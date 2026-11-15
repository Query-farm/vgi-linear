/**
 * One factory for every Linear GraphQL connection.
 *
 * A spec names the columns (each with the GraphQL selection it needs and a JSON
 * extractor), the root connection, and how pushed SQL filters map onto Linear's
 * filter input type. The factory turns that into a VGI table function that:
 *
 * - requests only the fields of the projected (and filtered) columns — GraphQL
 *   projection — so unused relations cost neither complexity points nor bytes;
 * - streams one Linear page (`first` / `after`) per Arrow batch, keeping the relay
 *   cursor in serializable state so a scan resumes on any process over HTTP;
 * - sizes pages from an estimate of Linear's query complexity, and halves the page
 *   size when Linear still answers "query too complex";
 * - reads the `linear` secret on every call and never stores it in state;
 * - pushes filters down (narrowing only) and lets the SDK re-apply them exactly.
 *
 * Per-issue collections (history, attachments, relations) read `issue(id:)` for the
 * keys passed as an argument or pushed as `= / IN`; history can also fan out over the
 * issues matching its pushed filters, nesting the first page of each issue's history
 * in the issues page.
 */

import {
  asDate32,
  batchFromColumns,
  bool,
  constraintRecord,
  dateDay,
  defineTableFunction,
  field,
  float64,
  formatPushedFilters,
  int32,
  int64,
  list,
  schema,
  type TableDescriptor,
  timestampMicros,
  utf8,
  type VgiDataType,
  type VgiFunction,
  type VgiSchema,
} from "@query-farm/vgi";
import { log } from "../log.ts";
import { type Category, column, objectTags } from "../meta.ts";
import { configFromSecrets, type LinearConfig, LinearError, linearQuery, SECRET_TYPE } from "./client.ts";
import { buildFilter, type Constraint, constraintsOf, eqValues, type FilterMap, parseRawFilter } from "./pushdown.ts";

// ------------------------------------------------------------------ column helpers

// biome-ignore lint/suspicious/noExplicitAny: Linear JSON is untyped.
export type Row = Record<string, any>;

export interface Col {
  name: string;
  type: VgiDataType;
  /** DuckDB spelling for vgi.result_columns_schema. */
  sqlType: string;
  doc: string;
  nullable: boolean;
  /** GraphQL selection this column needs, e.g. `assignee { displayName }`. */
  sel: string;
  /** Estimated complexity points per node (Linear: 0.1 per scalar, 1 per object). */
  cost: number;
  get: (row: Row) => unknown;
}

/** Walk a dotted path through untyped JSON. */
export function at(row: unknown, path: string): unknown {
  let cur: unknown = row;
  for (const p of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/** `a.b.c` → `a { b { c } }`. */
export function selOf(path: string): string {
  const parts = path.split(".");
  let s = parts[parts.length - 1] as string;
  for (let i = parts.length - 2; i >= 0; i--) s = `${parts[i]} { ${s} }`;
  return s;
}
const costOf = (path: string) => path.split(".").length - 1 + 0.1;

export const asStr = (v: unknown): string | null =>
  v == null ? null : typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
export const asBool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
export const asInt = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;
export const asBig = (v: unknown): bigint | null =>
  typeof v === "number" && Number.isFinite(v) ? BigInt(Math.trunc(v)) : null;
export const asNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** ISO 8601 → TIMESTAMPTZ microseconds. */
export function asTime(v: unknown): bigint | null {
  if (typeof v !== "string" || v === "") return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : BigInt(ms) * 1000n;
}
/** Linear TimelessDate `YYYY-MM-DD` → DATE. */
export function asDate(v: unknown): ReturnType<typeof asDate32> | null {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(v)) return null;
  const ms = Date.parse(`${v.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(ms) ? null : asDate32(Math.floor(ms / 86_400_000));
}
export const asJson = (v: unknown): string | null => (v == null ? null : JSON.stringify(v));
/** Names out of a connection's `nodes` list (or a plain list). */
export function nodeValues(v: unknown, key: string): string[] | null {
  const list = Array.isArray(v) ? v : Array.isArray((v as Row | null)?.nodes) ? (v as Row).nodes : null;
  if (!list) return null;
  return (list as Row[]).map((x) => asStr(x?.[key])).filter((x): x is string => x != null);
}

const JSON_META: [string, string] = ["ARROW:extension:name", "arrow.json"];

function mk(
  name: string,
  type: VgiDataType,
  sqlType: string,
  doc: string,
  path: string,
  get: (r: Row) => unknown,
  nullable = true,
): Col {
  return { name, type, sqlType, doc, nullable, sel: selOf(path), cost: costOf(path), get };
}

export const C = {
  str: (name: string, doc: string, path: string, nullable = true) =>
    mk(name, utf8(), "VARCHAR", doc, path, (r) => asStr(at(r, path)), nullable),
  time: (name: string, doc: string, path: string, nullable = true) =>
    mk(name, timestampMicros("UTC"), "TIMESTAMP WITH TIME ZONE", doc, path, (r) => asTime(at(r, path)), nullable),
  date: (name: string, doc: string, path: string) => mk(name, dateDay(), "DATE", doc, path, (r) => asDate(at(r, path))),
  bool: (name: string, doc: string, path: string, nullable = true) =>
    mk(name, bool, "BOOLEAN", doc, path, (r) => asBool(at(r, path)), nullable),
  int: (name: string, doc: string, path: string, nullable = true) =>
    mk(name, int32, "INTEGER", doc, path, (r) => asInt(at(r, path)), nullable),
  big: (name: string, doc: string, path: string, nullable = true) =>
    mk(name, int64(), "BIGINT", doc, path, (r) => asBig(at(r, path)), nullable),
  num: (name: string, doc: string, path: string) => mk(name, float64(), "DOUBLE", doc, path, (r) => asNum(at(r, path))),
  json: (name: string, doc: string, path: string) => mk(name, utf8(), "JSON", doc, path, (r) => asJson(at(r, path))),
  strList: (name: string, doc: string, path: string) =>
    mk(name, list(utf8()), "VARCHAR[]", doc, path, (r) => {
      const v = at(r, path);
      return Array.isArray(v) ? v.map((x) => asStr(x)).filter((x) => x != null) : null;
    }),
  /** A list of one key out of a nested connection: `labels(first: 50) { nodes { name } }`. */
  nodesList: (name: string, doc: string, conn: string, first: number, key: string) => ({
    name,
    type: list(utf8()),
    sqlType: "VARCHAR[]",
    doc,
    nullable: true,
    sel: `${conn}(first: ${first}) { nodes { ${key} } }`,
    cost: 1 + first * 1.1,
    get: (r: Row) => nodeValues(r[conn], key),
  }),
  /** Anything else: explicit selection, type and extractor. */
  custom: (
    name: string,
    type: VgiDataType,
    sqlType: string,
    doc: string,
    sel: string,
    get: (r: Row) => unknown,
    cost = 1,
    nullable = true,
  ): Col => ({ name, type, sqlType, doc, nullable, sel, cost, get }),
};

// --------------------------------------------------------------------- the factory

export interface FnExample {
  sql: string;
  description: string;
}

/** Per-issue collections: `issue(id:) { <connection> }`. */
export interface PerIssue {
  connection: string;
  /** Columns whose pushed `= / IN` values are issue keys or ids (e.g. issue_key, issue_id). */
  keyColumns: string[];
  /** Named argument carrying one issue key (e.g. `issue_key`). */
  argName: string;
  /**
   * Without keys: true = fan out over issues (filtered by `fanoutFilters`), nesting each
   * issue's first page; false = use the spec's root connection instead.
   */
  fanout?: boolean;
  fanoutFilters?: Record<string, FilterMap>;
}

export interface LinearTableSpec {
  name: string;
  description: string;
  title: string;
  category: Category;
  keywords: string;
  docLlm: string;
  docMd: string;
  /** Text appended to doc_md describing what pushes down. */
  pushdown?: string;
  examples: FnExample[];
  args?: Record<string, VgiDataType>;
  argDocs?: Record<string, string>;
  argDefaults?: Record<string, unknown>;
  argConstraints?: Record<string, Record<string, unknown>>;
  columns: Col[];
  /** Primary key column for catalog tables (default `id`). */
  primaryKey?: string;
  /** Root Query connection field, e.g. `issues`. */
  root: string;
  /** GraphQL filter input type of the root connection (omit when it takes none). */
  filterType?: string;
  filters?: Record<string, FilterMap>;
  orderBy?: "updatedAt" | "createdAt";
  /** Extra boolean root arguments taken from same-named SQL args (`include_archived` → includeArchived). */
  boolArgs?: Record<string, string>;
  /** Constant boolean root arguments (e.g. `includeDisabled: true` for users). */
  fixedBools?: Record<string, boolean>;
  /** Named SQL arguments that act as `column = value` filters (e.g. `issue_key`). */
  argColumns?: Record<string, string>;
  /** Default and maximum rows per page (Linear allows 1–250). */
  pageSize?: number;
  perIssue?: PerIssue;
  /** Columns that may be hidden by the key's scope: dropped (NULL) when Linear refuses them. */
  optionalColumns?: string[];
  /** What a permission error means for this collection. */
  onForbidden?: { mode: "error" | "empty"; hint: string };
}

interface ScanState {
  /** Index into the explicit phases (issue keys) or 0 for a root scan. */
  phase: number;
  /** Relay cursor of the current phase ("" = first page). */
  after: string;
  /** Fan-out: pending "key\tcursor" lines (issues whose nested page overflowed). */
  queue: string;
  /** Fan-out: cursor of the parent issues listing; `parentDone` once it is exhausted. */
  parentAfter: string;
  parentDone: boolean;
  /** Current page size (halved on "query too complex"); 0 = not chosen yet. */
  pageSize: number;
  /** Optional columns the key's scope refused (comma-joined). */
  dropped: string;
}

/** Linear's documented ceiling is 10,000 points per query; stay well under it. */
export const COMPLEXITY_BUDGET = 5_000;
const MAX_PAGE = 250;

function outputSchemaOf(spec: LinearTableSpec): VgiSchema {
  return schema(
    spec.columns.map((c) =>
      c.sqlType === "JSON"
        ? field(c.name, c.type, c.nullable, new Map([["comment", c.doc], JSON_META]))
        : column(c.name, c.type, c.doc, c.nullable),
    ),
  );
}

function tagsOf(spec: LinearTableSpec): Record<string, string> {
  return {
    domain: "project-management",
    ...objectTags({
      title: spec.title,
      category: spec.category,
      keywords: spec.keywords,
      docLlm: spec.docLlm,
      docMd: spec.docMd + (spec.pushdown ? `\n\n**Pushdown:** ${spec.pushdown}` : ""),
    }),
    "vgi.result_columns_schema": JSON.stringify(
      // Keep it compact for agent tools: the pushdown notes are in doc_md.
      spec.columns.map((c) => ({
        name: c.name,
        type: c.sqlType,
        description: c.doc.replace(/\s*(Ranges are )?[Pp]ushed down[^.]*\./g, "").trim(),
      })),
    ),
  };
}

/** Columns referenced anywhere in the pushed filters (including under OR/NOT). */
function filterColumns(filters: unknown): string[] {
  const out: string[] = [];
  const walk = (e: unknown) => {
    if (!e || typeof e !== "object") return;
    const n = e as Record<string, unknown>;
    if (n.node === "column_ref" && typeof n.columnName === "string") out.push(n.columnName);
    for (const v of Object.values(n)) {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object" && !(v instanceof Uint8Array)) walk(v);
    }
  };
  walk(filters);
  return out;
}

/** The GraphQL selection for a set of columns (deduplicated, `id` always included). */
export function selectionFor(columns: Col[], needed: Set<string>): { sel: string; cost: number } {
  const sels = new Set<string>(["id"]);
  let cost = 1;
  for (const c of columns) {
    if (!needed.has(c.name) || sels.has(c.sel)) continue;
    sels.add(c.sel);
    cost += c.cost;
  }
  return { sel: [...sels].join(" "), cost };
}

/** Rows per page so that `pageSize × nodeCost` stays inside the complexity budget. */
export function pageSizeFor(nodeCost: number, requested: number): number {
  return Math.max(1, Math.min(requested, MAX_PAGE, Math.floor(COMPLEXITY_BUDGET / Math.max(nodeCost, 0.1))));
}

/** Build a root connection query. */
export function rootQuery(spec: LinearTableSpec, sel: string, boolVars: string[]): string {
  const decl = ["$first: Int!", "$after: String"];
  const call = ["first: $first", "after: $after"];
  if (spec.filterType) {
    decl.push(`$filter: ${spec.filterType}`);
    call.push("filter: $filter");
  }
  for (const v of boolVars) {
    decl.push(`$${v}: Boolean`);
    call.push(`${v}: $${v}`);
  }
  if (spec.orderBy) call.push(`orderBy: ${spec.orderBy}`);
  return (
    `query LinearScan(${decl.join(", ")}) { ${spec.root}(${call.join(", ")}) ` +
    `{ nodes { ${sel} } pageInfo { hasNextPage endCursor } } }`
  );
}

/** Build a per-issue child connection query. */
export function issueChildQuery(conn: string, sel: string, boolVars: string[]): string {
  const decl = ["$id: String!", "$first: Int!", "$after: String", ...boolVars.map((v) => `$${v}: Boolean`)];
  const call = ["first: $first", "after: $after", ...boolVars.map((v) => `${v}: $${v}`)];
  return (
    `query LinearIssueChildren(${decl.join(", ")}) { issue(id: $id) { id identifier ` +
    `${conn}(${call.join(", ")}) { nodes { ${sel} } pageInfo { hasNextPage endCursor } } } }`
  );
}

/** Build the fan-out query: a page of issues, each with the first page of a child connection. */
export function fanoutQuery(conn: string, sel: string, boolVars: string[]): string {
  const decl = ["$first: Int!", "$after: String", "$filter: IssueFilter", "$childFirst: Int!"];
  const childCall = ["first: $childFirst", ...boolVars.map((v) => `${v}: $${v}`)];
  for (const v of boolVars) decl.push(`$${v}: Boolean`);
  return (
    `query LinearIssueFanout(${decl.join(", ")}) { issues(first: $first, after: $after, filter: $filter, ` +
    `orderBy: updatedAt) { nodes { id identifier ${conn}(${childCall.join(", ")}) { nodes { ${sel} } ` +
    `pageInfo { hasNextPage endCursor } } } pageInfo { hasNextPage endCursor } } }`
  );
}

interface Conn {
  nodes?: Row[];
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
}

const nextCursor = (c: Conn | undefined): string | null =>
  c?.pageInfo?.hasNextPage && c.pageInfo.endCursor ? c.pageInfo.endCursor : null;

/** Every spec defined so far (tests validate each one's queries against the schema). */
export const SPECS: LinearTableSpec[] = [];

/** A spec exposed as a catalog table (`SELECT … FROM linear.main.teams`). */
export function defineLinearCatalogTable(spec: LinearTableSpec): TableDescriptor {
  SPECS.push(spec);
  const fn = defineLinearTable({ ...spec, name: `${spec.name}_scan` }, false);
  const pk = spec.primaryKey ?? "id";
  const record = (id: string, kind: "NOT_NULL" | "PRIMARY_KEY") =>
    constraintRecord({
      schemaPath: ["main"],
      table: spec.name,
      id,
      kind,
      columns: [[pk]],
      enforcement: "ENFORCED",
      validation: "ALL_ROWS",
    });
  return {
    name: spec.name,
    comment: spec.description,
    columns: outputSchemaOf(spec),
    function: fn,
    constraints: [record(`${pk}_not_null`, "NOT_NULL"), record("pk", "PRIMARY_KEY")],
    tags: { ...tagsOf(spec), "vgi.example_queries": JSON.stringify(spec.examples) },
  };
}

export function defineLinearTable(spec: LinearTableSpec, register = true): VgiFunction {
  if (register) SPECS.push(spec);
  const outSchema = outputSchemaOf(spec);
  const defaultPage = spec.pageSize ?? 100;

  return defineTableFunction<Record<string, unknown>, ScanState>({
    name: spec.name,
    description: spec.description,
    args: spec.args ?? {},
    argDocs: spec.argDocs,
    argDefaults: spec.argDefaults,
    argConstraints: spec.argConstraints as never,
    filterPushdown: true,
    projectionPushdown: true,
    // DuckDB drops pushed predicates from its plan; the SDK re-applies them exactly,
    // so translating a predicate only ever narrows what Linear returns.
    autoApplyFilters: true,
    onBind: (params) =>
      params.resolvedSecretsProvided
        ? { outputSchema: outSchema }
        : { outputSchema: outSchema, lookupSecretTypes: [SECRET_TYPE] },
    initialState: () => ({
      phase: 0,
      after: "",
      queue: "",
      parentAfter: "",
      parentDone: false,
      pageSize: 0,
      dropped: "",
    }),
    process: async (params, state, out) => {
      const cfg = configFromSecrets(params.secrets);
      const args = params.args;
      const constraints = constraintsOf(params.pushdownFilters);
      for (const [arg, col] of Object.entries(spec.argColumns ?? {})) {
        if (typeof args[arg] === "string" && args[arg]) {
          constraints.push({ kind: "cmp", column: col, op: "eq", value: args[arg] });
        }
      }
      log.debug(`${spec.name}: pushed filters ${formatPushedFilters(params.pushdownFilters)}`);

      const needed = new Set(params.outputSchema.fields.map((f) => f.name));
      for (const c of constraints) needed.add(c.column);
      for (const c of filterColumns(params.pushdownFilters?.filters)) needed.add(c);
      const dropped = new Set(state.dropped ? state.dropped.split(",") : []);
      let sel = "";
      let cost = 1;
      /** (Re)compute the GraphQL selection, leaving out refused optional columns. */
      const refresh = () => {
        for (const d of dropped) needed.delete(d);
        ({ sel, cost } = selectionFor(spec.columns, needed));
      };
      refresh();

      const requested = Number(args.page_size ?? defaultPage);
      if (!state.pageSize) state.pageSize = pageSizeFor(cost, requested);

      const boolVars: string[] = [];
      const boolValues: Record<string, unknown> = {};
      for (const [gqlArg, v] of Object.entries(spec.fixedBools ?? {})) {
        boolVars.push(gqlArg);
        boolValues[gqlArg] = v;
      }
      for (const [sqlArg, gqlArg] of Object.entries(spec.boolArgs ?? {})) {
        if (args[sqlArg] != null) {
          boolVars.push(gqlArg);
          boolValues[gqlArg] = Boolean(args[sqlArg]);
        }
      }

      const full = params.initCall.output_schema as unknown as VgiSchema;
      const emit = (rows: Row[]): boolean => {
        if (rows.length === 0) return false;
        const cols: Record<string, unknown[]> = {};
        for (const f of full.fields) {
          const c = spec.columns.find((x) => x.name === f.name);
          cols[f.name] = c && needed.has(f.name) ? rows.map((r) => c.get(r)) : rows.map(() => null);
        }
        out.emit(batchFromColumns(cols, full) as never);
        return true;
      };

      /** Run a query, adapting to complexity / scope errors. `null` = retry with new state. */
      const run = async (doc: string, vars: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
        try {
          return (await linearQuery(cfg, doc, vars)).data;
        } catch (err) {
          if (!(err instanceof LinearError)) throw err;
          if (err.tooComplex && state.pageSize > 1) {
            state.pageSize = Math.max(1, Math.floor(state.pageSize / 2));
            log.info(`${spec.name}: Linear says the query is too complex; page size now ${state.pageSize}`);
            return null;
          }
          const refused = (spec.optionalColumns ?? []).filter(
            (c) =>
              needed.has(c) &&
              !dropped.has(c) &&
              err.errors.some((e) => e.path?.at(-1) === c || new RegExp(`\\b${c}\\b`, "i").test(e.message)),
          );
          if (refused.length) {
            for (const c of refused) dropped.add(c);
            state.dropped = [...dropped].join(",");
            log.info(`${spec.name}: this key may not read ${refused.join(", ")}; returning NULL for it`);
            return null;
          }
          if (err.forbidden && spec.onForbidden) {
            if (spec.onForbidden.mode === "empty") {
              log.info(`${spec.name}: not available to this key (${err.message}); returning no rows`);
              return {};
            }
            throw new LinearError(`${spec.name}: ${spec.onForbidden.hint} (${err.message})`, err.status, err.code);
          }
          throw err;
        }
      };

      const per = spec.perIssue;
      const explicit = per
        ? typeof args[per.argName] === "string" && args[per.argName]
          ? [args[per.argName] as string]
          : per.keyColumns.map((k) => eqValues(constraints, k)).find((v) => v !== undefined)
        : undefined;

      /** Read one page of one issue's child connection; returns rows + next cursor. */
      const childPage = async (key: string, after: string) => {
        try {
          const data = await run(issueChildQuery(per?.connection as string, sel, boolVars), {
            id: key,
            first: state.pageSize,
            after: after || null,
            ...boolValues,
          });
          if (data === null) return null;
          const conn = (data.issue as Row | undefined)?.[per?.connection as string] as Conn | undefined;
          return { rows: conn?.nodes ?? [], next: nextCursor(conn) };
        } catch (err) {
          if (err instanceof LinearError && err.notFound) return { rows: [], next: null };
          throw err;
        }
      };

      for (;;) {
        // 1. Explicit issue keys (argument or pushed = / IN).
        if (per && explicit) {
          const key = explicit[state.phase];
          if (key === undefined) return out.finish();
          const page = await childPage(key, state.after);
          if (page === null) {
            refresh();
            continue;
          }
          if (page.next) state.after = page.next;
          else {
            state.phase += 1;
            state.after = "";
          }
          if (emit(page.rows)) return;
          continue;
        }
        // 2. Fan out over issues, nesting each issue's first child page.
        if (per?.fanout) {
          if (state.queue) {
            const lines = state.queue.split("\n");
            const [key, cursor] = (lines[0] as string).split("\t") as [string, string];
            const page = await childPage(key, state.after || cursor);
            if (page === null) {
              refresh();
              continue;
            }
            if (page.next) state.after = page.next;
            else {
              state.queue = lines.slice(1).join("\n");
              state.after = "";
            }
            if (emit(page.rows)) return;
            continue;
          }
          if (state.parentDone) return out.finish();
          const childFirst = Math.min(50, state.pageSize);
          const parents = Math.max(1, Math.min(50, Math.floor(COMPLEXITY_BUDGET / (2 + childFirst * cost))));
          const data = await run(fanoutQuery(per.connection, sel, boolVars), {
            first: parents,
            after: state.parentAfter || null,
            filter: buildFilter(constraints, per.fanoutFilters ?? {}) ?? null,
            childFirst,
            ...boolValues,
          });
          if (data === null) {
            refresh();
            continue;
          }
          const conn = data.issues as Conn | undefined;
          const next = nextCursor(conn);
          if (next) state.parentAfter = next;
          else state.parentDone = true;
          const rows: Row[] = [];
          const overflow: string[] = [];
          for (const issue of conn?.nodes ?? []) {
            const child = issue[per.connection] as Conn | undefined;
            rows.push(...(child?.nodes ?? []));
            const more = nextCursor(child);
            if (more) overflow.push(`${issue.identifier}\t${more}`);
          }
          state.queue = overflow.join("\n");
          if (emit(rows)) return;
          continue;
        }
        // 3. The root connection.
        if (state.phase > 0) return out.finish();
        const raw =
          spec.args && "filter" in spec.args ? parseRawFilter(args.filter as string, spec.filterType ?? "") : null;
        const data = await run(rootQuery(spec, sel, boolVars), {
          first: state.pageSize,
          after: state.after || null,
          ...(spec.filterType ? { filter: buildFilter(constraints, spec.filters ?? {}, raw) ?? null } : {}),
          ...boolValues,
        });
        if (data === null) {
          refresh();
          continue;
        }
        const conn = data[spec.root] as Conn | undefined;
        const next = nextCursor(conn);
        if (next) state.after = next;
        else state.phase = 1;
        if (emit(conn?.nodes ?? [])) return;
      }
    },
    tags: tagsOf(spec),
    examples: spec.examples,
  });
}

export type { Constraint, LinearConfig };

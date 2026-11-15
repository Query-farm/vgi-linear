/**
 * Offline Linear GraphQL replay server for the SQL and unit tests.
 *
 *   bun test/mock_api/server.ts          # prints PORT:<n> once listening
 *
 * It is strict on purpose, so the tests assert what the worker really sends:
 *
 * - Every request is parsed and **validated against the vendored public Linear schema**
 *   (`test/fixtures/linear-schema/schema.graphql`, MIT, from github.com/linear/linear).
 *   A query that Linear would reject (unknown field, wrong argument or variable type)
 *   gets Linear's GRAPHQL_VALIDATION_FAILED error, and is counted in the log.
 * - Only `query` operations are accepted; a mutation is refused and logged.
 * - Queries are **executed** against the fixture workspace (`test/fixtures/workspace.json`)
 *   with a generic resolver: connections apply `filter` (IssueFilter, TeamFilter, … —
 *   comparators, nested relation filters, `some` / `every`, `and` / `or`), `orderBy`,
 *   `includeArchived` / `includeDisabled` and relay `first` / `after` paging. An
 *   unsupported filter key is an error, so pushdown is genuinely evaluated, not ignored.
 * - Query complexity is computed the way Linear documents it (0.1 per scalar, 1 per
 *   object, connections × `first`) and reported in `X-Complexity`; over the limit the
 *   query is refused as too complex. Rate-limit headers are sent on every response.
 *
 * Auth: `Authorization: lin_api_admin` (personal key of an admin) sees everything;
 * `Authorization: Bearer lin_oauth_member` (OAuth token of a member) may not read user
 * emails, the audit log or customers. Anything else gets AUTHENTICATION_ERROR.
 *
 * Path prefixes select failure modes: `/strict/graphql` (complexity limit 1500),
 * `/ratelimited/graphql` (each distinct request is RATELIMITED once, reset in 0.8 s),
 * `/flaky/graphql` (each distinct request fails once with HTTP 502). `GET /__requests`
 * returns the request log as JSON (filter with `?path=`, `?root=`, `?invalid=1`).
 */

import { join } from "node:path";
import {
  buildSchema,
  type DocumentNode,
  execute,
  type FieldNode,
  GraphQLError,
  type GraphQLField,
  type GraphQLFieldResolver,
  type GraphQLObjectType,
  type GraphQLSchema,
  getNamedType,
  isObjectType,
  Kind,
  type OperationDefinitionNode,
  parse,
  type SelectionSetNode,
  validate,
  valueFromASTUntyped,
} from "graphql";

const ROOT = join(import.meta.dir, "..", "..");
const SDL = await Bun.file(join(ROOT, "test", "fixtures", "linear-schema", "schema.graphql")).text();
export const SCHEMA: GraphQLSchema = buildSchema(SDL);

// biome-ignore lint/suspicious/noExplicitAny: fixture rows are untyped JSON.
type Row = Record<string, any>;
const FIXTURE = (await Bun.file(join(ROOT, "test", "fixtures", "workspace.json")).json()) as Record<string, Row[]>;

/** Tag every row with its table so the resolver knows how to follow references. */
const TABLES: Record<string, Row[]> = {};
for (const [name, rows] of Object.entries(FIXTURE)) {
  if (!Array.isArray(rows)) continue;
  TABLES[name] = rows.map((r) => Object.defineProperty({ ...r }, "__t", { value: name, enumerable: false }));
}
const byId = new Map<string, Row>();
for (const rows of Object.values(TABLES)) for (const r of rows) byId.set(`${r.__t}:${r.id}`, r);
const lookup = (table: string, id: unknown): Row | null =>
  typeof id === "string" ? (byId.get(`${table}:${id}`) ?? null) : null;

/** Single-valued references: table → field → target table (stored as `<field>Id`). */
const REL: Record<string, Record<string, string>> = {
  issues: {
    team: "teams",
    state: "workflowStates",
    assignee: "users",
    creator: "users",
    project: "projects",
    projectMilestone: "projectMilestones",
    cycle: "cycles",
    parent: "issues",
  },
  workflowStates: { team: "teams" },
  labels: { team: "teams", parent: "labels", creator: "users" },
  teams: { parent: "teams" },
  projects: { status: "projectStatuses", lead: "users", creator: "users" },
  projectMilestones: { project: "projects" },
  projectUpdates: { project: "projects", user: "users" },
  cycles: { team: "teams" },
  initiatives: { owner: "users", creator: "users" },
  roadmaps: { owner: "users", creator: "users" },
  customers: { status: "customerStatuses", tier: "customerTiers", owner: "users" },
  customerNeeds: { customer: "customers", issue: "issues", project: "projects", creator: "users" },
  auditEntries: { actor: "users" },
  issueHistory: {
    issue: "issues",
    actor: "users",
    fromState: "workflowStates",
    toState: "workflowStates",
    fromAssignee: "users",
    toAssignee: "users",
    fromCycle: "cycles",
    toCycle: "cycles",
    fromProject: "projects",
    toProject: "projects",
    fromParent: "issues",
    toParent: "issues",
  },
  comments: { issue: "issues", user: "users", parent: "comments" },
  attachments: { issue: "issues", creator: "users" },
  issueRelations: { issue: "issues", relatedIssue: "issues" },
};

/** Multi-valued references: table → field → [target table, id-list property]. */
const MULTI: Record<string, Record<string, [string, string]>> = {
  issues: { labels: ["labels", "labelIds"] },
  projects: { teams: ["teams", "teamIds"] },
  initiatives: { projects: ["projects", "projectIds"] },
  roadmaps: { projects: ["projects", "projectIds"] },
  issueHistory: { addedLabels: ["labels", "addedLabelIds"], removedLabels: ["labels", "removedLabelIds"] },
};

/** Child connections: parent table → field → [child table, foreign key on the child]. */
const CHILDREN: Record<string, Record<string, [string, string]>> = {
  issues: {
    history: ["issueHistory", "issueId"],
    attachments: ["attachments", "issueId"],
    relations: ["issueRelations", "issueId"],
    comments: ["comments", "issueId"],
  },
};

/** Root connections → fixture tables. */
const ROOT_CONNECTIONS: Record<string, string> = {
  issues: "issues",
  comments: "comments",
  attachments: "attachments",
  issueRelations: "issueRelations",
  teams: "teams",
  workflowStates: "workflowStates",
  issueLabels: "labels",
  users: "users",
  projects: "projects",
  projectMilestones: "projectMilestones",
  projectUpdates: "projectUpdates",
  cycles: "cycles",
  initiatives: "initiatives",
  roadmaps: "roadmaps",
  customers: "customers",
  customerNeeds: "customerNeeds",
  auditEntries: "auditEntries",
};

interface Ctx {
  admin: boolean;
  emailVisible: boolean;
  customersEnabled: boolean;
}

// ------------------------------------------------------------------ filter evaluation

const COMPARATOR_KEYS = new Set([
  "eq",
  "neq",
  "in",
  "nin",
  "gt",
  "gte",
  "lt",
  "lte",
  "null",
  "startsWith",
  "startsWithIgnoreCase",
  "notStartsWith",
  "endsWith",
  "notEndsWith",
  "contains",
  "notContains",
  "containsIgnoreCase",
  "notContainsIgnoreCase",
  "eqIgnoreCase",
  "neqIgnoreCase",
]);

const isTime = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v);
function norm(v: unknown): unknown {
  if (isTime(v)) return Date.parse(v as string);
  return v;
}

/** Apply a scalar comparator object to a value (`ids` = extra values `eq`/`in` also match). */
function compare(value: unknown, cmp: Row, ids: unknown[] = []): boolean {
  const vals = [value, ...ids];
  for (const [op, raw] of Object.entries(cmp)) {
    if (!COMPARATOR_KEYS.has(op)) throw new GraphQLError(`mock: unsupported comparator '${op}'`);
    const a = norm(value);
    const b = Array.isArray(raw) ? raw.map(norm) : norm(raw);
    const s = typeof value === "string" ? value : "";
    let ok: boolean;
    switch (op) {
      case "null":
        ok = raw ? value == null : value != null;
        break;
      case "eq":
        ok = value != null && vals.some((v) => norm(v) === b);
        break;
      case "neq":
        ok = !vals.some((v) => norm(v) === b);
        break;
      case "in":
        ok = value != null && vals.some((v) => (b as unknown[]).includes(norm(v)));
        break;
      case "nin":
        ok = !vals.some((v) => (b as unknown[]).includes(norm(v)));
        break;
      case "gt":
        ok = value != null && (a as number) > (b as number);
        break;
      case "gte":
        ok = value != null && (a as number) >= (b as number);
        break;
      case "lt":
        ok = value != null && (a as number) < (b as number);
        break;
      case "lte":
        ok = value != null && (a as number) <= (b as number);
        break;
      case "startsWith":
        ok = value != null && s.startsWith(raw);
        break;
      case "startsWithIgnoreCase":
        ok = value != null && s.toLowerCase().startsWith(String(raw).toLowerCase());
        break;
      case "notStartsWith":
        ok = !s.startsWith(raw);
        break;
      case "endsWith":
        ok = value != null && s.endsWith(raw);
        break;
      case "notEndsWith":
        ok = !s.endsWith(raw);
        break;
      case "contains":
        ok = value != null && s.includes(raw);
        break;
      case "notContains":
        ok = !s.includes(raw);
        break;
      case "containsIgnoreCase":
        ok = value != null && s.toLowerCase().includes(String(raw).toLowerCase());
        break;
      case "notContainsIgnoreCase":
        ok = !s.toLowerCase().includes(String(raw).toLowerCase());
        break;
      case "eqIgnoreCase":
        ok = value != null && s.toLowerCase() === String(raw).toLowerCase();
        break;
      default:
        ok = s.toLowerCase() !== String(raw).toLowerCase();
    }
    if (!ok) return false;
  }
  return true;
}

/** Does `row` (of `table`) satisfy a Linear filter input object? */
export function matches(row: Row | null, filter: Row, table: string): boolean {
  for (const [key, cond] of Object.entries(filter)) {
    if (cond == null) continue;
    if (key === "and") {
      if (!(cond as Row[]).every((c) => matches(row, c, table))) return false;
      continue;
    }
    if (key === "or") {
      if (!(cond as Row[]).some((c) => matches(row, c, table))) return false;
      continue;
    }
    if (key === "null") {
      if ((row == null) !== cond) return false;
      continue;
    }
    if (row == null) return false;
    const rel = REL[table]?.[key];
    const multi = MULTI[table]?.[key];
    if (rel) {
      if (!matches(lookup(rel, row[`${key}Id`]), cond, rel)) return false;
    } else if (multi) {
      const items = ((row[multi[1]] as string[] | undefined) ?? []).map((id) => lookup(multi[0], id) as Row);
      for (const [op, sub] of Object.entries(cond as Row)) {
        if (op === "some") {
          if (!items.some((i) => matches(i, sub, multi[0]))) return false;
        } else if (op === "every") {
          if (!items.every((i) => matches(i, sub, multi[0]))) return false;
        } else if (op === "null") {
          if ((items.length === 0) !== sub) return false;
        } else if (op === "length") {
          if (!compare(items.length, sub)) return false;
        } else {
          // A field filter directly on the collection means "some item matches".
          if (!items.some((i) => matches(i, { [op]: sub }, multi[0]))) return false;
        }
      }
    } else if (key in (row as object) || SCALAR_FIELDS.has(key)) {
      // Issue ids also match their identifier (IssueIDComparator semantics).
      const extra = key === "id" && table === "issues" ? [row.identifier] : [];
      if (!compare(row[key], cond as Row, extra)) return false;
    } else {
      throw new GraphQLError(`mock: filter key '${key}' is not supported on ${table}`);
    }
  }
  return true;
}

/** Scalar fields that may be absent (null) in the fixture yet are valid filter targets. */
const SCALAR_FIELDS = new Set([
  "id",
  "archivedAt",
  "startedAt",
  "completedAt",
  "canceledAt",
  "triagedAt",
  "estimate",
  "dueDate",
  "health",
  "description",
  "subtitle",
  "sourceType",
  "ip",
  "countryCode",
  "name",
  "revenue",
  "size",
  "targetDate",
]);

// --------------------------------------------------------------------- connections

const encodeCursor = (id: string) => Buffer.from(`cursor:${id}`).toString("base64url");
const decodeCursor = (c: string) =>
  Buffer.from(c, "base64url")
    .toString()
    .replace(/^cursor:/, "");

function connection(rows: Row[], table: string, args: Row): Row {
  let list = rows;
  if (!args.includeArchived && list.some((r) => "archivedAt" in r || table === "issues")) {
    list = list.filter((r) => r.archivedAt == null);
  }
  if (table === "users" && !args.includeDisabled) list = list.filter((r) => r.active);
  if (args.filter) list = list.filter((r) => matches(r, args.filter, table));
  const order = (args.orderBy as string | undefined) ?? "createdAt";
  list = [...list].sort((a, b) => Date.parse(b[order]) - Date.parse(a[order]) || String(a.id).localeCompare(b.id));
  if (args.last != null || args.before != null) throw new GraphQLError("mock: backward paging is not supported");
  const first = (args.first as number | undefined) ?? 50;
  if (first < 1 || first > 250) {
    throw new GraphQLError("first must be between 1 and 250", { extensions: { code: "INVALID_INPUT" } });
  }
  let start = 0;
  if (args.after) {
    const id = decodeCursor(args.after);
    const i = list.findIndex((r) => r.id === id);
    if (i < 0) throw new GraphQLError("Invalid cursor", { extensions: { code: "INVALID_INPUT" } });
    start = i + 1;
  }
  const nodes = list.slice(start, start + first);
  const hasNextPage = start + first < list.length;
  return {
    nodes,
    edges: nodes.map((n) => ({ node: n, cursor: encodeCursor(n.id) })),
    pageInfo: {
      hasNextPage,
      hasPreviousPage: start > 0,
      startCursor: nodes[0] ? encodeCursor(nodes[0].id) : null,
      endCursor: nodes.length ? encodeCursor((nodes[nodes.length - 1] as Row).id) : null,
    },
  };
}

const forbidden = (message: string) => new GraphQLError(message, { extensions: { code: "FORBIDDEN" } });

const resolver: GraphQLFieldResolver<Row | undefined, Ctx> = (source, args, ctx, info) => {
  const name = info.fieldName;
  if (info.parentType.name === "Query") {
    const table = ROOT_CONNECTIONS[name];
    if (table) {
      if (table === "auditEntries" && !ctx.admin)
        throw forbidden("Forbidden: only workspace admins can read the audit log");
      if ((table === "customers" || table === "customerNeeds") && !ctx.customersEnabled) {
        throw forbidden("Forbidden: the Customers feature is not enabled for this workspace");
      }
      return connection(TABLES[table] ?? [], table, args);
    }
    if (name === "issue") {
      const hit = (TABLES.issues ?? []).find((r) => r.id === args.id || r.identifier === args.id);
      if (!hit) {
        throw new GraphQLError("Entity not found: Issue - Could not find referenced Issue.", {
          extensions: { code: "INVALID_INPUT", type: "invalid input" },
        });
      }
      return hit;
    }
    if (name === "organization") return FIXTURE.organization;
    if (name === "viewer") return (TABLES.users ?? []).find((u) => u.isMe);
    throw new GraphQLError(`mock: Query.${name} is not implemented`);
  }
  if (!source) return null;
  const table = (source as Row).__t as string | undefined;
  if (info.parentType.name === "User" && name === "email" && !ctx.emailVisible) {
    throw forbidden("Forbidden: email is only visible to workspace admins");
  }
  const child = table ? CHILDREN[table]?.[name] : undefined;
  const multi = table ? MULTI[table]?.[name] : undefined;
  const retName = getNamedType(info.returnType).name;
  if (retName.endsWith("Connection")) {
    if (child) {
      const [t, fk] = child;
      return connection(
        (TABLES[t] ?? []).filter((r) => r[fk] === source.id),
        t,
        args,
      );
    }
    if (multi) {
      const [t, prop] = multi;
      const ids = (source[prop] as string[] | undefined) ?? [];
      return connection(
        (TABLES[t] ?? []).filter((r) => ids.includes(r.id)),
        t,
        args,
      );
    }
    throw new GraphQLError(`mock: connection ${info.parentType.name}.${name} is not implemented`);
  }
  if (multi) {
    const ids = source[multi[1]] as string[] | undefined;
    return ids == null ? null : ids.map((id) => lookup(multi[0], id));
  }
  const rel = table ? REL[table]?.[name] : undefined;
  if (rel) return lookup(rel, source[`${name}Id`]);
  if (name in source) return source[name];
  if (/^(added|removed)LabelIds$/.test(name)) return source[name] ?? null;
  return null;
};

// ---------------------------------------------------------------------- complexity

/** Linear-style complexity: 0.1 per scalar, 1 per object, connection children × first. */
export function complexity(doc: DocumentNode, vars: Row): number {
  const op = doc.definitions.find((d) => d.kind === Kind.OPERATION_DEFINITION) as OperationDefinitionNode;
  const walk = (set: SelectionSetNode | undefined, type: GraphQLObjectType): number => {
    let total = 0;
    for (const sel of set?.selections ?? []) {
      if (sel.kind !== Kind.FIELD) continue;
      const node = sel as FieldNode;
      if (node.name.value.startsWith("__")) continue;
      const def = type.getFields()[node.name.value] as GraphQLField<unknown, unknown> | undefined;
      if (!def) continue;
      const named = getNamedType(def.type);
      if (!isObjectType(named)) {
        total += 0.1;
        continue;
      }
      const inner = walk(node.selectionSet, named);
      if (named.name.endsWith("Connection")) {
        const arg = node.arguments?.find((a) => a.name.value === "first");
        const first = arg ? Number(valueFromASTUntyped(arg.value, vars) ?? 50) : 50;
        total += 1 + first * inner;
      } else {
        total += 1 + inner;
      }
    }
    return total;
  };
  return Math.round(walk(op.selectionSet, SCHEMA.getQueryType() as GraphQLObjectType) * 10) / 10;
}

// --------------------------------------------------------------------------- server

interface LogEntry {
  seq: number;
  path: string;
  auth: string;
  operation: string | null;
  roots: string[];
  query: string;
  variables: string;
  complexity: number | null;
  status: number;
  invalid: boolean;
  error: string | null;
}
const LOG: LogEntry[] = [];
const seenOnce = new Set<string>();
let requestsRemaining = 5000;

function respond(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

async function handleGraphql(req: Request, path: string): Promise<Response> {
  const auth = req.headers.get("Authorization") ?? "";
  const entry: LogEntry = {
    seq: LOG.length + 1,
    path,
    auth: auth === "lin_api_admin" ? "api_key" : auth === "Bearer lin_oauth_member" ? "oauth" : "invalid",
    operation: null,
    roots: [],
    query: "",
    variables: "{}",
    complexity: null,
    status: 200,
    invalid: false,
    error: null,
  };
  LOG.push(entry);
  const finish = (status: number, body: Row, headers: Record<string, string> = {}) => {
    entry.status = status;
    if (body.errors) entry.error = (body.errors as Row[]).map((e) => e.message).join("; ");
    return respond(status, body, headers);
  };

  let payload: Row;
  try {
    payload = (await req.json()) as Row;
  } catch {
    return finish(400, { errors: [{ message: "Body must be JSON", extensions: { code: "BAD_REQUEST" } }] });
  }
  entry.query = String(payload.query ?? "");
  entry.variables = JSON.stringify(payload.variables ?? {});

  if (entry.auth === "invalid") {
    return finish(400, {
      errors: [
        {
          message: "Authentication required, not authenticated",
          extensions: { code: "AUTHENTICATION_ERROR", type: "authentication error" },
        },
      ],
    });
  }

  let doc: DocumentNode;
  try {
    doc = parse(entry.query);
  } catch (err) {
    entry.invalid = true;
    return finish(400, { errors: [{ message: (err as Error).message, extensions: { code: "GRAPHQL_PARSE_FAILED" } }] });
  }
  const op = doc.definitions.find((d) => d.kind === Kind.OPERATION_DEFINITION) as OperationDefinitionNode | undefined;
  entry.operation = op?.name?.value ?? null;
  entry.roots = (op?.selectionSet.selections ?? []).flatMap((s) => (s.kind === Kind.FIELD ? [s.name.value] : []));
  if (op?.operation !== "query") {
    entry.invalid = true;
    return finish(400, {
      errors: [{ message: "mock: only read-only query operations are allowed", extensions: { code: "FORBIDDEN" } }],
    });
  }
  const problems = validate(SCHEMA, doc);
  if (problems.length) {
    entry.invalid = true;
    return finish(400, {
      errors: problems.map((p) => ({ message: p.message, extensions: { code: "GRAPHQL_VALIDATION_FAILED" } })),
    });
  }

  const vars = (payload.variables ?? {}) as Row;
  const cost = complexity(doc, vars);
  entry.complexity = cost;
  const limit = path.startsWith("/strict/") ? 1500 : 10_000;
  const now = Date.now();
  const rateHeaders = {
    "X-Complexity": String(cost),
    "X-RateLimit-Requests-Limit": "5000",
    "X-RateLimit-Requests-Remaining": String(Math.max(0, --requestsRemaining)),
    "X-RateLimit-Requests-Reset": String(now + 3_600_000),
    "X-RateLimit-Complexity-Limit": "3000000",
    "X-RateLimit-Complexity-Remaining": "2999000",
    "X-RateLimit-Complexity-Reset": String(now + 3_600_000),
  };
  if (cost > limit) {
    return finish(
      400,
      {
        errors: [
          { message: `Query too complex: complexity ${cost} exceeds ${limit}`, extensions: { code: "INVALID_INPUT" } },
        ],
      },
      rateHeaders,
    );
  }
  const onceKey = `${path}\u0000${entry.query}\u0000${entry.variables}`;
  if (path.startsWith("/ratelimited/") && !seenOnce.has(onceKey)) {
    seenOnce.add(onceKey);
    return finish(
      400,
      { errors: [{ message: "Rate limit exceeded", extensions: { code: "RATELIMITED", type: "ratelimited" } }] },
      { ...rateHeaders, "X-RateLimit-Requests-Remaining": "0", "X-RateLimit-Requests-Reset": String(now + 800) },
    );
  }
  if (path.startsWith("/flaky/") && !seenOnce.has(onceKey)) {
    seenOnce.add(onceKey);
    return finish(502, { errors: [{ message: "Bad gateway" }] });
  }

  const ctx: Ctx = {
    admin: entry.auth === "api_key",
    emailVisible: entry.auth === "api_key",
    customersEnabled: entry.auth === "api_key",
  };
  const result = await execute({
    schema: SCHEMA,
    document: doc,
    variableValues: vars,
    contextValue: ctx,
    fieldResolver: resolver,
  });
  const body: Row = { data: result.data ?? null };
  if (result.errors?.length) {
    body.errors = result.errors.map((e) => ({
      message: e.message,
      path: e.path,
      extensions: { code: "INTERNAL_ERROR", ...(e.extensions ?? {}) },
    }));
  }
  return finish(200, body, rateHeaders);
}

export function startServer(port = 0) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/__requests") {
        let rows = LOG;
        const p = url.searchParams.get("path");
        const root = url.searchParams.get("root");
        if (p) rows = rows.filter((r) => r.path === p);
        if (root) rows = rows.filter((r) => r.roots.includes(root));
        if (url.searchParams.get("invalid") === "1") rows = rows.filter((r) => r.invalid);
        // An empty log still needs a typed row for read_json; mark it.
        return respond(
          200,
          rows.length ? rows : [{ seq: 0, path: "", roots: [], query: "", variables: "{}", invalid: false, status: 0 }],
        );
      }
      if (req.method === "GET" && url.pathname === "/health") return new Response("ok");
      if (req.method === "POST" && url.pathname.endsWith("/graphql")) return handleGraphql(req, url.pathname);
      return respond(404, { errors: [{ message: `mock: no route ${req.method} ${url.pathname}` }] });
    },
  });
}

if (import.meta.main) {
  const server = startServer(Number(process.env.PORT ?? 0));
  process.stdout.write(`PORT:${server.port}\n`);
}

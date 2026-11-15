/**
 * Turn DuckDB's pushed-down WHERE predicates into Linear GraphQL filter inputs
 * (`IssueFilter`, `TeamFilter`, `ProjectFilter`, …).
 *
 * Every table function sets `autoApplyFilters: true`, so the SDK re-applies every
 * pushed predicate to each batch exactly. Translation therefore only has to NARROW
 * the request without ever dropping a matching row: predicates we cannot express are
 * simply not sent, and anything Linear matches more loosely is tightened again by the
 * SDK. Only top-level conjuncts are translated (a predicate under OR/NOT is left to
 * the SDK), so the generated filter is always implied by the SQL filter.
 */

import type { PushdownFilters } from "@query-farm/vgi";

type Expr = PushdownFilters["filters"][number];

/** One translatable constraint on a column. */
export type Constraint =
  | { kind: "cmp"; column: string; op: "eq" | "ne" | "gt" | "ge" | "lt" | "le"; value: unknown }
  | { kind: "in"; column: string; values: unknown[] }
  | { kind: "null"; column: string; negated: boolean }
  | { kind: "prefix"; column: string; value: string }
  | { kind: "contains"; column: string; value: unknown };

type Op = "eq" | "ne" | "gt" | "ge" | "lt" | "le";
const FLIP: Record<string, Op> = { eq: "eq", ne: "ne", gt: "lt", ge: "le", lt: "gt", le: "ge" };

function unwrap(e: Expr): Expr {
  return e.node === "cast" ? unwrap(e.expression) : e;
}

function one(e: Expr, out: Constraint[]): void {
  if (e.node === "column_ref") {
    out.push({ kind: "cmp", column: e.columnName, op: "eq", value: true });
    return;
  }
  if (e.node === "and") {
    for (const c of e.children) one(c, out);
    return;
  }
  if (e.node === "is_null") {
    const c = unwrap(e.expression);
    if (c.node === "column_ref") out.push({ kind: "null", column: c.columnName, negated: !!e.negated });
    return;
  }
  if (e.node === "not") {
    const inner = unwrap(e.expression);
    if (inner.node === "is_null") {
      const c = unwrap(inner.expression);
      if (c.node === "column_ref") out.push({ kind: "null", column: c.columnName, negated: !inner.negated });
    } else if (inner.node === "column_ref") {
      out.push({ kind: "cmp", column: inner.columnName, op: "eq", value: false });
    }
    return;
  }
  if (e.node === "comparison" && e.op in FLIP) {
    const [l, r] = [unwrap(e.left), unwrap(e.right)];
    if (l.node === "column_ref" && r.node === "literal" && r.value != null) {
      out.push({ kind: "cmp", column: l.columnName, op: e.op as Op, value: r.value });
    } else if (r.node === "column_ref" && l.node === "literal" && l.value != null) {
      out.push({ kind: "cmp", column: r.columnName, op: FLIP[e.op] ?? "eq", value: l.value });
    }
    return;
  }
  if (e.node === "in" && !e.negated) {
    const col = unwrap(e.expression);
    const all = e.set.values;
    const values = all.filter((v) => v != null);
    // A literal list, or a join/subquery set DuckDB materialized for us.
    if (col.node === "column_ref" && values.length > 0 && values.length <= 500) {
      out.push({ kind: "in", column: col.columnName, values });
    }
    return;
  }
  if (e.node === "call" && e.arguments.length === 2) {
    const fn = typeof e.function === "string" ? e.function : e.function.name;
    const [c, v] = [unwrap(e.arguments[0] as Expr), unwrap(e.arguments[1] as Expr)];
    if (c.node !== "column_ref" || v.node !== "literal" || v.value == null) return;
    if (fn === "starts_with" && typeof v.value === "string") {
      out.push({ kind: "prefix", column: c.columnName, value: v.value });
    } else if (["list_contains", "list_has", "array_contains", "array_has"].includes(fn)) {
      out.push({ kind: "contains", column: c.columnName, value: v.value });
    }
  }
}

/** The top-level, translatable constraints of a scan's pushed filters. */
export function constraintsOf(filters: PushdownFilters | undefined): Constraint[] {
  const out: Constraint[] = [];
  for (const f of filters?.filters ?? []) one(f, out);
  return [...out, ...prefixesFromRanges(out)];
}

/** The string after every string starting with `p` (DuckDB's prefix-range upper bound). */
function prefixSuccessor(p: string): string | undefined {
  if (!p) return undefined;
  const last = p.codePointAt(p.length - 1);
  return last === undefined ? undefined : p.slice(0, -1) + String.fromCodePoint(last + 1);
}

/** DuckDB rewrites `starts_with(c, 'ab')` / `c LIKE 'ab%'` into `c >= 'ab' AND c < 'ac'`. */
function prefixesFromRanges(cs: Constraint[]): Constraint[] {
  const out: Constraint[] = [];
  for (const lo of cs) {
    if (lo.kind !== "cmp" || lo.op !== "ge" || typeof lo.value !== "string") continue;
    const hi = prefixSuccessor(lo.value);
    if (cs.some((c) => c.kind === "cmp" && c.column === lo.column && c.op === "lt" && c.value === hi)) {
      out.push({ kind: "prefix", column: lo.column, value: lo.value });
    }
  }
  return out;
}

/** A pushed literal for a TIMESTAMPTZ column as epoch milliseconds (µs bigint, ms number, Date, ISO). */
export function toEpochMs(v: unknown): number | undefined {
  if (typeof v === "bigint") return Number(v / 1000n);
  if (typeof v === "number") return v;
  if (v instanceof Date) return v.getTime();
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

/** Equality / IN values pushed for a column (as strings), or undefined if unconstrained. */
export function eqValues(constraints: Constraint[], column: string): string[] | undefined {
  let set: string[] | undefined;
  for (const c of constraints) {
    if (c.column !== column) continue;
    let vs: string[] | undefined;
    if (c.kind === "cmp" && c.op === "eq" && typeof c.value === "string") vs = [c.value];
    else if (c.kind === "in" && c.values.every((v) => typeof v === "string")) vs = c.values as string[];
    if (!vs) continue;
    set = set ? set.filter((v) => vs.includes(v)) : [...new Set(vs)];
  }
  return set;
}

// ------------------------------------------------------------ GraphQL filter inputs

/** How one SQL column maps onto a path in a Linear filter input. */
export interface FilterMap {
  /** Path to the comparator, e.g. `["state", "type"]` → `{ state: { type: <cmp> } }`. */
  path: string[];
  kind: "string" | "id" | "number" | "time" | "bool";
  /** Allow `startsWith` (string comparators). */
  prefix?: boolean;
  /** Path that takes `{ null: true|false }` for IS [NOT] NULL (often the relation itself). */
  nullPath?: string[];
  /** List column: `list_contains(col, v)` → this comparator path (e.g. labels.some.name). */
  containsPath?: string[];
  /** Fully custom translation (e.g. the 'open'/'closed' state vocabulary). */
  custom?: (c: Constraint) => Record<string, unknown> | undefined;
}

const OPS: Record<string, string> = { eq: "eq", ne: "neq", gt: "gt", ge: "gte", lt: "lt", le: "lte" };

/** Wrap a comparator under a path: (["a","b"], x) → { a: { b: x } }. */
export function nest(path: string[], leaf: unknown): Record<string, unknown> {
  let out: unknown = leaf;
  for (let i = path.length - 1; i >= 0; i--) out = { [path[i] as string]: out };
  return out as Record<string, unknown>;
}

function literal(m: FilterMap, v: unknown): unknown {
  switch (m.kind) {
    case "time": {
      const ms = toEpochMs(v);
      return ms === undefined ? undefined : new Date(ms).toISOString();
    }
    case "number":
      if (typeof v === "bigint") return Number(v);
      return typeof v === "number" && Number.isFinite(v) ? v : undefined;
    case "bool":
      return typeof v === "boolean" ? v : undefined;
    default:
      return typeof v === "string" ? v : undefined;
  }
}

/** One constraint → one filter object, or undefined when it cannot be pushed. */
export function constraintFilter(c: Constraint, m: FilterMap): Record<string, unknown> | undefined {
  if (m.custom) return m.custom(c);
  switch (c.kind) {
    case "cmp": {
      const ordered = m.kind === "number" || m.kind === "time";
      if (c.op !== "eq" && c.op !== "ne" && !ordered) return undefined;
      if (c.op === "ne" && m.kind === "bool") return undefined;
      const v = literal(m, c.value);
      return v === undefined ? undefined : nest(m.path, { [OPS[c.op] as string]: v });
    }
    case "in": {
      const vs = c.values.map((v) => literal(m, v));
      if (vs.some((v) => v === undefined) || m.kind === "bool") return undefined;
      return nest(m.path, { in: [...new Set(vs)] });
    }
    case "null":
      return m.nullPath ? nest(m.nullPath, { null: !c.negated }) : undefined;
    case "prefix":
      return m.prefix && c.value !== "" ? nest(m.path, { startsWith: c.value }) : undefined;
    case "contains": {
      const v = typeof c.value === "string" ? c.value : undefined;
      return m.containsPath && v !== undefined ? nest(m.containsPath, { eq: v }) : undefined;
    }
  }
}

/**
 * Build a Linear filter input from the pushed constraints (+ an optional raw JSON
 * filter from the caller). Several parts are combined with `and`, so each part is
 * independent and no comparator is ever overwritten.
 */
export function buildFilter(
  constraints: Constraint[],
  maps: Record<string, FilterMap>,
  raw?: Record<string, unknown> | null,
): Record<string, unknown> | undefined {
  const parts: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const c of constraints) {
    const m = maps[c.column];
    if (!m) continue;
    const f = constraintFilter(c, m);
    if (!f) continue;
    const k = JSON.stringify(f);
    if (seen.has(k)) continue;
    seen.add(k);
    parts.push(f);
  }
  if (raw && Object.keys(raw).length) parts.unshift(raw);
  if (parts.length === 0) return undefined;
  return parts.length === 1 ? parts[0] : { and: parts };
}

/** Parse a user-supplied JSON filter argument (an object), with a clear error. */
export function parseRawFilter(text: string | null | undefined, typeName: string): Record<string, unknown> | null {
  if (text == null || text.trim() === "") return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (err) {
    throw new Error(`filter := must be a JSON object (a Linear ${typeName}): ${(err as Error).message}`);
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw new Error(`filter := must be a JSON object (a Linear ${typeName}), e.g. '{"priority": {"lte": 2}}'`);
  }
  return v as Record<string, unknown>;
}

// Unit tests. The SQL-level tests live in test/sql and run through DuckDB.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Arguments, VgiClient } from "@query-farm/vgi";
import { subprocessConnect } from "@query-farm/vgi-rpc";
import { buildSchema, parse, validate } from "graphql";
import {
  assertReadOnly,
  configFromSecrets,
  type LinearConfig,
  LinearError,
  linearQuery,
  normalizeBaseUrl,
  rateLimitDelayMs,
  resetBuckets,
  waitUntil,
} from "../src/linear/client.ts";
import {
  buildFilter,
  type Constraint,
  constraintFilter,
  type FilterMap,
  parseRawFilter,
} from "../src/linear/pushdown.ts";
import { FUNCTIONS, ISSUE_FILTERS, TABLES } from "../src/linear/resources.ts";
import {
  asDate,
  asTime,
  fanoutQuery,
  issueChildQuery,
  pageSizeFor,
  rootQuery,
  SPECS,
  selectionFor,
  selOf,
} from "../src/linear/table.ts";

const ROOT = join(import.meta.dir, "..");
const SCHEMA = buildSchema(await Bun.file(join(ROOT, "test/fixtures/linear-schema/schema.graphql")).text());
const ts = (iso: string) => BigInt(Date.parse(iso)) * 1000n;
const fm = (k: string) => ISSUE_FILTERS[k] as FilterMap;

test("base_url: https required except for loopback; a bare host gets /graphql", () => {
  expect(normalizeBaseUrl("https://api.linear.app/graphql")).toBe("https://api.linear.app/graphql");
  expect(normalizeBaseUrl("https://proxy.example.com/")).toBe("https://proxy.example.com/graphql");
  expect(normalizeBaseUrl("http://127.0.0.1:9/strict/graphql")).toBe("http://127.0.0.1:9/strict/graphql");
  expect(() => normalizeBaseUrl("http://api.linear.app/graphql")).toThrow(/https/);
  expect(() => normalizeBaseUrl("not a url")).toThrow(/not a URL/);
});

test("configFromSecrets: personal key vs OAuth token, exactly one", () => {
  expect(() => configFromSecrets({})).toThrow(/no linear secret/);
  expect(() => configFromSecrets({ s: { type: "linear" } })).toThrow(/API_KEY/);
  expect(() => configFromSecrets({ s: { type: "linear", api_key: "a", access_token: "b" } })).toThrow(/not both/);
  const key = configFromSecrets({ s: { type: "linear", api_key: "lin_api_x" } });
  expect(key).toEqual({ url: "https://api.linear.app/graphql", auth: "lin_api_x", kind: "api_key" });
  const oauth = configFromSecrets({ s: { type: "linear", access_token: "Bearer tok" } });
  expect(oauth.auth).toBe("Bearer tok");
  expect(oauth.kind).toBe("oauth");
});

test("assertReadOnly: only query operations leave the worker", () => {
  expect(() => assertReadOnly("query X { viewer { id } }")).not.toThrow();
  expect(() => assertReadOnly('mutation { issueDelete(id: "x") { success } }')).toThrow(/read-only/);
  expect(() => assertReadOnly("{ viewer { id } }")).toThrow(/read-only/);
  expect(() => assertReadOnly("query X { a } mutation Y { b }")).toThrow(/read-only/);
});

test("rate limits: waits for the exhausted bucket's epoch-ms reset, bounded", () => {
  const now = 1_000_000_000_000;
  const h = new Headers({
    "X-RateLimit-Requests-Remaining": "0",
    "X-RateLimit-Requests-Reset": String(now + 2_000),
    "X-RateLimit-Complexity-Remaining": "500",
    "X-RateLimit-Complexity-Reset": String(now + 30_000),
  });
  expect(rateLimitDelayMs(h, 1, now)).toBe(2_100);
  const c = new Headers({
    "X-RateLimit-Complexity-Remaining": "0",
    "X-RateLimit-Complexity-Reset": String(now + 5_000),
  });
  expect(rateLimitDelayMs(c, 1, now)).toBe(5_100);
  expect(rateLimitDelayMs(new Headers({ "Retry-After": "3" }), 1, now)).toBe(3_000);
  expect(rateLimitDelayMs(new Headers(), 2, now)).toBe(2_000);
  expect(waitUntil(now + 10 * 3_600_000, now)).toBe(65_000);
  expect(waitUntil((now + 4_000) / 1000, now)).toBe(4_100); // epoch seconds tolerated
});

test("pushdown: constraints become Linear filter inputs", () => {
  const c = (x: Constraint) => x;
  expect(constraintFilter(c({ kind: "cmp", column: "team_key", op: "eq", value: "ENG" }), fm("team_key"))).toEqual({
    team: { key: { eq: "ENG" } },
  });
  expect(constraintFilter(c({ kind: "cmp", column: "priority", op: "le", value: 2 }), fm("priority"))).toEqual({
    priority: { lte: 2 },
  });
  expect(
    constraintFilter(
      c({ kind: "cmp", column: "created_at", op: "gt", value: ts("2026-11-01T00:00:00Z") }),
      fm("created_at"),
    ),
  ).toEqual({ createdAt: { gt: "2026-11-01T00:00:00.000Z" } });
  expect(constraintFilter(c({ kind: "null", column: "assignee", negated: false }), fm("assignee"))).toEqual({
    assignee: { null: true },
  });
  expect(constraintFilter(c({ kind: "contains", column: "labels", value: "Bug" }), fm("labels"))).toEqual({
    labels: { some: { name: { eq: "Bug" } } },
  });
  expect(constraintFilter(c({ kind: "prefix", column: "title", value: "SAML" }), fm("title"))).toEqual({
    title: { startsWith: "SAML" },
  });
  // Strings have no order in Linear's comparators: a range on a string is not pushed.
  expect(constraintFilter(c({ kind: "cmp", column: "title", op: "gt", value: "a" }), fm("title"))).toBeUndefined();
});

test("pushdown: state 'open'/'closed' maps onto workflow state types", () => {
  const f = (x: Constraint) => constraintFilter(x, fm("state"));
  expect(f({ kind: "cmp", column: "state", op: "eq", value: "closed" })).toEqual({
    state: { type: { in: ["completed", "canceled"] } },
  });
  expect(f({ kind: "cmp", column: "state", op: "ne", value: "closed" })).toEqual({
    state: { type: { nin: ["completed", "canceled"] } },
  });
  expect(f({ kind: "in", column: "state", values: ["open", "closed"] })).toBeUndefined();
});

test("pushdown: closed_at ranges become an OR of completedAt / canceledAt", () => {
  expect(
    constraintFilter(
      { kind: "cmp", column: "closed_at", op: "lt", value: ts("2026-11-01T00:00:00Z") },
      fm("closed_at"),
    ),
  ).toEqual({
    or: [{ completedAt: { lt: "2026-11-01T00:00:00.000Z" } }, { canceledAt: { lt: "2026-11-01T00:00:00.000Z" } }],
  });
});

test("buildFilter: parts AND together, duplicates collapse, raw filter first", () => {
  const cs: Constraint[] = [
    { kind: "cmp", column: "team_key", op: "eq", value: "ENG" },
    { kind: "cmp", column: "repo", op: "eq", value: "ENG" },
    { kind: "cmp", column: "unknown", op: "eq", value: "x" },
  ];
  expect(buildFilter(cs, ISSUE_FILTERS)).toEqual({ team: { key: { eq: "ENG" } } });
  expect(buildFilter(cs, ISSUE_FILTERS, { priority: { lte: 2 } })).toEqual({
    and: [{ priority: { lte: 2 } }, { team: { key: { eq: "ENG" } } }],
  });
  expect(buildFilter([], ISSUE_FILTERS)).toBeUndefined();
  expect(() => parseRawFilter("[1]", "IssueFilter")).toThrow(/JSON object/);
  expect(parseRawFilter("", "IssueFilter")).toBeNull();
});

test("columns: dotted paths become nested selections; values convert", () => {
  expect(selOf("assignee.displayName")).toBe("assignee { displayName }");
  expect(selOf("issue.team.key")).toBe("issue { team { key } }");
  expect(asTime("2026-11-01T00:00:00.000Z")).toBe(ts("2026-11-01T00:00:00Z"));
  expect(asTime(null)).toBeNull();
  expect(asDate("2026-11-28")).toEqual(asDate("2026-11-28T00:00:00Z"));
  expect(asDate("junk")).toBeNull();
});

test("page sizes stay inside the complexity budget", () => {
  expect(pageSizeFor(2, 100)).toBe(100);
  expect(pageSizeFor(60, 250)).toBe(83);
  expect(pageSizeFor(100_000, 50)).toBe(1);
});

// Every query shape the worker can send, with every column selected, must validate
// against Linear's public schema — the same check the mock server applies at runtime.
describe("generated queries validate against the vendored Linear schema", () => {
  test("every object is covered", () => expect(SPECS.length).toBe(FUNCTIONS.length + TABLES.length));
  for (const spec of SPECS) {
    test(`${spec.name}: every query shape is valid for Linear`, () => {
      const { sel } = selectionFor(spec.columns, new Set(spec.columns.map((c) => c.name)));
      const bools = Object.values(spec.boolArgs ?? {});
      const docs: string[] = [];
      if (!spec.perIssue?.fanout) docs.push(rootQuery(spec, sel, [...bools, ...Object.keys(spec.fixedBools ?? {})]));
      if (spec.perIssue) docs.push(issueChildQuery(spec.perIssue.connection, sel, bools));
      if (spec.perIssue?.fanout) docs.push(fanoutQuery(spec.perIssue.connection, sel, bools));
      for (const doc of docs) expect(validate(SCHEMA, parse(doc)).map((e) => e.message)).toEqual([]);
    });
  }
});

describe("linearQuery against a local server", () => {
  let server: ReturnType<typeof Bun.serve>;
  let mode = "ok";
  let hits = 0;
  const cfg = (): LinearConfig => ({ url: `http://127.0.0.1:${server.port}/graphql`, auth: "k", kind: "api_key" });

  beforeAll(() => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        hits++;
        if (req.headers.get("Authorization") !== "k") return new Response("{}", { status: 401 });
        if (mode === "ratelimited" && hits === 1) {
          return Response.json(
            { errors: [{ message: "Rate limit exceeded", extensions: { code: "RATELIMITED" } }] },
            {
              status: 400,
              headers: {
                "X-RateLimit-Requests-Remaining": "0",
                "X-RateLimit-Requests-Reset": String(Date.now() + 200),
              },
            },
          );
        }
        if (mode === "errors") {
          return Response.json({
            data: null,
            errors: [{ message: "Forbidden: admins only", extensions: { code: "FORBIDDEN" } }],
          });
        }
        return Response.json({ data: { viewer: { id: "u1" } } }, { headers: { "X-Complexity": "1.1" } });
      },
    });
  });
  afterAll(() => server?.stop(true));

  test("returns data and the reported complexity", async () => {
    mode = "ok";
    hits = 0;
    resetBuckets();
    expect(await linearQuery(cfg(), "query V { viewer { id } }")).toEqual({
      data: { viewer: { id: "u1" } },
      complexity: 1.1,
    });
  });

  test("RATELIMITED waits for the reset and retries", async () => {
    mode = "ratelimited";
    hits = 0;
    resetBuckets();
    const t0 = Date.now();
    expect((await linearQuery(cfg(), "query V { viewer { id } }")).data).toEqual({ viewer: { id: "u1" } });
    expect(hits).toBe(2);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
  });

  test("GraphQL errors raise LinearError with the code; forbidden is detectable", async () => {
    mode = "errors";
    resetBuckets();
    const err = await linearQuery(cfg(), "query V { viewer { id } }").catch((e) => e);
    expect(err).toBeInstanceOf(LinearError);
    expect(err.code).toBe("FORBIDDEN");
    expect(err.forbidden).toBe(true);
    expect(err.message).toMatch(/FORBIDDEN: Forbidden: admins only/);
  });
});

describe("the worker subprocess", () => {
  let client: VgiClient;

  beforeAll(() => {
    client = new VgiClient(subprocessConnect([process.execPath, "run", join(ROOT, "src", "worker.ts")]));
  });
  afterAll(() => client?.close());

  // Fixture-backed results are covered end to end through DuckDB in test/sql (all
  // transports); here the worker must fail clearly when no linear secret is attached.
  test("a scan without a linear secret explains how to create one", async () => {
    const run = async () => {
      for await (const _ of client.tableFunctionRows({
        functionName: "issues",
        arguments: new Arguments([], new Map()),
        int64: "bigint",
      })) {
        // no rows expected
      }
    };
    await expect(run()).rejects.toThrow(/CREATE SECRET \(TYPE linear/);
  });
});

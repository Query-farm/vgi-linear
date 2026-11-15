/**
 * Linear GraphQL client: authentication, complexity-aware rate limiting, retries.
 *
 * - **Auth.** A `linear` DuckDB secret carries either a personal API key
 *   (`Authorization: <key>`, Linear's convention for `lin_api_…` keys) or an OAuth 2.0
 *   access token (`Authorization: Bearer <token>`), plus an optional `base_url` for a
 *   fixture or proxy. Credentials are read from the secret on every call and never
 *   enter table-function state.
 * - **Read-only.** `linearQuery` refuses any document that is not a single `query`
 *   operation, so no code path can send a mutation.
 * - **Rate limits.** Linear meters both requests and query complexity per hour and
 *   reports them in `X-RateLimit-Requests-*` / `X-RateLimit-Complexity-*` headers
 *   (reset = epoch milliseconds) plus `X-Complexity` for the query just run. When a
 *   bucket is nearly empty the client waits for its reset (bounded) instead of burning
 *   a request; a `RATELIMITED` error (HTTP 400 or 429) waits and retries. 5xx and
 *   network errors retry with exponential backoff.
 */

import { createHash } from "node:crypto";
import { secretOfType } from "@query-farm/vgi";
import { log } from "../log.ts";
import { VERSION } from "../meta.ts";

export const SECRET_TYPE = "linear";
export const DEFAULT_BASE_URL = "https://api.linear.app/graphql";
export const TIMEOUT_MS = 30_000;
export const MAX_ATTEMPTS = 5;
/** Longest single wait for a rate-limit reset. */
export const MAX_RATE_WAIT_MS = 65_000;
const USER_AGENT = `vgi-linear-worker/${VERSION}`;

export interface GqlError {
  message: string;
  path?: (string | number)[];
  extensions?: { code?: string; type?: string; userPresentableMessage?: string };
}

export class LinearError extends Error {
  constructor(
    message: string,
    readonly status = 0,
    readonly code = "",
    readonly errors: GqlError[] = [],
  ) {
    super(message);
  }
  /** True when the error is about permissions (FORBIDDEN, admin-only, scope). */
  get forbidden(): boolean {
    return (
      this.code === "FORBIDDEN" ||
      this.status === 403 ||
      this.errors.some((e) => /forbidden|permission|not authori[sz]ed|admin|scope/i.test(e.message))
    );
  }
  /** True when an entity looked up by id does not exist. */
  get notFound(): boolean {
    return this.errors.some((e) => /not found/i.test(e.message)) || this.code === "ENTITY_NOT_FOUND";
  }
  /** True when Linear rejected the query as too complex for a single request. */
  get tooComplex(): boolean {
    return this.errors.some((e) => /too complex|complexity/i.test(e.message)) || this.code === "QUERY_TOO_COMPLEX";
  }
}

export interface LinearConfig {
  url: string;
  /** The Authorization header value (secret). */
  auth: string;
  kind: "api_key" | "oauth";
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Normalize the GraphQL endpoint: https (http only for loopback); a bare host gets /graphql. */
export function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new LinearError(`linear secret: base_url '${raw}' is not a URL (expected e.g. ${DEFAULT_BASE_URL})`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    throw new LinearError(
      "linear secret: base_url must use https:// (http:// is accepted only for 127.0.0.1/localhost)",
    );
  }
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path === "" ? "/graphql" : path}`;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

/** Build the client config from the `linear` secret DuckDB resolved for this call. */
export function configFromSecrets(secrets: Record<string, Record<string, unknown>>): LinearConfig {
  const s = secretOfType(secrets as never, SECRET_TYPE) as Record<string, unknown> | undefined;
  if (!s) {
    throw new LinearError(
      "no linear secret: run CREATE SECRET (TYPE linear, API_KEY 'lin_api_…') with a personal API key " +
        "(Settings > Security & access > Personal API keys), or ACCESS_TOKEN '…' for an OAuth 2.0 token",
    );
  }
  const url = normalizeBaseUrl(str(s.base_url) ?? DEFAULT_BASE_URL);
  const apiKey = str(s.api_key);
  const token = str(s.access_token);
  if (apiKey && token) throw new LinearError("linear secret: set API_KEY or ACCESS_TOKEN, not both");
  if (apiKey) return { url, auth: apiKey.replace(/^Bearer\s+/i, ""), kind: "api_key" };
  if (token) return { url, auth: `Bearer ${token.replace(/^Bearer\s+/i, "")}`, kind: "oauth" };
  throw new LinearError("linear secret: API_KEY (personal API key) or ACCESS_TOKEN (OAuth 2.0) is required");
}

/** A short, stable, non-reversible id for one credential (per-key caches and buckets). */
export function credentialId(cfg: LinearConfig): string {
  return createHash("sha256").update(`${cfg.url}\u0000${cfg.auth}`).digest("hex").slice(0, 16);
}

/** Reject anything but a single read-only `query` operation (defence in depth). */
export function assertReadOnly(document: string): void {
  const stripped = document.replace(/#[^\n]*/g, "").trim();
  if (!/^query\b/.test(stripped) || /\b(mutation|subscription)\b/.test(stripped)) {
    throw new LinearError("refusing to send a non-query GraphQL operation: this worker is read-only");
  }
}

interface Bucket {
  requestsRemaining?: number;
  requestsReset?: number;
  complexityRemaining?: number;
  complexityReset?: number;
  lastComplexity: number;
}
/** Last rate-limit reading per credential (module-level: one process, many scans). */
const buckets = new Map<string, Bucket>();

/** Forget rate-limit readings (tests). */
export function resetBuckets(): void {
  buckets.clear();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const num = (h: Headers, name: string): number | undefined => {
  const v = h.get(name);
  return v != null && /^\d+(\.\d+)?$/.test(v) ? Number(v) : undefined;
};

/** Epoch-ms reset → a bounded wait; Linear's resets are epoch milliseconds (seconds tolerated). */
export function waitUntil(reset: number | undefined, now = Date.now()): number | undefined {
  if (reset === undefined) return undefined;
  const ms = reset < 1e12 ? reset * 1000 : reset;
  return Math.min(Math.max(0, ms - now) + 100, MAX_RATE_WAIT_MS);
}

/** How long a RATELIMITED answer asks us to wait (reset headers, then Retry-After). */
export function rateLimitDelayMs(headers: Headers, attempt: number, now = Date.now()): number {
  const resets = [num(headers, "X-RateLimit-Requests-Reset"), num(headers, "X-RateLimit-Complexity-Reset")];
  const remaining = [num(headers, "X-RateLimit-Requests-Remaining"), num(headers, "X-RateLimit-Complexity-Remaining")];
  // Prefer the reset of the bucket that is actually exhausted.
  for (let i = 0; i < 2; i++) {
    if (remaining[i] !== undefined && (remaining[i] as number) <= 0) {
      const w = waitUntil(resets[i], now);
      if (w !== undefined) return w;
    }
  }
  const retry = num(headers, "Retry-After");
  if (retry !== undefined) return Math.min(retry * 1000, MAX_RATE_WAIT_MS);
  const any = resets.map((r) => waitUntil(r, now)).find((w) => w !== undefined);
  return any ?? Math.min(1000 * attempt, MAX_RATE_WAIT_MS);
}

function recordBucket(key: string, h: Headers, complexity: number | undefined): void {
  const b: Bucket = buckets.get(key) ?? { lastComplexity: 0 };
  b.requestsRemaining = num(h, "X-RateLimit-Requests-Remaining") ?? b.requestsRemaining;
  b.requestsReset = num(h, "X-RateLimit-Requests-Reset") ?? b.requestsReset;
  b.complexityRemaining = num(h, "X-RateLimit-Complexity-Remaining") ?? b.complexityRemaining;
  b.complexityReset = num(h, "X-RateLimit-Complexity-Reset") ?? b.complexityReset;
  if (complexity !== undefined) b.lastComplexity = complexity;
  buckets.set(key, b);
}

/** Wait before sending when the last reading says the next call would be rejected. */
async function pace(key: string): Promise<void> {
  const b = buckets.get(key);
  if (!b) return;
  const now = Date.now();
  let wait: number | undefined;
  if (b.requestsRemaining !== undefined && b.requestsRemaining <= 1) wait = waitUntil(b.requestsReset, now);
  if (b.complexityRemaining !== undefined && b.complexityRemaining < Math.max(1, b.lastComplexity)) {
    wait = Math.max(wait ?? 0, waitUntil(b.complexityReset, now) ?? 0);
  }
  if (wait && wait > 100) {
    log.info(`linear: rate-limit budget nearly spent; waiting ${wait} ms for the reset`);
    await sleep(wait);
    // Assume the reset happened; the next response refreshes the reading.
    b.requestsRemaining = undefined;
    b.complexityRemaining = undefined;
  }
}

export interface QueryResult {
  data: Record<string, unknown>;
  /** The `X-Complexity` the server charged for this query, if reported. */
  complexity?: number;
}

function describe(errors: GqlError[]): string {
  return errors
    .map((e) => {
      const code = e.extensions?.code ? `${e.extensions.code}: ` : "";
      const path = e.path?.length ? ` (at ${e.path.join(".")})` : "";
      return `${code}${e.extensions?.userPresentableMessage ?? e.message}${path}`;
    })
    .join("; ")
    .slice(0, 500);
}

/**
 * Run one read-only GraphQL query. Throws `LinearError` for transport failures and for
 * any GraphQL `errors` (Linear's partial results are not trusted: a null from a
 * non-null field would silently drop rows).
 */
export async function linearQuery(
  cfg: LinearConfig,
  document: string,
  variables: Record<string, unknown> = {},
): Promise<QueryResult> {
  assertReadOnly(document);
  const key = credentialId(cfg);
  const body = JSON.stringify({ query: document, variables });

  for (let attempt = 1; ; attempt++) {
    await pace(key);
    let res: Response;
    try {
      res = await fetch(cfg.url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: cfg.auth,
          "User-Agent": USER_AGENT,
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) throw new LinearError(`POST ${cfg.url} failed: ${(err as Error).message}`);
      await sleep(250 * 2 ** attempt);
      continue;
    }
    const complexity = num(res.headers, "X-Complexity");
    recordBucket(key, res.headers, complexity);
    const text = await res.text();
    let json: { data?: Record<string, unknown> | null; errors?: GqlError[] } | undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    const errors = json?.errors ?? [];
    const code = errors.find((e) => e.extensions?.code)?.extensions?.code ?? "";
    const rateLimited = res.status === 429 || code === "RATELIMITED";
    if (rateLimited || res.status >= 500) {
      if (attempt >= MAX_ATTEMPTS) {
        throw new LinearError(
          `Linear GraphQL request failed with HTTP ${res.status}${errors.length ? `: ${describe(errors)}` : ""}`,
          res.status,
          code,
          errors,
        );
      }
      const delay = rateLimited ? rateLimitDelayMs(res.headers, attempt) : 250 * 2 ** attempt;
      log.info(`linear: HTTP ${res.status}${code ? ` ${code}` : ""}; retry ${attempt} in ${delay} ms`);
      await sleep(delay);
      continue;
    }
    if (!res.ok || errors.length || !json?.data) {
      const detail = errors.length ? describe(errors) : text.slice(0, 300);
      throw new LinearError(`Linear GraphQL request failed (HTTP ${res.status}): ${detail}`, res.status, code, errors);
    }
    return { data: json.data, complexity };
  }
}

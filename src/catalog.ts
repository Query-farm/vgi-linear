/**
 * Assemble the `linear` catalog: the table functions, the parameterless collections as
 * tables, and the `linear` secret type.
 */

import { type CatalogDescriptor, field, schema, utf8, type VgiFunction } from "@query-farm/vgi";
import { DEFAULT_BASE_URL, SECRET_TYPE } from "./linear/client.ts";
import { FUNCTIONS, TABLES } from "./linear/resources.ts";
import { CATALOG_COMMENT, CATALOG_NAME, CATALOG_TAGS, SCHEMA_COMMENT, SCHEMA_TAGS, SOURCE_URL } from "./meta.ts";

export { FUNCTIONS, TABLES };

const doc = (text: string) => new Map([["vgi_doc", text]]);
const redacted = (text: string) =>
  new Map([
    ["redact", "true"],
    ["vgi_doc", text],
  ]);

/** CREATE SECRET (TYPE linear, API_KEY 'lin_api_…') — or ACCESS_TOKEN for OAuth 2.0. */
export const LINEAR_SECRET_TYPE = {
  name: SECRET_TYPE,
  description: "A Linear personal API key or OAuth 2.0 access token (plus an optional GraphQL endpoint)",
  schema: schema(
    [
      field(
        "api_key",
        utf8(),
        true,
        redacted("Personal API key (lin_api_…, Settings > Security & access). Sent as `Authorization: <key>`."),
      ),
      field(
        "access_token",
        utf8(),
        true,
        redacted("OAuth 2.0 access token (read scope is enough). Sent as `Authorization: Bearer <token>`."),
      ),
      field(
        "base_url",
        utf8(),
        true,
        doc(`GraphQL endpoint; default ${DEFAULT_BASE_URL} (http:// is accepted only for 127.0.0.1/localhost).`),
      ),
    ],
    new Map([["vgi_doc_url", "https://linear.app/developers/graphql#authentication"]]),
  ),
};

interface Example {
  description: string;
  sql: string;
}

/** Publish each function's examples as `vgi.example_queries`; return them all for the schema. */
function stampExampleQueries(functions: VgiFunction[]): Example[] {
  const all: Example[] = [];
  for (const fn of functions) {
    const ex = (fn.meta.examples ?? []).map((e) => ({ description: e.description, sql: e.sql }));
    fn.meta.tags = { ...fn.meta.tags, "vgi.example_queries": JSON.stringify(ex) };
    all.push(...ex);
  }
  return all;
}

const ALL_EXAMPLES = [
  ...stampExampleQueries(FUNCTIONS),
  ...TABLES.flatMap((t) => JSON.parse(t.tags?.["vgi.example_queries"] ?? "[]") as Example[]),
];

export const CATALOG: CatalogDescriptor = {
  name: CATALOG_NAME,
  comment: CATALOG_COMMENT,
  sourceUrl: SOURCE_URL,
  tags: CATALOG_TAGS,
  secretTypes: [LINEAR_SECRET_TYPE],
  schemas: [
    {
      path: ["main"],
      comment: SCHEMA_COMMENT,
      functions: FUNCTIONS,
      tables: TABLES,
      tags: { ...SCHEMA_TAGS, "vgi.example_queries": JSON.stringify(ALL_EXAMPLES.slice(0, 12)) },
    },
  ],
};

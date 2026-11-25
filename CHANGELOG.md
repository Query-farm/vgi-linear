# Changelog

## 0.2.0 (2026-11-25)

- VGI protocol 3.4: bump @query-farm/vgi to 0.52 and @query-farm/vgi-rpc to 0.30. **Requires the
  3.4 vgi extension**: DuckDB 2.0 (`INSTALL vgi FROM query_farm`) or Haybarn 2.0.1+; Haybarn 2.0.0
  still serves the 3.3 extension, which cannot attach this worker.
- The Docker image supports Orchard hosted mode (`VGI_ORCHARD_HOSTED=1`): HTTP only, Orchard Pass
  authentication, large values through the Orchard blob vendor; the HEALTHCHECK uses `HEAD /health`.
- CI and `make` run the SQL tests on haybarn-unittest 2.0.1rc3.

## 0.1.3 (2026-11-16)

- CI tooling (haybarn-unittest, lint helpers) runs on Python 3.14.

## 0.1.2 (2026-11-16)

- Bump @query-farm/vgi to 0.50.1.

## 0.1.1

- Catalog and schema docs are overviews instead of object lists, and schemas have their own one-line comments (vgi-lint 2.8: VGI173, VGI102).

## 0.1.0

Initial release: Linear issue tracking as SQL through the Linear GraphQL API (read-only).

- `issues()` with SQL → `IssueFilter` pushdown and GraphQL projection; tracker-aligned columns
  (repo, key, number, state, status, assignee(s), user_login, labels, html_url, closed_at).
- `issue_history()` (state transitions, cycle time), `comments()`, `attachments()`,
  `issue_relations()`; catalog tables for teams, workflow states, labels, users, projects,
  milestones, project updates, cycles, initiatives, roadmaps, customers, customer needs and
  the audit log.
- Complexity-aware page sizing, Linear rate-limit headers honoured, resumable relay cursors.
- `linear` secret: API_KEY or ACCESS_TOKEN, optional BASE_URL.
- Offline tests against a schema-validating GraphQL server over a fixture workspace.

Generated from the VGI starter template v1.3.0.

Targets: @query-farm/vgi 0.50 · VGI protocol 3.3 · Haybarn 2.0.1rc3 · vgi-lint-check 2.x (unpinned)

# Changelog

## 0.1.0 (unreleased)

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

Targets: @query-farm/vgi 0.50 · VGI protocol 3.3 · Haybarn 2.0.0rc11 · vgi-lint-check 2.x (unpinned)

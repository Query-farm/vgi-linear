<p align="center">
  <img src="https://query.farm/media-kit/products/vgi/vgi-logo.png" alt="Vector Gateway Interface (VGI)" width="320">
</p>

<p align="center"><em>A Query.Farm VGI worker for DuckDB.</em></p>

# Query Linear Issues, Cycle Time, Projects and Customers in DuckDB

> **vgi-linear** · a [Query.Farm](https://query.farm) VGI worker · written in TypeScript

[![CI](https://github.com/Query-farm/vgi-linear/actions/workflows/ci.yml/badge.svg)](https://github.com/Query-farm/vgi-linear/actions/workflows/ci.yml)
[![vgi worker: query.farm](https://query.farm/media-kit/shields/vgi-worker.svg)](https://query.farm)

Linear issue tracking as SQL, read-only, through the
[Linear GraphQL API](https://linear.app/developers/graphql): issues with their full change
history, comments, attachments and relations; teams, workflow states, labels and users;
projects, milestones, project updates, cycles, initiatives and roadmaps; customers and
customer requests; and the audit log.

```sql
CREATE SECRET linear (TYPE linear, API_KEY 'lin_api_…');

-- Open ENG work by priority (one IssueFilter, only the selected fields fetched).
SELECT key, title, status, assignee
FROM linear.main.issues()
WHERE team_key = 'ENG' AND state = 'open'
ORDER BY priority, key;

-- Cycle time in hours: first move to a started state → completion, per issue.
SELECT issue_key, (epoch_ms(done) - epoch_ms(started)) / 3600000 AS cycle_time_hours
FROM (SELECT issue_key,
             min(created_at) FILTER (WHERE to_state_type = 'started')   AS started,
             max(created_at) FILTER (WHERE to_state_type = 'completed') AS done
      FROM linear.main.issue_history() WHERE team_key = 'ENG' GROUP BY issue_key)
WHERE done IS NOT NULL ORDER BY cycle_time_hours DESC;
```

## Functions and tables

Everything lives in `linear.main`. Table functions take named arguments; the rest are
catalog tables (`SELECT … FROM linear.main.teams`).

| Object | Linear query | What pushes down |
|---|---|---|
| `issues(include_archived := false, filter := NULL, page_size := 100)` | `issues(filter: IssueFilter, orderBy: updatedAt)` | `key`/`id` (`=`, `IN`), `repo`/`team_key` (`=`, `IN`, `starts_with`), `team_id`, `number`, `title` (`=`, prefix), `state` ('open'/'closed' → state types), `status`, `status_type`, `state_id`, `priority`, `estimate`, `assignee`/`assignee_id`/`assignee_name`, `user_login`/`creator_id`, `list_contains(labels \| label_ids, …)`, `project`/`project_id`, `project_milestone`, `cycle_number`/`cycle_id`, `parent_key`/`parent_id`, `IS [NOT] NULL` on nullable relations and dates, ranges on `created_at`/`updated_at`/`started_at`/`completed_at`/`canceled_at`/`closed_at`/`triaged_at`. `filter :=` adds a raw `IssueFilter` JSON object |
| `issue_history(issue_key := NULL, include_archived := false, page_size := 50)` | `issue(id:) { history }`, or `issues { history }` fan-out | `issue_key`/`issue_id` (`=`, `IN`) read only those issues; otherwise `team_key` narrows the issues fanned out over |
| `comments(issue_key := NULL, include_archived := false, page_size := 100)` | `comments(filter: CommentFilter)` | `issue_key`/`issue_id` (`=`, `IN`, `IS NULL`), `team_key`, `user_login`, `user_id`, time ranges |
| `attachments(issue_key := NULL, page_size := 100)` | `issue(id:) { attachments }` or `attachments(filter:)` | `issue_key`/`issue_id`; otherwise `title`, `url`, `source_type`, `user_login`, time ranges |
| `issue_relations(issue_key := NULL, page_size := 100)` | `issue(id:) { relations }` or `issueRelations` | `issue_key`/`issue_id` |
| `teams` | `teams(filter: TeamFilter)` | `id`, `key`, `name`, `private`, time ranges |
| `workflow_states` | `workflowStates(filter:)` | `id`, `name`, `type`, `team_key`, `team_id`, time ranges |
| `labels` | `issueLabels(filter:)` | `id`, `name`, `is_group`, `team_key` (incl. `IS NULL` = workspace labels), `parent_name` |
| `users` | `users(includeDisabled: true, filter:)` | `id`, `display_name`/`user_login`, `name`, `email`, `active`, `admin`, `app`, `is_me` |
| `projects` | `projects(filter: ProjectFilter)` | `id`, `name`, `status`, `status_type`, `health`, `lead`, `priority`, lifecycle ranges |
| `project_milestones` | `projectMilestones(filter:)` | `id`, `name`, `project`, `project_id`, time ranges |
| `project_updates` | `projectUpdates(filter:)` | `id`, `project`, `project_id`, `user_login`, time ranges |
| `cycles` | `cycles(filter: CycleFilter)` | `id`, `number`, `name`, `team_key`, `team_id`, `is_active`/`is_future`/`is_past`/`is_next`/`is_previous`, `starts_at`/`ends_at` ranges |
| `initiatives` | `initiatives(filter:)` | `id`, `name`, `status`, `health`, `owner` |
| `roadmaps` | `roadmaps` | — (no filter in the API; zero rows where roadmaps are unavailable) |
| `customers` | `customers(filter:)` | `id`, `name`, `revenue`, `size`, `owner` (zero rows when Customers is not enabled for the key) |
| `customer_needs` | `customerNeeds(filter:)` | `id`, `issue_key`/`issue_id` (incl. `IS NULL`), `customer`, `customer_id`, `project`, `priority` |
| `audit_entries` | `auditEntries(filter:)` | `id`, `type` (`=`, `IN`, prefix), `ip`, `country_code`, `user_login`, `actor_id`, time ranges. **Admin keys only**: a non-admin key gets a clear error |

Pushdown only narrows the request. The SDK re-applies every pushed predicate to each batch
(`autoApplyFilters`), so results are exact; predicates under `OR`/`NOT` and anything not
listed are filtered by DuckDB.

**GraphQL projection.** Each column knows the GraphQL selection it needs
(`assignee { displayName }`, `labels(first: 50) { nodes { name } }`, …); only the
selections of the columns you select (plus those your `WHERE` reads) are requested, so a
`SELECT key, title` never pays for labels or descriptions.

### Columns that line up with GitHub, GitLab and Jira

Issue columns use the names of the `vgi-github`, `vgi-gitlab` and `vgi-jira` workers so
issues UNION across trackers: `repo` (the team key), `key` (ENG-123), `number`, `title`,
`state` (`'open'`/`'closed'`; closed = a completed or canceled workflow state), `status`
(the workflow state name), `assignee`, `assignees` (a list; Linear has at most one),
`user_login` (the creator), `labels` (`VARCHAR[]`), `milestone`, `body` (Markdown),
`html_url`, `created_at`, `updated_at` and `closed_at` (`completed_at`, else
`canceled_at`). Linear-native columns (`status_type`, `priority`, `estimate`,
`cycle_number`, `project`, `parent_key`, …) are present too.

```sql
SELECT 'linear' AS tracker, repo, number, title, state, user_login, html_url, created_at
FROM linear.main.issues()
UNION ALL
SELECT 'gitlab', repo, number, title, state, user_login, html_url, created_at
FROM gitlab.main.issues('acme/web');
```

Types are real: timestamps are `TIMESTAMPTZ`, `due_date`/`target_date` are `DATE`,
numbers are `BIGINT`/`INTEGER`/`DOUBLE`, flags `BOOLEAN`, label and team lists
`VARCHAR[]`; only open shapes (attachment `metadata`, audit `metadata` /
`request_information`) are `JSON`.

## Authentication

Create one `linear` secret with exactly one of:

- **Personal API key:** `API_KEY 'lin_api_…'` (*Settings → Security & access → Personal
  API keys*). Sent as `Authorization: <key>`, as Linear requires.
- **OAuth 2.0 access token:** `ACCESS_TOKEN '…'` from your OAuth app (the `read` scope is
  enough). Sent as `Authorization: Bearer <token>`.

`BASE_URL` (optional) overrides the endpoint, `https://api.linear.app/graphql` by
default (`http://` is accepted only for `127.0.0.1`/`localhost` test servers). `API_KEY`
and `ACCESS_TOKEN` are redacted secret fields; credentials are read from the secret on
every call and never stored in scan state.

**Scope feature-detection.** The worker never asks for more than the key may see:

- `users.email` — when Linear refuses the field for this key, the scan is retried without
  it and `email` is `NULL`.
- `audit_entries` — needs a workspace admin; other keys get an error that says so.
- `customers` / `customer_needs` / `roadmaps` — zero rows when the workspace or key has no
  access to the feature.

## Paging, rate limits and complexity

Each GraphQL page becomes one Arrow batch. The relay cursor (`after`, plus the pending
issue keys during a history fan-out) lives in the table function's serializable state, so
long scans resume on any worker process over the HTTP transport.

Linear meters requests and **query complexity** per hour. Every response's
`X-RateLimit-Requests-*`, `X-RateLimit-Complexity-*` and `X-Complexity` headers are
tracked: a `RATELIMITED` answer waits for the exhausted bucket's reset (up to 65 s) and
retries, the worker pauses on its own when the next query would not fit the remaining
budget, and 5xx / network errors retry with exponential backoff. Page sizes are chosen
from an estimate of each query's complexity (Linear: 0.1 per field, 1 per object, nested
connections × `first`) to stay under half of Linear's 10,000-point per-query limit; if
Linear still answers "query too complex", the page size is halved and the page retried.

Only `query` operations are ever sent: the client refuses any document containing a
mutation or subscription.

## Install

**Prerequisites:** [Bun](https://bun.sh) 1.3+ (for a source checkout).

```bash
git clone https://github.com/Query-farm/vgi-linear.git && cd vgi-linear
git checkout v0.1.0
bun install --frozen-lockfile
```

**DuckDB 2.0:**

```sql
SET allow_extension_repositories = 'allowed';
CREATE EXTENSION REPOSITORY IF NOT EXISTS query_farm WITH PREFIX 'https://duckdb-extensions.query.farm';
INSTALL vgi FROM query_farm;
LOAD vgi FROM query_farm;
ATTACH 'linear' (TYPE vgi, LOCATION '/abs/path/to/vgi-linear/bin/vgi-linear-worker');
CREATE SECRET linear (TYPE linear, API_KEY 'lin_api_…');
```

**Haybarn 2.0.1+** (`uvx haybarn-cli`; Haybarn 2.0.0 serves an older vgi extension that cannot attach this worker):

```sql
INSTALL vgi FROM community;
LOAD vgi;
ATTACH 'linear' (TYPE vgi, LOCATION '/abs/path/to/vgi-linear/bin/vgi-linear-worker');
```

`LOCATION` is the command DuckDB runs, so use an absolute path. Tagged releases ship
signed standalone executables (no Bun needed); point `LOCATION` at the downloaded binary.
The same binary serves HTTP with `--http --port 8000` (see the `Dockerfile`).

## Testing

```bash
make test-unit                 # bun unit tests (filter translation, rate limits, query validation)
make test-sql                  # test/sql/linear.test through Haybarn 2.0 (stdio)
make test-sql TRANSPORT=http   # …over HTTP (also: launch)
make check                     # everything CI runs
```

No test touches the network or a real Linear workspace. `test/mock_api/server.ts` is a
strict GraphQL server over a hand-built workspace (`test/fixtures/workspace.json`):

- every request is parsed and **validated against Linear's public schema**, vendored
  unmodified in `test/fixtures/linear-schema/schema.graphql` (MIT, from
  [linear/linear](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql),
  license alongside), so a field or argument Linear does not have fails the test;
- queries are **executed** with a generic resolver that evaluates `IssueFilter`,
  `TeamFilter`, … (comparators, nested relation filters, `some`/`every`, `and`/`or`) and
  pages with relay cursors, and an unsupported filter key is an error, so pushdown is
  genuinely asserted;
- it computes Linear-style complexity (`X-Complexity`) and refuses over-limit queries,
  sends rate-limit headers, answers `RATELIMITED` and 502 once per request on dedicated
  endpoints, refuses mutations, and models a member OAuth token that may not read emails,
  the audit log or customers.

The SQL tests read its `/__requests` log to check exactly which filter and selection were
sent, and finish by asserting that no request failed schema validation. The unit tests
also validate every query shape of every object (all columns selected) against the
schema.

The metadata check runs with `execute: false` in CI: every object needs a `linear` secret
for a live workspace.

## Authorship & License

Written by [Query.Farm](https://query.farm). Released under the
[BSD Zero Clause License](LICENSE) (0BSD). The vendored Linear schema in
`test/fixtures/linear-schema/` is © Linear, MIT-licensed (see its `LICENSE`).

Copyright 2026 Query Farm LLC - https://query.farm

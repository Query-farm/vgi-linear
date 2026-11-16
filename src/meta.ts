/**
 * Discovery metadata: the one file to edit when you rename or extend the worker.
 *
 * DuckDB, coding agents and the `vgi-lint` metadata checker all read these
 * tags. Keep every object documented and `make lint-explain` stays at 100.
 */

import { field, type VgiDataType, type VgiField } from "@query-farm/vgi";

export const CATALOG_NAME = "linear";
export const VERSION = "0.1.0";

export const SOURCE_URL = "https://github.com/Query-farm/vgi-linear";

/** Categories group objects in docs and agent tools; every `vgi.category` names one. */
export const SCHEMA_CATEGORIES = [
  {
    name: "issues",
    title: "Issues",
    description: "Linear issues and their history, comments, attachments and relations.",
  },
  {
    name: "workspace",
    title: "Workspace Configuration",
    description: "Teams, workflow states, labels and users.",
  },
  {
    name: "planning",
    title: "Planning",
    description: "Projects, milestones, project updates, cycles, initiatives and roadmaps.",
  },
  { name: "customers", title: "Customers", description: "Customers and the customer requests (needs) they raise." },
  { name: "audit", title: "Audit Log", description: "The workspace audit log (admin API keys only)." },
] as const;

export type Category = (typeof SCHEMA_CATEGORIES)[number]["name"];

/** Turn `"a, b, c"` into the JSON array string `vgi.keywords` requires. */
export function keywordsArray(keywords: string): string {
  return JSON.stringify(
    keywords
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean),
  );
}

/** Build the standard per-object discovery tags. */
export function objectTags(opts: {
  title: string;
  category: Category;
  keywords: string;
  docLlm: string;
  docMd: string;
}): Record<string, string> {
  return {
    "vgi.title": opts.title,
    "vgi.category": opts.category,
    "vgi.keywords": keywordsArray(opts.keywords),
    "vgi.doc_llm": opts.docLlm,
    "vgi.doc_md": opts.docMd,
  };
}

/** Build an Arrow field whose `comment` shows up in DuckDB's `DESCRIBE` and agent tools. */
export function column(name: string, type: VgiDataType, comment: string, nullable = true): VgiField {
  return field(name, type, nullable, new Map([["comment", comment]]));
}

const SOURCES_MD =
  "### Sources and references\n\n" +
  "- [Linear GraphQL API](https://linear.app/developers/graphql) — the API this worker reads\n" +
  "- [Filtering](https://linear.app/developers/filtering) — the filter inputs SQL predicates become\n" +
  "- [Pagination](https://linear.app/developers/pagination) — relay `first` / `after` cursors\n" +
  "- [Rate limiting](https://linear.app/developers/rate-limiting) — request and complexity budgets\n" +
  "- [Public schema](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql) (MIT)";

export const CATALOG_COMMENT =
  "Linear issue tracking as SQL: issues with state history, comments, attachments and relations, plus teams, projects, cycles, initiatives and customers, read-only from the Linear GraphQL API.";

export const CATALOG_DOC_LLM =
  "Read-only SQL access to a Linear workspace through its GraphQL API (https://api.linear.app/graphql). " +
  "Reach for it to analyse issue tracking and planning: backlogs and workload, workflow-state changes for " +
  "cycle and lead time, cycles and project progress, initiatives and customer requests. issues() is the " +
  "main entry point: WHERE filters on key / id, repo / team_key, number, title, state ('open' / " +
  "'closed'), status (workflow state name), status_type (triage, backlog, unstarted, started, completed, " +
  "canceled), priority, estimate, assignee, user_login (creator), labels (list_contains), project, " +
  "project_milestone, cycle_number, parent_key and created / updated / started / completed / canceled / " +
  "closed ranges are translated into Linear's IssueFilter input, and only the GraphQL fields of the " +
  "selected columns are requested. Issue columns align with the GitHub, GitLab and Jira workers (repo, " +
  "key, number, title, state 'open'/'closed', status, assignee, assignees, user_login, labels, body, " +
  "html_url, created_at, updated_at, closed_at) so issues UNION across trackers. Per-issue collections " +
  "(history, comments, attachments, relations) take issue_key := or a pushed issue_key = / IN; the " +
  "workspace's teams, planning objects, customers and audit log (admin keys only) are catalog tables " +
  "with their own filter pushdown. Every object needs a `linear` secret: API_KEY (personal API key) or " +
  "ACCESS_TOKEN (OAuth 2.0), optional BASE_URL. Linear's request and complexity rate limits are read " +
  "from the X-RateLimit-* headers and honoured; pages are sized to stay inside the complexity budget. " +
  "Docs: https://linear.app/developers/graphql ; filtering https://linear.app/developers/filtering ; " +
  "rate limits https://linear.app/developers/rate-limiting .";

export const CATALOG_DOC_MD =
  "# Linear\n\n" +
  "Query a Linear workspace from DuckDB: issues with their full change history and discussion, the " +
  "workspace's teams and workflow, planning (projects, cycles, initiatives, roadmaps), customer " +
  "requests and the audit log. Read-only.\n\n" +
  "Create a `linear` secret with a personal API key (`API_KEY`) or an OAuth access token " +
  "(`ACCESS_TOKEN`). WHERE filters become Linear filter inputs and only the columns you select are " +
  "fetched, so filter and project early; rate limits and query complexity are handled for you.\n\n" +
  SOURCES_MD;

export const SCHEMA_DOC_LLM =
  "Linear as SQL. Table functions take named arguments: issues(include_archived := false, filter := NULL, " +
  "page_size := 100) where filter is a raw Linear IssueFilter JSON object ANDed with the pushed WHERE " +
  "filters. Per-issue functions (issue_key := NULL) read `issue(id:)` for the keys passed or pushed " +
  "(= / IN); without keys the change-history function fans out over all issues (filter team_key to " +
  "narrow it) while attachments and relations list the whole workspace, and comments push issue_key, " +
  "team_key, user_login and time ranges into CommentFilter. Workspace objects (teams, workflow, " +
  "planning, customers, audit log) are catalog tables with their own filter pushdown. All objects need " +
  "a `linear` secret.";

export const SCHEMA_COMMENT = "Linear issues, their history and discussion, and workspace planning objects, read-only.";

export const SCHEMA_DOC_MD =
  "## main\n\n" +
  "Linear GraphQL connections as SQL: issues and their history, comments, attachments and relations " +
  "(table functions), and the workspace's teams, states, labels, users, planning objects, customers " +
  "and audit log (catalog tables).\n\n" +
  "All objects need a `linear` secret; WHERE filters push down into Linear's filter inputs.";

export const AGENT_TEST_TASKS = [
  { name: "open_eng_issues", prompt: "List the keys and titles of open issues in the ENG team." },
  { name: "urgent_count", prompt: "How many Linear issues have Urgent priority?" },
  { name: "issues_by_status", prompt: "How many ENG issues are in each workflow state?" },
  { name: "ada_assigned", prompt: "Which issues are assigned to ada and not closed yet?" },
  { name: "bug_issues", prompt: "Which issues carry the Bug label?" },
  { name: "cycle_time", prompt: "How long did ENG-1 spend between entering In Progress and reaching Done?" },
  { name: "eng1_comments", prompt: "Who commented on ENG-1, and what did they say?" },
  { name: "eng1_attachments", prompt: "What links are attached to ENG-1?" },
  { name: "blocking", prompt: "Which issues block other issues?" },
  { name: "team_list", prompt: "What teams exist in the Linear workspace and what are their keys?" },
  { name: "done_states", prompt: "Which workflow states of the ENG team count as completed?" },
  { name: "active_users", prompt: "List the display names of active Linear users." },
  { name: "at_risk_projects", prompt: "Which projects are at risk?" },
  { name: "latest_update", prompt: "What was the health of the most recent update on the Apollo project?" },
  { name: "active_cycle", prompt: "Which ENG cycle is active right now (per Linear), and when does it end?" },
  { name: "initiatives", prompt: "List the initiatives and their statuses." },
  { name: "customer_requests", prompt: "Which customers asked for ENG-2?" },
  { name: "audit_logins", prompt: "Which IP addresses appear in the audit log for user logins?" },
  {
    name: "workspace_labels",
    prompt: "Which issue labels are shared by every team rather than belonging to one team?",
  },
  { name: "top_customer", prompt: "Which customer has the highest revenue, and what tier is it in?" },
  { name: "apollo_milestones", prompt: "What milestones does the Apollo project have, and when is each due?" },
  { name: "roadmap_projects", prompt: "Which projects are on the 2026 Roadmap?" },
];

/** Bind-only probes: each binds the function and shows its columns without fetching (LIMIT 0). */
export const EXECUTABLE_EXAMPLES = [
  {
    name: "issues_columns",
    description: "The issues() result columns (binds only; create a linear secret and drop LIMIT 0 for rows)",
    sql: "SELECT key, title, state, status, assignee, created_at FROM linear.main.issues() LIMIT 0",
  },
  {
    name: "issue_history_columns",
    description: "The issue_history() result columns (binds only; create a linear secret and drop LIMIT 0 for rows)",
    sql: "SELECT issue_key, created_at, from_state, to_state, actor FROM linear.main.issue_history() LIMIT 0",
  },
];

export const CATALOG_TAGS: Record<string, string> = {
  "vgi.title": "Linear Issue Tracking",
  "vgi.subtitle": "Linear issues, history, comments, projects, cycles, initiatives and customers as SQL tables.",
  "vgi.doc_llm": CATALOG_DOC_LLM,
  "vgi.doc_md": CATALOG_DOC_MD,
  "vgi.source_url": SOURCE_URL,
  "vgi.icon_url": "https://query.farm/media-kit/products/vgi/vgi-logo.png",
  "vgi.license": "0BSD",
  "vgi.author": "Query Farm LLC",
  "vgi.copyright": "Copyright 2026 Query Farm LLC - https://query.farm",
  "vgi.keywords": keywordsArray(
    "linear, issue tracking, issues, project management, graphql, cycles, sprints, projects, roadmap, initiatives, cycle time, engineering metrics",
  ),
  "vgi.support_contact": `${SOURCE_URL}/issues`,
  "vgi.support_policy_url": `${SOURCE_URL}#support`,
  // Public analyst tasks for `vgi-lint simulate`; private graders live in vgi-agent-tests.yaml.
  "vgi.agent_test_tasks": JSON.stringify(AGENT_TEST_TASKS),
  "vgi.executable_examples": JSON.stringify(EXECUTABLE_EXAMPLES),
};

export const SCHEMA_TAGS: Record<string, string> = {
  "vgi.title": "Linear GraphQL API",
  domain: "project-management",
  "vgi.keywords": keywordsArray("linear, issues, history, comments, teams, projects, cycles, initiatives, customers"),
  "vgi.doc_llm": SCHEMA_DOC_LLM,
  "vgi.doc_md": SCHEMA_DOC_MD,
  "vgi.categories": JSON.stringify(SCHEMA_CATEGORIES),
};

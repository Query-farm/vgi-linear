/**
 * The Linear objects: one spec per GraphQL connection.
 *
 * Issue columns align with the GitHub, GitLab and Jira workers (`repo`, `key`,
 * `number`, `title`, `state` 'open'/'closed', `status`, `assignee`, `assignees`,
 * `user_login`, `labels`, `body`, `html_url`, `created_at`, `updated_at`,
 * `closed_at`) so issues UNION across trackers; everything else follows Linear's
 * field names in snake_case.
 */

import { bool, int64, list, timestampMicros, utf8, type VgiFunction } from "@query-farm/vgi";
import type { Constraint, FilterMap } from "./pushdown.ts";
import {
  asStr,
  at,
  C,
  type Col,
  defineLinearCatalogTable,
  defineLinearTable,
  type LinearTableSpec,
  nodeValues,
  type Row,
} from "./table.ts";

const Q = "linear.main";
const PAGE_SIZE_DOC =
  "Rows requested per GraphQL page (1–250; lowered automatically to stay inside Linear's complexity budget).";
const ARCHIVED_DOC = "Include archived objects (Linear's includeArchived); default false, as in the Linear app.";

// ------------------------------------------------------------------ filter helpers

const f = {
  id: (...path: string[]): FilterMap => ({ path, kind: "id" }),
  str: (path: string[], opts: Partial<FilterMap> = {}): FilterMap => ({ path, kind: "string", ...opts }),
  num: (path: string[], nullPath?: string[]): FilterMap => ({ path, kind: "number", nullPath }),
  time: (path: string[], nullable = false): FilterMap => ({
    path,
    kind: "time",
    nullPath: nullable ? path : undefined,
  }),
  bool: (...path: string[]): FilterMap => ({ path, kind: "bool" }),
};
const TIMESTAMPS: Record<string, FilterMap> = {
  created_at: f.time(["createdAt"]),
  updated_at: f.time(["updatedAt"]),
};

const CLOSED_TYPES = ["completed", "canceled"];

/** state 'open' / 'closed' (GitHub vocabulary) → Linear workflow state types. */
function stateFilter(c: Constraint): Record<string, unknown> | undefined {
  let vals: unknown[] | undefined;
  if (c.kind === "cmp" && c.op === "eq") vals = [c.value];
  else if (c.kind === "in") vals = c.values;
  else if (c.kind === "cmp" && c.op === "ne")
    vals = [c.value === "open" ? "closed" : c.value === "closed" ? "open" : ""];
  if (!vals) return undefined;
  const open = vals.includes("open");
  const closed = vals.includes("closed");
  if (open === closed) return undefined;
  return { state: { type: closed ? { in: CLOSED_TYPES } : { nin: CLOSED_TYPES } } };
}

/** closed_at = coalesce(completedAt, canceledAt): a range on it is "either one in range". */
function closedAtFilter(c: Constraint): Record<string, unknown> | undefined {
  if (c.kind === "null") {
    return c.negated
      ? { or: [{ completedAt: { null: false } }, { canceledAt: { null: false } }] }
      : { completedAt: { null: true }, canceledAt: { null: true } };
  }
  if (c.kind !== "cmp" || c.op === "ne") return undefined;
  const ms =
    typeof c.value === "bigint" ? Number(c.value / 1000n) : c.value instanceof Date ? c.value.getTime() : undefined;
  if (ms === undefined) return undefined;
  const op = { eq: "eq", gt: "gt", ge: "gte", lt: "lt", le: "lte" }[c.op];
  const iso = new Date(ms).toISOString();
  return { or: [{ completedAt: { [op as string]: iso } }, { canceledAt: { [op as string]: iso } }] };
}

// ------------------------------------------------------------------------ issues

function issueColumns(): Col[] {
  return [
    C.str("id", "Linear issue UUID.", "id", false),
    C.str("key", "Issue identifier, e.g. ENG-123. Pushed down.", "identifier", false),
    C.big("number", "Issue number within its team (the 123 of ENG-123). Pushed down.", "number", false),
    C.str("repo", "Team key (tracker-aligned alias of team_key). Pushed down.", "team.key", false),
    C.str("team_key", "Team key, e.g. ENG. Pushed down.", "team.key", false),
    C.str("team_id", "Team UUID. Pushed down.", "team.id", false),
    C.str("title", "Issue title. Pushed down (=, starts_with).", "title", false),
    C.custom(
      "state",
      utf8(),
      "VARCHAR",
      "'open' or 'closed' (GitHub vocabulary): closed = a completed or canceled workflow state. Pushed down.",
      "state { type }",
      (r) => {
        const t = at(r, "state.type");
        return typeof t === "string" ? (CLOSED_TYPES.includes(t) ? "closed" : "open") : null;
      },
      1.1,
      false,
    ),
    C.str("status", "Workflow state name, e.g. 'In Progress'. Pushed down.", "state.name", false),
    C.str(
      "status_type",
      "triage, backlog, unstarted, started, completed or canceled. Pushed down.",
      "state.type",
      false,
    ),
    C.str("state_id", "Workflow state UUID. Pushed down.", "state.id", false),
    C.int("priority", "Priority: 0 none, 1 urgent, 2 high, 3 medium, 4 low. Pushed down.", "priority", false),
    C.str("priority_label", "Priority name: No priority, Urgent, High, Medium or Low.", "priorityLabel", false),
    C.num("estimate", "Estimate in the team's points scale; NULL when not estimated. Pushed down.", "estimate"),
    C.str("assignee", "Assignee's display name (unique nickname). Pushed down.", "assignee.displayName"),
    C.str("assignee_id", "Assignee's user UUID. Pushed down.", "assignee.id"),
    C.str("assignee_name", "Assignee's full name.", "assignee.name"),
    C.custom(
      "assignees",
      list(utf8()),
      "VARCHAR[]",
      "Assignee display names (at most one in Linear); tracker-aligned.",
      "assignee { displayName }",
      (r) => {
        const a = asStr(at(r, "assignee.displayName"));
        return a ? [a] : [];
      },
      1.1,
    ),
    C.str("user_login", "Creator's display name (tracker-aligned: the author). Pushed down.", "creator.displayName"),
    C.str("creator_id", "Creator's user UUID. Pushed down.", "creator.id"),
    C.nodesList("labels", "Label names (first 50). Pushed down via list_contains.", "labels", 50, "name"),
    C.strList("label_ids", "Label UUIDs. Pushed down via list_contains.", "labelIds"),
    C.str("project", "Project name. Pushed down; IS NULL too.", "project.name"),
    C.str("project_id", "Project UUID. Pushed down.", "project.id"),
    C.str("project_milestone", "Project milestone name. Pushed down.", "projectMilestone.name"),
    C.str("milestone", "Alias of project_milestone (tracker-aligned).", "projectMilestone.name"),
    C.int("cycle_number", "Number of the cycle (sprint) the issue is in. Pushed down.", "cycle.number"),
    C.str("cycle_id", "Cycle UUID. Pushed down.", "cycle.id"),
    C.str("parent_key", "Identifier of the parent issue for sub-issues. Pushed down.", "parent.identifier"),
    C.str("parent_id", "UUID of the parent issue. Pushed down.", "parent.id"),
    C.date("due_date", "Due date, if set.", "dueDate"),
    C.str("body", "Issue description as Markdown.", "description"),
    C.str("html_url", "Link to the issue in the Linear app.", "url", false),
    C.str("branch_name", "Suggested git branch name.", "branchName"),
    C.time("created_at", "When the issue was created. Ranges are pushed down.", "createdAt", false),
    C.time("updated_at", "When the issue last changed. Pushed down.", "updatedAt", false),
    C.time("started_at", "When the issue entered a started state. Pushed down.", "startedAt"),
    C.time("completed_at", "When the issue was completed. Pushed down.", "completedAt"),
    C.time("canceled_at", "When the issue was canceled. Pushed down.", "canceledAt"),
    C.custom(
      "closed_at",
      timestampMicros("UTC"),
      "TIMESTAMP WITH TIME ZONE",
      "completed_at, else canceled_at; NULL while open. Pushed down.",
      "completedAt canceledAt",
      (r) => {
        const v = (r.completedAt ?? r.canceledAt) as unknown;
        return typeof v === "string" ? BigInt(Date.parse(v)) * 1000n : null;
      },
      0.2,
    ),
    C.time("triaged_at", "When the issue left triage.", "triagedAt"),
    C.time("archived_at", "When archived (needs include_archived := true).", "archivedAt"),
  ];
}

export const ISSUE_FILTERS: Record<string, FilterMap> = {
  id: f.id("id"),
  key: f.id("id"), // IssueIDComparator accepts identifiers such as ENG-123
  number: f.num(["number"]),
  repo: f.str(["team", "key"], { prefix: true }),
  team_key: f.str(["team", "key"], { prefix: true }),
  team_id: f.id("team", "id"),
  title: f.str(["title"], { prefix: true }),
  state: { path: [], kind: "string", custom: stateFilter },
  status: f.str(["state", "name"]),
  status_type: f.str(["state", "type"]),
  state_id: f.id("state", "id"),
  priority: f.num(["priority"]),
  estimate: f.num(["estimate"], ["estimate"]),
  assignee: f.str(["assignee", "displayName"], { nullPath: ["assignee"] }),
  assignee_id: { ...f.id("assignee", "id"), nullPath: ["assignee"] },
  assignee_name: f.str(["assignee", "name"]),
  user_login: f.str(["creator", "displayName"], { nullPath: ["creator"] }),
  creator_id: { ...f.id("creator", "id"), nullPath: ["creator"] },
  labels: { path: ["labels"], kind: "string", containsPath: ["labels", "some", "name"] },
  label_ids: { path: ["labels"], kind: "id", containsPath: ["labels", "some", "id"] },
  project: f.str(["project", "name"], { nullPath: ["project"] }),
  project_id: { ...f.id("project", "id"), nullPath: ["project"] },
  project_milestone: f.str(["projectMilestone", "name"], { nullPath: ["projectMilestone"] }),
  milestone: f.str(["projectMilestone", "name"], { nullPath: ["projectMilestone"] }),
  cycle_number: f.num(["cycle", "number"], ["cycle"]),
  cycle_id: { ...f.id("cycle", "id"), nullPath: ["cycle"] },
  parent_key: { ...f.id("parent", "id"), nullPath: ["parent"] },
  parent_id: { ...f.id("parent", "id"), nullPath: ["parent"] },
  ...TIMESTAMPS,
  started_at: f.time(["startedAt"], true),
  completed_at: f.time(["completedAt"], true),
  canceled_at: f.time(["canceledAt"], true),
  closed_at: { path: [], kind: "time", custom: closedAtFilter },
  triaged_at: f.time(["triagedAt"], true),
  archived_at: f.time(["archivedAt"], true),
};

export const issues = defineLinearTable({
  name: "issues",
  description: "Linear issues, with SQL filters pushed into Linear's IssueFilter and GraphQL projection",
  title: "Linear Issues",
  category: "issues",
  keywords: "linear, issues, tickets, bugs, tasks, backlog, sprint, cycle, assignee, priority, labels, issue tracker",
  docLlm:
    "Every Linear issue the key can see (Query.issues, newest updatedAt first), one row each: key " +
    "(ENG-123), number, repo / team_key, title, state ('open' / 'closed'), status (workflow state name), " +
    "status_type, priority (0 none … 4 low) and priority_label, estimate, assignee / assignees / " +
    "assignee_id, user_login (creator), labels, project, project_milestone, cycle_number, parent_key, " +
    "due_date, body (Markdown description), html_url and the lifecycle timestamps created_at, updated_at, " +
    "started_at, completed_at, canceled_at, closed_at. WHERE filters on those columns become Linear's " +
    "IssueFilter (key / id IN uses Linear's identifier-aware id comparator; list_contains(labels, 'Bug') " +
    "becomes labels.some.name; assignee IS NULL becomes assignee.null). filter := '<IssueFilter JSON>' " +
    'adds a raw filter for anything else (e.g. \'{"slaStatus": {"eq": "Breached"}}\'). Archived issues ' +
    "need include_archived := true. Only the GraphQL fields of the selected columns are fetched.",
  docMd:
    "## issues(include_archived := false, filter := NULL, page_size := 100)\n\n" +
    "Linear issues, one row each, paged with relay cursors and ordered by `updatedAt`.",
  pushdown:
    "`key`/`id` (=, IN), `repo`/`team_key` (=, IN, starts_with), `team_id`, `number`, `title` (=, starts_with), " +
    "`state`, `status`, `status_type`, `state_id`, `priority`, `estimate`, `assignee`/`assignee_id`/`assignee_name`, " +
    "`user_login`/`creator_id`, `list_contains(labels | label_ids, …)`, `project`/`project_id`, `project_milestone`, " +
    "`cycle_number`/`cycle_id`, `parent_key`/`parent_id`, IS [NOT] NULL on the nullable relations and dates, and " +
    "ranges on every timestamp → `IssueFilter`. Projection → the GraphQL selection.",
  args: { include_archived: bool, filter: utf8(), page_size: int64() },
  argDefaults: { include_archived: false, filter: null, page_size: 100 },
  argDocs: {
    include_archived: ARCHIVED_DOC,
    filter: "Optional raw Linear IssueFilter as JSON, ANDed with the pushed WHERE filters.",
    page_size: PAGE_SIZE_DOC,
  },
  argConstraints: { page_size: { ge: 1, le: 250 } },
  columns: issueColumns(),
  root: "issues",
  filterType: "IssueFilter",
  filters: ISSUE_FILTERS,
  orderBy: "updatedAt",
  boolArgs: { include_archived: "includeArchived" },
  pageSize: 100,
  examples: [
    {
      sql: `SELECT key, title, status, assignee FROM ${Q}.issues() WHERE team_key = 'ENG' AND state = 'open' ORDER BY priority, key`,
      description: "Open ENG issues by priority (both predicates become one IssueFilter)",
    },
    {
      sql: `SELECT status, count(*) AS issues FROM ${Q}.issues() WHERE created_at >= TIMESTAMPTZ '2026-10-01' GROUP BY status ORDER BY issues DESC`,
      description: "Issues created since October by workflow state",
    },
  ],
} satisfies LinearTableSpec);

// --------------------------------------------------------------- issue history

const historyColumns = (): Col[] => [
  C.str("id", "History entry UUID.", "id", false),
  C.str("issue_id", "UUID of the issue that changed.", "issue.id", false),
  C.str(
    "issue_key",
    "Identifier of the issue that changed, e.g. ENG-123. = / IN reads only those issues.",
    "issue.identifier",
    false,
  ),
  C.str("team_key", "Team key of the issue. Pushed down when fanning out.", "issue.team.key", false),
  C.time("created_at", "When the change happened.", "createdAt", false),
  C.str(
    "actor",
    "Display name of the user who made the change (NULL for automations and integrations).",
    "actor.displayName",
  ),
  C.str("actor_id", "UUID of the user who made the change.", "actorId"),
  C.custom(
    "is_state_change",
    bool,
    "BOOLEAN",
    "True when this entry moved the issue to a workflow state (filter on it for state transitions).",
    "toStateId",
    (r) => r.toStateId != null,
    0.1,
    false,
  ),
  C.str("from_state", "Workflow state name before the change (NULL when the issue was created).", "fromState.name"),
  C.str("from_state_type", "Workflow state type before the change.", "fromState.type"),
  C.str("to_state", "Workflow state name after the change.", "toState.name"),
  C.str("to_state_type", "Workflow state type after the change (e.g. started, completed).", "toState.type"),
  C.str("from_state_id", "Workflow state UUID before the change.", "fromStateId"),
  C.str("to_state_id", "Workflow state UUID after the change.", "toStateId"),
  C.str("from_assignee", "Assignee display name before the change.", "fromAssignee.displayName"),
  C.str("to_assignee", "Assignee display name after the change.", "toAssignee.displayName"),
  C.int("from_priority", "Priority before the change.", "fromPriority"),
  C.int("to_priority", "Priority after the change.", "toPriority"),
  C.num("from_estimate", "Estimate before the change.", "fromEstimate"),
  C.num("to_estimate", "Estimate after the change.", "toEstimate"),
  C.str("from_title", "Title before a rename.", "fromTitle"),
  C.str("to_title", "Title after a rename.", "toTitle"),
  C.str("from_cycle_id", "Cycle UUID before the change.", "fromCycleId"),
  C.str("to_cycle_id", "Cycle UUID after the change.", "toCycleId"),
  C.str("from_project_id", "Project UUID before the change.", "fromProjectId"),
  C.str("to_project_id", "Project UUID after the change.", "toProjectId"),
  C.str("from_parent_id", "Parent issue UUID before the change.", "fromParentId"),
  C.str("to_parent_id", "Parent issue UUID after the change.", "toParentId"),
  C.custom(
    "added_labels",
    list(utf8()),
    "VARCHAR[]",
    "Names of labels added by this change.",
    "addedLabels { name }",
    (r) => nodeValues(r.addedLabels, "name"),
    1.1,
  ),
  C.custom(
    "removed_labels",
    list(utf8()),
    "VARCHAR[]",
    "Names of labels removed by this change.",
    "removedLabels { name }",
    (r) => nodeValues(r.removedLabels, "name"),
    1.1,
  ),
  C.bool("archived", "True when this change archived the issue.", "archived"),
  C.bool("auto_closed", "True when Linear closed the issue automatically.", "autoClosed"),
  C.bool("auto_archived", "True when Linear archived the issue automatically.", "autoArchived"),
  C.bool("updated_description", "True when the description was edited.", "updatedDescription"),
];

export const issueHistory = defineLinearTable({
  name: "issue_history",
  description: "Change history of Linear issues: state transitions, reassignments, label and estimate changes",
  title: "Linear Issue History",
  category: "issues",
  keywords: "linear, issue history, state transitions, changelog, cycle time, lead time, audit trail, workflow",
  docLlm:
    "One row per change to an issue (Issue.history): issue_key, team_key, created_at (when), actor, " +
    "from_state / to_state (+ _type and _id), is_state_change, from/to assignee, priority, estimate, title, " +
    "cycle, project and parent, added_labels / removed_labels and flags (archived, auto_closed, " +
    "updated_description). Use it for cycle time and lead time: e.g. epoch(max(created_at) FILTER (WHERE " +
    "to_state_type = 'completed')) - epoch(min(created_at) FILTER (WHERE to_state_type = 'started')) seconds per issue_key. Pass issue_key := 'ENG-1' or " +
    "filter WHERE issue_key = / IN (…) to read specific issues; otherwise every issue is read (filter " +
    "team_key = '…' to narrow the issues), nesting the first 50 entries of each issue in the issues page.",
  docMd:
    "## issue_history(issue_key := NULL, include_archived := false, page_size := 50)\n\n" +
    "Every change to the selected issues, newest first.",
  pushdown:
    "`issue_key` / `issue_id` (=, IN) select which issues are read (`issue(id:)` each); otherwise " +
    "`team_key` (=, IN) narrows the issues fanned out over.",
  args: { issue_key: utf8(), include_archived: bool, page_size: int64() },
  argDefaults: { issue_key: null, include_archived: false, page_size: 50 },
  argDocs: {
    issue_key: "Only this issue, by identifier such as ENG-123 (or its internal id); NULL reads every issue.",
    include_archived: "Include archived issues and history entries.",
    page_size: PAGE_SIZE_DOC,
  },
  argConstraints: { page_size: { ge: 1, le: 250 } },
  columns: historyColumns(),
  root: "issues",
  boolArgs: { include_archived: "includeArchived" },
  pageSize: 50,
  perIssue: {
    connection: "history",
    keyColumns: ["issue_key", "issue_id"],
    argName: "issue_key",
    fanout: true,
    fanoutFilters: { team_key: f.str(["team", "key"]) },
  },
  examples: [
    {
      sql: `SELECT created_at, actor, from_state, to_state FROM ${Q}.issue_history(issue_key := 'ENG-1') WHERE is_state_change ORDER BY created_at`,
      description: "State transitions of one issue",
    },
    {
      sql:
        `SELECT issue_key, (epoch(max(created_at) FILTER (WHERE to_state_type = 'completed')) - epoch(min(created_at) FILTER (WHERE to_state_type = 'started'))) / 3600 AS cycle_time_hours ` +
        `FROM ${Q}.issue_history() WHERE team_key = 'ENG' GROUP BY issue_key ORDER BY issue_key`,
      description: "Cycle time (first started → completed) per ENG issue",
    },
  ],
} satisfies LinearTableSpec);

// --------------------------------------------------------------------- comments

export const comments = defineLinearTable({
  name: "comments",
  description: "Comments on Linear issues (Markdown bodies), with filters pushed into CommentFilter",
  title: "Linear Comments",
  category: "issues",
  keywords: "linear, comments, discussion, issue comments, markdown, threads, replies",
  docLlm:
    "Comments (Query.comments): issue_key / issue_id, team_key, body (Markdown), user_login (author " +
    "display name), user_id, parent_id for threaded replies, project_update_id for comments on project " +
    "updates, html_url and created_at / updated_at / edited_at / resolved_at. issue_key := 'ENG-1' or WHERE " +
    "issue_key = / IN, team_key, user_login and created_at / updated_at ranges push into CommentFilter.",
  docMd: "## comments(issue_key := NULL, include_archived := false, page_size := 100)\n\nComments, newest first.",
  pushdown:
    "`issue_key`/`issue_id` (=, IN, IS NULL), `team_key`, `user_login`, `user_id`, `id`, `created_at`/`updated_at` ranges → `CommentFilter`.",
  args: { issue_key: utf8(), include_archived: bool, page_size: int64() },
  argDefaults: { issue_key: null, include_archived: false, page_size: 100 },
  argDocs: {
    issue_key:
      "Only comments on this issue, by identifier such as ENG-1 (or its internal id); NULL reads all comments.",
    include_archived: ARCHIVED_DOC,
    page_size: PAGE_SIZE_DOC,
  },
  argConstraints: { page_size: { ge: 1, le: 250 } },
  columns: [
    C.str("id", "Comment UUID.", "id", false),
    C.str("issue_id", "UUID of the issue commented on (NULL for project-update comments).", "issue.id"),
    C.str("issue_key", "Identifier of the issue commented on. Pushed down.", "issue.identifier"),
    C.str("team_key", "Team key of the issue. Pushed down.", "issue.team.key"),
    C.str("body", "Comment body as Markdown.", "body", false),
    C.str("user_login", "Author's display name. Pushed down.", "user.displayName"),
    C.str("user_id", "Author's user UUID. Pushed down.", "user.id"),
    C.str("user_name", "Author's full name.", "user.name"),
    C.str("parent_id", "Parent comment UUID for threaded replies.", "parentId"),
    C.str("project_update_id", "Project update UUID when the comment is on a project update.", "projectUpdateId"),
    C.str("html_url", "Link to the comment in the Linear app.", "url", false),
    C.time("created_at", "When the comment was posted. Ranges are pushed down.", "createdAt", false),
    C.time("updated_at", "When the comment last changed. Ranges are pushed down.", "updatedAt", false),
    C.time("edited_at", "When the body was last edited.", "editedAt"),
    C.time("resolved_at", "When the thread was resolved.", "resolvedAt"),
    C.time("archived_at", "When the comment was archived.", "archivedAt"),
  ],
  root: "comments",
  filterType: "CommentFilter",
  filters: {
    id: f.id("id"),
    issue_key: { ...f.id("issue", "id"), nullPath: ["issue"] },
    issue_id: { ...f.id("issue", "id"), nullPath: ["issue"] },
    team_key: f.str(["issue", "team", "key"]),
    user_login: f.str(["user", "displayName"]),
    user_id: f.id("user", "id"),
    ...TIMESTAMPS,
  },
  argColumns: { issue_key: "issue_key" },
  boolArgs: { include_archived: "includeArchived" },
  examples: [
    {
      sql: `SELECT created_at, user_login, body FROM ${Q}.comments(issue_key := 'ENG-1') ORDER BY created_at`,
      description: "The discussion on one issue",
    },
    {
      sql: `SELECT user_login, count(*) AS comments FROM ${Q}.comments() WHERE created_at >= TIMESTAMPTZ '2026-10-01' GROUP BY user_login ORDER BY comments DESC`,
      description: "Most active commenters since October",
    },
  ],
} satisfies LinearTableSpec);

// ------------------------------------------------------------------- attachments

export const attachments = defineLinearTable({
  name: "attachments",
  description: "Attachments (links to pull requests, designs, error reports…) on Linear issues",
  title: "Linear Issue Attachments",
  category: "issues",
  keywords: "linear, attachments, links, pull requests, github, figma, sentry, integrations",
  docLlm:
    "Attachment metadata (not file contents): issue_key / issue_id, title, subtitle, url, source_type " +
    "(github, figma, sentry, slack …), user_login (creator), metadata (integration-specific JSON such as " +
    "PR state) and timestamps. issue_key := 'ENG-1' or WHERE issue_key = / IN reads Issue.attachments of " +
    "those issues; otherwise Query.attachments lists the workspace, with title, url, source_type, " +
    "user_login and time ranges pushed into AttachmentFilter.",
  docMd: "## attachments(issue_key := NULL, page_size := 100)\n\nIssue attachments, newest first.",
  pushdown:
    "`issue_key`/`issue_id` (=, IN) read only those issues; otherwise `title`, `url`, `source_type`, " +
    "`user_login`, `created_at`/`updated_at` → `AttachmentFilter`.",
  args: { issue_key: utf8(), page_size: int64() },
  argDefaults: { issue_key: null, page_size: 100 },
  argDocs: {
    issue_key:
      "Only this issue's attachments, by identifier such as ENG-1 (or its internal id); NULL lists all attachments.",
    page_size: PAGE_SIZE_DOC,
  },
  argConstraints: { page_size: { ge: 1, le: 250 } },
  columns: [
    C.str("id", "Attachment UUID.", "id", false),
    C.str("issue_id", "UUID of the issue.", "issue.id", false),
    C.str("issue_key", "Identifier of the issue. = / IN reads only those issues.", "issue.identifier", false),
    C.str("title", "Attachment title. Pushed down.", "title", false),
    C.str("subtitle", "Attachment subtitle.", "subtitle"),
    C.str("url", "The linked URL. Pushed down.", "url", false),
    C.str("source_type", "Integration that created it, e.g. github, figma, sentry. Pushed down.", "sourceType"),
    C.str("user_login", "Creator's display name. Pushed down.", "creator.displayName"),
    C.json("metadata", "Integration-specific metadata (e.g. pull request state) as JSON.", "metadata"),
    C.time("created_at", "When it was attached. Ranges are pushed down.", "createdAt", false),
    C.time("updated_at", "When it last changed. Ranges are pushed down.", "updatedAt", false),
  ],
  root: "attachments",
  filterType: "AttachmentFilter",
  filters: {
    id: f.id("id"),
    title: f.str(["title"], { prefix: true }),
    url: f.str(["url"], { prefix: true }),
    source_type: f.str(["sourceType"]),
    user_login: f.str(["creator", "displayName"], { nullPath: ["creator"] }),
    ...TIMESTAMPS,
  },
  perIssue: { connection: "attachments", keyColumns: ["issue_key", "issue_id"], argName: "issue_key" },
  examples: [
    {
      sql: `SELECT title, url, source_type FROM ${Q}.attachments(issue_key := 'ENG-1') ORDER BY title`,
      description: "Links attached to one issue",
    },
    {
      sql: `SELECT source_type, count(*) FROM ${Q}.attachments() GROUP BY source_type ORDER BY source_type`,
      description: "Attachments by integration",
    },
  ],
} satisfies LinearTableSpec);

// --------------------------------------------------------------- issue relations

export const issueRelations = defineLinearTable({
  name: "issue_relations",
  description: "Relations between Linear issues: blocks, duplicate, related, similar",
  title: "Linear Issue Relations",
  category: "issues",
  keywords: "linear, issue relations, blocks, blocked by, duplicates, related issues, dependencies",
  docLlm:
    "One row per relation (IssueRelation): issue_key `type` related_issue_key, where type is blocks, " +
    "duplicate, related or similar (for 'blocks', issue_key blocks related_issue_key). issue_key := or " +
    "WHERE issue_key = / IN reads the outgoing relations of those issues; otherwise every relation in the " +
    "workspace is listed (Query.issueRelations has no filter).",
  docMd: "## issue_relations(issue_key := NULL, page_size := 100)\n\nIssue-to-issue relations.",
  pushdown: "`issue_key`/`issue_id` (=, IN) read only those issues' relations.",
  args: { issue_key: utf8(), page_size: int64() },
  argDefaults: { issue_key: null, page_size: 100 },
  argDocs: {
    issue_key:
      "Only relations from this issue, by identifier such as ENG-1 (or its internal id); NULL lists all relations.",
    page_size: PAGE_SIZE_DOC,
  },
  argConstraints: { page_size: { ge: 1, le: 250 } },
  columns: [
    C.str("id", "Relation UUID.", "id", false),
    C.str("type", "blocks, duplicate, related or similar.", "type", false),
    C.str("issue_id", "UUID of the source issue.", "issue.id", false),
    C.str("issue_key", "Identifier of the source issue (the blocker, the duplicate).", "issue.identifier", false),
    C.str("related_issue_id", "UUID of the target issue.", "relatedIssue.id", false),
    C.str(
      "related_issue_key",
      "Identifier of the target issue (the blocked issue, the original).",
      "relatedIssue.identifier",
      false,
    ),
    C.time("created_at", "When the relation was created.", "createdAt", false),
    C.time("updated_at", "When the relation last changed.", "updatedAt", false),
  ],
  root: "issueRelations",
  perIssue: { connection: "relations", keyColumns: ["issue_key", "issue_id"], argName: "issue_key" },
  examples: [
    {
      sql: `SELECT issue_key, related_issue_key FROM ${Q}.issue_relations() WHERE type = 'blocks' ORDER BY issue_key`,
      description: "What blocks what",
    },
  ],
} satisfies LinearTableSpec);

// ----------------------------------------------------------------- catalog tables

const nameDoc = (what: string) => `${what} name. Pushed down.`;

export const teams = defineLinearCatalogTable({
  name: "teams",
  description: "Linear teams: their keys, names, privacy and cycle / triage settings",
  title: "Linear Teams",
  category: "workspace",
  keywords: "linear, teams, team keys, workspace, cycles, triage",
  docLlm:
    "Every team the key can see: key (the ENG of ENG-123), name, description, private, parent_key for " +
    "sub-teams, cycles_enabled / cycle_duration (weeks), triage_enabled, issue_estimation_type, timezone and " +
    "timestamps. key, name, id, private and time ranges push into TeamFilter.",
  docMd: "## teams\n\nLinear teams.",
  pushdown: "`id`, `key`, `name` (=, IN, starts_with), `private`, `created_at`/`updated_at` → `TeamFilter`.",
  columns: [
    C.str("id", "Team UUID.", "id", false),
    C.str("key", "Team key used in issue identifiers. Pushed down.", "key", false),
    C.str("name", nameDoc("Team"), "name", false),
    C.str("display_name", "Team display name (includes the parent for sub-teams).", "displayName"),
    C.str("description", "Team description.", "description"),
    C.bool("private", "Whether the team is private. Pushed down.", "private"),
    C.str("parent_key", "Key of the parent team for sub-teams.", "parent.key"),
    C.str("color", "Team color (hex).", "color"),
    C.str("icon", "Team icon name.", "icon"),
    C.str("timezone", "Team timezone (cycles start in it).", "timezone"),
    C.bool("cycles_enabled", "Whether the team uses cycles.", "cyclesEnabled"),
    C.int("cycle_duration", "Cycle length in weeks.", "cycleDuration"),
    C.bool("triage_enabled", "Whether triage is enabled.", "triageEnabled"),
    C.str(
      "issue_estimation_type",
      "Estimate scale: notUsed, exponential, fibonacci, linear or tShirt.",
      "issueEstimationType",
    ),
    C.time("created_at", "When the team was created. Pushed down.", "createdAt", false),
    C.time("updated_at", "When the team last changed. Pushed down.", "updatedAt", false),
    C.time("archived_at", "When the team was archived.", "archivedAt"),
  ],
  root: "teams",
  filterType: "TeamFilter",
  filters: {
    id: f.id("id"),
    key: f.str(["key"], { prefix: true }),
    name: f.str(["name"], { prefix: true }),
    private: f.bool("private"),
    ...TIMESTAMPS,
  },
  examples: [
    {
      sql: `SELECT key, name, cycles_enabled FROM ${Q}.teams ORDER BY key`,
      description: "Teams and whether they use cycles",
    },
  ],
});

export const workflowStates = defineLinearCatalogTable({
  name: "workflow_states",
  description: "Workflow states (issue statuses) of every Linear team",
  title: "Linear Workflow States",
  category: "workspace",
  keywords: "linear, workflow states, statuses, board columns, backlog, done, canceled, state types",
  docLlm:
    "Every team's workflow states: name (e.g. 'In Review'), type (triage, backlog, unstarted, started, " +
    "completed, canceled), team_key, position (board order), color and description. Join issues.state_id " +
    "or issue_history.to_state_id to id. name, type, team_key and id push into WorkflowStateFilter.",
  docMd: "## workflow_states\n\nWorkflow states per team.",
  pushdown: "`id`, `name`, `type`, `team_key`, `team_id`, `created_at`/`updated_at` → `WorkflowStateFilter`.",
  columns: [
    C.str("id", "Workflow state UUID.", "id", false),
    C.str("name", nameDoc("State"), "name", false),
    C.str("type", "triage, backlog, unstarted, started, completed or canceled. Pushed down.", "type", false),
    C.str("team_key", "Key of the team the state belongs to. Pushed down.", "team.key", false),
    C.str("team_id", "UUID of the team. Pushed down.", "team.id", false),
    C.num(
      "position",
      "Sort order (ordinal rank) of the column on the team's board; lower is further left.",
      "position",
    ),
    C.str("color", "State color (hex).", "color"),
    C.str("description", "State description.", "description"),
    C.time("created_at", "When the state was created.", "createdAt", false),
    C.time("updated_at", "When the state last changed.", "updatedAt", false),
    C.time("archived_at", "When the state was archived.", "archivedAt"),
  ],
  root: "workflowStates",
  filterType: "WorkflowStateFilter",
  filters: {
    id: f.id("id"),
    name: f.str(["name"]),
    type: f.str(["type"]),
    team_key: f.str(["team", "key"]),
    team_id: f.id("team", "id"),
    ...TIMESTAMPS,
  },
  examples: [
    {
      sql: `SELECT name, type FROM ${Q}.workflow_states WHERE team_key = 'ENG' ORDER BY position`,
      description: "The ENG board's columns in order",
    },
  ],
});

export const labels = defineLinearCatalogTable({
  name: "labels",
  description: "Linear issue labels (workspace and team labels, groups and their children)",
  title: "Linear Issue Labels",
  category: "workspace",
  keywords: "linear, labels, tags, label groups, issue labels",
  docLlm:
    "Issue labels: name, description, color, is_group (label groups), parent_name / parent_id for labels " +
    "inside a group, team_key (NULL for workspace-wide labels) and timestamps. name, is_group, team_key " +
    "(and IS NULL), parent_name and id push into IssueLabelFilter.",
  docMd: "## labels\n\nIssue labels.",
  pushdown:
    "`id`, `name` (=, IN, starts_with), `is_group`, `team_key` (incl. IS NULL), `parent_name` → `IssueLabelFilter`.",
  columns: [
    C.str("id", "Label UUID.", "id", false),
    C.str("name", nameDoc("Label"), "name", false),
    C.str("description", "Label description.", "description"),
    C.str("color", "Label color (hex).", "color"),
    C.bool("is_group", "Whether this is a label group. Pushed down.", "isGroup", false),
    C.str("parent_id", "UUID of the group the label belongs to.", "parent.id"),
    C.str("parent_name", "Name of the group the label belongs to. Pushed down.", "parent.name"),
    C.str("team_key", "Team key for team labels; NULL for workspace labels. Pushed down.", "team.key"),
    C.time("created_at", "When the label was created.", "createdAt", false),
    C.time("updated_at", "When the label last changed.", "updatedAt", false),
    C.time("archived_at", "When the label was archived.", "archivedAt"),
  ],
  root: "issueLabels",
  filterType: "IssueLabelFilter",
  filters: {
    id: f.id("id"),
    name: f.str(["name"], { prefix: true }),
    is_group: f.bool("isGroup"),
    team_key: f.str(["team", "key"], { nullPath: ["team"] }),
    parent_name: f.str(["parent", "name"]),
    ...TIMESTAMPS,
  },
  examples: [
    {
      sql: `SELECT name, coalesce(team_key, '(workspace)') AS scope FROM ${Q}.labels WHERE NOT is_group ORDER BY name`,
      description: "Labels and their scope",
    },
  ],
});

export const users = defineLinearCatalogTable({
  name: "users",
  description: "Linear users (members, guests, disabled users and app users)",
  title: "Linear Users",
  category: "workspace",
  keywords: "linear, users, members, people, guests, admins, display names",
  docLlm:
    "Every user, including disabled ones: display_name (Linear's unique nickname, the value of " +
    "issues.assignee / user_login), user_login (alias), name, email, active, admin, guest, app, is_me " +
    "(the key's own user), title, timezone, last_seen and timestamps. email is NULL when the key's scope " +
    "may not read it (Linear refuses the field; the worker retries without it). active, admin, app, " +
    "display_name, name, email and id push into UserFilter.",
  docMd: "## users\n\nWorkspace users, including disabled ones.",
  pushdown:
    "`id`, `display_name`/`user_login`, `name`, `email` (=, IN, starts_with), `active`, `admin`, `app`, `is_me` → `UserFilter`.",
  columns: [
    C.str("id", "User UUID.", "id", false),
    C.str("display_name", "Display name (unique nickname). Pushed down.", "displayName", false),
    C.str("user_login", "Alias of display_name (tracker-aligned login). Pushed down.", "displayName", false),
    C.str("name", "Full name. Pushed down.", "name", false),
    C.str("email", "Email address; NULL when the key's scope may not read it. Pushed down.", "email"),
    C.bool("active", "False for disabled (suspended) users. Pushed down.", "active", false),
    C.bool("admin", "Workspace admin. Pushed down.", "admin", false),
    C.bool("guest", "Guest user (limited to some teams).", "guest"),
    C.bool("app", "An app / agent user rather than a person. Pushed down.", "app"),
    C.bool("is_me", "The user who owns the API key. Pushed down.", "isMe"),
    C.str("title", "Job title.", "title"),
    C.str("timezone", "User timezone.", "timezone"),
    C.str("html_url", "Link to the user's profile in Linear.", "url"),
    C.time("last_seen", "When the user was last online.", "lastSeen"),
    C.time("created_at", "When the user joined.", "createdAt", false),
    C.time("updated_at", "When the user last changed.", "updatedAt", false),
    C.time("archived_at", "When the user was archived.", "archivedAt"),
  ],
  root: "users",
  filterType: "UserFilter",
  filters: {
    id: f.id("id"),
    display_name: f.str(["displayName"], { prefix: true }),
    user_login: f.str(["displayName"], { prefix: true }),
    name: f.str(["name"], { prefix: true }),
    email: f.str(["email"], { prefix: true }),
    active: f.bool("active"),
    admin: f.bool("admin"),
    app: f.bool("app"),
    is_me: f.bool("isMe"),
    ...TIMESTAMPS,
  },
  fixedBools: { includeDisabled: true },
  optionalColumns: ["email"],
  examples: [
    {
      sql: `SELECT display_name, name, admin FROM ${Q}.users WHERE active ORDER BY display_name`,
      description: "Active users",
    },
  ],
});

// ------------------------------------------------------------------------ planning

export const projects = defineLinearCatalogTable({
  name: "projects",
  description: "Linear projects with status, health, lead, dates and progress",
  title: "Linear Projects",
  category: "planning",
  keywords: "linear, projects, roadmap, health, on track, at risk, progress, target date",
  docLlm:
    "Every project: name, state / status / status_type (backlog, planned, started, paused, completed, " +
    "canceled), health (onTrack, atRisk, offTrack, from the latest project update), lead, user_login " +
    "(creator), priority, progress (0–1), team_keys, start_date / target_date and lifecycle timestamps. " +
    "name, status, status_type, health, lead, priority and the timestamps push into ProjectFilter.",
  docMd: "## projects\n\nLinear projects.",
  pushdown:
    "`id`, `name` (=, IN, starts_with), `status`, `status_type`, `health`, `lead` (incl. IS NULL), `priority`, " +
    "`created_at`/`updated_at`/`started_at`/`completed_at`/`canceled_at` → `ProjectFilter`.",
  columns: [
    C.str("id", "Project UUID.", "id", false),
    C.str("name", nameDoc("Project"), "name", false),
    C.str("slug_id", "Project slug used in URLs.", "slugId"),
    C.str("description", "Short description.", "description"),
    C.str("status", "Project status name. Pushed down.", "status.name"),
    C.str("status_type", "backlog, planned, started, paused, completed or canceled. Pushed down.", "status.type"),
    C.str(
      "health",
      "onTrack, atRisk or offTrack (from the latest update); NULL if never reported. Pushed down.",
      "health",
    ),
    C.time("health_updated_at", "When health was last reported.", "healthUpdatedAt"),
    C.int(
      "priority",
      "Priority score from 0 to 4 (lower number = more urgent; 0 = none, 1 urgent … 4 low). Pushed down.",
      "priority",
    ),
    C.num(
      "progress",
      "Completed fraction of the scope, a ratio from 0 to 1 (completed / total estimate points).",
      "progress",
    ),
    C.str("lead", "Project lead's display name. Pushed down.", "lead.displayName"),
    C.str("user_login", "Creator's display name.", "creator.displayName"),
    C.nodesList("team_keys", "Keys of the teams working on the project (first 20).", "teams", 20, "key"),
    C.date("start_date", "Planned start date.", "startDate"),
    C.date("target_date", "Calendar day the work is due to be finished.", "targetDate"),
    C.time("started_at", "When work started.", "startedAt"),
    C.time("completed_at", "When the project was completed.", "completedAt"),
    C.time("canceled_at", "When the project was canceled.", "canceledAt"),
    C.str("html_url", "Link to the project in Linear.", "url", false),
    C.time("created_at", "When the project was created.", "createdAt", false),
    C.time("updated_at", "When the project last changed.", "updatedAt", false),
    C.time("archived_at", "When the project was archived.", "archivedAt"),
  ],
  root: "projects",
  filterType: "ProjectFilter",
  filters: {
    id: f.id("id"),
    name: f.str(["name"], { prefix: true }),
    status: f.str(["status", "name"]),
    status_type: f.str(["status", "type"]),
    health: f.str(["health"]),
    lead: f.str(["lead", "displayName"], { nullPath: ["lead"] }),
    priority: f.num(["priority"]),
    ...TIMESTAMPS,
    started_at: f.time(["startedAt"], true),
    completed_at: f.time(["completedAt"], true),
    canceled_at: f.time(["canceledAt"], true),
  },
  examples: [
    {
      sql: `SELECT name, health, lead, target_date FROM ${Q}.projects WHERE health IN ('atRisk', 'offTrack') ORDER BY target_date`,
      description: "Projects in trouble",
    },
  ],
});

export const projectMilestones = defineLinearCatalogTable({
  name: "project_milestones",
  description: "Milestones of Linear projects with status, progress and target dates",
  title: "Linear Project Milestones",
  category: "planning",
  keywords: "linear, milestones, project milestones, target dates, progress",
  docLlm:
    "Project milestones: name, project / project_id, status (unstarted, next, overdue, done), progress " +
    "(0–1), target_date, description and timestamps. name, project, project_id and time ranges push into " +
    "ProjectMilestoneFilter.",
  docMd: "## project_milestones\n\nProject milestones.",
  pushdown: "`id`, `name`, `project`, `project_id`, `created_at`/`updated_at` → `ProjectMilestoneFilter`.",
  columns: [
    C.str("id", "Milestone UUID.", "id", false),
    C.str("name", nameDoc("Milestone"), "name", false),
    C.str("project", "Project name. Pushed down.", "project.name", false),
    C.str("project_id", "Project UUID. Pushed down.", "project.id", false),
    C.str("status", "unstarted, next, overdue or done.", "status"),
    C.num("progress", "Completed fraction of the scope, a ratio from 0 to 1.", "progress"),
    C.date("target_date", "Calendar day the work is due to be finished.", "targetDate"),
    C.str("description", "Milestone description (Markdown).", "description"),
    C.time("created_at", "When the milestone was created.", "createdAt", false),
    C.time("updated_at", "When the milestone last changed.", "updatedAt", false),
    C.time("archived_at", "When the milestone was archived.", "archivedAt"),
  ],
  root: "projectMilestones",
  filterType: "ProjectMilestoneFilter",
  filters: {
    id: f.id("id"),
    name: f.str(["name"]),
    project: f.str(["project", "name"]),
    project_id: f.id("project", "id"),
    ...TIMESTAMPS,
  },
  examples: [
    {
      sql: `SELECT project, name, status, target_date FROM ${Q}.project_milestones ORDER BY project, target_date`,
      description: "Milestones per project",
    },
  ],
});

export const projectUpdates = defineLinearCatalogTable({
  name: "project_updates",
  description: "Project status updates with their health (on track / at risk / off track)",
  title: "Linear Project Updates",
  category: "planning",
  keywords: "linear, project updates, status updates, health, on track, at risk, off track",
  docLlm:
    "Project updates (the weekly status posts): project / project_id, health (onTrack, atRisk, offTrack), " +
    "body (Markdown), user_login (author), comment_count, is_stale, html_url and timestamps. project, " +
    "project_id, user_login and time ranges push into ProjectUpdateFilter.",
  docMd: "## project_updates\n\nProject status updates, newest first.",
  pushdown: "`id`, `project`, `project_id`, `user_login`, `created_at`/`updated_at` → `ProjectUpdateFilter`.",
  columns: [
    C.str("id", "Project update UUID.", "id", false),
    C.str("project", "Project name. Pushed down.", "project.name", false),
    C.str("project_id", "Project UUID. Pushed down.", "project.id", false),
    C.str("health", "onTrack, atRisk or offTrack.", "health", false),
    C.str("body", "Update text as Markdown.", "body", false),
    C.str("user_login", "Author's display name. Pushed down.", "user.displayName", false),
    C.int("comment_count", "Number of comments on the update.", "commentCount"),
    C.bool("is_stale", "Whether Linear considers the update stale.", "isStale"),
    C.str("html_url", "Link to the update.", "url", false),
    C.time("created_at", "When the update was posted. Pushed down.", "createdAt", false),
    C.time("updated_at", "When the update last changed.", "updatedAt", false),
    C.time("edited_at", "When the body was last edited.", "editedAt"),
    C.time("archived_at", "When the update was archived.", "archivedAt"),
  ],
  root: "projectUpdates",
  filterType: "ProjectUpdateFilter",
  filters: {
    id: f.id("id"),
    project: f.str(["project", "name"]),
    project_id: f.id("project", "id"),
    user_login: f.str(["user", "displayName"]),
    ...TIMESTAMPS,
  },
  examples: [
    {
      sql: `SELECT project, arg_max(health, created_at) AS latest_health FROM ${Q}.project_updates GROUP BY project ORDER BY project`,
      description: "Latest reported health per project",
    },
  ],
});

export const cycles = defineLinearCatalogTable({
  name: "cycles",
  description: "Linear cycles (sprints) of every team",
  title: "Linear Cycles",
  category: "planning",
  keywords: "linear, cycles, sprints, iterations, active cycle, velocity",
  docLlm:
    "Every team's cycles: number, name, team_key, starts_at / ends_at / completed_at, is_active / " +
    "is_future / is_past / is_next / is_previous (as Linear computes them now) and progress (0–1). " +
    "number, team_key, the is_* flags and starts_at / ends_at ranges push into CycleFilter. Join " +
    "issues.cycle_id to id.",
  docMd: "## cycles\n\nCycles (sprints) per team.",
  pushdown:
    "`id`, `number`, `name`, `team_key`, `team_id`, `is_active`/`is_future`/`is_past`/`is_next`/`is_previous`, `starts_at`/`ends_at`/`created_at`/`updated_at` ranges → `CycleFilter`.",
  columns: [
    C.str("id", "Cycle UUID.", "id", false),
    C.int("number", "Sequence number of the cycle within its team (1, 2, 3 …). Pushed down.", "number", false),
    C.str("name", "Optional cycle name.", "name"),
    C.str("team_key", "Team key. Pushed down.", "team.key", false),
    C.str("team_id", "Team UUID. Pushed down.", "team.id", false),
    C.time("starts_at", "Cycle start. Pushed down.", "startsAt", false),
    C.time("ends_at", "Cycle end. Pushed down.", "endsAt", false),
    C.time("completed_at", "When the cycle was completed.", "completedAt"),
    C.bool("is_active", "The team's current cycle. Pushed down.", "isActive"),
    C.bool("is_future", "Starts in the future. Pushed down.", "isFuture"),
    C.bool("is_past", "Already ended. Pushed down.", "isPast"),
    C.bool("is_next", "The next cycle. Pushed down.", "isNext"),
    C.bool("is_previous", "The previous cycle. Pushed down.", "isPrevious"),
    C.num("progress", "Completed fraction of the scope, a ratio from 0 to 1.", "progress"),
    C.str("description", "Cycle description.", "description"),
    C.time("created_at", "When the cycle was created.", "createdAt", false),
    C.time("updated_at", "When the cycle last changed.", "updatedAt", false),
    C.time("archived_at", "When the cycle was archived.", "archivedAt"),
  ],
  root: "cycles",
  filterType: "CycleFilter",
  filters: {
    id: f.id("id"),
    number: f.num(["number"]),
    name: f.str(["name"]),
    team_key: f.str(["team", "key"]),
    team_id: f.id("team", "id"),
    is_active: f.bool("isActive"),
    is_future: f.bool("isFuture"),
    is_past: f.bool("isPast"),
    is_next: f.bool("isNext"),
    is_previous: f.bool("isPrevious"),
    starts_at: f.time(["startsAt"]),
    ends_at: f.time(["endsAt"]),
    ...TIMESTAMPS,
  },
  examples: [
    {
      sql: `SELECT team_key, number, starts_at, ends_at FROM ${Q}.cycles WHERE is_active ORDER BY team_key`,
      description: "Each team's active cycle",
    },
  ],
});

export const initiatives = defineLinearCatalogTable({
  name: "initiatives",
  description: "Linear initiatives (groups of projects toward a company goal)",
  title: "Linear Initiatives",
  category: "planning",
  keywords: "linear, initiatives, goals, okrs, strategy, roadmap, projects",
  docLlm:
    "Initiatives: name, description, status (Planned, Active, Completed …), health, owner, user_login " +
    "(creator), target_date, project_names (first 50 projects) and timestamps. name, status, health, owner " +
    "and time ranges push into InitiativeFilter.",
  docMd: "## initiatives\n\nInitiatives and their projects.",
  pushdown:
    "`id`, `name`, `status`, `health`, `owner` (incl. IS NULL), `created_at`/`updated_at` → `InitiativeFilter`.",
  columns: [
    C.str("id", "Initiative UUID.", "id", false),
    C.str("name", nameDoc("Initiative"), "name", false),
    C.str("description", "Free-text summary written by the owner.", "description"),
    C.str("status", "Proposed, Planned, Active, Completed or Canceled. Pushed down.", "status", false),
    C.str("health", "onTrack, atRisk or offTrack; NULL if never reported. Pushed down.", "health"),
    C.str("owner", "Owner's display name. Pushed down.", "owner.displayName"),
    C.str("user_login", "Creator's display name.", "creator.displayName"),
    C.date("target_date", "Calendar day the work is due to be finished.", "targetDate"),
    C.nodesList("project_names", "Names of the initiative's projects (first 50).", "projects", 50, "name"),
    C.str("html_url", "Link to the initiative.", "url", false),
    C.time("started_at", "When the initiative started.", "startedAt"),
    C.time("completed_at", "When it was completed.", "completedAt"),
    C.time("created_at", "When it was created.", "createdAt", false),
    C.time("updated_at", "When it last changed.", "updatedAt", false),
    C.time("archived_at", "When it was archived.", "archivedAt"),
  ],
  root: "initiatives",
  filterType: "InitiativeFilter",
  filters: {
    id: f.id("id"),
    name: f.str(["name"]),
    status: f.str(["status"]),
    health: f.str(["health"]),
    owner: f.str(["owner", "displayName"], { nullPath: ["owner"] }),
    ...TIMESTAMPS,
  },
  examples: [
    {
      sql: `SELECT name, status, len(project_names) AS projects FROM ${Q}.initiatives ORDER BY name`,
      description: "Initiatives and how many projects each has",
    },
  ],
});

export const roadmaps = defineLinearCatalogTable({
  name: "roadmaps",
  description: "Linear roadmaps (the older project grouping that initiatives replace)",
  title: "Linear Roadmaps",
  category: "planning",
  keywords: "linear, roadmaps, project groups, planning",
  docLlm:
    "Roadmaps (deprecated in favour of initiatives but still in the API): name, description, owner, " +
    "user_login (creator), project_names (first 50) and timestamps. Workspaces where the API no longer " +
    "offers roadmaps return zero rows. No filter pushdown (Query.roadmaps takes no filter).",
  docMd: "## roadmaps\n\nRoadmaps and their projects.",
  columns: [
    C.str("id", "Roadmap UUID.", "id", false),
    C.str("name", "Roadmap name.", "name", false),
    C.str("description", "Free-text summary written by the owner.", "description"),
    C.str("owner", "Owner's display name.", "owner.displayName"),
    C.str("user_login", "Creator's display name.", "creator.displayName"),
    C.nodesList("project_names", "Names of the roadmap's projects (first 50).", "projects", 50, "name"),
    C.str("html_url", "Link to the roadmap.", "url", false),
    C.time("created_at", "When it was created.", "createdAt", false),
    C.time("updated_at", "When it last changed.", "updatedAt", false),
    C.time("archived_at", "When it was archived.", "archivedAt"),
  ],
  root: "roadmaps",
  onForbidden: { mode: "empty", hint: "roadmaps are not available to this workspace or key" },
  examples: [
    { sql: `SELECT name, project_names FROM ${Q}.roadmaps ORDER BY name`, description: "Roadmaps and their projects" },
  ],
});

// ----------------------------------------------------------------------- customers

export const customers = defineLinearCatalogTable({
  name: "customers",
  description: "Customers tracked in Linear (Linear Customers / Asks)",
  title: "Linear Customers",
  category: "customers",
  keywords: "linear, customers, accounts, revenue, tiers, customer requests",
  docLlm:
    "Customers: name, domains, external_ids, revenue, size, status, tier, owner, approximate_need_count " +
    "and timestamps. Workspaces without the Customers feature (or keys that may not read it) return zero " +
    "rows. name, revenue, size, owner and time ranges push into CustomerFilter.",
  docMd: "## customers\n\nCustomers and their tiers.",
  pushdown:
    "`id`, `name` (=, IN, starts_with), `revenue`, `size`, `owner`, `created_at`/`updated_at` → `CustomerFilter`.",
  columns: [
    C.str("id", "Customer UUID.", "id", false),
    C.str("name", nameDoc("Customer"), "name", false),
    C.strList("domains", "Email / web domains of the customer.", "domains"),
    C.strList("external_ids", "IDs of the customer in other systems (CRM).", "externalIds"),
    C.big("revenue", "Annual revenue amount in the workspace's currency units, as entered. Pushed down.", "revenue"),
    C.num("size", "Company size as a number of employees, as entered.", "size"),
    C.str("status", "Customer status name.", "status.name"),
    C.str("tier", "Customer tier name.", "tier.name"),
    C.str("owner", "Owner's display name. Pushed down.", "owner.displayName"),
    C.num("approximate_need_count", "Approximate number of customer requests.", "approximateNeedCount"),
    C.str("html_url", "Link to the customer.", "url", false),
    C.time("created_at", "When the customer was added.", "createdAt", false),
    C.time("updated_at", "When it last changed.", "updatedAt", false),
    C.time("archived_at", "When it was archived.", "archivedAt"),
  ],
  root: "customers",
  filterType: "CustomerFilter",
  filters: {
    id: f.id("id"),
    name: f.str(["name"], { prefix: true }),
    revenue: f.num(["revenue"]),
    size: f.num(["size"]),
    owner: f.str(["owner", "displayName"], { nullPath: ["owner"] }),
    ...TIMESTAMPS,
  },
  onForbidden: { mode: "empty", hint: "Customers are not enabled for this workspace or key" },
  examples: [
    {
      sql: `SELECT name, tier, revenue FROM ${Q}.customers ORDER BY revenue DESC NULLS LAST`,
      description: "Customers by revenue",
    },
  ],
});

export const customerNeeds = defineLinearCatalogTable({
  name: "customer_needs",
  description: "Customer requests (needs) linked to Linear issues and projects",
  title: "Linear Customer Requests",
  category: "customers",
  keywords: "linear, customer requests, customer needs, asks, feedback, feature requests",
  docLlm:
    "Customer requests: customer / customer_id, issue_key / issue_id or project / project_id they are " +
    "attached to, priority (0 normal, 1 important), body (the quoted request), user_login (creator), " +
    "html_url and timestamps. issue_key (= / IN / IS NULL), customer, project, priority and time ranges " +
    "push into CustomerNeedFilter. Zero rows when the Customers feature is unavailable.",
  docMd: "## customer_needs\n\nCustomer requests linked to issues and projects.",
  pushdown:
    "`id`, `issue_key`/`issue_id` (=, IN, IS NULL), `customer`, `customer_id`, `project`, `priority`, `created_at`/`updated_at` → `CustomerNeedFilter`.",
  columns: [
    C.str("id", "Customer need UUID.", "id", false),
    C.str("customer", "Customer name. Pushed down.", "customer.name"),
    C.str("customer_id", "Customer UUID. Pushed down.", "customer.id"),
    C.str("issue_key", "Identifier of the linked issue. Pushed down.", "issue.identifier"),
    C.str("issue_id", "UUID of the linked issue. Pushed down.", "issue.id"),
    C.str("project", "Name of the linked project. Pushed down.", "project.name"),
    C.str("project_id", "UUID of the linked project.", "project.id"),
    C.int(
      "priority",
      "Importance score from 0 to 1 (higher number = more important; 0 normal, 1 important). Pushed down.",
      "priority",
      false,
    ),
    C.str("body", "The request text (Markdown).", "body"),
    C.str("user_login", "Creator's display name.", "creator.displayName"),
    C.str("html_url", "Link to the request's source, if any.", "url"),
    C.time("created_at", "When the request was recorded. Pushed down.", "createdAt", false),
    C.time("updated_at", "When it last changed.", "updatedAt", false),
    C.time("archived_at", "When it was archived.", "archivedAt"),
  ],
  root: "customerNeeds",
  filterType: "CustomerNeedFilter",
  filters: {
    id: f.id("id"),
    issue_key: { ...f.id("issue", "id"), nullPath: ["issue"] },
    issue_id: { ...f.id("issue", "id"), nullPath: ["issue"] },
    customer: f.str(["customer", "name"], { nullPath: ["customer"] }),
    customer_id: { ...f.id("customer", "id"), nullPath: ["customer"] },
    project: f.str(["project", "name"], { nullPath: ["project"] }),
    priority: f.num(["priority"]),
    ...TIMESTAMPS,
  },
  onForbidden: { mode: "empty", hint: "Customers are not enabled for this workspace or key" },
  examples: [
    {
      sql: `SELECT issue_key, count(*) AS requests, list(DISTINCT customer) AS customers FROM ${Q}.customer_needs WHERE issue_key IS NOT NULL GROUP BY issue_key ORDER BY requests DESC`,
      description: "Most-requested issues",
    },
  ],
});

// ---------------------------------------------------------------------------- audit

export const auditEntries = defineLinearCatalogTable({
  name: "audit_entries",
  description: "The Linear workspace audit log (requires an admin API key)",
  title: "Linear Audit Log",
  category: "audit",
  keywords: "linear, audit log, security, logins, admin, compliance, siem",
  docLlm:
    "Audit log entries (admin keys only): type (e.g. user.login, apiKey.created), created_at, " +
    "user_login / actor_id of who did it, ip, country_code, metadata and request_information (JSON). " +
    "A non-admin key gets a clear error. type (=, IN, starts_with), ip, country_code, user_login, actor_id " +
    "and created_at ranges push into AuditEntryFilter.",
  docMd: "## audit_entries\n\nThe workspace audit log, newest first. Needs an admin key.",
  pushdown:
    "`id`, `type` (=, IN, starts_with), `ip`, `country_code`, `user_login`, `actor_id`, `created_at`/`updated_at` → `AuditEntryFilter`.",
  columns: [
    C.str("id", "Audit entry UUID.", "id", false),
    C.str("type", "Event type, e.g. user.login. Pushed down.", "type", false),
    C.time("created_at", "When it happened. Pushed down.", "createdAt", false),
    C.str("user_login", "Actor's display name. Pushed down.", "actor.displayName"),
    C.str("actor_id", "Actor's user UUID. Pushed down.", "actorId"),
    C.str("ip", "Client IP address. Pushed down.", "ip"),
    C.str("country_code", "Two-letter country of the IP. Pushed down.", "countryCode"),
    C.json("metadata", "Event-specific details as JSON.", "metadata"),
    C.json("request_information", "Request details (user agent …) as JSON.", "requestInformation"),
    C.time("updated_at", "When the entry last changed.", "updatedAt", false),
  ],
  root: "auditEntries",
  filterType: "AuditEntryFilter",
  filters: {
    id: f.id("id"),
    type: f.str(["type"], { prefix: true }),
    ip: f.str(["ip"]),
    country_code: f.str(["countryCode"]),
    user_login: f.str(["actor", "displayName"], { nullPath: ["actor"] }),
    actor_id: { ...f.id("actor", "id"), nullPath: ["actor"] },
    ...TIMESTAMPS,
  },
  onForbidden: {
    mode: "error",
    hint: "the audit log needs an API key (or OAuth token with admin scope) of a workspace admin",
  },
  examples: [
    {
      sql: `SELECT created_at, user_login, ip FROM ${Q}.audit_entries WHERE type = 'user.login' ORDER BY created_at DESC`,
      description: "Recent sign-ins",
    },
  ],
});

export const FUNCTIONS: VgiFunction[] = [issues, issueHistory, comments, attachments, issueRelations];

export const TABLES = [
  teams,
  workflowStates,
  labels,
  users,
  projects,
  projectMilestones,
  projectUpdates,
  cycles,
  initiatives,
  roadmaps,
  customers,
  customerNeeds,
  auditEntries,
];

export type { Row };

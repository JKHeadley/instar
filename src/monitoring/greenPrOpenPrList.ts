/**
 * The auto-merger's open-PR listing, read a small GraphQL page at a time.
 *
 * `gh pr list --limit 100 --json ...statusCheckRollup` asks GitHub for 100 PRs a page with every
 * PR's checks. At 60 authored open PRs (102 open in the repo) that single page outran GitHub's
 * ~10 s GraphQL budget: every tick failed with HTTP 502, the breaker opened, and a verified PR
 * sat unmerged (2026-11-13 04:55-06:10 PST). Pages of OPEN_PR_LIST_PAGE_SIZE stay well inside
 * that budget. The same fault was fixed for Local Verify's reconciler in PR 3130.
 *
 * Each PR is returned in the row shape `gh pr list --json LIST_PR_JSON_FIELDS` printed, so
 * `mapPr` and everything downstream is unchanged.
 */

// RULE 3: EXEMPT — reads typed fields from GitHub's GraphQL API (check status and conclusion enums); it matches no terminal, CLI or provider output text.

export type GhExecResult = { stdout: string; stderr: string; code: number };
export type GhExecFn = (args: string[]) => Promise<GhExecResult>;

/**
 * PRs per GraphQL page (each PR carries up to 100 check contexts). Measured 2026-11-13 at 25 a
 * page: 0.7 to 6.1 s a page against GitHub's ~10 s budget, so 15 leaves room for a loaded GitHub.
 */
export const OPEN_PR_LIST_PAGE_SIZE = 15;
/** Hard stop on pages read in one listing (600 open PRs). Past it the read fails; it is never cut short silently. */
export const OPEN_PR_LIST_MAX_PAGES = 40;
/** At most this many authored PRs, oldest first: the `--limit 100` the single call carried. */
export const OPEN_PR_LIST_LIMIT = 100;

export const OPEN_PR_LIST_QUERY = `query($owner: String!, $name: String!, $endCursor: String) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequests(first: ${OPEN_PR_LIST_PAGE_SIZE}, after: $endCursor, states: OPEN, baseRefName: "main", orderBy: {field: CREATED_AT, direction: ASC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title isDraft headRefName headRefOid baseRefName mergeable reviewDecision createdAt isCrossRepository
        labels(first: 50) { nodes { name } }
        author { __typename login }
        autoMergeRequest { enabledAt }
        commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) {
          nodes {
            __typename
            ... on StatusContext { context state createdAt }
            ... on CheckRun { name status conclusion startedAt completedAt checkSuite { workflowRun { workflow { name } } } }
          }
        } } } } }
      }
    }
  }
}`;

/** What `gh` prints for a time GitHub has not set (an unfinished check's completedAt). */
export const GH_ZERO_TIME = '0001-01-01T00:00:00Z';

interface GqlContext {
  __typename?: string;
  context?: string | null; state?: string | null; createdAt?: string | null;
  name?: string | null; status?: string | null; conclusion?: string | null;
  startedAt?: string | null; completedAt?: string | null;
  checkSuite?: { workflowRun?: { workflow?: { name?: string | null } | null } | null } | null;
}
export interface GqlOpenPrListNode {
  number: number;
  title?: string | null; isDraft?: boolean | null; headRefName?: string | null; headRefOid?: string | null;
  baseRefName?: string | null; mergeable?: string | null; reviewDecision?: string | null; createdAt?: string | null;
  isCrossRepository?: boolean | null;
  labels?: { nodes?: Array<{ name?: string | null } | null> | null } | null;
  author?: { __typename?: string; login?: string | null } | null;
  autoMergeRequest?: { enabledAt?: string | null } | null;
  commits?: { nodes?: Array<{ commit?: { statusCheckRollup?: { contexts?: { nodes?: Array<GqlContext | null> | null } | null } | null } | null } | null> | null } | null;
}
interface GqlOpenPrListPage {
  data?: {
    viewer?: { login?: string | null } | null;
    repository?: { pullRequests?: {
      pageInfo?: { hasNextPage?: boolean | null; endCursor?: string | null } | null;
      nodes?: Array<GqlOpenPrListNode | null> | null;
    } | null } | null;
  } | null;
  errors?: unknown[];
}

/** One GraphQL PR node as the row `gh pr list --json LIST_PR_JSON_FIELDS` printed. */
export function ghRowFromGraphqlPr(n: GqlOpenPrListNode): Record<string, unknown> {
  const contexts = n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
  const statusCheckRollup = contexts
    .filter((c): c is GqlContext => !!c && typeof c === 'object')
    .map((c) => c.__typename === 'CheckRun'
      // `gh pr list` flattens the workflow name, prints an unfinished conclusion as '' and an
      // unset time as Go's zero time; keep each so every consumer reads what it read before.
      ? { __typename: 'CheckRun', name: c.name ?? '', status: c.status ?? '', conclusion: c.conclusion ?? '',
          startedAt: c.startedAt ?? GH_ZERO_TIME, completedAt: c.completedAt ?? GH_ZERO_TIME,
          workflowName: c.checkSuite?.workflowRun?.workflow?.name ?? '' }
      : { __typename: 'StatusContext', context: c.context ?? '', state: c.state ?? '', startedAt: c.createdAt ?? null });
  return {
    number: n.number,
    title: n.title ?? '',
    labels: (n.labels?.nodes ?? []).filter((l): l is { name?: string | null } => !!l).map((l) => ({ name: l.name ?? '' })),
    isDraft: n.isDraft === true,
    headRefName: n.headRefName ?? '',
    headRefOid: n.headRefOid ?? '',
    baseRefName: n.baseRefName ?? '',
    mergeable: n.mergeable ?? 'UNKNOWN',
    statusCheckRollup,
    autoMergeRequest: n.autoMergeRequest ?? null,
    reviewDecision: n.reviewDecision ?? '',
    createdAt: n.createdAt ?? '',
    // `gh pr list` reports a bot author as `app/<login>`; keep that shape.
    author: n.author?.login ? { login: n.author.__typename === 'Bot' ? `app/${n.author.login}` : n.author.login } : null,
    isCrossRepository: n.isCrossRepository === true,
  };
}

/**
 * The authenticated account's open PRs on main, oldest first, at most OPEN_PR_LIST_LIMIT.
 * Throws on any failed or unreadable page: a partial list is never returned as the whole list
 * (the caller's tick-failed breaker and its fail-toward-not-merging depend on that).
 */
export async function listOpenPrRowsPaged(exec: GhExecFn, repo: string): Promise<Array<Record<string, unknown>>> {
  const [owner, name] = String(repo).split('/');
  if (!owner || !name) throw new Error('gh pr list failed: repo is not owner/name');
  const rows: Array<Record<string, unknown>> = [];
  let cursor: string | null = null;
  for (let page = 1; page <= OPEN_PR_LIST_MAX_PAGES; page++) {
    const args = ['api', 'graphql', '-F', `owner=${owner}`, '-F', `name=${name}`, '-f', `query=${OPEN_PR_LIST_QUERY}`];
    if (cursor) args.push('-F', `endCursor=${cursor}`);
    const r = await exec(args);
    if (r.code !== 0) throw new Error(`gh pr list failed: page ${page}: ${String(r.stderr).slice(0, 200)}`);
    let parsed: GqlOpenPrListPage;
    try { parsed = JSON.parse(r.stdout) as GqlOpenPrListPage; }
    catch { throw new Error(`gh pr list failed: page ${page}: unparseable output`); }
    const viewer = parsed?.data?.viewer?.login;
    const conn = parsed?.data?.repository?.pullRequests;
    if (parsed?.errors?.length || typeof viewer !== 'string' || !viewer || !conn || !Array.isArray(conn.nodes)) {
      throw new Error(`gh pr list failed: page ${page}: unreadable GraphQL page`);
    }
    for (const n of conn.nodes) {
      if (!n || typeof n.number !== 'number') throw new Error(`gh pr list failed: page ${page}: unreadable PR node`);
      // `--author @me`: ownership is by author, as before.
      if (n.author?.login !== viewer) continue;
      rows.push(ghRowFromGraphqlPr(n));
      if (rows.length >= OPEN_PR_LIST_LIMIT) return rows;
    }
    if (conn.pageInfo?.hasNextPage !== true) return rows;
    const next = conn.pageInfo.endCursor;
    if (typeof next !== 'string' || !next) throw new Error(`gh pr list failed: page ${page}: next page has no cursor`);
    cursor = next;
  }
  throw new Error(`gh pr list failed: more than ${OPEN_PR_LIST_MAX_PAGES} pages of open PRs`);
}

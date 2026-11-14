/**
 * Real GitHub seams for the status reconciler and the floor gate. Every call goes
 * through async `gh` with the agent's EXPLICIT per-agent GitHub environment (the
 * same resolver MergeRunner and the verify service use), so nothing blocks the
 * server's event loop and nothing ever uses an ambient login. A read failure is
 * `null` — never an empty answer.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { MAIN_PROTECTION_RULESET_ID, type FloorGateSeams } from './floorGate.js';
import { LOCAL_VERIFY_STATUS_CONTEXT, type CheckRunView, type ProjectedState } from './statusProjection.js';
import { RECONCILER_LIMITS, type CombinedStatusRead, type OpenPr, type RollupEntry, type StatusReconcilerSeams } from './StatusReconciler.js';

const execFileAsync = promisify(execFile);

export interface GhRunner {
  (args: string[]): Promise<{ ok: true; stdout: string } | { ok: false; status: number | null; stderr: string }>;
}

export function buildGhRunner(resolveGitHubEnv: () => NodeJS.ProcessEnv | null): GhRunner {
  return async (args) => {
    const env = resolveGitHubEnv();
    if (!env) return { ok: false, status: null, stderr: 'no explicit GitHub identity' };
    try {
      const { stdout } = await execFileAsync('gh', args, { env, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
      return { ok: true, stdout };
    } catch (e) {
      const err = e as { stderr?: string | Buffer; message?: string };
      const stderr = String(err.stderr ?? err.message ?? '');
      const m = /HTTP (\d{3})/.exec(stderr);
      return { ok: false, status: m ? Number(m[1]) : null, stderr };
    }
  };
}

function parse<T>(s: string): T | null {
  try { return JSON.parse(s) as T; } catch { return null; }
}

/** `--paginate --slurp` output: an array of pages. */
function pages<T>(s: string): T[] | null {
  const v = parse<unknown>(s);
  if (v === null) return null;
  return (Array.isArray(v) ? v : [v]) as T[];
}

interface GhRollupEntry { __typename?: string; context?: string; state?: string; name?: string; status?: string | null; conclusion?: string | null }

export function toRollup(raw: GhRollupEntry[] | null | undefined): RollupEntry[] {
  const out: RollupEntry[] = [];
  for (const r of raw ?? []) {
    if (r.__typename === 'StatusContext' && typeof r.context === 'string') out.push({ kind: 'status', context: r.context, state: String(r.state ?? '') });
    else if (typeof r.name === 'string') out.push({ kind: 'check', name: r.name, status: r.status ?? null, conclusion: r.conclusion ?? null });
  }
  return out;
}

/** PRs per GraphQL page for the open-PR listing (each PR carries up to 100 check contexts). */
export const OPEN_PR_PAGE_SIZE = 25;

/** The open-PR listing: the same fields `gh pr list --json ...statusCheckRollup` returned. */
export const OPEN_PRS_QUERY = `query($owner: String!, $name: String!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: ${OPEN_PR_PAGE_SIZE}, after: $endCursor, states: OPEN, baseRefName: "main", orderBy: {field: CREATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number headRefOid baseRefName headRefName isCrossRepository
        author { __typename login }
        commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) {
          pageInfo { hasNextPage }
          nodes {
            __typename
            ... on StatusContext { context state }
            ... on CheckRun { name status conclusion }
          }
        } } } } }
      }
    }
  }
}`;

interface GqlOpenPrNode {
  number: number; headRefOid: string; baseRefName: string; headRefName: string; isCrossRepository?: boolean;
  author?: { __typename?: string; login?: string } | null;
  commits?: { nodes?: Array<{ commit?: { statusCheckRollup?: { contexts?: { pageInfo?: { hasNextPage?: boolean }; nodes?: GhRollupEntry[] } | null } | null } } | null> };
}
interface GqlOpenPrsPage {
  data?: { repository?: { pullRequests?: { nodes?: Array<GqlOpenPrNode | null> } | null } | null };
  errors?: unknown[];
}

export function buildReconcilerGitHubSeams(repo: string, gh: GhRunner): Pick<StatusReconcilerSeams,
  'listOpenPrs' | 'readMainHead' | 'readCombinedStatus' | 'readCheckRuns' | 'postStatus'> {
  return {
    async listOpenPrs(): Promise<OpenPr[] | null> {
      // Paged GraphQL, OPEN_PR_PAGE_SIZE PRs a page. `gh pr list --limit 1000` asks GitHub for 100
      // PRs a page with every PR's checks; past ~100 open PRs that page outruns GitHub's ~10 s
      // GraphQL budget and every pass failed with HTTP 502 (2026-11-13, 102 open PRs: the queue
      // stopped admitting anything). Smaller pages each finish in ~1.5 s.
      const [owner, name] = repo.split('/');
      if (!owner || !name) return null;
      const r = await gh(['api', 'graphql', '--paginate', '--slurp',
        '-F', `owner=${owner}`, '-F', `name=${name}`, '-f', `query=${OPEN_PRS_QUERY}`]);
      if (!r.ok) return null;
      const ps = pages<GqlOpenPrsPage>(r.stdout);
      if (!ps || ps.length === 0) return null;
      const out: OpenPr[] = [];
      for (const p of ps) {
        // A page with GraphQL errors or no connection is a failed read, never a short list.
        if (p?.errors?.length) return null;
        const conn = p?.data?.repository?.pullRequests;
        if (!conn || !Array.isArray(conn.nodes)) return null;
        for (const n of conn.nodes) {
          if (!n || typeof n.number !== 'number') return null;
          const ctx = n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts ?? null;
          // `gh pr list` reports an unfinished check's conclusion as '' (GraphQL: null); keep that shape.
          const raw = (ctx?.nodes ?? []).map((c) => (c && c.__typename === 'CheckRun' ? { ...c, conclusion: c.conclusion ?? '' } : c));
          out.push({
            number: n.number, headSha: n.headRefOid, baseRefName: n.baseRefName, headRefName: n.headRefName,
            // `gh pr list` reports a bot author as `app/<login>`; keep that shape.
            author: n.author?.login ? (n.author.__typename === 'Bot' ? `app/${n.author.login}` : n.author.login) : null,
            isCrossRepository: n.isCrossRepository === true,
            rollup: toRollup(raw),
            rollupTruncated: ctx?.pageInfo?.hasNextPage === true || raw.length >= RECONCILER_LIMITS.rollupTruncationAt,
          });
        }
      }
      return out;
    },
    async readMainHead(): Promise<string | null> {
      const r = await gh(['api', `repos/${repo}/git/ref/heads/main`]);
      if (!r.ok) return null;
      const sha = parse<{ object?: { sha?: string } }>(r.stdout)?.object?.sha;
      return typeof sha === 'string' && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
    },
    async readCombinedStatus(sha: string): Promise<CombinedStatusRead | null> {
      const r = await gh(['api', `repos/${repo}/commits/${sha}/status?per_page=100`, '--paginate', '--slurp']);
      if (!r.ok) return null;
      const ps = pages<{ statuses?: Array<{ context?: string; state?: string; description?: string | null; creator?: { login?: string } | null }> }>(r.stdout);
      if (!ps) return null;
      const s = ps.flatMap((p) => p?.statuses ?? []).find((x) => x?.context === LOCAL_VERIFY_STATUS_CONTEXT);
      if (!s) return { state: 'absent', creator: null, description: null };
      const state = s.state === 'success' ? 'success' : s.state === 'pending' ? 'pending' : 'failure';
      return { state, creator: s.creator?.login ?? null, description: s.description ?? null };
    },
    async readCheckRuns(sha: string): Promise<CheckRunView[] | null> {
      const runs = await gh(['api', `repos/${repo}/commits/${sha}/check-runs?per_page=100`, '--paginate', '--slurp']);
      const wfs = await gh(['api', `repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`, '--paginate', '--slurp']);
      if (!runs.ok || !wfs.ok) return null;
      const runPages = pages<{ check_runs?: Array<{ name?: string; status?: string; conclusion?: string | null; app?: { slug?: string } | null; check_suite?: { id?: number } | null }> }>(runs.stdout);
      const wfPages = pages<{ workflow_runs?: Array<{ check_suite_id?: number; path?: string }> }>(wfs.stdout);
      if (!runPages || !wfPages) return null;
      const pathBySuite = new Map<number, string>();
      for (const w of wfPages.flatMap((p) => p?.workflow_runs ?? [])) {
        if (w?.check_suite_id != null && w?.path) pathBySuite.set(w.check_suite_id, w.path);
      }
      return runPages.flatMap((p) => p?.check_runs ?? []).map((c) => ({
        name: c?.name ?? '', status: c?.status ?? null, conclusion: c?.conclusion ?? null,
        appSlug: c?.app?.slug ?? null, workflowPath: (c?.check_suite?.id != null ? pathBySuite.get(c.check_suite.id) : undefined) ?? null,
      }));
    },
    async postStatus(sha: string, state: ProjectedState, description: string) {
      const r = await gh(['api', '-X', 'POST', `repos/${repo}/statuses/${sha}`,
        '-f', `state=${state}`, '-f', `context=${LOCAL_VERIFY_STATUS_CONTEXT}`, '-f', `description=${description}`]);
      return r.ok ? { ok: true as const } : { ok: false as const, status: r.status, detail: r.stderr };
    },
  };
}

export function buildFloorGateGitHubSeams(repo: string, gh: GhRunner): Pick<FloorGateSeams, 'readRulesBranches' | 'readBranch' | 'readRulesetBypass'> {
  return {
    async readRulesBranches() {
      const r = await gh(['api', `repos/${repo}/rules/branches/main?per_page=100`, '--paginate', '--slurp']);
      if (!r.ok) return null;
      const ps = pages<unknown>(r.stdout);
      return ps ? ps.flat() : null;
    },
    async readBranch() {
      const r = await gh(['api', `repos/${repo}/branches/main`]);
      return r.ok ? parse<unknown>(r.stdout) : null;
    },
    async readRulesetBypass() {
      const r = await gh(['api', `repos/${repo}/rulesets/${MAIN_PROTECTION_RULESET_ID}`]);
      if (!r.ok) return null;
      const v = parse<{ current_user_can_bypass?: string }>(r.stdout)?.current_user_can_bypass;
      return typeof v === 'string' ? v : null;
    },
  };
}

import { Router, type Request, type Response } from 'express';
import {
  createGitHubTokenResolver,
  fetchGitHubGraphql,
  GitHubAuthUnavailableError,
  resolveGitHubToken,
} from '../core/githubRuntime.js';

// RULE 3.1 RATIONALE
// Criticality: low — this is a read-only dashboard signal with no actuation authority.
// Frequency: on-demand, browser-selected, with a private one-minute response cache.
// Stability: GitHub GraphQL is a versioned structured interface; no human text is parsed.
// Fallback: auth, transport, schema, or JSON failure returns explicit HTTP 503, never plausible zero metrics.
// Verdict: deterministic aggregation over bounded inputs; contract tests pin author and index semantics.
// RULE 3: EXEMPT — this parses typed, structured GitHub JSON and fails the read closed; it does not infer provider state from presentation text.

type Author = 'codey' | 'echo' | 'other';
type Weights = { velocity: number; speed: number; quality: number; output: number };
export type ThroughputGraphql = (query: string, variables: Record<string, unknown>) => Promise<unknown>;
type Pr = {
  number: number;
  title: string;
  author?: { login?: string } | null;
  mergedAt: string;
  createdAt: string;
  additions: number;
  deletions: number;
  reviews?: { nodes?: Array<{ state?: string }> };
  commits?: { totalCount?: number };
};
type Detail = { reworkLoops: number; commits: number };
type SearchPage = {
  search?: {
    issueCount?: number;
    nodes?: Pr[];
    pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
  };
};

export const DEFAULT_THROUGHPUT_WEIGHTS: Weights = { velocity: .40, speed: .20, quality: .25, output: .15 };
const WINDOWS = [7, 14, 30] as const;
const MAX_SEARCH_PAGES = 10;
const THROUGHPUT_QUERY = `
  query ThroughputPullRequests($query: String!, $cursor: String) {
    search(query: $query, type: ISSUE, first: 100, after: $cursor) {
      issueCount
      nodes {
        ... on PullRequest {
          number
          title
          author { login }
          mergedAt
          createdAt
          additions
          deletions
          reviews(first: 30) { nodes { state } }
          commits { totalCount }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;
const ZERO = () => ({ merges: 0, medianLatencyH: 0, reworkLoops: 0, reverts: 0, medianPushIters: 0, medianLoc: 0 });

function median(values: number[]): number {
  if (!values.length) return 0;
  const a = [...values].sort((x, y) => x - y); const m = Math.floor(a.length / 2);
  return Math.round((a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2) * 10) / 10;
}
function authorOf(login?: string): Author { return login === 'JKHeadley' ? 'codey' : login === 'EchoOfDawn' ? 'echo' : 'other'; }
const PACIFIC_DAY = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
export function pacificDay(iso: string): string {
  const parts = Object.fromEntries(PACIFIC_DAY.formatToParts(new Date(iso)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function metrics(prs: Pr[], details: Map<number, Detail>) {
  return {
    merges: prs.length,
    medianLatencyH: median(prs.map(p => (Date.parse(p.mergedAt) - Date.parse(p.createdAt)) / 3_600_000)),
    reworkLoops: prs.reduce((n, p) => n + (details.get(p.number)?.reworkLoops ?? 0), 0),
    reverts: prs.filter(p => /^revert/i.test(p.title)).length,
    medianPushIters: median(prs.map(p => details.get(p.number)?.commits ?? 0)),
    medianLoc: median(prs.map(p => p.additions + p.deletions)),
  };
}

async function listMergedPullRequests(
  graphql: ThroughputGraphql,
  cutoff: number,
  now: number,
): Promise<Pr[]> {
  const searchQuery = `repo:JKHeadley/instar is:pr is:merged merged:>=${new Date(cutoff).toISOString().slice(0, 10)} sort:updated-desc`;
  const prs: Pr[] = [];
  let expectedCount: number | null = null;
  let fetchedCount = 0;
  let cursor: string | null = null;
  for (let page = 0; page < MAX_SEARCH_PAGES; page += 1) {
    const data = await graphql(THROUGHPUT_QUERY, { query: searchQuery, cursor }) as SearchPage;
    const search = data.search;
    if (!search || !Number.isSafeInteger(search.issueCount) || search.issueCount! < 0
      || !Array.isArray(search.nodes) || !search.pageInfo) {
      throw new Error('github-throughput-invalid-response');
    }
    if (search.issueCount! > 1_000) throw new Error('github-throughput-result-cap-exceeded');
    if (expectedCount === null) expectedCount = search.issueCount!;
    if (search.issueCount !== expectedCount) throw new Error('github-throughput-count-changed');
    fetchedCount += search.nodes.length;
    prs.push(...search.nodes.filter((pr) =>
      typeof pr?.mergedAt === 'string'
      && Date.parse(pr.mergedAt) >= cutoff
      && Date.parse(pr.mergedAt) <= now));
    if (!search.pageInfo.hasNextPage) {
      if (fetchedCount !== expectedCount) throw new Error('github-throughput-result-truncated');
      return prs;
    }
    if (typeof search.pageInfo.endCursor !== 'string' || !search.pageInfo.endCursor) {
      throw new Error('github-throughput-invalid-cursor');
    }
    cursor = search.pageInfo.endCursor;
  }
  throw new Error('github-throughput-page-cap-exceeded');
}

/** Canonical server-owned implementation of Echo's throughput-metrics.mjs contract. */
export async function buildThroughputSeries(opts: {
  days: 7 | 14 | 30;
  now?: Date;
  graphql?: ThroughputGraphql;
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof globalThis.fetch;
  resolveToken?: () => string | null;
  weights?: Weights;
}) {
  const now = opts.now ?? new Date(); const weights = opts.weights ?? DEFAULT_THROUGHPUT_WEIGHTS;
  const cutoff = now.getTime() - opts.days * 86_400_000;
  let graphql = opts.graphql;
  if (!graphql) {
    const token = opts.resolveToken
      ? opts.resolveToken()
      : resolveGitHubToken({ stateDir: opts.stateDir, env: opts.env });
    if (!token) throw new GitHubAuthUnavailableError();
    graphql = (query, variables) => fetchGitHubGraphql({
      token,
      query,
      variables,
      fetchImpl: opts.fetchImpl,
    });
  }
  const prs = await listMergedPullRequests(graphql, cutoff, now.getTime());
  const details = new Map<number, Detail>(prs.map((pr) => [pr.number, {
    reworkLoops: (pr.reviews?.nodes ?? []).filter((review) => review.state === 'CHANGES_REQUESTED').length,
    commits: Number(pr.commits?.totalCount ?? 0),
  }]));
  const days = new Map<string, Pr[]>();
  for (const p of prs) days.set(pacificDay(p.mergedAt), [...(days.get(pacificDay(p.mergedAt)) ?? []), p]);
  const rows = [...days].sort(([a], [b]) => a.localeCompare(b)).map(([day, all]) => {
    const authors: Partial<Record<Author, ReturnType<typeof ZERO>>> = {};
    for (const a of ['codey', 'echo', 'other'] as const) {
      const own = all.filter(p => authorOf(p.author?.login) === a); if (own.length) authors[a] = metrics(own, details);
    }
    return { day, authors, team: { ...metrics(all, details), dayLoc: all.reduce((n, p) => n + p.additions + p.deletions, 0), index: 0 } };
  });
  const maxM = Math.max(1, ...rows.map(r => r.team.merges)); const maxL = Math.max(1, ...rows.map(r => r.team.medianLatencyH)); const maxLoc = Math.max(1, ...rows.map(r => r.team.dayLoc));
  for (const r of rows) {
    const v = r.team.merges / maxM; const s = 1 - r.team.medianLatencyH / maxL;
    const q = 1 - Math.min(1, (r.team.reworkLoops + 2 * r.team.reverts) / r.team.merges);
    const o = Math.log1p(r.team.dayLoc) / Math.log1p(maxLoc);
    r.team.index = Math.round(1000 * (weights.velocity * v + weights.speed * s + weights.quality * q + weights.output * o)) / 10;
  }
  return { repo: 'JKHeadley/instar', windowDays: opts.days, generatedAt: now.toISOString(), weights, rows };
}

export function createThroughputRoutes(options: {
  graphql?: ThroughputGraphql;
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof globalThis.fetch;
  weights?: Weights;
} = {}): Router {
  const router = Router();
  const resolveToken = createGitHubTokenResolver({
    stateDir: options.stateDir,
    env: options.env,
  });
  router.get('/throughput/series', async (req: Request, res: Response) => {
    const days = Number(req.query.days ?? 14);
    if (!WINDOWS.includes(days as 7 | 14 | 30)) { res.status(400).json({ error: 'invalid-throughput-window', allowed: WINDOWS }); return; }
    try {
      res.set('Cache-Control', 'private, max-age=60').json(await buildThroughputSeries({
        days: days as 7 | 14 | 30,
        ...options,
        resolveToken,
      }));
    } catch (error) {
      if (error instanceof GitHubAuthUnavailableError) {
        res.status(503).json({ error: 'github-auth-unavailable' });
        return;
      }
      res.status(503).json({ error: 'throughput-series-unavailable' });
    }
  });
  return router;
}

import { execFile } from 'node:child_process';
import { Router, type Request, type Response } from 'express';

// RULE 3.1 RATIONALE
// Criticality: low — this is a read-only dashboard signal with no actuation authority.
// Frequency: on-demand, browser-selected, with a private one-minute response cache.
// Stability: `gh --json` and GraphQL are versioned structured interfaces; no human text is parsed.
// Fallback: command, schema, or JSON failure returns explicit HTTP 503, never plausible zero metrics.
// Verdict: deterministic aggregation over bounded inputs; contract tests pin author and index semantics.
// RULE 3: EXEMPT — this parses typed, structured GitHub JSON and fails the read closed; it does not infer provider state from presentation text.

type Author = 'codey' | 'echo' | 'other';
type Weights = { velocity: number; speed: number; quality: number; output: number };
type GhExec = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
type Pr = { number: number; title: string; author?: { login?: string }; mergedAt: string; createdAt: string; additions: number; deletions: number };
type Detail = { reworkLoops: number; commits: number };

export const DEFAULT_THROUGHPUT_WEIGHTS: Weights = { velocity: .40, speed: .20, quality: .25, output: .15 };
const WINDOWS = [7, 14, 30] as const;
const ZERO = () => ({ merges: 0, medianLatencyH: 0, reworkLoops: 0, reverts: 0, medianPushIters: 0, medianLoc: 0 });

function gh(args: string[]): ReturnType<GhExec> {
  return new Promise(resolve => execFile('gh', args, { timeout: 30_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) =>
    resolve({ code: err ? 1 : 0, stdout: stdout ?? '', stderr: stderr ?? '' })));
}
function median(values: number[]): number {
  if (!values.length) return 0;
  const a = [...values].sort((x, y) => x - y); const m = Math.floor(a.length / 2);
  return Math.round((a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2) * 10) / 10;
}
function authorOf(login?: string): Author { return login === 'JKHeadley' ? 'codey' : login === 'EchoOfDawn' ? 'echo' : 'other'; }
function pdtDay(iso: string): string { return new Date(Date.parse(iso) - 7 * 3_600_000).toISOString().slice(0, 10); }
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
async function detailMap(numbers: number[], run: GhExec): Promise<Map<number, Detail>> {
  const out = new Map<number, Detail>();
  for (let offset = 0; offset < numbers.length; offset += 50) {
    const batch = numbers.slice(offset, offset + 50);
    const fields = batch.map(n => `p${n}:pullRequest(number:${n}){number reviews(first:30){nodes{state}} commits{totalCount}}`).join(' ');
    const r = await run(['api', 'graphql', '-f', `query=query{repository(owner:"JKHeadley",name:"instar"){${fields}}}`]);
    if (r.code) throw new Error(`github-details-unavailable: ${r.stderr.slice(0, 120)}`);
    const repo = JSON.parse(r.stdout)?.data?.repository ?? {};
    for (const n of batch) {
      const p = repo[`p${n}`]; if (!p) continue;
      out.set(n, { reworkLoops: (p.reviews?.nodes ?? []).filter((x: { state?: string }) => x.state === 'CHANGES_REQUESTED').length, commits: Number(p.commits?.totalCount ?? 0) });
    }
  }
  return out;
}

/** Canonical server-owned implementation of Echo's throughput-metrics.mjs contract. */
export async function buildThroughputSeries(opts: { days: 7 | 14 | 30; now?: Date; run?: GhExec; weights?: Weights }) {
  const now = opts.now ?? new Date(); const run = opts.run ?? gh; const weights = opts.weights ?? DEFAULT_THROUGHPUT_WEIGHTS;
  const cutoff = now.getTime() - opts.days * 86_400_000;
  const listed = await run(['pr', 'list', '--repo', 'JKHeadley/instar', '--state', 'merged', '--limit', '400', '--json', 'number,title,author,mergedAt,createdAt,additions,deletions']);
  if (listed.code) throw new Error(`github-list-unavailable: ${listed.stderr.slice(0, 120)}`);
  const prs = (JSON.parse(listed.stdout) as Pr[]).filter(p => Date.parse(p.mergedAt) >= cutoff && Date.parse(p.mergedAt) <= now.getTime());
  const details = await detailMap(prs.map(p => p.number), run);
  const days = new Map<string, Pr[]>();
  for (const p of prs) days.set(pdtDay(p.mergedAt), [...(days.get(pdtDay(p.mergedAt)) ?? []), p]);
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

export function createThroughputRoutes(options: { run?: GhExec; weights?: Weights } = {}): Router {
  const router = Router();
  router.get('/throughput/series', async (req: Request, res: Response) => {
    const days = Number(req.query.days ?? 14);
    if (!WINDOWS.includes(days as 7 | 14 | 30)) { res.status(400).json({ error: 'invalid-throughput-window', allowed: WINDOWS }); return; }
    try {
      res.set('Cache-Control', 'private, max-age=60').json(await buildThroughputSeries({ days: days as 7 | 14 | 30, ...options }));
    } catch {
      res.status(503).json({ error: 'throughput-series-unavailable' });
    }
  });
  return router;
}

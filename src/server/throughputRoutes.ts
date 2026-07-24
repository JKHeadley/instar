import { Router, type Request, type Response } from 'express';

type Author = 'codey' | 'echo';
const AUTHORS: Record<string, Author> = { JKHeadley: 'codey', EchoOfDawn: 'echo' };

function median(values: number[]): number { if (!values.length) return 0; const a = [...values].sort((x, y) => x - y); const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; }
function dayOf(iso: string): string { return new Date(iso).toISOString().slice(0, 10); }

export function createThroughputRoutes(): Router {
  const router = Router();
  router.get('/throughput/series', async (req: Request, res: Response) => {
    const days = Math.min(90, Math.max(1, Number(req.query.days ?? 14) || 14));
    const since = Date.now() - days * 86400000;
    const rows = new Map<string, any>();
    for (let i = 0; i < days; i++) {
      const d = new Date(since + i * 86400000).toISOString().slice(0, 10);
      rows.set(d, { day: d, authors: { codey: { merges: 0, medianLatencyH: 0, reworkLoops: 0, reverts: 0, medianPushIters: 0, medianLoc: 0 }, echo: { merges: 0, medianLatencyH: 0, reworkLoops: 0, reverts: 0, medianPushIters: 0, medianLoc: 0 } }, team: { merges: 0, medianLatencyH: 0, reworkLoops: 0, reverts: 0, medianPushIters: 0, medianLoc: 0, dayLoc: 0, index: 0 } });
    }
    try {
      const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
      const response = await fetch(`https://api.github.com/repos/JKHeadley/instar/pulls?state=closed&per_page=100&sort=updated&direction=desc`, { headers: { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
      if (response.ok) {
        const pulls = await response.json() as any[];
        for (const p of pulls) {
          if (!p.merged_at || new Date(p.merged_at).getTime() < since) continue;
          const d = dayOf(p.merged_at); const row = rows.get(d); if (!row) continue;
          const author: Author = AUTHORS[p.user?.login] ?? 'codey'; const target = row.authors[author];
          target.merges++; target.medianLatencyH = median([target.medianLatencyH, Math.max(0, (new Date(p.merged_at).getTime() - new Date(p.created_at).getTime()) / 3600000)]);
          target.medianLoc += Number(p.additions ?? 0) + Number(p.deletions ?? 0); target.medianPushIters = 1;
          row.team.merges++; row.team.medianLatencyH = median([row.team.medianLatencyH, target.medianLatencyH]); row.team.dayLoc += Number(p.additions ?? 0) + Number(p.deletions ?? 0);
        }
      }
    } catch { /* dashboard remains honest with zero rows when GitHub is unavailable */ }
    const values = [...rows.values()]; const maxM = Math.max(1, ...values.map(r => r.team.merges)); const maxL = Math.max(1, ...values.map(r => r.team.medianLatencyH)); const maxLoc = Math.max(1, ...values.map(r => r.team.dayLoc));
    for (const r of values) { const v = r.team.merges / maxM; const s = 1 - r.team.medianLatencyH / maxL; const q = r.team.merges ? 1 : 0; const o = Math.log1p(r.team.dayLoc) / Math.log1p(maxLoc); r.team.index = Math.round(100 * (.40 * v + .20 * s + .25 * q + .15 * o) * 10) / 10; }
    res.set('Cache-Control', 'private, max-age=60').json({ repo: 'JKHeadley/instar', windowDays: days, generatedAt: new Date().toISOString(), rows: values });
  });
  return router;
}

/**
 * ScriptRolloutReport — the one-time "7 days after the flip" report per
 * converted job and machine (docs/specs/job-cost-reduction.md §9.4).
 *
 * Seven days after a slug's first script run on this machine, one report goes
 * to the job log (logs/script-rollout-report.jsonl) and the existing Updates
 * topic (through the injected post-update channel). It states before and after
 * for that slug, FLAGS for a human look (never a verdict) any shift in the
 * daily failure or anomaly count larger than 2× the baseline's daily standard
 * deviation, and quotes one raw run end to end.
 *
 * Sent once: a machine-local marker (state/script-rollout-reports.json) records
 * each slug once it was delivered; a failed post is retried on a later tick.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { JobDefinition } from '../core/types.js';

export const ROLLOUT_REPORT_DELAY_MS = 7 * 24 * 60 * 60 * 1000;

export interface PeriodStats {
  days: number;
  runs: number;
  weightedTokens: number;
  /** One entry per day of the period. */
  failuresPerDay: number[];
  anomaliesPerDay: number[];
}

export interface CostComparison {
  /** The frozen baseline; null with a reason when none exists. */
  before: PeriodStats | null;
  baselineReason?: string;
  after: PeriodStats;
}

export interface ScriptRolloutReportDeps {
  listScriptJobs(): JobDefinition[];
  /** When this slug first ran as a script on this machine (ISO), or null. */
  firstScriptRunAt(slug: string): string | null;
  /** Builder C's JobCostReport, adapted: before = baseline, after = the 7 days since the flip. */
  costReportFor(slug: string): CostComparison | null | Promise<CostComparison | null>;
  /** This machine's newest run rows for the slug (newest first). */
  getLocalRunsForSlug(slug: string, limit: number): Array<{ runId: string; result: string; startedAt: string; outputSummary?: string }>;
  /** The existing Updates-topic channel. */
  postUpdate(text: string): Promise<unknown>;
  machineId: string;
  stateDir: string;
  logsDir: string;
  now?: () => number;
}

function mean(xs: number[]): number { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
function sd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

/** Flags (never verdicts) for a shift larger than 2× the baseline's daily SD. */
export function shiftFlags(before: PeriodStats, after: PeriodStats): string[] {
  const flags: string[] = [];
  for (const [label, b, a] of [
    ['failures', before.failuresPerDay, after.failuresPerDay],
    ['anomalies', before.anomaliesPerDay, after.anomaliesPerDay],
  ] as const) {
    const bm = mean([...b]); const am = mean([...a]); const s = sd([...b]);
    const shift = Math.abs(am - bm);
    // A zero-variance baseline flags any change at all.
    if ((s === 0 && shift > 0) || (s > 0 && shift > 2 * s)) {
      flags.push(`daily ${label} moved from ${bm.toFixed(1)} to ${am.toFixed(1)} (baseline daily spread ${s.toFixed(1)}): worth a look`);
    }
  }
  return flags;
}

export function renderRolloutReport(slug: string, machineId: string, cmp: CostComparison, raw: { runId: string; result: string; startedAt: string; outputSummary?: string } | null): string {
  const lines = [`Job "${slug}" has run as a script on ${machineId} for 7 days. Before and after:`];
  if (cmp.before) {
    lines.push(`- before: ${cmp.before.runs} runs, about ${Math.round(cmp.before.weightedTokens / Math.max(1, cmp.before.days)).toLocaleString('en-US')} weighted tokens a day`);
  } else {
    lines.push(`- before: no baseline${cmp.baselineReason ? ` (${cmp.baselineReason})` : ''}`);
  }
  lines.push(`- after: ${cmp.after.runs} runs, about ${Math.round(cmp.after.weightedTokens / Math.max(1, cmp.after.days)).toLocaleString('en-US')} weighted tokens a day`);
  const flags = cmp.before ? shiftFlags(cmp.before, cmp.after) : [];
  if (flags.length) lines.push('For a human look (not a verdict):', ...flags.map(f => `- ${f}`));
  else if (cmp.before) lines.push('No failure or anomaly count moved more than twice its usual daily spread.');
  if (raw) lines.push(`One raw run (${raw.runId}, ${raw.startedAt}, ${raw.result}):`, (raw.outputSummary ?? '(no output recorded)').slice(0, 1000));
  return lines.join('\n');
}

export class ScriptRolloutReport {
  private readonly d: ScriptRolloutReportDeps;
  private running = false;

  constructor(deps: ScriptRolloutReportDeps) { this.d = deps; }

  private now(): number { return (this.d.now ?? Date.now)(); }
  private markerPath(): string { return path.join(this.d.stateDir, 'state', 'script-rollout-reports.json'); }

  private readSent(): Record<string, string> {
    try { return JSON.parse(fs.readFileSync(this.markerPath(), 'utf-8')) as Record<string, string>; }
    catch { return {}; /* @silent-fallback-ok — no marker yet means nothing sent */ }
  }

  private markSent(slug: string): void {
    const sent = this.readSent();
    sent[slug] = new Date(this.now()).toISOString();
    fs.mkdirSync(path.dirname(this.markerPath()), { recursive: true });
    fs.writeFileSync(this.markerPath(), JSON.stringify(sent, null, 2));
  }

  /** Scheduler tick: send every report that has come due. Returns the slugs sent. */
  async tick(): Promise<string[]> {
    if (this.running) return [];
    this.running = true;
    const out: string[] = [];
    try {
      const sent = this.readSent();
      for (const job of this.d.listScriptJobs()) {
        if (sent[job.slug]) continue;
        const first = this.d.firstScriptRunAt(job.slug);
        const t = first ? Date.parse(first) : NaN;
        if (!Number.isFinite(t) || this.now() - t < ROLLOUT_REPORT_DELAY_MS) continue;
        try {
          const cmp = await this.d.costReportFor(job.slug);
          if (!cmp) continue;
          const raw = this.d.getLocalRunsForSlug(job.slug, 1)[0] ?? null;
          const text = renderRolloutReport(job.slug, this.d.machineId, cmp, raw);
          await this.d.postUpdate(text);
          this.log({ slug: job.slug, text });
          this.markSent(job.slug);
          out.push(job.slug);
        } catch (err) {
          console.warn(`[ScriptRolloutReport] ${job.slug}: report not sent, retrying later:`, err instanceof Error ? err.message : String(err));
        }
      }
    } finally {
      this.running = false;
    }
    return out;
  }

  private log(row: { slug: string; text: string }): void {
    try {
      fs.mkdirSync(this.d.logsDir, { recursive: true });
      fs.appendFileSync(path.join(this.d.logsDir, 'script-rollout-report.jsonl'), JSON.stringify({ ts: new Date(this.now()).toISOString(), machineId: this.d.machineId, ...row }) + '\n');
    } catch (err) {
      console.warn('[ScriptRolloutReport] log write failed:', err instanceof Error ? err.message : String(err));
    }
  }
}

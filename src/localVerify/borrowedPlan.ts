/**
 * Which files a run machine sends to a helper, and in what slices
 * (docs/specs/local-verify-borrowed-unit-slices.md, F "Which files" / "How much is sent").
 *
 * Decision point (judgment-candidate): floor = eligible files only; arbiter = recorded durations
 * and the helper's measured throughput (seeded from the trials until measured); conservative
 * default = send only the seeded amount. Durations only choose WHICH files are also run on a
 * helper: the run machine's own unit lane still runs every file.
 *
 * Pure.
 */
import { filterOverlapGroups } from './shardPlan.js';

export const BORROWED_PLAN = Object.freeze({
  /** The slice budget starts at 10 s of the helper's measured time (trials' median slices: 5 to 11 s). */
  initialBudgetMs: 10_000,
  /** Enlarged while vitest startup is over a quarter of a slice; never past this. */
  maxBudgetMs: 60_000,
  /** A file longer than the budget goes alone if it fits within 3x the budget; otherwise it is not sent. */
  longFileFactor: 3,
  /**
   * Seeded share of a run machine's unit throughput: about 0.27 of the Studio (0.17 of an M5) at the
   * laptop's allowed workers. The Studio is the first pairing; the M5 is only paired while it runs
   * `main` verifies, and a mis-seed only changes how much is sent before 5 measured runs replace it.
   */
  seedRelativeShare: 0.27,
  /** Seeded preparation time (trials: about 3 minutes). */
  seedPrepMs: 3 * 60_000,
  /** Measured values replace the seeds after this many runs with a finished slice. */
  measuredAfterRuns: 5,
  /**
   * The unit lane's wall-to-sum factor when none is known (1.22 measured on the Studio, 2026-11-18).
   */
  defaultWallFactor: 1.22,
  /**
   * PRACTICE-PHASE DEFAULT: time from a `main` run's start to its unit lane's start (fetch, merge
   * tree, install, build). The run's own end always ends the shadow window too. Re-measured from the
   * audited prepWaitMs and the run logs in the 20-run report.
   */
  setupAllowanceMs: 4 * 60_000,
});

/**
 * Local file-seconds per helper-second: what a helper completes per second of its wall time,
 * expressed in the run machine's own per-file durations.
 */
export function seededThroughput(localWorkers: number, wallFactor: number = BORROWED_PLAN.defaultWallFactor): number {
  return (BORROWED_PLAN.seedRelativeShare * Math.max(1, localWorkers)) / Math.max(0.5, wallFactor);
}

/** Projected unit lane wall time: the files' summed durations spread over the workers, times the wall factor. */
export function projectedUnitLaneMs(fileMs: readonly number[], localWorkers: number, wallFactor: number = BORROWED_PLAN.defaultWallFactor): number {
  const sum = fileMs.reduce((n, x) => n + (Number.isFinite(x) && x > 0 ? x : 0), 0);
  return Math.round((sum / Math.max(1, localWorkers)) * wallFactor);
}

/** How much local file time to send: throughput × (projected unit lane time − the helper's prepMs p90). */
export function sendAmountMs(o: { throughput: number; projectedUnitMs: number; prepP90Ms: number }): number {
  return Math.max(0, Math.round(o.throughput * (o.projectedUnitMs - o.prepP90Ms)));
}

/** Enlarge the budget while the audited vitest startup is over a quarter of a slice. */
export function nextBudgetMs(current: number, recentVitestStartMs: readonly number[]): number {
  const xs = recentVitestStartMs.filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  if (xs.length === 0) return current;
  const median = xs[Math.floor(xs.length / 2)];
  if (median * 4 <= current) return current;
  return Math.min(BORROWED_PLAN.maxBudgetMs, Math.max(current, median * 4));
}

export interface SlicePlan {
  slices: string[][];
  sentLocalMs: number;
  /** Unit time never eligible because a file (group) is longer than 3x the slice capacity (audited). */
  neverEligibleMs: number;
  neverEligibleFiles: string[];
}

/**
 * Pack eligible files into slices of `budgetMs` helper time (capacity = budget × throughput in
 * local ms), longest first, until `sendLocalMs` is reached. Files whose paths contain one another
 * (vitest's substring filter) stay in one slice (filterOverlapGroups). A group longer than the
 * capacity goes alone if it fits within 3x; otherwise it is not sent.
 */
export function planSlices(o: { files: ReadonlyArray<{ file: string; ms: number }>; budgetMs: number; throughput: number; sendLocalMs: number }): SlicePlan {
  const ms = new Map(o.files.map((f) => [f.file, Number.isFinite(f.ms) && f.ms > 0 ? f.ms : 0]));
  const cap = Math.max(1, o.budgetMs * o.throughput);
  const groups = filterOverlapGroups([...ms.keys()]).map((g) => ({ files: g, ms: g.reduce((n, f) => n + (ms.get(f) ?? 0), 0) }));
  groups.sort((a, b) => b.ms - a.ms || (a.files[0] < b.files[0] ? -1 : 1));
  const slices: Array<{ files: string[]; ms: number }> = [];
  let sent = 0;
  let neverEligibleMs = 0;
  const neverEligibleFiles: string[] = [];
  for (const g of groups) {
    if (g.ms > cap * BORROWED_PLAN.longFileFactor) { neverEligibleMs += g.ms; neverEligibleFiles.push(...g.files); continue; }
    if (sent >= o.sendLocalMs) continue;
    if (g.ms > cap) { slices.push({ files: [...g.files], ms: g.ms }); sent += g.ms; continue; }
    const fit = slices.find((s) => s.ms <= cap && s.ms + g.ms <= cap);
    if (fit) { fit.files.push(...g.files); fit.ms += g.ms; } else slices.push({ files: [...g.files], ms: g.ms });
    sent += g.ms;
  }
  return { slices: slices.map((s) => s.files.sort()), sentLocalMs: sent, neverEligibleMs, neverEligibleFiles };
}

/** The p90 of a list (nearest-rank), or null when empty. */
export function p90(xs: readonly number[]): number | null {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  return v[Math.min(v.length - 1, Math.ceil(v.length * 0.9) - 1)];
}

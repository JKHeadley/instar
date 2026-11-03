/**
 * Wedge candidate window rules (docs/specs/machine-self-maintenance.md, Part E).
 *
 * Pure: observations in, window state out. No I/O and no clock of its own.
 *
 * A candidate is one continuous 20-minute evidence window with at least 3
 * observations in which the same two families are positive at every observation.
 * A negative observation of either family resets the window. A missing sample
 * (the family unknown or ineligible) neither counts as positive nor resets, but a
 * gap over 6 minutes between observations restarts the window, so a stalled
 * monitor or a maintainer takeover cannot bridge it. The judge needs both families
 * observed positive within the last 6 minutes.
 *
 * One family positive for 2 hours forms no candidate; it brings the scheduled
 * restart forward (`forcedDueAt`). Uptime under 6 hours marks a candidate
 * `recently-restarted`, which caps its outcome at a notice.
 *
 * F3 (stuck dialog) never forms a candidate: it needs a ladder to exist first.
 */

const MIN = 60_000;

export const WEDGE_WINDOW_MS = 20 * MIN;
export const WEDGE_MIN_OBSERVATIONS = 3;
export const WEDGE_MAX_GAP_MS = 6 * MIN;
export const WEDGE_FRESH_MS = 6 * MIN;
export const WEDGE_SINGLE_FAMILY_MS = 2 * 60 * MIN;
export const WEDGE_RECENT_BOOT_MS = 6 * 60 * MIN;
export const WEDGE_SAMPLE_IDLE_MS = 10 * MIN;
export const WEDGE_SAMPLE_POSITIVE_MS = 2 * MIN;

/** The families that can form a candidate. F3 informs the judge only. */
export const CANDIDATE_FAMILIES = ['F1', 'F2', 'F4'] as const;
export type CandidateFamily = typeof CANDIDATE_FAMILIES[number];
export type FamilyId = CandidateFamily | 'F3';

/**
 * One family's reading at one sample. `unknown`: it could not be read here (a
 * platform without the probe, an unreadable source). `ineligible`: read, but the
 * spec says it must not count yet (F1 before its probe has passed this boot).
 * Neither is negative.
 */
export type FamilyResult = 'positive' | 'negative' | 'unknown' | 'ineligible' | 'not-covered';

export interface Sample {
  at: number;
  results: Record<CandidateFamily, FamilyResult>;
}

export interface RunState {
  startAt: number;
  lastObsAt: number;
  observations: number;
}

export interface WindowState {
  /** Keyed by pair, e.g. `F1+F2`. */
  pairs: Record<string, RunState>;
  /** One run per family, for the single-family rule. */
  singles: Partial<Record<CandidateFamily, RunState>>;
}

export function emptyWindow(): WindowState {
  return { pairs: {}, singles: {} };
}

export const PAIRS: ReadonlyArray<[CandidateFamily, CandidateFamily]> = [['F1', 'F2'], ['F1', 'F4'], ['F2', 'F4']];
export const pairKey = (a: CandidateFamily, b: CandidateFamily): string => `${a}+${b}`;

function advance(run: RunState | undefined, at: number): RunState {
  if (!run || at - run.lastObsAt > WEDGE_MAX_GAP_MS) return { startAt: at, lastObsAt: at, observations: 1 };
  return { startAt: run.startAt, lastObsAt: at, observations: run.observations + 1 };
}

/** Folds one sample into the window. Returns a new state; the input is not changed. */
export function observe(state: WindowState, sample: Sample): WindowState {
  const next: WindowState = { pairs: { ...state.pairs }, singles: { ...state.singles } };
  for (const [a, b] of PAIRS) {
    const key = pairKey(a, b);
    const ra = sample.results[a];
    const rb = sample.results[b];
    if (ra === 'negative' || rb === 'negative') delete next.pairs[key];
    else if (ra === 'positive' && rb === 'positive') next.pairs[key] = advance(next.pairs[key], sample.at);
    // Otherwise a missing sample for this pair: no count, no reset. The gap rule applies at the next observation.
  }
  for (const f of CANDIDATE_FAMILIES) {
    const r = sample.results[f];
    if (r === 'negative') delete next.singles[f];
    else if (r === 'positive') next.singles[f] = advance(next.singles[f], sample.at);
  }
  return next;
}

/** A window that has met the candidate rule. */
export function isCandidateRun(run: RunState | undefined): boolean {
  return !!run && run.observations >= WEDGE_MIN_OBSERVATIONS && run.lastObsAt - run.startAt >= WEDGE_WINDOW_MS;
}

/** Both families of this run were observed positive recently enough for the judge. */
export function isFresh(run: RunState, now: number): boolean {
  return now - run.lastObsAt <= WEDGE_FRESH_MS;
}

export interface Candidate {
  pair: string;
  startAt: number;
  lastObsAt: number;
  observations: number;
}

/**
 * The candidate, if any pair qualifies. With more than one, the longest-running wins,
 * ties to the first pair in `PAIRS`, so the same evidence always names the same pair.
 */
export function currentCandidate(state: WindowState): Candidate | null {
  let best: Candidate | null = null;
  for (const [a, b] of PAIRS) {
    const key = pairKey(a, b);
    const run = state.pairs[key];
    if (!isCandidateRun(run)) continue;
    if (!best || run!.startAt < best.startAt) best = { pair: key, ...run! };
  }
  return best;
}

/** A family positive for the single-family span, when no candidate is formed. */
export function singleFamilyRun(state: WindowState): { family: CandidateFamily; run: RunState } | null {
  for (const f of CANDIDATE_FAMILIES) {
    const run = state.singles[f];
    if (run && run.lastObsAt - run.startAt >= WEDGE_SINGLE_FAMILY_MS) return { family: f, run };
  }
  return null;
}

/** Under 6 hours of uptime: a restart that did not help is not repeated. Unknown boot time is unknown. */
export function recentlyRestarted(now: number, lastBootAt: number | null): boolean | null {
  if (lastBootAt === null || !Number.isFinite(lastBootAt)) return null;
  return now - lastBootAt < WEDGE_RECENT_BOOT_MS;
}

/** Sample every 10 minutes, and every 2 once any family is positive. */
export function nextSampleDelay(sample: Sample | null): number {
  if (!sample) return WEDGE_SAMPLE_IDLE_MS;
  return CANDIDATE_FAMILIES.some((f) => sample.results[f] === 'positive') ? WEDGE_SAMPLE_POSITIVE_MS : WEDGE_SAMPLE_IDLE_MS;
}

export type JudgeAction = 'leave' | 'gentle' | 'restart-next-window' | 'restart-now';
export const JUDGE_ACTIONS: ReadonlyArray<JudgeAction> = ['leave', 'gentle', 'restart-next-window', 'restart-now'];

/**
 * The ladder rungs a proposal would run if the feature were live. Rung 6 runs only if
 * the machine is still up 8 minutes after rung 5, so it is listed as conditional.
 * Recorded only: nothing in this build runs any rung.
 */
export function rungsFor(action: JudgeAction | null, cappedAtNotice: boolean): { rungs: number[]; conditional: number[] } {
  if (cappedAtNotice) return { rungs: [], conditional: [] };
  switch (action) {
    case 'leave': return { rungs: [], conditional: [] };
    case 'gentle': return { rungs: [1, 2, 3], conditional: [] };
    case 'restart-next-window': return { rungs: [1, 2, 3], conditional: [] };
    case 'restart-now': return { rungs: [1, 2, 3, 4, 5], conditional: [6] };
    // No usable proposal: the deterministic fallback runs the gentle rungs and brings the restart forward.
    default: return { rungs: [1, 2, 3], conditional: [] };
  }
}

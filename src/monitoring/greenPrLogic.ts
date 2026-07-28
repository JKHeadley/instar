/**
 * greenPrLogic — PURE decision helpers for the GreenPrAutoMerger
 * (green-pr-automerge-enforcement). No I/O, no clock of their own (time is
 * passed in), so every decision boundary is unit-testable on both sides.
 *
 * The orchestrating class (GreenPrAutoMerger.ts) wires these to real gh /
 * safe-merge / lease / latch / audit I/O.
 */

/** One PR as returned by the `gh pr list` GraphQL projection. */
export interface PrSummary {
  number: number;
  title: string;
  labels: string[];
  isDraft: boolean;
  headRefName: string;
  headRefOid: string;
  /** GraphQL mergeable enum: MERGEABLE | CONFLICTING | UNKNOWN. */
  mergeable: string;
  /** Worst-case rollup of the head's checks: SUCCESS | PENDING | FAILURE | null. */
  statusRollup: string | null;
  /**
   * GitHub-side native-auto-merge state derived from the `autoMergeRequest`
   * field of the `gh pr list` projection (true ⇔ the PR has auto-merge armed).
   * Optional/forward-compatible — absent on a legacy projection that did not
   * request the field. The CHEAP-PASS source of truth for "already armed,"
   * surviving a lease move with no local episode (mergerunner-auto-arm-handoff
   * Blocker 4: GitHub-side armed state is authoritative, not the local episode).
   */
  autoMergeArmed?: boolean;
  /**
   * Red-PR watchdog (red-pr-watchdog). The LATEST-run-per-check checks whose
   * conclusion is a failing one (FAILURE|ERROR|CANCELLED|TIMED_OUT), each with
   * its `completedAt` ms. Populated by mapPr from the raw statusCheckRollup —
   * already fetched by the list projection (no new gh call). Absent on a legacy
   * projection. `completedAt:0` means the timestamp was unknown.
   */
  failingChecks?: { name: string; completedAt: number }[];
}

/**
 * A single check normalized from a raw statusCheckRollup entry (either a
 * CheckRun — `name`/`conclusion`/`status`/`startedAt`/`completedAt` — or a
 * legacy StatusContext — `context`/`state`/`createdAt`). Timestamps are ms
 * (0 when unknown); `conclusion`/`status` are upper-cased.
 */
export interface NormalizedCheck {
  name: string;
  conclusion: string;
  status: string;
  startedAt: number;
  completedAt: number;
}

/** Conclusions that read as a failing (red) check. Kept in lockstep with deriveRollup's FAILURE set. */
export const FAILING_CONCLUSIONS: ReadonlySet<string> = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT']);

/** Coerce a gh timestamp (ISO string or ms number) to ms; 0 when unparseable/absent. */
function toMs(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : 0;
  }
  return 0;
}

/**
 * Collapse a raw statusCheckRollup to the LATEST run per check name (group by
 * name, keep the entry with the max run-time). This is the dedup that fixes the
 * 2026-07-08 bug: a stale FAILED run superseded by a passing rerun must not read
 * as failure. Unnamed checks never collapse together (each kept as-is).
 */
export function latestRunPerCheck(rollup: unknown): NormalizedCheck[] {
  if (!Array.isArray(rollup)) return [];
  const byName = new Map<string, NormalizedCheck>();
  const anon: NormalizedCheck[] = [];
  for (const raw of rollup as Array<Record<string, unknown>>) {
    if (!raw || typeof raw !== 'object') continue;
    const name = String(raw.name ?? raw.context ?? '').trim();
    const conclusion = String(raw.conclusion ?? raw.state ?? '').toUpperCase();
    const status = String(raw.status ?? '').toUpperCase();
    const startedAt = toMs(raw.startedAt);
    const completedAt = toMs(raw.completedAt) || toMs(raw.startedAt) || toMs((raw as { createdAt?: unknown }).createdAt);
    const norm: NormalizedCheck = { name, conclusion, status, startedAt, completedAt };
    if (!name) { anon.push(norm); continue; }
    const prev = byName.get(name);
    if (!prev) { byName.set(name, norm); continue; }
    // Later run wins: order by best-available run time (startedAt, else completedAt).
    const prevOrder = prev.startedAt || prev.completedAt;
    const order = startedAt || completedAt;
    if (order >= prevOrder) byName.set(name, norm);
  }
  return [...byName.values(), ...anon];
}

/**
 * The failing (red) checks of a PR's rollup, deduped to the latest run per check.
 * Each carries its `completedAt` ms so the watchdog can age it. An in-progress
 * rerun (status != COMPLETED) is never counted as failing even if a prior run
 * failed — latestRunPerCheck already dropped the superseded run.
 */
export function failingChecksFromRollup(rollup: unknown): { name: string; completedAt: number }[] {
  return latestRunPerCheck(rollup)
    .filter((c) => (!c.status || c.status === 'COMPLETED') && FAILING_CONCLUSIONS.has(c.conclusion))
    .map((c) => ({ name: c.name || '(unnamed check)', completedAt: c.completedAt }));
}

/**
 * The failing checks of a PR that have been red for at least `thresholdMs`
 * (measured from each check's `completedAt`). A check with an unknown completed
 * time (completedAt:0) is NOT counted — we can't prove it has been red long
 * enough, so we fail toward NOT alerting (signal-only).
 */
export function stuckRedChecks(
  pr: Pick<PrSummary, 'failingChecks'>,
  now: number,
  thresholdMs: number,
): { name: string; completedAt: number }[] {
  const failing = pr.failingChecks ?? [];
  return failing.filter((c) => c.completedAt > 0 && now - c.completedAt >= thresholdMs);
}

export type HoldReason = 'draft' | 'hold-title' | 'hold-label' | null;

/** A PR is held (excluded) by a deliberate marker. Returns WHY, or null. */
export function holdReasonOf(pr: Pick<PrSummary, 'isDraft' | 'title' | 'labels'>): HoldReason {
  if (pr.isDraft) return 'draft';
  // Title trimmed before the prefix match (round-5: a hand-edited " [HOLD]" with
  // leading whitespace must not silently fail).
  const title = (pr.title ?? '').trim().toLowerCase();
  if (title.startsWith('[hold')) return 'hold-title';
  const labels = (pr.labels ?? []).map((l) => l.toLowerCase());
  if (labels.includes('hold') || labels.includes('do-not-merge')) return 'hold-label';
  return null;
}

export type CandidateSkip =
  | 'not-agent-namespace'
  | 'held'
  | 'not-mergeable'
  | 'not-settled-green'
  | 'protected-paths'
  | 'protected-paths-unverifiable';

export interface CandidateVerdict {
  eligible: boolean;
  skip?: CandidateSkip;
  hold?: HoldReason;
}

/**
 * First-pass candidacy from the list projection alone (cheap fields). Protected
 * paths require a separate diff enumeration (handled by the caller and folded in
 * via `protectedPaths`), so this returns `eligible:true` only when the cheap
 * gates ALL pass; the caller still runs the protected-paths check before acting.
 */
export function classifyCandidate(
  pr: PrSummary,
  agentNamespace: string,
): CandidateVerdict {
  if (!headInNamespace(pr.headRefName, agentNamespace)) {
    return { eligible: false, skip: 'not-agent-namespace' };
  }
  const hold = holdReasonOf(pr);
  if (hold) return { eligible: false, skip: 'held', hold };
  if (pr.mergeable !== 'MERGEABLE') return { eligible: false, skip: 'not-mergeable' };
  // "Settled green" — the watcher NEVER invokes safe-merge into a pending wait
  // (keeps each attempt window seconds-long; timeout inversion impossible).
  if (pr.statusRollup !== 'SUCCESS') return { eligible: false, skip: 'not-settled-green' };
  return { eligible: true };
}

/** A head branch `<agentName>/...` filter (a FILTER, not provenance — Decision 8). */
export function headInNamespace(headRefName: string, agentNamespace: string): boolean {
  if (!agentNamespace) return false;
  const prefix = agentNamespace.endsWith('/') ? agentNamespace : `${agentNamespace}/`;
  return headRefName.startsWith(prefix);
}

/**
 * Oldest-first selection over the FULL fetched set (the list query is pinned
 * oldest-first server-side; this is the deterministic tiebreak by PR number).
 */
export function selectOldest(candidates: PrSummary[]): PrSummary | null {
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => a.number - b.number)[0];
}

// ---- hold-release debounce (R3) -------------------------------------------

export interface HoldMemoryEntry {
  /** Consecutive ticks (same lease holder) the marker has been ABSENT. */
  absentTicks: number;
  /** ms timestamp the PR was first observed held this episode. */
  firstHeldAt: number;
  /** ms timestamp of the most recent absence observation. */
  lastAbsentAt?: number;
}

/**
 * Update hold memory for a PR and decide whether it is eligible to RESUME.
 * A PR observed held resumes only after the marker is absent for
 * `holdReleaseTicks` consecutive ticks AND `>= tickIntervalMs` elapsed
 * (tick-AND-time so a manual double-tick cannot collapse the window).
 */
export function debounceHoldRelease(
  mem: HoldMemoryEntry | undefined,
  currentlyHeld: boolean,
  nowMs: number,
  holdReleaseTicks: number,
  tickIntervalMs: number,
): { mem: HoldMemoryEntry | undefined; resumeEligible: boolean; transition: 'still-held' | 'released' | 'observing-release' | 'not-held' } {
  if (currentlyHeld) {
    return {
      mem: { absentTicks: 0, firstHeldAt: mem?.firstHeldAt ?? nowMs },
      resumeEligible: false,
      transition: 'still-held',
    };
  }
  // Not held right now.
  if (!mem) {
    // Never seen held → no debounce needed.
    return { mem: undefined, resumeEligible: true, transition: 'not-held' };
  }
  const absentTicks = mem.absentTicks + 1;
  const elapsedOk = (nowMs - (mem.firstHeldAt ?? nowMs)) >= tickIntervalMs;
  if (absentTicks >= holdReleaseTicks && elapsedOk) {
    return { mem: undefined, resumeEligible: true, transition: 'released' };
  }
  return {
    mem: { absentTicks, firstHeldAt: mem.firstHeldAt, lastAbsentAt: nowMs },
    resumeEligible: false,
    transition: 'observing-release',
  };
}

// ---- per-PR failure ladder (R5) -------------------------------------------

export interface Episode {
  pr: number;
  headRefOid: string;
  attempts: number;
  rearmEpisodes: number;
  state: 'active' | 'gave-up';
  lastAttemptAt?: number;
  nextEligibleAt?: number;
  lastOutcome?: string;
  /**
   * NEW (mergerunner-auto-arm-handoff). When set, GitHub native auto-merge was
   * armed for this PR at `armedAt` (ms) against `armedHead` (the head sha we
   * passed to `--match-head-commit`). An armed episode is GitHub's — it stays
   * `state:'active'`, does NOT advance the ladder, and is reconciled at the top
   * of each acting tick until it merges/closes/disarms. Absent ⇒ not armed.
   */
  armedAt?: number;
  armedHead?: string;
  /**
   * Set true once the episode crosses `armedConfirmCeilingMs` (24h) still
   * OPEN + armed — the `armed-overdue` state (Close the Loop, Blocker 5). It
   * KEEPS reconciling; `armedAt` is never cleared by the ceiling alone.
   * `overdueSurfacedAt` drives the deduped re-raise cadence.
   */
  overdue?: boolean;
  overdueSurfacedAt?: number;
  /**
   * Head-keyed confirm-gap counter (Blocker D). Bounds the non-ladder retry of
   * `error:auto-arm-unconfirmed` / `error:auto-confirm-unreadable` so a
   * persistent confirm gap becomes VISIBLE rather than an invisible tick-loop.
   * Reset to 1 whenever the head changes. Absent ⇒ never had a confirm gap.
   */
  unconfirmedArmAttempts?: { head: string; count: number };
}

export interface LadderConfig {
  maxAttempts: number;
  maxRearmEpisodes: number;
  backoffBaseMs: number;
}

/**
 * Fold a merge OUTCOME into the PR's episode. Returns the updated episode and
 * whether this counts as a breaker-feeding failure. `already-merged` /
 * `closed` are success-noops (never ladder failures). A `refused`/`error`
 * advances the attempt ladder with backoff; at `maxAttempts` the episode is
 * `gave-up` (re-armable by a NEW head sha up to `maxRearmEpisodes`).
 */
export function applyOutcome(
  ep: Episode,
  outcome: string,
  nowMs: number,
  cfg: LadderConfig,
  opts: { armedHead?: string } = {},
): { ep: Episode; terminal: boolean; feedsBreaker: boolean } {
  const next: Episode = { ...ep };
  if (outcome === 'merged') {
    next.state = 'gave-up'; // episode complete; reaped by the caller on confirm
    next.lastOutcome = 'merged';
    return { ep: next, terminal: true, feedsBreaker: false };
  }
  // ARMED (mergerunner-auto-arm-handoff): terminal-success-PENDING. GitHub now
  // owns the merge — the episode stays ALIVE so a LATER reconciliation tick
  // confirms the eventual merge. NOT a ladder attempt and NOT a breaker feed.
  // Exact field-state pinned by the spec: state:'active', attempts UNCHANGED,
  // nextEligibleAt CLEARED, armedAt/armedHead set, lastOutcome:'armed'.
  if (outcome === 'armed') {
    next.state = 'active';
    next.lastOutcome = 'armed';
    next.lastAttemptAt = nowMs;
    next.armedAt = nowMs;
    next.armedHead = opts.armedHead ?? ep.headRefOid;
    next.nextEligibleAt = undefined;
    // A clean arm clears any prior confirm-gap counter for this head.
    next.unconfirmedArmAttempts = undefined;
    return { ep: next, terminal: false, feedsBreaker: false };
  }
  // NON-LADDER retry (Blocker D): safe-merge armed but could not confirm on
  // re-read. NOT a maxAttempts-consuming merge failure — do NOT advance attempts,
  // do NOT feed the breaker. The reconciliation step + the gather() autoMergeArmed
  // belt resolve the true state next tick. Bound it with a head-keyed counter so a
  // genuinely-persistent confirm gap on the SAME head becomes visible (the caller
  // surfaces one deduped attention line at unconfirmedArmCeiling). Stamps only
  // lastOutcome + the counter — never the ladder.
  if (outcome === 'error:auto-arm-unconfirmed' || outcome === 'error:auto-confirm-unreadable') {
    next.lastOutcome = outcome;
    next.lastAttemptAt = nowMs;
    const head = opts.armedHead ?? ep.headRefOid;
    const prior = ep.unconfirmedArmAttempts;
    next.unconfirmedArmAttempts =
      prior && prior.head === head ? { head, count: prior.count + 1 } : { head, count: 1 };
    return { ep: next, terminal: false, feedsBreaker: false };
  }
  if (outcome === 'already-merged' || outcome === 'closed' || outcome === 'merged-by-other' || outcome === 'closed-by-other') {
    next.lastOutcome = outcome;
    next.state = 'gave-up';
    return { ep: next, terminal: true, feedsBreaker: false };
  }
  // A real refusal/error: advance the ladder.
  next.attempts = ep.attempts + 1;
  next.lastAttemptAt = nowMs;
  next.lastOutcome = outcome;
  const backoff = cfg.backoffBaseMs * Math.pow(2, Math.min(next.attempts - 1, 6));
  next.nextEligibleAt = nowMs + backoff;
  if (next.attempts >= cfg.maxAttempts) {
    next.state = 'gave-up';
  }
  return { ep: next, terminal: next.state === 'gave-up', feedsBreaker: true };
}

/**
 * Re-arm a gave-up episode when a NEW head sha appears (the author pushed a
 * fix). Bounded by `maxRearmEpisodes` — beyond that, manual action is required.
 */
export function maybeRearm(ep: Episode, newHeadOid: string, cfg: LadderConfig): Episode | null {
  if (ep.state !== 'gave-up') return ep;
  if (ep.headRefOid === newHeadOid) return ep; // same head, still given up
  if (ep.rearmEpisodes >= cfg.maxRearmEpisodes) return null; // exhausted
  return {
    pr: ep.pr,
    headRefOid: newHeadOid,
    attempts: 0,
    rearmEpisodes: ep.rearmEpisodes + 1,
    state: 'active',
  };
}

/** Is the episode currently eligible to attempt (active + backoff elapsed)? */
export function episodeEligible(ep: Episode | undefined, nowMs: number): boolean {
  if (!ep) return true; // first attempt
  if (ep.state === 'gave-up') return false;
  if (ep.nextEligibleAt && nowMs < ep.nextEligibleAt) return false;
  return true;
}

// ---- circuit breaker (R5) -------------------------------------------------

export interface BreakerState {
  open: boolean;
  openedAt?: number;
  consecutiveBusySkips: number;
  consecutiveDeadlineKills: number;
  consecutiveTickFailures: number;
}

export interface BreakerConfig {
  busySkipBreakerThreshold: number;
  deadlineKillBreakerThreshold: number;
  breakerThreshold: number;
  breakerCooldownMs: number;
}

export function freshBreaker(): BreakerState {
  return { open: false, consecutiveBusySkips: 0, consecutiveDeadlineKills: 0, consecutiveTickFailures: 0 };
}

/** Is the breaker open AND still within its cooldown? */
export function breakerBlocking(b: BreakerState, nowMs: number, cooldownMs: number): boolean {
  if (!b.open) return false;
  if (b.openedAt && nowMs - b.openedAt >= cooldownMs) return false; // cooled down
  return true;
}

/** Fold a breaker SIGNAL; returns the updated state (may open the breaker). */
export function feedBreaker(
  b: BreakerState,
  signal: 'busy-skip' | 'deadline-kill' | 'tick-failed' | 'reset',
  nowMs: number,
  cfg: BreakerConfig,
): BreakerState {
  const next: BreakerState = { ...b };
  if (signal === 'reset') {
    return { ...next, consecutiveBusySkips: 0, consecutiveDeadlineKills: 0, consecutiveTickFailures: 0, open: false, openedAt: undefined };
  }
  if (signal === 'busy-skip') {
    next.consecutiveBusySkips += 1;
    if (next.consecutiveBusySkips >= cfg.busySkipBreakerThreshold) { next.open = true; next.openedAt = nowMs; }
  } else if (signal === 'deadline-kill') {
    next.consecutiveDeadlineKills += 1;
    if (next.consecutiveDeadlineKills >= cfg.deadlineKillBreakerThreshold) { next.open = true; next.openedAt = nowMs; }
  } else if (signal === 'tick-failed') {
    next.consecutiveTickFailures += 1;
    if (next.consecutiveTickFailures >= cfg.breakerThreshold) { next.open = true; next.openedAt = nowMs; }
  }
  return next;
}

/** Boot-time invariant (B24): busy-skip budget must outlast a single merge. */
export function validateTimeoutInvariant(
  busySkipBreakerThreshold: number,
  tickIntervalMs: number,
  mergeTimeoutMs: number,
  mergeKillGraceMs: number,
): { ok: boolean; reason?: string } {
  const budget = busySkipBreakerThreshold * tickIntervalMs;
  const need = mergeTimeoutMs + mergeKillGraceMs;
  if (budget <= need) {
    return { ok: false, reason: `busySkipBreakerThreshold(${busySkipBreakerThreshold}) × tickIntervalMs(${tickIntervalMs}) = ${budget} must exceed mergeTimeoutMs(${mergeTimeoutMs}) + mergeKillGraceMs(${mergeKillGraceMs}) = ${need}` };
  }
  return { ok: true };
}

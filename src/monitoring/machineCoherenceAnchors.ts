/**
 * Machine-coherence ANCHORS — the durable, identity-independent clock layer
 * (calm-transient-episode-alerting spec, M-P0).
 *
 * WHY: the confirmation engine's rowState is keyed on the N1 row identity,
 * which EMBEDS every participant's value class — so a version advance mints a
 * new row and wipes the clocks. The grace/ceiling/flap arms of the calm design
 * must survive exactly that churn (plus <2-online clears, sentinel restarts,
 * warmup, and raiser handoff), so their state lives HERE: keyed per
 * `(dimension|key)` (NO value classes), persisted as an additive block in the
 * episode manager's existing durable file, computed on every machine from the
 * shared adverts.
 *
 * Clock model (spec M-P0): `activeSkewMs` accumulates
 * `clamp(now − anchorLastEvaluatedAtMs, 0, K × tickMs)` and credits ONLY
 * reconciles where the key is observed divergent AND every skew participant is
 * present in the compared set — a suspended anchor (participant departed)
 * freezes both the clear and the accumulator; gaps beyond K ticks are
 * retroactively suspended time. Grace and the stall ceiling compare against
 * `activeSkewMs`, never wall-clock-since-onset; advances can never reset it.
 *
 * Pure + deterministic: no I/O, no Date.now() — callers pass `nowMs`.
 * Supervision tier: Tier 0 (deterministic bookkeeping, no LLM anywhere).
 */

import type { SkewDimension, SkewRow } from './machineCoherenceEvaluate.js';

/** One durable anchor, keyed `(dimension|key)` — value classes NEVER enter the key. */
export interface AnchorEntry {
  dimension: SkewDimension;
  key: string;
  /** First appearance of ANY skew on this key (0 = no active skew episode). */
  skewOnsetAtMs: number;
  /** The accumulator grace/ceiling compare against (suspension-aware). */
  activeSkewMs: number;
  /** Last reconcile that evaluated this anchor (the accumulator's delta base). */
  anchorLastEvaluatedAtMs: number;
  /** Union of machines that participated in this key's skew (participant-aware
   *  clear: EVERY one must be present AND agreeing, sustained, to clear). */
  participants: string[];
  /** Sustained-convergence counter toward `resolveTicks` (participant-aware). */
  clearStreakTicks: number;
  /** Set when a confirm transition happened on this key while skewed; a later
   *  GENUINE convergence completes the flap cycle (confirm→heal definition —
   *  bare re-confirms / identity re-mints never complete a cycle). */
  pendingFlapConfirm?: boolean;
  /** Completed flap-cycle timestamps (pruned to 24 h, clamped to 64 events). */
  flapHistory: number[];
  /** When the key last stopped being observed divergent (retirement clock —
   *  entries drop only after ≥`retireAfterMs` sustained absence). */
  absentSinceMs?: number;
  /** Durable per-key 24 h once-latches for the derived escalation raises. */
  lastStalledFireAtMs?: number;
  lastRecurringFireAtMs?: number;
  /** Per-machine progress tracking (version dimension: gap-narrowing advances). */
  perMachine: Record<string, { lastSeenVersion?: string; lastAdvanceAtMs?: number }>;
}

/** The additive durable block (rides EpisodeFile; reader is lenient to it). */
export interface AnchorsBlock {
  entries: Record<string, AnchorEntry>;
  /** Cross-key wave backstop dedupe latch (per-machine; 2×-per-handoff residual accepted). */
  lastWaveNoticeAtMs?: number;
  /** NON-reopen calm-class episode onsets (24 h pruned) feeding the wave backstop. */
  calmOnsetTimestamps: number[];
}

export function emptyAnchors(): AnchorsBlock {
  return { entries: {}, calmOnsetTimestamps: [] };
}

export function anchorKey(dimension: SkewDimension, key: string): string {
  return `${dimension}|${key}`;
}

const DAY_MS = 24 * 3_600_000;
const FLAP_HISTORY_CLAMP = 64;

/** Parse the numeric `major.minor.patch` triplet; prerelease/build ignored; null = unparseable. */
export function parseVersionTriplet(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? '').trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Numeric triplet comparison: negative a<b, 0 equal, positive a>b. */
export function compareTriplets(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/**
 * The gap-narrowing advance predicate (spec M-P0): an advance counts ONLY when
 * the machine's version moves strictly toward the pool's max observed version —
 * `next > prev AND next <= poolMax`. Regression, lateral, unparseable, or a
 * jump PAST the pool max never counts.
 */
export function isGapNarrowingAdvance(prev: string | undefined, next: string, poolMax: string): boolean {
  if (prev === undefined) return false; // first observation is a baseline, not an advance
  const p = parseVersionTriplet(prev);
  const n = parseVersionTriplet(next);
  const max = parseVersionTriplet(poolMax);
  if (!p || !n || !max) return false;
  return compareTriplets(n, p) > 0 && compareTriplets(n, max) <= 0;
}

/** Max observed parseable version across the compared machines ('' if none parse). */
export function poolMaxVersion(versionsByMachine: Record<string, string>): string {
  let best: string = '';
  let bestT: [number, number, number] | null = null;
  for (const v of Object.values(versionsByMachine)) {
    const t = parseVersionTriplet(v);
    if (!t) continue;
    if (!bestT || compareTriplets(t, bestT) > 0) { bestT = t; best = v; }
  }
  return best;
}

/** One reconcile tick's input to the anchor layer (post-M6-suppression rows). */
export interface AnchorReconcileInput {
  nowMs: number;
  tickMs: number;
  /** Gap clamp K (spec: small, e.g. 4) — gaps beyond K ticks are suspended time. */
  kTicks: number;
  /** THIS tick's raw divergent rows (pre-confirmation, post-M6-suppression). */
  rows: SkewRow[];
  /** The online, comparable machine set THIS tick. */
  comparedMachines: string[];
  /** Raw advertised instarVersion per compared machine (progress source). */
  versionsByMachine: Record<string, string>;
  /** Sustained-convergence ticks required to clear (mirrors episode resolveTicks). */
  resolveTicks: number;
  /** Sustained-absence before an entry (and its latches) drops (default 24 h). */
  retireAfterMs: number;
}

export type AnchorEvent =
  | { kind: 'onset'; anchorKey: string }
  | { kind: 'flap-cycle-completed'; anchorKey: string; cyclesIn24h: number }
  | { kind: 'cleared'; anchorKey: string }
  | { kind: 'retired'; anchorKey: string };

/**
 * Advance the anchor block one reconcile tick. Pure: returns the (mutated-in-
 * place) block, whether a MATERIAL change occurred (the persist dirty-check —
 * accumulator-only drift under the 5-min bucket is NOT material), and events.
 */
export function reconcileAnchors(block: AnchorsBlock, input: AnchorReconcileInput): { changed: boolean; events: AnchorEvent[] } {
  const { nowMs, tickMs, kTicks, rows, comparedMachines, versionsByMachine, resolveTicks, retireAfterMs } = input;
  const events: AnchorEvent[] = [];
  let changed = false;
  const compared = new Set(comparedMachines);
  const divergentByKey = new Map<string, SkewRow[]>();
  for (const r of rows) {
    const k = anchorKey(r.dimension, r.key);
    const arr = divergentByKey.get(k) ?? [];
    arr.push(r);
    divergentByKey.set(k, arr);
  }

  // ── 1. Onset / participant-union for keys divergent THIS tick ──
  for (const [k, keyRows] of divergentByKey) {
    let e = block.entries[k];
    const rowParticipants = new Set<string>();
    for (const r of keyRows) for (const p of r.participants) rowParticipants.add(p);
    if (!e) {
      e = {
        dimension: keyRows[0].dimension,
        key: keyRows[0].key,
        skewOnsetAtMs: nowMs,
        activeSkewMs: 0,
        anchorLastEvaluatedAtMs: nowMs,
        participants: [...rowParticipants].sort(),
        clearStreakTicks: 0,
        flapHistory: [],
        perMachine: {},
      };
      block.entries[k] = e;
      changed = true;
      events.push({ kind: 'onset', anchorKey: k });
    } else if (e.skewOnsetAtMs === 0) {
      // Re-skew of a cleared-but-not-retired entry: fresh onset, latches + flap history survive.
      e.skewOnsetAtMs = nowMs;
      e.activeSkewMs = 0;
      e.anchorLastEvaluatedAtMs = nowMs;
      e.participants = [...rowParticipants].sort();
      e.clearStreakTicks = 0;
      e.absentSinceMs = undefined;
      changed = true;
      events.push({ kind: 'onset', anchorKey: k });
    } else {
      // Ongoing skew: union any newly-participating machines; clear absence.
      const before = e.participants.length;
      const union = new Set(e.participants);
      for (const p of rowParticipants) union.add(p);
      e.participants = [...union].sort();
      if (e.participants.length !== before) changed = true;
      if (e.absentSinceMs !== undefined) { e.absentSinceMs = undefined; changed = true; }
      e.clearStreakTicks = 0;
    }
  }

  // ── 2. Per-entry clock credit / clear-streak / retirement ──
  const poolMax = poolMaxVersion(versionsByMachine);
  for (const [k, e] of Object.entries(block.entries)) {
    const divergentNow = divergentByKey.has(k);
    const allParticipantsPresent = e.participants.length > 0 && e.participants.every((p) => compared.has(p));
    const activeEpisode = e.skewOnsetAtMs !== 0;

    // Accumulator: credit ONLY divergent-observed + all-participants-present ticks.
    if (activeEpisode && divergentNow && allParticipantsPresent) {
      const rawDelta = nowMs - e.anchorLastEvaluatedAtMs;
      const credit = Math.min(Math.max(rawDelta, 0), kTicks * tickMs);
      if (credit > 0) e.activeSkewMs += credit;
      // Dirty-check: accumulator drift persists on ≥5-min bucket boundaries only.
      if (Math.floor((e.activeSkewMs - credit) / 300_000) !== Math.floor(e.activeSkewMs / 300_000)) changed = true;
    }
    e.anchorLastEvaluatedAtMs = nowMs;

    // Participant-aware clear: NOT divergent + every participant present + ≥2 compared.
    if (activeEpisode && !divergentNow) {
      if (allParticipantsPresent && compared.size >= 2) {
        e.clearStreakTicks += 1;
        if (e.clearStreakTicks >= resolveTicks) {
          if (e.pendingFlapConfirm) {
            e.flapHistory.push(nowMs);
            e.flapHistory = e.flapHistory.filter((t) => nowMs - t < DAY_MS).slice(-FLAP_HISTORY_CLAMP);
            e.pendingFlapConfirm = undefined;
            events.push({ kind: 'flap-cycle-completed', anchorKey: k, cyclesIn24h: e.flapHistory.length });
          }
          e.skewOnsetAtMs = 0;
          e.activeSkewMs = 0;
          e.clearStreakTicks = 0;
          e.absentSinceMs = nowMs;
          changed = true;
          events.push({ kind: 'cleared', anchorKey: k });
        }
      }
      // participant departed or <2 compared ⇒ suspended: streak frozen, never vacuous-clear.
    }

    // Retirement: sustained absence only (latches survive until then).
    if (!activeEpisode && e.absentSinceMs !== undefined && nowMs - e.absentSinceMs >= retireAfterMs && !divergentNow) {
      delete block.entries[k];
      changed = true;
      events.push({ kind: 'retired', anchorKey: k });
      continue;
    }

    // Progress tracking (version dimension): update per-machine from adverts.
    if (e.dimension === 'version') {
      for (const m of comparedMachines) {
        const v = versionsByMachine[m];
        if (v === undefined) continue;
        const pm = (e.perMachine[m] ??= {});
        if (pm.lastSeenVersion !== v) {
          if (isGapNarrowingAdvance(pm.lastSeenVersion, v, poolMax)) {
            pm.lastAdvanceAtMs = nowMs;
            changed = true; // an observed version change is a material change
          }
          pm.lastSeenVersion = v;
          changed = true;
        }
      }
      // Machines gone from the registry/compared set entirely for the retirement
      // window ride the entry's own retirement; individual pruning is not needed
      // for correctness (bounded by pool size).
    }
  }

  // ── 3. Wave-backstop onset history pruning (24 h) ──
  const beforeLen = block.calmOnsetTimestamps.length;
  block.calmOnsetTimestamps = block.calmOnsetTimestamps.filter((t) => nowMs - t < DAY_MS);
  if (block.calmOnsetTimestamps.length !== beforeLen) changed = true;

  return { changed, events };
}

/** Sentinel → anchors: a confirm transition happened on this key while skewed. */
export function recordConfirmTransition(block: AnchorsBlock, dimension: SkewDimension, key: string): boolean {
  const e = block.entries[anchorKey(dimension, key)];
  if (!e || e.skewOnsetAtMs === 0) return false;
  if (e.pendingFlapConfirm) return false;
  e.pendingFlapConfirm = true;
  return true; // material change
}

/** M-P1 confirmation decision for a patch-only version row (reads the anchor). */
export interface PatchSkewDecisionConfig {
  graceMs: number;
  progressWindowMs: number;
  ceilingMs: number;
  progressExtensionEnabled: boolean;
}

export type PatchSkewDecision =
  | { confirm: false; reason: 'grace' | 'extend' | 'no-anchor' }
  | { confirm: true; reason: 'no-progress' | 'ceiling' };

/**
 * Decide confirm-vs-extend for patch-only version skew (spec M-P1). Laggards =
 * participants whose version parses BELOW the pool max; the extension applies
 * only when EVERY laggard advanced within the window (any stalled laggard ⇒
 * confirm — the conservative, louder direction). No anchor ⇒ fall back to the
 * legacy grace path (fail toward today's behavior).
 */
export function decidePatchSkew(
  block: AnchorsBlock,
  key: string,
  cfg: PatchSkewDecisionConfig,
  nowMs: number,
  versionsByMachine: Record<string, string>,
): PatchSkewDecision {
  const e = block.entries[anchorKey('version', key)];
  if (!e || e.skewOnsetAtMs === 0) return { confirm: false, reason: 'no-anchor' };
  if (e.activeSkewMs < cfg.graceMs) return { confirm: false, reason: 'grace' };
  if (e.activeSkewMs >= cfg.ceilingMs) return { confirm: true, reason: 'ceiling' };
  if (!cfg.progressExtensionEnabled) return { confirm: true, reason: 'no-progress' };
  const poolMax = poolMaxVersion(versionsByMachine);
  const maxT = parseVersionTriplet(poolMax);
  if (!maxT) return { confirm: true, reason: 'no-progress' }; // unreadable ⇒ louder
  const laggards = e.participants.filter((m) => {
    const t = parseVersionTriplet(versionsByMachine[m] ?? '');
    return !t || compareTriplets(t, maxT) < 0; // unparseable counts as lagging (louder)
  });
  if (laggards.length === 0) return { confirm: true, reason: 'no-progress' }; // divergent yet no laggard — confirm (loud)
  const allAdvancing = laggards.every((m) => {
    const pm = e.perMachine[m];
    return pm?.lastAdvanceAtMs !== undefined && nowMs - pm.lastAdvanceAtMs <= cfg.progressWindowMs;
  });
  return allAdvancing ? { confirm: false, reason: 'extend' } : { confirm: true, reason: 'no-progress' };
}

/** Durable 24 h once-latch check + arm for the derived escalation raises. */
export function tryArmDerivedLatch(block: AnchorsBlock, dimension: SkewDimension, key: string, which: 'stalled' | 'recurring', nowMs: number): boolean {
  const e = block.entries[anchorKey(dimension, key)];
  if (!e) return false;
  const last = which === 'stalled' ? e.lastStalledFireAtMs : e.lastRecurringFireAtMs;
  if (last !== undefined && nowMs - last < DAY_MS) return false;
  if (which === 'stalled') e.lastStalledFireAtMs = nowMs;
  else e.lastRecurringFireAtMs = nowMs;
  return true;
}

/** Flap-brake trigger check: ≥threshold completed cycles in 24 h (latch NOT consumed here). */
export function flapBrakeEligible(block: AnchorsBlock, dimension: SkewDimension, key: string, threshold: number, nowMs: number): boolean {
  const e = block.entries[anchorKey(dimension, key)];
  if (!e) return false;
  const recent = e.flapHistory.filter((t) => nowMs - t < DAY_MS).length;
  return recent >= threshold;
}

/** Record a NON-reopen calm-class onset; returns true when the wave backstop should fire (and arms its latch). */
export function recordCalmOnsetAndCheckWave(block: AnchorsBlock, nowMs: number, threshold: number): boolean {
  block.calmOnsetTimestamps.push(nowMs);
  block.calmOnsetTimestamps = block.calmOnsetTimestamps.filter((t) => nowMs - t < DAY_MS);
  if (threshold <= 0) return false;
  if (block.calmOnsetTimestamps.length < threshold) return false;
  if (block.lastWaveNoticeAtMs !== undefined && nowMs - block.lastWaveNoticeAtMs < DAY_MS) return false;
  block.lastWaveNoticeAtMs = nowMs;
  return true;
}

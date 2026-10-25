/**
 * ParallelWorkSentinel — the proactive overlap councilor (Parallel-Work Awareness
 * Phase B; docs/specs/parallel-activity-coherence.md, Part 2).
 *
 * On a cadence it reads the cross-topic activity index, runs the pure overlap detector,
 * and — for genuinely-fresh overlaps — emits ONE 'overlap' nudge so the agent learns its
 * other hand is already on the same work (the willpower-trap fix: the signal comes TO the
 * agent, it doesn't rely on the agent remembering to query). SIGNAL-ONLY — it never gates,
 * blocks, or mutates anything.
 *
 * Convergence-mandated containment (a noisy councilor gets muted, which is worse than
 * silence), all enforced here statefully on top of the pure detector's containment:
 *  - PAIR-KEYED COOLDOWN: at most one nudge per (topicA,topicB) per `nudgeCooldownMs`
 *    (default 60min) — survives focus edits, so responding to a nudge can't re-trigger it.
 *  - SIGNATURE HYSTERESIS: within the cooldown, a re-nudge only fires if the shared-tag SET
 *    changed materially (a genuinely new overlap), not on a one-token focus tweak.
 *  - It is the LEASE-HOLDER's job to run this (the caller gates ticks on holdsLease) so the
 *    same overlap isn't nudged twice from two machines.
 *
 * Ships DARK (the route/config default is enabled:false) — graduate after it's proven quiet.
 */

import { EventEmitter } from 'node:events';
import {
  detectOverlaps,
  pairKey,
  signatureChangedMaterially,
  type OverlapCandidate,
  type OverlapPair,
} from './ParallelWorkOverlap.js';

export interface ParallelWorkSentinelOptions {
  /** Pull the current cross-topic activities (e.g. ParallelActivityIndex.activities()). */
  getActivities: (nowMs: number) => OverlapCandidate[];
  /** Min ms between nudges for the same topic pair (default 60min). */
  nudgeCooldownMs?: number;
  /** Only compare topics worked within this window (passed to the detector; default 4h). */
  activityWindowMs?: number;
  /** Require ≥ this many shared high-specificity tags (default 1). */
  minSharedSpecific?: number;
  /** Audit sink for every transition (detected/nudged/deduped) — default-on housekeeping. */
  audit?: (event: ParallelWorkAuditEvent) => void;
}

export interface ParallelWorkAuditEvent {
  kind: 'nudged' | 'deduped-cooldown' | 'deduped-hysteresis';
  pair: OverlapPair;
  atMs: number;
}

/** Emitted to the agent when a fresh overlap is found. The one user-facing signal. */
export interface OverlapNudge {
  pair: OverlapPair;
  atMs: number;
  message: string;
}

interface PairState {
  lastSignature: string;
  lastNudgedMs: number;
}

export interface ParallelWorkSentinelEvents {
  overlap: [nudge: OverlapNudge];
}

/**
 * Runtime instrumentation (CMT-810, Defect 2). Before this the guard-posture
 * inventory graded the sentinel `on-unverified` / `not-instrumented` forever: the
 * config said on, nothing anywhere confirmed a single tick had happened. A guard
 * nobody can verify is indistinguishable from a guard that is off.
 */
export interface ParallelWorkSentinelStats {
  enabled: true;
  constructedAt: number;
  /** Epoch ms of the last COMPLETED tick (0 = never ticked). */
  lastTickAt: number;
  tickCount: number;
  /** Activities seen + nudges fired on the last tick. */
  lastTickActivities: number;
  lastTickNudges: number;
  /** Total nudges emitted since construction. */
  nudgesTotal: number;
  /** Last tick that THREW (0 = never) + its message; the tick re-throws after recording. */
  lastErrorAt: number;
  lastError: string | null;
  trackedPairs: number;
}

export class ParallelWorkSentinel extends EventEmitter {
  private readonly state = new Map<string, PairState>();
  private readonly constructedAt: number;
  private lastTickAt = 0;
  private tickCount = 0;
  private lastTickActivities = 0;
  private lastTickNudges = 0;
  private nudgesTotal = 0;
  private lastErrorAt = 0;
  private lastError: string | null = null;

  constructor(private readonly opts: ParallelWorkSentinelOptions) {
    super();
    this.constructedAt = Date.now();
  }

  /**
   * Run one cadence tick. Pure-ish: side effects are the emitted nudges + the audit
   * sink + the runtime counters. A tick that throws records the error (so /guards
   * and /parallel-work/sentinel can show it) and re-throws for the caller's guard.
   */
  tick(nowMs: number): OverlapNudge[] {
    try {
      const fired = this.runTick(nowMs);
      this.lastTickAt = nowMs;
      this.tickCount++;
      this.lastTickNudges = fired.length;
      this.nudgesTotal += fired.length;
      return fired;
    } catch (err) {
      this.lastErrorAt = nowMs;
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  /**
   * GuardRegistry getter contract: a synchronous in-memory read. `lastTickAt` 0 while
   * enabled reads as `on-stale` in the posture view — registration is not life; only a
   * completed tick confirms the sentinel is genuinely running.
   */
  guardStatus(): { enabled: true; lastTickAt: number } {
    return { enabled: true, lastTickAt: this.lastTickAt };
  }

  /** Full runtime stats (backs GET /parallel-work/sentinel). */
  stats(): ParallelWorkSentinelStats {
    return {
      enabled: true,
      constructedAt: this.constructedAt,
      lastTickAt: this.lastTickAt,
      tickCount: this.tickCount,
      lastTickActivities: this.lastTickActivities,
      lastTickNudges: this.lastTickNudges,
      nudgesTotal: this.nudgesTotal,
      lastErrorAt: this.lastErrorAt,
      lastError: this.lastError,
      trackedPairs: this.state.size,
    };
  }

  private runTick(nowMs: number): OverlapNudge[] {
    const activities = this.opts.getActivities(nowMs);
    this.lastTickActivities = activities.length;
    const pairs = detectOverlaps(activities, {
      nowMs,
      activityWindowMs: this.opts.activityWindowMs,
      minSharedSpecific: this.opts.minSharedSpecific,
      requireRunning: true,
    });
    const cooldown = this.opts.nudgeCooldownMs ?? 60 * 60 * 1000;
    const fired: OverlapNudge[] = [];

    for (const pair of pairs) {
      const key = pairKey(pair.topicA, pair.topicB);
      const prev = this.state.get(key);
      if (prev) {
        const withinCooldown = nowMs - prev.lastNudgedMs < cooldown;
        if (withinCooldown && !signatureChangedMaterially(prev.lastSignature, pair.signature)) {
          this.opts.audit?.({ kind: 'deduped-hysteresis', pair, atMs: nowMs });
          // refresh the stored signature (track drift) but do NOT re-nudge
          this.state.set(key, { lastSignature: pair.signature, lastNudgedMs: prev.lastNudgedMs });
          continue;
        }
        if (withinCooldown && signatureChangedMaterially(prev.lastSignature, pair.signature)) {
          // Material change but still inside the cooldown window: suppress, record drift.
          this.opts.audit?.({ kind: 'deduped-cooldown', pair, atMs: nowMs });
          this.state.set(key, { lastSignature: pair.signature, lastNudgedMs: prev.lastNudgedMs });
          continue;
        }
      }
      // Fresh (never nudged, or past cooldown) → nudge.
      this.state.set(key, { lastSignature: pair.signature, lastNudgedMs: nowMs });
      const nudge: OverlapNudge = {
        pair,
        atMs: nowMs,
        message:
          `Heads up: topics ${pair.topicA} and ${pair.topicB} look like overlapping work ` +
          `(shared: ${pair.sharedTags.join(', ')}). You may be duplicating — worth aligning before you go further.`,
      };
      this.opts.audit?.({ kind: 'nudged', pair, atMs: nowMs });
      this.emit('overlap', nudge);
      fired.push(nudge);
    }
    return fired;
  }

  /** Test/inspection helper: how many pairs are being tracked for dedup. */
  trackedPairCount(): number {
    return this.state.size;
  }
}

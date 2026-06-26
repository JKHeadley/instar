/**
 * TopicReachabilityVerifier — F7 Piece 2 (PURE SIGNAL)
 * (docs/specs/verify-after-reachability.md §Piece 2).
 *
 * After a destructive session/routing mutation (a `sessionReaped(terminal)` or an
 * ownership release/transfer), it verifies the affected topic is still inbound-reachable
 * and SURFACES a genuine orphan as ONE NORMAL-priority attention item. It mutates
 * NOTHING — no clear, spawn, kill, transfer, or re-place. It is a smoke alarm.
 *
 * Honesty guard: the dominant single-machine path already self-heals (the next inbound
 * auto-spawns), so a topic that simply has no session now but WILL spawn on the next
 * message is REACHABLE, not orphaned — the verifier must not scream on every idle kill.
 * Only the specific defeats of the self-heal (stuck-spawn, at-capacity, released-no-
 * placement, stalled inbound-queue) are orphans.
 *
 * This module is the DECISION CORE (deterministic, tick-driven, injected deps). The
 * server wires the triggers (events) + the live `probe` (reads session/placement state)
 * + the attention sink; this class owns grace/coalescing/pressure/suppression/dedup.
 */

export type OrphanReason =
  | 'stuck-spawn'
  | 'at-capacity'
  | 'released-no-placement'
  | 'inbound-queue-stalled'
  | 'partition-suspected';

export type Reachability = { reachable: true } | { reachable: false; reason: OrphanReason };

export interface AttentionSurface {
  /** A single attention item (NORMAL priority, stable sourceContext, deduped by key). */
  key: string;
  topics: number[];
  reason: string;
  rolledUp: boolean;
}

export interface VerifierDeps {
  /** Live reachability classification for a topic (reads local session/placement state). */
  probe: (topic: number) => Reachability;
  /** Raise one NORMAL attention item. */
  surface: (item: AttentionSurface) => void;
  /** True ⇒ skip per-topic verify churn (mass-reap is the pressure; don't amplify). */
  pressureCritical: () => boolean;
  /** True ⇒ an operator emergency-stop / halt is active; suppress surfacing. */
  emergencyStopActive: () => boolean;
  now: () => number;
  /** Verify delay after a mutation (default 30s; > normal respawn so a healthy bounce isn't flagged). */
  graceMs?: number;
  /** Orphan count in a flush past which a single rolled-up item is emitted (default 10). */
  burstThreshold?: number;
  /** Per-topic minimum re-surface interval, exponential floor (default 1h). */
  resurfaceFloorMs?: number;
  /** Hard cap on pending verifies (overflow counted). */
  maxPendingVerifies?: number;
}

interface DedupState {
  /** Last time we surfaced this topic (for the backoff). */
  lastSurfacedMs: number;
  /** Consecutive surfaces (drives the exponential backoff). */
  surfaceCount: number;
  /** True once a verified-REACHABLE observation re-armed the topic. */
  armed: boolean;
}

const DEFAULT_GRACE_MS = 30_000;
const DEFAULT_BURST = 10;
const DEFAULT_RESURFACE_FLOOR_MS = 3_600_000;
const DEFAULT_MAX_PENDING = 500;

export class TopicReachabilityVerifier {
  private readonly d: Required<Omit<VerifierDeps, 'probe' | 'surface' | 'pressureCritical' | 'emergencyStopActive' | 'now'>> &
    Pick<VerifierDeps, 'probe' | 'surface' | 'pressureCritical' | 'emergencyStopActive' | 'now'>;
  /** topic → earliest time the verify is due (now + grace at record time). Coalesced. */
  private readonly pending = new Map<number, number>();
  /** Topics whose verify was SKIPPED under pressure / SUPPRESSED under halt — re-swept on clear. */
  private readonly deferredWindow = new Set<number>();
  private readonly dedup = new Map<number, DedupState>();
  private _overflow = 0;
  private _orphansSurfaced = 0;
  private _verifiedReachable = 0;
  private _lastTickAt = 0;

  constructor(deps: VerifierDeps) {
    this.d = {
      ...deps,
      graceMs: deps.graceMs ?? DEFAULT_GRACE_MS,
      burstThreshold: deps.burstThreshold ?? DEFAULT_BURST,
      resurfaceFloorMs: deps.resurfaceFloorMs ?? DEFAULT_RESURFACE_FLOOR_MS,
      maxPendingVerifies: deps.maxPendingVerifies ?? DEFAULT_MAX_PENDING,
    };
  }

  /** A destructive mutation hit `topic` — schedule a coalesced post-grace verify. */
  recordMutation(topic: number): void {
    const due = this.d.now() + this.d.graceMs;
    if (!this.pending.has(topic)) {
      if (this.pending.size >= this.d.maxPendingVerifies) {
        this._overflow++;
        return;
      }
      this.pending.set(topic, due);
    }
    // coalesced: an existing pending verify keeps its (earlier) due time.
  }

  /**
   * Process verifies whose grace has elapsed. Pure-signal: classifies + surfaces.
   * Returns a report (for the status route + tests).
   */
  tick(): { surfaced: number; reachable: number; skipped: number; overflow: number; pending: number } {
    const now = this.d.now();
    this._lastTickAt = now;
    const due: number[] = [];
    for (const [topic, dueAt] of this.pending) {
      if (dueAt <= now) due.push(topic);
    }

    const halt = this.d.emergencyStopActive();
    const pressure = this.d.pressureCritical();
    let skipped = 0;
    const orphans: Array<{ topic: number; reason: OrphanReason }> = [];

    for (const topic of due) {
      this.pending.delete(topic);
      // Under halt or critical pressure we do NOT churn per-topic — defer to re-sweep.
      if (halt || pressure) {
        this.deferredWindow.add(topic);
        skipped++;
        continue;
      }
      const r = this.d.probe(topic);
      if (r.reachable) {
        this._verifiedReachable++;
        this.markReachable(topic); // re-arm dedup
      } else {
        orphans.push({ topic, reason: r.reason });
      }
    }

    // A window just cleared (no halt + no pressure) → re-sweep deferred topics once.
    if (!halt && !pressure && this.deferredWindow.size > 0) {
      for (const topic of [...this.deferredWindow]) {
        this.deferredWindow.delete(topic);
        const r = this.d.probe(topic);
        if (r.reachable) {
          this._verifiedReachable++;
          this.markReachable(topic);
        } else {
          orphans.push({ topic, reason: r.reason });
        }
      }
    }

    const surfaced = this.surfaceOrphans(orphans, now, pressure);
    return { surfaced, reachable: this._verifiedReachable, skipped, overflow: this._overflow, pending: this.pending.size };
  }

  private surfaceOrphans(
    orphans: Array<{ topic: number; reason: OrphanReason }>,
    now: number,
    pressure: boolean,
  ): number {
    if (orphans.length === 0) return 0;
    // Burst roll-up: a mass-orphan (or partition) → ONE rolled-up item, never N.
    if (orphans.length >= this.d.burstThreshold || pressure) {
      const topics = orphans.map((o) => o.topic);
      this.d.surface({
        key: 'topic-reachability:burst',
        topics,
        reason: `${topics.length} topics may be unreachable`,
        rolledUp: true,
      });
      for (const o of orphans) this.bumpDedup(o.topic, now);
      this._orphansSurfaced += 1;
      return 1;
    }
    // Per-topic with backoff (a single flapper cannot mint per cycle).
    let count = 0;
    for (const o of orphans) {
      if (this.shouldSurface(o.topic, now)) {
        this.d.surface({
          key: `topic-reachability:${o.topic}`,
          topics: [o.topic],
          reason: `topic ${o.topic} may be unreachable (${o.reason})`,
          rolledUp: false,
        });
        this.bumpDedup(o.topic, now);
        this._orphansSurfaced++;
        count++;
      }
    }
    return count;
  }

  /** Backoff gate: re-surface only past an exponentially-widening floor, regardless of re-arm. */
  private shouldSurface(topic: number, now: number): boolean {
    const s = this.dedup.get(topic);
    if (!s || s.armed) return true; // first time, or re-armed by a verified-reachable obs
    const wait = this.d.resurfaceFloorMs * Math.pow(2, Math.max(0, s.surfaceCount - 1));
    return now - s.lastSurfacedMs >= wait;
  }

  private bumpDedup(topic: number, now: number): void {
    const s = this.dedup.get(topic) ?? { lastSurfacedMs: 0, surfaceCount: 0, armed: true };
    s.lastSurfacedMs = now;
    s.surfaceCount = s.armed ? 1 : s.surfaceCount + 1;
    s.armed = false;
    this.dedup.set(topic, s);
  }

  private markReachable(topic: number): void {
    const s = this.dedup.get(topic);
    if (s) {
      s.armed = true; // a genuine re-orphan after heal may surface again (not suppressed forever)
      s.surfaceCount = 0;
    }
  }

  status(): { pending: number; deferred: number; orphansSurfaced: number; verifiedReachable: number; overflow: number; lastTickAt: number } {
    return {
      pending: this.pending.size,
      deferred: this.deferredWindow.size,
      orphansSurfaced: this._orphansSurfaced,
      verifiedReachable: this._verifiedReachable,
      overflow: this._overflow,
      lastTickAt: this._lastTickAt,
    };
  }
}

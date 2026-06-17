/**
 * AutonomousProgressHeartbeat — a hedged, change-gated, sparse liveness BACKSTOP
 * for an autonomous run that has gone silent on the user for a long stretch
 * while its terminal output is STILL changing.
 *
 * Spec: docs/specs/autonomous-progress-heartbeat.md (ELI16: .eli16.md).
 *
 * The incident this closes (2026-06-16, topic 12476): during a 24h autonomous
 * run the agent finished a milestone, said "PR is armed", then went heads-down
 * for ~an hour fixing CI — real work the whole time, but emitted ZERO
 * user-facing message. An hour of silence is indistinguishable from a stall.
 *
 * This is NOT the suppressed PromiseBeacon §B1 "still on it, no new output"
 * filler (HONEST-PROGRESS-MESSAGING removed that). It is a structurally higher
 * bar: it fires ONLY on a LONG user-silence gate (≥25m) AND a corroborated
 * recent output change (read from ActiveWorkSilenceSentinel's already-computed
 * `lastOutputAt` snapshot — predicate #8 captures NOTHING of its own), with
 * purely-observational wording, a per-topic cooldown, a widening per-run backoff
 * + hard cap, and the shared one-voice ProxyCoordinator lease.
 *
 * Signal-only: it emits a liveness message and never gates, blocks, delays, or
 * rewrites anything. Every predicate fails CLOSED (no emit) on any uncertainty.
 */

import { EventEmitter } from 'node:events';
import type { ProxyCoordinator } from './ProxyCoordinator.js';
import { scrubFocus } from './autonomousHeartbeatScrub.js';

// ─── Config & types ─────────────────────────────────────────────────────────

export interface AutonomousHeartbeatConfig {
  /** Master switch (resolved by the dev-gate at construction; absent → off). */
  enabled?: boolean;
  /** dryRun: log the intended heartbeat instead of sending. Default true. */
  dryRun?: boolean;
  /** User-silence gate, in minutes. Default 25, floor-clamped to ~5. */
  silenceThresholdMinutes?: number;
  /** Tick cadence, ms. Default 60_000, floor-clamped to ~30_000. */
  tickIntervalMs?: number;
  /** Hard per-run heartbeat cap. Default 6. */
  maxHeartbeatsPerRun?: number;
  /** How recently the shared snapshot's lastOutputAt must have advanced. Default 5m. */
  recentOutputChangeWindowMs?: number;
}

/** A topic with a live autonomous run, surfaced for the per-topic predicate. */
export interface ActiveAutonomousRun {
  topicId: number;
  /** The tmux session bound to the topic (for #4 alive + #8 snapshot lookup). */
  sessionName: string | null;
  /** Seconds remaining on the run window (from autonomousRunRemainingForTopic). */
  remainingSeconds: number;
}

/** Run-state markers (predicate #2 mid-move + #3 warmup). */
export interface RunMarkers {
  movedTo: string | null;
  moveSuspended: boolean;
  startedAtMs: number | null;
}

/** A single outbound-history entry (predicate #5 silence-clock). */
export interface OutboundHistoryEntry {
  /** true = inbound user message; false = an outbound (agent/proxy/system) send. */
  fromUser: boolean;
  /** epoch ms of the entry. */
  at: number;
}

export interface AutonomousHeartbeatDeps {
  /** Cheap, in-memory: topics with a live autonomous run (predicate #1). */
  listActiveAutonomousRuns: () => ActiveAutonomousRun[];
  /** Read the run-state markers for #2 (mid-move) + #3 (warmup). Null fails closed. */
  getRunMarkers: (topicId: number) => RunMarkers | null;
  /** Predicate #4: is the bound session alive? */
  isSessionAlive: (sessionName: string) => boolean;
  /** Predicate #5: the topic's recent outbound history (most-recent first or any order). */
  getTopicHistory: (topicId: number) => OutboundHistoryEntry[];
  /**
   * Predicate #8: ActiveWorkSilenceSentinel's ALREADY-COMPUTED lastOutputAt for
   * a session (the shared OutputActivityTracker snapshot — NOT a capture). Return
   * the lastOutputAt epoch ms, or null/undefined when the snapshot is unavailable
   * or the session is absent (fails CLOSED — never an own capture).
   */
  getSharedLastOutputAt: (sessionName: string) => number | null | undefined;
  /**
   * The matching topic's one-line `focus` from ParallelActivityIndex.activities().
   * Indexed by topic ONCE per tick by the caller. Null when unavailable.
   */
  getFocusForTopic: (topicId: number) => string | null;
  /** Predicate #9: the shared one-voice lease. */
  proxyCoordinator: ProxyCoordinator;
  /** The SAME canonical funnel PromiseBeacon uses (POST /telegram/reply/:topicId). */
  sendMessage: (
    topicId: number,
    text: string,
    metadata: { source: 'autonomous-heartbeat'; isProxy: true; tier: number },
  ) => Promise<void>;
  /** Override Date.now for tests. */
  now?: () => number;
  /** Override timer setters for tests. */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

/** A ring-buffer record of an emit (or dry-run would-emit / suppression). */
export interface HeartbeatEmit {
  topicId: number;
  at: number;
  minutesSilent: number;
  /** The ALREADY-SCRUBBED focus (never raw attacker content), or null when generic. */
  focus: string | null;
  dryRun: boolean;
  /** Set when this record is a SUPPRESSION (no emit) rather than an emit. */
  suppressedReason?: string;
}

const DEFAULTS = {
  silenceThresholdMinutes: 25,
  silenceThresholdFloorMinutes: 5,
  tickIntervalMs: 60_000,
  tickIntervalFloorMs: 30_000,
  maxHeartbeatsPerRun: 6,
  recentOutputChangeWindowMs: 5 * 60_000,
};

/** Widening per-run backoff (minutes). Floor = silenceThresholdMinutes; the
 *  ladder widens 25→40→60→90 (then holds at the last value, capped by the
 *  per-run budget). */
const BACKOFF_LADDER_MINUTES = [25, 40, 60, 90];

/** Per-run in-memory throttle state (keyed by topic + run identity). */
interface RunState {
  /** Identity of the run this state belongs to (startedAtMs); reset on a new run. */
  runStartedAtMs: number | null;
  /** Last heartbeat emit (or dry-run would-emit) wall-clock for this topic. */
  lastHeartbeatAt: number;
  /** Count of heartbeats emitted (or would-be in dryRun) for THIS run. */
  count: number;
}

export class AutonomousProgressHeartbeat extends EventEmitter {
  private readonly cfg: {
    enabled: boolean;
    dryRun: boolean;
    silenceThresholdMs: number;
    tickIntervalMs: number;
    maxHeartbeatsPerRun: number;
    recentOutputChangeWindowMs: number;
  };
  private readonly runState = new Map<number, RunState>();
  private readonly lastEmits: HeartbeatEmit[] = [];
  private static readonly LAST_EMITS_CAP = 50;

  private tickHandle: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private lastTickAt = 0;
  private topicsConsidered = 0;

  constructor(private readonly deps: AutonomousHeartbeatDeps, raw: AutonomousHeartbeatConfig = {}) {
    super();
    const silenceMin = Math.max(
      DEFAULTS.silenceThresholdFloorMinutes,
      raw.silenceThresholdMinutes ?? DEFAULTS.silenceThresholdMinutes,
    );
    const tickMs = Math.max(
      DEFAULTS.tickIntervalFloorMs,
      raw.tickIntervalMs ?? DEFAULTS.tickIntervalMs,
    );
    this.cfg = {
      enabled: raw.enabled === true,
      // default true: dryRun unless explicitly false (the graduated-rollout ladder).
      dryRun: raw.dryRun !== false,
      silenceThresholdMs: silenceMin * 60_000,
      tickIntervalMs: tickMs,
      maxHeartbeatsPerRun: raw.maxHeartbeatsPerRun ?? DEFAULTS.maxHeartbeatsPerRun,
      recentOutputChangeWindowMs: raw.recentOutputChangeWindowMs ?? DEFAULTS.recentOutputChangeWindowMs,
    };
  }

  start(): void {
    if (!this.cfg.enabled || this.tickHandle) return;
    this.tickHandle = setInterval(() => {
      this.tick().catch((err) => {
        // Observability never endangers the observed; never throw out of the tick.
        this.emit('tick-error', err);
      });
    }, this.cfg.tickIntervalMs);
    if (typeof this.tickHandle.unref === 'function') this.tickHandle.unref();
  }

  stop(): void {
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
    this.runState.clear();
  }

  /** Read-only status for GET /autonomous-heartbeat. */
  status(): {
    enabled: boolean;
    dryRun: boolean;
    silenceThresholdMinutes: number;
    lastTickAt: number;
    topicsConsidered: number;
    lastEmits: HeartbeatEmit[];
  } {
    return {
      enabled: this.cfg.enabled,
      dryRun: this.cfg.dryRun,
      silenceThresholdMinutes: Math.round(this.cfg.silenceThresholdMs / 60_000),
      lastTickAt: this.lastTickAt,
      topicsConsidered: this.topicsConsidered,
      lastEmits: [...this.lastEmits],
    };
  }

  /** Guard-posture surface (GET /guards). Cheap property read — no I/O. */
  guardStatus(): { enabled: boolean; lastTickAt: number } {
    return { enabled: this.cfg.enabled, lastTickAt: this.lastTickAt };
  }

  /**
   * One tick. Re-entrancy-guarded (the emit step is awaited and a send can
   * block). Evaluates the per-topic predicate cheap-first; the ProxyCoordinator
   * lease is acquired/released in a try/finally within THIS tick.
   *
   * Public for tests.
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    this.lastTickAt = (this.deps.now ?? Date.now)();
    try {
      const now = (this.deps.now ?? Date.now)();
      const runs = this.deps.listActiveAutonomousRuns();
      this.topicsConsidered = runs.length;
      // Prune run-state for topics no longer active so the map can't leak.
      const activeTopicIds = new Set(runs.map((r) => r.topicId));
      for (const t of [...this.runState.keys()]) {
        if (!activeTopicIds.has(t)) this.runState.delete(t);
      }
      for (const run of runs) {
        await this.evaluateTopic(run, now);
      }
    } finally {
      this.ticking = false;
    }
  }

  /**
   * The per-topic predicate, evaluated strictly cheapest-first, short-circuiting
   * on the first failure. Predicate #1 (run active) is implied by `run` being in
   * the active set. Every predicate is an in-memory read.
   */
  private async evaluateTopic(run: ActiveAutonomousRun, now: number): Promise<void> {
    const topicId = run.topicId;

    // #2 Not mid-handoff + #3 destination warmup elapsed (markers fail closed).
    const markers = this.deps.getRunMarkers(topicId);
    if (!markers) {
      this.recordSuppressed(topicId, now, 'run-markers-unreadable');
      return;
    }
    if (markers.movedTo || markers.moveSuspended) {
      this.recordSuppressed(topicId, now, 'mid-move-marker');
      return;
    }
    // #3 warmup: the run must have been active on THIS machine ≥ one full window.
    if (markers.startedAtMs == null || now - markers.startedAtMs < this.cfg.silenceThresholdMs) {
      this.recordSuppressed(topicId, now, 'warmup-not-elapsed');
      return;
    }

    // #4 Session alive.
    if (!run.sessionName || !this.deps.isSessionAlive(run.sessionName)) {
      this.recordSuppressed(topicId, now, 'session-not-alive');
      return;
    }

    // #5 Silent-to-user ≥ threshold (minutes since most-recent fromUser===false).
    const lastOutboundAt = this.mostRecentOutboundAt(topicId);
    if (lastOutboundAt != null && now - lastOutboundAt < this.cfg.silenceThresholdMs) {
      this.recordSuppressed(topicId, now, 'spoke-recently');
      return;
    }
    const silenceAnchor = lastOutboundAt ?? markers.startedAtMs;
    const minutesSilent = Math.max(1, Math.round((now - silenceAnchor) / 60_000));

    // #6 Per-topic emit-cooldown elapsed (LOCAL map). A new run resets state.
    const state = this.ensureRunState(topicId, markers.startedAtMs);
    const cooldownMs = this.currentBackoffMs(state.count);
    if (state.lastHeartbeatAt > 0 && now - state.lastHeartbeatAt < cooldownMs) {
      this.recordSuppressed(topicId, now, 'cooldown-not-elapsed');
      return;
    }

    // #7 Per-run heartbeat budget not exhausted.
    if (state.count >= this.cfg.maxHeartbeatsPerRun) {
      this.recordSuppressed(topicId, now, 'budget-exhausted');
      return;
    }

    // #8 Recent output change — from the SHARED snapshot (no own capture).
    const lastOutputAt = this.deps.getSharedLastOutputAt(run.sessionName);
    if (lastOutputAt == null || lastOutputAt <= 0) {
      // Snapshot unavailable / lastOutputAt absent → fail CLOSED, never capture.
      this.recordSuppressed(topicId, now, 'shared-snapshot-unavailable');
      return;
    }
    if (now - lastOutputAt > this.cfg.recentOutputChangeWindowMs) {
      // Output has NOT advanced recently (e.g. frozen spinner) → suppress.
      this.recordSuppressed(topicId, now, 'no-recent-output-change');
      return;
    }

    // #9 One-voice free: acquire the shared lease; release UNCONDITIONALLY here.
    if (!this.deps.proxyCoordinator.tryAcquire(topicId, 'autonomous-heartbeat')) {
      this.recordSuppressed(topicId, now, 'lease-held');
      return;
    }
    try {
      const rawFocus = this.deps.getFocusForTopic(topicId);
      const scrub = scrubFocus(rawFocus);
      const text = this.buildMessage(scrub.focus);

      if (this.cfg.dryRun) {
        // dryRun gates on the SAME cooldown/budget as live (it only swaps the
        // final send for a log). Advance state so the next tick doesn't re-log.
        state.lastHeartbeatAt = now;
        state.count += 1;
        this.recordEmit({ topicId, at: now, minutesSilent, focus: scrub.focus, dryRun: true });
        this.emit('would-emit', { topicId, minutesSilent, focus: scrub.focus });
        return;
      }

      try {
        await this.deps.sendMessage(topicId, text, {
          source: 'autonomous-heartbeat',
          isProxy: true,
          tier: 1,
        });
        state.lastHeartbeatAt = now;
        state.count += 1;
        this.recordEmit({ topicId, at: now, minutesSilent, focus: scrub.focus, dryRun: false });
        this.emit('emitted', { topicId, minutesSilent, focus: scrub.focus });
      } catch (err) {
        // @silent-fallback-ok: NOT silent — a failed heartbeat send is surfaced via
        // recordSuppressed('send-failed') + the 'send-error' event. We deliberately do
        // NOT advance cooldown/count (a missed heartbeat is the safe status quo; the
        // next tick retries). The lease still releases in finally.
        this.recordSuppressed(topicId, now, 'send-failed');
        this.emit('send-error', { topicId, err });
      }
    } finally {
      this.deps.proxyCoordinator.release(topicId, 'autonomous-heartbeat');
    }
  }

  /**
   * The purely-observational, untrusted-framed line. NEVER an assertive "still
   * working"/"still going" claim. `focus` is already scrubbed + HTML-escaped;
   * null → the generic fallback.
   */
  buildMessage(focus: string | null): string {
    if (focus) {
      return `I haven't posted here in a while — last observed activity was «${focus}». Message me if you need me.`;
    }
    return `I haven't posted here in a while on this autonomous run. Message me if you need me.`;
  }

  // ─── Internals ──────────────────────────────────────────────────────────────

  /** Most-recent outbound (fromUser===false) entry time, or null when none. */
  private mostRecentOutboundAt(topicId: number): number | null {
    let history: OutboundHistoryEntry[];
    try {
      history = this.deps.getTopicHistory(topicId) ?? [];
    } catch {
      // @silent-fallback-ok: this is fail-CLOSED, not a degraded fallback — when history
      // can't be read we treat the topic as "spoke just now" (MAX_SAFE_INTEGER sentinel)
      // so the silence gate CANNOT fire on missing evidence. Suppressing a heartbeat on
      // an unreadable read is the safe direction; reporting degradation here would be
      // noise on the common transient-read case.
      return Number.MAX_SAFE_INTEGER;
    }
    let latest: number | null = null;
    for (const e of history) {
      if (e.fromUser === false && typeof e.at === 'number') {
        if (latest === null || e.at > latest) latest = e.at;
      }
    }
    return latest;
  }

  private ensureRunState(topicId: number, runStartedAtMs: number | null): RunState {
    const existing = this.runState.get(topicId);
    if (existing && existing.runStartedAtMs === runStartedAtMs) return existing;
    // New run (or first sighting) → fresh throttle state.
    const fresh: RunState = { runStartedAtMs, lastHeartbeatAt: 0, count: 0 };
    this.runState.set(topicId, fresh);
    return fresh;
  }

  /**
   * The cooldown (ms) that must elapse before the NEXT heartbeat, given how many
   * have already fired on this run (`count`). The gap WIDENS with each heartbeat:
   * the 1st→2nd gap is ladder[0] (25m), the 2nd→3rd gap is ladder[1] (40m), …
   * (then holds at the last ladder value). So the index is `count-1` (the number
   * of gaps already opened). Floored at silenceThresholdMinutes — the ladder
   * never goes below the user-silence gate.
   */
  private currentBackoffMs(count: number): number {
    const gapIdx = Math.min(Math.max(count - 1, 0), BACKOFF_LADDER_MINUTES.length - 1);
    const ladderMin = BACKOFF_LADDER_MINUTES[gapIdx];
    const floorMin = this.cfg.silenceThresholdMs / 60_000;
    return Math.max(ladderMin, floorMin) * 60_000;
  }

  private recordEmit(e: HeartbeatEmit): void {
    this.lastEmits.push(e);
    if (this.lastEmits.length > AutonomousProgressHeartbeat.LAST_EMITS_CAP) {
      this.lastEmits.splice(0, this.lastEmits.length - AutonomousProgressHeartbeat.LAST_EMITS_CAP);
    }
  }

  private recordSuppressed(topicId: number, at: number, reason: string): void {
    this.emit('suppressed', { topicId, reason });
  }
}

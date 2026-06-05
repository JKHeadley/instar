/**
 * StaleSessionBackstop — the unkillability backstop (UNIFIED-SESSION-LIFECYCLE §P5).
 *
 * Rules 1–2 of the robustness bar are deliberately conservative ("can't tell"
 * never means "dead"). That creates a dual risk the round-1 review surfaced:
 *   (a) a session that FAKES work (a tight CPU loop, or a transcript that appends
 *       a heartbeat byte every few minutes) is KEPT by every killer forever;
 *   (b) a session stuck `indeterminate` forever leaks a slot.
 * Both are resolved by a single staleness escalation — NEVER an auto-kill. After
 * M minutes of no-forward-progress, or N consecutive `indeterminate` probes, ONE
 * deduped Attention-queue item is raised for an operator decision
 * (investigate / force-kill?). Dedupe is per EPISODE (a recovered session that
 * later goes stale again raises a fresh item).
 *
 * Forward progress is NOT raw byte growth — a wedged session that appends a
 * heartbeat byte would defeat a naive "any growth" gate forever (exactly the
 * absence-of-signal inference rule 2 forbids). "Progress" = ANY of:
 *   (i)   a MEANINGFUL transcript advance: delta ≥ progressFloorBytes AND the new
 *         tail differs from the prior tail (guards the heartbeat/loop case),
 *   (ii)  main-process CPU above an idle floor,
 *   (iii) a change in the positive-idle / prompt state.
 *
 * A server-unreachable `indeterminate` raises ONE GLOBAL "tmux control-plane
 * unreachable" item (not one per session) — anti-flood. Long-`indeterminate`
 * sessions are flagged so the spawn-path can exclude them from the ABSOLUTE
 * session cap, so a fleet of unverifiable panes can never lock a human out of
 * spawning (the death-spiral cannot relocate here).
 *
 * Signal-only: this backstop never ends a session. It only observes and asks.
 */

import type { Session } from '../core/types.js';
import type { AttentionPoster } from './sentinelWiring.js';

export type Liveness = 'alive' | 'dead' | 'indeterminate';

/** A per-tick forward-progress probe for one session. */
export interface ProgressSnapshot {
  /** Whether the transcript path resolved + statted (false ⇒ ambiguous). */
  transcriptResolved: boolean;
  /** Transcript size in bytes (0 when unresolved). */
  transcriptSize: number;
  /** Hash of the last `progressFloorBytes` of the transcript (null when unresolved/short). */
  transcriptTailHash: string | null;
  /** Main-process CPU/IO above an idle floor. `undefined` ⇒ uninspectable. */
  mainProcessActive: boolean | undefined;
  /** Opaque token for the positive-idle / prompt state — ANY change ⇒ progress. */
  idleStateToken: string;
  /** Accumulated CPU-seconds of non-baseline descendant processes. Compared as a
   *  DELTA across snapshots — real CPU used in the interval. For JOB sessions this
   *  replaces the existence-based `mainProcessActive` progress test, so a
   *  wedged-but-alive job (process up, 0% CPU) reads as no-progress. Default 0. */
  descendantCpuSeconds: number;
  /** True when this session was spawned by a job (`Session.jobSlug` set). A job
   *  has no legitimate-idle state (it runs to completion), so it is held to the
   *  stricter cpu-seconds-delta progress test; conversational sessions keep the
   *  existence-based test (which correctly exempts idle-with-bg-process). */
  isJobSession: boolean;
}

export interface LivenessBatch {
  /** False ⇒ the tmux control plane is unreachable (no authoritative snapshot). */
  reachable: boolean;
  /** Per-session tri-state liveness keyed by tmux session name. */
  liveness: Map<string, Liveness>;
}

export interface StaleBackstopDeps {
  listRunningSessions: () => Session[];
  /** ONE batch probe per tick (mirrors the boot-purge single-snapshot path). */
  probeLiveness: (tmuxSessions: string[]) => Promise<LivenessBatch> | LivenessBatch;
  snapshot: (session: Session) => ProgressSnapshot;
  raiseAttention: AttentionPoster;
  /** Flag/unflag a session as long-`indeterminate` for the spawn absolute-cap exclusion. */
  setLongIndeterminate?: (sessionId: string, isLong: boolean) => void;
  /**
   * Resolve a session to its HUMAN Telegram topic name (e.g. "EXO 3.0") so the
   * heads-up reads with the topic name, never a bare `topic-<n>`. Returns null
   * when no friendly name is known (the notice falls back to the session name).
   */
  resolveTopicName?: (session: Session) => string | null;
  now?: () => number;
}

export interface StaleBackstopOptions {
  enabled: boolean;
  tickIntervalSec: number;
  unverifiableEscalateMinutes: number;
  indeterminateEscalateCount: number;
  progressFloorBytes: number;
  /** Minimum CPU-seconds a JOB session's descendants must accumulate between two
   *  snapshots to count as forward progress. Below this, a job with a live but
   *  idle (0% CPU) process is treated as making no progress. Small to catch a
   *  genuinely-wedged job while ignoring sampling jitter. */
  cpuFloorSeconds: number;
}

export const DEFAULT_STALE_BACKSTOP_OPTIONS: StaleBackstopOptions = {
  enabled: true,
  tickIntervalSec: 120,
  unverifiableEscalateMinutes: 30,
  indeterminateEscalateCount: 15,
  progressFloorBytes: 512,
  cpuFloorSeconds: 1,
};

interface Obs {
  lastSnapshot: ProgressSnapshot | null;
  lastProgressAt: number;
  indeterminateStreak: number;
  episodeActive: boolean;
  episodeSeq: number;
}

export class StaleSessionBackstop {
  private readonly deps: StaleBackstopDeps;
  private readonly opts: StaleBackstopOptions;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private obs = new Map<string, Obs>();
  private globalUnreachable = false;
  private globalUnreachableSeq = 0;

  constructor(deps: StaleBackstopDeps, opts?: Partial<StaleBackstopOptions>) {
    this.deps = deps;
    this.opts = { ...DEFAULT_STALE_BACKSTOP_OPTIONS, ...(opts ?? {}) };
    this.now = deps.now ?? (() => Date.now());
  }

  start(): void {
    if (this.timer || !this.opts.enabled) return;
    this.timer = setInterval(() => { void this.tick(); }, this.opts.tickIntervalSec * 1000);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private obsFor(id: string): Obs {
    let o = this.obs.get(id);
    if (!o) {
      o = { lastSnapshot: null, lastProgressAt: this.now(), indeterminateStreak: 0, episodeActive: false, episodeSeq: 0 };
      this.obs.set(id, o);
    }
    return o;
  }

  /** Run one observation pass. Public so the lifecycle (and tests) can drive it. */
  async tick(): Promise<void> {
    if (!this.opts.enabled) return;

    const running = this.deps.listRunningSessions();
    const batch = await this.deps.probeLiveness(running.map((s) => s.tmuxSession));

    // Control-plane unreachable: ONE global item, never per-session (anti-flood).
    if (!batch.reachable) {
      if (!this.globalUnreachable) {
        this.globalUnreachable = true;
        this.globalUnreachableSeq++;
        await this.deps.raiseAttention({
          id: `stale-tmux-unreachable-${this.globalUnreachableSeq}`,
          title: 'tmux control plane unreachable',
          summary:
            'The tmux server is not answering, so no session can be verified alive or dead. '
            + 'Sessions are being KEPT (never auto-killed on doubt). Investigate the tmux server / host.',
          category: 'degradation',
          priority: 'HIGH',
        });
      }
      return; // do not advance per-session episodes while blind
    }
    this.globalUnreachable = false;

    const liveIds = new Set(running.map((s) => s.id));
    for (const session of running) {
      const v = batch.liveness.get(session.tmuxSession) ?? 'indeterminate';
      const o = this.obsFor(session.id);

      if (v === 'dead') {
        // A dead session is the reapers' business; clear our state for it.
        this.clear(session.id);
        continue;
      }

      if (v === 'indeterminate') {
        o.indeterminateStreak++;
        const isLong = o.indeterminateStreak >= this.opts.indeterminateEscalateCount;
        this.deps.setLongIndeterminate?.(session.id, isLong);
        if (isLong && !o.episodeActive) {
          o.episodeActive = true;
          o.episodeSeq++;
          await this.escalateSession(session, o, `unverifiable: ${o.indeterminateStreak} consecutive indeterminate probes`);
        }
        continue;
      }

      // v === 'alive' — verifiable again.
      o.indeterminateStreak = 0;
      this.deps.setLongIndeterminate?.(session.id, false);
      const cur = this.deps.snapshot(session);
      const prev = o.lastSnapshot;
      o.lastSnapshot = cur;
      if (!prev) {
        // First sighting — establish the baseline, treat as progress.
        o.lastProgressAt = this.now();
        continue;
      }
      if (this.hasForwardProgress(prev, cur)) {
        o.lastProgressAt = this.now();
        o.episodeActive = false; // recovered — a future stall is a new episode
        continue;
      }
      const stalledMs = this.now() - o.lastProgressAt;
      if (stalledMs >= this.opts.unverifiableEscalateMinutes * 60_000 && !o.episodeActive) {
        o.episodeActive = true;
        o.episodeSeq++;
        await this.escalateSession(
          session, o,
          `no forward progress for ${Math.round(stalledMs / 60_000)} min (transcript static + no CPU + no prompt change) — may be faking work`,
        );
      }
    }

    // Drop obs for sessions that are gone.
    for (const id of [...this.obs.keys()]) {
      if (!liveIds.has(id)) this.clear(id);
    }
  }

  private hasForwardProgress(prev: ProgressSnapshot, cur: ProgressSnapshot): boolean {
    // (i) Meaningful transcript advance — guards the heartbeat/loop case.
    if (
      prev.transcriptResolved && cur.transcriptResolved &&
      cur.transcriptSize - prev.transcriptSize >= this.opts.progressFloorBytes &&
      cur.transcriptTailHash != null && cur.transcriptTailHash !== prev.transcriptTailHash
    ) {
      return true;
    }
    // (ii) Real work by the main process.
    //      For JOB sessions (which have no legitimate-idle state — a job runs to
    //      completion) require actual CPU USED in the interval: the cpu-seconds
    //      delta past a small floor. A wedged-but-alive job (process up, 0% CPU)
    //      reads as no-progress here, where the old existence-based check
    //      false-positived it as "active" (the 12h-undetected codex-job wedge).
    //      Conversational sessions keep the existence-based check, which correctly
    //      exempts a legitimately-idle session that happens to have a background
    //      process. `undefined` (uninspectable) is never progress.
    if (cur.isJobSession) {
      if (cur.descendantCpuSeconds - prev.descendantCpuSeconds > this.opts.cpuFloorSeconds) return true;
    } else if (cur.mainProcessActive === true) {
      return true;
    }
    // (iii) Positive-idle / prompt state changed.
    if (cur.idleStateToken !== prev.idleStateToken) return true;
    return false;
  }

  private async escalateSession(session: Session, o: Obs, detail: string): Promise<void> {
    // Resolve a friendly topic name so the heads-up reads "the 'EXO 3.0' session",
    // never "topic-19077". Fall back to the session name only if it isn't the
    // useless topic-<n> form.
    const resolved = this.deps.resolveTopicName?.(session) ?? null;
    const display = (resolved && !/^topic-\d+$/.test(resolved))
      ? resolved
      : (!/^topic-\d+$/.test(session.name) ? session.name : (resolved ?? session.name));
    // Route into the calm Agent-Health lane at NORMAL priority. This is a routine
    // self-health observation, not a user-critical alert — so it bundles into the
    // ONE "🩺 Agent Health" topic and never spawns topic-after-topic. The store
    // `id` still carries the episode seq (each episode is recorded), while
    // `healthKey` is stable per session so the lane suppresses duplicate re-posts.
    await this.deps.raiseAttention({
      id: `stale-${session.id}-${o.episodeSeq}`,
      healthKey: `stale-${session.id}`,
      lane: 'agent-health',
      title: `Heads-up on the "${display}" session`,
      summary:
        `It hasn't shown visible progress in a while (${detail}), so it might be stuck — but it's still `
        + `running and nothing's been killed. Reply "check ${display}" and I'll look, or ignore this if you know it's fine.`,
      category: 'degradation',
      priority: 'NORMAL',
    });
  }

  private clear(id: string): void {
    if (this.obs.delete(id)) this.deps.setLongIndeterminate?.(id, false);
  }
}

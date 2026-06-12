/**
 * ActiveWorkSilenceSentinel — detects sessions in the registry that were
 * actively producing output and then went silent for an extended period,
 * independent of topic binding.
 *
 * Closes the watchdog gap surfaced 2026-05-22: a gsd-style sub-spawned
 * worktree session went silent for 1h16m and three existing watchdogs all
 * missed it:
 *   - SessionWatchdog requires a long-running child (this had none).
 *   - SessionMonitor only inspects topic-bound sessions (this wasn't).
 *   - PresenceProxy wakes on inbound user messages (none arrived).
 *
 * This sentinel sits one layer below those: it walks the SessionRegistry
 * directly, looking for "had output recently, now hasn't for N minutes."
 * On match it tries one gentle nudge; if that doesn't unstick the session
 * within the verify window, it escalates via the tone-gated /attention
 * path.
 *
 * Spec: docs/specs/silently-stopped-trio.md
 *
 * Signal-vs-authority: the threshold check is a detector. The nudge is a
 * bounded recovery primitive. The escalation goes through MessagingToneGate
 * via the notify path. No new blocking authority.
 */

import { EventEmitter } from 'node:events';

export type SilenceStatus =
  | 'detected'
  | 'nudged'
  | 'recovered'
  | 'recovering'
  | 'recovery-failed'
  | 'escalated';

export interface SilenceState {
  sessionName: string;
  detectedAt: number;
  lastOutputAtAtDetection: number;
  nudgedAt: number;
  status: SilenceStatus;
  /** Auto-recovery (respawn) attempts made for this stall episode. Bounded by
   *  maxAutoRecoveries to prevent a respawn-loop on a session that stays stuck. */
  recoveryAttempts: number;
}

export interface SessionRegistryEntry {
  sessionName: string;
  /** Wall-clock (ms) of the most recent tmux output observed for this session. */
  lastOutputAt: number;
  /** Optional flag — if true, sentinel skips this session (e.g. operator paused). */
  paused?: boolean;
  /** Optional flag — true if another sentinel/restart is in flight; skip. */
  recoveryInFlight?: boolean;
}

export interface ActiveWorkSilenceSentinelDeps {
  /** List every session the registry knows about (topic-bound or not). */
  listSessions: () => SessionRegistryEntry[];
  /** Send an empty send-keys to wake the pane. Returns whether it was accepted. */
  nudgeFn: (sessionName: string) => Promise<boolean>;
  /** Route a user-facing message; server.ts owns topic routing (→ the stalled
   *  session's OWN topic when auto-recover is on). */
  notifyFn: (sessionName: string, text: string) => Promise<void>;
  /** Auto-recovery primitive: fresh-respawn a confirmed-stuck session
   *  (conversation preserved via resume/bootstrap). Returns whether it succeeded.
   *  Optional — when absent (or autoRecover off) the sentinel falls back to the
   *  ask-the-user escalation. DESTRUCTIVE (discards in-context work), so it only
   *  runs after the nudge fails AND is bounded by maxAutoRecoveries. */
  recoverFn?: (sessionName: string) => Promise<boolean>;
  /** Override Date.now for tests. */
  now?: () => number;
  /** Override timer setters for tests. */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface ActiveWorkSilenceSentinelConfig {
  enabled?: boolean;
  /** Tick interval — how often we walk the registry (ms). Default 60s. */
  tickIntervalMs?: number;
  /** Silence threshold — output gap that triggers detection (ms). Default 15m. */
  silenceThresholdMs?: number;
  /** Verify window — how long after nudge before declaring escalate (ms). Default 30s. */
  verifyWindowMs?: number;
  /** Auto-recover (respawn) a stalled session after the nudge fails, instead of
   *  only asking the user. DARK by default — destructive (discards in-context
   *  work), so opt-in. When off, behaviour is unchanged (nudge → ask). */
  autoRecover?: boolean;
  /** Hard cap on auto-recovery (respawn) attempts per stall episode. Prevents a
   *  respawn-loop on a session that stays stuck after a respawn. Default 1 —
   *  one auto-respawn, then fall back to asking the user. */
  maxAutoRecoveries?: number;
}

const DEFAULT_CONFIG: Required<ActiveWorkSilenceSentinelConfig> = {
  enabled: true,
  tickIntervalMs: 60_000,
  silenceThresholdMs: 15 * 60_000,
  verifyWindowMs: 30_000,
  autoRecover: false,
  maxAutoRecoveries: 1,
};

export class ActiveWorkSilenceSentinel extends EventEmitter {
  private readonly cfg: Required<ActiveWorkSilenceSentinelConfig>;
  private readonly states = new Map<string, SilenceState>();
  private readonly verifyTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private tickHandle: ReturnType<typeof setInterval> | null = null;
  /** Liveness of the tick loop (GUARD-POSTURE-ENDPOINT-SPEC §2.2): 0 = never ticked. */
  private lastTickAt = 0;

  constructor(private readonly deps: ActiveWorkSilenceSentinelDeps, cfg: ActiveWorkSilenceSentinelConfig = {}) {
    super();
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
  }

  start(): void {
    if (!this.cfg.enabled || this.tickHandle) return;
    this.tickHandle = setInterval(() => this.tick(), this.cfg.tickIntervalMs);
    // Unref so this doesn't keep the process alive on shutdown.
    if (typeof this.tickHandle.unref === 'function') this.tickHandle.unref();
  }

  stop(): void {
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
    for (const t of this.verifyTimers.values()) this.clearTimer(t);
    this.verifyTimers.clear();
    this.states.clear();
  }

  /** Public for tests. Walk the registry and act on silence findings. */
  tick(): void {
    this.lastTickAt = Date.now();
    const now = (this.deps.now ?? Date.now)();
    const sessions = this.deps.listSessions();
    for (const s of sessions) {
      if (s.paused || s.recoveryInFlight) continue;
      if (!s.lastOutputAt || s.lastOutputAt <= 0) continue;
      // Session is in the registry but never produced output → not "actively working then stopped"; skip.
      const idleMs = now - s.lastOutputAt;
      if (idleMs < this.cfg.silenceThresholdMs) continue;
      const existing = this.states.get(s.sessionName);
      if (existing) continue; // already handling
      this.report(s.sessionName, s.lastOutputAt);
    }
  }

  /** Public entry: report a silence finding. Idempotent. */
  report(sessionName: string, lastOutputAt: number): void {
    if (!this.cfg.enabled) return;
    if (this.states.has(sessionName)) return;
    const now = (this.deps.now ?? Date.now)();
    const state: SilenceState = {
      sessionName,
      detectedAt: now,
      lastOutputAtAtDetection: lastOutputAt,
      nudgedAt: 0,
      status: 'detected',
      recoveryAttempts: 0,
    };
    this.states.set(sessionName, state);
    this.emit('silence', { sessionName, idleMs: now - lastOutputAt });
    void this.runNudge(sessionName);
  }

  isRecoveryActive(sessionName: string): boolean {
    const s = this.states.get(sessionName);
    return !!s && s.status !== 'recovered' && s.status !== 'escalated';
  }

  listActive(): SilenceState[] {
    return Array.from(this.states.values());
  }

  clear(sessionName: string): void {
    const t = this.verifyTimers.get(sessionName);
    if (t) this.clearTimer(t);
    this.verifyTimers.delete(sessionName);
    this.states.delete(sessionName);
  }

  private async runNudge(sessionName: string): Promise<void> {
    const state = this.states.get(sessionName);
    if (!state) return;
    state.status = 'nudged';
    state.nudgedAt = (this.deps.now ?? Date.now)();

    let accepted = false;
    try {
      accepted = await this.deps.nudgeFn(sessionName);
    } catch (err) {
      this.emit('nudge-error', { sessionName, err });
      accepted = false;
    }

    if (!accepted) {
      // Couldn't even nudge — escalate immediately.
      this.escalate(sessionName);
      return;
    }

    const handle = this.setTimer(() => this.verifyNudge(sessionName), this.cfg.verifyWindowMs);
    this.verifyTimers.set(sessionName, handle);
  }

  private verifyNudge(sessionName: string): void {
    const state = this.states.get(sessionName);
    if (!state) return;
    // Re-poll the registry — has lastOutputAt advanced past detection point?
    const fresh = this.deps.listSessions().find(s => s.sessionName === sessionName);
    if (!fresh) {
      // Session vanished from registry — treat as recovered (probably ended cleanly).
      state.status = 'recovered';
      this.clear(sessionName);
      return;
    }
    if (fresh.lastOutputAt > state.lastOutputAtAtDetection) {
      state.status = 'recovered';
      this.emit('recovered', sessionName);
      this.clear(sessionName);
      return;
    }
    this.escalate(sessionName);
  }

  private escalate(sessionName: string): void {
    const state = this.states.get(sessionName);
    if (!state) return;
    // Auto-heal path (dark by default): after the nudge failed, recover the
    // session (respawn) instead of only asking the user — bounded by
    // maxAutoRecoveries so a session that stays stuck can't trigger a
    // respawn-loop. Falls through to the ask-path when off / cap reached / no
    // recoverFn wired.
    if (this.cfg.autoRecover && this.deps.recoverFn && state.recoveryAttempts < this.cfg.maxAutoRecoveries) {
      void this.runRecovery(sessionName);
      return;
    }
    state.status = 'escalated';
    const minutes = Math.max(1, Math.round(((this.deps.now ?? Date.now)() - state.lastOutputAtAtDetection) / 60_000));
    void this.notify(
      sessionName,
      `${friendlyName(sessionName)} was working and went quiet about ${minutes} minutes ago. I tried a gentle nudge and nothing came back. Want me to dig in?`,
    );
    this.emit('escalated', sessionName);
  }

  /**
   * Auto-recovery ladder (dark by default): notify in the stalled session's own
   * topic, respawn it, then notify the outcome. Bounded by maxAutoRecoveries
   * (the recoveryAttempts increment + the escalate() guard) so a session that
   * stays stuck after a respawn falls back to asking the user — never a loop.
   */
  private async runRecovery(sessionName: string): Promise<void> {
    const state = this.states.get(sessionName);
    if (!state || !this.deps.recoverFn) return;
    state.status = 'recovering';
    state.recoveryAttempts += 1;
    const minutes = Math.max(1, Math.round(((this.deps.now ?? Date.now)() - state.lastOutputAtAtDetection) / 60_000));
    await this.notify(
      sessionName,
      `${friendlyName(sessionName)} went quiet about ${minutes} minutes ago and a nudge didn't wake it — auto-recovering it now.`,
    );
    this.emit('recovering', sessionName);

    let ok = false;
    try {
      ok = await this.deps.recoverFn(sessionName);
    } catch (err) {
      this.emit('recover-error', { sessionName, err });
      ok = false;
    }

    if (ok) {
      state.status = 'recovered';
      await this.notify(
        sessionName,
        `${friendlyName(sessionName)} was stuck — I recovered it (fresh restart, conversation preserved). It should pick back up now.`,
      );
      this.emit('recovered', sessionName);
      // Clear so the freshly-respawned session is monitored anew. The respawn
      // resets its output clock, so it won't immediately re-trigger.
      this.clear(sessionName);
      return;
    }

    // Respawn failed — fall back to asking the user, and DO NOT clear (the
    // persisted state stops tick() re-detecting → no auto-recovery loop).
    state.status = 'recovery-failed';
    await this.notify(
      sessionName,
      `${friendlyName(sessionName)} went quiet and I couldn't auto-recover it. Want me to dig in?`,
    );
    this.emit('recovery-failed', sessionName);
  }

  private async notify(sessionName: string, text: string): Promise<void> {
    try {
      await this.deps.notifyFn(sessionName, text);
    } catch (err) {
      this.emit('notify-error', { sessionName, err });
    }
  }

  private setTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    return (this.deps.setTimer ?? setTimeout)(fn, ms);
  }

  private clearTimer(handle: ReturnType<typeof setTimeout>): void {
    (this.deps.clearTimer ?? clearTimeout)(handle);
  }

  /** Sync in-memory runtime read for the GuardRegistry (GET /guards).
   *  MUST stay a cheap property read — no I/O, no session listing. */
  guardStatus(): { enabled: boolean; lastTickAt: number } {
    return { enabled: this.cfg.enabled, lastTickAt: this.lastTickAt };
  }
}

function friendlyName(sessionName: string): string {
  return sessionName.replace(/^ai\.instar\./, '').replace(/-server$/, '').replace(/-lifeline$/, '');
}

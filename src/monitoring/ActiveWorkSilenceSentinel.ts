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

export type SilenceStatus = 'detected' | 'nudged' | 'recovered' | 'escalated';

export interface SilenceState {
  sessionName: string;
  detectedAt: number;
  lastOutputAtAtDetection: number;
  nudgedAt: number;
  status: SilenceStatus;
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
  /** Route a user-facing message; server.ts owns topic routing. */
  notifyFn: (sessionName: string, text: string) => Promise<void>;
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
}

const DEFAULT_CONFIG: Required<ActiveWorkSilenceSentinelConfig> = {
  enabled: true,
  tickIntervalMs: 60_000,
  silenceThresholdMs: 15 * 60_000,
  verifyWindowMs: 30_000,
};

export class ActiveWorkSilenceSentinel extends EventEmitter {
  private readonly cfg: Required<ActiveWorkSilenceSentinelConfig>;
  private readonly states = new Map<string, SilenceState>();
  private readonly verifyTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private tickHandle: ReturnType<typeof setInterval> | null = null;

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
    state.status = 'escalated';
    const minutes = Math.max(1, Math.round(((this.deps.now ?? Date.now)() - state.lastOutputAtAtDetection) / 60_000));
    void this.notify(
      sessionName,
      `${friendlyName(sessionName)} was working and went quiet about ${minutes} minutes ago. I tried a gentle nudge and nothing came back. Want me to dig in?`,
    );
    this.emit('escalated', sessionName);
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
}

function friendlyName(sessionName: string): string {
  return sessionName.replace(/^ai\.instar\./, '').replace(/-server$/, '').replace(/-lifeline$/, '');
}

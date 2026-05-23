/**
 * SocketDisconnectSentinel — detects Claude Code's "socket connection closed
 * unexpectedly" message in tracked sessions and runs a bounded recovery loop.
 *
 * Closes the gap surfaced by the joint diagnosis on 2026-05-22: the instar
 * repo had detectors for rate limits, quota, hundreds of patterns, but zero
 * detectors for Claude Code's own connection-drop string. When it fires, the
 * session freezes; nothing classifies it; no recovery runs; no user-visible
 * alert reaches the user.
 *
 * Pattern mirrors `RateLimitSentinel.report` → backoff → `resumeFn` →
 * verification → escalate, but the failure shape is simpler (no Claude
 * Code internal retries to wait out — disconnect is immediate) so the
 * lifecycle is shorter.
 *
 * Spec: docs/specs/silently-stopped-trio.md
 *
 * Signal-vs-authority: the regex + state machine are detectors. The
 * notifyFn path is the existing MessagingToneGate authority (called through
 * /attention). No new blocking authority introduced.
 */

import { EventEmitter } from 'node:events';

export type SocketDisconnectStatus =
  | 'detected'
  | 'recovering'
  | 'recovered'
  | 'escalated';

export interface SocketDisconnectState {
  sessionName: string;
  detectedAt: number;
  attempts: number;
  lastInjectAt: number;
  status: SocketDisconnectStatus;
}

export interface SocketDisconnectSentinelDeps {
  /**
   * Inject a recovery nudge into the session: typically Ctrl+C then Enter.
   * Returns whether the injection was accepted.
   */
  resumeFn: (sessionName: string) => Promise<boolean>;
  /** Route a user-facing message; server.ts owns topic routing. */
  notifyFn: (sessionName: string, text: string) => Promise<void>;
  /** Peek at the session's most recent tmux output. Returns a string that
   * may be empty if the session has no recent output. */
  getRecentOutput: (sessionName: string) => string;
  /**
   * Optional: list the session names to scan on each tick. Required for the
   * self-driving `start()` loop; without it the sentinel is event-driven only
   * (caller invokes `scanSession`/`report`). The server wiring supplies this.
   */
  listSessionNames?: () => string[];
  /** Override Date.now (tests). */
  now?: () => number;
  /** Override timer setters (tests). */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface SocketDisconnectSentinelConfig {
  enabled?: boolean;
  /** Backoff staircase in ms between recovery attempts. Last value repeats. */
  backoffScheduleMs?: number[];
  /** Max recovery attempts before escalating. Default 4. */
  maxAttempts?: number;
  /** How long to wait after a nudge before declaring recovery (ms). Default 60s. */
  verifyWindowMs?: number;
  /** How often the self-driving loop scans every session (ms). Default 15s. */
  tickIntervalMs?: number;
}

const DEFAULT_CONFIG: Required<SocketDisconnectSentinelConfig> = {
  enabled: true,
  backoffScheduleMs: [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000],
  maxAttempts: 4,
  verifyWindowMs: 60_000,
  tickIntervalMs: 15_000,
};

/**
 * Patterns Claude Code uses when its connection to Anthropic drops. Broad
 * intentionally — false-positive cost is one harmless nudge; false-negative
 * cost is the silently-stopped failure class this sentinel exists to close.
 */
export const SOCKET_DISCONNECT_PATTERNS: readonly RegExp[] = [
  /socket connection closed unexpectedly/i,
  /websocket.*reset by peer/i,
  /ECONNRESET.*claude/i,
  /connection.*closed.*unexpectedly/i,
];

/**
 * Detector — true if `text` contains any known disconnect pattern.
 */
export function detectSocketDisconnect(text: string): boolean {
  if (!text) return false;
  for (const pat of SOCKET_DISCONNECT_PATTERNS) {
    if (pat.test(text)) return true;
  }
  return false;
}

export class SocketDisconnectSentinel extends EventEmitter {
  private readonly cfg: Required<SocketDisconnectSentinelConfig>;
  private readonly states = new Map<string, SocketDisconnectState>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private tickHandle: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: SocketDisconnectSentinelDeps, cfg: SocketDisconnectSentinelConfig = {}) {
    super();
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
  }

  /**
   * Begin the self-driving scan loop. No-op unless `listSessionNames` was
   * provided (otherwise the sentinel is purely event-driven). The interval is
   * unref'd so it never holds the process open at shutdown.
   */
  start(): void {
    if (!this.cfg.enabled || this.tickHandle) return;
    if (!this.deps.listSessionNames) return;
    this.tickHandle = setInterval(() => this.tick(), this.cfg.tickIntervalMs);
    if (typeof this.tickHandle.unref === 'function') this.tickHandle.unref();
  }

  /** Stop the scan loop and cancel all in-flight recovery. */
  stop(): void {
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
    this.shutdown();
  }

  /** One scan pass over every session the registry currently knows about. */
  tick(): void {
    if (!this.cfg.enabled) return;
    const names = this.deps.listSessionNames?.() ?? [];
    for (const name of names) this.scanSession(name);
  }

  /** Called by the tick loop (or by an event trigger) for each tracked session. */
  scanSession(sessionName: string): void {
    if (!this.cfg.enabled) return;
    if (this.states.has(sessionName)) return; // already handling
    const output = this.deps.getRecentOutput(sessionName);
    if (!detectSocketDisconnect(output)) return;
    this.report(sessionName);
  }

  /**
   * Public entry: report a detected disconnect. Idempotent — second call
   * for the same session within an active recovery is a no-op.
   */
  report(sessionName: string): void {
    if (!this.cfg.enabled) return;
    if (this.states.has(sessionName)) return;
    const now = (this.deps.now ?? Date.now)();
    const state: SocketDisconnectState = {
      sessionName,
      detectedAt: now,
      attempts: 0,
      lastInjectAt: 0,
      status: 'detected',
    };
    this.states.set(sessionName, state);

    // First user notice — tone-gated path via notifyFn.
    void this.notify(
      sessionName,
      `${friendlyName(sessionName)} lost its connection to Claude Code. Trying to recover; will let you know if it can't.`,
    );

    this.scheduleNextAttempt(sessionName);
  }

  isRecoveryActive(sessionName: string): boolean {
    const s = this.states.get(sessionName);
    return !!s && s.status !== 'recovered' && s.status !== 'escalated';
  }

  listActive(): SocketDisconnectState[] {
    return Array.from(this.states.values());
  }

  /** Cancel any in-flight recovery for this session (test + shutdown helper). */
  clear(sessionName: string): void {
    const t = this.timers.get(sessionName);
    if (t) this.clearTimer(t);
    this.timers.delete(sessionName);
    this.states.delete(sessionName);
  }

  /** Cancel all in-flight recovery (server shutdown). */
  shutdown(): void {
    for (const t of this.timers.values()) this.clearTimer(t);
    this.timers.clear();
    this.states.clear();
  }

  // ── Recovery loop ──────────────────────────────────────────────────

  private scheduleNextAttempt(sessionName: string): void {
    const state = this.states.get(sessionName);
    if (!state) return;
    if (state.attempts >= this.cfg.maxAttempts) {
      this.escalate(sessionName);
      return;
    }
    const idx = Math.min(state.attempts, this.cfg.backoffScheduleMs.length - 1);
    const wait = this.cfg.backoffScheduleMs[idx];
    state.status = 'recovering';
    const handle = this.setTimer(() => this.runAttempt(sessionName), wait);
    this.timers.set(sessionName, handle);
  }

  private async runAttempt(sessionName: string): Promise<void> {
    const state = this.states.get(sessionName);
    if (!state) return;
    const now = (this.deps.now ?? Date.now)();
    state.attempts += 1;
    state.lastInjectAt = now;

    let injected = false;
    try {
      injected = await this.deps.resumeFn(sessionName);
    } catch (err) {
      this.emit('recovery-error', { sessionName, err });
      injected = false;
    }

    if (!injected) {
      // Nudge couldn't be delivered — escalate immediately, this isn't
      // something a backoff staircase can fix.
      this.escalate(sessionName);
      return;
    }

    // Schedule a verify check.
    const handle = this.setTimer(() => this.verifyAttempt(sessionName), this.cfg.verifyWindowMs);
    this.timers.set(sessionName, handle);
  }

  private verifyAttempt(sessionName: string): void {
    const state = this.states.get(sessionName);
    if (!state) return;
    const output = this.deps.getRecentOutput(sessionName);
    // Heuristic: if the disconnect pattern no longer appears in the recent
    // output, the session has progressed past the freeze.
    if (!detectSocketDisconnect(output)) {
      state.status = 'recovered';
      void this.notify(
        sessionName,
        `${friendlyName(sessionName)} is reconnected and back to work.`,
      );
      this.emit('recovered', sessionName);
      this.clear(sessionName);
      return;
    }
    // Still stuck → next attempt.
    this.scheduleNextAttempt(sessionName);
  }

  private escalate(sessionName: string): void {
    const state = this.states.get(sessionName);
    if (!state) return;
    state.status = 'escalated';
    const minutes = Math.max(1, Math.round(((this.deps.now ?? Date.now)() - state.detectedAt) / 60_000));
    void this.notify(
      sessionName,
      `${friendlyName(sessionName)} has been disconnected for about ${minutes} minutes and my recovery attempts haven't worked. Want me to dig in?`,
    );
    this.emit('escalated', sessionName);
    // Keep state so a subsequent scanSession doesn't re-report the same outage.
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

/** Strip prefix conventions for user-facing copy. Keeps B12 simple. */
function friendlyName(sessionName: string): string {
  return sessionName.replace(/^ai\.instar\./, '').replace(/-server$/, '').replace(/-lifeline$/, '');
}

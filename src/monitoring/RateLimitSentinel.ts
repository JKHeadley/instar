/**
 * RateLimitSentinel — Owns the full lifecycle of riding out Anthropic's
 * server-side capacity throttle without dropping the session or burning quota.
 *
 * Scenario: Claude Code surfaces "Server is temporarily limiting requests (not
 * your usage limit) · Rate limited" (or "Repeated 529 Overloaded errors") only
 * AFTER its own internal retries (CLAUDE_CODE_MAX_RETRIES, exp backoff) are
 * exhausted. The session then sits idle with no reply relayed to the user.
 *
 * Prior behavior: SessionManager's idle-error path fired a single immediate
 * nudge — which re-hits the live throttle and burns quota — then went silent
 * until the zombie-killer reaped the session.
 *
 * What this class adds (mirrors CompactionSentinel's own-the-lifecycle pattern):
 *   1. Dedupe across the two signal triggers (watchdog poll + SessionManager
 *      idle-error emit).
 *   2. Immediate user notice — "throttled, backing off, you're not dropped".
 *   3. Backoff BEFORE re-engaging (escalating schedule) — the core quota-burn
 *      mitigation; we sit on top of Claude's already-exhausted retries.
 *   4. Neutral "continue" re-engagement (NOT the compaction-resume payload,
 *      which would falsely tell the agent its memory was reset).
 *   5. Verification — jsonl size/mtime growth = Claude processed the nudge.
 *   6. Periodic user check-ins at verify-fail transitions (min-spacing gated).
 *   7. Escalation after a capped attempts/window envelope.
 *   8. Zombie-kill veto while a recovery is in flight (isRecoveryActive).
 *   9. Bidirectional deferral with CompactionSentinel via deferIf, so the two
 *      never inject into one pane concurrently.
 *
 * The lifecycle is strictly SEQUENTIAL — at any instant a session is either
 * waiting out a backoff or waiting out a verify window, never both — so a
 * single timer slot per session is sufficient (no concurrent backoff/verify/
 * check-in timers). Check-ins are emitted synchronously at the transition.
 *
 * Decoupling: takes resumeFn + notifyFn in deps rather than importing server.ts,
 * so topic/channel routing stays out of this file (same pattern as
 * CompactionSentinel's recoverFn).
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

export type RateLimitTrigger = 'watchdog-poll' | 'idle-error' | string;

export type RateLimitStatus =
  | 'detected'      // reported; first user notice sent; first backoff scheduled
  | 'backing-off'   // waiting out the current backoff interval
  | 'resuming'      // nudge injected; waiting verify window for jsonl growth
  | 'recovered'     // jsonl grew → throttle cleared; user notified
  | 'escalated';    // attempts/window exhausted; final user notice sent

export interface RateLimitRecoveryState {
  sessionName: string;
  trigger: RateLimitTrigger;
  detectedAt: number;
  attempts: number;
  lastInjectAt: number;
  lastCheckInAt: number;
  baselineJsonlPath: string | null;
  baselineJsonlSize: number | null;
  baselineJsonlMtime: number | null;
  status: RateLimitStatus;
}

export interface RateLimitSentinelDeps {
  /**
   * Inject a NEUTRAL "continue" nudge into the session (topic-tagged so
   * InputGuard accepts it). Returns whether the injection was accepted.
   * Must NOT reuse the compaction-resume payload.
   */
  resumeFn: (sessionName: string) => Promise<boolean>;

  /** Route a user-facing message for this session (server.ts owns topic lookup + relay). */
  notifyFn: (sessionName: string, text: string) => Promise<void>;

  /** Project dir, to locate Claude Code JSONL files for verification. */
  projectDir: string;

  /** Resolve a session's Claude Code session UUID for exact-file jsonl lookup. */
  getClaudeSessionId?: (sessionName: string) => string | undefined;

  /** Defer (skip starting) recovery when this returns true — e.g. compaction recovery in flight. */
  deferIf?: (sessionName: string) => boolean;

  /** Override JSONL lookup root (tests). Defaults to $HOME/.claude/projects/<project-hash>. */
  jsonlRoot?: string;

  /** Override Date.now (tests). */
  now?: () => number;

  /** Override timer setters (tests). */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface RateLimitSentinelConfig {
  /** Master kill switch. When false, report() is a no-op. */
  enabled?: boolean;
  /** Escalating wait (ms) before each re-engagement attempt. Last value repeats. */
  backoffScheduleMs?: number[];
  /** Max re-engagement attempts before escalating. */
  maxAttempts?: number;
  /** Max wall-clock window (ms) a recovery may run before escalating. */
  maxWindowMs?: number;
  /** How long to wait after a nudge before checking jsonl growth. */
  verifyWindowMs?: number;
  /** Minimum spacing (ms) between user check-in messages. */
  checkInEveryMs?: number;
  /** Ignore repeat reports for the same session within this window. */
  dedupeWindowMs?: number;
}

const DEFAULTS: Required<RateLimitSentinelConfig> = {
  enabled: true,
  backoffScheduleMs: [30_000, 60_000, 120_000, 300_000, 300_000, 300_000],
  maxAttempts: 6,
  maxWindowMs: 30 * 60_000,
  verifyWindowMs: 25_000,
  checkInEveryMs: 120_000,
  dedupeWindowMs: 60_000,
};

export interface RateLimitSentinelEvents {
  'rate-limit:detected': [RateLimitRecoveryState];
  'rate-limit:resuming': [RateLimitRecoveryState & { backoffMs: number }];
  'rate-limit:recovered': [RateLimitRecoveryState & { jsonlDelta: number }];
  'rate-limit:escalated': [RateLimitRecoveryState & { reason: string }];
}

function humanizeMs(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const mins = Math.round(ms / 60_000);
  return `${mins}m`;
}

export class RateLimitSentinel extends EventEmitter {
  private readonly deps: RateLimitSentinelDeps;
  private readonly cfg: Required<RateLimitSentinelConfig>;
  private readonly active = new Map<string, RateLimitRecoveryState>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly recentReports = new Map<string, number>();
  private deferIf?: (sessionName: string) => boolean;

  constructor(deps: RateLimitSentinelDeps, config: RateLimitSentinelConfig = {}) {
    super();
    this.deps = deps;
    this.deferIf = deps.deferIf;
    this.cfg = {
      enabled: config.enabled ?? DEFAULTS.enabled,
      backoffScheduleMs: config.backoffScheduleMs ?? DEFAULTS.backoffScheduleMs,
      maxAttempts: config.maxAttempts ?? DEFAULTS.maxAttempts,
      maxWindowMs: config.maxWindowMs ?? DEFAULTS.maxWindowMs,
      verifyWindowMs: config.verifyWindowMs ?? DEFAULTS.verifyWindowMs,
      checkInEveryMs: config.checkInEveryMs ?? DEFAULTS.checkInEveryMs,
      dedupeWindowMs: config.dedupeWindowMs ?? DEFAULTS.dedupeWindowMs,
    };
  }

  /** Late-bind the deferral predicate (server.ts wires the two sentinels at each other). */
  setDeferIf(fn: (sessionName: string) => boolean): void {
    this.deferIf = fn;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private setTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    return this.deps.setTimer ? this.deps.setTimer(fn, ms) : setTimeout(fn, ms);
  }

  private clearTimer(handle: ReturnType<typeof setTimeout>): void {
    if (this.deps.clearTimer) this.deps.clearTimer(handle);
    else clearTimeout(handle);
  }

  /**
   * Report a detected throttle. Called by both signal triggers. Deduped — if a
   * recovery is already active, or one was reported within the dedupe window,
   * or deferIf says another recovery owns this session, this is a no-op.
   */
  report(sessionName: string, trigger: RateLimitTrigger): void {
    if (!this.cfg.enabled) return;
    const now = this.now();

    if (this.active.has(sessionName)) return;            // recovery in flight
    if (this.deferIf?.(sessionName)) return;             // another recovery owns it (S6)
    const lastReport = this.recentReports.get(sessionName);
    if (lastReport && now - lastReport < this.cfg.dedupeWindowMs) return;
    this.recentReports.set(sessionName, now);

    const baseline = this.readJsonlBaseline(sessionName);
    const state: RateLimitRecoveryState = {
      sessionName,
      trigger,
      detectedAt: now,
      attempts: 0,
      lastInjectAt: 0,
      lastCheckInAt: 0,
      baselineJsonlPath: baseline?.path ?? null,
      baselineJsonlSize: baseline?.size ?? null,
      baselineJsonlMtime: baseline?.mtime ?? null,
      status: 'detected',
    };
    this.active.set(sessionName, state);

    console.log(
      `[RateLimitSentinel] detected throttle on "${sessionName}" via ${trigger}; ` +
      `baseline jsonl=${state.baselineJsonlPath ? path.basename(state.baselineJsonlPath) : 'none'} ` +
      `size=${state.baselineJsonlSize ?? 'n/a'}`,
    );
    this.emit('rate-limit:detected', state);

    // Immediate user notice (fixed template, no LLM).
    void this.notify(
      sessionName,
      "Heads up — Claude hit a temporary server-side throttle on Anthropic's side " +
      '(not your usage limit). I\'m backing off and will keep retrying. ' +
      "You haven't been dropped — I'll check back in.",
    );
    state.lastCheckInAt = now;

    this.scheduleBackoff(state);
  }

  /** Predicate for SessionManager's zombie-killer + PresenceProxy suppression. */
  isRecoveryActive(sessionName: string): boolean {
    const state = this.active.get(sessionName);
    if (!state) return false;
    return state.status !== 'recovered' && state.status !== 'escalated';
  }

  clear(sessionName: string): void {
    const timer = this.timers.get(sessionName);
    if (timer) {
      this.clearTimer(timer);
      this.timers.delete(sessionName);
    }
    this.active.delete(sessionName);
  }

  stop(): void {
    for (const handle of this.timers.values()) this.clearTimer(handle);
    this.timers.clear();
    this.active.clear();
    this.recentReports.clear();
  }

  getState(sessionName: string): RateLimitRecoveryState | undefined {
    return this.active.get(sessionName);
  }

  /** Snapshot of all active recoveries — backs GET /rate-limit/status. */
  listActive(): Array<RateLimitRecoveryState & { nextBackoffMs: number }> {
    return [...this.active.values()].map(s => ({
      ...s,
      nextBackoffMs: this.backoffFor(s.attempts),
    }));
  }

  private backoffFor(attempts: number): number {
    const sched = this.cfg.backoffScheduleMs;
    if (sched.length === 0) return 0;
    return sched[Math.min(attempts, sched.length - 1)];
  }

  private scheduleBackoff(state: RateLimitRecoveryState): void {
    const backoffMs = this.backoffFor(state.attempts);
    state.status = 'backing-off';
    const handle = this.setTimer(() => {
      this.attemptResume(state).catch(err => {
        console.warn(`[RateLimitSentinel] resume threw on "${state.sessionName}":`, err);
        this.finalize(state, 'escalated', `resume threw: ${String(err)}`);
      });
    }, backoffMs);
    this.timers.set(state.sessionName, handle);
  }

  private async attemptResume(state: RateLimitRecoveryState): Promise<void> {
    this.timers.delete(state.sessionName);
    state.attempts += 1;
    state.lastInjectAt = this.now();
    state.status = 'resuming';

    let accepted = false;
    try {
      accepted = await this.deps.resumeFn(state.sessionName);
    } catch (err) {
      console.warn(`[RateLimitSentinel] resumeFn threw on "${state.sessionName}" (attempt ${state.attempts}):`, err);
    }

    console.log(
      `[RateLimitSentinel] resume-attempted on "${state.sessionName}" ` +
      `(attempt ${state.attempts}/${this.cfg.maxAttempts}, accepted=${accepted})`,
    );
    this.emit('rate-limit:resuming', { ...state, backoffMs: this.backoffFor(state.attempts - 1) });

    if (!accepted) {
      // No pending work / session gone / injection blocked — nothing to recover.
      this.finalize(state, 'escalated', 'resumeFn declined (no pending work or session gone)');
      return;
    }

    const handle = this.setTimer(() => {
      this.verify(state).catch(err => {
        console.warn(`[RateLimitSentinel] verify threw on "${state.sessionName}":`, err);
        this.finalize(state, 'escalated', `verify threw: ${String(err)}`);
      });
    }, this.cfg.verifyWindowMs);
    this.timers.set(state.sessionName, handle);
  }

  private async verify(state: RateLimitRecoveryState): Promise<void> {
    this.timers.delete(state.sessionName);

    const current = this.readJsonlBaseline(state.sessionName);
    const grew =
      state.baselineJsonlSize !== null &&
      current !== null &&
      (current.size > state.baselineJsonlSize ||
        (current.path === state.baselineJsonlPath &&
          state.baselineJsonlMtime !== null &&
          current.mtime > state.baselineJsonlMtime));

    if (grew) {
      const delta = (current?.size ?? 0) - (state.baselineJsonlSize ?? 0);
      console.log(`[RateLimitSentinel] recovered "${state.sessionName}" after ${state.attempts} attempt(s) (jsonl grew by ${delta} bytes)`);
      this.emit('rate-limit:recovered', { ...state, jsonlDelta: delta });
      void this.notify(
        state.sessionName,
        "Back online — Anthropic's throttle cleared. Continuing where I left off.",
      );
      this.finalize(state, 'recovered');
      return;
    }

    // Refresh baseline to the current file so a later partial write still counts as growth.
    if (current) {
      state.baselineJsonlPath = current.path;
      state.baselineJsonlSize = current.size;
      state.baselineJsonlMtime = current.mtime;
    }

    const elapsed = this.now() - state.detectedAt;
    if (state.attempts >= this.cfg.maxAttempts || elapsed >= this.cfg.maxWindowMs) {
      void this.notify(
        state.sessionName,
        `Still can't get through after ${state.attempts} tries over ${humanizeMs(elapsed)}. ` +
        "This is on Anthropic's side — status.claude.com has live capacity notices. " +
        "I'll keep an eye out; you can also just message me to retry.",
      );
      this.finalize(
        state,
        'escalated',
        `no jsonl growth after ${state.attempts} attempts over ${humanizeMs(elapsed)}`,
      );
      return;
    }

    // Check-in at this transition, min-spacing gated.
    const now = this.now();
    if (now - state.lastCheckInAt >= this.cfg.checkInEveryMs) {
      state.lastCheckInAt = now;
      void this.notify(
        state.sessionName,
        `Still throttled on Anthropic's side — next retry in ${humanizeMs(this.backoffFor(state.attempts))}. ` +
        "Still here, haven't dropped you.",
      );
    }

    this.scheduleBackoff(state);
  }

  private finalize(state: RateLimitRecoveryState, status: 'recovered' | 'escalated', reason?: string): void {
    state.status = status;
    if (status === 'escalated') {
      console.warn(`[RateLimitSentinel] escalated "${state.sessionName}": ${reason ?? 'unknown'}`);
      this.emit('rate-limit:escalated', { ...state, reason: reason ?? 'unknown' });
    }
    // Keep state briefly past the zombie-veto race window, then clear so a fresh
    // throttle on this session can start a new recovery.
    const keepFor = status === 'recovered' ? 5_000 : 30_000;
    const handle = this.setTimer(() => {
      this.timers.delete(state.sessionName);
      this.active.delete(state.sessionName);
      this.recentReports.delete(state.sessionName);
    }, keepFor);
    this.timers.set(state.sessionName, handle);
  }

  private async notify(sessionName: string, text: string): Promise<void> {
    try {
      await this.deps.notifyFn(sessionName, text);
    } catch (err) {
      console.warn(`[RateLimitSentinel] notifyFn threw on "${sessionName}":`, err);
    }
  }

  private readJsonlBaseline(sessionName: string): { path: string; size: number; mtime: number } | null {
    try {
      const root = this.deps.jsonlRoot
        || path.join(process.env.HOME || '/tmp', '.claude', 'projects',
                     this.deps.projectDir.replace(/\//g, '-'));
      if (!fs.existsSync(root)) return null;

      const uuid = this.deps.getClaudeSessionId?.(sessionName);
      if (uuid) {
        const exact = path.join(root, `${uuid}.jsonl`);
        if (fs.existsSync(exact)) {
          const st = fs.statSync(exact);
          return { path: exact, size: st.size, mtime: st.mtimeMs };
        }
        return null;
      }

      const entries = fs.readdirSync(root).filter(f => f.endsWith('.jsonl'));
      if (entries.length === 0) return null;
      const latest = entries
        .map(f => {
          const full = path.join(root, f);
          const st = fs.statSync(full);
          return { path: full, size: st.size, mtime: st.mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime)[0];
      return latest;
    } catch {
      return null;
    }
  }
}

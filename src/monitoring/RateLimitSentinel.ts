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
import { findNewestRolloutSync } from '../providers/adapters/openai-codex/observability/sessionPaths.js';
import { findNewestGeminiSessionSync } from '../providers/adapters/gemini-cli/observability/sessionPaths.js';

export type RateLimitTrigger = 'watchdog-poll' | 'idle-error' | string;

/**
 * The CLASS of transient API error this recovery is riding out. The lifecycle
 * (backoff → re-engage → verify → escalate) is identical across classes — only the
 * backoff SCHEDULE and the user-facing wording differ:
 *  - 'throttle'      — Anthropic capacity throttle / 529 Overloaded / rate limit.
 *                      Re-hitting it immediately burns quota, so the backoff is LONG.
 *  - 'transient-api' — a generic transient API error (500/502/503, timeout, connection
 *                      drop). These usually clear in seconds, so the first retry is
 *                      FAST and the schedule escalates more gently. Generalizing the
 *                      proven throttle-recovery lifecycle to this whole class is the
 *                      2026-05-29 future-proofing ask (topic 13481).
 */
export type ApiErrorClass = 'throttle' | 'transient-api';

export type RateLimitStatus =
  | 'detected'      // reported; first user notice sent; first backoff scheduled
  | 'backing-off'   // waiting out the current backoff interval
  | 'resuming'      // nudge injected; waiting verify window for jsonl growth
  | 'recovered'     // jsonl grew → throttle cleared; user notified
  | 'escalated';    // attempts/window exhausted; final user notice sent

export interface RateLimitRecoveryState {
  sessionName: string;
  trigger: RateLimitTrigger;
  /** Which transient-error class this recovery rides out (picks backoff + wording). */
  errorClass: ApiErrorClass;
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

  /**
   * Resolve a session's framework ('codex-cli' | 'claude-code' | undefined) — the value
   * carried on a running session. When it returns 'codex-cli', recovery-verification
   * reads the newest codex ROLLOUT jsonl (account-wide growth = the account-wide OpenAI
   * throttle cleared) instead of the Claude transcript. Absent/non-codex → the unchanged
   * Claude path is used (Claude behavior byte-for-byte preserved). #33.
   */
  getSessionFramework?: (sessionName: string) => string | undefined;

  /** Override $CODEX_HOME (tests). Defaults to ~/.codex. Only used for codex sessions. */
  codexHome?: string;

  /** Override ~/.gemini (tests). Defaults to ~/.gemini. Only used for gemini-cli sessions. */
  geminiHome?: string;

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
  /**
   * #33 codex parity: enable the codex account-usage detection poll (server-side), which
   * reports throttled codex sessions into the sentinel so its (codex-aware) recovery runs
   * for codex exactly as it does for Claude. Ships DARK (default off / undefined) — the
   * Claude detection triggers are unaffected; flip on after a live codex-throttle
   * verification. Rollback = set false.
   */
  codexUsageDetection?: boolean;
  /** Escalating wait (ms) before each re-engagement attempt for a THROTTLE/rate-limit
   *  recovery. Last value repeats. */
  backoffScheduleMs?: number[];
  /** Escalating wait (ms) for a generic 'transient-api' recovery (500/502/503/timeout/
   *  connection). Shorter than the throttle schedule — these usually clear in seconds,
   *  so the first retry is fast. Last value repeats. */
  transientApiBackoffScheduleMs?: number[];
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
  codexUsageDetection: false, // #33 codex detection ships DARK
  backoffScheduleMs: [30_000, 60_000, 120_000, 300_000, 300_000, 300_000],
  transientApiBackoffScheduleMs: [5_000, 15_000, 30_000, 60_000, 120_000, 300_000],
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
      codexUsageDetection: config.codexUsageDetection ?? DEFAULTS.codexUsageDetection,
      backoffScheduleMs: config.backoffScheduleMs ?? DEFAULTS.backoffScheduleMs,
      transientApiBackoffScheduleMs: config.transientApiBackoffScheduleMs ?? DEFAULTS.transientApiBackoffScheduleMs,
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
  report(sessionName: string, trigger: RateLimitTrigger, opts?: { errorClass?: ApiErrorClass }): void {
    if (!this.cfg.enabled) return;
    const now = this.now();
    const errorClass: ApiErrorClass = opts?.errorClass ?? 'throttle';

    if (this.active.has(sessionName)) return;            // recovery in flight
    if (this.deferIf?.(sessionName)) return;             // another recovery owns it (S6)
    const lastReport = this.recentReports.get(sessionName);
    if (lastReport && now - lastReport < this.cfg.dedupeWindowMs) return;
    this.recentReports.set(sessionName, now);

    const baseline = this.readJsonlBaseline(sessionName);
    const state: RateLimitRecoveryState = {
      sessionName,
      trigger,
      errorClass,
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
      `[RateLimitSentinel] detected ${errorClass} error on "${sessionName}" via ${trigger}; ` +
      `baseline jsonl=${state.baselineJsonlPath ? path.basename(state.baselineJsonlPath) : 'none'} ` +
      `size=${state.baselineJsonlSize ?? 'n/a'}`,
    );
    this.emit('rate-limit:detected', state);

    // Immediate user notice (fixed template, no LLM), worded per error class + vendor.
    const v = this.vendor(sessionName);
    void this.notify(
      sessionName,
      errorClass === 'transient-api'
        ? `Heads up — ${v.agent} hit a transient API error (likely a brief server-side blip). ` +
          "I'm waiting a moment and will retry. You haven't been dropped — I'll pick up where I left off."
        : `Heads up — ${v.agent} hit a temporary server-side throttle on ${v.provider}'s side ` +
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
      nextBackoffMs: this.backoffFor(s.attempts, s.errorClass),
    }));
  }

  private backoffFor(attempts: number, errorClass: ApiErrorClass = 'throttle'): number {
    const sched = errorClass === 'transient-api' ? this.cfg.transientApiBackoffScheduleMs : this.cfg.backoffScheduleMs;
    if (sched.length === 0) return 0;
    return sched[Math.min(attempts, sched.length - 1)];
  }

  private scheduleBackoff(state: RateLimitRecoveryState): void {
    const backoffMs = this.backoffFor(state.attempts, state.errorClass);
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
    this.emit('rate-limit:resuming', { ...state, backoffMs: this.backoffFor(state.attempts - 1, state.errorClass) });

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
    const v = this.vendor(state.sessionName);

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
        state.errorClass === 'transient-api'
          ? 'Back online — the API error cleared. Continuing where I left off.'
          : `Back online — ${v.provider}'s throttle cleared. Continuing where I left off.`,
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
        `This is on ${v.provider}'s side — ${v.statusUrl} has live capacity notices. ` +
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
        state.errorClass === 'transient-api'
          ? `Still hitting an API error — next retry in ${humanizeMs(this.backoffFor(state.attempts, state.errorClass))}. Still here, haven't dropped you.`
          : `Still throttled on ${v.provider}'s side — next retry in ${humanizeMs(this.backoffFor(state.attempts, state.errorClass))}. ` +
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

  /**
   * Per-session vendor labels for user-facing throttle messages. A codex session's
   * throttle is OpenAI's, not Anthropic's — so the wording + status URL follow the
   * session's framework (#33). Non-codex returns the exact prior Claude strings, so the
   * Claude-facing messages are byte-for-byte unchanged.
   */
  private vendor(sessionName: string): { provider: string; agent: string; statusUrl: string } {
    const fw = this.deps.getSessionFramework?.(sessionName);
    if (fw === 'codex-cli') {
      return { provider: 'OpenAI', agent: 'Codex', statusUrl: 'status.openai.com' };
    }
    if (fw === 'gemini-cli') {
      return { provider: 'Google', agent: 'Gemini', statusUrl: 'status.cloud.google.com' };
    }
    return { provider: 'Anthropic', agent: 'Claude', statusUrl: 'status.claude.com' };
  }

  private readJsonlBaseline(sessionName: string): { path: string; size: number; mtime: number } | null {
    // #33 codex parity: a codex session's transcript is the newest rollout JSONL under
    // $CODEX_HOME/sessions (the OpenAI throttle is account-wide, so the newest rollout's
    // growth is the account-wide "is codex producing output again?" signal). Only taken
    // for codex sessions; everything else falls through to the unchanged Claude path
    // below (Claude behavior is byte-for-byte preserved).
    if (this.deps.getSessionFramework?.(sessionName) === 'codex-cli') {
      return findNewestRolloutSync(this.deps.codexHome);
    }
    // Gemini parity (apprenticeship Step 2 §4.0.2): a gemini session's transcript
    // is the newest session file under ~/.gemini/tmp/<hash>/chats — NOT the Claude
    // projects tree or a codex rollout. "Is gemini producing output again?" ==
    // "did the newest gemini session file grow?". Only taken for gemini sessions;
    // everything else falls through to the unchanged Claude path below (Claude
    // behavior byte-for-byte preserved). Mirrors the codex fix (#33).
    if (this.deps.getSessionFramework?.(sessionName) === 'gemini-cli') {
      return findNewestGeminiSessionSync(this.deps.geminiHome);
    }
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

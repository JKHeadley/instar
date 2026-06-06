/**
 * CompactionSentinel — Owns the full lifecycle of recovering a Claude session
 * after context compaction.
 *
 * Prior behavior (before this class): three independent triggers —
 * PreCompact hook event, SessionWatchdog 'compaction-idle' poll, and the
 * compaction-recovery.sh endpoint — each called `recoverCompactedSession`
 * fire-and-forget. If the injection didn't wake the session up (session
 * genuinely hung, injection silently dropped, Claude process dead), nobody
 * noticed. The idle-prompt zombie-killer then raced the recovery window
 * and killed the session 15 minutes later, wiping the conversation.
 *
 * What this class adds:
 *   1. Dedupe across triggers — once a session is in recovery, additional
 *      reports within the guard window are ignored.
 *   2. Verification — after each inject attempt, watch the session's JSONL
 *      file for size/mtime growth, which is the cheapest reliable signal
 *      that Claude actually processed the prompt and produced output.
 *   3. Retry with backoff — if verification fails within the window, try
 *      injecting again, up to `maxInjectAttempts`.
 *   4. Zombie-kill veto — while a recovery is in flight, SessionManager's
 *      idle-prompt cleanup is told to leave the session alone via the
 *      activeRecoveryChecker hook.
 *   5. Observable outcomes — emits `compaction:detected`,
 *      `compaction:inject-attempted`, `compaction:recovered`,
 *      `compaction:failed` events with a single `[Sentinel]` log prefix
 *      so the full lifecycle is greppable.
 *
 * Decoupling: the class takes a `recoverFn` in its deps rather than pulling
 * in server.ts. The existing `recoverCompactedSession` helper is passed
 * straight through, which keeps message-bus / topic-routing concerns out
 * of this file.
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { findNewestRolloutSync } from '../providers/adapters/openai-codex/observability/sessionPaths.js';
import { findNewestGeminiSessionSync } from '../providers/adapters/gemini-cli/observability/sessionPaths.js';

export type CompactionTrigger = 'PreCompact' | 'watchdog-poll' | 'recovery-hook' | string;

export type CompactionStatus =
  | 'pending-inject'    // state created; first inject dispatched
  | 'verifying'         // inject done, waiting for verify-window to elapse
  | 'deferring'         // session is actively working; waiting WITHOUT re-injecting
  | 'retrying'          // verification failed, scheduling next attempt
  | 'recovered'         // session produced output → success
  | 'failed';           // max attempts exhausted without recovery

export interface RecoveryState {
  sessionName: string;
  trigger: CompactionTrigger;
  detectedAt: number;
  attempts: number;
  /** Times we deferred an inject because the session was actively working. */
  workingDefers: number;
  lastInjectAt: number;
  baselineJsonlPath: string | null;
  baselineJsonlSize: number | null;
  baselineJsonlMtime: number | null;
  status: CompactionStatus;
}

export interface CompactionSentinelDeps {
  /**
   * Actually perform a recovery injection on a session. The sentinel uses this
   * rather than talking to SessionManager directly so topic/channel routing
   * stays in server.ts. Returns whether the injection was accepted.
   */
  recoverFn: (sessionName: string, triggerLabel: string) => Promise<boolean>;

  /**
   * Project directory, used to locate Claude Code's JSONL files for the
   * verification check. Usually `config.projectDir`.
   */
  projectDir: string;

  /**
   * Resolve a session's Claude Code session UUID (from hook events). When
   * present, the sentinel reads the jsonl file named exactly `<uuid>.jsonl`
   * instead of falling back to most-recently-modified — which prevents
   * false positives where a sibling session's output makes this one look
   * recovered. Return undefined for sessions whose uuid isn't known yet.
   */
  getClaudeSessionId?: (sessionName: string) => string | undefined;

  /**
   * Resolve a session's framework ('codex-cli' | 'claude-code' | undefined). When it
   * returns 'codex-cli', recovery-verification reads the newest codex ROLLOUT jsonl
   * (account-wide growth signal) instead of the Claude transcript. Absent/non-codex →
   * the unchanged Claude path is used (Claude behavior byte-for-byte preserved).
   */
  getSessionFramework?: (sessionName: string) => string | undefined;

  /** Override $CODEX_HOME (tests). Defaults to ~/.codex. Only used for codex sessions. */
  codexHome?: string;

  /** Override ~/.gemini (tests). Defaults to ~/.gemini. Only used for gemini-cli sessions. */
  geminiHome?: string;

  /**
   * Override for the JSONL lookup root. Primarily for tests. Defaults to
   * `$HOME/.claude/projects/<project-hash>`.
   */
  jsonlRoot?: string;

  /**
   * Defer (skip starting) a compaction recovery when this returns true — e.g.
   * a rate-limit recovery already owns this session. Prevents two sentinels
   * injecting into one pane concurrently. Default: never defer.
   */
  deferIf?: (sessionName: string) => boolean;

  /**
   * Is the session actively working RIGHT NOW (mid-turn)? When this returns
   * true the sentinel will NOT inject/re-inject a recovery prompt — it waits
   * another verify window instead, up to `maxWorkingDefers`. This is the fix
   * for the false "session is restarting" loop: a long extended-think on a
   * large context writes nothing to the JSONL until the turn lands, so the
   * no-growth check used to read it as "stuck" and re-inject, burying the
   * user's real message under stacked recovery bootstraps. Wired in server.ts
   * to SessionManager.isSessionActivelyWorking. When undefined, behavior is
   * unchanged (never defers) — so this is purely additive.
   */
  isActivelyWorking?: (sessionName: string) => boolean;

  /** Override for Date.now — for tests. */
  now?: () => number;

  /** Override timer setters — for tests. */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface CompactionSentinelConfig {
  /** Ignore repeat reports for the same session within this window. */
  dedupeWindowMs?: number;
  /** How long to wait after injection before verifying output. */
  verifyWindowMs?: number;
  /** Max inject attempts before declaring failure. */
  maxInjectAttempts?: number;
  /** Max total time a recovery can block the zombie-killer. */
  recoveryGuardMs?: number;
  /**
   * Max consecutive times a recovery may defer an inject because the session
   * is actively working (mid-turn). Each defer waits one `verifyWindowMs`
   * WITHOUT re-injecting. Bounds the wait for a session whose "working" footer
   * is genuinely hung — after the cap, normal inject/retry resumes. Set to 0
   * to disable deferral entirely (restores pre-fix behavior).
   */
  maxWorkingDefers?: number;
}

const DEFAULTS = {
  dedupeWindowMs: 60_000,          // 1 minute — catch overlapping triggers
  verifyWindowMs: 25_000,          // 25s — enough for claude to boot past recovery hook and emit output
  maxInjectAttempts: 3,
  recoveryGuardMs: 10 * 60_000,    // 10 minutes — protection from zombie-killer
  maxWorkingDefers: 10,            // up to 10×verifyWindowMs (~4min) of "actively working" before forcing an inject
};

export interface CompactionSentinelEvents {
  'compaction:detected': [RecoveryState];
  'compaction:inject-attempted': [RecoveryState & { accepted: boolean }];
  'compaction:deferred': [RecoveryState];
  'compaction:recovered': [RecoveryState & { jsonlDelta: number }];
  'compaction:failed': [RecoveryState & { reason: string }];
}

export class CompactionSentinel extends EventEmitter {
  private readonly deps: CompactionSentinelDeps;
  private readonly cfg: Required<CompactionSentinelConfig>;
  private readonly active = new Map<string, RecoveryState>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly recentReports = new Map<string, number>(); // sessionName → lastReportedAt
  private deferIf?: (sessionName: string) => boolean;

  constructor(deps: CompactionSentinelDeps, config: CompactionSentinelConfig = {}) {
    super();
    this.deps = deps;
    this.deferIf = deps.deferIf;
    this.cfg = {
      dedupeWindowMs: config.dedupeWindowMs ?? DEFAULTS.dedupeWindowMs,
      verifyWindowMs: config.verifyWindowMs ?? DEFAULTS.verifyWindowMs,
      maxInjectAttempts: config.maxInjectAttempts ?? DEFAULTS.maxInjectAttempts,
      recoveryGuardMs: config.recoveryGuardMs ?? DEFAULTS.recoveryGuardMs,
      maxWorkingDefers: config.maxWorkingDefers ?? DEFAULTS.maxWorkingDefers,
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
   * Report a compaction event for a session. Called by all three trigger paths
   * (PreCompact hook, watchdog poll, recovery-hook endpoint). Deduped — if the
   * same session is already in active recovery or was reported within the
   * dedupe window, this is a no-op.
   */
  report(sessionName: string, trigger: CompactionTrigger): void {
    const now = this.now();

    if (this.active.has(sessionName)) {
      return; // Recovery already in flight — ignore duplicate trigger.
    }
    if (this.deferIf?.(sessionName)) {
      return; // Another recovery (e.g. rate-limit) owns this session — bidirectional defer.
    }
    const lastReport = this.recentReports.get(sessionName);
    if (lastReport && now - lastReport < this.cfg.dedupeWindowMs) {
      return; // Already reported recently.
    }
    this.recentReports.set(sessionName, now);

    const baseline = this.readJsonlBaseline(sessionName);
    const state: RecoveryState = {
      sessionName,
      trigger,
      detectedAt: now,
      attempts: 0,
      workingDefers: 0,
      lastInjectAt: 0,
      baselineJsonlPath: baseline?.path ?? null,
      baselineJsonlSize: baseline?.size ?? null,
      baselineJsonlMtime: baseline?.mtime ?? null,
      status: 'pending-inject',
    };
    this.active.set(sessionName, state);

    console.log(
      `[Sentinel] detected compaction on "${sessionName}" via ${trigger}; ` +
      `baseline jsonl: ${state.baselineJsonlPath ? path.basename(state.baselineJsonlPath) : 'none'} ` +
      `size=${state.baselineJsonlSize ?? 'n/a'}`,
    );
    this.emit('compaction:detected', state);
    this.attemptInjection(state);
  }

  /**
   * Predicate for SessionManager's zombie-killer: is this session currently
   * being recovered? If yes, the zombie-killer should skip it.
   */
  isRecoveryActive(sessionName: string): boolean {
    const state = this.active.get(sessionName);
    if (!state) return false;
    // Don't claim active for terminal states (defense in depth).
    return state.status !== 'recovered' && state.status !== 'failed';
  }

  /**
   * Manually clear recovery state. Used when the session completes or is
   * explicitly reset. Exposed mainly for tests and edge cases.
   */
  clear(sessionName: string): void {
    const timer = this.timers.get(sessionName);
    if (timer) {
      this.clearTimer(timer);
      this.timers.delete(sessionName);
    }
    this.active.delete(sessionName);
  }

  /** Stop all pending timers. Safe to call multiple times. */
  stop(): void {
    for (const handle of this.timers.values()) this.clearTimer(handle);
    this.timers.clear();
    this.active.clear();
    this.recentReports.clear();
  }

  /** Get current active recovery state (test introspection). */
  getState(sessionName: string): RecoveryState | undefined {
    return this.active.get(sessionName);
  }

  private async attemptInjection(state: RecoveryState): Promise<void> {
    // Gate: never inject into an actively-working session. Re-injecting a
    // recovery prompt while Claude is mid-turn buries the user's real message
    // under stacked recovery bootstraps — the false "session is restarting"
    // loop. Defer one verify window and re-check, bounded by maxWorkingDefers.
    if (this.deferForActiveWork(state)) return;

    state.attempts += 1;
    state.lastInjectAt = this.now();
    state.status = 'pending-inject';

    let accepted = false;
    try {
      accepted = await this.deps.recoverFn(state.sessionName, state.trigger);
    } catch (err) {
      console.warn(`[Sentinel] recoverFn threw on "${state.sessionName}" (attempt ${state.attempts}):`, err);
    }

    console.log(
      `[Sentinel] inject-attempted on "${state.sessionName}" ` +
      `(attempt ${state.attempts}/${this.cfg.maxInjectAttempts}, accepted=${accepted})`,
    );
    this.emit('compaction:inject-attempted', { ...state, accepted });

    if (!accepted) {
      // recoverFn returned false — typically means no unanswered user message,
      // session not alive, or injection blocked. No point retrying; close out.
      this.finalize(state, 'failed', 'recoverFn declined (no pending work or session gone)');
      return;
    }

    state.status = 'verifying';
    this.scheduleVerify(state);
  }

  /**
   * If the session is actively working (mid-turn) and we haven't exhausted the
   * defer budget, record a defer, schedule another verify window WITHOUT
   * injecting, and return true (the caller must return). Otherwise return false
   * and let the caller proceed with its normal inject/retry/fail path.
   *
   * This is the heart of the busy-session guard: a long extended-think on a
   * large context emits nothing to the JSONL until the turn lands, so the
   * no-growth check would otherwise read it as "stuck" and re-inject — burying
   * the user's real message. Deferring waits it out instead, and the cap means
   * a genuinely-hung "working" footer still gets a forced inject eventually.
   */
  private deferForActiveWork(state: RecoveryState): boolean {
    if (!this.deps.isActivelyWorking?.(state.sessionName)) return false;
    if (state.workingDefers >= this.cfg.maxWorkingDefers) return false;

    state.workingDefers += 1;
    state.status = 'deferring';
    console.log(
      `[Sentinel] "${state.sessionName}" actively working — deferring inject ` +
      `(defer ${state.workingDefers}/${this.cfg.maxWorkingDefers}); NOT re-injecting`,
    );
    this.emit('compaction:deferred', { ...state });
    this.scheduleVerify(state);
    return true;
  }

  /** Schedule one verify pass after the verify window. */
  private scheduleVerify(state: RecoveryState): void {
    const handle = this.setTimer(() => {
      this.verifyRecovery(state).catch(err => {
        console.warn(`[Sentinel] verify threw on "${state.sessionName}":`, err);
        this.finalize(state, 'failed', `verify threw: ${String(err)}`);
      });
    }, this.cfg.verifyWindowMs);
    this.timers.set(state.sessionName, handle);
  }

  private async verifyRecovery(state: RecoveryState): Promise<void> {
    this.timers.delete(state.sessionName);

    // Has the jsonl file grown? If so, claude processed the prompt and emitted.
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
      console.log(
        `[Sentinel] recovered "${state.sessionName}" after ${state.attempts} attempt(s) ` +
        `(jsonl grew by ${delta} bytes)`,
      );
      this.emit('compaction:recovered', { ...state, jsonlDelta: delta });
      this.finalize(state, 'recovered');
      return;
    }

    // No growth — but the session may be mid-turn (a long extended-think that
    // hasn't emitted to the JSONL yet, or a turn that began right at the verify
    // boundary). Re-injecting now would trample it. Defer and re-verify instead
    // of re-injecting OR failing. Bounded by maxWorkingDefers.
    if (this.deferForActiveWork(state)) return;

    // Genuinely not progressing and not working — session didn't respond.
    if (state.attempts >= this.cfg.maxInjectAttempts) {
      this.finalize(
        state,
        'failed',
        `no jsonl growth after ${state.attempts} attempts (${state.attempts * this.cfg.verifyWindowMs}ms total wait)`,
      );
      return;
    }

    // Retry.
    state.status = 'retrying';
    console.log(
      `[Sentinel] retry "${state.sessionName}" ` +
      `(attempt ${state.attempts}/${this.cfg.maxInjectAttempts} produced no output, re-injecting)`,
    );
    await this.attemptInjection(state);
  }

  private finalize(state: RecoveryState, status: 'recovered' | 'failed', reason?: string): void {
    state.status = status;
    if (status === 'failed') {
      console.warn(`[Sentinel] failed "${state.sessionName}": ${reason ?? 'unknown'}`);
      this.emit('compaction:failed', { ...state, reason: reason ?? 'unknown' });
    }
    // Keep the state around just long enough to exit the recovery-guard window
    // (so the zombie-killer won't race the next prompt). Then clean up.
    // Also clear the recentReports entry so a *new* compaction on this session
    // can trigger a fresh recovery, even if the second compaction happens
    // within the dedupe window of the first. Without this, the second
    // compaction would be silently suppressed.
    const keepFor = status === 'recovered' ? 5_000 : 30_000;
    const handle = this.setTimer(() => {
      this.timers.delete(state.sessionName);
      this.active.delete(state.sessionName);
      this.recentReports.delete(state.sessionName);
    }, keepFor);
    this.timers.set(state.sessionName, handle);
  }

  /**
   * Look up the JSONL file for this session. Prefers the exact file by
   * Claude Code session UUID when known (prevents a sibling session's
   * activity from looking like this session recovered). Falls back to the
   * most recently-modified file in the project's jsonl root.
   */
  private readJsonlBaseline(sessionName: string): { path: string; size: number; mtime: number } | null {
    // Codex parity: a codex session's transcript is the newest rollout JSONL under
    // $CODEX_HOME/sessions, NOT the Claude projects tree. Compaction-recovery is verified
    // by post-recovery output, and for codex "the account is producing output again" ==
    // "the newest rollout grew" (the OpenAI account-wide signal). Only taken for codex
    // sessions; everything else falls through to the unchanged Claude path (Claude
    // behavior byte-for-byte preserved). Mirrors the RateLimitSentinel codex fix (#33).
    if (this.deps.getSessionFramework?.(sessionName) === 'codex-cli') {
      return findNewestRolloutSync(this.deps.codexHome);
    }
    // Gemini parity (apprenticeship Step 2 §4.0.2): a gemini session's transcript
    // is the newest session file under ~/.gemini/tmp/<hash>/chats. Compaction-
    // recovery is verified by post-recovery output growth; for gemini "producing
    // output again" == "the newest gemini session file grew". Only taken for
    // gemini sessions; everything else falls through to the unchanged Claude path
    // (Claude behavior byte-for-byte preserved). Mirrors the codex fix (#33).
    if (this.deps.getSessionFramework?.(sessionName) === 'gemini-cli') {
      return findNewestGeminiSessionSync(this.deps.geminiHome);
    }
    try {
      const root = this.deps.jsonlRoot
        || path.join(process.env.HOME || '/tmp', '.claude', 'projects',
                     this.deps.projectDir.replace(/\//g, '-'));
      if (!fs.existsSync(root)) return null;

      // Prefer the exact file by claudeSessionId when available.
      const uuid = this.deps.getClaudeSessionId?.(sessionName);
      if (uuid) {
        const exact = path.join(root, `${uuid}.jsonl`);
        if (fs.existsSync(exact)) {
          const st = fs.statSync(exact);
          return { path: exact, size: st.size, mtime: st.mtimeMs };
        }
        // Stale claudeSessionId: the stored UUID has no transcript on disk
        // (conversation rotated via respawn/--resume and the record lagged).
        // The old "return null — the session genuinely has no jsonl" reasoning
        // assumed the mapping was always fresh; a write-once bridge made it
        // permanently stale instead, so null here meant recovery verification
        // could NEVER succeed (2026-06-06 false-escalation incident, mirrored
        // in RateLimitSentinel). Degrade to the same newest-jsonl heuristic
        // the no-uuid case already uses.
        console.log(
          `[CompactionSentinel] stale claudeSessionId for "${sessionName}" ` +
          `(${uuid}.jsonl missing) — falling back to newest jsonl in project root`,
        );
      }

      // Fallback: most-recently-modified jsonl in the project.
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

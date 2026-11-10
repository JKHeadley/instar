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
import { DegradationReporter } from './DegradationReporter.js';
import { findNewestRolloutSync } from '../providers/adapters/openai-codex/observability/sessionPaths.js';
import { findNewestGeminiSessionSync } from '../providers/adapters/gemini-cli/observability/sessionPaths.js';

export type CompactionTrigger = 'PreCompact' | 'watchdog-poll' | 'recovery-hook' | string;

export type CompactionStatus =
  | 'pending-inject'    // state created; first inject dispatched
  | 'verifying'         // inject done, waiting for verify-window to elapse
  | 'deferring'         // session is actively working; waiting WITHOUT re-injecting
  | 'awaiting-seed'     // waiting for the SessionStart(compact) hook's seeded marker
  | 'awaiting-idle'     // fallback staged durably; released only at an idle, ready prompt
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
   * Returns false when this session is NOT a legitimate recovery target — unknown,
   * or status ∈ {completed, failed, killed}, or no longer in the running set. The
   * `PreCompact` trigger reports EVERY session in the topic→session map (including
   * finished ones the map never cleaned up), so without this guard a finished
   * session gets a recovery injected against it. Dep ABSENT ⇒ today's behavior.
   * (Companion to the same guard on RateLimitSentinel — live incident 2026-06-24.)
   */
  isSessionRecoverable?: (sessionName: string) => boolean;

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

  /**
   * One carrier of post-compaction context (context-budget-layered-summaries
   * §9.1). Is compaction recovery switched on for this machine
   * (`contextBudget.compactionRecovery.enabled`)? Off or absent ⇒ today's path
   * unchanged: no seed wait, the server injects as before.
   */
  isCompactionRecoveryEnabled?: () => boolean;

  /**
   * Read the seeded marker the SessionStart(compact) hook writes after its
   * recovery seed succeeded (`state/context-layers/_seeded/<claudeSessionId>.json`).
   * Returns null when there is none. Absent ⇒ no seed wait.
   */
  readSeedMarker?: (sessionName: string) => { seededAt: number; epoch: string } | null;

  /**
   * The idle-gated, durable server fallback (context-budget-layered-summaries
   * §9.1): when the seed wait ends without a seeded marker, the recovery text
   * is staged in PendingInjectStore and released only when the session is not
   * actively working AND its pane shows a ready prompt, re-checked every tick
   * within `fallbackIdleBoundMs`; one delivery per compaction epoch, never a
   * retry. Absent ⇒ the fallback is today's `attemptInjection` path.
   */
  fallback?: CompactionFallbackDeps;

  /** Override for Date.now — for tests. */
  now?: () => number;

  /** Override timer setters — for tests. */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

/** A staged fallback as the durable store holds it. */
export interface StagedCompactionFallback {
  tmuxSession: string;
  epoch: string;
  trigger: string;
  text: string;
  stagedAt: number;
  /** This compaction's compact-boundary time, when one was seen (late-seed freshness). */
  boundaryAt?: number;
}

export interface CompactionFallbackDeps {
  /**
   * Build the recovery text for a session. `declined` = nothing to recover
   * (no unanswered user message); `unsupported` = this session's channel has
   * no idle-gated builder yet, so today's `recoverFn` path runs instead.
   */
  build(sessionName: string, trigger: string): Promise<{ text: string } | 'declined' | 'unsupported'>;
  /** Durably stage the text (survives a restart). */
  stage(rec: StagedCompactionFallback): void;
  /** Remove a session's staged fallback. */
  clear(tmuxSession: string): void;
  /** Every staged fallback (boot resume). */
  list(): StagedCompactionFallback[];
  /** Does the pane show a ready prompt right now? (`classifyPaneState === 'ready'`) */
  isReadyPrompt(sessionName: string): boolean;
  /** Type the text into the session. Returns whether it was accepted. */
  inject(sessionName: string, text: string): boolean;
  /** Is another (initial-message) inject pending for this session? It goes first. */
  otherInjectPending?(sessionName: string): boolean;
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
  /**
   * How long after compaction completed (the transcript's compact-boundary
   * entry) to wait for the hook's seeded marker before the server path runs.
   */
  seedWaitMs?: number;
  /**
   * Upper bound on the seed wait while no compact-boundary entry has appeared
   * yet (a PreCompact report arrives before the compaction itself finishes).
   */
  seedMaxWaitMs?: number;
  /** Poll interval while awaiting the seeded marker. */
  seedPollMs?: number;
  /** How long a staged fallback waits for an idle, ready prompt before standing down. */
  fallbackIdleBoundMs?: number;
  /** A staged fallback older than this at boot is reported lost, never delivered. */
  fallbackResumeMaxAgeMs?: number;
}

const DEFAULTS = {
  dedupeWindowMs: 60_000,          // 1 minute — catch overlapping triggers
  verifyWindowMs: 25_000,          // 25s — enough for claude to boot past recovery hook and emit output
  maxInjectAttempts: 3,
  recoveryGuardMs: 10 * 60_000,    // 10 minutes — protection from zombie-killer
  maxWorkingDefers: 10,            // up to 10×verifyWindowMs (~4min) of "actively working" before forcing an inject
  seedWaitMs: 30_000,              // spec §9.1: 30 s after the compact-boundary entry
  seedMaxWaitMs: 180_000,          // a compaction still running after 3 min falls back to the server path
  seedPollMs: 2_000,
  fallbackIdleBoundMs: 5 * 60_000, // the same order as the working-defer budget (10 × 25 s)
  fallbackResumeMaxAgeMs: 15 * 60_000, // older than this, the conversation has moved on
};

/** Accept a marker or boundary written up to this long before the report (watchdog reports late). */
const SEED_LOOKBACK_MS = 120_000;

export interface CompactionSentinelEvents {
  'compaction:detected': [RecoveryState];
  'compaction:inject-attempted': [RecoveryState & { accepted: boolean }];
  'compaction:deferred': [RecoveryState];
  'compaction:seeded': [RecoveryState & { epoch: string }];
  'compaction:recovered': [RecoveryState & { jsonlDelta: number }];
  'compaction:failed': [RecoveryState & { reason: string }];
  'compaction:fallback-staged': [RecoveryState & { epoch: string }];
}

export class CompactionSentinel extends EventEmitter {
  private readonly deps: CompactionSentinelDeps;
  private readonly cfg: Required<CompactionSentinelConfig>;
  private readonly active = new Map<string, RecoveryState>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly recentReports = new Map<string, number>(); // sessionName → lastReportedAt
  private deferIf?: (sessionName: string) => boolean;
  /** sessionName → seededAt of the last hook marker that already covered a compaction (idempotence). */
  private readonly consumedSeedAt = new Map<string, number>();
  /** sessionName → compaction epoch whose server fallback was already delivered (one per epoch). */
  private readonly deliveredFallback = new Map<string, { epoch: string; at: number }>();
  /** Sessions whose current recovery is a once-only fallback delivery (verify never re-injects). */
  private readonly onceOnly = new Set<string>();

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
      seedWaitMs: config.seedWaitMs ?? DEFAULTS.seedWaitMs,
      seedMaxWaitMs: config.seedMaxWaitMs ?? DEFAULTS.seedMaxWaitMs,
      seedPollMs: config.seedPollMs ?? DEFAULTS.seedPollMs,
      fallbackIdleBoundMs: config.fallbackIdleBoundMs ?? DEFAULTS.fallbackIdleBoundMs,
      fallbackResumeMaxAgeMs: config.fallbackResumeMaxAgeMs ?? DEFAULTS.fallbackResumeMaxAgeMs,
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
    // A finished/killed session is never a recovery target. The PreCompact trigger
    // enumerates the whole topic→session map (which is not cleaned up on completion),
    // so a finished session can be reported here; injecting a recovery into it is the
    // false-positive class this guard closes (live incident 2026-06-24).
    if (this.deps.isSessionRecoverable && !this.deps.isSessionRecoverable(sessionName)) {
      console.log(`[Sentinel] ignoring ${trigger} for "${sessionName}" — not a live recovery target (finished/killed/unknown)`);
      return;
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
    if (this.seedWaitApplies(sessionName)) {
      state.status = 'awaiting-seed';
      this.awaitSeed(state);
      return;
    }
    this.attemptInjection(state);
  }

  /**
   * The seed wait applies only with the switch on, a marker reader wired, and a
   * Claude Code session (other engines have no SessionStart(compact) seed yet).
   */
  private seedWaitApplies(sessionName: string): boolean {
    if (!this.deps.readSeedMarker || !this.deps.isCompactionRecoveryEnabled) return false;
    let enabled = false;
    try { enabled = this.deps.isCompactionRecoveryEnabled(); } catch { enabled = false; /* @silent-fallback-ok — an unreadable switch means no seed wait: the server sends its own recovery (today's path) */ }
    if (!enabled) return false;
    const fw = this.deps.getSessionFramework?.(sessionName);
    return fw === undefined || fw === 'claude-code';
  }

  /**
   * Wait for the hook's seeded marker for this compaction. Seeded ⇒ the session
   * already has its recovery context; the server stands down (one carrier).
   * No marker within the bound ⇒ today's server path runs once.
   */
  private awaitSeed(state: RecoveryState): void {
    if (this.active.get(state.sessionName) !== state) return; // cleared meanwhile
    const now = this.now();
    let marker: { seededAt: number; epoch: string } | null = null;
    try { marker = this.deps.readSeedMarker!(state.sessionName); } catch { marker = null; /* @silent-fallback-ok — no readable marker means "not seeded": the server delivers the recovery itself */ }
    const consumed = this.consumedSeedAt.get(state.sessionName) ?? -Infinity;
    const boundary = this.readCompactBoundary(state, consumed);
    // The marker must belong to THIS compaction (second-pass review, slice 2):
    //  - newer than any marker already consumed for this session;
    //  - written after this compaction's boundary entry (2 s clock slack; the
    //    hook runs once compaction completes, before the entry is flushed), or,
    //    while that boundary is not yet visible, after this report itself.
    // The hook writes an empty epoch (it cannot see this compaction's boundary);
    // the epoch is bound here to the boundary entry's id (§7.7).
    const markerFresh = marker !== null
      && marker.seededAt > consumed
      && (boundary
        ? marker.seededAt >= boundary.at - 2_000
        : marker.seededAt >= state.detectedAt - this.lookbackFor(state));
    if (marker && markerFresh) {
      const key = boundary?.uuid || marker.epoch || `t${marker.seededAt}`;
      this.consumedSeedAt.set(state.sessionName, marker.seededAt);
      console.log(`[Sentinel] "${state.sessionName}" seeded by its compaction hook (epoch ${key}); server recovery stands down`);
      this.emit('compaction:seeded', { ...state, epoch: key });
      this.finalize(state, 'recovered');
      return;
    }
    const boundaryAt = boundary ? boundary.at : null;
    const deadline = boundaryAt !== null
      ? Math.max(boundaryAt, state.detectedAt) + this.cfg.seedWaitMs
      : state.detectedAt + this.cfg.seedMaxWaitMs;
    if (now >= deadline) {
      console.log(
        `[Sentinel] no hook seed for "${state.sessionName}" ` +
        `(${boundaryAt !== null ? 'compaction finished' : 'no compact boundary seen'}); server recovery runs`,
      );
      state.status = 'pending-inject';
      if (this.deps.fallback) {
        void this.startFallback(state, boundary?.uuid || `t${state.detectedAt}`, boundary ? boundary.at : null);
        return;
      }
      this.attemptInjection(state);
      return;
    }
    const handle = this.setTimer(() => {
      this.timers.delete(state.sessionName);
      this.awaitSeed(state);
    }, Math.min(this.cfg.seedPollMs, Math.max(1, deadline - now)));
    this.timers.set(state.sessionName, handle);
  }

  /**
   * §9.1 server fallback, once per compaction epoch: build the text, stage it
   * durably, then release it only at an idle, ready prompt (tickFallback).
   * `boundaryAt` is this compaction's compact-boundary time when one was seen.
   */
  private async startFallback(state: RecoveryState, epoch: string, boundaryAt: number | null): Promise<void> {
    const fb = this.deps.fallback!;
    const name = state.sessionName;
    const prior = this.deliveredFallback.get(name);
    // Once per epoch. Without a boundary the epoch is only `t<detectedAt>`, so a
    // delivery in the last window with no newer boundary also counts as this one.
    if (prior && (prior.epoch === epoch
      || (boundaryAt === null && this.now() - prior.at < this.cfg.seedMaxWaitMs + this.cfg.fallbackIdleBoundMs))) {
      console.log(`[Sentinel] fallback for "${name}" (epoch ${epoch}) already delivered; not again`);
      this.finalize(state, 'recovered');
      return;
    }
    let built: { text: string } | 'declined' | 'unsupported';
    try {
      built = await fb.build(name, state.trigger);
    } catch (err) {
      console.warn(`[Sentinel] fallback build threw on "${name}":`, err);
      DegradationReporter.getInstance().report({
        feature: 'CompactionSentinel.fallback',
        primary: 'Build the post-compaction briefing for an idle-gated, durable delivery',
        fallback: 'Plain recovery injection (the pre-fallback path)',
        reason: `fallback build threw: ${err instanceof Error ? err.message : String(err)}`,
        impact: 'The session gets the older, plainer recovery prompt after this compaction.',
      });
      built = 'unsupported';
    }
    if (this.active.get(name) !== state) return; // cleared meanwhile
    if (built === 'unsupported') {
      this.attemptInjection(state);
      return;
    }
    if (built === 'declined') {
      this.finalize(state, 'failed', 'recoverFn declined (no pending work or session gone)');
      return;
    }
    const staged: StagedCompactionFallback = {
      tmuxSession: name, epoch, trigger: state.trigger, text: built.text, stagedAt: this.now(),
      ...(boundaryAt !== null ? { boundaryAt } : {}),
    };
    try { fb.stage(staged); } catch (err) {
      console.warn(`[Sentinel] fallback stage failed on "${name}" (delivering without durability):`, err);
      DegradationReporter.getInstance().report({
        feature: 'CompactionSentinel.fallback',
        primary: 'Stage the post-compaction briefing durably before waiting for idle',
        fallback: 'Hold it in memory only',
        reason: `stage failed: ${err instanceof Error ? err.message : String(err)}`,
        impact: 'A server restart before delivery would lose this briefing.',
      });
    }
    state.status = 'awaiting-idle';
    console.log(`[Sentinel] fallback staged for "${name}" (epoch ${epoch}); waiting for an idle, ready prompt`);
    this.emit('compaction:fallback-staged', { ...state, epoch });
    void this.tickFallback(state, staged, this.now() + this.cfg.fallbackIdleBoundMs);
  }

  /** Same freshness rule as awaitSeed: the marker must belong to THIS compaction. */
  private seedMarkerCovers(state: RecoveryState, staged: StagedCompactionFallback): boolean {
    let marker: { seededAt: number; epoch: string } | null = null;
    try { marker = this.deps.readSeedMarker?.(state.sessionName) ?? null; } catch { marker = null; /* @silent-fallback-ok — unreadable marker reads as "not seeded", so the staged fallback is kept, never dropped */ }
    if (!marker) return false;
    const consumed = this.consumedSeedAt.get(state.sessionName) ?? -Infinity;
    if (!(marker.seededAt > consumed)) return false;
    const fresh = staged.boundaryAt !== undefined
      ? marker.seededAt >= staged.boundaryAt - 2_000
      : marker.seededAt >= state.detectedAt - this.lookbackFor(state);
    if (fresh) this.consumedSeedAt.set(state.sessionName, marker.seededAt);
    return fresh;
  }

  private async tickFallback(state: RecoveryState, staged: StagedCompactionFallback, deadline: number): Promise<void> {
    if (this.active.get(state.sessionName) !== state) return;
    const fb = this.deps.fallback!;
    const name = state.sessionName;
    // A late hook seed for this compaction makes the fallback unnecessary.
    if (this.seedMarkerCovers(state, staged)) {
      fb.clear(name);
      console.log(`[Sentinel] late hook seed for "${name}" (epoch ${staged.epoch}); staged fallback withdrawn`);
      this.emit('compaction:seeded', { ...state, epoch: staged.epoch });
      this.finalize(state, 'recovered');
      return;
    }
    if (this.deps.isSessionRecoverable && !this.deps.isSessionRecoverable(name)) {
      fb.clear(name);
      this.finalize(state, 'failed', 'session ended before an idle moment');
      return;
    }
    let working = false;
    let ready = false;
    try { working = this.deps.isActivelyWorking?.(name) ?? false; } catch { working = false; /* @silent-fallback-ok — the ready-prompt check below still gates delivery */ }
    // One injector at a time: a pending initial-message inject for this session
    // (e.g. the boot sweep's re-delivery) goes first.
    let otherPending = false;
    try { otherPending = fb.otherInjectPending?.(name) ?? false; } catch { otherPending = false; /* @silent-fallback-ok — the ready-prompt check below still gates delivery */ }
    try { ready = !working && !otherPending && fb.isReadyPrompt(name); } catch { ready = false; /* @silent-fallback-ok — not provably idle means keep waiting (bounded by the idle deadline) */ }
    if (ready) {
      // Re-check at release, not just at stage time: the session may have
      // answered the user while we waited (the text names an unanswered message).
      let fresh: { text: string } | 'declined' | 'unsupported' | null = null;
      try { fresh = await fb.build(name, state.trigger); } catch (err) {
        // A builder error is not an answer: keep waiting and try again next tick.
        // @silent-fallback-ok — retried on the next tick; the idle deadline bounds it.
        console.warn(`[Sentinel] fallback rebuild threw on "${name}"; retrying next tick:`, err);
      }
      if (this.active.get(name) !== state) return;
      if (fresh === null) {
        this.scheduleFallbackTick(state, staged, deadline);
        return;
      }
      if (typeof fresh !== 'object') {
        fb.clear(name);
        console.log(`[Sentinel] "${name}" no longer needs the fallback at release (${fresh}); withdrawn`);
        this.finalize(state, fresh === 'declined' ? 'recovered' : 'failed', `fallback withdrawn at release: ${fresh}`);
        return;
      }
      state.attempts += 1;
      state.lastInjectAt = this.now();
      // The verify baseline is the transcript as it stands now, so the
      // compaction's own writes do not count as a response.
      const baseline = this.readJsonlBaseline(name);
      state.baselineJsonlPath = baseline?.path ?? state.baselineJsonlPath;
      state.baselineJsonlSize = baseline?.size ?? state.baselineJsonlSize;
      state.baselineJsonlMtime = baseline?.mtime ?? state.baselineJsonlMtime;
      let accepted = false;
      try { accepted = fb.inject(name, fresh.text); } catch (err) {
        console.warn(`[Sentinel] fallback inject threw on "${name}":`, err);
        DegradationReporter.getInstance().report({
          feature: 'CompactionSentinel.fallback',
          primary: 'Deliver the post-compaction briefing at an idle prompt',
          fallback: 'None: the recovery is recorded as failed',
          reason: `inject threw: ${err instanceof Error ? err.message : String(err)}`,
          impact: 'This compaction ends without a briefing; the session continues from its compacted summary.',
        });
      }
      fb.clear(name);
      this.emit('compaction:inject-attempted', { ...state, accepted });
      if (!accepted) {
        this.finalize(state, 'failed', 'fallback inject not accepted');
        return;
      }
      this.deliveredFallback.set(name, { epoch: staged.epoch, at: this.now() });
      console.log(`[Sentinel] fallback delivered to "${name}" at an idle prompt (epoch ${staged.epoch})`);
      this.onceOnly.add(name);
      state.status = 'verifying';
      this.scheduleVerify(state);
      return;
    }
    if (this.now() >= deadline) {
      fb.clear(name);
      if (working) {
        // Alive and working for the whole bound: it resumed on its own (same
        // stand-down as the working-defer budget); never interrupt a live turn.
        console.log(`[Sentinel] "${name}" worked through the fallback bound; standing down, fallback withdrawn`);
        this.emit('compaction:recovered', { ...state, jsonlDelta: 0 });
        this.finalize(state, 'recovered');
      } else {
        this.finalize(state, 'failed', 'no idle, ready prompt within the fallback bound');
      }
      return;
    }
    this.scheduleFallbackTick(state, staged, deadline);
  }

  private scheduleFallbackTick(state: RecoveryState, staged: StagedCompactionFallback, deadline: number): void {
    const name = state.sessionName;
    const handle = this.setTimer(() => {
      this.timers.delete(name);
      void this.tickFallback(state, staged, deadline);
    }, Math.min(this.cfg.seedPollMs, Math.max(1, deadline - this.now())));
    this.timers.set(name, handle);
  }

  /**
   * Boot resume (§9.1): a fallback staged before a restart is picked up again
   * under the same idle gate, within what is left of its original bound. Too
   * old, a session that is gone, the switch now off, or another recovery
   * already owning the session ⇒ withdrawn and returned for loss reporting.
   * Never delivers ungated.
   */
  resumeStagedFallbacks(): { resumed: string[]; withdrawn: Array<{ tmuxSession: string; reason: string }> } {
    const out = { resumed: [] as string[], withdrawn: [] as Array<{ tmuxSession: string; reason: string }> };
    const fb = this.deps.fallback;
    if (!fb) return out;
    let staged: StagedCompactionFallback[] = [];
    try { staged = fb.list(); } catch (err) {
      staged = [];
      DegradationReporter.getInstance().report({
        feature: 'CompactionSentinel.fallback',
        primary: 'Resume staged post-compaction briefings at boot',
        fallback: 'Resume none this boot',
        reason: `staged list unreadable: ${err instanceof Error ? err.message : String(err)}`,
        impact: 'A briefing staged before the restart is not delivered.',
      });
    }
    let enabled = false;
    try { enabled = this.deps.isCompactionRecoveryEnabled?.() ?? false; } catch { enabled = false; /* @silent-fallback-ok — unreadable switch at boot withdraws staged briefings loudly (each withdrawal is reported) */ }
    for (const rec of staged) {
      const name = rec.tmuxSession;
      const age = this.now() - rec.stagedAt;
      let reason: string | null = null;
      if (!enabled) reason = 'compaction recovery is switched off';
      else if (!Number.isFinite(age) || age > this.cfg.fallbackResumeMaxAgeMs) reason = 'staged too long ago';
      else if (this.deps.isSessionRecoverable && !this.deps.isSessionRecoverable(name)) reason = 'session no longer running';
      else if (this.active.has(name)) reason = 'a newer recovery already owns the session';
      if (reason) {
        if (reason !== 'a newer recovery already owns the session') fb.clear(name);
        out.withdrawn.push({ tmuxSession: name, reason });
        continue;
      }
      const state: RecoveryState = {
        sessionName: name, trigger: (rec.trigger as CompactionTrigger), detectedAt: rec.stagedAt,
        attempts: 0, workingDefers: 0, lastInjectAt: 0,
        baselineJsonlPath: null, baselineJsonlSize: null, baselineJsonlMtime: null, status: 'awaiting-idle',
      };
      this.active.set(name, state);
      this.recentReports.set(name, this.now());
      out.resumed.push(name);
      // The bound is the original one, not a fresh 5 minutes: the record's age counts.
      const deadline = rec.stagedAt + this.cfg.fallbackIdleBoundMs;
      void this.tickFallback(state, rec, Math.max(deadline, this.now() + this.cfg.seedPollMs));
    }
    return out;
  }

  /**
   * How far before the report this compaction's evidence may lie. A PreCompact
   * report precedes the compaction, so nothing earlier belongs to it (2 s clock
   * slack); the watchdog poll and the recovery route report after the fact.
   */
  private lookbackFor(state: RecoveryState): number {
    return state.trigger === 'PreCompact' ? 2_000 : SEED_LOOKBACK_MS;
  }

  /**
   * Time and id of the newest compact-boundary entry in the session's transcript that
   * is not older than the report (minus the trigger's lookback) and newer than the
   * last consumed marker (so a compaction already handled is never re-bound), or null. The engine
   * writes this entry when compaction completes; it is the spec's anchor for
   * the seed wait.
   */
  private readCompactBoundary(state: RecoveryState, after: number): { at: number; uuid: string } | null {
    const p = state.baselineJsonlPath;
    if (!p) return null;
    try {
      const fd = fs.openSync(p, 'r');
      try {
        const size = fs.fstatSync(fd).size;
        const len = Math.min(size, 524_288);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, size - len);
        let best: { at: number; uuid: string } | null = null;
        for (const line of buf.toString('utf-8').split('\n')) {
          if (!line.includes('compact_boundary')) continue;
          try {
            const e = JSON.parse(line) as { subtype?: string; timestamp?: string; uuid?: string };
            if (e.subtype !== 'compact_boundary' || !e.timestamp) continue;
            const t = Date.parse(e.timestamp);
            if (Number.isFinite(t) && t >= state.detectedAt - this.lookbackFor(state) && t > after
              && (best === null || t > best.at)) {
              best = { at: t, uuid: typeof e.uuid === 'string' ? e.uuid : '' };
            }
          } catch { /* @silent-fallback-ok — a partial first line in the tail window is skipped, not an error */ }
        }
        return best;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return null; // @silent-fallback-ok — an unreadable transcript yields no boundary, so the marker is not trusted and the server recovers
    }
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
    this.consumedSeedAt.delete(sessionName);
    this.onceOnly.delete(sessionName);
    this.deliveredFallback.delete(sessionName);
    // A reset session's staged fallback must not be delivered later (stop() keeps
    // them on purpose: a shutdown is exactly what the boot resume is for).
    try { this.deps.fallback?.clear(sessionName); } catch { /* @silent-fallback-ok — store clear is best-effort; the boot resume ages it out */ }
  }

  /** Stop all pending timers. Safe to call multiple times. */
  stop(): void {
    for (const handle of this.timers.values()) this.clearTimer(handle);
    this.timers.clear();
    this.active.clear();
    this.recentReports.clear();
    this.consumedSeedAt.clear();
    this.onceOnly.clear();
    this.deliveredFallback.clear();
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
   * If the session is actively working (mid-turn): if we haven't exhausted the
   * defer budget, record a defer, schedule another verify window WITHOUT injecting,
   * and return true (the caller must return). If we HAVE exhausted the budget but
   * the session is STILL working, STAND DOWN (finalize self-recovered, no inject)
   * and return true — never force a resume nudge into a live, working session.
   * Only when the session is NOT actively working do we return false and let the
   * caller proceed with its normal inject/retry/fail path.
   *
   * This is the heart of the busy-session guard: a long extended-think on a
   * large context emits nothing to the JSONL until the turn lands, so the
   * no-growth check would otherwise read it as "stuck" and re-inject — burying
   * the user's real message. Deferring waits it out; and crucially, exhausting the
   * defer budget on a session that is STILL working is NOT a license to interrupt
   * it — we stand down. (A footer that FALSELY shows "working" while truly hung is
   * the frozen-frame silence/wedge sentinels' job, not this recovery path's.)
   */
  private deferForActiveWork(state: RecoveryState): boolean {
    if (!this.deps.isActivelyWorking?.(state.sessionName)) return false;
    // maxWorkingDefers === 0 is the explicit opt-out: "disable the working-guard,
    // inject immediately even while working." Preserve it — proceed to inject.
    if (this.cfg.maxWorkingDefers === 0) return false;
    if (state.workingDefers >= this.cfg.maxWorkingDefers) {
      // Defer budget exhausted, but the live frame STILL shows active work. Do NOT
      // force-inject: that would trample a genuinely-working session, which is the
      // recurring mid-turn "[Request interrupted by user]" on long autonomous
      // sessions that compact periodically (2026-06-18, topic 13481). A session that
      // is demonstrably alive AND working has already recovered from the compaction
      // on its own — a resume nudge here only interrupts its live turn. So STAND
      // DOWN. (The opposite case — a session whose footer FALSELY shows "working"
      // while actually hung — is the job of the frozen-frame silence/wedge sentinels,
      // not this compaction-recovery path; this path's only safe action on a working
      // session is to wait, never to interrupt.)
      console.log(
        `[Sentinel] "${state.sessionName}" still actively working after ` +
        `${state.workingDefers} defers — standing down, NOT forcing an inject ` +
        `(session is alive + working; no resume nudge needed)`,
      );
      this.emit('compaction:recovered', { ...state });
      this.finalize(state, 'recovered');
      return true;
    }

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
    if (this.onceOnly.has(state.sessionName)) {
      // §9.1: the server fallback runs once per compaction epoch; no re-inject.
      this.finalize(state, 'failed', 'fallback delivered once; no output followed');
      return;
    }
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
      this.onceOnly.delete(state.sessionName);
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

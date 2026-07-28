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
  | 'suppressed-active'
  | 'escalated';

/** Observability funnel events (HONEST-PROGRESS-MESSAGING E). */
export type SilenceFunnelEvent =
  | 'detected'
  | 'suppressed_active_indicator'
  | 'suppressed_subagent_live'
  | 'suppressed_corroborate_error'
  | 'escalated_indeterminate'
  | 'escalated_frozen_indicator'
  | 'escalated_legacy';

export interface SilenceState {
  sessionName: string;
  detectedAt: number;
  lastOutputAtAtDetection: number;
  nudgedAt: number;
  status: SilenceStatus;
  /** Auto-recovery (respawn) attempts made for this stall episode. Bounded by
   *  maxAutoRecoveries to prevent a respawn-loop on a session that stays stuck. */
  recoveryAttempts: number;
  /** A1/A5: when escalation was suppressed because the live frame still showed an
   *  active-work indicator, the wall-clock the suppression began AND the frozen
   *  frame's hash. If the SAME frame stays byte-identical past
   *  activeWorkMaxFrozenIndicatorMs, A5 escalates (a frozen-indicator hang).
   *  Reset whenever the frame changes (genuine progress). */
  activeFrozenSince?: number;
  activeFrozenHash?: string;
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
  /** Capture the session's CURRENT live tmux frame (HONEST-PROGRESS-MESSAGING
   *  A1/A2). Used to corroborate a wedge before escalating. When absent, the
   *  sentinel keeps its legacy behavior (escalate on threshold+nudge, no
   *  corroboration) — back-compat for callers that don't wire it. */
  captureFrame?: (sessionName: string) => string | null;
  /** Does this live frame still show an active-work indicator (spinner / "esc to
   *  interrupt" / "(running)")? Wired to looksActivelyWorking(). A1: if true, the
   *  session is in an active turn — suppress, never escalate. */
  looksActivelyWorking?: (frame: string, sessionName: string) => boolean;
  /** Is this live frame a clean idle prompt (turn finished, waiting for input)?
   *  A2(b): a clean idle prompt is NOT a wedge — only an indeterminate non-prompt
   *  frame is. When absent, the indeterminate check degrades to "no active-work
   *  indicator" alone. */
  isCleanIdlePrompt?: (frame: string, sessionName: string) => boolean;
  /** Does the session have a live sub-agent (SubagentTracker, no stoppedAt)?
   *  A2(c): a session whose sub-agent is mid-work is not wedged — suppress. */
  hasActiveSubagents?: (sessionName: string) => boolean;
  /** Observability hook (HONEST-PROGRESS-MESSAGING E). Records a funnel event so
   *  the suppressed-vs-escalated rates are auditable. Never throws into the
   *  sentinel; best-effort. */
  recordEvent?: (event: SilenceFunnelEvent, sessionName: string, detail?: string) => void;
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
  /** Silence threshold — output gap that triggers detection (ms). Default 30m
   *  (HONEST-PROGRESS-MESSAGING A4 — raised from 15m; with A1/A2 corroboration
   *  this collapses the false-positive rate without missing a genuine wedge). */
  silenceThresholdMs?: number;
  /** Verify window — how long after nudge before declaring escalate (ms). Default 30s. */
  verifyWindowMs?: number;
  /** Frozen-indicator hard timeout (HONEST-PROGRESS-MESSAGING A5). A1 suppresses
   *  escalation whenever the live frame still shows an active-work indicator —
   *  which would permanently hide a genuine hang that froze mid-tool with the
   *  indicator still on screen. Backstop: if a frame WITH an active-work
   *  indicator stays byte-identical this long, escalate once with an extra-hedged
   *  message. Default 90m. */
  activeWorkMaxFrozenIndicatorMs?: number;
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
  silenceThresholdMs: 30 * 60_000,
  verifyWindowMs: 30_000,
  activeWorkMaxFrozenIndicatorMs: 90 * 60_000,
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
    const pastThreshold = new Set<string>();
    for (const s of sessions) {
      if (s.paused || s.recoveryInFlight) continue;
      if (!s.lastOutputAt || s.lastOutputAt <= 0) continue;
      // Session is in the registry but never produced output → not "actively working then stopped"; skip.
      const idleMs = now - s.lastOutputAt;
      if (idleMs < this.cfg.silenceThresholdMs) continue;
      pastThreshold.add(s.sessionName);
      const existing = this.states.get(s.sessionName);
      if (existing) {
        // A1/A5 (HONEST-PROGRESS-MESSAGING): a session whose escalation was
        // suppressed because it still looked actively working is re-evaluated
        // every tick — so A5's frozen-indicator timeout can eventually fire and
        // a turn that finishes mid-suppression gets re-judged as a real wedge.
        if (existing.status === 'suppressed-active') void this.escalate(s.sessionName);
        continue; // any other status: already handling
      }
      this.report(s.sessionName, s.lastOutputAt);
    }
    // A suppressed-active session that is no longer past the silence threshold
    // (its frame changed → genuine progress, or it ended) is cleared so the map
    // can't leak and the session is monitored fresh.
    for (const [name, st] of this.states) {
      if (st.status === 'suppressed-active' && !pastThreshold.has(name)) {
        this.clear(name);
        this.emit('recovered', name);
      }
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
      // Couldn't even nudge — escalate immediately (corroborated inside escalate).
      void this.escalate(sessionName);
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
    void this.escalate(sessionName);
  }

  /**
   * Corroboration gate (HONEST-PROGRESS-MESSAGING A1/A2/A5). Before claiming a
   * session is stuck, re-capture its LIVE frame and prove it really is wedged —
   * a static scrollback on a session that is mid-tool, mid-sub-agent, or just
   * finished is NOT a freeze. The whole path FAILS CLOSED (FD-6): any error
   * suppresses the escalation rather than risk a false "it's stuck" claim.
   */
  private async escalate(sessionName: string): Promise<void> {
    const state = this.states.get(sessionName);
    if (!state) return;

    // Legacy path: no live-frame capture wired → keep the original behavior but
    // with the honest A3 wording. Corroboration is unavailable, so escalate on
    // threshold + failed-nudge as before.
    if (!this.deps.captureFrame) {
      this.deps.recordEvent?.('escalated_legacy', sessionName);
      this.proceedEscalation(sessionName, this.honestAskMessage(sessionName));
      return;
    }

    let frame: string | null;
    try {
      frame = this.deps.captureFrame(sessionName);
    } catch (err) {
      // FD-6 — capture threw: unreliable evidence, suppress + re-arm.
      this.deps.recordEvent?.('suppressed_corroborate_error', sessionName, String(err));
      this.markSuppressedActive(state, undefined);
      return;
    }
    if (!frame) {
      // No frame to judge → fail closed (suppress + re-arm).
      this.deps.recordEvent?.('suppressed_corroborate_error', sessionName, 'empty-frame');
      this.markSuppressedActive(state, undefined);
      return;
    }

    let activelyWorking = false;
    try {
      activelyWorking = this.deps.looksActivelyWorking?.(frame, sessionName) ?? false;
    } catch (err) {
      this.deps.recordEvent?.('suppressed_corroborate_error', sessionName, String(err));
      this.markSuppressedActive(state, undefined);
      return;
    }

    // A1 + A5: the live frame still shows an active-work indicator → in an active
    // turn (a long task), NOT a freeze. Suppress — unless the SAME frame has been
    // byte-identical past the frozen-indicator timeout, the rare genuine hang.
    if (activelyWorking) {
      const hash = cheapHash(frame);
      const now = (this.deps.now ?? Date.now)();
      const frozenLongEnough =
        state.activeFrozenHash === hash &&
        state.activeFrozenSince != null &&
        now - state.activeFrozenSince >= this.cfg.activeWorkMaxFrozenIndicatorMs;
      if (frozenLongEnough) {
        this.deps.recordEvent?.('escalated_frozen_indicator', sessionName);
        state.status = 'escalated';
        const minutes = Math.max(1, Math.round(this.cfg.activeWorkMaxFrozenIndicatorMs / 60_000));
        void this.notify(
          sessionName,
          `${friendlyName(sessionName)} has shown the same "working" frame for ${minutes} min with zero change — could be a long task, or a hang that froze mid-step. Worth a look?`,
        );
        this.emit('escalated', sessionName);
        return;
      }
      // Still working (or the frozen-frame timer hasn't elapsed) → suppress.
      this.markSuppressedActive(state, hash);
      this.deps.recordEvent?.('suppressed_active_indicator', sessionName);
      return;
    }

    // A2(c): a live sub-agent means the session is mid-work, not wedged. Suppress.
    let subagentLive = false;
    try {
      subagentLive = this.deps.hasActiveSubagents?.(sessionName) ?? false;
    } catch {
      // A failing tracker read is unreliable evidence → fail closed (suppress).
      this.deps.recordEvent?.('suppressed_corroborate_error', sessionName, 'subagent-check-threw');
      this.markSuppressedActive(state, undefined);
      return;
    }
    if (subagentLive) {
      this.markSuppressedActive(state, undefined);
      this.deps.recordEvent?.('suppressed_subagent_live', sessionName);
      return;
    }

    // A2(b): a clean idle prompt is a finished/idle turn, not a wedge. Drop the
    // episode silently (the tracker's paused flag normally catches this; the live
    // frame is the authority).
    let cleanIdle = false;
    try {
      cleanIdle = this.deps.isCleanIdlePrompt?.(frame, sessionName) ?? false;
    } catch {
      cleanIdle = false;
    }
    if (cleanIdle) {
      this.clear(sessionName);
      this.emit('recovered', sessionName);
      return;
    }

    // Corroborated wedge: no active-work indicator, no live sub-agent, and the
    // frame is in an indeterminate non-prompt state. This is a genuine freeze.
    this.deps.recordEvent?.('escalated_indeterminate', sessionName);
    this.proceedEscalation(sessionName, this.honestAskMessage(sessionName));
  }

  /** Mark a session as suppressed-active and (re)stamp the frozen-frame timer.
   *  A changed frame hash resets the A5 timer (genuine progress within the turn). */
  private markSuppressedActive(state: SilenceState, frameHash: string | undefined): void {
    const now = (this.deps.now ?? Date.now)();
    if (frameHash != null && state.activeFrozenHash !== frameHash) {
      state.activeFrozenHash = frameHash;
      state.activeFrozenSince = now;
    } else if (frameHash == null) {
      // Couldn't hash the frame (error path) — don't arm A5 on bad evidence.
      state.activeFrozenHash = undefined;
      state.activeFrozenSince = undefined;
    } // else: same hash → keep the existing activeFrozenSince so A5 can elapse.
    state.status = 'suppressed-active';
    this.emit('suppressed-active', state.sessionName);
  }

  /** The autoRecover-or-ask escalation, reached only after corroboration (or in
   *  the legacy no-capture path). */
  private proceedEscalation(sessionName: string, askText: string): void {
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
    void this.notify(sessionName, askText);
    this.emit('escalated', sessionName);
  }

  /** A3 honest wording — evidence + uncertainty, never an asserted conclusion. */
  private honestAskMessage(sessionName: string): string {
    const state = this.states.get(sessionName);
    const base = state?.lastOutputAtAtDetection ?? (this.deps.now ?? Date.now)();
    const minutes = Math.max(1, Math.round(((this.deps.now ?? Date.now)() - base) / 60_000));
    return `${friendlyName(sessionName)}'s screen hasn't changed in ${minutes} min and a nudge didn't wake it — it may be stuck, or on a long task I can't see into. Want me to check?`;
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
  const stripped = sessionName
    .replace(/^ai\.instar\./, '')
    .replace(/-server$/, '')
    .replace(/-lifeline$/, '');
  // FD-7 (HONEST-PROGRESS-MESSAGING): the name is embedded in a user-facing
  // message — clamp to a safe charset so a crafted tmux session name can't inject
  // markdown/control characters into the escalation text. Session names are
  // already alphanumeric/dash/dot by construction; this is defense-in-depth.
  const safe = stripped.replace(/[^A-Za-z0-9._-]/g, '');
  return safe.length > 0 ? safe : 'a session';
}

/** FNV-1a — enough to detect that a captured live frame changed byte-for-byte
 *  (A5 frozen-indicator timer). Not security-sensitive. */
function cheapHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

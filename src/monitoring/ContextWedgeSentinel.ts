/**
 * ContextWedgeSentinel — detects Claude Code's "thinking/redacted_thinking
 * blocks in the latest assistant message cannot be modified" 400 wedge and
 * recovers via a FRESH respawn.
 *
 * The failure (diagnosed 2026-05-28): a tool call is cancelled inside a
 * parallel tool batch while extended thinking is on. Claude Code cancels every
 * sibling call, and that cancellation corrupts the thinking block on the latest
 * assistant turn. The Anthropic API then rejects EVERY resume of that session
 * with `400 ... thinking blocks in the latest assistant message cannot be
 * modified`. The session fast-fails instantly on every inbound message ("Cooked
 * for 0s"); it is permanently dead yet still emitting output, so neither the
 * silence sentinel (output never goes quiet) nor the socket sentinel (no
 * disconnect string) catches it.
 *
 * Critical difference from the other silently-stopped sentinels: a send-keys
 * nudge CANNOT recover this — re-engaging just re-sends the corrupted turn and
 * hits the same 400. The only recovery is a clean respawn that does NOT
 * `--resume` the corrupted transcript. That is the injected `recoverFn`
 * (wired to SessionRefresh fresh-mode, which clears the topic's resume UUID
 * before respawning).
 *
 * Because recovery is destructive (kills + respawns a session), detection is
 * gated by a CONFIRM WINDOW: the signature must still be the non-progressing
 * session tail after `confirmWindowMs` before a wedge is confirmed. This is the
 * defense against false-positives — most importantly a session merely
 * *discussing* this very error (its tail keeps changing as it works, so the
 * signature does not persist as the tail). And the destructive recovery itself
 * is opt-in (autoRecovery, default off) and rides the Graduated Feature Rollout
 * track; in the default detect-only mode the sentinel only audits + escalates.
 *
 * Spec: docs/specs/context-wedge-sentinel.md (companion to silently-stopped-trio.md)
 *
 * Signal-vs-authority: the regex + confirm-window are detectors. The recoverFn
 * is a bounded recovery primitive (SessionRefresh rate-guards respawns). User-
 * facing escalation routes through the existing MessagingToneGate via the
 * SentinelNotifier path. No new blocking authority.
 */

import { EventEmitter } from 'node:events';

export type ContextWedgeStatus =
  | 'detected'
  | 'confirming'
  | 'recovered'
  | 'escalated';

/** Outcome of a recovery attempt, returned by the injected recoverFn. */
export type WedgeRecoveryOutcome =
  | 'respawned' // autoRecovery live: session was killed + freshly respawned
  | 'dry-run' // autoRecovery dry-run: would-respawn logged, nothing killed
  | 'detect-only' // autoRecovery off: no recovery action taken
  | 'failed'; // autoRecovery live but the respawn attempt failed

export interface ContextWedgeState {
  sessionName: string;
  detectedAt: number;
  status: ContextWedgeStatus;
}

export interface ContextWedgeSentinelDeps {
  /** Peek at the session's most recent tmux output (may be empty). */
  getRecentOutput: (sessionName: string) => string;
  /**
   * Attempt recovery of a confirmed wedge. The wiring decides policy
   * (detect-only / dry-run / live respawn) and reports back via the outcome.
   * Never throws on the expected failure modes; rejection is treated as 'failed'.
   */
  recoverFn: (sessionName: string) => Promise<WedgeRecoveryOutcome>;
  /** Route a user-facing escalation; server.ts owns topic routing + tone gate. */
  notifyFn: (sessionName: string, text: string) => Promise<void>;
  /** List the session names to scan each tick. Without it the sentinel is
   *  event-driven only (caller invokes scanSession/report). */
  listSessionNames?: () => string[];
  /** Override Date.now (tests). */
  now?: () => number;
  /** Override timer setters (tests). */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface ContextWedgeSentinelConfig {
  enabled?: boolean;
  /** How often the self-driving loop scans every session (ms). Default 20s. */
  tickIntervalMs?: number;
  /** How long the signature must persist as the non-progressing tail before the
   *  wedge is confirmed (ms). Default 45s. */
  confirmWindowMs?: number;
}

const DEFAULT_CONFIG: Required<ContextWedgeSentinelConfig> = {
  enabled: true,
  tickIntervalMs: 20_000,
  confirmWindowMs: 45_000,
};

/**
 * Patterns for the thinking-block 400. Intentionally anchored on the unusual,
 * API-specific phrase — natural prose almost never contains it, and the
 * confirm-window + opt-in recovery cover the one case that does (a session
 * discussing this very bug).
 */
export const CONTEXT_WEDGE_PATTERNS: readonly RegExp[] = [
  /blocks in the latest assistant message cannot be modified/i,
  /`?(?:thinking|redacted_thinking)`?\s+blocks.{0,80}cannot be modified/i,
];

/** Detector — true if `text` contains the thinking-block-400 signature. */
export function detectContextWedge(text: string): boolean {
  if (!text) return false;
  for (const pat of CONTEXT_WEDGE_PATTERNS) {
    if (pat.test(text)) return true;
  }
  return false;
}

/**
 * Tail detector — is the signature present within the last `tailLines`
 * non-empty lines of the capture? A genuinely wedged session shows the error as
 * its live tail; a session that merely mentioned the error earlier and then
 * kept working has scrolled it out of the tail.
 */
export function signatureIsTail(text: string, tailLines = 10): boolean {
  if (!text) return false;
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const tail = lines.slice(-tailLines).join('\n');
  return detectContextWedge(tail);
}

export class ContextWedgeSentinel extends EventEmitter {
  private readonly cfg: Required<ContextWedgeSentinelConfig>;
  private readonly states = new Map<string, ContextWedgeState>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private tickHandle: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: ContextWedgeSentinelDeps, cfg: ContextWedgeSentinelConfig = {}) {
    super();
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
  }

  /** Begin the self-driving scan loop. No-op without listSessionNames. */
  start(): void {
    if (!this.cfg.enabled || this.tickHandle) return;
    if (!this.deps.listSessionNames) return;
    this.tickHandle = setInterval(() => this.tick(), this.cfg.tickIntervalMs);
    if (typeof this.tickHandle.unref === 'function') this.tickHandle.unref();
  }

  stop(): void {
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
    this.shutdown();
  }

  /** One scan pass over every tracked session. */
  tick(): void {
    if (!this.cfg.enabled) return;
    const names = this.deps.listSessionNames?.() ?? [];
    for (const name of names) this.scanSession(name);
  }

  /** Scan one session for the wedge signature. */
  scanSession(sessionName: string): void {
    if (!this.cfg.enabled) return;
    if (this.states.has(sessionName)) return; // already handling
    const output = this.deps.getRecentOutput(sessionName);
    // Require the signature to be the live TAIL, not merely present somewhere in
    // the scrollback — the discriminator against a session discussing the bug.
    if (!signatureIsTail(output)) return;
    this.report(sessionName);
  }

  /** Public entry: report a detected (not yet confirmed) wedge. Idempotent. */
  report(sessionName: string): void {
    if (!this.cfg.enabled) return;
    if (this.states.has(sessionName)) return;
    const now = (this.deps.now ?? Date.now)();
    const state: ContextWedgeState = {
      sessionName,
      detectedAt: now,
      status: 'detected',
    };
    this.states.set(sessionName, state);
    this.emit('detected', { sessionName });

    // Enter the confirm window before any destructive action.
    state.status = 'confirming';
    const handle = this.setTimer(() => void this.confirm(sessionName), this.cfg.confirmWindowMs);
    this.timers.set(sessionName, handle);
  }

  isRecoveryActive(sessionName: string): boolean {
    const s = this.states.get(sessionName);
    return !!s && s.status !== 'recovered' && s.status !== 'escalated';
  }

  listActive(): ContextWedgeState[] {
    return Array.from(this.states.values());
  }

  clear(sessionName: string): void {
    const t = this.timers.get(sessionName);
    if (t) this.clearTimer(t);
    this.timers.delete(sessionName);
    this.states.delete(sessionName);
  }

  shutdown(): void {
    for (const t of this.timers.values()) this.clearTimer(t);
    this.timers.clear();
    this.states.clear();
  }

  // ── Confirm + recover ────────────────────────────────────────────────

  private async confirm(sessionName: string): Promise<void> {
    const state = this.states.get(sessionName);
    if (!state) return;
    const output = this.deps.getRecentOutput(sessionName);

    // Confirmation gate: the signature must STILL be the tail. If it scrolled
    // out (the session progressed past the error), this was not a wedge — a
    // false alarm (e.g. a session that quoted the error then kept working).
    if (!signatureIsTail(output)) {
      this.emit('false-alarm', { sessionName });
      this.clear(sessionName);
      return;
    }

    // Confirmed wedge → hand to the recovery policy.
    let outcome: WedgeRecoveryOutcome = 'failed';
    try {
      outcome = await this.deps.recoverFn(sessionName);
    } catch (err) {
      this.emit('recovery-error', { sessionName, err });
      outcome = 'failed';
    }

    switch (outcome) {
      case 'respawned':
        state.status = 'recovered';
        this.emit('recovered', { sessionName });
        this.clear(sessionName);
        return;
      case 'dry-run':
        // Housekeeping only — would-have-respawned. Keep state so we don't
        // re-confirm the same wedge every tick; the dry-run log is the signal.
        state.status = 'escalated';
        this.emit('dry-run', { sessionName });
        return;
      case 'detect-only':
      case 'failed':
      default:
        this.escalate(sessionName, outcome);
        return;
    }
  }

  private escalate(sessionName: string, outcome: WedgeRecoveryOutcome): void {
    const state = this.states.get(sessionName);
    if (!state) return;
    state.status = 'escalated';
    const detail =
      outcome === 'failed'
        ? `${friendlyName(sessionName)} is wedged on a stuck-context error and my respawn attempt did not clear it. Want me to dig in?`
        : `${friendlyName(sessionName)} is wedged on a stuck-context error (it can only be fixed by a fresh restart, which is currently off). Want me to restart it?`;
    void this.notify(sessionName, detail);
    this.emit('escalated', { sessionName, outcome });
    // Keep state so a subsequent scan doesn't re-report the same wedge.
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

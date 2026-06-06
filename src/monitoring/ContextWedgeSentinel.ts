/**
 * ContextWedgeSentinel — detects transcript-level fast-fail wedges (the
 * thinking-block 400 and the Usage-Policy rejection loop) and recovers via a
 * FRESH respawn.
 *
 * Signature family 1 — thinking-block 400 (diagnosed 2026-05-28): a tool call
 * is cancelled inside a parallel tool batch while extended thinking is on.
 * Claude Code cancels every sibling call, and that cancellation corrupts the
 * thinking block on the latest assistant turn. The Anthropic API then rejects
 * EVERY resume of that session with `400 ... thinking blocks in the latest
 * assistant message cannot be modified`. The session fast-fails instantly on
 * every inbound message ("Cooked for 0s"); it is permanently dead yet still
 * emitting output, so neither the silence sentinel (output never goes quiet)
 * nor the socket sentinel (no disconnect string) catches it.
 *
 * Signature family 2 — AUP-rejection loop (diagnosed 2026-06-05, EXO 3.0
 * incident): the transcript accumulates content that trips the API's Usage
 * Policy classifier (e.g. literal red-team / prompt-injection test payloads
 * generated during security-harness work). Because every turn re-sends the
 * full conversation, EVERY response attempt is rejected with `API Error:
 * Claude Code is unable to respond to this request, which appears to violate
 * our Usage Policy` — same permanent-death shape, same recovery. Unlike the
 * thinking-block 400, a SINGLE policy rejection can be a benign one-off (one
 * bad request, next message fine), so this family additionally requires the
 * signature to appear MORE THAN ONCE in the capture (the loop always repeats;
 * a one-off never does) before it counts as a wedge.
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
  /** Which signature family triggered the detection. */
  kind: WedgeKind;
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

/**
 * Patterns for the AUP-rejection loop. Anchored on the API-specific rejection
 * phrase, which natural prose almost never contains verbatim.
 */
export const AUP_WEDGE_PATTERNS: readonly RegExp[] = [
  /unable to respond to this request.{0,60}appears to violate our Usage Policy/is,
  /appears to violate our Usage Policy/i,
];

/** Which signature family a wedge detection matched. */
export type WedgeKind = 'thinking-block-400' | 'aup-rejection';

/** Detector — true if `text` contains the thinking-block-400 signature. */
export function detectContextWedge(text: string): boolean {
  if (!text) return false;
  for (const pat of CONTEXT_WEDGE_PATTERNS) {
    if (pat.test(text)) return true;
  }
  return false;
}

/** Detector — true if `text` contains the AUP-rejection signature. */
export function detectAupRejection(text: string): boolean {
  if (!text) return false;
  for (const pat of AUP_WEDGE_PATTERNS) {
    if (pat.test(text)) return true;
  }
  return false;
}

/**
 * Count how many distinct lines of `text` carry the AUP signature. The
 * rejection loop re-prints the error on every failed turn, so a wedged session
 * shows it repeatedly; a benign one-off rejection appears exactly once.
 */
function countAupSignatureLines(text: string): number {
  if (!text) return 0;
  let n = 0;
  for (const line of text.split('\n')) {
    if (line && detectAupRejection(line)) n++;
  }
  return n;
}

/**
 * Tail classifier — which wedge family (if any) is the live tail of the
 * capture? A genuinely wedged session shows the error as its tail; a session
 * that merely mentioned the error earlier and then kept working has scrolled
 * it out. The AUP family additionally requires the signature on >1 line of the
 * full capture — the loop always repeats, a benign one-off rejection doesn't.
 */
export function classifyWedgeTail(text: string, tailLines = 10): WedgeKind | null {
  if (!text) return null;
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const tail = lines.slice(-tailLines).join('\n');
  if (detectContextWedge(tail)) return 'thinking-block-400';
  if (detectAupRejection(tail) && countAupSignatureLines(text) > 1) return 'aup-rejection';
  return null;
}

/**
 * Tail detector — is any wedge signature the live tail? (Back-compat wrapper
 * around classifyWedgeTail; existing callers and tests use the boolean form.)
 */
export function signatureIsTail(text: string, tailLines = 10): boolean {
  return classifyWedgeTail(text, tailLines) !== null;
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
    const kind = classifyWedgeTail(output);
    if (!kind) return;
    this.report(sessionName, kind);
  }

  /** Public entry: report a detected (not yet confirmed) wedge. Idempotent. */
  report(sessionName: string, kind: WedgeKind = 'thinking-block-400'): void {
    if (!this.cfg.enabled) return;
    if (this.states.has(sessionName)) return;
    const now = (this.deps.now ?? Date.now)();
    const state: ContextWedgeState = {
      sessionName,
      detectedAt: now,
      status: 'detected',
      kind,
    };
    this.states.set(sessionName, state);
    this.emit('detected', { sessionName, kind });

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
    if (!classifyWedgeTail(output)) {
      this.emit('false-alarm', { sessionName, kind: state.kind });
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
        this.emit('recovered', { sessionName, kind: state.kind });
        this.clear(sessionName);
        return;
      case 'dry-run':
        // Housekeeping only — would-have-respawned. Keep state so we don't
        // re-confirm the same wedge every tick; the dry-run log is the signal.
        state.status = 'escalated';
        this.emit('dry-run', { sessionName, kind: state.kind });
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
    const cause =
      state.kind === 'aup-rejection'
        ? 'a policy-rejection loop (its conversation content is being refused by the API on every turn)'
        : 'a stuck-context error';
    const detail =
      outcome === 'failed'
        ? `${friendlyName(sessionName)} is wedged on ${cause} and my respawn attempt did not clear it. Want me to dig in?`
        : `${friendlyName(sessionName)} is wedged on ${cause} (it can only be fixed by a fresh restart, which is currently off). Want me to restart it?`;
    void this.notify(sessionName, detail);
    this.emit('escalated', { sessionName, outcome, kind: state.kind });
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

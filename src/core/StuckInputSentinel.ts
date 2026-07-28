/**
 * StuckInputSentinel — persistent, periodic recovery for stuck tmux prompts.
 *
 * Why this exists, separate from SessionManager.verifyInjection:
 *
 * verifyInjection (PR #159, v0.28.92) runs as four in-process setTimeout
 * callbacks at 0.5s / 1.5s / 3.5s / 6.5s after an injection. If the server
 * process exits anywhere in that 6.5s window — crash, restart, OOM — all
 * pending timers die. Any message injected just before the crash sits at the
 * `❯` prompt forever. This was exactly the failure mode reproduced on echo
 * 2026-05-11: a 30+ minute server crash loop (better-sqlite3 ABI rebuild
 * loop) left three of echo's sessions with messages from the user that
 * never submitted.
 *
 * This sentinel is the durable backstop. It runs as a long-lived setInterval
 * on the server, scans every running session every TICK_MS, and fires the
 * same escalating recovery actions verifyInjection uses — but it doesn't
 * depend on having armed a timer at injection time. A server restart re-
 * starts the sentinel and it picks up any session that's still stuck.
 *
 * Detection (per session per tick):
 *   1. Capture the bottom of the pane.
 *   2. Find the `❯` prompt line and read whatever's after it.
 *   3. Skip if the pane shows Claude Code is actively working (spinner row,
 *      "esc to interrupt", churn indicator). The sentinel must never fire
 *      Enter while a tool/turn is in flight — that would interrupt work.
 *   4. Skip if the prompt text just appeared (give verifyInjection its 6.5s
 *      window to handle the common race first).
 *   5. If the same prompt text persists across MIN_TICKS_BEFORE_FIRE ticks
 *      without changing AND no activity indicator, verify the text is REAL
 *      input (see the ghost-text exclusion below), then fire one recovery
 *      action, then escalate next tick if still stuck.
 *
 * Ghost-text exclusion (F2, live finding 2026-07-02): Claude Code renders a
 * model-generated prompt SUGGESTION ("ghost text") in the composer — dim-styled
 * (SGR 2, e.g. `ESC[0;2m`), never typed by anyone. In a plain capture-pane
 * frame the dim attribute is stripped, so ghost text is byte-identical to real
 * stuck input, and the sentinel fired 4 Enter presses at a fabricated
 * instruction during the 2026-07-02 live run (harmless today only because
 * Enter does not accept ghost text — one harness UX change away from a
 * watchdog auto-submitting a model-fabricated instruction). The invariant this
 * gate encodes: THE SENTINEL NEVER AUTO-SUBMITS TEXT THE USER (OR AN
 * AUTHORIZED INJECTOR) DID NOT ACTUALLY TYPE. Before any keypress on the
 * generic `❯`-prompt path, the sentinel re-captures the pane WITH ANSI escapes
 * (`capture-pane -e`) and classifies the prompt text's presentation:
 *   - 'real'         — rendered at normal intensity → proceed with recovery.
 *   - 'ghost'        — rendered entirely dim → NEVER press keys at it; the
 *                      record is exhausted until the prompt text changes.
 *   - 'inconclusive' — ANSI capture failed, frames raced, or mixed styling →
 *                      fail toward NOT pressing keys this tick (log-only);
 *                      re-assessed next tick.
 * The codex marker path is NOT gated: it only ever fires when the exact marker
 * text we ourselves injected is stuck at the prompt, so the invariant holds
 * there by construction (and codex's dim placeholder-hint is already excluded
 * by marker matching).
 *
 * Bounded escalation matches SessionManager.fireStuckInputRecovery:
 *   attempt 0,1 → Enter        attempt 2 → C-m        attempt 3 → Enter+sleep+Enter
 * After MAX_ATTEMPTS the per-session record is marked exhausted; it will not
 * fire again until the prompt text changes (i.e., new content arrives).
 *
 * Persistence: every fire writes one line to
 * `<stateDir>/stuck-input-events.jsonl` for observability. The sentinel does
 * NOT rely on the file to function — in-memory state is fine. The file is
 * for operators auditing what fired and when, and feeds the
 * DegradationReporter.
 *
 * Signal vs authority: this is a recovery detector with the smallest possible
 * action surface — a single Enter keypress per attempt. It does not gate
 * messages, does not block any flow. A false positive (Enter fired against a
 * session that wasn't actually stuck) is a no-op against an empty prompt and
 * therefore safe. The cost is bounded; the benefit is "messages don't
 * silently disappear after a server crash."
 */

import fs from 'node:fs';
import path from 'node:path';
import type { SessionManager } from './SessionManager.js';
import { CLAUDE_WORKING_INDICATORS } from './claudeActivityIndicators.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';
import { SessionRecoveryChannel, type RecoveryTier } from './SessionRecoveryChannel.js';

export interface StuckInputSentinelOptions {
  /** Poll interval. Default 10s. */
  tickMs?: number;
  /** Minimum ticks the same prompt text must persist before firing. Default 2
   *  (i.e. ≥20s with the default tickMs, which sits comfortably past
   *  verifyInjection's 6.5s window). */
  minTicksBeforeFire?: number;
  /** Max recovery attempts per stuck event. After this, the per-session
   *  record is exhausted until the prompt text changes. Default 4. */
  maxAttempts?: number;
  /** State directory for the events log. */
  stateDir: string;
  /** Disable persistence to disk (used by unit tests). */
  noPersist?: boolean;
  /** Cross-process recovery channel. When provided AND escalationEnabled, the
   *  sentinel escalates PAST the keypress ladder (tier C: it requests a server
   *  restart + replay from the lifeline, which owns ServerSupervisor). When
   *  absent the sentinel keeps its legacy behavior (exhaust → stop). */
  recoveryChannel?: SessionRecoveryChannel;
  /** Master gate for the deeper-tier escalation. Default false (dark): the
   *  sentinel marks the record exhausted after the keypress ladder, exactly as
   *  before. Set true (via config) to enable tier-C recovery requests. */
  escalationEnabled?: boolean;
  /** How many ticks to wait for the lifeline to ack a tier-C request before
   *  giving up (bounded — no restart loop). Default 6. */
  escalationTimeoutTicks?: number;
}

/** In-memory record of what the sentinel has seen for a given session. */
interface SessionStuckRecord {
  /** The prompt text observed most recently (the bit after `❯`). */
  lastPromptText: string;
  /** When we first saw this exact text at the prompt. */
  firstSeenAt: number;
  /** How many consecutive ticks have observed this same text. */
  consecutiveTicks: number;
  /** How many recovery actions have been fired so far for this text. */
  attempts: number;
  /** Whether this record is exhausted (max attempts reached — or the text was
   *  classified as ghost text — won't fire again until the prompt text
   *  changes). */
  exhausted: boolean;
  /** Whether a ghost-text-skip / ghost-check-inconclusive event has already
   *  been logged for this record's text (one observability row per stuck
   *  text, not one per tick). */
  ghostSkipLogged?: boolean;
  /** Deeper-tier escalation phase (after the keypress ladder exhausts).
   *   - 'none': not escalating (keypress ladder still running or escalation off).
   *   - 'requested': a tier-C recovery request is in flight to the lifeline;
   *     subsequent ticks read the ack.
   *   - 'recovered'/'gave-up': terminal. */
  recoveryPhase: 'none' | 'requested' | 'recovered' | 'gave-up';
  /** attemptId of the in-flight recovery request (matches the channel ack). */
  recoveryAttemptId?: string;
  /** tickCounter value when the request was emitted (for the bounded wait). */
  recoveryRequestedTick?: number;
}

/** Event row written to stuck-input-events.jsonl on each fire. */
export interface StuckInputEvent {
  ts: string;
  session: string;
  promptText: string;
  attempt: number;
  action: 'Enter' | 'C-m' | 'Enter-sleep-Enter'
    | 'escalate-request' | 'escalate-recovered' | 'escalate-failed' | 'escalate-timeout'
    | 'ghost-text-skip' | 'ghost-check-inconclusive';
  outcome: 'fired' | 'fire-error' | 'escalated' | 'recovered' | 'gave-up' | 'skipped';
  /** Recovery tier for escalation events (absent for keypress events). */
  tier?: RecoveryTier;
  error?: string;
}

const DEFAULT_TICK_MS = 10_000;
const DEFAULT_MIN_TICKS_BEFORE_FIRE = 2;
const DEFAULT_MAX_ATTEMPTS = 4;

/** Strings that indicate Claude Code is actively working — the sentinel
 *  refuses to fire Enter against any of these states. Each entry is checked
 *  with `pane.includes(...)` against the captured bottom of the pane.
 *
 *  Sourced from the shared CLAUDE_WORKING_INDICATORS so this sentinel,
 *  SessionManager.verifyInjection, and CompactionSentinel all agree on the
 *  single canonical "mid-turn footer" tell. */
const ACTIVITY_INDICATORS: readonly string[] = CLAUDE_WORKING_INDICATORS;

/**
 * How the stuck prompt text is RENDERED in the live pane (F2 ghost-text
 * exclusion). Classified from an ANSI capture (`tmux capture-pane -e`):
 *   - 'real'         — normal intensity: genuinely typed/injected input.
 *   - 'ghost'        — entirely dim (SGR 2): the harness's model-generated
 *                      composer suggestion; never actually typed by anyone.
 *   - 'inconclusive' — cannot prove either way (capture failed, frames raced,
 *                      mixed styling). The sentinel fails toward NOT pressing.
 */
export type PromptTextPresentation = 'real' | 'ghost' | 'inconclusive';

/** One physical pane line decoded from an ANSI capture: the visible text and
 *  a parallel per-character dim(SGR 2)-active mask. */
interface AnsiDimLine { text: string; dim: boolean[] }

/**
 * Decode a `capture-pane -e` frame into visible lines plus a per-character
 * dim-attribute mask. Tracks SGR state across the whole frame (tmux may or may
 * not re-emit attributes at line starts). Handles the extended-color forms
 * (`38;5;n`, `38;2;r;g;b` and their colon-subparam variants) so a truecolor
 * component value of `2` is never misread as the dim attribute.
 */
function parseAnsiDimLines(ansi: string): AnsiDimLine[] {
  const lines: AnsiDimLine[] = [{ text: '', dim: [] }];
  let dimActive = false;
  let i = 0;
  while (i < ansi.length) {
    const ch = ansi[i];
    if (ch === '\x1b') {
      const csi = /^\x1b\[([0-9;:]*)([@-~])/.exec(ansi.slice(i, i + 64));
      if (csi) {
        if (csi[2] === 'm') {
          const params = csi[1] === '' ? ['0'] : csi[1].split(';');
          let j = 0;
          while (j < params.length) {
            const head = params[j].split(':')[0];
            if (head === '38' || head === '48' || head === '58') {
              // Extended color. Colon-subparam form (38:2:r:g:b) is fully
              // contained in this token; semicolon form consumes the mode +
              // component params (5;n or 2;r;g;b) without interpreting them.
              if (!params[j].includes(':')) {
                const mode = params[j + 1];
                if (mode === '5') j += 2;
                else if (mode === '2') j += 4;
              }
              j += 1;
              continue;
            }
            if (head === '' || head === '0') dimActive = false;      // full reset
            else if (head === '2') dimActive = true;                  // dim/faint on
            else if (head === '22') dimActive = false;                // normal intensity
            j += 1;
          }
        }
        i += csi[0].length;
        continue;
      }
      // Non-CSI escape — skip ESC + the next byte conservatively.
      i += 2;
      continue;
    }
    if (ch === '\n') {
      lines.push({ text: '', dim: [] });
      i += 1;
      continue;
    }
    if (ch === '\r') { i += 1; continue; }
    const line = lines[lines.length - 1];
    line.text += ch;
    line.dim.push(dimActive);
    i += 1;
  }
  return lines;
}

/**
 * Classify how the stuck prompt text is rendered, from an ANSI (`-e`) capture
 * of the SAME pane. `expectedText` is the stuck text extracted from the plain
 * capture; when the ANSI frame's own prompt extraction does not reproduce it
 * exactly (the two captures raced, or the frame has no readable prompt), the
 * verdict is 'inconclusive' — never a guess.
 *
 * Grounded in the 2026-07-02 live F2 evidence: Claude Code's ghost suggestion
 * rendered with `ESC[0;2m` (dim). Real typed/injected input renders at normal
 * intensity. Only the dim attribute (SGR 2) is used as the ghost tell —
 * color-based heuristics were deliberately NOT added (a gray-but-normal-
 * intensity theme must not disable genuine recovery).
 *
 * Exported for unit tests; the live path goes through evaluateSession.
 */
export function classifyPromptTextPresentation(ansiPane: string, expectedText: string): PromptTextPresentation {
  try {
    const parsed = parseAnsiDimLines(ansiPane);
    const located = StuckInputSentinel.locatePromptText(parsed.map(l => l.text));
    if (!located || located.text !== expectedText) return 'inconclusive';
    const dimMask = parsed[located.lineIdx].dim;
    let sawDim = false;
    let sawNormal = false;
    for (let k = 0; k < located.text.length; k++) {
      const ch = located.text[k];
      if (ch === ' ' || ch === '\t') continue; // whitespace carries no styling signal
      if (dimMask[located.start + k]) sawDim = true;
      else sawNormal = true;
    }
    if (sawDim && !sawNormal) return 'ghost';
    if (sawNormal && !sawDim) return 'real';
    return 'inconclusive'; // mixed styling (or no styleable chars) — do not guess
  } catch {
    return 'inconclusive'; // any parse failure fails toward NOT pressing keys
  }
}

export class StuckInputSentinel {
  private readonly sessionManager: SessionManager;
  private readonly tickMs: number;
  private readonly minTicksBeforeFire: number;
  private readonly maxAttempts: number;
  private readonly stateDir: string;
  private readonly noPersist: boolean;
  private readonly eventsLogPath: string;
  private readonly recoveryChannel: SessionRecoveryChannel | null;
  private readonly escalationEnabled: boolean;
  private readonly escalationTimeoutTicks: number;

  /** Per-session sticky state. Keyed by tmuxSession. */
  private readonly records: Map<string, SessionStuckRecord> = new Map();

  private intervalHandle: NodeJS.Timeout | null = null;
  private tickInProgress = false;
  private degradationReportedOnce = false;
  /** Monotonic tick counter — drives the bounded escalation wait. */
  private tickCounter = 0;

  constructor(sessionManager: SessionManager, opts: StuckInputSentinelOptions) {
    this.sessionManager = sessionManager;
    this.tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
    this.minTicksBeforeFire = opts.minTicksBeforeFire ?? DEFAULT_MIN_TICKS_BEFORE_FIRE;
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.stateDir = opts.stateDir;
    this.noPersist = opts.noPersist ?? false;
    this.eventsLogPath = path.join(this.stateDir, 'stuck-input-events.jsonl');
    this.recoveryChannel = opts.recoveryChannel ?? null;
    this.escalationEnabled = opts.escalationEnabled ?? false;
    this.escalationTimeoutTicks = opts.escalationTimeoutTicks ?? 6;
  }

  start(): void {
    if (this.intervalHandle) return;
    this.intervalHandle = setInterval(() => {
      if (this.tickInProgress) return;
      this.tickInProgress = true;
      try {
        this.tick();
      } catch (err) {
        console.error(`[StuckInputSentinel] tick error: ${err instanceof Error ? err.message : err}`);
      } finally {
        this.tickInProgress = false;
      }
    }, this.tickMs);
    // Don't keep the event loop alive just for this sentinel.
    this.intervalHandle.unref?.();
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /**
   * One tick. Public for unit tests; production code uses start()/stop().
   *
   * Iterates running sessions, captures each pane, and decides whether the
   * session looks stuck. Fires one recovery action per stuck session per
   * tick (escalating across ticks).
   */
  tick(): void {
    this.tickCounter += 1;
    const running = this.sessionManager.listRunningSessions();
    const seenSessions = new Set<string>();

    for (const session of running) {
      const name = session.tmuxSession;
      seenSessions.add(name);
      this.evaluateSession(name);
    }

    // GC: drop records for sessions that are no longer running.
    for (const key of this.records.keys()) {
      if (!seenSessions.has(key)) {
        this.records.delete(key);
      }
    }

    // GC: release stranded-draft markers for sessions that have gone away, so a
    // dead codex session's stranded marker can't linger in memory.
    for (const key of this.sessionManager.strandedDraftMarkerSessions()) {
      if (!seenSessions.has(key)) {
        this.sessionManager.clearStrandedDraftMarker(key);
      }
    }
  }

  /** Evaluate a single tmux session for stuck-input recovery. */
  private evaluateSession(tmuxSession: string): void {
    const priorRecord = this.records.get(tmuxSession);
    let pane: string | null;
    try {
      if (!this.sessionManager.tmuxSessionExists(tmuxSession)) {
        this.finalizePendingRecovery(tmuxSession, priorRecord, 'session-gone');
        this.records.delete(tmuxSession);
        this.sessionManager.clearStrandedDraftMarker(tmuxSession);
        return;
      }
      pane = this.sessionManager.captureOutput(tmuxSession, 30);
    } catch (err) {
      console.error(`[StuckInputSentinel] capture failed for "${tmuxSession}": ${err instanceof Error ? err.message : err}`);
      return;
    }
    if (!pane) return;

    // Refuse to fire Enter against a session that's actively working. Codex
    // shares Claude's "esc to interrupt" footer hint while a turn is in flight,
    // so this shared activity check is correct for both frameworks — we never
    // fire Enter mid-turn (which would interrupt work / premature-submit).
    if (this.isPaneActivelyWorking(pane)) {
      // A session that escalated and is now WORKING has recovered — clear its
      // pending tier-C request (the drain means the wedge cleared; the marker-
      // based detector won't re-enter handleEscalation once it's no longer stuck).
      this.finalizePendingRecovery(tmuxSession, priorRecord, 'recovered-working');
      this.records.delete(tmuxSession);
      return;
    }

    // Choose the detection strategy by framework. A codex session with a pending
    // injection marker uses MARKER-based detection: codex renders a dim
    // placeholder hint at an empty `›` prompt that is byte-identical to real
    // input once color is stripped, so the generic prompt-text reader would
    // false-fire on every idle codex session. The injected marker never equals
    // the placeholder. Everything else uses the generic `❯`-prompt reader.
    const pending = this.sessionManager.getStrandedDraftMarker(tmuxSession);
    const codexMarker = pending && pending.framework === 'codex-cli' ? pending.marker : null;

    let stuckText: string | null;
    if (codexMarker) {
      stuckText = this.sessionManager.isMarkerStuckAtPrompt(pane, codexMarker) ? codexMarker : null;
    } else {
      stuckText = this.extractPromptText(pane);
    }

    if (!stuckText) {
      this.records.delete(tmuxSession);
      // The marker is no longer stuck at the `›` prompt → the codex message
      // submitted (or was cleared). Release the marker so we stop re-checking it.
      if (codexMarker) this.sessionManager.clearStrandedDraftMarker(tmuxSession);
      return;
    }

    const now = Date.now();
    const existing = this.records.get(tmuxSession);

    if (!existing || existing.lastPromptText !== stuckText) {
      // New content at the prompt — start tracking fresh.
      this.records.set(tmuxSession, {
        lastPromptText: stuckText,
        firstSeenAt: now,
        consecutiveTicks: 1,
        attempts: 0,
        exhausted: false,
        recoveryPhase: 'none',
      });
      return;
    }

    // Same text as last tick.
    existing.consecutiveTicks += 1;

    if (existing.exhausted) return;
    if (existing.consecutiveTicks < this.minTicksBeforeFire) return;
    if (existing.attempts >= this.maxAttempts) {
      // Keypress ladder (tier A) exhausted. Either escalate to deeper-tier
      // recovery (tier C: cross-process server restart + replay request) when
      // enabled, or fall back to the legacy "mark exhausted, stop" behavior.
      this.handleEscalation(existing, tmuxSession, stuckText, now);
      return;
    }

    // F2 ghost-text exclusion: before pressing ANY key on the generic
    // `❯`-prompt path, verify the stuck text is REAL input (typed or injected)
    // and not the harness's dim-rendered, model-generated composer suggestion.
    // The codex marker path is exempt by construction — it only fires when the
    // exact text WE injected is stuck at the prompt (see the file header).
    // Escalation (the maxAttempts branch above) is unreachable for ghost text:
    // attempts only accrue through this gate, so four 'real' verdicts must
    // precede any tier-C request.
    if (!codexMarker) {
      const presentation = this.assessPromptTextPresentation(tmuxSession, stuckText);
      if (presentation !== 'real') {
        // 'ghost' is sticky: the suggestion is never pressable; a prompt-text
        // change resets the record. 'inconclusive' is transient: re-assess
        // next tick (a raced capture self-heals; a persistent failure keeps
        // failing toward NOT pressing keys).
        if (presentation === 'ghost') existing.exhausted = true;
        if (!existing.ghostSkipLogged) {
          existing.ghostSkipLogged = true;
          this.recordEvent({
            ts: new Date(now).toISOString(),
            session: tmuxSession,
            promptText: stuckText.slice(0, 200),
            attempt: existing.attempts,
            action: presentation === 'ghost' ? 'ghost-text-skip' : 'ghost-check-inconclusive',
            outcome: 'skipped',
          });
        }
        return;
      }
    }

    // Fire one recovery action and record it.
    const attempt = existing.attempts;
    const action = StuckInputSentinel.actionForAttempt(attempt);
    let outcome: StuckInputEvent['outcome'] = 'fired';
    let errMsg: string | undefined;
    try {
      this.sessionManager.fireStuckInputRecovery(tmuxSession, attempt);
    } catch (err) {
      outcome = 'fire-error';
      errMsg = err instanceof Error ? err.message : String(err);
    }
    existing.attempts += 1;

    this.recordEvent({
      ts: new Date(now).toISOString(),
      session: tmuxSession,
      promptText: stuckText.slice(0, 200),
      attempt,
      action,
      outcome,
      error: errMsg,
    });

    if (!this.degradationReportedOnce) {
      this.degradationReportedOnce = true;
      DegradationReporter.getInstance().report({
        feature: 'StuckInputSentinel.recover',
        primary: 'Bracketed paste + Enter submits injected message',
        fallback: 'Persistent sentinel re-fires Enter after in-process verifyInjection window expired (covers server-restart cases)',
        reason: 'Prompt text persistent for ≥2 sentinel ticks with no activity indicator',
        impact: 'Recovered without user intervention; survives server restart',
      });
    }
  }

  /** Pull the text after `❯` from the captured pane.
   *  Returns null if no ❯ line is found or the prompt is empty.
   *
   *  Public for unit tests; the live tick goes through evaluateSession. */
  extractPromptText(pane: string): string | null {
    return StuckInputSentinel.locatePromptText(pane.split('\n'))?.text ?? null;
  }

  /**
   * Locate the stuck prompt text within the pane's lines: which line holds it,
   * the column it starts at, and the trimmed text. This is extractPromptText's
   * engine, factored out so the ghost-text classifier can map the SAME
   * located characters onto an ANSI capture's per-character dim mask —
   * guaranteeing the styling verdict is about exactly the text the plain-frame
   * extraction saw, never a different region of the pane.
   */
  static locatePromptText(lines: string[]): { lineIdx: number; start: number; text: string } | null {
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line || !line.includes('❯')) continue;
      // Take everything after the LAST ❯ on the line, trimmed.
      const idx = line.lastIndexOf('❯');
      const after = line.slice(idx + 1);
      const text = after.trim();
      if (text.length > 0) {
        const start = idx + 1 + (after.length - after.trimStart().length);
        return { lineIdx: i, start, text };
      }
      // Empty prompt line — look at the immediately-following line for
      // wrapped multi-line input. If that's also empty, no stuck text.
      const next = lines[i + 1];
      if (next && next.trim().length > 0 && !StuckInputSentinel.isStatusLine(next)) {
        return {
          lineIdx: i + 1,
          start: next.length - next.trimStart().length,
          text: next.trim(),
        };
      }
      return null;
    }
    return null;
  }

  /**
   * F2 ghost-text gate: capture the SAME pane WITH ANSI escapes and classify
   * how the stuck text is rendered. Every failure path — no ANSI capture
   * support, capture returned null, capture threw — resolves to
   * 'inconclusive', which the caller treats as "do NOT press keys this tick".
   */
  private assessPromptTextPresentation(tmuxSession: string, expectedText: string): PromptTextPresentation {
    let ansiPane: string | null;
    try {
      ansiPane = this.sessionManager.captureOutputAnsi(tmuxSession, 30);
    } catch {
      return 'inconclusive';
    }
    if (!ansiPane) return 'inconclusive';
    return classifyPromptTextPresentation(ansiPane, expectedText);
  }

  /** True if the pane currently shows a Claude Code "working" indicator.
   *
   *  We deliberately use ONLY the footer activity hints (`esc to interrupt`,
   *  `ctrl+t to hide tasks`, `tokens · esc`). Claude Code shows these on the
   *  bottom status line ONLY when a turn is in progress, so they're a
   *  precise tell. We do NOT key on spinner glyphs at line-start (✻, ✶, etc.)
   *  because those persist as part of completed-turn markers like
   *  `✻ Brewed for 14m 11s` and `✻ Churned for 1m 16s` — past-tense renders
   *  that stay in the pane long after the turn finished and the agent went
   *  idle. Live reproduction on echo's 2026-05-11 stuck sessions
   *  (echo-qalatra, echo-exploring-slack-integration) showed both held a
   *  stale `✻ Brewed`/`Churned` line while genuinely idle. Including the
   *  glyph in the working-state check would silently exclude those sessions
   *  from recovery — the most user-visible cases of the bug we're closing.
   *
   *  A false-positive "working" (sentinel skips a session that's actually
   *  idle) leaves the user stuck. A false-negative "idle" (sentinel fires
   *  Enter while the agent is mid-turn) interrupts work. Choosing the
   *  precise tell on the right side: the footer hint is structurally only
   *  present mid-turn, so this can't double-fire against an active session.
   *
   *  Public for unit tests. */
  isPaneActivelyWorking(pane: string): boolean {
    if (ACTIVITY_INDICATORS.some(ind => pane.includes(ind))) return true;
    return false;
  }

  /** Heuristic: lines that look like Claude Code status/separator content
   *  rather than wrapped input. Used to avoid mistaking a separator for
   *  wrapped prompt text in locatePromptText. */
  private static isStatusLine(line: string): boolean {
    const t = line.trim();
    if (!t) return true;
    // Long runs of horizontal box-drawing chars are the input-box border.
    if (/^─+$/.test(t)) return true;
    // The "⏵⏵ bypass permissions" footer.
    if (t.startsWith('⏵⏵ ')) return true;
    return false;
  }

  /** Map attempt index → human-readable action name (matches
   *  SessionManager.fireStuckInputRecovery's escalation). */
  static actionForAttempt(attempt: number): StuckInputEvent['action'] {
    if (attempt === 0 || attempt === 1) return 'Enter';
    if (attempt === 2) return 'C-m';
    return 'Enter-sleep-Enter';
  }

  /**
   * Clear a session's in-flight tier-C recovery request when the session has
   * recovered out-of-band — it's now actively working (the wedge drained) or it
   * is gone. The sentinel is the sole writer of the request file, so it (not the
   * lifeline) does this cleanup. No-op unless a request is actually in flight.
   * This closes the "request lingers after a successful drain" path that the
   * stuck-detection branches would otherwise skip (they early-return before
   * handleEscalation ever reads the ack).
   */
  private finalizePendingRecovery(
    tmuxSession: string, record: SessionStuckRecord | undefined, reason: string,
  ): void {
    if (!record || record.recoveryPhase !== 'requested' || !this.recoveryChannel) return;
    this.recoveryChannel.clearRequest(tmuxSession);
    record.recoveryPhase = 'recovered';
    this.recordEvent({
      ts: new Date(Date.now()).toISOString(),
      session: tmuxSession,
      promptText: record.lastPromptText.slice(0, 200),
      attempt: record.attempts,
      action: 'escalate-recovered',
      outcome: 'recovered',
      tier: 'server-restart-replay',
      error: reason,
    });
  }

  /**
   * Deeper-tier escalation, invoked once the keypress ladder (tier A) is
   * exhausted but the prompt is still stuck. This is the codex session-wedge
   * SELF-recovery path: the sentinel (server process) cannot restart the server
   * itself — ServerSupervisor lives in the lifeline process — so it REQUESTS a
   * tier-C recovery (server restart + queue replay) through SessionRecoveryChannel
   * and the lifeline executes + acks. The sentinel here only signals, polls the
   * ack, verifies, and bounds the wait (no restart loop). Spec:
   * docs/specs/CODEX-SESSION-WEDGE-SELF-RECOVERY.md.
   *
   * Dark by default: with escalation disabled or no channel, this reproduces the
   * legacy behavior exactly (mark the record exhausted and stop).
   *
   * NOTE: a gentler server-side tier B (re-inject the full pending message before
   * requesting a restart) is a planned refinement; this first cut goes A→C.
   */
  private handleEscalation(
    record: SessionStuckRecord, tmuxSession: string, stuckText: string, now: number,
  ): void {
    const channel = this.recoveryChannel;
    if (!this.escalationEnabled || !channel) {
      record.exhausted = true; // legacy behavior
      return;
    }

    const isoNow = new Date(now).toISOString();
    const promptText = stuckText.slice(0, 200);

    if (record.recoveryPhase === 'none') {
      // First escalation — request tier C from the lifeline.
      const attemptId = `${tmuxSession}#${record.firstSeenAt}`;
      const tier: RecoveryTier = 'server-restart-replay';
      try {
        channel.requestRecovery({
          sessionId: tmuxSession,
          tier,
          reason: `keypress ladder exhausted (${this.maxAttempts} attempts); prompt still stuck`,
          observedAt: isoNow,
          attemptId,
          requestedBy: 'StuckInputSentinel',
        });
        record.recoveryPhase = 'requested';
        record.recoveryAttemptId = attemptId;
        record.recoveryRequestedTick = this.tickCounter;
        this.recordEvent({ ts: isoNow, session: tmuxSession, promptText, attempt: record.attempts, action: 'escalate-request', outcome: 'escalated', tier });
      } catch (err) {
        record.exhausted = true; // couldn't even emit the request — stop
        this.recordEvent({ ts: isoNow, session: tmuxSession, promptText, attempt: record.attempts, action: 'escalate-request', outcome: 'fire-error', tier, error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    if (record.recoveryPhase === 'requested') {
      // Poll the lifeline's ack for THIS attempt.
      const ack = channel.readAck(tmuxSession);
      if (ack && ack.attemptId === record.recoveryAttemptId) {
        if (ack.outcome === 'recovered') {
          record.recoveryPhase = 'recovered';
          record.exhausted = true; // terminal; a prompt-text change resets the record
          channel.clearRequest(tmuxSession);
          this.recordEvent({ ts: isoNow, session: tmuxSession, promptText, attempt: record.attempts, action: 'escalate-recovered', outcome: 'recovered', tier: ack.tier });
          return;
        }
        if (ack.outcome === 'failed') {
          record.recoveryPhase = 'gave-up';
          record.exhausted = true;
          channel.clearRequest(tmuxSession);
          this.recordEvent({ ts: isoNow, session: tmuxSession, promptText, attempt: record.attempts, action: 'escalate-failed', outcome: 'gave-up', tier: ack.tier });
          return;
        }
        // 'in-progress' → keep waiting (fall through to the bounded-wait check).
      }
      // Bounded wait: give up after escalationTimeoutTicks with no terminal ack,
      // so a never-acked request can't loop forever.
      const waited = this.tickCounter - (record.recoveryRequestedTick ?? this.tickCounter);
      if (waited >= this.escalationTimeoutTicks) {
        record.recoveryPhase = 'gave-up';
        record.exhausted = true;
        channel.clearRequest(tmuxSession);
        this.recordEvent({ ts: isoNow, session: tmuxSession, promptText, attempt: record.attempts, action: 'escalate-timeout', outcome: 'gave-up', tier: 'server-restart-replay' });
      }
      return;
    }

    // 'recovered' | 'gave-up' → terminal.
    record.exhausted = true;
  }

  /** Append one event row to the JSONL log. Best-effort. */
  private recordEvent(event: StuckInputEvent): void {
    if (this.noPersist) return;
    try {
      fs.mkdirSync(this.stateDir, { recursive: true });
      fs.appendFileSync(this.eventsLogPath, JSON.stringify(event) + '\n');
    } catch (err) {
      console.error(`[StuckInputSentinel] failed to persist event: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Test helper: read the in-memory record for a session. */
  getRecordForTest(tmuxSession: string): SessionStuckRecord | undefined {
    return this.records.get(tmuxSession);
  }

  /** Test helper: clear all in-memory state. */
  resetForTest(): void {
    this.records.clear();
    this.degradationReportedOnce = false;
  }
}

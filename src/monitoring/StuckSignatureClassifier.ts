/**
 * StuckSignatureClassifier — honest turn-receipts.
 *
 * The problem (2026-06-05, three incidents in two days, same symptom): a
 * session is ALIVE and still emitting output, but every turn fails — it is
 * rate-limited, policy-wedged, context-wedged, or out of context. Because the
 * process is alive, PresenceProxy's tier-3 assessment sees "active child
 * processes" and reports "🔭 actively working" — a lie. The user stares at
 * delivery receipts while the session is dead, and finds out by screenshot.
 *
 * This classifier answers the honest question: "is this live session actually
 * able to reply, or is it failing every turn for a known reason?" When it
 * matches, PresenceProxy surfaces the REAL reason instead of "working."
 *
 * Two design rules carried from the ContextWedgeSentinel work:
 *
 *  1. TAIL-GATED. The signature must be in the LIVE TAIL of the capture, not
 *     merely somewhere in scrollback. A session that hit "conversation too
 *     long" an hour ago, recovered, and kept working has that phrase scrolled
 *     far up — matching it anywhere is exactly the false-positive noise the
 *     user flagged ("these messages come up often but the conversation
 *     continues fine"). The live tail is the discriminator between a real
 *     current block and a stale mention.
 *
 *  2. SIGNAL-ONLY. This returns a classification + an honest user-facing
 *     message. It never kills, blocks, or recovers — the caller decides what
 *     to do with the honest answer. Recovery stays with the sentinels.
 *
 * Reuses the wedge detectors (classifyWedgeTail) shipped for the AUP-rejection
 * incident, and adds tail-gated rate-limit + context-too-long detection.
 */

import { classifyWedgeTail } from './ContextWedgeSentinel.js';
import { liveTail as sharedLiveTail } from '../core/paneTail.js';

export type StuckKind =
  | 'rate-limited'      // Claude/provider usage or capacity limit — will clear on its own
  | 'policy-wedge'      // AUP-rejection loop — needs a fresh session (transcript poisoned)
  | 'context-wedge'     // thinking-block-400 — needs a fresh session (transcript corrupted)
  | 'context-too-long'; // conversation exceeded the context window — needs a fresh session

export interface StuckClassification {
  kind: StuckKind;
  /** Honest, plain-language one-liner for the user (no jargon, no localhost). */
  message: string;
  /** Optional extracted detail (e.g. a reset time), for logs/audit. */
  detail?: string;
}

/** Rate-limit / usage-limit pane signatures (the Claude usage-limit form the
 *  RateLimitSentinel does NOT auto-handle — it only owns the capacity throttle).
 *  Anchored on the STATIVE/blocking forms Claude Code prints when it actually
 *  blocks a turn ("You've hit your session limit · resets 10:30pm"), NOT prose
 *  that merely mentions limits ("when you hit your usage limit, the session
 *  pauses") — the same prose-vs-block discriminator the wedge detector uses. */
const RATE_LIMIT_TAIL_PATTERNS: readonly RegExp[] = [
  /you'?ve (?:hit|reached) your (?:session|usage|5-hour) limit/i,
  /usage limit reached/i,
  /(?:session|usage|5-hour) limit reached/i,
  /\blimit\b[^.\n]{0,30}\bresets?\b/i,   // "limit · resets 10:30pm" co-occurrence
];

/** Context-exhaustion pane signatures — the genuine "conversation too long"
 *  block (NOT the normal compaction lifecycle, which recovers on its own). */
const CONTEXT_TOO_LONG_TAIL_PATTERNS: readonly RegExp[] = [
  /conversation (?:is )?too long/i,
  /error during compaction[^.\n]{0,40}too long/i,
  /press esc twice to go up a few messages/i,
];

/** Normal compaction lifecycle phrases — when these are the tail (and no
 *  explicit too-long error is), the session is mid-recovery, not stuck. */
const NORMAL_COMPACTION_TAIL_PATTERNS: readonly RegExp[] = [
  /conversation compacted/i,
  /paused for context compaction/i,
  /compaction[^.\n]{0,20}resumed/i,
  /compaction recovery/i,
];

/** The last `tailLines` non-empty, trimmed lines of a capture, joined.
 *  Delegates to the shared paneTail.liveTail (CMT-1785: one definition of the live
 *  tail) and joins to preserve this module's byte-identical string-matching behavior. */
function liveTail(text: string, tailLines: number): string {
  return sharedLiveTail(text, tailLines).join('\n');
}

function anyMatch(text: string, patterns: readonly RegExp[]): RegExp | null {
  for (const p of patterns) if (p.test(text)) return p;
  return null;
}

/** Extract a human reset hint ("resets 10:30pm", "resets in 5m") if present. */
export function extractResetHint(text: string): string | undefined {
  const m =
    /resets?\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm))/i.exec(text) ??
    /resets?\s+(?:in\s+)?(\d+\s*(?:minutes?|mins?|hours?|hrs?|m|h))\b/i.exec(text);
  return m ? m[1].trim() : undefined;
}

/**
 * Classify a LIVE session from its tmux capture. Returns the honest stuck
 * reason when the live tail shows a known "alive but failing every turn"
 * signature, else null (the session is genuinely working/idle/normal).
 *
 * Precedence reflects recoverability: a wedge (needs a fresh session) and a
 * usage limit (clears on its own) are both more specific/actionable than a
 * generic context-too-long, so they win when co-present in the tail.
 */
export function classifyStuckSignature(
  capture: string,
  tailLines = 12,
): StuckClassification | null {
  if (!capture || !capture.trim()) return null;
  const tail = liveTail(capture, tailLines);

  // Wedges first — most specific, and they reuse the already-tail-gated +
  // (for AUP) repetition-gated detector. classifyWedgeTail does its own tail
  // slicing over the full capture, so pass the whole thing.
  const wedge = classifyWedgeTail(capture);
  if (wedge === 'aup-rejection') {
    return {
      kind: 'policy-wedge',
      message:
        "My session on this thread got stuck on a content-policy error and can't reply here. " +
        "I'm starting a fresh session — please resend your last message.",
    };
  }
  if (wedge === 'thinking-block-400') {
    return {
      kind: 'context-wedge',
      message:
        "My session on this thread hit a stuck-context error and can't continue. " +
        "A fresh session is starting — please resend your last message.",
    };
  }

  // Rate / usage limit — tail-gated. Clears on its own, so the message is
  // reassuring rather than action-demanding.
  if (anyMatch(tail, RATE_LIMIT_TAIL_PATTERNS)) {
    const hint = extractResetHint(tail);
    return {
      kind: 'rate-limited',
      message:
        "I've hit the usage limit, so I can't reply on this thread right now" +
        (hint ? ` (resets ${hint})` : '') +
        '. I\'ll pick back up automatically once it clears — your messages are not lost.',
      detail: hint ? `resets ${hint}` : undefined,
    };
  }

  // Context too long — tail-gated, and suppressed when the tail is the NORMAL
  // compaction lifecycle (which recovers itself). This is the fix for the
  // "conversation too long messages come up often but are just noise" report:
  // a stale mention up in scrollback no longer fires.
  if (anyMatch(tail, CONTEXT_TOO_LONG_TAIL_PATTERNS) && !anyMatch(tail, NORMAL_COMPACTION_TAIL_PATTERNS)) {
    return {
      kind: 'context-too-long',
      message:
        "This conversation got too long for one session. I'm starting a fresh session with your recent history — " +
        "please resend your last message if I don't pick it up.",
    };
  }

  return null;
}

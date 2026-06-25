/**
 * IdleErrorClassifier — precise "did this idle session's turn die on a transient
 * API error?" signal (CMT-1785), replacing a bare `.includes()` over the pane buffer.
 *
 * THE PROBLEM it fixes: the old check fired on any TERMINAL_ERROR_PATTERN appearing
 * ANYWHERE in the last 30 pane lines — so a stale error scrolled up (the turn already
 * recovered), or a token merely QUOTED in content (the agent discussing an API error,
 * a pasted log, or even the agent reading the source that lists these codes), spuriously
 * triggered a transient-API recovery on a healthy session.
 *
 * THE FIX: tail-gate + a two-tier BEGINS-WITH frame discriminator. This is a SIGNAL
 * (Signal vs Authority) — it feeds the existing rateLimitSentinel recovery actuator and
 * gains no blocking authority. The match set is a STRICT SUBSET of the old buffer-wide
 * match, so it can only SUPPRESS spurious fires, never add one.
 *
 * Spec: docs/specs/idle-error-tailgate-corroboration.md
 */

import { liveTail, stripLineLead, wasGlyphLed } from './paneTail.js';

export interface IdleErrorClassification {
  /** The signal: did the turn END in a Claude-emitted transient-API error? */
  isTerminalError: boolean;
  /** Which TERMINAL_ERROR_PATTERN matched (audit). */
  matchedPattern?: string;
  /** The lead-stripped, length-clamped, newline-stripped matched line (audit). */
  matchedLine?: string;
  /** 1-based depth of the match from the end of the tail window (audit). */
  tailDepthFromEnd?: number;
}

/** Tier A: Claude Code's canonical own-API-failure frame. */
const API_ERROR_FRAME = /^api error:/i;
/** Audit clamp for matchedLine. */
const MAX_MATCHED_LINE = 200;
/** Default live-tail window (non-empty lines). 20 clears the post-error input-box chrome
 *  (top/bottom box borders + input row + footer hints + a usage line ≈ 6-12 non-empty rows,
 *  worst case higher) WITH margin, while staying well inside the 45-row capture so a stale
 *  error at the TOP of the buffer (after real recovered work) is still excluded. The frame
 *  discriminator — not the window — carries the quoted-content precision, so a generous
 *  window only risks a rare stale re-fire, which the non-destructive verify-first actuator
 *  absorbs as a no-op (the cheap direction; a MISSED live error costs the 15m idle-kill). */
const DEFAULT_TAIL_LINES = 20;

function startsWithCi(haystack: string, needle: string): boolean {
  return haystack.slice(0, needle.length).toLowerCase() === needle.toLowerCase();
}

function clampLine(line: string): string {
  return line.replace(/[\r\n]+/g, ' ').slice(0, MAX_MATCHED_LINE);
}

/**
 * Classify whether the LIVE TAIL of an idle session's pane shows a Claude-emitted
 * terminal transient-API error (the turn died on it) vs a stale/quoted mention.
 *
 *  - TAIL-GATED: only the last `tailLines` non-empty lines are considered.
 *  - WHOLE-WINDOW SCAN: every tail line is checked (a wrapped error's lead line may sit
 *    mid-window), nearest-the-prompt first.
 *  - FRAME-DISCRIMINATED (two tiers, on the line AFTER stripLineLead()):
 *      Tier A — the stripped line BEGINS WITH `API Error:` (fires alone).
 *      Tier B — the line WAS glyph-led AND the stripped line BEGINS WITH one of `patterns`.
 *    A token merely CONTAINED mid-line (prose / quoted literal / a tool's own `Error:`)
 *    qualifies under neither tier.
 */
export function classifyIdleError(
  paneText: string,
  patterns: readonly string[],
  opts?: { tailLines?: number },
): IdleErrorClassification {
  const miss: IdleErrorClassification = { isTerminalError: false };
  if (!paneText || !paneText.trim()) return miss;

  const tailLines = opts?.tailLines ?? DEFAULT_TAIL_LINES;
  const lines = liveTail(paneText, tailLines);

  // Scan nearest-the-prompt first (the most recent line is the session's terminal state).
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i];
    const stripped = stripLineLead(raw);
    const depthFromEnd = lines.length - i;

    // Tier A — Claude's own `API Error:` frame, fires regardless of glyph lead.
    if (API_ERROR_FRAME.test(stripped)) {
      // Prefer a structured code present on the same framed line as the audit pattern.
      const pat =
        patterns.find((p) => p !== 'API Error:' && stripped.includes(p)) ?? 'API Error:';
      return {
        isTerminalError: true,
        matchedPattern: pat,
        matchedLine: clampLine(stripped),
        tailDepthFromEnd: depthFromEnd,
      };
    }

    // Tier B — a glyph-led line whose content BEGINS WITH one of the terminal patterns.
    if (wasGlyphLed(raw)) {
      const pat = patterns.find((p) => startsWithCi(stripped, p));
      if (pat) {
        return {
          isTerminalError: true,
          matchedPattern: pat,
          matchedLine: clampLine(stripped),
          tailDepthFromEnd: depthFromEnd,
        };
      }
    }
  }

  return miss;
}

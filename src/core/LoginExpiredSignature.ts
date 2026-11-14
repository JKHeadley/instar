/**
 * LoginExpiredSignature — "did this Claude Code session land on a dead login?"
 *
 * THE PROBLEM it fixes (2026-10-18, Mac Studio): a rerouted job session was
 * launched under a pool login whose interactive sign-in had expired. Claude
 * Code printed `⏺ Login expired · Please run /login` and sat at the prompt.
 * The rerouted-session monitor only checks two things — "did it print its
 * completion sentinel?" and "is it past its hard lifetime (480 min)?" — so the
 * dead session held a scheduler slot for eight hours. With `maxParallelJobs: 2`
 * two such sessions stalled every scheduled job on the machine for a day.
 *
 * This is a SIGNAL (Signal vs Authority): a pure, tail-gated, frame-discriminated
 * classifier with no I/O. The callers (SessionManager's rerouted branch, and since
 * CMT-1008 its interactive branch) decide what to do with it. It never touches
 * account/pool state — the QuotaPoller stays the only authority over that.
 *
 * Precision rules (mirroring IdleErrorClassifier):
 *  - TAIL-GATED: only the last `tailLines` non-empty lines are considered, so a
 *    stale mention scrolled up does not count.
 *  - FRAME-DISCRIMINATED: the line must be GLYPH-LED (Claude Code's own rendered
 *    message, e.g. `⏺ `) AND, after the lead is stripped, BEGIN WITH one of the
 *    CLI's own auth-failure phrases. Prose that merely contains "Login expired"
 *    mid-line (an agent discussing the incident, a quoted log) qualifies as
 *    neither.
 */

import { leadGlyphsOf, liveTail, stripLineLead, wasGlyphLed } from './paneTail.js';

/** Claude Code's own "you are not signed in" frames (line-start, after the lead glyph). */
const LOGIN_EXPIRED_FRAMES: readonly RegExp[] = [
  /^login expired\b/i,
  /^oauth token (?:has )?expired\b/i,
  /^invalid api key\b[^\n]{0,40}\/login\b/i,
  /^please run \/login\b/i,
];

/**
 * Newer Claude Code (seen 2026-10-25 on the sagemind agent) prints "Not logged in · Run /login"
 * instead of "Login expired · Please run /login". The same words are ALSO what `claude auth
 * status` prints as tool output (a `⎿`-led line), so this frame counts only when it is the CLI's
 * own message line (`⏺`/`●`-led), never a tool result.
 */
const MESSAGE_LED_ONLY_FRAMES: readonly RegExp[] = [
  /^not logged in\b[^\n]{0,40}\/login\b/i,
];

/** The CLI's own message-line lead (`⏺`, rendered `●` by some terminals) — not a tool result (`⎿`). */
const MESSAGE_LEAD_RE = /[\u23FA\u25CF]/;

const DEFAULT_TAIL_LINES = 12;
const MAX_MATCHED_LINE = 160;

export interface LoginExpiredClassification {
  loginExpired: boolean;
  /** The lead-stripped, clamped matched line (audit only). */
  matchedLine?: string;
  /**
   * True when the matched line was led by the CLI's own message glyph (`⏺`/`●`) rather than a
   * tool-result or box glyph. Only such a frame is strong enough to change pool state (CMT-1008):
   * a `⎿ Please run /login` can be the output of a command the session itself ran.
   */
  messageLed?: boolean;
}

export function classifyLoginExpired(
  paneText: string,
  opts?: { tailLines?: number },
): LoginExpiredClassification {
  if (!paneText || !paneText.trim()) return { loginExpired: false };
  const lines = liveTail(paneText, opts?.tailLines ?? DEFAULT_TAIL_LINES);
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i];
    if (!wasGlyphLed(raw)) continue;
    const stripped = stripLineLead(raw);
    const messageLed = MESSAGE_LEAD_RE.test(leadGlyphsOf(raw));
    if (LOGIN_EXPIRED_FRAMES.some((re) => re.test(stripped))
      || (messageLed && MESSAGE_LED_ONLY_FRAMES.some((re) => re.test(stripped)))) {
      return { loginExpired: true, messageLed, matchedLine: stripped.replace(/[\r\n]+/g, ' ').slice(0, MAX_MATCHED_LINE) };
    }
  }
  return { loginExpired: false };
}

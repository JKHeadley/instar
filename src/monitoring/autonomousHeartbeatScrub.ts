/**
 * autonomousHeartbeatScrub — the deterministic boundary scrub for the
 * AutonomousProgressHeartbeat's interpolated `focus`.
 *
 * Per docs/specs/autonomous-progress-heartbeat.md §Content, `focus` is
 * LLM-derived from conversation/feedback content and therefore
 * attacker-influenceable. Before it is used in the message AND before it is
 * stored into the status route's `lastEmits`, it MUST pass this deterministic
 * boundary scrub:
 *   - run it through the credential/secret/path regex set (reuse of the
 *     credential-leak-detector / PolicyEnforcementLayer patterns);
 *   - on ANY match, DROP focus entirely (the caller falls back to the generic
 *     line) — never emit partially-redacted attacker content;
 *   - length-clamp to ≤200 chars;
 *   - HTML-escape for the Telegram formatter (the message is sent on the
 *     `isProxy` path; focus is interpolated).
 *
 * This is a BOUNDARY SCRUB — a deterministic structural validator, not a new
 * LLM gate — and is therefore signal-vs-authority compliant.
 */

import { escapeHtmlText } from '../messaging/TelegramMarkdownFormatter.js';

/** Max length of the (post-clamp, pre-escape) focus string. */
export const FOCUS_MAX_LENGTH = 200;

/**
 * Credential / secret / path / internal-URL patterns. A reuse of the
 * PolicyEnforcementLayer credential-leak set (kept inline + self-contained so
 * the scrub is a pure, deterministic, unit-testable function with no I/O).
 * On ANY match, focus is dropped.
 */
const SCRUB_PATTERNS: RegExp[] = [
  // ── Credentials / secrets ──
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/,           // Anthropic API key
  /\bsk-[A-Za-z0-9_-]{20,}\b/,               // OpenAI API key
  /\bghp_[A-Za-z0-9]{20,}\b/,                // GitHub PAT
  /\bgho_[A-Za-z0-9]{20,}\b/,                // GitHub OAuth token
  /\bghu_[A-Za-z0-9]{20,}\b/,                // GitHub user-to-server token
  /\bghs_[A-Za-z0-9]{20,}\b/,                // GitHub server-to-server token
  /\bghr_[A-Za-z0-9]{20,}\b/,                // GitHub refresh token
  /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/,         // Slack tokens
  /\bAKIA[0-9A-Z]{12,}\b/,                   // AWS access key
  /\bsk_(?:live|test)_[A-Za-z0-9]{12,}\b/,   // Stripe keys
  /Bearer\s+[A-Za-z0-9_\-.]{20,}/i,          // bearer token
  /(?:password|passwd|pwd|secret|api[_-]?key|token)\s*[:=]\s*\S{6,}/i, // generic secret assignment
  /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/, // PEM private key block
  // ── Sensitive / absolute paths ──
  /\/?\.instar\/[^\s)"']*/,                  // .instar/ paths
  /\/?\.claude\/[^\s)"']*/,                  // .claude/ paths
  /\/Users\/[^\s)"']+/,                      // macOS home paths
  /\/home\/[^\s)"']+/,                       // linux home paths
  // ── Internal URLs ──
  /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?[^\s)]*/i,
];

/** True if `text` matches any credential/secret/path pattern → focus must drop. */
export function focusHasScrubMatch(text: string): boolean {
  if (!text) return false;
  return SCRUB_PATTERNS.some((p) => p.test(text));
}

export interface ScrubResult {
  /** The HTML-escaped, length-clamped focus to interpolate — or null to drop. */
  focus: string | null;
  /** Why focus was dropped (for the status route / observability). */
  dropped: boolean;
  /** The reason a drop happened: 'scrub-match' | 'empty'. Absent when kept. */
  reason?: 'scrub-match' | 'empty';
}

/**
 * Apply the boundary scrub to a raw focus string.
 *  - empty/whitespace → dropped (reason 'empty').
 *  - any scrub match → dropped (reason 'scrub-match') — never partially redacted.
 *  - otherwise → length-clamped to FOCUS_MAX_LENGTH then HTML-escaped.
 *
 * Length-clamp happens BEFORE escape so the 200-char budget is over the visible
 * text, not the escaped expansion. The scrub runs over the RAW text (before
 * clamp) so a secret split across the clamp boundary still trips a pattern.
 */
export function scrubFocus(raw: string | null | undefined): ScrubResult {
  const text = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return { focus: null, dropped: true, reason: 'empty' };
  if (focusHasScrubMatch(text)) return { focus: null, dropped: true, reason: 'scrub-match' };
  const clamped = text.length > FOCUS_MAX_LENGTH ? text.slice(0, FOCUS_MAX_LENGTH) : text;
  const escaped = escapeHtmlText(clamped);
  if (!escaped) return { focus: null, dropped: true, reason: 'empty' };
  return { focus: escaped, dropped: false };
}

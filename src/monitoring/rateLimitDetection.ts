/**
 * Rate-limit (server-side throttle) detection — pure predicate, shared by
 * SessionWatchdog (periodic poll signal) and SessionManager (idle-error path).
 *
 * Distinguishes Anthropic's short-lived shared-capacity throttle
 *   "Server is temporarily limiting requests (not your usage limit) · Rate limited"
 *   "Repeated 529 Overloaded errors"
 * from the account's plan/usage quota (which is PresenceProxy /
 * QuotaExhaustionDetector's domain — wait-for-reset, not retry).
 *
 * Strings are taken from authoritative sources (the user's live screenshot and
 * the Claude Code error reference), NOT invented — see the spec
 * docs/specs/rate-limit-sentinel.md §Detection and the fixtures in
 * tests/unit/rate-limit-detection.test.ts. Treat them as empirical-until-
 * reverified.
 */

/** The throttle is present (shared-capacity, NOT the user's quota). */
export const THROTTLE_PATTERNS: RegExp[] = [
  /server is temporarily limiting requests/i,
  /not your usage limit/i,
  /repeated 529 overloaded errors/i,
  /\b529\b[^\n]*overloaded/i,
];

/**
 * Usage-limit / plan-quota phrasing. If any of these match, this is the user's
 * quota — NOT a server throttle — so the rate-limit sentinel must stand down.
 * (Mirrors PresenceProxy.QUOTA_EXHAUSTION_PATTERNS intent.)
 */
export const USAGE_LIMIT_PATTERNS: RegExp[] = [
  /you've hit your (?:session|weekly|opus|usage) limit/i,
  /\bresets?\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?/i,
  /\/extra-usage to finish/i,
  /usage limit.*reached/i,
];

/**
 * Claude Code's own retry spinner ("Retrying in Ns · attempt x/y"). While this
 * is on the pane the framework is still retrying internally — we do NOT
 * intervene. Keyed on "retrying in <n>" after middot-stripping so encoding /
 * ANSI drift around the `·` can't break the match.
 */
export const RETRY_SPINNER_PATTERN = /retrying in\s+\d+/i;

/** How many trailing pane lines detection inspects. */
export const RATE_LIMIT_CAPTURE_LINES = 20;

/** Replace middot / bullet separators with spaces so matches don't hinge on them. */
export function stripSeparators(s: string): string {
  return s.replace(/[·•∙]/g, ' ');
}

/**
 * True iff the recent pane output indicates an active server-side throttle that
 * we should own: throttle string present, NOT a usage-limit, and Claude is not
 * currently mid-retry.
 *
 * Caller is responsible for the idle-at-prompt precondition (recency); this
 * function only classifies the text.
 */
export function detectRateLimited(snapshot: string | null | undefined): boolean {
  if (!snapshot) return false;
  const recent = stripSeparators(
    snapshot.split('\n').slice(-RATE_LIMIT_CAPTURE_LINES).join('\n'),
  );
  // Still retrying internally → framework owns it.
  if (RETRY_SPINNER_PATTERN.test(recent)) return false;
  // Must look like the throttle.
  if (!THROTTLE_PATTERNS.some(p => p.test(recent))) return false;
  // Must NOT be the user's plan quota.
  if (USAGE_LIMIT_PATTERNS.some(p => p.test(recent))) return false;
  return true;
}

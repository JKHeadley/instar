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

/** How many trailing pane lines detection inspects by default. */
export const RATE_LIMIT_CAPTURE_LINES = 20;

/**
 * Wider window for the settled-throttle backstop (SessionWatchdog). Claude
 * Code's input box + footer + task list + tips can render 15-25 rows BELOW the
 * "API Error: …" line, pushing the throttle string past the default 20-line
 * window — which is precisely why the watchdog never detected it in the wild
 * (the 2026-05-30 "sessions hang on 429" incident). The settled-output guard
 * (see evaluateThrottleSettle) keeps the wider window from matching a stale
 * throttle the session already recovered from.
 */
export const RATE_LIMIT_SETTLED_CAPTURE_LINES = 45;

/** Default time a throttled pane must stay byte-identical before we recover it. */
export const RATE_LIMIT_DEFAULT_SETTLE_MS = 20_000;

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
 * function only classifies the text. `captureLines` widens the inspected
 * trailing-line window (default 20) — callers that scan past the input box use
 * RATE_LIMIT_SETTLED_CAPTURE_LINES.
 */
export function detectRateLimited(
  snapshot: string | null | undefined,
  captureLines: number = RATE_LIMIT_CAPTURE_LINES,
): boolean {
  if (!snapshot) return false;
  const recent = stripSeparators(
    snapshot.split('\n').slice(-captureLines).join('\n'),
  );
  // Still retrying internally → framework owns it.
  if (RETRY_SPINNER_PATTERN.test(recent)) return false;
  // Must look like the throttle.
  if (!THROTTLE_PATTERNS.some(p => p.test(recent))) return false;
  // Must NOT be the user's plan quota.
  if (USAGE_LIMIT_PATTERNS.some(p => p.test(recent))) return false;
  return true;
}

/**
 * A stable fingerprint of the recent pane, used to decide whether the session
 * is *settled* (turn ended) vs still producing work. Trailing whitespace is
 * stripped per line so cursor/animation jitter doesn't read as a change.
 */
export function throttleSignature(
  snapshot: string,
  captureLines: number = RATE_LIMIT_SETTLED_CAPTURE_LINES,
): string {
  return snapshot
    .split('\n')
    .slice(-captureLines)
    .map(l => l.replace(/\s+$/g, ''))
    .join('\n');
}

export type ThrottleSettleDecision = 'no-throttle' | 'waiting' | 'settled';

/** Per-session settle tracking: the last poll's pane fingerprint + when it first appeared. */
export interface ThrottleSettleState {
  sig: string;
  since: number;
}

/**
 * Decide whether a session is genuinely stuck on a *settled* server throttle.
 *
 * The key insight that makes this robust where the old gates failed: an
 * actively-working Claude session animates its spinner and elapsed-timer every
 * tick, so byte-identical pane output across two consecutive polls means NO
 * work is being produced — the turn has ended on the throttle. This needs no
 * process-tree inspection (a lingering background shell used to mask the
 * throttle) and no at-prompt heuristic (the input box used to hide the error).
 *
 * Pure + clock-injected so all timing is unit-testable without real timers.
 *  - 'no-throttle': throttle absent / mid-retry / usage-limit → caller clears tracking.
 *  - 'waiting'    : throttle present but pane changed since last poll, or not settled long enough.
 *  - 'settled'    : throttle present and pane unchanged ≥ settleMs → caller hands to recovery.
 */
export function evaluateThrottleSettle(
  snapshot: string | null | undefined,
  prev: ThrottleSettleState | undefined,
  now: number,
  opts?: { settleMs?: number; captureLines?: number },
): { decision: ThrottleSettleDecision; next: ThrottleSettleState | undefined } {
  const captureLines = opts?.captureLines ?? RATE_LIMIT_SETTLED_CAPTURE_LINES;
  const settleMs = opts?.settleMs ?? RATE_LIMIT_DEFAULT_SETTLE_MS;

  if (!detectRateLimited(snapshot, captureLines)) {
    return { decision: 'no-throttle', next: undefined };
  }
  const sig = throttleSignature(snapshot as string, captureLines);
  if (!prev || prev.sig !== sig) {
    // First sighting, or the pane changed since last poll → (re)start the settle clock.
    return { decision: 'waiting', next: { sig, since: now } };
  }
  if (now - prev.since >= settleMs) {
    return { decision: 'settled', next: prev };
  }
  return { decision: 'waiting', next: prev };
}

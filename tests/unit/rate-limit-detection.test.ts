// Unit tests for the rate-limit (server-side throttle) detection predicate.
// Both sides of the decision boundary, using the EXACT rendered strings from
// the user's live screenshot and the Claude Code error reference (the fixtures
// are the spec's "verify against real APIs" anchor).

import { describe, it, expect } from 'vitest';
import {
  detectRateLimited,
  throttleSignature,
  evaluateThrottleSettle,
  THROTTLE_PATTERNS,
  USAGE_LIMIT_PATTERNS,
  RETRY_SPINNER_PATTERN,
  RATE_LIMIT_SETTLED_CAPTURE_LINES,
  RATE_LIMIT_DEFAULT_SETTLE_MS,
} from '../../src/monitoring/rateLimitDetection.js';

// Exact rendered strings (fixtures).
const THROTTLE_SCREENSHOT =
  'API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited';
const THROTTLE_529 = 'API Error: Repeated 529 Overloaded errors. The API is at capacity.';
const USAGE_WEEKLY = "You've hit your weekly limit · resets Mon 12:00am";
const USAGE_SESSION = "You've hit your session limit · resets 3:45pm (America/Los_Angeles)";
const RETRY_SPINNER = 'Retrying in 7s · attempt 3/10';
const GENERIC_500 = 'API Error: 500 Internal server error. This is a server-side issue.';

function pane(...lines: string[]): string {
  return lines.join('\n');
}

describe('detectRateLimited', () => {
  // ─── Fires (true) ───

  it('fires on the exact throttle string from the screenshot', () => {
    expect(detectRateLimited(pane('❯ doing work', THROTTLE_SCREENSHOT, '❯ '))).toBe(true);
  });

  it('fires on the 529 overloaded form', () => {
    expect(detectRateLimited(pane(THROTTLE_529, '❯ '))).toBe(true);
  });

  it('fires on the "not your usage limit" anchor alone', () => {
    expect(detectRateLimited('something (not your usage limit) happened')).toBe(true);
  });

  // ─── Does NOT fire (false) ───

  it('does NOT fire on a usage/plan limit (weekly)', () => {
    expect(detectRateLimited(pane(USAGE_WEEKLY, '❯ '))).toBe(false);
  });

  it('does NOT fire on a usage/plan limit (session, with reset time)', () => {
    expect(detectRateLimited(pane(USAGE_SESSION, '❯ '))).toBe(false);
  });

  it('does NOT fire on a generic 500 API error', () => {
    expect(detectRateLimited(pane(GENERIC_500, '❯ '))).toBe(false);
  });

  it('does NOT fire while the retry spinner is still showing (framework owns it)', () => {
    expect(detectRateLimited(pane(THROTTLE_SCREENSHOT, RETRY_SPINNER))).toBe(false);
  });

  it('tolerates middot/encoding drift around the spinner separator', () => {
    expect(detectRateLimited(pane(THROTTLE_SCREENSHOT, 'Retrying in 5s  attempt 2/10'))).toBe(false);
  });

  it('is conservative: a stray reset line suppresses (treats as usage domain)', () => {
    expect(detectRateLimited(pane(THROTTLE_SCREENSHOT, 'next window resets 7pm'))).toBe(false);
  });

  it('returns false for empty / null / undefined', () => {
    expect(detectRateLimited('')).toBe(false);
    expect(detectRateLimited(null)).toBe(false);
    expect(detectRateLimited(undefined)).toBe(false);
  });

  it('only inspects recent lines (old throttle scrolled away is ignored)', () => {
    const old = pane(THROTTLE_SCREENSHOT, ...Array(30).fill('continued working fine'), '❯ ');
    expect(detectRateLimited(old)).toBe(false);
  });

  // ─── Pattern sanity ───

  it('pattern arrays are non-empty and the screenshot matches a throttle pattern', () => {
    expect(THROTTLE_PATTERNS.length).toBeGreaterThan(0);
    expect(USAGE_LIMIT_PATTERNS.length).toBeGreaterThan(0);
    expect(THROTTLE_PATTERNS.some(p => p.test(THROTTLE_SCREENSHOT))).toBe(true);
    expect(RETRY_SPINNER_PATTERN.test('retrying in 12')).toBe(true);
  });
});

// The Claude Code input box + footer + task list + tips render ~15-25 rows
// BELOW the "API Error:" line. This is the exact pane shape from the 2026-05-30
// incident — the reason the watchdog (20-line window) never saw the throttle.
function paneWithInputBox(): string {
  return pane(
    '  ⎿  Loaded .worktrees/mentor-stagea-prompt-bound/CLAUDE.md',
    `  ⎿  ${THROTTLE_SCREENSHOT}`,
    '✻ Churned for 7m 43s',
    '',
    '─'.repeat(80),
    '❯ ',
    '─'.repeat(80),
    '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt',
    '  ⎿ Tip: Use /btw to ask a quick side question',
    ...Array(14).fill(''),  // trailing blank rows the terminal pads with
  );
}

describe('detectRateLimited — widened window (input-box regression)', () => {
  it('MISSES the throttle with the default 20-line window (documents the incident)', () => {
    // The error is pushed >20 rows above the bottom by the input box → the old
    // narrow window returns false even though the session is stuck.
    expect(detectRateLimited(paneWithInputBox())).toBe(false);
  });

  it('CATCHES the throttle with the widened settled window', () => {
    expect(detectRateLimited(paneWithInputBox(), RATE_LIMIT_SETTLED_CAPTURE_LINES)).toBe(true);
  });

  it('the widened window still ignores a genuinely old throttle scrolled far away', () => {
    const old = pane(THROTTLE_SCREENSHOT, ...Array(60).fill('continued working fine'), '❯ ');
    expect(detectRateLimited(old, RATE_LIMIT_SETTLED_CAPTURE_LINES)).toBe(false);
  });

  it('the widened window still stands down for usage-limit / mid-retry', () => {
    expect(detectRateLimited(pane(USAGE_WEEKLY, ...Array(10).fill('')), RATE_LIMIT_SETTLED_CAPTURE_LINES)).toBe(false);
    expect(detectRateLimited(pane(THROTTLE_SCREENSHOT, RETRY_SPINNER, ...Array(10).fill('')), RATE_LIMIT_SETTLED_CAPTURE_LINES)).toBe(false);
  });
});

describe('throttleSignature', () => {
  it('is stable across trailing-whitespace / cursor jitter', () => {
    const a = pane('line one', 'API Error: Server is temporarily limiting requests', '❯   ');
    const b = pane('line one', 'API Error: Server is temporarily limiting requests', '❯');
    expect(throttleSignature(a)).toBe(throttleSignature(b));
  });

  it('changes when real content changes (a spinner ticked / new output appeared)', () => {
    const a = pane('✻ Churned for 7m 43s', '❯ ');
    const b = pane('✽ Sock-hopping… (2m 24s)', '❯ ');
    expect(throttleSignature(a)).not.toBe(throttleSignature(b));
  });
});

describe('evaluateThrottleSettle', () => {
  const opts = { settleMs: RATE_LIMIT_DEFAULT_SETTLE_MS, captureLines: RATE_LIMIT_SETTLED_CAPTURE_LINES };
  const stuck = paneWithInputBox();

  it('returns no-throttle when the throttle is absent → caller clears tracking', () => {
    const r = evaluateThrottleSettle(pane('❯ all good', '❯ '), undefined, 1_000, opts);
    expect(r.decision).toBe('no-throttle');
    expect(r.next).toBeUndefined();
  });

  it('first sighting → waiting, and starts the settle clock', () => {
    const r = evaluateThrottleSettle(stuck, undefined, 1_000, opts);
    expect(r.decision).toBe('waiting');
    expect(r.next).toEqual({ sig: throttleSignature(stuck), since: 1_000 });
  });

  it('same pane but not settled long enough → still waiting (clock preserved)', () => {
    const prev = { sig: throttleSignature(stuck), since: 1_000 };
    const r = evaluateThrottleSettle(stuck, prev, 1_000 + 5_000, opts);  // 5s < 20s
    expect(r.decision).toBe('waiting');
    expect(r.next).toEqual(prev);  // since NOT reset — it's the same frozen pane
  });

  it('same pane held past settleMs → settled (hand to recovery)', () => {
    const prev = { sig: throttleSignature(stuck), since: 1_000 };
    const r = evaluateThrottleSettle(stuck, prev, 1_000 + RATE_LIMIT_DEFAULT_SETTLE_MS, opts);
    expect(r.decision).toBe('settled');
  });

  it('pane CHANGED since last poll → waiting with a RESET clock (it was working)', () => {
    const prev = { sig: 'a totally different earlier pane', since: 1_000 };
    const r = evaluateThrottleSettle(stuck, prev, 1_000 + 60_000, opts);
    expect(r.decision).toBe('waiting');
    expect(r.next?.since).toBe(1_000 + 60_000);  // clock restarted — not settled despite 60s elapsed
  });

  it('an actively-working session (throttle scrolled out of window) → no-throttle', () => {
    // Output keeps changing AND the throttle has scrolled away → never settles.
    const working = pane('✽ Sock-hopping… (3m 12s · ↓ 9.1k tokens)', '❯ ');
    const r = evaluateThrottleSettle(working, undefined, 5_000, opts);
    expect(r.decision).toBe('no-throttle');
  });
});

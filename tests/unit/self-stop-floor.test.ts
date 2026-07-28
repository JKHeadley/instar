/**
 * Unit tests for the deterministic self-stop floor.
 * Spec: docs/specs/ux-is-the-product-hardening.md §2.1
 */

import { describe, it, expect } from 'vitest';
import { detectSelfStopShape } from '../../src/core/self-stop-floor.js';

describe('detectSelfStopShape', () => {
  it('detects the 2026-06-27 slip (pause action + huge-session/clean-pass reason)', () => {
    const r = detectSelfStopShape(
      "Why I'm pausing here rather than barreling ahead: not as the tail of an " +
        'already-huge work session — a clean, focused pass is better.',
    );
    expect(r.detected).toBe(true);
    expect(r.actionMatch).toBeTruthy();
    expect(r.reasonMatch).toBeTruthy();
  });

  it('detects restart-avoidance framing', () => {
    const r = detectSelfStopShape(
      "I'll pause here because deploying restarts the agent and I'd rather avoid a restart.",
    );
    expect(r.detected).toBe(true);
  });

  it('detects context-window deferral', () => {
    const r = detectSelfStopShape(
      "Let me pick this up later in a fresh session — I'm running low on context.",
    );
    expect(r.detected).toBe(true);
  });

  it('detects environment-issue-as-stop', () => {
    const r = detectSelfStopShape(
      "I'll pause here — the gate is flagging environment-only failures, so I'll stop and let you look.",
    );
    expect(r.detected).toBe(true);
  });

  it('does NOT detect a legitimate operator-decision question (no self-protective reason)', () => {
    const r = detectSelfStopShape(
      'Before I proceed: ship approach A or B? Either is reversible — your call.',
    );
    expect(r.detected).toBe(false);
  });

  it('does NOT detect an external-blocker wait (legit override)', () => {
    const r = detectSelfStopShape(
      "I'll resume later once the rate limit resets — I'm rate-limited right now.",
    );
    expect(r.detected).toBe(false);
  });

  it('does NOT detect a normal progress report', () => {
    const r = detectSelfStopShape(
      'Shipped the migration and pushed the change; tests are green. Moving to the next task now.',
    );
    expect(r.detected).toBe(false);
  });

  it('does NOT detect an action with no self-protective reason', () => {
    // A pause keyed to a real external dependency, not agent-state.
    const r = detectSelfStopShape('Pausing here until CI is green, then I continue.');
    expect(r.detected).toBe(false);
  });

  it('does NOT detect a reason mention with no stop action (status disclosure)', () => {
    // B15 step-1 analogue: mentioning context while continuing is a PASS.
    const r = detectSelfStopShape(
      "I'm at about 90% context and may compact, but I'm continuing the migration now.",
    );
    expect(r.detected).toBe(false);
  });

  it('handles empty input', () => {
    expect(detectSelfStopShape('').detected).toBe(false);
  });

  // Over-block regression — the second-pass review (2026-06-28) flagged these
  // legitimate messages as false positives under the original over-broad markers.
  // They pair an incidental "stop-ish" word with an incidental "reason-ish" word
  // (a data structure, a UI, a completion) and must NOT be held.
  describe('over-block regressions (must NOT detect)', () => {
    const legitimate = [
      "I'll come back to this edge case next session — the tail of the array is handled.",
      "I'll handle logging as a follow-up; it's a local environment concern, not production.",
      'Let me wrap up here — the compact dashboard layout is done, tests pass.',
      "I'll write a handoff doc covering this work; the migration is complete.",
      'Done a lot of the refactor; the compact view renders correctly now.',
    ];
    for (const msg of legitimate) {
      it(`passes: ${msg.slice(0, 48)}…`, () => {
        expect(detectSelfStopShape(msg).detected).toBe(false);
      });
    }
  });
});

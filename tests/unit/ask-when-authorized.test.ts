/**
 * Unit tests — ask-when-authorized.ts (the SIGNAL detector for the
 * standing-authorization extension of B17_FALSE_BLOCKER).
 *
 * The detector only flags permission-seeking phrasing; it never judges
 * legitimacy (that is the gate's job, combining this with standingAuthorization).
 * So these tests assert detection, NOT verdicts.
 */

import { describe, it, expect } from 'vitest';
import { detectAskWhenAuthorized } from '../../src/core/ask-when-authorized.js';

describe('detectAskWhenAuthorized — flags permission-seeking phrasing', () => {
  for (const t of [
    'The spec is converged — ready for your go-ahead to build?',
    'Shall I proceed with the merge?',
    'Want me to deploy this now?',
    'Approve and I will ship it.',
    'Just say the word and I’ll start.',
    'This is waiting on your approval to continue.',
    'Do you want me to build the structural fix?',
    'Should I build it now or wait?',
    'Let me know if I should merge.',
  ]) {
    it(`asking: ${t.slice(0, 40)}`, () => {
      expect(detectAskWhenAuthorized(t).asking).toBe(true);
    });
  }
});

describe('detectAskWhenAuthorized — does NOT flag non-asking text', () => {
  for (const t of [
    'I built the fix and merged it; here is what changed.',
    'Done — v1.3.688 is deployed and verified live.',
    'I hit a real CI failure and fixed it.',
    'The release pipeline is fully closed.',
    '', // empty
  ]) {
    it(`not asking: ${t.slice(0, 40) || '(empty)'}`, () => {
      expect(detectAskWhenAuthorized(t).asking).toBe(false);
    });
  }

  it('returns the matched phrase, bounded', () => {
    const r = detectAskWhenAuthorized('OK — shall I proceed?');
    expect(r.asking).toBe(true);
    expect(r.phrase).toBeTruthy();
    expect((r.phrase ?? '').length).toBeLessThanOrEqual(60);
  });

  it('handles non-string input safely', () => {
    // @ts-expect-error intentional bad input
    expect(detectAskWhenAuthorized(null).asking).toBe(false);
    // @ts-expect-error intentional bad input
    expect(detectAskWhenAuthorized(undefined).asking).toBe(false);
  });
});

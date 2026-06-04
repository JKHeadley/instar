/**
 * CommitmentSentinel over-detection guard (#49). THE boundary under test:
 * a bare approval / continuation ("please proceed", "yes") must be dropped so
 * it cannot seed a false-positive commitment — WITHOUT dropping a genuine
 * durable request that happens to open with an approval word ("go ahead and
 * deploy", "please change max sessions to 5"). Both sides, with realistic input.
 */

import { describe, it, expect } from 'vitest';
import { isBareContinuation } from '../../src/monitoring/CommitmentSentinel.js';

describe('isBareContinuation — drops bare approvals/continuations (the false-positive source)', () => {
  const BARE = [
    'yes', 'Yes', 'yes please', 'Yes please!', 'yep', 'sure', 'ok', 'okay', 'k',
    'proceed', 'please proceed', 'Please proceed.', 'go ahead', 'go for it', 'do it',
    'continue', 'keep going', 'sounds good', 'sounds great!', 'lgtm', 'ship it',
    'great', 'perfect', 'awesome', 'thanks', 'thank you', 'got it', 'agreed', 'approved',
    'yes approved!', 'no', 'nope', 'stop', '👍', '🎉🎉', '...', 'ok!!!', 'yes go ahead',
  ];
  for (const t of BARE) {
    it(`drops: ${JSON.stringify(t)}`, () => {
      expect(isBareContinuation(t)).toBe(true);
    });
  }
});

describe('isBareContinuation — KEEPS genuine durable requests (no over-filtering)', () => {
  const REAL = [
    'change max sessions to 5',
    'please change the timeout to 10 seconds',
    'turn off auto-updates',
    'go ahead and deploy the latest version',     // opens with "go" but has "deploy"
    'yes, please turn off the daily reports',      // opens with "yes" but has "turn"/"reports"
    'sure, set the model to opus',                 // opens with "sure" but has "set"
    'rewrite the agent-to-agent spec',
    'always check with me before deploying',
    'can you clean up the old logs',
    'please proceed with building the reaper and report back when done', // long + durable
    'ok now restart the gemini server',
  ];
  for (const t of REAL) {
    it(`keeps: ${JSON.stringify(t)}`, () => {
      expect(isBareContinuation(t)).toBe(false);
    });
  }
});

describe('isBareContinuation — edge cases', () => {
  it('treats empty / whitespace / emoji-only as bare', () => {
    expect(isBareContinuation('')).toBe(true);
    expect(isBareContinuation('   ')).toBe(true);
    expect(isBareContinuation('😀')).toBe(true);
  });
});

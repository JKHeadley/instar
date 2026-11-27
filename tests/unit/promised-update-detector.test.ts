/**
 * Tier 1 — promised-update detector (docs/specs/promised-update-capture.md).
 * Both sides of every boundary: promise vs. mention, concrete time vs. vague,
 * and the time arithmetic in the agent's zone (including DST and rollover).
 */
import { describe, it, expect } from 'vitest';
import { detectPromisedUpdate, splitSentences, MAX_HORIZON_MS } from '../../src/monitoring/promisedUpdateDetector.js';

const TZ = 'America/Los_Angeles';
// 2026-11-07 17:01:59 PST (UTC-8) — the moment the live promise was made.
const LIVE_NOW = Date.parse('2026-11-08T01:01:59.712Z');

// The exact message from topic 137342 that went unkept.
const LIVE_MESSAGE =
  "Conversations update (5:01 PM), and sorry, this is half an hour later than I said.\n\n" +
  'I cut the biggest cost in removing a stopped machine: it was re-checking the same signed records on every read, about 80% of the work. That fix is committed and passes its tests.\n\n' +
  'The new timed test with 200 efforts still failed, though. This time the cause is different: one step froze the server for about a minute in a single stretch, so it lost its hold on being the active machine and the removal stopped safely partway. Nothing was lost.\n\n' +
  "Next I'm catching that one-minute freeze in the act to see exactly which step does it, then splitting it up. Still no deploy date until a 200-effort removal finishes cleanly. Next update by about 7 PM.";

describe('the live miss', () => {
  it('catches "Next update by about 7 PM" and resolves it to 7 PM Pacific that day', () => {
    const r = detectPromisedUpdate(LIVE_MESSAGE, LIVE_NOW, TZ);
    expect(r).not.toBeNull();
    expect(new Date(r!.dueAtMs).toISOString()).toBe('2026-11-08T03:00:00.000Z');
    expect(r!.sentence).toBe('Next update by about 7 PM.');
    expect(r!.phrase.toLowerCase()).toContain('7 pm');
  });

  it('the earlier sentence "later than I said" is not a promise', () => {
    expect(detectPromisedUpdate('Conversations update (5:01 PM), and sorry, this is half an hour later than I said.', LIVE_NOW, TZ)).toBeNull();
  });
});

describe('promises that are caught', () => {
  const cases: Array<[string, string]> = [
    ["I'll report back by 6:30 pm.", '2026-11-08T02:30:00.000Z'],
    ['Next status update at 19:00.', '2026-11-08T03:00:00.000Z'],
    ["I'll send the results by 9 AM tomorrow.", '2026-11-08T17:00:00.000Z'],
    ['You will hear from me by noon tomorrow.', '2026-11-08T20:00:00.000Z'],
    ["Not done yet; next update by 8pm.", '2026-11-08T04:00:00.000Z'],
    ["I’ll get back to you around 6 p.m. with the numbers.", '2026-11-08T02:00:00.000Z'],
  ];
  for (const [text, iso] of cases) {
    it(text, () => {
      const r = detectPromisedUpdate(text, LIVE_NOW, TZ);
      expect(r, text).not.toBeNull();
      expect(new Date(r!.dueAtMs).toISOString()).toBe(iso);
    });
  }

  it('relative: "I\'ll check back in 30 minutes"', () => {
    const r = detectPromisedUpdate("I'll check back in 30 minutes.", LIVE_NOW, TZ);
    expect(r!.dueAtMs - LIVE_NOW).toBe(30 * 60_000);
  });

  it('relative: "update within about an hour" and "in half an hour"', () => {
    expect(detectPromisedUpdate("I'll post an update within about an hour.", LIVE_NOW, TZ)!.dueAtMs - LIVE_NOW).toBe(3_600_000);
    expect(detectPromisedUpdate('Next update in half an hour.', LIVE_NOW, TZ)!.dueAtMs - LIVE_NOW).toBe(1_800_000);
  });

  it('a clock time already past today rolls to tomorrow', () => {
    // 23:00 Pacific, "by 9 AM" → next morning.
    const late = Date.parse('2026-11-08T07:00:00.000Z');
    const r = detectPromisedUpdate('Next update by 9 AM.', late, TZ);
    expect(new Date(r!.dueAtMs).toISOString()).toBe('2026-11-08T17:00:00.000Z');
  });

  it('a weekday resolves to its next occurrence', () => {
    // Saturday 2026-11-07 → Monday 2026-11-09 10:00 PST.
    const r = detectPromisedUpdate("I'll send an update by 10 AM Monday.", LIVE_NOW, TZ);
    expect(new Date(r!.dueAtMs).toISOString()).toBe('2026-11-09T18:00:00.000Z');
  });

  it('uses the zone given: the same words mean a different instant in London', () => {
    const r = detectPromisedUpdate('Next update by 7 PM.', Date.parse('2026-11-08T12:00:00.000Z'), 'Europe/London');
    expect(new Date(r!.dueAtMs).toISOString()).toBe('2026-11-08T19:00:00.000Z');
  });

  it('is DST-correct (the day after the fall-back change)', () => {
    // 2026-11-01 is the US fall-back; on 11-02 07:00 PST = 15:00Z.
    const r = detectPromisedUpdate('Next update by 7 AM.', Date.parse('2026-11-02T10:00:00.000Z'), TZ);
    expect(new Date(r!.dueAtMs).toISOString()).toBe('2026-11-02T15:00:00.000Z');
  });
});

describe('things that are not a promised update', () => {
  const none = [
    'The job runs at 7 PM every day.',
    'The build finished at 5:02 PM.',
    'I promised an update by 7 PM and never sent one.',
    "I won't send another update by 7 PM, nothing will change.",
    'No update by 7 PM is needed.',
    "I'll send it later today.",
    "I'll report back by end of day.",
    "I'll report back soon.",
    'Next update by 7.', // no am/pm and not a 24-hour clock
    'Version 2 is at 3.1 now.',
    'Update the config at 19:00 in the cron file.', // instruction, no promise cue
    // Second-pass review: labels and past events are not promises.
    'Status at 14:30: all tests green.',
    'The update at 7 PM failed.',
    'Results at 9:00 AM showed a 4% drop.',
  ];
  for (const text of none) {
    it(text, () => expect(detectPromisedUpdate(text, LIVE_NOW, TZ)).toBeNull());
  }

  it('a clock time that passed a little while ago is a late reference, not tomorrow', () => {
    // 5:20 PM, "by 5 PM" — late, not a promise for 5 PM tomorrow.
    expect(detectPromisedUpdate('Next update by 5 PM.', Date.parse('2026-11-08T01:20:00.000Z'), TZ)).toBeNull();
  });

  it('"tomorrow" with a time that would already be past is still tomorrow, never today', () => {
    const r = detectPromisedUpdate('Next update by 6 PM tomorrow.', LIVE_NOW, TZ);
    expect(new Date(r!.dueAtMs).toISOString()).toBe('2026-11-09T02:00:00.000Z');
  });

  it('a time too close (under two minutes) is not captured', () => {
    expect(detectPromisedUpdate("I'll check back in 1 minute.", LIVE_NOW, TZ)).toBeNull();
  });

  it('a relative time beyond the horizon is not captured', () => {
    const hours = Math.ceil(MAX_HORIZON_MS / 3_600_000) + 1;
    expect(detectPromisedUpdate(`I'll report back in ${hours} hours.`, LIVE_NOW, TZ)).toBeNull();
  });

  it('empty and non-string input', () => {
    expect(detectPromisedUpdate('', LIVE_NOW, TZ)).toBeNull();
    expect(detectPromisedUpdate(undefined as unknown as string, LIVE_NOW, TZ)).toBeNull();
  });

  it('an invalid zone falls back instead of throwing', () => {
    expect(() => detectPromisedUpdate('Next update by 7 PM.', LIVE_NOW, 'Not/AZone')).not.toThrow();
  });
});

describe('splitSentences', () => {
  it('splits on lines and sentence ends but keeps times like 5:01 whole', () => {
    expect(splitSentences('Done at 5:01 PM. Next update by 7 PM.\nThanks')).toEqual(['Done at 5:01 PM.', 'Next update by 7 PM.', 'Thanks']);
  });
});

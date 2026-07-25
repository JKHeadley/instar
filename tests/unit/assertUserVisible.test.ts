import { describe, expect, it } from 'vitest';
import { assertPlainEnglish, assertHonestFailure, assertNoZombie, assertTimely } from '../../src/messaging/detectors/assertUserVisible.js';
import { TestClock } from '../../src/messaging/detectors/clock.js';

describe('user-visible assertions', () => {
  it('accepts clear copy and rejects implementation detail', () => {
    expect(() => assertPlainEnglish('Your message was sent.')).not.toThrow();
    expect(() => assertPlainEnglish('CMT-1003 failed in src/server/routes.ts')).toThrow();
  });

  it('requires an honest actionable failure', () => {
    expect(() => assertHonestFailure({ message: 'Try again in a moment.', actionable: true, ok: false })).not.toThrow();
    expect(() => assertHonestFailure({ message: 'Internal error', actionable: false, ok: false })).toThrow();
  });

  it('rejects stale queued entries as zombies', () => {
    expect(() => assertNoZombie([{ status: 'queued', createdAt: new Date().toISOString() }])).not.toThrow();
    expect(() => assertNoZombie([{ status: 'queued', createdAt: '2020-01-01T00:00:00.000Z' }])).toThrow();
  });

  it('uses an injected clock for timely responses', () => {
    const clock = new TestClock(1_000);
    clock.advance(99);
    expect(() => assertTimely([{ startedAt: 1_000, at: clock.now() }], 100, clock)).not.toThrow();
    clock.advance(2);
    expect(() => assertTimely([{ startedAt: 1_000, at: clock.now() }], 100, clock)).toThrow();
  });
});

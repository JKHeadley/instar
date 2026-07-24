import { describe, expect, it } from 'vitest';
import { assertPlainEnglish, assertHonestFailure, assertNoZombie } from '../../src/messaging/detectors/assertUserVisible.js';

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
});

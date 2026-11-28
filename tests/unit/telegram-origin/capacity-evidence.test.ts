import { describe, expect, it } from 'vitest';
import { newCapacityEvidence, sanitizeCapacityEvidence } from '../../../src/messaging/telegram-origin/OriginCapacityEvidence.js';

describe('bounded secret-free capacity attribution', () => {
  it('retains signed expired lifetime, fractional durations and consumed owner with caller refusal', () => {
    const evidence = { ...newCapacityEvidence('ipc'), stage: 'pre-network' as const, cause: 'grant-expired' as const,
      ownerVerdict: 'consumed' as const, reserveStartedAtMs: 100, reserveEndedAtMs: 120,
      grantExpiresAtMs: 130, consumeStartedAtMs: 125, consumeEndedAtMs: 140, checkedAtMs: 140,
      reserveDurationMs: 20.25, consumeDurationMs: 15.5, remainingAtReserveMs: 10, remainingAtConsumeMs: 5 };
    expect(sanitizeCapacityEvidence(evidence)).toEqual(evidence);
    expect(sanitizeCapacityEvidence({ ...evidence, remainingAtConsumeMs: -1 })).toMatchObject({ remainingAtConsumeMs: -1 });
  });
  it('rejects extra secret fields and invalid numeric/phase values without copying them', () => {
    const e = newCapacityEvidence('direct'), invalid = { version: 1, explanation: 'invalid' };
    for (const patch of [{ token: 'private' }, { reserveDurationMs: NaN }, { reserveStartedAtMs: -1 },
      { cause: 'rate-window-full', stage: 'consume' }, { stage: 'network-start', ownerVerdict: 'unknown' }]) {
      expect(sanitizeCapacityEvidence({ ...e, ...patch })).toEqual(invalid);
    }
    expect(sanitizeCapacityEvidence(invalid)).toEqual(invalid);
  });
  it('preserves positive decisions with invalid optional explanations and negative unknown-cause evidence', () => {
    expect(sanitizeCapacityEvidence({ ...newCapacityEvidence('ipc'), ownerVerdict: 'granted', explanation: 'invalid' }))
      .toMatchObject({ ownerVerdict: 'granted', cause: null, explanation: 'invalid' });
    expect(sanitizeCapacityEvidence({ ...newCapacityEvidence('ipc'), ownerVerdict: 'refused', cause: 'legacy-unexplained', explanation: 'invalid' }))
      .toMatchObject({ ownerVerdict: 'refused', cause: 'legacy-unexplained', explanation: 'invalid' });
  });
});

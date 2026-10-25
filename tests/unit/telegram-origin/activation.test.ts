import { describe, expect, it } from 'vitest';
import { assessOriginActivation, ORIGIN_ACTIVATION_OBLIGATIONS, type OriginEnrollmentSnapshot } from '../../../src/messaging/telegram-origin/OriginActivation.js';

function complete(now = 100_000): OriginEnrollmentSnapshot {
  return { inventoryComplete: true, observations: ORIGIN_ACTIVATION_OBLIGATIONS.map(obligation => ({
    obligation, subject: 'fixture', state: 'ready', reason: 'verified-fixture', observedAt: now, validUntil: now + 30_000,
  })) };
}
describe('Telegram origin rolling activation conjunction', () => {
  it('allows complete coverage only with a complete fresh inventory', () => {
    expect(assessOriginActivation(complete(), 100_000).complete).toBe(true);
    const partial = complete(); partial.inventoryComplete = false;
    expect(assessOriginActivation(partial, 100_000).complete).toBe(false);
    expect(assessOriginActivation(null, 100_000).observations).toHaveLength(ORIGIN_ACTIVATION_OBLIGATIONS.length);
  });
  it.each(ORIGIN_ACTIVATION_OBLIGATIONS)('refuses a missing, held or expired %s obligation', obligation => {
    const missing = complete(); missing.observations = missing.observations.filter(item => item.obligation !== obligation);
    expect(assessOriginActivation(missing, 100_000).complete).toBe(false);
    const held = complete(); held.observations.find(item => item.obligation === obligation)!.state = 'held';
    expect(assessOriginActivation(held, 100_000).complete).toBe(false);
    const expired = complete(); expired.observations.find(item => item.obligation === obligation)!.validUntil = 100_000;
    expect(assessOriginActivation(expired, 100_000).complete).toBe(false);
  });
  it('does not hide an old enabled writer behind a newer ready writer', () => {
    const snapshot = complete(); snapshot.observations.push({ obligation: 'lifeline', subject: 'old-process', state: 'unknown',
      reason: 'writer-protocol-unavailable', observedAt: 100_000, validUntil: 120_000 });
    expect(assessOriginActivation(snapshot, 100_000).complete).toBe(false);
    const duplicate = complete(); duplicate.observations.push(duplicate.observations[0]);
    expect(assessOriginActivation(duplicate, 100_000).inventoryComplete).toBe(false);
    expect(assessOriginActivation(complete(), 130_001).complete).toBe(false);
  });
});

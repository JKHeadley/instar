import { describe, expect, it } from 'vitest';
import { projectOriginNoticePolicy } from '../../../src/messaging/telegram-origin/OriginNoticePolicy.js';
import type { OriginNoticeDestinationPolicy } from '../../../src/messaging/telegram-origin/OriginNoticePolicy.js';

const now = 100_000, destination = { accountId: '123', chatId: '-100123', topicId: '7848' };
const display = { enabled: true, machine: true, harness: true, model: true };
function project(source: OriginNoticeDestinationPolicy | null) {
  return projectOriginNoticePolicy({ id: 'operator-attention-hub', destination, display,
    configObservedAt: now, enabled: true, ownershipValid: true, source, now });
}
function observed(): OriginNoticeDestinationPolicy {
  return { destination, authorized: true, clientPreferences: 'telegram-managed', optedOut: false,
    observerHealthy: true, observedAt: now - 20_000, validUntil: now + 20_000, version: 'authority-1' };
}
describe('independent recording-outage policy projection', () => {
  it('does not infer permission from the configured hub or renew source observation through config refresh', () => {
    expect(project(null)).toBeNull();
    expect(project(observed())).toMatchObject({ authorized: true, observedAt: now - 20_000, validUntil: now + 10_000 });
    expect(project({ ...observed(), observedAt: now - 30_001 })).toBeNull();
  });
  it.each(['optedOut'] as const)('preserves a live %s revocation', key => {
    expect(project({ ...observed(), [key]: true })?.[key]).toBe(true);
  });
  it('rejects expired/unhealthy/unknown policy and a rebound hub destination', () => {
    expect(project({ ...observed(), validUntil: now })).toBeNull();
    expect(project({ ...observed(), observerHealthy: false })).toBeNull();
    expect(project({ ...observed(), optedOut: undefined } as never)).toBeNull();
    expect(project({ ...observed(), destination: { ...destination, topicId: '999' } })).toBeNull();
  });
});

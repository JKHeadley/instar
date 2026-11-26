import { describe, expect, it } from 'vitest';
import { holdPollAtBoot, resolvePollOverride, supportsLeasePollIntent } from '../../../src/lifeline/pollDecision.js';

describe('N72: one poll floor at boot and reconcile', () => {
  it.each([
    [{}, null],
    [{ telegramPolling: false }, 'force-mute'],
    [{ pollOverride: 'force-mute' }, 'force-mute'],
    [{ leaseSelfHeal: { leaseRole: 'observe-only' } }, 'force-mute'],
    [{ leaseSelfHeal: { leaseRole: 'active' } }, null],
    [{ leaseSelfHeal: { leaseRole: null } }, null],
    [{ telegramPolling: false, pollOverride: 'force-poll' }, 'force-poll'],
    [{ leaseSelfHeal: { leaseRole: 'observe-only' }, pollOverride: 'force-poll' }, 'force-poll'],
  ])('resolves %j as %s', (config, expected) => expect(resolvePollOverride(config)).toBe(expected));
  it('observe-only never arms the live boot hold', () => {
    expect(holdPollAtBoot({ followsLeaseEnabled: true, dryRun: false, telegramPolling: true, pollOverride: undefined, leaseSelfHeal: { leaseRole: 'observe-only' } })).toBe(false);
  });
  it('leftover flags without identity cannot require an absent intent producer', () => expect(supportsLeasePollIntent(false)).toBe(false));
  it('independent machines own separate inboxes', () => expect(supportsLeasePollIntent(true, 'independent')).toBe(false));
  it('coordinated machines require lease intent even if the enabled config flag is absent', () => expect(supportsLeasePollIntent(true)).toBe(true));
});

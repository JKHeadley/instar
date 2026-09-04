import { describe, expect, it } from 'vitest';
import { buildQueueAcknowledgement, buildQueueDeliveryNotices } from '../../../src/lifeline/queueDeliveryNotice.js';

describe('queue delivery notice policy', () => {
  it('acknowledges a delayed handoff without falsely claiming a server outage', () => {
    expect(buildQueueAcknowledgement('server-unhealthy', 'message')).toBeNull();
    expect(buildQueueAcknowledgement('healthy-forward-failed', 'message')).toContain('safely queued');
    expect(buildQueueAcknowledgement('healthy-forward-failed', 'message')).not.toContain('server recovered');
  });

  it('does not invent recovery for slow healthy-server handoffs', () => {
    expect(buildQueueDeliveryNotices({ outage: 0, delayedHandoff: 1, legacyUnknown: 0 })).toEqual([
      '✓ Your delayed message has now been delivered to the session.',
    ]);
  });

  it('uses recovery copy for outages and neutral copy for legacy entries', () => {
    expect(buildQueueDeliveryNotices({ outage: 2, delayedHandoff: 0, legacyUnknown: 1 })).toEqual([
      '✓ Server recovered — 2 queued messages delivered.',
      '✓ Your queued message has been delivered.',
    ]);
  });
});

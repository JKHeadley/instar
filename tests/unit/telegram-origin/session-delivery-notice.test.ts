import { describe, expect, it } from 'vitest';
import { lateRecoveredReplyNotice, sessionDeliveryNotice } from '../../../src/messaging/telegram-origin/SessionDeliveryNotice.js';

describe('session delivery notices', () => {
  it('distinguishes delayed, lost, and uncertain replies in plain words', () => {
    expect(sessionDeliveryNotice('held').topicText).toContain('delayed');
    expect(sessionDeliveryNotice('known-failed').topicText).toContain('did not reach you');
    expect(sessionDeliveryNotice('expired', true).topicText).toContain('cannot confirm');
  });
  it('labels a late recovered reply without implying it is the latest answer', () => {
    expect(lateRecoveredReplyNotice(0, 250_000)).toBeNull();
    expect(lateRecoveredReplyNotice(0, 56 * 60_000)).toContain('may be out of order');
  });
});

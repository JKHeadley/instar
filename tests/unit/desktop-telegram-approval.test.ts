import { describe, expect, it } from 'vitest';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';

describe('desktop approval command privacy and sender admission', () => {
  const command = '/desktop 12345678-1234-1234-1234-123456789abc 123456';

  function adapter(): TelegramAdapter {
    const value = Object.create(TelegramAdapter.prototype) as TelegramAdapter & {
      isAuthorizedSender: (uid: number) => boolean;
    };
    value.isAuthorizedSender = uid => uid === 7812716706;
    value.setDesktopApprovalHandler(() => true);
    return value;
  }

  it('consumes malformed desktop commands before ordinary logging', () => {
    const value = adapter();
    expect(value.consumeDesktopApproval({ text: '/desktop 12345678-1234-1234-1234-123456789abc 12345',
      topicId: 131439, senderUid: '7812716706', trusted: true, forwarded: false }))
      .toEqual({ matched: true, approved: false });
  });

  it('requires the authenticated allowed sender and refuses forwarded codes', () => {
    const value = adapter();
    const base = { text: command, topicId: 131439, senderUid: '7812716706', trusted: true, forwarded: false };
    expect(value.consumeDesktopApproval(base)).toEqual({ matched: true, approved: true });
    expect(value.consumeDesktopApproval({ ...base, trusted: false })).toEqual({ matched: true, approved: false });
    expect(value.consumeDesktopApproval({ ...base, forwarded: true })).toEqual({ matched: true, approved: false });
    expect(value.consumeDesktopApproval({ ...base, senderUid: '99' })).toEqual({ matched: true, approved: false });
  });
});

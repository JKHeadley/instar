import { describe, expect, it } from 'vitest';
import { browserSendAllowanceMatches, readBrowserSendAllowance } from '../../../src/messaging/telegram-origin/OriginConfig.js';
import type { OriginDestination } from '../../../src/messaging/telegram-origin/types.js';

const configured = { browserSendAllowance: { profileId: 'justin-telegram', accountId: '7812716706',
  chatId: 'channel:4290919884', topicId: null, decisionRef: 'telegram:102965:2026-10-30:07:17' } };
const destination: OriginDestination = { version: 1, transport: 'telegram-web', accountId: '7812716706',
  chatId: 'channel:4290919884', topicId: null, messageId: null, inlineMessageId: null, scheduledMessageId: null };

describe('singular browser send allowance', () => {
  it('matches only the enrolled profile, account and exact General destination', () => {
    const grant = readBrowserSendAllowance(configured);
    expect(browserSendAllowanceMatches(grant, 'justin-telegram', '7812716706', destination)).toBe(true);
    expect(browserSendAllowanceMatches(grant, 'other-profile', '7812716706', destination)).toBe(false);
    expect(browserSendAllowanceMatches(grant, 'justin-telegram', 'other-account', destination)).toBe(false);
    for (const change of [
      { accountId: '123' }, { chatId: 'channel:123' }, { topicId: '1' }, { messageId: '42' },
      { transport: 'bot-api' as const }, { inlineMessageId: 'x' }, { scheduledMessageId: '1' },
    ]) expect(browserSendAllowanceMatches(grant, 'justin-telegram', '7812716706', { ...destination, ...change })).toBe(false);
  });

  it('rejects absent, malformed and widened grants', () => {
    expect(readBrowserSendAllowance(undefined)).toBeNull();
    expect(readBrowserSendAllowance({ browserSendAllowance: [{ ...configured.browserSendAllowance }] })).toBeNull();
    for (const change of [
      { chatId: 'channel:*' }, { accountId: '*' }, { topicId: '*' }, { decisionRef: '' }, { wildcard: true },
    ]) expect(readBrowserSendAllowance({ browserSendAllowance: { ...configured.browserSendAllowance, ...change } })).toBeNull();
  });
});

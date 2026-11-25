import { expect, it } from 'vitest';
import { matchesFirstPhonePrivateStart } from '../../src/core/trustJourney/firstPhonePrivateStart.js';
import type { Receipt } from '../../src/core/trustJourney/accountPath.js';

const issuedAt = Date.parse('2026-11-25T20:00:00Z');
const start = {
  token: 'synthetic_No-live-link_123', ownerAccountId: '7001', holderEpoch: 'epoch-2',
  holderMachineId: 'fixture-holder', issuedAt, expiresAt: issuedAt + 60_000,
};
const receipt: Receipt = {
  receiptId: 'fixture-receipt', adapter: 'telegram', senderId: '7001', chatId: '7001',
  chatType: 'private', messageId: '123', text: `/start ${start.token}`,
  senderIsBot: false, forwarded: false, uniqueKey: 'fixture-update',
  receivedBy: 'fixture-holder', receivedAt: new Date(issuedAt + 1000).toISOString(),
};

it('allows only the prepared owner to open the disclosure from a fresh direct Telegram update', () => {
  const check = (r: Receipt, owner = '7001', epoch = 'epoch-2', now = issuedAt + 2000) =>
    matchesFirstPhonePrivateStart(start, r, owner, epoch, now);
  expect(check(receipt)).toBe(true);
  for (const patch of [
    { chatType: 'supergroup' }, { chatId: '8001' }, { senderId: '8001' },
    { forwarded: true }, { senderIsBot: true }, { receivedBy: 'other-machine' },
    { text: `/start ${start.token} extra` }, { receivedAt: new Date(issuedAt - 1).toISOString() },
  ]) expect(check({ ...receipt, ...patch })).toBe(false);
  expect(check(receipt, '7001', 'epoch-3')).toBe(false);
  expect(check(receipt, '8001')).toBe(false);
  expect(check(receipt, '7001', 'epoch-2', start.expiresAt)).toBe(false);
});

import { expect, it } from 'vitest';
import { matchesFirstPhonePrivateAccept } from '../../src/core/trustJourney/firstPhonePrivateAccept.js';

const offer = {
  callbackData: 'first-phone:synthetic_fixture_token_123', chatId: '7001', disclosureMessageId: 15,
  proposalHash: 'a'.repeat(64), accountAcceptanceId: 'accepted-fixture', holderEpoch: 'holder-2',
  issuedAt: 100, expiresAt: 300,
};
const tap = {
  callbackData: offer.callbackData, senderId: '7001', senderIsBot: false,
  chatId: '7001', chatType: 'private', messageId: 15, receivedAt: 200,
};
const current = {
  ownerId: '7001', accountAcceptanceId: offer.accountAcceptanceId,
  holderEpoch: offer.holderEpoch, proposalHash: offer.proposalHash,
};

it('binds Accept to the current owner, exact private disclosure and active account acceptance', () => {
  expect(matchesFirstPhonePrivateAccept(offer, tap, current, 210)).toBe(true);
  for (const change of [
    { senderId: '999' }, { senderIsBot: true }, { chatId: '-10099' },
    { chatType: 'supergroup' }, { messageId: 16 }, { callbackData: 'other' }, { receivedAt: 99 },
  ]) {
    expect(matchesFirstPhonePrivateAccept(offer, { ...tap, ...change }, current, 210)).toBe(false);
  }
  for (const change of [
    { accountAcceptanceId: 'new-account' }, { holderEpoch: 'holder-3' },
    { proposalHash: 'b'.repeat(64) }, { ownerId: '999' },
  ]) {
    expect(matchesFirstPhonePrivateAccept(offer, tap, { ...current, ...change }, 210)).toBe(false);
  }
  expect(matchesFirstPhonePrivateAccept(offer, tap, current, 300)).toBe(false);
});

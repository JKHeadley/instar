import { expect, it } from 'vitest';
import { matchesFirstPhoneNomination } from '../../src/core/trustJourney/firstPhoneNomination.js';

const nomination = {
  ownerId: 'owner-1', ownerGeneration: 'owner-v2', holderEpoch: 'epoch-3',
  issuedAt: 250, accountAcceptanceId: 'fixture-acceptance', chatId: '-100123', topicId: 42, challenge: 'synthetic-challenge',
  proposalHash: 'a'.repeat(64), expiresAt: 400,
};
const confirmation = {
  senderId: nomination.ownerId, chatId: nomination.chatId, topicId: nomination.topicId,
  messageId: 9, challenge: nomination.challenge, proposalHash: nomination.proposalHash,
  receivedAt: 300, forwarded: false,
};
const account = { ownerId: nomination.ownerId, ownerGeneration: nomination.ownerGeneration, acceptanceId: 'fixture-acceptance', acceptedAt: 200, approvedAt: 299, approvedProposalHash: nomination.proposalHash };

it('requires a current, previously accepted approval account in addition to an exact topic confirmation', () => {
  expect(matchesFirstPhoneNomination(nomination, confirmation, account, 'epoch-3', 301)).toBe(true);
  expect(matchesFirstPhoneNomination(nomination, confirmation, null, 'epoch-3', 301)).toBe(false);
  expect(matchesFirstPhoneNomination(nomination, confirmation, { ...account, acceptedAt: 300 }, 'epoch-3', 301)).toBe(false);
  expect(matchesFirstPhoneNomination(nomination, confirmation, { ...account, approvedProposalHash: 'b'.repeat(64) }, 'epoch-3', 301)).toBe(false);
  expect(matchesFirstPhoneNomination(nomination, confirmation, { ...account, approvedAt: 249 }, 'epoch-3', 301)).toBe(false);
  expect(matchesFirstPhoneNomination(nomination, confirmation, { ...account, ownerGeneration: 'stale' }, 'epoch-3', 301)).toBe(false);
  expect(matchesFirstPhoneNomination(nomination, confirmation, account, 'epoch-4', 301)).toBe(false);
  expect(matchesFirstPhoneNomination(nomination, confirmation, account, 'epoch-3', 400)).toBe(false);
});

it('refuses forwarded or changed source and proposal fields', () => {
  for (const change of [
    { forwarded: true }, { senderId: 'other' }, { chatId: '-100124' }, { topicId: 43 },
    { messageId: 0 }, { receivedAt: 249 }, { challenge: 'other' }, { proposalHash: 'b'.repeat(64) }, { receivedAt: 302 },
  ]) {
    expect(matchesFirstPhoneNomination(nomination, { ...confirmation, ...change }, account, 'epoch-3', 301)).toBe(false);
  }
});

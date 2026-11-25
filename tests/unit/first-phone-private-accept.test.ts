import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { FirstPhonePrivateNominationStore } from '../../src/core/trustJourney/FirstPhonePrivateNominationStore.js';
import { expect, it } from 'vitest';
import { matchesFirstPhonePrivateAccept } from '../../src/core/trustJourney/firstPhonePrivateAccept.js';

const offer = {
  callbackData: 'first-phone:synthetic_fixture_token_123', chatId: '7001', disclosureMessageId: 15,
  proposalHash: 'a'.repeat(64), accountAcceptanceId: 'accepted-fixture', holderEpoch: 'holder-2',
  firstAcceptanceKey: 'tj:device-acceptance:first:0', issuedAt: 100, expiresAt: 300,
};
const tap = {
  callbackData: offer.callbackData, senderId: '7001', senderIsBot: false,
  chatId: '7001', chatType: 'private', messageId: 15, receivedAt: 200,
};
const current = {
  ownerId: '7001', accountAcceptanceId: offer.accountAcceptanceId,
  holderEpoch: offer.holderEpoch, proposalHash: offer.proposalHash,
  firstAcceptanceKey: offer.firstAcceptanceKey,
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
    { firstAcceptanceKey: 'tj:device-acceptance:first:1' }, { firstAcceptanceKey: null },
  ]) {
    expect(matchesFirstPhonePrivateAccept(offer, tap, { ...current, ...change }, 210)).toBe(false);
  }
  expect(matchesFirstPhonePrivateAccept(offer, tap, current, 300)).toBe(false);
});

it('records at most one nomination per exact private tap and proposal', () => {
  const db = new Database(':memory:');
  try {
    const store = new FirstPhonePrivateNominationStore(db);
    db.transaction(() => {
      expect(() => new FirstPhonePrivateNominationStore(db)).toThrow('top-level schema transaction');
      expect(store.record('receipt-1', offer, tap, current, 210)).toEqual({ status: 'refused' });
    })();
    expect(store.record('receipt-1', offer, tap, {
      ...current, firstAcceptanceKey: 'tj:device-acceptance:first:1',
    }, 210)).toEqual({ status: 'refused' });
    const first = store.record('receipt-1', offer, tap, current, 210);
    if (first.status === 'refused') throw new Error('Expected nomination to be recorded');
    expect(new FirstPhonePrivateNominationStore(db).binding(first.nominationId)).toEqual({
      proposalHash: offer.proposalHash, firstAcceptanceKey: offer.firstAcceptanceKey,
    });
    expect(store.binding('missing')).toBeNull();
    db.transaction(() => expect(store.binding(first.nominationId)).toBeNull())();
    const laterKey = 'tj:device-acceptance:first:1';
    expect(store.record('receipt-1', { ...offer, firstAcceptanceKey: laterKey }, tap,
      { ...current, firstAcceptanceKey: laterKey }, 210)).toEqual({ status: 'refused' });
    expect(store.record('receipt-1', offer, tap, {
      ...current, firstAcceptanceKey: null,
    }, 210)).toEqual({ status: 'refused' });
    expect(store.record('receipt-1', offer, tap, current, 210)).toEqual({
      ...first, status: 'already-recorded',
    });
    expect(store.record('different-receipt', offer, tap, current, 210)).toEqual({ status: 'refused' });
    const otherCallback = 'first-phone:synthetic_fixture_token_456';
    const reissuedOffer = { ...offer, callbackData: otherCallback };
    const reissuedTap = { ...tap, callbackData: otherCallback };
    expect(store.record('receipt-2', reissuedOffer, reissuedTap, current, 210)).toEqual({ status: 'refused' });
    const otherHash = 'b'.repeat(64);
    expect(store.record('receipt-1', { ...reissuedOffer, proposalHash: otherHash }, reissuedTap,
      { ...current, proposalHash: otherHash }, 210)).toEqual({ status: 'refused' });
  } finally {
    db.close();
  }
});

it('leaves an older nomination without a recorded slot unusable after migration', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`
      CREATE TABLE first_phone_private_nominations (
        callback_hash TEXT PRIMARY KEY,
        receipt_id TEXT NOT NULL UNIQUE,
        proposal_hash TEXT NOT NULL UNIQUE,
        nomination_id TEXT NOT NULL UNIQUE
      )
    `);
    db.prepare('INSERT INTO first_phone_private_nominations VALUES (?, ?, ?, ?)').run(
      createHash('sha256').update(offer.callbackData).digest('hex'), 'legacy-receipt', offer.proposalHash, 'legacy',
    );
    const store = new FirstPhonePrivateNominationStore(db);
    expect(store.binding('legacy')).toBeNull();
    expect(store.record('legacy-receipt', offer, tap, current, 210)).toEqual({ status: 'refused' });
  } finally {
    db.close();
  }
});

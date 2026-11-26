import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { FirstPhonePrivateAcceptService } from '../../src/core/trustJourney/FirstPhonePrivateAcceptService.js';
import { TrustJourneyStore } from '../../src/core/trustJourney/TrustJourneyStore.js';
import { FirstPhonePrivateNominationStore } from '../../src/core/trustJourney/FirstPhonePrivateNominationStore.js';
import { expect, it } from 'vitest';
import { matchesFirstPhonePrivateAccept } from '../../src/core/trustJourney/firstPhonePrivateAccept.js';

import { createFirstPhoneOfferResolver } from '../../src/core/trustJourney/firstPhoneOfferResolver.js';
import { firstPhoneProposalHash } from '../../src/core/trustJourney/firstPhoneProposal.js';

const proposal = {
  ownerId: '7001', ownerGeneration: 'owner-1', accountAcceptanceId: 'accepted-fixture',
  holderEpoch: 'holder-2', origin: 'https://paired.example', deviceId: 'phone-1',
  deviceKeyFingerprint: '0123-4567-89AB-CDEF', deviceKeyHash: 'c'.repeat(64), presenceKeyHash: 'a'.repeat(64),
  disclosureHash: 'b'.repeat(64), firstAcceptanceKey: 'tj:device-acceptance:first:0', expiresAt: 300,
};

const offer = {
  callbackData: 'first-phone:synthetic_fixture_token_123', chatId: '7001', disclosureMessageId: 15,
  proposalHash: firstPhoneProposalHash(proposal), accountAcceptanceId: proposal.accountAcceptanceId,
  holderEpoch: proposal.holderEpoch, firstAcceptanceKey: proposal.firstAcceptanceKey,
  issuedAt: 100, expiresAt: proposal.expiresAt,
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

it('changes the proposal digest for every bound authorization input', () => {
  for (const [key, value] of Object.entries(proposal)) {
    const changed = typeof value === 'number' ? value + 1 : value + '-changed';
    expect(firstPhoneProposalHash({ ...proposal, [key]: changed }), key).not.toBe(offer.proposalHash);
  }
});

it('resolves the current private approval account and holder before recording the tap', async () => {
  const db = new Database(':memory:');
  try {
    const trust = new TrustJourneyStore({ description: 'fixture', loadAll: () => [], append: async () => true });
    const nominations = new FirstPhonePrivateNominationStore(db);
    const resolved = { offer, ownerId: current.ownerId, principal: 'owner', holderEpoch: offer.holderEpoch, proposalHash: offer.proposalHash };
    let decision: typeof resolved | null = resolved;
    const service = new FirstPhonePrivateAcceptService({
      trust, nominations, resolveCurrentOffer: () => decision, now: () => 210,
    });
    const recordAcceptance = (fields: Record<string, unknown> = {}) => trust.write('acceptance', {
      acceptanceId: offer.accountAcceptanceId, principal: 'owner', adapter: 'telegram',
      accountId: current.ownerId, acceptedAt: new Date(90).toISOString(), ...fields,
    });

    expect(service.record('receipt-1', tap)).toEqual({ status: 'refused' });
    await recordAcceptance({ acceptedAt: new Date(offer.issuedAt).toISOString() });
    expect(service.record('receipt-1', tap)).toEqual({ status: 'refused' });
    await recordAcceptance();
    decision = null;
    expect(service.record('receipt-1', tap)).toEqual({ status: 'refused' });
    decision = { ...resolved, holderEpoch: 'changed' };
    expect(service.record('receipt-1', tap)).toEqual({ status: 'refused' });
    decision = { ...resolved, proposalHash: 'f'.repeat(64) };
    expect(service.record('receipt-1', tap)).toEqual({ status: 'refused' });

    decision = resolved;
    expect(service.record('receipt-1', tap).status).toBe('recorded');
    expect(service.record('receipt-1', tap).status).toBe('already-recorded');
    await trust.write('device-acceptance', {
      acceptanceId: 'fixture-current-approver', principal: 'owner', deviceId: 'existing-phone',
      via: 'local-install', keyPolicy: 'biometryCurrentSet', acceptedAt: new Date(205).toISOString(),
    });
    expect(service.record('receipt-1', tap)).toEqual({ status: 'refused' });
    await trust.write('device-acceptance-withdrawn', { acceptanceId: 'fixture-current-approver' });
    expect(service.record('receipt-1', tap)).toEqual({ status: 'refused' });
    await trust.write('acceptance-withdrawn', { acceptanceId: offer.accountAcceptanceId });
    expect(service.record('receipt-1', tap)).toEqual({ status: 'refused' });
    expect(trust.currentDeviceAcceptances()).toEqual([]);
  } finally {
    db.close();
  }
});

it('resolves only an exact durable offer for an unexpired committed local holder and current device', () => {
  const { callbackData, ...stored } = offer;
  const digest = createHash('sha256').update(callbackData).digest('hex');
  const holder = { localMachineId: 'local', holderMachineId: 'local', epoch: offer.holderEpoch, expiresAt: 250 };
  const device = { principal: 'owner', proposal };
  let liveHolder: typeof holder | null = holder;
  let liveDevice: typeof device | null = device;
  let now = 210;
  const resolve = createFirstPhoneOfferResolver({
    readStoredOffer: (hash) => hash === digest ? { offer: stored, deviceId: proposal.deviceId, holderMachineId: holder.holderMachineId } : null,
    readVerifiedHolder: () => liveHolder,
    readVerifiedDeviceProposal: (id) => id === proposal.deviceId ? liveDevice : null,
    now: () => now,
  });
  expect(resolve(callbackData)).toMatchObject({ offer, ownerId: current.ownerId, principal: 'owner', proposalHash: offer.proposalHash });
  expect(resolve('first-phone:different_fixture_token_123')).toBeNull();
  for (const state of [null, { ...holder, holderMachineId: 'peer' }, { ...holder, localMachineId: 'peer', holderMachineId: 'peer' }, { ...holder, epoch: 'next' }, { ...holder, expiresAt: now }]) {
    liveHolder = state;
    expect(resolve(callbackData)).toBeNull();
  }
  liveHolder = holder;
  for (const change of [
    { ownerGeneration: 'changed' }, { accountAcceptanceId: 'changed' }, { deviceId: 'changed' },
    { deviceKeyHash: 'd'.repeat(64) }, { presenceKeyHash: 'd'.repeat(64) },
    { origin: 'https://other.example' }, { firstAcceptanceKey: 'tj:device-acceptance:first:1' },
    { disclosureHash: 'd'.repeat(64) },
  ]) {
    liveDevice = { ...device, proposal: { ...proposal, ...change } };
    expect(resolve(callbackData)).toBeNull();
  }
  liveDevice = device;
  liveHolder = { ...holder, expiresAt: 500 };
  now = offer.expiresAt;
  expect(resolve(callbackData)).toBeNull();
});

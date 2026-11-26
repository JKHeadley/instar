import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { createFirstPhoneStartHandler } from '../../src/core/trustJourney/firstPhoneStartHandler.js';
import { FirstPhonePrivateStartStore } from '../../src/core/trustJourney/FirstPhonePrivateStartStore.js';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { issueFirstPhonePrivateOffer } from '../../src/core/trustJourney/firstPhoneOfferIssuance.js';
import { FirstPhonePrivateOfferStore } from '../../src/core/trustJourney/FirstPhonePrivateOfferStore.js';
import Database from 'better-sqlite3';
import { FirstPhonePrivateAcceptService } from '../../src/core/trustJourney/FirstPhonePrivateAcceptService.js';
import { TrustJourneyStore } from '../../src/core/trustJourney/TrustJourneyStore.js';
import { FirstPhonePrivateNominationStore } from '../../src/core/trustJourney/FirstPhonePrivateNominationStore.js';
import { expect, it, vi } from 'vitest';
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

it('recovers the immutable acknowledged offer from disk without saving the button token', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'first-phone-offer-'));
  const dbPath = path.join(dir, 'offers.sqlite');
  let db = new Database(dbPath);
  try {
    const { callbackData, ...fields } = offer;
    const expected = { offer: fields, deviceId: proposal.deviceId, holderMachineId: 'holder-machine' };
    const store = new FirstPhonePrivateOfferStore(db);
    expect(store.saveAcknowledged(callbackData, { ...expected, offer: { ...fields, disclosureMessageId: 0 } })).toBe(false);
    expect(store.saveAcknowledged(callbackData, expected)).toBe(true);
    expect(store.saveAcknowledged(callbackData, { ...expected, deviceId: 'another-phone' })).toBe(false);
    expect(store.saveAcknowledged('first-phone:another_fixture_token_123', expected)).toBe(false);
    const callbackHash = createHash('sha256').update(callbackData).digest('hex');
    expect(db.prepare('SELECT callback_hash FROM first_phone_private_offers').all()).toEqual([{ callback_hash: callbackHash }]);
    db.close();

    db = new Database(dbPath);
    const reopened = new FirstPhonePrivateOfferStore(db);
    expect(reopened.lookup(callbackHash)).toEqual(expected);
    expect(reopened.lookup(callbackData)).toBeNull();
    db.transaction(() => {
      expect(reopened.lookup(callbackHash)).toBeNull();
      expect(reopened.saveAcknowledged('first-phone:third_fixture_token_123', expected)).toBe(false);
    })();
  } finally {
    db.close();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'test first-phone offer store' });
  }
});

it('saves only a direct acknowledged offer which is still current after Telegram returns', async () => {
  const db = new Database(':memory:');
  try {
    const offers = new FirstPhonePrivateOfferStore(db);
    const { callbackData: _callback, disclosureMessageId: _message, ...fields } = offer;
    const disclosure = 'Exact disclosure';
    const exactProposal = { ...proposal, disclosureHash: createHash('sha256').update(disclosure).digest('hex') };
    const prepared = {
      offer: { ...fields, proposalHash: firstPhoneProposalHash(exactProposal) },
      deviceId: proposal.deviceId, holderMachineId: 'holder-machine', disclosure, proposal: exactProposal,
    };
    let current = false;
    let now = 200;
    const sendPrivate = vi.fn(async (_chatId: string, _disclosure: string, _callback: string) => ({ chatId: prepared.offer.chatId, messageId: 15 }));
    const deps = { offers, sendPrivate, stillCurrent: () => current, now: () => now };
    const sentDigest = () => createHash('sha256').update(sendPrivate.mock.lastCall![2]).digest('hex');

    expect(await issueFirstPhonePrivateOffer(deps, prepared)).toEqual({ status: 'unavailable' });
    expect(sendPrivate).not.toHaveBeenCalled();
    current = true;
    expect(await issueFirstPhonePrivateOffer(deps, { ...prepared, disclosure: 'wrong text' })).toEqual({ status: 'unavailable' });
    expect(sendPrivate).not.toHaveBeenCalled();
    sendPrivate.mockResolvedValueOnce({ chatId: '999', messageId: 15 });
    expect(await issueFirstPhonePrivateOffer(deps, prepared)).toEqual({ status: 'unavailable' });
    expect(offers.lookup(sentDigest())).toBeNull();
    sendPrivate.mockImplementationOnce(async () => {
      current = false;
      return { chatId: prepared.offer.chatId, messageId: 15 };
    });
    expect(await issueFirstPhonePrivateOffer(deps, prepared)).toEqual({ status: 'unavailable' });
    expect(offers.lookup(sentDigest())).toBeNull();
    current = true;
    sendPrivate.mockImplementationOnce(async () => {
      now = prepared.offer.expiresAt;
      return { chatId: prepared.offer.chatId, messageId: 15 };
    });
    expect(await issueFirstPhonePrivateOffer(deps, prepared)).toEqual({ status: 'unavailable' });
    expect(offers.lookup(sentDigest())).toBeNull();

    now = 210;
    expect(await issueFirstPhonePrivateOffer(deps, prepared)).toEqual({ status: 'recorded', messageId: 15 });
    expect(sendPrivate).toHaveBeenLastCalledWith(prepared.offer.chatId, prepared.disclosure, expect.stringMatching(/^first-phone:[A-Za-z0-9_-]{43}$/));
    expect(offers.lookup(sentDigest())).toEqual({
      offer: { ...prepared.offer, disclosureMessageId: 15 }, deviceId: prepared.deviceId, holderMachineId: prepared.holderMachineId,
    });
  } finally {
    db.close();
  }
});

it('issues the exact offer once from an authenticated Start and drops acknowledgement after a holder change', async () => {
  const db = new Database(':memory:');
  try {
    const starts = new FirstPhonePrivateStartStore(db);
    const offers = new FirstPhonePrivateOfferStore(db);
    const { callbackData: _callback, disclosureMessageId: _message, ...fields } = offer;
    const disclosure = 'Exact disclosure';
    const exactProposal = { ...proposal, disclosureHash: createHash('sha256').update(disclosure).digest('hex') };
    const prepared = {
      offer: { ...fields, proposalHash: firstPhoneProposalHash(exactProposal) },
      deviceId: proposal.deviceId, holderMachineId: 'holder-machine', disclosure, proposal: exactProposal,
    };
    const originalAuthority = {
      ownerAccountId: prepared.offer.chatId, localMachineId: prepared.holderMachineId,
      holderMachineId: prepared.holderMachineId, epoch: prepared.offer.holderEpoch, expiresAt: 400,
    };
    let authority = originalAuthority;
    const startReceipt = (updateId: number) => {
      const token = starts.prepare({
        ownerAccountId: originalAuthority.ownerAccountId, holderEpoch: originalAuthority.epoch,
        holderMachineId: originalAuthority.holderMachineId, proposalHash: prepared.offer.proposalHash,
        issuedAt: 100, expiresAt: 300,
      });
      return {
        text: `/start ${token}`, adapter: 'telegram' as const, receiptId: `tg-${updateId}`, uniqueKey: `tg-update:${updateId}`,
        senderId: offer.chatId, chatId: offer.chatId, chatType: 'private', messageId: String(updateId),
        senderIsBot: false, forwarded: false, receivedAt: new Date(190).toISOString(),
      };
    };
    const sendPrivate = vi.fn(async (chatId: string, _text: string, _data: string) => ({ chatId, messageId: 15 }));
    const readPreparedOffer = vi.fn(() => prepared);
    const handle = createFirstPhoneStartHandler({
      starts, offers, readAuthority: () => authority, readPreparedOffer,
      stillCurrent: () => true, now: () => 200, sendPrivate,
    });
    const digest = () => createHash('sha256').update(sendPrivate.mock.lastCall![2]).digest('hex');
    const receipt = startReceipt(12);
    await handle({ ...receipt, senderId: '8001' });
    authority = { ...originalAuthority, holderMachineId: 'other-holder' };
    await handle(receipt);
    expect(readPreparedOffer).not.toHaveBeenCalled();

    authority = originalAuthority;
    readPreparedOffer.mockReturnValueOnce({ ...prepared, offer: { ...prepared.offer, proposalHash: 'b'.repeat(64) } });
    await handle(startReceipt(14));
    expect(sendPrivate).not.toHaveBeenCalled();
    await handle(receipt);
    expect(readPreparedOffer).toHaveBeenCalledWith(prepared.offer.proposalHash);
    expect(offers.lookup(digest())?.offer.disclosureMessageId).toBe(15);
    await handle(receipt);
    expect(sendPrivate).toHaveBeenCalledTimes(1);

    sendPrivate.mockImplementationOnce(async chatId => {
      authority = { ...originalAuthority, epoch: 'holder-3' };
      return { chatId, messageId: 16 };
    });
    await handle(startReceipt(13));
    expect(sendPrivate).toHaveBeenCalledTimes(2);
    expect(offers.lookup(digest())).toBeNull();
  } finally {
    db.close();
  }
});

it('connects direct Telegram Start and Accept to one durable nomination without accepting the phone', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'first-phone-telegram-journey-'));
  const db = new Database(':memory:');
  try {
    const adapter = new TelegramAdapter({ token: 'fixture-bot', chatId: '-100999' }, stateDir);
    vi.spyOn(adapter, 'getVerifiedOwner').mockReturnValue(7001);
    const answer = vi.spyOn(adapter, 'answerCallback').mockResolvedValue();
    const api = vi.spyOn(adapter as unknown as {
      apiCall(method: string, payload: unknown): Promise<unknown>;
    }, 'apiCall');
    const starts = new FirstPhonePrivateStartStore(db);
    const offers = new FirstPhonePrivateOfferStore(db);
    const nominations = new FirstPhonePrivateNominationStore(db);
    const trust = new TrustJourneyStore({ description: 'fixture', loadAll: () => [], append: async () => true });
    const issuedAt = Date.now() - 100;
    const expiresAt = issuedAt + 60_000;
    await trust.write('acceptance', {
      acceptanceId: offer.accountAcceptanceId, principal: 'owner', adapter: 'telegram',
      accountId: '7001', acceptedAt: new Date(issuedAt - 1).toISOString(),
    });
    const disclosure = 'Allow this iPhone to approve changes. Confirm in Instar.';
    const deviceProposal = {
      ...proposal, firstAcceptanceKey: trust.firstDeviceAcceptanceKey(),
      disclosureHash: createHash('sha256').update(disclosure).digest('hex'),
    };
    const exactProposal = { ...deviceProposal, expiresAt };
    const proposalHash = firstPhoneProposalHash(exactProposal);
    const { callbackData: _callback, disclosureMessageId: _message, ...fields } = offer;
    const prepared = {
      offer: { ...fields, firstAcceptanceKey: exactProposal.firstAcceptanceKey, proposalHash, issuedAt, expiresAt },
      deviceId: exactProposal.deviceId, holderMachineId: 'holder-machine', disclosure, proposal: exactProposal,
    };
    const holder = { localMachineId: 'holder-machine', holderMachineId: 'holder-machine', epoch: offer.holderEpoch, expiresAt };
    adapter.onFirstPhonePrivateStart = createFirstPhoneStartHandler({
      starts, offers, now: Date.now, stillCurrent: () => true,
      readAuthority: () => ({ ...holder, ownerAccountId: '7001' }),
      readPreparedOffer: hash => hash === proposalHash ? prepared : null,
      sendPrivate: adapter.sendFirstPhonePrivateOffer.bind(adapter),
    });
    const accept = new FirstPhonePrivateAcceptService({
      trust, nominations, now: Date.now,
      resolveCurrentOffer: createFirstPhoneOfferResolver({
        readStoredOffer: hash => offers.lookup(hash),
        readVerifiedHolder: () => holder,
        readVerifiedDeviceProposal: () => ({ principal: 'owner', proposal: deviceProposal }),
        now: Date.now,
      }),
    });
    const record = vi.spyOn(accept, 'record');
    adapter.onFirstPhonePrivateAccept = async (receiptId, evidence) => accept.record(receiptId, evidence).status !== 'refused';
    const phoneLink = starts.prepare({
      ownerAccountId: '7001', holderMachineId: holder.holderMachineId, holderEpoch: holder.epoch,
      proposalHash, issuedAt, expiresAt,
    });
    expect(phoneLink).toEqual(expect.any(String));
    const chat = { id: 7001, type: 'private' };
    const from = { id: 7001, is_bot: false };
    const date = Math.floor(issuedAt / 1000);
    const direct = (update: unknown) => (adapter as unknown as {
      processUpdate(update: unknown): Promise<void>;
    }).processUpdate(update);
    const startUpdate = { update_id: 12, message: { message_id: 12, chat, from, date, text: `/start ${phoneLink}` } };
    api.mockImplementationOnce(async (_method, payload) => ({ ...(payload as object), chat, message_id: 15 }));

    await direct(startUpdate);
    await direct(startUpdate);
    expect(api).toHaveBeenCalledTimes(1);
    expect(record).not.toHaveBeenCalled();
    const payload = api.mock.calls[0][1] as { reply_markup: { inline_keyboard: Array<Array<{ callback_data: string }>> } };
    const data = payload.reply_markup.inline_keyboard[0][0].callback_data;
    const callback = { id: 'fixture-tap', from, message: { message_id: 15, chat, date }, data };
    await adapter.handleForwardedCallback(callback);
    expect(record).not.toHaveBeenCalled();
    await direct({ update_id: 13, callback_query: callback });
    await direct({ update_id: 13, callback_query: callback });
    expect(record.mock.results.map(result => result.value.status)).toEqual(['recorded', 'already-recorded']);
    const result = record.mock.results[0].value;
    if (result.status === 'refused') throw new Error('Expected the direct tap to record a nomination');
    expect(nominations.binding(result.nominationId)).toEqual({ proposalHash, firstAcceptanceKey: exactProposal.firstAcceptanceKey });
    expect(answer).toHaveBeenLastCalledWith(callback.id, 'Continue in Instar on the nominated iPhone.');
    expect(trust.currentDeviceAcceptances()).toEqual([]);
  } finally {
    db.close();
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'test first-phone Telegram journey' });
  }
});

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { FirstPhonePrivateStartStore } from '../../src/core/trustJourney/FirstPhonePrivateStartStore.js';
import { expect, it } from 'vitest';
import { matchesFirstPhonePrivateStart } from '../../src/core/trustJourney/firstPhonePrivateStart.js';
import type { Receipt } from '../../src/core/trustJourney/accountPath.js';

const issuedAt = Date.parse('2026-11-25T20:00:00Z');
const start = {
  token: 'fp1_synthetic_No-live-link_123', ownerAccountId: '7001', holderEpoch: 'epoch-2',
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

it('persists only the locator digest and claims the exact proposal once across connections and restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'first-phone-locator-'));
  const filename = path.join(dir, 'locator.db');
  const proposalHash = 'a'.repeat(64);
  const { token: _fixtureToken, ...context } = start;
  const locator = { ...context, proposalHash };
  try {
    const db = new Database(filename);
    const peer = new Database(filename);
    let actualReceipt: Receipt;
    try {
      const first = new FirstPhonePrivateStartStore(db);
      const second = new FirstPhonePrivateStartStore(peer);
      const token = first.prepare(locator);
      expect(token).toMatch(/^fp1_[A-Za-z0-9_-]{43}$/);
      expect(db.prepare('SELECT token_hash FROM first_phone_private_starts').pluck().all()).toEqual([
        createHash('sha256').update(token!).digest('hex'),
      ]);
      actualReceipt = { ...receipt, text: `/start ${token}` };
      const now = issuedAt + 2000;
      for (const patch of [
        { forwarded: true }, { senderId: '8002' }, { receivedBy: 'other-holder' }, { text: receipt.text },
      ]) expect(first.claim({ ...actualReceipt, ...patch }, '7001', 'epoch-2', now)).toBeNull();
      expect(first.claim(actualReceipt, '7001', 'epoch-3', now)).toBeNull();
      expect(first.claim(actualReceipt, '7001', 'epoch-2', locator.expiresAt)).toBeNull();
      expect(first.prepare({ ...locator, expiresAt: issuedAt + 60 * 60_000 })).toBeNull();
      expect(second.claim(actualReceipt, '7001', 'epoch-2', now)).toBe(proposalHash);
      expect(first.claim(actualReceipt, '7001', 'epoch-2', now)).toBeNull();
    } finally {
      peer.close();
      db.close();
    }
    const reopened = new Database(filename);
    try {
      expect(new FirstPhonePrivateStartStore(reopened).claim(actualReceipt!, '7001', 'epoch-2', issuedAt + 2000)).toBeNull();
    } finally {
      reopened.close();
    }
  } finally {
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'test first-phone Start store' });
  }
});

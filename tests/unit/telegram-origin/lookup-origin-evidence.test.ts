/**
 * message-origin-all-platforms §4 (Telegram join): one bounded, read-only, indexed lookup returns
 * the producer evidence behind a page of delivered messages, by (transport, chat, message id).
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { OriginStore } from '../../../src/messaging/telegram-origin/OriginStore.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { admission, compileOriginWorker, hash, temporaryState } from '../../helpers/telegramOriginStore.js';
import type { OriginAdmission } from '../../../src/messaging/telegram-origin/StoreTypes.js';

let worker: URL;
const stores: OriginStore[] = [], stateDirs: string[] = [];
beforeAll(async () => { worker = await compileOriginWorker(); }, 30_000);
afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.close()));
  for (const state of stateDirs.splice(0)) SafeFsExecutor.safeRmSync(state, { recursive: true, force: true, operation: 'tests/unit/telegram-origin/lookup-origin-evidence.test.ts:cleanup' });
});
async function open() {
  const stateDir = temporaryState(); stateDirs.push(stateDir);
  const store = await OriginStore.open({ stateDir, agentId: 'echo', requestTimeoutMs: 20_000 }, worker); stores.push(store);
  return { store, database: path.join(stateDir, 'state/pending-relay.echo.sqlite') };
}
const evidence = (value: string) => ({ value, status: 'observed', sourceEventRef: 'x', observedAt: 1, reason: null });
function withProducer(input: OriginAdmission): OriginAdmission {
  const envelopeJson = JSON.stringify({ ...JSON.parse(input.record.envelopeJson), producerKind: 'session', originMachineId: 'studio',
    originMachineName: 'Mac Studio', harnessName: 'Claude Code', machine: evidence('Mac Studio'), harness: evidence('claude-code'), model: evidence('claude-opus-5-5'),
    attestation: { signature: 'not-returned' } });
  return { ...input, record: { ...input.record, envelopeJson, envelopeDigest: hash(envelopeJson) } };
}
async function delivered(store: OriginStore, input: OriginAdmission, messageId: number) {
  await store.admit(input);
  const child = input.children[0];
  const claim = await store.claim({ childId: child.childId, materializationId: child.materializations[0].materializationId, ownerBootId: 'boot-1', leaseMs: 60_000, now: input.preparedAt + 1 });
  if (claim.status !== 'claimed') throw new Error('fixture claim unavailable');
  await store.markDispatched({ ...claim.child, now: input.preparedAt + 2 });
  await store.recordOutcome({ ...claim.child, outcome: 'accepted', receiptJson: JSON.stringify({ messageId }), now: input.preparedAt + 3 });
}

describe('lookupOriginEvidence', () => {
  it('returns only the producer evidence for found messages and nothing for misses', async () => {
    const { store } = await open();
    await delivered(store, withProducer(admission('a')), 501);
    const page = await store.lookupOriginEvidence({ transport: 'bot-api', chatId: '-100123', messageIds: ['501', '999'] });
    expect(page.results).toEqual([{ messageId: '501', state: 'found', producer: {
      producerKind: 'session', originMachineId: 'studio', originMachineName: 'Mac Studio', harnessName: 'Claude Code',
      machine: evidence('Mac Studio'), harness: evidence('claude-code'), model: evidence('claude-opus-5-5'),
    } }]);
    expect(JSON.stringify(page)).not.toContain('not-returned'); // never the signature or other envelope fields
  });
  it('is scoped by chat: the same message id in another chat is not a match', async () => {
    const { store } = await open();
    await delivered(store, withProducer(admission('b')), 77);
    expect((await store.lookupOriginEvidence({ transport: 'bot-api', chatId: '-100999', messageIds: ['77'] })).results).toEqual([]);
  });
  it('rejects an oversized page', async () => {
    const { store } = await open();
    await expect(store.lookupOriginEvidence({ transport: 'bot-api', chatId: '-100123', messageIds: Array.from({ length: 101 }, (_, i) => String(i)) })).rejects.toThrow();
  });
  it('is served by the (transport, chat_id, message_id) index, not a scan', async () => {
    const { store, database } = await open();
    await delivered(store, withProducer(admission('c')), 9);
    const db = new Database(database, { readonly: true });
    try {
      const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT origin_id FROM telegram_origin_platform_receipts WHERE transport=? AND chat_id=? AND message_id IN (?,?)`)
        .all('bot-api', '-100123', '9', '10') as Array<{ detail: string }>;
      expect(plan.map(p => p.detail).join(' ')).toContain('telegram_origin_receipt_message');
    } finally { db.close(); }
  });
});

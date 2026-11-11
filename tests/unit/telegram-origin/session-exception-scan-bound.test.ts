import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { OriginStore } from '../../../src/messaging/telegram-origin/OriginStore.js';
import { SESSION_REPLY_OUT_OF_ORDER_SQL } from '../../../src/messaging/telegram-origin/OriginStoreBackend.js';
import { compileOriginWorker, temporaryState } from '../../helpers/telegramOriginStore.js';

let worker: URL;
const stores: OriginStore[] = [];
beforeAll(async () => { worker = await compileOriginWorker(); });
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); });

const BASE = 1793811600000 + 1000;
const CHAT = '-100123', TOPIC = '12';
const SESSION_RECORD = JSON.stringify({ envelopeJson: JSON.stringify({ producerKind: 'session', operationKind: 'sendMessage' }) });

interface Seed { id: string; preparedAt: number; acceptedAt: number; messageId: number }
function seed(db: Database.Database, rows: Seed[], archivedReceipts = 0): void {
  const origin = db.prepare('INSERT INTO telegram_origins(origin_id,machine_id,created_at,envelope_digest,record_json) VALUES (?,?,?,?,?)');
  const destination = db.prepare('INSERT INTO telegram_origin_destinations VALUES (?,?,?,?,?)');
  const operation = db.prepare("INSERT INTO telegram_origin_operations(operation_id,origin_id,admission_digest,prepared_at,deadline_at,max_attempts,payload_bytes,state,kind) VALUES (?,?,?,?,?,9,10,'accepted','ordinary')");
  const child = db.prepare("INSERT INTO telegram_origin_children VALUES (?,?,?,'{}','d',0,'accepted','[]')");
  const attempt = db.prepare("INSERT INTO telegram_origin_attempts VALUES (?,?,'m',?,'owner','dispatched','accepted',NULL,?,?)");
  const receipt = db.prepare("INSERT INTO telegram_origin_platform_receipts VALUES (?,?,'bot-api','bot-1',?,?,?)");
  db.transaction(() => {
    for (const row of rows) {
      origin.run(`o-${row.id}`, 'studio', row.preparedAt, 'digest', SESSION_RECORD);
      destination.run(`o-${row.id}`, 'bot-api', 'bot-1', CHAT, TOPIC);
      operation.run(`op-${row.id}`, `o-${row.id}`, 'digest', row.preparedAt, row.preparedAt + 3600_000);
      child.run(`c-${row.id}`, `op-${row.id}`, `d-${row.id}`);
      attempt.run(`a-${row.id}`, `c-${row.id}`, `t-${row.id}`, row.preparedAt, row.acceptedAt);
      receipt.run(`c-${row.id}`, `o-${row.id}`, CHAT, TOPIC, String(row.messageId));
    }
    for (let i = 0; i < archivedReceipts; i++) receipt.run(`old-${i}`, `old-${i}`, CHAT, TOPIC, String(i + 1));
  })();
}
async function open() {
  const store = await OriginStore.open({ stateDir: temporaryState(), agentId: 'echo' }, worker); stores.push(store);
  const db = new Database((await store.diagnostics()).path);
  return { store, db };
}

describe('session delivery exception scan stays bounded on a large store', () => {
  it('answers a page quickly with the receipt volume that held every reply on the Studio', async () => {
    const { store, db } = await open();
    const rows: Seed[] = [];
    for (let i = 0; i < 2000; i++) rows.push({ id: `r${i}`, preparedAt: BASE + i * 60_000, acceptedAt: BASE + i * 60_000 + 1000, messageId: 1_000_000 + i });
    seed(db, rows, 60_000); db.close();
    const started = Date.now();
    const page = await store.listSessionDeliveryExceptions({ limit: 100 });
    const elapsed = Date.now() - started;
    expect(page).toHaveLength(100);
    expect(page.every(row => row.state === 'accepted' && row.outOfOrder === false)).toBe(true);
    // Before the fix this page cost about 2000 x 60000 receipt probes (39 s on the
    // Studio's copy), far past the 2 s every send waits for the store.
    expect(elapsed).toBeLessThan(1500);
  }, 180_000);

  it('reaches one reply\'s neighbours through child ids, never a whole topic or store of receipts', async () => {
    const { db } = await open();
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${SESSION_REPLY_OUT_OF_ORDER_SQL}`).all(0, 1, 'x') as Array<{ detail: string }>).map(row => row.detail);
    db.close();
    expect(plan.find(step => step.includes(' r1 '))).toContain('(child_id=?)');
    expect(plan.find(step => step.includes(' r2 '))).toContain('(child_id=?)');
    expect(plan.find(step => step.includes(' o2 '))).toContain('prepared_at>?');
    expect(plan.join('\n')).not.toMatch(/SCAN/);
  });

  it('calls a reply out of order on both sides of the window the proof allows', async () => {
    const { store, db } = await open();
    const at = BASE + 10_000_000;
    seed(db, [
      // The older reply landed after a newer one written before it was accepted.
      { id: 'late', preparedAt: at, acceptedAt: at + 120_000, messageId: 500 },
      { id: 'newer-landed-first', preparedAt: at + 60_000, acceptedAt: at + 61_000, messageId: 499 },
      // Written after this one was accepted (inside clock tolerance): still counted.
      { id: 'skewed', preparedAt: at + 600_000, acceptedAt: at + 601_000, messageId: 600 },
      { id: 'skewed-newer', preparedAt: at + 601_000 + 4 * 60_000, acceptedAt: at + 602_000 + 4 * 60_000, messageId: 599 },
      // Written well past acceptance and clock tolerance: cannot have landed first.
      { id: 'far', preparedAt: at + 2_000_000, acceptedAt: at + 2_001_000, messageId: 700 },
      { id: 'far-newer', preparedAt: at + 2_001_000 + 6 * 60_000, acceptedAt: at + 2_002_000 + 6 * 60_000, messageId: 699 },
      // Ordinary order.
      { id: 'in-order', preparedAt: at + 4_000_000, acceptedAt: at + 4_001_000, messageId: 800 },
      { id: 'in-order-newer', preparedAt: at + 4_060_000, acceptedAt: at + 4_061_000, messageId: 801 },
    ]);
    db.close();
    const rows = await store.listSessionDeliveryExceptions({ limit: 20 });
    const verdict = Object.fromEntries(rows.map(row => [row.operationId, row.outOfOrder]));
    expect(verdict).toMatchObject({ 'op-late': true, 'op-newer-landed-first': false, 'op-skewed': true,
      'op-far': false, 'op-in-order': false, 'op-in-order-newer': false });
    expect(rows.map(row => row.preparedAt)).toEqual([...rows.map(row => row.preparedAt)].sort((a, b) => a - b));
  });

  it('lists a retired overtaken reply so the retirement is never silent, and no other suppression', async () => {
    const { store, db } = await open();
    const at = BASE + 50_000_000;
    seed(db, [{ id: 'retired', preparedAt: at, acceptedAt: at + 1000, messageId: 9001 },
      { id: 'quiet', preparedAt: at + 1000, acceptedAt: at + 2000, messageId: 9002 }]);
    db.prepare("UPDATE telegram_origin_operations SET state='held' WHERE operation_id IN ('op-retired','op-quiet')").run();
    db.prepare("DELETE FROM telegram_origin_platform_receipts WHERE child_id IN ('c-retired','c-quiet')").run();
    db.prepare("DELETE FROM telegram_origin_attempts WHERE child_id IN ('c-retired','c-quiet')").run();
    db.prepare("UPDATE telegram_origin_children SET state='queued' WHERE child_id IN ('c-retired','c-quiet')").run();
    db.close();
    expect(await store.recordOperationState({ operationId: 'op-retired', state: 'suppressed', holdReason: 'overtaken-reply' })).toBe(true);
    expect(await store.recordOperationState({ operationId: 'op-quiet', state: 'suppressed' })).toBe(true);
    const rows = (await store.listSessionDeliveryExceptions({ afterPreparedAt: at - 1, limit: 100 }))
      .filter(row => row.operationId === 'op-retired' || row.operationId === 'op-quiet');
    expect(rows).toEqual([expect.objectContaining({ operationId: 'op-retired', state: 'suppressed', reason: 'overtaken-reply' })]);
  });

  it('refuses the overtaken reason on any state but suppressed, and with a detail', async () => {
    const { store, db } = await open();
    const at = BASE + 60_000_000;
    seed(db, [{ id: 'x', preparedAt: at, acceptedAt: at + 1000, messageId: 9100 }]);
    db.prepare("UPDATE telegram_origin_operations SET state='held' WHERE operation_id='op-x'").run();
    db.close();
    await expect(store.recordOperationState({ operationId: 'op-x', state: 'admitted', holdReason: 'overtaken-reply' })).rejects.toThrow();
    await expect(store.recordOperationState({ operationId: 'op-x', state: 'suppressed', holdReason: 'overtaken-reply', holdDetail: { a: 1 } })).rejects.toThrow();
  });
});

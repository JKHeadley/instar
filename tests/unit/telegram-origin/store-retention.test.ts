import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { OriginStore } from '../../../src/messaging/telegram-origin/OriginStore.js';
import { auditRetentionDays } from '../../../src/messaging/telegram-origin/TelegramOriginRuntime.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { admission, compileOriginWorker, hash, temporaryState } from '../../helpers/telegramOriginStore.js';
import type { OriginAdmission } from '../../../src/messaging/telegram-origin/StoreTypes.js';

const DAY = 24 * 60 * 60_000;
let worker: URL;
const stores: OriginStore[] = [], stateDirs: string[] = [];
beforeAll(async () => { worker = await compileOriginWorker(); }, 30_000);
afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.close()));
  for (const state of stateDirs.splice(0)) SafeFsExecutor.safeRmSync(state, { recursive: true, force: true, operation: 'tests/unit/telegram-origin/store-retention.test.ts:cleanup' });
});
async function open() {
  const stateDir = temporaryState(); stateDirs.push(stateDir);
  const store = await OriginStore.open({ stateDir, agentId: 'echo', requestTimeoutMs: 20_000 }, worker); stores.push(store);
  return { store, stateDir, archiveDir: path.join(stateDir, 'state/telegram-origin-archives/echo'), database: path.join(stateDir, 'state/pending-relay.echo.sqlite') };
}
async function delivered(store: OriginStore, input: OriginAdmission, messageId: number) {
  await store.admit(input);
  const child = input.children[0];
  const claim = await store.claim({ childId: child.childId, materializationId: child.materializations[0].materializationId, ownerBootId: 'boot-1', leaseMs: 60_000, now: input.preparedAt + 1 });
  if (claim.status !== 'claimed') throw new Error('fixture claim unavailable');
  await store.markDispatched({ ...claim.child, now: input.preparedAt + 2 });
  await store.recordOutcome({ ...claim.child, outcome: 'accepted', receiptJson: JSON.stringify({ messageId }), now: input.preparedAt + 3 });
  return input;
}
const old = (name: string, age = 10 * DAY) => admission(name, Date.now() - age);

describe('archive walks a cursor', () => {
  it('leaves a young origin alone and archives the terminal old ones ahead of it', async () => {
    const { store } = await open();
    const a = await delivered(store, old('a'), 1), young = await delivered(store, admission('young'), 2);
    expect((await store.archive({ before: Date.now() - 5 * DAY, limit: 100 })).archived).toBe(1);
    expect((await store.getOrigin(a.record.originId))?.operation?.state).toBe('accepted');
    expect((await store.archive({ before: Date.now() - 5 * DAY, limit: 100 })).archived).toBe(0);
    expect((await store.archive({ before: Date.now() + 1, limit: 100 })).archived).toBe(1);
    expect((await store.getOrigin(young.record.originId))?.operation?.state).toBe('accepted');
  });

  it('a row not yet terminal does not hold back later rows and is not skipped once it finishes', async () => {
    const { store } = await open();
    const pending = old('pending'); await store.admit(pending);
    await delivered(store, old('after-pending', 9 * DAY), 3);
    expect((await store.archive({ before: Date.now(), limit: 100 })).archived).toBe(1);
    await store.recordOperationState({ operationId: pending.operationId, state: 'suppressed' });
    expect((await store.archive({ before: Date.now(), limit: 100 })).archived).toBe(1);
    expect((await store.archive({ before: Date.now(), limit: 100 })).archived).toBe(0);
    expect((await store.getOrigin(pending.record.originId))?.operation?.state).toBe('suppressed');
  });

  it('a row that has to wait cannot stop archiving past the scan window', async () => {
    const { store } = await open();
    const kept = await delivered(store, old('kept-back'), 400);
    for (let i = 0; i < 2100; i++) await store.putEvidence(old(`evidence-${i}`).record);
    let archived = 0, last = -1;
    while (archived !== last) { last = archived; archived += (await store.archive({ before: Date.now(), limit: 200, keepOperations: [kept.operationId] })).archived; }
    expect(archived).toBe(2100);
    // Once it may go, the scan wraps round to it within a couple of passes.
    let late = 0;
    for (let i = 0; i < 3; i++) late += (await store.archive({ before: Date.now(), limit: 200 })).archived;
    expect(late).toBe(1);
  }, 60_000);

  it('a future-dated origin cannot pin retention', async () => {
    const { store } = await open();
    await delivered(store, admission('wrong-clock', Date.now() + 30 * DAY), 4);
    await delivered(store, old('behind-it'), 5);
    expect((await store.archive({ before: Date.now(), limit: 100 })).archived).toBe(2);
  });

  it('archives evidence-only origins, which have no operation to wait for', async () => {
    const { store } = await open();
    const evidence = old('evidence-only').record;
    await store.putEvidence(evidence);
    expect((await store.archive({ before: Date.now(), limit: 100 })).archived).toBe(1);
    expect((await store.getOrigin(evidence.originId))?.record).toEqual(evidence);
  });

  it('writes no file for a small batch until its oldest row passes the flush line', async () => {
    const { store, archiveDir } = await open();
    await delivered(store, old('quiet', 10 * DAY), 6);
    const quiet = { before: Date.now(), limit: 200, minRecords: 200 };
    expect((await store.archive({ ...quiet, flushBefore: Date.now() - 20 * DAY })).archived).toBe(0);
    expect(fs.existsSync(archiveDir)).toBe(false);
    expect((await store.archive({ ...quiet, flushBefore: Date.now() - 5 * DAY })).archived).toBe(1);
    expect(fs.readdirSync(archiveDir)).toHaveLength(1);
  });

  it('a waiting batch stays eligible for the next run', async () => {
    const { store } = await open();
    await delivered(store, old('waits'), 7);
    expect((await store.archive({ before: Date.now(), limit: 200, minRecords: 2 })).archived).toBe(0);
    await delivered(store, old('fills-it'), 8);
    expect((await store.archive({ before: Date.now(), limit: 200, minRecords: 2 })).archived).toBe(2);
  });
});

describe('compactArchives', () => {
  it('merges small files, keeps every record readable, and removes the sources', async () => {
    const { store, archiveDir } = await open();
    const inputs: OriginAdmission[] = [];
    for (let i = 0; i < 3; i++) {
      inputs.push(await delivered(store, old(`merge-${i}`), 10 + i));
      expect((await store.archive({ before: Date.now(), limit: 100 })).archived).toBe(1);
    }
    expect(fs.readdirSync(archiveDir)).toHaveLength(3);
    const expected = await Promise.all(inputs.map(input => store.getOrigin(input.record.originId)));
    const { merged, archiveId } = await store.compactArchives();
    expect(merged).toBe(3);
    expect(fs.readdirSync(archiveDir)).toEqual([`${archiveId}.sqlite`]);
    expect(await Promise.all(inputs.map(input => store.getOrigin(input.record.originId)))).toEqual(expected);
    expect((await store.compactArchives()).merged).toBe(0);
  });

  it('leaves a damaged source in place and still merges the rest', async () => {
    const { store, archiveDir } = await open();
    const inputs: OriginAdmission[] = [], files: string[] = [];
    for (let i = 0; i < 3; i++) {
      inputs.push(await delivered(store, old(`damaged-${i}`), 20 + i));
      files.push(`${(await store.archive({ before: Date.now(), limit: 100 })).archiveId}.sqlite`);
    }
    fs.appendFileSync(path.join(archiveDir, files[0]), 'corrupted');
    expect((await store.compactArchives()).merged).toBe(2);
    expect(fs.existsSync(path.join(archiveDir, files[0]))).toBe(true);
    await expect(store.getOrigin(inputs[0].record.originId)).rejects.toThrow('archive-integrity');
    expect((await store.getOrigin(inputs[2].record.originId))?.operation?.state).toBe('accepted');
    expect((await store.compactArchives()).merged).toBe(0);
  });
});

describe('compactArchives bounds', () => {
  it('a file too big to pair with its neighbour does not stop the files behind it', async () => {
    const { store, archiveDir } = await open();
    const big = (name: string) => { const input = old(name); input.record.envelopeJson = JSON.stringify({ padding: 'x'.repeat(200 * 1024) }); input.record.envelopeDigest = hash(input.record.envelopeJson); return input; };
    for (const name of ['big-a', 'big-b']) {
      for (let i = 0; i < 50; i++) await store.putEvidence(big(`${name}-${i}`).record);
      await store.archive({ before: Date.now(), limit: 100 });
    }
    for (let i = 0; i < 2; i++) {
      await delivered(store, old(`tiny-${i}`), 500 + i);
      await store.archive({ before: Date.now(), limit: 100 });
    }
    expect(fs.readdirSync(archiveDir)).toHaveLength(4);
    let merged = 0;
    for (let i = 0; i < 4; i++) merged += (await store.compactArchives({ limit: 8 })).merged;
    expect(merged).toBeGreaterThanOrEqual(2);
    expect(fs.readdirSync(archiveDir).length).toBeLessThan(4);
  }, 60_000);
});

describe('superseded operations', () => {
  it('stop counting against capacity and stay superseded past their deadline', async () => {
    const stateDir = temporaryState(); stateDirs.push(stateDir);
    const store = await OriginStore.open({ stateDir, agentId: 'echo', requestTimeoutMs: 20_000, maxOperations: 1 }, worker); stores.push(store);
    const first = admission('superseded-first', Date.now() - 7 * 60 * 60_000); await store.admit(first);
    expect(await store.supersedeOperation({ operationId: first.operationId, supersededBy: 'operation-next' })).toBe(true);
    await store.admit(admission('takes-the-slot'));
    await store.cleanupPayloads();
    expect((await store.getOrigin(first.record.originId))?.operation?.state).toBe('superseded');
  });
});

describe('late detail', () => {
  it('refuses a diagnostic for an origin already in the archive', async () => {
    const { store } = await open();
    const input = await delivered(store, old('late-diagnostic'), 600);
    await store.archive({ before: Date.now(), limit: 100 });
    expect(await store.reserveDiagnostic({ originId: input.record.originId, reason: 'late' })).toBe(false);
  });
});

describe('purgeArchived', () => {
  it('removes hot detail while lookups, receipts and counters stay whole', async () => {
    const { store, database } = await open();
    const input = await delivered(store, old('purged'), 77);
    await store.archive({ before: Date.now(), limit: 100 });
    const expected = await store.getOrigin(input.record.originId);
    const counts = (await store.getMetrics()).counts;
    expect(await store.purgeArchived({ before: Date.now() })).toBe(1);
    expect(await store.getOrigin(input.record.originId)).toEqual(expected);
    expect((await store.listOrigins({ messageId: '77' })).records.map(row => row.record.originId)).toEqual([input.record.originId]);
    expect((await store.getMetrics()).counts).toEqual(counts);
    expect(await store.getChild(input.children[0].childId)).toBeNull();
    const db = new Database(database, { readonly: true });
    try {
      for (const table of ['telegram_origin_operations', 'telegram_origin_children', 'telegram_origin_materializations', 'telegram_origin_attempts', 'telegram_origin_outcome_details', 'entries'])
        expect((db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n, table).toBe(0);
    } finally { db.close(); }
  });

  it('never touches an origin that is unarchived or inside the hot window', async () => {
    const { store } = await open();
    const unarchived = await delivered(store, old('unarchived'), 80);
    expect(await store.purgeArchived({ before: Date.now() })).toBe(0);
    await store.archive({ before: Date.now(), limit: 100 });
    expect(await store.purgeArchived({ before: Date.now() - 30 * DAY })).toBe(0);
    expect((await store.getChild(unarchived.children[0].childId))?.state).toBe('accepted');
  });

  it('keeps an operation whose notice permit is still reserved', async () => {
    const { store } = await open();
    const notice = admission('reserved-notice', Date.now() - 10 * DAY);
    await store.reserveNotice({ admission: notice, ownerBootId: 'lifeline', generation: 'outage', alertDestinationId: 'hub' });
    await store.recordOperationState({ operationId: notice.operationId, state: 'expired', now: Date.now() });
    // Archiving it now would freeze a copy from before the notice fired.
    expect((await store.archive({ before: Date.now(), limit: 100 })).archived).toBe(0);
    expect(await store.purgeArchived({ before: Date.now() })).toBe(0);
    await store.retireNoticeOwner('lifeline');
    expect((await store.archive({ before: Date.now(), limit: 100 })).archived).toBe(1);
    expect(await store.purgeArchived({ before: Date.now() })).toBe(1);
    expect((await store.getOrigin(notice.record.originId))?.children[0].state).toBe('unavailable');
  });

  it('rows it must keep never hide the purgeable rows behind them', async () => {
    const { store } = await open();
    const kept = [];
    for (let i = 0; i < 30; i++) kept.push((await delivered(store, old(`kept-${i}`), 200 + i)).operationId);
    const later = await delivered(store, old('behind-the-window'), 300);
    await store.archive({ before: Date.now(), limit: 100 });
    const limit = 1, keepOperations = kept;
    let purged = 0;
    for (let i = 0; i < 3; i++) purged += await store.purgeArchived({ before: Date.now(), limit, keepOperations });
    expect(purged).toBe(1);
    expect(await store.getChild(later.children[0].childId)).toBeNull();
  });

  it('refuses a late replay of an archived operation instead of sending it again', async () => {
    const { store } = await open();
    const input = await delivered(store, old('replayed'), 81);
    await store.archive({ before: Date.now(), limit: 100 });
    await store.purgeArchived({ before: Date.now() });
    await expect(store.admit(input)).rejects.toThrow('operation-id-conflict');
    // A logical send retries the same operation id under a fresh origin id.
    const retry = old('replayed'); retry.record.originId = 'origin-fresh'; retry.record.envelopeJson = JSON.stringify({ originId: 'origin-fresh' });
    retry.record.envelopeDigest = hash(retry.record.envelopeJson);
    await expect(store.admit(retry)).rejects.toThrow('operation-id-conflict');
  });

  it('still answers an operation id after its row is gone, so a retry gets its receipt', async () => {
    const { store } = await open();
    const input = await delivered(store, old('receipt-replay'), 82);
    await store.archive({ before: Date.now(), limit: 100 });
    await store.purgeArchived({ before: Date.now() });
    const audit = await store.getOperation(input.operationId);
    expect(audit?.operation?.state).toBe('accepted');
    expect(audit?.attempts[0].receiptJson).toBe(JSON.stringify({ messageId: 82 }));
  });

  it('keeps an operation with a receipt still to fold in, and an unreported held expiry', async () => {
    const { store } = await open();
    const receipt = await delivered(store, old('unrecorded'), 83);
    await store.archive({ before: Date.now(), limit: 100, keepOperations: [receipt.operationId] }).then(result => expect(result.archived).toBe(0));
    await store.archive({ before: Date.now(), limit: 100 });
    expect(await store.purgeArchived({ before: Date.now(), keepOperations: [receipt.operationId] })).toBe(0);
    const held = old('held-expiry');
    await store.admit(held);
    await store.recordOperationState({ operationId: held.operationId, state: 'held', holdReason: 'lease-not-held' });
    await store.recordOperationState({ operationId: held.operationId, state: 'expired', now: Date.now() });
    await store.archive({ before: Date.now(), limit: 100 });
    expect(await store.purgeArchived({ before: Date.now() })).toBe(1);
    expect((await store.getOperation(held.operationId))?.operation?.state).toBe('expired');
    await store.markHoldExpiryReported({ operationId: held.operationId });
    expect(await store.purgeArchived({ before: Date.now() })).toBe(1);
  });
});

describe('foldMetricEvents', () => {
  it('moves old events into rollups with federated totals and counters unchanged', async () => {
    const { store, database } = await open();
    await delivered(store, old('folded'), 90);
    await delivered(store, admission('recent'), 91);
    const federated = (await store.getFederatedMetrics('studio')).counts, other = (await store.getFederatedMetrics('elsewhere')).counts;
    const counters = (await store.getMetrics()).counts;
    const events = () => { const db = new Database(database, { readonly: true }); try { return (db.prepare('SELECT count(*) n FROM telegram_origin_metric_events').get() as { n: number }).n; } finally { db.close(); } };
    const total = events();
    const fold = await store.foldMetricEvents({ before: Date.now() - DAY });
    expect(fold.folded).toBeGreaterThan(3); expect(fold.more).toBe(false);
    expect(events()).toBe(total - fold.folded);
    expect((await store.getFederatedMetrics('studio')).counts).toEqual(federated);
    expect((await store.getFederatedMetrics('elsewhere')).counts).toEqual(other);
    expect((await store.getMetrics()).counts).toEqual(counters);
    expect((await store.foldMetricEvents({ before: Date.now() - DAY })).folded).toBe(0);
  });

  it('reports a remaining backlog in bounded steps', async () => {
    const { store } = await open();
    await delivered(store, old('backlog'), 92); await delivered(store, admission('line'), 93);
    expect(await store.foldMetricEvents({ before: Date.now() - DAY, limit: 2 })).toEqual({ folded: 2, more: true });
  });

  it('an idle agent with no newer origin still folds, keeping legacy totals', async () => {
    const { store } = await open();
    await delivered(store, old('alone'), 94);
    const federated = (await store.getFederatedMetrics('studio')).counts;
    expect((await store.foldMetricEvents({ before: Date.now() - DAY })).folded).toBeGreaterThan(3);
    expect((await store.getFederatedMetrics('studio')).counts).toEqual(federated);
  });
});

describe('expireAudit', () => {
  it('removes stubs and files past the horizon and tells readers', async () => {
    const { store, archiveDir } = await open();
    const ancient = await delivered(store, old('ancient', 400 * DAY), 100);
    await store.archive({ before: Date.now(), limit: 100 });
    await store.purgeArchived({ before: Date.now() });
    const kept = await delivered(store, old('kept', 100 * DAY), 101);
    await store.archive({ before: Date.now(), limit: 100 });
    await store.purgeArchived({ before: Date.now() });
    expect((await store.listOrigins()).historyExpiredBefore).toBeUndefined();
    const horizon = Date.now() - 365 * DAY;
    expect(await store.expireAudit({ before: horizon })).toBe(1);
    expect(await store.getOrigin(ancient.record.originId)).toBeNull();
    expect((await store.listOrigins({ messageId: '100' })).records).toEqual([]);
    expect(fs.readdirSync(archiveDir)).toHaveLength(1);
    expect((await store.getOrigin(kept.record.originId))?.operation?.state).toBe('accepted');
    expect((await store.listOrigins()).historyExpiredBefore).toBe(horizon);
  });

  it('never expires an origin that still has operation rows or no archive', async () => {
    const { store } = await open();
    await delivered(store, old('unarchived-old', 400 * DAY), 110);
    expect(await store.expireAudit({ before: Date.now() })).toBe(0);
    await store.archive({ before: Date.now(), limit: 100 });
    expect(await store.expireAudit({ before: Date.now() })).toBe(0);
  });

  it('a mistyped retention setting never reads as "delete everything"', () => {
    for (const bad of [0, -1, 1, 29, 1.5, Number.NaN, '90', null, undefined]) expect(auditRetentionDays(bad)).toBe(365);
    expect(auditRetentionDays(30)).toBe(30); expect(auditRetentionDays(730)).toBe(730);
  });
});

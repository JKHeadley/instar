import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import Database from 'better-sqlite3';
import { OriginStore } from '../../../src/messaging/telegram-origin/OriginStore.js';
import { newCapacityEvidence } from '../../../src/messaging/telegram-origin/OriginCapacityEvidence.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { admission, compileOriginWorker, temporaryState } from '../../helpers/telegramOriginStore.js';
let worker: URL;
const closes: Array<() => Promise<void>> = [];
beforeAll(async () => { worker = await compileOriginWorker(); });
afterEach(async () => { for (const c of closes.splice(0).reverse()) await c(); });
async function setup() {
  const stateDir = temporaryState();
  const store = await OriginStore.open({ stateDir, agentId: 'echo', requestTimeoutMs: 20_000 }, worker);
  const db = new Database(path.join(stateDir, 'state/pending-relay.echo.sqlite'));
  closes.push(async () => { db.close(); await store.close(); await SafeFsExecutor.safeRm(stateDir, { recursive: true, force: true, operation: 'test:capacity-evidence:cleanup' }); });
  return { store, db, stateDir };
}
async function accepted(h: Awaited<ReturnType<typeof setup>>, evidence: boolean) {
  const now = Date.now() - 10 * 86400000, a = admission(undefined, now);
  await h.store.admit(a);
  const child = a.children[0];
  const claim = await h.store.claim({ childId: child.childId, materializationId: child.materializations[0].materializationId, ownerBootId: 'owner', leaseMs: 60000, now: now + 1 });
  if (claim.status !== 'claimed') throw new Error('fixture claim refused');
  await h.store.markDispatched({ ...claim.child, now: now + 2 });
  expect(await h.store.recordOutcome({ ...claim.child, outcome: 'accepted', receiptJson: JSON.stringify({ messageId: 42 }), now: now + 3,
    ...(evidence ? { capacityEvidence: { ...newCapacityEvidence('ipc'), stage: 'network-start', ownerVerdict: 'consumed' } as const } : {}) })).toEqual({ recorded: true });
  return a;
}
describe('capacity evidence stays subordinate to the fenced outcome', () => {
  it('round-trips evidence through archive and cleans it with supported attempt purge', async () => {
    const h = await setup(), a = await accepted(h, true);
    expect((await h.store.getOrigin(a.record.originId))?.attempts[0]).toMatchObject({ capacityEvidenceStatus: 'collected', capacityEvidence: { ownerVerdict: 'consumed' } });
    await h.store.archive({ before: Date.now(), limit: 100 });
    expect((await h.store.getOrigin(a.record.originId))?.attempts[0]).toMatchObject({ capacityEvidenceStatus: 'collected' });
    await h.store.purgeArchived({ before: Date.now(), limit: 100 });
    expect((await h.store.getOrigin(a.record.originId))?.attempts[0]).toMatchObject({ capacityEvidenceStatus: 'collected', capacityEvidence: { ownerVerdict: 'consumed' } });
    expect(h.db.prepare('SELECT count(*) n FROM telegram_origin_capacity_evidence').get()).toEqual({ n: 0 });
  });
  it('commits acceptance and records unavailable status when only evidence insertion fails', async () => {
    const h = await setup();
    h.db.exec("CREATE TRIGGER inject_evidence_failure BEFORE INSERT ON telegram_origin_capacity_evidence BEGIN SELECT RAISE(ABORT,'fixture evidence unavailable'); END");
    const a = await accepted(h, true), record = await h.store.getOrigin(a.record.originId);
    expect(record?.operation?.state).toBe('accepted');
    expect(record?.attempts[0]).toMatchObject({ outcome: 'accepted', capacityEvidenceStatus: 'unavailable' });
    expect(record?.attempts[0].capacityEvidence).toBeUndefined();
    const federatedBefore = (await h.store.getFederatedMetrics('studio')).counts['capacity-evidence-unavailable'];
    expect(federatedBefore).toBe(1);
    expect((await h.store.recoverableAdmissions({ limit: 10 })).length).toBe(0);
    await h.store.foldMetricEvents({ before: Date.now(), limit: 5000 });
    expect((await h.store.getOrigin(a.record.originId))?.attempts[0]).toMatchObject({ capacityEvidenceStatus: 'unavailable' });
    await h.store.archive({ before: Date.now(), limit: 100 });
    await h.store.purgeArchived({ before: Date.now(), limit: 100 });
    expect((await h.store.getOrigin(a.record.originId))?.attempts[0]).toMatchObject({ capacityEvidenceStatus: 'unavailable' });
    expect((await h.store.getFederatedMetrics('studio')).counts['capacity-evidence-unavailable']).toBe(federatedBefore);
  });
  it('does not invent diagnostics for legacy attempts', async () => {
    const h = await setup(), a = await accepted(h, false);
    expect((await h.store.getOrigin(a.record.originId))?.attempts[0]).toMatchObject({ capacityEvidenceStatus: 'legacy-or-not-reached' });
  });
});

it('preserves optional evidence across real archive compaction and absent legacy evidence', async () => {
  const h = await setup(), first = await accepted(h, true);
  await h.store.archive({ before: Date.now(), limit: 100 });
  const legacy = await accepted(h, false);
  await h.store.archive({ before: Date.now(), limit: 100 });
  expect((await h.store.compactArchives()).merged).toBe(2);
  await h.store.purgeArchived({ before: Date.now(), limit: 100 });
  expect((await h.store.getOrigin(first.record.originId))?.attempts[0]).toMatchObject({ capacityEvidenceStatus: 'collected', capacityEvidence: { ownerVerdict: 'consumed' } });
  expect((await h.store.getOrigin(legacy.record.originId))?.attempts[0].capacityEvidence).toBeUndefined();
});

it('installs independent marker cleanup when an earlier evidence trigger definition is retained', async () => {
  const h = await setup();
  const schema = h.db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='telegram_origin_capacity_evidence_cleanup'").get() as { sql: string };
  // Recreate the earlier fixture definition from its actual stored schema, removing only marker cleanup.
  const legacySchema = schema.sql.split('\n').filter(line => !line.includes('telegram_origin_metric_events')).join('\n');
  h.db.exec('DROP TRIGGER IF EXISTS telegram_origin_capacity_unavailable_cleanup_v1');
  h.db.exec('DROP TRIGGER telegram_origin_capacity_evidence_cleanup');
  h.db.exec(legacySchema);
  await h.store.close();
  const upgraded = await OriginStore.open({ stateDir: h.stateDir, agentId: 'echo', requestTimeoutMs: 20_000 }, worker);
  closes.push(() => upgraded.close()); h.store = upgraded;
  const retained = h.db.prepare("SELECT sql FROM sqlite_master WHERE name='telegram_origin_capacity_evidence_cleanup'").get() as { sql: string };
  expect(retained.sql).not.toContain('telegram_origin_metric_events');
  expect(h.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='telegram_origin_capacity_unavailable_cleanup_v1'").get()).toBeTruthy();
  h.db.exec("CREATE TRIGGER inject_evidence_failure BEFORE INSERT ON telegram_origin_capacity_evidence BEGIN SELECT RAISE(ABORT,'fixture evidence unavailable'); END");
  const a = await accepted(h, true);
  await h.store.foldMetricEvents({ before: Date.now(), limit: 5000 });
  await h.store.archive({ before: Date.now(), limit: 100 });
  await h.store.purgeArchived({ before: Date.now(), limit: 100 });
  expect((await h.store.getOrigin(a.record.originId))?.attempts[0]).toMatchObject({ capacityEvidenceStatus: 'unavailable' });
  expect(h.db.prepare("SELECT count(*) n FROM telegram_origin_metric_events WHERE metric='capacity-evidence-unavailable'").get()).toEqual({ n: 0 });
});

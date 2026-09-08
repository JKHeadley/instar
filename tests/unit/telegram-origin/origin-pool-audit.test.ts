import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { OriginPoolAudit } from '../../../src/messaging/telegram-origin/OriginPoolAudit.js';
import { OriginStore } from '../../../src/messaging/telegram-origin/OriginStore.js';
import { admission, compileOriginWorker, temporaryState } from '../../helpers/telegramOriginStore.js';
import type { OriginAuditRecord, OriginListPage, OriginMetrics } from '../../../src/messaging/telegram-origin/StoreTypes.js';

let worker: URL;
const stores: OriginStore[] = [];
beforeAll(async () => { worker = await compileOriginWorker(); });
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); });
async function store() { const value = await OriginStore.open({ stateDir: temporaryState(), agentId: 'echo' }, worker); stores.push(value); return value; }
describe('origin pool audit frozen shard merge', () => {
  const row = (name: string, createdAt = 10_000): OriginAuditRecord => ({ sequence: 1,
    record: admission(name, createdAt).record, operation: null, children: [], attempts: [] });
  const page = (records: OriginAuditRecord[], cursor: string | null, upperSequence = 10): OriginListPage =>
    ({ records, cursor, upperSequence, coverage: 'complete' });

  it('rejects a repeated shard cursor even when each response supplies a different record', async () => {
    let calls = 0;
    const pool = new OriginPoolAudit({ shardIds: () => ['a'], readShard: async () =>
      page([row(`row-${++calls}`, calls * 1000)], 'stuck') });
    const first = await pool.list({ limit: 1 });
    expect(first.records).toHaveLength(1);
    const second = await pool.list({ limit: 1, cursor: first.cursor! });
    expect(second).toMatchObject({ records: [], cursor: null, coverage: 'incomplete', unavailableShards: ['a'] });
    expect(calls).toBe(2);
  });

  it('rejects a cursor cycle and a changed frozen upper sequence', async () => {
    let calls = 0;
    const pool = new OriginPoolAudit({ shardIds: () => ['a'], readShard: async () =>
      page([row(`row-${++calls}`, calls * 1000)], calls === 2 ? 'next' : 'first') });
    let result = await pool.list({ limit: 1 });
    result = await pool.list({ limit: 1, cursor: result.cursor! });
    result = await pool.list({ limit: 1, cursor: result.cursor! });
    expect(result).toMatchObject({ records: [], cursor: null, coverage: 'incomplete', unavailableShards: ['a'] });
    expect(calls).toBe(3);
    calls = 0;
    const changed = new OriginPoolAudit({ shardIds: () => ['a'], readShard: async () =>
      page([row(`row-${++calls}`, calls * 1000)], calls === 1 ? 'next' : null, calls) });
    const initial = await changed.list({ limit: 1 });
    expect(await changed.list({ limit: 1, cursor: initial.cursor! }))
      .toMatchObject({ records: [], coverage: 'incomplete', unavailableShards: ['a'] });
  });

  it.each(['same-page', 'later-page', 'changed-order-key'] as const)('never emits a duplicate origin as complete history (%s)', async mode => {
    let calls = 0;
    const original = row('duplicate');
    const pool = new OriginPoolAudit({ shardIds: () => ['a'], readShard: async () => {
      calls++;
      if (mode === 'same-page') return page([original, original], null);
      return page([mode === 'changed-order-key' && calls > 1
        ? { ...original, record: { ...original.record, createdAt: 20_000 } } : original], calls === 1 ? 'next' : null);
    } });
    const first = await pool.list({ limit: 1 });
    const last = first.cursor ? await pool.list({ limit: 1, cursor: first.cursor }) : first;
    expect(last).toMatchObject({ records: [], cursor: null, coverage: 'incomplete', unavailableShards: ['a'] });
  });

  it('matches SQLite binary ordering instead of locale sorting and detects displaced cross-shard copies', async () => {
    const upper = row('Z'), lower = row('a');
    const pool = new OriginPoolAudit({ shardIds: () => ['a'], readShard: async () => page([upper, lower], null) });
    expect((await pool.list()).records.map(item => item.record.originId)).toEqual(['origin-Z', 'origin-a']);
    const displaced = { ...upper, record: { ...upper.record, createdAt: 20_000 } };
    const conflicting = new OriginPoolAudit({ shardIds: () => ['a', 'b'], readShard: async id =>
      page(id === 'a' ? [upper, lower] : [row('between', 15_000), displaced], null) });
    let result = await conflicting.list({ limit: 1 });
    const ids = result.records.map(item => item.record.originId);
    while (result.cursor) {
      result = await conflicting.list({ limit: 1, cursor: result.cursor });
      ids.push(...result.records.map(item => item.record.originId));
    }
    expect(new Set(ids).size).toBe(ids.length);
    expect(result).toMatchObject({ coverage: 'incomplete', conflictingOrigins: ['origin-Z'] });
  });

  it('reports the oldest contributing metric sample, retains stale cache times, and rejects old/future samples', async () => {
    let now = 100_000, unavailable = false;
    const sample = (sampledAt: number, count = 1): OriginMetrics => ({ sampledAt, stale: false, coverage: 'complete', counts: { prepared: count } });
    const pool = new OriginPoolAudit({ shardIds: () => ['a', 'b'], now: () => now,
      readShard: async () => page([], null), readShardMetrics: async id => {
        if (id === 'a' && unavailable) throw new Error('offline');
        return sample(id === 'a' ? 80_000 : now);
      } });
    const initial = await pool.metricsForOperator();
    expect(initial).toMatchObject({ sampledAt: 80_000, collectedAt: 100_000, coverage: 'complete', stale: false });
    unavailable = true; now = 200_000;
    expect(await pool.metricsForOperator()).toMatchObject({ sampledAt: 80_000, collectedAt: 200_000,
      coverage: 'incomplete', stale: true, counts: { prepared: 2 }, unavailableShards: ['a'] });
    for (const sampledAt of [now - 30_001, now + 1, -1]) {
      const invalid = new OriginPoolAudit({ shardIds: () => ['a'], now: () => now,
        readShard: async () => page([], null), readShardMetrics: async () => sample(sampledAt) });
      expect(await invalid.metricsForOperator()).toMatchObject({ sampledAt: null, stale: true,
        coverage: 'incomplete', counts: null, unavailableShards: ['a'] });
    }
  });
  it('does not renew an early metric sample while waiting for a slower shard', async () => {
    let now = 100_000;
    const pool = new OriginPoolAudit({ shardIds: () => ['a', 'b'], now: () => now,
      readShard: async () => page([], null), readShardMetrics: async id => {
        if (id === 'b') { await new Promise(resolve => setTimeout(resolve, 1)); now = 101_000; }
        return { sampledAt: id === 'a' ? 70_000 : now, stale: false, coverage: 'complete', counts: { prepared: 1 } };
      } });
    expect(await pool.metricsForOperator()).toMatchObject({ sampledAt: 70_000, collectedAt: 101_000,
      coverage: 'incomplete', stale: true, counts: { prepared: 2 }, unavailableShards: ['a'] });
  });

  it('counts prepared evidence once across shards and keeps unavailable counts explicitly stale', async () => {
    const source = await store(), owner = await store();
    const op = admission('metric-copy');
    await source.putEvidence(op.record); await owner.admit(op);
    let offline = false;
    const pool = new OriginPoolAudit({ shardIds: () => ['studio', 'owner'], readShard: () => source.listOrigins(),
      readShardMetrics: id => { if (offline && id === 'studio') throw new Error('offline');
        return (id === 'studio' ? source : owner).getFederatedMetrics(id); } });
    const healthy = await pool.metricsForOperator();
    expect(healthy).toMatchObject({ coverage: 'complete', stale: false,
      counts: { 'operation:prepared': 1, 'operation:admitted': 1 } });
    await owner.archive({ before: Date.now() + 1 });
    expect((await pool.metricsForOperator()).counts).toEqual(healthy.counts);
    offline = true;
    const missing = await pool.metricsForOperator();
    expect(missing).toMatchObject({ coverage: 'incomplete', stale: true, unavailableShards: ['studio'], counts: healthy.counts });
    expect(missing.shards.find(shard => shard.machineId === 'studio')).toMatchObject({ stale: true, coverage: 'unknown' });
  });
  it('refuses production federation outside the verified operator call scope', async () => {
    const a = await store(); await a.admit(admission('scoped'));
    const pool = new OriginPoolAudit({ shardIds: () => ['a'], readShard: (_, query) => a.listOrigins(query), operatorScopeRequired: true });
    await expect(pool.list()).rejects.toThrow('operator-audit-scope-required');
    expect((await pool.listForOperator()).records).toHaveLength(1);
    await expect(pool.list()).rejects.toThrow('operator-audit-scope-required');
  });
  it('deduplicates evidence copies, retains owner state, freezes membership across clock skew, and repeats a cursor deterministically', async () => {
    const a = await store(), b = await store();
    for (let i = 0; i < 12; i++) {
      const op = admission(`row-${i}`, 10_000 + i * 1000);
      await a.putEvidence(op.record); await b.admit(op);
    }
    const pool = new OriginPoolAudit({ shardIds: () => ['a', 'b'], readShard: (id, query) => (id === 'a' ? a : b).listOrigins(query) });
    let page = await pool.list({ limit: 3 });
    expect(page.coverage).toBe('complete'); expect(page.records.every(row => row.operation !== null)).toBe(true);
    const firstIds = page.records.map(row => row.record.originId);
    await b.admit(admission('late-with-old-clock', 1000));
    const second = await pool.list({ limit: 3, cursor: page.cursor! });
    expect(await pool.list({ limit: 3, cursor: page.cursor! })).toEqual(second);
    while (page.cursor) {
      page = await pool.list({ limit: 3, cursor: page.cursor });
      firstIds.push(...page.records.map(row => row.record.originId));
    }
    expect(firstIds).toHaveLength(12); expect(new Set(firstIds).size).toBe(12);
    expect((await pool.list({ limit: 3 })).records[0].record.originId).toBe('origin-late-with-old-clock');
  });
  it('names missing shards and never claims complete history because a peer returned nothing', async () => {
    const a = await store(); await a.admit(admission('local'));
    const pool = new OriginPoolAudit({ shardIds: () => ['local', 'offline'], readShard: (id, query) => {
      if (id === 'offline') throw new Error('unreachable'); return a.listOrigins(query);
    } });
    const page = await pool.list();
    expect(page).toMatchObject({ coverage: 'incomplete', unavailableShards: ['offline'] });
    expect(page.records).toHaveLength(1);
    await expect(pool.list({ cursor: 'forged' })).rejects.toThrow('snapshot-expired');
  });
});

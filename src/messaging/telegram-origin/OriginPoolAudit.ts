import { randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { OriginAuditRecord, OriginListPage, OriginListQuery, OriginMetrics } from './StoreTypes.js';

export interface OriginPoolPage {
  records: OriginAuditRecord[];
  cursor: string | null;
  coverage: 'complete' | 'incomplete';
  unavailableShards: string[];
  conflictingOrigins: string[];
  snapshotAt: number;
}
type OrderKey = [number, string, string];
interface Shard { id: string; cursor?: string; done: boolean; records: OriginAuditRecord[];
  seenCursors: string[]; upperSequence?: number; lastKey?: OrderKey; }
interface Snapshot { shards: Shard[]; missing: string[]; conflicts: string[]; query: OriginListQuery; at: number;
  emitted: Array<[string, string]>; }
const orderKey = (row: OriginAuditRecord): OrderKey => [row.record.createdAt, row.record.machineId, row.record.originId];
// SQLite's default BINARY ordering compares UTF-8 bytes, not locale collation.
const compareKeys = (a: OrderKey, b: OrderKey) => a[0] - b[0] || Buffer.compare(Buffer.from(a[1]), Buffer.from(b[1])) ||
  Buffer.compare(Buffer.from(a[2]), Buffer.from(b[2]));
/** Bounded merge of independently frozen shard sequences. Wall clocks order
 * rows only; each shard's own cursor fixes membership. Missing shards remain
 * named throughout that snapshot instead of appearing as empty history.
 */
export class OriginPoolAudit {
  private readonly operatorScope = new AsyncLocalStorage<boolean>();
  private readonly metricCache = new Map<string, OriginMetrics>();
  private readonly cursors = new Map<string, { snapshot: Snapshot; result?: Promise<OriginPoolPage>; resultBytes?: number }>();
  constructor(private readonly options: {
    shardIds: () => string[];
    readShard: (machineId: string, query: OriginListQuery) => Promise<OriginListPage>;
    readShardMetrics?: (machineId: string) => Promise<OriginMetrics>;
    now?: () => number;
    operatorScopeRequired?: boolean;
  }) {}
  /** Called only after the route's independent operator-session verification. */
  listForOperator(query: OriginListQuery = {}): Promise<OriginPoolPage> {
    return this.operatorScope.run(true, () => this.list(query));
  }
  async metricsForOperator() {
    if (!this.options.readShardMetrics) throw new Error('origin-pool-metrics-unavailable');
    const ids = [...new Set(this.options.shardIds())].sort();
    if (!ids.length) throw new Error('origin-pool-membership-unavailable');
    const selected = ids.slice(0, 16), unavailableShards = ids.slice(16);
    for (const id of this.metricCache.keys()) if (!selected.includes(id)) this.metricCache.delete(id);
    const shards = await Promise.all(selected.map(async machineId => {
      let timer: NodeJS.Timeout | undefined;
      try {
        const metrics = await Promise.race([this.options.readShardMetrics!(machineId), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('origin-metric-shard-deadline')), 3000);
        })]);
        const receivedAt = this.now();
        if (metrics.coverage !== 'complete' || metrics.stale || !Number.isSafeInteger(metrics.sampledAt)
          || metrics.sampledAt < 0 || metrics.sampledAt > receivedAt || receivedAt - metrics.sampledAt > 30_000
          || Buffer.byteLength(JSON.stringify(metrics)) > 64 * 1024 || Object.keys(metrics.counts).length > 1000
          || Object.entries(metrics.counts).some(([key, count]) => key.length > 128 || !Number.isSafeInteger(count) || count < 0)) throw new Error('origin-metric-shard-invalid');
        const retained = structuredClone(metrics);
        this.metricCache.set(machineId, retained);
        return { machineId, ...structuredClone(retained) };
      } catch {
        unavailableShards.push(machineId);
        const previous = this.metricCache.get(machineId);
        return { machineId, sampledAt: previous?.sampledAt ?? null, coverage: 'unknown' as const, stale: true, counts: previous ? { ...previous.counts } : null };
      } finally { if (timer) clearTimeout(timer); }
    }));
    const collectedAt = this.now();
    for (const shard of shards) {
      // Another peer may have consumed the read deadline after this sample
      // arrived. Do not extend its freshness by waiting for the whole pool.
      if (!shard.stale && shard.sampledAt !== null &&
        (shard.sampledAt > collectedAt || collectedAt - shard.sampledAt > 30_000)) {
        shard.stale = true; shard.coverage = 'unknown'; unavailableShards.push(shard.machineId);
      }
    }
    let counts: Record<string, number> | null = null;
    for (const shard of shards) if (shard.counts) {
      counts ??= {};
      for (const [metric, count] of Object.entries(shard.counts)) {
        const total = (counts[metric] ?? 0) + count;
        if (!Number.isSafeInteger(total)) throw new Error('origin-metric-overflow');
        counts[metric] = total;
      }
    }
    const sampledTimes = shards.flatMap(shard => shard.sampledAt === null ? [] : [shard.sampledAt]);
    return { sampledAt: sampledTimes.length ? Math.min(...sampledTimes) : null, collectedAt,
      coverage: unavailableShards.length ? 'incomplete' : 'complete',
      stale: unavailableShards.length > 0, unavailableShards: unavailableShards.sort(), counts, shards };
  }
  private now() { return this.options.now?.() ?? Date.now(); }
  async list(query: OriginListQuery = {}): Promise<OriginPoolPage> {
    if (this.options.operatorScopeRequired && !this.operatorScope.getStore()) throw new Error('operator-audit-scope-required');
    for (const [key, value] of this.cursors) if (this.now() - value.snapshot.at >= 10 * 60_000) this.cursors.delete(key);
    const limit = query.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('origin-pool-invalid-limit');
    const { cursor, ...filter } = query;
    if (cursor) {
      const entry = this.cursors.get(cursor);
      if (!entry || JSON.stringify(entry.snapshot.query) !== JSON.stringify(filter)) throw new Error('origin-pool-snapshot-expired-or-changed');
      return entry.result ??= this.page(entry.snapshot, limit).then(page => {
        const bytes = Buffer.byteLength(JSON.stringify(page));
        if (this.cachedBytes() + bytes > 16 * 1024 * 1024) {
          if (page.cursor) this.cursors.delete(page.cursor);
          throw new Error('origin-pool-snapshot-capacity');
        }
        entry.resultBytes = bytes; return page;
      });
    }
    const ids = [...new Set(this.options.shardIds())].sort();
    const snapshot: Snapshot = { shards: ids.slice(0, 16).map(id => ({ id, done: false, records: [], seenCursors: [] })),
      missing: ids.slice(16), conflicts: [], emitted: [], query: filter, at: this.now() };
    if (!ids.length) throw new Error('origin-pool-membership-unavailable');
    return this.page(snapshot, limit);
  }
  private cachedBytes(): number {
    return [...this.cursors.values()].reduce((n, value) => n + Buffer.byteLength(JSON.stringify(value.snapshot)) + (value.resultBytes ?? 0), 0);
  }
  private async fill(snapshot: Snapshot, shard: Shard): Promise<void> {
    if (shard.done || shard.records.length) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      const page = await Promise.race([this.options.readShard(shard.id, { ...snapshot.query, limit: 10, cursor: shard.cursor }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('origin-audit-shard-deadline')), 3000); })]);
      if (page.coverage !== 'complete' || !Array.isArray(page.records) || page.records.length > 10 ||
        Buffer.byteLength(JSON.stringify(page)) > 2 * 1024 * 1024 || !Number.isSafeInteger(page.upperSequence) || page.upperSequence < 0 ||
        (shard.upperSequence !== undefined && page.upperSequence !== shard.upperSequence) ||
        (page.cursor !== null && (typeof page.cursor !== 'string' || !page.cursor.length || page.cursor.length > 8192 ||
          shard.seenCursors.includes(page.cursor)))) throw new Error('origin-pool-invalid-shard-page');
      let previous = shard.lastKey;
      const ids = new Set<string>();
      const emittedIds = new Set(snapshot.emitted.map(([id]) => id));
      for (const row of page.records) {
        if (!row?.record || !Number.isSafeInteger(row.record.createdAt) || row.record.createdAt < 0 ||
          typeof row.record.machineId !== 'string' || !row.record.machineId.length || row.record.machineId.length > 256 ||
          typeof row.record.originId !== 'string' || !row.record.originId.length || row.record.originId.length > 256 ||
          typeof row.record.envelopeDigest !== 'string' || !/^[a-f0-9]{64}$/.test(row.record.envelopeDigest) ||
          ids.has(row.record.originId)) throw new Error('origin-pool-invalid-shard-record');
        if (emittedIds.has(row.record.originId)) {
          snapshot.conflicts.push(row.record.originId);
          throw new Error('origin-pool-repeated-shard-record');
        }
        const key = orderKey(row);
        if (previous && compareKeys(previous, key) >= 0) throw new Error('origin-pool-nonadvancing-shard');
        previous = key; ids.add(row.record.originId);
      }
      shard.lastKey = previous; shard.upperSequence = page.upperSequence;
      if (page.cursor !== null) {
        if (shard.seenCursors.length >= 1000) throw new Error('origin-pool-shard-cursor-bound');
        shard.seenCursors.push(page.cursor);
      }
      shard.records = structuredClone(page.records); shard.cursor = page.cursor ?? undefined; shard.done = page.cursor === null;
      if (!shard.records.length && !shard.done) throw new Error('origin-pool-nonadvancing-shard');
    } catch {
      shard.records = []; shard.done = true;
      if (!snapshot.missing.includes(shard.id)) snapshot.missing.push(shard.id);
    } finally { if (timer) clearTimeout(timer); }
  }
  private async page(source: Snapshot, limit: number): Promise<OriginPoolPage> {
    const snapshot = structuredClone(source), records: OriginAuditRecord[] = [];
    const emitted = new Map(snapshot.emitted);
    let recordBytes = 0;
    const compare = (a: OriginAuditRecord, b: OriginAuditRecord) => compareKeys(orderKey(a), orderKey(b));
    while (records.length < limit) {
      await Promise.all(snapshot.shards.map(shard => this.fill(snapshot, shard)));
      const heads = snapshot.shards.filter(shard => shard.records.length).sort((a, b) => compare(a.records[0], b.records[0]));
      if (!heads.length) break;
      let chosen = heads[0].records[0];
      const largest = Math.max(...heads.filter(shard => shard.records[0].record.originId === chosen.record.originId)
        .map(shard => Buffer.byteLength(JSON.stringify(shard.records[0]))));
      if (recordBytes + largest > 2 * 1024 * 1024 && records.length) break;
      for (const shard of heads) {
        const row = shard.records[0];
        if (row.record.originId !== chosen.record.originId) continue;
        shard.records.shift();
        if (row.record.envelopeDigest !== chosen.record.envelopeDigest || compare(row, chosen) !== 0) snapshot.conflicts.push(chosen.record.originId);
        // Evidence copies add reach, not duplicate logical operations. The
        // credential owner's receipt-bearing row supplies delivery state.
        if (row.operation && !chosen.operation) chosen = row;
      }
      if (emitted.has(chosen.record.originId)) {
        // A legitimate evidence copy has the same ordering tuple and is
        // consumed with its owner's row above. A later repeat is inconsistent
        // shard data, never another complete logical operation.
        snapshot.conflicts.push(chosen.record.originId);
        continue;
      }
      if (emitted.size >= 10_000) throw new Error('origin-pool-snapshot-record-bound');
      emitted.set(chosen.record.originId, chosen.record.envelopeDigest);
      snapshot.emitted.push([chosen.record.originId, chosen.record.envelopeDigest]);
      records.push(chosen);
      recordBytes += Buffer.byteLength(JSON.stringify(chosen));
    }
    let cursor: string | null = null;
    snapshot.emitted = [...emitted];
    if (snapshot.shards.some(shard => shard.records.length || !shard.done)) {
      const bytes = this.cachedBytes();
      if (this.cursors.size >= 100 || bytes + Buffer.byteLength(JSON.stringify(snapshot)) > 16 * 1024 * 1024) throw new Error('origin-pool-snapshot-capacity');
      cursor = randomBytes(24).toString('base64url');
      this.cursors.set(cursor, { snapshot });
    }
    return { records, cursor, snapshotAt: snapshot.at, unavailableShards: [...snapshot.missing].sort(),
      conflictingOrigins: [...new Set(snapshot.conflicts)], coverage: snapshot.missing.length || snapshot.conflicts.length ? 'incomplete' : 'complete' };
  }
}

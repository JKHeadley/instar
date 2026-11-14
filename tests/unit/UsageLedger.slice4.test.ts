/**
 * Unified usage ledger — Slice 4 (docs/specs/unified-usage-ledger.md): replication pages,
 * the holder's pooled copy, the puller's brakes, the read answers, the snapshot restore
 * rules and the /usage/* routes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { UsageLedger, encodeClaudeProjectDir, type InvocationInput, type ExportPage } from '../../src/monitoring/UsageLedger.js';
import { UsagePoolPuller } from '../../src/monitoring/UsagePoolPuller.js';
import { usageSummary, usageSeries, usageTop, usageTree, usageCoverage, trimForPhone, UsageQueryError, type ReadContext } from '../../src/monitoring/usageReadModel.js';
import { mountUsageRoutes, type UsageRouteDeps } from '../../src/server/usageRoutes.js';
import type { ListPriceSource } from '../../src/monitoring/usagePricing.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const DAY = 86_400_000;
const NOW = Date.now();

const prices: ListPriceSource = {
  listEquivalentFor: (m) => (m && m.startsWith('claude-opus-5-5') ? { door: 'anthropic-list', modelId: 'claude-opus-5-5' } : null),
  canonicalPointAt: () => ({ door: 'anthropic-list', modelId: 'claude-opus-5-5', inPerMtok: 4, outPerMtok: 20, cachedInPerMtok: 0.2, cacheWritePerMtok: 5, effectiveAt: '2026-01-01T00:00:00.000Z' }),
};

function inv(feature: string, input: number, over: Partial<InvocationInput> = {}): InvocationInput {
  return {
    feature, framework: 'claude-code', model: 'claude-opus-5-5', startedAt: NOW - 1000, endedAt: NOW, outcome: 'ok',
    jobSlug: null, runId: null, usage: { input, cacheRead: 0, cacheWrite: 0, output: 0 }, ...over,
  };
}

function mk(machineId: string, dbPath = ':memory:', now = () => NOW): UsageLedger {
  return new UsageLedger({ dbPath, machineId, agentId: 'echo', agentHomes: ['/nonexistent-home'], now });
}

function ctx(ledger: UsageLedger, over: Partial<ReadContext> = {}): ReadContext {
  return { ledger, prices, peers: [], now: NOW, scope: 'pool', ...over };
}

describe('Slice 4 — replication', () => {
  let a: UsageLedger, holder: UsageLedger;
  beforeEach(() => { a = mk('m-a'); holder = mk('m-h'); });
  afterEach(() => { a.close(); holder.close(); });

  it('a peer page applied on the holder reproduces the peer totals, and re-applying is idempotent', () => {
    a.enqueueInvocation(inv('ToneGate', 1_000_000));
    a.enqueueInvocation(inv('Sentinel', 500_000));
    a.flushInvocations();
    const page = a.exportPage(0);
    expect(page.machineId).toBe('m-a');
    expect(page.rows.length).toBeGreaterThan(0);
    holder.applyPeerPage('m-a', page);
    holder.applyPeerPage('m-a', page);
    const s = usageSummary(ctx(holder), {});
    const ma = s.machines.find(m => m.machineId === 'm-a')!;
    expect(ma.tokens.total).toBe(1_500_000);
    expect(ma.equivUsd).toBeCloseTo(6);
    expect(s.total.tokens.total).toBe(1_500_000);
  });

  it('the cursor advances so a later pull only carries changes', () => {
    a.enqueueInvocation(inv('ToneGate', 100)); a.flushInvocations();
    const p1 = a.exportPage(0);
    holder.applyPeerPage('m-a', p1);
    const after = holder.peerCursors()[0].lastSeq;
    expect(a.exportPage(after).rows.length).toBe(0);
    a.enqueueInvocation(inv('ToneGate', 50)); a.flushInvocations();
    const p2 = a.exportPage(after);
    expect(p2.rows.length).toBeGreaterThan(0);
    holder.applyPeerPage('m-a', p2);
    expect(usageSummary(ctx(holder), {}).total.tokens.total).toBe(150);
  });

  it('pages end on a seq boundary even with a tiny row cap', () => {
    for (let i = 0; i < 5; i++) { a.enqueueInvocation(inv(`F${i}`, 10)); }
    a.flushInvocations(); // one batch, one seq, many rollup keys
    const page = a.exportPage(0, 2);
    const seqs = new Set(page.rows.filter(r => r.table !== 'session_bindings').map(r => r.row.change_seq));
    // The whole batch arrives together (never half a seq).
    const all = a.exportPage(0).rows.filter(r => r.table !== 'session_bindings' && seqs.has(r.row.change_seq));
    expect(page.rows.filter(r => r.table !== 'session_bindings' && seqs.has(r.row.change_seq)).length).toBe(all.length);
  });

  it('a peer may only write rows under its own machine id; invalid rows are skipped, counted, and do not stall the cursor', () => {
    a.enqueueInvocation(inv('ToneGate', 100)); a.flushInvocations();
    const page = a.exportPage(0);
    const forged: ExportPage = { ...page, rows: [
      ...page.rows,
      { table: 'rollup_day', row: { ...page.rows.find(r => r.table === 'rollup_day')!.row, machine: 'm-other', tok_input: 999 } },
      { table: 'rollup_day', row: { ...page.rows.find(r => r.table === 'rollup_day')!.row, feature: 'x', tok_input: -5 } },
    ] };
    const r = holder.applyPeerPage('m-a', forged);
    expect(r.skipped).toBe(2);
    expect(holder.peerCursors()[0].invalidRows).toBe(2);
    expect(holder.peerCursors()[0].lastSeq).toBe(page.lastSeq);
    expect(usageSummary(ctx(holder), {}).machines.find(m => m.machineId === 'm-other')).toBeUndefined();
  });

  it('a generation change drops that peer\'s pooled rows from its snapshot time and re-pulls from zero', () => {
    a.enqueueInvocation(inv('ToneGate', 100)); a.flushInvocations();
    holder.applyPeerPage('m-a', a.exportPage(0));
    const rebuilt = mk('m-a');
    rebuilt.enqueueInvocation(inv('ToneGate', 40)); rebuilt.flushInvocations();
    const reset = holder.applyPeerPage('m-a', rebuilt.exportPage(0));
    expect(reset.reset).toBe(true);
    expect(holder.peerCursors()[0].generationChanges).toBe(1);
    expect(holder.peerCursors()[0].lastSeq).toBe(0);
    holder.applyPeerPage('m-a', rebuilt.exportPage(0));
    expect(usageSummary(ctx(holder), {}).total.tokens.total).toBe(40);
    rebuilt.close();
  });
});

describe('Slice 4 — puller brakes', () => {
  it('backs off, names a peer not-reached after 3 failures, and recovers on success', async () => {
    let t = NOW;
    const holder = mk('m-h', ':memory:', () => t);
    const peer = mk('m-a');
    peer.enqueueInvocation(inv('ToneGate', 10)); peer.flushInvocations();
    let fail = true;
    const puller = new UsagePoolPuller({
      ledger: holder, peers: () => [{ machineId: 'm-a' }], isHolder: () => true, now: () => t,
      fetchPeer: async (_m, p) => { if (fail) throw new Error('connection refused'); return peer.exportPage(Number(new URL(p, 'http://x').searchParams.get('after'))); },
    });
    for (let i = 0; i < 3; i++) { await puller.pullPeer('m-a'); t += 31 * 60_000; }
    const st = puller.peerStatus()[0];
    expect(st.state).toBe('not-reached');
    expect(st.lastError).toContain('refused');
    expect(st.nextAttemptAt).toBeGreaterThan(t - 31 * 60_000);
    fail = false;
    await puller.pullPeer('m-a');
    expect(puller.peerStatus()[0].state).toBe('ok');
    expect(usageSummary(ctx(holder), {}).total.tokens.total).toBe(10);
    holder.close(); peer.close();
  });

  it('a standby never pulls', async () => {
    const holder = mk('m-h');
    let calls = 0;
    const puller = new UsagePoolPuller({ ledger: holder, peers: () => [{ machineId: 'm-a' }], isHolder: () => false, fetchPeer: async () => { calls++; return {}; } });
    await puller.pullAll();
    puller.touch();
    expect(calls).toBe(0);
    holder.close();
  });

  it('single-flight: concurrent pulls of one peer share one request stream', async () => {
    const holder = mk('m-h');
    const peer = mk('m-a');
    let calls = 0;
    const puller = new UsagePoolPuller({ ledger: holder, peers: () => [{ machineId: 'm-a' }], isHolder: () => true, fetchPeer: async () => { calls++; return peer.exportPage(0); } });
    await Promise.all([puller.pullPeer('m-a'), puller.pullPeer('m-a'), puller.pullPeer('m-a')]);
    expect(calls).toBe(1);
    holder.close(); peer.close();
  });
});

describe('Slice 4 — read answers', () => {
  let l: UsageLedger;
  beforeEach(() => {
    l = mk('m1');
    l.enqueueInvocation(inv('ToneGate', 2_000_000));
    l.enqueueInvocation(inv('Sentinel', 1_000_000, { jobSlug: 'nightly' }));
    l.enqueueInvocation(inv('Mystery', 500, { model: 'unknown-model-9' }));
    l.flushInvocations();
  });
  afterEach(() => l.close());

  it('summary: totals, equivalent cost and the unpriced share', () => {
    const s = usageSummary(ctx(l), {});
    expect(s.total.tokens.total).toBe(3_000_500);
    expect(s.total.equivUsd).toBeCloseTo(12);
    expect(s.total.unpricedTokens).toBe(500);
    expect(s.unpricedShare).toBeGreaterThan(0);
    expect(s.pricing).toContain('list-equivalent');
  });

  it('summary names not-reached and warming machines next to the totals', () => {
    const s = usageSummary(ctx(l, { peers: [{ machineId: 'm2', state: 'not-reached', lastPullAt: null, lastError: 'timeout' }, { machineId: 'm3', state: 'warming', lastPullAt: null, lastError: null }] }), {});
    expect(s.notReached).toEqual(['m2']);
    expect(s.warming).toEqual(['m3']);
    expect(s.machines.find(m => m.machineId === 'm2')?.tokens.total).toBe(0);
  });

  it('top features by equivalent cost, highest first, with limit', () => {
    const t = usageTop(ctx(l), { dim: 'feature', limit: '2' });
    expect(t.items.map(i => i.key)).toEqual(['ToneGate', 'Sentinel']);
    expect(usageTop(ctx(l), { dim: 'job' }).items.map(i => i.key)).toEqual(['nightly']);
  });

  it('series splits by model per bucket', () => {
    const s = usageSeries(ctx(l), { grain: 'hour', split: 'model' });
    expect(s.keys).toContain('claude-opus-5-5');
    expect(s.points.length).toBeGreaterThan(0);
  });

  it('tree nests at most three levels and refuses the session level without a parent', () => {
    const t = usageTree(ctx(l), { by: 'machine,framework,model,feature' });
    expect(t.by).toEqual(['machine', 'framework', 'model']);
    expect(t.root.children?.[0].children?.[0].children?.[0].dim).toBe('model');
    expect(t.root.children?.[0].children?.[0].children?.[0].children).toBeUndefined();
    expect(() => usageTree(ctx(l), { by: 'session' })).toThrow(UsageQueryError);
  });

  it('a node with more than 20 children returns 20 plus an "other" node', () => {
    const big = mk('m1');
    for (let i = 0; i < 25; i++) big.enqueueInvocation(inv(`F${String(i).padStart(2, '0')}`, 1000 + i));
    big.flushInvocations();
    const t = usageTree(ctx(big), { by: 'feature' });
    expect(t.root.children?.length).toBe(21);
    expect(t.root.children?.[20].dim).toBe('other');
    expect(t.root.otherCount).toBe(5);
    big.close();
  });

  it('validates enums and clamps windows by grain', () => {
    expect(() => usageSummary(ctx(l), { grain: 'minute' })).toThrow(UsageQueryError);
    expect(() => usageTop(ctx(l), { dim: 'account' })).toThrow(UsageQueryError);
    expect(() => usageTop(ctx(l), { limit: '0' })).toThrow(UsageQueryError);
    const s = usageSeries(ctx(l), { grain: 'hour', since: String(NOW - 60 * DAY) });
    expect(s.clamped).toBe(true);
    expect(Date.parse(s.since)).toBe(NOW - 14 * DAY);
    expect(usageTop(ctx(l), { dim: 'session', since: String(NOW - 60 * DAY) }).clamped).toBe(true);
  });

  it('coverage lists roots, shares, pairs, counters and the not-read sources', () => {
    const c = usageCoverage(ctx(l));
    expect(c.shares.unpriced).toBeGreaterThan(0);
    expect(c.unpricedModels['unknown-model-9']).toBe(500);
    expect(c.counters.invocations_uncorrelated).toBe(3);
    expect(c.notRead.length).toBeGreaterThan(0);
  });

  it('the phone trim carries names and totals but no machine, session or account ids', () => {
    const c = ctx(l, { peers: [{ machineId: 'secret-machine-id', state: 'not-reached', lastPullAt: null, lastError: 'x' }] });
    const phone = trimForPhone(usageSummary(c, {}), usageSeries(c, {}), {
      topic: usageTop(c, { dim: 'topic' }), job: usageTop(c, { dim: 'job' }), feature: usageTop(c, { dim: 'feature' }),
    });
    const text = JSON.stringify(phone);
    expect(text).not.toContain('secret-machine-id');
    expect(text).not.toContain('m1');
    expect(phone.machinesNotReached).toBe(1);
    expect(phone.partial).toBe(true);
    expect(phone.top.feature[0].name).toBe('ToneGate');
  });
});

describe('Slice 4 — snapshot restore rules', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-snap-')); });
  afterEach(() => { SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/UsageLedger.slice4.test.ts:cleanup' }); });

  function seeded(machine: string, dbFile: string): UsageLedger {
    const l = mk(machine, path.join(tmp, dbFile));
    l.enqueueInvocation(inv('ToneGate', 1234)); l.flushInvocations();
    return l;
  }

  it('never writes a snapshot while the live database is empty', () => {
    const l = mk('m1', path.join(tmp, 'empty.db'));
    expect(l.writeSnapshot(path.join(tmp, 'snap.db')).written).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'snap.db'))).toBe(false);
    l.close();
  });

  it('restoring over a live database changes nothing', () => {
    const l = seeded('m1', 'live.db');
    l.writeSnapshot(path.join(tmp, 'snap.db'));
    expect(l.importSnapshotIfEmpty(path.join(tmp, 'snap.db')).outcome).toBe('ignored-live-authoritative');
    expect(usageSummary(ctx(l), {}).total.tokens.total).toBe(1234);
    l.close();
  });

  it('a lost live database is rebuilt from the snapshot with the same totals and a new generation', () => {
    const l = seeded('m1', 'live.db');
    const gen = l.generationId;
    l.writeSnapshot(path.join(tmp, 'snap.db'));
    l.close();
    const fresh = mk('m1', path.join(tmp, 'live2.db'));
    const r = fresh.importSnapshotIfEmpty(path.join(tmp, 'snap.db'));
    expect(r.outcome).toBe('imported');
    expect(fresh.generationId).not.toBe(gen);
    expect(usageSummary(ctx(fresh), {}).total.tokens.total).toBe(1234);
    expect(fresh.exportPage(0).snapshotAt).toBeGreaterThan(0);
    fresh.close();
  });

  it('a predecessor machine id imports re-keyed to this machine', () => {
    const l = seeded('m-old', 'old.db');
    l.writeSnapshot(path.join(tmp, 'snap.db')); l.close();
    const fresh = mk('m-new', path.join(tmp, 'new.db'));
    expect(fresh.importSnapshotIfEmpty(path.join(tmp, 'snap.db'), { isPredecessor: id => id === 'm-old' }).outcome).toBe('imported');
    expect(usageSummary(ctx(fresh), {}).machines.map(m => m.machineId)).toEqual(['m-new']);
    fresh.close();
  });

  it('a replaced machine that is not a live member imports as a frozen slice, never exported', () => {
    const l = seeded('m-gone', 'gone.db');
    l.writeSnapshot(path.join(tmp, 'snap.db')); l.close();
    const fresh = mk('m-new', path.join(tmp, 'new.db'));
    expect(fresh.importSnapshotIfEmpty(path.join(tmp, 'snap.db')).outcome).toBe('imported-frozen');
    const s = usageSummary(ctx(fresh), {});
    expect(s.machines.find(m => m.machineId === 'm-gone')?.tokens.total).toBe(1234);
    expect(fresh.exportPage(0).rows.filter(r => r.table === 'rollup_day').length).toBe(0);
    fresh.close();
  });

  it('a live pool member\'s snapshot, or another agent\'s, is refused', () => {
    const l = seeded('m-live', 'live.db');
    l.writeSnapshot(path.join(tmp, 'snap.db')); l.close();
    const fresh = mk('m-new', path.join(tmp, 'new.db'));
    expect(fresh.importSnapshotIfEmpty(path.join(tmp, 'snap.db'), { isLivePoolMember: id => id === 'm-live' }).outcome).toBe('refused-live-member');
    fresh.close();
    const otherAgent = new UsageLedger({ dbPath: path.join(tmp, 'other.db'), machineId: 'm-live', agentId: 'not-echo', agentHomes: ['/x'] });
    expect(otherAgent.importSnapshotIfEmpty(path.join(tmp, 'snap.db')).outcome).toBe('refused-other-agent');
    otherAgent.close();
  });
});

describe('Slice 4 — routes', () => {
  let holder: UsageLedger;
  let standby: UsageLedger;
  beforeEach(() => {
    holder = mk('m-h');
    holder.enqueueInvocation(inv('ToneGate', 1_000_000)); holder.flushInvocations();
    standby = mk('m-s');
    standby.enqueueInvocation(inv('Local', 7)); standby.flushInvocations();
  });
  afterEach(() => { holder.close(); standby.close(); });

  function app(deps: UsageRouteDeps | null) {
    const a = express();
    const r = express.Router();
    mountUsageRoutes(r, () => deps);
    a.use(r);
    return a;
  }

  const base = (ledger: UsageLedger, over: Partial<UsageRouteDeps> = {}): UsageRouteDeps => ({
    ledger, prices, puller: null, isHolder: () => true, fromHolder: async () => null, fromPeer: async () => null, bearerOk: () => true, now: () => NOW, ...over,
  });

  it('503 when the ledger is off', async () => {
    const r = await request(app(null)).get('/usage/summary');
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('usage-ledger-off');
  });

  it('the holder answers summary, top, series, tree and coverage; a bad query is 400 in plain words', async () => {
    const a = app(base(holder));
    expect((await request(a).get('/usage/summary')).body.total.tokens.total).toBe(1_000_000);
    expect((await request(a).get('/usage/top?dim=feature')).body.items[0].key).toBe('ToneGate');
    expect((await request(a).get('/usage/series?grain=day&split=framework')).status).toBe(200);
    expect((await request(a).get('/usage/tree')).body.root.label).toBe('agent');
    expect((await request(a).get('/usage/coverage')).status).toBe(200);
    const bad = await request(a).get('/usage/top?dim=wallet');
    expect(bad.status).toBe(400);
    expect(bad.body.detail).toContain('dim must be one of');
  });

  it('a standby proxies to the holder, and answers locally labelled when the holder is unreachable', async () => {
    const holderApp = app(base(holder));
    const proxied = app(base(standby, {
      isHolder: () => false,
      fromHolder: async (p) => { const r = await request(holderApp).get(p).set('x-usage-proxied', '1'); return { status: r.status, body: r.body }; },
    }));
    expect((await request(proxied).get('/usage/summary')).body.total.tokens.total).toBe(1_000_000);
    const alone = app(base(standby, { isHolder: () => false, fromHolder: async () => null }));
    const r = await request(alone).get('/usage/summary');
    expect(r.body.scope).toBe('this-machine-only');
    expect(r.body.holderUnreachable).toBe(true);
    expect(r.body.total.tokens.total).toBe(7);
  });

  it('/usage/rollup serves this machine\'s page; /usage/events validates the session id', async () => {
    const a = app(base(holder));
    const page = await request(a).get('/usage/rollup?after=0');
    expect(page.body.machineId).toBe('m-h');
    expect((await request(a).get('/usage/rollup?after=-1')).status).toBe(400);
    expect((await request(a).get('/usage/events?session=../../etc')).status).toBe(400);
    expect((await request(a).get('/usage/events?session=nope')).status).toBe(404);
  });

  it('/mobile/usage refuses a non-owner and trims for the owner', async () => {
    const denied = express();
    denied.use((req, _res, next) => { (req as any).instarPrincipal = { kind: 'device', deviceId: 'd1' }; next(); });
    const r = express.Router(); mountUsageRoutes(r, () => base(holder)); denied.use(r);
    expect((await request(denied).get('/mobile/usage')).status).toBe(403);
    const ok = await request(app(base(holder))).get('/mobile/usage?window=week');
    expect(ok.status).toBe(200);
    expect(ok.body.total.tokens).toBe(1_000_000);
    expect(JSON.stringify(ok.body)).not.toContain('m-h');
  });
});

describe('Slice 4 — Claude transcripts flow through to the read answers', () => {
  it('a counted transcript request shows up under its topic', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-s4-claude-'));
    try {
      const home = path.join(tmp, 'agent');
      const cfg = path.join(tmp, 'claude');
      fs.mkdirSync(home, { recursive: true });
      const l = new UsageLedger({ dbPath: ':memory:', machineId: 'm1', agentId: 'echo', agentHomes: [home], now: () => NOW + 60_000 });
      l.addClaudeRoot(cfg, 'test');
      l.recordBinding({ sessionId: 's-1', framework: 'claude-code', sessionKind: 'interactive', cwd: home, topicId: '141063', jobSlug: null, runId: null, accountId: null, validFrom: NOW - 1000 });
      const dir = path.join(cfg, 'projects', encodeClaudeProjectDir(home));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 's-1.jsonl'), JSON.stringify({
        type: 'assistant', requestId: 'r1', sessionId: 's-1', cwd: home, timestamp: new Date(NOW + 30_000).toISOString(),
        message: { model: 'claude-opus-5-5', usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 } },
      }) + '\n');
      l.scanTick();
      const t = usageTop(ctx(l, { now: NOW + 60_000 }), { dim: 'topic' });
      expect(t.items[0]).toMatchObject({ key: '141063' });
      expect(t.items[0].tokens.total).toBe(100);
      l.close();
    } finally {
      SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/UsageLedger.slice4.test.ts:cleanup2' });
    }
  });
});

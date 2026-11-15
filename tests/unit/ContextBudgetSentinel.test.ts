// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
/**
 * ContextBudgetSentinel, Phase 0 core (context-budget-layered-summaries §7.8,
 * §9.3 Quarantine): the heartbeat, quarantine reconciliation (rollback within
 * the bound; past it force-end, VERIFIED termination, then rollback-degraded;
 * containment stays on any unknown), the torn-record guard and escalation,
 * and the checkpoint grace pass. Real coordinator, lease, records and gate;
 * only sessions, transcripts and Attention are stubs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FencedLease, type LeaseCrypto } from '../../src/core/FencedLease.js';
import { KeyedLeaseLock, LocalKeyedLeaseStore } from '../../src/core/KeyedLease.js';
import { FoldCoordinator, FoldRecordStore, type FoldCarrier, type FoldRecord, type FoldState } from '../../src/monitoring/FoldCoordinator.js';
import { ContextBudgetSentinel, QUARANTINE_RECONCILE_BOUND_MS, CONTEXT_BUDGET_SENTINEL_TICK_MS, type AttentionNotice, type FoldCandidate } from '../../src/monitoring/ContextBudgetSentinel.js';
import { InMemorySelfHealEpisodeStore } from '../../src/core/SelfHealGate.js';
import { engineCheckpointCarrier } from '../../src/monitoring/engineCheckpoint.js';
import type { AdmissionToken } from '../../src/monitoring/selfaction/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/unit/ContextBudgetSentinel.test.ts';
const T = '141133';
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const leaseCrypto: LeaseCrypto = {
  selfMachineId: 'm_self',
  sign: (c) => crypto.sign(null, Buffer.from(c), privateKey).toString('base64'),
  verify: (c, s, h) => h === 'm_self' && crypto.verify(null, Buffer.from(c), publicKey, Buffer.from(s, 'base64')),
};

describe('ContextBudgetSentinel', () => {
  let stateDir: string; let now: number; let ids: number;
  let store: FoldRecordStore; let fc: FoldCoordinator;
  let released: string[]; let held: Array<{ topicKey: string; foldId: string }>;
  let sessions: FoldCandidate[]; let alive: Set<string>; let sizes: Map<string, number | null>;
  let killed: string[]; let attention: AttentionNotice[]; let owns: boolean | 'unknown';

  const carrier: FoldCarrier = {
    kind: 'test-hold',
    release: (t, f) => { released.push(`${t}/${f}`); held = held.filter((c) => c.foldId !== f); },
    list: () => held,
  };

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-sentinel-'));
    now = Date.parse('2026-11-10T08:00:00Z'); ids = 0;
    released = []; held = []; killed = []; attention = []; owns = true;
    sessions = [{ tmuxSession: 'echo-141133', transcriptPath: '/t/a.jsonl' }];
    alive = new Set(['echo-141133']); sizes = new Map([['/t/a.jsonl', 1000]]);
    const lock = new KeyedLeaseLock({
      fenced: new FencedLease(leaseCrypto, { leaseTtlMs: 60_000, failoverThresholdMs: 120_000 }),
      store: new LocalKeyedLeaseStore(path.join(stateDir, 'state', 'fold-leases')), ttlMs: 60_000, now: () => now,
    });
    store = new FoldRecordStore(stateDir);
    fc = new FoldCoordinator({
      store, lock, machineId: 'm_self', ownerEpoch: () => 7, carriers: [carrier], now: () => now, newFoldId: () => `fold${(ids += 1)}`,
      preconditions: { isOwner: () => true, sentinelHeartbeatFresh: () => true, hasRowSource: () => true, exactlyOneLiveSession: () => true, inboundQueueLive: () => true, layerKindPresent: () => true, topicRowsPresent: () => true },
    });
  });
  afterEach(() => SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: OP }));

  const quarantined = (): FoldRecord => {
    const b = fc.begin(T); if (!b.ok) throw new Error(b.reason);
    let r = b.record;
    for (const to of ['snapshotted', 'staged', 'replacing'] as FoldState[]) {
      const x = fc.transition(T, r.foldId, { state: r.state, seq: r.seq, generation: r.generation }, to); if (!x.ok) throw new Error(x.reason); r = x.record;
    }
    held.push({ topicKey: T, foldId: r.foldId });
    const q = fc.quarantine(T, r.foldId, 'step bound passed'); if (!q.ok) throw new Error(q.reason);
    return q.record;
  };

  const make = (over: Partial<ConstructorParameters<typeof ContextBudgetSentinel>[0]> = {}) => new ContextBudgetSentinel({
    stateDir, machineId: 'm_self', coordinator: fc, store,
    ownsFold: () => owns, ownsTopic: () => owns,
    candidates: () => sessions.filter((s) => alive.has(s.tmuxSession)),
    tmuxAlive: (t) => alive.has(t),
    kill: (t) => { killed.push(t); alive.delete(t); },
    fileBytes: (p) => sizes.get(p) ?? null,
    attention: (n) => { attention.push(n); },
    admit: async () => ({ outcome: 'allow' as const, token: { id: 't' } as AdmissionToken, reason: 'admitted' as const }),
    consumeToken: () => ({ proceed: true, valid: true }),
    episodeStore: new InMemorySelfHealEpisodeStore(),
    now: () => now,
    ...over,
  });
  const advance = (ms: number) => { now += ms; };

  it('heartbeat: absent before the first tick, fresh after, stale after two missed intervals', async () => {
    const s = make();
    expect(s.heartbeatFresh()).toBe(false);
    await s.tick();
    expect(s.heartbeatFresh()).toBe(true);
    advance(2 * CONTEXT_BUDGET_SENTINEL_TICK_MS + 1);
    expect(s.heartbeatFresh()).toBe(false);
  });

  it('within the bound: the rollback runner rolls back (healed); without one the fold waits, containment intact', async () => {
    const rec = quarantined();
    const s0 = make();
    await s0.tick();
    expect(store.get(T, rec.foldId)?.state).toBe('quarantined');
    expect(killed).toEqual([]); expect(released).toEqual([]);
    const rollback = vi.fn(async (r: FoldRecord) => {
      const x = fc.transition(T, r.foldId, { state: r.state, seq: r.seq, generation: r.generation }, 'rolled-back', { reason: 'step 8' });
      return x.ok ? 'rolled-back' as const : 'failed' as const;
    });
    advance(CONTEXT_BUDGET_SENTINEL_TICK_MS);
    await make({ rollback }).tick();
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(store.get(T, rec.foldId)?.state).toBe('rolled-back');
    expect(released).toEqual([`${T}/${rec.foldId}`]);
  });

  it('past the bound: force-end, then on a LATER tick verified termination ⇒ rollback-degraded, holds released, one notice', async () => {
    const rec = quarantined();
    const s = make();
    advance(QUARANTINE_RECONCILE_BOUND_MS);
    await s.tick();
    expect(killed).toEqual(['echo-141133']);
    expect(store.get(T, rec.foldId)?.state).toBe('quarantined'); // not verified on the same tick
    expect(released).toEqual([]);
    advance(CONTEXT_BUDGET_SENTINEL_TICK_MS);
    await s.tick();
    const after = store.get(T, rec.foldId)!;
    expect(after.state).toBe('rolled-back');
    expect(after.reason).toMatch(/^rollback-degraded/);
    expect(released).toEqual([`${T}/${rec.foldId}`]);
    // The FULL notice list: exactly one, no "slow to recover" notice while it waited its bound.
    expect(attention.map((a) => a.id)).toEqual([`context-budget-rollback-degraded-${T}-${rec.foldId}`]);
    advance(CONTEXT_BUDGET_SENTINEL_TICK_MS); await s.tick();
    expect(attention).toHaveLength(1);
  });

  it.each([
    ['the transcript grew after the force-end', () => { sizes.set('/t/a.jsonl', 2000); }],
    ['the transcript cannot be read', () => { sizes.set('/t/a.jsonl', null); }],
    ['the session is still alive', () => { alive.add('echo-141133'); }],
  ])('containment STAYS when termination is not verified: %s', async (_n, spoil) => {
    const rec = quarantined();
    const s = make();
    advance(QUARANTINE_RECONCILE_BOUND_MS); await s.tick();
    spoil();
    advance(CONTEXT_BUDGET_SENTINEL_TICK_MS); await s.tick();
    expect(store.get(T, rec.foldId)?.state).toBe('quarantined');
    expect(released).toEqual([]);
  });

  it('a transcript path that never resolves keeps containment and the ladder escalates URGENT naming the topic', async () => {
    sessions = [{ tmuxSession: 'echo-141133', transcriptPath: null }];
    const rec = quarantined();
    const s = make();
    advance(QUARANTINE_RECONCILE_BOUND_MS);
    for (let i = 0; i < 20; i++) { await s.tick(); advance(CONTEXT_BUDGET_SENTINEL_TICK_MS); }
    expect(store.get(T, rec.foldId)?.state).toBe('quarantined');
    expect(released).toEqual([]);
    const urgent = attention.filter((a) => a.priority === 'URGENT');
    expect(urgent).toHaveLength(1);
    expect(urgent[0].title).toContain(`topic ${T}`);
  });

  it('the termination snapshot survives a restart and never verifies vacuously after a re-force-end', async () => {
    sessions = [{ tmuxSession: 'echo-141133', transcriptPath: null }];
    const rec = quarantined();
    advance(QUARANTINE_RECONCILE_BOUND_MS); await make().tick(); // force-ended; session now dead
    for (let i = 0; i < 3; i++) { advance(CONTEXT_BUDGET_SENTINEL_TICK_MS); await make().tick(); } // three restarts
    expect(store.get(T, rec.foldId)?.state).toBe('quarantined');
    expect(released).toEqual([]);
  });

  it('a session seen on a later attempt joins the snapshot and is ended too', async () => {
    const rec = quarantined();
    const s = make();
    advance(QUARANTINE_RECONCILE_BOUND_MS); await s.tick();
    sessions.push({ tmuxSession: 'echo-141133-b', transcriptPath: '/t/b.jsonl' }); alive.add('echo-141133-b'); sizes.set('/t/b.jsonl', 5);
    advance(CONTEXT_BUDGET_SENTINEL_TICK_MS); await s.tick(); // not verified: a live session on the topic ⇒ re-force-end
    expect(killed).toEqual(['echo-141133', 'echo-141133-b']);
    advance(CONTEXT_BUDGET_SENTINEL_TICK_MS); await s.tick();
    expect(store.get(T, rec.foldId)?.state).toBe('rolled-back');
  });

  describe('review round 1: never release on an unknown', () => {
    const forceEndThenVerify = async (s: ContextBudgetSentinel) => { advance(QUARANTINE_RECONCILE_BOUND_MS); await s.tick(); advance(CONTEXT_BUDGET_SENTINEL_TICK_MS); await s.tick(); };

    it('a record torn for one tick keeps the termination snapshot (its unreadable transcript is not forgotten)', async () => {
      sessions = [{ tmuxSession: 'echo-141133', transcriptPath: null }];
      const rec = quarantined();
      const s = make();
      advance(QUARANTINE_RECONCILE_BOUND_MS); await s.tick(); // force-ended; snapshot holds an unreadable transcript
      const file = path.join(store.dirFor(T), `${rec.foldId}.json`); const good = fs.readFileSync(file, 'utf-8');
      fs.writeFileSync(file, '{torn'); advance(CONTEXT_BUDGET_SENTINEL_TICK_MS); await s.tick();
      fs.writeFileSync(file, good);
      for (let i = 0; i < 4; i++) { advance(CONTEXT_BUDGET_SENTINEL_TICK_MS); await s.tick(); }
      expect(store.get(T, rec.foldId)?.state).toBe('quarantined');
      expect(released).toEqual([]);
    });

    it('a tmux probe that cannot answer is never read as gone', async () => {
      const rec = quarantined();
      const s = make({ tmuxAlive: (t) => (alive.has(t) ? true : 'unknown') });
      await forceEndThenVerify(s);
      expect(store.get(T, rec.foldId)?.state).toBe('quarantined');
    });

    it('a crash that left no session gives no evidence of termination: containment stays and it escalates', async () => {
      sessions = []; alive.clear();
      const rec = quarantined();
      const s = make();
      for (let i = 0; i < 20; i++) { advance(i === 0 ? QUARANTINE_RECONCILE_BOUND_MS : CONTEXT_BUDGET_SENTINEL_TICK_MS); await s.tick(); }
      expect(store.get(T, rec.foldId)?.state).toBe('quarantined');
      expect(attention.filter((a) => a.priority === 'URGENT')).toHaveLength(1);
    });

    it('the rollback-degraded notice survives a down Attention channel and a restart', async () => {
      const rec = quarantined();
      let up = false;
      const flaky = (n: AttentionNotice) => { if (!up) throw new Error('down'); attention.push(n); };
      await forceEndThenVerify(make({ attention: flaky }));
      expect(store.get(T, rec.foldId)?.state).toBe('rolled-back');
      expect(attention).toEqual([]);
      up = true;
      advance(CONTEXT_BUDGET_SENTINEL_TICK_MS); await make({ attention: flaky }).tick(); // a NEW instance: the outbox is durable
      expect(attention.map((a) => a.id)).toEqual([`context-budget-rollback-degraded-${T}-${rec.foldId}`]);
      advance(CONTEXT_BUDGET_SENTINEL_TICK_MS); await make({ attention: flaky }).tick();
      expect(attention).toHaveLength(1);
    });

    it('a queued degraded notice is DROPPED if the fold ended any other way (no wrong notice)', async () => {
      const rec = quarantined();
      // Force-end, then make the degraded transition fail by rolling back cleanly in between.
      const s = make();
      advance(QUARANTINE_RECONCILE_BOUND_MS); await s.tick();
      const cur = store.get(T, rec.foldId)!;
      expect(fc.transition(T, rec.foldId, { state: cur.state, seq: cur.seq, generation: cur.generation }, 'rolled-back', { reason: 'step 8 (runner)' }).ok).toBe(true);
      // Plant the entry the degraded path would have queued before its refused transition.
      const ob = path.join(stateDir, 'state', 'context-budget', 'outbox.json');
      fs.mkdirSync(path.dirname(ob), { recursive: true });
      fs.writeFileSync(ob, JSON.stringify({ x: { notice: { id: 'x', title: 't', summary: 's', priority: 'HIGH' }, whenRolledBack: { topicKey: T, foldId: rec.foldId } } }));
      advance(CONTEXT_BUDGET_SENTINEL_TICK_MS); await s.tick();
      expect(attention).toEqual([]);
      expect(JSON.parse(fs.readFileSync(ob, 'utf-8'))).toEqual({});
    });

    it('a record with no usable timestamp waits; it never ends a session early', async () => {
      const rec = quarantined();
      const file = path.join(store.dirFor(T), `${rec.foldId}.json`);
      const r = JSON.parse(fs.readFileSync(file, 'utf-8')); delete r.updatedAt; fs.writeFileSync(file, JSON.stringify(r));
      advance(QUARANTINE_RECONCILE_BOUND_MS * 2); await make().tick();
      expect(killed).toEqual([]);
    });

    it('a refused kill (protected session) does not stop the others, and containment stays', async () => {
      sessions.push({ tmuxSession: 'echo-141133-b', transcriptPath: '/t/b.jsonl' }); alive.add('echo-141133-b'); sizes.set('/t/b.jsonl', 1);
      const rec = quarantined();
      const s = make({ kill: (t) => { if (t === 'echo-141133') throw new Error('protected'); killed.push(t); alive.delete(t); } });
      await forceEndThenVerify(s);
      expect(killed).toContain('echo-141133-b');
      expect(store.get(T, rec.foldId)?.state).toBe('quarantined');
    });

    it('a tick with a failed step does not refresh the heartbeat', async () => {
      const s = make({ episodeStore: { load: () => { throw new Error('store broken'); }, create: () => null, mutate: () => null } as never });
      quarantined();
      await s.tick();
      expect(s.heartbeatFresh()).toBe(false);
      expect(s.status().lastError).toMatch(/^quarantine|^prune/);
    });

    it('a torn record refuses a new fold on that topic', () => {
      const rec = quarantined();
      fs.writeFileSync(path.join(store.dirFor(T), `${rec.foldId}.json`), '{torn');
      expect(fc.begin(T)).toEqual({ ok: false, reason: 'torn-record' });
    });
  });

  it('a non-owner observes only: no kill, no transition, no notice', async () => {
    owns = false;
    const rec = quarantined();
    const s = make();
    advance(QUARANTINE_RECONCILE_BOUND_MS); await s.tick();
    advance(CONTEXT_BUDGET_SENTINEL_TICK_MS); await s.tick();
    expect(killed).toEqual([]); expect(attention).toEqual([]);
    expect(store.get(T, rec.foldId)?.state).toBe('quarantined');
    expect(s.status().quarantined).toMatchObject([{ topicKey: T, foldId: rec.foldId, owned: false }]);
  });

  describe('torn records (never release on an unknown)', () => {
    const tear = (foldId: string) => fs.writeFileSync(path.join(store.dirFor(T), `${foldId}.json`), '{torn');

    it('the store tells absent from torn; the boot sweep keeps every carrier of a torn record and reports it', () => {
      const rec = quarantined();
      tear(rec.foldId);
      expect(store.inspect(T, rec.foldId)).toEqual({ kind: 'torn' });
      expect(store.inspect(T, 'nope')).toEqual({ kind: 'absent' });
      const out = fc.recoverPendingFolds();
      expect(out.torn).toEqual([{ topicKey: T, foldId: rec.foldId }]);
      expect(released).toEqual([]);
      expect(out.orphans).toEqual([]);
    });

    it('an absent record is still an orphan and is released (the guard is torn-only)', () => {
      held.push({ topicKey: T, foldId: 'ghost' });
      const out = fc.recoverPendingFolds();
      expect(out.orphans).toMatchObject([{ foldId: 'ghost' }]);
      expect(released).toEqual([`${T}/ghost`]);
    });

    it('the engine checkpoint carrier keeps a checkpoint whose record is unreadable', () => {
      const dir = path.join(stateDir, 'state', 'context-archive', T, 'checkpoints');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'f9.jsonl'), 'x');
      engineCheckpointCarrier(stateDir, () => 'unreadable').release(T, 'f9');
      expect(fs.existsSync(path.join(dir, 'f9.jsonl'))).toBe(true);
    });

    it('the owner raises ONE Attention item per torn record, durably, and again after it recurs', async () => {
      const rec = quarantined(); tear(rec.foldId);
      await make().tick(); await make().tick(); // two sentinel lifetimes
      expect(attention.filter((a) => a.id === `context-budget-torn-record-${T}-${rec.foldId}`)).toHaveLength(1);
      // The title names the fold, as the quarantine notices do, so the console's Home count dedupes it by fold id.
      expect(attention.find((a) => a.id === `context-budget-torn-record-${T}-${rec.foldId}`)!.title).toContain(`(fold ${rec.foldId})`);
      fs.writeFileSync(path.join(store.dirFor(T), `${rec.foldId}.json`), JSON.stringify({ ...rec, state: 'rolled-back' }));
      await make().tick();
      tear(rec.foldId);
      await make().tick();
      expect(attention.filter((a) => a.id === `context-budget-torn-record-${T}-${rec.foldId}`)).toHaveLength(2);
    });

    it('a non-owner does not raise it', async () => {
      owns = false;
      const rec = quarantined(); tear(rec.foldId);
      await make().tick();
      expect(attention).toEqual([]);
      expect(make().status().torn).toEqual([]); // status reflects the last tick of that instance
    });
  });

  it('runs the canary each tick and reports it in status; a failing canary scan leaves the heartbeat stale', async () => {
    const { CompactionCanary } = await import('../../src/monitoring/compactionCanary.js');
    const instance = new CompactionCanary({ stateDir, machineId: 'm_self', now: () => now });
    const tr = path.join(stateDir, 'tr.jsonl');
    fs.writeFileSync(tr, '');
    const sessionsFn = vi.fn(() => [{ topicKey: T, claudeSessionId: 'sid', transcriptPath: tr, engine: 'claude-code' }]);
    const s = make({ canary: { instance, sessions: sessionsFn, switchOn: () => true } });
    await s.tick();
    fs.appendFileSync(tr, JSON.stringify({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto' }, uuid: 'b1', timestamp: new Date(now).toISOString(), sessionId: 'sid', version: '2.1.321' }) + '\n');
    advance(1_000); await s.tick();
    expect(sessionsFn).toHaveBeenCalledTimes(2);
    expect(s.status().canary?.groups[0]).toMatchObject({ engine: 'claude-code', version: '2.1.321', detected: 1, pending: 1 });
    expect(s.heartbeatFresh()).toBe(true);
    const broken = make({ canary: { instance, sessions: () => { throw new Error('session list failed'); }, switchOn: () => true } });
    await broken.tick();
    expect(broken.heartbeatFresh()).toBe(false);
    expect(broken.status().lastError).toMatch(/^canary/);
  });

  describe('adapter verification suite trigger (§9.6)', () => {
    const result = (version: string) => ({ schema: 'adapter-suite/1' as const, engine: 'claude-code' as const, version, machine: 'm', ranAt: now, durationMs: 1,
      capabilities: { toolPolicy: { state: 'supported' as const, evidence: 'refused' } } as never, inconclusive: false, errors: [] as string[] });

    it('runs once for an unrecorded version, never twice at once, then not again once recorded', async () => {
      const { writeSuiteResult } = await import('../../src/monitoring/adapterVerificationSuite.js');
      let finish!: () => void;
      const run = vi.fn(() => new Promise<void>((r) => { finish = () => { writeSuiteResult(stateDir, result('2.1.322')); r(); }; }));
      const s = make({ adapterSuite: { currentVersion: () => '2.1.322', run } });
      await s.tick(); await s.tick();
      expect(run).toHaveBeenCalledTimes(1);
      expect(s.status().adapterSuite.running).toBe(true);
      finish(); await new Promise((r) => setTimeout(r, 5));
      advance(25 * 60 * 60_000); await s.tick();
      expect(run).toHaveBeenCalledTimes(1); // recorded for this version
      expect(s.status().adapterSuite).toMatchObject({ running: false, results: [{ version: '2.1.322' }] });
    });

    it('a failed run is retried only after the backoff, durably (a restart does not reset it)', async () => {
      const run = vi.fn(async () => { throw new Error('engine down'); });
      await make({ adapterSuite: { currentVersion: () => '2.1.323', run } }).tick();
      await new Promise((r) => setTimeout(r, 5));
      advance(60_000); await make({ adapterSuite: { currentVersion: () => '2.1.323', run } }).tick(); // a NEW instance
      expect(run).toHaveBeenCalledTimes(1);
      advance(24 * 60 * 60_000); await make({ adapterSuite: { currentVersion: () => '2.1.323', run } }).tick();
      expect(run).toHaveBeenCalledTimes(2);
    });

    it('gives up after 3 failed attempts for a version, and the status says so', async () => {
      const run = vi.fn(async () => { throw new Error('engine down'); });
      for (let i = 0; i < 5; i++) { await make({ adapterSuite: { currentVersion: () => '2.1.324', run } }).tick(); await new Promise((r) => setTimeout(r, 2)); advance(25 * 60 * 60_000); }
      expect(run).toHaveBeenCalledTimes(3);
      expect(make({ adapterSuite: { currentVersion: () => '2.1.324', run } }).status().adapterSuite).toMatchObject({ gaveUp: ['2.1.324'], attempts: { '2.1.324': { count: 3 } } });
    });

    it('a new engine version triggers a run; an unknown version never does', async () => {
      const { writeSuiteResult } = await import('../../src/monitoring/adapterVerificationSuite.js');
      writeSuiteResult(stateDir, result('2.1.322'));
      const run = vi.fn(async () => {});
      let v: string | null = null;
      const s = make({ adapterSuite: { currentVersion: () => v, run } });
      await s.tick(); expect(run).not.toHaveBeenCalled();
      v = '2.1.322'; await s.tick(); expect(run).not.toHaveBeenCalled();
      v = '2.1.330'; await s.tick(); expect(run).toHaveBeenCalledTimes(1);
    });
  });

  it('runs the checkpoint grace pass each tick', async () => {
    const dir = path.join(stateDir, 'state', 'context-archive', T, 'checkpoints');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'old.jsonl'), 'x');
    fs.writeFileSync(path.join(dir, 'old.json'), JSON.stringify({ schema: 'engine-checkpoint/1', topicKey: T, foldId: 'old', sessionId: 's', sourcePath: '/x', file: `${T}/checkpoints/old.jsonl`, sha256: 'a', bytes: 1, lastEntryId: null, takenAt: 0, settledAt: now - 25 * 60 * 60_000 }));
    const s = make();
    await s.tick();
    expect(fs.existsSync(path.join(dir, 'old.jsonl'))).toBe(false);
    expect(s.status().checkpointsPruned).toBe(1);
  });

  it('refuses a tick interval that would break the gate\'s idle-prune contract', () => {
    expect(() => make({ tickMs: QUARANTINE_RECONCILE_BOUND_MS * 2 })).toThrow(/tick interval/);
  });
});

describe('tmuxHasSession (three-state)', () => {
  const fake = (r: { status?: number | null; stderr?: string; error?: Error }) => (() => ({ status: r.status ?? null, stderr: r.stderr ?? '', stdout: '', pid: 1, output: [], signal: null, ...(r.error ? { error: r.error } : {}) })) as never;
  it('alive, gone, and every other answer is unknown', async () => {
    const { tmuxHasSession } = await import('../../src/monitoring/contextBudgetSentinelBoot.js');
    expect(tmuxHasSession('s', fake({ status: 0 }))).toBe(true);
    expect(tmuxHasSession('s', fake({ status: 1, stderr: "can't find session: s" }))).toBe(false);
    expect(tmuxHasSession('s', fake({ status: 1, stderr: 'no server running on /tmp/tmux-1000/default' }))).toBe(false);
    expect(tmuxHasSession('s', fake({ error: new Error('ETIMEDOUT') }))).toBe('unknown');
    expect(tmuxHasSession('s', fake({ status: 1, stderr: 'something else' }))).toBe('unknown');
    expect(tmuxHasSession('s', fake({ status: null }))).toBe('unknown');
    expect(tmuxHasSession('s', fake({ status: 1, stderr: 'error connecting to /tmp/tmux-1000/default (No such file or directory)' }))).toBe(false);
    expect(tmuxHasSession('s', fake({ status: 1, stderr: 'error connecting to /tmp/tmux-1000/default (Permission denied)' }))).toBe('unknown');
    expect(tmuxHasSession('bad name; rm', fake({ status: 0 }))).toBe('unknown');
  });
});

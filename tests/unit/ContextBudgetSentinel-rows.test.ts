// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
/**
 * ContextBudgetSentinel, the §17 rows (context-budget-layered-summaries §7.8,
 * §17, Phase 1 S12): layer freshness, hold health, and the eligible topic
 * without a fold. Real coordinator, records, hold store, markers and gate;
 * only sessions, TopicMemory's reading and Attention are stubs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FencedLease, type LeaseCrypto } from '../../src/core/FencedLease.js';
import { KeyedLeaseLock, LocalKeyedLeaseStore } from '../../src/core/KeyedLease.js';
import { FoldCoordinator, FoldRecordStore, type FoldRecord } from '../../src/monitoring/FoldCoordinator.js';
import {
  ContextBudgetSentinel, CONTEXT_BUDGET_SENTINEL_TICK_MS, ORPHAN_GRACE_MS, LAYER_REBUILD_SPACING_MS, LAYER_STALE_SUSTAINED_MS,
  LAYER_REBUILD_MAX_PER_EPISODE, STATUS_ROW_LIMIT,
  type AttentionNotice, type DegradationRow, type HoldCarrierSource, type LayerRebuildOutcome,
} from '../../src/monitoring/ContextBudgetSentinel.js';
import { InMemorySelfHealEpisodeStore } from '../../src/core/SelfHealGate.js';
import { FoldHoldStore, foldHoldCarrier } from '../../src/monitoring/FoldHoldStore.js';
import { writeFoldMarker, listFoldMarkers, foldMarkersDir } from '../../src/monitoring/foldMarker.js';
import { productionHoldCarriers } from '../../src/monitoring/contextBudgetSentinelBoot.js';
import type { AdmissionToken } from '../../src/monitoring/selfaction/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/unit/ContextBudgetSentinel-rows.test.ts';
const T = '141133';
const TICK = CONTEXT_BUDGET_SENTINEL_TICK_MS;
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const leaseCrypto: LeaseCrypto = {
  selfMachineId: 'm_self',
  sign: (c) => crypto.sign(null, Buffer.from(c), privateKey).toString('base64'),
  verify: (c, s, h) => h === 'm_self' && crypto.verify(null, Buffer.from(c), publicKey, Buffer.from(s, 'base64')),
};
const allow = async () => ({ outcome: 'allow' as const, token: { id: 't' } as AdmissionToken, reason: 'admitted' as const });

describe('ContextBudgetSentinel §17 rows', () => {
  let stateDir: string; let now: number; let ids: number;
  let store: FoldRecordStore; let fc: FoldCoordinator; let holds: FoldHoldStore;
  let attention: AttentionNotice[]; let degradations: DegradationRow[]; let owns: boolean | 'unknown';
  let live: string[];

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-rows-'));
    now = Date.parse('2026-11-10T08:00:00Z'); ids = 0;
    attention = []; degradations = []; owns = true; live = [T];
    const lock = new KeyedLeaseLock({
      fenced: new FencedLease(leaseCrypto, { leaseTtlMs: 60_000, failoverThresholdMs: 120_000 }),
      store: new LocalKeyedLeaseStore(path.join(stateDir, 'state', 'fold-leases')), ttlMs: 60_000, now: () => now,
    });
    store = new FoldRecordStore(stateDir);
    holds = new FoldHoldStore({ stateDir, ttlCeilingMs: 60 * 60_000, now: () => now });
    fc = new FoldCoordinator({
      store, lock, machineId: 'm_self', ownerEpoch: () => 7, carriers: [foldHoldCarrier(holds)], now: () => now, newFoldId: () => `fold${(ids += 1)}`,
      preconditions: { isOwner: () => true, sentinelHeartbeatFresh: () => true, hasRowSource: () => true, exactlyOneLiveSession: () => true, inboundQueueLive: () => true, layerKindPresent: () => true, topicRowsPresent: () => true },
    });
  });
  afterEach(() => SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: OP }));

  type Deps = ConstructorParameters<typeof ContextBudgetSentinel>[0];
  const make = (over: Partial<Deps> = {}) => new ContextBudgetSentinel({
    stateDir, machineId: 'm_self', coordinator: fc, store,
    ownsFold: () => owns, ownsTopic: () => owns,
    candidates: () => [], tmuxAlive: () => false, kill: () => {}, fileBytes: () => null,
    attention: (n) => { attention.push(n); },
    admit: allow, consumeToken: () => ({ proceed: true, valid: true }),
    episodeStore: new InMemorySelfHealEpisodeStore(),
    now: () => now,
    liveTopics: () => live,
    ...over,
  });
  const withHolds = (over: Partial<NonNullable<Deps['holdHealth']>> = {}): Pick<Deps, 'holdHealth'> => ({
    holdHealth: { carriers: productionHoldCarriers({ stateDir, holds }), admit: allow, degradation: (r) => { degradations.push(r); }, ...over },
  });
  const advance = (ms: number) => { now += ms; };

  // ── (a) layer freshness ────────────────────────────────────────────────

  describe('layer freshness', () => {
    it('without the layers the row reads unavailable: layers-off; without a session source, no-session-source', async () => {
      const s = make();
      await s.tick();
      expect(s.status().layerFreshness).toEqual({ state: 'unavailable', reason: 'layers-off' });
      const s2 = make({ liveTopics: undefined, layers: { h1: () => ({ line: 'x', stale: false }) } });
      await s2.tick();
      expect(s2.status().layerFreshness).toEqual({ state: 'unavailable', reason: 'no-session-source' });
    });

    it('missing evidence reads unknown, is counted, and takes no action (no rebuild request, no notice)', async () => {
      const requests: string[] = [];
      live = ['1', '2', '3'];
      const s = make({ layers: {
        h1: (t) => { if (t === '1') return null; if (t === '2') throw new Error('stamp unreadable'); return { line: 'as of …, stale: unknown', stale: 'unknown' }; },
        requestRebuild: (t) => { requests.push(t); return 'reprojected'; },
      } });
      for (let i = 0; i < 30; i++) { await s.tick(); advance(TICK); }
      const row = s.status().layerFreshness;
      expect(row.state).toBe('ok');
      if (row.state !== 'ok') return;
      expect(row.counts).toMatchObject({ topics: 3, unknown: 3, stale: 0, fresh: 0, rebuildRequests: 0, notices: 0 });
      expect(row.topics.map((r) => r.h1.stale)).toEqual(['unknown', 'unknown', 'unknown']);
      expect(row.topics.every((r) => r.h3.state === 'unavailable' && r.h3.reason === 'h3-not-built')).toBe(true);
      expect(requests).toEqual([]);
      expect(attention).toEqual([]);
      expect(s.heartbeatFresh()).toBe(true); // an unknown reading is not a failed tick
    });

    it('over target on an owned topic: rebuild requests through the seam, bounded and spaced; a seam that could act and did not help ⇒ exactly ONE notice, surviving a restart', async () => {
      const requests: Array<{ t: string; at: number }> = [];
      const layers = {
        h1: () => ({ line: 'as of …, 5 messages behind', stale: true as const, userTurnsBehind: 4 }),
        requestRebuild: (t: string): LayerRebuildOutcome => { requests.push({ t, at: now }); return 'failed'; },
      };
      let s = make({ layers });
      for (let i = 0; i < 48; i++) {
        if (i === 20) s = make({ layers }); // a restart mid-episode: the episode is durable
        await s.tick(); advance(TICK);
      }
      expect(requests).toHaveLength(LAYER_REBUILD_MAX_PER_EPISODE);
      for (let i = 1; i < requests.length; i++) expect(requests[i].at - requests[i - 1].at).toBeGreaterThanOrEqual(LAYER_REBUILD_SPACING_MS);
      const stale = attention.filter((n) => n.id.startsWith('context-budget-layer-stale-'));
      expect(stale).toHaveLength(1);
      expect(stale[0].title).toContain('falling behind');
      expect(stale[0].priority).toBe('NORMAL');
      const row = s.status().layerFreshness;
      if (row.state !== 'ok') throw new Error('row');
      expect(row.topics[0]).toMatchObject({ topicKey: T, owned: true, h1: { stale: true, userTurnsBehind: 4 }, rebuildRequests: 3, lastRebuild: 'failed', notified: true });
      expect(row.checkedAt).toBe(now - TICK);
    });

    it('"nothing to rebuild from" (a run of acknowledgements the extractor rightly left alone) is counted and never pages', async () => {
      for (const outcome of ['awareness-behind', 'no-awareness', 'unavailable'] as LayerRebuildOutcome[]) {
        attention = [];
        SafeFsExecutor.safeRmSync(path.join(stateDir, 'state', 'context-budget'), { recursive: true, force: true, operation: OP });
        const requests: number[] = [];
        const s = make({ layers: { h1: () => ({ line: 'x', stale: true }), requestRebuild: () => { requests.push(now); return outcome; } } });
        for (let i = 0; i < 48; i++) { await s.tick(); advance(TICK); }
        expect(requests).toHaveLength(LAYER_REBUILD_MAX_PER_EPISODE);
        expect(attention).toEqual([]);
        const row = s.status().layerFreshness;
        if (row.state !== 'ok') throw new Error('row');
        expect(row.topics[0]).toMatchObject({ rebuildRequests: 3, lastRebuild: outcome, notified: false });
      }
    });

    it('the notice never lands in the tick of the request it would blame: a non-owner turned owner an hour into staleness', async () => {
      owns = 'unknown';
      const s = make({ layers: { h1: () => ({ line: 'x', stale: true }), requestRebuild: () => 'failed' } });
      for (let i = 0; i < 14; i++) { await s.tick(); advance(TICK); } // 65 minutes observed only
      expect(attention).toEqual([]);
      owns = true;
      await s.tick(); // first request
      expect(attention).toEqual([]);
      for (let t = TICK; t < LAYER_STALE_SUSTAINED_MS; t += TICK) { advance(TICK); await s.tick(); }
      expect(attention).toEqual([]); // an hour has not passed since the first request
      advance(TICK); await s.tick();
      expect(attention).toHaveLength(1);
    });

    it('a request that just re-projected defers the notice to a later tick', async () => {
      let n = 0;
      const s = make({ layers: { h1: () => ({ line: 'x', stale: true }), requestRebuild: () => { n++; return 'reprojected'; } } });
      for (let t = 0; t <= LAYER_STALE_SUSTAINED_MS; t += TICK) { await s.tick(); if (t < LAYER_STALE_SUSTAINED_MS) advance(TICK); }
      expect(n).toBe(3); // the third request ran at the one-hour mark and re-projected
      expect(attention).toEqual([]);
      advance(TICK); await s.tick();
      expect(attention).toHaveLength(1);
    });

    it('a corrupt episodes file never fails the tick (the heartbeat stays fresh); bad entries are dropped', async () => {
      const f = path.join(stateDir, 'state', 'context-budget', 'layer-stale-episodes.json');
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify({ [T]: 5, other: { since: 'x' } }));
      const s = make({ layers: { h1: () => ({ line: 'x', stale: true }), requestRebuild: () => 'failed' } });
      await s.tick();
      expect(s.status().lastError).toBeNull();
      expect(s.heartbeatFresh()).toBe(true);
      fs.writeFileSync(f, '{not json');
      advance(TICK); await s.tick();
      expect(s.heartbeatFresh()).toBe(true);
    });

    it('a session listing that throws fails the step loudly: lastError names it and the heartbeat is not refreshed', async () => {
      const s = make({ liveTopics: () => { throw new Error('session list unavailable'); }, layers: { h1: () => ({ line: 'x', stale: false }) } });
      await s.tick();
      expect(s.status().lastError).toMatch(/session list unavailable/);
      expect(s.heartbeatFresh()).toBe(false);
    });

    it('the notice waits for the sustained window: stale for less than an hour raises nothing', async () => {
      const s = make({ layers: { h1: () => ({ line: 'x', stale: true }), requestRebuild: () => 'failed' } });
      for (let t = 0; t < LAYER_STALE_SUSTAINED_MS - TICK; t += TICK) { await s.tick(); advance(TICK); }
      expect(attention).toEqual([]);
    });

    it('a fresh reading ends the episode; a later stale episode is a new episode (its own requests and notice)', async () => {
      let stale = true;
      const requests: number[] = [];
      const s = make({ layers: { h1: () => ({ line: 'x', stale }), requestRebuild: () => { requests.push(now); return 'reprojected'; } } });
      for (let i = 0; i < 14; i++) { await s.tick(); advance(TICK); }
      expect(attention).toHaveLength(1);
      stale = false; await s.tick(); advance(TICK);
      const row = s.status().layerFreshness;
      if (row.state !== 'ok') throw new Error('row');
      expect(row.topics[0]).toMatchObject({ staleSince: null, rebuildRequests: 0 });
      stale = true;
      for (let i = 0; i < 14; i++) { await s.tick(); advance(TICK); }
      expect(attention.filter((n) => n.id.startsWith('context-budget-layer-stale-'))).toHaveLength(2);
      expect(new Set(attention.map((n) => n.id)).size).toBe(2);
    });

    it('a non-owner observes only: no rebuild request, no notice, counted observedOnly', async () => {
      owns = 'unknown';
      const requests: string[] = [];
      const s = make({ layers: { h1: () => ({ line: 'x', stale: true }), requestRebuild: (t) => { requests.push(t); return 'reprojected'; } } });
      for (let i = 0; i < 30; i++) { await s.tick(); advance(TICK); }
      expect(requests).toEqual([]);
      expect(attention).toEqual([]);
      const row = s.status().layerFreshness;
      if (row.state !== 'ok') throw new Error('row');
      expect(row.counts).toMatchObject({ stale: 1, observedOnly: 1, rebuildRequests: 0 });
      expect(row.topics[0].owned).toBe('unknown');
    });

    it('without a rebuild seam each request is counted as unavailable (never a silent no-op)', async () => {
      const s = make({ layers: { h1: () => ({ line: 'x', stale: true }) } });
      await s.tick();
      const row = s.status().layerFreshness;
      if (row.state !== 'ok') throw new Error('row');
      expect(row.topics[0]).toMatchObject({ rebuildRequests: 1, lastRebuild: 'unavailable' });
    });

    it('the per-topic detail is bounded; the counts stay exact', async () => {
      live = Array.from({ length: STATUS_ROW_LIMIT + 7 }, (_, i) => String(1000 + i));
      const s = make({ layers: { h1: () => ({ line: 'x', stale: false }) } });
      await s.tick();
      const row = s.status().layerFreshness;
      if (row.state !== 'ok') throw new Error('row');
      expect(row.counts.topics).toBe(STATUS_ROW_LIMIT + 7);
      expect(row.topics).toHaveLength(STATUS_ROW_LIMIT);
      expect(row.truncated).toBe(7);
    });
  });

  // ── (b) hold health ────────────────────────────────────────────────────

  describe('hold health', () => {
    const holdFile = (topic: string) => path.join(stateDir, 'state', 'context-layers', topic, 'fold-hold.json');
    const begin = (): FoldRecord => { const b = fc.begin(T); if (!b.ok) throw new Error(b.reason); return b.record; };

    it('without carriers the row reads unavailable', async () => {
      const s = make();
      await s.tick();
      expect(s.status().holdHealth).toEqual({ state: 'unavailable', reason: 'no-carriers' });
    });

    it('an orphan hold (no record) past the grace period is cleared LOUDLY: file gone, degradation row, status', async () => {
      expect(holds.write(T, 'foldgone', now + 60_000)).toBe(true);
      advance(ORPHAN_GRACE_MS + 1);
      const s = make(withHolds());
      await s.tick();
      expect(fs.existsSync(holdFile(T))).toBe(false);
      expect(holds.check(T)).toEqual({ held: false });
      expect(degradations).toHaveLength(1);
      expect(degradations[0]).toMatchObject({ feature: 'ContextBudgetSentinel.holdHealth' });
      expect(degradations[0].fallback).toContain('foldgone');
      const row = s.status().holdHealth;
      if (row.state !== 'ok') throw new Error('row');
      expect(row.counts).toMatchObject({ carriers: 1, orphans: 1, cleared: 1, clearedTotal: 1 });
      expect(row.orphans[0]).toMatchObject({ kind: 'fold-hold', topicKey: T, foldId: 'foldgone', verdict: 'cleared', reason: 'no-record' });
      expect(row.recentClears[0]).toMatchObject({ kind: 'fold-hold', topicKey: T, foldId: 'foldgone' });
      expect(attention).toEqual([]); // a successful clear is a degradation row, not a page
    });

    it('a hold whose fold record is LIVE is never cleared, however old', async () => {
      const rec = begin();
      expect(holds.write(T, rec.foldId, now + 60_000)).toBe(true);
      const s = make(withHolds());
      for (let i = 0; i < 40; i++) { advance(TICK); await s.tick(); }
      expect(fs.existsSync(holdFile(T))).toBe(true);
      expect(degradations).toEqual([]);
      const row = s.status().holdHealth;
      if (row.state !== 'ok') throw new Error('row');
      expect(row.counts).toMatchObject({ carriers: 1, live: 1, orphans: 0, cleared: 0 });
    });

    it('an orphan inside the grace period is not cleared (and is cleared once past it)', async () => {
      expect(holds.write(T, 'foldgone', now + 60_000)).toBe(true);
      const s = make(withHolds());
      advance(ORPHAN_GRACE_MS - TICK); await s.tick();
      expect(fs.existsSync(holdFile(T))).toBe(true);
      const row = s.status().holdHealth;
      if (row.state !== 'ok') throw new Error('row');
      expect(row.orphans[0]).toMatchObject({ verdict: 'in-grace' });
      advance(TICK + 1); await s.tick();
      expect(fs.existsSync(holdFile(T))).toBe(false);
    });

    it('a hold left behind by a TERMINAL record is an orphan; the grace runs from the later of the hold and the record', async () => {
      const rec = begin();
      const t = fc.transition(T, rec.foldId, { state: rec.state, seq: rec.seq, generation: rec.generation }, 'aborted', { reason: 'test' });
      expect(t.ok).toBe(true);
      // A settle that crashed before releasing this carrier (re-written after the terminal transition).
      expect(holds.write(T, rec.foldId, now + 60_000)).toBe(true);
      const s = make(withHolds());
      advance(ORPHAN_GRACE_MS - TICK); await s.tick();
      expect(fs.existsSync(holdFile(T))).toBe(true);
      advance(TICK + 1); await s.tick();
      expect(fs.existsSync(holdFile(T))).toBe(false);
      expect(degradations[0].fallback).toContain('record-aborted');
    });

    it('a non-owner observes only: the orphan is reported, never cleared', async () => {
      owns = 'unknown';
      expect(holds.write(T, 'foldgone', now + 60_000)).toBe(true);
      advance(ORPHAN_GRACE_MS + 1);
      const s = make(withHolds());
      for (let i = 0; i < 5; i++) { await s.tick(); advance(TICK); }
      expect(fs.existsSync(holdFile(T))).toBe(true);
      expect(degradations).toEqual([]);
      const row = s.status().holdHealth;
      if (row.state !== 'ok') throw new Error('row');
      expect(row.orphans[0]).toMatchObject({ verdict: 'observe-only' });
      expect(row.orphans[0].reason).toContain('owner-unknown');
      expect(row.counts.observedOnly).toBe(1);
    });

    it('a torn record, a malformed hold and a torn marker are unknown: counted, never cleared', async () => {
      // Torn record for a hold.
      const dir = store.dirFor(T); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'foldtorn.json'), '{not json');
      expect(holds.write(T, 'foldtorn', now + 60_000)).toBe(true);
      // A malformed hold on another topic.
      fs.mkdirSync(path.dirname(holdFile('777')), { recursive: true });
      fs.writeFileSync(holdFile('777'), '{"schema":"nope"}');
      // A torn marker.
      fs.mkdirSync(foldMarkersDir(stateDir), { recursive: true });
      fs.writeFileSync(path.join(foldMarkersDir(stateDir), 'inst_x.json'), 'garbage');
      advance(ORPHAN_GRACE_MS * 4);
      const s = make(withHolds());
      await s.tick();
      expect(fs.existsSync(holdFile(T))).toBe(true);
      expect(fs.existsSync(holdFile('777'))).toBe(true);
      expect(fs.existsSync(path.join(foldMarkersDir(stateDir), 'inst_x.json'))).toBe(true);
      expect(degradations).toEqual([]);
      const row = s.status().holdHealth;
      if (row.state !== 'ok') throw new Error('row');
      expect(row.counts).toMatchObject({ unknown: 3, cleared: 0 });
      expect(row.orphans.map((o) => o.reason).join('|')).toMatch(/record-unreadable/);
    });

    it('a record directory that cannot be read is an unknown, never "absent": the hold is kept', async () => {
      expect(holds.write(T, 'foldx', now + 60_000)).toBe(true);
      const dir = store.dirFor(T); fs.mkdirSync(dir, { recursive: true });
      fs.chmodSync(dir, 0o000);
      try {
        expect(store.inspect(T, 'foldx')).toEqual({ kind: 'torn' });
        advance(ORPHAN_GRACE_MS * 2);
        await make(withHolds()).tick();
        expect(fs.existsSync(holdFile(T))).toBe(true);
        expect(degradations).toEqual([]);
      } finally { fs.chmodSync(dir, 0o700); }
      expect(store.inspect(T, 'foldx')).toEqual({ kind: 'absent' }); // the positive control: readable and missing is absent
    });

    it('an orphan fold MARKER is cleared loudly; a marker of a live fold is kept', async () => {
      const rec = begin();
      expect(writeFoldMarker(stateDir, { instarSessionId: 'inst_live', foldId: rec.foldId, topicKey: T, expiresAt: now + 60_000 }, now)).not.toBeNull();
      expect(writeFoldMarker(stateDir, { instarSessionId: 'inst_a', foldId: 'foldgone', topicKey: '555', expiresAt: now + 60_000 }, now)).not.toBeNull();
      expect(writeFoldMarker(stateDir, { instarSessionId: 'inst_b', foldId: 'foldgone', topicKey: '555', expiresAt: now + 60_000 }, now)).not.toBeNull();
      advance(ORPHAN_GRACE_MS + 1);
      const s = make(withHolds());
      await s.tick();
      expect(listFoldMarkers(stateDir).map((m) => m.instarSessionId)).toEqual(['inst_live']);
      expect(degradations).toHaveLength(1);
      expect(degradations[0].fallback).toContain('session marker');
    });

    it('corroboration: a record that comes back at ANY re-read between the scan and the release stops the clear', async () => {
      // Listing 1 is the scan; 2-5 are the gate's eligibility checks; 6 is clearOrphan's own re-read immediately before the release.
      let maxListings = 0;
      for (let at = 2; at <= 8; at++) {
        SafeFsExecutor.safeRmSync(path.join(stateDir, 'state', 'context-layers'), { recursive: true, force: true, operation: OP });
        ids = 0; degradations = [];
        expect(holds.write(T, 'fold1', now + 60_000)).toBe(true);
        const t0 = now; advance(ORPHAN_GRACE_MS + 1);
        let listings = 0;
        const racing: HoldCarrierSource[] = productionHoldCarriers({ stateDir, holds }).map((c) => c.kind !== 'fold-hold' ? c : {
          ...c,
          list: () => { listings++; if (listings === at) begin(); return c.list(); },
        });
        const s = make(withHolds({ carriers: racing }));
        await s.tick();
        maxListings = Math.max(maxListings, listings);
        if (at <= 6) {
          expect(store.get(T, 'fold1')?.state, `record back at listing ${at}`).toBe('locked');
          expect(fs.existsSync(holdFile(T)), `record back at listing ${at}`).toBe(true);
          expect(degradations, `record back at listing ${at}`).toEqual([]);
        }
        void t0;
      }
      // The positive control: with no race the same rig clears, after exactly 7 listings (6 + the post-release verification).
      SafeFsExecutor.safeRmSync(path.join(stateDir, 'state', 'context-layers'), { recursive: true, force: true, operation: OP });
      expect(holds.write(T, 'fold9', now + 60_000)).toBe(true);
      advance(ORPHAN_GRACE_MS + 1);
      let listings = 0;
      const counted: HoldCarrierSource[] = productionHoldCarriers({ stateDir, holds }).map((c) => c.kind !== 'fold-hold' ? c : { ...c, list: () => { listings++; return c.list(); } });
      await make(withHolds({ carriers: counted })).tick();
      expect(fs.existsSync(holdFile(T))).toBe(false);
      expect(listings).toBe(7);
      expect(maxListings).toBeGreaterThanOrEqual(6);
    });

    it('a different fold\'s hold replacing the file before the release is never removed', async () => {
      expect(holds.write(T, 'fold1', now + 60_000)).toBe(true);
      advance(ORPHAN_GRACE_MS + 1);
      let listings = 0;
      const racing: HoldCarrierSource[] = productionHoldCarriers({ stateDir, holds }).map((c) => c.kind !== 'fold-hold' ? c : {
        ...c,
        list: () => { listings++; if (listings === 6) holds.write(T, 'fold2', now + 60_000); return c.list(); },
      });
      await make(withHolds({ carriers: racing })).tick();
      expect(JSON.parse(fs.readFileSync(holdFile(T), 'utf-8')).foldId).toBe('fold2');
      expect(degradations).toEqual([]);
    });

    it('a release that never takes exhausts its ladder with exactly ONE notice, and stops trying', async () => {
      expect(holds.write(T, 'foldgone', now + 60_000)).toBe(true);
      advance(ORPHAN_GRACE_MS + 1);
      let releases = 0;
      const stuck: HoldCarrierSource[] = productionHoldCarriers({ stateDir, holds }).map((c) => c.kind !== 'fold-hold' ? c : { ...c, release: () => { releases++; } });
      const s = make(withHolds({ carriers: stuck }));
      for (let i = 0; i < 60; i++) { await s.tick(); advance(TICK); }
      expect(releases).toBe(3);
      const pages = attention.filter((n) => n.id.startsWith('context-budget-orphan-'));
      expect(pages).toHaveLength(1);
      expect(pages[0].title).toContain('could not be cleared');
      expect(degradations).toEqual([]);
    });
  });

  // ── (c) eligible topic without a fold ──────────────────────────────────

  describe('eligible topic without a fold', () => {
    it('without a session source the row reads unavailable', async () => {
      const s = make({ liveTopics: undefined });
      await s.tick();
      expect(s.status().eligibleWithoutFold).toEqual({ state: 'unavailable', reason: 'no-session-source' });
    });

    it('reads unknown (no benefit estimator), is counted, and NEVER acts: no fold, no notice, no degradation', async () => {
      live = [T, '999'];
      // Topic T folded recently; 999 never.
      const b = fc.begin(T); if (!b.ok) throw new Error(b.reason);
      fc.transition(T, b.record.foldId, { state: b.record.state, seq: b.record.seq, generation: b.record.generation }, 'aborted', { reason: 't' });
      const before = JSON.stringify(store.topics().map((t) => store.list(t)));
      const s = make(withHolds());
      for (let i = 0; i < 12; i++) { await s.tick(); advance(TICK); }
      const row = s.status().eligibleWithoutFold;
      if (row.state !== 'ok') throw new Error('row');
      expect(row.counts).toEqual({ topics: 2, unknown: 1, foldedRecently: 1 });
      expect(row.topics.find((r) => r.topicKey === '999')).toMatchObject({ verdict: 'unknown', lastFoldAt: null });
      expect(row.topics.find((r) => r.topicKey === '999')!.reason).toMatch(/^no-benefit-estimator/);
      expect(row.topics.find((r) => r.topicKey === T)).toMatchObject({ verdict: 'folded-recently' });
      expect(JSON.stringify(store.topics().map((t) => store.list(t)))).toBe(before);
      expect(attention).toEqual([]);
      expect(degradations).toEqual([]);
      // A day later the folded topic reads unknown too.
      advance(24 * 60 * 60_000); await s.tick();
      const later = s.status().eligibleWithoutFold;
      if (later.state !== 'ok') throw new Error('row');
      expect(later.counts).toEqual({ topics: 2, unknown: 2, foldedRecently: 0 });
    });
  });
});

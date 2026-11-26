// safe-fs-allow: test fixture teardown uses SafeFsExecutor.safeRmSync on tmp dirs only.
/**
 * Unit — the additive substrate changes the writer-agnostic reconciler relies on
 * (docs/specs/statesync-writer-agnostic-reconciler.md §2, "Unit (substrate)"):
 *
 *   - CoherenceJournal.emitReplicatedRecord returns a JournalEmitOutcome per branch.
 *   - ReplicatedRecordEmitter.emit returns {outcome, hlc}: `emitted` only on
 *     `accepted`, `unconfirmed` for a void journal seam, observers only on emitted,
 *     `opts.observed` (incl. null) replaces the witness read.
 *   - ReplicatedPeerStreamReader.loadOwnOriginRecordsAsync == the own half of
 *     materialize (incl. lastPutFields).
 *   - UnionReader collapses a concurrent set of byte-identical versions (2 and 3
 *     origins, a delayed third, HIGH and LOW tier) and still flags a differing one.
 *   - ConflictStore.autoResolveIdenticalContent + ReplicatedStoreReader closing an
 *     already-open identical conflict on read.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CoherenceJournal } from '../../src/core/CoherenceJournal.js';
import { JournalSyncApplier } from '../../src/core/JournalSyncApplier.js';
import { ReplicatedPeerStreamReader } from '../../src/core/ReplicatedPeerStreamReader.js';
import { ReplicatedRecordEmitter } from '../../src/core/ReplicatedRecordEmitter.js';
import { ReplicatedStoreReader } from '../../src/core/ReplicatedStoreReader.js';
import { ReplicatedKindRegistry, type StoreFieldSchema } from '../../src/core/ReplicatedRecordEnvelope.js';
import { ConflictStore } from '../../src/core/ConflictStore.js';
import { DroppedOriginRegistry } from '../../src/core/RollbackUnmerge.js';
import { HybridLogicalClock, serializeHlcKey, type HlcTimestamp } from '../../src/core/HybridLogicalClock.js';
import { classifyOriginSet, conflictId, readUnion, type OriginRecord } from '../../src/core/UnionReader.js';
import {
  KNOWLEDGE_KIND_REGISTRATION,
  KNOWLEDGE_RECORD_KIND,
  KNOWLEDGE_STORE_KEY,
  buildKnowledgeRecordData,
  buildKnowledgeTombstoneFromKey,
  deriveKnowledgeRecordKey,
} from '../../src/core/KnowledgeReplicatedStore.js';
import type { KnowledgeSource } from '../../src/knowledge/KnowledgeManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const SELF = 'm_self';
const PEER = 'm_peer';

function hlc(p: number, l: number, n: string): HlcTimestamp {
  return { physical: p, logical: l, node: n };
}

function src(title: string, extra: Partial<KnowledgeSource> = {}): KnowledgeSource {
  return {
    id: `id-${title}`, title, url: `https://example.com/${title}`, type: 'article',
    ingestedAt: '2026-10-01T00:00:00.000Z', filePath: `${title}.md`, tags: [], summary: '', wordCount: 1, ...extra,
  };
}

function knowledgeRegistry(): ReplicatedKindRegistry {
  const r = new ReplicatedKindRegistry();
  r.register(KNOWLEDGE_KIND_REGISTRATION);
  return r;
}

const dirs: string[] = [];
function tmp(label: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `reconcile-substrate-${label}-`));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) {
    SafeFsExecutor.safeRmSync(dirs.pop()!, { recursive: true, force: true, operation: 'tests/unit/replicated-store-reconciler-substrate.test.ts' });
  }
});

function knowledgeData(s: KnowledgeSource, h: HlcTimestamp, origin = SELF): Record<string, unknown> {
  return buildKnowledgeRecordData({ record: s, hlc: h, origin })! as unknown as Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('CoherenceJournal.emitReplicatedRecord outcomes', () => {
  const journals: CoherenceJournal[] = [];
  afterEach(() => { while (journals.length) { try { journals.pop()!.close(); } catch { /* */ } } });

  function journal(opts: { open?: boolean; registry?: ReplicatedKindRegistry | null; rateCap?: { capacity: number; refillPerSec: number } } = {}): CoherenceJournal {
    const j = new CoherenceJournal({ stateDir: tmp('j'), machineId: SELF, flushIntervalMs: 1_000_000, ...(opts.rateCap ? { rateCap: opts.rateCap } : {}) });
    journals.push(j);
    if (opts.open !== false) j.open();
    if (opts.registry !== null) j.setReplicatedKindRegistry(opts.registry ?? knowledgeRegistry());
    return j;
  }

  it('accepted, then deduped for the same op key', () => {
    const j = journal();
    const data = knowledgeData(src('a'), hlc(10, 0, SELF));
    expect(j.emitReplicatedRecord('knowledge-record', data)).toBe('accepted');
    expect(j.emitReplicatedRecord('knowledge-record', data)).toBe('deduped');
  });

  it('not-replicated-kind when the kind is not registered', () => {
    const j = journal({ registry: null });
    expect(j.emitReplicatedRecord('knowledge-record', knowledgeData(src('a'), hlc(10, 0, SELF)))).toBe('not-replicated-kind');
  });

  it('locked-out before open and after close', () => {
    const j = journal({ open: false });
    expect(j.emitReplicatedRecord('knowledge-record', knowledgeData(src('a'), hlc(10, 0, SELF)))).toBe('locked-out');
    const j2 = journal();
    j2.close();
    expect(j2.emitReplicatedRecord('knowledge-record', knowledgeData(src('a'), hlc(11, 0, SELF)))).toBe('locked-out');
  });

  it('rate-limited past the token bucket', () => {
    const j = journal({ rateCap: { capacity: 1, refillPerSec: 0 } });
    expect(j.emitReplicatedRecord('knowledge-record', knowledgeData(src('a'), hlc(10, 0, SELF)))).toBe('accepted');
    expect(j.emitReplicatedRecord('knowledge-record', knowledgeData(src('b'), hlc(11, 0, SELF)))).toBe('rate-limited');
  });

  it('schema-rejected for an envelope that does not validate', () => {
    const j = journal();
    const bad = { ...knowledgeData(src('a'), hlc(10, 0, SELF)), op: 'mutate' };
    expect(j.emitReplicatedRecord('knowledge-record', bad)).toBe('schema-rejected');
  });

  it('oversize for a record over the 80 KB replicated-record cap', () => {
    const passSchema: StoreFieldSchema = { knownFields: ['v'], validate: (raw) => ({ v: (raw as { v?: unknown }).v }) };
    const reg = new ReplicatedKindRegistry();
    reg.register({ kind: 'pref-record', store: 'pref', schema: passSchema });
    const j = journal({ registry: reg });
    const data = { recordKey: 'k1', hlc: hlc(10, 0, SELF), op: 'put', origin: SELF, v: 'x'.repeat(90 * 1024) };
    expect(j.emitReplicatedRecord('pref-record', data)).toBe('oversize');
  });

  it('error when an internal fault is swallowed', () => {
    const j = journal({ registry: null });
    j.setReplicatedKindRegistry({ isReplicatedKind: () => { throw new Error('boom'); } } as never);
    expect(j.emitReplicatedRecord('knowledge-record', knowledgeData(src('a'), hlc(10, 0, SELF)))).toBe('error');
  });
});

describe('ReplicatedRecordEmitter outcomes, observers and observed override', () => {
  function emitter(journalReturn: () => unknown, opts: { witness?: () => HlcTimestamp | undefined; enabled?: boolean } = {}) {
    const appended: Record<string, unknown>[] = [];
    let witnessReads = 0;
    const clock = new HybridLogicalClock({ node: SELF, now: () => 1_000 });
    const e = new ReplicatedRecordEmitter({
      journal: { emitReplicatedRecord: (_k, d) => { appended.push(d); return journalReturn() as never; } },
      clock,
      registry: knowledgeRegistry(),
      origin: SELF,
      stores: () => ({ knowledge: { enabled: opts.enabled ?? true } }),
      loadWitness: () => { witnessReads++; return opts.witness?.(); },
    });
    const events: unknown[] = [];
    e.addEmitObserver((ev) => events.push(ev));
    return { e, appended, events, witnessReads: () => witnessReads, clock };
  }
  const s = src('a');
  const key = deriveKnowledgeRecordKey(s.title, s.url, s.type)!;
  const build = (h: HlcTimestamp, o: string, obs?: HlcTimestamp) => buildKnowledgeRecordData({ record: s, hlc: h, origin: o, observed: obs });

  it('returns emitted with the ticked hlc only on accepted, and fires observers with the exact data', () => {
    const t = emitter(() => 'accepted');
    const r = t.e.emit(KNOWLEDGE_STORE_KEY, key, build);
    expect(r.outcome).toBe('emitted');
    expect(r.hlc).toEqual(t.appended[0].hlc);
    expect(t.events).toEqual([{ store: KNOWLEDGE_STORE_KEY, recordKey: key, op: 'put', hlc: r.hlc, data: t.appended[0] }]);
  });

  it('a void journal seam yields `unconfirmed` and fires no observer', () => {
    const t = emitter(() => undefined);
    const r = t.e.emit(KNOWLEDGE_STORE_KEY, key, build);
    expect(r.outcome).toBe('unconfirmed');
    expect(r.hlc).toBeDefined();
    expect(t.events).toHaveLength(0);
  });

  it.each(['rate-limited', 'locked-out', 'schema-rejected', 'deduped', 'oversize', 'error'])('journal %s ⇒ dropped:%s, no observer', (o) => {
    const t = emitter(() => o);
    const r = t.e.emit(KNOWLEDGE_STORE_KEY, key, build);
    expect(r.outcome).toBe(`dropped:${o}`);
    expect(t.events).toHaveLength(0);
    expect(t.e.getStats().dropped).toBe(1);
  });

  it('disabled / skipped / builder-throw outcomes', () => {
    expect(emitter(() => 'accepted', { enabled: false }).e.emit(KNOWLEDGE_STORE_KEY, key, build).outcome).toBe('disabled');
    expect(emitter(() => 'accepted').e.emit(KNOWLEDGE_STORE_KEY, null, build).outcome).toBe('skipped');
    const thrown = emitter(() => 'accepted').e.emit(KNOWLEDGE_STORE_KEY, key, () => { throw new Error('over cap'); });
    expect(thrown.outcome).toBe('error');
    expect(thrown.hlc).toBeDefined();
  });

  it('a delete emit reports op:delete to observers', () => {
    const t = emitter(() => 'accepted');
    t.e.emit(KNOWLEDGE_STORE_KEY, key, (h, o, obs) => buildKnowledgeTombstoneFromKey({ recordKey: key, deletedAt: '2026-10-02T00:00:00.000Z', hlc: h, origin: o, observed: obs }));
    expect((t.events[0] as { op: string }).op).toBe('delete');
  });

  it('an observer that throws is counted and never fails the emit; unsubscribe works', () => {
    const t = emitter(() => 'accepted');
    const off = t.e.addEmitObserver(() => { throw new Error('observer bug'); });
    expect(t.e.emit(KNOWLEDGE_STORE_KEY, key, build).outcome).toBe('emitted');
    expect(t.e.getStats().observerErrors).toBe(1);
    off();
    t.e.emit(KNOWLEDGE_STORE_KEY, deriveKnowledgeRecordKey('b', null, 'doc')!, build);
    expect(t.e.getStats().observerErrors).toBe(1);
  });

  it('opts.observed:null carries no witness and does not read it', () => {
    const t = emitter(() => 'accepted', { witness: () => hlc(5, 0, PEER) });
    t.e.emit(KNOWLEDGE_STORE_KEY, key, build, { observed: null });
    expect(t.witnessReads()).toBe(0);
    expect(t.appended[0].observed).toBeUndefined();
  });

  it('opts.observed replaces the witness read with exactly that value', () => {
    const t = emitter(() => 'accepted', { witness: () => hlc(5, 0, PEER) });
    t.e.emit(KNOWLEDGE_STORE_KEY, key, build, { observed: hlc(7, 1, PEER) });
    expect(t.witnessReads()).toBe(0);
    expect(t.appended[0].observed).toEqual(hlc(7, 1, PEER));
  });

  it('with no opts the witness is read as before', () => {
    const t = emitter(() => 'accepted', { witness: () => hlc(5, 0, PEER) });
    t.e.emit(KNOWLEDGE_STORE_KEY, key, build);
    expect(t.witnessReads()).toBe(1);
    expect(t.appended[0].observed).toEqual(hlc(5, 0, PEER));
  });

  it('exposes its clock (the instance the reconciler fences against)', () => {
    const t = emitter(() => 'accepted');
    expect(t.e.clock).toBe(t.clock);
  });
});

describe('ReplicatedPeerStreamReader.loadOwnOriginRecordsAsync', () => {
  it('equals the own-origin half of materialize (incl. lastPutFields), and never reads peer files', async () => {
    const dirA = tmp('a');
    const dirB = tmp('b');
    const registry = knowledgeRegistry();
    const ja = new CoherenceJournal({ stateDir: dirA, machineId: SELF, flushIntervalMs: 1_000_000 });
    ja.open(); ja.setReplicatedKindRegistry(registry);
    const jb = new CoherenceJournal({ stateDir: dirB, machineId: PEER, flushIntervalMs: 1_000_000 });
    jb.open(); jb.setReplicatedKindRegistry(registry);
    try {
      const keep = src('keep');
      const edited = src('edited');
      const gone = src('gone');
      const k = (s: KnowledgeSource) => deriveKnowledgeRecordKey(s.title, s.url, s.type)!;
      ja.emitReplicatedRecord('knowledge-record', knowledgeData(keep, hlc(10, 0, SELF)));
      ja.emitReplicatedRecord('knowledge-record', knowledgeData(edited, hlc(11, 0, SELF)));
      ja.emitReplicatedRecord('knowledge-record', knowledgeData({ ...edited, summary: 'v2' }, hlc(12, 0, SELF)));
      ja.emitReplicatedRecord('knowledge-record', knowledgeData(gone, hlc(13, 0, SELF)));
      ja.emitReplicatedRecord('knowledge-record', buildKnowledgeTombstoneFromKey({ recordKey: k(gone), deletedAt: '2026-10-02T00:00:00.000Z', hlc: hlc(14, 0, SELF), origin: SELF }) as unknown as Record<string, unknown>);
      ja.flush();
      // A peer record for a key A also holds, plus a peer-only key.
      jb.emitReplicatedRecord('knowledge-record', knowledgeData(keep, hlc(20, 0, PEER), PEER));
      jb.emitReplicatedRecord('knowledge-record', knowledgeData(src('peer-only'), hlc(21, 0, PEER), PEER));
      jb.flush();
      const servedFrom = new JournalSyncApplier({ stateDir: dirB, replicatedRegistry: registry });
      const batch = servedFrom.buildServeBatch(KNOWLEDGE_RECORD_KIND, 0, PEER);
      new JournalSyncApplier({ stateDir: dirA, replicatedRegistry: registry }).apply(PEER, [batch]);

      const reader = new ReplicatedPeerStreamReader({ stateDir: dirA, registry, selfMachineId: SELF });
      const own = await reader.loadOwnOriginRecordsAsync(KNOWLEDGE_STORE_KEY);

      // The own half of materialize, via the public per-key surface.
      const expected = new Map<string, OriginRecord>();
      for (const key of reader.listRecordKeys(KNOWLEDGE_STORE_KEY)) {
        for (const r of reader.loadOriginRecords(KNOWLEDGE_STORE_KEY, key)) if (r.origin === SELF) expected.set(key, r);
      }
      expect(reader.listRecordKeys(KNOWLEDGE_STORE_KEY)).toContain(k(src('peer-only'))); // peer applied
      expect([...own.keys()].sort()).toEqual([...expected.keys()].sort());
      for (const [key, r] of expected) {
        const o = own.get(key)!;
        expect(o.op).toBe(r.envelope.op);
        expect(o.hlc).toEqual(r.envelope.hlc);
        expect(o.storeFields).toEqual(r.data);
      }
      expect(own.has(k(src('peer-only')))).toBe(false);
      expect(own.get(k(edited))!.storeFields.summary).toBe('v2');
      const del = own.get(k(gone))!;
      expect(del.op).toBe('delete');
      expect(del.lastPutFields!.title).toBe('gone');
      expect(own.get(k(keep))!.lastPutFields).toBeUndefined();
    } finally {
      ja.close(); jb.close();
    }
  });

  it('lastPutFields holds the newest put store fields of a deleted key; a delete with no readable put has none', async () => {
    const dir = tmp('lp');
    const registry = knowledgeRegistry();
    const j = new CoherenceJournal({ stateDir: dir, machineId: SELF, flushIntervalMs: 1_000_000 });
    j.open(); j.setReplicatedKindRegistry(registry);
    try {
      const g = src('gone');
      const k = deriveKnowledgeRecordKey(g.title, g.url, g.type)!;
      j.emitReplicatedRecord('knowledge-record', knowledgeData(g, hlc(10, 0, SELF)));
      j.emitReplicatedRecord('knowledge-record', knowledgeData({ ...g, summary: 'last' }, hlc(11, 0, SELF)));
      j.emitReplicatedRecord('knowledge-record', buildKnowledgeTombstoneFromKey({ recordKey: k, deletedAt: '2026-10-02T00:00:00.000Z', hlc: hlc(12, 0, SELF), origin: SELF }) as unknown as Record<string, unknown>);
      j.emitReplicatedRecord('knowledge-record', buildKnowledgeTombstoneFromKey({ recordKey: 'never-put', deletedAt: '2026-10-02T00:00:00.000Z', hlc: hlc(13, 0, SELF), origin: SELF }) as unknown as Record<string, unknown>);
      j.flush();
      const own = await new ReplicatedPeerStreamReader({ stateDir: dir, registry, selfMachineId: SELF }).loadOwnOriginRecordsAsync(KNOWLEDGE_STORE_KEY);
      expect(own.get(k)!.op).toBe('delete');
      expect(own.get(k)!.lastPutFields!.summary).toBe('last');
      expect(own.get(k)!.lastPutFields!.title).toBe('gone');
      expect(own.get('never-put')!.op).toBe('delete');
      expect(own.get('never-put')!.lastPutFields).toBeUndefined();
      expect((await new ReplicatedPeerStreamReader({ stateDir: dir, registry, selfMachineId: SELF }).loadOwnOriginRecordsAsync('unregistered')).size).toBe(0);
    } finally {
      j.close();
    }
  });
});

describe('UnionReader identical-content collapse', () => {
  const DATA = { title: 'same', n: 1 };
  function rec(origin: string, h: HlcTimestamp, data: Record<string, unknown> = DATA, op: 'put' | 'delete' = 'put'): OriginRecord {
    return { origin, envelope: { recordKey: 'k', hlc: h, op, origin }, data };
  }

  for (const tier of ['high', 'low'] as const) {
    it(`[${tier}] two concurrent identical puts collapse to the HLC-max with no conflict and no divergence`, () => {
      const set = [rec('A', hlc(100, 0, 'A')), rec('B', hlc(200, 0, 'B'), { n: 1, title: 'same' })]; // key order differs
      const v = classifyOriginSet(set);
      expect(v.concurrent).toBe(false);
      const u = readUnion('k', set, tier);
      expect(u.conflict).toBeNull();
      expect(u.divergenceFlag).toBe(false);
      expect(u.value!.origin).toBe('B');
      expect(u.collapsedIdentical!.conflictId).toBe(conflictId('k', [hlc(100, 0, 'A'), hlc(200, 0, 'B')]));
      expect(u.collapsedIdentical!.versions).toEqual([
        { origin: 'A', hlcKey: serializeHlcKey(hlc(100, 0, 'A')) },
        { origin: 'B', hlcKey: serializeHlcKey(hlc(200, 0, 'B')) },
      ]);
    });

    it(`[${tier}] three identical origins, including a delayed third, still collapse`, () => {
      const two = [rec('A', hlc(100, 0, 'A')), rec('B', hlc(200, 0, 'B'))];
      expect(readUnion('k', two, tier).collapsedIdentical).toBeDefined();
      const three = [...two, rec('C', hlc(900, 0, 'C'))];
      const u = readUnion('k', three, tier);
      expect(u.conflict).toBeNull();
      expect(u.divergenceFlag).toBe(false);
      expect(u.value!.origin).toBe('C');
      expect(u.collapsedIdentical!.versions).toHaveLength(3);
    });

    it(`[${tier}] a set with ONE differing version still flags`, () => {
      const set = [rec('A', hlc(100, 0, 'A')), rec('B', hlc(200, 0, 'B')), rec('C', hlc(300, 0, 'C'), { title: 'different', n: 1 })];
      const u = readUnion('k', set, tier);
      expect(u.collapsedIdentical).toBeUndefined();
      if (tier === 'high') {
        expect(u.value).toBeNull();
        expect(u.conflict!.versions).toHaveLength(3);
      } else {
        expect(u.divergenceFlag).toBe(true);
      }
      // A delayed differing third breaks an identical pair.
      const delayed = [rec('A', hlc(100, 0, 'A')), rec('B', hlc(200, 0, 'B')), rec('C', hlc(50, 0, 'C'), { title: 'x', n: 2 })];
      expect(classifyOriginSet(delayed).concurrent).toBe(true);
    });

    it(`[${tier}] identical tombstones collapse; a put vs a delete with the same fields does not`, () => {
      const tomb = { deletedAt: '2026-10-02T00:00:00.000Z' };
      const u = readUnion('k', [rec('A', hlc(100, 0, 'A'), tomb, 'delete'), rec('B', hlc(200, 0, 'B'), tomb, 'delete')], tier);
      expect(u.collapsedIdentical).toBeDefined();
      expect(u.value).toBeNull();
      expect(u.conflict).toBeNull();
      expect(classifyOriginSet([rec('A', hlc(100, 0, 'A'), tomb, 'put'), rec('B', hlc(200, 0, 'B'), tomb, 'delete')]).concurrent).toBe(true);
    });
  }

  it('a sequential (witnessed) set never reports collapsedIdentical', () => {
    const a = rec('A', hlc(100, 0, 'A'));
    const b: OriginRecord = { origin: 'B', envelope: { recordKey: 'k', hlc: hlc(200, 0, 'B'), op: 'put', origin: 'B', observed: hlc(100, 0, 'A') }, data: DATA };
    expect(readUnion('k', [a, b], 'high').collapsedIdentical).toBeUndefined();
  });
});

describe('ConflictStore.autoResolveIdenticalContent', () => {
  let dir: string;
  beforeEach(() => { dir = tmp('cs'); });

  function versions(origins: Array<[string, number]>): OriginRecord[] {
    return origins.map(([o, p]) => ({ origin: o, envelope: { recordKey: 'k', hlc: hlc(p, 0, o), op: 'put', origin: o }, data: { v: 1 } }));
  }

  it('closes only on an exact version-set match, with resolution identical-content and no winner', () => {
    const cs = new ConflictStore({ stateDir: dir, now: () => new Date('2026-10-28T00:00:00.000Z') });
    const vs = versions([['A', 100], ['B', 200]]);
    const id = conflictId('k', vs.map((v) => v.envelope.hlc));
    cs.recordConflict('knowledge', { conflictId: id, recordKey: 'k', versions: vs });
    const keyed = vs.map((v) => ({ origin: v.origin, hlcKey: serializeHlcKey(v.envelope.hlc) }));

    expect(cs.autoResolveIdenticalContent(id, keyed.slice(0, 1))).toBe(false); // subset
    expect(cs.autoResolveIdenticalContent(id, [...keyed, { origin: 'C', hlcKey: serializeHlcKey(hlc(300, 0, 'C')) }])).toBe(false); // superset
    expect(cs.autoResolveIdenticalContent(id, [keyed[0], { origin: 'B', hlcKey: serializeHlcKey(hlc(201, 0, 'B')) }])).toBe(false); // other version
    expect(cs.getConflict(id)!.resolved).toBe(false);

    expect(cs.autoResolveIdenticalContent(id, [...keyed].reverse())).toBe(true);
    const e = cs.getConflict(id)!;
    expect(e.resolved).toBe(true);
    expect(e.resolution).toBe('identical-content');
    expect(e.winnerOrigin).toBeUndefined();
    expect(cs.listOpen()).toHaveLength(0);
    // Already resolved / unknown ⇒ false.
    expect(cs.autoResolveIdenticalContent(id, keyed)).toBe(false);
    expect(cs.autoResolveIdenticalContent('nope', keyed)).toBe(false);
    // Persisted.
    expect(new ConflictStore({ stateDir: dir, now: () => new Date() }).getConflict(id)!.resolution).toBe('identical-content');
  });

  it('never touches an operator-resolved entry', () => {
    const cs = new ConflictStore({ stateDir: dir, now: () => new Date() });
    const vs = versions([['A', 100], ['B', 200]]);
    const id = conflictId('k', vs.map((v) => v.envelope.hlc));
    cs.recordConflict('knowledge', { conflictId: id, recordKey: 'k', versions: vs });
    cs.resolveConflict(id, { winnerOrigin: 'A' } as never);
    const before = cs.getConflict(id)!.resolution;
    expect(cs.autoResolveIdenticalContent(id, vs.map((v) => ({ origin: v.origin, hlcKey: serializeHlcKey(v.envelope.hlc) })))).toBe(false);
    expect(cs.getConflict(id)!.resolution).toBe(before);
  });
});

describe('ReplicatedStoreReader closes an already-open identical conflict on read', () => {
  it('resolves the legacy identical entry; a differing set still records a conflict', () => {
    const dir = tmp('rsr');
    const passSchema: StoreFieldSchema = { knownFields: ['v'], validate: (raw) => ({ v: (raw as { v?: unknown }).v }) };
    const registry = new ReplicatedKindRegistry();
    registry.register({ kind: 'pref-record', store: 'pref', schema: passSchema });
    const conflictStore = new ConflictStore({ stateDir: dir, now: () => new Date() });
    let records: OriginRecord[] = [
      { origin: 'A', envelope: { recordKey: 'k', hlc: hlc(100, 0, 'A'), op: 'put', origin: 'A' }, data: { v: 'same' } },
      { origin: 'B', envelope: { recordKey: 'k', hlc: hlc(200, 0, 'B'), op: 'put', origin: 'B' }, data: { v: 'same' } },
    ];
    // The ledger entry an older build recorded for this identical set.
    const id = conflictId('k', records.map((r) => r.envelope.hlc));
    conflictStore.recordConflict('pref', { conflictId: id, recordKey: 'k', versions: records });
    expect(conflictStore.listOpen()).toHaveLength(1);

    const reader = new ReplicatedStoreReader({
      registry,
      stores: { pref: { enabled: true } },
      tierOf: () => 'high',
      loadOriginRecords: () => records,
      listRecordKeys: () => ['k'],
      droppedOrigins: new DroppedOriginRegistry({ stateDir: dir }),
      conflictStore,
    });
    const u = reader.read('pref', 'k');
    expect(u.value!.data).toEqual({ v: 'same' });
    expect(conflictStore.getConflict(id)!.resolution).toBe('identical-content');
    expect(conflictStore.listOpen()).toHaveLength(0);

    // A later, differing edit from B (a new version, so a new conflict id).
    records = [records[0], { origin: 'B', envelope: { recordKey: 'k', hlc: hlc(300, 0, 'B'), op: 'put', origin: 'B' }, data: { v: 'different' } }];
    const u2 = reader.read('pref', 'k');
    expect(u2.conflict).not.toBeNull();
    expect(conflictStore.listOpen()).toHaveLength(1);
  });
});

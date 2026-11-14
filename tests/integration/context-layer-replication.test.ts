// safe-fs-allow: test fixture teardown uses SafeFsExecutor.safeRmSync on tmp dirs only.
/**
 * Integration (Tier 2 — replication path) — the context layer kind
 * (context-budget-layered-summaries §14): records round-trip through the REAL
 * CoherenceJournal (emit → schema-validate → append → read), cross-apply to a
 * second machine through the REAL JournalSyncApplier, an oversize content
 * record never lands on either side, and a 60 KB H3 (the per-kind raise) does.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CoherenceJournal, sanitizeMachineId } from '../../src/core/CoherenceJournal.js';
import { JournalSyncApplier } from '../../src/core/JournalSyncApplier.js';
import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import { ReplicatedPeerStreamReader } from '../../src/core/ReplicatedPeerStreamReader.js';
import { CONTEXT_LAYER_KIND_REGISTRATION, CONTEXT_LAYER_RECORD_KIND, CONTEXT_LAYER_STORE_KEY, buildContextLayerPut } from '../../src/monitoring/contextLayerKind.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/integration/context-layer-replication.test.ts';
const hlc = (physical: number, node: string) => ({ physical, logical: 0, node });
const T = '141133';

describe('context layer kind — journal round-trip and cross-machine apply', () => {
  let root: string;
  let reg: ReplicatedKindRegistry;
  const machines: Array<{ id: string; dir: string; journal: CoherenceJournal }> = [];
  const make = (id: string) => {
    const dir = path.join(root, id);
    fs.mkdirSync(path.join(dir, 'state', 'sessions'), { recursive: true });
    const journal = new CoherenceJournal({ stateDir: dir, machineId: id, flushIntervalMs: 1_000_000 });
    journal.open();
    journal.setReplicatedKindRegistry(reg);
    const m = { id, dir, journal };
    machines.push(m);
    return m;
  };
  const put = (input: Parameters<typeof buildContextLayerPut>[0], at: number, origin: string) => {
    const r = buildContextLayerPut(input);
    if (!r.ok) throw new Error(r.reason);
    return r.build(hlc(at, origin), origin);
  };
  const lines = (dir: string, origin: string) => {
    const f = path.join(dir, 'state', 'coherence-journal', `${sanitizeMachineId(origin)}.${CONTEXT_LAYER_RECORD_KIND}.jsonl`);
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).data as Record<string, unknown>) : [];
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-layer-repl-'));
    reg = new ReplicatedKindRegistry();
    reg.register(CONTEXT_LAYER_KIND_REGISTRATION);
    machines.length = 0;
  });
  afterEach(() => {
    for (const m of machines) { try { m.journal.close(); } catch { /* best-effort */ } }
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: OP });
  });

  it('every record type lands, a fat H3 lands, and B holds the same records after applying A\'s stream', () => {
    const A = make('m_a'); const B = make('m_b');
    const recs = [
      put({ recordType: 'anchor', topicKey: T, entryKey: 'a', body: 'goal: ship phase 0' }, 100, A.id),
      put({ recordType: 'ledger-entry', topicKey: T, entryKey: 'g1', body: 'decided: Opus builds', status: 'live' }, 110, A.id),
      put({ recordType: 'chunk', topicKey: T, entryKey: 'c1', body: 'chunk body' }, 120, A.id),
      put({ recordType: 'h3', topicKey: T, entryKey: 'h3', body: 'h'.repeat(60 * 1024) }, 130, A.id),
      put({ recordType: 'fold-sidecar', topicKey: T, entryKey: 'f1-ids', foldId: 'f1', body: JSON.stringify(['r1', 'r2']) }, 140, A.id),
      put({ recordType: 'fold-record', topicKey: T, entryKey: 'f1', foldId: 'f1', state: 'committed', seq: 7, generation: 1 }, 150, A.id),
      put({ recordType: 'fold-hold', topicKey: T, entryKey: 'f1-hold', foldId: 'f1', status: 'released' }, 160, A.id),
    ];
    for (const r of recs) expect(A.journal.emitReplicatedRecord(CONTEXT_LAYER_RECORD_KIND, r)).toBe('accepted');
    A.journal.flush();
    const onA = lines(A.dir, A.id);
    expect(onA.map((d) => d.recordType)).toEqual(['anchor', 'ledger-entry', 'chunk', 'h3', 'fold-sidecar', 'fold-record', 'fold-hold']);
    expect((onA[3].body as string).length).toBe(60 * 1024);

    const entries = A.journal.readTail(CONTEXT_LAYER_RECORD_KIND, 10_000).entries.sort((x, y) => x.seq - y.seq);
    const applied = new JournalSyncApplier({ stateDir: B.dir, replicatedRegistry: reg }).apply(A.id, [{ kind: CONTEXT_LAYER_RECORD_KIND, incarnation: `${A.id}-1`, entries }]);
    expect(applied).toMatchObject({ applied: 7, invalidEntries: 0, forgedEntries: 0 });
    // B reads A's records through the production peer-stream reader, by store.
    const streams = new ReplicatedPeerStreamReader({ stateDir: B.dir, registry: reg, selfMachineId: B.id, autoRebuild: true });
    const byKey = streams.loadAllOriginRecords(CONTEXT_LAYER_STORE_KEY);
    expect([...byKey.keys()].sort()).toEqual(onA.map((d) => d.recordKey as string).sort());
    const fromA = (k: string) => byKey.get(k)!.find((r) => r.origin === A.id)!;
    expect(fromA(`${T}:h3:h3`).data.body).toBe(onA[3].body);
    expect(fromA(`${T}:fold-record:f1`).data).toMatchObject({ state: 'committed', seq: 7, generation: 1 });
  });

  it('an oversize content record is refused at emit and never appended (refuse-never-truncate)', () => {
    const A = make('m_a');
    const fat = { recordType: 'chunk', topicKey: T, entryKey: 'c9', body: 'x'.repeat(8 * 1024 + 1), recordKey: `${T}:chunk:c9`, hlc: hlc(100, A.id), op: 'put', origin: A.id };
    expect(A.journal.emitReplicatedRecord(CONTEXT_LAYER_RECORD_KIND, fat)).toBe('schema-rejected');
    A.journal.flush();
    expect(lines(A.dir, A.id)).toEqual([]);
  });

  it('the REAL reader takes the HLC-latest record per key, even when the older HLC arrives second', () => {
    const A = make('m_a'); const B = make('m_b');
    expect(A.journal.emitReplicatedRecord(CONTEXT_LAYER_RECORD_KIND, put({ recordType: 'ledger-entry', topicKey: T, entryKey: 'g1', body: 'd', status: 'superseded' }, 200, A.id))).toBe('accepted');
    expect(A.journal.emitReplicatedRecord(CONTEXT_LAYER_RECORD_KIND, put({ recordType: 'ledger-entry', topicKey: T, entryKey: 'g1', body: 'd', status: 'live' }, 100, A.id))).toBe('accepted');
    A.journal.flush();
    const entries = A.journal.readTail(CONTEXT_LAYER_RECORD_KIND, 10_000).entries.sort((x, y) => x.seq - y.seq);
    new JournalSyncApplier({ stateDir: B.dir, replicatedRegistry: reg }).apply(A.id, [{ kind: CONTEXT_LAYER_RECORD_KIND, incarnation: `${A.id}-1`, entries }]);
    const streams = new ReplicatedPeerStreamReader({ stateDir: B.dir, registry: reg, selfMachineId: B.id, autoRebuild: true });
    const rec = streams.loadAllOriginRecords(CONTEXT_LAYER_STORE_KEY).get(`${T}:ledger-entry:g1`)!.find((r) => r.origin === A.id)!;
    expect(rec.data.status).toBe('superseded');
  });

  it('receive side: an oversize record forged past the builder is refused by the real applier', () => {
    const B = make('m_b');
    const forged = { recordType: 'chunk', topicKey: T, entryKey: 'c9', body: 'x'.repeat(8 * 1024 + 1), recordKey: `${T}:chunk:c9`, hlc: hlc(100, 'm_x'), op: 'put', origin: 'm_x' };
    const r = new JournalSyncApplier({ stateDir: B.dir, replicatedRegistry: reg }).apply('m_x', [{ kind: CONTEXT_LAYER_RECORD_KIND, incarnation: 'm_x-1', entries: [{ seq: 1, ts: new Date().toISOString(), machine: 'm_x', kind: CONTEXT_LAYER_RECORD_KIND, data: forged } as never] }]);
    expect(r.applied).toBe(0);
    expect(r.invalidEntries).toBe(1);
  });

  it('a delete tombstone round-trips through the journal and the applier', () => {
    const A = make('m_a'); const B = make('m_b');
    expect(A.journal.emitReplicatedRecord(CONTEXT_LAYER_RECORD_KIND, put({ recordType: 'chunk', topicKey: T, entryKey: 'c1', body: 'x' }, 100, A.id))).toBe('accepted');
    expect(A.journal.emitReplicatedRecord(CONTEXT_LAYER_RECORD_KIND, { recordType: 'chunk', topicKey: T, entryKey: 'c1', recordKey: `${T}:chunk:c1`, hlc: hlc(200, A.id), op: 'delete', origin: A.id, body: 'stray' })).toBe('accepted');
    A.journal.flush();
    const entries = A.journal.readTail(CONTEXT_LAYER_RECORD_KIND, 10_000).entries.sort((x, y) => x.seq - y.seq);
    expect(new JournalSyncApplier({ stateDir: B.dir, replicatedRegistry: reg }).apply(A.id, [{ kind: CONTEXT_LAYER_RECORD_KIND, incarnation: `${A.id}-1`, entries }])).toMatchObject({ applied: 2, invalidEntries: 0 });
    const streams = new ReplicatedPeerStreamReader({ stateDir: B.dir, registry: reg, selfMachineId: B.id, autoRebuild: true });
    const rec = streams.loadAllOriginRecords(CONTEXT_LAYER_STORE_KEY).get(`${T}:chunk:c1`)!.find((r) => r.origin === A.id)!;
    expect(rec.envelope.op).toBe('delete');
    expect(rec.data).not.toHaveProperty('body');
  });

  it('FORWARD COMPATIBLE: a later build\'s new record type and fold state apply on this build without stalling the stream', () => {
    const B = make('m_b');
    const later = [
      { recordType: 'h4', topicKey: T, entryKey: 'x', body: 'from a newer build', recordKey: `${T}:h4:x`, hlc: hlc(100, 'm_new'), op: 'put', origin: 'm_new' },
      { recordType: 'fold-record', topicKey: T, entryKey: 'f9', state: 'pre-staged', recordKey: `${T}:fold-record:f9`, hlc: hlc(110, 'm_new'), op: 'put', origin: 'm_new' },
      { recordType: 'fold-cooldown', topicKey: T, entryKey: 'c', count: 2, recordKey: `${T}:fold-cooldown:c`, hlc: hlc(112, 'm_new'), op: 'put', origin: 'm_new' },
      { recordType: 'h4', topicKey: T, entryKey: 'big', body: 'y'.repeat(20 * 1024), recordKey: `${T}:h4:big`, hlc: hlc(114, 'm_new'), op: 'put', origin: 'm_new' },
      { recordType: 'ledger-entry', topicKey: T, entryKey: 'g', body: 'z', status: 'Body.Elsewhere', recordKey: `${T}:ledger-entry:g`, hlc: hlc(116, 'm_new'), op: 'put', origin: 'm_new' },
      { recordType: 'anchor', topicKey: T, entryKey: 'a', body: 'still flows after', recordKey: `${T}:anchor:a`, hlc: hlc(120, 'm_new'), op: 'put', origin: 'm_new' },
    ];
    const r = new JournalSyncApplier({ stateDir: B.dir, replicatedRegistry: reg }).apply('m_new', [{ kind: CONTEXT_LAYER_RECORD_KIND, incarnation: 'm_new-1', entries: later.map((data, i) => ({ seq: i + 1, ts: new Date().toISOString(), machine: 'm_new', kind: CONTEXT_LAYER_RECORD_KIND, data })) as never }]);
    expect(r).toMatchObject({ applied: 6, invalidEntries: 0, suspectStreams: 0 });
  });

  it('a machine WITHOUT the kind registered (an older build) refuses to emit it', () => {
    const dir = path.join(root, 'old'); fs.mkdirSync(dir);
    const old = new CoherenceJournal({ stateDir: dir, machineId: 'm_old', flushIntervalMs: 1_000_000 });
    old.open();
    old.setReplicatedKindRegistry(new ReplicatedKindRegistry());
    try {
      expect(old.emitReplicatedRecord(CONTEXT_LAYER_RECORD_KIND, put({ recordType: 'anchor', topicKey: T, entryKey: 'a', body: 'x' }, 1, 'm_old'))).not.toBe('accepted');
    } finally { old.close(); }
  });
});

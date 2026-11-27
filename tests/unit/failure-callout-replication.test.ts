import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CoherenceJournal, type JournalEntry } from '../../src/core/CoherenceJournal.js';
import { JournalSyncApplier } from '../../src/core/JournalSyncApplier.js';
import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import { ReplicatedPeerStreamReader } from '../../src/core/ReplicatedPeerStreamReader.js';
import { ReplicatedRecordEmitter } from '../../src/core/ReplicatedRecordEmitter.js';
import { HybridLogicalClock } from '../../src/core/HybridLogicalClock.js';
import { CorrectionLedger } from '../../src/monitoring/CorrectionLedger.js';
import { FAILURE_CALLOUT_KIND_REGISTRATION, FAILURE_CALLOUT_RECORD_KIND, FAILURE_CALLOUT_STORE_KEY,
  failureReplicaReader, failureReplicationEmitter, failureSnapshotChunks, buildFailureChunkData, resolveFailureReplicationTransport, isFailureReplicationKindAllowed, filterFailureReplicationBatch } from '../../src/core/FailureCalloutReplicatedStore.js';
import { buildReconcilerSeams } from '../../src/core/ReplicatedStoreReconcilerWiring.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { OriginRecord } from '../../src/core/UnionReader.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'failure-replication-test' }); });
function tmp() { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'failure-replica-')); roots.push(p); return p; }
function input() { return { kind: 'infra-gap' as const, severity: 'failure-callout' as const, learning: 'Own approved tasks', scrubbedSummary: 'Agent handed back work', deterministicWeight: 3,
  failureContext: { turns: [{ text: 'You do it', fromUser: false, at: 1 }, { text: 'That was your job', fromUser: true, at: 2 }],
    instructions: ['Agent does approved work'], decisions: ['Approval ignored'], sourceRefs: ['message:2'], missing: [] } }; }

describe('failure-callout journal continuity', () => {
  it('enables only forensic transport by default and honors every explicit transport opt-out', () => {
    expect(resolveFailureReplicationTransport({})).toEqual({ journalEnabled: true, replicationEnabled: true, failureOnly: true, failureEvidenceEnabled: true });
    expect(resolveFailureReplicationTransport({ multiMachine: { coherenceJournal: { enabled: false } } } as any)).toMatchObject({ journalEnabled: false, replicationEnabled: false });
    expect(resolveFailureReplicationTransport({ multiMachine: { coherenceJournal: { replication: { enabled: false } } } } as any)).toMatchObject({ journalEnabled: true, replicationEnabled: false });
    expect(resolveFailureReplicationTransport({ monitoring: { failureCallouts: { enabled: false } } } as any)).toMatchObject({ journalEnabled: false, replicationEnabled: false });
    expect(resolveFailureReplicationTransport({ multiMachine: { coherenceJournal: { replication: { enabled: true } } } } as any)).toEqual({ journalEnabled: true, replicationEnabled: true, failureOnly: false, failureEvidenceEnabled: true });
    expect(resolveFailureReplicationTransport({ monitoring: { failureCallouts: { enabled: false } } } as any, true)).toEqual({ journalEnabled: true, replicationEnabled: false, failureOnly: false, failureEvidenceEnabled: false });
  });

  it('uses the same forensic-only filter at inbound and outbound seams, and applies no lifecycle streams implicitly', () => {
    const mode = resolveFailureReplicationTransport({});
    expect(isFailureReplicationKindAllowed(mode, 'topic-placement')).toBe(false);
    expect(isFailureReplicationKindAllowed(mode, FAILURE_CALLOUT_RECORD_KIND)).toBe(true);
    for (const optout of [
      { monitoring: { failureCallouts: { enabled: false } }, multiMachine: { coherenceJournal: { enabled: true, replication: { enabled: true } } } },
      { multiMachine: { stateSync: { failureCallout: { enabled: false } }, coherenceJournal: { replication: { enabled: true } } } },
    ]) {
      const disabled = resolveFailureReplicationTransport(optout as any);
      expect(isFailureReplicationKindAllowed(disabled, FAILURE_CALLOUT_RECORD_KIND)).toBe(false);
      expect(isFailureReplicationKindAllowed(disabled, 'topic-placement')).toBe(true);
    }
    const reg = new ReplicatedKindRegistry(); reg.register(FAILURE_CALLOUT_KIND_REGISTRATION);
    const applier = new JournalSyncApplier({ stateDir: tmp(), replicatedRegistry: reg });
    const ledger = new CorrectionLedger({ dbPath: ':memory:', machineId: 'origin' });
    try {
      const record = ledger.record(input())!, chunk = failureSnapshotChunks(record)[0];
      const entry: JournalEntry = { machine: 'origin', kind: FAILURE_CALLOUT_RECORD_KIND, seq: 1, ts: new Date().toISOString(),
        data: buildFailureChunkData(chunk, { physical: 1, logical: 0, node: 'origin' }, 'origin') };
      const mixed = [{ kind: 'topic-placement', incarnation: 'one', entries: [] }, { kind: FAILURE_CALLOUT_RECORD_KIND, incarnation: 'one', entries: [entry] }];
      const selected = filterFailureReplicationBatch(mode, mixed);
      expect(selected.map(row => row.kind)).toEqual([FAILURE_CALLOUT_RECORD_KIND]);
      expect(applier.apply('origin', selected as any).applied).toBe(1);
      expect(applier.getAdvertState().origin['topic-placement']).toBeUndefined();
      expect(filterFailureReplicationBatch({ replicationEnabled: false, failureOnly: false }, mixed)).toEqual([]);
      expect(filterFailureReplicationBatch({ replicationEnabled: true, failureOnly: false }, mixed)).toHaveLength(2);
    } finally { ledger.close(); }
    const source = fs.readFileSync(new URL('../../src/commands/server.ts', import.meta.url), 'utf8');
    const inbound = source.slice(source.indexOf("'journal-sync': (cmd"), source.indexOf("'ownership-nudge': (cmd"));
    expect(inbound).toContain('isFailureReplicationKindAllowed(failureReplicationTransport, c.request.kind)');
    expect(inbound).toContain('filterFailureReplicationBatch(failureReplicationTransport, c.batch');
  });

  it('replicates real committed ledger writes and immutable episodes through journal apply and disk reader', async () => {
    const a = tmp(), b = tmp(), reg = new ReplicatedKindRegistry(); reg.register(FAILURE_CALLOUT_KIND_REGISTRATION);
    const journal = new CoherenceJournal({ stateDir: a, machineId: 'origin', flushIntervalMs: 1_000_000 }); journal.open(); journal.setReplicatedKindRegistry(reg);
    const ledger = new CorrectionLedger({ dbPath: path.join(a, 'correction-ledger.db'), machineId: 'origin' });
    try {
      const entries: JournalEntry[] = [];
      const emitter = new ReplicatedRecordEmitter({ journal: { emitReplicatedRecord(kind, data) {
        const result = journal.emitReplicatedRecord(kind as any, data); if (result === 'accepted') entries.push({ seq: entries.length + 1, ts: new Date().toISOString(), machine: 'origin', kind: FAILURE_CALLOUT_RECORD_KIND, data }); return result;
      } }, clock: new HybridLogicalClock({ node: 'origin', now: Date.now }), registry: reg, origin: 'origin', stores: () => ({ [FAILURE_CALLOUT_STORE_KEY]: { enabled: true } }), loadWitness: () => undefined });
      ledger.setFailureReplicationEmitter(failureReplicationEmitter(emitter));
      const record = ledger.record(input())!;
      const updated = ledger.updateFailureCase(record.id, { context: record.failureCase!.context }, record.version);
      expect(updated.ok).toBe(true); journal.flush();
      expect(entries.length).toBeGreaterThanOrEqual(4);
      const applier = new JournalSyncApplier({ stateDir: b, replicatedRegistry: reg });
      applier.apply('origin', [{ kind: FAILURE_CALLOUT_RECORD_KIND, incarnation: 'original', entries }]);
      const streams = new ReplicatedPeerStreamReader({ stateDir: b, registry: reg, selfMachineId: 'reader', autoRebuild: false });
      await streams.rebuildWitnessIndexAsync();
      const reader = failureReplicaReader(streams);
      const cases = reader.all();
      expect(cases).toHaveLength(1); expect(cases[0].machineId).toBe('origin'); expect(cases[0].record.version).toBe(record.version + 1);
      expect(cases[0].record.failureCase!.context).toEqual(record.failureCase!.context);
      expect(reader.episodes(record.id, 'origin').map(e => e.version).sort()).toEqual([1, 2]);
      const seam = buildReconcilerSeams({ stateDir: a, evolution: { listActions: () => [], listLearnings: () => [] } }).find(s => s.store === FAILURE_CALLOUT_STORE_KEY)!;
      expect(seam.snapshot().rows.length).toBeGreaterThanOrEqual(3);
    } finally { ledger.close(); journal.close(); }
  });

  it('rejects a first-hop sender forging the inner origin of a failure case', () => {
    const reg = new ReplicatedKindRegistry(); reg.register(FAILURE_CALLOUT_KIND_REGISTRATION);
    const ledger = new CorrectionLedger({ dbPath: ':memory:', machineId: 'victim' });
    try {
      const record = ledger.record(input())!, chunk = failureSnapshotChunks(record)[0];
      const data = buildFailureChunkData(chunk, { physical: 1, logical: 0, node: 'victim' }, 'victim');
      const applier = new JournalSyncApplier({ stateDir: tmp(), replicatedRegistry: reg });
      const result = applier.apply('attacker', [{ kind: FAILURE_CALLOUT_RECORD_KIND, incarnation: 'forged', entries: [
        { machine: 'attacker', kind: FAILURE_CALLOUT_RECORD_KIND, seq: 1, ts: new Date().toISOString(), data },
      ] }]);
      expect(result.forgedEntries).toBe(1); expect(result.applied).toBe(0);
    } finally { ledger.close(); }
  });

  it('exposes only whole digest-checked versions, retains latest complete version during partial delivery, and never merges origins', () => {
    const ledger = new CorrectionLedger({ dbPath: ':memory:', machineId: 'origin' });
    try {
      const record = ledger.record({ ...input(), failureContext: { ...input().failureContext, instructions: Array(20).fill('界'.repeat(4000)) } })!;
      const chunks = failureSnapshotChunks(record); expect(chunks.length).toBeGreaterThan(1);
      let rows = new Map<string, OriginRecord[]>();
      const dropped = new Set<string>();
      const reader = failureReplicaReader({ loadAllOriginRecords: () => rows }, () => dropped);
      function add(chunk: typeof chunks[number], origin = 'origin') {
        const hlc = { physical: 1, logical: 1, node: origin }; const data = buildFailureChunkData(chunk, hlc, origin);
        rows.set(`${origin}:${chunk.key}`, [{ origin, envelope: { recordKey: chunk.key, origin, hlc, op: 'put' }, data }]);
      }
      chunks.slice(1).forEach(c => add(c)); expect(reader.all()).toEqual([]);
      add(chunks[0], 'other'); expect(reader.all()).toEqual([]);
      add(chunks[0]); expect(reader.all()).toHaveLength(1);
      dropped.add('origin'); expect(reader.all()).toEqual([]); expect(reader.episodes(record.id, 'origin')).toEqual([]);
      dropped.clear(); expect(reader.all()).toHaveLength(1);
      const next = failureSnapshotChunks({ ...record, version: record.version + 1 }); add(next[0]);
      expect(reader.all().find(r => r.machineId === 'origin')!.record.version).toBe(record.version);
      rows = new Map(); const damaged = { ...chunks[0], data: { ...chunks[0].data, chunk: Buffer.from('wrong').toString('base64') } };
      chunks.slice(1).forEach(c => add(c)); add(damaged); expect(reader.all()).toEqual([]);
    } finally { ledger.close(); }
  });
});

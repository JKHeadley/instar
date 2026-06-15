// safe-fs-allow: test fixture teardown uses SafeFsExecutor.safeRmSync on tmp dirs only.
/**
 * Unit — ReplicatedPeerStreamReader (WS2 send-side, §3.3/§3.4 — the union-read +
 * witness + loadOwnEntries source).
 *
 * Proves the reader materializes the union's per-origin records from the OWN journal
 * stream (written by CoherenceJournal) AND a PEER replica stream (written by
 * JournalSyncApplier under first-hop binding) — folding to the latest per
 * (origin, recordKey) by HLC, keeping a tombstone — and that loadWitness returns the
 * MAX held HLC and loadOwnEntries serves only this machine's own entries.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { CoherenceJournal } from '../../src/core/CoherenceJournal.js';
import { JournalSyncApplier, type ApplyBatchStream } from '../../src/core/JournalSyncApplier.js';
import { ReplicatedPeerStreamReader } from '../../src/core/ReplicatedPeerStreamReader.js';
import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import {
  LEARNING_KIND_REGISTRATION,
  LEARNING_RECORD_KIND,
  LEARNING_STORE_KEY,
  buildLearningRecordData,
  buildLearningTombstoneData,
  deriveLearningRecordKey,
} from '../../src/core/LearningsReplicatedStore.js';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';
import type { JournalEntry } from '../../src/core/CoherenceJournal.js';
import type { LearningEntry, LearningSource } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const SELF = 'm_self';
const PEER = 'm_peer';

function reg(): ReplicatedKindRegistry {
  const r = new ReplicatedKindRegistry();
  r.register(LEARNING_KIND_REGISTRATION);
  return r;
}
function hlc(physical: number, node: string, logical = 0): HlcTimestamp {
  return { physical, logical, node };
}
function learning(over: Partial<LearningEntry> = {}): LearningEntry {
  return {
    id: 'LRN-001', title: 'tmux colon', category: 'ops',
    description: 'desc', source: { discoveredAt: '2026-06-15T00:00:00.000Z' },
    tags: [], applied: false, ...over,
  };
}
const SRC: LearningSource = { discoveredAt: '2026-06-15T00:00:00.000Z' };

/** Apply a peer learning-record as a first-hop-bound journal batch (writes peers/<PEER>...). */
function applyPeerRecord(applier: JournalSyncApplier, data: Record<string, unknown>, seq: number): void {
  const entry: JournalEntry = { seq, ts: new Date(2026, 5, 15).toISOString(), machine: PEER, kind: LEARNING_RECORD_KIND, data };
  const batch: ApplyBatchStream[] = [{ kind: LEARNING_RECORD_KIND, incarnation: 'inc-peer', entries: [entry] }];
  applier.apply(PEER, batch);
}

describe('ReplicatedPeerStreamReader', () => {
  let dir: string;
  let journal: CoherenceJournal;
  let applier: JournalSyncApplier;
  let reader: ReplicatedPeerStreamReader;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psr-'));
    const registry = reg();
    journal = new CoherenceJournal({ stateDir: dir, machineId: SELF, flushIntervalMs: 1_000_000 });
    journal.open();
    journal.setReplicatedKindRegistry(registry);
    applier = new JournalSyncApplier({ stateDir: dir, replicatedRegistry: registry });
    reader = new ReplicatedPeerStreamReader({ stateDir: dir, registry, selfMachineId: SELF });
  });
  afterEach(() => {
    try { journal.close(); } catch { /* best-effort */ }
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/ReplicatedPeerStreamReader.test.ts' });
  });

  it('materializes OWN + PEER records as distinct origins for the same recordKey', () => {
    // Same lesson learned on both machines ⇒ same recordKey, two origins.
    const rk = deriveLearningRecordKey('tmux colon', 'ops', SRC)!;
    journal.emitReplicatedRecord(LEARNING_RECORD_KIND, buildLearningRecordData({ record: learning(), hlc: hlc(1000, SELF), origin: SELF })!);
    journal.flush();
    applyPeerRecord(applier, buildLearningRecordData({ record: learning(), hlc: hlc(1500, PEER), origin: PEER })!, 1);

    const origins = reader.loadOriginRecords(LEARNING_STORE_KEY, rk);
    expect(origins).toHaveLength(2);
    expect(origins.map((o) => o.origin).sort()).toEqual([PEER, SELF].sort());
    expect(reader.listRecordKeys(LEARNING_STORE_KEY)).toEqual([rk]);
  });

  it('folds to the LATEST record per (origin, recordKey) by HLC', () => {
    const rk = deriveLearningRecordKey('tmux colon', 'ops', SRC)!;
    // Two OWN emits for the same key, the later (applied=true) at a higher HLC.
    journal.emitReplicatedRecord(LEARNING_RECORD_KIND, buildLearningRecordData({ record: learning({ applied: false }), hlc: hlc(1000, SELF), origin: SELF })!);
    journal.emitReplicatedRecord(LEARNING_RECORD_KIND, buildLearningRecordData({ record: learning({ applied: true }), hlc: hlc(2000, SELF), origin: SELF })!);
    journal.flush();

    const origins = reader.loadOriginRecords(LEARNING_STORE_KEY, rk);
    expect(origins).toHaveLength(1);
    expect(origins[0].envelope.hlc.physical).toBe(2000);
    expect(origins[0].data.applied).toBe(true);
  });

  it('keeps a tombstone (op:delete) as the latest record', () => {
    const rk = deriveLearningRecordKey('tmux colon', 'ops', SRC)!;
    journal.emitReplicatedRecord(LEARNING_RECORD_KIND, buildLearningRecordData({ record: learning(), hlc: hlc(1000, SELF), origin: SELF })!);
    journal.emitReplicatedRecord(LEARNING_RECORD_KIND, buildLearningTombstoneData({ title: 'tmux colon', category: 'ops', source: SRC, hlc: hlc(3000, SELF), origin: SELF, deletedAt: '2026-06-15T01:00:00.000Z' })!);
    journal.flush();

    const origins = reader.loadOriginRecords(LEARNING_STORE_KEY, rk);
    expect(origins).toHaveLength(1);
    expect(origins[0].envelope.op).toBe('delete');
  });

  it('loadWitness returns the MAX held HLC across origins (the observed source)', () => {
    const rk = deriveLearningRecordKey('tmux colon', 'ops', SRC)!;
    journal.emitReplicatedRecord(LEARNING_RECORD_KIND, buildLearningRecordData({ record: learning(), hlc: hlc(1000, SELF), origin: SELF })!);
    journal.flush();
    applyPeerRecord(applier, buildLearningRecordData({ record: learning(), hlc: hlc(2500, PEER), origin: PEER })!, 1);

    const witness = reader.loadWitness(LEARNING_STORE_KEY, rk);
    expect(witness?.physical).toBe(2500);
  });

  it('loadWitness is undefined for an unheld key (first write)', () => {
    expect(reader.loadWitness(LEARNING_STORE_KEY, 'never-seen')).toBeUndefined();
  });

  it('loadOwnEntries serves only THIS machine\'s own entries; {} for a foreign origin', () => {
    journal.emitReplicatedRecord(LEARNING_RECORD_KIND, buildLearningRecordData({ record: learning(), hlc: hlc(1000, SELF), origin: SELF })!);
    journal.flush();

    const own = reader.loadOwnEntries(LEARNING_STORE_KEY, SELF);
    expect(own[LEARNING_RECORD_KIND]).toBeDefined();
    expect(own[LEARNING_RECORD_KIND].length).toBe(1);
    expect(own[LEARNING_RECORD_KIND][0].machine).toBe(SELF);
    // Single-origin: a request for a foreign origin returns nothing.
    expect(reader.loadOwnEntries(LEARNING_STORE_KEY, PEER)).toEqual({});
  });
});

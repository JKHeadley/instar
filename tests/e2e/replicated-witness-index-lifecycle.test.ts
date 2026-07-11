// safe-fs-allow: test fixture teardown uses SafeFsExecutor.safeRmSync on tmp dirs only.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CoherenceJournal, type JournalEntry } from '../../src/core/CoherenceJournal.js';
import { JournalSyncApplier, type ApplyBatchStream } from '../../src/core/JournalSyncApplier.js';
import { LEARNING_KIND_REGISTRATION, LEARNING_RECORD_KIND, LEARNING_STORE_KEY, buildLearningRecordData, deriveLearningRecordKey } from '../../src/core/LearningsReplicatedStore.js';
import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import { ReplicatedPeerStreamReader } from '../../src/core/ReplicatedPeerStreamReader.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';
import type { LearningEntry } from '../../src/core/types.js';

const SELF = 'm_self';
const PEER = 'm_peer';

function registry(): ReplicatedKindRegistry {
  const r = new ReplicatedKindRegistry();
  r.register(LEARNING_KIND_REGISTRATION);
  return r;
}

function learning(): LearningEntry {
  return {
    id: 'LRN-E2E',
    title: 'rebuild indexed witness',
    category: 'ops',
    description: 'rebuilds after memory loss',
    source: { discoveredAt: '2026-07-10T00:00:00.000Z' },
    tags: [],
    applied: false,
  };
}

function hlc(physical: number, node: string): HlcTimestamp {
  return { physical, logical: 0, node };
}

function applyPeer(applier: JournalSyncApplier, data: Record<string, unknown>): void {
  const entry: JournalEntry = { seq: 1, ts: '2026-07-10T00:00:00.000Z', machine: PEER, kind: LEARNING_RECORD_KIND, data };
  const batch: ApplyBatchStream[] = [{ kind: LEARNING_RECORD_KIND, incarnation: 'inc-peer', entries: [entry] }];
  applier.apply(PEER, batch);
}

describe('replicated witness index lifecycle', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/replicated-witness-index-lifecycle.test.ts' });
    dir = undefined;
  });

  it('rebuilds from own + peer journal streams after index loss', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'witness-index-e2e-'));
    const reg = registry();
    const journal = new CoherenceJournal({ stateDir: dir, machineId: SELF, flushIntervalMs: 1_000_000 });
    journal.open();
    journal.setReplicatedKindRegistry(reg);
    try {
      const applier = new JournalSyncApplier({ stateDir: dir, replicatedRegistry: reg });
      const record = learning();
      const rk = deriveLearningRecordKey(record.title, record.category, record.source)!;

      journal.emitReplicatedRecord(LEARNING_RECORD_KIND, buildLearningRecordData({ record, hlc: hlc(1000, SELF), origin: SELF })!);
      journal.flush();
      applyPeer(applier, buildLearningRecordData({ record, hlc: hlc(2500, PEER), origin: PEER })!);

      const rebuilt = new ReplicatedPeerStreamReader({ stateDir: dir, registry: reg, selfMachineId: SELF, autoRebuild: false });
      await rebuilt.rebuildWitnessIndexAsync();
      expect(rebuilt.loadWitness(LEARNING_STORE_KEY, rk)?.physical).toBe(2500);
      expect(rebuilt.loadOriginRecords(LEARNING_STORE_KEY, rk).map((r) => r.origin).sort()).toEqual([PEER, SELF].sort());
    } finally {
      journal.close();
    }
  });
});

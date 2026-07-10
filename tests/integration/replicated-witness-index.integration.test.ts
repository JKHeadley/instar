// safe-fs-allow: test fixture teardown uses SafeFsExecutor.safeRmSync on tmp dirs only.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CoherenceJournal, type JournalFs } from '../../src/core/CoherenceJournal.js';
import { HybridLogicalClock, type HlcTimestamp } from '../../src/core/HybridLogicalClock.js';
import { LEARNING_KIND_REGISTRATION, LEARNING_RECORD_KIND, LEARNING_STORE_KEY, buildLearningRecordData, deriveLearningRecordKey } from '../../src/core/LearningsReplicatedStore.js';
import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import { ReplicatedPeerStreamReader } from '../../src/core/ReplicatedPeerStreamReader.js';
import { ReplicatedRecordEmitter } from '../../src/core/ReplicatedRecordEmitter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { LearningEntry } from '../../src/core/types.js';

const SELF = 'm_self';

function registry(): ReplicatedKindRegistry {
  const r = new ReplicatedKindRegistry();
  r.register(LEARNING_KIND_REGISTRATION);
  return r;
}

function learning(): LearningEntry {
  return {
    id: 'LRN-INT',
    title: 'indexed witness',
    category: 'ops',
    description: 'witness lookup is indexed',
    source: { discoveredAt: '2026-07-10T00:00:00.000Z' },
    tags: [],
    applied: false,
  };
}

function hlc(physical: number): HlcTimestamp {
  return { physical, logical: 0, node: SELF };
}

function countingFs(): { io: JournalFs; reads: () => number; reset: () => void } {
  let readCount = 0;
  const io = { ...fs } as unknown as JournalFs;
  io.readSync = (...args: Parameters<typeof fs.readSync>) => {
    readCount++;
    return fs.readSync(...args);
  };
  return { io, reads: () => readCount, reset: () => { readCount = 0; } };
}

describe('replicated witness index integration', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/replicated-witness-index.integration.test.ts' });
    dir = undefined;
  });

  it('real emitter path reads the derived witness index instead of the journal stream', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'witness-index-int-'));
    const reg = registry();
    const journal = new CoherenceJournal({ stateDir: dir, machineId: SELF, flushIntervalMs: 1_000_000 });
    journal.open();
    journal.setReplicatedKindRegistry(reg);
    try {
      const first = learning();
      const rk = deriveLearningRecordKey(first.title, first.category, first.source)!;
      journal.emitReplicatedRecord(LEARNING_RECORD_KIND, buildLearningRecordData({ record: first, hlc: hlc(1000), origin: SELF })!);
      journal.flush();

      const counted = countingFs();
      const reader = new ReplicatedPeerStreamReader({ stateDir: dir, registry: reg, selfMachineId: SELF, fsImpl: counted.io });
      journal.setReplicatedRecordCommitObserver((kind, entries) => reader.observeCommittedEntries(kind, entries));
      counted.reset();

      const emitted: Record<string, unknown>[] = [];
      const clock = new HybridLogicalClock({ node: SELF, now: () => 2000 });
      const emitter = new ReplicatedRecordEmitter({
        journal: { emitReplicatedRecord: (_kind, data) => { emitted.push(data); } },
        clock,
        registry: reg,
        origin: SELF,
        stores: () => ({ learnings: { enabled: true } }),
        loadWitness: (store, recordKey) => reader.loadWitness(store, recordKey),
      });
      emitter.emit(LEARNING_STORE_KEY, rk, (nextHlc, origin, observed) => ({
        ...buildLearningRecordData({ record: { ...first, applied: true }, hlc: nextHlc, origin })!,
        ...(observed ? { observed } : {}),
      }));

      expect((emitted[0].observed as HlcTimestamp).physical).toBe(1000);
      expect(counted.reads()).toBe(0);
    } finally {
      journal.close();
    }
  });
});

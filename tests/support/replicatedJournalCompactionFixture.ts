import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LEARNING_KIND_REGISTRATION, LEARNING_RECORD_KIND, buildLearningRecordData, deriveLearningRecordKey } from '../../src/core/LearningsReplicatedStore.js';
import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { LearningEntry } from '../../src/core/types.js';

export function createCompactionFixture() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-compact-'));
  const machine = 'm_compact';
  const journalDir = path.join(stateDir, 'state', 'coherence-journal'); fs.mkdirSync(journalDir, { recursive: true });
  const file = path.join(journalDir, `${machine}.${LEARNING_RECORD_KIND}.jsonl`);
  const registry = new ReplicatedKindRegistry(); registry.register(LEARNING_KIND_REGISTRATION);
  const record: LearningEntry = { id: 'LRN-1', title: 'same', category: 'ops', description: 'value', source: { discoveredAt: '2026-07-10T00:00:00.000Z' }, tags: [], applied: false };
  const recordKey = deriveLearningRecordKey(record.title, record.category, record.source)!;
  const lines = [1, 2, 3].map((seq) => JSON.stringify({ seq, ts: seq, machine, kind: LEARNING_RECORD_KIND, data: buildLearningRecordData({ record: { ...record, applied: seq === 3 }, hlc: { physical: seq, logical: 0, node: machine }, origin: machine }) }));
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return { stateDir, machine, file, registry, recordKey, cleanup: () => SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'replicated journal compaction fixture' }) };
}

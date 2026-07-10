// safe-fs-allow: fixtures live only under os.tmpdir and are removed after each test.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LEARNING_KIND_REGISTRATION, LEARNING_RECORD_KIND, buildLearningRecordData } from '../../src/core/LearningsReplicatedStore.js';
import { ReplicatedJournalCompactor } from '../../src/core/ReplicatedJournalCompactor.js';
import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { LearningEntry } from '../../src/core/types.js';

const SELF = 'm_compact';
let dir: string | undefined;
afterEach(() => { if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'ReplicatedJournalCompactor unit fixture' }); dir = undefined; });

function fixture(): { stateDir: string; file: string; registry: ReplicatedKindRegistry } {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-compact-unit-'));
  const journalDir = path.join(dir, 'state', 'coherence-journal');
  fs.mkdirSync(journalDir, { recursive: true });
  const file = path.join(journalDir, `${SELF}.${LEARNING_RECORD_KIND}.jsonl`);
  const registry = new ReplicatedKindRegistry(); registry.register(LEARNING_KIND_REGISTRATION);
  const base: LearningEntry = { id: 'LRN-1', title: 'same', category: 'ops', description: 'v', source: { discoveredAt: '2026-07-10T00:00:00.000Z' }, tags: [], applied: false };
  const lines = [1, 2, 3].map((seq) => JSON.stringify({ seq, ts: seq, machine: SELF, kind: LEARNING_RECORD_KIND, data: buildLearningRecordData({ record: { ...base, applied: seq === 3 }, hlc: { physical: seq, logical: 0, node: SELF }, origin: SELF }) }));
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return { stateDir: dir, file, registry };
}

describe('ReplicatedJournalCompactor', () => {
  it('drops superseded versions while preserving the latest witness', () => {
    const f = fixture();
    const result = new ReplicatedJournalCompactor({ stateDir: f.stateDir, registry: f.registry, enabled: true, dryRun: false }).run();
    expect(result).toMatchObject({ originalRecords: 3, compactedRecords: 1, filesCompacted: 1 });
    const rows = fs.readFileSync(f.file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(rows).toHaveLength(1);
    expect(rows[0].data.hlc.physical).toBe(3);
  });
});

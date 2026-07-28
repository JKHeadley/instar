import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { ReplicatedJournalCompactor } from '../../src/core/ReplicatedJournalCompactor.js';
import { ReplicatedPeerStreamReader } from '../../src/core/ReplicatedPeerStreamReader.js';
import { LEARNING_STORE_KEY } from '../../src/core/LearningsReplicatedStore.js';
import { createCompactionFixture } from '../support/replicatedJournalCompactionFixture.js';

describe('replicated journal compaction integration', () => {
  it('defaults to dry-run, reports N -> M, and a real run leaves the witness unchanged', () => {
    const f = createCompactionFixture();
    try {
      const beforeBytes = fs.readFileSync(f.file);
      const before = new ReplicatedPeerStreamReader({ stateDir: f.stateDir, registry: f.registry, selfMachineId: f.machine }).loadWitness(LEARNING_STORE_KEY, f.recordKey);
      const messages: string[] = [];
      const dry = new ReplicatedJournalCompactor({ stateDir: f.stateDir, registry: f.registry, enabled: true, logger: (m) => messages.push(m) }).run();
      expect(dry).toMatchObject({ dryRun: true, originalRecords: 3, compactedRecords: 1 });
      expect(messages[0]).toContain('would compact 3 records -> 1');
      expect(fs.readFileSync(f.file)).toEqual(beforeBytes);
      new ReplicatedJournalCompactor({ stateDir: f.stateDir, registry: f.registry, enabled: true, dryRun: false }).run();
      const after = new ReplicatedPeerStreamReader({ stateDir: f.stateDir, registry: f.registry, selfMachineId: f.machine }).loadWitness(LEARNING_STORE_KEY, f.recordKey);
      expect(after).toEqual(before);
      expect(fs.statSync(f.file).size).toBeLessThan(beforeBytes.length);
    } finally { f.cleanup(); }
  });
});

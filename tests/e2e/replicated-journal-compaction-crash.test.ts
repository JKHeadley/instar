import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ReplicatedJournalCompactor } from '../../src/core/ReplicatedJournalCompactor.js';
import { createCompactionFixture } from '../support/replicatedJournalCompactionFixture.js';

describe('replicated journal compaction crash boundary', () => {
  it('keeps the original byte-for-byte intact when interrupted before rename', () => {
    const f = createCompactionFixture();
    try {
      const original = fs.readFileSync(f.file);
      expect(() => new ReplicatedJournalCompactor({
        stateDir: f.stateDir, registry: f.registry, enabled: true, dryRun: false,
        beforeRename: () => { throw new Error('simulated kill before commit point'); },
      }).run()).toThrow('simulated kill');
      expect(fs.readFileSync(f.file)).toEqual(original);
      expect(fs.readdirSync(path.dirname(f.file)).some((name) => name.includes('.compact-'))).toBe(false);
    } finally { f.cleanup(); }
  });
});

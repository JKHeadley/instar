// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * WS2.2 — EvolutionManager learning-record replication emit seam.
 *
 * Wiring-integrity + the spec-critical prune-tombstone-resurrection test:
 *   - dark by default: with NO emitter injected, saveLearnings emits nothing (a strict
 *     single-machine no-op, byte-identical local behavior).
 *   - emit-on-write: an injected emitter receives a `put` per surviving learning.
 *   - PRUNE EMITS TOMBSTONE: when the learning count exceeds maxLearnings, the pruned
 *     learnings emit `op:delete` tombstones — else a peer re-replicates a locally-pruned
 *     learning forever (resurrection). This is the named §3 gate.
 *   - emit is best-effort: a throwing emitter NEVER breaks the local write (the durable
 *     state is still persisted).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { EvolutionManager, type LearningReplicationEmitter } from '../../src/core/EvolutionManager.js';
import type { LearningSource } from '../../src/core/types.js';

function mkDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evo-learning-repl-'));
}
function cleanup(dir: string) {
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/evolution-manager-learning-replication.test.ts' });
}

interface Recorder extends LearningReplicationEmitter {
  puts: string[];
  deletes: Array<{ title: string; category: string }>;
}
function recorder(over: Partial<LearningReplicationEmitter> = {}): Recorder {
  const r: Recorder = {
    puts: [],
    deletes: [],
    emitPut(record) { r.puts.push(record.title); },
    emitDelete(title, category, _source: LearningSource, _deletedAt) { r.deletes.push({ title, category }); },
    ...over,
  };
  return r;
}

describe('EvolutionManager learning-record replication emit', () => {
  it('dark by default: NO emitter ⇒ saveLearnings emits nothing (strict no-op)', () => {
    const dir = mkDir();
    try {
      const evo = new EvolutionManager({ stateDir: dir });
      // No setLearningReplicationEmitter call. addLearning must not throw + must persist.
      const l = evo.addLearning({ title: 'a', category: 'infra', description: 'd', source: { discoveredAt: '2026-06-01T00:00:00.000Z' } });
      expect(l.id).toMatch(/^LRN-/);
      expect(evo.listLearnings()).toHaveLength(1);
    } finally {
      cleanup(dir);
    }
  });

  it('emit-on-write: an injected emitter receives a put for the persisted learning', () => {
    const dir = mkDir();
    try {
      const evo = new EvolutionManager({ stateDir: dir });
      const rec = recorder();
      evo.setLearningReplicationEmitter(rec);
      evo.addLearning({ title: 'tmux colon', category: 'infra', description: 'd', source: { discoveredAt: '2026-06-01T00:00:00.000Z' } });
      expect(rec.puts).toContain('tmux colon');
      expect(rec.deletes).toHaveLength(0);
    } finally {
      cleanup(dir);
    }
  });

  it('PRUNE EMITS TOMBSTONE: a learning pruned over maxLearnings emits op:delete (no resurrection)', () => {
    const dir = mkDir();
    try {
      // maxLearnings=3, all unapplied. Adding the 4th prunes the OLDEST-by-keep-policy.
      // The prune policy keeps all unapplied; so to force a prune we must exceed with
      // applied entries trimmed. Use applied entries so the slice trims them.
      const evo = new EvolutionManager({ stateDir: dir, maxLearnings: 3 });
      const rec = recorder();
      evo.setLearningReplicationEmitter(rec);
      // 3 APPLIED learnings (so the prune keep-slice can drop the oldest applied).
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const l = evo.addLearning({ title: `lesson-${i}`, category: 'infra', description: 'd', source: { discoveredAt: `2026-06-0${i + 1}T00:00:00.000Z` } });
        ids.push(l.id);
        evo.markLearningApplied(l.id, 'EVO-x');
      }
      rec.puts.length = 0; rec.deletes.length = 0;
      // The 4th applied learning tips it over max=3 ⇒ the oldest applied (lesson-0) is pruned.
      const fourth = evo.addLearning({ title: 'lesson-3', category: 'infra', description: 'd', source: { discoveredAt: '2026-06-09T00:00:00.000Z' } });
      evo.markLearningApplied(fourth.id, 'EVO-y');
      // After the prune, fewer than 4 survive AND a tombstone fired for the pruned one.
      const survivors = evo.listLearnings().map((l) => l.title);
      expect(survivors).not.toContain('lesson-0'); // it was pruned
      expect(rec.deletes.map((d) => d.title)).toContain('lesson-0'); // tombstone emitted
    } finally {
      cleanup(dir);
    }
  });

  it('emit is best-effort: a throwing emitter NEVER breaks the local write', () => {
    const dir = mkDir();
    try {
      const evo = new EvolutionManager({ stateDir: dir });
      evo.setLearningReplicationEmitter({
        emitPut() { throw new Error('replication down'); },
        emitDelete() { throw new Error('replication down'); },
      });
      // The add must still persist despite the throwing emitter.
      const l = evo.addLearning({ title: 'resilient', category: 'infra', description: 'd', source: { discoveredAt: '2026-06-01T00:00:00.000Z' } });
      expect(l.id).toMatch(/^LRN-/);
      expect(evo.listLearnings().map((x) => x.title)).toContain('resilient');
    } finally {
      cleanup(dir);
    }
  });

  it('detach: passing undefined returns to single-machine no-op', () => {
    const dir = mkDir();
    try {
      const evo = new EvolutionManager({ stateDir: dir });
      const rec = recorder();
      evo.setLearningReplicationEmitter(rec);
      evo.setLearningReplicationEmitter(undefined);
      evo.addLearning({ title: 'detached', category: 'infra', description: 'd', source: { discoveredAt: '2026-06-01T00:00:00.000Z' } });
      expect(rec.puts).toHaveLength(0);
    } finally {
      cleanup(dir);
    }
  });
});

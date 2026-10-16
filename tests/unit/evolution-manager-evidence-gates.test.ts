import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EvolutionManager, LearningApplyError } from '../../src/core/EvolutionManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function mkDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evo-evidence-gates-'));
}

function cleanup(dir: string): void {
  SafeFsExecutor.safeRmSync(dir, {
    recursive: true,
    force: true,
    operation: 'tests/unit/evolution-manager-evidence-gates.test.ts',
  });
}

describe('EvolutionManager evidence and retention gates', () => {
  it('refuses to apply a consequence-bearing learning without consumer evidence', () => {
    const dir = mkDir();
    try {
      const evo = new EvolutionManager({ stateDir: dir });
      const learning = evo.addLearning({
        title: 'Guard prevents write',
        category: 'workflow',
        description: 'The guard prevents writes from landing.',
        source: { discoveredAt: '2026-09-06T00:00:00.000Z' },
      });

      expect(() => evo.markLearningApplied(learning.id, 'EVO-009')).toThrow(LearningApplyError);
    } finally {
      cleanup(dir);
    }
  });

  it('applies a consequence-bearing learning after consumer evidence is present', () => {
    const dir = mkDir();
    try {
      const evo = new EvolutionManager({ stateDir: dir });
      const learning = evo.addLearning({
        title: 'Guard prevents write',
        category: 'workflow',
        description: 'The guard prevents writes from landing.',
        source: { discoveredAt: '2026-09-06T00:00:00.000Z' },
        consumerEvidence: [{
          consumer: 'integration test route',
          observed: '422 before mutation',
          disconfirmation: '200 response',
          denominator: 'single apply request',
        }],
      });

      expect(evo.markLearningApplied(learning.id, 'EVO-009')).toBe(true);
      expect(evo.listLearnings({ applied: true })[0]?.id).toBe(learning.id);
    } finally {
      cleanup(dir);
    }
  });

  it('superseding a learning reopens its applied flag', () => {
    const dir = mkDir();
    try {
      const evo = new EvolutionManager({ stateDir: dir });
      const learning = evo.addLearning({
        title: 'Plain learning',
        category: 'workflow',
        description: 'No behavioral claim here.',
        source: { discoveredAt: '2026-09-06T00:00:00.000Z' },
      });
      expect(evo.markLearningApplied(learning.id, 'EVO-013')).toBe(true);
      expect(evo.supersedeLearning(learning.id, 'LRN-999', 'new evidence')).toBe(true);

      const reopened = evo.listLearnings({}).find((item) => item.id === learning.id)!;
      expect(reopened.applied).toBe(false);
      expect(reopened.appliedTo).toBeUndefined();
      expect(reopened.supersededBy).toBe('LRN-999');
    } finally {
      cleanup(dir);
    }
  });

  it('drops all terminal residue at and past a saturated active cap', () => {
    const dir = mkDir();
    try {
      const evo = new EvolutionManager({ stateDir: dir, maxActions: 2 });
      evo.addAction({ title: 'open 1', description: 'd' });
      evo.addAction({ title: 'open 2', description: 'd' });
      const done = evo.addAction({ title: 'done', description: 'd' });
      evo.updateAction(done.id, { status: 'completed' });

      const actions = evo.listActions({});
      expect(actions.map((a) => a.title)).toEqual(['open 1', 'open 2']);
      expect(actions).not.toContainEqual(expect.objectContaining({ title: 'done' }));
    } finally {
      cleanup(dir);
    }
  });
});

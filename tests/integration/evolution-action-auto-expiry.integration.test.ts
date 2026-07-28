import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EvolutionManager } from '../../src/core/EvolutionManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('evolution action auto-expiry integration', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'evolution-action-auto-expiry.integration.test.ts' });
    }
  });

  it('persists all eligible removals in one coalesced save', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-expiry-int-'));
    dirs.push(dir);
    const stateDir = path.join(dir, 'state', 'evolution');
    fs.mkdirSync(stateDir, { recursive: true });
    const actions = ['one', 'two', 'three'].map((title, index) => ({
      id: `ACT-00${index + 1}`,
      title,
      description: 'stale',
      priority: 'medium',
      status: 'pending',
      createdAt: '2026-01-01T00:00:00.000Z',
    }));
    fs.writeFileSync(path.join(stateDir, 'action-queue.json'), JSON.stringify({ actions, stats: {} }));

    const manager = new EvolutionManager({ stateDir: dir, autoExpiry: { enabled: false, maxAgeDays: 21, dryRun: false } });
    const save = vi.spyOn(manager as unknown as { saveActions: (...args: unknown[]) => void }, 'saveActions');
    expect(manager.runActionAutoExpirySweep()).toMatchObject({ eligible: 3, expired: 3 });
    expect(save).toHaveBeenCalledTimes(1);

    const persisted = JSON.parse(fs.readFileSync(path.join(stateDir, 'action-queue.json'), 'utf8')) as { actions: unknown[] };
    expect(persisted.actions).toEqual([]);
  });
});

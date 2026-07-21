import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BlockerLifecycleLedger } from '../../src/monitoring/BlockerLifecycleLedger.js';
import { BlockerLifecycleService } from '../../src/monitoring/BlockerLifecycleService.js';
import type { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import type { Initiative } from '../../src/core/InitiativeTracker.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('BlockerLifecycleService maturation evaluation', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach(dir => SafeFsExecutor.safeRmSync(dir, {
    recursive: true, force: true, operation: 'tests/unit/BlockerLifecycleMaturation.test.ts',
  })));

  it('evaluates every non-terminal rollout, including missing evidence and contract', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maturation-service-')); dirs.push(dir);
    const now = 2_000_000_000_000;
    const ledger = new BlockerLifecycleLedger({ dbPath: path.join(dir, 'ledger.db'), now: () => now });
    const events = new EventEmitter() as EventEmitter & { getAll(): never[]; update(): Promise<boolean>; getBlockerEpisodeDropBuckets(): Record<string, never> };
    events.getAll = () => [];
    events.update = async () => true;
    events.getBlockerEpisodeDropBuckets = () => ({});
    const service = new BlockerLifecycleService(events as unknown as CommitmentTracker, ledger, 'm1', () => now);
    const base = { title: 'x', description: 'x', status: 'active', phases: [], currentPhaseIndex: 0,
      lastTouchedAt: new Date(now).toISOString(), needsUser: false, blockers: [], links: [],
      createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), kind: 'task' } as const;
    const initiatives = [
      { ...base, id: 'with-contract', rollout: { flagPath: 'x', stage: 'dark', maturationEvaluation: {
        cadenceHours: 6, evidenceMaxAgeHours: 12, metrics: [{ id: 'coverage', source: 'blocker-summary',
          sourceRef: 'clear-latency.coverage', direction: 'at-least', threshold: 0.95, minSamples: 1 }],
      } } },
      { ...base, id: 'without-contract', rollout: { flagPath: 'y', stage: 'live' } },
      { ...base, id: 'terminal', rollout: { flagPath: 'z', stage: 'default-on' } },
    ] as Initiative[];
    expect(service.evaluateMaturation(initiatives)).toMatchObject({ eligible: 2 });
    expect(ledger.maturationEvaluations('m1', now - 24 * 3_600_000).map(r => [r.featureId, r.status])).toEqual([
      ['with-contract', 'insufficient-evidence'], ['without-contract', 'missing-contract'],
    ]);
    const summary = service.localSummary(24) as { maturation: { eligible: number; evaluated: number } };
    expect(summary.maturation).toMatchObject({ eligible: 2, evaluated: 2 });
    service.close();
  });
});

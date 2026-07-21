import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import { BlockerLifecycleLedger } from '../../src/monitoring/BlockerLifecycleLedger.js';
import { BlockerLifecycleService } from '../../src/monitoring/BlockerLifecycleService.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('BlockerLifecycleService deliverable throughput', () => {
  const dirs: string[] = [];
  const services: BlockerLifecycleService[] = [];
  afterEach(() => {
    services.splice(0).forEach(service => service.close());
    dirs.splice(0).forEach(dir => SafeFsExecutor.safeRmSync(dir, {
      recursive: true, force: true, operation: 'BlockerLifecycleService-throughput.test.ts',
    }));
  });

  function fixture(now: number) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blocker-throughput-')); dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'config.json'), '{}');
    const tracker = new CommitmentTracker({ stateDir: dir, liveConfig: new LiveConfig(dir),
      blockerLifecycleEnabled: true, originMachineId: 'machine-a' });
    const ledger = new BlockerLifecycleLedger({ dbPath: path.join(dir, 'ledger.db'), now: () => now });
    const service = new BlockerLifecycleService(tracker, ledger, 'machine-a', () => now);
    services.push(service);
    return { tracker, ledger, service };
  }

  it('counts the existing delivered event once and exposes a live non-zero summary', async () => {
    const now = Date.UTC(2026, 6, 21, 12);
    const { tracker, service } = fixture(now);
    const c = tracker.record({ userRequest: 'ship one deliverable', agentResponse: 'will ship',
      type: 'one-time-action', verificationMethod: 'manual' });
    expect(tracker.deliver(c.id)).not.toBeNull();
    await new Promise(resolve => setImmediate(resolve));
    const factor = (service.localSummary(24).factors as Array<Record<string, unknown>>)
      .find(row => row.factor === 'deliverable-completion');
    expect(factor).toMatchObject({ unit: 'count', completed: 1, total: 1, averagePerDay: 1,
      recoverability: 'reconcilable' });
  });

  it('reports a climbing count trend when the second half of a drive completes more deliverables', () => {
    const now = Date.UTC(2026, 6, 21, 12);
    const { ledger, service } = fixture(now);
    const todayStart = Date.UTC(2026, 6, 21);
    const daily = [1, 1, 1, 3, 4, 5];
    daily.forEach((count, dayIndex) => {
      const observedAtMs = todayStart - (6 - dayIndex) * 86_400_000 + 1_000;
      for (let i = 0; i < count; i++) ledger.record({ origin: 'machine-a',
        factor: 'deliverable-completion', sourceEventId: `day-${dayIndex}-${i}`,
        observedAtMs, latencyMs: null, outcome: 'observed' }, true);
    });
    const factor = (service.localTrend(7).factors as Array<Record<string, unknown>>)
      .find(row => row.factor === 'deliverable-completion');
    expect(factor).toMatchObject({ unit: 'count', direction: 'climbing', reason: null,
      firstHalf: { days: 3, total: 3, meanPerDay: 1 },
      secondHalf: { days: 3, total: 12, meanPerDay: 4 }, ratio: 4 });
  });
});

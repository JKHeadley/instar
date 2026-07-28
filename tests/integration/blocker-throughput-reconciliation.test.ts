import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import { BlockerLifecycleLedger } from '../../src/monitoring/BlockerLifecycleLedger.js';
import { BlockerLifecycleService } from '../../src/monitoring/BlockerLifecycleService.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('deliverable throughput reconciliation integration', () => {
  const dirs: string[] = [];
  const services: BlockerLifecycleService[] = [];

  afterEach(() => {
    vi.useRealTimers();
    services.splice(0).forEach(service => service.close());
    dirs.splice(0).forEach(dir => SafeFsExecutor.safeRmSync(dir, {
      recursive: true, force: true, operation: 'blocker-throughput-reconciliation.test.ts',
    }));
  });

  it('backfills a completion delivered before service startup and remains idempotent across restart', async () => {
    vi.useFakeTimers();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'throughput-reconcile-'));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'config.json'), '{}');
    const tracker = new CommitmentTracker({ stateDir: dir, liveConfig: new LiveConfig(dir),
      blockerLifecycleEnabled: true, originMachineId: 'machine-a' });
    // Put the real completion beyond the reconciler's 64-row slice boundary.
    // A startup pass must drain the bounded backlog without waiting five
    // minutes per slice before the live count can move.
    for (let index = 0; index < 70; index++) tracker.record({
      userRequest: `historical commitment ${String(index).padStart(2, '0')}`,
      agentResponse: 'recorded', type: 'behavioral', behavioralRule: `rule-${index}`,
    });
    const commitment = tracker.record({ userRequest: 'complete before metrics startup', agentResponse: 'done',
      type: 'one-time-action', verificationMethod: 'manual' });
    expect(tracker.deliver(commitment.id)).not.toBeNull();

    const dbPath = path.join(dir, 'blocker-lifecycle.db');
    const first = new BlockerLifecycleService(tracker, new BlockerLifecycleLedger({ dbPath }), 'machine-a');
    services.push(first);
    await vi.advanceTimersByTimeAsync(5_001);
    expect((first.localSummary(24).factors as Array<Record<string, unknown>>)
      .find(row => row.factor === 'deliverable-completion')).toMatchObject({ total: 1, completed: 1 });
    first.close();
    services.pop();

    const second = new BlockerLifecycleService(tracker, new BlockerLifecycleLedger({ dbPath }), 'machine-a');
    services.push(second);
    await vi.advanceTimersByTimeAsync(5_001);
    expect((second.localSummary(24).factors as Array<Record<string, unknown>>)
      .find(row => row.factor === 'deliverable-completion')).toMatchObject({ total: 1, completed: 1 });
  });
});
// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

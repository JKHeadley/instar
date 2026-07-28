/**
 * Wiring-integrity unit test (TESTING-INTEGRITY-SPEC — "verify deps are not null,
 * not no-ops, and delegate to real implementations") for the increment-2 factory
 * makeSingleMachineFailoverGapDetector: fake managers → a real gap → the adapted
 * attention-item shape the real TelegramAdapter.createAttentionItem consumes.
 */
import { describe, it, expect } from 'vitest';
import { makeSingleMachineFailoverGapDetector, type FailoverGapAttentionItemInput } from '../../src/monitoring/singleMachineFailoverGapWiring.js';
import { SINGLE_MACHINE_FAILOVER_GAP_DEDUP_KEY } from '../../src/monitoring/SingleMachineFailoverGapDetector.js';

describe('makeSingleMachineFailoverGapDetector (factory dep mapping)', () => {
  it('maps a single-machine + active-work gap into the real attention-item shape', () => {
    const raised: FailoverGapAttentionItemInput[] = [];
    const detector = makeSingleMachineFailoverGapDetector({
      enabled: () => true,
      dryRun: () => false, // live → actually raises
      // only self online → onlinePeerCount 0 → single-machine
      getCapacities: () => [
        { machineId: 'self', online: true },
        { machineId: 'peer', online: false }, // offline peer → not counted
      ],
      selfMachineId: () => 'self',
      multiMachineEnabled: () => true, // configured → 'peer-offline' mode
      getActiveAutonomousRunCount: () => 2, // active work needing a failover target
      createAttentionItem: (item) => { raised.push(item); },
    });

    const r = detector.tick();
    expect(r.gapDetected).toBe(true);
    expect(r.mode).toBe('peer-offline');
    expect(r.raised).toBe(true);

    expect(raised).toHaveLength(1);
    const item = raised[0];
    // The load-bearing adaptation: dedupKey→id, body→summary, source→sourceContext,
    // category 'monitoring', priority HIGH.
    expect(item.id).toBe(SINGLE_MACHINE_FAILOVER_GAP_DEDUP_KEY);
    expect(item.category).toBe('monitoring');
    expect(item.priority).toBe('HIGH');
    expect(item.sourceContext).toBe('single-machine-failover-gap');
    expect(item.title).toBe('No failover target for active autonomous work');
    expect(item.summary).toContain('2 autonomous runs'); // body carries the count
  });

  it('online peer present → NOT single-machine → no gap, no attention raised', () => {
    const raised: FailoverGapAttentionItemInput[] = [];
    const detector = makeSingleMachineFailoverGapDetector({
      enabled: () => true,
      dryRun: () => false,
      getCapacities: () => [
        { machineId: 'self', online: true },
        { machineId: 'peer', online: true }, // a live failover target
      ],
      selfMachineId: () => 'self',
      multiMachineEnabled: () => true,
      getActiveAutonomousRunCount: () => 3,
      createAttentionItem: (item) => { raised.push(item); },
    });

    const r = detector.tick();
    expect(r.gapDetected).toBe(false);
    expect(raised).toHaveLength(0);
  });

  it('dryRun on a real gap → computes the verdict but raises NOTHING', () => {
    const raised: FailoverGapAttentionItemInput[] = [];
    const detector = makeSingleMachineFailoverGapDetector({
      enabled: () => true,
      dryRun: () => true, // first rung — count would-raise, raise nothing
      getCapacities: () => [{ machineId: 'self', online: true }],
      selfMachineId: () => 'self',
      multiMachineEnabled: () => false, // not-configured mode
      getActiveAutonomousRunCount: () => 1,
      createAttentionItem: (item) => { raised.push(item); },
    });

    const r = detector.tick();
    expect(r.gapDetected).toBe(true);
    expect(r.mode).toBe('not-configured');
    expect(r.raised).toBe(false);
    expect(raised).toHaveLength(0);
    expect(detector.status().counters.wouldRaise).toBe(1);
  });

  it('disabled gate → strict no-op (never reads managers, never raises)', () => {
    let capacityReads = 0;
    const detector = makeSingleMachineFailoverGapDetector({
      enabled: () => false,
      dryRun: () => false,
      getCapacities: () => { capacityReads += 1; return []; },
      selfMachineId: () => 'self',
      multiMachineEnabled: () => true,
      getActiveAutonomousRunCount: () => 5,
      createAttentionItem: () => { throw new Error('must not raise while dark'); },
    });

    const r = detector.tick();
    expect(r.ran).toBe(false);
    expect(capacityReads).toBe(0);
  });
});

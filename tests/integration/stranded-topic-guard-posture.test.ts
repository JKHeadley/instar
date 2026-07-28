/**
 * stranded-inbound-self-heal — integration: the StrandedTopicSentinel is visible
 * through its REAL surfaces and its detection→attention pipeline works end-to-end.
 *
 * Tier 2 (integration) for the testing-integrity standard. Exercises:
 *  (a) the GUARD_MANIFEST entry + deriveGuardRow (the EXACT path GET /guards uses),
 *      so a running sentinel grades correctly and a disabled one is not falsely OK;
 *  (b) the live detection→attention pipeline: a stranded fixture, ticked across the
 *      dwell, raises ONE aggregated agent-health attention item through the real
 *      sentinel (with a captured raiseAttention), naming the topic, owner, reason,
 *      servable-peer state, and signal staleness — and NOT before the dwell.
 */
import { describe, it, expect } from 'vitest';

import { StrandedTopicSentinel, type StrandAttentionItem } from '../../src/monitoring/StrandedTopicSentinel.js';
import { GUARD_MANIFEST } from '../../src/monitoring/guardManifest.js';
import { deriveGuardRow } from '../../src/monitoring/guardPostureView.js';
import type { MachineCapacity } from '../../src/core/types.js';
import type { SessionOwnershipRecord } from '../../src/core/SessionOwnership.js';

const KEY = 'monitoring.strandedTopicSentinel.enabled';

const manifestEntry = () => {
  const e = GUARD_MANIFEST.find((m) => m.key === KEY);
  if (!e) throw new Error('StrandedTopicSentinel GUARD_MANIFEST entry missing');
  return e;
};

/** A fixture mesh: this machine ('self', lease-holder) + a quota-walled peer ('mini'). */
function walledFixture(clock: () => number) {
  const records: SessionOwnershipRecord[] = [
    {
      sessionKey: '28130',
      ownerMachineId: 'mini',
      ownershipEpoch: 2,
      status: 'active',
      nonce: 'x',
      timestamp: 0,
      updatedAt: new Date(0).toISOString(),
    } as SessionOwnershipRecord,
  ];
  // Fresh rich beats recomputed per call so the beat never goes stale as the clock advances.
  const capacities = (): MachineCapacity[] => [
    { machineId: 'self', online: true, routerReceivedAt: new Date(clock() - 1000).toISOString() } as MachineCapacity,
    {
      machineId: 'mini',
      online: true,
      quotaState: { blocked: true },
      servesChannels: { telegram: { chatIds: ['c1'] } },
      routerReceivedAt: new Date(clock() - 1000).toISOString(),
    } as MachineCapacity,
  ];
  return { records, capacities };
}

describe('StrandedTopicSentinel — guard posture (Tier 2)', () => {
  it('has a well-formed GUARD_MANIFEST entry (component + expectRuntime + config path)', () => {
    const e = manifestEntry();
    expect(e.component).toBe('StrandedTopicSentinel');
    expect(e.expectRuntime).toBe(true);
    expect(e.configPath).toBe(KEY);
    expect(e.defaultEnabled).toBe(false); // dark on the fleet
  });

  it('a running (dev-gated ON) sentinel grades on /guards and is NOT off-runtime-divergent', () => {
    let now = 1_700_000_000_000;
    const sentinel = new StrandedTopicSentinel(
      {
        listOwnershipRecords: () => [],
        listCapacities: () => [],
        selfMachineId: () => 'self',
        holdsLease: () => true,
        raiseAttention: () => {},
        now: () => now,
      },
      { enabled: true, tickMs: 60_000 },
    );
    sentinel.start();
    sentinel.tick();
    const status = sentinel.guardStatus();
    expect(status.enabled).toBe(true);
    expect(status.lastTickAt).toBe(now);

    const entry = manifestEntry();
    const row = deriveGuardRow({
      key: entry.key,
      manifest: entry,
      configEnabled: true,
      defaultEnabled: entry.defaultEnabled,
      bootValue: true,
      bootSnapshotAvailable: true,
      runtime: { kind: 'ok', status: { enabled: status.enabled, lastTickAt: status.lastTickAt } },
      now,
    });
    expect(row.effective).not.toBe('off-runtime-divergent');
    sentinel.stop();
  });

  it('detection→attention pipeline: raises ONE aggregated item AFTER the dwell, not before', () => {
    let now = 1_700_000_000_000;
    const dwellMs = 30_000;
    const raised: StrandAttentionItem[] = [];
    const { records, capacities } = walledFixture(() => now);

    const sentinel = new StrandedTopicSentinel(
      {
        listOwnershipRecords: () => records,
        listCapacities: capacities,
        selfMachineId: () => 'self',
        holdsLease: () => true,
        raiseAttention: (item) => raised.push(item),
        nicknameOf: (id) => (id === 'mini' ? 'Mac Mini' : id),
        now: () => now,
      },
      { enabled: true, tickMs: 60_000, dwellMs, freshnessBoundMs: 45_000 },
    );
    sentinel.start();

    // Tick 1: qualifies but dwell not yet met → recorded, NOT emitted.
    sentinel.tick();
    expect(raised).toHaveLength(0);

    // Tick 2, past the dwell: emitted exactly once, aggregated.
    now += dwellMs + 1_000;
    sentinel.tick();
    expect(raised).toHaveLength(1);
    const item = raised[0];
    expect(item.priority).toBe('NORMAL'); // rides the flood ceiling, never bypasses
    expect(item.lane).toBe('agent-health');
    expect(item.description).toContain('28130');
    expect(item.description).toContain('Mac Mini');
    expect(item.description.toLowerCase()).toContain('quota'); // the reason
    expect(item.description.toLowerCase()).toContain('heartbeat'); // staleness disclosure
    expect(item.id).toContain('mini'); // dedup keyed on owner

    sentinel.stop();
  });

  it('single-machine (no peer) raises nothing — strict no-op', () => {
    let now = 1_700_000_000_000;
    const raised: StrandAttentionItem[] = [];
    const sentinel = new StrandedTopicSentinel(
      {
        listOwnershipRecords: () => [
          { sessionKey: '1', ownerMachineId: 'self', ownershipEpoch: 1, status: 'active', nonce: 'x', timestamp: 0, updatedAt: '' } as SessionOwnershipRecord,
        ],
        listCapacities: () => [{ machineId: 'self', online: true, routerReceivedAt: new Date(now).toISOString() } as MachineCapacity],
        selfMachineId: () => 'self',
        holdsLease: () => true,
        raiseAttention: (item) => raised.push(item),
        now: () => now,
      },
      { enabled: true },
    );
    sentinel.tick();
    expect(raised).toHaveLength(0);
  });
});

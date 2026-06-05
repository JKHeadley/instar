/**
 * Tier-1 tests for MachinePoolRegistry (Multi-Machine Session Pool §L2):
 * hardware capture, the clock-skew quarantine FSM (both sides of every
 * boundary), and the capacity assembly (router-clock liveness, not self-report).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  captureHardware,
  clockSkewTransition,
  isPlacementEligibleByClock,
  INITIAL_CLOCK_SKEW_STATE,
  MachinePoolRegistry,
  type ClockSkewFsmState,
} from '../../src/core/MachinePoolRegistry.js';

describe('captureHardware', () => {
  it('captures platform/arch/cpu/mem/hostname from os', () => {
    const hw = captureHardware('1.3.75');
    expect(typeof hw.platform).toBe('string');
    expect(typeof hw.arch).toBe('string');
    expect(hw.cpuCores).toBeGreaterThan(0);
    expect(hw.totalMemBytes).toBeGreaterThan(0);
    expect(hw.hostname.length).toBeGreaterThan(0);
    expect(hw.instarVersion).toBe('1.3.75');
  });
});

describe('clockSkewTransition (§L2 FSM — both sides of each boundary)', () => {
  const ok: ClockSkewFsmState = { status: 'ok', removedCleanCount: 0 };

  it('ok + in-tolerance stays ok (no side effect)', () => {
    expect(clockSkewTransition(ok, false)).toEqual({ next: ok, sideEffect: 'none' });
  });
  it('ok + divergent arms divergence-detected-once (logged, NOT removed)', () => {
    const r = clockSkewTransition(ok, true);
    expect(r.next.status).toBe('divergence-detected-once');
    expect(r.sideEffect).toBe('logged');
  });
  it('a SINGLE divergent beat then a clean beat resets to ok (forgiven)', () => {
    const armed = clockSkewTransition(ok, true).next;
    const r = clockSkewTransition(armed, false);
    expect(r.next.status).toBe('ok');
    expect(r.sideEffect).toBe('reset');
  });
  it('2 consecutive divergent beats → removed + side effect "removed"', () => {
    const armed = clockSkewTransition(ok, true).next;
    const r = clockSkewTransition(armed, true);
    expect(r.next.status).toBe('suspect-clock-removed');
    expect(r.sideEffect).toBe('removed');
  });
  it('removed + divergent stays removed, clean-count reset', () => {
    const removed: ClockSkewFsmState = { status: 'suspect-clock-removed', removedCleanCount: 1 };
    const r = clockSkewTransition(removed, true);
    expect(r.next).toEqual({ status: 'suspect-clock-removed', removedCleanCount: 0 });
    expect(r.sideEffect).toBe('none');
  });
  it('removed needs 2 consecutive clean beats to re-admit', () => {
    let s: ClockSkewFsmState = { status: 'suspect-clock-removed', removedCleanCount: 0 };
    const first = clockSkewTransition(s, false); // 1st clean
    expect(first.next.status).toBe('suspect-clock-removed');
    expect(first.next.removedCleanCount).toBe(1);
    expect(first.sideEffect).toBe('none');
    const second = clockSkewTransition(first.next, false); // 2nd clean
    expect(second.next.status).toBe('ok');
    expect(second.sideEffect).toBe('re-admitted');
  });

  it('isPlacementEligibleByClock excludes only suspect-clock-removed', () => {
    expect(isPlacementEligibleByClock('ok')).toBe(true);
    expect(isPlacementEligibleByClock('divergence-detected-once')).toBe(true);
    expect(isPlacementEligibleByClock('suspect-clock-removed')).toBe(false);
  });
});

describe('MachinePoolRegistry', () => {
  const machines = [
    { machineId: 'm_a', nickname: 'Mac Mini', capabilities: ['gpu'] },
    { machineId: 'm_b', nickname: 'Laptop' },
  ];
  function mk(now: () => number, onQuarantine = vi.fn()) {
    return new MachinePoolRegistry({
      listMachines: () => machines,
      clockSkewToleranceMs: 300_000,
      failoverThresholdMs: 60_000,
      now,
      onClockQuarantine: onQuarantine,
    });
  }

  it('liveness uses routerReceivedAt (router clock), not self-reported time', () => {
    let now = 1_000_000;
    const reg = mk(() => now);
    // Machine reports a far-FUTURE self time, but the router stamps receipt at `now`.
    reg.recordHeartbeat({ machineId: 'm_a', selfReportedLastSeen: new Date(now + 9_000_000).toISOString() });
    let cap = reg.getCapacity('m_a')!;
    expect(cap.online).toBe(true); // fresh by router clock
    // Advance the router clock past the failover threshold → offline.
    now += 120_000;
    cap = reg.getCapacity('m_a')!;
    expect(cap.online).toBe(false);
  });

  it('assembles nickname + capabilities from the registry, load from the heartbeat', () => {
    const now = 5_000_000;
    const reg = mk(() => now);
    reg.recordHeartbeat({ machineId: 'm_a', selfReportedLastSeen: new Date(now).toISOString(), loadAvg: 2.5, activeSessionCount: 3, maxSessions: 10 });
    const cap = reg.getCapacity('m_a')!;
    expect(cap.nickname).toBe('Mac Mini');
    expect(cap.capabilities).toEqual(['gpu']);
    expect(cap.loadAvg).toBe(2.5);
    expect(cap.activeSessionCount).toBe(3);
    expect(cap.clockSkewStatus).toBe('ok');
  });

  it('quarantines a clock-divergent machine after 2 beats and excludes it from placement', () => {
    let now = 1_000_000;
    const onQ = vi.fn();
    const reg = mk(() => now, onQ);
    // Heartbeat 1: self time diverges by 10 min (> 5 min tolerance).
    reg.recordHeartbeat({ machineId: 'm_a', selfReportedLastSeen: new Date(now + 600_000).toISOString() });
    expect(reg.clockSkewStatus('m_a')).toBe('divergence-detected-once');
    expect(reg.isPlacementEligible('m_a')).toBe(true); // armed, still eligible
    // Heartbeat 2 (still divergent) → removed.
    now += 1000;
    reg.recordHeartbeat({ machineId: 'm_a', selfReportedLastSeen: new Date(now + 600_000).toISOString() });
    expect(reg.clockSkewStatus('m_a')).toBe('suspect-clock-removed');
    expect(reg.isPlacementEligible('m_a')).toBe(false);
    expect(onQ).toHaveBeenCalledTimes(1);
    // 2 clean beats → re-admitted.
    now += 1000;
    reg.recordHeartbeat({ machineId: 'm_a', selfReportedLastSeen: new Date(now).toISOString() });
    now += 1000;
    reg.recordHeartbeat({ machineId: 'm_a', selfReportedLastSeen: new Date(now).toISOString() });
    expect(reg.clockSkewStatus('m_a')).toBe('ok');
    expect(reg.isPlacementEligible('m_a')).toBe(true);
  });

  it('getCapacities returns every known machine; unseen machine is offline + ok', () => {
    const now = 1_000_000;
    const reg = mk(() => now);
    reg.recordHeartbeat({ machineId: 'm_a', selfReportedLastSeen: new Date(now).toISOString() });
    const caps = reg.getCapacities();
    expect(caps.map((c) => c.machineId).sort()).toEqual(['m_a', 'm_b']);
    const b = caps.find((c) => c.machineId === 'm_b')!;
    expect(b.online).toBe(false); // never sent a heartbeat
    expect(b.clockSkewStatus).toBe('ok');
    expect(b.nickname).toBe('Laptop');
  });

  it('getCapacity returns null for a machine not in the registry', () => {
    const reg = mk(() => 1_000_000);
    expect(reg.getCapacity('m_unknown')).toBeNull();
  });
});

describe('MachinePoolRegistry — quotaState passthrough (quota-aware placement)', () => {
  it('a heartbeat-reported quotaState surfaces on the assembled MachineCapacity', () => {
    const machines = [{ machineId: 'm1', nickname: 'Laptop' }];
    let now = 1_000_000;
    const reg = new MachinePoolRegistry({
      listMachines: () => machines,
      clockSkewToleranceMs: 60_000,
      failoverThresholdMs: 120_000,
      now: () => now,
    });
    reg.recordHeartbeat({
      machineId: 'm1',
      selfReportedLastSeen: new Date(now).toISOString(),
      loadAvg: 1.5,
      quotaState: { blocked: true, blockedUntil: '2099-01-01T00:00:00Z', reason: '5-hour window at 100%' },
    });
    const cap = reg.getCapacity('m1');
    expect(cap?.quotaState).toEqual({ blocked: true, blockedUntil: '2099-01-01T00:00:00Z', reason: '5-hour window at 100%' });

    // A later heartbeat WITHOUT quotaState clears it (unknown ≠ blocked).
    now += 1000;
    reg.recordHeartbeat({ machineId: 'm1', selfReportedLastSeen: new Date(now).toISOString(), loadAvg: 1.2 });
    expect(reg.getCapacity('m1')?.quotaState).toBeUndefined();
  });
});

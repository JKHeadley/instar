import { observeTrialTeardown } from '../../../src/localVerify/smallPeerWatchdog.js';
import { describe, expect, it, vi } from 'vitest';
import { parseSmallPeerMemory, smallPeerMemoryAllows, smallPeerMemoryStopReason } from '../../../src/localVerify/smallPeerMemory.js';

const native = 'Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free: 10.\nPages inactive: 12.\nPages purgeable: 3.\n';
describe('small peer memory measurement', () => {
  it.each([null, parseSmallPeerMemory(native, '2', 100)])('consumes the final probe when cleanup finishes before its result (%j)', async sample => {
    let finishProbe!: (value: typeof sample) => void;
    const memory = new Promise<typeof sample>(resolve => { finishProbe = resolve; });
    const onMemory = vi.fn();
    const scope = { stop: vi.fn(async () => {}), sample: vi.fn(() => ({ rssBytes: 10, members: [] })) };
    const pending = observeTrialTeardown(scope, () => memory, onMemory, vi.fn());
    await Promise.resolve(); // The scope has stopped, while its host-memory read is still outstanding.
    expect(scope.stop).toHaveBeenCalledOnce();
    expect(onMemory).not.toHaveBeenCalled();
    finishProbe(sample);
    await pending;
    expect(onMemory).toHaveBeenCalledOnce();
    expect(onMemory).toHaveBeenCalledWith(sample);
    expect(scope.sample).not.toHaveBeenCalled();
  });

  it('distinguishes measured pressure and low memory from lost or stale telemetry after a healthy sample', () => {
    const sample = parseSmallPeerMemory(native, '1', 100)!;
    expect(smallPeerMemoryStopReason(sample, 4096, 100)).toBeNull();
    expect(smallPeerMemoryStopReason(null, 4096, 1100)).toBe('measurement-failed');
    expect(smallPeerMemoryStopReason(sample, 4096, 2100)).toBe('measurement-failed');
    expect(smallPeerMemoryStopReason({ ...sample, pressureLevel: 2 }, 4096, 1100)).toBe('memory');
    expect(smallPeerMemoryStopReason({ ...sample, availableBytes: 4096 }, 4096, 1100)).toBe('memory');
  });

  it('uses the reported page size and all three available page counts', () => {
    expect(parseSmallPeerMemory(native, '1\n', 100)?.availableBytes).toBe(25 * 4096);
  });
  it('refuses missing and invalid telemetry', () => {
    expect(parseSmallPeerMemory(native.replace('Pages inactive: 12.', ''), '1', 0)).toBeNull();
    expect(parseSmallPeerMemory(native, '', 0)).toBeNull();
    expect(parseSmallPeerMemory(native.replace('4096 bytes', 'unknown'), '1', 0)).toBeNull();
    expect(smallPeerMemoryAllows(null, 1, 0)).toBe(false);
  });
  it('requires fresh memory above the floor with normal native pressure', () => {
    const sample = parseSmallPeerMemory(native, '1', 1);
    expect(smallPeerMemoryAllows(sample, 102399, 2000)).toBe(true);
    expect(smallPeerMemoryAllows(sample, 102400, 10)).toBe(false);
    expect(smallPeerMemoryAllows(sample, 102399, 2001)).toBe(false);
    expect(smallPeerMemoryAllows(parseSmallPeerMemory(native, '2', 1), 1, 2)).toBe(false);
  });
});

import { SMALL_PEER_COLLECTOR, parseSmallPeerTrialPolicy, smallPeerStartHasHeadroom, validSmallPeerHeartbeat } from '../../../src/localVerify/smallPeerMemory.js';
describe('bounded trial policy and observation identity', () => {
  const policy = { version: 1, machineId: 'm_' + 'a'.repeat(32), collector: SMALL_PEER_COLLECTOR,
    floorBytes: 8192, reserveBytes: 4096, recoveryMs: 2000, unitWorkers: 2, integration: 1, e2e: 1 };
  it('accepts only an exact calibrated contract', () => {
    expect(parseSmallPeerTrialPolicy(policy)).toEqual(policy);
    const oneWorker = { ...policy, unitWorkers: 1 };
    expect(parseSmallPeerTrialPolicy(oneWorker)).toEqual(oneWorker);
    for (const bad of [null, { ...policy, e2e: 2 }, { ...policy, unitWorkers: 0 }, { ...policy, unitWorkers: 3 }, { ...policy, future: true }, { ...policy, reserveBytes: 8192 },
      { ...policy, machineId: 'any' }, { ...policy, collector: 'unknown' }]) expect(parseSmallPeerTrialPolicy(bad)).toBeNull();
  });
  it('binds the optional admission floor without changing the runtime floor', () => {
    const gated = { ...policy, startFloorBytes: 7500000000 };
    expect(parseSmallPeerTrialPolicy(gated)).toEqual(gated);
    for (const startFloorBytes of [policy.floorBytes, -1, undefined, '7500000000']) {
      expect(parseSmallPeerTrialPolicy({ ...policy, startFloorBytes })).toBeNull();
    }
  });

  it.each([
    { label: 'sustained margin', dip: false, gap: false, allowed: true },
    { label: 'brief dip', dip: true, gap: false, allowed: false },
    { label: 'stale interval', dip: false, gap: true, allowed: false },
  ])('checks $label before launch', async ({ dip, gap, allowed }) => {
    let tick = 0;
    const gated = parseSmallPeerTrialPolicy({ ...policy, startFloorBytes: 7500000000 })!;
    const read = vi.fn(async () => ({
      collector: SMALL_PEER_COLLECTOR,
      sampledAt: tick,
      pressureLevel: 1,
      availableBytes: dip && tick === 1000 ? 7499999999 : 7600000000,
    }));
    const wait = vi.fn(async () => { tick += gap ? 2000 : 1000; });
    expect(await smallPeerStartHasHeadroom(gated, read, () => tick, wait)).toBe(allowed);
    expect(read).toHaveBeenCalledTimes(allowed ? 4 : 2);
    expect(tick).toBe(allowed ? 3000 : gap ? 2000 : 1000);
  });

  it('a heartbeat cannot mask a stale, repeated or foreign sample', () => {
    const sample = { attemptId: 'abc', sequence: 1, requestedAt: 1000 };
    expect(validSmallPeerHeartbeat('abc', null, sample, 2999)).toBe(true);
    expect(validSmallPeerHeartbeat('abc', null, sample, 3000)).toBe(false);
    expect(validSmallPeerHeartbeat('abc', sample, sample, 1001)).toBe(false);
    expect(validSmallPeerHeartbeat('def', null, sample, 1001)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { parseSmallPeerMemory, smallPeerMemoryAllows } from '../../../src/localVerify/smallPeerMemory.js';

const native = 'Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free: 10.\nPages inactive: 12.\nPages purgeable: 3.\n';
describe('small peer memory measurement', () => {
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

import { SMALL_PEER_COLLECTOR, parseSmallPeerTrialPolicy, validSmallPeerHeartbeat } from '../../../src/localVerify/smallPeerMemory.js';
describe('bounded trial policy and observation identity', () => {
  const policy = { version: 1, machineId: 'm_' + 'a'.repeat(32), collector: SMALL_PEER_COLLECTOR,
    floorBytes: 8192, reserveBytes: 4096, recoveryMs: 2000, unitWorkers: 2, integration: 1, e2e: 1 };
  it('accepts only an exact calibrated contract', () => {
    expect(parseSmallPeerTrialPolicy(policy)).toEqual(policy);
    for (const bad of [null, { ...policy, e2e: 2 }, { ...policy, future: true }, { ...policy, reserveBytes: 8192 },
      { ...policy, machineId: 'any' }, { ...policy, collector: 'unknown' }]) expect(parseSmallPeerTrialPolicy(bad)).toBeNull();
  });
  it('a heartbeat cannot mask a stale, repeated or foreign sample', () => {
    const sample = { attemptId: 'abc', sequence: 1, requestedAt: 1000 };
    expect(validSmallPeerHeartbeat('abc', null, sample, 2999)).toBe(true);
    expect(validSmallPeerHeartbeat('abc', null, sample, 3000)).toBe(false);
    expect(validSmallPeerHeartbeat('abc', sample, sample, 1001)).toBe(false);
    expect(validSmallPeerHeartbeat('def', null, sample, 1001)).toBe(false);
  });
});

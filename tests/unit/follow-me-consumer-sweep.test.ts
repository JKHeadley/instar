// safe-git-allow: test file — fs.rmSync is per-test tmpdir cleanup, no production path
/**
 * runFollowMeConsumerSweep — the missing-caller connector sweep (convergence #1).
 * Uses the REAL single-flight ledger (temp file) + a mock drive, to prove: it drives
 * fresh mandates, skips completed (no re-mint), skips live in-flight, and retries failed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AccountFollowMeSingleFlight, singleFlightKey } from '../../src/coordination/AccountFollowMeSingleFlight.js';
import { runFollowMeConsumerSweep } from '../../src/coordination/followMeConsumerSweep.js';

let dir: string;
let clock = 1_000_000;
const sf = () => new AccountFollowMeSingleFlight({ filePath: path.join(dir, 'sf.json'), now: () => clock });

const delivered = (accountId: string, targetMachineId: string, mandateId: string) => ({
  mandateId, expiresAt: new Date(9e12).toISOString(), bounds: { accountId, targetMachineId },
});

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-')); clock = 1_000_000; });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('runFollowMeConsumerSweep', () => {
  it('drives a fresh delivered mandate (the missing caller now exists)', async () => {
    const singleFlight = sf();
    const driven: string[] = [];
    const r = await runFollowMeConsumerSweep({
      listDelivered: () => [delivered('adriana', 'm_4cbc', 'm1')],
      singleFlight,
      drive: async (input) => { driven.push(input.mandateId); return { ok: true, state: 'login-issued', login: { verificationUrl: 'u', userCode: 'c', ttlMs: 1 } }; },
      eventIdFor: (id) => `evt-${id}`,
    });
    expect(driven).toEqual(['m1']);
    expect(r.driven).toBe(1);
    expect(r.considered).toBe(1);
  });

  it('SKIPS a completed mandate — never re-drives (no re-mint)', async () => {
    const singleFlight = sf();
    const key = singleFlightKey('adriana', 'm_4cbc');
    singleFlight.tryClaim({ accountId: 'adriana', targetMachineId: 'm_4cbc', frontingMachineId: 'f', mandateId: 'm1', holder: 'h', ttlMs: 60000 });
    singleFlight.transition(key, 'login-issued', 'h', { ttlMs: 60000 });
    singleFlight.transition(key, 'completed', 'h');
    let driveCalled = false;
    const r = await runFollowMeConsumerSweep({
      listDelivered: () => [delivered('adriana', 'm_4cbc', 'm1')],
      singleFlight,
      drive: async () => { driveCalled = true; return { ok: true, state: 'login-issued', login: { verificationUrl: 'u', userCode: 'c', ttlMs: 1 } }; },
      eventIdFor: (id) => id,
    });
    expect(driveCalled).toBe(false);
    expect(r.skippedCompleted).toBe(1);
    expect(r.driven).toBe(0);
  });

  it('SKIPS a live in-flight mandate (owned by its holder)', async () => {
    const singleFlight = sf();
    singleFlight.tryClaim({ accountId: 'adriana', targetMachineId: 'm_4cbc', frontingMachineId: 'f', mandateId: 'm1', holder: 'h', ttlMs: 60000 });
    let driveCalled = false;
    const r = await runFollowMeConsumerSweep({
      listDelivered: () => [delivered('adriana', 'm_4cbc', 'm1')],
      singleFlight,
      drive: async () => { driveCalled = true; return { ok: false, state: 'in-flight', reason: 'x' }; },
      eventIdFor: (id) => id,
    });
    expect(driveCalled).toBe(false);
    expect(r.skippedInFlight).toBe(1);
  });

  it('drives a failed mandate (retry) and handles multiple delivered at once', async () => {
    const singleFlight = sf();
    const k = singleFlightKey('failacct', 'm_x');
    singleFlight.tryClaim({ accountId: 'failacct', targetMachineId: 'm_x', frontingMachineId: 'f', mandateId: 'mf', holder: 'h', ttlMs: 60000 });
    singleFlight.transition(k, 'failed', 'h');
    const driven: string[] = [];
    const r = await runFollowMeConsumerSweep({
      listDelivered: () => [delivered('adriana', 'm_4cbc', 'm1'), delivered('failacct', 'm_x', 'mf')],
      singleFlight,
      drive: async (i) => { driven.push(i.mandateId); return { ok: true, state: 'login-issued', login: { verificationUrl: 'u', userCode: 'c', ttlMs: 1 } }; },
      eventIdFor: (id) => id,
    });
    expect(driven.sort()).toEqual(['m1', 'mf']); // fresh + failed-retry both driven
    expect(r.driven).toBe(2);
  });

  it('ignores malformed delivered entries (no bounds)', async () => {
    const r = await runFollowMeConsumerSweep({
      listDelivered: () => [{ mandateId: 'bad', expiresAt: new Date(9e12).toISOString(), bounds: { accountId: '', targetMachineId: '' } }],
      singleFlight: sf(),
      drive: async () => { throw new Error('should not be called'); },
      eventIdFor: (id) => id,
    });
    expect(r.driven).toBe(0);
  });
});

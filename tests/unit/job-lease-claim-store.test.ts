/**
 * Unit tests — JobLeaseClaimStore (WS4.3 durable, epoch-fenced job leases).
 *
 * Load-bearing invariant: epoch fencing prevents a demoted machine's stale
 * claim from stealing a job (no double-run across a cutover/demotion), and a
 * peer's fresher-epoch claim correctly supersedes. Adversarial: stale-epoch
 * remote apply, equal-epoch tie, expiry, durable round-trip.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobLeaseClaimStore, type JobLeaseClaim } from '../../src/scheduler/JobLeaseClaimStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let dir: string;
let clock = 1_000_000;
const now = () => clock;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-store-'));
  clock = 1_000_000;
});
afterEach(() => {
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/job-lease-claim-store.test.ts' });
});

const store = (machineId: string) => new JobLeaseClaimStore({ machineId, stateDir: dir, now });

describe('JobLeaseClaimStore', () => {
  it('takes a lease and reports it active; idempotent re-claim returns existing', () => {
    const s = store('m1');
    const a = s.tryClaim('job-a', 1);
    expect(a.ok).toBe(true);
    const b = s.tryClaim('job-a', 1);
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.reason).toBe('already-own');
    expect(s.getActiveClaims().map(c => c.jobSlug)).toEqual(['job-a']);
  });

  it('a peer holding a live lease blocks our same/older-epoch claim', () => {
    const s = store('m1');
    s.applyRemote({
      claimId: 'lease_peer', jobSlug: 'job-a', machineId: 'm2', epoch: 5,
      claimedAt: new Date(now()).toISOString(),
      expiresAt: new Date(now() + 60_000).toISOString(), completed: false,
    });
    expect(s.hasRemoteClaim('job-a')).toBe(true);
    const same = s.tryClaim('job-a', 5);
    expect(same.ok).toBe(false);
    if (!same.ok) expect(same.reason).toBe('held-by-peer');
  });

  it('EPOCH FENCE: our strictly-newer epoch supersedes a peer lease (demotion → re-take)', () => {
    const s = store('m1');
    s.applyRemote({
      claimId: 'lease_peer', jobSlug: 'job-a', machineId: 'm2', epoch: 5,
      claimedAt: new Date(now()).toISOString(),
      expiresAt: new Date(now() + 60_000).toISOString(), completed: false,
    });
    const taken = s.tryClaim('job-a', 6); // our epoch advanced past the demoted peer
    expect(taken.ok).toBe(true);
    if (taken.ok) expect(taken.claim.machineId).toBe('m1');
  });

  it('EPOCH FENCE: applyRemote rejects a STALE-epoch peer record (no steal from fresher lease)', () => {
    const s = store('m1');
    const fresh: JobLeaseClaim = {
      claimId: 'lease_fresh', jobSlug: 'job-a', machineId: 'm2', epoch: 10,
      claimedAt: new Date(now()).toISOString(),
      expiresAt: new Date(now() + 60_000).toISOString(), completed: false,
    };
    expect(s.applyRemote(fresh)).toBe(true);
    const stale: JobLeaseClaim = { ...fresh, claimId: 'lease_stale', machineId: 'm3', epoch: 9 };
    expect(s.applyRemote(stale)).toBe(false);
    expect(s.getClaim('job-a')?.machineId).toBe('m2'); // fresher incumbent retained
  });

  it('applyRemote ignores a record claiming to be our own machine (no self-spoof)', () => {
    const s = store('m1');
    const spoof: JobLeaseClaim = {
      claimId: 'x', jobSlug: 'job-a', machineId: 'm1', epoch: 99,
      claimedAt: new Date(now()).toISOString(),
      expiresAt: new Date(now() + 60_000).toISOString(), completed: false,
    };
    expect(s.applyRemote(spoof)).toBe(false);
  });

  it('completion releases the lease for the next tick', () => {
    const s = store('m1');
    s.tryClaim('job-a', 1);
    s.completeClaim('job-a', 'success');
    const claim = s.getClaim('job-a');
    expect(claim?.completed).toBe(true);
    // A completed claim no longer blocks a new take.
    const again = s.tryClaim('job-a', 1);
    expect(again.ok).toBe(true);
  });

  it('expired peer lease no longer blocks (crash recovery)', () => {
    const s = store('m1');
    s.applyRemote({
      claimId: 'lease_peer', jobSlug: 'job-a', machineId: 'm2', epoch: 5,
      claimedAt: new Date(now()).toISOString(),
      expiresAt: new Date(now() + 1000).toISOString(), completed: false,
    });
    expect(s.hasRemoteClaim('job-a')).toBe(true);
    clock += 2000; // past expiry
    expect(s.hasRemoteClaim('job-a')).toBe(false);
    const taken = s.tryClaim('job-a', 5);
    expect(taken.ok).toBe(true);
  });

  it('leases persist across a restart (durable ledger)', () => {
    const s1 = store('m1');
    s1.tryClaim('job-a', 3);
    const s2 = store('m1'); // re-open same stateDir
    const claim = s2.getClaim('job-a');
    expect(claim?.machineId).toBe('m1');
    expect(claim?.epoch).toBe(3);
  });
});

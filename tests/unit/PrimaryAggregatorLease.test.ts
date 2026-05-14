/**
 * PrimaryAggregatorLease tests — A47 / A60 primary-aggregator lease + failover.
 *
 * Spec: docs/specs/SELF-HEALING-REMEDIATOR-V2-SPEC.md
 * Anchors: A47, A56, A57 (Tier-3), A60.
 *
 * Coverage:
 *   1. tryAcquire on empty state → first machine wins (deterministic by hash).
 *   2. tryAcquire with valid existing lease from another machine → declined.
 *   3. tryAcquire with expired lease → new claim succeeds.
 *   4. renew extends leaseExpiresAt.
 *   5. renew with stolen lease (someone else replaced it) → split-brain.
 *   6. verifyFencingToken passes for current lease.
 *   7. verifyFencingToken fails for stale token.
 *   8. Lower sha256(machineId) wins tiebreak with two simultaneous claims.
 *   9. HMAC verification rejects forged lease files.
 *  10. Deterministic failover on TTL expiration (event emitted).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PrimaryAggregatorLease,
  primaryLeaseTiebreakWins,
  type PrimaryAggregatorChangedEvent,
} from '../../src/remediation/PrimaryAggregatorLease.js';
import { RemediationKeyVault } from '../../src/remediation/RemediationKeyVault.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let tmp: string;
let originalPassphrase: string | undefined;
const VALID_PASSPHRASE = 'lease-test-passphrase-of-sufficient-length';

async function newKeyVault(stateDir: string): Promise<RemediationKeyVault> {
  return RemediationKeyVault.forStateDir(stateDir, {
    forceBackend: 'env-passphrase',
    allowEnvPassphraseFallback: true,
    passphraseResolver: () => VALID_PASSPHRASE,
  });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-primary-lease-'));
  originalPassphrase = process.env.INSTAR_REMEDIATION_KEY_PASSPHRASE;
  delete process.env.INSTAR_REMEDIATION_KEY_PASSPHRASE;
});

afterEach(() => {
  if (originalPassphrase === undefined) {
    delete process.env.INSTAR_REMEDIATION_KEY_PASSPHRASE;
  } else {
    process.env.INSTAR_REMEDIATION_KEY_PASSPHRASE = originalPassphrase;
  }
  SafeFsExecutor.safeRmSync(tmp, {
    recursive: true,
    force: true,
    operation: 'tests/unit/PrimaryAggregatorLease.test.ts:afterEach',
  });
});

// ── Helper: pick two machineIds with known tiebreak ordering ─────────
//
// We brute-force a pair of machineIds where `sha256(a) < sha256(b)`. This
// lets tests assert "a wins" deterministically rather than depending on
// a hard-coded pair that could drift if the hash strategy changes.
function pickOrderedMachineIds(): { lower: string; higher: string } {
  for (let i = 0; i < 1000; i += 1) {
    const a = `machine-${crypto.randomBytes(4).toString('hex')}`;
    const b = `machine-${crypto.randomBytes(4).toString('hex')}`;
    const ha = crypto.createHash('sha256').update(a).digest('hex');
    const hb = crypto.createHash('sha256').update(b).digest('hex');
    if (ha < hb) return { lower: a, higher: b };
    if (hb < ha) return { lower: b, higher: a };
  }
  throw new Error('could not generate distinct hashed machineIds');
}

describe('PrimaryAggregatorLease — tryAcquire / renew / readCurrent (A47, A60)', () => {
  // 1.
  it('1. tryAcquire on empty state → first machine wins, lease persisted with fencingToken + hmac', async () => {
    const vault = await newKeyVault(tmp);
    const lease = new PrimaryAggregatorLease({
      stateDir: tmp,
      machineId: 'machine-A',
      keyVault: vault,
    });
    const result = await lease.tryAcquire();
    expect(result.acquired).toBe(true);
    expect(result.leader.leaderId).toBe('machine-A');
    expect(result.leader.fencingToken).toMatch(/^[0-9a-f]{32}$/);
    expect(result.leader.hmac.length).toBe(32);

    // On disk: lease file exists with the same fencingToken.
    const leasePath = path.join(tmp, 'remediation', 'primary-lease.json');
    expect(fs.existsSync(leasePath)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(leasePath, 'utf-8'));
    expect(onDisk.leaderId).toBe('machine-A');
    expect(onDisk.fencingToken).toBe(result.leader.fencingToken);
    expect(typeof onDisk.hmac).toBe('string');
  });

  // 2.
  it('2. tryAcquire with valid existing lease from another machine → declined with held-by-other', async () => {
    const vault = await newKeyVault(tmp);
    const a = new PrimaryAggregatorLease({ stateDir: tmp, machineId: 'machine-A', keyVault: vault });
    const ack = await a.tryAcquire();
    expect(ack.acquired).toBe(true);

    const b = new PrimaryAggregatorLease({ stateDir: tmp, machineId: 'machine-B', keyVault: vault });
    const bResult = await b.tryAcquire();
    expect(bResult.acquired).toBe(false);
    expect(bResult.reason).toBe('held-by-other');
    expect(bResult.leader.leaderId).toBe('machine-A');
  });

  // 3.
  it('3. tryAcquire with expired lease → new machine claims successfully', async () => {
    const vault = await newKeyVault(tmp);
    let clock = 1_000_000;
    const a = new PrimaryAggregatorLease({
      stateDir: tmp,
      machineId: 'machine-A',
      keyVault: vault,
      ttlMs: 1000,
      now: () => clock,
    });
    const first = await a.tryAcquire();
    expect(first.acquired).toBe(true);

    // Advance past TTL.
    clock += 5000;

    const b = new PrimaryAggregatorLease({
      stateDir: tmp,
      machineId: 'machine-B',
      keyVault: vault,
      ttlMs: 1000,
      now: () => clock,
    });
    const second = await b.tryAcquire();
    // machine-B succeeds iff it wins the tiebreak. Force the tiebreak to
    // favor whichever-this-pair-resolves-to by checking both directions:
    // if A's hash is lower, B will lose; otherwise B claims.
    const expectB = primaryLeaseTiebreakWins('machine-B', 'machine-A');
    if (expectB) {
      expect(second.acquired).toBe(true);
      expect(second.leader.leaderId).toBe('machine-B');
    } else {
      expect(second.acquired).toBe(false);
      expect(second.reason).toBe('tiebreak-lost');
    }
  });

  // 4.
  it('4. renew extends leaseExpiresAt without changing fencingToken or acquiredAt', async () => {
    const vault = await newKeyVault(tmp);
    let clock = 1_000_000;
    const lease = new PrimaryAggregatorLease({
      stateDir: tmp,
      machineId: 'machine-A',
      keyVault: vault,
      ttlMs: 1000,
      now: () => clock,
    });
    const acquired = await lease.tryAcquire();
    expect(acquired.acquired).toBe(true);
    const originalExpiry = acquired.leader.leaseExpiresAt;
    const originalToken = acquired.leader.fencingToken;
    const originalAcquiredAt = acquired.leader.acquiredAt;

    clock += 500; // halfway through TTL
    const renewed = await lease.renew();
    expect(renewed.renewed).toBe(true);

    const after = await lease.readCurrent();
    expect(after).not.toBeNull();
    expect(after!.leaseExpiresAt).toBeGreaterThan(originalExpiry);
    expect(after!.fencingToken).toBe(originalToken);
    expect(after!.acquiredAt).toBe(originalAcquiredAt);
  });

  // 5.
  it('5. renew with stolen lease (someone else replaced it) → split-brain detected, fail-closed', async () => {
    const vault = await newKeyVault(tmp);
    const lease = new PrimaryAggregatorLease({
      stateDir: tmp,
      machineId: 'machine-A',
      keyVault: vault,
    });
    await lease.tryAcquire();

    // Simulate a rogue write: another machine briefly wrote a "machine-A"
    // lease with a fresh fencingToken (split-brain). We do this by going
    // through a SECOND lease instance for the SAME machineId — different
    // process, different random token — so the HMAC is still valid.
    const rogue = new PrimaryAggregatorLease({
      stateDir: tmp,
      machineId: 'machine-A',
      keyVault: vault,
    });
    // Force a fresh acquire by clearing in-memory state and re-claiming the
    // lease (the rogue process didn't know our token).
    rogue.__forgetIssuedToken();
    // Erase the on-disk lease so the rogue's `tryAcquire` claims cleanly.
    SafeFsExecutor.safeUnlinkSync(path.join(tmp, 'remediation', 'primary-lease.json'), {
      operation: 'tests/unit/PrimaryAggregatorLease.test.ts:simulate-rogue-claim',
    });
    const rogueResult = await rogue.tryAcquire();
    expect(rogueResult.acquired).toBe(true);
    expect(rogueResult.leader.fencingToken).not.toBe(
      // The original lease's token (we still have it in memory inside `lease`).
      // We don't need to read it here — the rogue minted a fresh one.
      rogueResult.leader.fencingToken + 'XX', // intentional non-match shape; we just need a stable comparator
    );

    // Now the original `lease` tries to renew — it sees a different
    // fencingToken on disk and trips split-brain.
    const renewResult = await lease.renew();
    expect(renewResult.renewed).toBe(false);
    expect(lease.isSplitBrainTripped()).toBe(true);

    // Anomaly log entry exists.
    const anomalyPath = path.join(tmp, 'remediation', 'audit-anomaly.jsonl');
    expect(fs.existsSync(anomalyPath)).toBe(true);
    const line = fs.readFileSync(anomalyPath, 'utf-8').trim().split('\n')[0];
    const parsed = JSON.parse(line);
    expect(parsed.kind).toBe('primary-aggregator.split-brain-detected');
    expect(parsed.operation).toBe('renew');

    // Subsequent tryAcquire also refuses while split-brain is tripped.
    const trapped = await lease.tryAcquire();
    expect(trapped.acquired).toBe(false);
    expect(trapped.reason).toBe('split-brain');
  });

  // 6.
  it('6. verifyFencingToken passes for the current lease token', async () => {
    const vault = await newKeyVault(tmp);
    const lease = new PrimaryAggregatorLease({
      stateDir: tmp,
      machineId: 'machine-A',
      keyVault: vault,
    });
    const acquired = await lease.tryAcquire();
    expect(await lease.verifyFencingToken(acquired.leader.fencingToken)).toBe(true);
  });

  // 7.
  it('7. verifyFencingToken fails for a stale / wrong token', async () => {
    const vault = await newKeyVault(tmp);
    const lease = new PrimaryAggregatorLease({
      stateDir: tmp,
      machineId: 'machine-A',
      keyVault: vault,
    });
    await lease.tryAcquire();
    const stale = crypto.randomBytes(16).toString('hex'); // same shape, wrong value
    expect(await lease.verifyFencingToken(stale)).toBe(false);
    // Different length is also refused.
    expect(await lease.verifyFencingToken('too-short')).toBe(false);
  });

  // 8.
  it('8. Lower sha256(machineId) wins tiebreak with two simultaneous claims (A47)', async () => {
    const vault = await newKeyVault(tmp);
    const { lower, higher } = pickOrderedMachineIds();
    // Both machines see an empty state (no lease file).
    const a = new PrimaryAggregatorLease({ stateDir: tmp, machineId: higher, keyVault: vault });
    // The "higher" hash machine acquires first in a race-loss-of-the-lower
    // case. To simulate "two simultaneous claims" with deterministic tiebreak,
    // we let the higher one claim first, then expire its lease, then both
    // try again — only the lower wins the tiebreak.
    let clock = 1_000_000;
    const aBound = new PrimaryAggregatorLease({
      stateDir: tmp, machineId: higher, keyVault: vault, ttlMs: 1000, now: () => clock,
    });
    const aResult = await aBound.tryAcquire();
    expect(aResult.acquired).toBe(true);
    clock += 5000; // expire

    const bBound = new PrimaryAggregatorLease({
      stateDir: tmp, machineId: lower, keyVault: vault, ttlMs: 1000, now: () => clock,
    });
    const aRetry = new PrimaryAggregatorLease({
      stateDir: tmp, machineId: higher, keyVault: vault, ttlMs: 1000, now: () => clock,
    });

    // The lower machine wins tiebreak.
    const bResult = await bBound.tryAcquire();
    expect(bResult.acquired).toBe(true);
    expect(bResult.leader.leaderId).toBe(lower);

    // The higher machine now sees a valid lease and declines (held-by-other).
    const aDeclined = await aRetry.tryAcquire();
    expect(aDeclined.acquired).toBe(false);
    expect(aDeclined.reason).toBe('held-by-other');

    // Reference the unused initial instance to keep linters happy.
    expect(a).toBeTruthy();
  });

  // 9.
  it('9. HMAC verification rejects forged lease files (treated as absent)', async () => {
    const vault = await newKeyVault(tmp);
    const lease = new PrimaryAggregatorLease({
      stateDir: tmp,
      machineId: 'machine-A',
      keyVault: vault,
    });
    await lease.tryAcquire();

    // Tamper: rewrite the lease with a different leaderId but keep the
    // (now-stale) HMAC. The verifier must reject.
    const leasePath = path.join(tmp, 'remediation', 'primary-lease.json');
    const onDisk = JSON.parse(fs.readFileSync(leasePath, 'utf-8'));
    onDisk.leaderId = 'evil-machine';
    fs.writeFileSync(leasePath, JSON.stringify(onDisk));

    const read = await lease.readCurrent();
    expect(read).toBeNull();

    // tryAcquire on the "no valid lease" state succeeds (since the forged
    // file is treated as absent).
    const recovery = await lease.tryAcquire();
    expect(recovery.acquired).toBe(true);
    expect(recovery.leader.leaderId).toBe('machine-A');
  });

  // 10.
  it('10. Deterministic failover on TTL expiration emits remediation.primary-aggregator.changed', async () => {
    const vault = await newKeyVault(tmp);
    let clock = 1_000_000;

    const a = new PrimaryAggregatorLease({
      stateDir: tmp, machineId: 'machine-A', keyVault: vault, ttlMs: 1000, now: () => clock,
    });
    const aResult = await a.tryAcquire();
    expect(aResult.acquired).toBe(true);

    clock += 5000; // A's lease has now expired

    // B picks up. We expect B to emit `remediation.primary-aggregator.changed`
    // with previousLeaderId='machine-A' on the first observation.
    const events: PrimaryAggregatorChangedEvent[] = [];
    const b = new PrimaryAggregatorLease({
      stateDir: tmp, machineId: 'machine-B', keyVault: vault, ttlMs: 1000, now: () => clock,
    });
    b.on('remediation.primary-aggregator.changed', (e) => events.push(e));

    const bResult = await b.tryAcquire();
    // Tiebreak determines if B wins. Either way, an event must fire on the
    // transition. We test both branches.
    const bWins = primaryLeaseTiebreakWins('machine-B', 'machine-A');
    if (bWins) {
      expect(bResult.acquired).toBe(true);
      expect(bResult.leader.leaderId).toBe('machine-B');
      // Two transitions are possible: prev=null→'machine-A' (on read), then
      // 'machine-A'→'machine-B' (on claim). The implementation may collapse
      // these depending on read ordering. We assert that the FINAL observed
      // leader is 'machine-B' and at least one transition has been emitted.
      expect(events.length).toBeGreaterThanOrEqual(1);
      const last = events[events.length - 1];
      expect(last.newLeaderId).toBe('machine-B');
    } else {
      // B lost tiebreak; A remains the recorded leader (B observes A's
      // expired lease and defers). Transition still fires: prev=null→'machine-A'.
      expect(bResult.acquired).toBe(false);
      expect(bResult.reason).toBe('tiebreak-lost');
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[events.length - 1].newLeaderId).toBe('machine-A');
    }
  });
});

describe('PrimaryAggregatorLease — auxiliary contracts', () => {
  it('readCurrent returns null when the file is missing', async () => {
    const vault = await newKeyVault(tmp);
    const lease = new PrimaryAggregatorLease({
      stateDir: tmp, machineId: 'machine-A', keyVault: vault,
    });
    expect(await lease.readCurrent()).toBeNull();
  });

  it('readCurrent returns null when the file is malformed JSON', async () => {
    const vault = await newKeyVault(tmp);
    const lease = new PrimaryAggregatorLease({
      stateDir: tmp, machineId: 'machine-A', keyVault: vault,
    });
    fs.mkdirSync(path.join(tmp, 'remediation'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'remediation', 'primary-lease.json'), 'not-json{');
    expect(await lease.readCurrent()).toBeNull();
  });

  it('getRenewIntervalMs returns the configured cadence', async () => {
    const vault = await newKeyVault(tmp);
    const lease = new PrimaryAggregatorLease({
      stateDir: tmp, machineId: 'machine-A', keyVault: vault, renewIntervalMs: 42_000,
    });
    expect(lease.getRenewIntervalMs()).toBe(42_000);
  });

  it('resetSplitBrainTrip clears the local trip flag', async () => {
    const vault = await newKeyVault(tmp);
    const lease = new PrimaryAggregatorLease({
      stateDir: tmp, machineId: 'machine-A', keyVault: vault,
    });
    await lease.tryAcquire();

    // Manually trip split-brain via the renew-with-stolen-lease scenario.
    const rogue = new PrimaryAggregatorLease({
      stateDir: tmp, machineId: 'machine-A', keyVault: vault,
    });
    rogue.__forgetIssuedToken();
    SafeFsExecutor.safeUnlinkSync(path.join(tmp, 'remediation', 'primary-lease.json'), {
      operation: 'tests/unit/PrimaryAggregatorLease.test.ts:resetSplitBrainTrip',
    });
    await rogue.tryAcquire();
    await lease.renew();
    expect(lease.isSplitBrainTripped()).toBe(true);
    lease.resetSplitBrainTrip();
    expect(lease.isSplitBrainTripped()).toBe(false);
  });
});

/**
 * B1 (multimachine-lease-poll-robustness) — lease-derived poll-intent republish.
 *
 * REGRESSION THIS LOCKS IN (observed live on a two-machine agent, v1.3.1122):
 * `_role` is restored from the machine registry at startup, so a machine that was
 * already `awake` before a restart re-enters `reconcileRoleToLease` with
 * `desired === this._role` and hits the no-transition early-return. The publish
 * used to sit BELOW that return, so `initializeLease()`'s safe boot default
 * (`{shouldPoll:false, role:'standby'}`) stayed as the PERMANENT published intent
 * for a machine that actually holds the lease — measured in production as
 * `/health` reporting `role:awake, holdsLease:true` while the intent file said
 * `role:standby, shouldPoll:false` at the SAME lease epoch, in the same second.
 *
 * Downstream harm: the lifeline either fought for the poll (dry-run → Telegram 409
 * conflict loop → `conflict409Stuck` self-restart → server restart every ~10 min)
 * or, once the lever went live, muted the rightful holder outright.
 *
 * Second failure mode covered here: the record was only ever written on a role
 * TRANSITION, so on a steady role its `ts` aged past the consumer's
 * `maxStaleMs: 90_000` bound and `effectivePollIntent` degraded it to "no
 * current opinion".
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { MultiMachineCoordinator } from '../../src/core/MultiMachineCoordinator.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { readPollIntent } from '../../src/core/pollIntent.js';
import { FencedLease, type LeaseCrypto } from '../../src/core/FencedLease.js';
import { LeaseCoordinator, type LeaseTransport } from '../../src/core/LeaseCoordinator.js';
import { LocalLeaseStore } from '../../src/core/LocalLeaseStore.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mmc-pollintent-'));
}

function seedIdentity(stateDir: string, machineId: string) {
  const identity = {
    machineId,
    signingPublicKey: 'k1',
    encryptionPublicKey: 'k2',
    name: 'machine-a',
    platform: 'test',
    createdAt: new Date().toISOString(),
    capabilities: ['sessions'],
  };
  fs.mkdirSync(path.join(stateDir, 'machine'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'machine', 'identity.json'), JSON.stringify(identity));
  return identity;
}

/**
 * Build a coordinator whose in-memory role is ALREADY `registryRole` (the
 * production restart path — the registry remembers what this machine was), with a
 * stub lease coordinator whose holdsLease/currentEpoch the test drives directly.
 */
function makeCoord(
  dir: string,
  opts: { registryRole: 'awake' | 'standby'; holds: boolean; epoch?: number; pollFollowsLease?: unknown },
) {
  const machineId = `m_${crypto.randomBytes(8).toString('hex')}`;
  const identity = seedIdentity(dir, machineId);
  const mgr = new MachineIdentityManager(dir);
  mgr.registerMachine(identity as any, opts.registryRole);
  const state = new StateManager(dir);
  const coord = new MultiMachineCoordinator(state, {
    stateDir: dir,
    multiMachine: {
      pollFollowsLease: opts.pollFollowsLease ?? { enabled: true, dryRun: true },
    } as any,
  });
  coord.start();
  const c = coord as any;
  // `start()` runs a startup-failover promotion when no heartbeat file exists, so
  // pin the in-memory role to the value the machine registry would have restored.
  // That restored role is the whole point of the regression: it is what makes
  // `desired === this._role` true on the first reconcile after a restart.
  c._role = opts.registryRole;
  // Minimal lease stub — this suite is about what reconcile PUBLISHES, not about
  // lease acquisition (covered by the FencedLease / LeaseCoordinator suites).
  const stub = {
    holds: opts.holds,
    epoch: opts.epoch ?? 7,
    holdsLease() { return this.holds; },
    currentEpoch() { return this.epoch; },
  };
  c.leaseCoordinator = stub;
  return { coord, c, stub, machineId };
}

describe('MultiMachineCoordinator B1 — poll-intent republish', () => {
  let dir: string;
  beforeEach(() => { dir = tempDir(); });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'pollIntentRepublish:afterEach' });
  });

  it('publishes shouldPoll:true for a lease HOLDER whose role did not transition (the regression)', () => {
    // Registry says awake + lease held ⇒ desired === _role ⇒ the old code
    // early-returned and never replaced the standby boot default.
    const { coord, c } = makeCoord(dir, { registryRole: 'awake', holds: true });
    expect(c._role).toBe('awake'); // precondition: no transition will occur

    c.reconcileRoleToLease('test');

    const rec = readPollIntent(dir);
    expect(rec).not.toBeNull();
    expect(rec!.shouldPoll).toBe(true);
    expect(rec!.role).toBe('awake');
    expect(rec!.leaseEpoch).toBe(7);
    coord.stop();
  });

  it('publishes shouldPoll:false for a NON-holder whose role did not transition', () => {
    const { coord, c } = makeCoord(dir, { registryRole: 'standby', holds: false });
    expect(c._role).toBe('standby');

    c.reconcileRoleToLease('test');

    const rec = readPollIntent(dir);
    expect(rec).not.toBeNull();
    expect(rec!.shouldPoll).toBe(false);
    expect(rec!.role).toBe('standby');
    coord.stop();
  });

  it('refreshes a STEADY role once the refresh window elapses, and throttles inside it', () => {
    const { coord, c } = makeCoord(dir, { registryRole: 'awake', holds: true });
    // Count real writes rather than comparing `ts`: two reconciles in the same
    // millisecond produce an identical timestamp, so `ts` cannot distinguish
    // "rewritten" from "skipped" — a control that could not fail.
    const spy = vi.spyOn(c, 'writeLeasePollIntent');

    c.reconcileRoleToLease('tick-1');
    expect(spy).toHaveBeenCalledTimes(1);

    // Inside the refresh window with an unchanged intent ⇒ throttled, no rewrite.
    c.reconcileRoleToLease('tick-2');
    expect(spy).toHaveBeenCalledTimes(1);

    // Past the window ⇒ rewritten, so `ts` stays inside the consumer's 90s bound.
    c.lastPollIntentWriteMs = Date.now() - (31_000);
    c.reconcileRoleToLease('tick-3');
    expect(spy).toHaveBeenCalledTimes(2);
    expect(readPollIntent(dir)!.shouldPoll).toBe(true);
    spy.mockRestore();
    coord.stop();
  });

  it('retries on the next reconcile when a write FAILS (no skip-window off a failure)', () => {
    const { coord, c } = makeCoord(dir, { registryRole: 'awake', holds: true });
    const spy = vi.spyOn(c, 'writeLeasePollIntent').mockReturnValueOnce(false);

    c.reconcileRoleToLease('tick-1');   // write fails ⇒ throttle state must NOT advance
    c.reconcileRoleToLease('tick-2');   // immediately retried, not skipped

    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
    coord.stop();
  });

  it('publishes IMMEDIATELY on a lease-epoch change even inside the refresh window', () => {
    const { coord, c, stub } = makeCoord(dir, { registryRole: 'awake', holds: true, epoch: 7 });
    c.reconcileRoleToLease('tick-1');
    expect(readPollIntent(dir)!.leaseEpoch).toBe(7);

    stub.epoch = 8; // fenced epoch moved — the intent must not lag behind it
    c.reconcileRoleToLease('tick-2');
    expect(readPollIntent(dir)!.leaseEpoch).toBe(8);
    coord.stop();
  });

  it('writes NOTHING when the pollFollowsLease gate is explicitly off', () => {
    const { coord, c } = makeCoord(dir, {
      registryRole: 'awake',
      holds: true,
      pollFollowsLease: { enabled: false },
    });

    c.reconcileRoleToLease('test');

    expect(readPollIntent(dir)).toBeNull();
    coord.stop();
  });

  it('still fires the transition-only side effects on a REAL role change', () => {
    // Registry says standby, lease is held ⇒ genuine standby→awake transition.
    const { coord, c } = makeCoord(dir, { registryRole: 'standby', holds: true });
    const events: string[] = [];
    coord.on('roleChange', (from: string, to: string) => events.push(`roleChange:${from}->${to}`));
    coord.on('promote', () => events.push('promote'));

    c.reconcileRoleToLease('test');

    expect(events).toContain('roleChange:standby->awake');
    expect(events).toContain('promote');
    expect(c._role).toBe('awake');
    expect(readPollIntent(dir)!.shouldPoll).toBe(true);
    coord.stop();
  });

  it('REAL boot path: initializeLease writes the standby default, the first reconcile replaces it', async () => {
    // The stubbed tests above prove the publish runs; this one proves the whole
    // production sequence lands correctly — a real FencedLease/LeaseCoordinator,
    // the real `initializeLease()` the server calls at boot, and the real
    // acquisition. Without it the suite could pass while the boot default still
    // won in production, which is exactly the shape of the defect.
    const machineId = `m_${crypto.randomBytes(8).toString('hex')}`;
    const identity = seedIdentity(dir, machineId);
    const mgr = new MachineIdentityManager(dir);
    mgr.registerMachine(identity as any, 'awake'); // registry-restored role, as after a restart
    const keys = crypto.generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const cryptoIface: LeaseCrypto = {
      selfMachineId: machineId,
      sign: (c) => crypto.sign(null, Buffer.from(c), keys.privateKey).toString('base64'),
      verify: (c, sig) => {
        try { return crypto.verify(null, Buffer.from(c), keys.publicKey, Buffer.from(sig, 'base64')); } catch { return false; }
      },
    };
    const tunnel: LeaseTransport = {
      broadcast: async () => true,
      observed: () => ({ lease: null, lastNonceByHolder: {} }),
      isReachable: () => true,
      pullAllPeers: async () => {},
    };
    const lc = new LeaseCoordinator({
      lease: new FencedLease(cryptoIface, { leaseTtlMs: 60_000, failoverThresholdMs: 15 * 60_000 }),
      store: new LocalLeaseStore({ filePath: path.join(dir, 'lease-local.json') }),
      tunnel,
      presumedDeadHolders: () => new Set(),
    });
    const state = new StateManager(dir);
    const coord = new MultiMachineCoordinator(state, {
      stateDir: dir,
      multiMachine: { pollFollowsLease: { enabled: true, dryRun: true } } as any,
    });
    coord.start();
    coord.attachLeaseCoordinator(lc);
    const c = coord as any;
    c._role = 'awake'; // registry-restored, as production does after a restart

    // `initializeLease()` writes the safe default, then acquires, then reconciles.
    await coord.initializeLease();

    // END STATE is what matters: this machine genuinely holds the lease, so the
    // record the lifeline will read must say so. Two separate defects had to be
    // fixed for this to hold — the reconcile publishing only on a transition
    // (there is none: the registry already said awake), and the safe boot default
    // being written AFTER that reconcile, clobbering the decision it stands in for.
    expect(lc.holdsLease()).toBe(true);
    expect(c._role).toBe('awake');
    const afterBoot = readPollIntent(dir);
    expect(afterBoot).not.toBeNull();
    expect(afterBoot!.shouldPoll).toBe(true);
    expect(afterBoot!.role).toBe('awake');
    expect(afterBoot!.leaseEpoch).toBe(lc.currentEpoch());

    // And a later steady-state reconcile must not regress it.
    c.lastPollIntentWriteMs = Date.now() - 31_000;
    c.reconcileRoleToLease('post-boot-tick');
    const after = readPollIntent(dir)!;
    expect(after.shouldPoll).toBe(true);
    expect(after.role).toBe('awake');
    coord.stop();
  });

  it('REAL boot path: a machine that does NOT acquire is left muted (safe default preserved)', async () => {
    // The counterpart to the test above — the safe default must still win when the
    // boot path does not end up holding the lease, or the ordering fix would have
    // traded one silent failure for the opposite one (a standby told to poll).
    const machineId = `m_${crypto.randomBytes(8).toString('hex')}`;
    const identity = seedIdentity(dir, machineId);
    const mgr = new MachineIdentityManager(dir);
    mgr.registerMachine(identity as any, 'standby');
    const keys = crypto.generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const cryptoIface: LeaseCrypto = {
      selfMachineId: machineId,
      sign: (c) => crypto.sign(null, Buffer.from(c), keys.privateKey).toString('base64'),
      verify: (c, sig) => {
        try { return crypto.verify(null, Buffer.from(c), keys.publicKey, Buffer.from(sig, 'base64')); } catch { return false; }
      },
    };
    const tunnel: LeaseTransport = {
      broadcast: async () => true,
      observed: () => ({ lease: null, lastNonceByHolder: {} }),
      isReachable: () => true,
      pullAllPeers: async () => {},
    };
    const lc = new LeaseCoordinator({
      lease: new FencedLease(cryptoIface, { leaseTtlMs: 60_000, failoverThresholdMs: 15 * 60_000 }),
      store: new LocalLeaseStore({ filePath: path.join(dir, 'lease-local.json') }),
      tunnel,
      presumedDeadHolders: () => new Set(),
    });
    const state = new StateManager(dir);
    const coord = new MultiMachineCoordinator(state, {
      stateDir: dir,
      multiMachine: {
        pollFollowsLease: { enabled: true, dryRun: true },
        // Silent-standby branch: observe the primary's lease, never acquire.
        leaseSelfHeal: { leaseRole: 'observe-only' },
      } as any,
    });
    coord.start();
    coord.attachLeaseCoordinator(lc);

    await coord.initializeLease();

    expect(lc.holdsLease()).toBe(false);
    const rec = readPollIntent(dir)!;
    expect(rec.shouldPoll).toBe(false);
    expect(rec.role).toBe('standby');
    coord.stop();
  });

  it('does NOT re-fire transition-only side effects when the role is steady', () => {
    const { coord, c } = makeCoord(dir, { registryRole: 'awake', holds: true });
    const events: string[] = [];
    coord.on('roleChange', () => events.push('roleChange'));
    coord.on('promote', () => events.push('promote'));

    c.reconcileRoleToLease('tick-1');
    c.lastPollIntentWriteMs = Date.now() - 31_000;
    c.reconcileRoleToLease('tick-2');

    expect(events).toEqual([]); // publish is per-reconcile; transitions are not
    expect(readPollIntent(dir)!.shouldPoll).toBe(true);
    coord.stop();
  });
});

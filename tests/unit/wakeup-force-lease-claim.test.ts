import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { claimLeaseForSelf } from '../../src/commands/machine.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { FencedLease } from '../../src/core/FencedLease.js';
import { sign, verify } from '../../src/core/MachineIdentity.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

/**
 * Bug #6 — `instar wakeup --force` used to flip only the LOCAL registry role.
 * But the lease (not the role) is the authority, and the server's
 * reconcileRoleToLease() reverts role to match the lease on startup — so the
 * role-only flip was silently undone and never reached the peer (verified live
 * 2026-05-28). The fix claims a real signed +1-epoch lease for this machine.
 * This proves claimLeaseForSelf writes that lease into the registry.
 */
describe('claimLeaseForSelf — force-wakeup claims a real signed higher-epoch lease', () => {
  let home: string;

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'wakeup-lease-'));
    fs.mkdirSync(path.join(home, '.instar'), { recursive: true });
    const mgr = new MachineIdentityManager(path.join(home, '.instar'));
    // This machine joins as standby; generateIdentity writes signing-key.pem + registers.
    await mgr.generateIdentity({ name: 'mini', role: 'standby' });
    // Seed an "awake" peer holding the lease at epoch 5.
    const reg = mgr.loadRegistry();
    reg.machines['m_peerAWAKE000000000000000000000000'] = {
      name: 'laptop', status: 'active', role: 'awake',
      pairedAt: '2026-05-28T00:00:00Z', lastSeen: '2026-05-28T00:00:00Z',
      signingPublicKey: 'x', encryptionPublicKey: 'x', platform: 'darwin-arm64', capabilities: ['sessions'],
    } as never;
    reg.lease = { holder: 'm_peerAWAKE000000000000000000000000', epoch: 5, acquiredAt: '2026-05-28T00:00:00Z', expiresAt: '2026-05-28T01:00:00Z', nonce: 3, signature: 'old' };
    mgr.saveRegistry(reg);
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'tests/unit/wakeup-force-lease-claim.test.ts:afterEach' });
  });

  it('writes a self-held lease at currentEpoch+1 with a signature that verifies', async () => {
    const stateDir = path.join(home, '.instar');
    const mgr = new MachineIdentityManager(stateDir);
    const selfId = mgr.loadIdentity().machineId;
    const signingKeyPem = fs.readFileSync(path.join(stateDir, 'machine', 'signing-key.pem'), 'utf-8');

    await claimLeaseForSelf(mgr, selfId, signingKeyPem, { stateDir, projectDir: home /* no .git → push skipped */ });

    const reg = mgr.loadRegistry();
    // Lease authority now names THIS machine at epoch 6 (5 + 1).
    expect(reg.lease.holder).toBe(selfId);
    expect(reg.lease.epoch).toBe(6);
    // The freshness fields the replay guard needs were bumped.
    expect(reg.machines[selfId].authoredUnderEpoch).toBe(6);

    // The signature genuinely verifies against this machine's registered key.
    const crypto = {
      selfMachineId: selfId,
      sign: (c: string) => sign(c, signingKeyPem),
      verify: (c: string, s: string, holder: string) => {
        const pub = mgr.getSigningPublicKeyPem(holder);
        return pub ? verify(c, s, pub) : false;
      },
    };
    const fenced = new FencedLease(crypto, { leaseTtlMs: 60000, failoverThresholdMs: 900000 });
    expect(fenced.verifyLease(reg.lease)).toBe(true);
  });
});

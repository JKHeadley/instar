import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DeliveredMandateStore } from '../../src/coordination/DeliveredMandateStore.js';
import { packageMandateForDelivery } from '../../src/coordination/AccountFollowMeMandateBridge.js';
import { acceptMandateDelivery, isConfigureOnlyMandate, readConfigureBounds } from '../../src/coordination/AccountFollowMeMandateDelivery.js';
import { checkCommandRBAC } from '../../src/core/MeshRpc.js';

// spec one-tap-unattended-repair §4 — delivery acceptance for the configure-only shape.
const keys = crypto.generateKeyPairSync('ed25519');
const pem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const DIGEST = `sha256:${'b'.repeat(64)}`;
function mandate(authorities: Array<{ action: string; bounds: Record<string, unknown> }>, expiresInMs = 600_000) {
  return { id: `m-${Math.random()}`, scope: 'subscription-relogin', agents: ['a', 'a'], authorities, author: 'dashboard-pin-operator',
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + expiresInMs).toISOString() } as any;
}
const configure = (target = 'self', digest = DIGEST) => ({ action: 'subscription-relogin-configure', bounds: { targetMachineId: target, configDigest: digest } });
function deps(over: Partial<Parameters<typeof acceptMandateDelivery>[0]> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-deliver-'));
  return { enabled: () => false, reloginEnabled: () => false, selfMachineId: () => 'self', operatorMachinePublicKey: () => pem,
    store: new DeliveredMandateStore({ filePath: path.join(dir, 'd.json') }), ...over };
}

describe('configure-only mandate delivery', () => {
  it('is accepted with account follow-me AND repair both off, and persisted for point-of-use re-verify', () => {
    const d = deps();
    const m = mandate([configure()]);
    const r = acceptMandateDelivery(d, 'front', packageMandateForDelivery(m, 'front', keys.privateKey));
    expect(r).toEqual({ accepted: true, mandateId: m.id });
    expect(d.store.get(m.id)?.deliveredBy).toBe('front');
  });

  it('refuses another target, a malformed digest, mixed authorities, a bad signature and an expired mandate', () => {
    expect(acceptMandateDelivery(deps(), 'front', packageMandateForDelivery(mandate([configure('other')]), 'front', keys.privateKey)))
      .toMatchObject({ accepted: false, reason: 'target-not-this-machine' });
    expect(acceptMandateDelivery(deps(), 'front', packageMandateForDelivery(mandate([configure('self', 'nope')]), 'front', keys.privateKey)))
      .toMatchObject({ accepted: false, reason: 'malformed-configure-bounds' });
    expect(acceptMandateDelivery(deps(), 'front', packageMandateForDelivery(mandate([configure(), { action: 'account-follow-me', bounds: { accountId: 'x', targetMachineId: 'self', mechanism: 're-mint' } }]), 'front', keys.privateKey)))
      .toMatchObject({ accepted: false, reason: 'mixed-authorities' });
    const other = crypto.generateKeyPairSync('ed25519');
    expect(acceptMandateDelivery(deps(), 'front', packageMandateForDelivery(mandate([configure()]), 'front', other.privateKey)).accepted).toBe(false);
    expect(acceptMandateDelivery(deps(), 'front', packageMandateForDelivery(mandate([configure()], -1000), 'front', keys.privateKey)))
      .toMatchObject({ accepted: false, reason: 'mandate-expired' });
  });

  it('leaves the follow-me path gated exactly as before', () => {
    const fm = mandate([{ action: 'account-follow-me', bounds: { accountId: 'x', targetMachineId: 'self', mechanism: 're-mint' } }]);
    expect(acceptMandateDelivery(deps(), 'front', packageMandateForDelivery(fm, 'front', keys.privateKey)))
      .toMatchObject({ accepted: false, reason: 'feature-disabled' });
  });

  it('shape helpers', () => {
    expect(isConfigureOnlyMandate(mandate([configure()]))).toBe(true);
    expect(isConfigureOnlyMandate(mandate([configure(), configure()]))).toBe(false);
    expect(readConfigureBounds(mandate([configure()]))).toEqual({ targetMachineId: 'self', configDigest: DIGEST, operatorUnlockCarried: false });
  });

  it('reads the carried PIN-unlock claim only when both the signed bound and the author say so', () => {
    const withUnlock = { action: 'subscription-relogin-configure', bounds: { targetMachineId: 'self', configDigest: DIGEST, operatorUnlock: 'dashboard-pin-session' } };
    expect(readConfigureBounds(mandate([withUnlock]))?.operatorUnlockCarried).toBe(true);
    expect(readConfigureBounds({ ...mandate([withUnlock]), author: 'justin' })?.operatorUnlockCarried).toBe(false);
    const wrongValue = { ...withUnlock, bounds: { ...withUnlock.bounds, operatorUnlock: 'yes' } };
    expect(readConfigureBounds(mandate([wrongValue]))?.operatorUnlockCarried).toBe(false);
  });

  it('the mesh RBAC gate passes the command to the coarse check', () => {
    const seen: unknown[] = [];
    const cmd = { type: 'account-follow-me-mandate-deliver', portable: { mandate: mandate([configure()]) } } as any;
    const r = checkCommandRBAC(cmd, 'front', { routerHolder: () => null, ownerOf: () => null, placementTargetOf: () => null, authorizeMandateDeliver: (args: any) => { seen.push(args.command); return true; } } as any);
    expect(r.ok).toBe(true);
    expect(seen[0]).toBe(cmd);
  });
});

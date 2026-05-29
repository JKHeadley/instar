/**
 * Tier-1 tests for MeshRpc (Multi-Machine Session Pool §L0): the recipient-bound
 * signed envelope verification + the per-command RBAC gate. Pure logic with
 * injected crypto/nonce/registry/router seams.
 */
import { describe, it, expect } from 'vitest';
import {
  signEnvelope,
  verifyEnvelope,
  checkCommandRBAC,
  acceptEnvelope,
  canonicalizeEnvelope,
  type MeshCommand,
  type MeshEnvelope,
  type VerifyEnvelopeDeps,
  type RbacDeps,
} from '../../src/core/MeshRpc.js';

// Fake crypto: a signature is `SIG(<sender>):<canonical>` — so a sig is valid
// only for the exact (sender, canonical-bytes) pair it was made for.
const fakeSignFor = (sender: string) => (canonical: string) => `SIG(${sender}):${canonical}`;
const fakeVerify = (canonical: string, signature: string, sender: string) => signature === `SIG(${sender}):${canonical}`;

function envFrom(opts: {
  sender: string;
  recipient: string;
  command: MeshCommand;
  epoch?: number;
  nonce?: string;
  timestamp?: number;
}): MeshEnvelope {
  return signEnvelope(
    {
      sender: opts.sender,
      recipient: opts.recipient,
      command: opts.command,
      epoch: opts.epoch ?? 1,
      nonce: opts.nonce ?? 'n1',
      timestamp: opts.timestamp ?? 1_000_000,
    },
    fakeSignFor(opts.sender),
  );
}

function verifyDeps(self: string, over: Partial<VerifyEnvelopeDeps> = {}): VerifyEnvelopeDeps {
  return {
    selfMachineId: self,
    verify: fakeVerify,
    isRegisteredPeer: () => true,
    seenNonce: () => false,
    now: () => 1_000_000,
    clockToleranceMs: 30_000,
    ...over,
  };
}

describe('MeshRpc — envelope verification (§L0)', () => {
  it('canonical bytes include the recipient (recipient-bound signature)', () => {
    const base = { sender: 'A', command: { type: 'capacity-report' } as MeshCommand, epoch: 1, nonce: 'n', timestamp: 1 };
    expect(canonicalizeEnvelope({ ...base, recipient: 'B' })).not.toBe(canonicalizeEnvelope({ ...base, recipient: 'C' }));
  });

  it('accepts a valid envelope addressed to this machine', () => {
    const env = envFrom({ sender: 'A', recipient: 'B', command: { type: 'capacity-report' } });
    expect(verifyEnvelope(env, verifyDeps('B'))).toEqual({ ok: true, reason: 'ok' });
  });

  it('REJECTS a command signed for A and replayed verbatim to C (wrong-recipient)', () => {
    const envForB = envFrom({ sender: 'A', recipient: 'B', command: { type: 'capacity-report' } });
    // Machine C receives the exact bytes signed for B.
    expect(verifyEnvelope(envForB, verifyDeps('C'))).toEqual({ ok: false, reason: 'wrong-recipient' });
  });

  it('rejects a tampered/invalid signature', () => {
    const env = { ...envFrom({ sender: 'A', recipient: 'B', command: { type: 'capacity-report' } }), signature: 'forged' };
    expect(verifyEnvelope(env, verifyDeps('B')).reason).toBe('signature-invalid');
  });

  it('rejects an unregistered sender', () => {
    const env = envFrom({ sender: 'X', recipient: 'B', command: { type: 'capacity-report' } });
    expect(verifyEnvelope(env, verifyDeps('B', { isRegisteredPeer: () => false })).reason).toBe('unknown-sender');
  });

  it('rejects a replayed nonce', () => {
    const env = envFrom({ sender: 'A', recipient: 'B', command: { type: 'capacity-report' } });
    expect(verifyEnvelope(env, verifyDeps('B', { seenNonce: () => true })).reason).toBe('replayed-nonce');
  });

  it('rejects a stale timestamp (outside tolerance)', () => {
    const env = envFrom({ sender: 'A', recipient: 'B', command: { type: 'capacity-report' }, timestamp: 1_000_000 });
    expect(verifyEnvelope(env, verifyDeps('B', { now: () => 1_000_000 + 40_000 })).reason).toBe('stale-timestamp');
  });

  it('checks recipient BEFORE signature (a wrong-recipient with a bad sig still reports wrong-recipient)', () => {
    const env = { ...envFrom({ sender: 'A', recipient: 'B', command: { type: 'capacity-report' } }), signature: 'forged' };
    expect(verifyEnvelope(env, verifyDeps('C')).reason).toBe('wrong-recipient');
  });
});

describe('MeshRpc — per-command RBAC (§L0)', () => {
  function rbac(over: Partial<RbacDeps> = {}): RbacDeps {
    return { routerHolder: () => 'ROUTER', ownerOf: () => null, placementTargetOf: () => null, ...over };
  }

  it('place / transfer: router → ok, non-router → not-router', () => {
    expect(checkCommandRBAC({ type: 'place', session: 's', machine: 'm' }, 'ROUTER', rbac()).ok).toBe(true);
    expect(checkCommandRBAC({ type: 'place', session: 's', machine: 'm' }, 'OTHER', rbac()).reason).toBe('not-router');
    expect(checkCommandRBAC({ type: 'transfer', session: 's', target: 'm' }, 'ROUTER', rbac()).ok).toBe(true);
    expect(checkCommandRBAC({ type: 'transfer', session: 's', target: 'm' }, 'OTHER', rbac()).reason).toBe('not-router');
  });

  it('claim: placement-target → ok; router+failover → ok; anyone else → claim-unauthorized', () => {
    expect(checkCommandRBAC({ type: 'claim', session: 's', epoch: 2 }, 'TARGET', rbac({ placementTargetOf: () => 'TARGET' })).ok).toBe(true);
    expect(checkCommandRBAC({ type: 'claim', session: 's', epoch: 2, failover: true }, 'ROUTER', rbac()).ok).toBe(true);
    expect(checkCommandRBAC({ type: 'claim', session: 's', epoch: 2 }, 'ROUTER', rbac()).reason).toBe('claim-unauthorized'); // router but no failover + not target
    expect(checkCommandRBAC({ type: 'claim', session: 's', epoch: 2 }, 'RANDO', rbac({ placementTargetOf: () => 'TARGET' })).reason).toBe('claim-unauthorized');
  });

  it('release: current owner → ok; router+failover → ok; anyone else → release-unauthorized', () => {
    expect(checkCommandRBAC({ type: 'release', session: 's', epoch: 2 }, 'OWNER', rbac({ ownerOf: () => 'OWNER' })).ok).toBe(true);
    expect(checkCommandRBAC({ type: 'release', session: 's', epoch: 2, failover: true }, 'ROUTER', rbac()).ok).toBe(true);
    expect(checkCommandRBAC({ type: 'release', session: 's', epoch: 2 }, 'RANDO', rbac({ ownerOf: () => 'OWNER' })).reason).toBe('release-unauthorized');
  });

  it('read/observe + secret-share: any registered peer → ok', () => {
    for (const cmd of [{ type: 'capacity-report' }, { type: 'session-status' }, { type: 'secret-share', encrypted: 'x' }] as MeshCommand[]) {
      expect(checkCommandRBAC(cmd, 'ANY_PEER', rbac()).ok).toBe(true);
    }
  });
});

describe('MeshRpc — acceptEnvelope (verify THEN rbac)', () => {
  const vd = (self: string) => verifyDeps(self);
  const rd: RbacDeps = { routerHolder: () => 'ROUTER', ownerOf: () => null, placementTargetOf: () => null };

  it('a valid envelope from a non-router issuing place is refused at the RBAC door (not-router)', () => {
    const env = envFrom({ sender: 'PEER', recipient: 'B', command: { type: 'place', session: 's', machine: 'm' } });
    expect(acceptEnvelope(env, vd('B'), rd)).toEqual({ ok: false, reason: 'not-router' });
  });

  it('an invalid envelope fails on verify before RBAC is even consulted', () => {
    const env = envFrom({ sender: 'A', recipient: 'B', command: { type: 'place', session: 's', machine: 'm' } });
    // Sent to C → wrong-recipient (verify), never reaches RBAC.
    expect(acceptEnvelope(env, vd('C'), rd).reason).toBe('wrong-recipient');
  });

  it('a router placing on a correctly-addressed envelope is accepted', () => {
    const env = envFrom({ sender: 'ROUTER', recipient: 'B', command: { type: 'place', session: 's', machine: 'm' } });
    expect(acceptEnvelope(env, vd('B'), rd)).toEqual({ ok: true, reason: 'ok' });
  });
});

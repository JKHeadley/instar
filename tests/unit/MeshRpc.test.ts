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
  MeshRpcDispatcher,
  type MeshCommand,
  type MeshEnvelope,
  type VerifyEnvelopeDeps,
  type RbacDeps,
  type MeshRpcDispatcherDeps,
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

  it('drain (WS1.2): router → ok, non-router → drain-unauthorized — its OWN refusal reason', () => {
    const cmd = { type: 'drain', session: '13481', target: 'm_mini', ownershipEpoch: 4 } as const;
    expect(checkCommandRBAC(cmd, 'ROUTER', rbac()).ok).toBe(true);
    expect(checkCommandRBAC(cmd, 'OTHER', rbac()).reason).toBe('drain-unauthorized');
    // Even the transfer TARGET may not order a drain — only the planner (router).
    expect(checkCommandRBAC(cmd, 'm_mini', rbac()).reason).toBe('drain-unauthorized');
  });

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

describe('MeshRpc — dispatcher (receive side)', () => {
  const rd: RbacDeps = { routerHolder: () => 'ROUTER', ownerOf: () => null, placementTargetOf: () => null };

  function makeDispatcher(over: Partial<MeshRpcDispatcherDeps> = {}) {
    const recorded: string[] = [];
    const rejected: Array<{ type: string; reason: string }> = [];
    const handled: Array<{ type: string; sender: string }> = [];
    const d = new MeshRpcDispatcher({
      verify: verifyDeps('B'),
      rbac: rd,
      recordNonce: (s: string, n: string) => recorded.push(`${s}:${n}`),
      onReject: (e: MeshEnvelope, reason: string) => rejected.push({ type: e.command.type, reason }),
      handlers: {
        'capacity-report': (_c: MeshCommand, sender: string) => { handled.push({ type: 'capacity-report', sender }); return { load: 1 }; },
        place: (_c: MeshCommand, sender: string) => { handled.push({ type: 'place', sender }); return { placed: true }; },
      },
      ...over,
    });
    return { d, recorded, rejected, handled };
  }

  it('accepts → records nonce → dispatches to the handler → returns result', async () => {
    const { d, recorded, handled } = makeDispatcher();
    const env = envFrom({ sender: 'ROUTER', recipient: 'B', command: { type: 'place', session: 's', machine: 'm' } });
    const r = await d.dispatch(env);
    expect(r).toEqual({ ok: true, result: { placed: true } });
    expect(recorded).toEqual(['ROUTER:n1']); // nonce burned on accept
    expect(handled).toEqual([{ type: 'place', sender: 'ROUTER' }]);
  });

  it('rejects an unauthorized command, audits it, and does NOT burn the nonce (403)', async () => {
    const { d, recorded, rejected, handled } = makeDispatcher();
    const env = envFrom({ sender: 'PEER', recipient: 'B', command: { type: 'place', session: 's', machine: 'm' } });
    const r = await d.dispatch(env);
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ reason: 'not-router', status: 403 });
    expect(rejected).toEqual([{ type: 'place', reason: 'not-router' }]);
    expect(recorded).toEqual([]); // rejected → nonce NOT consumed
    expect(handled).toEqual([]);
  });

  it('rejects a wrong-recipient replay with 401 (verify gate)', async () => {
    const { d } = makeDispatcher();
    const envForC = envFrom({ sender: 'ROUTER', recipient: 'C', command: { type: 'capacity-report' } });
    const r = await d.dispatch(envForC);
    expect(r).toMatchObject({ ok: false, reason: 'wrong-recipient', status: 401 });
  });

  it('accepts + burns nonce but returns no-handler (501) for a verified command with no registered handler', async () => {
    const { d, recorded } = makeDispatcher();
    const env = envFrom({ sender: 'ROUTER', recipient: 'B', command: { type: 'transfer', session: 's', target: 'm' } });
    const r = await d.dispatch(env);
    expect(r).toMatchObject({ ok: false, reason: 'no-handler', status: 501 });
    expect(recorded).toEqual(['ROUTER:n1']); // it WAS authorized — nonce burned
  });

  it('routes a read-class command from any peer to its handler', async () => {
    const { d, handled } = makeDispatcher();
    const env = envFrom({ sender: 'ANY_PEER', recipient: 'B', command: { type: 'capacity-report' } });
    const r = await d.dispatch(env);
    expect(r).toEqual({ ok: true, result: { load: 1 } });
    expect(handled).toEqual([{ type: 'capacity-report', sender: 'ANY_PEER' }]);
  });

  it('maps a replayed nonce to 409', async () => {
    const { d } = makeDispatcher({ verify: verifyDeps('B', { seenNonce: () => true }) });
    const env = envFrom({ sender: 'ANY_PEER', recipient: 'B', command: { type: 'capacity-report' } });
    expect((await d.dispatch(env)).status).toBe(409);
  });
});

/**
 * fb-faa9d074-e09 — Tier-2 integration. The REAL SessionRouter over the REAL
 * SessionOwnershipRegistry (in-memory store, real FSM + CAS), wired exactly as
 * server.ts wires it: claims through `place`, the takeover through
 * `takeOverActiveRecord` (a guarded force-claim).
 *
 * The incident: a conversation owned by a peer that could not take forwarded
 * messages waited in the holder's queue until it expired, because a plain
 * `place` never moves an ACTIVE record. These tests pin that root cause and the fix.
 */
import { describe, it, expect, vi } from 'vitest';
import { SessionRouter, type SessionRouterDeps } from '../../src/core/SessionRouter.js';
import { PlacementExecutor } from '../../src/core/PlacementExecutor.js';
import { SessionOwnershipRegistry, InMemorySessionOwnershipStore, takeOverActiveRecord } from '../../src/core/SessionOwnershipRegistry.js';
import type { MachineCapacity } from '../../src/core/types.js';

const SELF = 'm_studio';
const PEER = 'm_m5';
function cap(id: string): MachineCapacity { return { machineId: id, online: true, clockSkewStatus: 'ok', loadAvg: 1, activeSessionCount: 1, maxSessions: 10, memPressure: 'low', capabilities: ['sessions'] }; }

function world(opts: { peerAlive: boolean; peerReceives: boolean | null }) {
  const nonces = new Set<string>();
  const reg = new SessionOwnershipRegistry({ store: new InMemorySessionOwnershipStore(), seenNonce: (k) => nonces.has(k), recordNonce: (k) => nonces.add(k) });
  // The conversation runs on the peer.
  reg.cas({ type: 'place', machineId: PEER }, { sessionKey: '22', sender: SELF, nonce: 'p' });
  reg.cas({ type: 'claim', machineId: PEER }, { sessionKey: '22', sender: SELF, nonce: 'c' });
  let n = 0;
  const queued: string[] = [];
  const deps: SessionRouterDeps = {
    selfMachineId: SELF,
    placement: new PlacementExecutor(),
    machineRegistry: () => [cap(SELF), cap(PEER)],
    resolveOwnership: (sk) => {
      const r = reg.read(sk);
      return r ? { owner: r.ownerMachineId, epoch: r.ownershipEpoch, status: r.status === 'released' ? null : r.status } : { owner: null, epoch: 0, status: null };
    },
    isMachineAlive: (m) => (m === PEER ? opts.peerAlive : true),
    ownerSupportsForward: () => opts.peerReceives,
    casClaimOwnership: (sk, m) => {
      const r = reg.cas({ type: 'place', machineId: m }, { sessionKey: sk, sender: SELF, nonce: `p${++n}` });
      return { ok: r.ok, epoch: reg.read(sk)?.ownershipEpoch ?? 0 };
    },
    confirmClaim: (sk, m) => { reg.cas({ type: 'claim', machineId: m }, { sessionKey: sk, sender: SELF, nonce: `c${++n}` }); },
    takeOverFromPeer: (sk, from) => takeOverActiveRecord(reg, sk, from, SELF, `t${++n}`)?.ok === true,
    deliverMessage: async () => ({ messageId: 'x', accepted: 'queued' }),
    handleLocally: vi.fn(async () => {}),
    spawnOnMachine: vi.fn(async () => ({ messageId: 'x', accepted: 'queued' as const })),
    queueMessage: (m, reason) => { queued.push(reason); return 'queued'; },
    raiseAttention: () => {},
    markOwnerSuspect: () => {},
    sleep: async () => {},
  };
  return { reg, router: new SessionRouter(deps), queued, deps };
}

describe('a waiting message whose owner cannot take it (fb-faa9d074-e09)', () => {
  it('root cause: a plain place never moves the peer\'s active record', () => {
    const { reg } = world({ peerAlive: false, peerReceives: null });
    const r = reg.cas({ type: 'place', machineId: SELF }, { sessionKey: '22', sender: SELF, nonce: 'x' });
    expect(r.ok).toBe(false);
  });

  it('live path: a peer without durable receive keeps the message waiting (no immediate steal)', async () => {
    const { router, reg, queued } = world({ peerAlive: true, peerReceives: false });
    const out = await router.route({ sessionKey: '22', messageId: 'tg-22', payload: 'hi' });
    expect(out.action).toBe('queued');
    expect(queued).toEqual(['owner-lacks-ws11-receive']);
    expect(reg.read('22')?.ownerMachineId).toBe(PEER);
  });

  it('the queue\'s forced attempt takes the conversation here and answers it', async () => {
    const { router, reg } = world({ peerAlive: true, peerReceives: false });
    expect(await router.forceReplace({ sessionKey: '22', messageId: 'tg-22', payload: 'hi' })).toBe('local');
    expect(reg.read('22')).toMatchObject({ ownerMachineId: SELF, status: 'active' });
    // The drain then routes it again: now owned here, handled locally.
    expect((await router.route({ sessionKey: '22', messageId: 'tg-22', payload: 'hi' })).action).toBe('handled-locally');
  });

  it('a peer that DOES receive is never taken over by the forced attempt', async () => {
    const { router, reg } = world({ peerAlive: true, peerReceives: true });
    await router.forceReplace({ sessionKey: '22', messageId: 'tg-22', payload: 'hi' });
    expect(reg.read('22')?.ownerMachineId).toBe(PEER);
  });

  it('routing-only (pool dark): a gone peer\'s conversation is taken here instead of expiring', async () => {
    const { router, reg, queued } = world({ peerAlive: false, peerReceives: null });
    const out = await router.route({ sessionKey: '22', messageId: 'tg-23', payload: 'hi', routingOnly: true });
    expect(out).toMatchObject({ action: 'handled-locally', detail: 'routing-only' });
    expect(queued).toEqual([]);
    expect(reg.read('22')).toMatchObject({ ownerMachineId: SELF, status: 'active' });
  });

  it('the takeover guard refuses once the record moved elsewhere', () => {
    const { reg } = world({ peerAlive: false, peerReceives: null });
    expect(takeOverActiveRecord(reg, '22', 'm_other', SELF, 'g')).toBeNull();
    expect(reg.read('22')?.ownerMachineId).toBe(PEER);
  });
});

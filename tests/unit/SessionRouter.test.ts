/**
 * Tier-1 tests for SessionRouter (Multi-Machine Session Pool §L4 dispatch). Each
 * dispatch branch is covered with injected (real-shaped, deterministic) deps:
 * local-handle, remote-forward (+duplicate/+stale/+retry-then-fallback), owner-dead,
 * transient-queue, unowned-place-CAS (won/lost/blocked/queued), and the per-session
 * in-order / one-in-flight serialization guarantee.
 */
import { describe, it, expect, vi } from 'vitest';
import { SessionRouter, type SessionRouterDeps, type OwnershipView, type DeliverAck, type InboundMessage } from '../../src/core/SessionRouter.js';
import { PlacementExecutor } from '../../src/core/PlacementExecutor.js';
import type { MachineCapacity } from '../../src/core/types.js';

const SELF = 'm_self';
function cap(id: string, over: Partial<MachineCapacity> = {}): MachineCapacity {
  return { machineId: id, online: true, clockSkewStatus: 'ok', loadAvg: 1, activeSessionCount: 1, maxSessions: 10, memPressure: 'low', capabilities: ['sessions'], ...over };
}
function msg(over: Partial<InboundMessage> = {}): InboundMessage {
  return { sessionKey: 's1', messageId: 'evt-1', payload: { text: 'hi' }, ...over };
}

function makeRouter(over: Partial<SessionRouterDeps> = {}, registry: MachineCapacity[] = [cap(SELF), cap('m_remote', { loadAvg: 0 })]) {
  const deps: SessionRouterDeps = {
    selfMachineId: SELF,
    placement: new PlacementExecutor(),
    machineRegistry: () => registry,
    resolveOwnership: () => ({ owner: null, epoch: 0, status: null }) as OwnershipView,
    isMachineAlive: () => true,
    casClaimOwnership: vi.fn((_s: string, _m: string, e: number) => ({ ok: true, epoch: e + 1 })),
    deliverMessage: async () => ({ messageId: 'evt-1', accepted: 'queued' }) as DeliverAck,
    handleLocally: vi.fn(async () => {}),
    spawnOnMachine: vi.fn(async () => {}),
    queueMessage: vi.fn(),
    raiseAttention: vi.fn(),
    markOwnerSuspect: vi.fn(),
    sleep: vi.fn(async () => {}),
    ...over,
  };
  return { router: new SessionRouter(deps), deps };
}

describe('SessionRouter.dispatch (§L4)', () => {
  it('owned by SELF + active → handled locally (no MeshRpc hop)', async () => {
    const { router, deps } = makeRouter({ resolveOwnership: () => ({ owner: SELF, epoch: 4, status: 'active' }) });
    const out = await router.route(msg());
    expect(out).toMatchObject({ action: 'handled-locally', owner: SELF, acked: true });
    expect(deps.handleLocally).toHaveBeenCalledOnce();
  });

  it('owned by an alive remote → forwarded via deliverMessage; acked only on the queued ACK', async () => {
    const deliver = vi.fn(async () => ({ messageId: 'evt-1', accepted: 'queued' }) as DeliverAck);
    const { router } = makeRouter({ resolveOwnership: () => ({ owner: 'm_remote', epoch: 7, status: 'active' }), deliverMessage: deliver });
    const out = await router.route(msg());
    expect(out).toMatchObject({ action: 'forwarded', owner: 'm_remote', acked: true });
    expect(deliver).toHaveBeenCalledWith('m_remote', expect.objectContaining({ sessionKey: 's1', messageId: 'evt-1', ownershipEpoch: 7 }));
  });

  it('a duplicate deliverMessage ACK is acked but counts as duplicate (idempotent redelivery)', async () => {
    const { router } = makeRouter({ resolveOwnership: () => ({ owner: 'm_remote', epoch: 1, status: 'active' }), deliverMessage: async () => ({ messageId: 'evt-1', accepted: 'duplicate' }) });
    expect(await router.route(msg())).toMatchObject({ action: 'duplicate', acked: true });
  });

  it('stale-ownership ACK → re-resolve to the new live owner and forward there', async () => {
    let call = 0;
    const owners: OwnershipView[] = [
      { owner: 'm_remote', epoch: 1, status: 'active' },
      { owner: 'm_remote2', epoch: 2, status: 'active' },
    ];
    const deliver = vi.fn(async (target: string) => ({ messageId: 'evt-1', accepted: target === 'm_remote' ? 'stale-ownership' : 'queued' }) as DeliverAck);
    const { router } = makeRouter({ resolveOwnership: () => owners[Math.min(call++, 1)], deliverMessage: deliver }, [cap(SELF), cap('m_remote'), cap('m_remote2')]);
    const out = await router.route(msg());
    expect(out).toMatchObject({ action: 'forwarded', owner: 'm_remote2', acked: true });
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it('deliverMessage transport errors → retries with backoff, then owner-dead re-placement', async () => {
    const deliver = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const sleep = vi.fn(async () => {});
    const { router, deps } = makeRouter({
      resolveOwnership: () => ({ owner: 'm_remote', epoch: 1, status: 'active' }),
      deliverMessage: deliver,
      sleep,
    });
    const out = await router.route(msg());
    expect(deliver).toHaveBeenCalledTimes(4); // initial + 3 retries
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(deps.markOwnerSuspect).toHaveBeenCalledWith('m_remote');
    expect(out.action).toBe('owner-dead-replaced');
    expect(out.acked).toBe(true); // re-placed onto a live machine
  });

  it('stale-ownership for the SAME owner with an advanced epoch re-forwards at the new epoch (#7)', async () => {
    let call = 0;
    const owners: OwnershipView[] = [
      { owner: 'm_remote', epoch: 1, status: 'active' },
      { owner: 'm_remote', epoch: 5, status: 'active' }, // same owner, epoch advanced
    ];
    const epochs: number[] = [];
    const deliver = vi.fn(async (_t: string, env: { ownershipEpoch: number }) => {
      epochs.push(env.ownershipEpoch);
      return { messageId: 'evt-1', accepted: env.ownershipEpoch < 5 ? 'stale-ownership' : 'queued' } as DeliverAck;
    });
    const { router } = makeRouter({ resolveOwnership: () => owners[Math.min(call++, 1)], deliverMessage: deliver });
    const out = await router.route(msg());
    expect(out).toMatchObject({ action: 'forwarded', owner: 'm_remote', acked: true });
    expect(epochs).toEqual([1, 5]); // re-delivered to the same owner at the corrected epoch
  });

  it('a spurious same-owner same-epoch stale ACK falls through to re-place (no infinite loop)', async () => {
    const deliver = vi.fn(async () => ({ messageId: 'evt-1', accepted: 'stale-ownership' }) as DeliverAck);
    const { router } = makeRouter({ resolveOwnership: () => ({ owner: 'm_remote', epoch: 1, status: 'active' }), deliverMessage: deliver });
    const out = await router.route(msg());
    expect(['spawned', 'handled-locally', 'owner-dead-replaced', 'queued']).toContain(out.action);
  });

  it('owner not alive → owner-dead re-placement (marks suspect, re-places, claims)', async () => {
    const spawn = vi.fn(async () => {});
    const { router, deps } = makeRouter({
      resolveOwnership: () => ({ owner: 'm_dead', epoch: 1, status: 'active' }),
      isMachineAlive: (m) => m !== 'm_dead',
      spawnOnMachine: spawn,
    });
    const out = await router.route(msg());
    expect(deps.markOwnerSuspect).toHaveBeenCalledWith('m_dead');
    expect(out.action).toBe('owner-dead-replaced');
  });

  it('transient (placing/transferring) ownership → queued, NOT acked', async () => {
    const { router, deps } = makeRouter({ resolveOwnership: () => ({ owner: null, epoch: 3, status: 'placing' }) });
    const out = await router.route(msg());
    expect(out).toMatchObject({ action: 'queued', detail: 'placing', acked: false });
    expect(deps.queueMessage).toHaveBeenCalledWith(expect.anything(), 'ownership-contention');
  });

  it('unowned → place → CAS won → spawn on the chosen remote machine', async () => {
    const spawn = vi.fn(async () => {});
    const { router } = makeRouter({ spawnOnMachine: spawn }, [cap(SELF, { loadAvg: 9 }), cap('m_remote', { loadAvg: 0 })]);
    const out = await router.route(msg());
    expect(out).toMatchObject({ action: 'spawned', owner: 'm_remote', acked: true });
    expect(spawn).toHaveBeenCalledWith('m_remote', expect.objectContaining({ sessionKey: 's1' }));
  });

  it('unowned → place chooses SELF → handled locally', async () => {
    const { router, deps } = makeRouter({}, [cap(SELF, { loadAvg: 0 }), cap('m_remote', { loadAvg: 9 })]);
    const out = await router.route(msg());
    expect(out).toMatchObject({ action: 'handled-locally', owner: SELF, acked: true });
    expect(deps.handleLocally).toHaveBeenCalledOnce();
  });

  it('unowned → corrupt topic metadata → placement-blocked, attention raised, NOT acked', async () => {
    const { router, deps } = makeRouter();
    const out = await router.route(msg({ topicMetadata: { pinned: 'yes' } as never }));
    expect(out).toMatchObject({ action: 'placement-blocked', acked: false });
    expect(deps.raiseAttention).toHaveBeenCalled();
    expect(deps.casClaimOwnership).not.toHaveBeenCalled();
  });

  it('unowned → no capable machine → queued + attention, NOT acked', async () => {
    const { router, deps } = makeRouter({}, [cap(SELF, { online: false }), cap('m_remote', { online: false })]);
    const out = await router.route(msg());
    expect(out).toMatchObject({ action: 'queued', acked: false });
    expect(deps.raiseAttention).toHaveBeenCalled();
  });

  it('unowned → CAS LOST → re-read → forward to the winning owner', async () => {
    let n = 0;
    const deliver = vi.fn(async () => ({ messageId: 'evt-1', accepted: 'queued' }) as DeliverAck);
    const { router } = makeRouter({
      // first read: unowned; after a lost CAS, re-read shows m_remote won.
      resolveOwnership: () => (n++ === 0 ? { owner: null, epoch: 0, status: null } : { owner: 'm_remote', epoch: 1, status: 'active' }),
      casClaimOwnership: () => ({ ok: false, epoch: 1 }),
      deliverMessage: deliver,
    });
    const out = await router.route(msg());
    expect(out).toMatchObject({ action: 'forwarded', owner: 'm_remote', acked: true });
    expect(deliver).toHaveBeenCalledOnce();
  });

  it('unowned → CAS LOST → re-read transient → queued (ownership-contention)', async () => {
    let n = 0;
    const { router, deps } = makeRouter({
      resolveOwnership: () => (n++ === 0 ? { owner: null, epoch: 0, status: null } : { owner: null, epoch: 1, status: 'placing' }),
      casClaimOwnership: () => ({ ok: false, epoch: 1 }),
    });
    const out = await router.route(msg());
    expect(out).toMatchObject({ action: 'queued', detail: 'ownership-contention', acked: false });
    expect(deps.queueMessage).toHaveBeenCalled();
  });

  it('serializes messages per session: in-order, at-most-one-in-flight', async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => { releaseFirst = r; });
    let handleN = 0;
    const handleLocally = vi.fn(async (m: InboundMessage) => {
      events.push(`start:${m.messageId}`);
      if (handleN++ === 0) await gate; // first message blocks until released
      events.push(`end:${m.messageId}`);
    });
    const { router } = makeRouter({ resolveOwnership: () => ({ owner: SELF, epoch: 1, status: 'active' }), handleLocally });
    const p1 = router.route(msg({ messageId: 'm1' }));
    const p2 = router.route(msg({ messageId: 'm2' }));
    // m2 must NOT start until m1 ends — flush microtasks so m1 reaches the gate await.
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toEqual(['start:m1']);
    releaseFirst();
    await Promise.all([p1, p2]);
    expect(events).toEqual(['start:m1', 'end:m1', 'start:m2', 'end:m2']);
  });

  it('different sessions dispatch concurrently (independent chains)', async () => {
    const order: string[] = [];
    const handleLocally = vi.fn(async (m: InboundMessage) => { order.push(m.sessionKey); });
    const { router } = makeRouter({ resolveOwnership: () => ({ owner: SELF, epoch: 1, status: 'active' }), handleLocally });
    await Promise.all([router.route(msg({ sessionKey: 'a' })), router.route(msg({ sessionKey: 'b' }))]);
    expect(order.sort()).toEqual(['a', 'b']);
  });
});

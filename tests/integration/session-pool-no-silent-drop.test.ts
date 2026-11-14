/**
 * A real SessionRouter talking to a real receive handler on a machine with no channel: the
 * message must come back and be handled, never acked and lost. Both placement and forwarding.
 */
import { describe, it, expect, vi } from 'vitest';
import { SessionRouter } from '../../src/core/SessionRouter.js';
import { createDeliverMessageHandler } from '../../src/core/DeliverMessageHandler.js';
import { PlacementExecutor } from '../../src/core/PlacementExecutor.js';
import type { DeliverAck, SessionRouterDeps } from '../../src/core/SessionRouter.js';
import type { MachineCapacity } from '../../src/core/types.js';

const SELF = 'm_self';
const PEER = 'm_peer';
const cap = (machineId: string, loadAvg: number) =>
  ({ machineId, online: true, loadAvg, activeSessionCount: 0, maxSessions: 10, clockSkewStatus: 'ok' }) as unknown as MachineCapacity;

/** The peer: a real handler that cannot serve, as a join-built standby cannot. */
function pair(owner: string | null) {
  const received: string[] = [];
  const peer = createDeliverMessageHandler({
    ownerEpochOf: () => null,
    recordReceipt: (id) => { received.push(id); return true; },
    refusal: { canServe: () => false, alreadyReceived: () => false },
  });
  const hop = async (_t: string, m: { sessionKey: string; messageId: string; payload: unknown }, epoch: number) =>
    peer({ type: 'deliverMessage', session: m.sessionKey, messageId: m.messageId, payload: m.payload, ownershipEpoch: epoch } as never) as DeliverAck;
  const handleLocally = vi.fn(async () => {});
  const router = new SessionRouter({
    selfMachineId: SELF,
    placement: new PlacementExecutor(),
    machineRegistry: () => [cap(SELF, 9), cap(PEER, 0)],
    resolveOwnership: () => (owner ? { owner, epoch: 4, status: 'active' } : { owner: null, epoch: 0, status: null }) as never,
    isMachineAlive: () => true,
    casClaimOwnership: (_s: string, _m: string, e: number) => ({ ok: true, epoch: e + 1 }),
    deliverMessage: (t: string, env: { sessionKey: string; messageId: string; payload: unknown; ownershipEpoch: number }) => hop(t, env, env.ownershipEpoch),
    handleLocally,
    spawnOnMachine: hop,
    reclaimPlacement: () => true,
    queueMessage: () => 'refused',
    raiseAttention: vi.fn(),
    markOwnerSuspect: vi.fn(),
    sleep: async () => {},
  } as unknown as SessionRouterDeps);
  return { router, handleLocally, received };
}
const msg = { sessionKey: '42', messageId: 'evt-1', payload: 'hello' };

describe('a peer that cannot serve', () => {
  it('placed there: the message comes back and is handled here, and the peer records nothing', async () => {
    const p = pair(null);
    const out = await p.router.route(msg as never);
    expect(out).toMatchObject({ action: 'handled-locally', acked: true });
    expect(p.handleLocally).toHaveBeenCalledOnce();
    expect(p.received).toEqual([]);
  });
  it('already owned there: the message is re-placed and still handled, not lost', async () => {
    const p = pair(PEER);
    const out = await p.router.route(msg as never);
    expect(out.acked).toBe(true);
    expect(p.handleLocally).toHaveBeenCalledOnce();
    expect(p.received).toEqual([]);
  });
});

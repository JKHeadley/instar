/**
 * silent-loss-refusal-conservation §2.A — "A Refusal Stays a Refusal" ratchet.
 * The pre-fix code mapped the owner's `sender-rejected` NACK to a SUCCESS shape
 * (`{action:'forwarded', acked:true}`) at every consumer. These tests pin that a
 * refusal is now a first-class terminal `rejected` at forwardToOwner, that
 * forceReplace never reports it as "durably handled" (and returns the DISTINCT
 * verdict, not bare false), and that isRemotelyHandled(rejected) === false.
 */
import { describe, it, expect, vi } from 'vitest';
import { SessionRouter, isRemotelyHandled, type SessionRouterDeps, type OwnershipView, type DeliverAck, type InboundMessage, type RouteOutcome } from '../../src/core/SessionRouter.js';
import { PlacementExecutor } from '../../src/core/PlacementExecutor.js';
import type { MachineCapacity } from '../../src/core/types.js';

const SELF = 'm_self';
function cap(id: string, over: Partial<MachineCapacity> = {}): MachineCapacity {
  return { machineId: id, online: true, clockSkewStatus: 'ok', loadAvg: 1, activeSessionCount: 1, maxSessions: 10, memPressure: 'low', capabilities: ['sessions'], ...over };
}
function msg(over: Partial<InboundMessage> = {}): InboundMessage {
  return { sessionKey: 's1', messageId: 'evt-1', payload: { text: 'hi' }, senderEnvelope: { userId: 999 }, ...over };
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
    queueMessage: vi.fn(() => 'refused' as const),
    raiseAttention: vi.fn(),
    markOwnerSuspect: vi.fn(),
    sleep: vi.fn(async () => {}),
    ...over,
  };
  return { router: new SessionRouter(deps), deps };
}

describe('§2.A RouteOutcome ratchet — a refusal stays a refusal', () => {
  it('forwardToOwner maps a sender-rejected NACK to first-class `rejected` (NEVER `forwarded`)', async () => {
    const { router } = makeRouter({
      resolveOwnership: () => ({ owner: 'm_remote', epoch: 7, status: 'active' }),
      deliverMessage: async () => ({ messageId: 'evt-1', accepted: 'sender-rejected' }) as DeliverAck,
    });
    const out = await router.route(msg());
    expect(out.action).toBe('rejected');
    expect(out.action).not.toBe('forwarded');
    // acked:true is retained (transport-terminal — the offset advances, never
    // retried) but it is NOT delivery success.
    expect(out.acked).toBe(true);
    expect(out.detail).toBe('sender-deauthorized');
  });

  it('isRemotelyHandled(rejected) === false (a refusal is not "handled elsewhere")', () => {
    const outcome: RouteOutcome = { action: 'rejected', owner: 'm_remote', acked: true, detail: 'sender-deauthorized' };
    expect(isRemotelyHandled(outcome, SELF)).toBe(false);
    expect(isRemotelyHandled(outcome, 'm_remote')).toBe(false);
  });

  it('a peer marked owner-suspect is NEVER touched on a sender-rejected (peer is healthy, it answered)', async () => {
    const markOwnerSuspect = vi.fn();
    const { router } = makeRouter({
      resolveOwnership: () => ({ owner: 'm_remote', epoch: 1, status: 'active' }),
      deliverMessage: async () => ({ messageId: 'evt-1', accepted: 'sender-rejected' }) as DeliverAck,
      markOwnerSuspect,
    });
    await router.route(msg());
    expect(markOwnerSuspect).not.toHaveBeenCalled();
  });

  it('forceReplace-never-reports-rejected-as-handled: returns the DISTINCT `rejected` verdict, not true and not bare false', async () => {
    // Drive placeAndClaim → CAS-lost → forwardToOwner → sender-rejected.
    let casCalls = 0;
    const { router } = makeRouter({
      // placement picks a remote machine.
      resolveOwnership: () => ({ owner: 'm_remote', epoch: 3, status: 'active' }),
      casClaimOwnership: () => { casCalls++; return { ok: false, epoch: 3 }; },
      deliverMessage: async () => ({ messageId: 'evt-1', accepted: 'sender-rejected' }) as DeliverAck,
    });
    const res = await router.forceReplace(msg());
    expect(res).toBe('rejected'); // NOT true, NOT false → the drain maps it to sender-deauthorized
    expect(casCalls).toBeGreaterThan(0);
  });

  it('forceReplace returns true for a genuinely-handled re-place (regression guard for the boolean path)', async () => {
    const { router } = makeRouter({
      resolveOwnership: () => ({ owner: null, epoch: 0, status: null }),
      casClaimOwnership: (_s, _m, e) => ({ ok: true, epoch: e + 1 }),
    }, [cap(SELF)]); // self is the only machine → placed self → handled-locally
    const res = await router.forceReplace(msg());
    expect(res).toBe(true);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { InboundDeliveryStore } from '../../src/core/InboundDeliveryStore.js';
import { PhysicalEffectLock, type PhysicalEffectLease, type PhysicalEffectLeaseSync, type PhysicalEffectLockProvider } from '../../src/core/PhysicalEffectLock.js';
import { TrackedPhysicalEffectDispatcher, type TrackedEffectStore } from '../../src/core/TrackedPhysicalEffectDispatcher.js';

function harness(options: { reconciliation?: boolean } = {}) {
  let released = false;
  const lease: PhysicalEffectLease = {
    scope: 'c', ownerId: 'owner', epoch: 9, acquiredAt: 1,
    requiresReconciliation: options.reconciliation ?? false,
    assertHeld: vi.fn(() => { if (released) throw new Error('released'); }),
    release: vi.fn(async () => { released = true; }),
  };
  const provider: PhysicalEffectLockProvider = {
    name: 'fake', available: true, acquire: vi.fn(async () => lease),
    acquireSync: vi.fn(() => ({ ...lease, release: vi.fn(() => { released = true; }) } as PhysicalEffectLeaseSync)),
  };
  const store = InboundDeliveryStore.openMemory();
  const delivery = store.prepare({ conversationId: 'c', incarnation: 'i', framework: 'codex-cli', envelope: 'body', hmacKey: 'k' });
  return { lease, provider, store, delivery, lock: new PhysicalEffectLock(provider) };
}

function dispatchInput(deliveryId: string, effect = vi.fn()) {
  return { scope: 'c', conversationId: 'c', deliveryId, deadlineMs: Date.now() + 2_000, effect };
}

describe('TrackedPhysicalEffectDispatcher', () => {
  it('runs the synchronous production lane inside the same monotonic journal', () => {
    const h = harness();
    let calls = 0;
    const result = new TrackedPhysicalEffectDispatcher(h.lock, h.store).dispatchSync({
      scope: 'c', conversationId: 'c', deliveryId: h.delivery.deliveryId,
      deadlineMs: Date.now() + 2_000, fence: () => true, effect: () => { calls++; },
    });
    expect(result.status).toBe('completed');
    expect(calls).toBe(1);
    expect(h.store.get('c', h.delivery.deliveryId)?.transportState).toBe('dispatched');
  });

  it('serializes a control-plane effect without minting or transitioning a delivery', () => {
    const h = harness();
    const before = h.store.status().logicalRows;
    const effect = vi.fn();
    const result = new TrackedPhysicalEffectDispatcher(h.lock, h.store).controlSync({
      scope: 'c', deadlineMs: Date.now() + 2_000, fence: () => true, effect,
    });
    expect(result).toEqual({ ok: true, status: 'completed', leaseEpoch: 9 });
    expect(effect).toHaveBeenCalledOnce();
    expect(h.store.status().logicalRows).toBe(before);
    expect(h.store.get('c', h.delivery.deliveryId)?.transportState).toBe('prepared');
    expect(h.provider.acquireSync).toHaveBeenCalledOnce();
  });

  it('refuses a control-plane effect when the action-time fence changes', () => {
    const h = harness();
    const effect = vi.fn();
    const result = new TrackedPhysicalEffectDispatcher(h.lock, h.store).controlSync({
      scope: 'c', deadlineMs: Date.now() + 2_000, fence: () => false, effect,
    });
    expect(result).toEqual({ ok: false, status: 'refused', reason: 'reconciliation-required' });
    expect(effect).not.toHaveBeenCalled();
    expect(h.store.get('c', h.delivery.deliveryId)?.transportState).toBe('prepared');
  });
  it('holds the lease across durable arm, start, effect, and terminalization', async () => {
    const h = harness();
    const effect = vi.fn((lease: PhysicalEffectLease) => lease.assertHeld());
    const result = await new TrackedPhysicalEffectDispatcher(h.lock, h.store)
      .dispatch(dispatchInput(h.delivery.deliveryId, effect));
    expect(result).toEqual({ ok: true, status: 'completed', leaseEpoch: 9 });
    expect(effect).toHaveBeenCalledOnce();
    expect(h.store.get('c', h.delivery.deliveryId)?.transportState).toBe('dispatched');
    expect(h.lease.release).toHaveBeenCalledOnce();
  });

  it('refuses an unclean acquisition until reconciliation succeeds', async () => {
    const refused = harness({ reconciliation: true });
    const effect = vi.fn();
    const dispatcher = new TrackedPhysicalEffectDispatcher(refused.lock, refused.store);
    expect(await dispatcher.dispatch(dispatchInput(refused.delivery.deliveryId, effect))).toEqual({
      ok: false, status: 'refused', reason: 'reconciliation-required',
    });
    expect(effect).not.toHaveBeenCalled();
    expect(refused.store.get('c', refused.delivery.deliveryId)?.transportState).toBe('prepared');

    const accepted = harness({ reconciliation: true });
    const reconcile = vi.fn(async () => true);
    const acceptedResult = await new TrackedPhysicalEffectDispatcher(accepted.lock, accepted.store).dispatch({
      ...dispatchInput(accepted.delivery.deliveryId), reconcile,
    });
    expect(acceptedResult.ok).toBe(true);
    expect(reconcile).toHaveBeenCalledOnce();
  });

  it('allows the synchronous lane only after synchronous reconciliation', () => {
    const h = harness({ reconciliation: true });
    const effect = vi.fn();
    const reconcile = vi.fn(() => true);
    const result = new TrackedPhysicalEffectDispatcher(h.lock, h.store).dispatchSync({
      ...dispatchInput(h.delivery.deliveryId, effect), reconcile,
    });
    expect(result.ok).toBe(true);
    expect(reconcile).toHaveBeenCalledOnce();
    expect(effect).toHaveBeenCalledOnce();

    const asyncReconcile = harness({ reconciliation: true });
    const refused = new TrackedPhysicalEffectDispatcher(asyncReconcile.lock, asyncReconcile.store).dispatchSync({
      ...dispatchInput(asyncReconcile.delivery.deliveryId, vi.fn()), reconcile: async () => true,
    });
    expect(refused).toEqual({ ok: false, status: 'refused', reason: 'reconciliation-required' });
  });

  it('never executes when durable arm or start fails', async () => {
    for (const failAt of ['arm', 'start'] as const) {
      const h = harness();
      const effect = vi.fn();
      const base = h.store;
      const store: TrackedEffectStore = {
        armAttempt: base.armAttempt.bind(base),
        transitionAttempt: base.transitionAttempt.bind(base),
        transition: vi.fn((c, d, from, to) => {
          if (failAt === 'arm' && to === 'dispatch-armed') return false;
          if (failAt === 'start' && to === 'dispatch-started') return false;
          return base.transition(c, d, from, to);
        }),
      };
      const result = await new TrackedPhysicalEffectDispatcher(h.lock, store)
        .dispatch(dispatchInput(h.delivery.deliveryId, effect));
      expect(result).toMatchObject({ ok: false, status: 'refused', reason: failAt === 'arm' ? 'durable-arm-failed' : 'durable-start-failed' });
      expect(effect).not.toHaveBeenCalled();
      expect(h.lease.release).toHaveBeenCalledOnce();
    }
  });

  it('terminalizes a thrown or post-effect CAS-failed dispatch as unknown', async () => {
    const thrown = harness();
    const thrownResult = await new TrackedPhysicalEffectDispatcher(thrown.lock, thrown.store).dispatch(
      dispatchInput(thrown.delivery.deliveryId, vi.fn(() => { throw new Error('partial paste'); })),
    );
    expect(thrownResult).toMatchObject({ ok: false, status: 'effect-unknown', reason: 'effect-threw', error: 'partial paste' });
    expect(thrown.store.get('c', thrown.delivery.deliveryId)?.transportState).toBe('effect-unknown');

    const cas = harness();
    const base = cas.store;
    const store: TrackedEffectStore = {
      armAttempt: base.armAttempt.bind(base), transitionAttempt: base.transitionAttempt.bind(base),
      transition: vi.fn((c, d, from, to) => to === 'dispatched' ? false : base.transition(c, d, from, to)),
    };
    const casResult = await new TrackedPhysicalEffectDispatcher(cas.lock, store).dispatch(dispatchInput(cas.delivery.deliveryId));
    expect(casResult).toMatchObject({ ok: false, status: 'effect-unknown', reason: 'terminal-write-failed' });
    expect(base.get('c', cas.delivery.deliveryId)?.transportState).toBe('effect-unknown');
  });

  it('journals a key attempt before effect and makes ambiguity permanent', async () => {
    const h = harness();
    h.store.transition('c', h.delivery.deliveryId, 'prepared', 'dispatch-armed');
    h.store.transition('c', h.delivery.deliveryId, 'dispatch-armed', 'dispatch-started');
    h.store.transition('c', h.delivery.deliveryId, 'dispatch-started', 'dispatched');
    const effect = vi.fn(() => { throw new Error('keypress timeout'); });
    const result = await new TrackedPhysicalEffectDispatcher(h.lock, h.store).keyAttempt({
      ...dispatchInput(h.delivery.deliveryId, effect), attemptIndex: 0,
    });
    expect(result).toMatchObject({ ok: false, status: 'effect-unknown', reason: 'effect-threw' });
    expect(h.store.status().attemptsByState['effect-unknown']).toBe(1);
    expect(h.store.armAttempt('c', h.delivery.deliveryId, 0)).toBe(false);
  });
});

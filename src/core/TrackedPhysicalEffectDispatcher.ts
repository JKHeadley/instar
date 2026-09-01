import {
  PhysicalEffectLock,
  PhysicalEffectLockError,
  type PhysicalEffectLease,
} from './PhysicalEffectLock.js';
import type {
  AttemptState,
  DeliveryTransportState,
  InboundDeliveryStore,
} from './InboundDeliveryStore.js';

export type TrackedEffectRefusal =
  | 'lock-unavailable'
  | 'lock-timeout'
  | 'lock-failed'
  | 'reconciliation-required'
  | 'durable-arm-failed'
  | 'durable-start-failed';

export type TrackedEffectResult =
  | { ok: true; status: 'completed'; leaseEpoch: number }
  | { ok: false; status: 'refused'; reason: TrackedEffectRefusal }
  | { ok: false; status: 'effect-unknown'; reason: 'effect-threw' | 'terminal-write-failed'; leaseEpoch: number; error?: string };

export interface TrackedEffectStore {
  transition(
    conversationId: string,
    deliveryId: string,
    from: DeliveryTransportState,
    to: DeliveryTransportState,
  ): boolean;
  armAttempt(conversationId: string, deliveryId: string, attemptIndex: number): boolean;
  transitionAttempt(
    conversationId: string,
    deliveryId: string,
    attemptIndex: number,
    from: AttemptState,
    to: AttemptState,
  ): boolean;
}

export interface TrackedEffectCommon {
  scope: string;
  conversationId: string;
  deliveryId: string;
  deadlineMs: number;
  /** Required after unclean lock ownership. It must durably reconcile before returning true. */
  reconcile?: (lease: Omit<PhysicalEffectLease, 'release'>) => boolean | Promise<boolean>;
  /** Re-read ownership/stop/activity immediately after lock acquisition. */
  fence?: () => boolean;
  effect: (lease: Omit<PhysicalEffectLease, 'release'>) => void | Promise<void>;
}

export interface TrackedDispatchEffect extends TrackedEffectCommon {}

export interface TrackedKeyAttemptEffect extends TrackedEffectCommon {
  attemptIndex: number;
}

/**
 * A trusted control-plane mutation (for example Codex `/compact`) that must
 * serialize with delivery effects but is not itself an inbound delivery and
 * therefore has no delivery-state transitions to journal.
 */
export interface SerializedControlEffect extends Omit<TrackedEffectCommon, 'conversationId' | 'deliveryId'> {}

/**
 * The only composition permitted to execute a journaled physical effect.
 *
 * A lease is acquired before arming and remains held until a terminal durable
 * write (or the best available durable uncertainty write) has completed.
 */
export class TrackedPhysicalEffectDispatcher {
  constructor(
    private readonly lock: PhysicalEffectLock,
    private readonly store: TrackedEffectStore | InboundDeliveryStore,
  ) {}

  async dispatch(input: TrackedDispatchEffect): Promise<TrackedEffectResult> {
    return this.withLease(input, async (lease) => {
      if (!this.store.transition(input.conversationId, input.deliveryId, 'prepared', 'dispatch-armed')) {
        return { ok: false, status: 'refused', reason: 'durable-arm-failed' };
      }
      if (!this.store.transition(input.conversationId, input.deliveryId, 'dispatch-armed', 'dispatch-started')) {
        return { ok: false, status: 'refused', reason: 'durable-start-failed' };
      }
      try {
        lease.assertHeld();
        await input.effect(lease);
        lease.assertHeld();
      } catch (err) {
        this.store.transition(input.conversationId, input.deliveryId, 'dispatch-started', 'effect-unknown');
        return unknown('effect-threw', lease.epoch, err);
      }
      if (!this.store.transition(input.conversationId, input.deliveryId, 'dispatch-started', 'dispatched')) {
        // A successful physical call without its terminal CAS is ambiguous.
        this.store.transition(input.conversationId, input.deliveryId, 'dispatch-started', 'effect-unknown');
        return unknown('terminal-write-failed', lease.epoch);
      }
      return { ok: true, status: 'completed', leaseEpoch: lease.epoch };
    });
  }

  async keyAttempt(input: TrackedKeyAttemptEffect): Promise<TrackedEffectResult> {
    return this.withLease(input, async (lease) => {
      if (!this.store.armAttempt(input.conversationId, input.deliveryId, input.attemptIndex)) {
        return { ok: false, status: 'refused', reason: 'durable-arm-failed' };
      }
      if (!this.store.transitionAttempt(
        input.conversationId, input.deliveryId, input.attemptIndex, 'attempt-armed', 'attempt-started',
      )) {
        return { ok: false, status: 'refused', reason: 'durable-start-failed' };
      }
      try {
        lease.assertHeld();
        await input.effect(lease);
        lease.assertHeld();
      } catch (err) {
        this.store.transitionAttempt(
          input.conversationId, input.deliveryId, input.attemptIndex, 'attempt-started', 'effect-unknown',
        );
        return unknown('effect-threw', lease.epoch, err);
      }
      if (!this.store.transitionAttempt(
        input.conversationId, input.deliveryId, input.attemptIndex, 'attempt-started', 'attempted',
      )) {
        this.store.transitionAttempt(
          input.conversationId, input.deliveryId, input.attemptIndex, 'attempt-started', 'effect-unknown',
        );
        return unknown('terminal-write-failed', lease.epoch);
      }
      return { ok: true, status: 'completed', leaseEpoch: lease.epoch };
    });
  }

  dispatchSync(input: TrackedDispatchEffect): TrackedEffectResult {
    return this.withLeaseSync(input, (lease) => {
      if (!this.store.transition(input.conversationId, input.deliveryId, 'prepared', 'dispatch-armed'))
        return { ok: false, status: 'refused', reason: 'durable-arm-failed' };
      if (!this.store.transition(input.conversationId, input.deliveryId, 'dispatch-armed', 'dispatch-started'))
        return { ok: false, status: 'refused', reason: 'durable-start-failed' };
      try { lease.assertHeld(); input.effect(lease); lease.assertHeld(); }
      catch (err) {
        this.store.transition(input.conversationId, input.deliveryId, 'dispatch-started', 'effect-unknown');
        return unknown('effect-threw', lease.epoch, err);
      }
      if (!this.store.transition(input.conversationId, input.deliveryId, 'dispatch-started', 'dispatched')) {
        this.store.transition(input.conversationId, input.deliveryId, 'dispatch-started', 'effect-unknown');
        return unknown('terminal-write-failed', lease.epoch);
      }
      return { ok: true, status: 'completed', leaseEpoch: lease.epoch };
    });
  }

  keyAttemptSync(input: TrackedKeyAttemptEffect): TrackedEffectResult {
    return this.withLeaseSync(input, (lease) => {
      if (!this.store.armAttempt(input.conversationId, input.deliveryId, input.attemptIndex))
        return { ok: false, status: 'refused', reason: 'durable-arm-failed' };
      if (!this.store.transitionAttempt(input.conversationId, input.deliveryId, input.attemptIndex, 'attempt-armed', 'attempt-started'))
        return { ok: false, status: 'refused', reason: 'durable-start-failed' };
      try { lease.assertHeld(); input.effect(lease); lease.assertHeld(); }
      catch (err) {
        this.store.transitionAttempt(input.conversationId, input.deliveryId, input.attemptIndex, 'attempt-started', 'effect-unknown');
        return unknown('effect-threw', lease.epoch, err);
      }
      if (!this.store.transitionAttempt(input.conversationId, input.deliveryId, input.attemptIndex, 'attempt-started', 'attempted')) {
        this.store.transitionAttempt(input.conversationId, input.deliveryId, input.attemptIndex, 'attempt-started', 'effect-unknown');
        return unknown('terminal-write-failed', lease.epoch);
      }
      return { ok: true, status: 'completed', leaseEpoch: lease.epoch };
    });
  }

  controlSync(input: SerializedControlEffect): TrackedEffectResult {
    return this.withLeaseSync({
      ...input,
      // withLeaseSync only uses these fields for the shared shape; a control
      // effect deliberately never calls the delivery store.
      conversationId: '',
      deliveryId: '',
    }, (lease) => {
      try { lease.assertHeld(); input.effect(lease); lease.assertHeld(); }
      catch (err) { return unknown('effect-threw', lease.epoch, err); }
      return { ok: true, status: 'completed', leaseEpoch: lease.epoch };
    });
  }

  private withLeaseSync(input: TrackedEffectCommon,
    run: (lease: ReturnType<PhysicalEffectLock['acquireSync']>) => TrackedEffectResult): TrackedEffectResult {
    let lease: ReturnType<PhysicalEffectLock['acquireSync']>;
    try { lease = this.lock.acquireSync(input.scope, input.deadlineMs); }
    catch (err) {
      const reason: TrackedEffectRefusal = err instanceof PhysicalEffectLockError
        ? err.code === 'provider-unavailable' ? 'lock-unavailable'
          : err.code === 'deadline-exceeded' ? 'lock-timeout' : 'lock-failed'
        : 'lock-failed';
      return { ok: false, status: 'refused', reason };
    }
    try {
      if (lease.requiresReconciliation) {
        if (!input.reconcile) return { ok: false, status: 'refused', reason: 'reconciliation-required' };
        let reconciled: boolean | Promise<boolean> = false;
        try { reconciled = input.reconcile(lease); } catch { /* @silent-fallback-ok: reconciliation failure refuses mutation */ reconciled = false; }
        if (typeof (reconciled as Promise<boolean>)?.then === 'function' || reconciled !== true) {
          return { ok: false, status: 'refused', reason: 'reconciliation-required' };
        }
        lease.assertHeld();
      }
      if (input.fence?.() === false) return { ok: false, status: 'refused', reason: 'reconciliation-required' };
      return run(lease);
    } finally { lease.release(); }
  }

  private async withLease(
    input: TrackedEffectCommon,
    run: (lease: PhysicalEffectLease) => Promise<TrackedEffectResult>,
  ): Promise<TrackedEffectResult> {
    let lease: PhysicalEffectLease;
    try {
      lease = await this.lock.acquire(input.scope, input.deadlineMs);
    } catch (err) {
      if (err instanceof PhysicalEffectLockError) {
        const reason: TrackedEffectRefusal = err.code === 'provider-unavailable'
          ? 'lock-unavailable'
          : err.code === 'deadline-exceeded' ? 'lock-timeout' : 'lock-failed';
        return { ok: false, status: 'refused', reason };
      }
      return { ok: false, status: 'refused', reason: 'lock-failed' };
    }

    try {
      if (lease.requiresReconciliation) {
        if (!input.reconcile) return { ok: false, status: 'refused', reason: 'reconciliation-required' };
        let reconciled = false;
        try { reconciled = await input.reconcile(lease); } catch { /* @silent-fallback-ok: reconciliation failure refuses mutation */ reconciled = false; }
        if (!reconciled) return { ok: false, status: 'refused', reason: 'reconciliation-required' };
        lease.assertHeld();
      }
      if (input.fence?.() === false) return { ok: false, status: 'refused', reason: 'reconciliation-required' };
      return await run(lease);
    } finally {
      await lease.release();
    }
  }
}

function unknown(reason: 'effect-threw' | 'terminal-write-failed', leaseEpoch: number, err?: unknown): TrackedEffectResult {
  return {
    ok: false,
    status: 'effect-unknown',
    reason,
    leaseEpoch,
    ...(err === undefined ? {} : { error: err instanceof Error ? err.message : String(err) }),
  };
}

/**
 * SessionRouter — the L4 inbound-message dispatch engine (Multi-Machine Session
 * Pool §L4 "Message Routing to Owner" + "Ownership CAS at Dispatch"). For every
 * inbound message the router resolves session ownership and dispatches:
 *
 *   1. Owned + owner alive + owner == self  → handle locally (no MeshRpc hop).
 *   2. Owned + owner alive + owner != self  → forward via deliverMessage over MeshRpc
 *      (signed, recipient-bound, idempotent on messageId; ACK before offset advance).
 *   3. Owned + owner DEAD                    → owner-dead re-placement (re-place + claim).
 *   4. Transient (placing/transferring)      → queue (ownership-contention).
 *   5. Unowned (new)                         → PlacementExecutor.decide() → SYNCHRONOUS
 *      CAS-claim → spawn on the winner (or, on CAS loss, forward to the winner / queue).
 *
 * Per-session ordering: messages for ONE sessionKey are dispatched strictly in
 * inbound order, at-most-one-in-flight (a per-session promise chain). Different
 * sessions dispatch concurrently. All I/O is injected so the dispatch logic itself
 * is deterministic + unit-testable; the deliverMessage dep owns its own per-attempt
 * timeout (it throws on timeout) — the router owns the retry/backoff/fallback loop.
 */

import type { PlacementExecutor, TopicPlacement } from './PlacementExecutor.js';
import type { MachineCapacity } from './types.js';

export interface OwnershipView {
  owner: string | null;
  epoch: number;
  status: 'active' | 'placing' | 'transferring' | null;
  target?: string;
}

export interface DeliverAck {
  messageId: string;
  accepted: 'queued' | 'duplicate' | 'stale-ownership';
}

export interface InboundMessage {
  sessionKey: string;
  messageId: string;
  payload: unknown;
  topicMetadata?: TopicPlacement;
}

export type RouteAction =
  | 'handled-locally'
  | 'forwarded'
  | 'spawned'
  | 'queued'
  | 'duplicate'
  | 'owner-dead-replaced'
  | 'placement-blocked';

export interface RouteOutcome {
  action: RouteAction;
  owner?: string | null;
  detail?: string;
  /** True once the inbound is durably accepted (ledger ACK or local handling) — the
   * caller may advance the platform offset ONLY when this is true (§L4 ACK protocol). */
  acked: boolean;
}

export interface SessionRouterConfig {
  deliverMessageMaxRetries: number;
  deliverMessageRetryBackoffStartMs: number;
  deliverMessageRetryBackoffMaxMs: number;
  /** Bound on stale-ownership re-resolution to avoid an unbounded chase. */
  maxReResolveDepth: number;
}

export const DEFAULT_ROUTER_CONFIG: SessionRouterConfig = {
  deliverMessageMaxRetries: 3,
  deliverMessageRetryBackoffStartMs: 250,
  deliverMessageRetryBackoffMaxMs: 2000,
  maxReResolveDepth: 3,
};

export interface SessionRouterDeps {
  selfMachineId: string;
  placement: PlacementExecutor;
  machineRegistry: () => MachineCapacity[];
  resolveOwnership: (sessionKey: string) => OwnershipView;
  isMachineAlive: (machineId: string) => boolean;
  /** SYNCHRONOUS per-session CAS-claim (the §L−1 single-ref fast-forward push). */
  casClaimOwnership: (sessionKey: string, machineId: string, expectedEpoch: number) => { ok: boolean; epoch: number };
  /** ONE deliverMessage attempt over MeshRpc; throws on transport error/timeout. */
  deliverMessage: (target: string, env: { sessionKey: string; messageId: string; payload: unknown; ownershipEpoch: number }) => Promise<DeliverAck>;
  /** Router == owner: process the message on this machine. */
  handleLocally: (msg: InboundMessage) => Promise<void>;
  /** Instruct the chosen machine to spawn/resume the session. */
  spawnOnMachine: (machineId: string, msg: InboundMessage) => Promise<void>;
  queueMessage: (msg: InboundMessage, reason: string) => void;
  raiseAttention: (title: string, body: string) => void;
  markOwnerSuspect?: (machineId: string) => void;
  sleep: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export class SessionRouter {
  private readonly deps: SessionRouterDeps;
  private readonly cfg: SessionRouterConfig;
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(deps: SessionRouterDeps, cfg: SessionRouterConfig = DEFAULT_ROUTER_CONFIG) {
    this.deps = deps;
    this.cfg = cfg;
  }

  /** Dispatch an inbound message; serialized per-session (in-order, one-in-flight). */
  route(msg: InboundMessage): Promise<RouteOutcome> {
    const prior = this.chains.get(msg.sessionKey) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(() => this.dispatchOne(msg));
    // Track the tail so the next message on this session waits for this one to settle.
    this.chains.set(msg.sessionKey, next.then(() => undefined, () => undefined));
    return next;
  }

  private backoff(attempt: number): number {
    return Math.min(this.cfg.deliverMessageRetryBackoffStartMs * 2 ** attempt, this.cfg.deliverMessageRetryBackoffMaxMs);
  }

  private async dispatchOne(msg: InboundMessage): Promise<RouteOutcome> {
    const own = this.deps.resolveOwnership(msg.sessionKey);

    if (own.status === 'active' && own.owner) {
      if (own.owner === this.deps.selfMachineId) {
        await this.deps.handleLocally(msg);
        return { action: 'handled-locally', owner: own.owner, acked: true };
      }
      if (this.deps.isMachineAlive(own.owner)) {
        return this.forwardToOwner(msg, own.owner, own.epoch, 0);
      }
      // Owner is not alive → owner-dead re-placement (§L4 fallback).
      this.deps.markOwnerSuspect?.(own.owner);
      return this.placeAndClaim(msg, 'failover', true);
    }

    if (own.status === 'placing' || own.status === 'transferring') {
      this.deps.queueMessage(msg, 'ownership-contention');
      return { action: 'queued', detail: own.status, acked: false };
    }

    // Unowned → place + claim.
    return this.placeAndClaim(msg, 'new', false);
  }

  private async forwardToOwner(msg: InboundMessage, owner: string, epoch: number, reResolveDepth: number): Promise<RouteOutcome> {
    for (let attempt = 0; attempt <= this.cfg.deliverMessageMaxRetries; attempt++) {
      try {
        const ack = await this.deps.deliverMessage(owner, { sessionKey: msg.sessionKey, messageId: msg.messageId, payload: msg.payload, ownershipEpoch: epoch });
        if (ack.accepted === 'duplicate') return { action: 'duplicate', owner, acked: true };
        if (ack.accepted === 'queued') return { action: 'forwarded', owner, acked: true };
        // stale-ownership → re-resolve (bounded) and route to the current owner.
        if (reResolveDepth >= this.cfg.maxReResolveDepth) {
          return this.placeAndClaim(msg, 'failover', true);
        }
        const own2 = this.deps.resolveOwnership(msg.sessionKey);
        if (own2.status === 'active' && own2.owner === this.deps.selfMachineId) {
          await this.deps.handleLocally(msg);
          return { action: 'handled-locally', owner: own2.owner, detail: 'after-stale', acked: true };
        }
        // Re-forward to the current owner when ownership is still active+alive AND
        // something actually changed — a DIFFERENT owner, or the SAME owner whose
        // epoch advanced (the stale-ownership ACK meant our epoch view was behind;
        // re-deliver at the corrected epoch rather than needlessly re-placing). A
        // same-owner/same-epoch stale ACK is spurious → fall through to re-place.
        // Bounded by maxReResolveDepth. (2026-05-29 pre-merge review #7.)
        if (own2.status === 'active' && own2.owner && this.deps.isMachineAlive(own2.owner) && (own2.owner !== owner || own2.epoch !== epoch)) {
          return this.forwardToOwner(msg, own2.owner, own2.epoch, reResolveDepth + 1);
        }
        // Ownership moved to a transient/dead state (or a spurious same-epoch stale) → re-place.
        return this.placeAndClaim(msg, 'failover', true);
      } catch (err) {
        this.deps.log?.(`deliverMessage attempt ${attempt} to ${owner} failed: ${String((err as Error)?.message ?? err)}`);
        if (attempt < this.cfg.deliverMessageMaxRetries) {
          await this.deps.sleep(this.backoff(attempt));
          continue;
        }
      }
    }
    // Retries exhausted → owner is unreachable → owner-dead re-placement.
    this.deps.markOwnerSuspect?.(owner);
    return this.placeAndClaim(msg, 'failover', true);
  }

  private async placeAndClaim(msg: InboundMessage, reason: 'new' | 'failover', fromDead: boolean): Promise<RouteOutcome> {
    const decision = this.deps.placement.decide({
      sessionKey: msg.sessionKey,
      topicMetadata: msg.topicMetadata ?? {},
      machineRegistry: this.deps.machineRegistry(),
      currentOwner: undefined,
      reason,
    });

    if (decision.outcome === 'placement-blocked') {
      this.deps.raiseAttention('Session placement blocked', `${msg.sessionKey}: ${decision.escalationReason ?? decision.reason}`);
      this.deps.queueMessage(msg, `placement-blocked:${decision.escalationReason ?? decision.reason}`);
      return { action: 'placement-blocked', detail: decision.escalationReason ?? decision.reason, acked: false };
    }
    if (decision.outcome === 'queued' || !decision.chosenMachine) {
      this.deps.raiseAttention('No machine available for session', `${msg.sessionKey}: ${decision.escalationReason ?? decision.reason}`);
      this.deps.queueMessage(msg, decision.escalationReason ?? 'no-capable-machine');
      return { action: 'queued', detail: decision.escalationReason ?? decision.reason, acked: false };
    }

    // Synchronous CAS-claim (the dispatch BLOCKS on this — Invariant #2).
    const pre = this.deps.resolveOwnership(msg.sessionKey);
    const cas = this.deps.casClaimOwnership(msg.sessionKey, decision.chosenMachine, pre.epoch);
    if (!cas.ok) {
      // Contention — re-read; route to the confirmed winner or queue if transient.
      const own2 = this.deps.resolveOwnership(msg.sessionKey);
      if (own2.status === 'active' && own2.owner === this.deps.selfMachineId) {
        await this.deps.handleLocally(msg);
        return { action: 'handled-locally', owner: own2.owner, detail: 'cas-lost-self', acked: true };
      }
      if (own2.status === 'active' && own2.owner && this.deps.isMachineAlive(own2.owner)) {
        return this.forwardToOwner(msg, own2.owner, own2.epoch, 0);
      }
      this.deps.queueMessage(msg, 'ownership-contention');
      return { action: 'queued', detail: 'ownership-contention', acked: false };
    }

    // CAS won → spawn on the winner (or handle locally if that's us).
    const action: RouteAction = fromDead ? 'owner-dead-replaced' : 'spawned';
    if (decision.chosenMachine === this.deps.selfMachineId) {
      await this.deps.handleLocally(msg);
      return { action: fromDead ? 'owner-dead-replaced' : 'handled-locally', owner: decision.chosenMachine, detail: 'placed-self', acked: true };
    }
    await this.deps.spawnOnMachine(decision.chosenMachine, msg);
    return { action, owner: decision.chosenMachine, acked: true };
  }
}

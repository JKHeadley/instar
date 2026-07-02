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
  /**
   * `sender-rejected` (Durable Inbound Message Queue §3.4 remote path): a
   * typed, NON-retryable NACK — the receive side re-validated a carried
   * senderEnvelope.userId against ITS OWN users registry and refused. It does
   * NOT mark the owner suspect (the peer is healthy; it answered), is never
   * retried or re-placed (a re-placed owner's registry would reject
   * identically), and maps in the queue drain to terminal
   * `sender-deauthorized`. Old peers never emit it (version skew named).
   */
  accepted: 'queued' | 'duplicate' | 'stale-ownership' | 'sender-rejected';
}

/** Sender identity captured at ingress (Durable Inbound Message Queue §2.2) —
 *  persisted with queued custody so a later delivery still knows its real
 *  sender; carried on the mesh envelope for drained forwards. */
export interface InboundSenderEnvelope {
  userId?: string | number;
  username?: string;
  firstName?: string;
}

export interface InboundMessage {
  sessionKey: string;
  messageId: string;
  payload: unknown;
  topicMetadata?: TopicPlacement;
  senderEnvelope?: InboundSenderEnvelope | null;
  /** The channel scope this message arrived on — threaded into placement so a Slack channel
   *  is never placed on a machine not connected to its workspace (spec:
   *  placement-platform-workspace-aware). Populated at the inbound from the platform event
   *  (Slack: team_id → workspaceId + channelId). Absent (telegram — a SHARED chat — or a legacy
   *  inbound) → placement resolves `unknown` → fail-open. */
  channel?: import('./machineServesChannel.js').ChannelScope & { channelId?: string };
}

/** Tri-state custody outcome from the queueMessage dep (§2.2): the router
 *  sets `acked` true ONLY for `queued`/`already-queued` — `refused` keeps
 *  today's un-acked fall-through. */
export type QueueMessageResult = 'queued' | 'already-queued' | 'refused';

export type RouteAction =
  | 'handled-locally'
  | 'forwarded'
  | 'spawned'
  | 'queued'
  | 'duplicate'
  | 'owner-dead-replaced'
  | 'placement-blocked'
  /**
   * TERMINAL REFUSAL (silent-loss-refusal-conservation §2.A — "A Refusal Stays a
   * Refusal"). The owner peer answered a `deliverMessage` with a typed
   * `sender-rejected` NACK: it re-validated the carried sender against its OWN
   * users registry and refused. This is NOT a successful forward — it is a
   * first-class terminal outcome that MUST stay distinguishable from `forwarded`
   * at every consumer. `acked` is true (transport-terminal: the offset advances,
   * the message is never retried/re-placed — a re-placed owner's registry would
   * reject identically), but the message was DROPPED, not delivered. Every
   * consumer enumerates this branch explicitly and fires the §2.C loss notice
   * BEFORE any local-dispatch / isRemotelyHandled check. */
  | 'rejected';

export interface RouteOutcome {
  action: RouteAction;
  owner?: string | null;
  detail?: string;
  /**
   * TRANSPORT-TERMINAL, not delivery-success. True once the inbound reached a
   * terminal transport state and the platform offset may advance (§L4 ACK
   * protocol) — this includes a durable accept (ledger ACK / local handling) AND
   * a terminal `action:'rejected'` refusal (advance the offset so the refused
   * message is never retried). NEVER read `acked:true` as "the user received
   * this" — a `rejected` outcome is acked AND dropped. Read `action` to know
   * which. (Conservation of refusal: the pre-fix code set acked:true on a
   * rejection and labelled it `forwarded`, so every consumer read it as success.)
   */
  acked: boolean;
}

/**
 * Did this route() outcome place/forward the session onto ANOTHER machine — i.e.
 * the inbound dispatch caller must NOT also handle it locally?
 *
 * `'forwarded'`/`'duplicate'` always mean delivered to a remote owner. A fresh
 * placement on a remote machine returns `'spawned'` (self-placement returns
 * `'handled-locally'`, never `'spawned'`), and owner-dead re-placement returns
 * `'owner-dead-replaced'` for EITHER self or remote — so those two are remote only
 * when the resolved owner is not us. Everything else ('handled-locally', a
 * self 'owner-dead-replaced', 'queued', 'placement-blocked') is local/no-op and
 * falls through to local dispatch.
 *
 * Pure + caller-agnostic so the inbound dispatch decision is unit-testable. Before
 * this, the caller only treated 'forwarded'/'duplicate' as remote, so a just-moved
 * topic was spawned on the target AND injected into the stale local session
 * (double-dispatch — the bug the first live transfer test surfaced, 2026-05-31).
 */
export function isRemotelyHandled(outcome: RouteOutcome, selfMachineId: string | null): boolean {
  if (outcome.action === 'forwarded' || outcome.action === 'duplicate') return true;
  const remoteOwner = outcome.owner != null && outcome.owner !== selfMachineId;
  if (outcome.action === 'spawned' && remoteOwner) return true;
  if (outcome.action === 'owner-dead-replaced' && remoteOwner) return true;
  // 'rejected' is DELIBERATELY not "remotely handled" (§2.A): a refusal is not a
  // success, and treating it as handled-elsewhere would re-hide the drop. Every
  // consumer branches on action==='rejected' explicitly BEFORE reaching here (and
  // fires the loss notice); this function only classifies success dispositions.
  return false;
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
  /** WS1.1 (MULTI-MACHINE-SEAMLESSNESS-SPEC invariant 5): does the owner peer
   *  advertise the ws11DeliverReceive capability in its heartbeat?
   *  true  → forward normally.
   *  false → the peer is ALIVE but cannot durably receive (older version or
   *          its queue is dark): forwarding would 501→retry→failover-STEAL
   *          from a live owner — instead the message waits in OUR durable
   *          queue (the conservative side; bounded by the queue's own shelf
   *          life + the owner's flags flipping true on upgrade/next heartbeat).
   *  null  → unknown (no flags signal wired) — proceed as before (back-compat).
   *  Absent dep → proceed as before. */
  ownerSupportsForward?: (machineId: string) => boolean | null;
  /** SYNCHRONOUS per-session CAS-claim (the §L−1 single-ref fast-forward push). */
  casClaimOwnership: (sessionKey: string, machineId: string, expectedEpoch: number) => { ok: boolean; epoch: number };
  /** ONE deliverMessage attempt over MeshRpc; throws on transport error/timeout. */
  deliverMessage: (target: string, env: { sessionKey: string; messageId: string; payload: unknown; ownershipEpoch: number; senderEnvelope?: InboundSenderEnvelope | null }) => Promise<DeliverAck>;
  /** Router == owner: process the message on this machine. */
  handleLocally: (msg: InboundMessage) => Promise<void>;
  /** Instruct the chosen machine to spawn/resume the session. */
  spawnOnMachine: (machineId: string, msg: InboundMessage) => Promise<void>;
  /**
   * Confirm a just-placed REMOTE session as the owner (status placing→active) once
   * the spawn has been dispatched to it. Without this the ownership stays 'placing'
   * forever and every later message for the session queues (bug #11). Best-effort —
   * a confirm failure leaves the placement to recover via the normal fences.
   * (The owner-side resume runs on the target; in the single-router topology the
   * router holds the authoritative ownReg, so it confirms on the target's behalf —
   * the FSM only permits a claim whose machineId equals the placed owner.)
   */
  confirmClaim?: (sessionKey: string, machineId: string) => void;
  /** Tri-state custody taking (Durable Inbound Message Queue §2.2). The
   *  production dep is QueueDrainLoop.enqueueLive (never throws; a storage
   *  failure maps to 'refused' → today's fall-through). */
  queueMessage: (msg: InboundMessage, reason: string) => QueueMessageResult;
  raiseAttention: (title: string, body: string) => void;
  markOwnerSuspect?: (machineId: string) => void;
  /**
   * A deliverMessage attempt REACHED the owner (queued/duplicate/stale acks all
   * prove the peer is responsive). Wired to OwnerSuspectBreaker.recordSuccess
   * so the per-peer suspect window closes the moment the peer answers — the
   * other half of the markOwnerSuspect breaker (P19).
   */
  onOwnerResponsive?: (machineId: string) => void;
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
    // Track the tail so the next message on this session waits for this one to
    // settle — and DELETE the entry once this tail settles while still current,
    // so the map is bounded by in-flight sessions, not sessions-ever-routed
    // (P19 cap: the map previously grew one settled-promise entry per session
    // forever).
    const tail = next.then(() => undefined, () => undefined);
    this.chains.set(msg.sessionKey, tail);
    void tail.then(() => {
      if (this.chains.get(msg.sessionKey) === tail) this.chains.delete(msg.sessionKey);
    });
    return next;
  }

  /**
   * The queue drain's maxAttempts escape hatch (Durable Inbound Message Queue
   * §3.3): ONE forced re-place that bypasses hold/deliver verdicts — a direct
   * placeAndClaim('failover'), serialized on the session's chain like every
   * dispatch. Returns true when the message ended up durably handled
   * (acked outcome that isn't another queued/blocked verdict).
   */
  async forceReplace(msg: InboundMessage): Promise<boolean | 'rejected'> {
    const prior = this.chains.get(msg.sessionKey) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(() => this.placeAndClaim(msg, 'failover', true));
    const tail = next.then(() => undefined, () => undefined);
    this.chains.set(msg.sessionKey, tail);
    void tail.then(() => {
      if (this.chains.get(msg.sessionKey) === tail) this.chains.delete(msg.sessionKey);
    });
    const outcome = await next;
    // Ratchet (§2.A / round-2 adversarial #M1): a `rejected` outcome is
    // acked-but-DROPPED — it must NEVER read as "durably handled" here (the
    // drain's maxAttempts escape keys on this return value; a truthy value would
    // suppress the §2.C loss notice). It also must NOT return bare `false` — bare
    // false lands in the escape's `else` and mislabels the cause `attempts-exhausted`,
    // losing the refusal cause + the divergence signal. Return the DISTINCT
    // `'rejected'` verdict so the drain escape maps it to the SAME
    // `sender-deauthorized` terminal handling (unified notice + divergence probe).
    // placeAndClaim CAN yield `rejected` via its CAS-lost → forwardToOwner arm.
    if (outcome.action === 'rejected') return 'rejected';
    return (
      outcome.acked &&
      outcome.action !== 'queued' &&
      outcome.action !== 'placement-blocked'
    );
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
        // WS1.1 skew gate: a live owner that does NOT advertise the durable
        // receive capability must not be forwarded to (501→retry→failover
        // would STEAL from a live machine). The message waits in OUR durable
        // queue until the owner's flags flip (upgrade / queue re-enabled) or
        // ownership genuinely moves. Unknown (null) proceeds — back-compat.
        const supports = this.deps.ownerSupportsForward?.(own.owner) ?? null;
        if (supports === false) {
          const q = this.deps.queueMessage(msg, 'owner-lacks-ws11-receive');
          return { action: 'queued', detail: 'owner-lacks-ws11-receive', acked: q === 'queued' || q === 'already-queued' };
        }
        return this.forwardToOwner(msg, own.owner, own.epoch, 0);
      }
      // Owner is not alive → owner-dead re-placement (§L4 fallback).
      this.deps.markOwnerSuspect?.(own.owner);
      return this.placeAndClaim(msg, 'failover', true);
    }

    if (own.status === 'placing' || own.status === 'transferring') {
      const q = this.deps.queueMessage(msg, 'ownership-contention');
      return { action: 'queued', detail: own.status, acked: q === 'queued' || q === 'already-queued' };
    }

    // Unowned → place + claim.
    return this.placeAndClaim(msg, 'new', false);
  }

  private async forwardToOwner(msg: InboundMessage, owner: string, epoch: number, reResolveDepth: number): Promise<RouteOutcome> {
    for (let attempt = 0; attempt <= this.cfg.deliverMessageMaxRetries; attempt++) {
      try {
        const ack = await this.deps.deliverMessage(owner, { sessionKey: msg.sessionKey, messageId: msg.messageId, payload: msg.payload, ownershipEpoch: epoch, senderEnvelope: msg.senderEnvelope ?? null });
        // ANY ack (queued/duplicate/stale) proves the peer answered — close its
        // suspect window before interpreting the ack.
        this.deps.onOwnerResponsive?.(owner);
        if (ack.accepted === 'duplicate') return { action: 'duplicate', owner, acked: true };
        if (ack.accepted === 'queued') return { action: 'forwarded', owner, acked: true };
        // sender-rejected: typed authz NACK (§3.4 remote) — the peer answered
        // (healthy, never suspect) and durably REFUSED the sender. Terminal for
        // this message: acked so the offset advances; never retried/re-placed.
        if (ack.accepted === 'sender-rejected') {
          // §2.A — the core silent-loss fix. The owner re-validated the sender
          // and refused. Return the FIRST-CLASS terminal `rejected` (NOT
          // `forwarded`) so no consumer can read the refusal as a successful
          // delivery. `acked:true` still advances the offset (never retried —
          // a re-placed owner rejects identically); `detail` carries the
          // canonical cause the §2.C notice + drain unify on.
          return { action: 'rejected', owner, detail: 'sender-deauthorized', acked: true };
        }
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
      // Thread the channel scope so a Slack channel is never placed on a machine not connected
      // to its workspace (the live-test bug — a FAILOVER placement; both new+failover route through
      // here). Absent → unknown/fail-open (telegram shared, or legacy inbound).
      ...(msg.channel ? { channel: msg.channel } : {}),
    });

    if (decision.outcome === 'placement-blocked') {
      this.deps.raiseAttention('Session placement blocked', `${msg.sessionKey}: ${decision.escalationReason ?? decision.reason}`);
      const q = this.deps.queueMessage(msg, `placement-blocked:${decision.escalationReason ?? decision.reason}`);
      return { action: 'placement-blocked', detail: decision.escalationReason ?? decision.reason, acked: q === 'queued' || q === 'already-queued' };
    }
    if (decision.outcome === 'queued' || !decision.chosenMachine) {
      this.deps.raiseAttention('No machine available for session', `${msg.sessionKey}: ${decision.escalationReason ?? decision.reason}`);
      const q = this.deps.queueMessage(msg, decision.escalationReason ?? 'no-capable-machine');
      return { action: 'queued', detail: decision.escalationReason ?? decision.reason, acked: q === 'queued' || q === 'already-queued' };
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
      const q = this.deps.queueMessage(msg, 'ownership-contention');
      return { action: 'queued', detail: 'ownership-contention', acked: q === 'queued' || q === 'already-queued' };
    }

    // CAS won → spawn on the winner (or handle locally if that's us).
    const action: RouteAction = fromDead ? 'owner-dead-replaced' : 'spawned';
    if (decision.chosenMachine === this.deps.selfMachineId) {
      await this.deps.handleLocally(msg);
      return { action: fromDead ? 'owner-dead-replaced' : 'handled-locally', owner: decision.chosenMachine, detail: 'placed-self', acked: true };
    }
    await this.deps.spawnOnMachine(decision.chosenMachine, msg);
    // Confirm the remote owner (placing → active). The 'place' above left the record
    // transient; without this the session is owned-but-never-active and every later
    // message routes to the placing/transferring branch → queued forever (bug #11).
    this.deps.confirmClaim?.(msg.sessionKey, decision.chosenMachine);
    return { action, owner: decision.chosenMachine, acked: true };
  }
}

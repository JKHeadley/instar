/**
 * MessageRouter — message sending, routing, acknowledgment, and relay.
 *
 * The primary entry point for the messaging subsystem. Handles:
 * - Creating and sending messages with proper envelope wrapping
 * - Routing to local, cross-agent (same machine), or cross-machine targets
 * - Default TTL assignment per message type
 * - Thread auto-creation for query/request types
 * - Echo prevention (cannot send to self)
 * - Relay chain loop detection
 * - Deduplication on relay receipt
 * - Delivery state monotonic transitions
 * - Drop-directory fallback for offline agents
 * - Cross-machine relay with Ed25519 signatures and Machine-HMAC auth
 * - Outbound queue for offline cross-machine fallback
 *
 * Routing decision tree (from INTER-AGENT-MESSAGING-SPEC v3.1):
 *   target machine == local?
 *     → Yes: target agent == local agent?
 *       → Yes: deliver locally (no relay needed)
 *       → No: relay via POST /api/messages/relay-agent (Bearer token)
 *              If agent down → write to drop directory with HMAC
 *     → No: target machine paired and online?
 *       → Yes: relay via POST /api/messages/relay-machine (Machine-HMAC + Ed25519)
 *       → No: queue to outbound directory for git-sync fallback
 */

import { maskInbound } from './inboundCredentialMask.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ResolveResult } from './sessionAddressResolver.js';
import type {
  IMessageRouter,
  AgentMessage,
  MessageEnvelope,
  MessageFilter,
  MessageThread,
  ThreadStatus,
  MessageType,
  MessagePriority,
  SendMessageOptions,
  SendResult,
  DeliveryState,
  MessagingStats,
  SignedPayload,
} from './types.js';
import { DEFAULT_TTL, VALID_TRANSITIONS, CLOCK_SKEW_TOLERANCE, THREAD_STALE_MINUTES, machineRelayBody, GENERATION_RELAY_MACHINE_PATH, RELAY_MACHINE_PATH } from './types.js';
import { CrossMachineRelayQueue, type RelayPassOutcome } from './CrossMachineRelayQueue.js';
import type { MessageStore } from './MessageStore.js';
import { beginDeliveryAttempt, ownsDeliveryAttempt, type DeliveryAttemptClaim, type MessageDelivery } from './MessageDelivery.js';
import { getAgentToken, computeDropHmac } from './AgentTokenManager.js';
import { listAgents } from '../core/AgentRegistry.js';
import type { AgentRegistryEntry } from '../core/types.js';
import type { MachineIdentityManager } from '../core/MachineIdentity.js';
import { sign, verify } from '../core/MachineIdentity.js';
import { signRequest } from '../server/machineAuth.js';
import type { NonceStore } from '../core/NonceStore.js';
import type { SecurityLog } from '../core/SecurityLog.js';
import { localRouteSignatureCounters, logSafe, type LocalEnvelopeSigner } from '../threadline/localEnvelopeSignature.js';
import { describeHolderRefusal, isHolderPendingRefusal } from './sessionAddressResolver.js';
import type { PeerMessageGeneration } from './peerMessageTarget.js';

export interface MessageRouterConfig {
  localAgent: string;
  localMachine: string;
  serverUrl: string;
  /**
   * A2A local-route signed envelope (docs/specs/a2a-local-route-signed-envelope.md §7):
   * signs a same-machine envelope with this agent's identity key. Returns null
   * when it cannot (no identity, or `from.agent` is not this agent).
   */
  envelopeSigner?: LocalEnvelopeSigner;
  /**
   * Same-agent delivery guard: true when `tmuxSession` is a RUNNING session this
   * agent owns. A same-agent message to any other name is marked 'failed' and
   * never typed — so a wrong name cannot land in another agent's (or the
   * operator's own) tmux session on this host. Absent ⇒ no ownership check
   * (tests and embedders without a SessionManager).
   */
  isOwnSession?: (tmuxSession: string) => boolean;
  /**
   * messages-reach-renamed-sessions §A: who holds the role a same-agent message
   * names, as of `asOf` (ms). Absent ⇒ today's exact-name behaviour.
   */
  resolveSession?: (target: string, asOf: number) => ResolveResult;
  /**
   * relay-asof-holder-skew §3: where one JSONL row per holder refusal is appended
   * (reason, target, holder start vs reference time). Absent ⇒ no file; the envelope's
   * transitions still carry the refusal.
   */
  refusalAuditPath?: string;
  /** N73: trusted peer read, before message creation; never inferred from clocks. */
  /** Live sender-only rollout switch. Absent is off; receiver proof checks are always on. */
  generationBindingEnabled?: () => boolean;
  generationEvidence?: (kind: 'fired' | 'held' | 'error', reason: string, messageId: string) => void;
  peerSessionGeneration?: (machineId: string, target: string, timeoutMs: number) => Promise<PeerMessageGeneration>;
  /** §C: a same-agent message reached a terminal failure on this machine. Never throws. */
  onDeliveryFailure?: (envelope: MessageEnvelope, reason: string) => void;
  /** §C: failures with no session to tell, by `target|reason`, for GET /messages/stats. */
  undeliveredCounts?: () => Record<string, number>;
  /**
   * §D.3: guarded relay addresses for a machine (late-bound; the mesh is set up after
   * the router). Absent ⇒ cross-machine session messages fail with no address.
   */
  peerAddresses?: (machineId: string) => string[];
  /**
   * SEC-164 part 1 §3.5: read live for each send; when true, live keys in the subject and body are
   * masked before the envelope is saved, signed or delivered. Absent ⇒ off (tests and embedders).
   */
  credentialScrubEnabled?: () => boolean;
}

/** What the target's server said to a same-machine relay POST. */
export type LocalRelayOutcome =
  | { kind: 'accepted' }
  /** The receiver answered with an explicit `refused: true` body — terminal, never dropped. */
  | { kind: 'refused'; status: number; error: string; reason: string | null; retryable: boolean }
  /** Everything else, exactly as before: no token, a network error, any other answered error. */
  | { kind: 'unreachable' };

/** relay-asof-holder-skew §3: one row per holder refusal, countable by `reason`. */
export interface HolderRefusalAuditRow {
  ts: string;
  kind: 'holder-refusal';
  messageId: string;
  target: string;
  reason: string;
  /** The message's reference time (ISO, this clock): when it was written. */
  referenceTime: string;
  /** When the too-new holder started (ISO), for `role-respawned-after-message`. */
  holderStartedAt: string | null;
  /** The machine that relayed the message here, or null for a local send. */
  relayedFrom: string | null;
  attempt: number;
  outcome: 'received' | 'failed';
}

/** The refusal audit rolls over to `<file>.1` past this size (same shape as the a2a sweep audit). */
const REFUSAL_AUDIT_MAX_BYTES = 5 * 1024 * 1024;

/** Optional cross-machine crypto dependencies. Only needed when multi-machine is enabled. */
export interface CrossMachineDeps {
  identityManager: MachineIdentityManager;
  signingKeyPem: string;
  nonceStore: NonceStore;
  securityLog: SecurityLog;
}

/**
 * The ONE relay-chain-loop predicate (inbound-id ledger §1): `relay()` uses it,
 * and `/messages/relay-agent` calls it BEFORE the ledger commit so a loop
 * envelope writes no row.
 */
export function isRelayChainLoop(envelope: Pick<MessageEnvelope, 'transport'>, localMachine: string): boolean {
  const chain = (envelope?.transport as { relayChain?: unknown } | undefined)?.relayChain;
  return Array.isArray(chain) && chain.includes(localMachine);
}

export class MessageRouter implements IMessageRouter {
  private refusalAuditTail: Promise<void> = Promise.resolve();
  private refusalAuditReady: Promise<void> | null = null;
  private refusalAuditWarned = false;
  private readonly generationLanes = new Map<string, Promise<void>>();
  private readonly store: MessageStore;
  private readonly delivery: MessageDelivery;
  private readonly config: MessageRouterConfig;
  private readonly crossMachine: CrossMachineDeps | null;
  /** Monotonic sequence counter for Machine-HMAC outgoing requests */
  private machineSequence: number = 0;
  /** Optional summary sentinel for intelligent routing */
  private summarySentinel: import('./SessionSummarySentinel.js').SessionSummarySentinel | null = null;

  constructor(
    store: MessageStore,
    delivery: MessageDelivery,
    config: MessageRouterConfig,
    crossMachine?: CrossMachineDeps,
  ) {
    this.store = store;
    this.delivery = delivery;
    this.config = config;
    this.crossMachine = crossMachine ?? null;
    if (this.crossMachine) {
      const cm = this.crossMachine;
      this.relayQueue = new CrossMachineRelayQueue({
        localMachine: config.localMachine,
        addressesFor: (m) => { try { return this.config.peerAddresses?.(m) ?? []; } catch { return []; } }, // @silent-fallback-ok: an unreadable list is no address; the envelope fails with that reason
        resignForAttempt: (env) => {
          // The receiver requires relayChain[0] = signer; set it on every attempt so an
          // envelope re-queued from disk after a restart is signed the same way.
          env.transport.relayChain = [config.localMachine];
          const created = Date.parse(env.message.createdAt);
          env.transport.timestamp = new Date().toISOString();
          env.transport.age = Number.isFinite(created) ? Math.max(0, Date.now() - created) : 0;
          this.signEnvelope(env);
        },
        signRequestHeaders: (body) => signRequest(config.localMachine, cm.signingKeyPem, body, this.machineSequence++) as unknown as Record<string, string>,
        peerPublicKey: (m) => cm.identityManager.getSigningPublicKeyPem(m) ?? null,
        onOutcome: (env, outcome) => this.onRelayOutcome(env, outcome),
        log: (line) => console.warn(line),
      });
    }
  }

  /** §D.5: the per-machine relay queue (null without cross-machine deps). */
  private relayQueue: CrossMachineRelayQueue | null = null;

  /** Start the relay queue and give every envelope still `relaying` its one pass. */
  async startRelayQueue(): Promise<void> {
    if (!this.relayQueue) return;
    this.relayQueue.start();
    try {
      const all = await this.store.queryInbox(this.config.localAgent);
      for (const env of all) {
        if (env.delivery.phase === 'relaying' && env.message.from.machine === this.config.localMachine) this.relayQueue.enqueue(env);
      }
    } catch (err) {
      console.warn(`[message-router] relay queue boot sweep failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async setPhase(env: MessageEnvelope, to: MessageEnvelope['delivery']['phase'], reason: string, extra: Partial<MessageEnvelope['delivery']> = {}): Promise<void> {
    const now = new Date().toISOString();
    env.delivery = {
      ...env.delivery,
      ...extra,
      phase: to,
      transitions: [...env.delivery.transitions, { from: env.delivery.phase, to, at: now, reason }],
      ...(to === 'failed' ? { failureReason: reason } : {}),
    };
    await this.store.updateDelivery(env.message.id, env.delivery);
  }

  private async onRelayOutcome(env: MessageEnvelope, outcome: RelayPassOutcome): Promise<void> {
    // A notice or ack may already have moved it (relaying→failed by a remote notice).
    const current = await this.store.get(env.message.id).catch(() => null);
    if (current && current.delivery.phase !== 'relaying') return;
    if (outcome.kind === 'received') {
      await this.setPhase(env, 'received', `relayed to machine ${env.message.to.machine} via ${outcome.via} (signed ack)`);
      return;
    }
    const reason = outcome.kind === 'refused' ? `refused on ${env.message.to.machine}: ${outcome.code}` : outcome.reason;
    await this.setPhase(env, 'failed', reason);
    if (env.message.type !== 'delivery-notice') this.reportTerminalFailure(env, reason);
  }

  /**
   * §C/§D.6: a same-agent message reached a terminal failure on THIS machine. A message
   * that came from another of this agent's machines is reported back to that machine
   * (signed notice); one sent from here goes to the local sender notifier.
   */
  reportTerminalFailure(envelope: MessageEnvelope, reason: string): void {
    if (envelope.message.type === 'delivery-notice') return;
    const signer = envelope.transport.signedBy;
    if (signer && signer !== this.config.localMachine && envelope.message.from.machine === signer) {
      void this.sendRemoteNotice(envelope, reason, signer);
      return;
    }
    try { this.config.onDeliveryFailure?.(envelope, reason); } catch { /* @silent-fallback-ok: notice is best-effort; the failure is recorded on the envelope */ }
  }

  private async sendRemoteNotice(about: MessageEnvelope, reason: string, originMachine: string): Promise<void> {
    if (!this.relayQueue) return;
    const now = new Date().toISOString();
    const notice: MessageEnvelope = {
      schemaVersion: about.schemaVersion,
      message: {
        id: crypto.randomUUID(),
        from: { agent: this.config.localAgent, session: 'instar-server', machine: this.config.localMachine },
        to: { agent: this.config.localAgent, session: about.message.from.session, machine: originMachine },
        type: 'delivery-notice',
        priority: 'low',
        subject: 'Delivery notice',
        body: JSON.stringify({ aboutMessageId: about.message.id, reason }),
        createdAt: now,
        ttlMinutes: DEFAULT_TTL['delivery-notice'],
      },
      transport: { relayChain: [this.config.localMachine], originServer: this.config.serverUrl, nonce: `${crypto.randomUUID()}:${now}`, timestamp: now },
      delivery: { phase: 'relaying', transitions: [{ from: 'sent', to: 'relaying', at: now, reason: `delivery notice for ${about.message.id}` }], attempts: 0 },
    } as MessageEnvelope;
    try { await this.store.save(notice); } catch { /* @silent-fallback-ok: the queue still carries it; the store copy is the record only */ }
    this.relayQueue.enqueue(notice);
  }

  /**
   * §D.2: a relayed envelope arrived from another of this agent's machines. Checks run
   * BEFORE storing or acknowledging; a duplicate is answered only after they pass.
   * `requestSigner` is the machine-auth middleware's verified machine id.
   */
  async relayFromMachine(envelope: MessageEnvelope, requestSigner: string): Promise<{ outcome: 'stored' | 'duplicate' } | { outcome: 'refused'; code: string }> {
    const m = envelope?.message;
    if (!m?.id || !this.crossMachine) return { outcome: 'refused', code: 'relay-cross-machine-disabled' };
    if (isRelayChainLoop(envelope, this.config.localMachine)) return { outcome: 'refused', code: 'relay-loop' };
    if (m.to?.machine !== this.config.localMachine) return { outcome: 'refused', code: 'relay-wrong-machine' };
    if (m.from?.agent !== this.config.localAgent) return { outcome: 'refused', code: 'relay-wrong-agent' };
    const signer = envelope.transport?.signedBy;
    if (!signer || m.from.machine !== signer || envelope.transport.relayChain?.[0] !== signer || requestSigner !== signer) {
      return { outcome: 'refused', code: 'relay-sender-mismatch' };
    }
    const verified = this.verifyEnvelopeSignature(envelope);
    if (!verified.valid) {
      this.crossMachine.securityLog.append({ event: 'relay_signature_invalid', reason: verified.reason, messageId: m.id, signedBy: signer });
      return { outcome: 'refused', code: 'relay-signature-invalid' };
    }
    const created = Date.parse(m.createdAt);
    const ttlMs = (m.ttlMinutes ?? DEFAULT_TTL[m.type] ?? 30) * 60_000;
    const rawAge = typeof envelope.transport.age === 'number' ? envelope.transport.age : null;
    if (rawAge !== null && rawAge > ttlMs) return { outcome: 'refused', code: 'expired' };
    if (await this.store.exists(m.id) || (await this.store.isDeadLettered?.(m.id))) return { outcome: 'duplicate' };

    // A delivery notice about a message this machine sent: apply it, never type it.
    if (m.type === 'delivery-notice') {
      await this.applyRemoteNotice(envelope, signer);
      return { outcome: 'stored' };
    }

    const arrivedAt = Date.now();
    const age = rawAge === null ? 0 : Math.min(Math.max(0, rawAge), ttlMs);
    const nowIso = new Date(arrivedAt).toISOString();
    // Map sender-measured age onto the receiving clock. The old extra -2W
    // subtraction refused every young holder, even when it predated the send.
    // This is an age-based estimate, not proof of clock offset or bounded transit;
    // do not add a grace period that knowingly admits post-reference replacements.
    envelope.delivery = {
      phase: 'received',
      transitions: [...(envelope.delivery?.transitions ?? []), { from: envelope.delivery?.phase ?? 'sent', to: 'received', at: nowIso, reason: `relayed from ${signer}` }],
      attempts: 0,
      deliveryPending: !m.to.sessionGenerationRequired && !!m.to.session && m.to.session !== 'best',
      ...(m.to.sessionGenerationRequired ? { holderPending: true } : {}),
      arrivedAt: nowIso,
      expiresAt: arrivedAt + Math.max(0, ttlMs - age),
      // Older/unproven senders retain the original conservative fence. A bound
      // generation is checked by id below and does not rely on this estimate.
      asOf: arrivedAt - age - (m.to.sessionId ? 0 : 2 * (CLOCK_SKEW_TOLERANCE['relay-machine'] ?? 5 * 60_000)),
    };
    const claimed = await this.store.saveIfAbsent(envelope);
    if (!claimed) return { outcome: 'duplicate' };
    if (m.threadId) {
      try { await this.updateThread(m.threadId, m); } catch { /* @silent-fallback-ok: thread aggregate is observability */ }
    }
    if (envelope.delivery.deliveryPending || envelope.delivery.holderPending) {
      // The ack goes back before typing; delivery runs after the answer.
      setImmediate(() => { void this.deliverRelayed(envelope); });
    }
    return { outcome: 'stored' };
  }

  private async deliverRelayed(envelope: MessageEnvelope): Promise<void> {
    await this.deliverSameAgentLocal(envelope, undefined, true);
  }

  /** Recover persisted unfinished attempts; the exclusive wrapper rereads state. */
  async recoverPendingRelayed(): Promise<void> {
    let all: MessageEnvelope[] = [];
    try { all = await this.store.queryInbox(this.config.localAgent); } catch { return; } // @silent-fallback-ok: unreadable persisted state grants no delivery authority
    for (const env of all) {
      if (!env.delivery.deliveryPending) continue;
      if (['delivered', 'read', 'failed', 'expired', 'dead-lettered'].includes(env.delivery.phase)) continue;
      if (env.delivery.typingStartedAt || env.delivery.phase === 'received') await this.deliverRelayed(env);
    }
  }

  private async applyRemoteNotice(notice: MessageEnvelope, signer: string): Promise<void> {
    let about = '';
    let reason = 'not delivered';
    try {
      const parsed = JSON.parse(notice.message.body) as { aboutMessageId?: unknown; reason?: unknown };
      if (typeof parsed.aboutMessageId === 'string') about = parsed.aboutMessageId;
      if (typeof parsed.reason === 'string') reason = parsed.reason.slice(0, 500);
    } catch { return; } // @silent-fallback-ok: an unparseable notice names nothing; there is nothing to apply
    const orig = about ? await this.store.get(about).catch(() => null) : null;
    if (!orig) return;
    if (orig.message.to.machine !== signer || orig.message.from.machine !== this.config.localMachine) return;
    if (orig.delivery.phase !== 'relaying' && orig.delivery.phase !== 'received') return;
    const why = `refused on ${signer}: ${reason}`;
    await this.setPhase(orig, 'failed', why);
    try { this.config.onDeliveryFailure?.(orig, why); } catch { /* @silent-fallback-ok: notice is best-effort */ }
  }

  /** Runtime status uses the same live source as sender admission. */
  isGenerationBindingEnabled(): boolean { return this.config.generationBindingEnabled?.() === true; }

  /** N73: current role generation for an authenticated machine preflight. */
  currentSessionGeneration(target: string): string | null {
    if (!this.config.resolveSession) throw new Error('session generation resolver is unavailable');
    const result = this.config.resolveSession(target, Number.MAX_SAFE_INTEGER);
    return result.kind === 'exact' || result.kind === 'redirected' ? result.session.id : null;
  }

  /** Attach a summary sentinel for intelligent routing (session: "best") */
  setSummarySentinel(sentinel: import('./SessionSummarySentinel.js').SessionSummarySentinel): void {
    this.summarySentinel = sentinel;
  }

  async send(
    from: AgentMessage['from'], to: AgentMessage['to'], type: MessageType,
    priority: MessagePriority, subject: string, body: string, options?: SendMessageOptions,
  ): Promise<SendResult> {
    const { sessionId: _untrustedId, sessionGenerationRequired: _untrustedRequired, ...cleanAddress } = to;
    to = cleanAddress;
    const namedPeer = to.agent === this.config.localAgent && to.machine !== '*' && to.machine !== 'local'
      && to.machine !== this.config.localMachine && to.session !== '*' && to.session !== 'best';
    const bindingEnabled = namedPeer && this.isGenerationBindingEnabled();
    if (!bindingEnabled) return this.sendMessage(from, to, type, priority, subject, body, options, 5_000, false);
    // One preflight/send admission per peer. Waiting shares the same bounded
    // budget; expired waiters are recorded as explicit failures, not dropped.
    const started = performance.now();
    const previous = this.generationLanes.get(to.machine) ?? Promise.resolve();
    let release!: () => void;
    const owned = new Promise<void>((done) => { release = done; });
    const tail = previous.then(() => owned);
    this.generationLanes.set(to.machine, tail);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const admitted = await Promise.race([previous.then(() => true), new Promise<boolean>((done) => { timer = setTimeout(() => done(false), 5_000); })]);
      return await this.sendMessage(from, to, type, priority, subject, body, options,
        admitted ? Math.max(0, 5_000 - (performance.now() - started)) : 0, true);
    } finally {
      if (timer) clearTimeout(timer);
      release();
      void tail.then(() => { if (this.generationLanes.get(to.machine) === tail) this.generationLanes.delete(to.machine); });
    }
  }

  private async sendMessage(
    from: AgentMessage['from'],
    to: AgentMessage['to'],
    type: MessageType,
    priority: MessagePriority,
    subject: string,
    body: string,
    options?: SendMessageOptions,
    generationBudgetMs = 5_000,
    generationBinding = false,
  ): Promise<SendResult> {
    // SEC-164 §3.5: mask live keys before the envelope is saved or signed. A queued envelope is never
    // rewritten; only a new send is masked. Never throws: a failed check sends the text unchanged.
    if (this.config.credentialScrubEnabled) {
      let enabled = false;
      try { enabled = this.config.credentialScrubEnabled(); } catch { enabled = false; } // @silent-fallback-ok — unreadable switch is off
      subject = maskInbound(subject, { enabled }).text;
      body = maskInbound(body, { enabled }).text;
    }
    // Intelligent routing: resolve session: "best" to actual session.
    // Pass `from.session` as an exclusion so the sender's own session is
    // never selected as the target — otherwise a self-to-self match would
    // immediately trip the echo-prevention check below.
    if (to.session === 'best' && this.summarySentinel) {
      const isLocal = to.machine === 'local' || to.machine === this.config.localMachine;
      if (isLocal && to.agent === this.config.localAgent) {
        const scores = this.summarySentinel.findBestSession(subject, body, to.agent, from.session);
        if (scores.length > 0) {
          to = { ...to, session: scores[0].tmuxSession };
        }
        // If no match, keep "best" — it will be queued for the next available session
      }
    }

    // Echo prevention: cannot send to the same session on the same agent
    if (
      from.agent === to.agent &&
      from.session === to.session &&
      (to.machine === 'local' || to.machine === from.machine)
    ) {
      throw new Error('Cannot send a message to the same session (echo prevention)');
    }

    // The recipient generation is observed BEFORE createdAt. Network delay after
    // this point cannot redirect the message into a replacement with the same name.
    let generationUnavailable: string | undefined;
    if (to.agent === this.config.localAgent && to.machine !== '*' && to.machine !== 'local' && to.machine !== this.config.localMachine && to.session !== '*' && to.session !== 'best') {
      const { sessionId: _callerId, sessionGenerationRequired: _callerRequired, ...address } = to;
      to = address; // caller-supplied ids are never a trusted preflight observation
      if (generationBinding) {
      to = { ...address, sessionGenerationRequired: true };
      try {
        const proof = generationBudgetMs > 0 ? await this.config.peerSessionGeneration?.(to.machine, to.session, generationBudgetMs) : { reason: 'the recipient generation check could not start within its deadline' };
        if (proof && 'sessionId' in proof) to = { ...to, sessionId: proof.sessionId };
        else generationUnavailable = proof?.reason ?? 'receiving session generation is unavailable';
      } catch {
        // @silent-fallback-ok: absent proof records an explicit origin failure; never send unproved work
        generationUnavailable = 'receiving session generation check failed';
      }
      }
    }
    const messageId = crypto.randomUUID();
    const now = new Date().toISOString();
    const ttlMinutes = options?.ttlMinutes ?? DEFAULT_TTL[type];

    // Auto-create thread for query and request types
    let threadId = options?.threadId;
    if (!threadId && (type === 'query' || type === 'request')) {
      threadId = crypto.randomUUID();
    }

    const message: AgentMessage = {
      id: messageId,
      from,
      to,
      type,
      priority,
      subject,
      body,
      createdAt: now,
      ttlMinutes,
      threadId,
      inReplyTo: options?.inReplyTo,
    };

    const envelope: MessageEnvelope = {
      schemaVersion: 1,
      message,
      transport: {
        relayChain: [],
        originServer: this.config.serverUrl,
        nonce: `${crypto.randomUUID()}:${now}`,
        timestamp: now,
      },
      delivery: {
        phase: 'sent',
        transitions: [
          { from: 'created', to: 'sent', at: now },
        ],
        attempts: 0,
        ...(generationUnavailable ? { refusalDetail: `${generationUnavailable}; no receiving session generation was proved` } : {}),
      },
    };

    // Save to local store (outbox)
    await this.store.save(envelope);

    // Track thread if message has a threadId
    if (threadId) {
      await this.updateThread(threadId, message);
    }

    if (generationUnavailable) {
      const reason = `not sent: ${generationUnavailable}; no receiving session generation was proved`;
      await this.setPhase(envelope, 'failed', reason);
      this.recordGenerationEvidence('held', 'proof-unavailable', messageId);
      this.reportTerminalFailure(envelope, reason);
      return { messageId, threadId, phase: 'failed' };
    }

    // Route the message based on target
    const isLocalMachine = to.machine === 'local' || to.machine === this.config.localMachine;
    const isLocalAgent = to.agent === this.config.localAgent;

    if (isLocalMachine && !isLocalAgent) {
      // Cross-agent, same machine → relay via HTTP or drop directory
      await this.routeCrossAgentLocal(envelope);
    } else if (!isLocalMachine) {
      // Cross-machine → relay via HTTP with Ed25519 or queue to outbound
      await this.routeCrossMachine(envelope);
    } else if (to.session !== '*' && to.session !== 'best') {
      // Same agent, same machine, a NAMED session: type it into that session
      // now. Before this branch the envelope sat at 'sent' forever — nothing
      // reads a same-agent 'sent' row, and DeliveryRetryManager only retries
      // 'queued'/'undelivered' — so sessions had no working private channel to
      // each other and fell back to posting in the user's Telegram topic
      // (bug 2026-11-03, Echo Bugs topic 10000001474).
      await this.deliverSameAgentLocal(envelope, undefined, true);
    }
    // Broadcast ('*') and an unresolved 'best' stay saved locally as before.

    return {
      messageId,
      threadId,
      phase: (await this.store.get(messageId))?.delivery.phase ?? 'failed',
    };
  }

  async acknowledge(messageId: string, sessionId: string): Promise<void> {
    const envelope = await this.store.get(messageId);
    if (!envelope) return;

    // Validate transition: must be at 'delivered' to advance to 'read'
    if (!this.isValidTransition(envelope.delivery.phase, 'read')) {
      return;
    }

    const now = new Date().toISOString();
    const delivery: DeliveryState = {
      ...envelope.delivery,
      phase: 'read',
      transitions: [
        ...envelope.delivery.transitions,
        { from: envelope.delivery.phase, to: 'read', at: now, reason: `ack by ${sessionId}` },
      ],
    };

    await this.store.updateDelivery(messageId, delivery);
  }

  /** This machine's id as the relay chain records it (for isRelayChainLoop). */
  get localMachine(): string {
    return this.config.localMachine;
  }

  async relay(envelope: MessageEnvelope, source: 'agent' | 'machine'): Promise<boolean> {
    // Loop prevention: check if our machine is already in the relay chain
    if (isRelayChainLoop(envelope, this.config.localMachine)) {
      return false;
    }

    // Deduplication: if message already exists, return ACK but don't re-store
    if (await this.store.exists(envelope.message.id)) {
      return true;
    }

    // Cross-machine relay requires Ed25519 signature verification
    if (source === 'machine') {
      if (!this.crossMachine) {
        return false; // Cross-machine not enabled
      }
      const verifyResult = this.verifyEnvelopeSignature(envelope);
      if (!verifyResult.valid) {
        this.crossMachine.securityLog.append({
          event: 'relay_signature_invalid',
          reason: verifyResult.reason,
          messageId: envelope.message.id,
          signedBy: envelope.transport.signedBy ?? 'unknown',
        });
        return false;
      }
    }

    // Update delivery phase to 'received'
    const now = new Date().toISOString();
    envelope.delivery = {
      phase: 'received',
      transitions: [
        ...envelope.delivery.transitions,
        { from: envelope.delivery.phase, to: 'received', at: now },
      ],
      attempts: 0,
    };

    await this.store.save(envelope);

    // Maintain the thread aggregate so getThread()/threadline_history return
    // this inbound leg. relay() previously only saved the envelope file, so the
    // threads/{id}.json aggregate getThread reads was never built for relayed
    // threads — getThread 404'd even with envelope files on disk (the C/D bug).
    // Non-fatal: the aggregate is observability, never gates delivery.
    if (envelope.message.threadId) {
      try {
        await this.updateThread(envelope.message.threadId, envelope.message);
      } catch (err) {
        console.warn(`[MessageRouter] updateThread (relay) failed for ${envelope.message.threadId}: ${err instanceof Error ? err.message : err}`);
      }
    }
    return true;
  }

  /**
   * Record a locally-delivered OUTBOUND leg into our own store + thread
   * aggregate. The relay-send local fast-path POSTs straight to the peer and
   * never persisted the sender's own outbound message, so each node's history
   * held only the other agent's half (the D bug). This makes getThread() return
   * BOTH legs. Idempotent (store.save dedups by message id). Non-fatal.
   */
  async recordLocalOutbound(envelope: MessageEnvelope): Promise<void> {
    // Idempotent: updateThread is NOT internally idempotent (it pushes the
    // message id + bumps messageCount unconditionally), so gate it on a
    // first-sight check — a re-record of the same message id must not
    // double-count the thread aggregate. (store.save already no-ops on a
    // duplicate file.)
    const alreadyStored = await this.store.exists(envelope.message.id);
    await this.store.save(envelope);
    if (!alreadyStored && envelope.message.threadId) {
      try {
        await this.updateThread(envelope.message.threadId, envelope.message);
      } catch (err) {
        console.warn(`[MessageRouter] updateThread (outbound) failed for ${envelope.message.threadId}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  async getMessage(messageId: string): Promise<MessageEnvelope | null> {
    return this.store.get(messageId);
  }

  async getInbox(agentName: string, filter?: MessageFilter): Promise<MessageEnvelope[]> {
    return this.store.queryInbox(agentName, filter);
  }

  async getOutbox(agentName: string, filter?: MessageFilter): Promise<MessageEnvelope[]> {
    return this.store.queryOutbox(agentName, filter);
  }

  async getDeadLetters(filter?: MessageFilter): Promise<MessageEnvelope[]> {
    return this.store.queryDeadLetters(filter);
  }

  // ── Thread Management ──────────────────────────────────────────

  async getThread(threadId: string): Promise<{ thread: MessageThread; messages: MessageEnvelope[] } | null> {
    const thread = await this.store.getThread(threadId);
    if (!thread) return null;

    // Fetch all messages in the thread
    const messages: MessageEnvelope[] = [];
    for (const msgId of thread.messageIds) {
      const env = await this.store.get(msgId);
      if (env) messages.push(env);
    }

    // Check staleness
    if (thread.status === 'active') {
      const lastActivity = new Date(thread.lastMessageAt).getTime();
      const staleThreshold = Date.now() - THREAD_STALE_MINUTES * 60_000;
      if (lastActivity < staleThreshold) {
        thread.status = 'stale';
        await this.store.saveThread(thread);
      }
    }

    return { thread, messages };
  }

  async listThreads(status?: ThreadStatus): Promise<MessageThread[]> {
    const threads = await this.store.listThreads(status);

    // Check staleness for active threads
    const now = Date.now();
    const staleThreshold = now - THREAD_STALE_MINUTES * 60_000;
    for (const thread of threads) {
      if (thread.status === 'active') {
        const lastActivity = new Date(thread.lastMessageAt).getTime();
        if (lastActivity < staleThreshold) {
          thread.status = 'stale';
          await this.store.saveThread(thread);
        }
      }
    }

    // Re-filter if status was specified (stale threads may have just changed)
    if (status) {
      return threads.filter(t => t.status === status);
    }
    return threads;
  }

  async resolveThread(threadId: string): Promise<void> {
    const thread = await this.store.getThread(threadId);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);

    thread.status = 'resolved';
    await this.store.saveThread(thread);
    await this.store.archiveThread(threadId);
  }

  private async updateThread(threadId: string, message: AgentMessage): Promise<void> {
    const now = message.createdAt;
    let thread = await this.store.getThread(threadId);

    if (!thread) {
      // Create new thread
      thread = {
        id: threadId,
        subject: message.subject,
        participants: [{
          agent: message.from.agent,
          session: message.from.session,
          joinedAt: now,
          lastMessageAt: now,
        }],
        createdAt: now,
        lastMessageAt: now,
        messageCount: 1,
        status: 'active',
        messageIds: [message.id],
      };
    } else {
      // Update existing thread
      thread.lastMessageAt = now;
      thread.messageCount++;
      thread.messageIds.push(message.id);

      // Un-stale a thread if a new message arrives
      if (thread.status === 'stale') {
        thread.status = 'active';
      }

      // Add or update participant
      const participant = thread.participants.find(
        p => p.agent === message.from.agent && p.session === message.from.session,
      );
      if (participant) {
        participant.lastMessageAt = now;
      } else {
        thread.participants.push({
          agent: message.from.agent,
          session: message.from.session,
          joinedAt: now,
          lastMessageAt: now,
        });
      }
    }

    await this.store.saveThread(thread);
  }

  async getStats(): Promise<MessagingStats & { undelivered?: Record<string, number> }> {
    const stats = await this.store.getStats();
    const undelivered = this.config.undeliveredCounts?.();
    return undelivered ? { ...stats, undelivered } : stats;
  }

  /**
   * messages-reach-renamed-sessions §C: an HTTP caller's `from` is its own text.
   * `from.agent` and `from.machine` are forced to this agent and machine; any other
   * values are kept in `from.requested` for the record. `from.session` is kept.
   */
  forceLocalSender(from: AgentMessage['from']): AgentMessage['from'] {
    const agent = this.config.localAgent;
    const machine = this.config.localMachine;
    const sameAgent = from?.agent === agent;
    const sameMachine = !from?.machine || from.machine === machine || from.machine === 'local';
    if (sameAgent && sameMachine) return { ...from, agent, machine };
    return { ...from, agent, machine, requested: { agent: from?.agent, machine: from?.machine } };
  }

  // ── Routing: Cross-Agent Same-Machine ───────────────────────────

  /**
   * Route a message to a different agent on the same machine.
   *
   * Resolution order (per spec §Cross-Agent Resolution):
   * 1. Look up target agent in ~/.instar/registry.json
   * 2. Verify agent is running (PID alive + server responds to health)
   * 3. Forward via POST http://localhost:{port}/messages/relay-agent
   *    with Bearer token from ~/.instar/agent-tokens/{agentName}.token
   * 4. If agent server is down → write to drop directory with HMAC
   */
  /**
   * Deliver a same-agent message into its named local session. A target that
   * is not a running session of this agent (config.isOwnSession) → 'failed',
   * never typed. Otherwise success → 'delivered'; any delivery failure
   * (unsafe foreground process, send-keys error, or a throw) → 'queued', which
   * DeliveryRetryManager's Layer-2 loop retries every 30s for ~5 minutes and
   * then dead-letters. Never throws: the message is already saved.
   *
   * relay-asof-holder-skew: a role the store knows but nobody holds yet, or whose
   * only holder started too late, is 'queued' with `holderPending` instead of
   * 'failed'. The retry loop re-resolves it each pass (redeliverSameAgentLocal);
   * when the lane is exhausted the sender gets the plain reason.
   */
  private async deliverSameAgentLocal(envelope: MessageEnvelope, inheritedClaim?: DeliveryAttemptClaim, initialOnly = false): Promise<void> {
    const inherited = ownsDeliveryAttempt(inheritedClaim, envelope.message.id);
    const claim = inherited ? inheritedClaim! : beginDeliveryAttempt(envelope.message.id);
    if (!claim) return;
    try {
      // The inbox snapshot may predate another completed attempt. Refresh only
      // its mutable delivery state under exclusive ownership before acting.
      const latest = await this.store.get(envelope.message.id);
      if (!latest) return; // A stale inbox snapshot is not authority to resurrect a dead letter.
      if (latest) {
        envelope.delivery = latest.delivery;
        if (initialOnly && latest.delivery.phase !== 'sent'
          && !(latest.delivery.phase === 'received' && (latest.delivery.deliveryPending
            || (latest.delivery.holderPending && !latest.delivery.holderRetryState)))) return;
        if (['delivered', 'read', 'failed', 'expired', 'dead-lettered'].includes(latest.delivery.phase)) return;
        if (latest.delivery.deliveryPending && latest.delivery.typingStartedAt) {
          const reason = 'outcome unknown: delivery began but its final state was not recorded; the message may have arrived';
          await this.setPhase(envelope, 'failed', reason, { deliveryPending: false });
          if (envelope.message.to.sessionId) this.recordGenerationEvidence('error', 'delivery-outcome-unknown', envelope.message.id);
          this.reportTerminalFailure(envelope, reason);
          return;
        }
      }
      const created = Date.parse(envelope.message.createdAt);
      const ttl = (envelope.message.ttlMinutes ?? DEFAULT_TTL[envelope.message.type] ?? 30) * 60_000;
      if (Date.now() > (envelope.delivery.expiresAt ?? (Number.isFinite(created) ? created + ttl : Number.MAX_SAFE_INTEGER))) {
        await this.setPhase(envelope, 'failed', 'TTL expired', { deliveryPending: false });
        this.reportTerminalFailure(envelope, 'TTL expired'); return;
      }
      await this.doDeliverSameAgentLocal(envelope);
    } finally { if (!inherited) claim.release(); }
  }

  private async doDeliverSameAgentLocal(envelope: MessageEnvelope): Promise<void> {
    const requested = envelope.message.to.session;
    let target = requested;
    let success = false;
    let outcomeUnknown = false;
    let reason = '';
    let owned = true;
    let holderPending = false;
    let refusalDetail: string | undefined;
    let resolvedNote = '';
    if ((envelope.message.to.sessionGenerationRequired || envelope.message.to.sessionId) && !this.config.resolveSession) {
      owned = false;
      reason = 'target session generation cannot be verified on this receiver';
    }
    if (this.config.resolveSession) {
      let res: ResolveResult;
      // §D.3: a relayed message carries its reference time on this clock.
      const rawAsOf = typeof envelope.delivery.asOf === 'number' ? envelope.delivery.asOf : Date.parse(envelope.message.createdAt);
      const asOf = Number.isFinite(rawAsOf) ? rawAsOf : Date.now();
      try {
        const expectedId = envelope.message.to.sessionId;
        res = envelope.message.to.sessionGenerationRequired && !expectedId
          ? { kind: 'none', reason: 'target-session-generation-unavailable', known: true }
          : this.config.resolveSession(requested, expectedId ? Number.MAX_SAFE_INTEGER : asOf);
        if (expectedId && (res.kind === 'exact' || res.kind === 'redirected') && res.session.id !== expectedId) {
          res = { kind: 'none', reason: 'target-session-generation-changed', known: true,
            holderStartedAt: res.session.startedAt, expectedSessionId: expectedId };
        }
      } catch (err) {
        res = { kind: 'none', reason: 'no-session-holds-this-role' };
        reason = `resolver failed: ${err instanceof Error ? err.message : String(err)}`;
      }
      if (res.kind === 'exact' || res.kind === 'redirected') {
        target = res.session.tmuxSession;
        // Pin BEFORE typing: retries and recovery are held to this exact session.
        // The same write leaves the holder lane (relay-asof-holder-skew §2): from here
        // on a retry goes to the pinned session id, never back through the resolver,
        // so a same-name respawn after this point cannot take the message.
        envelope.delivery = {
          ...envelope.delivery,
          phase: 'received',
          resolvedSession: target,
          resolvedSessionId: res.session.id,
          resolvedVia: res.via,
          typingStartedAt: new Date().toISOString(),
          // Recovery owns the uncertain interval from durable pin through final outcome.
          deliveryPending: true,
        };
        delete envelope.delivery.holderPending;
        try { await this.store.updateDelivery(envelope.message.id, envelope.delivery); } catch (err) {
          // @silent-fallback-ok: leave the persisted envelope for recovery; never type without a durable pin
          console.warn(`[message-router] pin write failed for ${envelope.message.id}: ${err instanceof Error ? err.message : err}`);
          return;
        }
        if (res.kind === 'redirected') resolvedNote = ` (redirected from ${requested} via ${res.via})`;
      } else {
        owned = false;
        const refused = res as Exclude<ResolveResult, { kind: 'exact' | 'redirected' }>;
        reason = reason || (refused.kind === 'ambiguous'
          ? `ambiguous: ${refused.reason} (${refused.candidates.join(', ')})`
          : refused.reason === 'topic-held-on' ? `topic-held-on ${refused.heldOn}` : refused.reason);
        // A resolver that threw is not a holder verdict; only a real refusal waits.
        holderPending = !reason.startsWith('resolver failed') && isHolderPendingRefusal(refused);
        if (refused.kind === 'none') refusalDetail = describeHolderRefusal(refused, requested, asOf);
        await this.auditRefusal({
          ts: new Date().toISOString(),
          kind: 'holder-refusal',
          messageId: envelope.message.id,
          target: requested,
          reason: refused.kind === 'none' ? refused.reason : 'ambiguous',
          referenceTime: new Date(asOf).toISOString(),
          holderStartedAt: refused.kind === 'none' ? refused.holderStartedAt ?? null : null,
          relayedFrom: envelope.transport.signedBy && envelope.transport.signedBy !== this.config.localMachine ? envelope.transport.signedBy : null,
          attempt: envelope.delivery.attempts + 1,
          outcome: holderPending ? 'received' : 'failed',
        });
      }
    }
    if (owned) {
      try {
        owned = this.config.isOwnSession ? this.config.isOwnSession(target) : true;
      } catch (err) {
        owned = false;
        reason = `ownership check failed: ${err instanceof Error ? err.message : String(err)}`;
      }
      if (!owned) reason = reason || `"${target}" is not a running session of this agent`;
    }
    if (owned) {
      try {
        const result = await this.delivery.deliverToSession(target, envelope);
        success = result.success;
        outcomeUnknown = result.outcomeUnknown === true;
        reason = result.failureReason ?? '';
        if (!result.success && !result.shouldRetry) owned = false;
      } catch (err) {
        outcomeUnknown = true; owned = false;
        reason = `outcome unknown: delivery did not confirm its result; the message may have arrived (${err instanceof Error ? err.message : String(err)})`;
      }
    }
    const now = new Date().toISOString();
    // Keep an unpinned holder wait at received: older binaries never retry that
    // phase by name, so a downgrade cannot deliver to a reused session name.
    const to = success ? 'delivered' : holderPending ? 'received' : owned ? 'queued' : 'failed';
    const from = envelope.delivery.phase;
    const transitionReason = success
      ? `injected into session ${target}${resolvedNote}`
      : holderPending
        ? `same-agent delivery waiting for a holder: ${refusalDetail ?? reason}`
        : `same-agent delivery deferred: ${refusalDetail ?? reason}`;
    envelope.delivery = {
      ...envelope.delivery,
      phase: to,
      // Hand recovery to the retry lane in the SAME durable write as the holder wait.
      deliveryPending: false,
      // A repeat holder refusal (queued → queued) bumps attempts and the reason without
      // growing the transition list on every pass.
      transitions: from === to && holderPending && envelope.delivery.holderPending
        ? envelope.delivery.transitions
        : [...envelope.delivery.transitions, { from, to, at: now, reason: transitionReason }],
      attempts: envelope.delivery.attempts + 1,
      ...(success ? {} : { failureReason: reason }),
      ...(holderPending ? { holderPending: true, refusalDetail } : {}),
    };
    if ((holderPending || (to === 'queued' && envelope.delivery.resolvedSessionId)) && !envelope.delivery.holderRetryState) {
      envelope.delivery.holderRetryState = { attempts: 0, lastAttemptAt: 0, firstAttemptAt: Date.now() };
    }
    if (!holderPending) {
      delete envelope.delivery.holderPending;
      if (!refusalDetail) delete envelope.delivery.refusalDetail; else envelope.delivery.refusalDetail = refusalDetail;
    }
    // Only a proven pre-injection refusal clears the typing evidence. A physical
    // send error is uncertain even if tmux returned false or threw after Enter.
    if (!success && !outcomeUnknown) delete envelope.delivery.typingStartedAt;
    let outcomePersisted = false;
    try {
      await this.store.updateDelivery(envelope.message.id, envelope.delivery);
      outcomePersisted = true;
    } catch (err) {
      // @silent-fallback-ok: the envelope is already saved; a failed phase write
      // leaves it at 'sent' (today's behaviour) and is logged, never thrown.
      console.warn(`[message-router] same-agent delivery phase write failed for ${envelope.message.id}: ${err instanceof Error ? err.message : err}`);
    }
    if (outcomePersisted && envelope.message.to.sessionId) {
      if (success) this.recordGenerationEvidence('fired', 'generation-delivered', envelope.message.id);
      else if (outcomeUnknown) this.recordGenerationEvidence('error', 'delivery-outcome-unknown', envelope.message.id);
      else if (reason === 'target-session-generation-changed') this.recordGenerationEvidence('held', 'generation-changed', envelope.message.id);
    }
    if (to === 'failed' && outcomePersisted) this.reportTerminalFailure(envelope, refusalDetail ?? reason);
  }

  /**
   * relay-asof-holder-skew §2: DeliveryRetryManager's pass over a `holderPending`
   * envelope. Re-resolves the role with the envelope's own reference time and
   * reference time (never types into `to.session` by name) and returns the phase it
   * reached. Never throws.
   */
  async redeliverSameAgentLocal(envelope: MessageEnvelope, claim?: DeliveryAttemptClaim): Promise<MessageEnvelope['delivery']['phase']> {
    try {
      await this.deliverSameAgentLocal(envelope, claim);
    } catch (err) {
      // @silent-fallback-ok: deliverSameAgentLocal records its own outcome; a throw here is a store fault, logged
      console.warn(`[message-router] holder redelivery failed for ${envelope.message.id}: ${err instanceof Error ? err.message : err}`);
    }
    return (await this.store.get(envelope.message.id))?.delivery.phase ?? 'failed';
  }

  private recordGenerationEvidence(kind: 'fired' | 'held' | 'error', reason: string, messageId: string): void {
    try { this.config.generationEvidence?.(kind, reason, messageId); }
    catch { /* @silent-fallback-ok: feature telemetry never changes the persisted delivery outcome */ }
  }

  /** One JSONL row per holder refusal (§3), appended to `refusalAuditPath`. Never throws. */
  private async auditRefusal(row: HolderRefusalAuditRow): Promise<void> {
    const file = this.config.refusalAuditPath;
    if (!file) return;
    // Legacy callers can supply long names; bound every encoded row independently.
    const bounded = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'string' ? value.slice(0, 512) : value]));
    const encoded = JSON.stringify(bounded) + '\n';
    const append = this.refusalAuditTail.then(async () => {
      this.refusalAuditReady ??= fs.promises.mkdir(path.dirname(file), { recursive: true }).then(() => undefined);
      await this.refusalAuditReady;
      let size = 0;
      try { size = (await fs.promises.stat(file)).size; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } // @silent-fallback-ok: a missing audit starts at zero bytes
      if (size + Buffer.byteLength(encoded) > REFUSAL_AUDIT_MAX_BYTES) await fs.promises.rename(file, `${file}.1`);
      await fs.promises.appendFile(file, encoded);
      this.refusalAuditWarned = false;
    });
    // Awaited per-caller backpressure, one writer for rotation, no sync disk IO.
    this.refusalAuditTail = append.then(() => undefined, () => undefined); // @silent-fallback-ok: the caller below reports the audit failure
    try { await append; }
    catch (error) {
      // @silent-fallback-ok: audit loss emits the warning below once until recovery; the delivery outcome remains durable
      this.refusalAuditReady = null;
      if (!this.refusalAuditWarned) {
        this.refusalAuditWarned = true;
        console.warn(`[message-router] refusal audit unavailable (non-fatal): ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  private async routeCrossAgentLocal(envelope: MessageEnvelope): Promise<void> {
    const targetAgent = envelope.message.to.agent;

    // Sign ONCE, before the POST-or-drop branch: the envelope carries its
    // signature whether it is relayed now or parked in the drop directory
    // (dropMessage only touches `delivery` and `transport.hmac/hmacBy`, all
    // outside the signed set).
    if (this.config.envelopeSigner) {
      const signature = this.config.envelopeSigner(envelope);
      if (signature) envelope.signature = signature;
    }

    // Look up target agent in registry
    const agents = listAgents({ status: 'running' });
    const targetEntry = agents.find(a => a.name === targetAgent);

    if (!targetEntry) {
      // Agent not registered — drop to filesystem
      await this.dropMessage(envelope, targetAgent, 'agent not registered');
      return;
    }

    // Try HTTP relay first
    const outcome = await this.relayToAgent(envelope, targetEntry);
    if (outcome.kind === 'refused') {
      // A Refusal Stays a Refusal: the receiver answered and said no. Parking
      // the envelope would launder that into a delivery at its next boot.
      localRouteSignatureCounters.localRefused++;
      const why = outcome.reason ? `${outcome.error}/${outcome.reason}` : outcome.error;
      console.log(`[message-router] ${targetAgent} refused ${envelope.message.id}: ${why} (HTTP ${outcome.status}, retryable=${outcome.retryable}) — not dropped`);
      const now = new Date().toISOString();
      envelope.delivery = {
        ...envelope.delivery,
        phase: 'failed',
        transitions: [
          ...envelope.delivery.transitions,
          { from: 'sent', to: 'failed', at: now, reason: `refused by ${targetAgent}: ${why}${outcome.retryable ? ' (retryable)' : ''}` },
        ],
        attempts: envelope.delivery.attempts + 1,
        failureReason: `refused by ${targetAgent}: ${why}`,
      };
      await this.store.updateDelivery(envelope.message.id, envelope.delivery);
      return;
    }
    if (outcome.kind === 'accepted') {
      // Update delivery phase to 'received' (both store and in-memory envelope)
      const now = new Date().toISOString();
      envelope.delivery = {
        ...envelope.delivery,
        phase: 'received',
        transitions: [
          ...envelope.delivery.transitions,
          { from: 'sent', to: 'received', at: now, reason: `relayed to ${targetAgent}` },
        ],
        attempts: envelope.delivery.attempts + 1,
      };
      await this.store.updateDelivery(envelope.message.id, envelope.delivery);
      return;
    }

    // HTTP relay failed — fall back to drop directory
    await this.dropMessage(envelope, targetAgent, 'relay failed (agent server unreachable)');
  }

  /**
   * Relay an envelope to another agent's server via HTTP and classify the answer.
   */
  private async relayToAgent(envelope: MessageEnvelope, target: AgentRegistryEntry): Promise<LocalRelayOutcome> {
    // Read target agent's token for Bearer auth
    const targetToken = getAgentToken(target.name);
    if (!targetToken) {
      return { kind: 'unreachable' }; // No token — can't authenticate
    }

    try {
      const url = `http://localhost:${target.port}/messages/relay-agent`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${targetToken}`,
        },
        body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(5000),
      });

      if (response.ok) return { kind: 'accepted' };
      // An explicit refusal is a JSON body saying `refused: true`, at any status.
      try {
        const body = await response.json() as { refused?: unknown; error?: unknown; reason?: unknown; retryable?: unknown } | null;
        if (body && body.refused === true) {
          return {
            kind: 'refused',
            status: response.status,
            // The receiver's words go into our log and store: printable ASCII, bounded.
            error: typeof body.error === 'string' && body.error ? logSafe(body.error) : 'refused',
            reason: typeof body.reason === 'string' && body.reason ? logSafe(body.reason) : null,
            retryable: body.retryable === true,
          };
        }
      } catch { /* @silent-fallback-ok — not JSON: an answered error without the flag, handled as before */ }
      return { kind: 'unreachable' };
    } catch {
      // @silent-fallback-ok — network failure, will fall back to drop directory
      return { kind: 'unreachable' };
    }
  }

  /**
   * Write a message to the drop directory for offline pickup.
   * The drop is HMAC-signed with the sender's token for tamper protection.
   *
   * Drop path: ~/.instar/messages/drop/{targetAgentName}/{messageId}.json
   */
  private async dropMessage(
    envelope: MessageEnvelope,
    targetAgent: string,
    reason: string,
  ): Promise<void> {
    const dropDir = path.join(os.homedir(), '.instar', 'messages', 'drop', targetAgent);
    fs.mkdirSync(dropDir, { recursive: true });

    // Compute HMAC with sender's token
    const senderToken = getAgentToken(this.config.localAgent);
    if (senderToken) {
      const hmac = computeDropHmac(senderToken, {
        message: envelope.message,
        originServer: envelope.transport.originServer,
        nonce: envelope.transport.nonce,
        timestamp: envelope.transport.timestamp,
      });
      envelope.transport.hmac = hmac;
      envelope.transport.hmacBy = this.config.localAgent;
    }

    // Update delivery phase to 'queued' (awaiting pickup)
    const now = new Date().toISOString();
    envelope.delivery = {
      ...envelope.delivery,
      phase: 'queued',
      transitions: [
        ...envelope.delivery.transitions,
        { from: envelope.delivery.phase, to: 'queued', at: now, reason: `drop: ${reason}` },
      ],
      attempts: envelope.delivery.attempts + 1,
    };

    // Write envelope to drop directory
    const dropPath = path.join(dropDir, `${envelope.message.id}.json`);
    fs.writeFileSync(dropPath, JSON.stringify(envelope, null, 2), { encoding: 'utf-8' });

    // Also update local store
    await this.store.updateDelivery(envelope.message.id, envelope.delivery);
  }

  // ── Routing: Cross-Machine ─────────────────────────────────────

  /**
   * Route a message to a different machine.
   *
   * Flow (per spec §Cross-Machine):
   * 1. Verify cross-machine deps are available
   * 2. Verify target machine is paired and active
   * 3. Resolve target machine URL
   * 4. Add self to relay chain (before signing — relayChain is part of SignedPayload)
   * 5. Sign envelope with Ed25519
   * 6. Forward via POST relay-machine with Machine-HMAC headers
   * 7. If relay fails → queue to outbound directory for git-sync fallback
   */
  private async routeCrossMachine(envelope: MessageEnvelope): Promise<void> {
    const targetMachine = envelope.message.to.machine;

    if (!this.crossMachine) {
      // Cross-machine not enabled — queue for later
      await this.queueOutbound(envelope, targetMachine, 'cross-machine not enabled');
      return;
    }

    const { identityManager } = this.crossMachine;

    // Verify target machine is paired and active
    if (!identityManager.isMachineActive(targetMachine)) {
      if (envelope.message.type !== 'delivery-notice' && envelope.message.to.agent === this.config.localAgent) {
        // (falls through to the existing failed write below; the sender is told after it)
        queueMicrotask(() => this.reportTerminalFailure(envelope, `target machine ${targetMachine} not active or unknown`));
      }
      const now = new Date().toISOString();
      envelope.delivery = {
        ...envelope.delivery,
        phase: 'failed',
        transitions: [
          ...envelope.delivery.transitions,
          { from: envelope.delivery.phase, to: 'failed', at: now, reason: `target machine ${targetMachine} not active or unknown` },
        ],
        failureReason: `target machine ${targetMachine} not active or unknown`,
      };
      await this.store.updateDelivery(envelope.message.id, envelope.delivery);
      return;
    }

    // §D.5: a same-agent message for a session on another machine gets one queued
    // pass over that machine's guarded addresses; it never goes to the outbound folder.
    if (this.relayQueue && envelope.message.to.agent === this.config.localAgent && envelope.message.to.session && envelope.message.to.session !== 'best') {
      // The receiver requires from.machine = signer = relayChain[0] (§D.2).
      if (!envelope.message.from.machine || envelope.message.from.machine === 'local') {
        envelope.message.from = { ...envelope.message.from, machine: this.config.localMachine };
        await this.store.updateEnvelope(envelope);
      }
      envelope.transport.relayChain = [this.config.localMachine];
      await this.store.updateEnvelope(envelope);
      await this.setPhase(envelope, 'relaying', `queued for one pass to machine ${targetMachine}`);
      this.relayQueue.enqueue(envelope);
      return;
    }

    // Resolve target machine URL
    const targetUrl = identityManager.getMachineUrl(targetMachine);
    if (!targetUrl) {
      // No URL known — queue for git-sync
      await this.queueOutbound(envelope, targetMachine, 'no URL known for target machine');
      return;
    }

    // Add self to relay chain before signing (relayChain is part of SignedPayload)
    envelope.transport.relayChain.push(this.config.localMachine);

    // Sign envelope with Ed25519
    this.signEnvelope(envelope);

    // Try HTTP relay
    const relaySuccess = await this.relayToMachine(envelope, targetUrl);
    if (relaySuccess) {
      const now = new Date().toISOString();
      envelope.delivery = {
        ...envelope.delivery,
        phase: 'received',
        transitions: [
          ...envelope.delivery.transitions,
          { from: 'sent', to: 'received', at: now, reason: `relayed to machine ${targetMachine}` },
        ],
        attempts: envelope.delivery.attempts + 1,
      };
      // Persist the full envelope (transport was updated with signature + relayChain)
      await this.store.updateEnvelope(envelope);
      return;
    }

    // HTTP relay failed — queue to outbound for git-sync
    await this.queueOutbound(envelope, targetMachine, 'relay failed (machine unreachable)');
  }

  /**
   * Sign a message envelope with this machine's Ed25519 key.
   * Sets transport.signature and transport.signedBy.
   *
   * Signature covers the canonical JSON of the SignedPayload:
   * { message, relayChain, originServer, nonce, timestamp }
   */
  private signEnvelope(envelope: MessageEnvelope): void {
    if (!this.crossMachine) return;

    const canonical = canonicalJSON(signedPayloadOf(envelope));
    envelope.transport.signature = sign(canonical, this.crossMachine.signingKeyPem);
    envelope.transport.signedBy = this.config.localMachine;
  }

  /**
   * Public signature verification for git-sync inbound messages.
   * Skips clock skew check (per spec: git-sync has no timestamp check).
   */
  verifyInboundSignature(envelope: MessageEnvelope): { valid: true } | { valid: false; reason: string } {
    return this.verifyEnvelopeSignature(envelope, { skipClockSkew: true });
  }

  /**
   * Verify the Ed25519 signature on an incoming cross-machine envelope.
   * Checks: signature present, signer is active, clock skew within tolerance, signature valid.
   */
  private verifyEnvelopeSignature(
    envelope: MessageEnvelope,
    options?: { skipClockSkew?: boolean },
  ): { valid: true } | { valid: false; reason: string } {
    if (!this.crossMachine) {
      return { valid: false, reason: 'cross-machine not enabled' };
    }

    const { identityManager } = this.crossMachine;

    // Signature must be present
    if (!envelope.transport.signature || !envelope.transport.signedBy) {
      return { valid: false, reason: 'missing signature or signedBy' };
    }

    // Signer must be a known, active machine
    if (!identityManager.isMachineActive(envelope.transport.signedBy)) {
      return { valid: false, reason: `signer ${envelope.transport.signedBy} not active or unknown` };
    }

    // Clock skew check for real-time relay (skipped for git-sync per spec)
    const tolerance = CLOCK_SKEW_TOLERANCE['relay-machine'];
    if (tolerance != null && !options?.skipClockSkew) {
      const envelopeTime = new Date(envelope.transport.timestamp).getTime();
      const skew = Math.abs(Date.now() - envelopeTime);
      if (skew > tolerance) {
        return { valid: false, reason: `timestamp skew ${Math.round(skew / 1000)}s exceeds ${tolerance / 1000}s tolerance` };
      }
    }

    // Get signer's public key
    const publicKeyPem = identityManager.getSigningPublicKeyPem(envelope.transport.signedBy);
    if (!publicKeyPem) {
      return { valid: false, reason: `public key not found for ${envelope.transport.signedBy}` };
    }

    // Reconstruct and verify the SignedPayload
    const canonical = canonicalJSON(signedPayloadOf(envelope));
    try {
      const isValid = verify(canonical, envelope.transport.signature, publicKeyPem);
      if (!isValid) {
        return { valid: false, reason: 'signature verification failed' };
      }
    } catch (err) {
      // @silent-fallback-ok — returns structured error with reason; caller handles validation failure
      return { valid: false, reason: `signature error: ${err instanceof Error ? err.message : String(err)}` };
    }

    return { valid: true };
  }

  /**
   * Relay an envelope to a remote machine via HTTP.
   * Uses Machine-HMAC (5-header scheme) for transport auth.
   * The envelope itself carries Ed25519 signature for message integrity.
   */
  private async relayToMachine(envelope: MessageEnvelope, targetUrl: string): Promise<boolean> {
    if (!this.crossMachine) return false;

    try {
      const sequence = this.machineSequence++;
      const requestBody = machineRelayBody(envelope);
      const machineHeaders = signRequest(
        this.config.localMachine,
        this.crossMachine.signingKeyPem,
        requestBody,
        sequence,
      );

      const url = `${targetUrl}${envelope.message.to.sessionGenerationRequired ? GENERATION_RELAY_MACHINE_PATH : RELAY_MACHINE_PATH}`;
      const response = await fetch(url, {
        method: 'POST',
        ...(envelope.message.to.sessionGenerationRequired ? { redirect: 'manual' as const } : {}),
        headers: {
          'Content-Type': 'application/json',
          ...machineHeaders,
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(10_000), // Cross-machine gets longer timeout
      });

      return response.ok;
    } catch {
      // @silent-fallback-ok — network failure, will fall back to outbound queue
      return false;
    }
  }

  /**
   * Queue a message in the outbound directory for offline cross-machine delivery.
   * These are picked up by git-sync or on next machine connection.
   *
   * Outbound path: ~/.instar/messages/outbound/{targetMachineId}/{messageId}.json
   */
  private async queueOutbound(
    envelope: MessageEnvelope,
    targetMachine: string,
    reason: string,
  ): Promise<void> {
    const outboundDir = path.join(os.homedir(), '.instar', 'messages', 'outbound', targetMachine);
    fs.mkdirSync(outboundDir, { recursive: true });

    // Sign envelope if not already signed (outbound messages need signatures for git-sync verification)
    if (!envelope.transport.signature && this.crossMachine) {
      envelope.transport.relayChain.push(this.config.localMachine);
      this.signEnvelope(envelope);
    }

    // Update delivery phase to 'queued'
    const now = new Date().toISOString();
    envelope.delivery = {
      ...envelope.delivery,
      phase: 'queued',
      transitions: [
        ...envelope.delivery.transitions,
        { from: envelope.delivery.phase, to: 'queued', at: now, reason: `outbound: ${reason}` },
      ],
      attempts: envelope.delivery.attempts + 1,
    };

    // Write envelope to outbound directory
    const outboundPath = path.join(outboundDir, `${envelope.message.id}.json`);
    fs.writeFileSync(outboundPath, JSON.stringify(envelope, null, 2), { encoding: 'utf-8' });

    // Update local store
    await this.store.updateDelivery(envelope.message.id, envelope.delivery);
  }

  // ── Private Helpers ──────────────────────────────────────────────

  private isValidTransition(from: string, to: string): boolean {
    return VALID_TRANSITIONS.some(([f, t]) => f === from && t === to);
  }
}

// ── Canonical JSON (RFC 8785 / JCS) ──────────────────────────────────

/**
 * Serialize an object to canonical JSON per RFC 8785.
 *
 * Rules:
 * - Object keys sorted lexicographically (Unicode code point order)
 * - No insignificant whitespace
 * - Applied recursively to all nested objects
 * - Arrays preserve element order
 * - Primitive values use standard JSON serialization
 */
/**
 * The signed fields of an envelope. `age` (messages-reach-renamed-sessions §D.3) is
 * included only when present, so an envelope signed without it verifies unchanged.
 */
export function signedPayloadOf(envelope: MessageEnvelope): SignedPayload {
  const payload: SignedPayload = {
    message: envelope.message,
    relayChain: envelope.transport.relayChain,
    originServer: envelope.transport.originServer,
    nonce: envelope.transport.nonce,
    timestamp: envelope.transport.timestamp,
  };
  if (typeof envelope.transport.age === 'number') payload.age = envelope.transport.age;
  return payload;
}

export function canonicalJSON(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = value.map(item => canonicalJSON(item));
    return `[${items.join(',')}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const pairs = keys
      .filter(key => (value as Record<string, unknown>)[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${canonicalJSON((value as Record<string, unknown>)[key])}`);
    return `{${pairs.join(',')}}`;
  }
  return JSON.stringify(value);
}

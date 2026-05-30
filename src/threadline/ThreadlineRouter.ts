/**
 * ThreadlineRouter — Wires ThreadResumeMap into the existing message receive pipeline.
 *
 * When a cross-agent message arrives for this agent:
 * 1. (Phase 2) Check the AutonomyGate for visibility/approval gating
 * 2. Check if a ThreadResumeMap entry exists for this threadId
 * 3. If yes → resume that Claude session (--resume UUID)
 * 4. If no → spawn a new session, save the mapping
 * 5. Inject thread history into the session context
 * 6. On session end → persist the UUID back to ThreadResumeMap
 *
 * The ThreadlineRouter hooks into the existing message pipeline — it does NOT
 * replace the MessageRouter. It handles the spawn/resume decision for threaded
 * cross-agent conversations specifically.
 */

import crypto from 'node:crypto';
import type { MessageRouter } from '../messaging/MessageRouter.js';
import type { SpawnRequestManager, SpawnResult } from '../messaging/SpawnRequestManager.js';
import type { MessageStore } from '../messaging/MessageStore.js';
import type { IMessageDelivery } from '../messaging/types.js';
import type { MessageEnvelope, AgentMessage } from '../messaging/types.js';
import type { ThreadResumeMap, ThreadResumeEntry, ThreadState } from './ThreadResumeMap.js';
import type { AutonomyGate } from './AutonomyGate.js';
import type { AgentTrustLevel } from './AgentTrustManager.js';
import { buildRelayGroundingPreamble, tagExternalMessage, RELAY_HISTORY_LIMITS } from './RelayGroundingPreamble.js';
import type { RelayGroundingContext } from './RelayGroundingPreamble.js';

// ── Types ───────────────────────────────────────────────────────

/** Configuration for the ThreadlineRouter */
export interface ThreadlineRouterConfig {
  /** Name of this agent */
  localAgent: string;
  /** Machine ID */
  localMachine: string;
  /** Max number of thread history messages to inject into context */
  maxHistoryMessages: number;
}

/**
 * Ledger event fired by the router on thread lifecycle transitions.
 * Consumed by the Integrated-Being SharedStateLedger via registerLedgerEmitters().
 *
 * SIGNAL-ONLY by design — the router never blocks on ledger write failures.
 */
export interface ThreadlineLedgerEvent {
  kind: 'thread-opened' | 'thread-closed' | 'thread-abandoned';
  threadId: string;
  remoteAgent: string;
  subject: string;
  /** Trust-tier source — autonomy level snapshot for trust mapping. */
  autonomyLevel?: string;
  /** ISO timestamp of the event. */
  timestamp: string;
}

/**
 * Transport-level authentication kind for a relay message.
 *
 * Distinguishes how the sender's identity was established on the wire:
 * - `verified`: end-to-end cryptographic authentication of this specific message
 * - `plaintext-tofu`: trust-on-first-use over plaintext transport (not hijack-safe)
 * - `unauthenticated`: no identity verification (rejected upstream in most paths)
 *
 * This is orthogonal to `AgentTrustLevel`, which is who the sender is in the trust DB.
 * Affinity features that assume the sender can't be impersonated on the wire
 * MUST gate on `kind === 'verified'`.
 */
export type RelayTrustLevel =
  | { kind: 'verified'; senderFingerprint: string }
  | { kind: 'plaintext-tofu'; senderFingerprint: string }
  | { kind: 'unauthenticated' };

/** Relay context passed from InboundMessageGate when message arrives via relay */
export interface RelayMessageContext {
  /** Transport-level authentication kind — see RelayTrustLevel. */
  trust: RelayTrustLevel;
  /** Sender's cryptographic fingerprint (display/key use; for authenticated-only use, read trust.senderFingerprint) */
  senderFingerprint: string;
  /** Sender's display name */
  senderName: string;
  /** Trust level of the sender */
  trustLevel: AgentTrustLevel;
  /** Who granted trust */
  trustSource?: string;
  /** When trust was granted */
  trustDate?: string;
  /** Original source fingerprint (for multi-hop) */
  originFingerprint?: string;
  /** Original source name */
  originName?: string;
}

/** Result of handling an inbound threaded message */
export interface ThreadlineHandleResult {
  /** Whether this message was handled as a threadline message */
  handled: boolean;
  /** The thread ID (existing or newly created) */
  threadId?: string;
  /** Whether a new session was spawned (vs. resumed) */
  spawned?: boolean;
  /** Whether an existing session was resumed */
  resumed?: boolean;
  /** Whether the message was injected directly into a live session
   *  (PR-4: avoids the overhead of spawning/resuming when a session is
   *  already running for this thread). */
  injected?: boolean;
  /** The tmux session name handling this thread */
  sessionName?: string;
  /** Error message if handling failed */
  error?: string;
  /** Gate decision (if autonomy gate is active) */
  gateDecision?: string;
  /** Approval ID (if message was queued for approval) */
  approvalId?: string;
}

// ── Constants ───────────────────────────────────────────────────

const DEFAULT_MAX_HISTORY = 20;

/**
 * Receiver-side session affinity (§4.1).
 *
 * When a verified peer sends us a threadless message, we want to reuse the
 * threadId we minted for their last recent message rather than spawning a
 * fresh session for every follow-up. Map is process-local, never persisted,
 * and read/written ONLY when `relayContext.trust.kind === 'verified'` —
 * plaintext-tofu paths cannot assert the sender is the same entity across
 * messages, so reusing a thread would open a hijack vector.
 *
 * Sliding TTL: entry expires if not used within this window.
 * Absolute TTL: entry expires this long after its first use regardless of
 * subsequent activity — caps exposure of any single reused thread.
 * LRU cap: bounds memory under adversarial peer churn.
 */
const RECEIVER_AFFINITY_SLIDING_TTL_MS = 600_000; // 10 minutes
const RECEIVER_AFFINITY_ABSOLUTE_TTL_MS = 7_200_000; // 2 hours
const RECEIVER_AFFINITY_MAX = 1000;

interface ReceiverAffinityEntry {
  threadId: string;
  firstUsedAt: number;
  lastUsedAt: number;
}

const THREAD_SPAWN_PROMPT_TEMPLATE = `You are continuing a threaded conversation with {remote_agent}.

Thread: {thread_id}
Subject: {subject}
Messages in thread: {message_count}

{history_section}

The latest message from {remote_agent}:
Subject: {latest_subject}
---
{latest_body}
---

Respond to this message. Use the threadline_send MCP tool with the agentId set to "{remote_agent}" and include the threadId "{thread_id}" to send your reply.`;

/**
 * Byte budget for the thread-history block injected into a spawn prompt.
 *
 * The spawn prompt is passed as a `tmux new-session ... <command>` ARGUMENT
 * (SessionManager.spawnSession → execFileSync). tmux's command-line limit is
 * ~16 KB (empirically: a 15 KB arg succeeds, 16 KB fails with the literal
 * "command too long"). An UNBOUNDED, ever-growing thread history made the spawn
 * command exceed that ceiling, so multi-agent reply-spawns failed OUTRIGHT once
 * a thread accumulated enough messages — silently breaking agent-to-agent
 * communication on exactly the long-running threads that need it most.
 *
 * Same failure class + fix as Mentor Stage-A (see MentorStageA.ts, which caps
 * its own growing compose context). We bound the history (newest-first) plus the
 * latest body so the whole assembled command stays comfortably under the cliff
 * (worst case ≈ 6 KB history + 3.5 KB latest + ~2.5 KB env/flags/grounding ≈
 * 12 KB, a ~4 KB margin). The existing message-COUNT cap (maxHistoryMessages)
 * is kept; this byte cap is the belt-and-suspenders that actually bounds size.
 */
const MAX_HISTORY_BYTES = 6000;
/** Per-message cap inside the history block, so one huge message can't dominate the budget. */
const MAX_HISTORY_MESSAGE_BYTES = 1500;
/** Cap on the latest (triggering) message body embedded in the spawn prompt. */
const MAX_LATEST_BODY_BYTES = 3500;

/**
 * Truncate a message body to a byte budget with an explicit marker. Pure +
 * exported for unit testing. No-op when already under budget.
 */
export function capMessageBody(body: string, maxBytes: number): string {
  if (body.length <= maxBytes) return body;
  return `${body.slice(0, maxBytes)}\n…[truncated ${body.length - maxBytes} chars]`;
}

/**
 * Build the bounded "Recent thread history" block. Walks newest→oldest so the
 * most recent context always survives, truncates any single oversized message,
 * and stops adding older messages once the byte budget is hit (always keeping at
 * least the newest one). Pure + exported for unit testing.
 */
export function buildBoundedHistorySection(
  messages: Array<{ agent: string; createdAt: string; body: string }>,
  totalCount: number,
  opts: { maxBytes: number; perMessageBytes: number },
): string {
  if (messages.length === 0) return '';
  const entries: string[] = [];
  let usedBytes = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const body = capMessageBody(m.body, opts.perMessageBytes);
    const entry = `${m.agent} (${m.createdAt}):\n${body}`;
    // Always include at least the newest message; stop adding older ones once
    // the budget would be exceeded.
    if (entries.length > 0 && usedBytes + entry.length > opts.maxBytes) break;
    entries.unshift(entry);
    usedBytes += entry.length;
  }
  const numbered = entries.map((e, i) => `[${i + 1}] ${e}`).join('\n\n');
  const omitted = totalCount - entries.length;
  const header = omitted > 0
    ? `Recent thread history (${entries.length} of ${totalCount} messages, older omitted to fit):`
    : `Recent thread history (${entries.length} of ${totalCount} messages):`;
  return `${header}\n${numbered}`;
}

// ── Implementation ──────────────────────────────────────────────

export class ThreadlineRouter {
  private readonly messageRouter: MessageRouter;
  private readonly spawnManager: SpawnRequestManager;
  private readonly threadResumeMap: ThreadResumeMap;
  private readonly messageStore: MessageStore;
  private readonly config: ThreadlineRouterConfig;
  private readonly autonomyGate: AutonomyGate | null;
  /** Optional live-session injection delivery (PR-4). When set, the router
   *  will try to inject inbound messages directly into an already-running
   *  session for the thread before falling back to spawn/resume. */
  private readonly messageDelivery: IMessageDelivery | null;

  /** Optional ledger-event sink (Integrated-Being v1). Signal-only. */
  private readonly onLedgerEvent: ((evt: ThreadlineLedgerEvent) => void) | null;

  /**
   * Optional topic-linkage handler (THREAD-TOPIC-LINKAGE-SPEC.md). When set,
   * inbound replies on threads with an `originTopicId` are routed to the
   * originating Telegram topic session instead of the standard thread-worker
   * path. Wired via setter post-construction so existing callers don't break.
   */
  private topicLinkageHandler: import('./TopicLinkageHandler.js').TopicLinkageHandler | null = null;

  /** Track in-flight spawn requests to prevent concurrent spawns for the same thread */
  private readonly pendingSpawns = new Set<string>();

  /**
   * Verified-path session affinity (§4.1 D3 fix).
   *
   * Maps a verified peer's senderFingerprint → the threadId we last used
   * for them, with sliding + absolute TTLs. Only read/written when
   * `relayContext.trust.kind === 'verified'`. Uses insertion-order iteration
   * as LRU proxy: setting an existing key deletes-then-sets to bump it to
   * the tail, and eviction at cap drops the head.
   *
   * Process-local, never persisted. Confirmed by test asserting no files
   * appear under `.instar/` during a send burst.
   */
  private readonly recentThreadByPeer = new Map<string, ReceiverAffinityEntry>();
  /** Test seam: override `Date.now()` for deterministic TTL tests. */
  private readonly nowFn: () => number;

  constructor(
    messageRouter: MessageRouter,
    spawnManager: SpawnRequestManager,
    threadResumeMap: ThreadResumeMap,
    messageStore: MessageStore,
    config: Partial<ThreadlineRouterConfig> & Pick<ThreadlineRouterConfig, 'localAgent' | 'localMachine'>,
    autonomyGate?: AutonomyGate | null,
    messageDelivery?: IMessageDelivery | null,
    onLedgerEvent?: (evt: ThreadlineLedgerEvent) => void,
    nowFn?: () => number,
  ) {
    this.messageRouter = messageRouter;
    this.spawnManager = spawnManager;
    this.threadResumeMap = threadResumeMap;
    this.messageStore = messageStore;
    this.config = {
      maxHistoryMessages: DEFAULT_MAX_HISTORY,
      ...config,
    };
    this.autonomyGate = autonomyGate ?? null;
    this.messageDelivery = messageDelivery ?? null;
    this.onLedgerEvent = onLedgerEvent ?? null;
    this.nowFn = nowFn ?? (() => Date.now());
  }

  /**
   * Look up a recent affinity entry for a verified peer. Returns the threadId
   * iff an entry exists AND both sliding + absolute TTLs are satisfied.
   * Expired entries are evicted as a side-effect. Non-verified trust kinds
   * short-circuit to null — the map is untouched.
   */
  private peekAffinity(relayContext: RelayMessageContext | undefined): string | null {
    if (!relayContext || relayContext.trust.kind !== 'verified') return null;
    const fingerprint = relayContext.trust.senderFingerprint;
    const entry = this.recentThreadByPeer.get(fingerprint);
    if (!entry) return null;
    const now = this.nowFn();
    if (now - entry.firstUsedAt > RECEIVER_AFFINITY_ABSOLUTE_TTL_MS) {
      this.recentThreadByPeer.delete(fingerprint);
      return null;
    }
    if (now - entry.lastUsedAt > RECEIVER_AFFINITY_SLIDING_TTL_MS) {
      this.recentThreadByPeer.delete(fingerprint);
      return null;
    }
    return entry.threadId;
  }

  /**
   * Record a (fingerprint → threadId) affinity for a verified peer. Bumps
   * LRU recency; evicts oldest entries when over cap. Non-verified trust
   * kinds are no-ops.
   */
  private recordAffinity(relayContext: RelayMessageContext | undefined, threadId: string): void {
    if (!relayContext || relayContext.trust.kind !== 'verified') return;
    const fingerprint = relayContext.trust.senderFingerprint;
    const now = this.nowFn();
    const existing = this.recentThreadByPeer.get(fingerprint);
    if (existing && existing.threadId === threadId) {
      // Refresh lastUsedAt + bump LRU by delete-then-set.
      this.recentThreadByPeer.delete(fingerprint);
      this.recentThreadByPeer.set(fingerprint, {
        threadId,
        firstUsedAt: existing.firstUsedAt,
        lastUsedAt: now,
      });
    } else {
      this.recentThreadByPeer.delete(fingerprint);
      this.recentThreadByPeer.set(fingerprint, {
        threadId,
        firstUsedAt: now,
        lastUsedAt: now,
      });
    }
    // LRU eviction: drop oldest until under cap.
    while (this.recentThreadByPeer.size > RECEIVER_AFFINITY_MAX) {
      const oldestKey = this.recentThreadByPeer.keys().next().value;
      if (oldestKey === undefined) break;
      this.recentThreadByPeer.delete(oldestKey);
    }
  }

  /**
   * Test seam: inspect the affinity map. Returns a snapshot; callers must
   * not mutate. Not intended for production use.
   */
  getAffinitySnapshotForTests(): ReadonlyMap<string, ReceiverAffinityEntry> {
    return new Map(this.recentThreadByPeer);
  }

  /**
   * Attach a TopicLinkageHandler post-construction. Optional — when unset,
   * the router behaves identically to pre-spec behavior. Per
   * THREAD-TOPIC-LINKAGE-SPEC.md.
   */
  setTopicLinkageHandler(
    handler: import('./TopicLinkageHandler.js').TopicLinkageHandler | null,
  ): void {
    this.topicLinkageHandler = handler;
  }

  /** Fire a ledger event swallowing any exception (signal-only). */
  private emitLedger(evt: ThreadlineLedgerEvent): void {
    if (!this.onLedgerEvent) return;
    try { this.onLedgerEvent(evt); } catch { /* signal-only */ }
  }

  /**
   * Sweep thread-resume entries older than the TTL and emit synthetic
   * `thread-abandoned` ledger events. Bounded, idempotent via dedupKey on
   * the ledger side.
   */
  sweepAbandonedThreads(ttlMs: number = 24 * 60 * 60 * 1000): number {
    if (!this.onLedgerEvent) return 0;
    let emitted = 0;
    try {
      const all = this.threadResumeMap.listActive?.() ?? [];
      const cutoff = Date.now() - ttlMs;
      for (const { threadId, entry } of all) {
        if (entry.state === 'active' || entry.state === 'idle') {
          const last = Date.parse(entry.lastAccessedAt);
          if (Number.isFinite(last) && last < cutoff) {
            this.emitLedger({
              kind: 'thread-abandoned',
              threadId,
              remoteAgent: entry.remoteAgent,
              subject: entry.subject,
              timestamp: new Date().toISOString(),
            });
            emitted += 1;
          }
        }
      }
    } catch { /* best effort */ }
    return emitted;
  }

  /**
   * Handle an inbound cross-agent message that has a threadId.
   *
   * Decision tree:
   * - No threadId → not a threadline message, return { handled: false }
   * - Has threadId + existing resume entry → resume session
   * - Has threadId + no resume entry → spawn new session
   */
  async handleInboundMessage(envelope: MessageEnvelope, relayContext?: RelayMessageContext): Promise<ThreadlineHandleResult> {
    const { message } = envelope;

    // Only handle messages from other agents (not self-delivery)
    if (message.from.agent === this.config.localAgent) {
      return { handled: false };
    }

    // First-contact: if the sender didn't provide a threadId, try to reuse
    // the last threadId we minted for this verified peer (§4.1 D3 fix).
    // Falls back to minting fresh on miss, plaintext trust kinds, or TTL expiry.
    if (!message.threadId) {
      const affinityThreadId = this.peekAffinity(relayContext);
      if (affinityThreadId) {
        console.log(`[ThreadlineRouter] Reused affinity threadId ${affinityThreadId} for verified peer (msg id: ${message.id})`);
        message.threadId = affinityThreadId;
      } else {
        const mintedThreadId = crypto.randomUUID();
        console.log(`[ThreadlineRouter] Minted new threadId ${mintedThreadId} for first-contact message from ${message.from.agent} (id: ${message.id})`);
        message.threadId = mintedThreadId;
      }
    }

    // SECURITY (KEYSTONE §2 / acceptance #8): a threadId is NOT a bearer token.
    // If an UNVERIFIED peer presents a threadId that already resolves to a
    // conversation owned by a DIFFERENT participant, it must NOT be resumed into
    // / routed to that owner session — that is the hijack surface
    // ContextThreadMap.agentIdentity defends. Crypto-verified peers are exempt
    // (identity is already established); for unverified peers the inbound
    // identity must match the thread's known participant, else we isolate the
    // sender to a fresh first-contact thread and the victim's conversation is
    // left untouched.
    {
      const presented = this.threadResumeMap.get(message.threadId);
      if (presented) {
        const cryptoVerified = relayContext?.trust.kind === 'verified';
        const inboundFp = relayContext?.senderFingerprint || message.from.agent || '';
        const inboundName = relayContext?.senderName || '';
        const peer = presented.remoteAgent || '';
        const identityMatches = !!peer && (peer === inboundFp || peer === inboundName);
        if (!cryptoVerified && !identityMatches) {
          const freshId = crypto.randomUUID();
          console.warn(
            `[ThreadlineRouter] Anti-hijack: unverified sender ${inboundName || inboundFp || 'unknown'} presented threadId ${message.threadId.slice(0, 8)} owned by ${peer.slice(0, 16)}; isolating to fresh thread ${freshId.slice(0, 8)}`,
          );
          message.threadId = freshId;
        }
      }
    }

    const threadId = message.threadId;
    // Record affinity (no-op for non-verified trust kinds).
    this.recordAffinity(relayContext, threadId);

    // Prevent concurrent spawns for the same thread
    if (this.pendingSpawns.has(threadId)) {
      return {
        handled: true,
        threadId,
        error: 'Spawn already in progress for this thread',
      };
    }

    try {
      this.pendingSpawns.add(threadId);

      // Phase 2: Check the autonomy gate before processing
      if (this.autonomyGate) {
        const gateResult = await this.autonomyGate.evaluate(envelope);

        switch (gateResult.decision) {
          case 'block':
            return {
              handled: true,
              threadId,
              gateDecision: 'block',
              error: `Blocked by autonomy gate: ${gateResult.reason}`,
            };

          case 'queue-for-approval':
            return {
              handled: true,
              threadId,
              gateDecision: 'queue-for-approval',
              approvalId: gateResult.approvalId,
            };

          case 'notify-and-deliver':
          case 'deliver':
            // Continue with normal spawn/resume flow
            break;
        }
      }

      // Check for existing resume entry
      const existingEntry = this.threadResumeMap.get(threadId);

      // THREAD-TOPIC-LINKAGE-SPEC.md: when the thread carries an originTopicId
      // (set on the outbound send by /threadline/relay-send), route the reply
      // back to the originating Telegram topic session instead of the standard
      // thread-worker path. The handler is responsible for salience
      // classification, live-injection vs resume-pending, Telegram surface,
      // and commitment lifecycle. Returns 'no-linkage' when the thread has no
      // originTopicId (falls through to existing behavior).
      if (this.topicLinkageHandler && existingEntry?.originTopicId !== undefined) {
        try {
          const outcome = await this.topicLinkageHandler.tryRouteReplyToTopic({
            envelope,
            threadEntry: {
              remoteAgent: existingEntry.remoteAgent,
              subject: existingEntry.subject,
              originTopicId: existingEntry.originTopicId,
              originSessionName: existingEntry.originSessionName,
            },
          });
          if (outcome.kind === 'routed') {
            return {
              handled: true,
              threadId,
              injected: outcome.deliveryMode === 'live-inject',
              resumed: outcome.deliveryMode === 'resume-pending',
            };
          }
          // 'no-linkage' or 'topic-expired' → fall through to existing path.
        } catch (err) {
          console.warn(
            `[ThreadlineRouter] TopicLinkageHandler threw for thread ${threadId}: ${err instanceof Error ? err.message : String(err)} — falling through to thread-worker path`,
          );
        }
      }

      // PR-4: If we have a live-session delivery path AND the thread has a
      // resume entry pointing at a sessionName that is currently alive, try
      // to inject the message directly into the running session instead of
      // spawning a fresh Claude process. Fall through to resume/spawn on
      // failure.
      if (existingEntry && this.messageDelivery) {
        const injected = await this.tryInjectIntoLiveSession(threadId, existingEntry, envelope);
        if (injected) return injected;
      }

      if (existingEntry) {
        return await this.resumeThread(threadId, existingEntry, envelope, relayContext);
      } else {
        return await this.spawnNewThread(threadId, envelope, relayContext);
      }
    } catch (err) {
      console.error(`[ThreadlineRouter] Error handling inbound message for thread ${threadId}:`, err);
      return {
        handled: true,
        threadId,
        error: err instanceof Error ? err.message : 'Unknown error',
      };
    } finally {
      this.pendingSpawns.delete(threadId);
    }
  }

  /**
   * Notify the router that a thread's session has ended.
   * Persists the UUID back to ThreadResumeMap for future resume.
   */
  onSessionEnd(threadId: string, uuid: string, sessionName: string): void {
    const entry = this.threadResumeMap.get(threadId);
    if (!entry) return;

    // Update the entry with the latest UUID and mark as idle
    this.threadResumeMap.save(threadId, {
      ...entry,
      uuid,
      sessionName,
      state: 'idle',
      lastAccessedAt: new Date().toISOString(),
    });
  }

  /**
   * Notify the router that a bound worker session has completed.
   * Reverse-maps the tmux session to all active thread entries and demotes only
   * threads that are no longer legitimately waiting on the remote peer.
   */
  onSessionComplete(sessionName: string, uuid?: string): { demoted: number; skippedAwaitingReply: number } {
    const matchesByThreadId = new Map(
      this.threadResumeMap.getBySessionName(sessionName)
        .map(match => [match.threadId, match]),
    );
    if (uuid) {
      for (const match of this.threadResumeMap.getBySessionUuid(uuid)) {
        matchesByThreadId.set(match.threadId, match);
      }
    }
    let demoted = 0;
    let skippedAwaitingReply = 0;

    for (const match of matchesByThreadId.values()) {
      if (match.conversationState === 'awaiting-reply') {
        skippedAwaitingReply += 1;
        continue;
      }
      this.onSessionEnd(match.threadId, uuid || match.entry.uuid, sessionName);
      demoted += 1;
    }

    return { demoted, skippedAwaitingReply };
  }

  /**
   * Notify the router that a thread has been resolved (conversation complete).
   *
   * Emits a `thread-closed` ledger event wrapped in try/finally so the ledger
   * emitter fires even if the resolve() call itself throws. Signal-only.
   */
  onThreadResolved(threadId: string): void {
    const entry = this.threadResumeMap.get(threadId);
    try {
      this.threadResumeMap.resolve(threadId);
    } finally {
      this.emitLedger({
        kind: 'thread-closed',
        threadId,
        remoteAgent: entry?.remoteAgent ?? 'unknown',
        subject: entry?.subject ?? '(unknown)',
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Notify the router that a thread has failed (unrecoverable error).
   */
  onThreadFailed(threadId: string): void {
    const entry = this.threadResumeMap.get(threadId);
    if (!entry) return;

    this.threadResumeMap.save(threadId, {
      ...entry,
      state: 'failed',
      lastAccessedAt: new Date().toISOString(),
    });
  }

  // ── Private: Resume an existing thread ──────────────────────

  private async resumeThread(
    threadId: string,
    entry: ThreadResumeEntry,
    envelope: MessageEnvelope,
    relayContext?: RelayMessageContext,
  ): Promise<ThreadlineHandleResult> {
    const { message } = envelope;

    // Build history context (trust-level-aware depth for relay)
    const maxHistory = relayContext
      ? RELAY_HISTORY_LIMITS[relayContext.trustLevel]
      : this.config.maxHistoryMessages;
    const historyContext = await this.buildHistoryContext(threadId, maxHistory);

    // Build the resume prompt (with grounding preamble if relay)
    const prompt = this.buildPrompt(
      message,
      threadId,
      entry.subject,
      entry.messageCount,
      entry.remoteAgent,
      historyContext,
      relayContext,
    );

    // Spawn with resume UUID
    const spawnResult = await this.spawnManager.evaluate({
      requester: message.from,
      target: { agent: this.config.localAgent, machine: this.config.localMachine },
      reason: `Resume thread ${threadId} with ${entry.remoteAgent}`,
      context: prompt,
      priority: message.priority === 'critical' ? 'critical' : 'medium',
      pendingMessages: [message.id],
    });

    if (!spawnResult.approved) {
      this.spawnManager.handleDenial(
        {
          requester: message.from,
          target: { agent: this.config.localAgent, machine: this.config.localMachine },
          reason: `Resume thread ${threadId}`,
          priority: message.priority === 'critical' ? 'critical' : 'medium',
        },
        spawnResult,
      );

      return {
        handled: true,
        threadId,
        error: `Spawn denied: ${spawnResult.reason}`,
      };
    }

    // Update the resume map entry
    this.threadResumeMap.save(threadId, {
      ...entry,
      state: 'active',
      lastAccessedAt: new Date().toISOString(),
      messageCount: entry.messageCount + 1,
      sessionName: spawnResult.tmuxSession || entry.sessionName,
    });

    return {
      handled: true,
      threadId,
      resumed: true,
      sessionName: spawnResult.tmuxSession || entry.sessionName,
    };
  }

  // ── Private: Spawn a new thread session ─────────────────────

  private async spawnNewThread(
    threadId: string,
    envelope: MessageEnvelope,
    relayContext?: RelayMessageContext,
  ): Promise<ThreadlineHandleResult> {
    const { message } = envelope;

    // Build history context (may be empty for brand new threads)
    const maxHistory = relayContext
      ? RELAY_HISTORY_LIMITS[relayContext.trustLevel]
      : this.config.maxHistoryMessages;
    const historyContext = await this.buildHistoryContext(threadId, maxHistory);

    // Build the spawn prompt (with grounding preamble if relay)
    const prompt = this.buildPrompt(
      message,
      threadId,
      message.subject,
      1,
      message.from.agent,
      historyContext,
      relayContext,
    );

    // Request spawn
    const spawnResult = await this.spawnManager.evaluate({
      requester: message.from,
      target: { agent: this.config.localAgent, machine: this.config.localMachine },
      reason: `New thread from ${message.from.agent}: ${message.subject}`,
      context: prompt,
      priority: message.priority === 'critical' ? 'critical' : 'medium',
      pendingMessages: [message.id],
    });

    if (!spawnResult.approved) {
      this.spawnManager.handleDenial(
        {
          requester: message.from,
          target: { agent: this.config.localAgent, machine: this.config.localMachine },
          reason: `New thread from ${message.from.agent}`,
          priority: message.priority === 'critical' ? 'critical' : 'medium',
        },
        spawnResult,
      );

      return {
        handled: true,
        threadId,
        error: `Spawn denied: ${spawnResult.reason}`,
      };
    }

    // Create the thread resume entry
    const now = new Date().toISOString();
    const newEntry: ThreadResumeEntry = {
      uuid: spawnResult.sessionId || crypto.randomUUID(),
      sessionName: spawnResult.tmuxSession || `thread-${threadId.slice(0, 8)}`,
      createdAt: now,
      savedAt: now,
      lastAccessedAt: now,
      remoteAgent: message.from.agent,
      subject: message.subject,
      state: 'active',
      pinned: false,
      messageCount: 1,
    };

    this.threadResumeMap.save(threadId, newEntry);

    // Integrated-Being: emit thread-opened ledger event (signal-only).
    this.emitLedger({
      kind: 'thread-opened',
      threadId,
      remoteAgent: message.from.agent,
      subject: message.subject,
      timestamp: new Date().toISOString(),
    });

    return {
      handled: true,
      threadId,
      spawned: true,
      sessionName: newEntry.sessionName,
    };
  }

  // ── Private: Inject into live session (PR-4) ────────────────

  /**
   * Attempt to deliver an inbound message directly into an already-running
   * session for this thread, avoiding the spawn/resume path entirely.
   * Returns a successful ThreadlineHandleResult on success, or null to
   * signal the caller should fall back to resume/spawn.
   */
  private async tryInjectIntoLiveSession(
    threadId: string,
    entry: ThreadResumeEntry,
    envelope: MessageEnvelope,
  ): Promise<ThreadlineHandleResult | null> {
    if (!this.messageDelivery) return null;
    if (!entry.sessionName) return null;

    try {
      const result = await this.messageDelivery.deliverToSession(entry.sessionName, envelope);
      if (!result.success) {
        console.log(`[ThreadlineRouter] Live-session injection failed for thread ${threadId} (${entry.sessionName}): ${result.failureReason}. Falling back to resume/spawn.`);
        return null;
      }

      // Injection succeeded — update the resume map entry
      this.threadResumeMap.save(threadId, {
        ...entry,
        state: 'active',
        lastAccessedAt: new Date().toISOString(),
        messageCount: entry.messageCount + 1,
      });

      console.log(`[ThreadlineRouter] Injected message into live session ${entry.sessionName} for thread ${threadId}`);
      return {
        handled: true,
        threadId,
        injected: true,
        sessionName: entry.sessionName,
      };
    } catch (err) {
      console.warn(`[ThreadlineRouter] Live-session injection threw for thread ${threadId}:`, err);
      return null;
    }
  }

  // ── Private: Build thread history context ───────────────────

  private async buildHistoryContext(threadId: string, maxMessages?: number): Promise<string> {
    try {
      const limit = maxMessages ?? this.config.maxHistoryMessages;
      if (limit <= 0) return '';

      // Fetch thread info from the messaging system's thread store
      const threadData = await this.messageRouter.getThread(threadId);
      if (!threadData || threadData.messages.length === 0) {
        return '';
      }

      // Take the last N messages, then enforce a total BYTE budget. The block
      // this produces is embedded in a spawn prompt passed as a `tmux
      // new-session` command argument (~16 KB ceiling), so an unbounded history
      // would fail the spawn outright on long threads ("command too long").
      // buildBoundedHistorySection walks newest-first and drops/truncates older
      // content to fit — see MAX_HISTORY_BYTES.
      const recent = threadData.messages.slice(-limit).map((env) => ({
        agent: env.message.from.agent,
        createdAt: env.message.createdAt,
        body: env.message.body,
      }));

      return buildBoundedHistorySection(recent, threadData.messages.length, {
        maxBytes: MAX_HISTORY_BYTES,
        perMessageBytes: MAX_HISTORY_MESSAGE_BYTES,
      });
    } catch {
      // @silent-fallback-ok — thread history is supplementary context; missing it degrades but doesn't break
      return '';
    }
  }

  // ── Private: Build spawn/resume prompt ──────────────────────

  private buildPrompt(
    latestMessage: AgentMessage,
    threadId: string,
    subject: string,
    messageCount: number,
    remoteAgent: string,
    historyContext: string,
    relayContext?: RelayMessageContext,
  ): string {
    const historySection = historyContext
      ? `${historyContext}\n`
      : 'No previous history available.\n';

    // Cap the latest body too: it's the other unbounded input to the spawn
    // command argument (a peer can send an arbitrarily large message). Together
    // with the bounded history this keeps the whole `tmux new-session` command
    // under tmux's ~16 KB "command too long" ceiling.
    const latestBody = capMessageBody(latestMessage.body, MAX_LATEST_BODY_BYTES);

    const basePrompt = THREAD_SPAWN_PROMPT_TEMPLATE
      .replaceAll('{remote_agent}', remoteAgent)
      .replaceAll('{thread_id}', threadId)
      .replaceAll('{subject}', subject)
      .replaceAll('{message_count}', String(messageCount))
      .replaceAll('{history_section}', historySection)
      .replaceAll('{latest_subject}', latestMessage.subject)
      .replaceAll('{latest_body}', latestBody);

    // If relay context is present, wrap with grounding preamble
    if (relayContext) {
      const grounding = buildRelayGroundingPreamble({
        agentName: this.config.localAgent,
        senderName: relayContext.senderName,
        senderFingerprint: relayContext.senderFingerprint,
        trustLevel: relayContext.trustLevel,
        trustSource: relayContext.trustSource,
        trustDate: relayContext.trustDate,
        originFingerprint: relayContext.originFingerprint,
        originName: relayContext.originName,
      });

      return `${grounding.header}\n\n${basePrompt}\n\n${grounding.footer}`;
    }

    return basePrompt;
  }
}

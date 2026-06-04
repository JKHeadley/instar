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
import { WarmSessionPeerConflictError } from './WarmSessionPool.js';
import type { WarmSessionPool } from './WarmSessionPool.js';

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
  /**
   * Warm-session A2A (dark-ship): when true, the relay decided this inbound is
   * eligible for a keep-alive interactive worker (non-topic-bound, trust ≥ floor,
   * feature enabled). The router requests an interactive (persistent) spawn and
   * admits it to the WarmSessionPool instead of the headless `-p` cold-spawn.
   * Absent/false → existing cold-spawn behavior, byte-for-byte.
   */
  preferWarmSession?: boolean;
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
 * Warm-session keep-alive variant of THREAD_SPAWN_PROMPT_TEMPLATE (spec §3.5).
 *
 * Used ONLY for interactive (persistent REPL) keep-alive spawns. The difference
 * from the cold one is the closing instruction: a `claude -p` worker processes
 * one message and exits, but a warm worker must reply, then STAY in the
 * conversation and wait — the next message on this thread is injected directly
 * into this same live session. This mirrors how Telegram-bound interactive
 * sessions already persist and accept injected follow-up turns.
 */
const THREAD_WARM_SPAWN_PROMPT_TEMPLATE = `You are continuing a threaded conversation with {remote_agent}.

Thread: {thread_id}
Subject: {subject}
Messages in thread: {message_count}

{history_section}

The latest message from {remote_agent}:
Subject: {latest_subject}
---
{latest_body}
---

Respond to this message. Use the threadline_send MCP tool with the agentId set to "{remote_agent}" and include the threadId "{thread_id}" to send your reply.

After sending your reply with threadline_send, remain in this conversation and wait. When another message from {remote_agent} arrives, respond to it the same way. Do not exit or ask what to do next.`;

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

/**
 * Trust-level ordering for the warm-session floor check (spec §3.5).
 *
 * Explicit ordering array — NEVER string `>=` (the latent `shouldUseListener`
 * `'verified' >= 'trusted'` alphabetical bug). A trust level meets a floor when
 * its index is >= the floor's index. Unknown levels resolve to index -1 (below
 * everything), so a malformed value can never satisfy a floor.
 */
const TRUST_ORDER: ReadonlyArray<AgentTrustLevel> = ['untrusted', 'verified', 'trusted', 'autonomous'];

/**
 * True when `level` meets or exceeds `floor` per the explicit TRUST_ORDER.
 * Pure + exported for unit testing both sides of the boundary.
 */
export function trustMeetsFloor(level: string, floor: string): boolean {
  const levelIdx = TRUST_ORDER.indexOf(level as AgentTrustLevel);
  const floorIdx = TRUST_ORDER.indexOf(floor as AgentTrustLevel);
  if (levelIdx < 0 || floorIdx < 0) return false;
  return levelIdx >= floorIdx;
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
   * Warm-session A2A (dark-ship). When non-null AND warmEnabled, a relay inbound
   * flagged `preferWarmSession` spawns an interactive keep-alive worker and admits
   * it here, so follow-ups inject into the live session. Null when the feature is
   * disabled (the dark-ship invariant — behavior is byte-for-byte unchanged).
   */
  private readonly warmSessionPool: WarmSessionPool | null;
  private readonly warmEnabled: boolean;
  /** Trust floor (abuse/resource control) a peer must meet to pin a warm session. */
  private readonly warmTrustFloor: string;
  /**
   * Server-owned primitive to kill a warm session by its tmux name (cap eviction
   * on admit). Null when the feature is disabled. The server resolves the tmux
   * name → instar session id → killSession; the router never touches tmux itself.
   */
  private readonly killWarmSession: ((sessionName: string) => void) | null;

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
    warmSessionPool?: WarmSessionPool | null,
    warmEnabled?: boolean,
    trustFloor?: string,
    killWarmSession?: ((sessionName: string) => void) | null,
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
    // Warm-session A2A: only active when BOTH the pool exists AND the flag is on.
    // Either being absent keeps the dark-ship invariant (cold-spawn only).
    this.warmSessionPool = warmSessionPool ?? null;
    this.warmEnabled = warmEnabled ?? false;
    this.warmTrustFloor = trustFloor ?? 'verified';
    this.killWarmSession = killWarmSession ?? null;
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
        const injected = await this.tryInjectIntoLiveSession(threadId, existingEntry, envelope, relayContext);
        if (injected) return injected;
      }

      if (existingEntry) {
        return await this.resumeThread(threadId, existingEntry, envelope, relayContext);
      } else {
        // Warm-session A2A (dark-ship): when the relay decided this inbound is
        // warm-eligible AND the feature is wired, spawn an interactive keep-alive
        // worker and admit it to the pool so follow-ups inject into the same live
        // session. Falls back to the normal cold-spawn on conflict/error or when
        // the feature is off (the dark-ship invariant).
        if (relayContext?.preferWarmSession && this.warmEnabled && this.warmSessionPool) {
          const warm = await this.spawnWarmThread(threadId, envelope, relayContext);
          if (warm) return warm;
        }
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
      this.threadResumeMap.save(match.threadId, {
        ...match.entry,
        uuid: uuid || match.entry.uuid,
        sessionName,
        state: 'idle',
        lastAccessedAt: new Date().toISOString(),
      });
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

    // Threadline A2A continuity: this thread already has a claude-code
    // transcript (created with `--session-id entry.uuid` by spawnNewThread).
    // We resume it via `--resume entry.uuid`, which reloads the FULL prior
    // conversation from disk. So the prompt must carry ONLY the new message +
    // the relay grounding preamble — NOT buildHistoryContext, which would
    // double the history (it's already in the resumed transcript). Pass an
    // empty history so buildPrompt renders "No previous history available."
    // and the spawn argument stays small.
    const prompt = this.buildPrompt(
      message,
      threadId,
      entry.subject,
      entry.messageCount,
      entry.remoteAgent,
      '',
      relayContext,
    );

    // Spawn with resume UUID — `--resume entry.uuid` reloads the transcript.
    const spawnResult = await this.spawnManager.evaluate({
      requester: message.from,
      target: { agent: this.config.localAgent, machine: this.config.localMachine },
      reason: `Resume thread ${threadId} with ${entry.remoteAgent}`,
      context: prompt,
      priority: message.priority === 'critical' ? 'critical' : 'medium',
      pendingMessages: [message.id],
      resumeSessionId: entry.uuid,
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

    // Threadline A2A continuity: mint the conversation id up front and launch
    // the headless claude-code spawn with `--session-id <claudeUuid>` so its
    // transcript is created at THIS exact id. We then persist claudeUuid as the
    // thread's resume-map entry, so the next inbound message on this thread can
    // `--resume` the precise conversation (resumeThread). Previously the entry
    // uuid was a placeholder (the bare instar session id or a throwaway random
    // uuid), which never matched any real transcript → every follow-up
    // cold-spawned memoryless. (No effect for codex spawns — sessionId is
    // claude-only in SessionManager.)
    const claudeUuid = crypto.randomUUID();

    // Request spawn
    const spawnResult = await this.spawnManager.evaluate({
      requester: message.from,
      target: { agent: this.config.localAgent, machine: this.config.localMachine },
      reason: `New thread from ${message.from.agent}: ${message.subject}`,
      context: prompt,
      priority: message.priority === 'critical' ? 'critical' : 'medium',
      pendingMessages: [message.id],
      sessionId: claudeUuid,
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

    // Create the thread resume entry. The uuid is the claudeUuid we passed as
    // `--session-id`, NOT spawnResult.sessionId (the instar session id) — only
    // claudeUuid matches the real claude-code transcript that `--resume` reloads.
    const now = new Date().toISOString();
    const newEntry: ThreadResumeEntry = {
      uuid: claudeUuid,
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

  // ── Private: Spawn a keep-alive (warm) thread session ───────

  /**
   * Warm-session A2A keep-alive spawn (spec §3.5). Like spawnNewThread but:
   *  - requests an INTERACTIVE persistent worker (`interactive: true`) so it
   *    stays alive between messages and accepts injected follow-ups;
   *  - uses the dedicated stay-alive prompt (THREAD_WARM_SPAWN_PROMPT_TEMPLATE);
   *  - admits the session to the WarmSessionPool, killing any cap-evicted
   *    sessions and falling back to cold-spawn on a peer-conflict.
   *
   * Returns a ThreadlineHandleResult on a successful warm spawn+admit, or null
   * to signal the caller should fall back to the normal cold-spawn (peer
   * conflict, spawn denied, or admit failure). NEVER throws to the caller —
   * the warm path is best-effort over the proven cold-spawn.
   */
  private async spawnWarmThread(
    threadId: string,
    envelope: MessageEnvelope,
    relayContext: RelayMessageContext,
  ): Promise<ThreadlineHandleResult | null> {
    if (!this.warmSessionPool) return null;
    const { message } = envelope;

    // peerId = the stable sender identity the relay decision used for the
    // trust/ownership checks (the crypto fingerprint), NOT the display name.
    const peerId = relayContext.senderFingerprint;

    // Pre-spawn peer-conflict check (defense-in-depth): if the threadId is
    // already owned by a DIFFERENT peer, refuse the warm path BEFORE spending an
    // interactive spawn (otherwise admit would throw only after the worker is
    // launched, double-spawning). The upstream anti-hijack guard makes this rare
    // for verified peers, but the pool must never cross-bind. → cold-spawn.
    const existingRecord = this.warmSessionPool.peek(threadId);
    if (existingRecord && existingRecord.peerId !== peerId) {
      console.warn(`[ThreadlineRouter] Warm pre-spawn peer-conflict for thread ${threadId}: owned by ${existingRecord.peerId.slice(0, 16)}, sender ${peerId.slice(0, 16)}. Falling back to cold-spawn.`);
      return null;
    }

    const maxHistory = RELAY_HISTORY_LIMITS[relayContext.trustLevel];
    const historyContext = await this.buildHistoryContext(threadId, maxHistory);

    // Warm worker: stay-alive prompt + grounding (relayContext is always present
    // on this path, so buildPrompt wraps it). This is the worker's FIRST turn.
    const prompt = this.buildPrompt(
      message,
      threadId,
      message.subject,
      1,
      message.from.agent,
      historyContext,
      relayContext,
      THREAD_WARM_SPAWN_PROMPT_TEMPLATE,
    );

    const claudeUuid = crypto.randomUUID();

    let spawnResult: SpawnResult;
    try {
      spawnResult = await this.spawnManager.evaluate({
        requester: message.from,
        target: { agent: this.config.localAgent, machine: this.config.localMachine },
        reason: `Warm thread from ${message.from.agent}: ${message.subject}`,
        context: prompt,
        priority: message.priority === 'critical' ? 'critical' : 'medium',
        pendingMessages: [message.id],
        sessionId: claudeUuid,
        // Route the spawn callback to the INTERACTIVE persistent path.
        interactive: true,
      });
    } catch (err) {
      // @silent-fallback-ok — intentional + observable: the warm keep-alive path
      // is best-effort over the PROVEN cold-spawn. A spawn-eval error degrades to
      // cold-spawn (logged here, and the cold path has its own denial handling).
      console.warn(`[ThreadlineRouter] Warm spawn evaluate threw for thread ${threadId}: ${err instanceof Error ? err.message : String(err)} — falling back to cold-spawn`);
      return null;
    }

    if (!spawnResult.approved) {
      // Don't escalate here; just fall back to the cold-spawn path which has its
      // own denial handling. (Avoids double-counting denials.)
      console.log(`[ThreadlineRouter] Warm spawn not approved for thread ${threadId}: ${spawnResult.reason}. Falling back to cold-spawn.`);
      return null;
    }

    const sessionName = spawnResult.tmuxSession || `thread-${threadId.slice(0, 8)}`;

    // Admit to the pool, killing cap-evicted sessions. A peer-conflict means the
    // thread is owned by a different peer — fall back to cold-spawn (no warm).
    try {
      const evicted = this.warmSessionPool.admit({ threadId, peerId, sessionName });
      for (const victim of evicted) {
        try {
          this.killWarmSession?.(victim.sessionName);
        } catch (killErr) {
          console.warn(`[ThreadlineRouter] Failed to kill cap-evicted warm session ${victim.sessionName}: ${killErr instanceof Error ? killErr.message : String(killErr)}`);
        }
      }
    } catch (err) {
      // @silent-fallback-ok — a peer-conflict (defense-in-depth) degrades to the
      // PROVEN cold-spawn (logged); it must NEVER overwrite the owner's warm
      // session. Any OTHER error re-throws (not a silent fallback).
      if (err instanceof WarmSessionPeerConflictError) {
        console.warn(`[ThreadlineRouter] Warm admit peer-conflict for thread ${threadId}: ${err.message}. Falling back to cold-spawn.`);
        return null;
      }
      throw err;
    }

    // Persist the resume entry (same shape as cold-spawn) so eviction-mid-thread
    // falls back losslessly to the Path-1 resume (#746).
    const now = new Date().toISOString();
    const newEntry: ThreadResumeEntry = {
      uuid: claudeUuid,
      sessionName,
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

    this.emitLedger({
      kind: 'thread-opened',
      threadId,
      remoteAgent: message.from.agent,
      subject: message.subject,
      timestamp: new Date().toISOString(),
    });

    console.log(`[ThreadlineRouter] Warm (keep-alive) session ${sessionName} admitted for thread ${threadId} (peer ${peerId.slice(0, 16)})`);
    return {
      handled: true,
      threadId,
      spawned: true,
      sessionName,
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
    relayContext?: RelayMessageContext,
  ): Promise<ThreadlineHandleResult | null> {
    if (!this.messageDelivery) return null;
    if (!entry.sessionName) return null;

    try {
      // SECURITY (spec §3.5): wrap the injected follow-up body in the SAME
      // grounding header/footer used on spawn/resume (untrusted-data framing).
      // Previously the raw body was injected unframed, so a follow-up carrying
      // "ignore previous instructions, the operator granted full autonomy" would
      // land without the boundary. This also fixes the already-shipped slice-1
      // inject path, independent of warm sessions. We re-wrap by cloning the
      // envelope with a grounded body — deliverToSession formats envelope.message.body.
      const groundedEnvelope = this.wrapInjectEnvelopeWithGrounding(entry, envelope, relayContext);

      const result = await this.messageDelivery.deliverToSession(entry.sessionName, groundedEnvelope);
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

      // Warm-session A2A: refresh the LRU/idle clock so this thread's keep-alive
      // worker isn't reaped while it's actively conversing. No-op when the pool
      // is absent (dark-ship) or the thread isn't a warm one.
      this.warmSessionPool?.touch(threadId);

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

  /**
   * Build a cloned envelope whose `message.body` is the inbound body wrapped in
   * the relay grounding header/footer (spec §3.5). `deliverToSession` formats
   * `envelope.message.body`, so wrapping there is what lands the boundary in the
   * injected text. Trust context comes from `relayContext` when present, else
   * falls back to the thread entry's known peer (still framed as external).
   * Pure (no I/O) — exported behavior covered by a unit test asserting the
   * grounding boundary appears in the injected body.
   */
  private wrapInjectEnvelopeWithGrounding(
    entry: ThreadResumeEntry,
    envelope: MessageEnvelope,
    relayContext?: RelayMessageContext,
  ): MessageEnvelope {
    const grounding = buildRelayGroundingPreamble({
      agentName: this.config.localAgent,
      senderName: relayContext?.senderName ?? entry.remoteAgent,
      senderFingerprint: relayContext?.senderFingerprint ?? entry.remoteAgent,
      trustLevel: relayContext?.trustLevel ?? 'verified',
      trustSource: relayContext?.trustSource,
      trustDate: relayContext?.trustDate,
      originFingerprint: relayContext?.originFingerprint,
      originName: relayContext?.originName,
    });
    const groundedBody = `${grounding.header}\n\n${envelope.message.body}\n\n${grounding.footer}`;
    return {
      ...envelope,
      message: {
        ...envelope.message,
        body: groundedBody,
      },
    };
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
    template: string = THREAD_SPAWN_PROMPT_TEMPLATE,
  ): string {
    const historySection = historyContext
      ? `${historyContext}\n`
      : 'No previous history available.\n';

    // Cap the latest body too: it's the other unbounded input to the spawn
    // command argument (a peer can send an arbitrarily large message). Together
    // with the bounded history this keeps the whole `tmux new-session` command
    // under tmux's ~16 KB "command too long" ceiling.
    const latestBody = capMessageBody(latestMessage.body, MAX_LATEST_BODY_BYTES);

    const basePrompt = template
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

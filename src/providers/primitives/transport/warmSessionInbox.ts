/**
 * WarmSessionInbox — long-lived agent session, file-based message inbox.
 *
 * A persistent agent process that receives messages via a file-system
 * inbox and processes them sequentially. The session lives across many
 * messages, retaining context and warm state.
 *
 * Used for:
 *   - Threadline's ListenerSessionManager (long-lived listener for
 *     incoming agent messages)
 *   - Interactive-pool fallback path (Phase 3b) — N long-lived `claude`
 *     REPLs in tmux, work routed through them to draw from subscription
 *     rather than Agent SDK credit pot
 *   - Future: any "always-on agent" pattern
 *
 * Maps to:
 *   - Claude: long-lived REPL in tmux + tmux send-keys for prompt injection
 *   - Codex: long-lived `codex remote-control` + `turn/steer` JSON-RPC
 *
 * Inbox file format is provider-agnostic (JSONL with `{message, fromAgent,
 * timestamp}` entries). The adapter polls the inbox or uses a wake signal
 * (socket) to detect new messages.
 *
 * Lifecycle:
 *   1. start(options) → spawn the session, return handle
 *   2. send(handle, message) → append to inbox, agent picks it up
 *   3. session emits events as it processes
 *   4. session may be retired when capacity threshold reached
 *      (compaction risk, message count limit, idle timeout)
 *   5. retire(handle) → graceful shutdown
 */

import type {
  CancellationOptions,
  ModelTier,
  ProviderSpecific,
  SessionHandle,
} from '../../types.js';
import type { CanonicalEvent } from '../../events.js';
import { CapabilityFlag } from '../../capabilities.js';

export interface WarmSessionInbox {
  readonly capability: typeof CapabilityFlag.WarmSessionInbox;

  /** Spawn a warm session and return its handle. */
  start(options: WarmSessionInboxOptions): Promise<WarmSessionInboxHandle>;

  /**
   * Deliver a message to the session's inbox. Returns when the message has
   * been written to the inbox file (not when it's been processed). To
   * observe the agent's response, consume the events stream and filter for
   * events tagged with the `correlationId` returned here.
   */
  send(
    handle: SessionHandle,
    message: WarmInboxMessage,
    options?: CancellationOptions,
  ): Promise<{ correlationId: string; deliveredAt: string }>;

  /**
   * Gracefully shut down a warm session. Drains the inbox, lets the agent
   * finish in-flight processing, then closes. Use HardKill for forced
   * termination.
   */
  retire(handle: SessionHandle, options?: CancellationOptions): Promise<void>;
}

export interface WarmSessionInboxOptions extends CancellationOptions {
  /** Inbox file path. Adapter creates if absent. */
  inboxPath: string;
  /** Working directory for the session. */
  workingDirectory?: string;
  /** Model tier. */
  model?: ModelTier;
  /** Optional initial system prompt for the warm session. */
  system?: string;
  /** Environment variables to inject. */
  env?: Readonly<Record<string, string>>;
  /**
   * Maximum number of messages this session should process before retiring.
   * Adapter MAY auto-retire and respawn when reached. Useful for bounding
   * context-window growth.
   */
  maxMessagesBeforeRetire?: number;
  /** Idle timeout before auto-retire (milliseconds). */
  idleRetireMs?: number;
}

export interface WarmInboxMessage {
  /** Message content. */
  content: string;
  /** Optional sender identity for the agent's context. */
  fromAgent?: string;
  /** Optional structured metadata. */
  metadata?: Readonly<Record<string, unknown>>;
}

export interface WarmSessionInboxHandle {
  readonly handle: SessionHandle;
  /** Event stream covering all messages processed by this session. */
  readonly events: AsyncIterable<CanonicalEvent>;
  /** Current message count, for capacity awareness. */
  readonly messageCount: () => number;
  /** Is the session ready to accept messages? */
  readonly isReady: () => boolean;
  readonly providerSpecific?: ProviderSpecific;
}

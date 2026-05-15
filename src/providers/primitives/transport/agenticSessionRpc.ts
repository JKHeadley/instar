/**
 * AgenticSessionRpc — JSON-RPC driven agent session.
 *
 * A session controlled via a structured JSON-RPC channel rather than via
 * stdin/stdout/tmux. The adapter exposes a narrow surface (start, steer,
 * interrupt, observe) regardless of how rich the underlying RPC is.
 *
 * Used for:
 *   - A2A protocol (Instar's existing A2A gateway)
 *   - Codex app-server `thread/start` + `turn/start` JSON-RPC
 *   - Future: any "structured remote control" pattern
 *
 * Maps to:
 *   - Codex: `codex remote-control` (stdio JSON-RPC); the canonical
 *     mapping. Codex exposes a vastly richer surface (fs/*, command/*,
 *     plugin/*, config/*) — that lives behind the optional
 *     `AppServerControlPlane` capability (Phase 2 step 7), not here.
 *   - Anthropic: no native RPC; adapter wraps an AgenticSession-headless
 *     and presents an RPC-shaped facade for callers that need consistency.
 *
 * Why distinct from AgenticSession-headless: the input model is different.
 * Headless takes a prompt at start and runs to completion. RPC takes a
 * series of `turn/start` calls and can be steered mid-task with `turn/steer`.
 * The lifecycle is "always-on" until explicitly closed, like WarmSessionInbox,
 * but the channel is structured RPC rather than file-based messages.
 */

import type {
  CancellationOptions,
  ProviderSpecific,
  SessionHandle,
} from '../../types.js';
import type { CanonicalEvent } from '../../events.js';
import { CapabilityFlag } from '../../capabilities.js';

export interface AgenticSessionRpc {
  readonly capability: typeof CapabilityFlag.AgenticSessionRpc;

  /** Open an RPC-driven session. */
  start(options: AgenticSessionRpcOptions): Promise<AgenticSessionRpcHandle>;

  /**
   * Start a new turn within an existing session. The promise resolves when
   * the turn has been accepted (not when it completes — observe events for
   * completion).
   */
  startTurn(
    handle: SessionHandle,
    turn: TurnRequest,
    options?: CancellationOptions,
  ): Promise<{ turnId: string }>;

  /**
   * Steer an in-flight turn with additional input. Adapters that don't
   * support mid-turn steering throw UnsupportedCapabilityError.
   */
  steerTurn(
    handle: SessionHandle,
    turnId: string,
    input: string,
    options?: CancellationOptions,
  ): Promise<void>;

  /** Cancel an in-flight turn (without closing the session). */
  interruptTurn(
    handle: SessionHandle,
    turnId: string,
    options?: CancellationOptions,
  ): Promise<void>;

  /** Close the session and release its resources. */
  close(handle: SessionHandle, options?: CancellationOptions): Promise<void>;
}

export interface AgenticSessionRpcOptions extends CancellationOptions {
  /** Transport for the RPC channel. */
  transport: 'stdio' | 'unix-socket' | 'tcp' | 'websocket';
  /** Transport-specific endpoint (socket path, host:port, ws URL). */
  endpoint?: string;
  /** Optional model tier (provider may override per turn). */
  model?: import('../../types.js').ModelTier;
  /** Working directory. */
  workingDirectory?: string;
  /** Optional initial capabilities/configuration for the session. */
  initialConfig?: Readonly<Record<string, unknown>>;
}

export interface TurnRequest {
  /** Prompt or message text for this turn. */
  prompt: string;
  /** Optional per-turn metadata (correlation id, task name, etc.). */
  metadata?: Readonly<Record<string, unknown>>;
}

export interface AgenticSessionRpcHandle {
  readonly handle: SessionHandle;
  /** Event stream for the session's lifetime. */
  readonly events: AsyncIterable<CanonicalEvent>;
  /**
   * Whether the underlying provider exposes the rich app-server control
   * plane (fs/command/plugin/config RPC methods). If true, the adapter
   * also implements the optional `AppServerControlPlane` capability. If
   * false, this is just a narrow RPC wrapper around an agent session.
   */
  readonly hasControlPlane: boolean;
  readonly providerSpecific?: ProviderSpecific;
}

/**
 * AgenticSessionHeadless — multi-turn agent session, tools enabled, no human.
 *
 * The workhorse primitive for autonomous instar jobs. Spawns a session that
 * receives an initial prompt + capability grant, runs to completion (or until
 * killed by control primitives), and streams events as it works.
 *
 * Maps to:
 *   - Claude: `claude --dangerously-skip-permissions -p PROMPT` in tmux
 *   - Codex: `codex exec --json PROMPT` with optional `--sandbox` flag
 *   - Codex app-server: `thread/start` JSON-RPC method
 *
 * Distinct from AgenticSessionInteractive because there's no human in the
 * loop — all permissions are either pre-granted or auto-approved by the
 * adapter (with the StopGateInterceptor primitive making the decisions).
 *
 * Distinct from WarmSessionInbox because the session is single-prompt:
 * the prompt arrives at start, the session runs, and ends. No mid-session
 * message injection from an inbox.
 */

import type {
  CancellationOptions,
  ModelTier,
  ProviderSpecific,
  SessionHandle,
} from '../../types.js';
import type { CanonicalEvent } from '../../events.js';
import { CapabilityFlag } from '../../capabilities.js';

export interface AgenticSessionHeadless {
  readonly capability: typeof CapabilityFlag.AgenticSessionHeadless;

  /**
   * Spawn a headless agent session.
   *
   * Returns immediately with a SessionHandle and an event stream. Caller
   * consumes the event stream to observe the session's progress. The
   * session terminates when:
   *   - The agent emits a final response (most common)
   *   - The caller aborts via `options.signal`
   *   - A timeout from `options.timeoutMs` expires
   *   - A control primitive (HardKill, Interrupt) is invoked on the handle
   *   - The provider terminates for an external reason (quota, crash, etc.)
   *
   * In all cases, the event stream emits a `session-lifecycle` event with
   * `lifecycleKind: 'ended'` as the final event before closing.
   */
  start(options: AgenticSessionHeadlessOptions): Promise<AgenticSessionHandle>;
}

export interface AgenticSessionHeadlessOptions extends CancellationOptions {
  /** Initial prompt / instructions for the agent. */
  prompt: string;
  /** Model tier. */
  model?: ModelTier;
  /** Working directory for tools that read/write files. */
  workingDirectory?: string;
  /** Maximum session duration in minutes (separate from options.timeoutMs). */
  maxDurationMinutes?: number;
  /**
   * Tool capability configuration (allowlists, sandbox modes, paths).
   * Concrete shape is provider-defined; pass through capability primitives.
   */
  capabilities?: SessionCapabilityConfig;
  /**
   * Environment variables to inject into the session's tool subprocesses.
   * Adapters MUST scrub sensitive variables (e.g. nested-session markers).
   */
  env?: Readonly<Record<string, string>>;
  /** Optional system message prepended to the agent's instructions. */
  system?: string;
}

/**
 * Marker type for capability config. Each adapter knows how to interpret
 * its own shape; the abstraction does not need to enumerate keys. Use the
 * dedicated capability primitives (ToolAllowlist, PathAllowlist, etc.) to
 * construct these in a portable way.
 */
export type SessionCapabilityConfig = Readonly<Record<string, unknown>>;

export interface AgenticSessionHandle {
  /** Opaque handle. Pass to other primitives (HardKill, Interrupt, etc.). */
  readonly handle: SessionHandle;
  /**
   * Event stream for this session. Iterate to observe progress; the stream
   * closes after a `session-lifecycle.ended` event is emitted.
   *
   * Implementations SHOULD support multiple consumers (tee the stream).
   * If they don't, document the single-consumer constraint and throw on
   * second iteration attempt.
   */
  readonly events: AsyncIterable<CanonicalEvent>;
  /** Adapter-specific extension fields. */
  readonly providerSpecific?: ProviderSpecific;
}

/**
 * AgenticSessionInteractive — multi-turn agent session, tools enabled,
 * human at a TTY.
 *
 * Used for: setup wizards, conversational onboarding, debug sessions where
 * the human is expected to type into the same terminal. Distinct from
 * AgenticSessionHeadless because the TTY is owned by the user, not the
 * abstraction.
 *
 * The most important difference: the abstraction does NOT control input
 * after startup. The user types. The abstraction may observe (via events
 * if the provider supports them) but cannot inject.
 *
 * Maps to:
 *   - Claude: bare `claude` with `stdio: 'inherit'`
 *   - Codex: bare `codex` with `stdio: 'inherit'`
 *
 * Why this is a distinct primitive: in the post-2026-06-15 billing world,
 * interactive sessions draw from Anthropic's Max subscription rather than
 * the Agent SDK credit pot. The routing policy uses the capability flag
 * to choose between this and AgenticSessionHeadless based on quota state.
 *
 * Note: this primitive is for sessions where a USER is at the terminal.
 * For programmatic "interactive-mode" usage (the interactive-pool strategy
 * for subscription compatibility), use a `WarmSessionInbox` adapter that
 * internally drives a `claude` REPL via tmux. The capability boundary is
 * "human controls the TTY" vs. "instar drives a TTY-bound process."
 */

import type {
  CancellationOptions,
  ProviderSpecific,
  SessionHandle,
} from '../../types.js';
import type { CanonicalEvent } from '../../events.js';
import { CapabilityFlag } from '../../capabilities.js';

export interface AgenticSessionInteractive {
  readonly capability: typeof CapabilityFlag.AgenticSessionInteractive;

  /**
   * Launch an interactive session attached to the current TTY.
   *
   * The current process's stdio is connected to the spawned agent. Returns
   * a handle and event stream (events only populate if the provider
   * supports out-of-band observability while a human owns the TTY — most
   * don't, so events may be empty for the lifetime of the session).
   */
  launch(options: AgenticSessionInteractiveOptions): Promise<AgenticSessionInteractiveHandle>;
}

export interface AgenticSessionInteractiveOptions extends CancellationOptions {
  /**
   * Optional initial slash-command or prompt to pre-fill. E.g., a setup
   * wizard might launch with `/setup-wizard` already populated.
   */
  initialInput?: string;
  /** Working directory. */
  workingDirectory?: string;
  /** Environment variables to inject (adapter scrubs sensitive markers). */
  env?: Readonly<Record<string, string>>;
}

export interface AgenticSessionInteractiveHandle {
  readonly handle: SessionHandle;
  /**
   * Event stream — typically empty or sparse while the TTY is human-owned.
   * Closes when the user exits the session.
   */
  readonly events: AsyncIterable<CanonicalEvent>;
  /**
   * Promise that resolves when the user closes the session. Use this
   * instead of consuming `events` if you only need to await completion.
   */
  readonly waitForExit: Promise<{ exitCode: number; durationMs: number }>;
  readonly providerSpecific?: ProviderSpecific;
}

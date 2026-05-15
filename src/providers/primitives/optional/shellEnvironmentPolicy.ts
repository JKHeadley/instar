/**
 * ShellEnvironmentPolicy — control which env vars subprocess tools see.
 *
 * OPTIONAL primitive — Codex-native. Determines whether shell tools
 * (Bash, bash_run) inherit the parent process's environment, get a
 * scrubbed subset, or get an empty env. Important for preventing
 * credential leakage into tool subprocesses.
 *
 * Maps to:
 *   - Codex: `shell_environment_policy` config key (clean/trimmed/pass-through)
 *   - Claude: instar's SessionManager manually scrubs env vars during
 *     tmux spawn; this primitive surfaces the same control as a config
 */

import type { CancellationOptions } from '../../types.js';
import { CapabilityFlag } from '../../capabilities.js';

export interface ShellEnvironmentPolicy {
  readonly capability: typeof CapabilityFlag.ShellEnvironmentPolicy;

  /** Current policy. */
  get(options?: CancellationOptions): Promise<ShellEnvPolicy>;

  /** Update policy. Affects new sessions; existing keep their start-time policy. */
  set(
    policy: ShellEnvPolicy,
    options?: CancellationOptions,
  ): Promise<void>;
}

export interface ShellEnvPolicy {
  /**
   * 'clean' = empty env for subprocesses
   * 'trimmed' = only safe variables (no credentials)
   * 'pass-through' = inherit everything
   */
  mode: 'clean' | 'trimmed' | 'pass-through';
  /** Additional env vars to always include (mode-independent). */
  alwaysInclude?: ReadonlyArray<string>;
  /** Env vars to always exclude even if mode would include them. */
  alwaysExclude?: ReadonlyArray<string>;
}

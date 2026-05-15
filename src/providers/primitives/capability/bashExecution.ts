/**
 * BashExecution — agent's ability to invoke shell commands.
 *
 * Maps to:
 *   - Claude: built-in `Bash` tool (governed by ToolAllowlist + permissions)
 *   - Codex: built-in `Bash` / `apply_patch` (sandboxed via command/exec);
 *     unsandboxed via experimental `process/spawn`
 *
 * Distinct from `ToolAccess.kind === 'bash'` because shell access is
 * elevated-risk: even if a session has shell capability, the caller
 * typically wants to gate WHICH commands are runnable, optionally restrict
 * env vars, and require approval for destructive operations.
 */

import { CapabilityFlag } from '../../capabilities.js';

export interface BashExecution {
  readonly capability: typeof CapabilityFlag.BashExecution;

  /** Build a portable bash-execution spec for session establishment. */
  buildSpec(rules: BashExecutionRules): BashExecutionSpec;

  /**
   * Whether the provider distinguishes sandboxed from unsandboxed shell.
   * If true, `BashExecutionRules.allowUnsandboxed` is honored; if false,
   * the field is ignored and the session uses the provider's only mode.
   */
  supportsSandboxModes(): boolean;
}

export interface BashExecutionRules {
  /**
   * Allowed commands by name or glob. Adapter matches against the leading
   * token of each `Bash` invocation. Empty array = no commands allowed
   * (i.e., disable shell entirely). Omitted = all commands allowed.
   */
  allowedCommands?: ReadonlyArray<string>;
  /** Commands always denied even if in allowedCommands. Deny wins. */
  deniedCommands?: ReadonlyArray<string>;
  /**
   * Whether commands run in the sandbox or have unfettered host access.
   * Applies only when provider supports both modes (see supportsSandboxModes).
   */
  allowUnsandboxed?: boolean;
  /**
   * Environment-variable policy. 'clean' = empty env. 'trimmed' = only
   * the variables the adapter deems safe. 'pass-through' = inherit from
   * parent process. Default: 'trimmed'.
   */
  envPolicy?: 'clean' | 'trimmed' | 'pass-through';
  /** Per-command timeout in milliseconds. */
  perCommandTimeoutMs?: number;
}

export type BashExecutionSpec = Readonly<{
  readonly __brand: 'BashExecutionSpec';
  readonly rules: BashExecutionRules;
}>;

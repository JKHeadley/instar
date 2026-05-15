/**
 * FileSystemAccess — sandboxing for the agent's filesystem operations.
 *
 * Determines what level of filesystem access a session has. Composes with
 * `PathAllowlist` for fine-grained per-path control.
 *
 * Maps to:
 *   - Claude: implicit (skip-permissions flag plus PathAllowlist via `--add-dir`)
 *   - Codex: `sandbox_mode = "read-only" | "workspace-write" | "danger-full-access"`
 *     in config.toml
 *
 * The abstraction surfaces three sandbox tiers that map cleanly to Codex's
 * three modes. Claude approximates "workspace-write" with its default and
 * "danger-full-access" via skip-permissions.
 */

import { CapabilityFlag } from '../../capabilities.js';

export interface FileSystemAccess {
  readonly capability: typeof CapabilityFlag.FileSystemAccess;

  /** Build a portable filesystem-access spec for session establishment. */
  buildSpec(mode: SandboxMode, options?: FilesystemAccessOptions): FileSystemAccessSpec;

  /** Sandbox modes supported by this provider. */
  supportedModes(): ReadonlySet<SandboxMode>;
}

export type SandboxMode =
  /** Read-only access to all paths (except those explicitly denied). */
  | 'read-only'
  /** Read everywhere; write only inside the workspace (working directory tree). */
  | 'workspace-write'
  /** Unrestricted read/write. Use with extreme caution; reserve for trusted workflows. */
  | 'danger-full-access';

export interface FilesystemAccessOptions {
  /** Override the workspace root (defaults to session's workingDirectory). */
  workspaceRoot?: string;
  /** Override the user's $HOME if the sandbox shouldn't follow it. */
  homeOverride?: string;
}

export type FileSystemAccessSpec = Readonly<{
  readonly __brand: 'FileSystemAccessSpec';
  readonly mode: SandboxMode;
  readonly options?: FilesystemAccessOptions;
}>;

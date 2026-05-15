/**
 * PathAllowlist — fine-grained per-path filesystem access rules.
 *
 * Composes with `FileSystemAccess` to specify exceptions: a `read-only`
 * session that needs write access to a specific scratch directory, or a
 * `workspace-write` session that's blocked from a specific subtree.
 *
 * Maps to:
 *   - Claude: `--add-dir <path>` CLI flag (additive, no deny semantics)
 *   - Codex: `permissions.<name>.filesystem` named profiles with path-based
 *     rules; more expressive
 *
 * The abstraction supports both allow and deny rules with a clear
 * precedence (deny wins). Providers that lack deny semantics map deny
 * rules to "no allow rule for this path" approximation.
 */

import { CapabilityFlag } from '../../capabilities.js';

export interface PathAllowlist {
  readonly capability: typeof CapabilityFlag.PathAllowlist;

  /** Build a portable spec from a rule set. */
  buildSpec(rules: PathAllowlistRules): PathAllowlistSpec;

  /** Whether this provider supports explicit deny rules. */
  supportsDenyRules(): boolean;
}

export interface PathAllowlistRules {
  /** Paths the session may read. Absolute paths or workspace-relative. */
  readAllow?: ReadonlyArray<string>;
  /** Paths the session may write. */
  writeAllow?: ReadonlyArray<string>;
  /** Paths denied even if allowed by another rule. Deny wins on conflict. */
  deny?: ReadonlyArray<string>;
  /**
   * Whether allowlist rules apply recursively to subdirectories. Default true.
   */
  recursive?: boolean;
}

export type PathAllowlistSpec = Readonly<{
  readonly __brand: 'PathAllowlistSpec';
  readonly rules: PathAllowlistRules;
}>;

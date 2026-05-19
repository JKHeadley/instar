/**
 * Framework-parity types — the contract shared by every parity rule and
 * by the future FrameworkParitySentinel that consumes the rules registry.
 *
 * Spec: specs/instar-foundations/framework-functional-parity.md
 *       specs/provider-portability/13-framework-parity-sentinel.md
 *
 * A ParityRule covers one (primitive × framework) cell of the capability
 * matrix. It declares what canonical input it reads, how to verify a
 * framework's rendering matches, and how to remediate drift.
 */

import type { IntelligenceFramework } from '../../core/intelligenceProviderFactory.js';

/**
 * Which Layer-3 functional primitive this rule covers.
 * Spec: specs/instar-foundations/required-primitives-inventory.md
 */
export type FunctionalPrimitive =
  | 'skill'
  | 'hook'
  | 'agent'
  | 'tool'
  | 'memory'
  | 'instruction-file'
  | 'session-resume'
  | 'slash-command'
  | 'messaging-platform-integration'
  | 'conversational-action'
  | 'mcp-server';

/**
 * Framework slot for a mismatch. Most mismatches name a specific framework
 * adapter; `'canonical'` is used when the issue is at the canonical-source
 * layer (parse error, missing file, slug grammar violation) and cannot be
 * attributed to any framework's rendering.
 */
export type MismatchFrameworkSlot = IntelligenceFramework | 'canonical';

/**
 * The shape of a single rendering mismatch detected by a parity rule's
 * verify() pass. Multiple mismatches per (skill × framework) cell are
 * possible; verify() returns all of them.
 */
export interface ParityMismatch {
  primitive: FunctionalPrimitive;
  /** Identifier of the specific instance (skill name, hook name, etc.) */
  instanceName: string;
  framework: MismatchFrameworkSlot;
  /** Machine-readable reason — used for sentinel auto-remediation routing */
  reasonCode:
    | 'canonical-read-error'        // canonical SKILL.md missing / malformed / slug grammar / git-merge-conflict
    | 'rendering-parse-error'       // rendered file present but unparseable
    | 'missing-rendered-file'
    | 'frontmatter-name-mismatch'
    | 'frontmatter-description-mismatch'
    | 'body-content-mismatch'
    | 'user-edit-conflict'          // body differs but stamp matches canonical hash — user edited rendering
    | 'sibling-artifact-missing'
    | 'sibling-artifact-mismatch'
    | 'bundled-subdir-missing'
    | 'bundled-subdir-mismatch'
    | 'orphan-rendering-found';     // rendered skill dir with no canonical counterpart
  /** Human-readable detail — surfaced in logs + reports */
  detail: string;
}

export interface VerifyResult {
  ok: boolean;
  mismatches: ParityMismatch[];
}

/**
 * Trust-level-mirrored auto-fix policy. Locked 2026-05-18:
 * - 'mirror-trust' — apply remediation if the agent's trust level allows it
 * - 'flag-only' — emit drift event, never auto-fix (manual operator action required)
 *
 * The sentinel reads this per-rule when deciding whether to call remediate().
 */
export type RemediationPolicy = 'mirror-trust' | 'flag-only';

/**
 * One (primitive × framework-set) parity rule.
 *
 * Rules are registered in the ParityRegistry; the FrameworkParitySentinel
 * (separate spec) walks the registry on its scan cadence + on explicit
 * trigger to call verify() and (per policy) remediate() per cell.
 */
export interface ParityRule {
  readonly primitive: FunctionalPrimitive;
  /** Frameworks this rule covers. Most rules cover all currently-enabled frameworks. */
  readonly frameworks: ReadonlyArray<IntelligenceFramework>;
  /** How the sentinel handles detected drift. */
  readonly remediationPolicy: RemediationPolicy;
  /**
   * When true, user-edit-conflict is treated as a signal (not blocking
   * authority) and remediate() always overwrites. Required for primitives
   * covered by Migration Parity §4 (built-in hooks "always overwritten on
   * every migration run — never install-if-missing"). The sentinel emits
   * `parity:user-edit-overwritten` for any overwrite that clobbered a
   * detected user edit so operators can recover via audit log + git.
   *
   * Default: false (refuse-on-conflict — operator-action required).
   */
  readonly alwaysOverwrite?: boolean;

  /**
   * Verify the rendering for ONE specific instance (e.g., one skill name)
   * against the canonical source under projectRoot.
   *
   * Returns ok:true with empty mismatches[] when the rendering is in sync;
   * ok:false with one or more mismatches when drift is detected.
   */
  verify(projectRoot: string, instanceName: string): Promise<VerifyResult>;

  /**
   * List all known instance names by reading the canonical source tree.
   * Used by the sentinel to enumerate cells to verify.
   */
  listInstances(projectRoot: string): Promise<string[]>;

  /**
   * Re-render the canonical source into the framework-native shape.
   * Idempotent — calling on an already-correct rendering should be a no-op
   * (the verify() should return ok:true after remediation; calling again
   * doesn't break anything).
   *
   * Throws if the current rendering has a `user-edit-conflict` AND the rule
   * is not marked `alwaysOverwrite: true`. Rules with `alwaysOverwrite: true`
   * (e.g., hookParityRule per Migration Parity §4) overwrite unconditionally
   * and the sentinel emits an audit event recording the clobber.
   */
  remediate(projectRoot: string, instanceName: string, framework: IntelligenceFramework): Promise<void>;

  /**
   * List rendered files in any framework that have no canonical counterpart.
   * Used by the sentinel to drive orphan cleanup separately from the
   * per-instance verify loop.
   */
  listOrphans(projectRoot: string): Promise<ParityMismatch[]>;

  /**
   * Remove orphan rendered files (those with no canonical counterpart) in
   * the given framework. Returns the paths removed for audit logging.
   */
  removeOrphans(projectRoot: string, framework: IntelligenceFramework): Promise<string[]>;
}

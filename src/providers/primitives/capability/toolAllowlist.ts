/**
 * ToolAllowlist — restrict which tools a session may invoke.
 *
 * Composes with the session-establishment primitives — when starting a
 * session, the caller passes a constructed `ToolAllowlistSpec` and the
 * adapter applies it provider-natively.
 *
 * Maps to:
 *   - Claude: `--allowed-tools` CLI flag + `.claude/settings.json` policy
 *   - Codex: `mcp_servers.<id>` allowlist + sandbox-mode gating; identity
 *     match (command/url value) is part of the allowlist key, not just name
 */

import { CapabilityFlag } from '../../capabilities.js';

export interface ToolAllowlist {
  readonly capability: typeof CapabilityFlag.ToolAllowlist;

  /** Construct a portable allowlist spec to pass to session starts. */
  buildSpec(rules: ToolAllowlistRules): ToolAllowlistSpec;
}

/**
 * Rules supplied by the caller, in portable form. The adapter translates
 * to its native config shape.
 */
export interface ToolAllowlistRules {
  /**
   * Either explicit allow-list (only these are permitted) or deny-list
   * (everything except these). Allow-list is more secure; default for
   * untrusted contexts.
   */
  mode: 'allowlist' | 'denylist';
  /** Tool kinds (broad categories) covered by this rule set. */
  toolKinds: ReadonlyArray<import('./toolAccess.js').ToolKind>;
  /**
   * Specific tool names, when finer-grained control is needed. Adapter
   * matches against its native tool names. Cross-provider portability
   * suffers when using this — prefer toolKinds when possible.
   */
  toolNames?: ReadonlyArray<string>;
  /**
   * For MCP servers, an additional identity check (command path or URL
   * value). Required by Codex; ignored by Claude. Including it never hurts
   * portability — it's silently ignored by adapters that don't enforce it.
   */
  mcpIdentities?: ReadonlyArray<{ name: string; commandOrUrl: string }>;
}

/**
 * Opaque allowlist spec to pass to session-starting primitives. The shape
 * is intentionally opaque to callers — each adapter knows how to interpret
 * its own spec.
 */
export type ToolAllowlistSpec = Readonly<{
  readonly __brand: 'ToolAllowlistSpec';
  readonly rules: ToolAllowlistRules;
}>;

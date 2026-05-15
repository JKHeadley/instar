/**
 * ToolAccess — whether the provider can invoke tools at all, and which kinds.
 *
 * Tool inventory and registration. Distinct from `ToolAllowlist` which
 * gates which registered tools are usable per session.
 *
 * Maps to:
 *   - Claude: built-in tools (Read, Edit, Bash, Write, ...) + MCP-registered
 *   - Codex: built-in tools + MCP-registered + plugin-registered
 *
 * Providers expose a list of tool kinds they support. The abstraction
 * groups them into broad categories so callers can ask "does this provider
 * support web access?" without enumerating specific tool names.
 */

import { CapabilityFlag } from '../../capabilities.js';

export interface ToolAccess {
  readonly capability: typeof CapabilityFlag.ToolAccess;

  /** Tool kinds this provider can invoke. */
  supportedToolKinds(): ReadonlySet<ToolKind>;

  /**
   * List the specific tool names available. Names are provider-specific
   * (e.g., 'Read' on Claude, 'fs_read' on Codex) — callers comparing across
   * providers should use `supportedToolKinds` instead.
   */
  registeredTools(): ReadonlyArray<RegisteredTool>;
}

export type ToolKind =
  | 'file-read'
  | 'file-write'
  | 'file-edit'
  | 'bash'
  | 'web-fetch'
  | 'web-search'
  | 'mcp'
  | 'subagent-spawn'
  | 'task-delegation'
  | 'computer-use'
  | 'image-generation'
  | 'code-execution';

export interface RegisteredTool {
  /** Provider-specific name. */
  name: string;
  /** Abstract category. */
  kind: ToolKind;
  /** Whether the tool is enabled by default for new sessions. */
  enabledByDefault: boolean;
  /** Whether invocations require user approval per call. */
  requiresApproval: boolean;
}

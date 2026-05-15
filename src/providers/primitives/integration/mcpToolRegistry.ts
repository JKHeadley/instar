/**
 * McpToolRegistry — register Instar's MCP tools with the provider's host.
 *
 * Maps to:
 *   - Claude: writes to `~/.claude.json` (project or user scope), declares
 *     MCP server name, transport, and command
 *   - Codex: `[mcp_servers.<id>]` TOML tables in `~/.codex/config.toml`;
 *     requires both server name AND identity (command/url value) to match
 *     for security
 *
 * Asymmetric on the identity check: Codex requires identity match for an
 * MCP server to be enabled; Claude matches by name only. Including identity
 * never hurts portability — Claude silently ignores it.
 *
 * Used by Threadline's ThreadlineBootstrap to expose `threadline_send`,
 * `threadline_discover`, etc. as MCP tools that Claude/Codex can invoke.
 * Phase 3 refactor pulls the bootstrap code through this primitive.
 */

import type { CancellationOptions } from '../../types.js';
import { CapabilityFlag } from '../../capabilities.js';

export interface McpToolRegistry {
  readonly capability: typeof CapabilityFlag.McpToolRegistry;

  /** Register an MCP server with this provider's host. */
  register(
    spec: McpServerSpec,
    options?: McpRegistryOptions,
  ): Promise<void>;

  /** Unregister an MCP server by name. */
  unregister(
    name: string,
    options?: McpRegistryOptions,
  ): Promise<void>;

  /** List currently-registered MCP servers. */
  list(options?: CancellationOptions): Promise<ReadonlyArray<McpServerSpec>>;

  /** Check whether a specific server is registered. */
  isRegistered(
    name: string,
    options?: CancellationOptions,
  ): Promise<boolean>;
}

export type McpServerSpec =
  | {
      kind: 'stdio';
      /** Server name (matched on both providers). */
      name: string;
      /** Command to spawn the server. Codex matches this for identity. */
      command: string;
      args?: ReadonlyArray<string>;
      env?: Readonly<Record<string, string>>;
    }
  | {
      kind: 'http';
      name: string;
      /** URL endpoint. Codex matches this for identity. */
      url: string;
      headers?: Readonly<Record<string, string>>;
    };

export interface McpRegistryOptions extends CancellationOptions {
  /**
   * Scope to register in. Default: 'user' (~/.claude.json or ~/.codex/...).
   * 'project' writes to `.claude/settings.json` or `.codex/config.toml`
   * in the current project root.
   */
  scope?: 'user' | 'project';
}

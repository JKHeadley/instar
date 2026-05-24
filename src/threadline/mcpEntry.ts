/**
 * mcpEntry — shared resolver for an agent's Threadline MCP stdio entry point.
 *
 * Single source of truth for the `{command, args}` that launches
 * `mcp-stdio-entry.js` for a specific agent. Used by:
 *   - ThreadlineBootstrap (registers it into ~/.claude.json + ~/.codex/config.toml)
 *   - frameworkSessionLaunch / SessionManager (injects it per-spawn as a Codex
 *     `-c mcp_servers.threadline.*` override so each agent's codex session uses
 *     ITS OWN threadline MCP, not whichever agent last won the SHARED
 *     ~/.codex/config.toml — see CODEX-MULTIAGENT-THREADLINE-SPEC).
 *
 * Keeping one resolver guarantees the registered entry and the per-spawn
 * override never drift.
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ThreadlineMcpEntry {
  command: string;
  args: string[];
}

/**
 * Resolve the `{command, args}` to launch the Threadline MCP server for the
 * given agent. Prefers the project's installed instar package; falls back to
 * the running instar dist directory (npm-linked / shadow-install layouts).
 */
export function resolveThreadlineMcpEntry(
  projectDir: string,
  stateDir: string,
  agentName: string,
): ThreadlineMcpEntry {
  const absDir = path.resolve(projectDir);
  let mcpEntryPath = path.join(absDir, 'node_modules', 'instar', 'dist', 'threadline', 'mcp-stdio-entry.js');
  if (!fs.existsSync(mcpEntryPath)) {
    // Fall back to the running instar installation's dist directory.
    // __dirname here is the compiled dist/threadline directory, so the
    // sibling mcp-stdio-entry.js is the running install's entry point.
    mcpEntryPath = path.join(__dirname, 'mcp-stdio-entry.js');
  }
  return {
    command: 'node',
    args: [mcpEntryPath, '--state-dir', stateDir, '--agent-name', agentName],
  };
}

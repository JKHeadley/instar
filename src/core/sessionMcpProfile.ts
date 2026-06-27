/**
 * Per-session MCP profiles (lever 1 of dynamic-MCP-lifecycle) — pure resolution.
 *
 * Claude Code fixes a session's MCP server set AT LAUNCH (it reads the project's
 * `.mcp.json`, or an explicit `--mcp-config`). MCP servers are heavy and mostly
 * idle (a whole Chromium for Playwright, an Electron for some bridges) and were a
 * dominant share of the steady-state process footprint behind the 2026-06-26
 * resource-exhaustion panic. This lets a topic's interactive session launch with
 * ONLY the MCP servers it needs instead of the full `.mcp.json`, cutting the
 * baseline footprint.
 *
 * Pure + default-no-op: when the feature is off OR a topic has no explicit profile,
 * resolution returns `null` ⇒ the caller adds NO `--mcp-config` flag ⇒ Claude reads
 * the full `.mcp.json` exactly as today. A topic only loses a server by EXPLICIT
 * configuration, so absent any config the spawn is byte-for-byte unchanged.
 */

/** The `sessions.mcpProfiles` config shape (all optional; absence ⇒ no-op). */
export interface McpProfilesConfig {
  /** Master switch — DARK by default. Off ⇒ resolution always returns null. */
  enabled?: boolean;
  /**
   * Explicit per-topic allow-list of MCP server names (the keys in `.mcp.json`).
   * A topic listed here launches with ONLY those servers. A topic NOT listed gets
   * the full `.mcp.json` (default-keep-warm — including Playwright, used often).
   */
  topicServers?: Record<string, string[]>;
}

/**
 * Resolve which MCP servers a topic's session should launch with.
 * Returns `null` when the full `.mcp.json` should be used unchanged (the default):
 *   - the feature is disabled, OR
 *   - no explicit profile is configured for this topic.
 * Returns a (possibly empty) server-name array when the topic has an explicit
 * profile — the session launches with ONLY those servers.
 */
export function resolveMcpProfileServers(
  topicId: number | string | undefined,
  cfg: McpProfilesConfig | undefined,
): string[] | null {
  if (!cfg || cfg.enabled !== true) return null;
  if (topicId === undefined || topicId === null) return null;
  const key = String(topicId);
  const entry = cfg.topicServers?.[key];
  if (!Array.isArray(entry)) return null; // no explicit profile ⇒ full .mcp.json
  // De-dupe + drop blanks; an explicit [] means "no MCP servers for this topic".
  return [...new Set(entry.filter((s) => typeof s === 'string' && s.length > 0))];
}

/** The minimal `.mcp.json` shape we read/filter. */
export interface McpJson {
  mcpServers?: Record<string, unknown>;
  [k: string]: unknown;
}

/**
 * Filter a parsed `.mcp.json` down to the allowed server set, preserving every
 * other top-level field. Unknown server names in `allowed` are simply ignored
 * (they can't be launched). Pure — returns a new object, never mutates the input.
 */
export function filterMcpConfig(full: McpJson, allowed: string[]): McpJson {
  const allowSet = new Set(allowed);
  const srcServers = (full && typeof full === 'object' ? full.mcpServers : undefined) ?? {};
  const filtered: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(srcServers)) {
    if (allowSet.has(name)) filtered[name] = def;
  }
  return { ...full, mcpServers: filtered };
}

/**
 * Dynamic MCP config — the pure core of the on-demand MCP-server lifecycle.
 *
 * Claude Code fixes a session's MCP server set AT LAUNCH (it reads the project's
 * `.mcp.json`, or an explicit `--mcp-config`). MCP servers are heavy and mostly
 * idle (a whole Chromium for Playwright, an Electron bridge) and were a dominant
 * share of the steady-state process footprint behind the 2026-06-26 resource
 * panic. There is no hot-reload: changing a session's MCP set requires relaunching
 * it with a different `--mcp-config` (a `claude --resume` keeps the conversation).
 *
 * Justin's correction (2026-06-27): a topic's MCP needs are NOT knowable at launch
 * and must be changeable MID-SESSION (a restart is acceptable). So this is NOT a
 * static per-topic profile. It is a small, mechanical state model:
 *
 *   - resolveBaselineServers — the lean set a session LAUNCHES with (opt-in trim).
 *   - mutateLoadedServers     — load/offload one server from the running set
 *                               (the caller then rewrites the config + restarts).
 *
 * Policy lives OUTSIDE this module: WHEN to offload an idle server is decided by
 * `decideIdleLiveOffload` (mcpIdleLiveOffload.ts); WHAT to keep warm is config.
 * This module only computes the resulting server set, purely + deterministically,
 * so the decision boundaries are unit-testable in isolation. It NEVER spawns,
 * kills, or writes anything.
 *
 * Default-no-op + dark: with the feature off, `resolveBaselineServers` returns
 * `null` ⇒ the caller adds NO `--mcp-config` flag ⇒ Claude reads the full
 * `.mcp.json` exactly as today. A session only loses a server by EXPLICIT
 * configuration or an explicit offload request.
 */

/** The minimal `.mcp.json` shape we read/filter. */
export interface McpJson {
  mcpServers?: Record<string, unknown>;
  [k: string]: unknown;
}

/**
 * Filter a parsed `.mcp.json` down to the allowed server set, preserving every
 * other top-level field. Unknown names in `allowed` are ignored (they can't be
 * launched). Pure — returns a new object, never mutates the input.
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

/** The `dynamicMcp` config shape (all optional; absence ⇒ no-op). */
export interface DynamicMcpConfig {
  /** Master switch — DARK by default. Off ⇒ resolution returns null (full .mcp.json). */
  enabled?: boolean;
  /**
   * Server names launched at baseline (the lean warm set). When provided, a
   * session launches with ONLY the intersection of this list and the servers
   * that actually exist in `.mcp.json`. When OMITTED (but enabled), the baseline
   * is the FULL `.mcp.json` (no trim) — trimming is an explicit per-agent opt-in
   * for an agent that has additional heavy dynamic servers. Justin's default
   * intent: Playwright stays warm ("used often"); a heavy non-Playwright server
   * is dynamic. Light stdio bridges (threadline/instar) are cheap and stay.
   */
  keepWarm?: string[];
}

/**
 * Resolve which MCP servers a session should LAUNCH with, given the names that
 * exist in `.mcp.json`. Returns `null` when the full `.mcp.json` should be used
 * unchanged (the default): the feature is disabled. When enabled with no
 * `keepWarm`, also returns null (no trim — explicit opt-in only). When enabled
 * WITH `keepWarm`, returns the (de-duped) intersection with the real servers.
 */
export function resolveBaselineServers(
  allServerNames: string[],
  cfg: DynamicMcpConfig | undefined,
): string[] | null {
  if (!cfg || cfg.enabled !== true) return null;
  if (!Array.isArray(cfg.keepWarm)) return null; // enabled but no trim configured ⇒ full set
  const exists = new Set(allServerNames);
  const warm = cfg.keepWarm.filter((s) => typeof s === 'string' && s.length > 0 && exists.has(s));
  return [...new Set(warm)];
}

/** A single load/offload request against a session's currently-loaded server set. */
export interface McpMutateOp {
  kind: 'load' | 'offload';
  /** The `.mcp.json` server name to add or remove. */
  server: string;
}

export interface McpMutateResult {
  /** Whether the resulting set differs from `current` (⇒ a restart is warranted). */
  changed: boolean;
  /** The resulting server set (always a fresh, de-duped, sorted-stable array). */
  servers: string[];
  /** Machine-readable outcome for audit/tests. */
  reason:
    | 'loaded'
    | 'already-loaded'
    | 'unknown-server'
    | 'offloaded'
    | 'not-loaded';
}

/**
 * Apply ONE load/offload op to a session's currently-loaded server set.
 * Purely mechanical — POLICY (when to offload, what to keep warm) lives elsewhere.
 *   - load an UNKNOWN server (not in `.mcp.json`) → rejected (`unknown-server`,
 *     no change): you cannot launch a server that isn't defined.
 *   - load an ALREADY-loaded server → no-op (`already-loaded`).
 *   - load a known, absent server → added (`loaded`).
 *   - offload an absent server → no-op (`not-loaded`).
 *   - offload a present server → removed (`offloaded`).
 * Never mutates the input arrays.
 */
export function mutateLoadedServers(
  current: string[],
  allServerNames: string[],
  op: McpMutateOp,
): McpMutateResult {
  const set = new Set(current.filter((s) => typeof s === 'string' && s.length > 0));
  const known = new Set(allServerNames);
  const server = op.server;

  if (op.kind === 'load') {
    if (!known.has(server)) {
      return { changed: false, servers: [...set], reason: 'unknown-server' };
    }
    if (set.has(server)) {
      return { changed: false, servers: [...set], reason: 'already-loaded' };
    }
    set.add(server);
    return { changed: true, servers: [...set], reason: 'loaded' };
  }

  // offload
  if (!set.has(server)) {
    return { changed: false, servers: [...set], reason: 'not-loaded' };
  }
  set.delete(server);
  return { changed: true, servers: [...set], reason: 'offloaded' };
}

export const DEFAULT_DYNAMIC_MCP_CONFIG: DynamicMcpConfig = {
  enabled: false,
};

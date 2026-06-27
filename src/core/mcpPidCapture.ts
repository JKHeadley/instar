/**
 * mcpPidCapture — pure helper for the dynamic-MCP offload's capture-then-reap
 * (DYNAMIC-MCP-LIFECYCLE-SPEC, fold C1). Given the live MCP process list + the
 * process tree + the tmux pane map, it returns the heavy MCP child PIDs that
 * belong to a specific session AND a specific `.mcp.json` server — the orphans the
 * driver must reap after an offload restart (killing a session does NOT cascade to
 * its MCP children; they reparent to launchd and survive).
 *
 * Pure + conservative: an unknown / non-heavy server, or a proc whose owning
 * session can't be resolved to the target, contributes NO pid. The worst case is
 * "capture nothing" (a missed reclaim the generic reaper still backstops), never
 * "kill the wrong pid".
 */

import { resolveOwningSession, type McpProcessInfo } from '../monitoring/McpProcessReaper.js';
import { isHeavyMcpSignature } from '../monitoring/mcpIdleLiveOffload.js';
import type { McpProcessSignature } from '../monitoring/mcpProcessSignatures.js';

/**
 * Map a `.mcp.json` server NAME (what a load/offload request names) to the MCP
 * process SIGNATURE id (what the process scan matches). Conservative: an unmapped
 * server resolves to no signature ⇒ no pids captured. Extend as heavy servers are
 * added (e.g. an Electron bridge) alongside HEAVY_MCP_SIGNATURE_IDS.
 */
export const MCP_SERVER_NAME_TO_SIGNATURE: Readonly<Record<string, McpProcessSignature['id']>> = {
  playwright: 'playwright-mcp',
};

export interface CaptureHeavyPidsInput {
  /** The owning tmux session name the offload is restarting. */
  sessionName: string;
  /** The `.mcp.json` server name being offloaded. */
  server: string;
  /** The live MCP process scan. */
  procs: McpProcessInfo[];
  /** pid → ppid map (ancestor resolution). */
  tree: Map<number, number>;
  /** tmux pane pid → session name. */
  paneMap: Map<number, string>;
  /** Max ppid hops when resolving a proc's owning session. */
  maxHops: number;
}

/**
 * The heavy MCP child PIDs for (sessionName, server) — the offload-orphan capture.
 * Returns [] when: the server has no known heavy signature, or no matching proc
 * resolves to the target session.
 */
export function captureHeavyMcpPidsForSession(input: CaptureHeavyPidsInput): number[] {
  const sig = MCP_SERVER_NAME_TO_SIGNATURE[input.server];
  if (!sig || !isHeavyMcpSignature(sig)) return []; // unknown / not-heavy ⇒ nothing to capture
  const pids: number[] = [];
  for (const p of input.procs) {
    if (p.signatureId !== sig) continue;
    if (resolveOwningSession(p.pid, input.tree, input.paneMap, input.maxHops) === input.sessionName) {
      pids.push(p.pid);
    }
  }
  return pids;
}

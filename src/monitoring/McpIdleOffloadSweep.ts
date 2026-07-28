/**
 * McpIdleOffloadSweep — the automatic "offload a heavy MCP server once it's been
 * idle a while" trigger for the dynamic-MCP lifecycle (DYNAMIC-MCP-LIFECYCLE-SPEC).
 * The explicit `POST /mcp/offload` already covers "offload when the work is done";
 * this covers the IDLE case automatically.
 *
 * Per tick it enumerates the heavy MCP processes under LIVE sessions, maps each to
 * a (topicId, `.mcp.json` server), maintains a per-proc continuous-idle clock, and
 * asks `decideIdleLiveOffload` whether it's eligible — then requests an offload via
 * the same authorization-gated driver an explicit request uses (so an idle-offload
 * on a non-preapproved interactive session surfaces an ASK, never a silent restart).
 *
 * All IO is INJECTED so the stateful orchestration is unit-testable. Ships dark +
 * dryRun-first: when dryRun, it only LOGS the intended offload. Every predicate
 * fails CLOSED (a null/unknown mid-tool-use keeps the server — `decideIdleLiveOffload`
 * enforces that).
 */

import { decideIdleLiveOffload, type IdleLiveOffloadConfig } from './mcpIdleLiveOffload.js';
import type { McpProcessSignature } from './mcpProcessSignatures.js';

export interface HeavyLiveMcpProc {
  pid: number;
  signatureId: McpProcessSignature['id'];
  /** The owning tmux session name (resolved via the ppid-walk). */
  sessionName: string;
}

export interface McpIdleOffloadSweepDeps {
  /** Heavy MCP procs under live/tracked sessions (the scan + ownership resolution). */
  listHeavyLiveMcpProcs: () => HeavyLiveMcpProc[];
  /** Owning session name → topic id (null if not a topic-bound session). */
  sessionToTopic: (sessionName: string) => number | null;
  /** signatureId → `.mcp.json` server name (null if unmapped). */
  signatureToServer: (signatureId: McpProcessSignature['id']) => string | null;
  /** Is the owning session mid-tool-use? true / false / null(unknown ⇒ keep). */
  isMidToolUse: (sessionName: string) => boolean | null;
  /** Is this server pinned keep-warm (never auto-offload)? */
  isKeepWarm: (server: string) => boolean;
  /** Request an offload through the authorization-gated driver. */
  requestOffload: (topicId: number, server: string) => Promise<unknown>;
  now: () => number;
  log?: (msg: string) => void;
}

export interface McpIdleOffloadSweepConfig extends IdleLiveOffloadConfig {
  /** When true, LOG the intended offload but do not request it. */
  dryRun: boolean;
}

interface IdleClockEntry {
  continuousIdleMs: number;
  lastTickAt: number;
}

export class McpIdleOffloadSweep {
  /** key = `${sessionName}|${pid}` → idle clock. */
  private readonly clocks = new Map<string, IdleClockEntry>();

  constructor(
    private readonly deps: McpIdleOffloadSweepDeps,
    private readonly cfg: McpIdleOffloadSweepConfig,
  ) {}

  /** Run one sweep. Returns the offload actions taken/simulated (for tests/status). */
  async tick(): Promise<Array<{ topicId: number; server: string; dryRun: boolean }>> {
    if (!this.cfg.enabled) { this.clocks.clear(); return []; }
    const now = this.deps.now();
    const procs = this.deps.listHeavyLiveMcpProcs();
    const seen = new Set<string>();
    const actions: Array<{ topicId: number; server: string; dryRun: boolean }> = [];

    for (const proc of procs) {
      const key = `${proc.sessionName}|${proc.pid}`;
      seen.add(key);
      const mid = this.deps.isMidToolUse(proc.sessionName);
      // Advance or reset the per-proc idle clock. Only a definite not-mid-tool-use
      // accrues idle time; true OR unknown(null) resets (fail-closed — never let an
      // ambiguous frame quietly age toward an offload).
      const prev = this.clocks.get(key);
      const elapsed = prev ? Math.max(0, now - prev.lastTickAt) : 0;
      const continuousIdleMs = mid === false ? (prev?.continuousIdleMs ?? 0) + elapsed : 0;
      this.clocks.set(key, { continuousIdleMs, lastTickAt: now });

      const server = this.deps.signatureToServer(proc.signatureId);
      if (!server) continue; // can't name the server ⇒ can't offload it
      const decision = decideIdleLiveOffload(
        {
          signatureId: proc.signatureId,
          ownerLive: true, // by construction (listHeavyLiveMcpProcs is live-only)
          midToolUse: mid,
          continuousIdleMs,
          keepWarm: this.deps.isKeepWarm(server),
        },
        this.cfg,
      );
      if (!decision.eligible) continue;

      const topicId = this.deps.sessionToTopic(proc.sessionName);
      if (topicId == null) continue; // not a topic-bound session ⇒ skip

      if (this.cfg.dryRun) {
        this.deps.log?.(`[mcp-idle-offload] would offload "${server}" on topic ${topicId} (idle ${Math.round(continuousIdleMs / 1000)}s)`);
        actions.push({ topicId, server, dryRun: true });
        // Reset the clock so a dry-run doesn't re-log every tick forever.
        this.clocks.set(key, { continuousIdleMs: 0, lastTickAt: now });
        continue;
      }
      try {
        await this.deps.requestOffload(topicId, server);
        actions.push({ topicId, server, dryRun: false });
      } catch { /* the driver surfaces its own outcome; a throw never breaks the sweep */ }
      // Reset after acting so the next eligibility starts a fresh idle window.
      this.clocks.set(key, { continuousIdleMs: 0, lastTickAt: now });
    }

    // Drop clocks for procs that vanished (offloaded/died) so the Map can't grow.
    for (const key of [...this.clocks.keys()]) {
      if (!seen.has(key)) this.clocks.delete(key);
    }
    return actions;
  }

  /** Outstanding idle-clock count (status/tests). */
  trackedCount(): number { return this.clocks.size; }
}

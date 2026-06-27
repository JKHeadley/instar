/**
 * DynamicMcpService — the composition root for the dynamic MCP lifecycle
 * (DYNAMIC-MCP-LIFECYCLE-SPEC). It assembles the DynamicMcpManager, the loaded-set
 * state store, and the approval-nonce store, wiring them to the host's real
 * primitives (restart, preapproval, pid capture/reap, mid-tool-use probe) which
 * are INJECTED so the whole thing is unit-testable without a live server.
 *
 * The three route handlers (`GET /mcp/session/:topicId`, `POST /mcp/load`,
 * `POST /mcp/offload`) are thin wrappers over `getSessionState` / `requestLoad` /
 * `requestOffload`. AgentServer builds this with the real primitives and gates the
 * routes on `enabled()`.
 */

import path from 'node:path';
import fs from 'node:fs';
import { DynamicMcpManager, type DynamicMcpDeps, type RequestActor, type RequestChangeResult } from './DynamicMcpManager.js';
import { McpLoadedSetStore } from './McpLoadedSetStore.js';
import { McpApprovalNonceStore } from './McpApprovalNonceStore.js';
import { resolveBaselineServers, type DynamicMcpConfig, type McpJson } from './dynamicMcpConfig.js';

export interface DynamicMcpServicePrimitives {
  /** `<projectDir>` (for `.mcp.json`) and where `.instar/state/mcp-loaded` lives. */
  projectDir: string;
  /** Live feature switch (dev-gate or explicit flag), evaluated per call. */
  enabled: () => boolean;
  /** The dynamicMcp config block (for the baseline `keepWarm`). */
  config: () => DynamicMcpConfig | undefined;
  /** Restart the topic's session `--resume`; ok:false carries a failure code. */
  restart: (topicId: number) => Promise<{ ok: boolean; code?: string }>;
  /** Live preapproval (active autonomous run / standing grant), fail-CLOSED. */
  isPreapproved: (topicId: number) => boolean;
  /** Capture heavy MCP child pids for an offload (before the kill). */
  captureHeavyPids: (topicId: number, server: string) => number[];
  /** Reap captured orphan pids after a confirmed restart. */
  reapPids: (pids: number[]) => void;
  /** Mid-tool-use probe: true / false / null(unknown ⇒ offload aborts). */
  isMidToolUse: (topicId: number) => boolean | null;
  /** Optional audit sink. */
  audit?: (entry: Record<string, unknown>) => void;
}

export interface SessionMcpState {
  topicId: number;
  servers: string[];
  preapproved: boolean;
  source: 'committed' | 'baseline' | 'full';
}

export class DynamicMcpService {
  private readonly loadedSet: McpLoadedSetStore;
  private readonly nonces = new McpApprovalNonceStore();
  private readonly manager: DynamicMcpManager;

  constructor(private readonly p: DynamicMcpServicePrimitives) {
    this.loadedSet = new McpLoadedSetStore(path.join(p.projectDir, '.instar', 'state', 'mcp-loaded'));
    const deps: DynamicMcpDeps = {
      currentServers: (t) => this.currentServers(t).servers,
      allServerNames: () => this.mcpServerNames(),
      writeLoadedSet: (t, servers, committed, reason) => this.loadedSet.write(t, servers, committed, reason),
      isPreapproved: (t) => p.isPreapproved(t),
      mintNonce: (t, kind, server) => this.nonces.mint(t, kind, server),
      consumeNonce: (t, kind, server, nonce) => this.nonces.consume(t, kind, server, nonce),
      captureHeavyPids: (t, server) => p.captureHeavyPids(t, server),
      reapPids: (pids) => p.reapPids(pids),
      isMidToolUse: (t) => p.isMidToolUse(t),
      restartSession: (t) => p.restart(t),
      audit: p.audit,
    };
    this.manager = new DynamicMcpManager(deps);
  }

  enabled(): boolean { return this.p.enabled(); }

  /** Read `.mcp.json` server names ([] on absent/unreadable). */
  private mcpServerNames(): string[] {
    try {
      const full = JSON.parse(fs.readFileSync(path.join(this.p.projectDir, '.mcp.json'), 'utf-8')) as McpJson;
      return Object.keys((full && typeof full === 'object' ? full.mcpServers : undefined) ?? {});
    } catch { return []; }
  }

  /** The set the session is currently running with + its provenance. */
  private currentServers(topicId: number): { servers: string[]; source: 'committed' | 'baseline' | 'full' } {
    const committed = this.loadedSet.readCommitted(topicId);
    if (committed !== null) return { servers: committed, source: 'committed' };
    const names = this.mcpServerNames();
    const baseline = resolveBaselineServers(names, this.p.config());
    if (baseline !== null) return { servers: baseline, source: 'baseline' };
    return { servers: names, source: 'full' };
  }

  /** Registry-first read for `GET /mcp/session/:topicId`. */
  getSessionState(topicId: number): SessionMcpState {
    const cur = this.currentServers(topicId);
    return { topicId, servers: cur.servers, preapproved: this.p.isPreapproved(topicId), source: cur.source };
  }

  requestLoad(topicId: number, server: string, actor: RequestActor): Promise<RequestChangeResult> {
    return this.manager.requestChange({ topicId, op: 'load', server, actor });
  }

  requestOffload(topicId: number, server: string, actor: RequestActor): Promise<RequestChangeResult> {
    return this.manager.requestChange({ topicId, op: 'offload', server, actor });
  }
}

/**
 * McpProcessReaper — Option B of the MCP-leak fix (Codey's design in
 * `.instar/apprenticeship/codey-task-mcp-leak-reaper.md`).
 *
 * The problem: a session spawns MCP-server children (Playwright, mcp-remote,
 * instar stdio). Killing the session's main pid does NOT cascade to those
 * children — they re-parent (to PID 1 / launchd) or are held by an npm-exec
 * wrapper and survive for days. The fleet accumulated ~80 such leaked procs,
 * up to 5 days old, as a persistent load floor. `OrphanProcessReaper` reaps the
 * session-level CLI proc but not these MCP *descendants*.
 *
 * This is a descendant-aware SWEEP (a sibling reaper, NOT a change to the
 * shared OrphanProcessReaper / ReapGuard path — zero blast radius on the
 * working reaper). For each allow-listed MCP proc it resolves the owning tmux
 * session by walking the ppid chain, and reaps ONLY when the proc is old AND
 * its owning session is a dead/stale *instar* session or fully orphaned. It
 * NEVER touches a proc under a live/tracked session, nor under an external
 * (non-instar) tmux session.
 *
 * Ships DARK + DRY-RUN by default (kills processes — same posture as
 * SessionReaper / AgentWorktreeReaper). Every decision is audited.
 */

import { EventEmitter } from 'node:events';
import { matchMcpSignature, type McpProcessSignature } from './mcpProcessSignatures.js';

export interface McpProcessReaperConfig {
  enabled: boolean;
  dryRun: boolean;
  /** A proc younger than this is always kept (a starting session's children). */
  minAgeMs: number;
  reapIntervalMs: number;
  /** Bounded blast radius per pass. */
  maxReapsPerPass: number;
  /** Max ppid hops when resolving a proc's owning tmux session. */
  maxAncestorHops: number;
}

export const DEFAULT_MCP_PROCESS_REAPER_CONFIG: McpProcessReaperConfig = {
  enabled: false,
  dryRun: true,
  // Conservative: the leaked procs are hours-to-days old; 2h floor means a
  // legitimately busy short-lived MCP child is never a candidate.
  minAgeMs: 2 * 3600 * 1000,
  reapIntervalMs: 30 * 60 * 1000,
  maxReapsPerPass: 25,
  maxAncestorHops: 30,
};

export interface McpProcessInfo {
  pid: number;
  ppid: number;
  elapsedMs: number;
  command: string;
  signatureId: McpProcessSignature['id'];
}

export type McpVerdict = 'keep' | 'reap-eligible';

export interface McpEvaluation {
  pid: number;
  signatureId: McpProcessSignature['id'];
  ageMs: number;
  owningSession: string | null;
  verdict: McpVerdict;
  /** The gate that forced KEEP, or the reap rationale. */
  reason: string;
}

/**
 * All signal sources injected so the classifier is unit-testable without a
 * real process table, tmux, or kill(2). Production wiring supplies ps/tmux/
 * SessionManager-backed implementations.
 */
export interface McpProcessReaperDeps {
  /** Allow-listed MCP-server processes currently running (this uid). */
  listMcpProcesses: () => McpProcessInfo[];
  /** Full pid → ppid map of the process table (for ancestor resolution). */
  getProcessTree: () => Map<number, number>;
  /** tmux pane pid → session name. */
  getTmuxPaneMap: () => Map<number, string>;
  /** tmux session names that are genuinely live/tracked. SACRED — never reaped. */
  getLiveSessions: () => Set<string>;
  /** All instar-pattern tmux session names present (tracked or not). Used to
   *  tell a dead/stale *instar* session (reapable) from an external one (kept). */
  getInstarSessions: () => Set<string>;
  /** SIGTERM the proc. Only called when killsEnabled. */
  killProcess: (pid: number) => void;
  /** Append one audit entry (JSONL). Never throws into the reap loop. */
  audit?: (entry: McpReapAuditEntry) => void;
  now?: () => number;
}

export interface McpReapAuditEntry {
  ts: number;
  type: 'reaped' | 'would-reap' | 'kept';
  pid: number;
  signatureId: string;
  ageMs: number;
  owningSession: string | null;
  reason: string;
  dryRun: boolean;
}

/**
 * Walk the ppid chain from `startPid` until a pid is a tmux pane pid. Returns
 * the owning tmux session name, or null when no tmux ancestor is found within
 * `maxHops` (i.e. the proc is orphaned / re-parented — its session is dead).
 * Pure — cycle-safe via a visited set.
 */
export function resolveOwningSession(
  startPid: number,
  tree: Map<number, number>,
  tmuxPaneMap: Map<number, string>,
  maxHops: number,
): string | null {
  let pid: number | undefined = startPid;
  const seen = new Set<number>();
  for (let hop = 0; hop <= maxHops && pid !== undefined && pid > 1; hop++) {
    if (seen.has(pid)) break; // cycle guard
    seen.add(pid);
    const session = tmuxPaneMap.get(pid);
    if (session) return session;
    pid = tree.get(pid);
  }
  return null;
}

/**
 * Pure per-proc classifier. KEEP unless the proc is old AND its owning session
 * is a dead/stale instar session or fully orphaned. Order matters: the sacred
 * gates (live session, external session) short-circuit before age is consulted.
 */
export function classifyMcpProcess(
  proc: McpProcessInfo,
  owningSession: string | null,
  liveSessions: Set<string>,
  instarSessions: Set<string>,
  minAgeMs: number,
): McpEvaluation {
  const base = {
    pid: proc.pid,
    signatureId: proc.signatureId,
    ageMs: proc.elapsedMs,
    owningSession,
  };
  const keep = (reason: string): McpEvaluation => ({ ...base, verdict: 'keep', reason });
  const reap = (reason: string): McpEvaluation => ({ ...base, verdict: 'reap-eligible', reason });

  if (owningSession !== null) {
    // SACRED: a live/tracked session owns it — keep regardless of age. A long-
    // running autonomous session legitimately owns old MCP servers.
    if (liveSessions.has(owningSession)) return keep('session-live');
    // An external (non-instar) tmux session — never touch the user's processes.
    if (!instarSessions.has(owningSession)) return keep('external-session');
    // A stale/dead *instar* session still lingering in tmux: reapable when old.
    if (proc.elapsedMs < minAgeMs) return keep('stale-instar-too-young');
    return reap(`stale-instar-session:${owningSession}`);
  }

  // No tmux ancestor — the owning session is dead and this proc re-parented.
  // This is the dominant leak shape. Reapable only when old.
  if (proc.elapsedMs < minAgeMs) return keep('orphan-too-young');
  return reap('orphaned-no-session');
}

export class McpProcessReaper extends EventEmitter {
  private readonly cfg: McpProcessReaperConfig;
  private readonly deps: McpProcessReaperDeps;
  private readonly now: () => number;
  private timer?: NodeJS.Timeout;
  private running = false;
  private lastPassAt = 0;
  private reapedLastPass = 0;

  constructor(deps: McpProcessReaperDeps, cfg?: Partial<McpProcessReaperConfig>) {
    super();
    this.deps = deps;
    this.cfg = { ...DEFAULT_MCP_PROCESS_REAPER_CONFIG, ...(cfg ?? {}) };
    this.now = deps.now ?? (() => Date.now());
  }

  start(): void {
    if (this.timer || !this.cfg.enabled) return;
    this.timer = setInterval(() => { void this.reap(); }, this.cfg.reapIntervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }

  private get killsEnabled(): boolean {
    return this.cfg.enabled && !this.cfg.dryRun;
  }

  /** Resolve + classify one proc against the current process/tmux/session view. */
  private evaluate(
    proc: McpProcessInfo,
    tree: Map<number, number>,
    tmuxPaneMap: Map<number, string>,
    liveSessions: Set<string>,
    instarSessions: Set<string>,
  ): McpEvaluation {
    const owningSession = resolveOwningSession(proc.pid, tree, tmuxPaneMap, this.cfg.maxAncestorHops);
    return classifyMcpProcess(proc, owningSession, liveSessions, instarSessions, this.cfg.minAgeMs);
  }

  /** One reap pass. Returns the per-proc evaluations + what was reaped. */
  async reap(): Promise<{ ts: number; evaluations: McpEvaluation[]; reaped: number[]; dryRun: boolean }> {
    if (this.running) return { ts: this.now(), evaluations: [], reaped: [], dryRun: !this.killsEnabled };
    this.running = true;
    const reaped: number[] = [];
    const evaluations: McpEvaluation[] = [];
    try {
      let procs: McpProcessInfo[];
      let tree: Map<number, number>;
      let tmuxPaneMap: Map<number, string>;
      let liveSessions: Set<string>;
      let instarSessions: Set<string>;
      try {
        procs = this.deps.listMcpProcesses();
        tree = this.deps.getProcessTree();
        tmuxPaneMap = this.deps.getTmuxPaneMap();
        liveSessions = this.deps.getLiveSessions();
        instarSessions = this.deps.getInstarSessions();
      } catch (err) {
        this.emit('error', err);
        return { ts: this.now(), evaluations: [], reaped: [], dryRun: !this.killsEnabled };
      }

      for (const proc of procs) {
        let evaln: McpEvaluation;
        try {
          evaln = this.evaluate(proc, tree, tmuxPaneMap, liveSessions, instarSessions);
        } catch {
          // A signal threw — cannot reason about it, so KEEP. Never reap on a
          // failed evaluation.
          evaln = {
            pid: proc.pid, signatureId: proc.signatureId, ageMs: proc.elapsedMs,
            owningSession: null, verdict: 'keep', reason: 'eval-error',
          };
        }
        evaluations.push(evaln);

        if (evaln.verdict !== 'reap-eligible') {
          this.writeAudit({ ts: this.now(), type: 'kept', pid: proc.pid, signatureId: proc.signatureId, ageMs: proc.elapsedMs, owningSession: evaln.owningSession, reason: evaln.reason, dryRun: !this.killsEnabled });
          continue;
        }
        if (reaped.length >= this.cfg.maxReapsPerPass) continue; // blast-radius cap

        if (!this.killsEnabled) {
          // Dry-run: classify + audit what we WOULD kill, kill nothing.
          this.writeAudit({ ts: this.now(), type: 'would-reap', pid: proc.pid, signatureId: proc.signatureId, ageMs: proc.elapsedMs, owningSession: evaln.owningSession, reason: evaln.reason, dryRun: true });
          continue;
        }
        try {
          this.deps.killProcess(proc.pid);
          reaped.push(proc.pid);
          this.writeAudit({ ts: this.now(), type: 'reaped', pid: proc.pid, signatureId: proc.signatureId, ageMs: proc.elapsedMs, owningSession: evaln.owningSession, reason: evaln.reason, dryRun: false });
          this.emit('reaped', proc);
        } catch (err) {
          this.emit('error', err);
        }
      }
      this.lastPassAt = this.now();
      this.reapedLastPass = reaped.length;
      this.emit('pass', { evaluations, reaped });
    } finally {
      this.running = false;
    }
    return { ts: this.now(), evaluations, reaped, dryRun: !this.killsEnabled };
  }

  private writeAudit(entry: McpReapAuditEntry): void {
    try { this.deps.audit?.(entry); } catch { /* audit must never break the loop */ }
  }

  /** Observability snapshot for GET /processes/mcp-reaper (no side effects). */
  snapshot(): {
    enabled: boolean; dryRun: boolean; minAgeMs: number;
    lastPassAt: number; reapedLastPass: number;
    processes: McpEvaluation[];
    reapEligible: number;
  } {
    let processes: McpEvaluation[] = [];
    try {
      const procs = this.deps.listMcpProcesses();
      const tree = this.deps.getProcessTree();
      const tmuxPaneMap = this.deps.getTmuxPaneMap();
      const liveSessions = this.deps.getLiveSessions();
      const instarSessions = this.deps.getInstarSessions();
      processes = procs.map((proc) => {
        try { return this.evaluate(proc, tree, tmuxPaneMap, liveSessions, instarSessions); }
        catch {
          return { pid: proc.pid, signatureId: proc.signatureId, ageMs: proc.elapsedMs, owningSession: null, verdict: 'keep' as McpVerdict, reason: 'eval-error' };
        }
      });
    } catch { /* listing failed — report empty, never crash the route */ }
    return {
      enabled: this.cfg.enabled,
      dryRun: this.cfg.dryRun,
      minAgeMs: this.cfg.minAgeMs,
      lastPassAt: this.lastPassAt,
      reapedLastPass: this.reapedLastPass,
      processes,
      reapEligible: processes.filter((p) => p.verdict === 'reap-eligible').length,
    };
  }
}

/** Re-export for production wiring that builds McpProcessInfo from a ps line. */
export { matchMcpSignature };

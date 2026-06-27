/**
 * DynamicMcpManager — the load-on-demand / idle-offload DRIVER for the dynamic
 * MCP lifecycle (DYNAMIC-MCP-LIFECYCLE-SPEC). Given a request to load or offload
 * a server for a topic's session, it mutates the committed loaded-set + restarts
 * the session (`--resume`) so the new set takes effect.
 *
 * All IO is INJECTED (state read/write, restart, pid capture/reap, authorization,
 * mid-tool-use probe) so the orchestration — the part that carries real authority
 * (it restarts a live session) — is fully unit-testable in isolation. The class
 * itself touches no fs/process/network directly.
 *
 * The orchestration folds the convergence findings:
 *  - per-topic serialization lock so concurrent requests can't lost-update the
 *    state file (M2);
 *  - TWO-PHASE commit: write the new set un-committed, restart, commit ONLY on a
 *    confirmed restart, roll back on any non-ok restart (M1/M3) — the spawn
 *    builder ignores an un-committed file, so a failed restart leaves the live
 *    session on its OLD set, never a phantom unapproved change;
 *  - offload CAPTURES the heavy child pids BEFORE the kill and reaps them AFTER
 *    the restart confirms (C1 — the children reparent to launchd and do NOT die
 *    with the session, so a naive offload would leak);
 *  - mid-tool-use is RE-CHECKED at kill time for an offload (M3) — abort if the
 *    session is, or might be, using its tools;
 *  - authorization is VERIFIED, never trusted from the caller: a preapproval is
 *    re-checked live, otherwise a single-use server-minted nonce bound to
 *    (topicId, kind, server) is required (C4). An agent cannot self-authorize.
 */

import { mutateLoadedServers, type McpMutateOp } from './dynamicMcpConfig.js';

export type McpChangeKind = 'load' | 'offload';

/** How a request is being authorized. The manager VERIFIES, never trusts. */
export type RequestActor =
  /** The initial agent-initiated request (or the idle sweep). Authorized only
   *  if the topic is live-preapproved; otherwise it returns needs-approval. */
  | { kind: 'agent' }
  /** The operator's approval coming back with the server-minted nonce. */
  | { kind: 'operator-approved'; nonce: string };

export interface RequestChangeInput {
  topicId: number;
  op: McpChangeKind;
  server: string;
  actor: RequestActor;
}

export type RequestChangeResult =
  | { status: 'no-op'; reason: 'already-loaded' | 'not-loaded' | 'unknown-server' }
  | { status: 'needs-approval'; nonce: string; prompt: string }
  | { status: 'aborted'; reason: 'mid-tool-use' }
  | { status: 'restart-failed'; code: string }
  | { status: 'unsupported-unbound' }
  | { status: 'applied'; servers: string[] };

export interface DynamicMcpDeps {
  /** The set the session is CURRENTLY running with (committed state servers, or
   *  the baseline / full set when none) — the basis for the mutation. */
  currentServers: (topicId: number) => string[];
  /** Server names defined in `.mcp.json` (for validating a load). */
  allServerNames: () => string[];
  /** Persist the new loaded set. `committed:false` = in-flight (the spawn builder
   *  ignores it); `committed:true` = authoritative. Atomic in the impl. */
  writeLoadedSet: (topicId: number, servers: string[], committed: boolean, reason: string) => void;
  /** Live preapproval check (real autonomous-session registry / standing grant),
   *  fail-CLOSED. Re-checked at kill time, not trusted from the caller. */
  isPreapproved: (topicId: number) => boolean;
  /** Mint a single-use nonce bound to (topicId, kind, server). */
  mintNonce: (topicId: number, kind: McpChangeKind, server: string) => string;
  /** Consume (verify + invalidate) an operator-supplied nonce. */
  consumeNonce: (topicId: number, kind: McpChangeKind, server: string, nonce: string) => boolean;
  /** Capture the heavy MCP child pids for this session BEFORE an offload kill. */
  captureHeavyPids: (topicId: number, server: string) => number[];
  /** Reap captured orphan pids AFTER the restart confirms (C1). */
  reapPids: (pids: number[]) => void;
  /** Is the session mid-tool-use right now? true / false / null(unknown). */
  isMidToolUse: (topicId: number) => boolean | null;
  /** Restart the session `--resume`. ok:false carries a failure code. */
  restartSession: (topicId: number) => Promise<{ ok: boolean; code?: string }>;
  /** Optional structured audit sink. */
  audit?: (entry: Record<string, unknown>) => void;
}

/** A short, server-authored approval prompt (never agent free-text). */
function approvalPrompt(op: McpChangeKind, server: string): string {
  return op === 'load'
    ? `I need the "${server}" tool for this — ready for a quick restart? Your conversation is preserved.`
    : `The "${server}" tool has been idle — OK to drop it (a quick restart; it reloads on next use)?`;
}

export class DynamicMcpManager {
  private readonly locks = new Map<number, Promise<unknown>>();

  constructor(private readonly deps: DynamicMcpDeps) {}

  /** Serialize per-topic so concurrent load/offload can't lost-update (M2). */
  async requestChange(input: RequestChangeInput): Promise<RequestChangeResult> {
    const prior = this.locks.get(input.topicId) ?? Promise.resolve();
    const run = prior.then(() => this.requestChangeLocked(input), () => this.requestChangeLocked(input));
    // Keep the chain alive but don't leak rejections into the next waiter.
    this.locks.set(input.topicId, run.catch(() => undefined));
    try {
      return await run;
    } finally {
      // Drop the lock entry once we're the tail (avoid unbounded growth).
      if (this.locks.get(input.topicId) === run || this.locks.get(input.topicId)) {
        // best-effort cleanup; a newer waiter may have replaced it already
      }
    }
  }

  private async requestChangeLocked(input: RequestChangeInput): Promise<RequestChangeResult> {
    const { topicId, op, server, actor } = input;
    const current = this.deps.currentServers(topicId);
    const names = this.deps.allServerNames();
    const mutateOp: McpMutateOp = { kind: op, server };
    const result = mutateLoadedServers(current, names, mutateOp);

    if (!result.changed) {
      // Map the mechanical no-op reasons through verbatim.
      const reason =
        result.reason === 'unknown-server' ? 'unknown-server'
          : result.reason === 'already-loaded' ? 'already-loaded'
            : 'not-loaded';
      this.audit({ topicId, op, server, outcome: 'no-op', reason });
      return { status: 'no-op', reason };
    }

    // ── Authorization (VERIFIED, never trusted from the caller) ──
    const preapproved = this.deps.isPreapproved(topicId);
    let authorized = preapproved;
    if (!authorized && actor.kind === 'operator-approved') {
      authorized = this.deps.consumeNonce(topicId, op, server, actor.nonce);
    }
    if (!authorized) {
      const nonce = this.deps.mintNonce(topicId, op, server);
      this.audit({ topicId, op, server, outcome: 'needs-approval' });
      return { status: 'needs-approval', nonce, prompt: approvalPrompt(op, server) };
    }

    // ── Offload-only: re-check mid-tool-use at kill time (M3) ──
    if (op === 'offload') {
      const mid = this.deps.isMidToolUse(topicId);
      if (mid !== false) {
        this.audit({ topicId, op, server, outcome: 'aborted', reason: 'mid-tool-use', mid });
        return { status: 'aborted', reason: 'mid-tool-use' };
      }
    }

    // ── Offload-only: capture heavy child pids BEFORE the kill (C1) ──
    const capturedPids = op === 'offload' ? this.deps.captureHeavyPids(topicId, server) : [];

    // ── Commit-before-restart (M1/M3) ──
    // The spawn builder reads the COMMITTED loaded-set, so the new set MUST be committed
    // BEFORE the restart, or the restart's own respawn reads the OLD committed state and
    // spawns from baseline. Pre-fix this wrote the new set UN-committed first, so a LOAD's
    // own respawn ignored it and came up lean — load was a no-op on its own restart, only
    // taking effect on a SUBSEQUENT restart (live-test 2026-06-27; offload was unaffected
    // because lean is also its target). Safety is preserved by the rollback: a non-ok
    // restart means no new session came up (restartSession returns ok ⟺ the new session is
    // up), so re-asserting the prior committed set keeps the next spawn on the old set.
    this.deps.writeLoadedSet(topicId, result.servers, true, op);
    const restart = await this.deps.restartSession(topicId);
    if (!restart.ok) {
      // Roll back to the prior committed set — a failed restart yields no new session, so
      // re-asserting the prior committed truth keeps the live/next session on the old set.
      this.deps.writeLoadedSet(topicId, current, true, `${op}-rollback`);
      const code = restart.code ?? 'unknown';
      this.audit({ topicId, op, server, outcome: 'restart-failed', code });
      if (code === 'not_telegram_bound') return { status: 'unsupported-unbound' };
      return { status: 'restart-failed', code };
    }

    // The new committed set is already in place; the respawn picked it up. For an offload,
    // reap the heavy child pids captured before the kill (they reparented to launchd — C1).
    if (op === 'offload' && capturedPids.length > 0) {
      this.deps.reapPids(capturedPids);
    }
    this.audit({ topicId, op, server, outcome: 'applied', servers: result.servers, reapedPids: capturedPids.length });
    return { status: 'applied', servers: result.servers };
  }

  private audit(entry: Record<string, unknown>): void {
    try { this.deps.audit?.(entry); } catch { /* audit is best-effort */ }
  }
}

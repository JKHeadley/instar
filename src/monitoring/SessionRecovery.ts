/**
 * SessionRecovery — Mechanical session crash/stall recovery via JSONL analysis.
 *
 * A fast, deterministic layer that runs BEFORE the LLM-powered TriageOrchestrator.
 * Detects three failure modes without any LLM calls:
 * 1. Tool call stalls (process alive but frozen mid-tool)
 * 2. Crashes (process dead with incomplete JSONL)
 * 3. Error loops (same error repeated 3+ times)
 *
 * Recovery strategy: truncate JSONL to safe point + respawn with recovery prompt.
 * Escalation ladder: last_exchange → last_successful_tool → n_exchanges_back → alert human.
 *
 * Self-contained — no Dawn dependencies. Uses only:
 * - stall-detector.ts (pure function)
 * - crash-detector.ts (pure function)
 * - jsonl-truncator.ts (pure function)
 *
 * Part of PROP-session-stall-recovery (Instar integration)
 */

import { EventEmitter } from 'events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';

import { detectToolCallStall, type StallInfo } from './stall-detector.js';
import { detectCrashedSession, detectErrorLoop, type CrashInfo, type ErrorLoopInfo } from './crash-detector.js';
import { truncateJsonlToSafePoint, type TruncationStrategy } from './jsonl-truncator.js';
import { detectContextExhaustion } from './QuotaExhaustionDetector.js';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';

// ============================================================================
// Types
// ============================================================================

export interface SessionRecoveryConfig {
  enabled: boolean;
  /** Max recovery attempts per session before alerting human */
  maxAttempts: number;
  /** Cooldown between recovery attempts (ms) */
  cooldownMs: number;
  /** Project directory (used to find JSONL files) */
  projectDir: string;
}

export interface RecoveryAttempt {
  lastAttempt: number;
  count: number;
}

export interface RecoveryResult {
  recovered: boolean;
  failureType: 'stall' | 'crash' | 'error_loop' | 'context_exhaustion' | null;
  strategy?: TruncationStrategy;
  attemptNumber?: number;
  message: string;
  /** True when the kill was DEFERRED because the work-check found the session
   *  alive and actively producing work (active child processes). The session
   *  was NOT killed and is NOT dead — callers MUST NOT treat this as a failed
   *  recovery of a dead session, and MUST NOT notify the user (a deferral is
   *  the system deciding the session is fine; telling the user it died is a
   *  false death report — the 2026-06-06 "conversation too long" flood). */
  deferred?: boolean;
}

export interface SessionRecoveryDeps {
  /** Check if a tmux session's Claude process is alive */
  isSessionAlive: (sessionName: string) => boolean;
  /** Get the PID of the pane in a tmux session */
  getPanePid?: (sessionName: string) => number | null;
  /**
   * Kill a tmux session — for kill-to-respawn paths this should route through
   * `SessionManager.terminateSession(id, 'session-recovery', { disposition:
   * 'recovery-bounce', finalStatus: 'killed', bypassRecoveryFlag: true })` so the
   * §P3 notifier stays silent (a bounce is not a disappearance) and the kill
   * lands in the reap-log as a recovery-bounce (UNIFIED-SESSION-LIFECYCLE §P0 #8).
   * Implementations may be async; callers `await` the result.
   */
  killSession: (sessionName: string) => void | Promise<void>;
  /**
   * P1/P2 cross-check (UNIFIED-SESSION-LIFECYCLE §P0 #8): does the session's
   * tmux pane have active child processes? A JSONL stall on a process that is
   * still producing real work is almost always a false read — keep the session
   * and let the next tick re-evaluate. Undefined ⇒ check is skipped (defaults
   * to the pre-Phase-2 behavior).
   */
  hasActiveProcesses?: (sessionName: string) => boolean;
  /** Respawn a session for a topic, optionally with a recovery prompt */
  respawnSession: (topicId: number, sessionName?: string, recoveryPrompt?: string) => Promise<void>;
  /** Send a message to a topic */
  sendToTopic?: (topicId: number, message: string) => Promise<void>;
  /** Capture tmux output for a session (needed for context exhaustion detection) */
  captureSessionOutput?: (sessionName: string, lines: number) => string | null;
  /** Respawn a session fresh (no --resume) for context exhaustion recovery */
  respawnSessionFresh?: (topicId: number, sessionName?: string, recoveryPrompt?: string) => Promise<void>;
  /**
   * Non-destructive context-wall escalation: press `/compact` for a session
   * genuinely stuck at "Context limit reached · /compact or /clear to continue"
   * and verify the wall cleared. This PRESERVES the conversation (Claude
   * compacts in place) — the rung that should be tried BEFORE the destructive
   * fresh respawn. Resolves `{ cleared: true }` when the wall is gone after
   * compaction, `{ cleared: false, reason }` when compaction itself fails
   * (e.g. the conversation is too long to even compact) or times out — in
   * which case recovery falls through to the fresh respawn. Undefined ⇒ the
   * rung is skipped (pre-escalation behavior: straight to fresh respawn).
   */
  attemptCompaction?: (sessionName: string) => Promise<{ cleared: boolean; reason?: string }>;
  /**
   * Get recent messages for a topic (used by context-exhaustion recovery to
   * capture any in-flight agent reply that lands between detection and respawn,
   * so the fresh session can avoid duplicating it).
   */
  getRecentTopicMessages?: (topicId: number, limit: number) => Array<{
    text: string;
    fromUser: boolean;
    timestamp: string | number | Date;
  }>;

  // ── Part D: double-dispatch recovery gate (docs/specs/ownership-follows-live-work.md) ──
  // Injected primitives that let `checkAndRecover` consult per-topic ownership
  // BEFORE re-running a recovery locally, so a machine that no longer owns a topic
  // FORWARDS to the owner instead of double-dispatching the same inbound. All
  // optional — when absent (or `ownershipFollowsLiveWork()` resolves false) the
  // gate is a strict no-op and the existing recovery logic runs unchanged (the
  // byte-identical legacy path). The decision logic lives in `checkAndRecover` so
  // both sides of every ownership state are unit-testable here.

  /** The dev-gated flag (resolveDevAgentGate). False / absent ⇒ gate is a no-op. */
  ownershipFollowsLiveWork?: () => boolean;
  /**
   * `ownReg.ownerOf(String(topicId))` — the topic's owner machine id, or null
   * when no record / released. MAY THROW (registry unreadable); the gate treats a
   * throw as the fail-OPEN registry-unknown branch (re-run locally + telemetry),
   * distinct from a reachability throw (which names a peer → withhold).
   */
  ownerOfTopic?: (topicId: number) => string | null;
  /** This machine's mesh id (null when single-machine / not yet resolved). */
  selfMachineId?: () => string | null;
  /**
   * Is the (peer) owner machine reachable right now?
   * `machinePoolRegistry.getCapacity(owner)?.online === true`. MAY THROW /
   * be indeterminate → the gate treats that as the UNREACHABLE-peer branch
   * (withhold the local re-run; the record NAMES a peer, so we don't
   * double-dispatch) — NOT the fail-open registry-unknown branch.
   */
  isOwnerReachable?: (owner: string) => boolean;
  /**
   * Forward the topic's ALREADY-DURABLE pending inbound through the existing
   * route() drain (FIFO, never a fabricated message). Returns the count forwarded
   * + a `nonePending` flag (true ⇒ nothing to serve; the gate withholds the local
   * respawn and emits no forward). Ordering + exactly-once are the queue drain's +
   * route()'s per-event-id ledger's responsibility — the gate adds neither.
   */
  forwardPendingInboundViaRoute?: (topicId: number) => Promise<{ forwarded: number; nonePending: boolean }>;
  /**
   * Emit ONE neutral observational telemetry row for the fail-OPEN /
   * reachability-unknown branches (`recovery-gate-registry-unknown` /
   * `recovery-gate-reachability-unknown`) to the machine-local sentinel-events
   * audit, so the fail-open tradeoff is MEASURED (the fleet-promotion gate reads
   * it), not assumed. Best-effort; a throw never affects the recovery decision.
   */
  emitRecoveryGateTelemetry?: (row: {
    kind: 'recovery-gate-registry-unknown' | 'recovery-gate-reachability-unknown';
    topicId: number;
    decision: 're-run-local' | 'withhold';
    reason: string;
  }) => void;
}

/**
 * Part D decision (docs/specs/ownership-follows-live-work.md). The MIXED safe
 * direction, named honestly per ownership state:
 *  - `proceed`   → re-run locally (owner === self, or null/released, or the
 *    fail-OPEN registry-unknown branch — re-running cannot double-dispatch when
 *    nobody else owns it, and a dead conversation is a worse failure than a rare
 *    double-reply on an UNKNOWN-ownership registry blip).
 *  - `forward`   → owner is a REACHABLE peer: do NOT re-run; forward to the owner.
 *  - `withhold`  → owner is an UNREACHABLE peer (incl. reachability throw): the
 *    record names a peer, so withhold the local re-run; the message rides the
 *    durable inbound queue / forward path (bounded by that queue's TTL +
 *    loss-notice — never an unbounded hold, never a silent strand).
 */
export type OwnershipRecoveryDecision = 'proceed' | 'forward' | 'withhold';

// ============================================================================
// SessionRecovery Class
// ============================================================================

export class SessionRecovery extends EventEmitter {
  private config: SessionRecoveryConfig;
  private deps: SessionRecoveryDeps;
  private recoveryAttempts: Map<string, RecoveryAttempt> = new Map();
  private stateFilePath: string;

  constructor(config: Partial<SessionRecoveryConfig>, deps: SessionRecoveryDeps) {
    super();
    this.config = {
      enabled: config.enabled ?? true,
      maxAttempts: config.maxAttempts ?? 3,
      cooldownMs: config.cooldownMs ?? 15 * 60 * 1000,
      projectDir: config.projectDir || process.cwd(),
    };
    this.deps = deps;
    this.stateFilePath = path.join(this.config.projectDir, '.instar', 'recovery-state.json');
    this.loadState();
  }

  /**
   * Check a session for mechanical failures and attempt recovery.
   * Should be called from SessionMonitor.checkSession() before LLM triage.
   *
   * @returns RecoveryResult — if recovered is true, caller should skip LLM triage
   */
  async checkAndRecover(
    topicId: number,
    sessionName: string,
  ): Promise<RecoveryResult> {
    if (!this.config.enabled) {
      return { recovered: false, failureType: null, message: 'Recovery disabled' };
    }

    // ── Part D: double-dispatch recovery gate (ownership-follows-live-work) ──────
    // BEFORE any recovery sub-path respawns/re-injects, consult per-topic ownership.
    // A `forward`/`withhold` decision means another machine owns this topic (or its
    // owner is briefly unreachable) — re-running here would double-dispatch the same
    // inbound. Strict no-op when the flag is OFF / deps absent (legacy behavior).
    const ownershipDecision = this.decideOwnershipForRecovery(topicId);
    if (ownershipDecision === 'forward') {
      // Reachable peer owns the topic: do NOT recover locally — forward the topic's
      // pending inbound through route() (which re-resolves the live owner + applies
      // isRemotelyHandled at dispatch). No pending inbound ⇒ nothing to serve; the
      // leftover idle session is converged by the existing reaper/reconciler.
      let forwarded = 0;
      let nonePending = true;
      try {
        const r = await this.deps.forwardPendingInboundViaRoute?.(topicId);
        if (r) { forwarded = r.forwarded; nonePending = r.nonePending; }
      } catch { /* @silent-fallback-ok — forward is best-effort; route()'s own ledger owns delivery + exactly-once */ }
      return {
        recovered: false,
        failureType: null,
        message: nonePending
          ? `Recovery skipped — topic ${topicId} owned by a reachable peer and no pending inbound to forward`
          : `Recovery forwarded — topic ${topicId} owned by a reachable peer; ${forwarded} pending inbound routed to the owner`,
      };
    }
    if (ownershipDecision === 'withhold') {
      // Unreachable peer owns the topic (incl. reachability-throw): WITHHOLD the
      // local re-run. The message is NOT lost — it rides the existing durable inbound
      // queue / forward path; if the owner stays dark the ownership reconciler +
      // failover (force-claim on death evidence) eventually move ownership.
      return {
        recovered: false,
        failureType: null,
        message: `Recovery withheld — topic ${topicId} owned by an unreachable peer; the message rides the durable inbound queue (not re-run locally to avoid double-dispatch)`,
      };
    }
    // ownershipDecision === 'proceed' → fall through to today's recovery logic.

    const processAlive = this.deps.isSessionAlive(sessionName);

    // 1. Check for context exhaustion (process alive but conversation too long)
    // This runs FIRST and doesn't need JSONL — it scans tmux output directly.
    // A session at the "conversation too long" prompt is alive and not stalled,
    // it just can't accept any more input without hitting the same error.
    if (processAlive && this.deps.captureSessionOutput) {
      const tmuxOutput = this.deps.captureSessionOutput(sessionName, 50);
      if (tmuxOutput) {
        const contextCheck = detectContextExhaustion(tmuxOutput);
        if (contextCheck.matched) {
          const result = await this.recoverFromContextExhaustion(topicId, sessionName, contextCheck.pattern || 'unknown');
          this.logEvent(result, topicId, sessionName);
          return result;
        }
      }
    }

    // 2. Find the JSONL file for this session (needed for stall/crash/error-loop detection)
    const jsonlPath = this.findJsonlForSession(sessionName);
    if (!jsonlPath) {
      return { recovered: false, failureType: null, message: 'No JSONL found' };
    }

    // 3. Check for stall (process alive but frozen)
    if (processAlive) {
      const stall = detectToolCallStall(jsonlPath);
      if (stall) {
        const result = await this.recoverFromStall(topicId, sessionName, stall);
        this.logEvent(result, topicId, sessionName);
        return result;
      }
    }

    // 4. Check for error loop (can happen with alive OR dead process)
    const errorLoop = detectErrorLoop(jsonlPath);
    if (errorLoop) {
      const result = await this.recoverFromErrorLoop(topicId, sessionName, jsonlPath, errorLoop);
      this.logEvent(result, topicId, sessionName);
      return result;
    }

    // 5. Check for crash (process dead with incomplete state)
    if (!processAlive) {
      const crash = detectCrashedSession(jsonlPath, false);
      if (crash) {
        const result = await this.recoverFromCrash(topicId, sessionName, jsonlPath, crash);
        this.logEvent(result, topicId, sessionName);
        return result;
      }
    }

    return { recovered: false, failureType: null, message: 'No mechanical failure detected' };
  }

  /**
   * Part D decision logic (docs/specs/ownership-follows-live-work.md). Resolves the
   * per-topic ownership state into a recovery direction. The safe direction is
   * MIXED and named honestly per state (NOT uniformly fail-closed):
   *  - owner === self / null / released → `proceed` (re-run locally; no competing
   *    owner can double-dispatch, and NOT re-running would silently drop the recovery).
   *  - owner === reachable peer → `forward` (the owner serves it; double-dispatch avoided).
   *  - owner === unreachable peer (incl. `isOwnerReachable` THROW / indeterminate) →
   *    `withhold` (the record NAMES a peer, so the safe direction is no-double-dispatch).
   *  - `ownerOf` THROWS / registry unreadable → `proceed` — **fail-OPEN, labeled as
   *    such** + a `recovery-gate-registry-unknown` telemetry row: we have NO owner
   *    evidence at all, and a dead conversation is a worse failure than a rare
   *    double-reply. (A *persistent* registry failure degrades to the OLD
   *    double-dispatch-prone behavior — an already-broken state, not a new regression.)
   */
  private decideOwnershipForRecovery(topicId: number): OwnershipRecoveryDecision {
    // Flag OFF / deps absent → strict no-op (legacy behavior: always proceed).
    if (!this.deps.ownershipFollowsLiveWork || !this.deps.ownershipFollowsLiveWork()) return 'proceed';
    if (!this.deps.ownerOfTopic || !this.deps.selfMachineId) return 'proceed';

    const self = this.deps.selfMachineId();
    if (!self) return 'proceed'; // single-machine / mesh id not resolved → no peer can own it

    let owner: string | null;
    try {
      owner = this.deps.ownerOfTopic(topicId);
    } catch {
      // ownerOf THREW / registry unreadable → FAIL-OPEN (re-run locally), labeled
      // as such + measured. We have NO owner evidence (distinct from a reachability
      // throw, where the record DID name a peer). A registry read error is rare +
      // transient; a recovery path that silently does nothing on a blip is the worse
      // failure (a dead conversation). The fleet-promotion gate reads this count.
      try {
        this.deps.emitRecoveryGateTelemetry?.({
          kind: 'recovery-gate-registry-unknown',
          topicId,
          decision: 're-run-local',
          reason: 'ownerOf threw / registry unreadable — fail-open to conversation continuity',
        });
      } catch { /* @silent-fallback-ok — telemetry is observability; never affects the decision */ }
      return 'proceed';
    }

    if (owner === null) return 'proceed'; // released / never-seen → no competing owner
    if (owner === self) return 'proceed'; // we own it → re-run is correct (today's behavior)

    // owner is a PEER. Reachable → forward; unreachable / indeterminate → withhold.
    let reachable: boolean;
    try {
      reachable = this.deps.isOwnerReachable ? this.deps.isOwnerReachable(owner) : false;
    } catch {
      // isOwnerReachable THREW / indeterminate for a PEER-owned record → treat as the
      // UNREACHABLE-peer branch (withhold), NOT a local re-run: the record NAMES a
      // peer, so the safe direction is no-double-dispatch (distinct from the
      // ownerOf-throw case above where we had no owner evidence at all). Measured.
      try {
        this.deps.emitRecoveryGateTelemetry?.({
          kind: 'recovery-gate-reachability-unknown',
          topicId,
          decision: 'withhold',
          reason: 'isOwnerReachable threw / indeterminate for a peer-owned record — withhold (record names a peer)',
        });
      } catch { /* @silent-fallback-ok — telemetry is observability; never affects the decision */ }
      return 'withhold';
    }
    return reachable ? 'forward' : 'withhold';
  }

  /**
   * Log a recovery event to the JSONL event log for observability.
   */
  logEvent(result: RecoveryResult, topicId: number, sessionName: string): void {
    const eventLogPath = path.join(this.config.projectDir, '.instar', 'recovery-events.jsonl');
    const entry = {
      timestamp: new Date().toISOString(),
      failureType: result.failureType,
      recovered: result.recovered,
      topicId,
      sessionName,
      attempt: result.attemptNumber ?? 1,
    };
    try {
      const dir = path.dirname(eventLogPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.appendFileSync(eventLogPath, JSON.stringify(entry) + '\n');
    } catch { // @silent-fallback-ok — event logging is best-effort observability
      // Can't write — skip
    }
  }

  /**
   * Aggregate recovery stats from the event log since a given timestamp.
   */
  getStats(sinceMs: number): {
    attempts: { stall: number; crash: number; errorLoop: number; contextExhaustion: number };
    successes: { stall: number; crash: number; errorLoop: number; contextExhaustion: number };
  } {
    const stats = {
      attempts: { stall: 0, crash: 0, errorLoop: 0, contextExhaustion: 0 },
      successes: { stall: 0, crash: 0, errorLoop: 0, contextExhaustion: 0 },
    };

    const eventLogPath = path.join(this.config.projectDir, '.instar', 'recovery-events.jsonl');
    if (!fs.existsSync(eventLogPath)) return stats;

    try {
      const lines = fs.readFileSync(eventLogPath, 'utf-8').trim().split('\n').filter(Boolean);
      for (const line of lines) {
        const entry = JSON.parse(line);
        const ts = new Date(entry.timestamp).getTime();
        if (ts < sinceMs) continue;

        const key = entry.failureType === 'error_loop' ? 'errorLoop'
          : entry.failureType === 'stall' ? 'stall'
          : entry.failureType === 'crash' ? 'crash'
          : entry.failureType === 'context_exhaustion' ? 'contextExhaustion'
          : null;
        if (!key) continue;

        stats.attempts[key]++;
        if (entry.recovered) stats.successes[key]++;
      }
    } catch { // @silent-fallback-ok — corrupt log returns empty stats
      // Can't read — return zeros
    }

    return stats;
  }

  // ============================================================================
  // Recovery Methods
  // ============================================================================

  /**
   * Shared kill-to-respawn entry (UNIFIED-SESSION-LIFECYCLE §P0 #8).
   *  - P1/P2 cross-check first: if the tmux pane has active child processes the
   *    session is doing real work and the JSONL "stall/crash" reading is almost
   *    certainly stale — defer this recovery attempt, let the next tick re-read.
   *  - Otherwise route through the dep's killSession (which is wired in
   *    server.ts to `terminateSession(disposition:'recovery-bounce',
   *    bypassRecoveryFlag:true)` so the §P3 notifier stays silent — a bounce is
   *    not a disappearance — and the kill lands in the reap-log).
   *
   *  @returns `'killed'` on a kill we performed; `'deferred-still-working'`
   *           when the work-check vetoed the kill.
   */
  private async killForRecovery(sessionName: string): Promise<'killed' | 'deferred-still-working'> {
    if (this.deps.hasActiveProcesses && this.deps.hasActiveProcesses(sessionName)) {
      console.log(
        `[SessionRecovery] "${sessionName}": P1/P2 cross-check found active child processes — `
          + `deferring recovery (JSONL stall but the process is still producing work)`,
      );
      return 'deferred-still-working';
    }
    await this.deps.killSession(sessionName);
    return 'killed';
  }

  private async recoverFromStall(
    topicId: number,
    sessionName: string,
    stall: StallInfo,
  ): Promise<RecoveryResult> {
    const key = `stall:${stall.sessionUuid || sessionName}`;

    if (!this.shouldAttempt(key)) {
      return {
        recovered: false,
        failureType: 'stall',
        message: `Stall recovery exhausted or in cooldown for ${sessionName}`,
      };
    }

    const attemptNumber = this.recordAttempt(key);

    this.emit('recovery:stall', { topicId, sessionName, stall, attemptNumber });

    // Kill and respawn (stalls don't need truncation — just resume)
    if ((await this.killForRecovery(sessionName)) === 'deferred-still-working') {
      return {
        recovered: false, failureType: 'stall', attemptNumber, deferred: true,
        message: `Stall recovery deferred for ${sessionName} — work-check found active children; the JSONL "stall" reading is unreliable while the process is producing work`,
      };
    }

    await new Promise(resolve => setTimeout(resolve, 3000));

    const recoveryPrompt = this.buildStallRecoveryPrompt(stall);

    try {
      await this.deps.respawnSession(topicId, sessionName, recoveryPrompt);
      return {
        recovered: true,
        failureType: 'stall',
        attemptNumber,
        message: `Recovered from stall (${stall.lastToolName}, attempt ${attemptNumber})`,
      };
    } catch (err: any) { // @silent-fallback-ok — recovery code; returning recovered:false IS the degradation signal
      return {
        recovered: false,
        failureType: 'stall',
        attemptNumber,
        message: `Stall recovery respawn failed: ${err.message}`,
      };
    }
  }

  /**
   * Recover from context exhaustion ("conversation too long").
   *
   * Unlike stall/crash recovery which truncates the JSONL and resumes,
   * context exhaustion means the ENTIRE conversation is too large.
   * Recovery strategy: kill the session and respawn FRESH with telegram
   * history as the context seed. No --resume, no JSONL reuse.
   */
  private async recoverFromContextExhaustion(
    topicId: number,
    sessionName: string,
    matchedPattern: string,
  ): Promise<RecoveryResult> {
    const key = `context:${sessionName}`;

    if (!this.shouldAttempt(key)) {
      return {
        recovered: false,
        failureType: 'context_exhaustion',
        message: `Context exhaustion recovery exhausted or in cooldown for ${sessionName}`,
      };
    }

    const attemptNumber = this.recordAttempt(key);

    this.emit('recovery:context_exhaustion', { topicId, sessionName, matchedPattern, attemptNumber });

    // ── Rung 1: non-destructive /compact (preserves the conversation) ──
    // Before killing the session and losing the conversation, try the escalation
    // the wall itself asks for: press `/compact`. This is gated to a GENUINELY
    // stuck session (no active child processes — a working session at 100%
    // context is handled by the kill-defer below, never compacted out from under
    // its work). If /compact clears the wall the conversation survives; if it
    // fails (too long to even compact) or times out, we fall through to the
    // destructive fresh respawn — never worse than the prior behavior.
    const hasChildren = this.deps.hasActiveProcesses?.(sessionName) ?? false;
    if (!hasChildren && this.deps.attemptCompaction) {
      try {
        const compaction = await this.deps.attemptCompaction(sessionName);
        if (compaction.cleared) {
          this.emit('recovery:context_compacted', { topicId, sessionName, attemptNumber });
          return {
            recovered: true,
            failureType: 'context_exhaustion',
            attemptNumber,
            message: `Recovered via /compact — conversation preserved (pattern: "${matchedPattern}", attempt ${attemptNumber})`,
          };
        }
        // compaction.cleared === false → fall through to the destructive respawn.
      } catch {
        // @silent-fallback-ok — compaction is best-effort; fall through to respawn.
      }
    }

    // Record detection moment so we can identify any in-flight agent reply that
    // lands AFTER this point — the dying session may have generated a reply that
    // hasn't been written to topic history yet at respawn time.
    const detectedAt = Date.now();

    // ── Rung 2: kill + fresh respawn (conversation lost) ──
    // Reached only when /compact was unavailable, declined (active children), or
    // could not clear the wall. The session is stuck at the "conversation too
    // long" prompt and a fresh start is the only remaining recovery.
    if ((await this.killForRecovery(sessionName)) === 'deferred-still-working') {
      return {
        recovered: false, failureType: 'context_exhaustion', attemptNumber, deferred: true,
        message: `Context-exhaustion recovery deferred for ${sessionName} — work-check found active children`,
      };
    }

    // Grace period: poll topic history for any in-flight agent reply from the
    // dying session. If one lands, capture its text so the fresh session can
    // avoid duplicating it. The previous 3s static sleep left a race window
    // where a reply landing at T+4s would never be known to the fresh session.
    const inFlightReply = await this.waitForInFlightReply(topicId, detectedAt);

    const baseRecoveryPrompt =
      `[RECOVERY] Your previous session hit the context window limit — the conversation became too long ` +
      `for Claude to process. The session was killed and restarted FRESH with thread history. ` +
      `You are NOT resuming the old conversation — this is a clean start with the recent message history ` +
      `loaded as context. Continue helping the user from where the conversation left off.`;

    const recoveryPrompt = sanitizeForPrompt(
      inFlightReply
        ? `${baseRecoveryPrompt}\n\n` +
          `IMPORTANT: Your previous session had ALREADY SENT this reply to the user before it was restarted — ` +
          `do NOT repeat any part of it. Acknowledge the restart to the user, then continue from where the reply left off:\n\n` +
          `<previous_reply>\n${inFlightReply}\n</previous_reply>`
        : baseRecoveryPrompt
    );

    // Use respawnSessionFresh if available (no --resume), otherwise fall back to normal respawn
    const respawnFn = this.deps.respawnSessionFresh || this.deps.respawnSession;

    try {
      await respawnFn(topicId, sessionName, recoveryPrompt);
      return {
        recovered: true,
        failureType: 'context_exhaustion',
        attemptNumber,
        message: inFlightReply
          ? `Recovered from context exhaustion with in-flight reply captured (pattern: "${matchedPattern}", attempt ${attemptNumber}) — fresh session knows what was already sent`
          : `Recovered from context exhaustion (pattern: "${matchedPattern}", attempt ${attemptNumber}) — fresh session spawned`,
      };
    } catch (err: any) { // @silent-fallback-ok — recovery code; returning recovered:false IS the degradation signal
      return {
        recovered: false,
        failureType: 'context_exhaustion',
        attemptNumber,
        message: `Context exhaustion recovery respawn failed: ${err.message}`,
      };
    }
  }

  /**
   * After a context-exhausted session is killed, an in-flight reply it was
   * generating may still land in topic history a few seconds later. This
   * helper polls history for a new agent message with a timestamp after
   * detection, returning its text if found (or null if nothing landed in
   * the grace window).
   *
   * Purpose: pass the captured reply into the recovery prompt so the fresh
   * session does not re-answer a question the dying session already answered.
   * Without this, the fresh session's bootstrap snapshot is a view of history
   * that predates the dying reply, and the fresh session duplicates output.
   *
   * Grace window: 7s. Empirically, in-flight replies land 2-6s after detection;
   * 7s covers the common case without adding much latency when nothing arrives.
   * Breaks early the moment a reply is seen.
   */
  private async waitForInFlightReply(topicId: number, detectedAt: number): Promise<string | null> {
    if (!this.deps.getRecentTopicMessages) {
      // No topic-history source — fall back to the legacy 3s static delay
      // to preserve previous behavior and give the kill + filesystem time to settle.
      await new Promise(resolve => setTimeout(resolve, 3000));
      return null;
    }

    const graceMs = 7000;
    const pollMs = 500;
    const start = Date.now();
    while (Date.now() - start < graceMs) {
      await new Promise(resolve => setTimeout(resolve, pollMs));
      try {
        const recent = this.deps.getRecentTopicMessages(topicId, 5);
        for (const m of recent) {
          const ts = new Date(m.timestamp).getTime();
          if (!m.fromUser && ts > detectedAt && m.text && m.text.trim().length > 0) {
            return m.text;
          }
        }
      } catch { /* best effort — continue polling */ }
    }
    return null;
  }

  private async recoverFromCrash(
    topicId: number,
    sessionName: string,
    jsonlPath: string,
    crash: CrashInfo,
  ): Promise<RecoveryResult> {
    const key = `crash:${crash.sessionUuid || sessionName}`;

    if (!this.shouldAttempt(key)) {
      return {
        recovered: false,
        failureType: 'crash',
        message: `Crash recovery exhausted or in cooldown for ${sessionName}`,
      };
    }

    const attemptNumber = this.recordAttempt(key);
    const strategy = this.pickTruncationStrategy(attemptNumber);

    this.emit('recovery:crash', { topicId, sessionName, crash, attemptNumber, strategy });

    // Truncate JSONL
    try {
      truncateJsonlToSafePoint(jsonlPath, strategy, strategy === 'n_exchanges_back' ? 3 : undefined);
    } catch (err: any) { // @silent-fallback-ok — recovery code; returning recovered:false IS the degradation signal
      return {
        recovered: false,
        failureType: 'crash',
        strategy,
        attemptNumber,
        message: `JSONL truncation failed: ${err.message}`,
      };
    }

    // Kill (might already be dead) and respawn
    if ((await this.killForRecovery(sessionName)) === 'deferred-still-working') {
      return {
        recovered: false, failureType: 'crash', attemptNumber, deferred: true,
        message: `Crash recovery deferred for ${sessionName} — work-check found active children (the JSONL "crashed" reading conflicts with a running process)`,
      };
    }
    await new Promise(resolve => setTimeout(resolve, 3000));

    const recoveryPrompt = this.buildCrashRecoveryPrompt(crash, strategy);

    try {
      await this.deps.respawnSession(topicId, sessionName, recoveryPrompt);
      return {
        recovered: true,
        failureType: 'crash',
        strategy,
        attemptNumber,
        message: `Recovered from crash (${strategy}, attempt ${attemptNumber})`,
      };
    } catch (err: any) { // @silent-fallback-ok — recovery code; returning recovered:false IS the degradation signal
      return {
        recovered: false,
        failureType: 'crash',
        strategy,
        attemptNumber,
        message: `Crash recovery respawn failed: ${err.message}`,
      };
    }
  }

  private async recoverFromErrorLoop(
    topicId: number,
    sessionName: string,
    jsonlPath: string,
    loop: ErrorLoopInfo,
  ): Promise<RecoveryResult> {
    const key = `loop:${loop.sessionUuid || sessionName}`;

    if (!this.shouldAttempt(key)) {
      return {
        recovered: false,
        failureType: 'error_loop',
        message: `Error loop recovery exhausted or in cooldown for ${sessionName}`,
      };
    }

    const attemptNumber = this.recordAttempt(key);
    // Error loops need more aggressive truncation
    const strategy: TruncationStrategy = attemptNumber <= 1 ? 'last_exchange' : 'last_successful_tool';

    this.emit('recovery:error_loop', { topicId, sessionName, loop, attemptNumber, strategy });

    // Truncate JSONL
    try {
      truncateJsonlToSafePoint(jsonlPath, strategy);
    } catch (err: any) { // @silent-fallback-ok — recovery code; returning recovered:false IS the degradation signal
      return {
        recovered: false,
        failureType: 'error_loop',
        strategy,
        attemptNumber,
        message: `JSONL truncation failed: ${err.message}`,
      };
    }

    // Kill and respawn
    if ((await this.killForRecovery(sessionName)) === 'deferred-still-working') {
      return {
        recovered: false, failureType: 'error_loop', attemptNumber, deferred: true,
        message: `Error-loop recovery deferred for ${sessionName} — work-check found active children`,
      };
    }
    await new Promise(resolve => setTimeout(resolve, 3000));

    const recoveryPrompt = this.buildErrorLoopRecoveryPrompt(loop, strategy);

    try {
      await this.deps.respawnSession(topicId, sessionName, recoveryPrompt);
      return {
        recovered: true,
        failureType: 'error_loop',
        strategy,
        attemptNumber,
        message: `Recovered from error loop (${loop.loopCount}x "${loop.failingPattern.slice(0, 50)}", attempt ${attemptNumber})`,
      };
    } catch (err: any) { // @silent-fallback-ok — recovery code; returning recovered:false IS the degradation signal
      return {
        recovered: false,
        failureType: 'error_loop',
        strategy,
        attemptNumber,
        message: `Error loop recovery respawn failed: ${err.message}`,
      };
    }
  }

  // ============================================================================
  // Recovery Prompt Builders
  // ============================================================================

  private buildStallRecoveryPrompt(stall: StallInfo): string {
    return sanitizeForPrompt(
      `[RECOVERY] Your previous session stalled while running tool "${stall.lastToolName}" ` +
      `(stalled for ${Math.round(stall.stallDurationMs / 1000)}s). ` +
      `The session was automatically restarted. ` +
      `Continue where you left off — the tool call that stalled has been discarded.`
    );
  }

  private buildCrashRecoveryPrompt(crash: CrashInfo, strategy: TruncationStrategy): string {
    const errorDetail = crash.errorMessage
      ? ` Error: "${crash.errorMessage.slice(0, 200)}"`
      : crash.lastToolName
        ? ` Last tool: "${crash.lastToolName}"`
        : '';
    return sanitizeForPrompt(
      `[RECOVERY] Your previous session crashed (${crash.errorType}).${errorDetail} ` +
      `The conversation was rewound using strategy "${strategy}" and the session was restarted. ` +
      `Some recent messages may be missing. Continue where you left off — avoid repeating ` +
      `the action that caused the crash.`
    );
  }

  private buildErrorLoopRecoveryPrompt(loop: ErrorLoopInfo, strategy: TruncationStrategy): string {
    return sanitizeForPrompt(
      `[RECOVERY] Your previous session was stuck in an error loop — ` +
      `the same error repeated ${loop.loopCount} times: "${loop.failingPattern.slice(0, 100)}". ` +
      (loop.failingCommand ? `Failing command: "${loop.failingCommand.slice(0, 100)}". ` : '') +
      `The conversation was rewound using strategy "${strategy}" and the session was restarted. ` +
      `Try a DIFFERENT approach — the previous one kept failing.`
    );
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  private pickTruncationStrategy(attemptNumber: number): TruncationStrategy {
    if (attemptNumber <= 1) return 'last_exchange';
    if (attemptNumber <= 2) return 'last_successful_tool';
    return 'n_exchanges_back';
  }

  private shouldAttempt(key: string): boolean {
    const prior = this.recoveryAttempts.get(key);
    if (!prior) return true;
    if (Date.now() - prior.lastAttempt < this.config.cooldownMs) return false;
    if (prior.count >= this.config.maxAttempts) return false;
    return true;
  }

  private recordAttempt(key: string): number {
    const prior = this.recoveryAttempts.get(key);
    const count = (prior?.count || 0) + 1;
    this.recoveryAttempts.set(key, { lastAttempt: Date.now(), count });
    this.saveState();
    return count;
  }

  /**
   * Load recovery state from disk. Prevents infinite kill-respawn loops
   * across dawn-server restarts by preserving attempt counts and cooldowns.
   */
  private loadState(): void {
    try {
      if (fs.existsSync(this.stateFilePath)) {
        const data = JSON.parse(fs.readFileSync(this.stateFilePath, 'utf-8'));
        if (data.attempts && typeof data.attempts === 'object') {
          for (const [key, value] of Object.entries(data.attempts)) {
            const attempt = value as RecoveryAttempt;
            if (attempt.lastAttempt && attempt.count) {
              this.recoveryAttempts.set(key, attempt);
            }
          }
        }
      }
    } catch { // @silent-fallback-ok — corrupt state file means fresh start, which is safe
      // Can't load — start fresh (safe default)
    }
  }

  /**
   * Persist recovery state to disk so it survives process restarts.
   */
  private saveState(): void {
    try {
      const dir = path.dirname(this.stateFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const data: Record<string, RecoveryAttempt> = {};
      // Only persist entries less than 1 hour old
      const ONE_HOUR = 60 * 60 * 1000;
      for (const [key, entry] of Array.from(this.recoveryAttempts.entries())) {
        if (Date.now() - entry.lastAttempt < ONE_HOUR) {
          data[key] = entry;
        }
      }

      fs.writeFileSync(this.stateFilePath, JSON.stringify({ attempts: data }, null, 2));
    } catch { // @silent-fallback-ok — state persistence is best-effort; in-memory state still works
      // Can't save — in-memory state still works for this process lifetime
    }
  }

  /**
   * Find the JSONL file for a session using lsof (Strategy 1) with NO fallback.
   *
   * Previous implementation fell back to most-recently-modified JSONL which
   * could match a DIFFERENT healthy session, leading to cross-session corruption
   * during truncation. Now returns null if lsof can't identify the file —
   * better to skip recovery than corrupt the wrong session.
   */
  private findJsonlForSession(sessionName: string): string | null {
    const projectDir = this.config.projectDir;
    const projectHash = projectDir.replace(/[\/\.]/g, '-');
    const projectJsonlDir = path.join(os.homedir(), '.claude', 'projects', projectHash);

    if (!fs.existsSync(projectJsonlDir)) return null;

    // Strategy 1: Use lsof to find the JSONL file held open by the session's process
    if (this.deps.getPanePid) {
      const pid = this.deps.getPanePid(sessionName);
      if (pid) {
        try {
          // lint-allow-blocking-scan: targeted `lsof -p <pid>` (one specific process,
          // not a full enumeration), 5s timeout, runs once during a session's JSONL
          // recovery — not on a cadence, so it can't starve /health the way the #972
          // every-tick scans did.
          const output = execFileSync('lsof', ['-p', String(pid), '-Fn'], {
            encoding: 'utf-8',
            timeout: 5000,
          });
          // Look for .jsonl files in the output
          for (const line of output.split('\n')) {
            if (line.startsWith('n') && line.endsWith('.jsonl')) {
              const filePath = line.slice(1); // Remove 'n' prefix
              if (filePath.startsWith(projectJsonlDir) && fs.existsSync(filePath)) {
                return filePath;
              }
            }
          }
        } catch { // @silent-fallback-ok — lsof failure is expected on some platforms; null return triggers skip-recovery path
          // lsof failed — fall through to null (do NOT fallback to mtime-based)
        }
      }
    }

    // Strategy 2 (removed): Most-recently-modified JSONL was unsafe — could match
    // a concurrent healthy session, leading to cross-session corruption during truncation.
    // If lsof fails, we skip recovery rather than risk corrupting the wrong session.

    return null;
  }

  /**
   * Clean up old recovery tracking entries and stale .bak files.
   */
  cleanup(): void {
    const ONE_HOUR = 60 * 60 * 1000;
    for (const [key, entry] of Array.from(this.recoveryAttempts.entries())) {
      if (Date.now() - entry.lastAttempt > ONE_HOUR) {
        this.recoveryAttempts.delete(key);
      }
    }

    // Clean up .bak files older than 24 hours
    this.cleanupBackupFiles();
  }

  /**
   * Remove .bak.* files older than maxAge from the Claude projects JSONL directory.
   * Each recovery creates a full backup — without cleanup these accumulate indefinitely,
   * consuming disk and retaining sensitive conversation data.
   */
  private cleanupBackupFiles(maxAgeMs: number = 24 * 60 * 60 * 1000): void {
    const projectDir = this.config.projectDir;
    const projectHash = projectDir.replace(/[\/\.]/g, '-');
    const projectJsonlDir = path.join(os.homedir(), '.claude', 'projects', projectHash);

    if (!fs.existsSync(projectJsonlDir)) return;

    try {
      const files = fs.readdirSync(projectJsonlDir);
      const now = Date.now();
      let cleaned = 0;

      for (const file of files) {
        if (!file.includes('.bak.')) continue;

        const filePath = path.join(projectJsonlDir, file);
        try {
          const stat = fs.statSync(filePath);
          if (now - stat.mtimeMs > maxAgeMs) {
            SafeFsExecutor.safeUnlinkSync(filePath, { operation: 'src/monitoring/SessionRecovery.ts:727' });
            cleaned++;
          }
        } catch { // @silent-fallback-ok — best-effort cleanup; skipping one file is fine
          // Skip files we can't stat/delete
        }
      }

      if (cleaned > 0) {
        this.emit('cleanup:backups', { cleaned, directory: projectJsonlDir });
      }
    } catch { // @silent-fallback-ok — best-effort cleanup; directory read failure is non-critical
      // Can't read directory — skip cleanup
    }
  }
}

// ============================================================================
// Standalone Utilities
// ============================================================================

/**
 * Sanitize text for injection into a recovery prompt.
 * Strips control characters, Unicode directional overrides, and truncates.
 */
export function sanitizeForPrompt(text: string, maxLength: number = 2000): string {
  return text
    // Strip Unicode directional overrides and invisible characters (CVE-class attack vector)
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, '')
    // Strip ASCII control characters (except newlines and tabs)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    // Normalize Unicode to NFC
    .normalize('NFC')
    // Truncate
    .slice(0, maxLength);
}

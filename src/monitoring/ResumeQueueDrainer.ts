/**
 * ResumeQueueDrainer — the gated recovery loop that revives mid-work reaped
 * sessions, one at a time, once the machine has recovered
 * (reap-notify spec R2.4–R2.11; Tier 1 supervision per P7, observe-only
 * during the soak).
 *
 * Discipline (all deterministic gates must pass; NEVER bypassable — the
 * manual drain lever may skip the calm-ticks requirement ONLY):
 *  - pressure tier `normal` for `requiredCalmTicks` consecutive ticks (the
 *    SAME shared gauge as the SessionReaper — one definition of "calm");
 *  - the quota gate (`canSpawnSession`);
 *  - session count below cap;
 *  - no quota migration in flight.
 *  AT MOST ONE entry resumes per tick — the operator's explicit "ordered
 *  queue so they don't all resume at once". A full queue (50) drains in
 *  ≥50 calm minutes BY DESIGN (recovery-time envelope, stated).
 *
 * Drain-time reality validation (R2.6) re-checks the world immediately
 * before any spawn; any failure → `invalidated:<why>`, audited, folded into
 * the aggregated surface — never a spawn. Dequeue-side HARD INVARIANTS
 * (UUID format, enum, charset, length caps — the Signal-vs-Authority
 * brittle-blocker exemption) protect `claude --resume` argv and the
 * scheduler from corrupted state.
 *
 * Failure ladder + brakes (R2.9 / P19): spawn verified alive after a grace
 * period; failure → attempts++ with backoff; maxAttempts → gave-up;
 * `breakerThreshold` consecutive failures ACROSS entries opens the circuit
 * for `breakerCooldownMin` with ONE aggregated degradation notice. ALL
 * give-up classes fold into ONE rolling deduped attention item (P17).
 *
 * Tier 1 supervision (observe-only during the dev soak): each
 * about-to-resume decision gets a fast-tier LLM sanity check whose verdict
 * is AUDITED but never defers; shed/timeout (5s deadline) → deterministic
 * gates proceed, audited `supervision:'shed'`. Its own lever:
 * `resumeQueue.tier1Check`.
 *
 * Dry-run (the fleet's shipped code-default): every would-spawn is audited
 * `would-resume` (once per entry) and nothing spawns; TTL expiries do not
 * raise attention (a fleet of observe-only queues must not page anyone).
 */

import type { ResumeQueue, ResumeQueueEntry } from './ResumeQueue.js';
import { AGE_LIMIT_ACTIVE_RUN_REASON, COMMITMENT_ACTIVE_RUN_REASON, isAutoResumableEmergencyPauseReason } from '../core/WorkEvidence.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JOB_SLUG_RE = /^[a-z0-9-]+$/;
const THREAD_ID_RE = /^[A-Za-z0-9._:-]{1,256}$/;
const PRIORITY_CLASSES = new Set(['interactive', 'job', 'other']);

export interface ResumeQueueDrainerDeps {
  queue: ResumeQueue;
  /** Shared pressure gauge (HostPressureSampler) — one definition of calm. */
  pressureTier: () => 'normal' | 'moderate' | 'critical';
  /** QuotaManager.canSpawnSession — consulted, never bypassed. */
  canSpawnSession: () => boolean;
  /** Session count below cap. */
  sessionCountOk: () => boolean;
  /** A quota migration is mid-flight. */
  migrationInFlight: () => boolean;
  // ── R2.6 drain-time reality validations ──
  liveSessionForTopic: (topicId: number) => boolean;
  currentResumeUuid: (topicId: number) => string | null;
  topicOwnerElsewhere: (topicId: number) => boolean;
  /** The topic's CURRENT project binding still matches the entry's cwd. */
  topicBindingMatches: (topicId: number, cwd: string) => boolean;
  /** An operator stop instruction recorded for the topic since the entry queued. */
  operatorStopSince: (topicId: number, sinceIso: string) => boolean;
  /**
   * Resume-idle-autonomous fix (spec: resume-idle-autonomous-on-reap.md):
   * OPTIONAL drain-time liveness re-check for an entry admitted because its topic
   * had an active autonomous run at age-limit-reap time. Returns `false` when the
   * run is NO LONGER active (completed OR its window elapsed between enqueue and
   * drain) → the entry invalidates `autonomous-run-finished`, never a spawn.
   * Absent (undefined) ⇒ today's behavior (no extra check) — back-compat.
   */
  autonomousRunFinished?: (topicId: number, reason: string) => boolean;
  /**
   * GAP-B D9 (spec: autonomous-registration-guarantee.md) — OPTIONAL drain-time
   * re-validation for an entry admitted via the COMMITMENT_ACTIVE_RUN_REASON
   * backstop (an UNregistered run kept alive by a fresh open commitment). Returns
   * `true` when the qualifying commitment + recent-user-activity STILL hold at
   * drain time → spawn proceeds; `false` when the commitment was
   * delivered/expired/violated or the user-activity window lapsed between enqueue
   * and drain → the entry invalidates `commitment-no-longer-active`, never a
   * spawn (so a done-but-not-marked commitment can't revive finished work). The
   * state-file `autonomousRunFinished` re-check is useless here (no state file by
   * construction), so this is its parallel. Absent ⇒ today's behavior. A
   * throwing/absent dep resolves to the SAFE side (still-active ⇒ allow), matching
   * autonomousRunFinished's contract: it never wrongly drops a legitimate revival.
   */
  commitmentStillActiveForTopic?: (topicId: number) => boolean;
  /** Jobs: exists, not disabled, not CrashLoopPauser-paused, not run since queuedAt. */
  jobCheck: (slug: string, queuedAtIso: string) => { ok: boolean; why?: string };
  pathExists: (p: string) => boolean;
  // ── Actions ──
  /** Respawn the topic's session (continuation prompt + entry cwd via the new
   *  spawn-path parameter). Returns the spawned tmux session name. */
  respawnTopic: (entry: ResumeQueueEntry, continuationPrompt: string) => Promise<string>;
  /** Re-route the exact canonical inbound through Threadline after a warm worker reap. */
  respawnThread?: (entry: ResumeQueueEntry) => Promise<string>;
  /** The exact canonical inbound is still present and has not already produced a reply. */
  threadlineMessagePending?: (entry: ResumeQueueEntry) => boolean;
  triggerJob: (slug: string) => Promise<'triggered' | 'queued' | 'skipped'>;
  /** Spawn verification after a grace period (R2.9). */
  spawnAliveAfterGrace: (tmuxSession: string) => Promise<boolean>;
  /** R2.11 honest resume notice to the topic ("restarted", never "resumed"). */
  notifyResumed?: (entry: ResumeQueueEntry) => void;
  /** Build-Session Yield Safety (ACT-839) R2.2: fired after a successful respawn
   *  when the revived entry carried `uncommitted-worktree-work`. The wiring
   *  (server.ts) registers a durable, beacon-enabled CommitmentTracker obligation
   *  so a STALLED revived session is re-surfaced. Present ONLY when the dev-gated
   *  yieldSafety feature is live — its presence is the gate. */
  onWorktreeRevival?: (entry: ResumeQueueEntry) => void;
  /** ONE rolling aggregated attention surface (caller dedupes on kind). */
  raiseAggregated: (kind: string, detail: string) => void;
  /** Decision-transition audit sink (logs/resume-queue.jsonl). */
  audit: (event: Record<string, unknown>) => void;
  /** Observe-only Tier 1 check (LlmQueue-backed). Resolves a verdict;
   *  the drainer imposes the 5s deadline and NEVER defers on it. */
  tier1Check?: (entry: ResumeQueueEntry) => Promise<{ sensible: boolean; reasoning?: string }>;
  now?: () => number;
}

export interface ResumeQueueDrainerConfig {
  drainIntervalSec: number;
  requiredCalmTicks: number;
  maxAttempts: number;
  breakerThreshold: number;
  breakerCooldownMin: number;
  tier1Check: boolean;
  /** Spawn-failure backoff base (doubles per attempt). */
  attemptBackoffMs: number;
  /** Tier-1 verdict deadline (prevents tick serialization). */
  tier1DeadlineMs: number;
  /**
   * Stale-emergency-pause auto-recovery (spec:
   * resume-queue-stale-emergency-pause.md). Layer 2 auto-resumes a stale
   * emergency/sentinel pause only when an active-autonomous-run entry was queued
   * STRICTLY MORE than this many minutes AFTER the pause began — long enough that
   * a fresh "kill all" + a coincidental age-reap minutes later never auto-undoes
   * the stop. CODE-defaulted (never frozen into ConfigDefaults — preserves the
   * fleet flip), like the other resumeQueue keys.
   */
  staleEmergencyPauseAutoResumeMin: number;
  /** Master off-switch for Layer 2 (the bounded behavior change). Layer 1 (the
   *  paused-with-waiting-work alert) is unaffected and always on. */
  autoResumeStalePause: boolean;
  /**
   * "The Agent Is Always Reachable" G2 (spec: agent-always-reachable). When a
   * revival is HELD by the pressure gate (calm-ticks) and the oldest waiting
   * entry has been queued longer than this, surface ONE plain-English
   * `pressure-held` notice (NOT silence, NOT the 24h ttl-expired) so the user
   * learns a topic is held under load with guidance — closing the topic-28744
   * silent-no-revival gap. 0 disables the notice.
   */
  pressureHeldNoticeMs: number;
}

export const DEFAULT_RESUME_DRAINER_CONFIG: ResumeQueueDrainerConfig = {
  drainIntervalSec: 60,
  requiredCalmTicks: 3,
  maxAttempts: 3,
  breakerThreshold: 3,
  breakerCooldownMin: 30,
  tier1Check: true,
  attemptBackoffMs: 2 * 60_000,
  tier1DeadlineMs: 5_000,
  staleEmergencyPauseAutoResumeMin: 60,
  autoResumeStalePause: true,
  pressureHeldNoticeMs: 20 * 60_000, // ~2 reaper ticks — surface a pressure-held revival, never silent
};

export class ResumeQueueDrainer {
  private readonly deps: ResumeQueueDrainerDeps;
  private readonly cfg: ResumeQueueDrainerConfig;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private calmTicks = 0;
  private consecutiveFailures = 0;
  private breakerOpenUntil = 0;
  private lastGateBlock = '';
  /** G2 (agent-always-reachable): episode flag so a pressure-held revival surfaces
   *  ONE notice per held episode, reset when the gate clears. */
  private pressureHeldNotified = false;
  /** would-resume audited once per entry in dry-run. */
  private dryRunAudited = new Set<string>();
  /**
   * Layer-1 (paused-with-waiting-work) dedupe marker — IN MEMORY by design (a
   * server restart mid-pause may re-alert once, which folds harmlessly into the
   * single rolling aggregate item). Keyed on `pausedAt|waitingCount` so a NEW
   * pause OR a GROWING backlog under the same pause re-alerts (closes the
   * "alert once then go silent as more entries accumulate" gap — codex r3 #3).
   */
  private lastPausedWaitingAlertKey = '';

  constructor(deps: ResumeQueueDrainerDeps, cfg?: Partial<ResumeQueueDrainerConfig>) {
    this.deps = deps;
    this.cfg = { ...DEFAULT_RESUME_DRAINER_CONFIG, ...(cfg ?? {}) };
    this.now = deps.now ?? (() => Date.now());
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() => { /* @silent-fallback-ok — last-resort belt: tick() guards internally and audits every decision; a throw here would only kill the interval timer */ });
    }, this.cfg.drainIntervalSec * 1000);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  status(): {
    calmTicks: number;
    breakerOpen: boolean;
    breakerOpenUntil: string | null;
    consecutiveFailures: number;
    lastTickAt: string | null;
  } {
    return {
      calmTicks: this.calmTicks,
      breakerOpen: this.now() < this.breakerOpenUntil,
      breakerOpenUntil: this.breakerOpenUntil > this.now() ? new Date(this.breakerOpenUntil).toISOString() : null,
      consecutiveFailures: this.consecutiveFailures,
      lastTickAt: this.lastTickAtIso,
    };
  }

  private lastTickAtIso: string | null = null;

  /**
   * One drainer tick. `skipCalmTicks` is the manual-drain lever (R2.10) — it
   * skips the calm-ticks requirement ONLY; every other gate still applies.
   */
  async tick(opts?: { skipCalmTicks?: boolean }): Promise<{
    resumed: boolean;
    blocked?: string;
    invalidated?: number;
  }> {
    if (this.ticking) return { resumed: false, blocked: 're-entrant' };
    this.ticking = true;
    try {
      this.lastTickAtIso = new Date(this.now()).toISOString();
      const queue = this.deps.queue;
      queue.heartbeat();

      if (queue.isDisabled()) return { resumed: false, blocked: 'queue-disabled' };
      if (!queue.config().enabled) return { resumed: false, blocked: 'queue-off' };
      if (queue.isPaused()) {
        // Stale-emergency-pause robustness (spec:
        // resume-queue-stale-emergency-pause.md). A paused queue used to early-
        // return here unconditionally, silently stranding every waiting revival
        // (the 2026-06-14 4-hour-silent-strand incident). Two layers now run at
        // this exact chokepoint; both are inert on a dry-run (observe-only) queue,
        // which strands nothing and must not page.
        if (!queue.isDryRun()) {
          const resumed = this.handlePausedQueue();
          // Layer 2 auto-resumed a stale pause → fall through to normal draining.
          // Otherwise the pause stands (Layer 1 alert, if any, already raised).
          if (!resumed) return { resumed: false, blocked: 'paused' };
        } else {
          return { resumed: false, blocked: 'paused' };
        }
      }

      // Calm tracking on the shared gauge.
      const tier = this.safeTier();
      if (tier === 'normal') this.calmTicks++;
      else this.calmTicks = 0;

      // TTL sweep (R2.9) — pressure-starved expiries marked; aggregated
      // attention only when LIVE (a fleet of dry-run queues must not page).
      const expired = queue.expireTtl(tier === 'normal');
      if (expired.length > 0 && !queue.isDryRun()) {
        const starved = expired.filter((e) => e.pressureStarved).length;
        this.deps.raiseAggregated(
          'ttl-expired',
          `${expired.length} queued resume(s) expired after 24h without a recovery window` +
          (starved > 0 ? ` (${starved} pressure-starved — the machine never calmed down)` : '') +
          `. Message the topic to bring the work back, or ask me to retry it.`,
        );
      }

      // Circuit breaker (R2.9).
      if (this.now() < this.breakerOpenUntil) {
        return { resumed: false, blocked: 'breaker-open' };
      }

      // Deterministic gates — NEVER bypassable.
      const gate = this.gateBlock(opts?.skipCalmTicks === true);
      if (gate) {
        if (gate !== this.lastGateBlock) {
          this.deps.audit({ event: 'gates-blocked', gate, tier, calmTicks: this.calmTicks });
          this.lastGateBlock = gate;
        }
        // G2 (agent-always-reachable): a PRESSURE-held revival must NOT be silent.
        // When the calm-ticks (pressure) gate holds a revival and the oldest READY
        // entry has waited past the notice window, surface ONE plain-English notice
        // through the DETERMINISTIC raiseAggregated funnel (a system notice, never
        // the tone-gated reply path that could itself be held by the same pressure),
        // then suppress until the gate clears. Closes the topic-28744 silent-no-revival gap.
        if (gate === 'calm-ticks') {
          if (this.cfg.pressureHeldNoticeMs > 0 && !this.pressureHeldNotified && !queue.isDryRun()) {
            const heldNowIso = new Date(this.now()).toISOString();
            const ready = queue.nextCandidates().find((e) => !e.nextAttemptAt || e.nextAttemptAt <= heldNowIso);
            const heldMs = ready ? this.now() - Date.parse(ready.queuedAt) : 0;
            if (ready && Number.isFinite(heldMs) && heldMs >= this.cfg.pressureHeldNoticeMs) {
              this.deps.raiseAggregated(
                'pressure-held',
                `A session I closed is waiting to come back, but the machine is under memory/CPU pressure, so I'm holding the restart until it eases — I'm not ignoring it. I'm freeing resources in the meantime; message me to retry, or I'll bring it back automatically once there's headroom.`,
              );
              this.pressureHeldNotified = true;
            }
          }
        } else {
          // The hold is no longer pressure (quota/session-cap/etc.) — re-arm the
          // pressure-held notice for a future pressure episode.
          this.pressureHeldNotified = false;
        }
        return { resumed: false, blocked: gate };
      }
      if (this.lastGateBlock) {
        this.deps.audit({ event: 'gates-cleared', calmTicks: this.calmTicks });
        this.lastGateBlock = '';
      }
      // Pressure (and every other gate) has cleared — re-arm the pressure-held notice.
      this.pressureHeldNotified = false;

      // ONE candidate per tick (R2.4), ordered (R2.5), attempt-backoff honored.
      const nowIso = new Date(this.now()).toISOString();
      const candidate = queue
        .nextCandidates()
        .find((e) => !e.nextAttemptAt || e.nextAttemptAt <= nowIso);
      if (!candidate) return { resumed: false, blocked: 'empty' };

      // Dequeue hard invariants (brittle-blocker exemption — argv protection).
      const corrupt = this.corruptEntryReason(candidate);
      if (corrupt) {
        queue.transition(candidate.id, 'invalidated:corrupt-entry');
        this.deps.audit({ event: 'invalidated', id: candidate.id, why: 'corrupt-entry', detail: corrupt });
        this.foldInvalidated(candidate, `corrupt-entry (${corrupt})`);
        return { resumed: false, invalidated: 1 };
      }

      // Drain-time reality validation (R2.6) — any failure → invalidated, never a spawn.
      const invalid = this.validateReality(candidate);
      if (invalid) {
        queue.transition(candidate.id, `invalidated:${invalid}`);
        this.deps.audit({ event: 'invalidated', id: candidate.id, why: invalid });
        this.foldInvalidated(candidate, invalid);
        return { resumed: false, invalidated: 1 };
      }

      // Tier 1 observe-only check (P7): audited, never defers, 5s deadline.
      if (this.cfg.tier1Check && this.deps.tier1Check) {
        const verdict = await this.runTier1(candidate);
        this.deps.audit({
          event: 'tier1-verdict',
          id: candidate.id,
          supervision: verdict.kind,
          ...(verdict.kind === 'verdict' ? { sensible: verdict.sensible, reasoning: verdict.reasoning } : {}),
        });
      }

      // Dry-run: audit would-resume ONCE per entry; nothing spawns (R2.4/config).
      if (queue.isDryRun()) {
        if (!this.dryRunAudited.has(candidate.id)) {
          this.dryRunAudited.add(candidate.id);
          this.deps.audit({ event: 'would-resume', id: candidate.id, stableKey: candidate.stableKey, dryRun: true });
        }
        return { resumed: false, blocked: 'dry-run' };
      }

      // ── The one resume of this tick ──
      queue.transition(candidate.id, 'starting', { lastAttemptAt: nowIso });
      let spawnedTmux: string | null = null;
      let failureDetail = '';
      try {
        if (candidate.topicId != null) {
          spawnedTmux = await this.deps.respawnTopic(candidate, this.continuationPrompt(candidate));
        } else if (candidate.threadId && candidate.threadlineMessageId && this.deps.respawnThread) {
          spawnedTmux = await this.deps.respawnThread(candidate);
        } else if (candidate.jobSlug) {
          const result = await this.deps.triggerJob(candidate.jobSlug);
          if (result === 'skipped') {
            failureDetail = 'triggerJob returned skipped';
          } else {
            spawnedTmux = ''; // job accepted — verification is the scheduler's domain
          }
        } else {
          // Should be unreachable (enqueue excludes no-path entries) — backstop.
          queue.transition(candidate.id, 'invalidated:no-resume-path');
          return { resumed: false, invalidated: 1 };
        }
      } catch (err) {
        failureDetail = err instanceof Error ? err.message : String(err);
      }

      // Spawn verification (R2.9): a topic respawn must be alive after grace.
      let verified = false;
      if (spawnedTmux !== null && failureDetail === '') {
        verified = spawnedTmux === '' ? true : await this.safeVerify(spawnedTmux);
        if (!verified && spawnedTmux !== '') failureDetail = 'spawned session not alive after grace';
      }

      if (verified) {
        queue.transition(candidate.id, 'respawned');
        queue.recordResumeSuccess(candidate.stableKey);
        this.consecutiveFailures = 0;
        try {
          this.deps.notifyResumed?.(candidate);
        } catch { /* the notice never endangers the resume */ }
        // Build-Session Yield Safety (ACT-839) R2.2: a session revived because its
        // worktree was dirty gets a durable, beacon-tracked obligation to commit /
        // deliberately preserve that work — so the loop is re-surfaced (PromiseBeacon)
        // even if the revived session STALLS rather than dies. The die-again case is
        // already caught by the dev-live OrphanedWorkSentinel (#1113), which detects +
        // preserves stranded worktree work; this hook adds only the stall-covering
        // obligation, never a duplicate scanner. Fires only when the feature is live
        // (the hook is wired only then) and the evidence is present.
        if (candidate.workEvidence.includes('uncommitted-worktree-work')) {
          try { this.deps.onWorktreeRevival?.(candidate); }
          catch { /* @silent-fallback-ok: the obligation registration is best-effort and NEVER endangers the resume — a successful respawn must stand even if the commitment row fails to open. */ }
        }
        this.deps.audit({ event: 'respawned', id: candidate.id, stableKey: candidate.stableKey, tmux: spawnedTmux });
        return { resumed: true };
      }

      // Failure ladder (R2.9).
      const attempts = candidate.attempts + 1;
      this.consecutiveFailures++;
      if (attempts >= this.cfg.maxAttempts) {
        queue.transition(candidate.id, 'gave-up:max-attempts', { attempts });
        this.deps.audit({ event: 'gave-up', id: candidate.id, why: 'max-attempts', attempts, detail: failureDetail });
        this.foldGaveUp(candidate, 'max-attempts', failureDetail);
      } else {
        const backoff = this.cfg.attemptBackoffMs * 2 ** Math.max(0, attempts - 1);
        queue.transition(candidate.id, 'queued', {
          attempts,
          nextAttemptAt: new Date(this.now() + backoff).toISOString(),
        });
        this.deps.audit({ event: 'attempt-failed', id: candidate.id, attempts, backoffMs: backoff, detail: failureDetail });
      }
      if (this.consecutiveFailures >= this.cfg.breakerThreshold) {
        this.breakerOpenUntil = this.now() + this.cfg.breakerCooldownMin * 60_000;
        this.consecutiveFailures = 0;
        this.deps.audit({ event: 'breaker-open', untilIso: new Date(this.breakerOpenUntil).toISOString() });
        this.deps.raiseAggregated(
          'breaker',
          `Session resumes keep failing (${this.cfg.breakerThreshold} in a row) — pausing resume attempts ` +
          `for ${this.cfg.breakerCooldownMin} minutes. The queue is intact; I'll retry after the cooldown.`,
        );
      }
      return { resumed: false, blocked: 'attempt-failed' };
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Paused-queue handling at the tick chokepoint (LIVE queues only — the caller
   * guards `!isDryRun()`). Returns `true` IFF Layer 2 auto-resumed a stale
   * emergency pause (the caller then falls through to normal draining); `false`
   * keeps the pause (the caller early-returns `blocked:'paused'`).
   *
   * Layer 1 (signal-only): raise ONE deduped `paused-waiting` notice when the
   * queue is paused with ≥1 waiting entry — at most once per (pause episode ×
   * waiting-count) so a NEW pause or a GROWING backlog re-alerts, but a steady
   * pause does not drip every tick.
   *
   * Layer 2 (bounded behavior change): auto-resume a STALE emergency/sentinel
   * pause (see staleness predicate) so a blunt stop on one topic never strands
   * unrelated, later-queued active-run revivals forever.
   */
  private handlePausedQueue(): boolean {
    const queue = this.deps.queue;
    const info = queue.pauseInfo();
    const waiting = queue.list().filter((e) => e.status === 'queued' || e.status === 'starting');

    // ── Layer 2: stale emergency-stop pause auto-recovery ──
    if (this.cfg.autoResumeStalePause && this.isStaleEmergencyPause(info, waiting)) {
      queue.unpause();
      this.deps.audit({
        event: 'auto-resumed-stale-pause',
        pausedAt: info.pausedAt,
        reason: info.reason,
        waiting: waiting.length,
      });
      this.deps.raiseAggregated(
        'auto-resumed-stale-pause',
        `I auto-resumed the revival queue. It had been paused by an emergency stop at ${info.pausedAt}, ` +
        `but an active autonomous run has been recycled and queued since then — so the stop wasn't about ` +
        `this work. Any topic you actually stopped stays protected (per-topic operator stops still block ` +
        `its revival).`,
      );
      // The Layer-1 marker is irrelevant after an unpause; reset so a future
      // pause episode alerts cleanly.
      this.lastPausedWaitingAlertKey = '';
      return true;
    }

    // ── Layer 1: paused-with-waiting-work escalation (signal-only) ──
    if (waiting.length > 0) {
      const key = `${info.pausedAt ?? 'unknown'}|${waiting.length}`;
      if (key !== this.lastPausedWaitingAlertKey) {
        this.lastPausedWaitingAlertKey = key;
        this.deps.audit({
          event: 'paused-waiting',
          pausedAt: info.pausedAt,
          reason: info.reason,
          waiting: waiting.length,
          resumeRoute: 'POST /sessions/resume-queue/resume',
        });
        this.deps.raiseAggregated(
          'paused-waiting',
          `Revival queue paused since ${info.pausedAt ?? 'an earlier stop'} (${info.reason ?? 'no reason recorded'}) — ` +
          `${waiting.length} session${waiting.length === 1 ? '' : 's'} ${waiting.length === 1 ? 'is' : 'are'} waiting and ` +
          `won't come back until it's resumed. Ask me to resume it, or resume it from the dashboard.`,
        );
      }
    }
    return false;
  }

  /**
   * Staleness predicate (spec §"Layer 2"). ALL must hold:
   *  - the pause reason is a blunt emergency/sentinel stop (closed-world
   *    predicate — never the deliberate `autonomous stop-all` pause);
   *  - a waiting entry's reason === AGE_LIMIT_ACTIVE_RUN_REASON (the operator
   *    has a live autonomous run they want continued);
   *  - that entry's queuedAt is STRICTLY MORE than the threshold AFTER pausedAt
   *    (the work the pause now blocks was queued long after the stop).
   * A missing/unparseable timestamp resolves to the SAFE side (NOT stale — the
   * pause stays), so a malformed clock can only keep the pause, never clear it.
   */
  private isStaleEmergencyPause(
    info: { paused: boolean; pausedAt?: string; reason?: string },
    waiting: ResumeQueueEntry[],
  ): boolean {
    if (!isAutoResumableEmergencyPauseReason(info.reason)) return false;
    const pausedAtMs = info.pausedAt ? Date.parse(info.pausedAt) : NaN;
    if (!Number.isFinite(pausedAtMs)) return false;
    const thresholdMs = this.cfg.staleEmergencyPauseAutoResumeMin * 60_000;
    return waiting.some((e) => {
      if (e.reason !== AGE_LIMIT_ACTIVE_RUN_REASON) return false;
      const queuedAtMs = Date.parse(e.queuedAt);
      if (!Number.isFinite(queuedAtMs)) return false;
      return queuedAtMs - pausedAtMs > thresholdMs;
    });
  }

  private safeTier(): 'normal' | 'moderate' | 'critical' {
    try {
      return this.deps.pressureTier();
    } catch {
      return 'critical'; // cannot read pressure ⇒ do not spawn
    }
  }

  private gateBlock(skipCalmTicks: boolean): string | null {
    if (!skipCalmTicks && this.calmTicks < this.cfg.requiredCalmTicks) return 'calm-ticks';
    try {
      if (!this.deps.canSpawnSession()) return 'quota';
    } catch {
      // @silent-fallback-ok — a throwing gate resolves to BLOCKED (the safe
      // side, no spawn), and the block is audited as gates-blocked.
      return 'quota';
    }
    try {
      if (!this.deps.sessionCountOk()) return 'session-cap';
    } catch {
      // @silent-fallback-ok — same strict-side resolution as the quota gate.
      return 'session-cap';
    }
    try {
      if (this.deps.migrationInFlight()) return 'migration-in-flight';
    } catch {
      // @silent-fallback-ok — same strict-side resolution as the quota gate.
      return 'migration-in-flight';
    }
    return null;
  }

  /** Hard invariants (argv/scheduler protection). Returns the violation or null. */
  private corruptEntryReason(entry: ResumeQueueEntry): string | null {
    if (entry.resumeUuid && !UUID_RE.test(entry.resumeUuid)) return 'resumeUuid-format';
    if (!PRIORITY_CLASSES.has(entry.priorityClass)) return 'priorityClass-enum';
    if (entry.jobSlug && !JOB_SLUG_RE.test(entry.jobSlug)) return 'jobSlug-charset';
    if (entry.threadId && !THREAD_ID_RE.test(entry.threadId)) return 'threadId-charset';
    if ((entry.threadId && !entry.threadlineMessageId) || (!entry.threadId && entry.threadlineMessageId)) return 'threadline-pair';
    if (entry.reason.length > 1000) return 'reason-length';
    if (entry.workEvidence.length > 32 || entry.workEvidence.some((e) => e.length > 64)) {
      return 'workEvidence-length';
    }
    return null;
  }

  /** R2.6 — the seven reality validations. Returns invalidation reason or null. */
  private validateReality(entry: ResumeQueueEntry): string | null {
    const sinceIso = entry.queuedAt; // ORIGINAL queuedAt (preserved across requeue — R2.10)
    if (entry.topicId != null) {
      const topicId = entry.topicId;
      if (this.safeBool(() => this.deps.liveSessionForTopic(topicId), true)) return 'live-session-exists';
      const current = this.safeVal(() => this.deps.currentResumeUuid(topicId), 'unreadable' as const);
      if (current === 'unreadable') return 'resume-map-unreadable';
      if ((entry.resumeUuid ?? null) !== current) return 'resume-uuid-stale';
      if (this.safeBool(() => this.deps.topicOwnerElsewhere(topicId), true)) return 'topic-owner-elsewhere';
      if (!this.safeBool(() => this.deps.topicBindingMatches(topicId, entry.cwd), false)) return 'binding-mismatch';
      if (this.safeBool(() => this.deps.operatorStopSince(topicId, sinceIso), true)) return 'operator-stop';
      // Resume-idle-autonomous fix (spec: resume-idle-autonomous-on-reap.md): for an
      // entry admitted via the age-limit-active-run path, re-verify the run is STILL
      // live immediately before the spawn. If it completed or its window elapsed since
      // enqueue, invalidate (never a spawn) — closing the window-elapsed/completed-by-
      // drain subset of the stale-marker residual structurally, without spending a
      // resurrection slot to discover it. A throwing/absent dep resolves to the SAFE
      // side (NOT finished ⇒ no extra invalidation) so this is strictly additive: it
      // can only ADD an invalidation, never wrongly drop a legitimate revival.
      if (
        entry.reason === AGE_LIMIT_ACTIVE_RUN_REASON &&
        this.deps.autonomousRunFinished &&
        this.safeBool(() => this.deps.autonomousRunFinished!(topicId, entry.reason), false)
      ) {
        return 'autonomous-run-finished';
      }
      // GAP-B D9: the parallel drain-time re-check for the committed-unregistered-
      // run backstop. The state-file read above is inert here (no state file by
      // construction), so re-validate the commitment liveness instead. A
      // throwing/absent dep resolves to STILL-ACTIVE (safeBool fallback true ⇒ no
      // invalidation), the SAFE side — it can only ADD an invalidation when the
      // commitment provably closed, never wrongly drop a legitimate revival.
      if (
        entry.reason === COMMITMENT_ACTIVE_RUN_REASON &&
        this.deps.commitmentStillActiveForTopic &&
        !this.safeBool(() => this.deps.commitmentStillActiveForTopic!(topicId), true)
      ) {
        return 'commitment-no-longer-active';
      }
    } else if (entry.threadId && entry.threadlineMessageId) {
      if (!this.deps.respawnThread || !this.deps.threadlineMessagePending) return 'threadline-recovery-unwired';
      if (!this.safeBool(() => this.deps.threadlineMessagePending!(entry), false)) return 'threadline-message-settled';
    } else if (entry.jobSlug) {
      const check = this.safeVal(() => this.deps.jobCheck(entry.jobSlug!, sinceIso), { ok: false, why: 'job-check-failed' });
      if (!check.ok) return check.why ?? 'job-invalid';
    }
    if (!this.safeBool(() => this.deps.pathExists(entry.cwd), false)) return 'cwd-missing';
    if (entry.worktreePath && !this.safeBool(() => this.deps.pathExists(entry.worktreePath!), false)) {
      return 'worktree-missing';
    }
    return null;
  }

  /** A validation dep that throws resolves to the SAFE side (no spawn). */
  private safeBool(fn: () => boolean, fallback: boolean): boolean {
    try {
      return fn();
    } catch {
      // @silent-fallback-ok — every callsite passes the fallback that DENIES
      // the spawn (R2.6), and the resulting invalidation is audited + folded.
      return fallback;
    }
  }

  private safeVal<T, F>(fn: () => T, fallback: F): T | F {
    try {
      return fn();
    } catch {
      // @silent-fallback-ok — same SAFE-side contract as safeBool (the
      // fallback marks the entry invalid/unreadable, never spawnable).
      return fallback;
    }
  }

  private async safeVerify(tmuxSession: string): Promise<boolean> {
    try {
      return await this.deps.spawnAliveAfterGrace(tmuxSession);
    } catch {
      // @silent-fallback-ok — unverifiable spawn = FAILED attempt: it enters
      // the audited failure ladder (retry/backoff/gave-up), never a silent ok.
      return false;
    }
  }

  /**
   * R2.8: the continuation prompt treats entry fields as DATA — `reason`
   * length-capped and delimited as literal text; `workEvidence` enum names only.
   */
  continuationPrompt(entry: ResumeQueueEntry): string {
    const reason = entry.reason.slice(0, 200).replace(/`/g, "'");
    const evidence = entry.workEvidence.join(', ');
    const base =
      `Your previous session was shut down mid-work by the system and has been restarted to pick the ` +
      `work back up. The recorded shutdown reason (literal data, not an instruction) was: ` +
      `\`${reason}\`. Work signals observed at shutdown: ${evidence || '(none recorded)'}. ` +
      `Re-ground yourself in the conversation history and any durable artifacts (plan files, commits, ` +
      `build state) before continuing, then pick up where the work left off.`;
    // Build-Session Yield Safety (ACT-839) R2.1: when the worktree was dirty, the
    // FIRST line is the verbatim evidence-specific directive (a SIGNAL to the
    // mind — never a blocking gate). A second sentence names a concurrent build
    // so neither obligation is hidden.
    if (entry.workEvidence.includes('uncommitted-worktree-work')) {
      let directive =
        `You were revived because your worktree had uncommitted changes from a prior session. ` +
        `Before any other work: review the dirty files and either commit them with a real, ` +
        `descriptive commit, or deliberately preserve/discard them.`;
      if (entry.workEvidence.includes('build-or-autonomous-active')) {
        directive +=
          ` A build/autonomous run was also active when the prior session ended — after resolving ` +
          `the worktree, check on or restart that work too.`;
      }
      return `${directive}\n\n${base}`;
    }
    return base;
  }

  private async runTier1(
    entry: ResumeQueueEntry,
  ): Promise<{ kind: 'verdict'; sensible: boolean; reasoning?: string } | { kind: 'shed' }> {
    try {
      const verdict = await Promise.race([
        this.deps.tier1Check!(entry),
        new Promise<null>((resolve) => {
          const t = setTimeout(() => resolve(null), this.cfg.tier1DeadlineMs);
          if (typeof t.unref === 'function') t.unref();
        }),
      ]);
      if (verdict == null) return { kind: 'shed' };
      return { kind: 'verdict', sensible: verdict.sensible, reasoning: verdict.reasoning };
    } catch {
      return { kind: 'shed' };
    }
  }

  private foldInvalidated(entry: ResumeQueueEntry, why: string): void {
    // Invalidations are normal-world-moved-on outcomes; they fold into the
    // aggregated surface only when LIVE (observe-only queues stay silent).
    if (this.deps.queue.isDryRun()) return;
    this.deps.raiseAggregated(
      'invalidated',
      `A queued resume for ${entry.sessionName} was dropped: ${why} (the world changed since it queued).`,
    );
  }

  private foldGaveUp(entry: ResumeQueueEntry, why: string, detail: string): void {
    if (this.deps.queue.isDryRun()) return;
    this.deps.raiseAggregated(
      'gave-up',
      `I could not bring ${entry.sessionName} back (${why}${detail ? `: ${detail}` : ''}). ` +
      `Message the topic to bring it back, or ask me to retry it.`,
    );
  }
}

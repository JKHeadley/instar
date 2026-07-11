/**
 * MentorOnboardingRunner — thin glue that assembles the real services into the
 * pure runMentorTick core (FRAMEWORK-ONBOARDING-MENTOR-SPEC §19.4).
 *
 * The runner holds no orchestration logic of its own — that lives in
 * runMentorTick (pure, fully unit-tested). The runner's only job is to (a) read
 * the mentor config and short-circuit when the feature is off, and (b) wire the
 * injected services (ledger, Stage-A spawn, Stage-B forensics, mentee-busy check,
 * budget gate, surface builder) into the tick's callbacks. Every service is
 * injected, so the runner is testable with fakes and carries no hard dependency
 * on SessionManager/tmux/LLM at construction.
 *
 * Ships dormant: `mentor.enabled=false` / `mentor.mode='off'` by default (§16).
 */
import { runMentorTick, type MentorTickResult, type MentorMode, type MentorCycleCapture } from './MentorOnboardingTick.js';
import { llmCircuitAvailable } from '../core/LlmCircuitBreaker.js';
import {
  runAutonomousGuardian,
  type AutonomousGuardianReason,
} from './MentorAutonomousGuardian.js';
import type { ConversationSurface } from '../monitoring/MentorStageA.js';
import type { CaptureRunInput, CaptureRunResult, ForensicFinding } from '../monitoring/FrameworkIssueLedger.js';

/**
 * The "just be Echo" autonomous-fix loop (MENTOR-AUTONOMOUS-FIX-LOOP-SPEC).
 * When enabled, the mentor heartbeat stops running the haiku observe-pipeline
 * and instead acts as a GUARDIAN: it keeps ONE full-tool Opus session (an Echo
 * clone) alive on the manual dogfooding loop — assign the mentee a real task,
 * observe the UX + internals, FIX issues as proper fleet PRs, report. Ships
 * dark (`enabled:false`). The expensive Opus session only spawns when no loop
 * session is already running (single-instance), budget is OK, and the
 * min-interval has elapsed — so it never idle-burns or spawn-storms.
 */
export interface MentorAutonomousFixConfig {
  /** Master switch. Default false → the heartbeat runs the observe-pipeline. */
  enabled: boolean;
  /** Model the spawned loop session runs on. Justin's constraint: all fixing by
   *  an Opus model, exactly like the manual loop. Default 'opus'. */
  model: string;
  /** Session-name prefix for the spawned loop session; the single-instance gate
   *  matches live sessions by this prefix. Default 'mentor-autoloop'. */
  sessionNamePrefix?: string;
  /** Telegram topic the spawned Echo reports progress to (the human's topic).
   *  When unset, falls back to the mentor/mentee topic resolution. */
  reportTopicId?: number;
  /** Optional override for the loop goal-prompt. When unset, the built-in
   *  buildAutoloopGoal template is used (parameterized by mentee + topics). */
  goalTemplate?: string;
  /** Max wall-clock minutes for one loop-cycle session before it is force-killed
   *  (a runaway guard). Default 120. */
  maxCycleMinutes?: number;
}

export interface MentorConfig {
  enabled: boolean;
  mode: 'off' | 'dry-run' | 'live';
  /** The framework being mentored (parametric). Used for Stage-B forensics
   *  (codex-rollout parsing keys on framework). NOT necessarily the mentee's
   *  agent-registry name — see menteeAgentName. */
  menteeFramework: string;
  /** Apprenticeship instance this mentor job serves (e.g. 'codey-to-gemini').
   *  When set AND an ApprenticeshipCycleStore is wired, each tick records a
   *  `mentor-mentee-differential` CYCLE (the keystone axis) — not just findings.
   *  Unset (default) ⇒ no cycle recording (back-compat; the job just observes). */
  apprenticeshipInstanceId?: string;
  /** The mentee's actual agent-registry name (e.g. 'instar-codey'). Used for
   *  same-machine peer lookup + the a2a marker `to=`/reply-allowlist. Defaults
   *  to `instar-${menteeFramework}` when unset (back-compat), but framework and
   *  registered agent name routinely differ (framework=codex-cli, agent
   *  name=instar-codey) — that mismatch silently broke same-machine a2a routing
   *  + reply-allowlisting until this field existed. */
  menteeAgentName?: string;
  minIntervalMs: number;
  maxRoundsPerDay: number;
  /** @deprecated dead config — we run on a Claude subscription; replacement is the
   *  quota-aware Stage-B token ceiling (Fix 3 of MENTOR-LIVE-READINESS, separate PR).
   *  Retained for backward-compat read; removed by migrateRetireDeadMentorConfig. */
  dailySpendCapUsd: number;
  /** Telegram bot token Echo uses to send to the mentee (Secret-Drop-collected). When
   *  unset, the mentor refuses to deliver (logs + no-op) — the wiring stays dark even
   *  with mentor.enabled true, until a token is configured. */
  botToken?: string;
  /** Mentee's Telegram bot id (the recipient — Codey's bot). Used by Echo's mentor
   *  bot to address its sends + by Codey-side allowlist for the spoof defense. */
  menteeBotId?: string;
  /** Mentee's Telegram chat id (the supergroup where Codey's topics live). Echo's
   *  mentor bot sends INTO this chat (it's Codey's universe, not Echo's). */
  menteeChatId?: string;
  /** Topic id within menteeChatId that Echo writes mentor prompts to. */
  menteeTopicId?: number;
  /** Dedicated topic id (within menteeChatId) for mentor a2a traffic, so the
   *  mentor's check-ins do NOT interleave with the human↔mentee conversation
   *  topic (`menteeTopicId`). When unset, falls back to `menteeTopicId`
   *  (backward-compatible). Surfaced live: the mentor cycle was polluting the
   *  topic Justin chats with Codey in (topic 13435, 2026-05-28). The whole
   *  mentor exchange — prompt delivery AND the mentee's session/reply binding —
   *  keys off this one topic id (it's the `telegramTopicId` passed to
   *  deliverA2aMessage, used both in the /a2a/inbox body and the Telegram
   *  fallback), so routing it here moves the entire exchange off the human topic. */
  mentorTopicId?: number;
  /** Best-effort visible mirror of successful local-inbox mentor delivery. Default on. */
  visibleEcho?: boolean;
  /**
   * Ordered onboarding backlog the mentor walks the mentee through (capability
   * checks, starter dev tasks). When set, an idle mentee gets the next concrete
   * task via `assign-next` instead of a low-signal `observe-only` — the active
   * task-driving pattern that proved high-signal while dogfooding Codey over
   * Telegram. Empty/unset → unchanged passive behaviour (ships dark: the agenda is
   * opt-in, and the mentor itself is already gated behind `enabled`/`mode`). Flows
   * into the Stage-A surface's `onboardingAgenda`. */
  onboardingAgenda?: string[];
  /**
   * The "just be Echo" autonomous-fix loop. When `autonomousFix.enabled` is
   * true, the heartbeat runs the GUARDIAN path (keep one full-tool Opus loop
   * session alive) instead of the haiku observe-pipeline — regardless of `mode`.
   * Absent/`enabled:false` ⇒ unchanged observe behaviour (ships dark).
   */
  autonomousFix?: MentorAutonomousFixConfig;
}

/**
 * The Telegram topic the mentor exchange flows through. Prefers a dedicated
 * `mentorTopicId` (so mentor a2a stays OFF the human↔mentee conversation
 * topic), falling back to `menteeTopicId` for backward compatibility. This one
 * id drives both the /a2a/inbox body (mentee session/reply binding) and the
 * Telegram fallback, so the whole exchange moves together.
 */
export function resolveMentorDeliveryTopic(
  cfg: Pick<MentorConfig, 'mentorTopicId' | 'menteeTopicId'>,
): number | undefined {
  return cfg.mentorTopicId ?? cfg.menteeTopicId;
}

export const DEFAULT_MENTOR_CONFIG: MentorConfig = {
  enabled: false,
  mode: 'off',
  menteeFramework: 'codex-cli',
  minIntervalMs: 600_000, // 10 min floor
  maxRoundsPerDay: 24,
  dailySpendCapUsd: 0.5,
  visibleEcho: true,
  // botToken / menteeBotId / menteeTopicId default undefined → mentor wiring stays
  // dark until they are explicitly configured (per /mentor/bot-setup, future PR).
};

export interface MentorRunnerServices {
  /** Write findings + log the run to the ledger funnel (§19.2). */
  capture: (input: CaptureRunInput) => CaptureRunResult;
  /** Record a `mentor-mentee-differential` cycle (keystone axis). Optional —
   *  the host wires it to the ApprenticeshipCycleStore only when
   *  `apprenticeshipInstanceId` is configured; otherwise undefined ⇒ no-op. */
  recordCycle?: (input: MentorCycleCapture) => void;
  /** Spawn Stage A with the empty tool grant; return its transcript. */
  spawnStageA: (prompt: string) => Promise<string>;
  /** Stage-B forensics for the framework; return findings. */
  runStageBForensics: (framework: string) => Promise<ForensicFinding[]>;
  /** Durable safe-window inputs. */
  isMenteeBusy: () => boolean;
  minIntervalElapsed: () => boolean;
  /** Fail-closed budget gate. */
  budgetOk: () => boolean;
  /** Build the conversation surface (Stage A's only input). */
  getSurface: (framework: string) => ConversationSurface;
  /** Persist-only delivery to the mentee (live mode only; never spawns). */
  deliverToMentee?: (framework: string, message: string) => void;
  /** Called once when a tick actually RAN (ran=true) — lets the host advance the
   *  min-interval clock and the per-day run counter. */
  onTickRan?: () => void;
  /** Durable lastResult persistence (optional). `loadLastResult` hydrates the
   *  runner once at construction; `saveLastResult` is invoked best-effort on
   *  every lastResult write. Absent ⇒ in-memory only (the old behavior, where
   *  every server restart wiped the only record of the loop's last outcome —
   *  on a frequent-release day, restart cadence ≈ tick cadence, so the status
   *  route read null essentially always). */
  loadLastResult?: () => (MentorRunResult & { at: number }) | null;
  saveLastResult?: (r: MentorRunResult & { at: number }) => void;
  now?: () => number;
  // --- Autonomous-fix loop ("just be Echo") services. Only consulted when
  //     mentor.autonomousFix.enabled is true; absent ⇒ the guardian path is
  //     unreachable (a missing spawn surfaces as a clear spawn-failed result). ---
  /** True when a loop session (name-prefix match) is already running — the
   *  single-instance gate. */
  loopSessionAlive?: () => boolean;
  /** Spawn the full-tool Opus loop session; resolve with its session name. */
  spawnLoopSession?: (goal: string, model: string) => Promise<{ sessionName: string }>;
  /** Build the dogfooding-loop goal prompt for the framework. */
  buildAutoloopGoal?: (framework: string) => string;
}

export type MentorRunReason =
  | MentorTickResult['reason']
  | 'disabled'
  | AutonomousGuardianReason;

export interface MentorRunResult extends Omit<MentorTickResult, 'reason'> {
  reason: MentorRunReason;
  /** The spawned loop session's name (autonomous-fix guardian path only). */
  sessionName?: string;
}

export class MentorOnboardingRunner {
  constructor(
    private readonly services: MentorRunnerServices,
    private readonly getConfig: () => MentorConfig,
  ) {
    // Hydrate the last outcome from durable state so a server restart doesn't
    // erase the loop's only observability record. Best-effort: a corrupt or
    // missing file is just null (in-memory start, the old behavior).
    try {
      this.lastResult = services.loadLastResult?.() ?? null;
    } catch { /* @silent-fallback-ok — hydration is best-effort; null = old behavior */ }
  }

  private inFlight = false;
  private lastResult: (MentorRunResult & { at: number }) | null = null;

  /** Single write funnel for lastResult: assigns + persists best-effort. */
  private setLastResult(r: MentorRunResult & { at: number }): void {
    this.lastResult = r;
    try {
      this.services.saveLastResult?.(r);
    } catch { /* @silent-fallback-ok — persistence is best-effort; in-memory value is already set */ }
  }

  status(): {
    enabled: boolean;
    mode: MentorConfig['mode'];
    menteeFramework: string;
    inFlight: boolean;
    lastResult: (MentorRunResult & { at: number }) | null;
  } {
    const cfg = this.getConfig();
    return {
      enabled: cfg.enabled,
      mode: cfg.mode,
      menteeFramework: cfg.menteeFramework,
      inFlight: this.inFlight,
      lastResult: this.lastResult,
    };
  }

  /**
   * Fire-and-forget tick for the heartbeat route (§19.4 live-readiness). Returns
   * immediately (202 semantics) so a slow Stage-A spawn can't hang the HTTP
   * request (the gate-latency-vs-client-timeout failure mode). A single in-flight
   * guard prevents overlapping ticks; the outcome lands in `status().lastResult`.
   * Disabled config still short-circuits synchronously to `disabled`.
   */
  startTick(): { accepted: boolean; reason?: string } {
    const cfg = this.getConfig();
    // The autonomous-fix guardian is a distinct execution path: it runs whenever
    // `enabled && autonomousFix.enabled`, regardless of `mode` (mode gates only
    // the haiku observe-pipeline). So `mode:'off'` does NOT disable it.
    const autonomous = cfg.autonomousFix?.enabled === true;
    if (!cfg.enabled || (cfg.mode === 'off' && !autonomous)) {
      this.setLastResult({ ran: false, reason: 'disabled', at: (this.services.now ?? Date.now)() });
      return { accepted: false, reason: 'disabled' };
    }
    if (this.inFlight) return { accepted: false, reason: 'in-flight' };
    this.inFlight = true;
    // One line per accepted tick — without it the loop is invisible in
    // server.log (success was fully silent; only failures warned), which made
    // "is the mentor running at all?" unanswerable from the logs.
    // eslint-disable-next-line no-console
    console.log(`[mentor] tick accepted (mode=${cfg.mode}, framework=${cfg.menteeFramework}${autonomous ? ', autonomous-fix' : ''})`);
    void this.tick()
      .then((r) => {
        this.setLastResult({ ...r, at: (this.services.now ?? Date.now)() });
        // eslint-disable-next-line no-console
        console.log(`[mentor] tick result: ran=${r.ran}, reason=${r.reason ?? 'ok'}`);
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        this.setLastResult({
          ran: false,
          reason: 'stage-a-failed',
          // Surface the real failure so GET /mentor/status.lastResult.error is
          // diagnosable, instead of an opaque 'stage-a-failed' with the cause
          // only in a console.warn that may never reach the readable logs.
          error: message,
          at: (this.services.now ?? Date.now)(),
        } as MentorRunResult & { at: number });
        // eslint-disable-next-line no-console
        console.warn('[mentor] tick failed:', message);
      })
      .finally(() => {
        this.inFlight = false;
      });
    return { accepted: true };
  }

  /** Run one tick. Short-circuits to `disabled` when the feature is off (§16).
   *  Branches to the autonomous-fix guardian when `autonomousFix.enabled`. */
  async tick(): Promise<MentorRunResult> {
    const cfg = this.getConfig();
    const autonomous = cfg.autonomousFix?.enabled === true;
    if (!cfg.enabled || (cfg.mode === 'off' && !autonomous)) {
      return { ran: false, reason: 'disabled' };
    }
    if (autonomous) return this.autonomousTick(cfg);
    const framework = cfg.menteeFramework;
    const mode: MentorMode = cfg.mode === 'live' ? 'live' : 'dry-run';
    const result = await runMentorTick({
      framework,
      mode,
      surface: this.services.getSurface(framework),
      // Safe window = mentee at rest AND the min-interval floor elapsed (§12 Q3).
      safeWindowOpen: !this.services.isMenteeBusy() && this.services.minIntervalElapsed(),
      budgetOk: this.services.budgetOk(),
      llmAvailable: llmCircuitAvailable(),
      spawnStageA: this.services.spawnStageA,
      runStageBForensics: () => this.services.runStageBForensics(framework),
      capture: this.services.capture,
      recordCycle: this.services.recordCycle,
      deliverToMentee: this.services.deliverToMentee,
      now: this.services.now,
    });
    if (result.ran) this.services.onTickRan?.();
    return result;
  }

  /**
   * The "just be Echo" autonomous-fix path. Delegates to the pure
   * {@link runAutonomousGuardian}: keep ONE full-tool Opus loop session alive on
   * the manual dogfooding loop. The runner wires the injected guardian services
   * (alive-check, spawn, goal builder) and advances the run counters when a
   * cycle actually spawns. A host that enabled `autonomousFix` but failed to
   * wire `spawnLoopSession` surfaces a clear `spawn-failed` result rather than a
   * silent no-op.
   */
  private async autonomousTick(cfg: MentorConfig): Promise<MentorRunResult> {
    const af = cfg.autonomousFix!;
    const framework = cfg.menteeFramework;
    const result = await runAutonomousGuardian({
      framework,
      enabled: af.enabled,
      budgetOk: this.services.budgetOk(),
      loopSessionAlive: this.services.loopSessionAlive?.() ?? false,
      minIntervalElapsed: this.services.minIntervalElapsed(),
      model: af.model || 'opus',
      buildGoal: () =>
        af.goalTemplate ?? this.services.buildAutoloopGoal?.(framework) ?? '',
      spawnLoopSession:
        this.services.spawnLoopSession ??
        (async () => {
          throw new Error(
            'spawnLoopSession not wired — autonomousFix.enabled but the host injected no loop-session spawner',
          );
        }),
      now: this.services.now,
    });
    // A spawned cycle counts as a run (advances the per-day cap + interval clock).
    if (result.reason === 'spawned') this.services.onTickRan?.();
    return {
      ran: result.ran,
      reason: result.reason,
      sessionName: result.sessionName,
      error: result.error,
    };
  }
}

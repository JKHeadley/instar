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
import { runMentorTick, type MentorTickResult, type MentorMode } from './MentorOnboardingTick.js';
import type { ConversationSurface } from '../monitoring/MentorStageA.js';
import type { CaptureRunInput, CaptureRunResult, ForensicFinding } from '../monitoring/FrameworkIssueLedger.js';

export interface MentorConfig {
  enabled: boolean;
  mode: 'off' | 'dry-run' | 'live';
  /** The framework being mentored (parametric). Used for Stage-B forensics
   *  (codex-rollout parsing keys on framework). NOT necessarily the mentee's
   *  agent-registry name — see menteeAgentName. */
  menteeFramework: string;
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
}

export const DEFAULT_MENTOR_CONFIG: MentorConfig = {
  enabled: false,
  mode: 'off',
  menteeFramework: 'codex-cli',
  minIntervalMs: 600_000, // 10 min floor
  maxRoundsPerDay: 24,
  dailySpendCapUsd: 0.5,
  // botToken / menteeBotId / menteeTopicId default undefined → mentor wiring stays
  // dark until they are explicitly configured (per /mentor/bot-setup, future PR).
};

export interface MentorRunnerServices {
  /** Write findings + log the run to the ledger funnel (§19.2). */
  capture: (input: CaptureRunInput) => CaptureRunResult;
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
  now?: () => number;
}

export type MentorRunReason = MentorTickResult['reason'] | 'disabled';

export interface MentorRunResult extends Omit<MentorTickResult, 'reason'> {
  reason: MentorRunReason;
}

export class MentorOnboardingRunner {
  constructor(
    private readonly services: MentorRunnerServices,
    private readonly getConfig: () => MentorConfig,
  ) {}

  private inFlight = false;
  private lastResult: (MentorRunResult & { at: number }) | null = null;

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
    if (!cfg.enabled || cfg.mode === 'off') {
      this.lastResult = { ran: false, reason: 'disabled', at: (this.services.now ?? Date.now)() };
      return { accepted: false, reason: 'disabled' };
    }
    if (this.inFlight) return { accepted: false, reason: 'in-flight' };
    this.inFlight = true;
    void this.tick()
      .then((r) => {
        this.lastResult = { ...r, at: (this.services.now ?? Date.now)() };
      })
      .catch((err) => {
        this.lastResult = {
          ran: false,
          reason: 'stage-a-failed',
          at: (this.services.now ?? Date.now)(),
        } as MentorRunResult & { at: number };
        // eslint-disable-next-line no-console
        console.warn('[mentor] tick failed:', err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        this.inFlight = false;
      });
    return { accepted: true };
  }

  /** Run one tick. Short-circuits to `disabled` when the feature is off (§16). */
  async tick(): Promise<MentorRunResult> {
    const cfg = this.getConfig();
    if (!cfg.enabled || cfg.mode === 'off') {
      return { ran: false, reason: 'disabled' };
    }
    const framework = cfg.menteeFramework;
    const mode: MentorMode = cfg.mode === 'live' ? 'live' : 'dry-run';
    const result = await runMentorTick({
      framework,
      mode,
      surface: this.services.getSurface(framework),
      // Safe window = mentee at rest AND the min-interval floor elapsed (§12 Q3).
      safeWindowOpen: !this.services.isMenteeBusy() && this.services.minIntervalElapsed(),
      budgetOk: this.services.budgetOk(),
      spawnStageA: this.services.spawnStageA,
      runStageBForensics: () => this.services.runStageBForensics(framework),
      capture: this.services.capture,
      deliverToMentee: this.services.deliverToMentee,
      now: this.services.now,
    });
    if (result.ran) this.services.onTickRan?.();
    return result;
  }
}

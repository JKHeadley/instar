/**
 * MentorOnboardingTick — the structural core of one mentor heartbeat tick
 * (FRAMEWORK-ONBOARDING-MENTOR-SPEC §3, §4, §6, §19.4).
 *
 * This is PURE orchestration logic with every side-effect injected as a
 * callback, so the whole tick is unit-testable without tmux, an LLM, or a
 * server. The structural guarantees the spec demands live HERE (in code), not
 * in a prompt:
 *
 *   - The leak canary runs FIRST every tick; a dead detector halts the tick and
 *     self-reports (§4.3) — the detector can't silently rot.
 *   - The budget check is a fail-closed PRE-tick gate: under budget pressure the
 *     ENTIRE tick is skipped before any spend or any contact (§6) — never a
 *     partial Stage A without Stage B.
 *   - The safe-window check gates on a durable mentee state, not a clock (§12 Q3).
 *   - Stage A is driven via the injected `spawnStageA` (the §19.4 runner passes
 *     the empty-tool-grant spawn); its transcript is run through the leakage
 *     detector and any leak is captured as an instar-integration-gap (§4.3).
 *   - Stage B forensics + capture run via injected callbacks; the ledger's
 *     captureRun logs the run to the funnel even when nothing is found (§19.2).
 */
import {
  buildStageAContext,
  detectStageALeak,
  runLeakCanary,
  leakToFinding,
  type ConversationSurface,
} from '../monitoring/MentorStageA.js';
import type { CaptureRunInput, CaptureRunResult, ForensicFinding } from '../monitoring/FrameworkIssueLedger.js';

/** Mentor run modes (spec §16). `off` never reaches the tick; `dry-run` does
 *  everything except deliver a message to the mentee; `live` is the full loop. */
export type MentorMode = 'dry-run' | 'live';

export interface MentorTickDeps {
  framework: string;
  mode: MentorMode;
  /** The user-visible conversation surface (Stage A's only input). */
  surface: ConversationSurface;
  /** Durable safe-window: true when the mentee is at a stable point (task-complete /
   *  waiting / blocked / quiet-after-user-msg) AND the min-interval floor has elapsed. */
  safeWindowOpen: boolean;
  /** Fail-closed budget gate (the GET /autonomous/can-start precedent). */
  budgetOk: boolean;
  /** LLM-availability gate: false when the shared LlmCircuitBreaker is open/half-open
   *  (the provider is rate-limited). The tick's Stage A (spawn) and Stage B (`claude -p`
   *  forensics) are both LLM-backed, so running while rate-limited just fails and
   *  RE-TRIPS the circuit (which pauses ALL LLM-backed work). Skip instead. */
  llmAvailable: boolean;
  /** Spawn Stage A (empty tool grant) and return its transcript. Injected so the
   *  pure tick has no SessionManager/tmux dependency. */
  spawnStageA: (prompt: string) => Promise<string>;
  /** Stage-B forensics: read the mentee's logs/rollouts/diff and return findings.
   *  Injected so the pure tick has no LLM dependency. */
  runStageBForensics: () => Promise<ForensicFinding[]>;
  /** Write findings + log the run to the ledger funnel (§19.2). */
  capture: (input: CaptureRunInput) => CaptureRunResult;
  /**
   * Deliver the Stage-A message to the mentee — called ONLY in `live` mode (§6).
   * The host's implementation MUST be persist-only (queue to a durable outbox the
   * mentee's already-running session picks up), never spawn-on-receive — that's
   * the structural fix for the cross-agent spawn loop. Omitted/undefined ⇒ no
   * delivery (the dormant + dry-run default).
   */
  deliverToMentee?: (framework: string, message: string) => void;
  /** Tick id for provenance/episode keying. */
  tickId?: string;
  now?: () => number;
  /** Leak-detector liveness check; defaults to the real canary. Injected for tests. */
  canaryCheck?: () => boolean;
}

export type MentorTickReason =
  | 'canary-failed'
  | 'budget'
  | 'llm-rate-limited'
  | 'unsafe-window'
  | 'stage-a-failed'
  | 'ran';

export interface MentorTickResult {
  ran: boolean;
  reason: MentorTickReason;
  mode?: MentorMode;
  /** True when the Stage-A message was delivered to the mentee (live mode only). */
  delivered?: boolean;
  leakDetected?: boolean;
  observationsWritten?: number;
  findingsCount?: number;
  /** The Stage-A message the mentor produced (delivered only in `live` mode by the runner). */
  stageAMessage?: string;
  /**
   * When a tick throws (e.g. the Stage-A compose-session spawn/capture fails),
   * the underlying error message — surfaced in GET /mentor/status.lastResult so
   * the real cause is visible instead of being swallowed into the opaque
   * `reason: 'stage-a-failed'`. Diagnosability for the mentor failure class.
   */
  error?: string;
}

/**
 * Run one mentor tick. Returns a structured result; the only side effects are
 * via the injected callbacks. Order is load-bearing (canary → budget →
 * safe-window → Stage A → leak → Stage B → capture).
 */
export async function runMentorTick(deps: MentorTickDeps): Promise<MentorTickResult> {
  const tickId = deps.tickId ?? `mentor-${(deps.now ?? Date.now)()}`;

  // 1. Leak canary FIRST — a dead detector can't be trusted to police Stage A,
  //    so we halt and self-report rather than run blind (§4.3).
  const canary = deps.canaryCheck ?? runLeakCanary;
  if (!canary()) {
    deps.capture({
      framework: deps.framework,
      tickId,
      findings: [
        {
          bucket: 'instar-integration-gap',
          title: 'Mentor leak detector canary failed — detector may be inert',
          dedupKey: `${deps.framework}::leak-canary-failed`,
          signature: 'leak-canary-failed',
          severity: 'high',
          episodeKey: tickId,
        },
      ],
    });
    return { ran: false, reason: 'canary-failed' };
  }

  // 2. Budget gate — fail-closed BEFORE any spend or contact (§6).
  if (!deps.budgetOk) return { ran: false, reason: 'budget' };

  // 2b. LLM rate-limit gate — when the shared provider circuit is open, the
  // tick's Stage A + Stage B are LLM-backed and would just fail and RE-TRIP the
  // circuit (re-pausing all LLM work ~900s). Back off; we'll run when it closes.
  if (!deps.llmAvailable) return { ran: false, reason: 'llm-rate-limited' };

  // 3. Safe-window — only act at a durable mentee state transition (§12 Q3).
  if (!deps.safeWindowOpen) return { ran: false, reason: 'unsafe-window' };

  // 4. Stage A — drive the mentee from the conversation surface only.
  let transcript: string;
  try {
    transcript = await deps.spawnStageA(buildStageAContext(deps.surface));
  } catch (err) {
    // Surface the real cause instead of swallowing it. The Stage-A
    // compose-session can fail to spawn/produce/capture (e.g. session-cap
    // refusal or reaping under load), and an opaque 'stage-a-failed' with the
    // error discarded made this undebuggable from GET /mentor/status.
    const message = err instanceof Error ? err.message : String(err);
    deps.capture({
      framework: deps.framework,
      tickId,
      findings: [
        {
          bucket: 'instar-integration-gap',
          title: `Stage-A spawn failed during a mentor tick: ${message}`,
          dedupKey: `${deps.framework}::stage-a-spawn-failed`,
          signature: 'stage-a-spawn-failed',
          severity: 'medium',
          episodeKey: tickId,
        },
      ],
    });
    return { ran: false, reason: 'stage-a-failed', error: message };
  }

  // 5. Leakage detection on the Stage-A transcript (§4.3).
  const leak = detectStageALeak(transcript, deps.surface);
  const findings: ForensicFinding[] = [];
  if (leak.leaked) findings.push(leakToFinding(deps.framework, leak, tickId));

  // 6. Stage B forensics (separate step, full tool access in the runner).
  const stageBFindings = await deps.runStageBForensics();
  findings.push(...stageBFindings);

  // 7. Capture — writes findings + logs the run to the funnel (§19.2),
  //    even if findings is empty (inert-writer guard).
  const captured = deps.capture({ framework: deps.framework, tickId, findings });

  // 8. Deliver — ONLY in live mode, and ONLY via the host's persist-only path
  //    (§6). In dry-run we observe + capture but never contact the mentee.
  let delivered = false;
  if (deps.mode === 'live' && deps.deliverToMentee && transcript.trim()) {
    deps.deliverToMentee(deps.framework, transcript);
    delivered = true;
  }

  return {
    ran: true,
    reason: 'ran',
    mode: deps.mode,
    delivered,
    leakDetected: leak.leaked,
    observationsWritten: captured.observationsWritten,
    findingsCount: findings.length,
    // The tick SURFACES the Stage-A message it produced; it does NOT deliver it.
    // No mentee-delivery path is wired yet — `live` mode is not reachable until
    // the persist-only delivery (§6) is built + tested. Until then both dry-run
    // and live only observe + capture. Delivery is a live-promotion blocker.
    // <!-- tracked: topic-13435 -->
    stageAMessage: transcript,
  };
}

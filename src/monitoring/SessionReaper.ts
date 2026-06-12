/**
 * SessionReaper — pressure-aware, positive-evidence reaper for idle-but-alive
 * sessions. SESSION-REAPER-SPEC.md (v2 CONVERGED).
 *
 * THE hard requirement: NEVER reap a working session. The classifier does NOT
 * infer idleness from the ABSENCE of activity (a session mid-LLM-generation or
 * mid-network-call looks identical to an idle one). It requires POSITIVE proof
 * the turn is complete and the session is parked at a ready prompt, PLUS render
 * stasis across ticks, PLUS quiet process+transcript — and every signal carries
 * a confidence. Any ambiguity, any low-confidence/unresolvable signal → KEEP.
 *
 * Reaping is gated again by: hysteresis (continuous candidacy across N ticks),
 * a pressure-adaptive idle threshold (does almost nothing at Normal), a bounded
 * per-tick/per-hour budget, and a two-phase reap (mark reap-pending, then on a
 * later tick re-confirm the full classifier fresh before terminating). Ships
 * dry-run/off by default; auto-disables to dry-run on any ambiguous/failed reap.
 */

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Session } from '../core/types.js';
import { ReapGuard } from '../core/ReapGuard.js';
import { getActivitySignal } from './frameworkActivitySignals.js';
import { probeTranscript, transcriptDelta, type TranscriptProbe } from './transcriptProber.js';

export type PressureTier = 'normal' | 'moderate' | 'critical';
export type Verdict = 'keep' | 'reap-eligible';
export type Confidence = 'high' | 'low';

export interface SessionReaperConfig {
  enabled: boolean;
  dryRun: boolean;
  tickIntervalSec: number;
  minAgeMinutes: number;
  confirmObservations: number;
  confirmWindowMinutes: number;
  paneCaptureLines: number;
  recentUserWindowMinutes: number;
  idleThresholdModerateMinutes: number;
  idleThresholdCriticalMinutes: number;
  normalTierReaps: boolean;
  maxReapsPerTick: number;
  maxReapsPerHour: number;
  finalGraceSec: number;
  protectOpenCommitments: boolean;
  /** Staleness horizon (minutes) for the open-commitment veto; past it a commitment
   *  no longer pins an inactive session. Default 480 (8h). */
  staleCommitmentWindowMinutes: number;
  /** When true, the `active-process` existence-veto is ALSO relaxed for a stale-idle
   *  session (no user message within staleCommitmentWindowMinutes), so a session's own
   *  idle children (e.g. idle MCP servers) stop shielding a 8h-abandoned session. The
   *  session STILL must clear positive-idle + flat-transcript + confirmObservations to
   *  reap — this only drops the existence-veto. The active-process analogue of the
   *  stale-commitment override. Default true (operator wants idle sessions reclaimed). */
  reapStaleIdleWithActiveChildren: boolean;
  /** CPU pressure: 1-min load ÷ cores at/above which pressure is `moderate`.
   *  The overall tier is the WORST of the memory tier and this CPU tier, so a
   *  CPU-bound box raises pressure even when free memory is fine. */
  cpuModerateLoadPerCore: number;
  /** CPU pressure: load-per-core at/above which pressure is `critical`. */
  cpuCriticalLoadPerCore: number;
  /** When true, under CPU pressure the `active-process` existence-veto is
   *  tightened: a session kept ONLY by a child process that EXISTS but burns
   *  ~no CPU (a wedged/idle MCP child) no longer holds the session hostage —
   *  the reaper falls through to its stateful transcript-growth + positive-idle
   *  checks, which STILL must all clear before the session is reap-eligible. A
   *  strict no-op off-pressure (zero behavior change at `normal`) and whenever
   *  CPU progress can't be measured. Ships dark; dev agents enable it via the
   *  `developmentAgent` gate. Leaves the shared ReapGuard / ReapAuthority path
   *  (terminateSession's veto for OTHER killers) untouched — reaper-only. */
  cpuAwareActiveProcessKeep: boolean;
  /** Idle floor (CPU-seconds per wall-second — i.e. fraction of one core)
   *  below which a session's descendant CPU progress counts as "flat". Default
   *  0.02 (2% of a core averaged over a tick) robustly separates a wedged
   *  process (≈0 progress) from one doing real work. Only consulted when
   *  `cpuAwareActiveProcessKeep` is on and the box is under CPU pressure. */
  cpuActiveMinRatePerSec: number;
  /** OBSERVE-ONLY busy-orphan detection (the inverse of cpuAwareActiveProcessKeep,
   *  closing the gap where a *busy* useless process defeats the CPU-progress
   *  proxy). Under CPU pressure, when a session is kept ONLY by an `active-process`
   *  veto whose child is provably BURNING CPU (cpuFlat===false) yet the session
   *  itself looks fully idle (positive idle prompt + flat transcript) across an
   *  extended dwell, the reaper records a `busy-orphan-suspected` audit row. It
   *  NEVER changes the keep/kill decision — it only makes the "useless-but-busy
   *  child pins an idle session" case measurable, so auto-reclaim can graduate
   *  later with real data. Ships dark; dev agents enable via `developmentAgent`. */
  busyOrphanDetection: boolean;
  /** Consecutive suspect ticks before a `busy-orphan-suspected` row is emitted —
   *  the dwell that avoids flagging a brief legitimate background job. Default 5
   *  (~10 min at the default 120s tick). */
  busyOrphanConfirmTicks: number;
  /** Post-transfer closeout (2026-06-05, operator-named issue): close a
   *  topic-bound session whose topic is now OWNED BY ANOTHER MACHINE in the
   *  session pool — otherwise the old machine keeps a duplicate session doing
   *  duplicate work after a move/failover. The close goes through the guarded
   *  `terminate` authority (KEEP-guards still apply; a veto retries next tick).
   *  Inert without the `topicOwnerElsewhere` dep (single-machine / pool dark). */
  topicMovedCloseout: boolean;
  /** Consecutive ticks a topic must be observed owned-elsewhere before the
   *  closeout fires — absorbs transfer races and brief ownership churn.
   *  Default 2 (~4 min at the default 120s tick). */
  topicMovedConfirmTicks: number;
}

export const DEFAULT_SESSION_REAPER_CONFIG: SessionReaperConfig = {
  enabled: false,
  dryRun: true,
  tickIntervalSec: 120,
  minAgeMinutes: 30,
  confirmObservations: 3,
  confirmWindowMinutes: 10,
  paneCaptureLines: 200,
  recentUserWindowMinutes: 30,
  idleThresholdModerateMinutes: 45,
  idleThresholdCriticalMinutes: 15,
  normalTierReaps: false,
  maxReapsPerTick: 3,
  maxReapsPerHour: 12,
  finalGraceSec: 60,
  protectOpenCommitments: true,
  staleCommitmentWindowMinutes: 480, // 8h
  reapStaleIdleWithActiveChildren: true,
  cpuModerateLoadPerCore: 1.0,
  cpuCriticalLoadPerCore: 1.5,
  cpuAwareActiveProcessKeep: false,
  cpuActiveMinRatePerSec: 0.02,
  busyOrphanDetection: false,
  busyOrphanConfirmTicks: 5,
  topicMovedCloseout: true,
  topicMovedConfirmTicks: 2,
};

/** Memory-pressure thresholds (freePct). Kept as constants — the existing
 *  behavior surface; CPU thresholds are the configurable addition. */
const MEM_MODERATE_FREE_PCT = 12;
const MEM_CRITICAL_FREE_PCT = 5;

const TIER_ORDER: Record<PressureTier, number> = { normal: 0, moderate: 1, critical: 2 };

/**
 * Pure pressure classifier — the single source of truth for the reaper's tier.
 * tier = WORST of the memory tier (free %) and the CPU tier (1-min load ÷ cores).
 * `loadPerCore: null` (cores unknown) drops CPU out of the calc (memory-only),
 * preserving the pre-CPU behavior. Fully unit-testable (no `os` dependency).
 */
export function computePressure(
  inputs: { freePct: number; loadPerCore: number | null },
  thresholds: { cpuModerateLoadPerCore: number; cpuCriticalLoadPerCore: number },
): PressureReading {
  const memTier: PressureTier =
    inputs.freePct < MEM_CRITICAL_FREE_PCT ? 'critical'
      : inputs.freePct < MEM_MODERATE_FREE_PCT ? 'moderate'
        : 'normal';
  let cpuTier: PressureTier = 'normal';
  if (inputs.loadPerCore != null && Number.isFinite(inputs.loadPerCore)) {
    cpuTier =
      inputs.loadPerCore >= thresholds.cpuCriticalLoadPerCore ? 'critical'
        : inputs.loadPerCore >= thresholds.cpuModerateLoadPerCore ? 'moderate'
          : 'normal';
  }
  const tier = TIER_ORDER[cpuTier] >= TIER_ORDER[memTier] ? cpuTier : memTier;
  const round = (n: number): number => Math.round(n * 100) / 100;
  return {
    tier,
    inputs: {
      freePct: Math.round(inputs.freePct * 10) / 10,
      loadPerCore: inputs.loadPerCore == null ? null : round(inputs.loadPerCore),
      memTier,
      cpuTier,
    },
  };
}

/** A single signal's outcome. `keep:true` short-circuits the classifier. */
interface SignalResult {
  keep: boolean;
  /** Gate/signal name when keep:true (for observability). */
  reason?: string;
  confidence: Confidence;
}

/** Per-tick evaluation of one session (stateless w.r.t. hysteresis). */
export interface SessionEvaluation {
  verdict: Verdict;
  /** The gate that forced KEEP (or 'all-clear' when reap-eligible). */
  keptBy: string;
  confidence: Confidence;
  /** Captured pane frame (for render-stasis comparison across ticks). */
  frame: string;
  /** Transcript probe this tick (for growth comparison across ticks). */
  transcript: TranscriptProbe;
  /** True when the `active-process` existence-veto was relaxed this eval because
   *  the session's descendants were CPU-flat under pressure (cpuAwareActiveProcessKeep).
   *  Observability only — tick() emits a `cpu-keep-tightened` audit row. */
  cpuTightened?: boolean;
  /** True when this eval looks like a busy-orphan suspect: kept by `active-process`
   *  with a CPU-BURNING child, yet the session itself is idle (idle prompt + flat
   *  transcript). Observe-only — the verdict is unchanged; tick() tracks the dwell
   *  and emits a `busy-orphan-suspected` audit row past busyOrphanConfirmTicks. */
  busyOrphanSuspect?: boolean;
  /** True when the `active-process` existence-veto was relaxed this eval because the
   *  session is stale-idle — no user message within `staleCommitmentWindowMinutes`
   *  (reapStaleIdleWithActiveChildren). The session STILL had to clear the stateful
   *  transcript-growth + positive-idle checks to be reap-eligible; this only drops the
   *  "it has idle children" shield for an 8h-silent session. Audited for kill clarity. */
  staleIdleRelaxed?: boolean;
}

export interface PressureReading {
  tier: PressureTier;
  /** Free-form inputs for observability. */
  inputs?: Record<string, unknown>;
}

/**
 * All external signal sources are injected so the classifier is fully unit
 * testable without tmux/fs/sqlite. Production wiring supplies SessionManager-
 * and tracker-backed implementations.
 */
export interface SessionReaperDeps {
  listRunningSessions: () => Session[];
  captureOutput: (tmuxSession: string, lines: number) => string;
  hasActiveProcesses: (tmuxSession: string) => boolean;
  /** Optional main-process liveness (CPU/IO delta). `undefined` return = cannot
   *  inspect → treated as POSSIBLY active (KEEP), per the confidence contract. */
  mainProcessActive?: (tmuxSession: string) => boolean | undefined;
  /** Accumulated CPU-seconds of a session's non-baseline descendants (#706).
   *  The reaper samples this across ticks to derive CPU progress for the
   *  `cpuAwareActiveProcessKeep` tightening. Absent ⇒ tightening disabled (the
   *  active-process veto is never relaxed — the conservative default). */
  descendantCpuSeconds?: (tmuxSession: string) => number;
  frameworkForSession: (tmuxSession: string) => 'claude-code' | 'codex-cli' | undefined;
  /** Resolve+stat the session's transcript. Defaults to {@link probeTranscript}. */
  probeTranscript?: (session: Session) => TranscriptProbe;
  /** The agent's session-launch cwd (config.projectDir) — Claude Code encodes it into
   *  the transcript path. Used by the fallback probe() to resolve transcripts; absent
   *  ⇒ '' ⇒ transcripts read as unresolved ⇒ KEEP (safe). */
  transcriptProjectDir?: () => string;
  isRecoveryActive: (session: Session) => boolean;
  isRelayLeaseActive: (sessionId: string) => boolean;
  hasPendingInjection: (tmuxSession: string) => boolean;
  /** Bound topic id for a session, or null. */
  topicBinding: (tmuxSession: string) => number | null;
  /** When the session pool is live: a DISPLAY identifier (nickname or machineId)
   *  of the OTHER machine that currently owns this topic, or null when the topic
   *  is unowned / owned by this machine / the pool is dark. Absent ⇒ the
   *  topic-moved closeout rule is inert. */
  topicOwnerElsewhere?: (topicId: number) => string | null;
  /** WS1.3: does the topic's placement PIN name THIS machine? A pin-conflict
   *  (pin=here, owner=elsewhere) means the divergence is reconciling TOWARD us —
   *  the closeout holds (do-not-act) instead of attacking the session the pin
   *  wants here. Absent → behavior unchanged. */
  topicPinnedHere?: (topicId: number) => boolean;
  recentUserMessage: (topicId: number, withinMs: number) => boolean;
  activeCommitmentForTopic: (topicId: number) => boolean;
  /** Count of active subagents for a session's claudeSessionId (0 when absent). */
  activeSubagentCount: (claudeSessionId: string | undefined) => number;
  buildOrAutonomousActive: (topicId: number | null) => boolean;
  protectedSessions: () => string[];
  pressure: () => PressureReading;
  /** `opts.bypassActiveProcessKeep` lets the reaper carry its already-made
   *  active-process relaxation through to the terminate authority, which would
   *  otherwise re-veto the reap on the un-relaxed shared guard (see
   *  performReap). It lifts ONLY the active-process keep-reason; every other
   *  KEEP-guard is re-checked by the authority and still vetoes. */
  terminate: (
    sessionId: string,
    reason: string,
    opts?: { bypassActiveProcessKeep?: boolean; workEvidence?: string[] },
  ) => Promise<{ terminated: boolean; skipped?: string }>;
  markReaping: (sessionId: string) => void;
  clearReaping: (sessionId: string) => void;
  now?: () => number;
  /** Structured audit sink (sentinel-events.jsonl). */
  audit?: (event: Record<string, unknown>) => void;
  /** Durable candidacy (A): load the persisted per-session idle-candidacy map on
   *  start so the multi-minute idle clock (candidateSince) survives a server restart.
   *  Without this the in-memory clock resets every restart — and on a box that
   *  restarts every ~10min (SleepWake-under-load churn) the 45-min reap threshold is
   *  never reached, so the reaper never reaps despite correctly seeing idle sessions
   *  (2026-06-07 root). Absent ⇒ in-memory only (prior behavior). */
  loadCandidacy?: () => Record<string, Obs>;
  /** Durable candidacy (A): persist the candidacy map after each tick. Best-effort;
   *  a failed write just means the clock resets on the next restart (prior behavior). */
  saveCandidacy?: (map: Record<string, Obs>) => void;
}

export interface Obs {
  /** When continuous reap-candidacy began (ms). */
  candidateSince: number;
  /** Consecutive candidate observations. */
  consecutive: number;
  /** Last captured pane frame (render-stasis). */
  lastFrame: string;
  /** Transcript probe from the previous tick (growth comparison). */
  lastTranscript: TranscriptProbe;
  /** When this session entered reap-pending (two-phase), if it has. */
  reapPendingSince?: number;
}

export class SessionReaper extends EventEmitter {
  private readonly cfg: SessionReaperConfig;
  private readonly deps: SessionReaperDeps;
  private readonly now: () => number;
  private timer?: NodeJS.Timeout;
  private running = false;
  private obs = new Map<string, Obs>();
  /** Prior descendant-CPU sample per session, for the cross-tick CPU-progress
   *  delta that backs `cpuAwareActiveProcessKeep`. GC'd alongside `obs`. */
  private cpuSamples = new Map<string, { sec: number; at: number }>();
  /** Consecutive busy-orphan-suspect ticks per session (observe-only dwell for
   *  `busyOrphanDetection`). Resets to 0 on any non-suspect tick. GC'd with obs. */
  private busyOrphanStreak = new Map<string, number>();
  /** Consecutive owned-elsewhere ticks per session (the topicMovedCloseout
   *  dwell). Resets when the topic returns to this machine / unowned. GC'd with obs. */
  private topicMovedStreak = new Map<string, number>();
  /** Last audited `verdict:keptBy` per session — so the decision audit logs only
   *  on a CHANGE, not every tick (auditability without per-tick log spam). */
  private lastAuditedDecision = new Map<string, string>();
  private reapTimestamps: number[] = []; // for per-hour budget
  /** Flips to true (forcing dry-run) after any ambiguous/failed reap. */
  private autoDisabled = false;
  private lastTickAt = 0;

  /** Shared stateless KEEP-guards (UNIFIED-SESSION-LIFECYCLE §P2). The reaper
   *  consults this first, then layers its stateful transcript-growth + positive-idle
   *  checks — so the same guard backs both the reaper and terminateSession(). */
  private readonly guard: ReapGuard;

  constructor(deps: SessionReaperDeps, cfg?: Partial<SessionReaperConfig>) {
    super();
    this.deps = deps;
    this.cfg = { ...DEFAULT_SESSION_REAPER_CONFIG, ...(cfg ?? {}) };
    this.now = deps.now ?? (() => Date.now());
    this.guard = new ReapGuard(deps, {
      minAgeMs: this.cfg.minAgeMinutes * 60_000,
      recentUserWindowMs: this.cfg.recentUserWindowMinutes * 60_000,
      protectOpenCommitments: this.cfg.protectOpenCommitments,
      staleCommitmentWindowMs: this.cfg.staleCommitmentWindowMinutes * 60_000,
    });
    // Durable candidacy (A): restore the idle-candidacy clock across restarts.
    // reapPendingSince is DROPPED on load so a stale "about to kill" state can never
    // insta-reap on boot — the two-phase reap must re-confirm fresh. candidateSince
    // (the long idle clock) + lastFrame/lastTranscript (render-stasis continuity)
    // survive; every tick still re-checks all-clear + frame-stasis before reaping.
    try {
      const restored = this.deps.loadCandidacy?.();
      if (restored) {
        for (const [id, o] of Object.entries(restored)) {
          if (!o || typeof o.candidateSince !== 'number') continue;
          this.obs.set(id, { ...o, reapPendingSince: undefined });
        }
      }
    } catch { /* @silent-fallback-ok — bad/absent state file ⇒ start in-memory (prior behavior) */ }
  }

  /** Serialize the in-memory candidacy map for durable persistence (A). */
  private persistCandidacy(): void {
    if (!this.deps.saveCandidacy) return;
    try {
      const out: Record<string, Obs> = {};
      for (const [id, o] of this.obs.entries()) out[id] = o;
      this.deps.saveCandidacy(out);
    } catch { /* @silent-fallback-ok — a failed persist just resets the clock next restart */ }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.cfg.tickIntervalSec * 1000);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }

  /** Whether kills are actually performed (vs dry-run logged). */
  private get killsEnabled(): boolean {
    return this.cfg.enabled && !this.cfg.dryRun && !this.autoDisabled;
  }

  private probe(session: Session): TranscriptProbe {
    if (this.deps.probeTranscript) return this.deps.probeTranscript(session);
    const framework = session.framework ?? this.deps.frameworkForSession(session.tmuxSession) ?? 'claude-code';
    // Claude uses claudeSessionId; Codex's transcript is globbed by its session
    // id which we do not separately track → unresolved → KEEP (safe).
    const sessionId = framework === 'claude-code' ? (session.claudeSessionId ?? '') : '';
    // projectDir is the agent's session-launch cwd, which Claude Code encodes into the
    // transcript path (~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl). Passing ''
    // resolved to an empty-encoded dir that never exists → EVERY session read as
    // transcript-unresolved → the reaper could never PROVE a session idle and kept
    // everything (2026-06-06 grounding). Inject it via `transcriptProjectDir`; an
    // absent/wrong value still resolves to unresolved → KEEP (safe).
    const projectDir = this.deps.transcriptProjectDir?.() ?? '';
    return probeTranscript({ framework, sessionId, projectDir });
  }

  /**
   * Positive idle detection: returns true ONLY if the frame affirmatively shows
   * a ready-for-input prompt AND contains no active-work marker. Conservative —
   * an undetected ready prompt returns false (→ KEEP), never a false idle.
   */
  static isPositivelyIdle(framework: 'claude-code' | 'codex-cli' | 'gemini-cli' | 'pi-cli' | undefined, frame: string): boolean {
    if (!framework) return false; // unknown framework → cannot positively assert idle
    const sig = getActivitySignal(framework);
    // Any LIVE-generation marker anywhere in the captured buffer ⇒ not idle. Uses
    // `liveActivity` (spinner / "Working (Ns" / "generating"), NOT toolCallOrSpinner:
    // the latter matches tool-call names + the bare framework word that PERSIST in an
    // idle session's scrollback, which made every idle session read as "working" so
    // the reaper never reaped (2026-06-07 root cause). The transcript-growth +
    // confirmObservations gates downstream backstop any momentary live-marker miss.
    if (sig.liveActivity.test(frame) || sig.escapeToInterrupt.test(frame) || sig.runningIndicator.test(frame)) {
      return false;
    }
    // Positive ready-prompt signatures (conservative; tunable via dry-run).
    if (framework === 'claude-code') {
      return /bypass permissions|\? for shortcuts|auto-accept edits|shift\+tab/i.test(frame)
        || /\n\s*>\s*$/.test(frame.trimEnd() + '\n');
    }
    if (framework === 'gemini-cli') {
      // Apprenticeship Step 2: the Gemini interactive-TUI ready-prompt signature
      // is not yet live-characterized (the minimal body runs one-shot, not a
      // long-lived TUI). Conservatively return false → KEEP, never a false idle.
      // Refined when the loop-driver/TUI path lands (§6 build-time discovery).
      return false;
    }
    // codex-cli: a ready prompt with no working status line. The model-name idle
    // line is NOT a reliable positive, so require the explicit input affordance.
    return /\? for shortcuts|send a message|type a message|\bEsc\b.*interrupt/i.test(frame) === false
      ? /\n\s*›\s*$|\n\s*▌|send your message/i.test(frame)
      : false;
  }

  /**
   * Stateless per-tick evaluation. Returns KEEP unless EVERY gate clears with
   * high confidence. Order: cheap protect-gates first (short-circuit), then the
   * positive-idle + activeness checks.
   */
  evaluate(session: Session, opts?: { cpuFlat?: boolean }): SessionEvaluation {
    const framework = session.framework ?? this.deps.frameworkForSession(session.tmuxSession);
    const frame = safeCapture(this.deps, session.tmuxSession, this.cfg.paneCaptureLines);
    const transcript = this.probe(session);
    let cpuTightened = false;
    let busyOrphanSuspect = false;
    let staleIdleRelaxed = false;

    const keep = (reason: string, confidence: Confidence = 'high'): SessionEvaluation =>
      ({ verdict: 'keep', keptBy: reason, confidence, frame, transcript, cpuTightened, busyOrphanSuspect, staleIdleRelaxed });

    // Stale-idle: no user message within the staleness window on the bound topic.
    // An 8h-silent session is treated as abandoned (Justin's "no message today"
    // rule) — see the active-process relax below. Unbindable topic ⇒ NOT stale
    // (conservative: never relax a veto on a session we can't time-bound).
    const staleTopicId = this.deps.topicBinding(session.tmuxSession);
    const staleIdle = this.cfg.reapStaleIdleWithActiveChildren
      && staleTopicId != null
      && !this.deps.recentUserMessage(staleTopicId, this.cfg.staleCommitmentWindowMinutes * 60_000);

    // ── Stateless KEEP-guards (§P2): protected, spawn-grace, recovery,
    //    pending-injection, relay-lease, recent-user, open-commitment,
    //    active-subagent, structural-long-work, active-process, main-process.
    //    Extracted to the shared ReapGuard so terminateSession() enforces the
    //    identical chain. Order + reasons preserved exactly. ──
    const blocked = this.guard.blockedReason(session);
    if (blocked) {
      // Host-load-gated tightening of the `active-process` existence-veto.
      // `opts.cpuFlat===true` (computed by tick() from the descendant CPU-seconds
      // delta) means the ONLY thing keeping this session is a child that EXISTS
      // but burns ~no CPU under pressure (a wedged/idle MCP child). In that one
      // case, don't honor the veto — fall through to the stateful transcript-
      // growth + positive-idle checks below, which STILL must all clear before
      // the session is reap-eligible. Every other keep-reason — and the
      // off-pressure / can't-measure cases (cpuFlat !== true) — is unchanged.
      if (blocked.reason === 'active-process' && (opts?.cpuFlat === true || staleIdle)) {
        // Relax the active-process veto and fall through (no return) to the stateful
        // transcript-growth + positive-idle checks, which STILL must all clear before
        // the session is reap-eligible. Two independent reasons to relax:
        //   • cpuFlat — the child exists but burns ~no CPU under pressure (wedged/idle).
        //   • staleIdle — no user message in 8h (abandoned); its idle children (e.g. the
        //     session's own idle MCP servers) must not shield a dead session forever.
        //     This is the active-process analogue of the #955 stale-commitment override.
        if (opts?.cpuFlat === true) cpuTightened = true;
        if (staleIdle) staleIdleRelaxed = true;
      } else {
        // OBSERVE-ONLY busy-orphan detection — the inverse of the relax above.
        // A child is keeping this session, but if that child is provably BURNING
        // CPU (opts.cpuFlat===false) while the session ITSELF looks fully idle
        // (positive idle prompt + flat transcript), it's a candidate useless-but-
        // busy orphan — the gap cpuAwareActiveProcessKeep can't catch. Flag it for
        // the dwell tracker; the keep verdict is UNCHANGED (never reaps on this).
        if (
          this.cfg.busyOrphanDetection
          && blocked.reason === 'active-process'
          && opts?.cpuFlat === false
          && this.looksIdleApartFromBusyChild(framework, frame, transcript, session)
        ) {
          busyOrphanSuspect = true;
        }
        return keep(blocked.reason, blocked.confidence);
      }
    }

    // ── Stateful checks (stay in the reaper; need per-tick obs / captured frame) ──
    // E. Transcript growth this tick (vs last tick). 'grew' ⇒ working;
    //    'unknown' (unresolved/rotated) ⇒ KEEP.
    const prev = this.obs.get(session.id)?.lastTranscript;
    if (prev) {
      const delta = transcriptDelta(prev, transcript);
      if (delta === 'grew') return keep('transcript-grew');
      if (delta === 'unknown') return keep('transcript-unresolved', 'low');
    } else if (!transcript.resolved) {
      // First sighting with an unresolvable transcript: cannot prove idle. KEEP.
      return keep('transcript-unresolved', 'low');
    }
    // (1) Positive idle proof — REQUIRED. No positive ready-prompt ⇒ KEEP.
    if (!SessionReaper.isPositivelyIdle(framework, frame)) return keep('no-positive-idle');

    // All gates clear: this tick the session is a reap candidate.
    return { verdict: 'reap-eligible', keptBy: 'all-clear', confidence: 'high', frame, transcript, cpuTightened, busyOrphanSuspect, staleIdleRelaxed };
  }

  /**
   * CPU-progress probe backing `cpuAwareActiveProcessKeep`. Returns:
   *  - `true`  → the session's descendants are CPU-flat (progress below the idle
   *    floor) over the sample window — i.e. existing-but-not-working;
   *  - `false` → descendants used CPU (genuinely working);
   *  - `undefined` → DO NOT tighten (the conservative default = KEEP): the
   *    feature is off, the box is at `normal` pressure, CPU can't be sampled, or
   *    there's no prior sample yet to delta against.
   * Records the current reading for the next tick's delta. Stateful — call once
   * per session per tick (from tick(), never from the observational report()).
   */
  private cpuProgressFlat(session: Session, tier: PressureTier): boolean | undefined {
    // Sample when EITHER consumer needs the signal: cpuAwareActiveProcessKeep
    // (uses cpuFlat===true to relax) or busyOrphanDetection (uses cpuFlat===false
    // to flag). Off-pressure / no dep ⇒ undefined (no tighten, no flag).
    if ((!this.cfg.cpuAwareActiveProcessKeep && !this.cfg.busyOrphanDetection)
        || tier === 'normal' || !this.deps.descendantCpuSeconds) {
      return undefined;
    }
    let sec: number;
    try { sec = this.deps.descendantCpuSeconds(session.tmuxSession); }
    catch { return undefined; }
    if (!Number.isFinite(sec)) return undefined;
    const at = this.now();
    const prior = this.cpuSamples.get(session.id);
    this.cpuSamples.set(session.id, { sec, at });
    if (!prior) return undefined; // first sighting — no delta yet, can't tell
    const elapsedSec = (at - prior.at) / 1000;
    if (elapsedSec <= 0) return undefined;
    const ratePerSec = (sec - prior.sec) / elapsedSec; // CPU-seconds per wall-second
    // Accumulated CPU went backwards (pid reuse / process restart) ⇒ not provably
    // flat ⇒ can't-tell ⇒ KEEP.
    if (ratePerSec < 0) return undefined;
    return ratePerSec < this.cfg.cpuActiveMinRatePerSec;
  }

  /**
   * Does this session look fully idle EXCEPT for the busy child keeping it alive?
   * True only when its transcript is provably STATIC (resolved + not grown vs the
   * previous tick) AND its pane is positively idle (a ready prompt, no working
   * footer). Conservative: a first sighting (no prior transcript), an unresolved/
   * rotated transcript, or any growth → false. Reuses the already-captured frame
   * and transcript (no extra tmux/fs work). Pure observation — never reaps.
   */
  private looksIdleApartFromBusyChild(
    framework: 'claude-code' | 'codex-cli' | 'gemini-cli' | 'pi-cli' | undefined,
    frame: string,
    transcript: TranscriptProbe,
    session: Session,
  ): boolean {
    const prev = this.obs.get(session.id)?.lastTranscript;
    if (!prev) return false; // first sighting — no growth comparison yet
    if (transcriptDelta(prev, transcript) !== 'static') return false; // grew/unknown ⇒ not idle
    return SessionReaper.isPositivelyIdle(framework, frame);
  }

  /** Active idle threshold (ms) for the current pressure tier. */
  private thresholdMs(tier: PressureTier): number | null {
    if (tier === 'normal') return this.cfg.normalTierReaps ? this.cfg.idleThresholdModerateMinutes * 60_000 : null;
    if (tier === 'moderate') return this.cfg.idleThresholdModerateMinutes * 60_000;
    return this.cfg.idleThresholdCriticalMinutes * 60_000;
  }

  private hourlyBudgetRemaining(): number {
    const cutoff = this.now() - 3_600_000;
    this.reapTimestamps = this.reapTimestamps.filter(t => t >= cutoff);
    return this.cfg.maxReapsPerHour - this.reapTimestamps.length;
  }

  async tick(): Promise<void> {
    if (!this.cfg.enabled || this.running) return;
    this.running = true;
    this.lastTickAt = this.now();
    try {
      const pressure = this.deps.pressure();
      const threshold = this.thresholdMs(pressure.tier);
      const sessions = this.deps.listRunningSessions();
      const live = new Set(sessions.map(s => s.id));
      // GC obs for vanished sessions.
      for (const id of [...this.obs.keys()]) if (!live.has(id)) { this.obs.delete(id); this.deps.clearReaping(id); }
      for (const id of [...this.lastAuditedDecision.keys()]) if (!live.has(id)) this.lastAuditedDecision.delete(id);
      for (const id of [...this.cpuSamples.keys()]) if (!live.has(id)) this.cpuSamples.delete(id);
      for (const id of [...this.busyOrphanStreak.keys()]) if (!live.has(id)) this.busyOrphanStreak.delete(id);
      for (const id of [...this.topicMovedStreak.keys()]) if (!live.has(id)) this.topicMovedStreak.delete(id);

      let reapedThisTick = 0;
      for (const session of sessions) {
        // ── Post-transfer closeout (operator-named issue, 2026-06-05) ──────
        // A topic-bound session whose topic is now OWNED BY ANOTHER MACHINE is
        // a leftover from a move/failover: the conversation continues on the
        // owning machine, and this one only does duplicate work. Independent of
        // the idle pipeline (a duplicate is wrong even when busy), but the kill
        // still goes through the guarded `terminate` authority — a KEEP-guard
        // veto is audited and retried next tick (eventual closeout, never a
        // forced kill). Dwell of `topicMovedConfirmTicks` absorbs ownership
        // churn mid-transfer.
        if (this.cfg.topicMovedCloseout && this.deps.topicOwnerElsewhere) {
          let otherOwner: string | null = null;
          let pinnedHere = false;
          try {
            const topicId = this.deps.topicBinding(session.tmuxSession);
            otherOwner = topicId != null ? this.deps.topicOwnerElsewhere(topicId) : null;
            // WS1.3 (MULTI-MACHINE-SEAMLESSNESS-SPEC): pin-conflict = do-not-act.
            // When the topic's PIN names THIS machine while ownership still says
            // another, the divergence is mid-reconcile TOWARD us — the
            // OwnershipReconciler is bringing the record back, and closing the
            // local session now would kill the exact session the pin wants here
            // (the 2026-06-12 incident: the closeout attacked the working laptop
            // session every 2 minutes for hours during a stuck transfer-back).
            pinnedHere = topicId != null && (this.deps.topicPinnedHere?.(topicId) ?? false);
          } catch { otherOwner = null; /* signal failed → cannot reason → skip rule */ }
          if (otherOwner && pinnedHere) {
            // -1 is the held-and-audited sentinel: audit ONCE per conflict
            // episode, hold (never act) for as long as the pin names us.
            const prior = this.topicMovedStreak.get(session.id) ?? 0;
            if (prior !== -1) {
              this.audit('reap-skipped-topic-moved', session, { rule: 'topic-moved-away', otherOwner, skipped: 'pin-conflict-pending-reconcile' });
              this.topicMovedStreak.set(session.id, -1);
            }
          } else if (otherOwner) {
            const streak = (this.topicMovedStreak.get(session.id) ?? 0) + 1;
            this.topicMovedStreak.set(session.id, streak);
            if (streak >= this.cfg.topicMovedConfirmTicks) {
              const reason = `topic moved to ${otherOwner} — closing the leftover session on this machine (post-transfer closeout)`;
              if (!this.killsEnabled) {
                if (streak === this.cfg.topicMovedConfirmTicks) {
                  this.audit('would-reap', session, { rule: 'topic-moved-away', otherOwner, dryRun: true });
                }
              } else if (reapedThisTick < this.cfg.maxReapsPerTick && this.hourlyBudgetRemaining() > 0) {
                const res = await this.deps.terminate(session.id, reason);
                if (res.terminated) {
                  reapedThisTick++;
                  this.reapTimestamps.push(this.now());
                  this.audit('reaped', session, { rule: 'topic-moved-away', otherOwner });
                  this.topicMovedStreak.delete(session.id);
                  continue; // session is gone — skip the idle pipeline
                }
                // Guard veto / already-terminal — audit once per streak crossing,
                // keep the streak so next tick retries.
                if (streak === this.cfg.topicMovedConfirmTicks) {
                  this.audit('reap-skipped-topic-moved', session, { rule: 'topic-moved-away', otherOwner, skipped: res.skipped });
                }
              }
            }
          } else if ((this.topicMovedStreak.get(session.id) ?? 0) !== 0) {
            // Clears both a counting streak AND the -1 pin-conflict sentinel,
            // so a FUTURE genuine move starts its dwell from a clean slate.
            this.topicMovedStreak.set(session.id, 0);
          }
        }
        // CPU-progress probe for the active-process keep-tightening. Sampled here
        // (once per session per tick) so the cross-tick delta lives in one place;
        // undefined off-pressure / when the feature is off ⇒ evaluate() unchanged.
        const cpuFlat = this.cpuProgressFlat(session, pressure.tier);
        let evaln: SessionEvaluation;
        try {
          evaln = this.evaluate(session, { cpuFlat });
        } catch {
          // A protect-signal threw — we cannot reason about this session, so
          // KEEP it (abort any reap-pending) and reset candidacy. Never reap on
          // a failed evaluation.
          this.deps.clearReaping(session.id);
          this.obs.set(session.id, { candidateSince: 0, consecutive: 0, lastFrame: '', lastTranscript: { resolved: false, path: '', size: 0, mtime: 0 } });
          continue;
        }
        // Decision audit (transition-only): record what we decided + WHY, stamped
        // with the pressure context, the first time we see it and on every change.
        this.auditDecisionIfChanged(session, evaln, pressure);
        // Kill-path observability: whenever the new behavior actually relaxed the
        // active-process existence-veto this tick, leave a durable breadcrumb
        // (every tick it applies — this is a behavior change to a reap decision).
        if (evaln.cpuTightened) {
          this.audit('cpu-keep-tightened', session, {
            tier: pressure.tier, verdict: evaln.verdict, keptBy: evaln.keptBy,
            cpuActiveMinRatePerSec: this.cfg.cpuActiveMinRatePerSec,
          });
        }
        // Observe-only busy-orphan dwell tracker: count consecutive suspect ticks;
        // emit ONE `busy-orphan-suspected` audit row the tick the streak crosses
        // busyOrphanConfirmTicks (not every tick after — avoids a per-tick flood),
        // and a `busy-orphan-cleared` row when a confirmed suspect recovers. Never
        // changes the verdict — purely makes the gap measurable.
        if (this.cfg.busyOrphanDetection) {
          const prevStreak = this.busyOrphanStreak.get(session.id) ?? 0;
          if (evaln.busyOrphanSuspect) {
            const streak = prevStreak + 1;
            this.busyOrphanStreak.set(session.id, streak);
            if (streak === this.cfg.busyOrphanConfirmTicks) {
              this.audit('busy-orphan-suspected', session, {
                tier: pressure.tier, streakTicks: streak, keptBy: evaln.keptBy,
                dwellMs: streak * this.cfg.tickIntervalSec * 1000,
              });
            }
          } else if (prevStreak > 0) {
            if (prevStreak >= this.cfg.busyOrphanConfirmTicks) {
              this.audit('busy-orphan-cleared', session, { tier: pressure.tier, afterTicks: prevStreak });
            }
            this.busyOrphanStreak.set(session.id, 0);
          }
        }
        const prior = this.obs.get(session.id);
        const now = this.now();

        if (evaln.verdict === 'keep') {
          // Any non-candidate observation resets candidacy + aborts reap-pending.
          if (prior?.reapPendingSince != null) {
            this.deps.clearReaping(session.id);
            this.audit('reap-aborted', session, { keptBy: evaln.keptBy });
          }
          this.obs.set(session.id, { candidateSince: 0, consecutive: 0, lastFrame: evaln.frame, lastTranscript: evaln.transcript });
          continue;
        }

        // Candidate this tick. Render-stasis: the frame must be byte-identical
        // to last tick. A changed frame ⇒ activity ⇒ reset candidacy.
        const frameStatic = prior != null && prior.consecutive > 0 && prior.lastFrame === evaln.frame;

        // If we were reap-pending and the frame is no longer static, the session
        // rendered something during the grace window — abort the reap (§3.5).
        if (prior?.reapPendingSince != null && !frameStatic) {
          this.deps.clearReaping(session.id);
          this.audit('reap-aborted', session, { reason: 'frame-changed-during-grace' });
          this.obs.set(session.id, { candidateSince: now, consecutive: 1, lastFrame: evaln.frame, lastTranscript: evaln.transcript });
          continue;
        }

        const consecutive = frameStatic ? prior!.consecutive + 1 : 1;
        const candidateSince = frameStatic && prior!.candidateSince ? prior!.candidateSince : now;
        const next: Obs = { candidateSince, consecutive, lastFrame: evaln.frame, lastTranscript: evaln.transcript, reapPendingSince: prior?.reapPendingSince };

        // Two-phase: if already reap-pending, see if the grace window elapsed.
        if (next.reapPendingSince != null) {
          if (now - next.reapPendingSince >= this.cfg.finalGraceSec * 1000) {
            // Final confirmation already passed THIS tick's full classifier
            // (we're here ⇒ still reap-eligible + render-static). Terminate.
            const canReap = threshold != null && reapedThisTick < this.cfg.maxReapsPerTick && this.hourlyBudgetRemaining() > 0;
            if (canReap) {
              // Carry THIS reap's active-process relaxation through to the terminate
              // authority. evaln reached reap-eligible; if it got there by relaxing the
              // active-process veto (cpuFlat under pressure, or 8h-stale-idle children),
              // the authority's un-relaxed re-check would otherwise skip:active-process
              // and the reap would never land. False ⇒ no active process was the blocker,
              // so the bypass is a harmless no-op.
              const relaxedActiveProcess = evaln.cpuTightened || evaln.staleIdleRelaxed;
              await this.performReap(session, pressure, next, relaxedActiveProcess); // clears the lease on every path
              reapedThisTick++;
            } else {
              // Grace elapsed but the reap is gated (tier dropped / budget spent).
              // Release the reaping lease so the idle-kill safety net is not
              // permanently disabled for this session.
              this.deps.clearReaping(session.id);
            }
            this.obs.set(session.id, { ...next, reapPendingSince: undefined });
          } else {
            this.obs.set(session.id, next); // keep waiting out the grace window
          }
          continue;
        }

        // Not yet reap-pending. Need: hysteresis satisfied + idle past threshold
        // + pressure tier permits reaping + budget available.
        const hysteresisOk = consecutive >= this.cfg.confirmObservations
          && (now - candidateSince) >= this.cfg.confirmWindowMinutes * 60_000;
        const idleMs = now - candidateSince;
        if (threshold != null && hysteresisOk && idleMs >= threshold
            && reapedThisTick < this.cfg.maxReapsPerTick && this.hourlyBudgetRemaining() > 0) {
          // Enter reap-pending (two-phase). Lease the session so idle-kill won't
          // race us; terminate on a later tick after the grace window.
          next.reapPendingSince = now;
          this.deps.markReaping(session.id);
          this.audit('reap-pending', session, { tier: pressure.tier, idleMs, thresholdMs: threshold });
        }
        this.obs.set(session.id, next);
      }
      this.persistCandidacy(); // durable candidacy (A): the idle clock survives restarts
    } finally {
      this.running = false;
    }
  }

  private async performReap(
    session: Session,
    pressure: PressureReading,
    obs: Obs,
    relaxedActiveProcess = false,
  ): Promise<void> {
    const detail = { tier: pressure.tier, idleMs: this.now() - obs.candidateSince, dryRun: !this.killsEnabled };
    if (!this.killsEnabled) {
      this.audit('would-reap', session, detail); // dry-run: log, do not kill
      this.deps.clearReaping(session.id);
      return;
    }
    try {
      // bypassActiveProcessKeep: carry the reaper's already-applied active-process
      // relaxation to the authority so it doesn't re-veto on the un-relaxed shared
      // guard (the 1,532× skipped:active-process stalemate). Scoped to active-process
      // only; every other KEEP-guard is still enforced by terminateSession.
      const r = await this.deps.terminate(session.id, 'reaped-idle', {
        bypassActiveProcessKeep: relaxedActiveProcess,
        // Pre-relaxation verdict as killer-supplied evidence (reap-notify R2.1):
        // an idle-reap means this reaper PROVED no work — assert the empty set
        // authoritatively so the chokepoint fallback can't re-stamp the
        // active-process signal the relaxation just disproved.
        workEvidence: [],
      });
      if (r.terminated) {
        this.reapTimestamps.push(this.now());
        this.audit('reaped', session, detail);
        this.emit('reaped', session);
      } else if (r.skipped) {
        // A refusal WITH a known reason (session is busy/protected/already gone) is a
        // deliberate, safe decline by the terminate dep — a normal skip. Move on to the
        // next candidate; do NOT disable the whole reaper. Disabling here was a bug: one
        // perpetually-busy session (e.g. skipped:'active-process') auto-disabled the
        // reaper every boot, so it never reaped any of the OTHER genuinely-idle sessions
        // (observed 2026-06-07: 8 self-shutoffs on a 37-session fleet, 0 real reaps).
        this.audit('reap-skipped', session, { ...detail, skipped: r.skipped });
      } else {
        // terminated:false with NO reason given = genuinely unexpected — fail safe.
        this.autoDisabled = true;
        this.audit('reap-skipped-auto-disable', session, { ...detail, skipped: r.skipped });
        this.emit('auto-disabled', { session, reason: 'unexpected-no-skip-reason' });
      }
    } catch (err) {
      this.autoDisabled = true;
      this.audit('reap-failed-auto-disable', session, { ...detail, error: err instanceof Error ? err.message : String(err) });
      this.emit('auto-disabled', { session, reason: 'error' });
    } finally {
      this.deps.clearReaping(session.id);
    }
  }

  /** Emit a `decision` audit row only when a session's (verdict, keptBy) differs
   *  from the last audited value — so a multi-day kept session logs once, not
   *  every tick. Each row carries the pressure context that drove the call. */
  private auditDecisionIfChanged(session: Session, evaln: SessionEvaluation, pressure: PressureReading): void {
    const key = `${evaln.verdict}:${evaln.keptBy}`;
    if (this.lastAuditedDecision.get(session.id) === key) return;
    this.lastAuditedDecision.set(session.id, key);
    this.audit('decision', session, {
      verdict: evaln.verdict,
      keptBy: evaln.keptBy,
      confidence: evaln.confidence,
      tier: pressure.tier,
      inputs: pressure.inputs,
    });
  }

  private audit(event: string, session: Session, detail: Record<string, unknown>): void {
    const entry = { ts: new Date(this.now()).toISOString(), kind: 'session-reaper', event, session: session.name, sessionId: session.id, ...detail };
    if (this.deps.audit) this.deps.audit(entry);
  }

  /** Observability snapshot for GET /sessions/reaper. */
  snapshot(): {
    enabled: boolean; dryRun: boolean; autoDisabled: boolean; lastTickAt: number;
    pressure: PressureReading; activeThresholdMinutes: number | null;
    reapsLastHour: number;
    sessions: Array<{ name: string; sessionId: string; verdict: Verdict; keptBy: string; confidence: Confidence; consecutive: number; idleMs: number; reapPending: boolean }>;
  } {
    const pressure = this.deps.pressure();
    const threshold = this.thresholdMs(pressure.tier);
    const now = this.now();
    const sessions = this.deps.listRunningSessions().map(s => {
      const o = this.obs.get(s.id);
      let verdict: Verdict = 'keep';
      let keptBy = 'eval-error';
      let confidence: Confidence = 'low';
      try {
        const e = this.evaluate(s);
        verdict = e.verdict; keptBy = e.keptBy; confidence = e.confidence;
      } catch { /* a protect-signal threw — report as kept, never crash the route */ }
      return {
        name: s.name, sessionId: s.id, verdict, keptBy, confidence,
        consecutive: o?.consecutive ?? 0, idleMs: o?.candidateSince ? now - o.candidateSince : 0,
        reapPending: o?.reapPendingSince != null,
      };
    });
    return {
      enabled: this.cfg.enabled, dryRun: this.cfg.dryRun || this.autoDisabled, autoDisabled: this.autoDisabled,
      lastTickAt: this.lastTickAt, pressure,
      activeThresholdMinutes: threshold == null ? null : Math.round(threshold / 60_000),
      reapsLastHour: this.cfg.maxReapsPerHour - this.hourlyBudgetRemaining(),
      sessions,
    };
  }

  /** Sync in-memory runtime read for the GuardRegistry (GET /guards).
   *  Cheap property read ONLY — snapshot() is the heavy surface. */
  guardStatus(): { enabled: boolean; dryRun: boolean; lastTickAt: number } {
    return {
      enabled: this.cfg.enabled,
      dryRun: this.cfg.dryRun || this.autoDisabled,
      lastTickAt: this.lastTickAt,
    };
  }
}

function safeCapture(deps: SessionReaperDeps, tmuxSession: string, lines: number): string {
  try { return deps.captureOutput(tmuxSession, lines) ?? ''; } catch { return ''; }
}

/** Default audit sink: append one JSON line to logs/sentinel-events.jsonl. */
export function fileAuditSink(stateDir: string): (event: Record<string, unknown>) => void {
  const logPath = path.join(stateDir, '..', 'logs', 'sentinel-events.jsonl');
  return (event: Record<string, unknown>) => {
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(logPath, JSON.stringify(event) + '\n');
    } catch { /* never throw from the audit sink */ }
  };
}

/** Path of the dedicated, reviewable reaper-decision audit trail. */
export function reaperAuditPath(stateDir: string): string {
  return path.join(stateDir, '..', 'logs', 'reaper-audit.jsonl');
}

/**
 * Dedicated reaper audit sink → logs/reaper-audit.jsonl (separate from the
 * shared sentinel log so the reaper's decisions are reviewable on their own).
 * Silent: never throws, never notifies — purely an inspectable record.
 */
export function reaperAuditSink(stateDir: string): (event: Record<string, unknown>) => void {
  const logPath = reaperAuditPath(stateDir);
  return (event: Record<string, unknown>) => {
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(logPath, JSON.stringify(event) + '\n');
    } catch { /* never throw from the audit sink */ }
  };
}

/**
 * Read the tail of the reaper audit trail (newest last), bounded to `limit`
 * rows. Returns [] when the file is absent or unreadable — never throws.
 */
export function readReaperAudit(stateDir: string, limit: number): Array<Record<string, unknown>> {
  const logPath = reaperAuditPath(stateDir);
  let raw: string;
  try {
    raw = fs.readFileSync(logPath, 'utf-8');
  } catch {
    return []; // @silent-fallback-ok — absent audit file ⇒ no rows yet.
  }
  const lines = raw.split('\n').filter(l => l.trim().length > 0);
  const tail = lines.slice(Math.max(0, lines.length - limit));
  const out: Array<Record<string, unknown>> = [];
  for (const line of tail) {
    try { out.push(JSON.parse(line)); } catch { /* skip a torn line */ }
  }
  return out;
}

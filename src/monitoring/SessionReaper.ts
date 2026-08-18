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
import { CONFIRMED_MOVE_ASSERTION_TTL_MS, validateConfirmedMoveAssertion } from '../core/SessionManager.js';
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
  /** P19 breaker (WS1.2, MULTI-MACHINE-SEAMLESSNESS-SPEC): after this many
   *  CONSECUTIVE vetoed closeout attempts on the same session, the closeout
   *  stops retrying and ONE degradation notice surfaces — the 2026-06-12
   *  incident was this exact loop attacking a working session every 2 minutes
   *  for hours. The session is NOT stranded: the normal idle pipeline still
   *  evaluates it every tick and reaps it when it actually finishes. The
   *  breaker resets when the topic returns home / a pin-conflict hold engages /
   *  the session ends. Default 5 (~10 min of vetoes at the default 120s tick). */
  topicMovedVetoBreakerAttempts: number;
  /** Post-transfer closeout CORRECTNESS gate (F1,
   *  docs/specs/post-transfer-closeout-correctness.md). When true, the closeout
   *  no longer terminates the live local session on a stale/unverified ownership
   *  record: it consults `remoteOwnerHasLiveSession` and proceeds ONLY when the
   *  owning machine genuinely HAS a live session for the topic (a real
   *  duplicate). `false` (owner has no live session) / `'unknown'` / dep-absent →
   *  WITHHOLD (fail-closed — never kill the sole live worker). It also re-keys the
   *  closeout breaker counters on the stable TOPIC id (so a session-id churn
   *  across respawn no longer resets the veto count) and passes the narrow
   *  `bypassRecentUserMessageForConfirmedMove` on a liveness-CONFIRMED move so a
   *  genuine leftover with a pre-move "recent" message can actually shed.
   *  Ships DARK fleet-wide, LIVE on a dev agent via `resolveDevAgentGate`. When
   *  OFF the closeout's observable behavior is byte-identical to today. */
  closeoutLivenessGate: boolean;
  /** Ticks a mutual muzzle (or an unresolvable pool view) must persist before the
   *  tiebreak releases. Mirrors the release hysteresis. */
  standDownMutualMuzzleGraceTicks: number;
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
  topicMovedVetoBreakerAttempts: 5,
  closeoutLivenessGate: false,
  standDownMutualMuzzleGraceTicks: 2,
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
  /** Post-transfer closeout correctness (F1): the combined, ATOMIC owner read
   *  the liveness-gated closeout uses — ONE registry read returning BOTH the
   *  STABLE `machineId` (the un-nicknamed `reg.ownerOf(...)` value — the
   *  liveness/snapshot key, immune to nickname rename/duplication) and the
   *  `displayName` (= nickname ?? machineId — audit/operator text). Returning
   *  both from one read guarantees the liveness key and the display text describe
   *  the SAME owner from the SAME instant (no straddle across an ownership change).
   *  null ⇒ the topic is not owned elsewhere. Consulted ONLY when
   *  `closeoutLivenessGate` is on; absent-under-gate ⇒ the closeout fail-closes to
   *  WITHHOLD (it never silently falls back to the display-only dep). */
  topicOwnerElsewhereInfo?: (topicId: number) => { machineId: string; displayName: string } | null;
  /** Post-transfer closeout correctness (F1): does the machine that OWNS this
   *  topic (per the ownership registry) actually have a LIVE session for it right
   *  now? Reads the machine-local liveness snapshot (NOT a live per-tick fetch).
   *    state:true     → owner genuinely serving → local is a duplicate → may shed.
   *    state:false    → owner has NO live session → local is the sole worker →
   *                     WITHHOLD (never terminate it).
   *    state:'unknown'→ liveness undeterminable (snapshot missing/stale, peer
   *                     unreachable) → WITHHOLD (fail-closed; UNKNOWN must NEVER act).
   *  `reachableAt` (ms) = the snapshot pass that produced the answer; backs the
   *  true-side dwell-advancement (a confirm tick only counts when `reachableAt`
   *  ADVANCED). Present on true/false, absent on 'unknown'. Absent dep ⇒ the
   *  liveness gate is inert. */
  remoteOwnerHasLiveSession?: (topicId: number, ownerMachineId: string)
    => { state: boolean | 'unknown'; reachableAt?: number };
  /** Post-transfer closeout correctness (F1, Part E freshest-interaction veto):
   *  the LOCAL-RECEIPT timestamp (ms) of the bound topic's most-recent user
   *  message, or null. SAME source the existing `recent-user-message` KEEP-guard
   *  reads, so the basis is local wall-clock at message receipt. Used to withhold
   *  the recent-message bypass when a user message arrived AFTER the liveness
   *  snapshot (the local session the user is actively talking to is kept). */
  recentUserMessageAt?: (topicId: number) => number | null;
  /** This machine's mesh identity. A GETTER because mesh identity resolves after
   *  construction. Absent/null ⇒ no stand-down is ever registered (the registry
   *  refuses without a trusted local identity — fail toward doing nothing). */
  selfMachineId?: () => string | null;
  /** The duplicate-session stand-down seam. Absent ⇒ feature dark ⇒ no-op. */
  standDown?: StandDownSeam;
  /** Live config read per tick (an edit applies with no restart). */
  standDownConfig?: () => { enabled: boolean; dryRun: boolean };
  /** The ownership EPOCH the current verdict rests on — the episode key's third
   *  component and the only thing that re-admits a latched episode. */
  ownershipEpochFor?: (topicId: number) => number | null;
  /** CONTESTED REAL WORK on the local copy. A non-null answer REFUSES
   *  registration and escalates to the human instead of muzzling: a build is a
   *  SEQUENCE of tool calls, so a muzzle would freeze it at the first boundary
   *  rather than let it finish, and suspending an operator's autonomous run is a
   *  consent-gated decision this machine may not make for them. */
  contestedWork?: (session: Session, topicId: number) => 'structural-long-work' | 'active-subagent' | 'autonomous-run' | null;
  /**
   * Hand a topic's freshest unanswered LOCAL inbound to the durable inbound
   * queue so the OWNER machine delivers it. Returns true only when the message
   * was genuinely accepted for delivery.
   *
   * Absent, or false, means the message CANNOT be forwarded — and then the
   * muzzle is RELEASED rather than held, because a muzzle must never outlive the
   * user's live attention. The durable inbound queue ships dark on the fleet, so
   * "absent" is the common case, not an edge: releasing is the correct default,
   * not a fallback.
   */
  divertInboundToOwner?: (topicId: number, ownerMachineId: string) => boolean;
  /**
   * Is EVERY live copy of this conversation across the pool muzzled? `null` =
   * could not determine (stale/partitioned membership). Absent ⇒ no pool view ⇒
   * the tiebreak never fires.
   */
  everyLiveCopyMuzzled?: (topicId: number) => Promise<boolean | null>;
  /** Claim a per-episode notice budget for ONE channel (the registry owns them,
   *  one budget per channel so the two audiences cannot silence each other). */
  claimStandDownNotice?: (sessionName: string, channel: 'session' | 'user') => boolean;
  /** Inject a line into a session's tmux pane. */
  injectNotice?: (tmuxSession: string, text: string) => void;
  /** ONE deduped attention item for a stand-down escalation. Distinct from the
   *  existing `raiseAttention` (whose shape the busy-orphan path owns) so the
   *  stand-down's priority is explicit at the callsite. */
  raiseStandDownAttention?: (item: { id: string; title: string; summary: string; description?: string; priority?: 'medium' | 'high' }) => void;
  /** Can this session's drain be PROVEN at all (framework capability)? False /
   *  absent ⇒ the entry takes the shorter TTL and rides the attention path
   *  rather than pretending it drained. Cheap by construction — no probing. */
  drainProvable?: (session: Session) => boolean;
  /** The corroborated drain observations for a muzzled session. Absent ⇒ drain
   *  is unprovable for this framework ⇒ the entry rides the TTL/attention path. */
  drainObservations?: (session: Session, drainBoundaryAt: number) => import('../core/standDownDrain.js').DrainObservations | null;
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
  /** Build-Session Yield Safety (ACT-839): the shared bounded worktreeDirtyCheck.
   *  Provided ONLY when the dev-gated yieldSafety feature is live (server.ts
   *  resolves the developmentAgent gate and injects this iff enabled) — so its
   *  mere presence is the gate. Run PRE-kill in the reaper's loop (never a
   *  synchronous git call on the terminate chokepoint); a true result means the
   *  session's worktree holds real uncommitted work → the reap carries the
   *  `uncommitted-worktree-work` evidence. Absent ⇒ feature inert. */
  dirtyCheck?: (worktreePath: string) => boolean;
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
    opts?: {
      bypassActiveProcessKeep?: boolean;
      /** Post-transfer closeout correctness (F1, Part E): lifts ONLY the
       *  `recent-user-message` keep-reason (every other guard re-checked), passed
       *  ONLY on a liveness-CONFIRMED genuine move so a duplicate leftover with a
       *  pre-move "recent" message can shed. */
      bypassRecentUserMessageForConfirmedMove?: boolean;
      /** The DRAINED close of a duplicate-session stand-down. A CLAIM the
       *  authority verifies against its own registry probe before applying its
       *  OWN frozen three-reason bypass list — this side never names reasons. */
      standDownDrainedClose?: boolean;
      /** Trusted closeout assertion. This option reaches only the birth-bound
       *  SessionManager authority closure held by production boot wiring. */
      localPostTransferCloseout?: boolean;
      workEvidence?: string[];
    },
  ) => Promise<{ terminated: boolean; skipped?: string }>;
  markReaping: (sessionId: string) => void;
  clearReaping: (sessionId: string) => void;
  now?: () => number;
  /** Structured audit sink (sentinel-events.jsonl). */
  audit?: (event: Record<string, unknown>) => void;
  /** WS1.2 P19 breaker escalation: ONE deduped degradation notice when the
   *  post-transfer closeout gives up on a permanently-vetoing session ("topic
   *  moved to X but the old session won't close — still finishing Y"). The
   *  attention queue dedupes on `id`, so a breaker that re-opens within the
   *  same episode never floods. Absent ⇒ audit-only (the transition is still
   *  in sentinel-events.jsonl). */
  raiseAttention?: (item: { id: string; title: string; summary: string; description?: string }) => void;
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

/**
 * The closeout dwell-streak value. OFF mode uses the legacy `number | -1` (-1 =
 * held sentinel). ON (gated) mode uses the richer struct so the dwell advances
 * only across DISTINCT snapshot generations and the GC grace window applies to
 * held + counting episodes uniformly:
 *   - `{ kind: 'counting'; count; lastTrueReachableAt; lastSeenAt }` — `count` is
 *     the consecutive-distinct-generation dwell; a `true` tick advances it only
 *     when `reachableAt > lastTrueReachableAt`.
 *   - `{ kind: 'held'; lastSeenAt }` — REPLACES the legacy `-1` sentinel for the
 *     WITHHOLD / pin-conflict episodes (audited once; never confirms terminate);
 *     `lastSeenAt` lets the GC grace window evict a held topic uniformly.
 */
/**
 * The narrow seam the reaper drives the duplicate-session stand-down through
 * (docs/specs/duplicate-session-standdown.md). Deliberately a small interface
 * rather than the StandDownRegistry class: the reaper is a PRODUCER of verdicts,
 * not an owner of the registry, and this shape is what a test can fake.
 *
 * Absent (`undefined`) ⇒ the feature is dark ⇒ every stand-down path below is a
 * strict no-op and the closeout behaves byte-identically to today.
 */
/** The projection of a stand-down entry the reaper needs. Deliberately a subset
 *  of the registry's own type: the reaper reads state, it never owns it. */
export interface StandDownSeamEntry {
  sessionName: string;
  topicId: number;
  ownerMachineId: string;
  state: string;
  dryRun: boolean;
  expiresAt: number;
  issuedAt: number;
  drainBoundaryAt: number;
  lastDrainObservedAt: number;
  lastEvaluateAt: number | null;
}

export interface StandDownSeam {
  register(req: {
    sessionName: string; topicId: number; ownerMachineId: string; ownershipEpoch: number;
    reason: string; dryRun: boolean; drainUnprovable?: boolean;
  }, actualLocalMachineId: string | null): { ok: true; created: boolean } | { ok: false; refusal: string };
  entryFor(sessionName: string): StandDownSeamEntry | null;
  liveEntries(): StandDownSeamEntry[];
  observeDrain(sessionName: string, drained: boolean, observedAt?: number): boolean;
  markClosed(sessionName: string): void;
  /** Remove an entry whose session vanished — NOT a retirement; no closed-episode row. */
  dropVanished(sessionName: string): void;
  closedEpisodeCount(topicId: number): number;
  closedEpisodeChurnThreshold(): number;
  reverify(sessionName: string, ok: boolean, why: string): 'held' | 'released';
  /** Release NOW, bypassing the re-verify hysteresis. Used only where the
   *  release signal is unambiguous (a live user message this copy holds). */
  release(sessionName: string, why: string, opts?: { armLatch?: boolean }): void;
  expire(sessionName: string): unknown;
  refreshMarker(): void;
  recordCanaryHit(sessionName: string, detail: string): void;
  health(): { due: boolean; expiredEpisodes: number; canaryHits: number; liveEntries: number; latches: number; degradedBoot: boolean };
  claimLatchAttention(): Array<{ episodeId: string; sessionName: string; topicId: number; blockedAttempts: number }>;
  pruneLatches(currentEpochByTopic: Map<number, number>): number;
}

export type TopicMovedStreakValue =
  | number // OFF-mode legacy (plain count, or -1 held sentinel)
  | {
    kind: 'counting';
    count: number;
    lastTrueReachableAt: number;
    lastSeenAt: number;
    /** The owner the dwell has been accumulating AGAINST (predecessor round-4
     *  finding 7, fixed here). Without it a topic that moved A→B and then B→C
     *  carries B's confirmations into C's episode, so the closeout could act on
     *  a dwell that was never established for the CURRENT owner. An owner change
     *  resets the count to 1 — the new episode starts clean. */
    ownerMachineId?: string;
  }
  | { kind: 'held'; lastSeenAt: number };

export class SessionReaper extends EventEmitter {
  private readonly cfg: SessionReaperConfig;
  readonly #deps: Readonly<SessionReaperDeps>;
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
  /** Consecutive VETOED closeout terminate attempts (the WS1.2 P19 breaker
   *  counter). Distinct from the dwell streak: this counts only real terminate()
   *  calls that came back vetoed. At `topicMovedVetoBreakerAttempts` the closeout
   *  stops retrying for the episode. Reset on success / topic-home / pin-conflict
   *  hold. GC'd with obs.
   *  Keyed on session.id when `closeoutLivenessGate` is OFF (legacy); on the
   *  STABLE topic id when ON (so a session-id churn across respawn no longer
   *  resets the count — the Secondary fix). Value is always a plain number. */
  private topicMovedVetoes = new Map<string | number, number>();
  /** Consecutive owned-elsewhere ticks (the topicMovedCloseout dwell). Resets
   *  when the topic returns home / unowned. GC'd with obs.
   *  OFF (legacy): keyed on session.id, value `number | -1` (-1 = held sentinel).
   *  ON (gated): keyed on the stable topic id, value the richer struct below —
   *  `lastTrueReachableAt` enforces dwell advancement (a confirm tick counts only
   *  when the snapshot `reachableAt` advanced), `lastSeenAt` backs the GC grace
   *  window so a held topic participates in eviction uniformly. */
  private topicMovedStreak = new Map<string | number, TopicMovedStreakValue>();
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
    this.#deps = Object.freeze({ ...deps });
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
      const restored = this.#deps.loadCandidacy?.();
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
    if (!this.#deps.saveCandidacy) return;
    try {
      const out: Record<string, Obs> = {};
      for (const [id, o] of this.obs.entries()) out[id] = o;
      this.#deps.saveCandidacy(out);
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
    if (this.#deps.probeTranscript) return this.#deps.probeTranscript(session);
    const framework = session.framework ?? this.#deps.frameworkForSession(session.tmuxSession) ?? 'claude-code';
    // Claude uses claudeSessionId; Codex's transcript is globbed by its session
    // id which we do not separately track → unresolved → KEEP (safe).
    const sessionId = framework === 'claude-code' ? (session.claudeSessionId ?? '') : '';
    // projectDir is the agent's session-launch cwd, which Claude Code encodes into the
    // transcript path (~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl). Passing ''
    // resolved to an empty-encoded dir that never exists → EVERY session read as
    // transcript-unresolved → the reaper could never PROVE a session idle and kept
    // everything (2026-06-06 grounding). Inject it via `transcriptProjectDir`; an
    // absent/wrong value still resolves to unresolved → KEEP (safe).
    const projectDir = this.#deps.transcriptProjectDir?.() ?? '';
    return probeTranscript({ framework, sessionId, projectDir });
  }

  /**
   * Positive idle detection: returns true ONLY if the frame affirmatively shows
   * a ready-for-input prompt AND contains no active-work marker. Conservative —
   * an undetected ready prompt returns false (→ KEEP), never a false idle.
   */
  static isPositivelyIdle(framework: 'claude-code' | 'codex-cli' | 'gemini-cli' | 'pi-cli' | 'grok-build' | undefined, frame: string): boolean {
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
    const framework = session.framework ?? this.#deps.frameworkForSession(session.tmuxSession);
    const frame = safeCapture(this.#deps, session.tmuxSession, this.cfg.paneCaptureLines);
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
    const staleTopicId = this.#deps.topicBinding(session.tmuxSession);
    const staleIdle = this.cfg.reapStaleIdleWithActiveChildren
      && staleTopicId != null
      && !this.#deps.recentUserMessage(staleTopicId, this.cfg.staleCommitmentWindowMinutes * 60_000);

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
        || tier === 'normal' || !this.#deps.descendantCpuSeconds) {
      return undefined;
    }
    let sec: number;
    try { sec = this.#deps.descendantCpuSeconds(session.tmuxSession); }
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
    framework: 'claude-code' | 'codex-cli' | 'gemini-cli' | 'pi-cli' | 'grok-build' | undefined,
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

  /**
   * Post-transfer closeout — LEGACY path (closeoutLivenessGate OFF). Byte-identical
   * observable behavior to the pre-correctness-fix code: session-id-keyed maps, no
   * liveness check, no Part E bypass. Returns whether the session was terminated +
   * the running reap count.
   */
  async #runCloseoutLegacy(
    session: Session,
    reapedThisTick: number,
  ): Promise<{ terminated: boolean; reapedThisTick: number }> {
    let otherOwner: string | null = null;
    let pinnedHere = false;
    try {
      const topicId = this.#deps.topicBinding(session.tmuxSession);
      otherOwner = topicId != null ? (this.#deps.topicOwnerElsewhere?.(topicId) ?? null) : null;
      // WS1.3: pin-conflict = do-not-act (reconcile mid-flight TOWARD us).
      pinnedHere = topicId != null && (this.#deps.topicPinnedHere?.(topicId) ?? false);
    } catch { otherOwner = null; /* @silent-fallback-ok — ownership signal failed → cannot reason → skip rule (safe withhold direction) */ }

    if (otherOwner && pinnedHere) {
      const prior = (this.topicMovedStreak.get(session.id) as number | undefined) ?? 0;
      if (prior !== -1) {
        this.audit('reap-skipped-topic-moved', session, { rule: 'topic-moved-away', otherOwner, skipped: 'pin-conflict-pending-reconcile' });
        this.topicMovedStreak.set(session.id, -1);
      }
      this.topicMovedVetoes.delete(session.id);
      return { terminated: false, reapedThisTick };
    }
    if (otherOwner) {
      const streak = ((this.topicMovedStreak.get(session.id) as number | undefined) ?? 0) + 1;
      this.topicMovedStreak.set(session.id, streak);
      if (streak >= this.cfg.topicMovedConfirmTicks) {
        const reason = `topic moved to ${otherOwner} — closing the leftover session on this machine (post-transfer closeout)`;
        return this.#attemptCloseoutTerminate({
          session, otherOwner, reason, streak,
          key: session.id, reapedThisTick, bypassRecentForMove: false,
        });
      }
      return { terminated: false, reapedThisTick };
    }
    // owned-by-self / unowned — clear the episode (counting streak AND -1 sentinel).
    if (((this.topicMovedStreak.get(session.id) as number | undefined) ?? 0) !== 0) {
      this.topicMovedStreak.set(session.id, 0);
      this.topicMovedVetoes.delete(session.id);
    }
    return { terminated: false, reapedThisTick };
  }

  /**
   * Post-transfer closeout — GATED path (closeoutLivenessGate ON). The
   * correctness fix: NEVER terminate the live local session on a stale/unverified
   * ownership record. Resolves the owner ATOMICALLY (machineId + display), then
   * consults `remoteOwnerHasLiveSession`:
   *   true     → genuine move (real duplicate) → dwell→terminate (with Part E bypass).
   *   false    → owner has no live session → WITHHOLD (neutral once-per-episode audit).
   *   'unknown'/throw/dep-absent → WITHHOLD (fail-closed; UNKNOWN must NEVER act).
   * Maps are keyed on the stable TOPIC id (Secondary fix) with the richer streak
   * struct so the dwell advances only across DISTINCT snapshot generations.
   */
  async #runCloseoutGated(
    session: Session,
    reapedThisTick: number,
  ): Promise<{ terminated: boolean; reapedThisTick: number }> {
    let topicId: number | null = null;
    let owner: { machineId: string; displayName: string } | null = null;
    let pinnedHere = false;
    try {
      topicId = this.#deps.topicBinding(session.tmuxSession);
      // The gated path REQUIRES the combined dep — it never falls back to the
      // display-only one. Absent ⇒ owner stays null ⇒ withhold (fail-closed below).
      owner = topicId != null ? (this.#deps.topicOwnerElsewhereInfo?.(topicId) ?? null) : null;
      pinnedHere = topicId != null && (this.#deps.topicPinnedHere?.(topicId) ?? false);
    } catch { owner = null; /* @silent-fallback-ok — ownership signal failed → cannot reason → skip rule (safe withhold direction) */ }

    // topicId null → no participation (also covers the topicOwnerElsewhereInfo-absent
    // dep window: owner is null → the "no owner-elsewhere" reset arm below runs).
    if (topicId == null) return { terminated: false, reapedThisTick };
    const key = topicId; // stable topic-keyed breaker state (Secondary fix)
    const now = this.now();

    if (owner && pinnedHere) {
      // Pin-conflict hold WINS ahead of the liveness gate (unchanged WS1.3 rule).
      const prior = this.topicMovedStreak.get(key);
      const isHeld = typeof prior === 'object' && prior.kind === 'held';
      if (!isHeld) {
        this.audit('reap-skipped-topic-moved', session, { rule: 'topic-moved-away', otherOwner: owner.displayName, skipped: 'pin-conflict-pending-reconcile' });
      }
      this.topicMovedStreak.set(key, { kind: 'held', lastSeenAt: now });
      this.topicMovedVetoes.delete(key);
      return { terminated: false, reapedThisTick };
    }

    if (owner) {
      // ── Part C: liveness gate ──────────────────────────────────────────────
      let liveness: { state: boolean | 'unknown'; reachableAt?: number };
      try {
        liveness = this.#deps.remoteOwnerHasLiveSession
          ? this.#deps.remoteOwnerHasLiveSession(topicId, owner.machineId)
          : { state: 'unknown' }; // dep absent under gate → fail-closed
      } catch {
        liveness = { state: 'unknown' }; // a throw is treated as 'unknown'
      }

      if (liveness.state !== true) {
        // false / 'unknown' → WITHHOLD. Once-per-episode neutral audit + held
        // sentinel; a withheld episode never accrues breaker vetoes.
        const prior = this.topicMovedStreak.get(key);
        const isHeld = typeof prior === 'object' && prior.kind === 'held';
        if (!isHeld) {
          const ownerEntry = liveness.reachableAt;
          this.audit('reap-skipped-topic-moved', session, {
            rule: 'topic-moved-away',
            otherOwner: owner.displayName,
            ownerMachineId: owner.machineId,
            skipped: liveness.state === false ? 'no-live-remote-session' : 'remote-liveness-unknown',
            // Neutral, non-directional observational evidence (NO reconcileToward).
            remoteOwnerListedSession: false,
            withheldCloseout: true,
            possibleStaleOwner: true,
            snapshotAgeMs: ownerEntry != null ? now - ownerEntry : undefined,
          });
        }
        this.topicMovedStreak.set(key, { kind: 'held', lastSeenAt: now });
        this.topicMovedVetoes.delete(key);
        return { terminated: false, reapedThisTick };
      }

      // state === true: genuine move. Advance the dwell ONLY across a DISTINCT
      // snapshot generation (reachableAt strictly newer than lastTrueReachableAt).
      const reachableAt = liveness.reachableAt ?? 0;
      const prior = this.topicMovedStreak.get(key);
      let count: number;
      let lastTrueReachableAt: number;
      if (typeof prior === 'object' && prior.kind === 'counting'
        // An OWNER CHANGE starts a new episode: confirmations accumulated against
        // a DIFFERENT owner say nothing about this one, and the stand-down
        // registration reuses this dwell as its admission evidence.
        && (prior.ownerMachineId === undefined || prior.ownerMachineId === owner.machineId)) {
        if (reachableAt > prior.lastTrueReachableAt) {
          count = prior.count + 1;
          lastTrueReachableAt = reachableAt;
        } else {
          // Same generation re-read — the tick does not advance the streak.
          count = prior.count;
          lastTrueReachableAt = prior.lastTrueReachableAt;
        }
      } else {
        // First counting tick OR transition out of a held (-1) episode → start at 1.
        count = 1;
        lastTrueReachableAt = reachableAt;
      }
      this.topicMovedStreak.set(key, { kind: 'counting', count, lastTrueReachableAt, lastSeenAt: now, ownerMachineId: owner.machineId });

      if (count >= this.cfg.topicMovedConfirmTicks) {
        const reason = `topic moved to ${owner.displayName} — closing the leftover session on this machine (post-transfer closeout)`;
        // Part E: pass the narrow bypass ONLY when the topic's freshest LOCAL user
        // message is OLDER than the snapshot reachableAt (freshest-interaction veto).
        const lastUserMsgAt = (() => {
          try { return this.#deps.recentUserMessageAt?.(topicId) ?? null; } catch { return null; /* @silent-fallback-ok — recent-msg signal failed → treat as no recent message → bypass not granted (safe) */ }
        })();
        const bypassRecentForMove = lastUserMsgAt == null || lastUserMsgAt <= reachableAt;
        return this.#attemptCloseoutTerminate({
          session, otherOwner: owner.displayName, reason, streak: count,
          key, reapedThisTick, bypassRecentForMove,
          confirmedMove: true, snapshotReachableAt: reachableAt,
          ownerMachineId: owner.machineId,
          standDownEvidence: { reachableAt, lastUserMessageAt: lastUserMsgAt, dwellTicks: count },
        });
      }
      return { terminated: false, reapedThisTick };
    }

    // No owner-elsewhere — clear the episode (counting OR held), so a FUTURE move
    // starts clean. Mirrors the legacy reset arm under the topic key.
    if (this.topicMovedStreak.has(key)) {
      this.topicMovedStreak.delete(key);
      this.topicMovedVetoes.delete(key);
    }
    return { terminated: false, reapedThisTick };
  }

  /**
   * Register a stand-down for a duplicate the closeout could not take.
   *
   * REFUSALS COME FIRST, and they are the honest half of this design. Contested
   * REAL work is the human's call, immediately: a build is a SEQUENCE of tool
   * calls, so muzzling it would freeze it at the first boundary rather than let
   * it finish (v1's "it finishes muzzled" was self-contradictory); and
   * suspending an operator's autonomous run is a CONSENT-GATED decision — the
   * transfer path's suspend primitive answers 409 needsConfirmation for exactly
   * this reason, so auto-invoking it here would mint an authority nobody granted.
   * Both refuse, raise ONE attention item, and create NO entry — which also
   * means no muzzle and therefore no Stop-hook/stand-down deadlock. The cost is
   * the one this spec accepts everywhere: contested real work waits for a human.
   */
  #registerStandDown(
    session: Session,
    ownerMachineId: string | undefined,
    otherOwner: string,
    evidence: { reachableAt: number; lastUserMessageAt: number | null; dwellTicks: number } | undefined,
    skipped?: string,
  ): void {
    const seam = this.#deps.standDown;
    if (!seam || !ownerMachineId) return;
    const gate = (() => {
      try { return this.#deps.standDownConfig?.() ?? { enabled: false, dryRun: true }; }
      catch { return { enabled: false, dryRun: true }; }
    })();
    if (!gate.enabled) return;

    const topicId = (() => {
      try { return this.#deps.topicBinding(session.tmuxSession); } catch { return null; }
    })();
    if (topicId == null) return;

    // The operator's never-touch list wins here exactly as it wins at the
    // terminate authority. Without this, a protected session gets its tools
    // blocked and its voice 409'd, can never be drain-closed (`protected` is in
    // DRAINED_CLOSE_NEVER_BYPASSED), and rides the TTL into the frozen state
    // awaiting an operator ack — a strictly worse outcome than the duplicate,
    // reached by ignoring the one list that exists to say "not this one".
    const isProtected = (() => {
      try { return this.#deps.protectedSessions().includes(session.tmuxSession); } catch { return true; }
    })();
    if (isProtected) {
      this.audit('standdown-refused', session, { rule: 'topic-moved-away', otherOwner, refusal: 'protected' });
      return;
    }

    // Contested real work → refuse + escalate. Never a muzzle.
    const contested = (() => {
      try { return this.#deps.contestedWork?.(session, topicId) ?? null; } catch { return null; }
    })();
    if (contested) {
      this.audit('standdown-refused', session, { rule: 'topic-moved-away', otherOwner, refusal: contested });
      this.#deps.raiseStandDownAttention?.({
        id: `standdown-contested:${topicId}:${contested}`,
        priority: 'high',
        title: `Two machines are serving topic ${topicId} and this one is doing real work`,
        summary: contested === 'autonomous-run'
          ? 'A duplicate copy on this machine is running an autonomous job — your call.'
          : 'A duplicate copy on this machine holds live work — your call.',
        description: `The conversation for topic ${topicId} is being served on ${otherOwner}, but this machine also has a live session for it that is genuinely working (${contested}). Nothing has been stopped: stopping it is your decision, not mine. Either let this work finish and it will retire itself, or move/stop it deliberately.`,
      });
      return;
    }

    const epoch = (() => {
      try { return this.#deps.ownershipEpochFor?.(topicId) ?? null; } catch { return null; }
    })();
    // No epoch ⇒ no episode key ⇒ no entry. The episode latch is the only thing
    // standing between an undiagnosed creation cause and an unbounded
    // register/release cycle, so an entry that cannot be keyed is not created.
    if (epoch == null) return;

    const selfId = (() => {
      try { return this.#deps.selfMachineId?.() ?? null; } catch { return null; }
    })();

    // ── The single admission bar (spec Frontloaded Decision 5) ──
    // The closeout's upstream gate already established ownership + confirmed
    // remote liveness + the dwell, but "upstream established it" is a claim
    // about a call chain, not a check. Routing registration through the
    // predecessor's hardened validator makes the evidence CHECKABLE at the point
    // of use: trusted local identity (not self-report), self-is-owner, the
    // freshest-interaction invariant (`lastUserMessageAt <= reachableAt`), the
    // dwell against the threshold in force, and — the leg nothing else covers —
    // the AGE of the liveness proof itself, so a snapshot that went stale while
    // the owner died cannot admit a muzzle. Every refusal is named and refuses.
    if (!evidence) return;
    const assertion = {
      sessionId: session.id,
      topicId,
      ownerMachineId,
      selfMachineId: selfId ?? '',
      reachableAt: evidence.reachableAt,
      lastUserMessageAt: evidence.lastUserMessageAt,
      dwellTicks: evidence.dwellTicks,
      requiredConfirmTicks: this.cfg.topicMovedConfirmTicks,
      expiresAt: this.now() + CONFIRMED_MOVE_ASSERTION_TTL_MS,
    };
    const validated = validateConfirmedMoveAssertion(assertion, this.now(), selfId, session.id);
    if (!validated.ok) {
      this.audit('standdown-refused', session, { rule: 'topic-moved-away', otherOwner, refusal: validated.refusal });
      return;
    }

    // Whether this framework can PROVE drain decides the TTL, not whether the
    // muzzle applies: a non-claude duplicate is muzzled on VOICE immediately and
    // routes to the TTL/attention path rather than pretending it drained.
    //
    // Asked PER SESSION, not by dep presence. Testing `!this.#deps.drainObservations`
    // was always false in production (the composition root always supplies the
    // dep; it returns null per-call for a framework it cannot probe), so the
    // shorter TTL and its config key were dead code and every entry took the full
    // 60 minutes.
    // Answered by the framework's CAPABILITY, not by running the whole drain
    // probe and discarding it — that probe is a tmux capture, a full process
    // listing and a 512KB transcript read, and it was being paid on every
    // registration attempt purely to test null-ness.
    const drainUnprovable = (() => {
      try { return this.#deps.drainProvable?.(session) !== true; } catch { return true; }
    })();

    const result = seam.register({
      sessionName: session.tmuxSession,
      topicId,
      ownerMachineId,
      ownershipEpoch: epoch,
      reason: `duplicate session — topic served on ${ownerMachineId}${skipped ? ` (closeout held by ${skipped})` : ''}`,
      dryRun: gate.dryRun,
      drainUnprovable,
    }, selfId);

    if (result.ok && result.created) {
      this.audit('standdown-registered', session, {
        rule: 'topic-moved-away', otherOwner, ownerMachineId, dryRun: gate.dryRun, drainUnprovable,
      });
    } else if (!result.ok && result.refusal !== 'already-registered') {
      this.audit('standdown-refused', session, { rule: 'topic-moved-away', otherOwner, refusal: result.refusal });
    }
  }

  /**
   * The per-tick stand-down maintenance pass: re-verify, drain, close, expire.
   *
   * Order matters. RE-VERIFY runs FIRST — the agreement invariant is that an
   * entry may exist only while the record names a different owner AND that owner
   * holds a live session, and a released entry must not then be drained or
   * closed on the strength of a verdict that no longer holds.
   */
  async #standDownTick(sessions: Session[]): Promise<Set<string>> {
    /** Sessions this pass CLOSED. The caller skips them for the rest of the tick:
     *  the session list was captured at the top of the tick, so without this the
     *  closeout would re-attempt a terminate on a session that is already gone,
     *  get `already-terminal`, and register a fresh stand-down entry for a dead
     *  session — one wasted register/close cycle and a misleading audit row per
     *  drained close. */
    const closed = new Set<string>();
    const seam = this.#deps.standDown;
    if (!seam) return closed;
    const gate = (() => {
      try { return this.#deps.standDownConfig?.() ?? { enabled: false, dryRun: true }; }
      catch { return { enabled: false, dryRun: true }; }
    })();
    if (!gate.enabled) return closed;

    const entries = seam.liveEntries();
    // NOTE the ordering: the episode-level escalations at the bottom of this
    // method must run even when there are NO live entries. A latched episode's
    // whole point is that its entry was RELEASED — deleted from the map — so
    // returning early on an empty map made the "a released-then-latched live
    // duplicate is never invisible" guarantee unreachable in exactly the state it
    // exists for. Same for the health item after an operator release.
    if (entries.length > 0) {
      // A deleted or corrupted marker between transitions would silently lift the
      // muzzle until the next one, so it is refreshed while entries exist.
      seam.refreshMarker();
    }

    const byName = new Map(sessions.map((s) => [s.tmuxSession, s]));
    const now = this.now();

    for (const entry of entries) {
      const session = byName.get(entry.sessionName);
      // The session is gone — closed by another path, or merely absent for a
      // tick while it restarts. The entry has nothing left to muzzle either way,
      // and no latch is armed (a future genuine duplicate stays admissible).
      //
      // But this is NOT a retirement, and recording it as one manufactured churn
      // evidence for work the stand-down never did: a session bouncing through a
      // restart would inflate the "this topic keeps producing duplicates" count
      // toward an attention item about a retirement that never happened.
      if (!session) { seam.dropVanished(entry.sessionName); this.#standDownLastDrainReason.delete(entry.sessionName); continue; }

      // ── 1. The agreement invariant ──
      const stillOwnedElsewhere = (() => {
        try {
          const owner = this.#deps.topicOwnerElsewhereInfo?.(entry.topicId) ?? null;
          if (!owner || owner.machineId !== entry.ownerMachineId) return false;
          const liveness = this.#deps.remoteOwnerHasLiveSession?.(entry.topicId, entry.ownerMachineId) ?? { state: 'unknown' as const };
          return liveness.state === true;
        } catch { return false; }
      })();
      if (seam.reverify(entry.sessionName, stillOwnedElsewhere, 'ownership-or-liveness-leg-failed') === 'released') {
        this.audit('standdown-released', session, { rule: 'topic-moved-away', topicId: entry.topicId });
        continue;
      }

      // ── 1b. RELEASE-OR-DIVERT: the user is demonstrably addressing THIS copy ──
      // The scenario that CREATES a duplicate is routing divergence, so the
      // muzzled copy holding the user's freshest message is the EXPECTED case,
      // not an edge. Reachability wins: if the message can be handed to the
      // owner it is diverted and the muzzle holds; if it cannot — including when
      // the durable inbound queue is simply dark on this machine, which is the
      // fleet default — the entry is RELEASED and this copy answers. A muzzle
      // must never outlive the user's live attention.
      const freshLocalInbound = (() => {
        try {
          const at = this.#deps.recentUserMessageAt?.(entry.topicId) ?? null;
          return at != null && at > entry.issuedAt;
        } catch { return false; }
      })();
      if (freshLocalInbound) {
        const diverted = (() => {
          try { return this.#deps.divertInboundToOwner?.(entry.topicId, entry.ownerMachineId) === true; }
          catch { return false; }
        })();
        if (!diverted) {
          // Release IMMEDIATELY, NOT through the hysteresis. The hysteresis
          // exists to absorb a flapping peer signal; a person waiting on an
          // answer is not a flap, and making them wait two ticks for a signal
          // that is already unambiguous would be the muzzle outliving its reason.
          seam.release(entry.sessionName, 'fresh-local-inbound-undivertable');
          this.audit('standdown-released', session, { rule: 'standdown', topicId: entry.topicId, why: 'fresh-local-inbound' });
          continue;
        }
        // Diverted: the user hears from the owner. ONE per-episode notice tells
        // them which machine is answering (claimed inside the registry's budget).
        if (this.#deps.standDown?.entryFor(entry.sessionName)) this.#injectStandDownNotice(session, entry);
      }

      // ── 2. TTL. BOTH enforcement halves persist past expiry; what changes is
      //    that the human is now in the loop and the drain clock stops. ──
      if (entry.state !== 'expired' && now > entry.expiresAt) {
        seam.expire(entry.sessionName);
        if (!entry.dryRun) {
          // dryRun entries reaching TTL are the EXPECTED state (nothing is
          // blocked, so the session keeps working) — paging the operator with an
          // enforcement-shaped alarm about an observe-only mode is noise.
          this.#deps.raiseStandDownAttention?.({
            id: `standdown-expired:${entry.topicId}:${entry.sessionName}`,
            priority: 'high',
            title: `A duplicate session for topic ${entry.topicId} never went quiet`,
            summary: 'It has been asked to stand down for the full window and is now frozen, awaiting your call.',
            description: `Topic ${entry.topicId} is being served on ${entry.ownerMachineId}. The duplicate copy on this machine (${entry.sessionName}) was asked to stand down but never finished what it was holding. It is now frozen — it cannot start work and cannot send — and nothing has been destroyed. Tell me to release it and it resumes, or close it from the dashboard.`,
          });
        }
        continue;
      }
      if (entry.state === 'expired') continue; // frozen, awaiting the human

      // ── ONE observation per entry per tick, shared by the canary and the
      //    drain verdict. Each call is a tmux capture, a full host process
      //    listing and a 512KB transcript read; taking it twice doubled that
      //    cost per muzzled entry for no new information.
      //
      //    Windowed from the LAST OBSERVATION, not the fixed registration
      //    boundary — see analyseTranscriptSinceBoundary for why a fixed
      //    boundary makes "grew" monotonic and drain unreachable. Consecutive
      //    clean windows are what establish drain, which is also what lets the
      //    in-flight step the muzzle deliberately allows land in one window and
      //    be gone by the next.
      const obs = (() => {
        try { return this.#deps.drainObservations?.(session, entry.lastDrainObservedAt) ?? null; } catch { return null; }
      })();

      // ── 1c. The impossible-state canary (the ONE reachable leg) ──
      // A live ENFORCING entry whose session is COMPLETING tool calls while
      // making zero evaluate calls is the signature of a lifted, deleted, or
      // bypassed marker file. Nothing else can see it: the server never hears
      // about a call the hook short-circuited, so the absence of evaluate traffic
      // is the only observable. Checked BEFORE the drain legs, because the same
      // completed-call evidence would otherwise just read as "not drained".
      if (!entry.dryRun && entry.state !== 'expired') {
        // `calls` is the count for THIS observation window (about one tick),
        // not a cumulative total since registration. That matters: a cumulative
        // count keeps the compliant sequence — one blocked call, model complies,
        // session idles — permanently non-zero, so the canary would report the
        // SUCCESS case as a bypass ten minutes later, which is how a health
        // alarm earns the right to be ignored. The bypass signature is work
        // completing RECENTLY while the guard has not been consulted for a long
        // time, and that is what the two conditions below say together.
        const calls = obs?.nonAllowlistedCallsSinceBoundary ?? 0;
        const lastEval = entry.lastEvaluateAt;
        const evalWindowMs = 10 * 60_000;
        // `lastEval != null` is required: a compliant session never calls
        // evaluate at all, so firing without evidence the guard was ACTUALLY
        // engaged would flag the designed happy path as a bypass.
        if (calls > 0 && lastEval != null && now - lastEval > evalWindowMs) {
          seam.recordCanaryHit(entry.sessionName, `${calls} non-allowlisted call(s) completed with no evaluate traffic in ${Math.round(evalWindowMs / 60_000)}m`);
        }
      }



      // ── 3. Drain, corroborated (P20). No observations ⇒ unprovable framework
      //    ⇒ never "drained"; the entry rides its shorter TTL to the human.
      //
      // The corroborated drain is the ENTIRE justification for crossing
      // active-process + recent-user-message + open-commitment, so anything that
      // weakens this predicate is the blanket activeness bypass wearing this
      // feature's name. It has been weakened twice by accident already (once by
      // passing the tick clock as the window, once by counting requested rather
      // than completed calls), which is why the window and the counter both
      // carry their reasoning where they are computed. ──
      if (!obs) continue;
      const { evaluateDrain } = await import('../core/standDownDrain.js');
      const verdict = evaluateDrain(obs);
      const drained = seam.observeDrain(entry.sessionName, verdict.drained, now);
      // The verdict's REASON is the operator's evidence for the dryRun→enforce
      // flip ("is this predicate converging, or is it stuck on one leg?"), and
      // splitting pane-busy from unknown-pane buys nothing unless something
      // writes it down. Logged on CHANGE, not per tick — the reaper's own
      // decision-audit convention (auditability without per-tick spam).
      const reasonNow = verdict.drained ? 'drained' : verdict.reason;
      if (this.#standDownLastDrainReason.get(entry.sessionName) !== reasonNow) {
        this.#standDownLastDrainReason.set(entry.sessionName, reasonNow);
        this.audit('standdown-drain-verdict', session, {
          rule: 'standdown', topicId: entry.topicId, reason: reasonNow,
        });
      }
      if (!drained) continue;

      // ── 4. The drained close — the ONE declared carve-out. ──
      if (await this.#drainedClose(session, entry, gate.dryRun)) {
        closed.add(session.id);
        // A clean close deliberately arms NO latch (that episode ended
        // correctly), so an undiagnosed creation cause can produce a
        // spawn → register → drain → close CYCLE. It is bounded and visible
        // rather than braked — each turn of it costs a full dwell plus a full
        // drain, so it is tens of minutes, not seconds — but "bounded and
        // visible" is only true if something actually looks. This is that.
        const churn = seam.closedEpisodeCount(entry.topicId);
        if (churn > seam.closedEpisodeChurnThreshold()) {
          this.#deps.raiseStandDownAttention?.({
            id: `standdown-churn:${entry.topicId}`,
            priority: 'medium',
            title: `Topic ${entry.topicId} keeps producing duplicate sessions`,
            summary: `${churn} duplicate copies have been retired on this machine in the last day — each one cleanly, but something keeps creating them.`,
            description: `A duplicate session for topic ${entry.topicId} has been stood down and retired ${churn} times in 24 hours. Each retirement worked correctly and nothing was lost, so this is not a failure of the retirement — it is a signal that whatever creates the duplicate has not been diagnosed. Worth looking at the creation cause rather than the cleanup.`,
          });
        }
      }
    }

    // ── Anti-mutual-muzzle tiebreak ──
    // The asymmetric admission check (`self-is-owner`) means a mutual muzzle
    // needs BOTH machines' ownership records wrong at once — rare, but it is the
    // one state where cooperative quiescence silences the whole agent. The pool
    // read fires ONLY when local entries exist, so an empty registry costs zero
    // peer HTTP (the steady state on every machine).
    //
    // Chosen deterministically WHEN both sides hold the same view: the copy on
    // the lexicographically-lowest machine id releases and serves. Under
    // stale/partitioned membership the two sides may compute different live-copy
    // sets, so release-on-uncertainty governs after the grace ticks and two
    // voices become possible — the stated tradeoff. At-least-one-voice beats
    // at-most-one-voice, because failing toward silence turns a partition into
    // an unreachable agent.
    if (this.#deps.everyLiveCopyMuzzled) {
      const selfId = (() => { try { return this.#deps.selfMachineId?.() ?? null; } catch { return null; } })();
      // Prune streaks for topics that no longer have an entry — otherwise a key
      // whose entry was released mid-streak stays resident for the process
      // lifetime. Small, but an unbounded map is an unbounded map.
      const liveTopics = new Set(seam.liveEntries().map((e) => e.topicId));
      for (const t of [...this.#mutualMuzzleStreak.keys()]) if (!liveTopics.has(t)) this.#mutualMuzzleStreak.delete(t);
      for (const entry of seam.liveEntries()) {
        if (entry.state === 'closed' || entry.state === 'released') continue;
        // An EXPIRED entry is the human-arbitered state: both halves stay
        // enforced and only the PIN-gated operator release clears it. Letting
        // two ticks of an UNRESOLVABLE peer read lift it would hand the machine
        // exactly the authority the freeze exists to withhold.
        if (entry.state === 'expired') continue;
        const allMuzzled = await (async () => {
          try { return await this.#deps.everyLiveCopyMuzzled!(entry.topicId); } catch { return null; }
        })();
        const streak = (this.#mutualMuzzleStreak.get(entry.topicId) ?? 0);
        if (allMuzzled === false) { this.#mutualMuzzleStreak.delete(entry.topicId); continue; }
        // `true` (confirmed mutual muzzle) and `null` (cannot tell) BOTH advance
        // toward release: uncertainty must never leave the agent silent.
        const next = streak + 1;
        this.#mutualMuzzleStreak.set(entry.topicId, next);
        if (next < this.cfg.standDownMutualMuzzleGraceTicks) continue;
        this.#mutualMuzzleStreak.delete(entry.topicId);
        // Deterministic winner: the lowest machine id speaks. The bias (the same
        // machine always wins, including when its own bad record caused the
        // episode) is acceptable only because every mutual-muzzle episode raises
        // an attention item — a human sees each one.
        const iAmLowest = selfId != null && entry.ownerMachineId > selfId;
        if (iAmLowest || allMuzzled === null) {
          const confirmed = allMuzzled === true;
          seam.release(
            entry.sessionName,
            confirmed ? 'mutual-muzzle-tiebreak' : 'mutual-muzzle-uncertain',
            // An UNRESOLVABLE read adjudicated nothing, so it must not arm the
            // episode latch — the same rule the two send arms already follow.
            // Latching here meant one unreadable peer permanently disabled a
            // legitimate muzzle for that epoch.
            { armLatch: confirmed },
          );
          // The alarm claims a specific fact ("both machines went quiet"). Only
          // raise it when that fact was actually established; an unresolvable
          // peer read is a release for safety, not evidence of a mutual muzzle,
          // and telling the operator otherwise is a false report.
          if (confirmed) {
            this.#deps.raiseStandDownAttention?.({
              id: `standdown-mutual-muzzle:${entry.topicId}`,
              priority: 'high',
              title: `Both machines went quiet on topic ${entry.topicId}`,
              summary: 'Each thought the other was serving it. I have resumed answering here so you are not left without a reply.',
              description: `For topic ${entry.topicId}, this machine and ${entry.ownerMachineId} each recorded the OTHER as the owner, so both copies went quiet — which would have left you with no answer at all. I have resumed on this machine. The underlying disagreement about who owns that conversation is worth a look.`,
            });
          } else {
            this.audit('standdown-released', { id: entry.sessionName, name: entry.sessionName, tmuxSession: entry.sessionName } as Session, {
              rule: 'standdown', topicId: entry.topicId, why: 'mutual-muzzle-uncertain',
            });
          }
        }
      }
    }

    // ── Episode-level escalations, once per episode by construction ──
    // A LATCHED episode whose producers keep re-attempting means a duplicate is
    // live and un-muzzled: the latch is doing its P19 job, but silently, and a
    // released-then-latched live duplicate must never be invisible.
    for (const latch of seam.claimLatchAttention()) {
      this.#deps.raiseStandDownAttention?.({
        id: `standdown-latched:${latch.topicId}`,
        priority: 'high',
        title: `Topic ${latch.topicId} keeps looking like a duplicate`,
        summary: `I've stopped re-asking that copy to stand down after ${latch.blockedAttempts} attempts — something keeps re-creating it.`,
        description: `A session for topic ${latch.topicId} on this machine has repeatedly been judged a duplicate, but each stand-down was released or expired, so I stopped re-issuing it (that brake is deliberate — otherwise it would loop). The duplicate is likely still there. Worth looking at why the copy keeps being created.`,
      });
    }

    // The standdown-health trigger. Expiry means the cooperative primitive did
    // not converge; a canary hit means enforcement was silently lifted. Both are
    // "a human should look at this", neither is an emergency.
    const health = seam.health();
    if (health.due && !this.#standDownHealthRaised) {
      this.#standDownHealthRaised = true;
      this.#deps.raiseStandDownAttention?.({
        id: 'standdown-health',
        priority: 'medium',
        title: 'The duplicate stand-down needs a look',
        summary: health.canaryHits > 0
          ? 'A muzzled session kept working — the guard may not be in effect.'
          : `${health.expiredEpisodes} duplicate sessions were asked to stand down and never went quiet.`,
        description: `Over the last week: ${health.expiredEpisodes} stand-down(s) reached their time limit without the session going quiet, and ${health.canaryHits} case(s) where a session that should have been held was still completing work. Nothing was destroyed in either case. This is the signal that the cooperative approach is not converging here and is worth a look.`,
      });
    } else if (!health.due) {
      this.#standDownHealthRaised = false;
    }

    // Latches keyed on a superseded epoch are dead weight.
    try {
      const epochs = new Map<number, number>();
      for (const s of sessions) {
        const t = this.#deps.topicBinding(s.tmuxSession);
        if (t == null) continue;
        const e = this.#deps.ownershipEpochFor?.(t);
        if (e != null) epochs.set(t, e);
      }
      seam.pruneLatches(epochs);
    } catch { /* @silent-fallback-ok — pruning is housekeeping; a failure just delays it */ }

    return closed;
  }

  /** Whether the once-per-condition standdown-health item is currently raised. */
  #standDownHealthRaised = false;
  /** Consecutive ticks a topic has looked mutually-muzzled (or unresolvable).
   *  Mirrors the release hysteresis: a single stale membership read must not
   *  break a legitimate muzzle. */
  #mutualMuzzleStreak = new Map<number, number>();
  /** Last audited drain-verdict reason per muzzled session — change-only audit. */
  #standDownLastDrainReason = new Map<string, string>();

  /**
   * The ONE injected tmux notice per episode. Injected into the MUZZLED session
   * rather than sent to the user: the user hears from the owner machine, and
   * this copy's own send path is refused by construction. The registry owns the
   * per-episode budget and suppresses it entirely in dryRun.
   */
  #injectStandDownNotice(session: Session, entry: { sessionName: string; ownerMachineId: string }): void {
    try {
      // The TMUX channel's own budget. It is deliberately distinct from the
      // user-facing standby line's: sharing one budget meant whichever fired
      // first permanently silenced the other, so a divert could leave the user
      // with nothing at all — the opposite of the "one honest line" this design
      // promises.
      if (!this.#deps.claimStandDownNotice?.(entry.sessionName, 'session')) return;
      this.#deps.injectNotice?.(
        session.tmuxSession,
        `This session is standing down: the conversation and its work continue on machine ${entry.ownerMachineId}. `
        + 'Your message was handed to that machine. Stop starting work and remain idle — this session will be closed cleanly.',
      );
    } catch { /* @silent-fallback-ok — the notice is courtesy; the hook's block message is the load-bearing channel */ }
  }

  /**
   * Close a DRAINED stand-down. The bounded, standard-shaped exit the three
   * prior ad-hoc closeout bypasses were groping toward: an explicit, corroborated,
   * narrowly-scoped crossing of exactly three named keep-reasons, never a fourth
   * ad-hoc flag. Everything else in the cascade is still re-checked.
   */
  async #drainedClose(
    session: Session,
    entry: { sessionName: string; topicId: number; ownerMachineId: string },
    dryRun: boolean,
  ): Promise<boolean> {
    const { drainedCloseReason } = await import('../core/standDownDrain.js');
    const reason = drainedCloseReason(entry.ownerMachineId);
    if (dryRun || !this.killsEnabled) {
      this.audit('would-reap', session, { rule: 'standdown-drained-close', dryRun: true, otherOwner: entry.ownerMachineId });
      return false;
    }
    // Counts against the ordinary reap budgets — a drained close is a close.
    if (this.hourlyBudgetRemaining() <= 0) return false;
    // The authority VERIFIES this claim against its own registry probe and then
    // applies its OWN frozen bypass list — this call cannot name reasons.
    const res = await this.#deps.terminate(session.id, reason, {
      standDownDrainedClose: true,
      workEvidence: [],
      localPostTransferCloseout: true,
    });
    if (res.terminated) {
      this.reapTimestamps.push(this.now());
      this.#deps.standDown?.markClosed(entry.sessionName);
      this.audit('reaped', session, { rule: 'standdown-drained-close', otherOwner: entry.ownerMachineId });
      return true;
    } else {
      // A guard OUTSIDE the crossed three still holds it — the correct outcome.
      // The entry stays; the TTL/attention path carries it to the human.
      this.audit('reap-skipped-topic-moved', session, {
        rule: 'standdown-drained-close', otherOwner: entry.ownerMachineId, skipped: res.skipped,
      });
    }
    return false;
  }

  /**
   * Shared closeout terminate machinery — the dwell has been met. Handles the P19
   * breaker, dry-run, budget caps, the guarded terminate, and the veto/breaker
   * audit. `key` is session.id (legacy) or the topic id (gated); `bypassRecentForMove`
   * is passed through to terminate ONLY on a liveness-confirmed genuine move.
   */
  async #attemptCloseoutTerminate(args: {
    session: Session;
    otherOwner: string;
    reason: string;
    streak: number;
    key: string | number;
    reapedThisTick: number;
    bypassRecentForMove: boolean;
    confirmedMove?: boolean;
    snapshotReachableAt?: number;
    /** The owner's stable machine id (distinct from `otherOwner`, which is the
     *  human-facing display name). The stand-down's episode key and its block
     *  message both need the ID, never the nickname. */
    ownerMachineId?: string;
    /** The evidence the stand-down registration is validated against. Absent ⇒
     *  no assertion can be built ⇒ no stand-down (fail toward doing nothing). */
    standDownEvidence?: { reachableAt: number; lastUserMessageAt: number | null; dwellTicks: number };
  }): Promise<{ terminated: boolean; reapedThisTick: number }> {
    const { session, otherOwner, reason, streak, key, bypassRecentForMove } = args;
    let { reapedThisTick } = args;
    const vetoes = this.topicMovedVetoes.get(key) ?? 0;

    if (vetoes >= this.cfg.topicMovedVetoBreakerAttempts) {
      // P19 breaker OPEN — stop retrying for the episode (audited+escalated once).
      return { terminated: false, reapedThisTick };
    }
    if (!this.killsEnabled) {
      if (streak === this.cfg.topicMovedConfirmTicks) {
        this.audit('would-reap', session, { rule: 'topic-moved-away', otherOwner, dryRun: true });
      }
      return { terminated: false, reapedThisTick };
    }
    if (reapedThisTick < this.cfg.maxReapsPerTick && this.hourlyBudgetRemaining() > 0) {
      // F8 carve-out: this assertion is emitted only after the ownership+dwell
      // transition above. Production wires this private dependency to the
      // SessionManager authority closure captured at manager construction;
      // public terminateSession drops the same-shaped forged option.
      const res = await this.#deps.terminate(session.id, reason, bypassRecentForMove
        ? { bypassRecentUserMessageForConfirmedMove: true, workEvidence: [], localPostTransferCloseout: true }
        : { localPostTransferCloseout: true });
      if (res.terminated) {
        reapedThisTick++;
        this.reapTimestamps.push(this.now());
        this.audit('reaped', session, {
          rule: 'topic-moved-away', otherOwner,
          ...(args.confirmedMove ? { confirmedMove: true, snapshotReachableAt: args.snapshotReachableAt } : {}),
        });
        this.topicMovedStreak.delete(key);
        this.topicMovedVetoes.delete(key);
        return { terminated: true, reapedThisTick };
      }
      // ── The stand-down producer (docs/specs/duplicate-session-standdown.md) ──
      // THIS is the seam. The closeout's KEEP-guards just refused to end a
      // duplicate — and a duplicate is BUSY by construction, so without a second
      // primitive the wrong copy survives until a human kills it. Rather than
      // widen the kill (round-4 review rejected that), register a cooperative
      // stand-down: the copy stops starting work and stops speaking, finishes
      // what it holds, and the drained-close retires it.
      //
      // Registered on the VETO path only, deliberately: an idle leftover is
      // still closed outright by the terminate above, exactly as today. Nothing
      // about the existing happy path changes.
      this.#registerStandDown(session, args.ownerMachineId, otherOwner, args.standDownEvidence, res.skipped);

      // Guard veto / already-terminal — audit once per streak crossing, keep the
      // streak so next tick retries (bounded by the breaker).
      const v = vetoes + 1;
      this.topicMovedVetoes.set(key, v);
      if (streak === this.cfg.topicMovedConfirmTicks) {
        this.audit('reap-skipped-topic-moved', session, { rule: 'topic-moved-away', otherOwner, skipped: res.skipped });
      }
      if (v === this.cfg.topicMovedVetoBreakerAttempts) {
        this.audit('closeout-breaker-open', session, {
          rule: 'topic-moved-away', otherOwner, vetoedAttempts: v, lastSkipped: res.skipped ?? 'keep-guard',
        });
        const topicId = this.#deps.topicBinding(session.tmuxSession);
        this.#deps.raiseAttention?.({
          id: `closeout-breaker:${session.id}`,
          title: `Topic ${topicId ?? '?'} moved to ${otherOwner}, but the old session won't close`,
          summary: `Post-transfer closeout gave up after ${v} vetoed attempts (held by: ${res.skipped ?? 'keep-guard'}).`,
          description: `The conversation for topic ${topicId ?? '?'} now lives on ${otherOwner}, but the leftover session on this machine (${session.tmuxSession}) refused to close ${v} times in a row — a KEEP-guard reports it is still working (${res.skipped ?? 'keep-guard'}). Closeout retries have stopped (P19 breaker); the session will close via the normal idle path when it finishes, or you can close it from the dashboard.`,
        });
      }
    }
    return { terminated: false, reapedThisTick };
  }

  async tick(): Promise<void> {
    if (!this.cfg.enabled || this.running) return;
    this.running = true;
    this.lastTickAt = this.now();
    try {
      const pressure = this.#deps.pressure();
      const threshold = this.thresholdMs(pressure.tier);
      const sessions = this.#deps.listRunningSessions();
      const live = new Set(sessions.map(s => s.id));
      // GC obs for vanished sessions.
      for (const id of [...this.obs.keys()]) if (!live.has(id)) { this.obs.delete(id); this.#deps.clearReaping(id); }
      for (const id of [...this.lastAuditedDecision.keys()]) if (!live.has(id)) this.lastAuditedDecision.delete(id);
      for (const id of [...this.cpuSamples.keys()]) if (!live.has(id)) this.cpuSamples.delete(id);
      for (const id of [...this.busyOrphanStreak.keys()]) if (!live.has(id)) this.busyOrphanStreak.delete(id);
      if (this.cfg.closeoutLivenessGate) {
        // Gated: the closeout maps are keyed on the stable TOPIC id, so a naive
        // "GC any topic without a live session THIS tick" would erase the count
        // during the brief gap between a session dying and its same-topic respawn
        // appearing — defeating the topic key. Instead evict a topic entry only
        // when it has had no live binding AND was not owned-elsewhere for a grace
        // window (2× tickIntervalSec — survives one full respawn gap). `lastSeenAt`
        // is stamped on every entry whenever its topic is bound/owned-elsewhere.
        const liveTopics = new Set<number>();
        for (const s of sessions) { const t = this.#deps.topicBinding(s.tmuxSession); if (t != null) liveTopics.add(t); }
        const graceMs = 2 * this.cfg.tickIntervalSec * 1000;
        const now = this.now();
        for (const [key, val] of [...this.topicMovedStreak.entries()]) {
          if (typeof key !== 'number') { this.topicMovedStreak.delete(key); continue; } // stale OFF-mode key
          if (liveTopics.has(key)) continue; // still bound — keep
          const lastSeen = typeof val === 'object' ? val.lastSeenAt : 0;
          if (now - lastSeen > graceMs) { this.topicMovedStreak.delete(key); this.topicMovedVetoes.delete(key); }
        }
        // topicMovedVetoes with no streak entry left (and not a live topic) → drop.
        for (const key of [...this.topicMovedVetoes.keys()]) {
          if (typeof key !== 'number') { this.topicMovedVetoes.delete(key); continue; }
          if (!liveTopics.has(key) && !this.topicMovedStreak.has(key)) this.topicMovedVetoes.delete(key);
        }
      } else {
        // OFF (legacy): keyed on session.id — GC any id not in the live set.
        for (const id of [...this.topicMovedStreak.keys()]) if (typeof id === 'number' || !live.has(id)) this.topicMovedStreak.delete(id);
        for (const id of [...this.topicMovedVetoes.keys()]) if (typeof id === 'number' || !live.has(id)) this.topicMovedVetoes.delete(id);
      }

      // ── Duplicate-session stand-down maintenance (docs/specs/duplicate-session-standdown.md) ──
      // Runs BEFORE the per-session loop so a released entry cannot be drained or
      // closed later in the same tick on a verdict that no longer holds. Wrapped:
      // this is remediation for a duplicate, and it must never be able to take
      // down the reaper's primary job.
      let standDownClosed = new Set<string>();
      try {
        standDownClosed = await this.#standDownTick(sessions);
      } catch (err) {
        // The wrapper exists so remediation for a duplicate can never take down
        // the reaper's primary job — but a swallowed exception is also how a
        // broken seam stays invisible, so it is LOUD in both channels rather
        // than an audit row nobody reads.
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[SessionReaper] stand-down maintenance pass threw (duplicate remediation is degraded this tick): ${msg}`);
        this.audit('standdown-tick-error', sessions[0] ?? ({ id: '-', name: '-', tmuxSession: '-' } as Session), {
          rule: 'standdown', error: msg,
        });
      }

      let reapedThisTick = 0;
      for (const session of sessions) {
        // Already retired by this tick's drained close — the captured list is stale.
        if (standDownClosed.has(session.id)) continue;
        // ── Post-transfer closeout (operator-named issue, 2026-06-05) ──────
        // A topic-bound session whose topic is now OWNED BY ANOTHER MACHINE is
        // a leftover from a move/failover: the conversation continues on the
        // owning machine, and this one only does duplicate work. Independent of
        // the idle pipeline (a duplicate is wrong even when busy), but the kill
        // still goes through the guarded `terminate` authority — a KEEP-guard
        // veto is audited and retried next tick (eventual closeout, never a
        // forced kill). Dwell of `topicMovedConfirmTicks` absorbs ownership
        // churn mid-transfer.
        if (this.cfg.topicMovedCloseout && (this.#deps.topicOwnerElsewhere || this.#deps.topicOwnerElsewhereInfo)) {
          const outcome = this.cfg.closeoutLivenessGate
            ? await this.#runCloseoutGated(session, reapedThisTick)
            : await this.#runCloseoutLegacy(session, reapedThisTick);
          reapedThisTick = outcome.reapedThisTick;
          if (outcome.terminated) continue; // session is gone — skip the idle pipeline
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
          this.#deps.clearReaping(session.id);
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
            this.#deps.clearReaping(session.id);
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
          this.#deps.clearReaping(session.id);
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
              await this.#performReap(session, pressure, next, relaxedActiveProcess); // clears the lease on every path
              reapedThisTick++;
            } else {
              // Grace elapsed but the reap is gated (tier dropped / budget spent).
              // Release the reaping lease so the idle-kill safety net is not
              // permanently disabled for this session.
              this.#deps.clearReaping(session.id);
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
          this.#deps.markReaping(session.id);
          this.audit('reap-pending', session, { tier: pressure.tier, idleMs, thresholdMs: threshold });
        }
        this.obs.set(session.id, next);
      }
      this.persistCandidacy(); // durable candidacy (A): the idle clock survives restarts
    } finally {
      this.running = false;
    }
  }

  async #performReap(
    session: Session,
    pressure: PressureReading,
    obs: Obs,
    relaxedActiveProcess = false,
  ): Promise<void> {
    const detail = { tier: pressure.tier, idleMs: this.now() - obs.candidateSince, dryRun: !this.killsEnabled };
    if (!this.killsEnabled) {
      this.audit('would-reap', session, detail); // dry-run: log, do not kill
      this.#deps.clearReaping(session.id);
      return;
    }
    try {
      // bypassActiveProcessKeep: carry the reaper's already-applied active-process
      // relaxation to the authority so it doesn't re-veto on the un-relaxed shared
      // guard (the 1,532× skipped:active-process stalemate). Scoped to active-process
      // only; every other KEEP-guard is still enforced by terminateSession.
      // Build-Session Yield Safety (ACT-839): an idle session can still have a
      // DIRTY worktree (uncommitted edits sitting there). Collect that here,
      // PRE-kill, in the reaper's own loop — never a synchronous git call on the
      // terminate chokepoint. `dirtyCheck` is present only when the dev-gated
      // feature is live; it is bounded + fail-open internally.
      const workEvidence: string[] = [];
      if (this.#deps.dirtyCheck && session.cwd) {
        try { if (this.#deps.dirtyCheck(session.cwd)) workEvidence.push('uncommitted-worktree-work'); }
        catch { /* @silent-fallback-ok: SPEC-MANDATED fail-open — evidence collection NEVER endangers the kill path; a dirty-check failure just omits the signal (the kill proceeds with the evidence gathered so far). */ }
      }
      const r = await this.#deps.terminate(session.id, 'reaped-idle', {
        bypassActiveProcessKeep: relaxedActiveProcess,
        // Pre-relaxation verdict as killer-supplied evidence (reap-notify R2.1):
        // an idle-reap means this reaper PROVED no active work — assert that set
        // authoritatively (now possibly carrying uncommitted-worktree-work) so
        // the chokepoint fallback can't re-stamp the active-process signal the
        // relaxation just disproved.
        workEvidence,
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
      this.#deps.clearReaping(session.id);
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
    if (this.#deps.audit) this.#deps.audit(entry);
  }

  /** Observability snapshot for GET /sessions/reaper. */
  snapshot(): {
    enabled: boolean; dryRun: boolean; autoDisabled: boolean; lastTickAt: number;
    pressure: PressureReading; activeThresholdMinutes: number | null;
    reapsLastHour: number;
    sessions: Array<{ name: string; sessionId: string; verdict: Verdict; keptBy: string; confidence: Confidence; consecutive: number; idleMs: number; reapPending: boolean }>;
  } {
    const pressure = this.#deps.pressure();
    const threshold = this.thresholdMs(pressure.tier);
    const now = this.now();
    const sessions = this.#deps.listRunningSessions().map(s => {
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

export interface ReaperAuditPage {
  entries: Array<Record<string, unknown>>;
  returned: number;
  truncated: boolean;
}

/**
 * Read a bounded page of the reaper audit trail (newest last). Scans backward
 * until it finds `limit + 1` VALID JSON rows, so a corrupt/torn tail line cannot
 * consume the truncation probe and make older valid evidence look absent.
 */
export function readReaperAuditPage(stateDir: string, limit: number): ReaperAuditPage {
  const logPath = reaperAuditPath(stateDir);
  let raw: string;
  try {
    raw = fs.readFileSync(logPath, 'utf-8');
  } catch (err) {
    // Absent means no trail yet. Other read failures cannot prove completeness.
    const absent = (err as NodeJS.ErrnoException).code === 'ENOENT';
    return { entries: [], returned: 0, truncated: !absent };
  }
  const lines = raw.split('\n').filter(l => l.trim().length > 0);
  const wanted = Math.max(0, Math.floor(limit));
  const foundNewestFirst: Array<Record<string, unknown>> = [];
  for (let i = lines.length - 1; i >= 0 && foundNewestFirst.length <= wanted; i--) {
    try {
      foundNewestFirst.push(JSON.parse(lines[i]) as Record<string, unknown>);
    } catch { /* skip a torn line and keep scanning for valid history */ }
  }
  const truncated = foundNewestFirst.length > wanted;
  const entries = foundNewestFirst.slice(0, wanted).reverse();
  return { entries, returned: entries.length, truncated };
}

/**
 * Read the tail of the reaper audit trail (newest last), bounded to `limit`
 * valid rows. Returns [] when the file is absent or unreadable — never throws.
 */
export function readReaperAudit(stateDir: string, limit: number): Array<Record<string, unknown>> {
  return readReaperAuditPage(stateDir, limit).entries;
}

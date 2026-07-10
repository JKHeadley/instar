/**
 * Session Manager — spawn and monitor Claude Code sessions via tmux.
 *
 * This is the core capability that transforms Claude Code from a CLI tool
 * into a persistent agent. Sessions run in tmux, survive terminal disconnects,
 * and can be monitored/reaped by the server.
 */

import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionLivenessOracle, type SessionLivenessOracleConfig } from './SessionLivenessOracle.js';
import { resolveGhTokenFromVault } from './ghToken.js';
import type { ReapGuard, ReapKeepReason } from './ReapGuard.js';
import { clampWorkEvidence, isMidWork } from './WorkEvidence.js';
import { resolveFrameworkTranscriptPath } from './FrameworkSessionStore.js';
import { paneShowsClaudeWorking } from './claudeActivityIndicators.js';
import { extractGeminiFinalAssistantBlock, meaningfulTail } from './paneText.js';
import { ensureInteractiveReady } from './ensureInteractiveReady.js';
import { withSyncOp } from './InFlightSyncOpMarker.js';
import type { DegradedTmuxGuard } from '../monitoring/DegradedTmuxGuard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Diagnostics for a single running session */
export interface SessionDiagnostic {
  name: string;
  id: string;
  jobSlug?: string;
  ageMinutes: number;
  maxDurationMinutes?: number;
  isStale: boolean;
  staleReason?: string;
}

/** System memory pressure levels */
export type MemoryPressure = 'low' | 'moderate' | 'high' | 'critical';

/** Full diagnostics snapshot for intelligent scheduling decisions */
export interface SessionDiagnostics {
  sessions: SessionDiagnostic[];
  maxSessions: number;
  staleSessions: SessionDiagnostic[];
  memoryPressure: MemoryPressure;
  memoryUsedPercent: number;
  freeMemoryMB: number;
  totalMemoryMB: number;
  suggestions: string[];
}
import { DegradationReporter } from '../monitoring/DegradationReporter.js';
import { detectRateLimited, nextIdleThrottleAction, RATE_LIMIT_SETTLED_CAPTURE_LINES, type ThrottleSettleState } from '../monitoring/rateLimitDetection.js';
import { classifyIdleError } from './IdleErrorClassifier.js';
import { InputGuard, type TopicBinding } from './InputGuard.js';
import type { InputDetector } from '../monitoring/PromptGate.js';
import { toPaneTailLines, type PermissionPromptAutoResolver } from '../monitoring/PermissionPromptAutoResolver.js';

const execFileAsync = promisify(execFile);
import type { Session, SessionManagerConfig, SessionStatus, ModelTier } from './types.js';
import type { IntelligenceFramework } from './intelligenceProviderFactory.js';
import {
  resolveBaselineServers,
  resolveSessionMcpServers,
  filterMcpConfig,
  type McpJson,
} from './dynamicMcpConfig.js';
import {
  buildInteractiveLaunch,
  buildHeadlessLaunch,
  claudeHeadlessExtraFlags,
  resolveInteractiveFramework,
  resolveModelForFramework,
} from './frameworkSessionLaunch.js';
import { frameworkFromEnv } from './intelligenceProviderFactory.js';
import { decideSdkVsSubscription, DEFAULT_SAFETY_MARGIN_FRACTION } from '../providers/costAwareRouting.js';
import {
  resolveCodexLaunchModelWithUsage,
  type CodexModelSwapConfig,
} from '../providers/adapters/openai-codex/observability/codexModelSwapPolicy.js';
import { StateManager } from './StateManager.js';
import { buildInjectionTag } from '../types/pipeline.js';
import { sanitizeSenderName, sanitizeTopicName } from '../utils/sanitize.js';
import { getTelegramInboundDir } from '../messaging/shared/telegramInboundFiles.js';
import { SessionBuildContextStore } from './SessionBuildContextStore.js';
import { PendingInjectStore, sweepPendingInjects } from './PendingInjectStore.js';
import { AgeKillBackoff } from './AgeKillBackoff.js';
import { governor, consumeAdmissionToken } from '../monitoring/selfaction/governor.js';
import type { DerivedTarget } from '../monitoring/selfaction/types.js';
import { VetoedKillBackoff, normalizeReasonKey, IDLE_ZOMBIE_ESCALATION_REASONS } from './VetoedKillBackoff.js';
import type { IncidentDedupe } from '../monitoring/IncidentDedupe.js';

/* @self-action-controller: age-kill-backoff */
// Unified self-action backpressure (Increment B, OBSERVE-ONLY): the age-limit
// kill request rides the SelfActionGovernor chokepoint. The handle is minted
// ONCE at module scope (companion §2); in observe mode admit records the
// would-verdict and always allows — behavior is unchanged until the operator
// flips this class to enforce (FD8).
const ageKillGov = governor.for('age-kill-backoff');

/** The canonical target derivation for the age-kill controller (companion §1):
 *  instar session ids are stable per topic across respawns, so the session id
 *  IS the recurrence identity — a stable key, never a per-incarnation pid. */
export function deriveTargetKey(sessionId: string): DerivedTarget {
  return { key: `session:${sessionId}`, classId: 'session', keyIsVolatile: false };
}

/** Absolute maximum session duration (4 hours) — safety net for sessions without explicit timeout */
const DEFAULT_MAX_DURATION_MINUTES = 240;

/** Age-gate transcript-activity window (ms). A session whose framework transcript
 *  (JSONL) was modified within this window is treated as actively producing work
 *  — the same "defer the kill" treatment a live child process gets — even when
 *  its tmux pane shows an idle-looking prompt and it has no non-baseline child
 *  process. This closes the age-kill blind spot to MCP/tool work (Playwright and
 *  other MCP servers run OUT of the pane's process tree; bash tool calls are
 *  short-lived), which terminal-killed an actively-working session on 2026-06-13.
 *  Claude Code appends to the JSONL on every turn/tool event, so a recent mtime
 *  is ground-truth liveness independent of the pane. 2 min comfortably covers the
 *  gap between tool calls; over-deferring a just-finished session for up to one
 *  window is harmless (the idle-detection block below still reaps it later). */
const AGE_GATE_TRANSCRIPT_ACTIVE_MS = 120_000;

/**
 * Pure age-gate idle decision — extracted so the exact 2026-06-13 incident can be
 * reproduced at the decision boundary (Bug-Fix Evidence Bar). A session past its
 * age limit is "truly idle" — and thus age-kill-eligible — ONLY when ALL THREE
 * hold: its pane shows an idle prompt, it has no non-baseline child process, and
 * its framework transcript is not recently active. Any ONE positive activity
 * signal (a live child process OR a growing transcript) defers the kill. The
 * transcript term is the fix: it closes the blind spot to MCP/tool work that runs
 * OUT of the pane's process tree. The incident inputs
 * (idleAtPrompt=true, hasActiveProcs=false, transcriptActive=true) return
 * `false` ⇒ DEFERRED, not killed — which the pre-fix two-signal decision got wrong.
 */
export function isAgeGateTrulyIdle(
  idleAtPrompt: boolean,
  hasActiveProcs: boolean,
  transcriptActive: boolean,
): boolean {
  return idleAtPrompt && !hasActiveProcs && !transcriptActive;
}

/** Minutes of idle-at-prompt before a non-protected session is killed */
const IDLE_PROMPT_KILL_MINUTES = 15;

/** Minutes of idle-at-prompt before a session bound to a live messaging topic is killed.
 *  Topic-bound sessions are *waiting* for the user — idle is healthy.
 *  Default 4h (240m): conservative balance between "conversational pauses through a
 *  workday don't trigger respawn" and "memory/connection pressure from sessions held
 *  indefinitely". Each held session retains a Claude TUI process (~200-500MB RSS)
 *  and an Anthropic connection — multi-topic agents on smaller hosts could feel a
 *  longer default. Operators with always-on conversations can override via
 *  `idlePromptKillMinutesBoundToTopic` in config. */
const IDLE_PROMPT_KILL_MINUTES_BOUND_TO_TOPIC = 240;

/** Fallback constants — used when config values are not set */
const FALLBACK_MAX_DURATION_MINUTES = DEFAULT_MAX_DURATION_MINUTES;
const FALLBACK_IDLE_PROMPT_KILL_MINUTES = IDLE_PROMPT_KILL_MINUTES;
const FALLBACK_IDLE_PROMPT_KILL_MINUTES_BOUND_TO_TOPIC = IDLE_PROMPT_KILL_MINUTES_BOUND_TO_TOPIC;

/** Patterns that indicate Claude is sitting at its idle prompt (not actively working).
 *  Exported for ModelSwapService (§5.3 of FABLE-MODEL-ESCALATION-SPEC) — the
 *  mid-session swap must verify prompt-ready idleness from the same source of
 *  truth the monitor loop uses, not a parallel copy that can drift. */
export const IDLE_PROMPT_PATTERNS = [
  'bypass permissions on',
  'shift+tab to cycle',
  'auto-accept edits',
  // The bare prompt character at end of output (after stripping ANSI)
];

/**
 * Patterns in terminal output that indicate an API or tool error caused the session to stop.
 * When detected at the idle prompt, we nudge the session to continue instead of killing it.
 */
export const TERMINAL_ERROR_PATTERNS = [
  'API Error:',
  'invalid_request_error',
  'Could not process',
  'overloaded_error',
  'rate_limit_error',
  'Request timed out',
  'Internal server error',
  'ServiceUnavailable',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'fetch failed',
];

/** Runaway cap: max error-nudges per session across its whole lifetime, regardless of
 *  per-episode re-arming. A session that flaps error→nudge→error this many times has a
 *  persistent problem (not a transient API blip) and should fall through to zombie-kill
 *  rather than be nudged forever. Generous enough that a long autonomous run with
 *  genuinely-transient errors never hits it. */
const MAX_ERROR_NUDGES_PER_SESSION = 50;

/**
 * Pure gate for the post-API-error nudge (the 2026-05-29 re-arm fix). A session is
 * nudged only when it has NOT already been nudged in the CURRENT idle episode
 * (`armedThisEpisode` false) AND it is under the lifetime runaway cap. The episode
 * flag is cleared on recovery, so a long-running session that hits a SECOND transient
 * API error is nudged again — fixing the prior once-per-session-forever strand.
 * Exported so the decision boundary is unit-testable without driving the tmux loop.
 */
export function shouldErrorNudge(armedThisEpisode: boolean, totalNudges: number, max: number = MAX_ERROR_NUDGES_PER_SESSION): boolean {
  return !armedThisEpisode && totalNudges < max;
}

/**
 * Parse a `ps -o time` accumulated-CPU-time string to seconds. Handles the
 * formats ps emits across platforms: `MM:SS`, `MM:SS.ss`, `HH:MM:SS`, and the
 * day-prefixed `DD-HH:MM:SS` (Linux/BSD). Returns 0 on anything unparseable —
 * used as a CPU-progress delta signal, so a bad sample just reads as no growth.
 * Exported for unit tests.
 */
export function parseProcTimeToSeconds(raw: string): number {
  if (!raw) return 0;
  let rest = raw.trim();
  let days = 0;
  // Optional leading "DD-" day count (only when it looks like `<digits>-`).
  const dashMatch = /^(\d+)-(.+)$/.exec(rest);
  if (dashMatch) {
    days = parseInt(dashMatch[1], 10) || 0;
    rest = dashMatch[2];
  }
  const parts = rest.split(':');
  let seconds = 0;
  for (const part of parts) {
    const n = parseFloat(part);
    if (Number.isNaN(n)) return 0;
    seconds = seconds * 60 + n; // sexagesimal accumulate: [HH,MM,SS] → HH*3600+MM*60+SS
  }
  return days * 86400 + seconds;
}

/**
 * Process names that are always running in a Claude Code session (MCP servers, etc.)
 * These do NOT indicate activity — they're background infrastructure.
 */
const BASELINE_PROCESS_PATTERNS = [
  /\bplaywright-mcp\b/,
  /\bplaywright\/mcp\b/,
  /\bmcp-stdio-entry\b/,
  /\bmcp.*server\b/i,
  /\bcaffeinate\b/,
  /\bnpm exec\b.*mcp/,
];

/** Sanitize a string for use as part of a tmux session name. */
function sanitizeSessionName(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  return sanitized || 'session';
}

export interface SessionManagerEvents {
  sessionComplete: [session: Session];
  /**
   * Emitted when a session goes idle after a server-side throttle ("Server is
   * temporarily limiting requests · not your usage limit") rather than a
   * generic API error. The RateLimitSentinel owns recovery from here — the
   * immediate single-nudge is deliberately skipped for this case.
   */
  rateLimitedAtIdle: [sessionName: string];
}

/**
 * Tri-state outcome of a hot-path tmux call (tmux-event-loop-resilience §A).
 * Modeled on SessionLivenessOracle.classify: `success` and `definitely-absent`
 * are the ONLY positive signals; everything else (timeout, server-unreachable,
 * unknown error) is `indeterminate` — and a destructive action keyed on a tmux
 * read must treat `indeterminate` as KEEP (never reap). A timeout becomes
 * `indeterminate`, NEVER `definitely-absent`.
 */
type TmuxOutcome =
  | { state: 'success'; stdout: string }
  | { state: 'definitely-absent'; reason: string }
  | { state: 'indeterminate'; reason: string };

/** Options threaded from server boot — the resolved (A)/(C) gate wiring.
 *  All optional so the (40+) existing 2-arg constructor callers (and every
 *  off-path/test caller) keep today's behavior byte-for-byte: tmuxAsyncEnabled
 *  defaults false ⇒ the legacy sync hot path runs unchanged. */
export interface SessionManagerOptions {
  /** (A) — when true, monitorTick drives the bounded async tmux hot-path twins
   *  and isSessionAliveAsync returns tri-state. Resolved server-side via
   *  resolveDevAgentGate(monitoring.tmuxResilience.asyncHotPath.enabled). */
  tmuxAsyncEnabled?: boolean;
  /** (C) latency feed — the async wrapper reports each call's duration+outcome.
   *  Optional-chained, so (A) can land before the (C) guard is wired. */
  degradedTmuxGuard?: DegradedTmuxGuard;
  /** Per-call SIGKILL-bounded timeout for the async wrapper (ms). Server boot
   *  threads monitoring.tmuxResilience.asyncHotPath.timeoutMs; absent ⇒ 9000. */
  tmuxCallTimeoutMs?: number;
  /** Max concurrent in-flight hot-path tmux calls before fail-closed-to-keep.
   *  Server boot threads monitoring.tmuxResilience.asyncHotPath.maxInFlight;
   *  absent ⇒ TMUX_MAX_INFLIGHT_DEFAULT (8). */
  tmuxMaxInFlight?: number;
  /** DARK-FLAGGED: when true, the idle-monitor gates the `rateLimitedAtIdle` emit
   *  behind the SAME settle discipline the SessionWatchdog already uses (a throttle
   *  must be present AND the pane byte-identical across polls before handing to
   *  recovery), instead of firing on a single glance. Strictly more conservative —
   *  can only emit LESS often. Resolved server-side via
   *  resolveDevAgentGate(monitoring.idleThrottleSettleGate.enabled). Absent ⇒ legacy
   *  immediate emit, unchanged. */
  idleThrottleSettleGate?: boolean;
  /** Idle-zombie veto-backoff ledger (session-respawn-thrash Fix A). Resolved
   *  server-side via resolveDevAgentGate(monitoring.idleKillVetoBackoff.enabled).
   *  DISABLED CONTRACT (C1): when `enabled !== true` the `idleKillBackoff` ledger
   *  is never constructed and never consulted — the idle-zombie branch falls
   *  through to its exact prior per-tick behavior. `cooldownMs: 0` is
   *  enabled-but-no-cooldown (R4-5), NOT a disable. */
  idleKillVetoBackoff?: { enabled: boolean; cooldownMs: number; escalateAfterEpisodes: number };
  /** Coordinator/mesh identity machine id for the per-machine
   *  SessionBuildContextStore re-key (standby-write-reconciliation §3.3).
   *  A GETTER because the mesh identity resolves after SessionManager
   *  construction at server boot. Absent/null ⇒ the literal 'local'. */
  buildContextMachineId?: () => string | null;
}

export class SessionManager extends EventEmitter {
  private config: SessionManagerConfig;
  private state: StateManager;
  private monitorInterval: ReturnType<typeof setInterval> | null = null;
  private monitoringInProgress = false;
  private inputGuard: InputGuard | null = null;
  private registryPath: string | null = null;

  /** Track when each session was first seen idle at the Claude prompt. Key = session ID */
  private idlePromptSince = new Map<string, number>();

  /**
   * Per-session marker of the most-recently injected message that has NOT yet
   * been confirmed submitted. Keyed by tmuxSession. Used by StuckInputSentinel
   * to recover messages that stranded at the input prompt.
   *
   * Why this exists for codex specifically: Claude Code's readline QUEUES input
   * typed while a turn is in flight and auto-submits it when the turn ends, so a
   * busy-delivery is self-healing. Codex's TUI does NOT — a message typed while
   * codex is "Working" is held as an unsubmitted DRAFT and never auto-submits
   * when the turn ends (live repro 2026-05-31: a user message sat stranded for
   * 3h on a busy 37-min codex turn). The in-process verifyInjection timers only
   * poll for 6.5s — far short of a multi-minute codex turn — and the generic
   * StuckInputSentinel prompt-text reader can't tell a real codex draft from the
   * dim placeholder hint codex renders at an EMPTY `›` prompt. A marker (the
   * actual injected text) is the robust, placeholder-immune tell: the codex
   * placeholder never equals what we injected. The sentinel matches this marker
   * at the `›` prompt and fires Enter once codex goes idle. Cleared on confirmed
   * submit (verifyInjection / sentinel) and GC'd for dead sessions.
   *
   * Distinct from `pendingInjections` (response-verification: did the session die
   * before replying?) — that map is cleared the moment the session produces ANY
   * output, which for a busy codex session happens while the draft is still
   * stranded. This map clears only when the marker actually leaves the prompt,
   * so it survives a long busy turn. */
  private strandedDraftMarkers = new Map<string, { marker: string; framework: string; injectedAt: number }>();

  /** Throttle stale session cleanup to every 5 minutes */
  private lastCleanupAt = 0;

  /** Optional callback to check if a session has active subagents (prevents false zombie kills) */
  private subagentChecker?: (session: Session) => boolean;

  /** Optional callback: is this session currently in active compaction recovery? If so, skip zombie kill. */
  private activeRecoveryChecker?: (session: Session) => boolean;
  /** Shared stateless KEEP-guard consulted by terminateSession (§P2). */
  private reapGuard?: ReapGuard;

  /** Pressure-tier provider for the work-evidence fallback (reap-notify R2.1). */
  private pressureTier?: () => 'normal' | 'moderate' | 'critical';
  /** Sessions the §P5 backstop has flagged long-`indeterminate` — excluded from
   *  the ABSOLUTE spawn cap so unverifiable panes can't lock out spawning. */
  private longIndeterminateSessions = new Set<string>();
  /** Multi-machine lease/awake predicate gating autonomous reaps (§Multi-machine). */
  private isAwakeMachine?: () => boolean;

  /** Optional callback: is this tmux session currently bound to a live messaging topic
   *  (Telegram/Slack/iMessage)? Returns a stable identifier (e.g. topic ID or channel ID)
   *  when bound, null otherwise. When bound, the zombie-kill threshold is extended via
   *  `effectiveBoundIdleKillMinutes` since "idle at prompt" is the healthy waiting state. */
  private topicBindingChecker?: (tmuxSession: string) => string | number | null;

  /**
   * Subscription-pool pinning resolver (Subscription & Auth Standard). When set,
   * a new claude-code spawn launches under the returned account's config home
   * (`CLAUDE_CONFIG_DIR`) and the session is tagged with `subscriptionAccountId`
   * — which is the linkage auto-swap needs to move a session when its account
   * hits a quota wall. Null/unset → spawns use the default config exactly as
   * before (the gate: this stays unset unless `subscriptionPool.pinSessionsToPool`
   * is enabled, so it is a strict no-op by default). Returns null per-call when
   * no eligible account exists. */
  private spawnAccountResolver?: () => { configHome: string; accountId: string } | null;

  /**
   * Census #5/#6: live credential re-pointing gate. When set AND enabled, a pinned account's
   * spawn home is resolved through the ledger (the account's CURRENT slot) instead of the
   * enrollment `configHome` the resolver returns — so after a swap a session lands on the slot
   * the credential ACTUALLY lives in now, not the stale enrollment home. Unset / flag-off /
   * ledger-unknown → the enrollment home is used exactly as today (strict no-op while dark).
   */
  private credentialLocationGate?: import('./CredentialLocationGate.js').CredentialLocationGate;

  /** Prompt Gate InputDetector — monitors terminal output for interactive prompts */
  private promptDetector?: InputDetector;
  private permissionPromptResolver?: PermissionPromptAutoResolver;

  /** Sessions with active relay leases (prompt relayed, waiting for response) — extends idle timeout */
  private relayLeases = new Map<string, number>(); // session ID → lease expiry timestamp

  /** Sessions the SessionReaper has leased for a two-phase reap (the transient
   *  'reaping' state of SESSION-REAPER-SPEC §3.6). While a session id is here,
   *  the idle-kill path skips it so only the reaper acts on it. */
  private reapingSessions = new Set<string>();

  /** Sessions whose termination is currently in flight — guards terminateSession()
   *  against re-entrant double-kill / double-event emission within a tick. */
  private terminating = new Set<string>();

  /** Track pending Telegram injections awaiting agent response.
   *  Key = tmuxSession name. Cleared when agent replies via /telegram/reply/:topicId. */
  private pendingInjections = new Map<string, { topicId: number; injectedAt: number; text: string }>();

  /** Dedup ledger for the Telegram→session delivery chokepoint.
   *  Key = `${tmuxSession}:${messageId}` → deliveredAt(ms). A single user message
   *  that is over-forwarded upstream (lifeline re-forward, PendingRelayStore
   *  re-drive, sentinel pause/resume) must still reach the session at most once.
   *  Bounded by pruning entries older than the dedup window on each delivery. */
  private recentTelegramDeliveries = new Map<string, number>();
  private static readonly TELEGRAM_DELIVERY_DEDUP_WINDOW_MS = 10 * 60 * 1000;

  /** Track sessions nudged after an API error in the CURRENT idle episode.
   *  Key = session ID. Set when we nudge; CLEARED when the session recovers (produces
   *  output / leaves idle), so the NEXT API-error episode in a long-running session
   *  gets its own nudge. (Before 2026-05-29 this was once-per-session-FOREVER — a long
   *  autonomous run that hit a SECOND transient API error was never re-nudged and
   *  silently stranded at the prompt. The runaway cap lives in errorNudgeTotal.) */
  private errorNudgedSessions = new Set<string>();
  /** Per-session once-per-idle-episode guard for the idle-error classify audit record
   *  (CMT-1785). Armed on the first classify of an episode; cleared in BOTH the
   *  active-session re-arm block AND sessionComplete (full errorNudgedSessions lifecycle
   *  parity — clearing only at re-arm would leak entries for sessions reaped while idle). */
  private idleErrorClassified = new Set<string>();

  /** Total error-nudges issued per session (never cleared until sessionComplete).
   *  Bounds runaway: even with per-episode re-arming, a session stuck in a tight
   *  error→nudge→error loop that never truly recovers stops being nudged after
   *  MAX_ERROR_NUDGES_PER_SESSION and falls through to the normal zombie-kill path. */
  private errorNudgeTotal = new Map<string, number>();

  /** Sessions where we've already retried Enter for stuck pasted text.
   *  Key = session ID. Prevents infinite retry loops — one retry per session. */
  private pasteRetried = new Set<string>();

  /**
   * Sessions that have been logged once for "over age limit but actively
   * working." Tracked to avoid log spam — the deferred-kill warning fires
   * once per session, not every tick.
   */
  private overAgeButActiveLogged = new Set<string>();
  /** Per-session back-off so the age-gate respects the KEEP-guard's verdict: after a kill
   *  is vetoed (session kept), suppress re-requests for a window instead of re-asking every
   *  5s tick (the 2026-06-05 17,503-line flood). Constructed in the constructor. */
  private ageKillBackoff!: AgeKillBackoff;

  /** Idle-zombie veto-backoff ledger (session-respawn-thrash Fix A). A SECOND,
   *  independently-configured VetoedKillBackoff instance for the bound-idle zombie
   *  killer (the age-gate keeps its own instance above). DISABLED CONTRACT (C1):
   *  left `undefined` and never consulted when the feature resolves disabled — the
   *  idle-zombie branch falls through to its exact prior per-tick behavior. */
  private idleKillBackoff?: VetoedKillBackoff;
  /** P19 breaker threshold (Fix A′): after this many consecutive veto episodes on
   *  the SAME session with the keep-reason still active, raise ONE attention item. */
  private idleKillEscalateAfter = 6;
  /** Best-effort "one per incident" dedupe seam for the P19 breaker (Fix A′).
   *  Injected at server boot; when unset the breaker escalation is a no-op. */
  private incidentDedupe?: IncidentDedupe;

  /** Cached count of running sessions, updated asynchronously by the monitor tick.
   *  Used by the health endpoint to avoid synchronous tmux polling. */
  private _cachedRunningCount = 0;
  private _cachedRunningSessions: Session[] = [];

  /** (A) tmux-event-loop-resilience — the bounded async hot path.
   *  When false (the default + every off-path/test caller) the legacy sync hot
   *  path runs byte-for-byte; monitorTick never touches the async wrapper. */
  private readonly tmuxAsyncEnabled: boolean;
  /** DARK-FLAGGED idle-monitor throttle settle-gate (see SessionManagerOptions). */
  private readonly idleThrottleSettleGate: boolean;
  /** Per-session settle tracking for the dark idle-throttle settle-gate (tmuxSession → state). */
  private readonly idleThrottleSettle = new Map<string, ThrottleSettleState>();
  /** (C) latency feed — optional-chained so (A) lands independently of the guard. */
  private readonly degradedTmuxGuard?: DegradedTmuxGuard;
  /** Per-call SIGKILL-bounded timeout for the async wrapper (ms). */
  private readonly tmuxCallTimeoutMs: number;
  /** Max concurrent in-flight hot-path tmux calls; (N+1)th fails CLOSED to KEEP. */
  private readonly tmuxMaxInFlight: number;
  /** Single-flight coalescing: in-flight async tmux calls keyed by `${op}:${session}`
   *  so a destructive op (kill) can NEVER coalesce with a concurrent read of the
   *  same session (a silent correctness hole). */
  private readonly tmuxInflight = new Map<string, Promise<TmuxOutcome>>();
  /** Live count of in-flight async tmux calls — the max-in-flight ceiling. */
  private tmuxInflightCount = 0;
  /** Fallback ceiling when no maxInFlight is threaded from server boot. */
  private static readonly TMUX_MAX_INFLIGHT_DEFAULT = 8;

  /** Worktree manager — when set, spawnSession resolves an isolated worktree per topic. */
  private worktreeManager: import('./WorktreeManager.js').WorktreeManager | null = null;
  private buildContextStore: SessionBuildContextStore | null = null;
  private pendingInjects!: PendingInjectStore;

  /** Per-session shim directory root (one subdir per session). Used for K9 mandatory shim. */
  private shimRoot: string | null = null;

  /**
   * SDK-credit reader for the june15-headless-spawn-reroute 'auto' decision
   * (PR2). Plumbed from server boot's anthropicRegistration.readSdkCredit (the
   * SAME TTL-cached reader PR1's routing policy uses, so the two routing layers
   * cannot drift). Returns null when credit state is unknown → the shared
   * decideSdkVsSubscription falls to the subscription floor. Unset (tests/
   * standalone) ⇒ 'auto' is treated as always-reroute-on-unknown (== subscription
   * floor), matching the pure function's null-snapshot contract. */
  private readSdkCredit?: () => Promise<import('../providers/primitives/observability/usageMeterProvider.js').AgentSdkCreditSnapshot | null>;

  /** Last reroute-decision per framework, so the transition-only log line fires
   *  on a CHANGE rather than every spawn (mirrors PR1's onRoute). Keyed by
   *  framework; value is the resolved path string. */
  private lastRerouteDecision = new Map<string, 'headless' | 'rerouted-interactive'>();

  /** State root for the per-agent encrypted vault (P3b gh-token resolution —
   *  same derivation as the pending-inject ledger: StateManager.baseDir when
   *  present, else `<projectDir>/.instar`). */
  private vaultStateDir: string;

  constructor(config: SessionManagerConfig, state: StateManager, opts: SessionManagerOptions = {}) {
    super();
    this.config = config;
    this.state = state;
    // (A)/(C) tmux-event-loop-resilience wiring — resolved server-side and threaded
    // in. Absent (every 2-arg/test caller) ⇒ the legacy sync hot path runs unchanged.
    this.tmuxAsyncEnabled = opts.tmuxAsyncEnabled === true;
    this.idleThrottleSettleGate = opts.idleThrottleSettleGate === true;
    // UNCONDITIONAL cleanup of the dark idle-throttle settle map on completion — NOT gated
    // on setPromptDetector() (a bare/test wiring may never call it), so a session killed
    // while mid-'wait' can't leak its settle entry.
    this.on('sessionComplete', (session: Session) => { this.idleThrottleSettle.delete(session.tmuxSession); });
    this.degradedTmuxGuard = opts.degradedTmuxGuard;
    this.tmuxCallTimeoutMs =
      typeof opts.tmuxCallTimeoutMs === 'number' && Number.isFinite(opts.tmuxCallTimeoutMs) && opts.tmuxCallTimeoutMs > 0
        ? opts.tmuxCallTimeoutMs
        : 9000;
    this.tmuxMaxInFlight =
      typeof opts.tmuxMaxInFlight === 'number' && Number.isFinite(opts.tmuxMaxInFlight) && opts.tmuxMaxInFlight > 0
        ? opts.tmuxMaxInFlight
        : SessionManager.TMUX_MAX_INFLIGHT_DEFAULT;
    // Durable in-flight inject ledger (finding 8d300555) — records survive a
    // server restart in the spawn→ready→inject window; recoverPendingInjects()
    // sweeps them at boot. Mock StateManagers in tests may lack baseDir —
    // fall back to the projectDir-derived state root rather than crashing
    // construction (the ledger path just needs to be stable per install).
    const stateBase = typeof (state as { baseDir?: unknown } | undefined)?.baseDir === 'string'
      ? (state as { baseDir: string }).baseDir
      : path.join(config.projectDir, '.instar');
    this.pendingInjects = new PendingInjectStore(path.join(stateBase, 'state'));
    this.vaultStateDir = stateBase;
    // Age-gate kill back-off: default 10 min between re-requests for a kept session
    // (config.ageKillBackoffMinutes; 0 disables → legacy every-tick behavior).
    const backoffMin = typeof config.ageKillBackoffMinutes === 'number' ? config.ageKillBackoffMinutes : 10;
    this.ageKillBackoff = new AgeKillBackoff({ backoffMs: Math.max(0, backoffMin) * 60_000 });
    // Idle-zombie veto-backoff ledger (session-respawn-thrash Fix A). DISABLED
    // CONTRACT (C1): only construct when explicitly enabled — otherwise the field
    // stays undefined and the idle-zombie branch runs its exact prior per-tick
    // behavior. `cooldownMs: 0` is enabled-but-no-cooldown (R4-5), never a disable.
    if (opts.idleKillVetoBackoff?.enabled === true) {
      this.idleKillBackoff = new VetoedKillBackoff({ backoffMs: opts.idleKillVetoBackoff.cooldownMs });
      this.idleKillEscalateAfter = opts.idleKillVetoBackoff.escalateAfterEpisodes;
    }
    if (config.respawnBuildContext?.enabled) {
      this.buildContextStore = new SessionBuildContextStore(state, {
        maxAgeMs: config.respawnBuildContext.maxAgeMs,
        // Per-machine re-key (standby-write-reconciliation §3.3): the id comes
        // from the coordinator/mesh identity via a late-resolving getter.
        machineId: opts.buildContextMachineId ?? null,
      });
    }
  }

  /** Per-agent GitHub token env flags for spawned sessions (Phase-3 increment
   *  P3b, option C — per-agent credential isolation). Resolves the agent's OWN
   *  token from its encrypted vault at spawn time; when the vault holds none,
   *  returns [] and the spawn env is unchanged (machine-global gh behavior,
   *  exactly as before). Mirrors the existing credential-injection art
   *  (INSTAR_AUTH_TOKEN / ANTHROPIC_API_KEY via tmux -e). The hardened triage
   *  spawn deliberately does NOT call this — it scrubs credentials. */
  private ghTokenEnvFlags(): string[] {
    const token = resolveGhTokenFromVault(this.vaultStateDir);
    return token ? ['-e', `GH_TOKEN=${token}`] : [];
  }

  /** durable-conversation-identity §7 (R4-M3): the per-session bind-token env
   *  flags (`INSTAR_BIND_TOKEN`). The token scopes durable-state opens
   *  (`POST /commitments` on a minted id) to the session's OWN authenticated
   *  bootstrap conversation set. Empty when no minter is wired or the spawn
   *  carries no bootstrap conversation — a token-less spawn rides the gate's
   *  legacy lane; a failed mint NEVER blocks a spawn. */
  private bindTokenEnvFlags(tmuxSession: string, bootstrapConversationIds: number[]): string[] {
    if (!this.config.mintBindToken || bootstrapConversationIds.length === 0) return [];
    try {
      const token = this.config.mintBindToken(tmuxSession, bootstrapConversationIds);
      return token ? ['-e', `INSTAR_BIND_TOKEN=${token}`] : [];
    } catch {
      // @silent-fallback-ok — a failed token mint degrades to a token-less
      // spawn (the §7 legacy lane, loud at bind time); never a blocked spawn.
      return [];
    }
  }

  /** Lazily-constructed tri-state liveness oracle (UNIFIED-SESSION-LIFECYCLE §P1).
   *  Backs the boot purge and isSessionAliveAsync so a slow/unreachable tmux is
   *  treated as `indeterminate`, never `dead`. */
  private _livenessOracle: SessionLivenessOracle | null = null;
  private get livenessOracle(): SessionLivenessOracle {
    if (!this._livenessOracle) {
      this._livenessOracle = new SessionLivenessOracle(
        { tmuxPath: this.config.tmuxPath, exec: execFileAsync },
        this.config.liveness,
      );
    }
    return this._livenessOracle;
  }

  /** Test/DI seam: inject a liveness oracle (e.g. one with a scripted exec).
   *  Production builds the oracle lazily from config; this lets unit tests drive
   *  the alive/dead/indeterminate verdicts deterministically. */
  setLivenessOracle(oracle: SessionLivenessOracle): void {
    this._livenessOracle = oracle;
  }

  /**
   * The SOLE funnel for hot-path tmux calls (tmux-event-loop-resilience §A).
   * Tri-state, modeled on SessionLivenessOracle.classify: `success` and
   * `definitely-absent` are the only POSITIVE signals; everything else —
   * timeout, server-unreachable, unknown error — is `indeterminate`, and a
   * caller keying a destructive action on the result MUST treat `indeterminate`
   * as KEEP (never reap). A timeout becomes `indeterminate`, NEVER
   * `definitely-absent`.
   *
   * `killSignal: 'SIGKILL'` is essential — a plain `timeout` sends SIGTERM,
   * which a wedged tmux ignores, so the call would never actually return inside
   * the bound. SIGKILL guarantees the 9s ceiling. Reuses the module-level
   * `execFileAsync` (no second promisify). The `observeTmuxCall` calls feed the
   * (C) DegradedTmuxGuard latency signal; optional-chained so (A) is independent
   * of whether (C) is wired yet (until then the calls are a no-op).
   */
  private async tmuxExecAsync(args: string[], opts: { timeoutMs?: number } = {}): Promise<TmuxOutcome> {
    const timeout = opts.timeoutMs ?? this.tmuxCallTimeoutMs;
    const t0 = Date.now();
    try {
      const { stdout } = await execFileAsync(this.config.tmuxPath, args, { timeout, killSignal: 'SIGKILL' });
      this.degradedTmuxGuard?.observeTmuxCall(Date.now() - t0, 'success');
      return { state: 'success', stdout };
    } catch (err) {
      const e =
        err && typeof err === 'object'
          ? (err as { stderr?: string; message?: string; killed?: boolean; signal?: string })
          : {};
      const msg = (e.stderr || e.message || String(err)).toString();
      // A definitive negative: the tmux server answered and named the session
      // absent. Treated as a SUCCESSFUL probe for latency (the call returned fast
      // with a real answer; it is not a slow/degraded call).
      if (/can't find session|no such session|no server running|session not found/i.test(msg)) {
        this.degradedTmuxGuard?.observeTmuxCall(Date.now() - t0, 'success');
        return { state: 'definitely-absent', reason: msg.slice(0, 120) };
      }
      // Everything else is indeterminate. A SIGKILL (our timeout) sets
      // killed===true / signal==='SIGKILL' — flag it as a killed-client so the
      // guard counts the degraded-call signal distinctly from a generic error.
      const killed = e.killed === true || e.signal === 'SIGKILL' || /SIGKILL/.test(msg);
      this.degradedTmuxGuard?.observeTmuxCall(Date.now() - t0, killed ? 'killed-client' : 'indeterminate');
      return { state: 'indeterminate', reason: msg.slice(0, 120) };
    }
  }

  /**
   * Single-flight + max-in-flight wrapper around `tmuxExecAsync` (§A).
   * Coalesces concurrent calls per `(op, tmuxSession)` so a tick that probes the
   * same session twice issues ONE subprocess; the key MUST include the op so a
   * destructive op never shares an in-flight Promise with a read of the same
   * session. When the live in-flight count is at the ceiling, resolves
   * `{state:'indeterminate', reason:'max-inflight'}` WITHOUT spawning — fail
   * CLOSED toward KEEP, never toward reap, and a hard cap on how many
   * subprocesses the hot path can fan out (never MORE than today).
   */
  private async tmuxExecCoalesced(
    op: string,
    tmuxSession: string,
    args: string[],
    opts: { timeoutMs?: number } = {},
  ): Promise<TmuxOutcome> {
    const key = `${op}:${tmuxSession}`;
    const existing = this.tmuxInflight.get(key);
    if (existing) return existing;
    if (this.tmuxInflightCount >= this.tmuxMaxInFlight) {
      return { state: 'indeterminate', reason: 'max-inflight' };
    }
    this.tmuxInflightCount += 1;
    const p = this.tmuxExecAsync(args, opts).finally(() => {
      this.tmuxInflight.delete(key);
      this.tmuxInflightCount = Math.max(0, this.tmuxInflightCount - 1);
    });
    this.tmuxInflight.set(key, p);
    return p;
  }

  /** Effective idle-at-prompt kill threshold (config override or hardcoded default) */
  private get effectiveIdleKillMinutes(): number {
    return this.config.idlePromptKillMinutes ?? FALLBACK_IDLE_PROMPT_KILL_MINUTES;
  }

  /** Effective idle-at-prompt kill threshold for sessions bound to a live messaging topic.
   *  Much higher than the default — topic-bound sessions sit at the prompt waiting for the
   *  next user message; that's the healthy state, not a zombie. */
  private get effectiveBoundIdleKillMinutes(): number {
    return this.config.idlePromptKillMinutesBoundToTopic ?? FALLBACK_IDLE_PROMPT_KILL_MINUTES_BOUND_TO_TOPIC;
  }

  /** Effective absolute max session duration (config override or hardcoded default) */
  private get effectiveMaxDurationMinutes(): number {
    return this.config.defaultMaxDurationMinutes ?? FALLBACK_MAX_DURATION_MINUTES;
  }

  /**
   * Wire the WorktreeManager into spawnSession. When set, every spawned session
   * resolves to an isolated worktree (PARALLEL-DEV-ISOLATION-SPEC.md, AC-1).
   *
   * @param shimRoot Filesystem root for per-session shim directories
   *                 (e.g. `<stateDir>/session-shims/`). When unset, no PATH shim
   *                 is injected (degrades to non-isolated mode for back-compat).
   */
  setWorktreeManager(
    wm: import('./WorktreeManager.js').WorktreeManager,
    shimRoot: string | null = null,
  ): void {
    this.worktreeManager = wm;
    this.shimRoot = shimRoot;
  }

  /**
   * Per-session shim (PARALLEL-DEV-ISOLATION-SPEC.md "Phase D: Mandatory destructive
   * command interception"). Creates `<shimDir>/git`, `<shimDir>/rm`, and a `.shellrc`
   * that defines bash functions overriding any user-shell aliases. Sourcing happens
   * via `BASH_ENV` env var (set in tmux spawn).
   */
  private installSessionShim(shimDir: string, fencingToken: string): void {
    fs.mkdirSync(shimDir, { recursive: true });

    // Resolve the absolute path to the destructive-command shim runner.
    // Walk up from the SessionManager source location to find package root.
    const shimRunner = this.resolveShimRunner();

    // git wrapper
    const gitShim = `#!/bin/sh
exec "${shimRunner}" git "$@"
`;
    fs.writeFileSync(path.join(shimDir, 'git'), gitShim, { mode: 0o755 });

    // rm wrapper
    const rmShim = `#!/bin/sh
exec "${shimRunner}" rm "$@"
`;
    fs.writeFileSync(path.join(shimDir, 'rm'), rmShim, { mode: 0o755 });

    // BASH_ENV-sourced rcfile to override shell aliases (handles `alias git=…` cases)
    const shellrc = `# instar parallel-dev session shim
export INSTAR_FENCING_TOKEN="${fencingToken}"
git() { "${shimRunner}" git "$@"; }
rm()  { "${shimRunner}" rm  "$@"; }
`;
    fs.writeFileSync(path.join(shimDir, '.shellrc'), shellrc, { mode: 0o644 });
  }

  private resolveShimRunner(): string {
    // Walk from this file up to project root, then look for scripts/destructive-command-shim.js
    let dir = __dirname;
    for (let i = 0; i < 6; i++) {
      const candidate = path.join(dir, 'scripts', 'destructive-command-shim.js');
      if (fs.existsSync(candidate)) return candidate;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    // Fallback to a not-yet-installed sentinel; shim wrappers will fail loudly
    return '/usr/local/bin/instar-destructive-command-shim';
  }

  /**
   * Set the InputGuard for cross-topic injection defense.
   * Must be called after construction with state dir info.
   */
  setInputGuard(guard: InputGuard, registryPath: string): void {
    this.inputGuard = guard;
    this.registryPath = registryPath;
  }

  /**
   * Set the subagent checker callback for zombie cleanup awareness.
   * When set, the zombie cleanup will skip sessions that have active subagents.
   * Must be called after SubagentTracker is constructed.
   */
  setSubagentChecker(checker: (session: Session) => boolean): void {
    this.subagentChecker = checker;
  }

  /**
   * Set the topic-binding checker — used by the zombie-kill loop to distinguish
   * sessions that are waiting for the next message from a live conversation
   * (healthy "idle at prompt") from sessions that have nothing to do (zombies).
   *
   * When the checker returns a non-null identifier for a session, the kill
   * threshold is extended to {@link effectiveBoundIdleKillMinutes} (default 24h).
   * This is a structural exemption — the binding is an authoritative fact, not a
   * judgment call. If Claude truly dies inside the tmux pane, isSessionAlive in
   * the bridge's message-routing path will detect it and trigger a clean respawn.
   *
   * Must be called after the messaging adapter is constructed.
   */
  setTopicBindingChecker(checker: (tmuxSession: string) => string | number | null): void {
    this.topicBindingChecker = checker;
  }

  /**
   * Wire the subscription-pool pinning resolver (Subscription & Auth Standard).
   * Called from server startup ONLY when `subscriptionPool.pinSessionsToPool` is
   * enabled, so leaving it unwired keeps spawns on the default config (no-op).
   * The resolver picks the optimal pool account (the scheduler's reset-date /
   * headroom score) at spawn time and returns its configHome + id, or null.
   */
  setSpawnAccountResolver(resolver: () => { configHome: string; accountId: string } | null): void {
    this.spawnAccountResolver = resolver;
  }

  /**
   * Wire the credential re-pointing gate (census #5/#6). Called from server startup; absent /
   * flag-off keeps spawn placement on the enrollment home exactly as today.
   */
  setCredentialLocationGate(gate: import('./CredentialLocationGate.js').CredentialLocationGate): void {
    this.credentialLocationGate = gate;
  }

  /**
   * Census #5/#6: resolve a pinned account's LIVE spawn home through the ledger gate. Returns the
   * account's current slot when re-pointing is enabled AND the ledger knows it; otherwise the
   * enrollment `configHome` unchanged (today's behavior). Sync + fail-open (the gate never throws).
   */
  private resolvePinnedSpawnHome(pinned: { configHome: string; accountId: string }): string {
    if (!this.credentialLocationGate) return pinned.configHome;
    return this.credentialLocationGate.slotForAccount(pinned.accountId, pinned.configHome);
  }

  /**
   * Defensive onboarding-readiness seed before any launch under a pool
   * account's CLAUDE_CONFIG_DIR (2026-06-09 incident): a headless-enrolled
   * home is missing the interactive first-launch flags, so an interactive
   * relaunch into it wedges on the onboarding screens. Cheap + idempotent —
   * safe to call on every pinned/swapped launch. Never throws (fail-safe by
   * the util's contract); failures are logged, not fatal, because the worst
   * case is the pre-fix behavior, not a dead spawn path.
   */
  private ensurePinnedHomeInteractiveReady(configHome: string, lane: string): void {
    const ready = ensureInteractiveReady(configHome);
    if (ready.patched) {
      console.log(`[SessionManager] ${lane}: made ${configHome} interactive-ready (${ready.reason})`);
    } else if (ready.reason !== 'already interactive-ready') {
      console.warn(`[SessionManager] ${lane}: could not verify ${configHome} interactive-ready — ${ready.reason}`);
    }
  }

  /**
   * Register a predicate that vetoes zombie cleanup when a compaction recovery
   * is in flight. When it returns true, the idle-prompt killer skips the
   * session and resets its idle clock so cleanup won't race the recovery
   * window. Wired by CompactionSentinel at server startup.
   */
  setActiveRecoveryChecker(checker: (session: Session) => boolean): void {
    this.activeRecoveryChecker = checker;
  }

  /**
   * Register the shared ReapGuard (UNIFIED-SESSION-LIFECYCLE §P2). Once set,
   * every AUTONOMOUS terminate consults it: a non-null KEEP reason makes the
   * terminate a no-op `{ terminated:false, skipped:<reason> }`. Wired in server.ts
   * with the same signal closures that back SessionReaper, so a killer can only
   * *request* a kill — the authority refuses to end a guarded session. Operator
   * kills bypass the guard. Unset (tests/standalone) → no guard consult.
   */
  setReapGuard(guard: ReapGuard): void {
    this.reapGuard = guard;
  }

  /**
   * Wire the best-effort "one per incident" dedupe seam for the idle-zombie veto
   * P19 breaker (session-respawn-thrash Fix A′). Server boot injects the shared
   * IncidentDedupe so the breaker escalation coalesces across ticks. Unset ⇒ the
   * breaker never escalates (best-effort, signal-only).
   */
  setIncidentDedupe(seam: IncidentDedupe): void {
    this.incidentDedupe = seam;
  }

  /**
   * Evaluate the ReapGuard ONCE for the idle-zombie kill decision (C2/R4-2). Calls
   * blockedReason with NO bypass flags (the idle-zombie branch never bypasses), and
   * normalizes the vetoing reason to its STABLE ledger key. The verdict is threaded
   * through both the backoff gate (shouldRequest) and the terminate call so the
   * guard is never double-evaluated with a possibly-changed reason between them.
   */
  private computeIdleZombieReapVerdict(
    session: Session,
    _now: number,   // stays UNUSED — the reasonKey MUST be time-independent (same key every tick)
  ): { blocked: ReapKeepReason | null; reasonKey: string | null } {
    // KEY CONSISTENCY (idle-zombie-veto-key-consistency.md): the veto-backoff ledger keys
    // its cooldown on this reasonKey, but recordVeto stores the reason terminateSessionInternal
    // ACTUALLY returns. That method's skip precedence is `protected` → the lease gate
    // (`not-lease-holder`) → the reapGuard cascade. On a STANDBY machine it short-circuits at
    // the lease gate and stores `not-lease-holder` (NOT a reapGuard reason). If this pre-check
    // key differs from the stored key, the reason-key stale-reprieve deletes the ledger entry
    // every tick and the 30m cooldown never holds (the observed 5s spin). Mirror that precedence
    // here so the pre-check key == the key recordVeto will store. `blocked` stays the RAW reapGuard
    // verdict (only reasonKey is overridden) so the C2/R4-2 single-guard-eval threading to
    // terminateSessionInternal is preserved. Equivalence with terminateSessionInternal is enforced
    // by a CI property test, NOT by discipline (Structure > Willpower).
    const blocked = this.reapGuard?.blockedReason(session) ?? null;
    if (blocked?.reason === 'protected') return { blocked, reasonKey: 'protected' };
    if (this.isAwakeMachine && !this.isAwakeMachine()) return { blocked, reasonKey: 'not-lease-holder' };
    return { blocked, reasonKey: normalizeReasonKey(blocked) };
  }

  /**
   * P19 breaker (Fix A′): after `idleKillEscalateAfter` consecutive veto episodes
   * on a session whose keep-reason is still active, raise ONE attention item via
   * the injected dedupe seam so it emits at most once per incident within the
   * process window. Signal-only — best-effort; if no seam is injected nothing
   * emits. Never spawns a topic or touches a transport directly.
   */
  private maybeEscalateIdleZombieVeto(session: Session, topicId: number | null, reasonKey: string): void {
    const incidentKey = 'idle-zombie-veto:' + (topicId ?? 'none') + ':' + reasonKey;
    if (this.incidentDedupe?.shouldEmit(incidentKey, 24 * 60 * 60 * 1000)) {
      this.emit('idleZombieVetoEscalation', {
        session,
        topicId,
        reasonKey,
        message: `Session "${session.name}" on topic ${topicId ?? 'n/a'} is permanently vetoed from idle-zombie cleanup (reason: ${reasonKey}) — likely a stuck open-commitment or a resume-loop; investigate.`,
      });
    }
  }

  /**
   * Idle-zombie kill decision (session-respawn-thrash Fix A). Factored out of
   * monitorTick so the enabled/disabled split is unit-testable in isolation.
   *
   * ENABLED (idleKillBackoff constructed) — veto-backoff path: evaluate the guard
   * once, honor the reason-key-aware cooldown, attempt the kill through the SAME
   * verdict, then either drop state on a real kill or record the veto (logging ONCE
   * per episode + escalating after N episodes). DISABLED (field undefined) — the
   * exact prior per-tick behavior: attempt terminateSession every tick.
   *
   * @returns whether a kill was actually performed (for the caller's WARN wording).
   */
  private async handleIdleZombie(
    session: Session,
    idleMs: number,
    binding: string | number | null,
    now: number,
    bindingNote: string,
    killThresholdMinutes: number,
  ): Promise<void> {
    void killThresholdMinutes; // threshold already applied by the caller
    if (this.idleKillBackoff) {
      // ENABLED — veto-backoff path.
      const verdict = this.computeIdleZombieReapVerdict(session, now);
      // Unkeyable fail-open (R4-4): a truthy veto with no usable reason string →
      // re-evaluate this tick rather than gate on a fabricated key.
      const unkeyable = verdict.blocked != null && verdict.reasonKey == null;
      if (!unkeyable && !this.idleKillBackoff.shouldRequest(session.id, now, verdict.reasonKey)) {
        // Inside the cooldown, same reason → quiet skip: no terminate attempt,
        // no reap-log write.
        return;
      }
      const result = await this.terminateSessionInternal(
        session.id,
        'idle-zombie',
        { disposition: 'terminal' },
        { blocked: verdict.blocked },
      );
      if (result.terminated) {
        console.warn(`[SessionManager] Session "${session.name}" idle at prompt for ${Math.round(idleMs / 60_000)}m with no active processes${bindingNote}. Killing zombie.`);
        this.idleKillBackoff.recordKilled(session.id);
      } else {
        const vetoKey = normalizeReasonKey(result.skipped ? { reason: result.skipped } : null)
          ?? verdict.reasonKey ?? 'unknown';
        // Cooldown applies to EVERY skip reason (the flood-stop benefit is
        // universal — incl. a STANDBY machine's `not-lease-holder` every-tick skip,
        // itself a documented reap-log flood source).
        const firstOfEpisode = this.idleKillBackoff.recordVeto(session.id, now, vetoKey);
        if (firstOfEpisode) {
          console.warn(`[SessionManager] Session "${session.name}" idle-zombie cleanup vetoed (${vetoKey})${bindingNote} — backing off re-attempts.`);
        }
        // Breaker (Fix A′): escalate ONLY when the persisting reason is a genuine
        // STUCK-session keep-reason (second-pass review point 9). Authority/CAS
        // skips (`not-lease-holder` on a standby machine, `in-flight`, `protected`,
        // `already-*`, …) back off above but must NEVER raise the "permanently
        // vetoed from idle-zombie cleanup" attention item — that wording is false
        // for them, and a standby machine would otherwise emit misleading HIGH items.
        if (
          IDLE_ZOMBIE_ESCALATION_REASONS.has(vetoKey)
          && this.idleKillBackoff.episodeCount(session.id) >= this.idleKillEscalateAfter
        ) {
          const topicId = typeof binding === 'number'
            ? binding
            : (binding != null && /^-?\d+$/.test(String(binding)) ? Number(binding) : null);
          this.maybeEscalateIdleZombieVeto(session, topicId, vetoKey);
        }
      }
      return;
    }
    // DISABLED — prior per-tick behavior EXACTLY.
    console.warn(`[SessionManager] Session "${session.name}" idle at prompt for ${Math.round(idleMs / 60_000)}m with no active processes${bindingNote}. Killing zombie.`);
    await this.terminateSession(session.id, 'idle-zombie', { disposition: 'terminal' });
  }

  /**
   * Wire the SDK-credit reader used by the headless-spawn-reroute 'auto'
   * decision (june15-headless-spawn-reroute, PR2). Server boot passes
   * anthropicRegistration.readSdkCredit — the same TTL-cached reader PR1's
   * routing policy uses — so the reroute decision and the intelligence-funnel
   * routing share ONE credit source and can't drift. Unset ⇒ 'auto' resolves to
   * the subscription floor (null-snapshot contract of decideSdkVsSubscription).
   */
  setSdkCreditReader(
    reader: () => Promise<import('../providers/primitives/observability/usageMeterProvider.js').AgentSdkCreditSnapshot | null>,
  ): void {
    this.readSdkCredit = reader;
  }

  /**
   * Flag/unflag a session as long-`indeterminate` (UNIFIED-SESSION-LIFECYCLE §P5).
   * Driven by the StaleSessionBackstop. A flagged session still counts toward the
   * soft scheduler cap, but is excluded from the ABSOLUTE `maxSessions × 3` cap so
   * a fleet of unverifiable panes can never lock a human out of spawning.
   */
  markLongIndeterminate(sessionId: string, isLong: boolean): void {
    if (isLong) this.longIndeterminateSessions.add(sessionId);
    else this.longIndeterminateSessions.delete(sessionId);
  }

  /**
   * Update a session's display `name` only (UNIFIED-SESSION-LIFECYCLE bonus —
   * session label follows topic rename). NEVER touches `tmuxSession` (the
   * stable key tmux + every internal lookup uses) or `id` (the stable UUID
   * state lookups use). The rename surfaces in the dashboard + any place that
   * prints `session.name`; the operational identity stays intact.
   *
   * Idempotent + safe: if the session isn't found or the name is unchanged,
   * the call is a no-op. Returns true when a save occurred.
   */
  renameSessionByTmux(tmuxSession: string, newName: string): boolean {
    if (!newName || typeof newName !== 'string') return false;
    const trimmed = newName.trim();
    if (!trimmed) return false;
    const session = this.state.listSessions().find((s) => s.tmuxSession === tmuxSession);
    if (!session) return false;
    if (session.name === trimmed) return false;
    session.name = trimmed;
    this.state.saveSession(session);
    return true;
  }

  /**
   * Resolve tri-state liveness for many sessions from ONE tmux snapshot via the
   * P1 oracle (UNIFIED-SESSION-LIFECYCLE §P5 backstop). `reachable` is false when
   * the snapshot was non-authoritative (control plane unreachable) — in which
   * case every session resolves `indeterminate`. Shares the oracle's short-TTL
   * cache, so the backstop and boot-purge never double-probe within a tick.
   */
  async probeLivenessBatch(
    tmuxSessions: string[],
  ): Promise<{ reachable: boolean; liveness: Map<string, 'alive' | 'dead' | 'indeterminate'> }> {
    const results = await this.livenessOracle.probeAll(tmuxSessions);
    const liveness = new Map<string, 'alive' | 'dead' | 'indeterminate'>();
    for (const [name, r] of results) liveness.set(name, r.liveness);
    // With a single authoritative snapshot, a session is only `indeterminate`
    // when the whole snapshot was non-authoritative — i.e. the server is
    // unreachable. So "reachable" ⟺ at least one definitive (alive/dead) verdict.
    const reachable = tmuxSessions.length === 0 || [...liveness.values()].some((l) => l !== 'indeterminate');
    return { reachable, liveness };
  }

  /**
   * Register the multi-machine lease/awake predicate. When set and it returns
   * false, an AUTONOMOUS terminate is a no-op `skipped:'not-lease-holder'` — only
   * the awake/lease-holding machine may autonomously reap; a standby may detect
   * and signal but never kill another machine's sessions. Operator kills bypass,
   * and so does the topic-moved closeout (`bypassLeaseForTopicMovedCloseout` —
   * F8: closing THIS machine's own leftover session for a topic that moved away
   * is not "killing another machine's session", and the old owner is by
   * definition usually not the lease holder). Unset → treated as awake
   * (single-machine default).
   */
  setAwakeChecker(fn: () => boolean): void {
    this.isAwakeMachine = fn;
  }

  /**
   * Set the Prompt Gate InputDetector for prompt monitoring.
   * When set, monitorTick() will capture output and feed it to the detector.
   */
  setPromptDetector(detector: InputDetector): void {
    this.promptDetector = detector;
    // Clean up detector state when sessions end
    this.on('sessionComplete', (session: Session) => {
      detector.cleanup(session.tmuxSession);
      this.relayLeases.delete(session.id);
      this.errorNudgedSessions.delete(session.id);
      this.idleErrorClassified.delete(session.id);
      this.errorNudgeTotal.delete(session.id);
      this.pasteRetried.delete(session.id);
    });
  }

  /**
   * Set the always-on Permission-Prompt Auto-Resolver (the safety floor that
   * auto-answers a framework approval prompt Instar cannot otherwise clear).
   * When set, monitorTick() pre-gates each running session's tail and hands a
   * candidate to it. Unconditional by design — there is no enable flag.
   */
  setPermissionPromptResolver(resolver: PermissionPromptAutoResolver): void {
    this.permissionPromptResolver = resolver;
  }

  /**
   * Grant a relay lease to a session — extends idle timeout while waiting for
   * a Telegram relay response. Prevents the zombie killer from killing sessions
   * that are legitimately waiting for user input.
   */
  grantRelayLease(sessionId: string, durationMs: number): void {
    this.relayLeases.set(sessionId, Date.now() + durationMs);
  }

  /**
   * Clear a relay lease (prompt was answered or timed out).
   */
  clearRelayLease(sessionId: string): void {
    this.relayLeases.delete(sessionId);
  }

  /**
   * True if the session has an unexpired relay lease (a prompt was relayed and
   * we are waiting on the user). Gate H of the SessionReaper — keyed on the
   * instar session id, not the tmux name. (SESSION-REAPER-SPEC §3.1(4)H.)
   */
  isRelayLeaseActive(sessionId: string): boolean {
    const expiry = this.relayLeases.get(sessionId);
    return expiry != null && expiry > Date.now();
  }

  /** The resolved protected-session list (incl. the `<project>-server` default).
   *  Exposed so the SessionReaper's gate A uses the SAME list the idle-kill /
   *  terminateSession guards enforce, rather than re-reading raw file config. */
  getProtectedSessions(): string[] {
    return this.config.protectedSessions;
  }

  /** Mark a session as being reaped (two-phase reap window). The idle-kill path
   *  skips reaping sessions so the reaper is the single actor on them. */
  markReaping(sessionId: string): void {
    this.reapingSessions.add(sessionId);
  }

  /** Clear the reaping lease (reap completed or aborted). */
  clearReaping(sessionId: string): void {
    this.reapingSessions.delete(sessionId);
  }

  /** True if a reap is in flight for this session. */
  isReaping(sessionId: string): boolean {
    return this.reapingSessions.has(sessionId);
  }

  /**
   * Single-writer session termination — the sole ReapAuthority
   * (UNIFIED-SESSION-LIFECYCLE §P0, building on SESSION-REAPER-SPEC §3.6). EVERY
   * autonomous killer funnels through this so a session is killed at most once,
   * with exactly-once `beforeSessionKill`/`sessionComplete`/`sessionReaped`
   * emission and a correct `endedReason`.
   *
   * The authority holds the safety checks so a killer can only *request* a kill:
   *  - CAS on live status + an in-flight guard (prevents the double-kill race).
   *  - `protectedSessions` (never kill).
   *  - Lease-holder gate: an AUTONOMOUS reap on a standby machine is a no-op
   *    `skipped:'not-lease-holder'` — only the awake machine reaps. Exception
   *    (F8): the topic-moved closeout's `bypassLeaseForTopicMovedCloseout`
   *    lifts ONLY this gate (see the opt's doc below).
   *  - ReapGuard (§P2): an AUTONOMOUS reap of a session the guard says to KEEP is
   *    a no-op `skipped:<keep-reason>` — even a buggy killer cannot end a guarded
   *    session.
   * `origin:'operator'` bypasses the lease-gate and the guard (an explicit human
   * kill must always happen). Default `origin` is `'autonomous'` so an in-process
   * caller can never accidentally mint operator privilege.
   *
   * Re-entrancy: the guard is consulted BEFORE this call acquires its own
   * in-flight lock, so the authority's lock for the kill it is performing is
   * never misread by the guard.
   *
   * `disposition:'recovery-bounce'` marks a kill-to-respawn (SessionRecovery,
   * version-skew, context-exhaustion) so the §P3 notifier stays silent — that is
   * a bounce, not a disappearance. Default `'terminal'`.
   *
   * @returns `{ terminated: true }` on a kill performed by THIS call, or
   *          `{ terminated: false, skipped }` describing why it was a no-op.
   */
  async terminateSession(
    sessionId: string,
    reason: string,
    opts?: {
      finalStatus?: 'completed' | 'killed';
      disposition?: 'terminal' | 'recovery-bounce';
      origin?: 'operator' | 'autonomous';
      /** UNTRUSTED caller-supplied provenance claim (REMOTE-SESSION-CLOSE-SPEC
       *  §2.3) — recorded in the reap-log as `viaClaim`, NEVER consulted in any
       *  authority/bypass decision (signal-vs-authority). */
      via?: string;
      knownDead?: boolean;
      bypassRecoveryFlag?: boolean;
      bypassActiveProcessKeep?: boolean;
      bypassRecentUserMessageForConfirmedMove?: boolean;
      bypassLeaseForTopicMovedCloseout?: boolean;
      workEvidence?: string[];
    },
  ): Promise<{ terminated: boolean; skipped?: string }> {
    // Public enforcement boundary — re-evaluates the guard itself (no precomputed
    // verdict). The single-guard-eval precompute is a PRIVATE same-tick optimization
    // used only by the idle-zombie branch (R3-1/R4-2); it is NEVER a public option.
    return this.terminateSessionInternal(sessionId, reason, opts);
  }

  /**
   * The single-writer termination implementation. `precomputedGuardVerdict`, when
   * provided (ONLY by the idle-zombie branch, which uses no bypass flags), threads
   * the already-computed ReapGuard verdict through so the guard is not
   * double-evaluated in the same tick (C2). Every OTHER caller passes it undefined
   * and the guard is evaluated here exactly as before.
   */
  private async terminateSessionInternal(
    sessionId: string,
    reason: string,
    opts?: {
      finalStatus?: 'completed' | 'killed';
      disposition?: 'terminal' | 'recovery-bounce';
      origin?: 'operator' | 'autonomous';
      /** UNTRUSTED caller-supplied provenance claim (REMOTE-SESSION-CLOSE-SPEC
       *  §2.3) — recorded in the reap-log as `viaClaim`, NEVER consulted in any
       *  authority/bypass decision (signal-vs-authority). */
      via?: string;
      knownDead?: boolean;
      bypassRecoveryFlag?: boolean;
      bypassActiveProcessKeep?: boolean;
      /**
       * Post-transfer closeout correctness (F1, Part E): a NARROW keep-reason
       * bypass that lifts ONLY the `recent-user-message` keep-reason (mirroring
       * `bypassActiveProcessKeep`). The SessionReaper sets it ONLY on a
       * liveness-CONFIRMED genuine move (Part C `true`) whose freshest LOCAL user
       * message PREDATES the liveness snapshot — so a duplicate leftover with a
       * stale pre-move "recent" message can actually shed. Every OTHER KEEP-guard
       * (active-subagent, open-commitment, recovery-in-flight, …) is re-checked
       * fresh and still vetoes. Spec: docs/specs/post-transfer-closeout-correctness.md.
       */
      bypassRecentUserMessageForConfirmedMove?: boolean;
      /**
       * Post-transfer closeout carve-out (F8, roadmap 0.6,
       * test-as-self 2026-07-02): lifts ONLY the lease-holder gate — protected,
       * CAS, in-flight, and EVERY KEEP-guard still apply unchanged. The
       * SessionReaper sets it ONLY on the topic-moved closeout path, where this
       * machine is closing ITS OWN local leftover session for a topic the pool
       * ownership registry says ANOTHER machine now owns. The lease gate exists
       * so a standby never reaps ANOTHER machine's sessions; the post-transfer
       * closeout is the inverse case — the machine a topic moves AWAY from is
       * by definition usually NOT the serving-lease holder, so without this
       * carve-out the transfer's required teardown was structurally vetoed
       * `skipped:'not-lease-holder'` every attempt until the P19 breaker gave
       * up, stranding a duplicate session on the old machine (audit F8).
       */
      bypassLeaseForTopicMovedCloseout?: boolean;
      /**
       * Killer-supplied work evidence (reap-notify spec R2.1): computed at the
       * KILLER's decision point — the only moment the work was observable (the
       * quota-shed migrator computes it BEFORE its Ctrl+C grace round tears the
       * work down; a chokepoint re-run is empty by construction for
       * guard-cleared kills). Clamped to the WorkEvidence enum here regardless
       * of which killer supplied it; unknown names are dropped, not stored.
       */
      workEvidence?: string[];
    },
    /** Idle-zombie-only same-tick optimization (C2/R4-2): the ReapGuard verdict
     *  already computed by computeIdleZombieReapVerdict, threaded here so the guard
     *  is evaluated ONCE. Only the idle-zombie branch (which uses no bypass flags)
     *  supplies it; every other caller leaves it undefined and the guard is
     *  re-evaluated below. NEVER exposed on the public terminateSession() signature. */
    precomputedGuardVerdict?: { blocked: ReapKeepReason | null },
  ): Promise<{ terminated: boolean; skipped?: string }> {
    const session = this.state.getSession(sessionId);
    if (!session) return { terminated: false, skipped: 'not-found' };
    // CAS: only live sessions are terminable. Idempotent for already-terminal ones.
    if (session.status !== 'running' && session.status !== 'starting') {
      return { terminated: false, skipped: `already-${session.status}` };
    }

    const origin = opts?.origin ?? 'autonomous';
    const disposition = opts?.disposition ?? 'terminal';

    // ── Authority gates (autonomous only; operator bypasses) ──
    // An `origin:'operator'` kill — stamped ONLY by the Bearer-authed HTTP route
    // layer and by the transfer handler executing the user's explicit
    // "move this to <machine>" command (post-transfer closeout, 2026-06-05) —
    // must always happen: the user commanded it. It bypasses protected, the
    // lease gate, and the KEEP-guard. (The transfer handler additionally skips
    // protected sessions BEFORE calling, so the bypass never reaches them on
    // that path.) Autonomous killers (the default) can only *request*; the
    // authority holds the safety checks.
    if (origin === 'autonomous') {
      // Protected set — never autonomously reap a protected session.
      if (this.config.protectedSessions.includes(session.tmuxSession)) {
        this.emit('reapBlocked', { session, reason, skipped: 'protected', origin });
        return { terminated: false, skipped: 'protected' };
      }
      // Lease-holder gate: a standby machine never reaps another machine's sessions.
      // F8 carve-out: the topic-moved closeout is exempt — it closes THIS
      // machine's OWN leftover session for a topic that moved AWAY (the old
      // owner is by definition usually not the lease holder, so the gate
      // structurally vetoed the exact teardown the transfer requires). The
      // flag lifts ONLY this gate; protected (above) and the KEEP-guard
      // cascade (below) are unaffected.
      if (this.isAwakeMachine && !this.isAwakeMachine()
          && !opts?.bypassLeaseForTopicMovedCloseout) {
        this.emit('reapBlocked', { session, reason, skipped: 'not-lease-holder', origin });
        return { terminated: false, skipped: 'not-lease-holder' };
      }
      // ReapGuard: refuse to end a session the guard says to KEEP. Consulted
      // before the in-flight lock is acquired (re-entrancy ordering).
      //
      // `knownDead` bypass (boot-purge, #1): the caller has already proven the
      // session is `dead` via the P1 oracle (tmux server reachable + exact id
      // absent). The guard exists to protect a LIVE-but-busy session from being
      // mistaken for dead — its topic-state KEEP reasons (recent-user-message,
      // open-commitment) are liveness-blind, so consulting it on a proven-dead
      // session would pin a tombstone in the running list and re-create the boot
      // death-spiral the purge guards against. A proven-dead session has no
      // liveness to protect, so skip the guard. Lease + protected + CAS still apply.
      if (!opts?.knownDead) {
        // Build the set of keep-reasons the active bypass flags TREAT AS BYPASSED,
        // then ask the guard for the first keep-reason that is NOT bypassed. This
        // re-checks EVERY other guard (the contract the spec's Part E promises):
        // lifting one named reason no longer masks a lower-priority guard, because
        // `blockedReason` now skips the bypassed reason and keeps evaluating down
        // the cascade. `protected` (#1) is never added here and so always wins.
        const bypassedReasons: string[] = [];
        if (opts?.bypassRecoveryFlag) bypassedReasons.push('recovery-in-flight');
        if (opts?.bypassActiveProcessKeep) bypassedReasons.push('active-process');
        if (opts?.bypassRecentUserMessageForConfirmedMove) bypassedReasons.push('recent-user-message');
        // C2/R4-2: the idle-zombie branch precomputes the guard verdict (no bypass
        // flags) and threads it here so the guard is evaluated ONCE this tick.
        // Every other caller leaves precomputedGuardVerdict undefined and the guard
        // is evaluated fresh (today's behavior, honoring any bypass flags).
        const blocked = precomputedGuardVerdict !== undefined
          ? precomputedGuardVerdict.blocked
          : this.reapGuard?.blockedReason(
              session,
              bypassedReasons.length > 0 ? bypassedReasons : undefined,
            );
        // `bypassRecoveryFlag` (UNIFIED-SESSION-LIFECYCLE §P0 #8): the recovery
        // engine itself sets the recovery-in-flight flag synchronously before
        // its kill-to-respawn, so the guard would otherwise refuse the
        // recovery's own kill. Bypass ONLY the recovery-in-flight check — all
        // other KEEP-guards (active subagent, recent-user-message, etc.) still
        // apply, so a session mid-conversation isn't killed-to-respawn under
        // the cover of "recovery."
        //
        // `bypassActiveProcessKeep` (active-process relaxation parity): the
        // SessionReaper's `evaluate()` ALREADY relaxes the `active-process`
        // existence-veto for a session it has proven idle (cpuFlat under
        // pressure, or 8h-stale-idle with only its own idle children e.g. the
        // standing MCP stack), then layers the stateful transcript-flat +
        // positive-idle + render-stasis-through-grace proofs on top. But this
        // shared ReapGuard re-runs the UN-relaxed `active-process` check, so
        // without this bypass the authority re-vetoes the very reap the reaper
        // authorized — the session is flagged reap-eligible, attempted, and
        // skipped:active-process every tick forever (observed live: 1,532×).
        // The reaper sets this flag ONLY on a reap whose active-process veto it
        // relaxed, so an arbitrary killer cannot use it; and like the recovery
        // bypass it lifts ONLY the `active-process` reason — every other
        // KEEP-guard (recent-user-message, open-commitment, active-subagent,
        // main-process-active, …) is re-checked fresh and still vetoes. Spec:
        // docs/specs/reaper-active-process-relaxation-parity.md.
        // `bypassRecentUserMessageForConfirmedMove` (post-transfer closeout
        // correctness, Part E): the SessionReaper has CONFIRMED (via the liveness
        // snapshot) that this topic genuinely moved to a live remote owner AND
        // that the bound topic's freshest LOCAL user message predates that
        // liveness evidence — so the `recent-user-message` veto is a stale-recent
        // false positive on a true duplicate leftover. Like the bypasses above it
        // lifts ONLY its one named reason; every other KEEP-guard still vetoes.
        //
        // The bypass is now applied INSIDE `blockedReason` (via `bypassedReasons`
        // above): a bypassed reason is skipped and the cascade continues, so
        // `blocked` is already the first NON-bypassed keep-reason (or null). No
        // post-hoc single-reason match is needed — that old match-one logic was
        // the masking bug (a higher-priority bypassed reason hid a lower-priority
        // live guard). If `blocked` is non-null here, it is a guard that genuinely
        // vetoes the kill, so withhold with that reason.
        if (blocked) {
          this.emit('reapBlocked', { session, reason, skipped: blocked.reason, origin });
          return { terminated: false, skipped: blocked.reason };
        }
      }
    }

    // In-flight guard: a concurrent terminate already owns this session.
    if (this.terminating.has(sessionId)) {
      return { terminated: false, skipped: 'in-flight' };
    }
    this.terminating.add(sessionId);
    try {
      // ── Work-evidence stamp (reap-notify spec R2.1) ──
      // Killer-supplied evidence wins (clamped to the enum); when the killer
      // supplied nothing, fall back to the guard's observe-only collection
      // (expected-empty for guard-cleared kills — documented). knownDead skips
      // stamping entirely: a proven-dead session has no work to evidence.
      let workEvidence: string[] = [];
      if (!opts?.knownDead) {
        if (opts?.workEvidence !== undefined) {
          // Killer-supplied is AUTHORITATIVE — including an explicit empty
          // array (e.g. the idle-reaper proved the session idle; re-collecting
          // here would re-stamp the very active-process signal it disproved).
          workEvidence = clampWorkEvidence(opts.workEvidence);
        } else if (this.reapGuard) {
          try {
            workEvidence = this.reapGuard.workEvidence(session, {
              skipForkChecks: this.pressureTier?.() === 'critical',
            });
            // A bypassActiveProcessKeep kill means the killer PROVED the
            // process tree idle — the fallback must not re-assert it (R2.1).
            if (opts?.bypassActiveProcessKeep) {
              workEvidence = workEvidence.filter((e) => e !== 'active-process');
            }
          } catch {
            workEvidence = []; // never let evidence collection endanger the kill path
          }
        }
      }
      const midWork = isMidWork(workEvidence);

      // Emit BEFORE destroying tmux so listeners (TopicResumeMap, SlackAdapter)
      // can capture resume UUIDs while the session is still alive.
      this.emit('beforeSessionKill', session);
      try {
        await execFileAsync(this.config.tmuxPath, ['kill-session', '-t', `=${session.tmuxSession}`]);
      } catch { /* session may already be dead */ }
      session.status = opts?.finalStatus ?? 'completed';
      session.endedAt = new Date().toISOString();
      session.endedReason = reason;
      if (!opts?.knownDead) {
        session.endedMidWork = midWork;
        if (workEvidence.length > 0) session.endedWorkEvidence = workEvidence;
      }
      this.state.saveSession(session);
      this.emit('sessionComplete', session);
      // The single reap-notification signal (§P3): terminal reaps may reach the
      // user; recovery-bounce reaps are silent. One emission, at the one chokepoint.
      this.emit('sessionReaped', { session, reason, disposition, origin, midWork, workEvidence, ...(opts?.via ? { via: opts.via } : {}) });
      this.idlePromptSince.delete(session.id);
      this.reapingSessions.delete(session.id);
      return { terminated: true };
    } finally {
      this.terminating.delete(sessionId);
    }
  }

  /**
   * Pressure-tier provider for the evidence fallback (reap-notify spec R2.1):
   * at tier 'critical' the fork-based closures are skipped and the
   * `unverified-under-pressure` marker is stamped instead. Wired at boot to
   * the shared PressureGauge; absent ⇒ forks run normally.
   */
  setPressureTierProvider(provider: () => 'normal' | 'moderate' | 'critical'): void {
    this.pressureTier = provider;
  }

  /**
   * Observe-only work-evidence snapshot for a LIVE session (reap-notify spec
   * R2.1) — for killers that must capture evidence at their decision moment,
   * before their own teardown destroys it (the quota-shed migrator's Ctrl+C
   * grace round). Never throws; never blocks anything.
   */
  collectWorkEvidence(sessionId: string): string[] {
    try {
      const session = this.state.getSession(sessionId);
      if (!session || !this.reapGuard) return [];
      return this.reapGuard.workEvidence(session, {
        skipForkChecks: this.pressureTier?.() === 'critical',
      });
    } catch {
      // @silent-fallback-ok — evidence collection must never endanger the kill
      // path (reap-notify R2.1); an error means "no evidence collected", which
      // the chokepoint records honestly as the expected-empty fallback.
      return [];
    }
  }

  /**
   * Associate a Claude Code session UUID with an instar session.
   * Called on hook events from a Claude Code session, allowing
   * SubagentTracker lookups to bridge the two ID spaces.
   *
   * Last-writer-wins, NOT write-once: a fresh respawn or `claude --resume`
   * rotates the conversation UUID, and every subsequent hook event carries
   * the NEW id. The old write-once guard froze the first-ever UUID, so after
   * any respawn the record pointed at a transcript that no longer grew (or
   * never existed) — which made both sentinels' jsonl-growth recovery
   * verification permanently fail and falsely escalate healthy sessions
   * ("no jsonl growth after 6 attempts" on a session that was actively
   * answering). 2026-06-06 echo-api-errors incident.
   *
   * Safe because every hook event's session_id is the MAIN conversation's
   * UUID (subagents are identified by separate agent_id/agent_transcript_path
   * fields, never by swapping session_id), and a dead conversation emits no
   * further events to flip the value back.
   */
  setClaudeSessionId(instarSessionId: string, claudeSessionId: string): void {
    if (!claudeSessionId) return;
    const sessions = this.state.listSessions({ status: 'running' });
    const session = sessions.find(s => s.id === instarSessionId);
    if (!session || session.claudeSessionId === claudeSessionId) return;
    if (session.claudeSessionId) {
      console.log(
        `[SessionManager] claudeSessionId rotated for "${session.tmuxSession}": ` +
        `${session.claudeSessionId} → ${claudeSessionId} (respawn/resume)`,
      );
    }
    session.claudeSessionId = claudeSessionId;
    this.state.saveSession(session);
  }

  /**
   * Find a running session by its instar session ID.
   */
  getSessionById(instarSessionId: string): Session | undefined {
    return this.state.listSessions({ status: 'running' }).find(s => s.id === instarSessionId);
  }

  /**
   * Look up the topic binding for a tmux session from the topic-session registry.
   * Returns null if the session is not bound to any topic.
   */
  private getTopicBinding(tmuxSession: string, preferTopicId?: number | null): TopicBinding | null {
    if (!this.registryPath) return null;
    try {
      if (!fs.existsSync(this.registryPath)) return null;
      const registry = JSON.parse(fs.readFileSync(this.registryPath, 'utf-8'));
      const topicToSession = registry.topicToSession || {};
      const topicToName = registry.topicToName || {};

      // Reverse lookup: collect ALL topics mapping to this session. Two topics
      // whose names slug to the same tmux session name COLLIDE here — e.g.
      // "Initiatives and maturation check-ins" (#21487) and the case-variant
      // "initiatives and maturation check-ins" (#21624) both produce
      // `echo-initiatives-and-maturation-check-ins`. With a single-match reverse
      // lookup that returned the FIRST entry, a legitimate message from the OTHER
      // colliding topic was blocked by the InputGuard as cross-topic (incident
      // 2026-06-09: topic 21624 silently unresponsive — every message dropped).
      const matches: number[] = [];
      for (const [topicIdStr, sessionName] of Object.entries(topicToSession)) {
        if (sessionName === tmuxSession) matches.push(parseInt(topicIdStr, 10));
      }
      if (matches.length === 0) return null;

      // Disambiguate on collision: if the incoming message names one of the
      // colliding topics (preferTopicId, parsed from its [telegram:N] tag),
      // bind to THAT topic so the provenance check passes. Otherwise fall back
      // to the first match (single-topic case is unchanged).
      const topicId = (preferTopicId != null && matches.includes(preferTopicId))
        ? preferTopicId
        : matches[0];
      return {
        topicId,
        topicName: (topicToName[String(topicId)] as string) || `Topic ${topicId}`,
        channel: 'telegram', // Currently only Telegram uses the registry
        sessionName: tmuxSession,
      };
    } catch {
      // Registry read failure — fail open (no binding = no check)
      return null;
    }
  }

  /**
   * Start polling for completed sessions. Emits 'sessionComplete' when
   * a running session's tmux process disappears.
   *
   * Uses async tmux calls to avoid blocking the event loop when
   * many sessions are running.
   */
  startMonitoring(intervalMs: number = 5000): void {
    if (this.monitorInterval) return;

    this.monitorInterval = setInterval(() => {
      // Prevent overlapping monitor ticks
      if (this.monitoringInProgress) return;
      this.monitorTick().catch(err => {
        console.error(`[SessionManager] Monitor tick error: ${err}`);
      });
    }, intervalMs);
  }

  private async monitorTick(): Promise<void> {
    this.monitoringInProgress = true;
    try {
      const running = this.state.listSessions({ status: 'running' });
      // Sweep the permission-prompt resolver's bounded state once per tick (evict
      // entries for ended sessions + per-entry TTL). The resolver's sweep is internally
      // guarded (it never throws into the monitor loop), so no outer guard is needed.
      this.permissionPromptResolver?.sweep(new Set(running.map(s => s.tmuxSession)));
      for (const session of running) {
        // Grace period: don't check sessions that started less than 15 seconds ago.
        // Claude Code takes several seconds to start — the process might not be
        // visible in tmux yet when the monitor runs its first check.
        if (session.startedAt) {
          const ageMs = Date.now() - new Date(session.startedAt).getTime();
          if (ageMs < 15_000) continue;
        }

        const alive = await this.isSessionAliveAsync(session.tmuxSession);
        // (A) tri-state: ONLY a definitive `false` (dead) marks the session
        // completed. `'indeterminate'` (slow/timed-out tmux) does NOT — it falls
        // through to be re-checked next tick rather than reaping a live session.
        if (alive === false) {
          // CAS re-read after the await: an operator kill (or another killer)
          // can land mid-probe, so re-read the live record before mutating it —
          // mirrors terminateSession's status CAS. If it already drifted off
          // 'running', another writer owns the transition; skip this inline
          // mark-completed (which lacks terminateSession's own CAS guard).
          const fresh = this.state.getSession(session.id);
          if (!fresh || fresh.status !== 'running') {
            continue;
          }
          // Check if this session had a pending Telegram injection that never got a response
          const pendingInjection = this.pendingInjections.get(session.tmuxSession);
          if (pendingInjection) {
            console.warn(`[SessionManager] Session "${session.name}" died with unanswered Telegram injection for topic ${pendingInjection.topicId} (injected ${Math.round((Date.now() - pendingInjection.injectedAt) / 1000)}s ago)`);
            this.pendingInjections.delete(session.tmuxSession);
            this.emit('injectionDropped', {
              topicId: pendingInjection.topicId,
              sessionName: session.tmuxSession,
              text: pendingInjection.text,
              injectedAt: pendingInjection.injectedAt,
            });
          }
          fresh.status = 'completed';
          fresh.endedAt = new Date().toISOString();
          this.state.saveSession(fresh);
          this.emit('sessionComplete', fresh);
          continue;
        }

        await this.recordBuildContextMaybeAsync(session.tmuxSession);

        // ── Rerouted-interactive completion branch (june15-headless-spawn-
        // reroute, PR2 O1) ──
        // A rerouted session (completionMode==='pattern') never exits on task
        // success, so completion is detected by (a) its OWN sentinel pattern and
        // (b) a hard lifetime cap as belt-and-suspenders. This branch handles
        // those sessions and `continue`s; the default lane (completionMode unset
        // or 'exit') falls through to today's global detectCompletion below,
        // byte-for-byte unchanged.
        if (session.completionMode === 'pattern') {
          // (a) Sentinel match → terminate via the SUCCESS path. We use
          // finalStatus:'completed' so sessionComplete carries status
          // 'completed' → JobScheduler records SUCCESS (JobScheduler.ts:1109
          // maps only 'killed' → 'timeout'). A sentinel completion is a clean
          // finish, NOT a timeout.
          if (!this.config.protectedSessions.includes(session.tmuxSession) &&
              await this.detectSessionCompletionMaybeAsync(session)) {
            console.log(`[SessionManager] Rerouted session "${session.name}" completed (sentinel detected). Reaping as success.`);
            await this.terminateSession(session.id, 'sentinel-complete', {
              finalStatus: 'completed',
              disposition: 'terminal',
            });
            continue;
          }
          // (b) Hard lifetime cap → kill + report. This IS a timeout (the model
          // never printed the sentinel), so finalStatus:'killed' → JobScheduler
          // records 'timeout'. The cap bounds the leak when the model phrases
          // its finish differently than the sentinel.
          if (session.startedAt && session.maxLifetimeMinutes) {
            const lifeElapsedMin = (Date.now() - new Date(session.startedAt).getTime()) / 60000;
            if (lifeElapsedMin > session.maxLifetimeMinutes &&
                !this.config.protectedSessions.includes(session.tmuxSession)) {
              console.warn(`[SessionManager] Rerouted session "${session.name}" exceeded its hard lifetime (${Math.round(lifeElapsedMin)}m > ${session.maxLifetimeMinutes}m) without a completion sentinel. Killing (timeout).`);
              const killed = await this.terminateSession(session.id, 'rerouted-lifetime', {
                finalStatus: 'killed',
                disposition: 'terminal',
              });
              if (killed.terminated) {
                DegradationReporter.getInstance().report({
                  feature: 'SessionManager.monitorTick.reroutedLifetime',
                  primary: 'rerouted-interactive session completes via its sentinel within the lifetime cap',
                  fallback: 'killed on the hard lifetime cap (recorded as timeout)',
                  reason: `Session "${session.name}" ran ${Math.round(lifeElapsedMin)}m without printing its completion sentinel`,
                  impact: 'Rerouted job recorded a timeout; it reruns cleanly on its next trigger',
                });
              }
              continue;
            }
          }
          // Still running, no sentinel, under lifetime — leave it; re-check next
          // tick. Skip the rest of the loop body (the default exit/idle paths
          // below are tuned for the headless lane, not a held REPL).
          continue;
        }

        // Gemini CLI can complete a Telegram turn by rendering the final
        // assistant block in the TUI without executing the relay script. When a
        // topic-bound injection is still pending, surface that completed block
        // as the reply instead of leaving the user silent.
        if (session.framework === 'gemini-cli') {
          const pendingInjection = this.pendingInjections.get(session.tmuxSession);
          if (pendingInjection) {
            const pane = (await this.captureOutputMaybeAsync(session.tmuxSession, 400)) || '';
            const marker = `[telegram:${pendingInjection.topicId}`;
            const markerIdx = pane.lastIndexOf(marker);
            if (markerIdx >= 0) {
              const reply = extractGeminiFinalAssistantBlock(pane.slice(markerIdx));
              if (reply && reply.trim()) {
                this.pendingInjections.delete(session.tmuxSession);
                this.emit('injectionReplyDetected', {
                  topicId: pendingInjection.topicId,
                  sessionName: session.tmuxSession,
                  text: reply,
                  injectedAt: pendingInjection.injectedAt,
                });
              }
            }
          }
        }

        // Check for completion patterns even while session appears alive
        // (catches sessions where Claude finished but tmux is still open)
        if (!this.config.protectedSessions.includes(session.tmuxSession) &&
            await this.detectCompletionMaybeAsync(session.tmuxSession)) {
          console.log(`[SessionManager] Session "${session.name}" completed (pattern detected). Cleaning up.`);
          // Emit beforeSessionKill so listeners (TopicResumeMap, SlackAdapter) can save resume UUIDs
          this.emit('beforeSessionKill', session);
          try {
            await execFileAsync(this.config.tmuxPath, ['kill-session', '-t', `=${session.tmuxSession}`]);
          } catch { /* ignore */ }
          session.status = 'completed';
          session.endedAt = new Date().toISOString();
          this.state.saveSession(session);
          this.emit('sessionComplete', session);
          continue;
        }

        // Enforce session timeout (prevents zombie/stuck sessions)
        // Uses explicit maxDurationMinutes if set, otherwise falls back to
        // DEFAULT_MAX_DURATION_MINUTES as an absolute safety net.
        //
        // Activity-aware kill gate: a session that is over the age limit but
        // demonstrably WORKING (terminal not at idle prompt, OR active
        // non-baseline child processes) is deferred for kill. Wall-clock age
        // alone is not sufficient — long-running autonomous flows (spec
        // convergence + multi-phase builds, /loop tasks, multi-hour driving
        // through several PRs to merge) routinely exceed 240m while producing
        // tool calls every few seconds. The previous unconditional age-based
        // kill reaped these sessions mid-build, taking their background agents
        // with them. The idle-detection block below (the existing infrastructure)
        // catches sessions that are genuinely stuck.
        if (session.startedAt) {
          const maxMinutes = session.maxDurationMinutes || this.effectiveMaxDurationMinutes;
          const elapsed = (Date.now() - new Date(session.startedAt).getTime()) / 60000;
          const buffer = Math.min(maxMinutes * 0.2, 60); // 20% buffer, max 60 min
          const limit = maxMinutes + buffer;
          if (elapsed > limit && !this.config.protectedSessions.includes(session.tmuxSession)) {
            // Activity check — defer kill if the session is doing real work.
            const ageGateOutput = await this.captureMeaningfulTailMaybeAsync(session.tmuxSession, 5);
            const ageGateIsIdle = ageGateOutput && IDLE_PROMPT_PATTERNS.some(p => ageGateOutput.includes(p));
            const ageGateHasProcs = await this.hasActiveProcessesMaybeAsync(session.tmuxSession);
            // Transcript-activity backstop (2026-06-13 incident): the pane+procs
            // check is BLIND to MCP/tool work. A session driving Playwright (or any
            // MCP server) runs that work OUT of the tmux process tree, and between
            // tool calls the pane shows an idle-looking prompt — so an actively
            // working session reads as "idle, no procs" and was terminal-killed at
            // the age limit. The framework transcript grows on every turn/tool
            // event, so a recently-modified JSONL is ground-truth that the session
            // is alive and producing. Treat it exactly like a live child process:
            // defer the kill.
            const ageGateTranscriptActive = this.isTranscriptRecentlyActive(session, AGE_GATE_TRANSCRIPT_ACTIVE_MS);
            const ageGateTrulyIdle = isAgeGateTrulyIdle(!!ageGateIsIdle, ageGateHasProcs, ageGateTranscriptActive);

            if (!ageGateTrulyIdle) {
              // Over age limit but actively working. Log once per session to
              // avoid log spam, defer the kill. The idle-detection block below
              // will catch the session once it genuinely stops working.
              if (!this.overAgeButActiveLogged.has(session.id)) {
                this.overAgeButActiveLogged.add(session.id);
                console.warn(
                  `[SessionManager] Session "${session.name}" is past the age limit (${Math.round(elapsed)}m > ${maxMinutes}m) ` +
                  `but is actively working (procs=${ageGateHasProcs}, idleAtPrompt=${!!ageGateIsIdle}, transcriptActive=${ageGateTranscriptActive}). Deferring kill; ` +
                  `the idle-detection block will catch it once it stops producing work.`
                );
              }
              // Fall through to the rest of the loop — do NOT skip idle detection,
              // because if the session DOES go idle, we still want it killed.
            } else if (!this.ageKillBackoff.shouldRequest(session.id, Date.now())) {
              // Over age + idle, but a recent kill-request for this session was VETOED by
              // the KEEP-guard (recent user message / topic-bound / commitment). Respect
              // that verdict: stay silent and back off instead of re-asking every 5s tick
              // (the 2026-06-05 17,503-line flood). Fall through to idle detection — when
              // the keep-reason lapses, the back-off expires and we re-evaluate then.
            } else {
              // Check for unanswered injection before timeout kill
              const pendingInjection = this.pendingInjections.get(session.tmuxSession);
              if (pendingInjection) {
                console.warn(`[SessionManager] Timed-out session "${session.name}" had unanswered injection for topic ${pendingInjection.topicId}`);
                this.pendingInjections.delete(session.tmuxSession);
                this.emit('injectionDropped', {
                  topicId: pendingInjection.topicId,
                  sessionName: session.tmuxSession,
                  text: pendingInjection.text,
                  injectedAt: pendingInjection.injectedAt,
                });
              }
              console.warn(`[SessionManager] Session "${session.name}" exceeded timeout (${Math.round(elapsed)}m > ${maxMinutes}m) and is idle. Requesting kill via ReapAuthority.`);
              // Unified self-action backpressure: admit the age-kill through the
              // governor BEFORE the ReapAuthority funnel (observe-only: always
              // allows + records the would-verdict; an enforce-mode non-allow
              // stands down this tick — the level-triggered over-age condition
              // re-fires on the next monitor pass).
              const ageKillTarget = deriveTargetKey(session.id);
              const ageKillAdmission = ageKillGov.admitSync(ageKillTarget, { incarnation: session.id, lane: 'job' });
              if (ageKillAdmission.outcome !== 'allow') {
                continue;
              }
              const ageKillSink = consumeAdmissionToken(ageKillAdmission.token, 'age-kill-backoff', { targetKey: ageKillTarget.key });
              if (!ageKillSink.proceed) {
                continue;
              }
              // Route through the single ReapAuthority (§P0) instead of an inline
              // kill: this restores the beforeSessionKill/sessionComplete emission,
              // adds the sessionReaped signal + reap-log entry, applies the lease
              // gate, and — critically — gains the P2 KEEP-guard's topic-bound
              // grace, so a session that just received a user message is not
              // age-killed out from under the user.
              const ageKillResult = await this.terminateSession(session.id, 'age-limit', {
                finalStatus: 'killed',
                disposition: 'terminal',
              });
              if (ageKillResult.terminated) {
                // Actually killed — drop any back-off state for the (now gone) session.
                this.ageKillBackoff.recordKilled(session.id);
              } else {
                // The KEEP-guard kept it (skipped:<reason>). Respect that and back off:
                // suppress re-requests for the back-off window instead of nagging every
                // tick. ONE informative line — not 17,503.
                this.ageKillBackoff.recordVeto(session.id, Date.now());
                console.warn(
                  `[SessionManager] Session "${session.name}" is over age but KEPT (${ageKillResult.skipped ?? 'guard'}); ` +
                  `backing off age re-checks. It is NOT being killed.`
                );
              }
              continue;
            }
          }
        }

        // Idle detection — kill sessions that are truly stopped.
        // A session is idle when: (1) the terminal shows idle prompt patterns,
        // AND (2) no non-baseline child processes are running. This is the ground
        // truth — no exemptions needed for subagents, topic bindings, or relay leases.
        // If the process tree shows work, the session is active. Period.
        // Skip sessions the SessionReaper has leased for a two-phase reap — it
        // is the single actor on them while reaping (§3.6).
        if (!this.config.protectedSessions.includes(session.tmuxSession) && !this.isReaping(session.id)) {
          const output = await this.captureMeaningfulTailMaybeAsync(session.tmuxSession, 5);

          // ── Permission-Prompt Auto-Resolver (always-on safety floor) ──
          // Cheap pre-gate on the already-captured 5-line tail, keyed on the
          // MENU SHAPE (a glyph/❯-led numbered option, or a generic blocking
          // affordance — all bottom-anchored, so reliably in the last 5 lines).
          // Only on a hit do a fuller capture + evaluate, so the common
          // (no-menu) case adds ZERO extra captures.
          if (this.permissionPromptResolver && output &&
              /(?:[>❯●○◉]\s*)?\d+\.\s|Esc to cancel|Do you want to proceed/i.test(output)) {
            try {
              const full = await this.captureMeaningfulTailMaybeAsync(session.tmuxSession, 16);
              if (full) {
                await this.permissionPromptResolver.evaluate(session.tmuxSession, toPaneTailLines(full));
              }
            } catch { /* resolver must never throw into the monitor loop */ }
          }

          const isIdleAtPrompt = output && IDLE_PROMPT_PATTERNS.some(p => output.includes(p));

          // ── Prompt Gate: feed captured output to InputDetector ──
          if (this.promptDetector && output) {
            const fullOutput = await this.captureOutputMaybeAsync(session.tmuxSession, 50);
            if (fullOutput) {
              this.promptDetector.onCapture(session.tmuxSession, fullOutput);
            }
          }

          // Two conditions must BOTH be true for idle: prompt pattern + no active processes
          const isActuallyIdle = isIdleAtPrompt && !(await this.hasActiveProcessesMaybeAsync(session.tmuxSession));

          if (isActuallyIdle) {
            const now = Date.now();
            // DARK-FLAGGED idle-throttle settle-gate (monitoring.idleThrottleSettleGate):
            // runs on EVERY idle tick (NOT just the first) so the pane can be re-sampled
            // across polls to reach 'settled' — mirroring the SessionWatchdog's per-tick
            // settle loop. When enabled this OWNS the rate-limit hand-off (the first-idle-
            // tick block below fires the legacy immediate emit only when the flag is OFF).
            // A throttle string alone can linger in a session's scrollback after the
            // throttle cleared; requiring the pane byte-identical across polls (a working
            // session animates its spinner) proves the turn genuinely ended on the throttle.
            // Strictly more conservative than the legacy single-glance emit.
            if (this.idleThrottleSettleGate) {
              const settledSnapshot = await this.captureOutputMaybeAsync(session.tmuxSession, RATE_LIMIT_SETTLED_CAPTURE_LINES);
              const { action, nextState } = nextIdleThrottleAction(
                settledSnapshot,
                this.idleThrottleSettle.get(session.tmuxSession),
                now,
              );
              if (action === 'emit') {
                this.idleThrottleSettle.delete(session.tmuxSession);
                this.emit('rateLimitedAtIdle', session.tmuxSession);
                continue; // Settled → sentinel owns recovery.
              }
              if (action === 'wait') {
                if (nextState) this.idleThrottleSettle.set(session.tmuxSession, nextState);
                continue; // Not settled yet — re-sample next idle tick; do NOT emit, and
                          // (like the watchdog's 'waiting') do not run the generic-error
                          // nudge or idle-kill while a throttle is present-but-unsettled.
              }
              // 'fall-through': no current throttle in the settled window (a stale buffer
              // line) → clear tracking and proceed to the normal idle machinery below.
              this.idleThrottleSettle.delete(session.tmuxSession);
            }
            if (!this.idlePromptSince.has(session.id)) {
              this.idlePromptSince.set(session.id, now);

              // ── Pasted text stuck: detect unsubmitted paste and retry Enter ──
              // Claude Code shows "[Pasted text #N]" when bracketed paste content
              // sits in the input buffer without being submitted. This happens when
              // the Enter key sent after the paste end sequence doesn't register.
              // Re-send Enter to unstick it. Only try once per session to avoid loops.
              if (!this.pasteRetried.has(session.id)) {
                const recentForPaste = await this.captureOutputMaybeAsync(session.tmuxSession, 15);
                if (recentForPaste && /\[Pasted text #\d+\]/.test(recentForPaste)) {
                  this.pasteRetried.add(session.id);
                  console.log(`[SessionManager] Session "${session.name}" has unsubmitted pasted text — resending Enter.`);
                  await this.sendKeyMaybeAsync(session.tmuxSession, 'Enter');
                  this.idlePromptSince.delete(session.id); // Reset idle timer
                  this.idleKillBackoff?.reset(session.id);
                  continue; // Skip to next session
                }
              }

              // ── Error nudge: on first idle detection, check terminal for API errors ──
              // If the session went idle because of an API error (not a natural stop),
              // inject a nudge to get it working again instead of waiting 15m to kill.
              const nudgeTotal = this.errorNudgeTotal.get(session.id) ?? 0;
              if (shouldErrorNudge(this.errorNudgedSessions.has(session.id), nudgeTotal)) {
                // 45 rows (RATE_LIMIT_SETTLED_CAPTURE_LINES), not 30: Claude Code's input
                // box + footer + tips render 15-25 rows BELOW the API-error line, so a
                // 30-row capture can miss the error entirely (the 2026-05-30 incident; the
                // same reason detectRateLimited/SessionWatchdog capture 45). The classifier
                // tail-gates within this; detectRateLimited only inspects its own last ~20
                // lines, so the wider capture is a no-op for it (CMT-1785).
                const recentOutput = await this.captureOutputMaybeAsync(session.tmuxSession, RATE_LIMIT_SETTLED_CAPTURE_LINES);
                if (recentOutput) {
                  // Server-side throttle ("Server is temporarily limiting
                  // requests · not your usage limit") gets a DIFFERENT path:
                  // the immediate nudge re-hits the live throttle and burns
                  // quota, so we skip it and hand ownership to the
                  // RateLimitSentinel (backoff-before-nudge). We do NOT consume
                  // the single-nudge token, so a later generic API error can
                  // still get its one nudge. The sentinel dedupes the re-emits
                  // that persist while the throttle string stays on the pane.
                  if (detectRateLimited(recentOutput) && !this.idleThrottleSettleGate) {
                    // Legacy (flag OFF): hand straight to the RateLimitSentinel on a single
                    // glance. When the settle-gate is ON, the per-idle-tick settle check
                    // above (which re-samples the pane every tick to reach 'settled') OWNS
                    // this hand-off — so we deliberately do NOT also fire the immediate emit
                    // here, which would defeat the gate.
                    this.emit('rateLimitedAtIdle', session.tmuxSession);
                    continue; // Skip to next session — sentinel owns recovery.
                  }
                  // CMT-1785: tail-gated + frame-discriminated classify replaces the bare
                  // buffer-wide `.includes()` (which fired on stale-scrollback + quoted
                  // content). A SIGNAL feeding the existing apiErrorAtIdle authority; the
                  // match set is a strict subset of the old bare match, so it can only
                  // SUPPRESS spurious fires, never add one.
                  const idleErr = classifyIdleError(recentOutput, TERMINAL_ERROR_PATTERNS);
                  const hasError = idleErr.isTerminalError;
                  // Structured observability (once per idle episode): record fired vs
                  // suppressed so a wave of suppressions on genuine errors (the under-fire
                  // risk) is observable. Armed here; cleared with errorNudgedSessions.
                  if (!this.idleErrorClassified.has(session.id)) {
                    const bareCandidate = TERMINAL_ERROR_PATTERNS.some(p => recentOutput.includes(p));
                    if (idleErr.isTerminalError || bareCandidate) {
                      this.idleErrorClassified.add(session.id);
                      console.log(`[SessionManager] ${JSON.stringify({
                        event: 'idle-error-classify',
                        session: session.name,
                        result: idleErr.isTerminalError ? 'fired' : 'suppressed',
                        matchedPattern: idleErr.matchedPattern,
                        tailDepthFromEnd: idleErr.tailDepthFromEnd,
                        reason: idleErr.isTerminalError ? undefined : 'no-frame-or-outside-tail',
                      })}`);
                    }
                  }
                  if (hasError) {
                    // Arm the per-episode guard (re-armed on recovery — see the
                    // "Session is active" branch). Prevents per-tick re-emit/re-nudge.
                    this.errorNudgedSessions.add(session.id);
                    // If a recovery sentinel owns the generic transient-API-error class
                    // (production wiring), hand off to its backoff→verify→escalate
                    // lifecycle rather than an immediate retry that could re-hit a
                    // still-down API. The sentinel owns the retry budget + is re-armable
                    // across episodes by design. (Mirrors the rate-limit handoff above;
                    // generalizes that proven recovery to the whole transient-API class.)
                    if (this.listenerCount('apiErrorAtIdle') > 0) {
                      this.emit('apiErrorAtIdle', session.tmuxSession);
                      this.idlePromptSince.delete(session.id);
                      this.idleKillBackoff?.reset(session.id);
                      continue; // Skip to next session — sentinel owns recovery.
                    }
                    // Fallback (no sentinel wired, e.g. bare/test): the re-armable
                    // immediate nudge, bounded by the lifetime cap.
                    this.errorNudgeTotal.set(session.id, nudgeTotal + 1);
                    console.log(`[SessionManager] Session "${session.name}" idle after API error — nudging to continue (nudge #${nudgeTotal + 1} this session).`);
                    this.sendInput(session.tmuxSession, 'You hit an API error. Please continue your work — skip or work around the action that failed.');
                    this.idlePromptSince.delete(session.id); // Reset idle timer
                    this.idleKillBackoff?.reset(session.id);
                    continue; // Skip to next session
                  }
                }
              }
            } else {
              const idleMs = now - this.idlePromptSince.get(session.id)!;
              // Topic-bound exemption: if this session is bound to a live messaging
              // topic, "idle at prompt" is the *healthy* waiting state — the agent is
              // waiting for the user's next message. Use a much longer threshold so
              // we don't kill healthy idle sessions and force the user through a
              // respawn-with-resume on every message after a pause.
              const binding = this.topicBindingChecker?.(session.tmuxSession);
              const killThresholdMinutes = binding != null
                ? this.effectiveBoundIdleKillMinutes
                : this.effectiveIdleKillMinutes;
              if (idleMs > killThresholdMinutes * 60_000) {
                // Veto: active compaction recovery in flight — skip kill and
                // reset the idle clock so we don't race the recovery window.
                if (this.activeRecoveryChecker && this.activeRecoveryChecker(session)) {
                  console.log(`[SessionManager] Skipping zombie kill for "${session.name}" — compaction recovery in flight.`);
                  this.idlePromptSince.delete(session.id);
                  this.idleKillBackoff?.reset(session.id); // recovery window → re-evaluate fresh next tick
                  continue;
                }
                // Check for unanswered injection before killing
                const pendingInjection = this.pendingInjections.get(session.tmuxSession);
                if (pendingInjection) {
                  console.warn(`[SessionManager] Zombie session "${session.name}" had unanswered injection for topic ${pendingInjection.topicId}`);
                  this.pendingInjections.delete(session.tmuxSession);
                  this.emit('injectionDropped', {
                    topicId: pendingInjection.topicId,
                    sessionName: session.tmuxSession,
                    text: pendingInjection.text,
                    injectedAt: pendingInjection.injectedAt,
                  });
                }
                const bindingNote = binding != null ? ` (topic-bound, threshold ${killThresholdMinutes}m)` : ` (threshold ${killThresholdMinutes}m)`;
                // Funnel through the single-writer path so the reaper and this
                // idle-kill can never double-kill or double-emit (§3.6). The
                // veto-backoff ledger (Fix A) suppresses the every-5s re-attempt on
                // a permanently-vetoed session; the WARN + terminate live in the
                // helper's enabled/disabled split.
                await this.handleIdleZombie(session, idleMs, binding ?? null, now, bindingNote, killThresholdMinutes);
                continue;
              }
            }
          } else {
            // Session is active — clear idle tracker AND re-arm the error nudge.
            // The session producing output means the prior idle episode is over (the
            // nudge worked, or the error cleared), so a FUTURE API-error episode in
            // this same long-running session deserves its own nudge. (errorNudgeTotal
            // is NOT cleared here — it's the lifetime runaway cap.)
            this.idlePromptSince.delete(session.id);
            this.idleKillBackoff?.reset(session.id); // resumed work → re-evaluate next tick, don't stay suppressed
            this.errorNudgedSessions.delete(session.id);
            this.idleErrorClassified.delete(session.id); // CMT-1785: re-arm the once-per-episode classify audit
            this.idleThrottleSettle.delete(session.tmuxSession); // session moved on — reset the settle clock
          }
        }
      }

      // Periodically clean up stale killed/completed session state files (every 5 min)
      const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
      if (Date.now() - this.lastCleanupAt > CLEANUP_INTERVAL_MS) {
        this.lastCleanupAt = Date.now();
        this.cleanupStaleSessions();
      }

      // Update cached session list (non-blocking) for health endpoint
      const stillRunning = this.state.listSessions({ status: 'running' });
      this._cachedRunningSessions = stillRunning;
      this._cachedRunningCount = stillRunning.length;
    } finally {
      this.monitoringInProgress = false;
    }
  }

  /**
   * Stop the monitoring poll.
   */
  stopMonitoring(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
  }

  /**
   * Current host memory-pressure tier (june15-headless-spawn-reroute PR2, O2).
   * Extracted from getSessionDiagnostics' inline computation so the reroute
   * pre-spawn gate and the diagnostics surface read ONE definition of pressure.
   * The reroute gate refuses to hold a fresh ~200-500MB REPL when the host is
   * already 'high'/'critical' — the 2026-06-05 laptop-meltdown class.
   */
  private currentMemoryPressure(): MemoryPressure {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedPercent = Math.round(((totalMem - freeMem) / totalMem) * 100);
    if (usedPercent >= 90) return 'critical';
    if (usedPercent >= 75) return 'high';
    if (usedPercent >= 60) return 'moderate';
    return 'low';
  }

  /**
   * Count live sessions currently on the rerouted-interactive lane
   * (june15-headless-spawn-reroute PR2, findings S1/O2). The concurrency cap
   * (subscriptionPath.maxRerouted) bounds the held-REPL memory envelope ACROSS
   * all spawn classes — jobs, A2A, and mentor spawns alike — since A2A/mentor
   * spawns carry no jobSlug and would otherwise be bounded only by the global
   * maxSessions.
   */
  private countReroutedInteractiveSessions(): number {
    return this.listRunningSessions().filter((s) => s.launchLane === 'rerouted-interactive').length;
  }

  /**
   * Decide whether a claude-code headless spawn should be rerouted onto the
   * interactive (subscription) lane (june15-headless-spawn-reroute PR2, "The
   * core switch"). ONLY claude-code is eligible — the lever is Anthropic-billing-
   * specific; codex/gemini headless paths don't draw the Anthropic SDK pot.
   *
   * - mode 'off'/absent           → false (today's behavior, byte-for-byte)
   * - mode 'force'                → true  (zero `claude -p` traffic, the soak lever)
   * - mode 'auto'                 → consult the SAME shared decideSdkVsSubscription
   *                                 + TTL-cached credit reader PR1 uses, so the two
   *                                 routing layers can't drift. Subscription → reroute.
   *
   * Emits a transition-only log line when the resolved lane CHANGES for this
   * framework (mirrors PR1's onRoute — a line per change, not per spawn).
   */
  private async shouldRerouteToInteractive(
    framework: IntelligenceFramework,
  ): Promise<boolean> {
    if (framework !== 'claude-code') return false;
    const mode = this.config.subscriptionPathMode ?? 'off';
    if (mode === 'off') return false;

    let reroute: boolean;
    let reason: string;
    if (mode === 'force') {
      reroute = true;
      reason = 'mode=force';
    } else {
      // 'auto' — null snapshot (unknown / no reader) ⇒ subscription floor.
      let snapshot: import('../providers/primitives/observability/usageMeterProvider.js').AgentSdkCreditSnapshot | null = null;
      if (this.readSdkCredit) {
        try {
          snapshot = await this.readSdkCredit();
        } catch {
          // @silent-fallback-ok — a credit-read error is the unknown state; the
          // shared decision below maps null → subscription floor (conservative),
          // exactly as PR1's routing policy does. No degradation: this is the
          // designed fallback, not an unexpected failure.
          snapshot = null;
        }
      }
      const decision = decideSdkVsSubscription(snapshot, DEFAULT_SAFETY_MARGIN_FRACTION);
      reroute = decision.path === 'subscription';
      reason = `mode=auto ${decision.reason}`;
    }

    const lane: 'headless' | 'rerouted-interactive' = reroute ? 'rerouted-interactive' : 'headless';
    if (this.lastRerouteDecision.get(framework) !== lane) {
      this.lastRerouteDecision.set(framework, lane);
      console.log(`[SessionManager] reroute lane → ${lane} for ${framework} (${reason})`);
    }
    return reroute;
  }

  /**
   * Spawn a new Claude Code session in tmux.
   *
   * When a WorktreeManager is wired in (see `setWorktreeManager`) and `topicId`
   * is supplied, the session is resolved into an isolated topic worktree
   * (PARALLEL-DEV-ISOLATION-SPEC.md). Without `topicId`, falls back to the
   * legacy main-checkout behavior for back-compat with non-topic-bound jobs.
   */
  async spawnSession(options: {
    name: string;
    prompt: string;
    /** Either a Claude tier name, a generic tier ('fast'|'balanced'|'capable'),
     *  or a raw model id. Resolution happens inside the framework's headless
     *  builder via resolveModelForFramework, so generic tiers work uniformly
     *  across Claude and Codex. */
    model?: ModelTier | string;
    jobSlug?: string;
    triggeredBy?: string;
    maxDurationMinutes?: number;
    topicId?: number | 'platform';
    /** durable-conversation-identity §7: the authenticated bootstrap
     *  conversation ids this session may open durable state on. Falls back to
     *  [topicId] when topicId is numeric. */
    bootstrapConversationIds?: number[];
    worktreeMode?: 'dev' | 'read-only' | 'doc-fix' | 'platform';
    worktreeSlug?: string;
    /** Per-call framework override; falls back to INSTAR_FRAMEWORK env, then claude-code. */
    framework?: IntelligenceFramework;
    /** Phase 6 local-model adapter — when set on a codex-cli launch,
     *  the spawned session uses `codex exec --oss --local-provider <p>`
     *  instead of OpenAI. Ignored for non-codex frameworks. */
    codexLocalProvider?: 'ollama' | 'lmstudio';
    /** Optional Claude Code per-session tool allowlist
     *  (mapped to `--allowedTools <comma-separated>`).
     *  When omitted, the spawn runs with full tools (back-compat).
     *  When an empty array, no `--allowedTools` flag is emitted —
     *  callers must explicitly pass at least one tool name to scope. */
    allowedTools?: string[];
    /** When true, a codex-cli spawn launches with full bypass so it can make
     *  MCP tool calls (e.g. threadline_send). Set ONLY by Threadline
     *  inbound-reply spawns — codex cancels MCP calls under any sandbox.
     *  Jobs leave this false and keep the workspace-write sandbox. No effect
     *  on non-codex frameworks. */
    codexAllowMcpTools?: boolean;
    /** When true, a claude-code spawn launches with NO project MCP servers
     *  (`--strict-mcp-config` + an empty `--mcp-config`), ignoring the project's
     *  `.mcp.json`. This is required for headless one-shot spawns that don't need
     *  MCP: the project's MCP set includes interactively-authenticated remote
     *  servers (e.g. Fathom's `mcp-remote`, the claude.ai connectors) that can't
     *  complete their OAuth handshake in a headless `claude -p` run, so the
     *  session HANGS on boot and never processes its prompt. Verified live: the
     *  mentor autonomous-fix loop session stalled ~4.5 min at 0.1% CPU on MCP
     *  init; with this flag a headless spawn boots in ~9s. No effect on Codex
     *  spawns (Codex MCP wiring is separate). */
    disableProjectMcp?: boolean;
    /** Threadline A2A continuity (claude-code HEADLESS only): when set, the
     *  headless `claude -p` spawn is launched with `--session-id <uuid>` so the
     *  transcript is created at a deterministic, caller-chosen id. The caller
     *  (ThreadlineRouter.spawnNewThread) stores this uuid as the thread's
     *  resume-map entry, so the next inbound message on the same thread can
     *  resume the exact conversation via `resumeSessionId`. Mutually exclusive
     *  with `resumeSessionId` (sessionId wins). No effect on non-claude
     *  frameworks or interactive spawns. */
    sessionId?: string;
    /** Threadline A2A continuity (claude-code HEADLESS only): when set, the
     *  headless `claude -p` spawn is launched with `--resume <uuid>` so it
     *  reloads the full prior transcript captured by an earlier `sessionId`
     *  spawn. This is what makes A2A follow-ups land in a warm session with
     *  full context instead of cold-spawning memoryless. Mutually exclusive
     *  with `sessionId` (sessionId wins when both are present). A stale uuid is
     *  covered by the existing resume-crash fallback. No effect on non-claude
     *  frameworks or interactive spawns. */
    resumeSessionId?: string;
  }): Promise<Session> {
    const runningSessions = this.listRunningSessions();
    if (runningSessions.length >= this.config.maxSessions) {
      throw new Error(
        `Max sessions (${this.config.maxSessions}) reached. ` +
        `Running: ${runningSessions.map(s => s.name).join(', ')}`
      );
    }

    const sessionId = this.generateId();
    const safeName = sanitizeSessionName(options.name);
    const tmuxSession = `${path.basename(this.config.projectDir)}-${safeName}`;

    // Check if tmux session already exists
    if (this.tmuxSessionExists(tmuxSession)) {
      throw new Error(`tmux session "${tmuxSession}" already exists`);
    }

    // ── PARALLEL-DEV-ISOLATION (PARALLEL-DEV-ISOLATION-SPEC.md AC-1) ──
    // If WorktreeManager is wired AND topicId provided, resolve a topic worktree
    // and use its cwd. Otherwise fall back to projectDir (legacy behavior).
    let resolvedCwd = this.config.projectDir;
    let workTreeFencingToken: string | null = null;
    let shimDir: string | null = null;
    if (this.worktreeManager && options.topicId !== undefined) {
      try {
        const resolved = await this.worktreeManager.resolve({
          topicId: options.topicId,
          mode: options.worktreeMode ?? 'dev',
          sessionId,
          pid: process.pid,
          processStartTime: Math.floor(Date.now() / 1000),
          slug: options.worktreeSlug ?? options.name,
        });
        resolvedCwd = resolved.cwd;
        workTreeFencingToken = resolved.fencingToken;

        // K9: install per-session shim dir and prepend to PATH so destructive-command
        // wrappers fire in the spawned shell (PARALLEL-DEV-ISOLATION-SPEC.md, "Phase D").
        if (this.shimRoot) {
          shimDir = path.join(this.shimRoot, sessionId);
          this.installSessionShim(shimDir, resolved.fencingToken);
        }
      } catch (err: any) {
        if (err && err.code === 'LOCK_HELD') {
          throw new Error(`Cannot spawn session for topic ${options.topicId}: lock held by ${JSON.stringify(err.holder)}`);
        }
        throw err;
      }
    }

    // Build the CLI argv via the framework-aware headless-launch helper
    // so Codex agents (and future frameworks) spawn correctly through
    // this same path. The helper returns argv (binary + flags + prompt)
    // and env overrides (CLAUDECODE clear, etc.) — caller merges the
    // env overrides into the tmux -e block alongside the universal
    // INSTAR_* / DATABASE_URL clears.
    //
    // Framework resolution: the per-call options.framework wins, falling
    // back to the agent's configured sessions.framework and then to the
    // INSTAR_FRAMEWORK env. Defaults to claude-code for back-compat.
    const headlessFramework = resolveInteractiveFramework({
      perCall: options.framework,
      // config.framework is the agent's resolved runtime framework
      // (derived at load from sessions.framework | enabledFrameworks[0]
      // | INSTAR_FRAMEWORK). Per-call wins, then config, then env.
      configFramework: this.config.framework,
      envFramework: frameworkFromEnv(),
    });
    const headlessBinaryPath =
      this.config.frameworkBinaryPaths?.[headlessFramework]
      ?? this.config.claudePath;

    // Codex rate-limit model-swap (dark by default): when the agent's main
    // codex model has exhausted its weekly window, launch on a configured
    // fallback model (separate quota bucket) instead of stalling. No-op +
    // zero disk I/O unless codex.rateLimitModelSwap is enabled. Best-effort.
    const launchModel = await this.resolveCodexLaunchModel(headlessFramework, options.model);

    // ── Headless-spawn reroute (june15-headless-spawn-reroute, PR2) ──
    // For claude-code ONLY, when subscriptionPath.mode is 'force' (or 'auto'
    // under SDK-pot pressure), reroute this `claude -p` one-shot onto the
    // interactive (subscription) lane so it stops billing the Agent SDK pot
    // after 2026-06-15. A control-flow fork, NOT a launch-spec swap (spec F3):
    // it delegates to the interactive delivery chain (ready-wait + inject) and
    // supplies its own completion sentinel + lifetime cap (the REPL never exits
    // on task success). Non-claude frameworks and 'off' fall straight through to
    // today's headless path, byte-for-byte.
    //
    // The cap + memory-pressure gate (spec O2/S1) is evaluated here: under
    // 'auto', an exceeded cap / elevated pressure DEGRADES to the headless lane
    // below (degradation-reported); under 'force' it REFUSES loudly (no headless
    // fallback — force guarantees zero `claude -p`). So this branch only commits
    // to the reroute when the gate passes; otherwise control falls through.
    if (await this.shouldRerouteToInteractive(headlessFramework)) {
      const gate = this.evaluateRerouteGate(options.name);
      if (gate.allow) {
        return await this.spawnReroutedInteractive({
          sessionId,
          tmuxSession,
          options,
          binaryPath: headlessBinaryPath,
          launchModel,
          resolvedCwd,
          workTreeFencingToken,
          shimDir,
        });
      }
      // gate refused — 'force' already threw inside evaluateRerouteGate; only
      // 'auto' reaches here, having degradation-reported. Fall through to the
      // headless build below.
    }

    const headlessSpec = buildHeadlessLaunch(headlessFramework, {
      binaryPath: headlessBinaryPath,
      prompt: options.prompt,
      model: launchModel,
      ...(options.codexLocalProvider ? { codexLocalProvider: options.codexLocalProvider } : {}),
      // Per-agent codex threadline MCP override (ignored by non-codex builders).
      // Ensures a headless codex worker — notably a Threadline inbound-reply
      // spawn — uses THIS agent's threadline MCP, not whichever agent last won
      // the shared ~/.codex/config.toml.
      ...(this.config.codexThreadlineMcp ? { codexThreadlineMcp: this.config.codexThreadlineMcp } : {}),
      // Reply spawns set this so the codex worker can call threadline_send;
      // jobs leave it unset and keep the workspace-write sandbox.
      ...(options.codexAllowMcpTools ? { codexAllowMcpTools: true } : {}),
    });

    // Extra claude-code headless flags, spliced before the `-p` prompt positional
    // (argv structure: [binary, --dangerously-skip-permissions, (--model X)?, -p,
    // prompt]). Currently Claude-only — Codex has no `--allowedTools`/MCP-config
    // CLI equivalent (it uses sandbox modes via the headless builder), so the
    // helper returns [] for Codex and the splice is skipped:
    //  - `--allowedTools <list>` — per-job tool-scope allowlist (INSTAR-JOBS-AS-
    //    AGENTMD §5).
    //  - `--strict-mcp-config --mcp-config {}` — no-project-MCP spawn for headless
    //    one-shot sessions that would otherwise hang on auth-required remote MCP
    //    boot (the mentor autonomous-fix loop). See claudeHeadlessExtraFlags.
    const extraClaudeFlags = claudeHeadlessExtraFlags({
      framework: headlessFramework,
      allowedTools: options.allowedTools,
      disableProjectMcp: options.disableProjectMcp,
    });
    if (extraClaudeFlags.length > 0) {
      const dashPIndex = headlessSpec.argv.indexOf('-p');
      if (dashPIndex > 0) {
        headlessSpec.argv.splice(dashPIndex, 0, ...extraClaudeFlags);
      }
    }

    // Threadline A2A continuity (claude-code HEADLESS only): set/resume the
    // conversation id so follow-up messages on the same thread land in a warm
    // session with the full prior transcript instead of cold-spawning.
    // Spliced before the `-p` positional, mirroring extraClaudeFlags exactly.
    // Mutually exclusive: `sessionId` (--session-id) wins over `resumeSessionId`
    // (--resume). Only emitted for claude-code and only when provided, so every
    // existing spawn (jobs, topic sessions, codex) is byte-for-byte unaffected.
    if (headlessFramework === 'claude-code') {
      const continuityFlags: string[] = options.sessionId
        ? ['--session-id', options.sessionId]
        : options.resumeSessionId
          ? ['--resume', options.resumeSessionId]
          : [];
      if (continuityFlags.length > 0) {
        const dashPIndex = headlessSpec.argv.indexOf('-p');
        if (dashPIndex > 0) {
          headlessSpec.argv.splice(dashPIndex, 0, ...continuityFlags);
        }
      }
    }

    // K9: build PATH env with shim prepended (when shim was installed)
    const inheritedPath = process.env.PATH ?? '';
    const shimmedPath = shimDir ? `${shimDir}:${inheritedPath}` : inheritedPath;

    // Merge the framework-specific env overrides into the tmux -e block.
    // Anthropic-only env vars (CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY,
    // ANTHROPIC_BASE_URL) only apply when the framework is claude-code;
    // for Codex, the env-allowlist enforcement happens inside Codex CLI's
    // process tree via Spec 12 Rule 1a, not via tmux -e flags (which
    // would be unscrubbed parent inheritance).
    // Subscription-pool pinning (Subscription & Auth Standard): launch this
    // claude-code session under a chosen pool account's config home and tag it,
    // so auto-swap can move it when that account walls. No-op unless the resolver
    // is wired (pinSessionsToPool enabled) and returns an account.
    const pinnedAccount = headlessFramework === 'claude-code'
      ? (this.spawnAccountResolver?.() ?? null)
      : null;
    if (pinnedAccount) {
      // Census #6: pin to the account's CURRENT slot per the ledger gate, not its enrollment home.
      const pinnedHome = this.resolvePinnedSpawnHome(pinnedAccount);
      headlessSpec.envOverrides.CLAUDE_CONFIG_DIR = pinnedHome;
      this.ensurePinnedHomeInteractiveReady(pinnedHome, 'headless pin');
    }
    const frameworkEnvFlags: string[] = [];
    for (const [k, v] of Object.entries(headlessSpec.envOverrides)) {
      frameworkEnvFlags.push('-e', `${k}=${v}`);
    }
    const anthropicEnvFlags: string[] = headlessFramework === 'claude-code'
      ? [
          ...((this.config.anthropicApiKey ?? '').startsWith('sk-ant-oat')
            ? ['-e', `CLAUDE_CODE_OAUTH_TOKEN=${this.config.anthropicApiKey}`, '-e', 'ANTHROPIC_API_KEY=']
            : ['-e', `ANTHROPIC_API_KEY=${this.config.anthropicApiKey ?? ''}`, '-e', 'CLAUDE_CODE_OAUTH_TOKEN=']),
          '-e', `ANTHROPIC_BASE_URL=${this.config.anthropicBaseUrl ?? ''}`,
        ]
      : [];
    // §2.10 provenance — SINGLE SOURCE OF TRUTH: the SAME `(anthropicApiKey ?? '') !== ''`
    // predicate that selects the Anthropic env block above. Non-empty ⇒ this session launches
    // with an env token (store-bypassing) ⇒ 'env'; empty ⇒ it reads the per-CLAUDE_CONFIG_DIR
    // store ⇒ 'store'. Only meaningful for the claude-code env-block lane (undefined otherwise).
    const headlessCredentialSource: 'store' | 'env' | undefined =
      headlessFramework === 'claude-code'
        ? ((this.config.anthropicApiKey ?? '') !== '' ? 'env' : 'store')
        : undefined;

    try {
      // §B in-flight marker: this spawn is EXCLUDED from §A async conversion
      // (its synchronous timing is part of the spawn contract) but still funnels
      // through withSyncOp so a drift during the blocking spawn is classed as an
      // event-loop BLOCK, not sleep.
      withSyncOp(() => execFileSync(this.config.tmuxPath, [
        'new-session', '-d',
        '-s', tmuxSession,
        '-c', resolvedCwd,
        ...frameworkEnvFlags,
        // Opt-in: raise Claude Code's own retry count so it rides out transient
        // throttle/overload longer before surfacing to the RateLimitSentinel.
        ...(this.config.claudeCodeMaxRetries != null
          ? ['-e', `CLAUDE_CODE_MAX_RETRIES=${this.config.claudeCodeMaxRetries}`]
          : []),
        '-e', `INSTAR_SESSION_ID=${sessionId}`, // Expose instar session ID to hook events
        '-e', `INSTAR_SESSION_NAME=${tmuxSession}`, // Threadline binding: attributes a relay-send to its origin session
        '-e', `INSTAR_SERVER_URL=http://localhost:${this.config.port}`,
        '-e', `INSTAR_AUTH_TOKEN=${this.config.authToken}`,
        '-e', `INSTAR_AGENT_ID=${this.config.projectName}`,
        // durable-conversation-identity §7: per-session bind token scoping
        // durable-state opens to this spawn's bootstrap conversation set.
        ...this.bindTokenEnvFlags(
          tmuxSession,
          options.bootstrapConversationIds ??
            (typeof options.topicId === 'number' ? [options.topicId] : []),
        ),
        // Structural message-kind stamping (outbound-jargon-filepath-gap §2.1):
        // a job-spawned session is marked 'automated' in its ENVIRONMENT, so
        // telegram-reply.sh forwards the kind regardless of what the model
        // does. Interactive (jobSlug-less) spawns get NONE of these → 'reply'.
        ...(options.jobSlug
          ? [
              '-e', 'INSTAR_MESSAGE_KIND=automated',
              '-e', `INSTAR_JOB_SLUG=${options.jobSlug}`,
              '-e', 'INSTAR_SENDER_CLASS=llm-session',
              // Test-runner bound (test-runner-concurrency-bound §2.6): a
              // server-launched job session is BACKGROUND class — test suites
              // it runs get the short fail-loud acquire budget, never the long
              // interactive one. Derived from the launch site, never from
              // user input. Interactive (jobSlug-less) spawns get NONE.
              '-e', 'INSTAR_HOST_TEST_RUN_CLASS=background',
            ]
          : []),
        ...this.ghTokenEnvFlags(), // P3b: per-agent vault GitHub token (empty when no vault token)
        ...(workTreeFencingToken ? ['-e', `INSTAR_FENCING_TOKEN=${workTreeFencingToken}`] : []),
        ...(workTreeFencingToken ? ['-e', `INSTAR_WORKTREE_PATH=${resolvedCwd}`] : []),
        ...(shimDir ? ['-e', `PATH=${shimmedPath}`, '-e', `BASH_ENV=${path.join(shimDir, '.shellrc')}`] : []),
        ...anthropicEnvFlags,
        // Isolate database credentials — spawned sessions must never inherit production
        // database URLs from the parent shell. This prevents accidental schema changes
        // or data operations against the wrong database. (Learned from Portal incident 2026-02-22)
        '-e', 'DATABASE_URL=',
        '-e', 'DIRECT_DATABASE_URL=',
        '-e', 'DATABASE_URL_PROD=',
        '-e', 'DATABASE_URL_DEV=',
        '-e', 'DATABASE_URL_TEST=',
        ...headlessSpec.argv,
      ], { encoding: 'utf-8' }));

      // Increase tmux scrollback buffer for dashboard history support
      try {
        withSyncOp(() => execFileSync(this.config.tmuxPath, [
          'set-option', '-t', `=${tmuxSession}:`, 'history-limit', '50000',
        ], { encoding: 'utf-8', timeout: 5000 }));
      } catch {
        // @silent-fallback-ok — history-limit is a nice-to-have
      }
    } catch (err) {
      throw new Error(`Failed to create tmux session: ${err}`);
    }

    const session: Session = {
      id: sessionId,
      name: options.name,
      status: 'running',
      jobSlug: options.jobSlug,
      tmuxSession,
      startedAt: new Date().toISOString(),
      triggeredBy: options.triggeredBy,
      // Record the framework-RESOLVED model, not the raw tier alias. A Codex
      // agent's session must show its real gpt-5.x model on the dashboard, not
      // the Claude tier nickname (haiku/sonnet) the caller passed. Falls back
      // to the raw value when no mapping applies. + carry the framework so the
      // dashboard can render engine-aware.
      model: resolveModelForFramework(headlessFramework, options.model) ?? options.model,
      framework: headlessFramework,
      prompt: options.prompt,
      maxDurationMinutes: options.maxDurationMinutes,
      // Subscription-pool pinning: tag the session with the account it launched
      // under, so auto-swap can move it when that account hits a quota wall.
      ...(pinnedAccount ? { subscriptionAccountId: pinnedAccount.accountId } : {}),
      // §2.10 credential provenance — derived from the SAME predicate as the env block.
      ...(headlessCredentialSource ? { credentialSource: headlessCredentialSource } : {}),
      // Positive-lane observability (june15-headless-spawn-reroute O4): always
      // populated now, so the soak's "zero headless under force" criterion is
      // machine-checkable from GET /sessions. completionMode stays 'exit' (the
      // headless one-shot signals completion by process exit — today's behavior).
      launchLane: 'headless',
      completionMode: 'exit',
    };

    this.state.saveSession(session);
    return session;
  }

  /**
   * Pre-spawn cap + memory-pressure gate for the reroute (june15-headless-spawn-
   * reroute PR2, findings O2/S1). Decides whether a rerouted-interactive spawn
   * may proceed:
   *  - cap reached (>= subscriptionPath.maxRerouted) OR host memory pressure
   *    elevated ('high'/'critical') → REFUSE.
   *  - under 'force': a refusal THROWS loudly (force guarantees zero `claude -p`,
   *    so there is no headless fallback) — and degradation-reports first.
   *  - under 'auto': a refusal returns `{ allow: false }` after degradation-
   *    reporting, so spawnSession falls through to the headless lane (the SDK
   *    pot still works; the host stays healthy).
   * Returns `{ allow: true }` when the reroute may proceed.
   */
  private evaluateRerouteGate(spawnName: string): { allow: boolean } {
    const mode = this.config.subscriptionPathMode ?? 'off';
    const maxRerouted = this.config.subscriptionMaxRerouted ?? 3;
    const reroutedCount = this.countReroutedInteractiveSessions();
    const pressure = this.currentMemoryPressure();
    const pressureElevated = pressure === 'high' || pressure === 'critical';
    if (reroutedCount < maxRerouted && !pressureElevated) {
      return { allow: true };
    }
    const why = reroutedCount >= maxRerouted
      ? `rerouted-session cap reached (${reroutedCount}/${maxRerouted})`
      : `host memory pressure is ${pressure}`;
    if (mode === 'force') {
      // Loud refusal — force-mode has no headless fallback. Report AND throw.
      DegradationReporter.getInstance().report({
        feature: 'SessionManager.spawnReroutedInteractive',
        primary: 'reroute claude-code one-shot onto the interactive subscription lane',
        fallback: 'spawn REFUSED (force-mode has no headless fallback)',
        reason: `Cannot reroute: ${why}`,
        impact: `Job/A2A spawn "${spawnName}" refused under force-mode to protect the host; it will retry on its next trigger`,
      });
      throw new Error(`Reroute refused (force-mode): ${why}`);
    }
    // 'auto' — degrade to the headless lane (host stays healthy). Caller falls
    // through to the headless build.
    DegradationReporter.getInstance().report({
      feature: 'SessionManager.spawnReroutedInteractive',
      primary: 'reroute claude-code one-shot onto the interactive subscription lane',
      fallback: 'fell back to the headless (claude -p) lane',
      reason: `Cannot reroute: ${why}`,
      impact: `Job/A2A spawn "${spawnName}" ran headless this time to avoid host pressure`,
    });
    this.recordRerouteFallback(why);
    return { allow: false };
  }

  /**
   * F6 recurrence cap (spec "Structural guards" + Distrust Temporary
   * Success): the auto-mode headless fallback is self-healing — a reroute
   * that's BROKEN (cap stuck, pressure stuck high, continuity gap) would
   * silently fall back on EVERY spawn and look fine forever while the entire
   * June-15 reroute is dead. Count fallbacks in a rolling window; past the
   * cap, raise ONE escalated degradation event per window saying "dead, not
   * transiently degraded".
   */
  private rerouteFallbackTimes: number[] = [];
  private rerouteFallbackEscalatedAt = 0;
  private recordRerouteFallback(why: string): void {
    const WINDOW_MS = 30 * 60_000;
    const CAP = 5;
    const now = Date.now();
    this.rerouteFallbackTimes = this.rerouteFallbackTimes.filter((t) => now - t < WINDOW_MS);
    this.rerouteFallbackTimes.push(now);
    if (
      this.rerouteFallbackTimes.length > CAP &&
      now - this.rerouteFallbackEscalatedAt >= WINDOW_MS
    ) {
      this.rerouteFallbackEscalatedAt = now;
      DegradationReporter.getInstance().report({
        feature: 'SessionManager.rerouteFallbackRecurrence',
        primary: 'subscription-path reroute serving job/A2A spawns (mode auto)',
        fallback: `headless fallback recurred ${this.rerouteFallbackTimes.length}× in 30min — the reroute is effectively DEAD, not transiently degraded`,
        reason: `latest: ${why}`,
        impact: 'Every job/A2A spawn is back on the SDK-pot claude -p lane; post-June-15 this drains the pot with no reroute. Investigate the cap/pressure/continuity cause.',
      });
    }
  }

  /**
   * Spawn a claude-code job/A2A one-shot rerouted onto the interactive
   * (subscription) lane (june15-headless-spawn-reroute, PR2 "The core switch").
   *
   * This is the control-flow fork from spawnSession's headless branch. It:
   *  - builds an INTERACTIVE claude launch (no `-p`; the REPL opens and waits)
   *    via buildInteractiveLaunch, carrying the resolved model + the A2A
   *    `--session-id`/`--resume` continuity flag through unchanged;
   *  - splices the SAME `claudeHeadlessExtraFlags` (--allowedTools,
   *    --strict-mcp-config --mcp-config {}) the headless path uses — both are
   *    valid INTERACTIVE flags and the gate is framework-only, so the load-
   *    bearing no-project-MCP boot (avoids the ~4.5-min OAuth-remote-MCP hang)
   *    is preserved (spec F4/S3);
   *  - creates the tmux session with the same env isolation as the headless
   *    block PLUS `-x 200 -y 50` (prompt detection is tuned for the wide pane,
   *    spec F6);
   *  - enforces the memory-pressure + concurrency cap gate BEFORE rerouting
   *    (spec O2/S1): under 'auto', exceeding either falls back to the headless
   *    lane (degradation-reported); under 'force' the spawn is refused loudly;
   *  - appends a deterministic completion sentinel to the prompt and stamps the
   *    session with completionMode='pattern' + the per-session pattern + a hard
   *    maxLifetimeMinutes, so the monitor loop can reap a never-exiting REPL on
   *    sentinel-match or lifetime-expiry (spec O1, "the crux");
   *  - fires the ready-wait + inject ASYNCHRONOUSLY (does NOT block the return —
   *    callers expect the Session back promptly), reusing the same
   *    waitForClaudeReadyWithRetry + injectMessage machinery handleReadyAndInject
   *    uses.
   */
  private async spawnReroutedInteractive(args: {
    sessionId: string;
    tmuxSession: string;
    options: Parameters<SessionManager['spawnSession']>[0];
    binaryPath: string;
    launchModel: string | undefined;
    resolvedCwd: string;
    workTreeFencingToken: string | null;
    shimDir: string | null;
  }): Promise<Session> {
    const { sessionId, tmuxSession, options, binaryPath, launchModel, resolvedCwd, workTreeFencingToken, shimDir } = args;
    const lifetimeMinutes = this.config.subscriptionReroutedLifetimeMinutes ?? 45;

    // ── Completion sentinel (spec O1, "the crux") ──
    // An interactive REPL never exits on task success, and the default
    // completionPatterns are session-DEATH phrases. So we instruct the model to
    // print a deterministic, per-session sentinel as its FINAL line, and teach
    // the monitor loop to reap on that (completionMode='pattern'). The sentinel
    // is keyed on the session id suffix so two concurrent rerouted sessions
    // can't false-trigger each other.
    const sentinel = `INSTAR_JOB_COMPLETE_${sessionId.slice(-8)}`;
    const promptWithSentinel = `${options.prompt}\n\nWhen you have fully completed this task, print exactly this marker as your final line: ${sentinel}`;

    // ── Build the INTERACTIVE launch (no `-p`) ──
    // Carry the resolved model + the A2A continuity flag through. sessionId
    // (--session-id) pins the transcript at the caller-chosen uuid so A2A
    // `--resume` keeps working (spec "A2A cold spawns"); resumeSessionId
    // (--resume) reloads a prior transcript. Mirrors the headless precedence
    // (sessionId wins).
    const launchSpec = buildInteractiveLaunch('claude-code', {
      binaryPath,
      ...(launchModel ? { defaultModel: launchModel } : {}),
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(!options.sessionId && options.resumeSessionId ? { resumeSessionId: options.resumeSessionId } : {}),
    });

    // Splice the load-bearing headless flags into the INTERACTIVE argv. Both
    // --allowedTools and --strict-mcp-config --mcp-config {} are valid
    // interactive flags; claudeHeadlessExtraFlags is gated only on
    // framework==='claude-code', so the reroute calls it and appends to the end
    // of the argv (the interactive argv has no `-p` positional to splice before).
    // Without --strict-mcp-config, an MCP-restricted rerouted job re-introduces
    // the documented ~4.5-min OAuth-remote-MCP boot hang (spec F4/S3).
    const extraClaudeFlags = claudeHeadlessExtraFlags({
      framework: 'claude-code',
      allowedTools: options.allowedTools,
      disableProjectMcp: options.disableProjectMcp,
    });
    if (extraClaudeFlags.length > 0) {
      launchSpec.argv.push(...extraClaudeFlags);
    }

    // K9: build PATH env with shim prepended (when shim was installed) — same as
    // the headless block.
    const inheritedPath = process.env.PATH ?? '';
    const shimmedPath = shimDir ? `${shimDir}:${inheritedPath}` : inheritedPath;

    // Subscription-pool pinning (Subscription & Auth Standard): this lane is
    // always claude-code, so launch under the chosen pool account's config home
    // and tag the session. No-op unless the resolver is wired + returns an account.
    const pinnedAccount = this.spawnAccountResolver?.() ?? null;
    if (pinnedAccount) {
      // Census #6: pin to the account's CURRENT slot per the ledger gate, not its enrollment home.
      const pinnedHome = this.resolvePinnedSpawnHome(pinnedAccount);
      launchSpec.envOverrides.CLAUDE_CONFIG_DIR = pinnedHome;
      this.ensurePinnedHomeInteractiveReady(pinnedHome, 'interactive-reroute pin');
    }
    const frameworkEnvFlags: string[] = [];
    for (const [k, v] of Object.entries(launchSpec.envOverrides)) {
      frameworkEnvFlags.push('-e', `${k}=${v}`);
    }
    // Anthropic-only env (claude-code reroute is always claude-code).
    const anthropicEnvFlags: string[] =
      (this.config.anthropicApiKey ?? '').startsWith('sk-ant-oat')
        ? ['-e', `CLAUDE_CODE_OAUTH_TOKEN=${this.config.anthropicApiKey}`, '-e', 'ANTHROPIC_API_KEY=']
        : ['-e', `ANTHROPIC_API_KEY=${this.config.anthropicApiKey ?? ''}`, '-e', 'CLAUDE_CODE_OAUTH_TOKEN='];
    anthropicEnvFlags.push('-e', `ANTHROPIC_BASE_URL=${this.config.anthropicBaseUrl ?? ''}`);
    // §2.10 provenance — SINGLE SOURCE OF TRUTH: the SAME `(anthropicApiKey ?? '') !== ''`
    // predicate as the env block above (this lane is always claude-code → always set).
    const reroutedCredentialSource: 'store' | 'env' =
      (this.config.anthropicApiKey ?? '') !== '' ? 'env' : 'store';

    try {
      // §B: excluded from §A async conversion (spawn timing is contractual) but
      // funnels through withSyncOp so a drift during this blocking spawn reads as
      // an event-loop BLOCK, not sleep.
      withSyncOp(() => execFileSync(this.config.tmuxPath, [
        'new-session', '-d',
        '-s', tmuxSession,
        '-c', resolvedCwd,
        // Wide pane — detectClaudePrompt reads the last lines for the ❯/status
        // markers and is tuned for the interactive default (spec F6). The 80×24
        // headless default makes ready/idle detection flaky.
        '-x', '200', '-y', '50',
        ...frameworkEnvFlags,
        ...(this.config.claudeCodeMaxRetries != null
          ? ['-e', `CLAUDE_CODE_MAX_RETRIES=${this.config.claudeCodeMaxRetries}`]
          : []),
        '-e', `INSTAR_SESSION_ID=${sessionId}`,
        '-e', `INSTAR_SESSION_NAME=${tmuxSession}`,
        '-e', `INSTAR_SERVER_URL=http://localhost:${this.config.port}`,
        '-e', `INSTAR_AUTH_TOKEN=${this.config.authToken}`,
        '-e', `INSTAR_AGENT_ID=${this.config.projectName}`,
        // Structural message-kind stamping (outbound-jargon-filepath-gap §2.1).
        // This rerouted-interactive lane is the path the June-15 subscription
        // lever routes JOB spawns through — omitting it here would leave a
        // structural hole for exactly those job sessions.
        ...(options.jobSlug
          ? [
              '-e', 'INSTAR_MESSAGE_KIND=automated',
              '-e', `INSTAR_JOB_SLUG=${options.jobSlug}`,
              '-e', 'INSTAR_SENDER_CLASS=llm-session',
              // Test-runner bound (test-runner-concurrency-bound §2.6): a
              // server-launched job session is BACKGROUND class — test suites
              // it runs get the short fail-loud acquire budget, never the long
              // interactive one. Derived from the launch site, never from
              // user input. Interactive (jobSlug-less) spawns get NONE.
              '-e', 'INSTAR_HOST_TEST_RUN_CLASS=background',
            ]
          : []),
        ...this.ghTokenEnvFlags(), // P3b: per-agent vault GitHub token (empty when no vault token)
        ...(workTreeFencingToken ? ['-e', `INSTAR_FENCING_TOKEN=${workTreeFencingToken}`] : []),
        ...(workTreeFencingToken ? ['-e', `INSTAR_WORKTREE_PATH=${resolvedCwd}`] : []),
        ...(shimDir ? ['-e', `PATH=${shimmedPath}`, '-e', `BASH_ENV=${path.join(shimDir, '.shellrc')}`] : []),
        ...anthropicEnvFlags,
        // Same DB-credential isolation as every other spawn (Portal 2026-02-22).
        '-e', 'DATABASE_URL=',
        '-e', 'DIRECT_DATABASE_URL=',
        '-e', 'DATABASE_URL_PROD=',
        '-e', 'DATABASE_URL_DEV=',
        '-e', 'DATABASE_URL_TEST=',
        ...launchSpec.argv,
      ], { encoding: 'utf-8' }));

      try {
        withSyncOp(() => execFileSync(this.config.tmuxPath, [
          'set-option', '-t', `=${tmuxSession}:`, 'history-limit', '50000',
        ], { encoding: 'utf-8', timeout: 5000 }));
      } catch {
        // @silent-fallback-ok — history-limit is a nice-to-have
      }
    } catch (err) {
      throw new Error(`Failed to create rerouted interactive tmux session: ${err}`);
    }

    const session: Session = {
      id: sessionId,
      name: options.name,
      status: 'running',
      jobSlug: options.jobSlug,
      tmuxSession,
      startedAt: new Date().toISOString(),
      triggeredBy: options.triggeredBy,
      model: resolveModelForFramework('claude-code', launchModel) ?? launchModel,
      framework: 'claude-code',
      prompt: options.prompt,
      maxDurationMinutes: options.maxDurationMinutes,
      // Subscription-pool pinning: tag with the account this launched under, so
      // auto-swap can move it when that account hits a quota wall.
      ...(pinnedAccount ? { subscriptionAccountId: pinnedAccount.accountId } : {}),
      // §2.10 credential provenance — derived from the SAME predicate as the env block.
      credentialSource: reroutedCredentialSource,
      // The reroute's completion contract (spec O1 + O4):
      launchLane: 'rerouted-interactive',
      completionMode: 'pattern',
      completionPatterns: [sentinel],
      maxLifetimeMinutes: lifetimeMinutes,
    };
    this.state.saveSession(session);

    // Deliver the prompt asynchronously — do NOT block spawnSession's return on
    // readiness (callers expect the Session back promptly; the ready-gate is
    // ~90s worst-case). Reuses the EXISTING ready-wait + inject machinery.
    const readyTimeout = options.resumeSessionId ? 120_000 : 90_000;
    this.injectAfterReady(tmuxSession, promptWithSentinel, readyTimeout).catch((err) => {
      // @silent-fallback-ok — fire-and-forget error log for the background
      // ready-wait+inject (mirrors handleReadyAndInject's .catch). injectAfterReady
      // already DegradationReporter-reports a genuine delivery failure internally;
      // this guards only against an unexpected rejection escaping the detached promise.
      console.error(`[SessionManager] Error during rerouted ready-and-inject for "${tmuxSession}": ${err}`);
    });

    return session;
  }

  /**
   * Wait for Claude to be ready, then inject a prompt — the minimal ready-wait
   * + inject path shared by the rerouted-interactive spawn
   * (june15-headless-spawn-reroute). Factored from handleReadyAndInject's shape;
   * deliberately WITHOUT the resume-fresh-spawn fallback (a rerouted job's
   * delivery is best-effort — the monitor loop's lifetime cap bounds a dead
   * REPL, and the job reruns cleanly on its next trigger).
   */
  private async injectAfterReady(tmuxSession: string, prompt: string, readyTimeout: number): Promise<void> {
    const ready = await this.waitForClaudeReadyWithRetry(tmuxSession, readyTimeout);
    if (ready) {
      await new Promise((r) => setTimeout(r, 1000));
      this.injectMessage(tmuxSession, prompt);
      return;
    }
    // Not ready in time. If tmux is still alive, best-effort inject anyway
    // (prompt-detection false negative). If it's gone, the spawn crashed during
    // startup — surface a degradation; the monitor loop will not see a sentinel
    // and the lifetime cap will reap the record.
    if (this.tmuxSessionExists(tmuxSession)) {
      this.injectMessage(tmuxSession, prompt);
      return;
    }
    DegradationReporter.getInstance().report({
      feature: 'SessionManager.injectAfterReady',
      primary: 'wait for rerouted interactive Claude ready, inject prompt',
      fallback: 'tmux died during startup; prompt not delivered',
      reason: 'rerouted spawn crashed during startup; readiness probe could not verify prompt',
      impact: 'Rerouted job prompt dropped; the job reruns on its next trigger',
    });
  }

  /**
   * Check if a session is still running by checking tmux AND verifying
   * that the Claude process is running inside (not a zombie tmux pane).
   */
  isSessionAlive(tmuxSession: string): boolean {
    if (!this.tmuxSessionExists(tmuxSession)) return false;

    // Verify Claude process is running inside the tmux session
    try {
      const paneInfo = withSyncOp(() => execFileSync(
        this.config.tmuxPath,
        ['display-message', '-t', `=${tmuxSession}:`, '-p', '#{pane_current_command}||#{pane_start_command}'],
        { encoding: 'utf-8', timeout: 5000 }
      )).trim();
      const [paneCmd, startCmd] = paneInfo.split('||');
      // Claude Code runs as 'claude' or 'node' process
      if (paneCmd && (paneCmd.includes('claude') || paneCmd.includes('node'))) {
        return true;
      }
      // If pane command is bash/zsh/sh, check whether the session was launched
      // with a direct command (e.g., a bash script as claudePath). In that case
      // bash IS the expected running process — not a leftover shell after Claude exits.
      // tmux kills sessions launched with direct commands when the command exits,
      // so if has-session succeeds and start_command is non-empty, it's still running.
      if (paneCmd === 'bash' || paneCmd === 'zsh' || paneCmd === 'sh') {
        if (startCmd && startCmd !== paneCmd) {
          // Session was launched with a specific command (not a bare shell) — still alive
          return true;
        }
        return false;
      }
      // For any other command, assume alive (could be a Claude subprocess)
      return true;
    } catch {
      // @silent-fallback-ok — pane inspection, assumes alive
      return true;
    }
  }

  /**
   * Pure classification of a `pane_current_command||pane_start_command` reading
   * into alive/dead — shared by the SYNC `isSessionAlive`, the legacy async
   * body, and the tri-state async body so the bare-shell/claude/node logic can
   * NEVER drift across the three callers. Returns the same verdicts as the
   * original inline code, including the bare-shell log line.
   */
  private classifyPaneCommand(tmuxSession: string, paneInfo: string): boolean {
    const [paneCmd, startCmd] = paneInfo.split('||');
    if (paneCmd && (paneCmd.includes('claude') || paneCmd.includes('node'))) {
      return true;
    }
    if (paneCmd === 'bash' || paneCmd === 'zsh' || paneCmd === 'sh') {
      if (startCmd && startCmd !== paneCmd) {
        return true;
      }
      console.log(`[SessionManager] Session "${tmuxSession}" has bare shell (${paneCmd}) — marking dead. start_command: ${startCmd}`);
      return false;
    }
    // Unknown command — log it and assume alive
    if (paneCmd) {
      console.log(`[SessionManager] Session "${tmuxSession}" has unknown pane command: "${paneCmd}" — assuming alive`);
    }
    return true;
  }

  /**
   * Check if a session is still running by checking tmux AND verifying
   * that the Claude process is running inside (async version).
   * Used by the monitoring loop to avoid blocking the event loop.
   *
   * Previously only checked `tmux has-session` which missed zombie sessions
   * where tmux was alive but Claude had exited — causing stuck sessions
   * that blocked the scheduler for hours.
   *
   * (A) tmux-event-loop-resilience: when `tmuxAsyncEnabled`, this returns a
   * TRI-STATE — `boolean | 'indeterminate'` — through the bounded, SIGKILL-
   * capped wrapper. A slow/timed-out `has-session` resolves to `'indeterminate'`
   * (the caller must NOT reap), NEVER to `false` ("dead"). This closes the
   * latent spurious-reap bug where a busy tmux's timeout was mapped to `false`
   * → marked-completed → killed a live session. When OFF, the legacy body runs
   * byte-for-byte (including the false-on-timeout reap).
   */
  private async isSessionAliveAsync(tmuxSession: string): Promise<boolean | 'indeterminate'> {
    if (!this.tmuxAsyncEnabled) {
      // ── Legacy body, byte-for-byte (today's false-on-timeout behavior). ──
      try {
        await execFileAsync(this.config.tmuxPath, ['has-session', '-t', `=${tmuxSession}`], {
          timeout: 5000,
        });
      } catch {
        // tmux session doesn't exist — it's dead
        return false;
      }
      try {
        const { stdout } = await execFileAsync(
          this.config.tmuxPath,
          ['display-message', '-t', `=${tmuxSession}:`, '-p', '#{pane_current_command}||#{pane_start_command}'],
          { timeout: 5000 }
        );
        return this.classifyPaneCommand(tmuxSession, stdout.trim());
      } catch {
        // @silent-fallback-ok: legacy off-path body, byte-for-byte. An unprobeable
        // display-message (the session exists but the pane read failed/timed out) ⇒ assume
        // ALIVE — the safe direction (never spuriously reap a live session over a probe blip).
        return true;
      }
    }

    // ── (A) tri-state path. ──
    const has = await this.tmuxExecCoalesced('has-session', tmuxSession, [
      'has-session',
      '-t',
      `=${tmuxSession}`,
    ]);
    if (has.state === 'definitely-absent') return false; // genuinely dead
    if (has.state === 'indeterminate') return 'indeterminate'; // slow tmux ⇒ NEVER 'dead'

    // Verify Claude process is alive inside (matches sync isSessionAlive logic).
    const disp = await this.tmuxExecCoalesced('display-message', tmuxSession, [
      'display-message',
      '-t',
      `=${tmuxSession}:`,
      '-p',
      '#{pane_current_command}||#{pane_start_command}',
    ]);
    if (disp.state !== 'success') return true; // unprobeable ⇒ assume alive (preserves the legacy catch)
    return this.classifyPaneCommand(tmuxSession, disp.stdout.trim());
  }

  /**
   * Kill a session by terminating its tmux session.
   */
  killSession(sessionId: string): boolean {
    const session = this.state.getSession(sessionId);
    if (!session) return false;

    // Don't kill protected sessions
    if (this.config.protectedSessions.includes(session.tmuxSession)) {
      throw new Error(`Cannot kill protected session: ${session.tmuxSession}`);
    }

    // Share the in-flight guard so an explicit kill can't double with an
    // in-flight terminateSession() from the idle-kill / reaper path (§3.6).
    // NB: unlike terminateSession we do NOT early-return on terminal status —
    // killSession's contract is to destroy the pane unconditionally (a caller
    // may kill a session whose status already drifted while its pane lives).
    if (this.terminating.has(sessionId)) return false;
    this.terminating.add(sessionId);
    try {
      // Emit beforeSessionKill BEFORE destroying the tmux session so
      // listeners (e.g. TopicResumeMap) can discover the Claude UUID
      // while the session is still alive.
      this.emit('beforeSessionKill', session);

      try {
        // §B: kill is EXCLUDED from §A async conversion but funnels through
        // withSyncOp so a drift during the blocking kill reads as a block, not sleep.
        withSyncOp(() => execFileSync(this.config.tmuxPath, ['kill-session', '-t', `=${session.tmuxSession}`], {
          encoding: 'utf-8',
        }));
      } catch {
        // Session might already be dead
      }

      session.status = 'killed';
      session.endedAt = new Date().toISOString();
      session.endedReason = 'manual-kill';
      this.state.saveSession(session);
      // NB: killSession historically does NOT emit 'sessionComplete' (only
      // beforeSessionKill). Preserved to avoid changing listener semantics —
      // the CAS guard + endedReason are the only additions here.
      this.idlePromptSince.delete(session.id);
      this.idleKillBackoff?.clear(session.id); // session gone → drop veto-backoff state (map-leak eviction)
      this.reapingSessions.delete(session.id);
      // G3 (MESH-SELF-HEAL-SPEC §3.3, FD7): "a topic→session binding exists IFF a
      // live session exists." killSession historically did NOT clear the binding,
      // so a killed session left a stale binding that a later inbound resumed (the
      // 2026-06-27 stale-binding respawn). Emit `sessionKilled` AFTER the pane is
      // destroyed so a server-side listener can clear the binding — but ONLY if it
      // still points to THIS exact session (a kill-to-restart that already
      // re-registered a new session name must NOT be cleared). Race-safe by design.
      this.emit('sessionKilled', session);
      return true;
    } finally {
      this.terminating.delete(sessionId);
    }
  }

  /**
   * Check if a tmux session has active (non-baseline) child processes.
   * Returns true if the session is doing real work — running tools, bash commands,
   * subagents, etc. Returns false if only baseline processes (MCP servers, caffeinate)
   * are running, meaning the session is truly idle.
   *
   * This is the ground truth for whether a session is active — it doesn't care about
   * terminal output patterns, topic bindings, or subagent trackers. If the process
   * tree shows work happening, the session is active. Period.
   */
  /**
   * Pure descendant-tree analysis — shared by the sync `hasActiveProcesses` and
   * its async twin so the parsing/tree-walk/baseline-filter logic can NEVER
   * drift between paths (Map 2 risk #5). Given the pane shell PID and raw
   * `ps -eo pid,ppid,command` output, returns whether any non-baseline,
   * non-Claude descendant process is running.
   */
  private computeHasActiveProcesses(panePid: string, psOutput: string): boolean {
    // Build a map of PID → { ppid, command }
    const processes = new Map<string, { ppid: string; command: string }>();
    for (const line of psOutput.split('\n').slice(1)) { // skip header
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (match) {
        processes.set(match[1], { ppid: match[2], command: match[3] });
      }
    }

    // Walk the tree: find all descendants of panePid
    const descendants: Array<{ pid: string; command: string }> = [];
    const queue = [panePid];
    while (queue.length > 0) {
      const parentPid = queue.shift()!;
      for (const [pid, info] of processes) {
        if (info.ppid === parentPid && pid !== panePid) {
          descendants.push({ pid, command: info.command });
          queue.push(pid);
        }
      }
    }

    // Filter out baseline processes
    const activeProcesses = descendants.filter(p => {
      return !BASELINE_PROCESS_PATTERNS.some(pattern => pattern.test(p.command));
    });

    // The Claude Code node process itself is always running — that's the main process.
    // We care about processes BEYOND Claude itself and its baseline children.
    // Claude's main process is the direct child of the pane PID.
    // Filter it out: it's typically `node` or `claude` running the main Claude binary.
    const nonClaude = activeProcesses.filter(p => {
      const proc = processes.get(p.pid);
      // Direct child of pane PID running claude/node is the main process
      if (proc?.ppid === panePid) {
        return !/\bclaude\b/.test(p.command) && !/\bnode\b.*\bclaude\b/.test(p.command);
      }
      return true;
    });

    return nonClaude.length > 0;
  }

  hasActiveProcesses(tmuxSession: string): boolean {
    try {
      // Get the tmux pane's shell PID
      const panePid = withSyncOp(() => execFileSync(
        this.config.tmuxPath,
        ['list-panes', '-t', `=${tmuxSession}:`, '-F', '#{pane_pid}'],
        { encoding: 'utf-8', timeout: 5000 }
      )).trim();

      if (!panePid || !/^\d+$/.test(panePid)) return false;

      // Get all descendant processes of the pane PID
      // Use ps to find all processes whose parent is in our tree
      const psOutput = withSyncOp(() => execFileSync(
        'ps', ['-eo', 'pid,ppid,command'],
        { encoding: 'utf-8', timeout: 5000 }
      ));

      return this.computeHasActiveProcesses(panePid, psOutput);
    } catch {
      // If we can't check processes, assume active (fail-safe: don't kill)
      return true;
    }
  }

  /**
   * Async twin of hasActiveProcesses (§A) — the tmux list-panes goes through the
   * bounded wrapper and the non-tmux `ps` fork runs on `execFileAsync` (so the
   * whole probe is off the event loop). The fail-safe is preserved EXACTLY: an
   * indeterminate list-panes, an unparseable pane PID, OR any failure resolves
   * to TRUE (assume active — never kill on an unprobeable process tree). The
   * pure tree-walk is the SAME `computeHasActiveProcesses` the sync path uses.
   */
  private async hasActiveProcessesAsync(tmuxSession: string): Promise<boolean> {
    try {
      const panes = await this.tmuxExecCoalesced('list-panes', tmuxSession, [
        'list-panes',
        '-t',
        `=${tmuxSession}:`,
        '-F',
        '#{pane_pid}',
      ]);
      // Indeterminate (slow/timed-out tmux) ⇒ fail-safe TRUE (don't kill). A
      // definitive-absent / parse failure of the pane PID is "no pane PID" ⇒
      // false, matching the sync version's `return false` on a bad PID.
      if (panes.state === 'indeterminate') return true;
      if (panes.state === 'definitely-absent') return false;
      const panePid = panes.stdout.trim();
      if (!panePid || !/^\d+$/.test(panePid)) return false;

      const { stdout: psOutput } = await execFileAsync('ps', ['-eo', 'pid,ppid,command'], {
        timeout: 5000,
        killSignal: 'SIGKILL',
      });

      return this.computeHasActiveProcesses(panePid, psOutput);
    } catch {
      // If we can't check processes, assume active (fail-safe: don't kill)
      return true;
    }
  }

  // ── (§A) hot-path dispatchers: monitorTick awaits these. When
  // `tmuxAsyncEnabled` they run the bounded async twins (off the event loop);
  // when OFF they call the EXACT sync method, so the off-path is byte-for-byte
  // today's behavior (the await on an already-resolved value is a microtask, no
  // semantic change). Kept tiny so the conversion at each monitorTick callsite
  // is a one-line substitution. ────────────────────────────────────────────
  private async captureOutputMaybeAsync(tmuxSession: string, lines?: number): Promise<string | null> {
    return this.tmuxAsyncEnabled
      ? this.captureOutputAsync(tmuxSession, lines)
      : this.captureOutput(tmuxSession, lines);
  }
  private async captureMeaningfulTailMaybeAsync(tmuxSession: string, lines: number): Promise<string | null> {
    return this.tmuxAsyncEnabled
      ? this.captureMeaningfulTailAsync(tmuxSession, lines)
      : this.captureMeaningfulTail(tmuxSession, lines);
  }
  private async hasActiveProcessesMaybeAsync(tmuxSession: string): Promise<boolean> {
    return this.tmuxAsyncEnabled
      ? this.hasActiveProcessesAsync(tmuxSession)
      : this.hasActiveProcesses(tmuxSession);
  }
  private async detectCompletionMaybeAsync(tmuxSession: string): Promise<boolean> {
    return this.tmuxAsyncEnabled
      ? this.detectCompletionAsync(tmuxSession)
      : this.detectCompletion(tmuxSession);
  }
  private async detectSessionCompletionMaybeAsync(session: Session): Promise<boolean> {
    return this.tmuxAsyncEnabled
      ? this.detectSessionCompletionAsync(session)
      : this.detectSessionCompletion(session);
  }
  private async recordBuildContextMaybeAsync(tmuxSession: string): Promise<void> {
    return this.tmuxAsyncEnabled
      ? this.recordBuildContextAsync(tmuxSession)
      : void this.recordBuildContext(tmuxSession);
  }
  private async sendKeyMaybeAsync(tmuxSession: string, key: string): Promise<boolean> {
    return this.tmuxAsyncEnabled
      ? this.sendKeyAsync(tmuxSession, key)
      : this.sendKey(tmuxSession, key);
  }

  /**
   * Accumulated CPU-seconds of a session's non-baseline descendant processes.
   *
   * Unlike `hasActiveProcesses` (which checks process EXISTENCE only), this reads
   * each descendant's accumulated CPU time. Comparing two samples across a window
   * reveals whether the process actually USED CPU in the interval — the signal
   * StaleSessionBackstop needs to tell a wedged-but-ALIVE session (0% CPU, e.g. a
   * hung `codex exec --json` job) from one genuinely working. A wedged codex job
   * keeps a live process (so `hasActiveProcesses` reads true and the stale-session
   * escalation never fires), but its CPU-seconds stay flat — which this exposes.
   *
   * Returns 0 on any failure; callers compare DELTAS, so a flat/zero reading just
   * reads as "no CPU progress" (the backstop's other signals + the operator-ask
   * escalation make that safe — it never auto-kills).
   */
  descendantCpuSeconds(tmuxSession: string): number {
    try {
      const panePid = withSyncOp(() => execFileSync(
        this.config.tmuxPath,
        ['list-panes', '-t', `=${tmuxSession}:`, '-F', '#{pane_pid}'],
        { encoding: 'utf-8', timeout: 5000 },
      )).trim();
      if (!panePid || !/^\d+$/.test(panePid)) return 0;

      const psOutput = withSyncOp(() => execFileSync(
        'ps', ['-eo', 'pid,ppid,time,command'],
        { encoding: 'utf-8', timeout: 5000 },
      ));
      const procs = new Map<string, { ppid: string; time: string; command: string }>();
      for (const line of psOutput.split('\n').slice(1)) {
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
        if (m) procs.set(m[1], { ppid: m[2], time: m[3], command: m[4] });
      }

      // Same descendant tree-walk as hasActiveProcesses.
      const descendants: Array<{ time: string; command: string }> = [];
      const queue = [panePid];
      while (queue.length > 0) {
        const parent = queue.shift()!;
        for (const [pid, info] of procs) {
          if (info.ppid === parent && pid !== panePid) {
            descendants.push({ time: info.time, command: info.command });
            queue.push(pid);
          }
        }
      }

      let total = 0;
      for (const p of descendants) {
        if (BASELINE_PROCESS_PATTERNS.some(pattern => pattern.test(p.command))) continue;
        total += parseProcTimeToSeconds(p.time);
      }
      return total;
    } catch {
      return 0;
    }
  }

  /**
   * Pane (shell) PID for each RUNNING session, keyed by instar session id.
   * Read-only: it issues a single `tmux list-panes` per running session and
   * returns whatever resolves — sessions whose pane can't be read are simply
   * omitted (never throws). Consumed by ResourceSampler to attribute per-session
   * CPU/RSS. The pane shell PID is the root of the session's process tree, so a
   * caller measuring it (and its descendants, via `ps`) sees the session's load.
   */
  getRunningSessionPanePids(): Array<{ id: string; pid: number }> {
    const out: Array<{ id: string; pid: number }> = [];
    let running: Session[];
    try {
      running = this.state.listSessions({ status: 'running' });
    } catch {
      return out;
    }
    for (const s of running) {
      try {
        const panePid = withSyncOp(() => execFileSync(
          this.config.tmuxPath,
          ['list-panes', '-t', `=${s.tmuxSession}:`, '-F', '#{pane_pid}'],
          { encoding: 'utf-8', timeout: 5000 },
        )).trim();
        if (panePid && /^\d+$/.test(panePid)) {
          out.push({ id: s.id, pid: Number(panePid) });
        }
      } catch {
        /* pane gone / tmux busy — omit this session, never throw */
      }
    }
    return out;
  }

  /**
   * Pure check: does this already-captured pane show Claude Code actively
   * working? Footer-hint based (see CLAUDE_WORKING_INDICATORS). Exposed so
   * callers that already hold a pane capture (e.g. verifyInjection) can reuse
   * the canonical signal without a second tmux capture. Public for unit tests.
   */
  paneShowsActiveWork(pane: string | null | undefined): boolean {
    return paneShowsClaudeWorking(pane);
  }

  /**
   * Is this session actively working right now? True when the captured pane
   * shows Claude Code's mid-turn footer ("esc to interrupt" / "tokens · esc" /
   * "ctrl+t to hide tasks") OR the session has a live, non-baseline child
   * process (a tool is running).
   *
   * The footer half is the discriminator that matters most for recovery: a
   * long extended-think on a large context shows the footer but spawns no
   * child process and writes nothing to the JSONL until the turn lands — which
   * is exactly the state the compaction-recovery loop used to misread as
   * "stuck" and re-inject into, burying the user's real message. A session
   * that is genuinely idle at its prompt, or one that has wedged and fast-fails
   * every turn, shows neither tell and returns false (recovery proceeds
   * unchanged). Never throws — a capture/ps failure resolves to false.
   */
  isSessionActivelyWorking(tmuxSession: string): boolean {
    try {
      if (!this.tmuxSessionExists(tmuxSession)) return false;
      const pane = this.captureOutput(tmuxSession, 30);
      if (this.paneShowsActiveWork(pane)) return true;
      return this.hasActiveProcesses(tmuxSession);
    } catch {
      return false;
    }
  }

  // ── swap-continuity-antithrash §4.1: the tri-state work-state probe ──────

  /** Shared short-TTL `ps -eo pid,ppid,command` snapshot. The work-gate probe
   *  frequency (deferred intents re-checked per tick + per-10 s reactive grace
   *  loops across a wave) must never fan out one `ps` fork per probe — every
   *  concurrent caller within the TTL reuses ONE process-table read (the §4.1
   *  one-ps-per-TTL mandate; the wiring test pins it). */
  private psSnapshotShared: { atMs: number; promise: Promise<string | null> } | null = null;
  private psSnapshotForkCount = 0;
  private readonly psSnapshotTtlMs = 2_000;

  /** Observability for the §12 wiring test: how many real `ps` forks the
   *  shared snapshot has issued. */
  get psSnapshotForks(): number {
    return this.psSnapshotForkCount;
  }

  private getPsSnapshotShared(): Promise<string | null> {
    const now = Date.now();
    if (this.psSnapshotShared && now - this.psSnapshotShared.atMs < this.psSnapshotTtlMs) {
      return this.psSnapshotShared.promise;
    }
    this.psSnapshotForkCount += 1;
    const promise = execFileAsync('ps', ['-eo', 'pid,ppid,command'], {
      timeout: 5000,
      killSignal: 'SIGKILL' as const,
    })
      .then((r) => r.stdout)
      .catch(() => null);
    this.psSnapshotShared = { atMs: now, promise };
    return promise;
  }

  /**
   * Tri-state in-flight work probe (swap-continuity-antithrash §4.1) — the
   * public async surface the SwapWorkGate composes. Unlike
   * `isSessionActivelyWorking` (which swallows its own failures to `false` —
   * the OPPOSITE resolution I7 requires for optimization callers), each leg
   * that cannot be read reports its own `indeterminate` instead of a silent
   * boolean, and the whole probe is event-loop-safe: coalesced tmux calls +
   * the shared ps snapshot, NEVER the synchronous execFileSync path.
   *
   *  - 'working'       — the pane shows Claude's mid-turn footer OR a live
   *                      non-baseline child process exists.
   *  - 'idle'          — every leg affirmatively reports no work (a
   *                      definitely-absent tmux session is affirmatively idle).
   *  - 'indeterminate' — a leg was attempted and could not be read.
   */
  async checkSessionWorkState(tmuxSession: string): Promise<'working' | 'idle' | 'indeterminate'> {
    // Footer leg (the extended-think discriminator: a long think shows the
    // footer but spawns no child process and writes nothing to JSONL).
    let footer: 'working' | 'idle' | 'indeterminate';
    const cap = await this.tmuxExecCoalesced('capture-pane', tmuxSession, [
      'capture-pane',
      '-t',
      `=${tmuxSession}:`,
      '-p',
      '-S',
      '-30',
    ]);
    if (cap.state === 'success') {
      footer = paneShowsClaudeWorking(cap.stdout) ? 'working' : 'idle';
    } else if (cap.state === 'definitely-absent') {
      // The tmux session does not exist — affirmatively no in-flight work.
      return 'idle';
    } else {
      footer = 'indeterminate';
    }
    if (footer === 'working') return 'working';

    // Child-process leg — the batched path around the pure
    // computeHasActiveProcesses (deliberately NOT hasActiveProcessesAsync,
    // which forks its own full `ps -eo` per call and folds failure to `true`
    // — the wrong shape twice over for this probe, §4.1).
    let proc: 'working' | 'idle' | 'indeterminate';
    const panes = await this.tmuxExecCoalesced('list-panes', tmuxSession, [
      'list-panes',
      '-t',
      `=${tmuxSession}:`,
      '-F',
      '#{pane_pid}',
    ]);
    if (panes.state === 'definitely-absent') {
      proc = 'idle';
    } else if (panes.state !== 'success') {
      proc = 'indeterminate';
    } else {
      const panePid = panes.stdout.trim();
      if (!panePid || !/^\d+$/.test(panePid)) {
        proc = 'idle';
      } else {
        const ps = await this.getPsSnapshotShared();
        proc = ps === null ? 'indeterminate' : this.computeHasActiveProcesses(panePid, ps) ? 'working' : 'idle';
      }
    }
    if (proc === 'working') return 'working';
    if (footer === 'indeterminate' || proc === 'indeterminate') return 'indeterminate';
    return 'idle';
  }

  /**
   * Capture the current output of a tmux session.
   */
  captureOutput(tmuxSession: string, lines: number = 100): string | null {
    try {
      // Note: use `=session:` (trailing colon) for pane-level tmux commands
      // RULE 3: EXEMPT — primitive output capture, not state detection. The
      // raw bytes returned here are consumed by callers (sentinels, watchdog)
      // that own the actual state-detection patterns and their canary/registry
      // coverage. This method is the transport layer.
      return withSyncOp(() => execFileSync(
        this.config.tmuxPath,
        ['capture-pane', '-t', `=${tmuxSession}:`, '-p', '-S', `-${lines}`],
        { encoding: 'utf-8', timeout: 5000 }
      ));
    } catch {
      // @silent-fallback-ok — capture output, null handled by caller
      return null;
    }
  }

  /**
   * Capture the current output of a tmux session WITH ANSI escape sequences
   * (`capture-pane -e`) preserved.
   *
   * Exists for consumers that need the RENDERING of pane text, not just its
   * bytes — the F2 ghost-text exclusion in StuckInputSentinel reads the SGR
   * dim attribute to tell the harness's model-generated composer suggestion
   * (rendered dim, never typed) apart from genuinely stuck real input, which
   * are byte-identical once attributes are stripped. Returns null on any
   * capture failure, exactly like captureOutput.
   */
  // RULE 3: EXEMPT — primitive output capture (styled twin of captureOutput
  // above); the state-detection patterns live in the consumers.
  captureOutputAnsi(tmuxSession: string, lines: number = 100): string | null {
    try {
      return withSyncOp(() => execFileSync(
        this.config.tmuxPath,
        ['capture-pane', '-t', `=${tmuxSession}:`, '-p', '-e', '-S', `-${lines}`],
        { encoding: 'utf-8', timeout: 5000 }
      ));
    } catch {
      // @silent-fallback-ok — capture output, null handled by caller
      return null;
    }
  }

  /**
   * The last `lines` MEANINGFUL rows of a session's pane — blank-fill-immune.
   *
   * `capture-pane -S -N` returns the last N PHYSICAL rows, so in a tall pane
   * the meaningful text (idle prompt, modal, readiness marker) can sit above a
   * run of trailing blank rows and a small-N capture comes back entirely blank.
   * That made genuinely-idle sessions read as ACTIVE forever in the n=5 idle/
   * age checks (the #20/#47 inflated-blocker family; cycle-2 finding, task #77;
   * same class PR #818 fixed inside PromptGate). This captures a wider physical
   * window, trims trailing blanks (shared core/paneText semantics — interior
   * blanks preserved), and returns the last `lines` meaningful rows.
   */
  captureMeaningfulTail(tmuxSession: string, lines: number): string | null {
    const raw = this.captureOutput(tmuxSession, Math.max(lines * 4, 50));
    if (raw === null) return null;
    return meaningfulTail(raw, lines);
  }

  /**
   * Async twin of captureOutput (§A hot path) — bounded, SIGKILL-capped
   * capture-pane through the single-flight wrapper. Any non-success outcome
   * (indeterminate/absent/timeout) resolves to `null`, exactly like the sync
   * version's catch — the caller's null handling is byte-for-byte preserved.
   */
  private async captureOutputAsync(tmuxSession: string, lines: number = 100): Promise<string | null> {
    const out = await this.tmuxExecCoalesced('capture-pane', tmuxSession, [
      'capture-pane',
      '-t',
      `=${tmuxSession}:`,
      '-p',
      '-S',
      `-${lines}`,
    ]);
    return out.state === 'success' ? out.stdout : null;
  }

  /** Async twin of captureMeaningfulTail — async capture, SAME pure trim/tail. */
  private async captureMeaningfulTailAsync(tmuxSession: string, lines: number): Promise<string | null> {
    const raw = await this.captureOutputAsync(tmuxSession, Math.max(lines * 4, 50));
    if (raw === null) return null;
    return meaningfulTail(raw, lines);
  }

  /**
   * Transcript-activity probe — ground-truth liveness independent of the tmux
   * pane and process tree. A session doing MCP/tool work (e.g. driving Playwright)
   * runs that work OUT of the pane's process tree and, between tool calls, shows an
   * idle-looking prompt with no non-baseline child process — so the pane+procs
   * activity check reads it as idle and the age-kill terminal-reaped it mid-work
   * (2026-06-13 incident). The framework JSONL grows on every turn/tool event, so
   * a transcript modified within `withinMs` proves the session is alive and
   * producing. Returns true on a recent mtime; false on anything unprobeable
   * (no session id, '' path, missing file, stat error) — never block a kill on a
   * transcript we cannot read (the safe direction is to fall through to the
   * pane/procs verdict, not to keep a possibly-dead session alive forever).
   */
  isTranscriptRecentlyActive(session: Session, withinMs: number): boolean {
    try {
      const sessionId = session.claudeSessionId;
      if (!sessionId) return false;
      const jsonlPath = resolveFrameworkTranscriptPath({
        framework: session.framework ?? 'claude-code',
        sessionId,
        projectDir: session.cwd ?? this.config.projectDir,
      });
      if (!jsonlPath) return false;
      const stat = fs.statSync(jsonlPath);
      return Date.now() - stat.mtimeMs < withinMs;
    } catch {
      // @silent-fallback-ok — an unprobeable transcript is NOT evidence of
      // activity; fall through to the pane/procs verdict rather than pinning a
      // possibly-dead session alive on a read error.
      return false;
    }
  }

  private currentPaneCwd(tmuxSession: string): string | null {
    try {
      const out = withSyncOp(() => execFileSync(
        this.config.tmuxPath,
        ['display-message', '-p', '-t', `=${tmuxSession}:`, '#{pane_current_path}'],
        { encoding: 'utf-8', timeout: 2000 },
      )).trim();
      return out || null;
    } catch {
      // @silent-fallback-ok — cwd tracking is best-effort enrichment for respawn recovery
      return null;
    }
  }

  /**
   * Async twin of currentPaneCwd (§A) — preserves the LIGHTER 2000ms budget the
   * sync version uses (cwd tracking is best-effort enrichment, not a liveness
   * probe). A distinct op key (`display-message-cwd`) keeps single-flight from
   * coalescing this `pane_current_path` probe with the liveness
   * `pane_current_command` probe of the same session. Non-success ⇒ null.
   */
  private async currentPaneCwdAsync(tmuxSession: string): Promise<string | null> {
    const out = await this.tmuxExecCoalesced(
      'display-message-cwd',
      tmuxSession,
      ['display-message', '-p', '-t', `=${tmuxSession}:`, '#{pane_current_path}'],
      { timeoutMs: 2000 },
    );
    if (out.state !== 'success') return null;
    const trimmed = out.stdout.trim();
    return trimmed || null;
  }

  private recordBuildContext(tmuxSession: string): void {
    if (!this.buildContextStore) return;
    const currentCwd = this.currentPaneCwd(tmuxSession);
    if (!currentCwd) return;
    try {
      this.buildContextStore.record(tmuxSession, this.config.projectDir, currentCwd);
    } catch (err) {
      console.warn(`[SessionManager] Failed to record build context for "${tmuxSession}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Async twin of recordBuildContext — async cwd probe, SAME persistence. */
  private async recordBuildContextAsync(tmuxSession: string): Promise<void> {
    if (!this.buildContextStore) return;
    const currentCwd = await this.currentPaneCwdAsync(tmuxSession);
    if (!currentCwd) return;
    try {
      this.buildContextStore.record(tmuxSession, this.config.projectDir, currentCwd);
    } catch (err) {
      console.warn(`[SessionManager] Failed to record build context for "${tmuxSession}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private withBuildContextRestoreNote(
    tmuxSession: string,
    initialMessage: string | undefined,
    resumeSessionId: string | undefined,
  ): string | undefined {
    if (!resumeSessionId || !this.buildContextStore) return initialMessage;
    const restore = this.buildContextStore.getRestore(tmuxSession);
    if (!restore) return initialMessage;
    console.log(`[SessionManager] Restoring build context for "${tmuxSession}" from ${restore.entry.currentCwd}`);
    return [restore.note, initialMessage].filter(Boolean).join('\n\n');
  }

  /**
   * Resolve the IntelligenceFramework a tmux session was spawned under
   * by reading the INSTAR_FRAMEWORK env we set in its tmux env block.
   * Cached so repeated injections don't re-shell out. Returns null when
   * the env isn't present (legacy sessions, non-instar tmux sessions).
   */
  private readonly sessionFrameworkCache = new Map<string, IntelligenceFramework | null>();
  /** Invalidate cached framework for a tmux name. Call after killing or
   *  respawning a session whose name may be reused under a different
   *  framework — e.g., after a /route switch. */
  clearSessionFrameworkCache(tmuxSession: string): void {
    this.sessionFrameworkCache.delete(tmuxSession);
  }
  /** Public accessor for a session's resolved intelligence framework
   *  (claude-code | codex-cli), or undefined if it can't be determined.
   *  Cached per session. Used by sentinel wiring to pick the right
   *  activity-signal patterns when classifying a captured frame. */
  frameworkForSession(tmuxSession: string): IntelligenceFramework | undefined {
    return this.getSessionFramework(tmuxSession) ?? undefined;
  }
  private getSessionFramework(tmuxSession: string): IntelligenceFramework | null {
    if (this.sessionFrameworkCache.has(tmuxSession)) {
      return this.sessionFrameworkCache.get(tmuxSession) ?? null;
    }
    let resolved: IntelligenceFramework | null = null;
    try {
      const out = withSyncOp(() => execFileSync(
        this.config.tmuxPath,
        ['show-environment', '-t', `=${tmuxSession}`, 'INSTAR_FRAMEWORK'],
        { encoding: 'utf-8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] },
      )).trim();
      const value = out.startsWith('INSTAR_FRAMEWORK=') ? out.slice('INSTAR_FRAMEWORK='.length) : '';
      if (value === 'claude-code' || value === 'codex-cli') {
        resolved = value;
      }
    } catch {
      // @silent-fallback-ok — framework lookup is advisory; injection
      // falls back to the Claude path which is correct for the default
      // and conservative for unknown frameworks.
    }
    this.sessionFrameworkCache.set(tmuxSession, resolved);
    return resolved;
  }

  /**
   * Send input to a running tmux session.
   */
  sendInput(tmuxSession: string, input: string): boolean {
    try {
      // Note: use `=session:` (trailing colon) for pane-level tmux commands
      // Send text literally, then Enter separately. `--` terminates option
      // parsing so input can never be interpreted as a send-keys flag
      // (FABLE-MODEL-ESCALATION-SPEC §5.3 hardening; safe for all callers).
      withSyncOp(() => execFileSync(
        this.config.tmuxPath,
        ['send-keys', '-t', `=${tmuxSession}:`, '-l', '--', input],
        { encoding: 'utf-8', timeout: 5000 }
      ));
      withSyncOp(() => execFileSync(
        this.config.tmuxPath,
        ['send-keys', '-t', `=${tmuxSession}:`, 'Enter'],
        { encoding: 'utf-8', timeout: 5000 }
      ));
      return true;
    } catch {
      // @silent-fallback-ok — send-keys boolean return
      return false;
    }
  }

  /**
   * Send a tmux key sequence (without -l literal flag).
   * Use for special keys like 'C-c' (Ctrl+C), 'Enter', 'Escape'.
   * Unlike sendInput() which uses -l (literal), this sends key names directly.
   */
  sendKey(tmuxSession: string, key: string): boolean {
    try {
      withSyncOp(() =>
        execFileSync(
          this.config.tmuxPath,
          ['send-keys', '-t', `=${tmuxSession}:`, key],
          { encoding: 'utf-8', timeout: 5000 }
        )
      );
      return true;
    } catch {
      // @silent-fallback-ok — send-key boolean return
      return false;
    }
  }

  /**
   * Async twin of sendKey (§A) — bounded, SIGKILL-capped send-keys. This is a
   * WRITE, so it is NOT single-flight-coalesced (two Enter presses must each
   * fire — coalescing would silently swallow one); it still respects the
   * max-in-flight ceiling (fail CLOSED ⇒ report not-sent) and feeds (C). Used by
   * the paste-retry path only — NOT the injection send-keys sequence (which
   * stays synchronous because its timing IS the correctness mechanism).
   */
  private async sendKeyAsync(tmuxSession: string, key: string): Promise<boolean> {
    if (this.tmuxInflightCount >= this.tmuxMaxInFlight) return false;
    this.tmuxInflightCount += 1;
    try {
      const out = await this.tmuxExecAsync(['send-keys', '-t', `=${tmuxSession}:`, key]);
      return out.state === 'success';
    } finally {
      this.tmuxInflightCount = Math.max(0, this.tmuxInflightCount - 1);
    }
  }

  /**
   * List all sessions that are currently running.
   * Pure filter — does not mutate state. The monitor tick handles lifecycle transitions.
   * WARNING: This calls synchronous tmux has-session for each session.
   * For health checks and non-critical callers, prefer getCachedRunningSessions().
   */
  listRunningSessions(): Session[] {
    const sessions = this.state.listSessions({ status: 'running' });
    const alive = sessions.filter(s => this.isSessionAlive(s.tmuxSession));
    // Update cache as a side effect
    this._cachedRunningCount = alive.length;
    this._cachedRunningSessions = alive;
    return alive;
  }

  /**
   * Every tmuxSession name SessionManager has ever known (any status — running,
   * completed, failed, killed). Backs the OrphanProcessReaper's exact-id orphan
   * classification (UNIFIED-SESSION-LIFECYCLE §P0 #6): a process is an instar-
   * orphan ONLY when its tmuxSession exactly matches a name instar has tracked,
   * never via a project-prefix substring (which over-matches user-created
   * sessions that happen to share the prefix).
   */
  listKnownTmuxSessions(): Set<string> {
    const out = new Set<string>();
    for (const s of this.state.listSessions()) out.add(s.tmuxSession);
    return out;
  }

  /**
   * Get cached running session info (count + list) without blocking the event loop.
   * Updated asynchronously by the monitor tick every 5 seconds.
   * Safe to call from the health endpoint and other latency-sensitive paths.
   */
  getCachedRunningSessions(): { count: number; sessions: Session[] } {
    return { count: this._cachedRunningCount, sessions: this._cachedRunningSessions };
  }

  /**
   * Fast startup purge — remove session records for sessions that are *definitively*
   * dead. Called once at server boot BEFORE monitoring starts, to prevent the death
   * spiral where stale records overwhelm startup and block health checks.
   *
   * UNIFIED-SESSION-LIFECYCLE §P1 (the 2026-05-27 fix): liveness is resolved from a
   * single `tmux list-sessions` via the tri-state oracle, NOT a per-session
   * `has-session` with a 1s timeout. The old code treated a timeout (tmux busy at
   * boot) identically to "session gone" and mass-purged live sessions — "9 of 9".
   * Now ONLY a `dead` verdict (server reachable + exact id absent) purges; `alive`
   * and `indeterminate` are kept. An indeterminate session lingers one extra tick
   * (cheap, caught by monitoring) rather than being falsely reaped (expensive).
   */
  async purgeDeadSessions(): Promise<number> {
    const running = this.state.listSessions({ status: 'running' });
    if (running.length === 0) return 0;

    const verdicts = await this.livenessOracle.probeAll(running.map((s) => s.tmuxSession));

    let purged = 0;
    let kept = 0;
    let indeterminate = 0;
    let skipped = 0;
    for (const session of running) {
      const v = verdicts.get(session.tmuxSession);
      if (v?.liveness === 'dead') {
        // Route through the single ReapAuthority (§P0) so the reap is lease-gated,
        // recorded in the reap-log, and emits the standard lifecycle events. The
        // KEEP-guard is bypassed via `knownDead` — the oracle has already proven
        // this session dead, and the guard's liveness-blind topic-state KEEPs would
        // otherwise pin a tombstone and re-create the death-spiral.
        const r = await this.terminateSession(session.id, 'boot-purge-dead', {
          knownDead: true,
          finalStatus: 'completed',
        });
        if (r.terminated) purged++;
        else skipped++; // not-lease-holder / protected — recorded, kept for next awake tick
      } else if (session.launchLane === 'rerouted-interactive' && session.jobSlug) {
        // Boot reconciliation (june15-headless-spawn-reroute, PR2 finding O3):
        // a rerouted JOB session that survived a restart is still ALIVE in tmux,
        // but JobScheduler.activeRunIds (in-memory) is lost AND triggerJob has no
        // guard against re-triggering the slug on its next cron tick → double
        // execution + double billing. Adopt-or-kill: we KILL (the safe choice —
        // the job reruns cleanly with fresh run-tracking; adopting an orphan REPL
        // whose run-id we no longer hold would silently never finalize). Operator
        // kill so the lease/KEEP-guards don't pin the orphan.
        const r = await this.terminateSession(session.id, 'boot-reconcile-rerouted-job', {
          finalStatus: 'killed',
          disposition: 'terminal',
          origin: 'operator',
        });
        if (r.terminated) {
          console.log(`[SessionManager] Startup reconcile: killed surviving rerouted job session "${session.name}" (slug ${session.jobSlug}) — the job reruns cleanly on its next trigger.`);
        }
        kept++; // counted as "not dead-purged"; the kill is the reconciliation
      } else {
        kept++;
        if (v?.liveness === 'indeterminate') indeterminate++;
      }
    }

    if (purged > 0 || indeterminate > 0 || skipped > 0) {
      console.log(
        `[SessionManager] Startup purge: removed ${purged} dead session(s) of ${running.length} tracked` +
          (indeterminate > 0
            ? ` (${indeterminate} indeterminate — KEPT, will re-verify on the next tick rather than risk a false purge)`
            : '') +
          (skipped > 0
            ? ` (${skipped} dead but not reaped here — standby/protected, deferred to the awake machine)`
            : ''),
      );
    }
    return purged;
  }

  /**
   * Get diagnostics for all running sessions, including staleness detection
   * and memory pressure. Used by the scheduler to build intelligent notifications
   * when jobs are blocked by session limits.
   */
  getSessionDiagnostics(): SessionDiagnostics {
    const running = this.listRunningSessions();
    const now = Date.now();

    const sessions: SessionDiagnostic[] = running.map(s => {
      const ageMinutes = s.startedAt
        ? Math.round((now - new Date(s.startedAt).getTime()) / 60000)
        : 0;
      const maxDuration = s.maxDurationMinutes || this.effectiveMaxDurationMinutes;

      // A session is stale if it's exceeded its expected duration
      let isStale = false;
      let staleReason: string | undefined;

      if (ageMinutes > maxDuration) {
        isStale = true;
        staleReason = `Running ${ageMinutes}m, expected max ${maxDuration}m`;
      } else if (s.maxDurationMinutes && ageMinutes > s.maxDurationMinutes * 0.9) {
        // Near its limit — flag as approaching stale
        isStale = true;
        staleReason = `Near timeout (${ageMinutes}m / ${s.maxDurationMinutes}m)`;
      }

      return {
        name: s.name,
        id: s.id,
        jobSlug: s.jobSlug,
        ageMinutes,
        maxDurationMinutes: s.maxDurationMinutes,
        isStale,
        staleReason,
      };
    });

    const staleSessions = sessions.filter(s => s.isStale);

    // Memory pressure assessment
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedPercent = Math.round(((totalMem - freeMem) / totalMem) * 100);
    const freeMemMB = Math.round(freeMem / 1048576);
    const totalMemMB = Math.round(totalMem / 1048576);

    // Shared with the reroute pre-spawn gate (june15-headless-spawn-reroute O2)
    // via currentMemoryPressure() — one definition of the pressure tiers.
    const memoryPressure: MemoryPressure = this.currentMemoryPressure();

    // Build actionable suggestions
    const suggestions: string[] = [];

    if (staleSessions.length > 0) {
      for (const s of staleSessions) {
        suggestions.push(`Kill stale session "${s.name}" (${s.staleReason})`);
      }
    }

    if (memoryPressure === 'critical' || memoryPressure === 'high') {
      if (staleSessions.length > 0) {
        suggestions.push(`Memory pressure is ${memoryPressure} (${usedPercent}% used) — killing stale sessions would free resources`);
      } else {
        suggestions.push(`Memory pressure is ${memoryPressure} (${usedPercent}% used) — avoid increasing maxSessions`);
      }
    } else if (staleSessions.length === 0) {
      // No stale sessions and memory is fine — suggest increasing the limit
      suggestions.push(`All ${running.length} sessions are active and healthy. Consider increasing maxSessions from ${this.config.maxSessions} to ${this.config.maxSessions + 1}`);
    }

    return {
      sessions,
      maxSessions: this.config.maxSessions,
      staleSessions,
      memoryPressure,
      memoryUsedPercent: usedPercent,
      freeMemoryMB: freeMemMB,
      totalMemoryMB: totalMemMB,
      suggestions,
    };
  }

  /**
   * Pure completion-pattern scan — shared by the sync detect methods and their
   * async twins so the `.includes()` matching can NEVER drift between paths.
   * `output === null` (an unreadable capture) is NOT a completion.
   */
  private matchesAnyPattern(output: string | null, patterns: readonly string[]): boolean {
    if (!output) return false;
    return patterns.some((pattern) => output.includes(pattern));
  }

  /**
   * Detect if a session has completed by checking output patterns.
   */
  detectCompletion(tmuxSession: string): boolean {
    const output = this.captureOutput(tmuxSession, 30);
    return this.matchesAnyPattern(output, this.config.completionPatterns);
  }

  /** Async twin of detectCompletion — bounded capture, identical pattern scan. */
  private async detectCompletionAsync(tmuxSession: string): Promise<boolean> {
    const output = await this.captureOutputAsync(tmuxSession, 30);
    return this.matchesAnyPattern(output, this.config.completionPatterns);
  }

  /**
   * Per-session completion detection (june15-headless-spawn-reroute, PR2).
   * Scans the captured pane for THIS session's own `completionPatterns` (the
   * injected sentinel) rather than the global death-phrase config. A rerouted-
   * interactive REPL never exits and never prints the global death phrases on
   * success, so the global detectCompletion would never reap it. Used by the
   * monitor loop ONLY for completionMode==='pattern' sessions; the default lane
   * is byte-for-byte untouched. Returns false when the session has no
   * per-session patterns (defensive — should not happen for a 'pattern' session).
   */
  detectSessionCompletion(session: Session): boolean {
    const patterns = session.completionPatterns;
    if (!patterns || patterns.length === 0) return false;
    const output = this.captureOutput(session.tmuxSession, 30);
    return this.matchesAnyPattern(output, patterns);
  }

  /** Async twin of detectSessionCompletion — bounded capture, identical scan. */
  private async detectSessionCompletionAsync(session: Session): Promise<boolean> {
    const patterns = session.completionPatterns;
    if (!patterns || patterns.length === 0) return false;
    const output = await this.captureOutputAsync(session.tmuxSession, 30);
    return this.matchesAnyPattern(output, patterns);
  }

  /**
   * Reap completed/zombie sessions.
   */
  reapCompletedSessions(): string[] {
    const running = this.state.listSessions({ status: 'running' });
    const reaped: string[] = [];

    for (const session of running) {
      if (this.config.protectedSessions.includes(session.tmuxSession)) continue;

      if (!this.isSessionAlive(session.tmuxSession) || this.detectCompletion(session.tmuxSession)) {
        session.status = 'completed';
        session.endedAt = new Date().toISOString();
        this.state.saveSession(session);
        reaped.push(session.id);

        // Kill the tmux session if it's still hanging around
        if (this.isSessionAlive(session.tmuxSession)) {
          try {
            withSyncOp(() => execFileSync(this.config.tmuxPath, ['kill-session', '-t', `=${session.tmuxSession}`], {
              encoding: 'utf-8',
            }));
          } catch { /* ignore */ }
        }
      }
    }

    return reaped;
  }

  /**
   * Remove stale session state files for sessions that have been
   * killed or completed beyond the retention period.
   * Killed sessions: removed after 1 hour.
   * Completed sessions: removed after 24 hours.
   */
  cleanupStaleSessions(): string[] {
    const allSessions = this.state.listSessions();
    const now = Date.now();
    const KILLED_TTL_MS = 60 * 60 * 1000;            // 1 hour
    const COMPLETED_JOB_TTL_MS = 60 * 60 * 1000;     // 1 hour for jobs
    const COMPLETED_TTL_MS = 24 * 60 * 60 * 1000;    // 24 hours for interactive
    const cleaned: string[] = [];
    const completed: { id: string; endedAt: number }[] = [];

    for (const session of allSessions) {
      if (session.status !== 'killed' && session.status !== 'completed') continue;
      const endedAt = session.endedAt ? new Date(session.endedAt).getTime() : 0;
      if (!endedAt) continue;

      const age = now - endedAt;
      let ttl: number;
      if (session.status === 'killed') {
        ttl = KILLED_TTL_MS;
      } else if (session.jobSlug) {
        ttl = COMPLETED_JOB_TTL_MS;
      } else {
        ttl = COMPLETED_TTL_MS;
      }

      if (age > ttl) {
        if (this.state.removeSession(session.id)) {
          cleaned.push(session.id);
          this.idleKillBackoff?.clear(session.id); // map-leak eviction (Fix A finding 1)
        }
      } else if (session.status === 'completed') {
        completed.push({ id: session.id, endedAt });
      }
    }

    // Hard cap: prune oldest completed sessions if more than 50 remain
    const MAX_COMPLETED = 50;
    if (completed.length > MAX_COMPLETED) {
      completed.sort((a, b) => a.endedAt - b.endedAt);
      const excess = completed.slice(0, completed.length - MAX_COMPLETED);
      for (const s of excess) {
        if (this.state.removeSession(s.id)) {
          cleaned.push(s.id);
          this.idleKillBackoff?.clear(s.id); // map-leak eviction (Fix A finding 1)
        }
      }
    }

    if (cleaned.length > 0) {
      console.log(`[SessionManager] Cleaned up ${cleaned.length} stale session(s): ${cleaned.join(', ')}`);
    }
    return cleaned;
  }

  /**
   * Resolve the codex launch model, applying the rate-limit model-swap when
   * configured. For non-codex frameworks, or when codex.rateLimitModelSwap is
   * disabled / has no fallbackModel, returns the requested model unchanged with
   * ZERO disk I/O (the fast-path guard lives in resolveCodexLaunchModelWithUsage).
   * Best-effort: a usage-read failure resolves to the requested model — it never
   * blocks a spawn. Used by both the headless (spawnSession) and interactive
   * (spawnInteractiveSession) codex launch paths.
   */
  private async resolveCodexLaunchModel(
    framework: IntelligenceFramework,
    requestedModel: string | undefined,
  ): Promise<string | undefined> {
    const swapCfg = (this.config as { codex?: { rateLimitModelSwap?: CodexModelSwapConfig } })
      .codex?.rateLimitModelSwap;
    const decision = await resolveCodexLaunchModelWithUsage({
      framework,
      requestedModel,
      config: swapCfg,
    });
    if (decision.swapped) {
      console.log(`[SessionManager] ${decision.reason}`);
      return decision.model;
    }
    return requestedModel;
  }

  /**
   * Dynamic MCP Lifecycle (DYNAMIC-MCP-LIFECYCLE-SPEC) — build the `--mcp-config`
   * launch flags for a claude-code interactive session, so it launches with a
   * lean/explicit MCP subset instead of the full `.mcp.json`.
   *
   * FAIL-SAFE by construction: the FIRST check is the (currently explicit)
   * enable flag, so a dark agent returns `[]` (full `.mcp.json`) immediately —
   * a strict no-op. The whole body is wrapped so ANY error (unreadable config,
   * write failure, anything) returns `[]` — a session is NEVER stranded without
   * its tools; the worst case is "the full tool set", never "missing tools".
   *
   * Resolution order is the spec's load-bearing gate (resolveSessionMcpServers):
   * enabled → framework → committed state file → state-unreadable⇒lean baseline
   * → baseline → full. When it resolves a trimmed set and no committed state file
   * exists yet, it SEEDS one (so the driver + a later --resume restart know what
   * is loaded). Until the on-demand load/offload driver lands, this gates behind
   * the EXPLICIT `dynamicMcp.enabled` flag (NOT the dev-agent gate) so trimming
   * cannot go live before there is a way to load a heavy server back.
   */
  private buildSessionMcpFlags(topicId: number | undefined, framework: string): string[] {
    try {
      const cfg = this.config.dynamicMcp;
      const enabled = cfg?.enabled === true; // explicit-dark until the full path lands
      if (!enabled) return [];
      if (framework !== 'claude-code') return [];
      if (topicId === undefined || topicId === null) return [];

      const mcpJsonPath = path.join(this.config.projectDir, '.mcp.json');
      let full: McpJson;
      try { full = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8')) as McpJson; }
      catch { return []; } // no/unreadable .mcp.json ⇒ nothing to filter ⇒ full
      const allNames = Object.keys((full && typeof full === 'object' ? full.mcpServers : undefined) ?? {});

      const stateDir = path.join(this.config.projectDir, '.instar', 'state', 'mcp-loaded');
      const statePath = path.join(stateDir, `${topicId}.json`);
      let committedStateServers: string[] | null = null;
      let stateFileUnreadable = false;
      if (fs.existsSync(statePath)) {
        try {
          const st = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
          // Two-phase commit: only a `committed:true` file is authoritative; an
          // un-committed (in-flight) file is ignored (treated as no state).
          if (st && st.committed === true && Array.isArray(st.servers)) {
            committedStateServers = st.servers.filter((s: unknown) => typeof s === 'string' && (s as string).length > 0);
          }
        } catch { stateFileUnreadable = true; }
      }

      const baselineServers = resolveBaselineServers(allNames, cfg);
      const allowed = resolveSessionMcpServers({
        enabled, framework, committedStateServers, stateFileUnreadable, baselineServers,
      });
      if (allowed === null) return []; // full .mcp.json

      // Seed the committed loaded-set state file from the resolved baseline when
      // none exists yet — best-effort (a seed failure never blocks the launch).
      // Skip when the existing file was merely unreadable (never clobber it).
      if (committedStateServers === null && !stateFileUnreadable) {
        try {
          fs.mkdirSync(stateDir, { recursive: true });
          const tmp = path.join(stateDir, `${topicId}.json.tmp`);
          fs.writeFileSync(tmp, JSON.stringify({ servers: allowed, committed: true, updatedAt: new Date().toISOString(), reason: 'baseline' }, null, 2));
          fs.renameSync(tmp, statePath);
        } catch { /* seeding is best-effort */ }
      }

      const filtered = filterMcpConfig(full, allowed);
      const outDir = path.join(this.config.projectDir, '.instar', 'state', 'session-mcp-config');
      fs.mkdirSync(outDir, { recursive: true });
      const outPath = path.join(outDir, `mcp-${topicId}-${Date.now()}.json`);
      fs.writeFileSync(outPath, JSON.stringify(filtered, null, 2));
      return ['--strict-mcp-config', '--mcp-config', outPath];
    } catch {
      return []; // @silent-fallback-ok — any failure ⇒ full .mcp.json (never strands a session)
    }
  }

  /**
   * Spawn an interactive Claude Code session (no -p prompt — opens at the REPL).
   * Used for Telegram-driven conversational sessions.
   * Optionally sends an initial message after Claude is ready.
   */
  async spawnInteractiveSession(initialMessage?: string, name?: string, options?: { telegramTopicId?: number; slackChannelId?: string; slackThreadTs?: string; resumeSessionId?: string; framework?: IntelligenceFramework; codexLocalProvider?: 'ollama' | 'lmstudio'; defaultModel?: string;
    /** durable-conversation-identity §7: the authenticated bootstrap
     *  conversation ids this session may open durable state on (a Slack spawn
     *  passes its minted conversation id). Falls back to [telegramTopicId]. */
    bootstrapConversationIds?: number[];
    /** Warm-session A2A (claude-code only): pin a deterministic --session-id so an
     *  eviction mid-thread can --resume losslessly (#746). Ignored when resuming. */
    sessionId?: string;
    /** Subscription & Auth Standard P1.3 (claude-code only): launch this session
     *  under the given account's config home (CLAUDE_CONFIG_DIR) — the account-swap
     *  mechanism. Additive; an explicit value always wins. When unset AND the
     *  spawn-account resolver is wired (pinSessionsToPool), B1 resolves the
     *  scheduler-picked pool home automatically so the interactive lane pins like
     *  the headless lane; unset + no resolver = inherit the parent's login. */
    configHome?: string;
    /** P1.3: record which subscription-pool account this session runs under. An
     *  explicit value wins; otherwise B1 fills it from the resolver-pinned account
     *  (kept in lockstep with configHome). */
    subscriptionAccountId?: string;
    /** Topic Profile §6 — per-topic thinking mode, threaded to the launch
     *  builder (claude `--effort` / codex `model_reasoning_effort`; no-op on
     *  frameworks without a reasoning knob). */
    thinkingMode?: import('./topicProfileValidation.js').ThinkingMode;
    /** Topic Profile — per-topic Claude Code `--effort` level pin, threaded to
     *  the launch builder as `--effort <level>` (claude-code only; strict no-op
     *  on other frameworks). A DIRECT CLI-flag pin, distinct from thinkingMode. */
    effort?: import('./topicProfileValidation.js').EffortLevel;
    /** Explicit per-spawn working directory (reap-notify spec R2.8 / L13 —
     *  a NAMED extension: no spawn path accepted a per-spawn cwd before).
     *  The resume-queue drainer threads a queue entry's recorded cwd /
     *  worktreePath here so an interrupted worktree session resumes in ITS
     *  tree, not the module-level project dir. Unset = projectDir (today's
     *  behavior, byte-for-byte). */
    cwd?: string;
  }): Promise<string> {
    const sanitized = name
      ? name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
      : null;
    const projectBase = path.basename(this.config.projectDir);
    const tmuxSession = sanitized ? `${projectBase}-${sanitized}` : `${projectBase}-interactive-${Date.now()}`;

    // Prevent injection into protected sessions (e.g., the server itself)
    if (this.config.protectedSessions.includes(tmuxSession)) {
      throw new Error(`Cannot interact with protected session: ${tmuxSession}`);
    }

    if (this.tmuxSessionExists(tmuxSession)) {
      // Session already exists — just reuse it. The initial message is
      // instar-composed bootstrap content (F7) — mark it first-party so the
      // InputGuard doesn't flag instar's own boot template as an injection.
      if (initialMessage) {
        this.injectMessage(tmuxSession, initialMessage, { firstParty: { source: 'session-bootstrap' } });
      }
      return tmuxSession;
    }

    const effectiveInitialMessage = this.withBuildContextRestoreNote(
      tmuxSession,
      initialMessage,
      options?.resumeSessionId,
    );

    // User-initiated sessions bypass the maxSessions limit entirely.
    // The user should NEVER be blocked from interacting with their agent
    // because scheduled jobs filled all slots. maxSessions only constrains
    // autonomous/scheduled sessions, not human-initiated ones.
    // Safety valve: still cap at maxSessions * 3 to prevent runaway sessions.
    const runningSessions = this.listRunningSessions();
    const absoluteLimit = this.config.maxSessions * 3;
    // §P5: exclude long-`indeterminate` sessions (unverifiable panes flagged by the
    // StaleSessionBackstop) from the ABSOLUTE cap, so a fleet of them can never lock
    // a human out of spawning — the death-spiral the boot purge guarded against
    // cannot relocate here.
    const countable = runningSessions.filter(s => !this.longIndeterminateSessions.has(s.id));
    if (countable.length >= absoluteLimit) {
      throw new Error(
        `Absolute session limit (${absoluteLimit}) reached. ` +
        `Running: ${runningSessions.map(s => s.name).join(', ')}`
      );
    }

    // Generate session ID before tmux spawn so we can pass it as env var
    const interactiveSessionId = this.generateId();

    // Resolve which framework this session runs under. Precedence:
    //   1. per-call override (options.framework)
    //   2. the agent's resolved runtime framework (config.framework,
    //      derived at load from sessions.framework | enabledFrameworks[0]
    //      | INSTAR_FRAMEWORK)
    //   3. INSTAR_FRAMEWORK env (defense-in-depth if config.framework
    //      wasn't populated by an older Config.load)
    //   4. 'claude-code' (historical default)
    // Before config.framework existed this hardcoded 'claude-code',
    // which made a codex-cli-only agent spawn a Claude session every
    // time the user messaged it (the interactive path is what handles
    // Telegram/Slack messages).
    const framework: IntelligenceFramework = resolveInteractiveFramework({
      perCall: options?.framework,
      configFramework: this.config.framework,
      envFramework: frameworkFromEnv(),
    });
    const binaryPath =
      this.config.frameworkBinaryPaths?.[framework]
      ?? (framework === 'pi-cli'
        // pi-cli must NEVER inherit the claudePath fallback: claudePath holds a
        // CLAUDE binary on claude-code installs, and silently launching Claude
        // with pi's flags violates the additive-only constraint
        // (PI-HARNESS-INTEGRATION-SPEC §0.1). A bare 'pi' lets PATH resolution
        // work when detection missed an install; a missing binary then fails
        // loudly inside the pane instead of impersonating another framework.
        ? 'pi'
        : this.config.claudePath);
    if (!binaryPath) {
      throw new Error(`No binary path available for framework "${framework}"`);
    }
    // Per-call defaultModel override (used by /local-model to set Codex's
    // local model id) wins over config defaults. Config defaults survive
    // for cloud-Codex topics that haven't been customized.
    const defaultModel = options?.defaultModel ?? this.config.frameworkDefaultModels?.[framework];
    // Codex rate-limit model-swap (see resolveCodexLaunchModel) — applies to the
    // interactive (user-facing) codex session too, not just headless spawns.
    const launchDefaultModel = await this.resolveCodexLaunchModel(framework, defaultModel);
    // Subscription-pool pinning for the INTERACTIVE (user-facing) lane (B1).
    // Mirrors the headless lane (spawnSession): when pinSessionsToPool wired the
    // spawn-account resolver, launch this claude-code session under the
    // scheduler-picked optimal account's config home and TAG it. That makes the
    // user's own conversation first-class for auto-swap — it can be moved when
    // its account walls — instead of riding the default login untagged, where
    // only ProactiveSwapMonitor's default-login fallback could rescue it.
    //   • An explicit caller-supplied configHome ALWAYS wins (the account-swap
    //     path, SessionRefresh, passes one) — the resolver is only consulted when
    //     the caller didn't pin a home itself.
    //   • claude-code only: the pool holds claude logins; a pool configHome is
    //     meaningless for a codex/pi launch.
    //   • No-op unless the resolver is wired (pinSessionsToPool) and returns an
    //     account → default-login behavior is exactly unchanged when off.
    const explicitConfigHome = options?.configHome;
    const pinnedAccount = (!explicitConfigHome && framework === 'claude-code')
      ? (this.spawnAccountResolver?.() ?? null)
      : null;
    // Census #6: when the home comes from a pinned pool account, resolve its LIVE slot through the
    // ledger gate (an explicit caller-supplied home — the account-swap / SessionRefresh path — is a
    // deliberate pin and always wins, unchanged).
    const effectiveConfigHome =
      explicitConfigHome ?? (pinnedAccount ? this.resolvePinnedSpawnHome(pinnedAccount) : undefined);
    const effectiveAccountId = options?.subscriptionAccountId ?? pinnedAccount?.accountId;
    // §2.10 provenance — SINGLE SOURCE OF TRUTH: the SAME `(anthropicApiKey ?? '') !== ''`
    // predicate that selects the Anthropic env block in the execFileSync below. Only meaningful
    // for the claude-code lane (the only one whose env block claude-code actually reads).
    const interactiveCredentialSource: 'store' | 'env' | undefined =
      framework === 'claude-code'
        ? ((this.config.anthropicApiKey ?? '') !== '' ? 'env' : 'store')
        : undefined;
    // This interactive session is about to launch under a pool account's config
    // home — seed the onboarding flags first or a headless-enrolled home wedges
    // it on the first-launch onboarding wizard (2026-06-09 incident). Applies to
    // both the explicit account-swap target and a resolver-pinned home.
    if (effectiveConfigHome && framework === 'claude-code') {
      this.ensurePinnedHomeInteractiveReady(
        effectiveConfigHome,
        explicitConfigHome ? 'interactive account-swap' : 'interactive pin',
      );
    }
    const launchSpec = buildInteractiveLaunch(framework, {
      binaryPath,
      ...(options?.resumeSessionId ? { resumeSessionId: options.resumeSessionId } : {}),
      ...(launchDefaultModel ? { defaultModel: launchDefaultModel } : {}),
      // Warm-session A2A: pin a deterministic --session-id (claude-only, ignored
      // when resuming) so eviction mid-thread falls back to --resume losslessly.
      ...(options?.sessionId && !options?.resumeSessionId ? { sessionId: options.sessionId } : {}),
      ...(options?.codexLocalProvider ? { codexLocalProvider: options.codexLocalProvider } : {}),
      // Subscription & Auth Standard P1.3: per-account config home (claude-only,
      // ignored by other builders) → CLAUDE_CONFIG_DIR for the launched session.
      // effectiveConfigHome = explicit caller home, else the resolver-pinned one.
      ...(effectiveConfigHome ? { configHome: effectiveConfigHome } : {}),
      // Per-agent codex threadline MCP override (ignored by non-codex builders).
      ...(this.config.codexThreadlineMcp ? { codexThreadlineMcp: this.config.codexThreadlineMcp } : {}),
      // Dynamic MCP Lifecycle (claude-code only): launch with a lean/explicit MCP
      // subset when resolved. Fail-safe to [] (full .mcp.json) — a no-op while the
      // feature is dark, and never strands a launch. Ignored by other frameworks.
      ...(() => { const f = this.buildSessionMcpFlags(options?.telegramTopicId, framework); return f.length > 0 ? { mcpFlags: f } : {}; })(),
      // pi-cli: pin session transcripts into the agent state dir so they are
      // durable + discoverable (PI-HARNESS-INTEGRATION-SPEC §2.2). Ignored by
      // every other framework's builder.
      ...(framework === 'pi-cli'
        ? { piSessionDir: path.join(this.config.projectDir, '.instar', 'state', 'pi-sessions') }
        : {}),
      // Topic Profile §6: per-topic thinking mode (claude --effort / codex
      // model_reasoning_effort; strict no-op on gemini/pi).
      ...(options?.thinkingMode ? { thinkingMode: options.thinkingMode } : {}),
      // Topic Profile: direct per-topic Claude `--effort` pin (claude-code
      // only; the builder validates the enum + drops an unknown value).
      ...(options?.effort ? { effort: options.effort } : {}),
    });

    // Spawn the framework CLI in tmux — no bash -c shell intermediary.
    // Uses tmux -e flags to set/unset env vars directly, matching spawnSession pattern.
    // This avoids shell injection risks and handles binary paths with spaces.
    try {
      const tmuxArgs = [
        'new-session', '-d',
        '-s', tmuxSession,
        '-c', options?.cwd ?? this.config.projectDir,
        '-x', '200', '-y', '50',
        // Opt-in: raise Claude Code's own retry count so it rides out transient
        // throttle/overload longer before surfacing to the RateLimitSentinel.
        ...(this.config.claudeCodeMaxRetries != null
          ? ['-e', `CLAUDE_CODE_MAX_RETRIES=${this.config.claudeCodeMaxRetries}`]
          : []),
        '-e', `INSTAR_SESSION_ID=${interactiveSessionId}`, // Expose instar session ID to hook events
        '-e', `INSTAR_SESSION_NAME=${tmuxSession}`, // Threadline binding: attributes a relay-send to its origin session
        '-e', `INSTAR_SERVER_URL=http://localhost:${this.config.port}`,
        '-e', `INSTAR_AUTH_TOKEN=${this.config.authToken}`,
        '-e', `INSTAR_AGENT_ID=${this.config.projectName}`,
        '-e', `INSTAR_FRAMEWORK=${framework}`,
        // durable-conversation-identity §7: per-session bind token scoping
        // durable-state opens to this spawn's bootstrap conversation set
        // (Telegram topic, or the Slack dispatch's minted conversation id).
        ...this.bindTokenEnvFlags(
          tmuxSession,
          options?.bootstrapConversationIds ??
            (typeof options?.telegramTopicId === 'number' ? [options.telegramTopicId] : []),
        ),
        ...this.ghTokenEnvFlags(), // P3b: per-agent vault GitHub token (empty when no vault token)
        // Framework-specific env additions/clears (e.g., CLAUDECODE=)
        ...Object.entries(launchSpec.envOverrides).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
        // OAuth tokens (sk-ant-oat01-...) go in CLAUDE_CODE_OAUTH_TOKEN to enable
        // interactive mode auth via subscription. API keys (sk-ant-api03-...) go in
        // ANTHROPIC_API_KEY for direct API billing. Codex reads its own
        // OPENAI_API_KEY but harmless to pass these — Codex ignores them.
        ...((this.config.anthropicApiKey ?? '').startsWith('sk-ant-oat')
          ? ['-e', `CLAUDE_CODE_OAUTH_TOKEN=${this.config.anthropicApiKey}`, '-e', 'ANTHROPIC_API_KEY=']
          : ['-e', `ANTHROPIC_API_KEY=${this.config.anthropicApiKey ?? ''}`, '-e', 'CLAUDE_CODE_OAUTH_TOKEN=']),
        '-e', `ANTHROPIC_BASE_URL=${this.config.anthropicBaseUrl ?? ''}`,
        // Isolate database credentials — spawned sessions must never inherit production
        // database URLs from the parent shell. (Learned from Portal incident 2026-02-22)
        '-e', 'DATABASE_URL=',
        '-e', 'DIRECT_DATABASE_URL=',
        '-e', 'DATABASE_URL_PROD=',
        '-e', 'DATABASE_URL_DEV=',
        '-e', 'DATABASE_URL_TEST=',
      ];

      if (options?.telegramTopicId) {
        tmuxArgs.push('-e', `INSTAR_TELEGRAM_TOPIC=${options.telegramTopicId}`);
      }

      if (options?.slackChannelId) {
        tmuxArgs.push('-e', `INSTAR_SLACK_CHANNEL=${options.slackChannelId}`);
      }

      // Thread→session (§5.3): when this session belongs to a Slack thread, carry the
      // thread_ts so the session's reply path can thread its replies. Absent for
      // channel-level sessions (today's behavior unchanged).
      if (options?.slackThreadTs) {
        tmuxArgs.push('-e', `INSTAR_SLACK_THREAD_TS=${options.slackThreadTs}`);
      }

      // ── slack-followthrough-generalization §4.4: channel-neutral conversation id
      // for the Action-Claim Stop hook. Resolved IDENTICALLY to the bind token's
      // bootstrap set above (bootstrapConversationIds[0] ?? telegramTopicId), so
      // the id the hook posts is ALWAYS in the token's set (§4.3 gate never 403s
      // its own session). 1:1 GUARD (R2-EXT-C1): injected ONLY for a session that
      // is 1:1 with the conversation — NEVER on the shared `lifeline` session, which
      // serves both the Telegram system topic AND Slack DMs. On the lifeline the
      // hook (which keys ONLY on INSTAR_CONVERSATION_ID, no fallback) registers
      // nothing — a genuine untracked miss, never a cross-channel mis-delivery.
      if (name !== 'lifeline') {
        const conversationEnvId =
          options?.bootstrapConversationIds?.[0] ??
          (typeof options?.telegramTopicId === 'number' ? options.telegramTopicId : undefined);
        if (typeof conversationEnvId === 'number') {
          tmuxArgs.push('-e', `INSTAR_CONVERSATION_ID=${conversationEnvId}`);
        }
      }

      tmuxArgs.push(...launchSpec.argv);

      if (options?.resumeSessionId) {
        console.log(`[SessionManager] Resuming session: ${options.resumeSessionId} (framework: ${framework})`);
      } else {
        console.log(`[SessionManager] Spawning interactive session "${tmuxSession}" (framework: ${framework})`);
      }

      withSyncOp(() => execFileSync(this.config.tmuxPath, tmuxArgs, { encoding: 'utf-8' }));

      // Increase tmux scrollback buffer for dashboard history support
      try {
        withSyncOp(() => execFileSync(this.config.tmuxPath, [
          'set-option', '-t', `=${tmuxSession}:`, 'history-limit', '50000',
        ], { encoding: 'utf-8', timeout: 5000 }));
      } catch {
        // @silent-fallback-ok — history-limit is a nice-to-have
      }
    } catch (err) {
      throw new Error(`Failed to create interactive tmux session: ${err}`);
    }

    // Track it in state (with default timeout — interactive sessions shouldn't hang forever)
    const session: Session = {
      id: interactiveSessionId,
      name: name || tmuxSession,
      status: 'running',
      tmuxSession,
      startedAt: new Date().toISOString(),
      // Carry the framework so the dashboard renders engine-aware (a Codex
      // interactive session must not display as a Claude one). Model is the
      // framework-resolved model THIS session was actually launched with —
      // we use launchDefaultModel (post Codex rate-limit swap), not the raw
      // config default, so GET /sessions reports the real running model and an
      // operator can confirm what a session picked up after a config change.
      // Left undefined only when no model was pinned (the CLI uses its own
      // account default).
      framework,
      ...(resolveModelForFramework(framework, launchDefaultModel) ? { model: resolveModelForFramework(framework, launchDefaultModel) } : {}),
      // P1.3: which subscription-pool account this session runs under (an explicit
      // quota-aware swap/placement, OR the resolver-pinned account for B1 — the
      // user-facing interactive lane is now tagged just like the headless lane).
      // Undefined for single-account agents (resolver unwired → no pin).
      ...(effectiveAccountId ? { subscriptionAccountId: effectiveAccountId } : {}),
      // §2.10 credential provenance — derived from the SAME predicate as the env block.
      ...(interactiveCredentialSource ? { credentialSource: interactiveCredentialSource } : {}),
      prompt: effectiveInitialMessage,
      maxDurationMinutes: this.effectiveMaxDurationMinutes,
      // R2.8/L13: record the spawn cwd so a resume-queue entry can revive
      // this session in ITS tree (worktree round-trip).
      cwd: options?.cwd ?? this.config.projectDir,
    };
    this.state.saveSession(session);

    // Wait for Claude to be ready, then send the initial message.
    // Resume sessions load large JONSLs which trigger TUI redraws — use longer timeout
    // and a stabilization delay to avoid injecting text that gets wiped by the redraw.
    // Fresh sessions also get a generous timeout (90s) to handle slow API auth,
    // large CLAUDE.md loading, and session-start hook execution.
    const readyTimeout = options?.resumeSessionId ? 120_000 : 90_000;
    if (effectiveInitialMessage) {
      // DURABILITY (finding 8d300555): the inject below happens after an async
      // readiness wait — codex can take tens of seconds to boot, and a server
      // restart in that window used to silently drop the message (the pending
      // inject was process-local; tmux survived idle, the bootstrap file sat
      // unconsumed, the operator waited on nothing). Record the pending inject
      // BEFORE the wait; handleReadyAndInject clears it only after the inject
      // actually runs; recoverPendingInjects sweeps survivors at boot.
      this.pendingInjects.record({
        tmuxSession,
        initialMessage: effectiveInitialMessage,
        telegramTopicId: options?.telegramTopicId,
      });
      this.handleReadyAndInject(tmuxSession, name, effectiveInitialMessage, readyTimeout, options).catch((err) => {
        console.error(`[SessionManager] Error during ready-and-inject for "${tmuxSession}": ${err}`);
      });
    }

    return tmuxSession;
  }

  /**
   * Wait for Claude to be ready, inject the initial message, and — when the
   * resume path crashes during startup — fall back to a fresh spawn carrying
   * the same message instead of silently dropping it.
   *
   * Why this exists: a stale --resume UUID can crash Claude during startup
   * (`Session died during startup` in the logs). Without fallback, the user's
   * first message after an idle pause vanishes; the presence proxy fires its
   * "session appears stopped" 5 minutes later; the user must re-send to
   * recover. The fallback closes that gap by retrying once without --resume.
   *
   * Single retry only — if the fresh-spawn also fails, we surface the error
   * via the existing degradation reporter and the bridge's own respawn paths.
   */
  private async handleReadyAndInject(
    tmuxSession: string,
    originalName: string | undefined,
    initialMessage: string,
    readyTimeout: number,
    options?: { telegramTopicId?: number; slackChannelId?: string; slackThreadTs?: string; resumeSessionId?: string },
  ): Promise<void> {
    const ready = await this.waitForClaudeReadyWithRetry(tmuxSession, readyTimeout);
    if (ready) {
      const stabilizationMs = options?.resumeSessionId ? 5000 : 1000;
      await new Promise(r => setTimeout(r, stabilizationMs));
      // First-party provenance (F7): this initial message is instar's OWN
      // composed bootstrap (session context + the MANDATORY Telegram-relay
      // instructions). Marking it here covers every spawn lane that funnels
      // through ready-and-inject — cold spawns, moved-topic respawns, and the
      // pending-inject boot recovery — so the InputGuard never flags instar's
      // own boot template as a suspected prompt injection (audit F7).
      this.injectMessage(tmuxSession, initialMessage, { firstParty: { source: 'session-bootstrap' } });
      this.pendingInjects.clear(tmuxSession);
      console.log(`[SessionManager] Injected initial message into "${tmuxSession}" (${initialMessage.length} chars${stabilizationMs ? ', after stabilization delay' : ''})`);
      return;
    }

    // Not ready. Two flavors:
    //   (a) tmux is gone — startup crash. With --resume, the saved UUID is most
    //       likely stale or corrupt. Fall back to a fresh spawn (no --resume)
    //       carrying the same initial message.
    //   (b) tmux is alive but readiness probe couldn't see the prompt. Best
    //       effort: inject anyway, the original behavior.
    const stillAlive = this.tmuxSessionExists(tmuxSession);
    if (!stillAlive && options?.resumeSessionId) {
      console.warn(`[SessionManager] Resume failed for "${tmuxSession}" (UUID ${options.resumeSessionId}) — tmux died during startup. Falling back to fresh spawn.`);

      // Mark the failed session BEFORE emitting the event. A concurrent
      // monitor tick that reads state in between would otherwise see a dead
      // pane still flagged `running`. Also matters because some
      // resumeFailed listeners may consult listRunningSessions to confirm
      // the failure shape.
      try {
        const failed = this.listRunningSessions().find(s => s.tmuxSession === tmuxSession);
        if (failed) {
          failed.status = 'failed';
          failed.endedAt = new Date().toISOString();
          this.state.saveSession(failed);
        }
      } catch { /* state cleanup is best-effort */ }

      this.emit('resumeFailed', {
        tmuxSession,
        resumeSessionId: options.resumeSessionId,
        telegramTopicId: options.telegramTopicId,
        slackChannelId: options.slackChannelId,
        slackThreadTs: options.slackThreadTs,
      });

      // Best-effort tmux cleanup in case a zombie pane survived.
      try {
        await execFileAsync(this.config.tmuxPath, ['kill-session', '-t', `=${tmuxSession}`]);
      } catch { /* expected if tmux pane is already gone */ }

      // Single fresh-spawn retry. Pass the original `name` parameter through
      // so the recursive call reconstructs the same tmux name — important
      // because the bridge's session→topic mapping was registered against
      // that name. Stripping the project-base prefix from the tmux name
      // would not preserve the auto-generated `interactive-${ts}` form.
      // resumeSessionId is intentionally omitted to break the bad-UUID cycle.
      try {
        await this.spawnInteractiveSession(initialMessage, originalName, {
          telegramTopicId: options.telegramTopicId,
          slackChannelId: options.slackChannelId,
          slackThreadTs: options.slackThreadTs,
        });
        // HONEST LOG (finding 8d300555): the recursive spawn returns BEFORE its
        // own readiness wait + inject complete — "succeeded" here only means
        // "launched". The pending-inject record (re-written by the recursive
        // call) is what guarantees delivery survives a restart in that window.
        console.log(`[SessionManager] Fresh-spawn fallback launched for "${tmuxSession}" (inject pending — durable record held until verified).`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[SessionManager] Fresh-spawn fallback FAILED for "${tmuxSession}": ${errMsg}`);
        DegradationReporter.getInstance().report({
          feature: 'SessionManager.handleReadyAndInject',
          primary: 'Resume failed → fresh-spawn fallback',
          fallback: 'Both resume and fresh-spawn failed; message not delivered',
          reason: `Why: ${errMsg}`,
          impact: 'User message not delivered; bridge will respawn on next message',
        });
      }
      return;
    }

    // Tmux still alive but readiness probe couldn't confirm — best-effort inject.
    // (Preserves the original behavior for prompt-detection false negatives.)
    if (stillAlive) {
      console.error(`[SessionManager] Claude not ready in session "${tmuxSession}" — message NOT injected. Session may need manual intervention.`);
      console.log(`[SessionManager] Session "${tmuxSession}" still alive — attempting injection anyway`);
      // Same instar-composed bootstrap as the ready path above — first-party (F7).
      this.injectMessage(tmuxSession, initialMessage, { firstParty: { source: 'session-bootstrap' } });
      this.pendingInjects.clear(tmuxSession);
      return;
    }

    // tmux dead AND not a resume case — fresh spawn that crashed during startup.
    // No fallback (no UUID to blame); surface as a degradation so the bridge can
    // notice. The bridge already retries on the next inbound message.
    // (The pending-inject record is deliberately NOT cleared here — the boot
    // sweep reports the loss loudly instead of letting it vanish.)
    console.error(`[SessionManager] Claude not ready in session "${tmuxSession}" — tmux died during fresh startup. Message NOT injected.`);
    DegradationReporter.getInstance().report({
      feature: 'SessionManager.handleReadyAndInject',
      primary: 'Wait for Claude ready, inject initial message',
      fallback: 'tmux died during startup with no --resume to fall back from',
      reason: 'fresh-spawn crashed during startup; readiness probe could not verify prompt',
      impact: 'Initial message dropped; bridge will respawn on next inbound message',
    });
  }

  /**
   * Boot-time recovery for injects orphaned by a server restart (finding
   * 8d300555). Sweeps the durable pending-inject records: a still-alive
   * session gets its message re-delivered through the normal readiness path
   * (the live incident — codex idle at a fresh prompt, bootstrap unread); a
   * dead or expired record is reported via DegradationReporter and expired —
   * the loss becomes VISIBLE instead of vanishing with the old process.
   * At-least-once by design: server death between inject and clear means one
   * duplicate on the next boot, which beats a silent drop.
   */
  async recoverPendingInjects(): Promise<{ redelivered: string[]; expired: string[]; deadSession: string[]; failed: string[] }> {
    const result = await sweepPendingInjects(this.pendingInjects, {
      sessionAlive: (tmux) => this.tmuxSessionExists(tmux),
      redeliver: async (record) => {
        console.log(`[SessionManager] Recovering orphaned pending inject for "${record.tmuxSession}" (queued ${record.createdAt})`);
        // Reuse the normal readiness machinery; no resume options — the target
        // session is already running, we only need ready + inject. The inject
        // path clears the record on success.
        await this.handleReadyAndInject(record.tmuxSession, undefined, record.initialMessage, 90_000, {
          telegramTopicId: record.telegramTopicId,
        });
      },
      reportLoss: (record, reason) => {
        DegradationReporter.getInstance().report({
          feature: 'SessionManager.recoverPendingInjects',
          primary: 'Re-deliver an inject orphaned by a server restart',
          fallback: `Pending inject for "${record.tmuxSession}" not re-delivered: ${reason}`,
          reason: `Why: queued ${record.createdAt}${record.telegramTopicId !== undefined ? ` for topic ${record.telegramTopicId}` : ''}`,
          impact: 'A queued initial message may not have reached its session; the bridge respawns on the next inbound message.',
        });
      },
    });
    const total = result.redelivered.length + result.expired.length + result.deadSession.length + result.failed.length;
    if (total > 0) {
      console.log(`[SessionManager] Pending-inject recovery: ${result.redelivered.length} redelivered, ${result.deadSession.length} dead-session, ${result.expired.length} expired, ${result.failed.length} failed.`);
    }
    return result;
  }

  /**
   * Spawn a scoped triage session with restricted tool access.
   * Unlike interactive sessions, triage sessions use --allowedTools + --permission-mode dontAsk
   * instead of --dangerously-skip-permissions. This gives them read-only access.
   *
   * Used by TriageOrchestrator for behind-the-scenes session investigation.
   */
  async spawnTriageSession(name: string, options: {
    allowedTools: string[];
    permissionMode: string;
    resumeSessionId?: string;
  }): Promise<string> {
    const sanitized = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    const projectBase = path.basename(this.config.projectDir);
    const tmuxSession = `${projectBase}-${sanitized}`;

    if (this.config.protectedSessions.includes(tmuxSession)) {
      throw new Error(`Cannot create triage session with protected name: ${tmuxSession}`);
    }

    // Generate session ID before tmux spawn so we can pass it as env var
    const triageSessionId = this.generateId();

    // Kill existing triage session if present (triage sessions are ephemeral)
    if (this.tmuxSessionExists(tmuxSession)) {
      try {
        withSyncOp(() => execFileSync(this.config.tmuxPath, ['kill-session', '-t', tmuxSession], { encoding: 'utf-8' }));
      } catch {
        // Best-effort
      }
    }

    try {
      const tmuxArgs = [
        'new-session', '-d',
        '-s', tmuxSession,
        '-c', this.config.projectDir,
        '-x', '200', '-y', '50',
        '-e', 'CLAUDECODE=',
        '-e', `INSTAR_SESSION_ID=${triageSessionId}`,
        '-e', `INSTAR_SESSION_NAME=${tmuxSession}`, // Threadline binding: attributes a relay-send to its origin session
        '-e', `INSTAR_SERVER_URL=http://localhost:${this.config.port}`,
        '-e', `INSTAR_AUTH_TOKEN=${this.config.authToken}`,
        '-e', `INSTAR_AGENT_ID=${this.config.projectName}`,
        '-e', 'ANTHROPIC_API_KEY=',
        '-e', 'DATABASE_URL=',
        '-e', 'DIRECT_DATABASE_URL=',
        '-e', 'DATABASE_URL_PROD=',
        '-e', 'DATABASE_URL_DEV=',
        '-e', 'DATABASE_URL_TEST=',
      ];

      tmuxArgs.push(this.config.claudePath);

      // Scoped permissions: allowedTools + permissionMode (NOT --dangerously-skip-permissions)
      if (options.allowedTools.length > 0) {
        tmuxArgs.push('--allowedTools', options.allowedTools.join(','));
      }
      tmuxArgs.push('--permission-mode', options.permissionMode);

      if (options.resumeSessionId) {
        tmuxArgs.push('--resume', options.resumeSessionId);
        console.log(`[SessionManager] Resuming triage session: ${options.resumeSessionId}`);
      }

      withSyncOp(() => execFileSync(this.config.tmuxPath, tmuxArgs, { encoding: 'utf-8' }));

      // Increase tmux scrollback buffer for dashboard history support
      try {
        withSyncOp(() => execFileSync(this.config.tmuxPath, [
          'set-option', '-t', `=${tmuxSession}:`, 'history-limit', '50000',
        ], { encoding: 'utf-8', timeout: 5000 }));
      } catch {
        // @silent-fallback-ok — history-limit is a nice-to-have
      }
    } catch (err) {
      throw new Error(`Failed to create triage tmux session: ${err}`);
    }

    // Track it but with a shorter timeout (triage sessions should be brief)
    const session: Session = {
      id: triageSessionId,
      name,
      status: 'running',
      tmuxSession,
      startedAt: new Date().toISOString(),
      maxDurationMinutes: 10,
      // §2.10 provenance — the triage lane hardcodes an EMPTY `ANTHROPIC_API_KEY=` above
      // (it always reads the per-CLAUDE_CONFIG_DIR store, never an env token), so 'store' is
      // the deterministic provenance here. Set explicitly so no claude-code spawn record is
      // provenance-blind (an env-token lane that forgot the flag would be a lint-caught bug).
      credentialSource: 'store',
    };
    this.state.saveSession(session);

    // Wait for Claude to be ready
    const readyTimeout = options.resumeSessionId ? 120_000 : 90_000;
    await this.waitForClaudeReadyWithRetry(tmuxSession, readyTimeout);

    return tmuxSession;
  }

  /**
   * Inject a Telegram message into a tmux session.
   * Short messages go via send-keys; long messages are written to a temp file.
   *
   * Image handling: [image:/path] tags from Telegram photo downloads are
   * transformed into explicit instructions so Claude Code knows to read the
   * image file (it can natively view images via the Read tool).
   */
  /**
   * Inject a paste notification into a tmux session.
   * Uses the same injection path as Telegram/WhatsApp messages
   * so InputGuard provenance checks apply.
   */
  injectPasteNotification(tmuxSession: string, notification: string): string {
    const FILE_THRESHOLD = 500;

    if (notification.length <= FILE_THRESHOLD) {
      this.injectMessage(tmuxSession, notification);
      return notification;
    }

    // Write to temp file for large notifications
    const tmpDir = path.join('/tmp', 'instar-paste');
    fs.mkdirSync(tmpDir, { recursive: true });
    const filename = `paste-notify-${Date.now()}-${randomUUID().slice(0, 8)}.txt`;
    const filepath = path.join(tmpDir, filename);
    fs.writeFileSync(filepath, notification);

    const ref = `[paste] Content notification saved to ${filepath} — read it to see the details.`;
    this.injectMessage(tmuxSession, ref);
    return ref;
  }

  /**
   * Inject a paste notification and CONFIRM it actually submitted (was not left
   * stuck at the prompt by the paste-end Enter race). Returns true only when the
   * injected marker is no longer sitting at the input prompt within the recovery
   * window — i.e. the session genuinely consumed the message. Observes outcome
   * across the same window verifyInjection (fired by injectMessage) uses to resend
   * Enter, so this does NOT duplicate recovery; it only reports the result.
   *
   * Used by topic-linkage reply surfacing, which must not treat a
   * dispatched-but-stuck inject as "delivered to the user" (the A2 bug: a stalled
   * inject silently resolved the commitment and suppressed the Telegram fallback).
   */
  async injectPasteNotificationConfirmed(tmuxSession: string, notification: string): Promise<boolean> {
    let injected: string;
    try {
      injected = this.injectPasteNotification(tmuxSession, notification);
    } catch {
      return false;
    }
    const marker = injected.replace(/^\s+/, '').slice(0, 40).trim();
    // Marker too short to verify reliably — treat dispatch as success.
    if (!marker || marker.length < 8) return true;

    // Absolute times-from-injection (ms) at which to check. Extends just past
    // verifyInjection's last recovery attempt (6500ms) so we observe the final state.
    const schedule = [1000, 3000, 5000, 7500];
    let prev = 0;
    for (const t of schedule) {
      await new Promise((r) => setTimeout(r, t - prev));
      prev = t;
      if (!this.tmuxSessionExists(tmuxSession)) return false;
      const pane = this.captureOutput(tmuxSession, 30) || '';
      if (!this.isMarkerStuckAtPrompt(pane, marker)) return true; // submitted
    }
    return false; // still stuck after the full recovery window
  }

  injectTelegramMessage(tmuxSession: string, topicId: number, text: string, topicName?: string, senderName?: string, telegramUserId?: number, messageId?: number): boolean {
    // Structural dedup at the delivery chokepoint: a given Telegram messageId
    // must reach a session at most once. Upstream paths can over-forward the SAME
    // user message (lifeline re-forward, PendingRelayStore re-drive, sentinel
    // pause/resume) — observed 5x to one codex session, which wastes mentee LLM
    // quota and queues the task repeatedly. Suppress the duplicate but LOG it so
    // the upstream over-forward stays visible for root-cause. Skipped when no
    // positive messageId is available (in-process callers that don't carry one).
    if (typeof messageId === 'number' && messageId > 0) {
      const now = Date.now();
      // Prune expired entries to keep the ledger bounded.
      for (const [k, ts] of this.recentTelegramDeliveries) {
        if (now - ts > SessionManager.TELEGRAM_DELIVERY_DEDUP_WINDOW_MS) {
          this.recentTelegramDeliveries.delete(k);
        }
      }
      const dedupKey = `${tmuxSession}:${messageId}`;
      const priorAt = this.recentTelegramDeliveries.get(dedupKey);
      if (priorAt !== undefined) {
        console.warn(
          `[SessionManager] Suppressed duplicate Telegram delivery to "${tmuxSession}" ` +
          `(topic ${topicId}, messageId ${messageId}, ${Math.round((now - priorAt) / 1000)}s after first) — ` +
          `a single user message was forwarded more than once; delivering only once.`,
        );
        return true; // already delivered on the first call — success without re-injecting
      }
      this.recentTelegramDeliveries.set(dedupKey, now);
    }

    // Track this injection for response verification.
    // If the session dies before the agent replies, the monitor loop will detect it.
    this.pendingInjections.set(tmuxSession, { topicId, injectedAt: Date.now(), text: text.slice(0, 200) });

    const FILE_THRESHOLD = 500;

    // Transform [image:path] tags into explicit read instructions.
    // Claude Code can natively view images via the Read tool, but only
    // if it knows there's an image file to read.
    let transformed = text.replace(
      /\[image:([^\]]+)\]/g,
      (_, imagePath: string) => {
        if (imagePath === 'download-failed') {
          return '[User sent a photo but the download failed]';
        }
        return `[User sent a photo — read the image file at ${imagePath} to view it. If the image cannot be processed, acknowledge you received it and let the user know the image format may not be supported.]`;
      }
    );

    // Transform [document:path] tags into explicit read instructions.
    transformed = transformed.replace(
      /\[document:([^\]]+)\]/g,
      (_, docPath: string) => {
        if (docPath === 'download-failed') {
          return '[User sent a file but the download failed]';
        }
        return `[User sent a file — it has been saved to ${docPath}. Read the file to view its contents]`;
      }
    );

    // Sanitize user-controlled content at the injection boundary
    // (User-Agent Topology Spec, Gap 12)
    const safeName = senderName ? sanitizeSenderName(senderName) : undefined;
    const safeTopic = topicName ? sanitizeTopicName(topicName) : undefined;

    // Build tag using the shared builder — includes UID when available
    // Format: [telegram:42 "Agent Updates" from Justin (uid:12345)]
    const topicTag = buildInjectionTag(topicId, safeTopic, safeName, telegramUserId);
    const taggedText = `${topicTag} ${transformed}`;

    if (taggedText.length <= FILE_THRESHOLD) {
      return this.injectMessage(tmuxSession, taggedText) !== false;
    }

    // Write full message to a project-local inbound file readable by sandboxed agents.
    const tmpDir = getTelegramInboundDir(this.config.projectDir);
    fs.mkdirSync(tmpDir, { recursive: true });
    const filename = `msg-${topicId}-${Date.now()}-${randomUUID().slice(0, 8)}.txt`;
    const filepath = path.join(tmpDir, filename);
    fs.writeFileSync(filepath, taggedText);

    const ref = `[telegram:${topicId}] [Long message saved to ${filepath} — read it to see the full message]`;
    return this.injectMessage(tmuxSession, ref) !== false;
  }

  /**
   * Clear the injection tracker for a topic when the agent sends a reply.
   * Called from the /telegram/reply/:topicId route.
   */
  clearInjectionTracker(topicId: number): void {
    for (const [session, info] of this.pendingInjections) {
      if (info.topicId === topicId) {
        this.pendingInjections.delete(session);
      }
    }
  }

  /**
   * Get all pending injections (for diagnostics / event emission on session death).
   */
  getPendingInjection(tmuxSession: string): { topicId: number; injectedAt: number; text: string } | undefined {
    return this.pendingInjections.get(tmuxSession);
  }

  /**
   * Inject a WhatsApp message into a tmux session.
   * Tags with [whatsapp:JID] and handles long messages via temp files.
   */
  injectWhatsAppMessage(tmuxSession: string, jid: string, text: string, senderName?: string): void {
    const FILE_THRESHOLD = 500;

    // Build tag: [whatsapp:12345678901@s.whatsapp.net from Justin]
    const nameTag = senderName ? ` from ${senderName.replace(/[\[\]]/g, '')}` : '';
    const tag = `[whatsapp:${jid}${nameTag}]`;
    const taggedText = `${tag} ${text}`;

    if (taggedText.length <= FILE_THRESHOLD) {
      this.injectMessage(tmuxSession, taggedText);
      return;
    }

    // Write full message to temp file
    const tmpDir = path.join('/tmp', 'instar-whatsapp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const filename = `msg-${jid.split('@')[0]}-${Date.now()}.txt`;
    const filepath = path.join(tmpDir, filename);
    fs.writeFileSync(filepath, taggedText);

    const ref = `${tag} [Long message saved to ${filepath} — read it to see the full message]`;
    this.injectMessage(tmuxSession, ref);
  }

  /**
   * Inject an iMessage into a tmux session.
   * Tags with [imessage:SENDER] and handles long messages via temp files.
   * Tracks injection for stall detection (uses a synthetic numeric topicId
   * derived from hashing the sender identifier).
   */
  injectIMessageMessage(tmuxSession: string, sender: string, text: string, senderName?: string): void {
    const FILE_THRESHOLD = 500;

    // Generate a stable numeric ID from sender for pendingInjections tracking
    // (pendingInjections uses topicId: number, so we hash the sender string)
    let senderHash = 0;
    for (let i = 0; i < sender.length; i++) {
      senderHash = ((senderHash << 5) - senderHash + sender.charCodeAt(i)) | 0;
    }
    const syntheticTopicId = Math.abs(senderHash);

    this.pendingInjections.set(tmuxSession, { topicId: syntheticTopicId, injectedAt: Date.now(), text: text.slice(0, 200) });

    // Build tag: [imessage:+14081234567 from Justin]
    const safeName = senderName ? senderName.replace(/[\[\]]/g, '') : undefined;
    const nameTag = safeName ? ` from ${safeName}` : '';
    const tag = `[imessage:${sender}${nameTag}]`;
    const taggedText = `${tag} ${text}`;

    if (taggedText.length <= FILE_THRESHOLD) {
      this.injectMessage(tmuxSession, taggedText);
      return;
    }

    // Write full message to temp file with restricted permissions
    const tmpDir = path.join('/tmp', 'instar-imessage');
    fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
    const senderSlug = sender.replace(/[^a-zA-Z0-9]/g, '').slice(-8);
    const filename = `msg-${senderSlug}-${Date.now()}.txt`;
    const filepath = path.join(tmpDir, filename);
    fs.writeFileSync(filepath, taggedText, { mode: 0o600 });

    const ref = `${tag} [Long message saved to ${filepath} — read it to see the full message]`;
    this.injectMessage(tmuxSession, ref);
  }

  /**
   * Clear the injection tracker for an iMessage sender.
   * Called from the /imessage/reply/:recipient route.
   */
  clearIMessageInjectionTracker(sender: string): void {
    // Compute the same hash used in injectIMessageMessage
    let senderHash = 0;
    for (let i = 0; i < sender.length; i++) {
      senderHash = ((senderHash << 5) - senderHash + sender.charCodeAt(i)) | 0;
    }
    const syntheticTopicId = Math.abs(senderHash);

    for (const [session, info] of this.pendingInjections) {
      if (info.topicId === syntheticTopicId) {
        this.pendingInjections.delete(session);
      }
    }
  }

  /**
   * Send text to a tmux session via send-keys, with Input Guard protection.
   *
   * When an InputGuard is configured, messages are checked for provenance
   * before injection. Suspicious messages still reach the session but with
   * a system-reminder warning injected afterward (async, non-blocking).
   *
   * `opts.firstParty` — first-party provenance for instar's OWN injections
   * (F7, roadmap 0.6, test-as-self 2026-07-02): the session-boot bootstrap
   * (context + the MANDATORY Telegram-relay instructions) is composed by
   * instar itself, but it reached the guard as ordinary untagged text — so the
   * InputGuard flagged instar's own boot template as a suspected prompt
   * injection and the freshly-spawned session distrusted its own bootstrap.
   * The provenance travels as THIS in-process parameter — never as content.
   * That is deliberately stronger than any in-content marker: no HTTP surface
   * or message body can reach this parameter, so content that merely LOOKS
   * like a bootstrap (or like any marker) cannot mint the flag by
   * construction — there is nothing to string-match and therefore nothing to
   * forge. Only in-process injector code that AUTHORED the text sets it.
   * Every first-party injection is recorded in the security log
   * (`first-party-injection`) so the guard bypass stays auditable. Everything
   * without the flag keeps the exact pre-F7 guard behavior.
   *
   * For multi-line text, uses bracketed paste mode escape sequences so the
   * terminal treats newlines as literal text rather than Enter keypresses.
   * This avoids tmux load-buffer/paste-buffer which trigger macOS TCC
   * "access data from other apps" permission prompts.
   */
  injectMessage(
    tmuxSession: string,
    text: string,
    opts?: {
      /** In-process first-party provenance (F7). `source` is the audit label
       *  (e.g. 'session-bootstrap'). See the method doc — content can never
       *  mint this flag; only instar's own injector code can. */
      firstParty?: { source: string };
    },
  ): boolean {
    // ── First-party provenance (F7): instar-authored content, verified by
    // the in-process parameter (never by what the text says) — the guard
    // layers below exist to vet content of UNVERIFIED origin, and instar's
    // own bootstrap is not that. Logged, then injected directly.
    if (opts?.firstParty) {
      if (this.inputGuard) {
        try {
          this.inputGuard.logSecurityEvent({
            event: 'first-party-injection',
            session: tmuxSession,
            source: opts.firstParty.source,
            messagePreview: text.slice(0, 100),
          });
        } catch { /* logging must never block a bootstrap injection */ }
      }
      return this.rawInject(tmuxSession, text);
    }

    // ── Input Guard: Layer 1 + 1.5 (deterministic, synchronous) ──
    if (this.inputGuard) {
      // Parse the message's own [telegram:N] tag so getTopicBinding can
      // disambiguate when multiple topics collide onto one tmux session name
      // (case-variant topic names). Without this, a colliding session binds to
      // the first-registered topic and legitimate messages from the other topic
      // are dropped as cross-topic.
      const tagMatch = text.match(/^\[telegram:(\d+)/);
      const preferTopicId = tagMatch ? parseInt(tagMatch[1], 10) : null;
      const binding = this.getTopicBinding(tmuxSession, preferTopicId);
      if (binding) {
        const provenance = this.inputGuard.checkProvenance(text, binding);

        if (provenance === 'mismatched-tag') {
          // Wrong topic — log, alert, and drop
          console.error(
            `[InputGuard] BLOCKED cross-topic injection: message bound for different topic, ` +
            `session "${tmuxSession}" is bound to topic ${binding.topicId}`
          );
          this.inputGuard.logSecurityEvent({
            event: 'input-provenance-block',
            session: tmuxSession,
            boundTopic: binding.topicId,
            messagePreview: text.slice(0, 100),
            reason: 'mismatched tag',
          });
          return false;
        }

        if (provenance === 'untagged') {
          // Layer 1.5: Check injection patterns
          const pattern = this.inputGuard.checkInjectionPatterns(text);
          if (pattern) {
            const action = this.inputGuard['config'].action ?? 'warn';
            this.inputGuard.logSecurityEvent({
              event: 'input-injection-pattern',
              session: tmuxSession,
              boundTopic: binding.topicId,
              pattern,
              action,
              messagePreview: text.slice(0, 100),
            });

            if (action === 'block') {
              console.error(`[InputGuard] BLOCKED injection pattern "${pattern}" in session "${tmuxSession}"`);
              return false;
            }
            if (action === 'warn') {
              // Inject the message, then inject warning afterward
              const result = this.rawInject(tmuxSession, text);
              // Small delay so warning arrives after message
              setTimeout(() => {
                const warning = this.inputGuard!.buildWarning(binding, `Matched injection pattern: ${pattern}`);
                this.rawInject(tmuxSession, warning);
              }, 500);
              return result;
            }
            // action === 'log': fall through to normal injection
          }

          // Layer 2: Async LLM topic coherence review (non-blocking)
          // Inject immediately, review in background
          const injected = this.rawInject(tmuxSession, text);
          this.inputGuard.reviewTopicCoherence(text, binding).then(result => {
            if (result.verdict === 'suspicious') {
              const action = this.inputGuard!['config'].action ?? 'warn';
              this.inputGuard!.logSecurityEvent({
                event: 'input-coherence-suspicious',
                session: tmuxSession,
                boundTopic: binding.topicId,
                reason: result.reason,
                confidence: result.confidence,
                action,
                messagePreview: text.slice(0, 100),
              });

              if (action === 'warn') {
                const warning = this.inputGuard!.buildWarning(binding, result.reason);
                this.rawInject(tmuxSession, warning);
              }
              // block mode doesn't apply after async review — message already injected
              // log mode: already logged above
            }
          }).catch(err => {
            // Fail open — message already injected, just log the error
            console.error(`[InputGuard] Coherence review error: ${err instanceof Error ? err.message : err}`);
          });
          return injected;
        }
        // provenance === 'verified' or 'unbound' — fall through to normal injection
      }
    }

    // ── Normal injection (verified provenance or no InputGuard) ──
    return this.rawInject(tmuxSession, text);
  }

  /**
   * Internal-only injection for trusted in-process recovery agents (the
   * sentinels). Bypasses InputGuard's topic-prefix provenance requirement so a
   * recovery nudge can reach a session that is NOT bound to any Telegram topic
   * (e.g. a developer's interactive Claude Code window). Without this path, the
   * rate-limit / socket-disconnect / silence sentinels silently no-op for
   * non-topic-bound sessions — the exact bug behind "the throttle never
   * recovered in my dev window."
   *
   * SECURITY BOUNDARY: this method is NOT exposed over HTTP. The only callers
   * are in-process sentinel recovery deps wired in server.ts. HTTP injection
   * continues to flow through injectMessage(), which enforces topic prefixing.
   * Every internal injection is recorded with source 'sentinel-recovery' so the
   * audit log can distinguish trusted recovery nudges from user/topic traffic.
   *
   * @param source - audit label for the trusted caller (e.g. 'sentinel-recovery')
   */
  injectInternalMessage(tmuxSession: string, text: string, source = 'sentinel-recovery'): boolean {
    if (!this.isSessionAlive(tmuxSession)) return false;
    if (this.inputGuard) {
      // Record the trusted bypass so it's distinguishable in the security log.
      try {
        this.inputGuard.logSecurityEvent({
          event: 'internal-recovery-injection',
          session: tmuxSession,
          source,
          messagePreview: text.slice(0, 100),
        });
      } catch { /* logging must never block a recovery nudge */ }
    }
    return this.rawInject(tmuxSession, text);
  }

  /**
   * Raw tmux send-keys injection. No validation — just sends text to the session.
   * Used by injectMessage after provenance checks pass.
   */
  private rawInject(tmuxSession: string, text: string): boolean {
    // Strip any EMBEDDED bracketed-paste markers from the prompt content before
    // we wrap it in our own \x1b[200~…\x1b[201~ (june15-headless-spawn-reroute,
    // PR2 finding S2). A job/A2A prompt containing a literal \x1b[201~ would
    // otherwise forge a paste boundary and submit extra REPL turns — the
    // headless `-p` argv path was immune, and InputGuard only scans topic-bound
    // sessions, so rerouted job/A2A prompts need this sanitizer at the chokepoint.
    text = text.replace(/\x1b\[20[01]~/g, '');
    // Reset idle-prompt timer — this session is about to receive new input,
    // so it's not a zombie. Without this, the zombie detector can kill a session
    // that just received a message but hasn't produced output yet.
    const running = this.state.listSessions({ status: 'running' });
    const match = running.find(s => s.tmuxSession === tmuxSession);
    if (match) {
      this.idlePromptSince.delete(match.id);
      this.idleKillBackoff?.reset(match.id); // new input arriving → re-evaluate fresh, not a zombie
    }

    const exactTarget = `=${tmuxSession}:`;
    // Framework-specific submit semantics. Claude Code's readline buffers
    // the bracketed paste and accepts a single Enter ~500ms later to
    // submit. Codex's TUI takes longer to commit a paste into its
    // input state and silently discards the first Enter that arrives
    // before the commit is done — observed live: messages stacked up
    // in the input box because the post-paste Enter landed too early.
    // For codex we wait longer and send Enter twice (the second one
    // submits if the first was eaten; if both land, the second is a
    // harmless no-op against an empty buffer).
    const framework = this.getSessionFramework(tmuxSession);
    const postPasteDelaySec = framework === 'codex-cli' ? '1.5' : '0.5';
    const enterPresses = framework === 'codex-cli' ? 2 : 1;
    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // §B: the injection send-keys + /bin/sleep stay SYNCHRONOUS — their
        // synchronous timing IS the correctness mechanism (D1) and so are EXCLUDED
        // from §A async conversion — but every blocking call funnels through
        // withSyncOp so a sleep/wake drift across this sequence reads as an
        // event-loop BLOCK, not sleep.
        if (text.includes('\n')) {
          // Multi-line: use bracketed paste mode.
          // The terminal (and Claude Code's readline) treats everything between
          // \e[200~ and \e[201~ as a single paste — newlines are literal, not Enter.
          // This completely avoids load-buffer/paste-buffer and their TCC prompts.
          withSyncOp(() => execFileSync(this.config.tmuxPath, ['send-keys', '-t', exactTarget, '\x1b[200~'], {
            encoding: 'utf-8', timeout: 5000,
          }));
          withSyncOp(() => execFileSync(this.config.tmuxPath, ['send-keys', '-t', exactTarget, '-l', text], {
            encoding: 'utf-8', timeout: 10000,
          }));
          withSyncOp(() => execFileSync(this.config.tmuxPath, ['send-keys', '-t', exactTarget, '\x1b[201~'], {
            encoding: 'utf-8', timeout: 5000,
          }));
          withSyncOp(() => execFileSync('/bin/sleep', [postPasteDelaySec], { timeout: 4000 }));
          for (let i = 0; i < enterPresses; i++) {
            withSyncOp(() => execFileSync(this.config.tmuxPath, ['send-keys', '-t', exactTarget, 'Enter'], {
              encoding: 'utf-8', timeout: 5000,
            }));
            if (i < enterPresses - 1) {
              try { withSyncOp(() => execFileSync('/bin/sleep', ['0.3'], { timeout: 2000 })); } catch { /* ignore */ }
            }
          }
        } else {
          // Single-line: simple send-keys
          withSyncOp(() => execFileSync(this.config.tmuxPath, ['send-keys', '-t', exactTarget, '-l', text], {
            encoding: 'utf-8', timeout: 10000,
          }));
          for (let i = 0; i < enterPresses; i++) {
            withSyncOp(() => execFileSync(this.config.tmuxPath, ['send-keys', '-t', exactTarget, 'Enter'], {
              encoding: 'utf-8', timeout: 5000,
            }));
            if (i < enterPresses - 1) {
              try { withSyncOp(() => execFileSync('/bin/sleep', ['0.3'], { timeout: 2000 })); } catch { /* ignore */ }
            }
          }
        }
        // Track the just-injected message so the persistent StuckInputSentinel
        // can recover it if it strands at the prompt. This is the durable-across-
        // turn backstop for codex specifically: codex holds a busy-delivery as an
        // unsubmitted draft and does NOT auto-submit it when the turn ends, and a
        // long codex turn far outlasts verifyInjection's 6.5s in-process window.
        if (framework === 'codex-cli') {
          this.recordStrandedDraftMarker(tmuxSession, text, framework);
        }
        // Verify Enter actually submitted — on fresh Claude Code TUIs (v2.1.105+)
        // the Enter after bracketed-paste-end is occasionally eaten, leaving the
        // text sitting in the input box unsubmitted. verifyInjection captures the
        // pane after a short delay and sends one extra Enter if the marker text
        // is still visible at the ❯ (or codex `›`) prompt.
        this.verifyInjection(tmuxSession, text);
        return true;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[SessionManager] Failed to inject message into ${tmuxSession} (attempt ${attempt}/${maxAttempts}): ${errMsg}`);
        if (attempt < maxAttempts) {
          // Synchronous sleep between retry attempts. We use execFileSync('/bin/sleep')
          // rather than an async delay because the entire injection path is synchronous:
          // rawInject → injectMessage → injectTelegramMessage all use execFileSync for
          // tmux send-keys. Converting to async would require changing the call chain
          // through multiple callers. The 300ms pause is brief and only hits on failure
          // (max once per injection), so the event loop impact is negligible in practice.
          try { withSyncOp(() => execFileSync('/bin/sleep', ['0.3'], { timeout: 2000 })); } catch { /* ignore */ }
          continue;
        }
        DegradationReporter.getInstance().report({
          feature: 'SessionManager.injectMessage',
          primary: 'Inject Telegram message into tmux session',
          fallback: 'Message delivery failed — caller notified for user-facing error relay',
          reason: `Failed to inject message after ${maxAttempts} attempts: ${errMsg}`,
          impact: 'User message not delivered to session',
        });
        return false;
      }
    }
    return false;
  }

  /**
   * Verify an injection actually submitted by polling for a marker snippet
   * still present at the ❯ prompt. On Claude Code v2.1.105+, the Enter after
   * bracketed-paste-end is occasionally eaten by a race with the paste-end
   * sequence — and the recovery Enter can be eaten by the same race. Single-
   * shot verification leaves the user stuck when recovery also misses.
   *
   * Polls at 500/1500/3500/6500ms from injection (markerCheckSchedule),
   * stops as soon as the marker is no longer at ❯, and escalates the
   * recovery action across attempts: Enter, Enter, C-m, Enter+sleep+Enter.
   * Bounded — never more than 4 recovery actions. No-op when text submits
   * normally. Reports a single Degradation entry on first recovery firing.
   *
   * Runs asynchronously via setTimeout. Does not block the caller.
   */
  private verifyInjection(tmuxSession: string, injectedText: string): void {
    // Extract a distinguishing first-40-chars marker from the injected text.
    // Strip leading whitespace/newlines so we match what's visible at the prompt.
    const marker = injectedText.replace(/^\s+/, '').slice(0, 40).trim();
    if (!marker || marker.length < 8) return; // too short to be a reliable marker

    // Polling schedule in ms from injection. Each entry is the absolute
    // time-from-injection at which that attempt fires. Stops on success
    // (marker no longer at ❯) or after the last entry.
    const markerCheckSchedule = [500, 1500, 3500, 6500];
    let recoveryFiredOnce = false;

    const runCheck = (attempt: number): void => {
      try {
        if (!this.tmuxSessionExists(tmuxSession)) return;
        const pane = this.captureOutput(tmuxSession, 30) || '';
        if (!this.isMarkerStuckAtPrompt(pane, marker)) {
          // Submitted (or marker no longer at the input prompt) — stop polling
          // and release the stranded-draft marker so the sentinel doesn't keep
          // re-checking a message that already landed.
          this.clearStrandedDraftMarker(tmuxSession);
          return;
        }

        // The marker is at the prompt — but if the session is actively working,
        // that's NOT a stuck Enter: the injected text is correctly queued and
        // Claude submits it when the current turn ends. Firing Enter now is a
        // no-op at best and a premature/duplicate submit at worst — and it's
        // the noisy "Injection stuck — Auto-recovering" spam that fires on
        // every inbound to a busy session. Skip recovery this tick; keep
        // polling in case it's still stuck once the turn completes.
        if (this.paneShowsActiveWork(pane)) {
          const nextIdx = attempt + 1;
          if (nextIdx < markerCheckSchedule.length) {
            const delay = markerCheckSchedule[nextIdx] - markerCheckSchedule[attempt];
            setTimeout(() => runCheck(nextIdx), delay);
          }
          return;
        }

        // Still stuck. Fire escalating recovery action.
        this.fireStuckInputRecovery(tmuxSession, attempt);

        if (!recoveryFiredOnce) {
          recoveryFiredOnce = true;
          console.warn(`[SessionManager] Injection stuck in "${tmuxSession}" — marker "${marker.slice(0, 30)}…" still at prompt. Auto-recovering (attempt ${attempt + 1}/${markerCheckSchedule.length}).`);
          DegradationReporter.getInstance().report({
            feature: 'SessionManager.verifyInjection',
            primary: 'Bracketed paste + Enter submits injected message',
            fallback: 'Auto-resent Enter after detecting stuck input',
            reason: 'Enter eaten by paste-end race on fresh Claude Code TUI',
            impact: 'Recovered without user intervention',
          });
        }

        // Schedule next check if we have attempts remaining.
        const nextIdx = attempt + 1;
        if (nextIdx < markerCheckSchedule.length) {
          const delay = markerCheckSchedule[nextIdx] - markerCheckSchedule[attempt];
          setTimeout(() => runCheck(nextIdx), delay);
        }
      } catch (err) {
        // Best-effort — never throw from a background verification
        console.error(`[SessionManager] verifyInjection error for "${tmuxSession}" attempt ${attempt}: ${err instanceof Error ? err.message : err}`);
      }
    };

    setTimeout(() => runCheck(0), markerCheckSchedule[0]);
  }

  /**
   * Detect whether a marker snippet of injected text is still sitting at an
   * input prompt line in the captured pane. Matches the marker on the same
   * line as the prompt char or on the immediately-following line (TUIs wrap
   * long input across two visible rows).
   *
   * Recognises BOTH framework prompt chars: Claude Code's `❯` and codex's `›`
   * (U+203A). Marker-based detection is deliberate for codex — codex renders a
   * dim placeholder hint (e.g. "Explain this codebase") at an EMPTY `›` prompt
   * that is byte-identical to real input once color is stripped, so reading the
   * prompt text generically would false-fire on every idle codex session. The
   * injected marker never equals the placeholder, so matching it is robust.
   *
   * Exposed as a method so StuckInputSentinel and tests can reuse it.
   */
  isMarkerStuckAtPrompt(pane: string, marker: string): boolean {
    if (!marker || marker.length < 8) return false;
    const lines = pane.split('\n');
    const shortMarker = marker.slice(0, 30);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Claude Code uses ❯, codex uses › as the input-prompt char. Gemini CLI has
      // NEITHER — it renders its input inside a rounded border, and the active
      // input line is "│ * <text>" (box pipe + bullet). Without recognizing that,
      // an injected message sitting unsubmitted in a Gemini box was never detected
      // as stuck, so verifyInjection's Enter-recovery never fired for Gemini and
      // forwarded prompts stalled in the input box. The marker-in-line check below
      // still gates it, so "│ *" only matches when the injected marker is on that
      // line — a normal bulleted output line can't false-fire.
      const hasPromptChar = line.includes('❯') || line.includes('›') || /│\s+\*/.test(line);
      if (hasPromptChar && (line.includes(marker) || (lines[i + 1] && lines[i + 1].includes(shortMarker)))) {
        return true;
      }
      // pi has NO prompt char at all — its input box is a bare text line
      // SANDWICHED between two horizontal-rule lines (verified by live pane
      // capture, P0.1 eval pi 0.78.1):
      //   ────────────────────────────
      //   STUCK-MARKER-TEXT …
      //   ────────────────────────────
      // Submitted transcript text is never between two rules, so requiring a
      // rule within 2 lines BOTH above and below (the tolerance covers a long
      // input wrapping to a second row) plus the marker match cannot
      // false-fire on normal output. Without this branch, an injected message
      // stranded in pi's input box would never be detected as stuck and the
      // Enter-recovery would never fire (the Gemini lesson, same shape).
      if (line.includes(marker) || (lines[i + 1] && lines[i + 1].includes(shortMarker))) {
        const isRule = (l: string | undefined): boolean => !!l && /^\s*─{10,}\s*$/.test(l);
        const ruleAbove = isRule(lines[i - 1]) || isRule(lines[i - 2]);
        const ruleBelow = isRule(lines[i + 1]) || isRule(lines[i + 2]);
        if (ruleAbove && ruleBelow) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Extract the distinguishing first-40-chars marker from injected text, the
   * same way verifyInjection and the pending-injection map do. Returns null if
   * the text is too short to be a reliable marker (<8 visible chars). Shared so
   * the recorded marker and the verification marker can never drift apart.
   */
  static extractInjectionMarker(injectedText: string): string | null {
    const marker = injectedText.replace(/^\s+/, '').slice(0, 40).trim();
    if (!marker || marker.length < 8) return null;
    return marker;
  }

  /**
   * Record that `text` was just injected into `tmuxSession` and has not yet been
   * confirmed submitted. Only the latest injection per session is tracked
   * (a newer message supersedes an older stuck one). No-op when the marker is
   * too short to track reliably. See the strandedDraftMarkers field for why this
   * primarily matters for codex sessions. */
  recordStrandedDraftMarker(tmuxSession: string, text: string, framework: string): void {
    const marker = SessionManager.extractInjectionMarker(text);
    if (!marker) return;
    this.strandedDraftMarkers.set(tmuxSession, { marker, framework, injectedAt: Date.now() });
  }

  /** Read the stranded-draft marker record for a session (or undefined). Used by
   *  StuckInputSentinel to do marker-based recovery for codex sessions. */
  getStrandedDraftMarker(tmuxSession: string): { marker: string; framework: string; injectedAt: number } | undefined {
    return this.strandedDraftMarkers.get(tmuxSession);
  }

  /** Clear the stranded-draft marker for a session — called once the marker is
   *  no longer stuck at the prompt (confirmed submitted) or the session is
   *  gone. */
  clearStrandedDraftMarker(tmuxSession: string): void {
    this.strandedDraftMarkers.delete(tmuxSession);
  }

  /** All tmux sessions with a stranded-draft marker. Used by the sentinel to GC
   *  records for sessions that are no longer running. */
  strandedDraftMarkerSessions(): string[] {
    return [...this.strandedDraftMarkers.keys()];
  }

  /**
   * Fire one recovery action for a stuck input. Escalates the action by
   * attempt index — early attempts use plain Enter, later attempts use
   * C-m (literal carriage return) or Enter+sleep+Enter to defeat tighter
   * race windows. Bounded; called from verifyInjection's polling loop and
   * from the persistent StuckInputSentinel after a server restart.
   */
  fireStuckInputRecovery(tmuxSession: string, attempt: number): void {
    const target = `=${tmuxSession}:`;
    const tmuxPath = this.config.tmuxPath;
    try {
      // §B: the stuck-input recovery send-keys stay sync (escalating timing IS the
      // mechanism) but funnel through withSyncOp for the marker.
      if (attempt === 0 || attempt === 1) {
        withSyncOp(() => execFileSync(tmuxPath, ['send-keys', '-t', target, 'Enter'], { encoding: 'utf-8', timeout: 5000 }));
      } else if (attempt === 2) {
        // Escalate: literal carriage-return — bypasses any Enter-specific consumer.
        withSyncOp(() => execFileSync(tmuxPath, ['send-keys', '-t', target, 'C-m'], { encoding: 'utf-8', timeout: 5000 }));
      } else {
        // Final attempt: Enter, brief sleep, Enter — covers sub-second consume races.
        withSyncOp(() => execFileSync(tmuxPath, ['send-keys', '-t', target, 'Enter'], { encoding: 'utf-8', timeout: 5000 }));
        try { withSyncOp(() => execFileSync('/bin/sleep', ['0.15'], { timeout: 1000 })); } catch { /* @silent-fallback-ok — sleep is best-effort */ }
        withSyncOp(() => execFileSync(tmuxPath, ['send-keys', '-t', target, 'Enter'], { encoding: 'utf-8', timeout: 5000 }));
      }
    } catch (err) {
      console.error(`[SessionManager] fireStuckInputRecovery error for "${tmuxSession}" attempt ${attempt}: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Wait for Claude to be ready in a tmux session by polling output.
   * Looks for Claude Code's prompt character (❯) which appears when ready for input.
   */
  async waitForClaudeReady(tmuxSession: string, timeoutMs: number = 30000): Promise<boolean> {
    const start = Date.now();
    // Wait a minimum startup delay before checking (Claude needs time to load)
    await new Promise(r => setTimeout(r, 3000));
    while (Date.now() - start < timeoutMs) {
      if (!this.tmuxSessionExists(tmuxSession)) {
        console.error(`[SessionManager] Session "${tmuxSession}" died during startup`);
        return false;
      }
      if (this.detectClaudePrompt(tmuxSession)) {
        console.log(`[SessionManager] Claude ready in "${tmuxSession}" after ${Date.now() - start}ms`);
        return true;
      }
      await new Promise(r => setTimeout(r, 500));
    }
    // Log what we see on timeout for debugging
    const finalOutput = this.captureOutput(tmuxSession, 30);
    console.error(`[SessionManager] Claude not ready in "${tmuxSession}" after ${timeoutMs}ms. Output: ${(finalOutput || '').slice(-300)}`);
    return false;
  }

  /**
   * Detect whether Claude Code's prompt is visible in a tmux session.
   * Also auto-accepts consent dialogs that block startup.
   *
   * Checks multiple indicators across a wider capture window to handle
   * varying TUI layouts (different terminal sizes, large banners, etc.)
   */
  private detectClaudePrompt(tmuxSession: string): boolean {
    // Capture a generous window — Claude Code's TUI can have many blank lines
    // below the prompt in large panes. Using only 5 lines risks missing content.
    const output = this.captureOutput(tmuxSession, 20);
    if (!output) return false;

    const lines = output.split('\n').filter(l => l.trim());
    if (lines.length === 0) return false;

    // Auto-accept consent/ToS dialogs that block startup.
    // Claude Code shows "1. No, exit / 2. Yes, I accept" on first run or after updates.
    // If we don't accept, any injected text selects "No" and crashes the session.
    const fullText = lines.join('\n');
    if (fullText.includes('Yes, I accept') && fullText.includes('No, exit')) {
      console.log(`[SessionManager] Consent dialog detected in "${tmuxSession}" — auto-accepting`);
      try {
        // Press Down to select "Yes, I accept", then Enter to confirm
        withSyncOp(() => execFileSync(this.config.tmuxPath, ['send-keys', '-t', `=${tmuxSession}:`, 'Down'], {
          encoding: 'utf-8', timeout: 5000,
        }));
        withSyncOp(() => execFileSync(this.config.tmuxPath, ['send-keys', '-t', `=${tmuxSession}:`, 'Enter'], {
          encoding: 'utf-8', timeout: 5000,
        }));
      } catch {
        // Best-effort — if this fails, the session will be stuck but not crashed
      }
      return false; // Not ready yet — will be ready on next poll
    }

    // Check the last 6 non-blank lines for readiness indicators.
    // Claude Code's TUI shows: prompt (❯), status bar (bypass permissions / model info),
    // and separators. Using a wider tail catches all of these even when
    // blank lines or separators push them around.
    const tail = lines.slice(-6).join('\n');

    // Primary: the prompt character
    if (tail.includes('❯')) return true;

    // Secondary: permission mode indicators (visible in status bar)
    if (tail.includes('bypass permissions')) return true;

    // Tertiary: model/effort indicators in the status bar
    // These appear when Claude Code has fully loaded and is ready for input.
    if (/\/(effort|model|fast)/.test(tail)) return true;

    // Quaternary: the "medium · /effort" or "high · /effort" pattern
    if (/(?:low|medium|high)\s*·\s*\/effort/.test(tail)) return true;

    return false;
  }

  /**
   * Wait for Claude to be ready with a two-phase approach:
   * 1. Primary wait: poll for the prompt within the timeout
   * 2. Extended wait: if the session is alive but prompt wasn't detected,
   *    do a final longer check — Claude may have just finished loading
   *
   * This handles cases where Claude Code takes longer than expected due to
   * API auth refresh, large CLAUDE.md parsing, session-start hooks, or
   * network latency. The extended phase catches sessions that are "almost ready."
   */
  private async waitForClaudeReadyWithRetry(tmuxSession: string, timeoutMs: number): Promise<boolean> {
    const ready = await this.waitForClaudeReady(tmuxSession, timeoutMs);
    if (ready) return true;

    // Session not ready after primary timeout — check if it's still alive
    if (!this.tmuxSessionExists(tmuxSession)) {
      return false;
    }

    // Extended wait: the session is alive but prompt wasn't detected.
    // Give it one more chance with a 15-second grace period.
    // This catches the case where Claude Code was almost done loading
    // when the primary timeout hit.
    console.log(`[SessionManager] Session "${tmuxSession}" alive after primary timeout — starting 15s extended wait`);
    const extendedStart = Date.now();
    while (Date.now() - extendedStart < 15_000) {
      if (!this.tmuxSessionExists(tmuxSession)) {
        return false;
      }
      if (this.detectClaudePrompt(tmuxSession)) {
        console.log(`[SessionManager] Claude ready in "${tmuxSession}" during extended wait (${Date.now() - extendedStart}ms after primary timeout)`);
        return true;
      }
      await new Promise(r => setTimeout(r, 1000));
    }

    return false;
  }

  tmuxSessionExists(name: string): boolean {
    try {
      // §B: request-route existence check stays sync (§A excludes it) but funnels
      // through withSyncOp for the in-flight marker.
      withSyncOp(() => execFileSync(this.config.tmuxPath, ['has-session', '-t', `=${name}`], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      }));
      return true;
    } catch {
      // @silent-fallback-ok — session existence check
      return false;
    }
  }

  private generateId(): string {
    return randomUUID();
  }
}

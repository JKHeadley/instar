/**
 * PromiseBeacon — Follow-through heartbeats for open agent commitments.
 *
 * Implements the Phase 1 scope of docs/specs/PROMISE-BEACON-SPEC.md.
 *
 * When the agent says "I'll come back when X finishes" and then works silently
 * for 30+ minutes, the user has no signal whether the agent is alive,
 * progressing, or has forgotten. PromiseBeacon watches beacon-enabled
 * commitments (Commitment rows with `beaconEnabled: true` and a `topicId`)
 * and emits a short status line on a per-commitment cadence.
 *
 * Key properties:
 *  - setTimeout-based scheduling (not polling); durable across sleep by
 *    persisting `nextDueAt` (spec Round 3 #17).
 *  - Per-commitment hot state at .instar/state/promise-beacon/<id>.json
 *    (gitignored).
 *  - Snapshot-hash gate: unchanged tmux output emits a templated line
 *    without calling the LLM (≈70% of heartbeats on a quiet session).
 *  - Session-epoch check: if the Claude Code session UUID at declaration
 *    no longer matches the live session, transition to `violated` with
 *    reason `session-lost`.
 *  - Quiet hours + daily spend cap → `beaconSuppressed` (non-terminal).
 *  - Shares the LlmQueue and ProxyCoordinator with PresenceProxy so the
 *    two monitors can't double-post.
 *
 * Integration points:
 *  - `commitmentTracker.mutate(id, fn)` is the only write path.
 *  - `sendMessage(topicId, text, { source: 'promise-beacon', isProxy: true })`
 *    is what PresenceProxy's `isSystemOrProxyMessage` filters out.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { EventEmitter } from 'node:events';
import type { CommitmentTracker, Commitment } from './CommitmentTracker.js';
import type { LlmQueue } from './LlmQueue.js';
import { LlmAbortedError } from './LlmQueue.js';
import type { ProxyCoordinator } from './ProxyCoordinator.js';
import { sanitizeTmuxOutput, guardProxyOutput } from './PresenceProxy.js';
import { detectInternalIdLeak } from '../core/internal-id-leak.js';

// ─── Config & types ─────────────────────────────────────────────────────────

export interface PromiseBeaconConfig {
  stateDir: string;
  commitmentTracker: CommitmentTracker;
  llmQueue: LlmQueue;
  proxyCoordinator: ProxyCoordinator;

  // Callbacks
  captureSessionOutput: (sessionName: string, lines?: number) => string | null;
  getSessionForTopic: (topicId: number) => string | null;
  isSessionAlive: (sessionName: string) => boolean;
  /**
   * Count of LIVE sessions bound to a topic. Feeds the double-spawn detector
   * (PROMISE-BEACON-ESCALATION-SPEC §6): two distinct live sessions for one
   * topic while a commitment is `escalationInFlight` is the partition/race
   * double-spawn signature, and the rollout hard-stop signal. Optional — when
   * unset, the detector is inert (single-machine installs that can't observe it).
   */
  liveSessionCountForTopic?: (topicId: number) => number;
  getSessionEpoch?: (sessionName: string) => string | null;
  sendMessage: (
    topicId: number,
    text: string,
    metadata?: { source: 'promise-beacon'; isProxy: true; tier?: number },
  ) => Promise<void>;
  /**
   * durable-conversation-identity §6.1 step 2 — the funnel swap. When wired,
   * EVERY beacon user-send routes through `deliverToConversation` (typed §5.1
   * outcomes, the §5.0(a) E1 guard keyed on `<commitmentId>:<sendSeq>`, the
   * §3.5.2 boundTuple delivery rule). Absent → the legacy sendMessage path is
   * preserved byte-for-byte.
   */
  deliverMessage?: (
    topicId: number,
    text: string,
    opts: {
      source: 'promise-beacon';
      isProxy: true;
      tier?: number;
      logicalSendId: string;
      boundTuple?: { platform: 'slack'; channelId: string; threadTs: string | null };
    },
  ) => Promise<import('../core/deliverToConversation.js').DeliveryOutcome>;
  /** §5.0(a): journal `op:"send-retire"` for a delivered/delivered-equivalent
   *  logical send — called AFTER the sendSeq persist (the R5-M3 pinned order). */
  retireSend?: (conversationId: number, logicalSendId: string) => void;
  /** §5.0 ownership predicate (`ownsConversation(id)`) — drives the R3-M16
   *  stand-down recheck riding the external-block sweep. */
  ownsConversation?: (conversationId: number) => boolean;
  /** §5.1 R3-M15: consecutive `not-delivered` results before the dead-letter
   *  attention item (distinct from deadLetterAttentionAfter=1 — the item
   *  dedupes once the state is reached). Default 3. */
  deadLetterAfterConsecutiveFailures?: number;
  /** Haiku-class LLM call returning a short status line. */
  generateStatusLine?: (
    promiseText: string,
    tmuxOutput: string,
    signal: AbortSignal,
  ) => Promise<string>;
  /**
   * Haiku-class classifier — returns a `concern` verdict used as a signal-only
   * input to the atRisk transition. The beacon never auto-transitions to
   * `violated` on this signal; authority for terminal `violated` is held by
   * hard corroboration (session death / hard deadline). Per spec Round 3 #1.
   *
   * Return shape:
   *  - `working`  — normal heartbeat, atRisk cleared.
   *  - `stalled`  — the beacon sets `atRisk: true` (non-terminal), emits a
   *                 softer line, and doubles cadence until the next check.
   *                 Two consecutive `stalled` verdicts spanning ≥30 min
   *                 remain a signal-only state here; the terminal promotion
   *                 still requires a hard corroborating event.
   */
  classifyProgress?: (
    promiseText: string,
    tmuxOutput: string,
    signal: AbortSignal,
  ) => Promise<'working' | 'stalled'>;

  // Settings (all spec-defaulted, per-agent overridable via config.json)
  prefix?: string;                   // Default: "⏳"
  maxDailyLlmSpendCents?: number;    // Default: 100
  sentinelAutoEnable?: boolean;      // Default: false
  quietHours?: { start: string; end: string; timezone?: string }; // "22:00-08:00" local
  /** Current machine id (ownership gate). */
  currentMachineId?: string;
  /**
   * WS3 one-voice gate (MULTI-MACHINE-SEAMLESSNESS-SPEC): when wired, the
   * election decides whether THIS machine speaks for the commitment's topic —
   * live placement first, the commitment's ownerMachineId stamp as fallback,
   * failing toward speech via lease-holder/tiebreak so unknown ownership never
   * silences the pool. Absent → the legacy static gate applies unchanged.
   */
  speakerElection?: import('./SpeakerElection.js').SpeakerElection;
  /** Floor for heartbeat cadence (ms). Default 60_000. */
  minCadenceMs?: number;
  /** Ceiling for heartbeat cadence (ms). Default 21_600_000 (6h). */
  maxCadenceMs?: number;
  /** Dev-only timer multiplier for tests. */
  __dev_timerMultiplier?: number;
  /** Injectable clock for tests. */
  now?: () => number;
  /**
   * Max active beacons per agent (boot-cap). When more beacon-enabled pending
   * commitments exist at `start()`, the overflow is marked `beaconSuppressed`
   * with reason `boot-cap-exceeded` (non-terminal; status stays `pending`).
   * Spec Round 3 #2. Default: 20.
   */
  maxActiveBeacons?: number;
  /**
   * Default cycle count for auto-pause when a commitment doesn't specify
   * `beaconAutoPauseAfterUnchanged`. At default 10-min cadence, 4 cycles
   * ≈ 40 minutes of silence before the beacon stops firing. After this
   * threshold the user gets one final "auto-paused — reply 'keep watching'
   * to resume" message and the timer stops. Set to 0 to disable globally.
   * Default 4.
   */
  defaultAutoPauseAfterUnchanged?: number;
  /**
   * HONEST-PROGRESS-MESSAGING B1 — when the tmux snapshot is UNCHANGED, send
   * nothing (the "still on it, no new output" line carried zero information and
   * was the user's #1 noise complaint). The unchanged-count is still tracked for
   * atRisk/auto-pause accounting; only the message is withheld. The beacon still
   * speaks on genuine new output, atRisk, close-out, a deadline (B1a), or a
   * sparse liveness tick (B1b). Default `true`; set `false` to restore the old
   * every-tick templated heartbeat (rollback path). */
  suppressUnchangedHeartbeats?: boolean;
  /**
   * HONEST-PROGRESS-MESSAGING B1b — sparse liveness. When unchanged heartbeats
   * are suppressed, a genuinely long task would otherwise go fully dark. At most
   * ONE "still watching, N min in" line is emitted per this interval while a
   * session is still present and its turn is not finished. Default 60m. */
  beaconLivenessIntervalMs?: number;
  /**
   * HONEST-PROGRESS-MESSAGING B2 / FD-1 — turn-finished close-out. When the
   * session's live frame shows a finished/idle turn (no active-work indicator)
   * for this many consecutive checks, the beacon emits ONE close-out prompt and
   * auto-pauses (no clockwork heartbeats into a finished room). Default 3
   * (≈60m at 20m cadence — rules out a momentary prompt-like frame mid-task). */
  turnFinishedCloseoutChecks?: number;
  /**
   * HONEST-PROGRESS-MESSAGING B2 — detector for "is this session still actively
   * working?" (wired to looksActivelyWorking on the live frame). When absent,
   * turn-finished close-out is inactive (degrades safely). */
  looksActivelyWorking?: (frame: string, sessionName: string) => boolean;

  // ── Escalation (PROMISE-BEACON-ESCALATION-SPEC §3–§5) ──────────────────────
  /**
   * When set, a commitment whose owning session has died is ESCALATED (revive →
   * honest status → loud give-up) instead of being silently terminalized to
   * `violated: session-lost`. When absent/disabled, the legacy immediate
   * `transitionViolated(c, 'session-lost')` behavior is preserved exactly.
   */
  escalation?: EscalationConfig;
  /**
   * Request a fresh session bound to `topicId`, carrying the CONTINUATION
   * payload + the `revivalMode` marker + the `escalationAttemptId` idempotency
   * key (I14). Returns the spawned session name on success, null on refusal.
   * `refusalReason` (quota/lease/unbound/budget/disabled) is reported via the
   * resolve callback's return when null. Wired to SpawnRequestManager.
   */
  requestRevive?: (req: ReviveRequest) => Promise<ReviveResult>;
  /** Raise ONE deduped operator Attention item for a Rung-3 give-up (§3.3). */
  raiseAttention?: (commitmentId: string, detail: string) => void;
  /**
   * C1+C2 "The Agent Carries the Loop" rollout resolver (spec
   * agent-owned-followthrough §4.8). Returns the live feature state for the
   * owner-gated outbound chokepoint (emitUserSend). ABSENT or `enabled:false`
   * ⇒ the chokepoint is a strict no-op (current behavior preserved — beacon
   * sends go out normally regardless of owner). `enabled:true, dryRun:true`
   * ⇒ logs the intended suppression/reroute but STILL sends (observe-first).
   * `enabled:true, dryRun:false` ⇒ actually suppresses status under
   * owner:'agent' and reroutes a terminal send to the Attention dead-letter.
   * Wired dark-on-fleet / live-on-dev via the developmentAgent gate.
   */
  agentOwnedFollowthrough?: () => { enabled: boolean; dryRun: boolean };
  /** §4.4 external-block staleness window (no probe within → dead-letter). Default 24h. */
  externalBlockWindowMs?: number;
  /** §4.4 absolute external-wait ceiling (dead-letter regardless of probes). Default 14d. */
  externalBlockCeilingMs?: number;
  /** §4.4 governor sweep cadence. Default 1h (a slow closer, off the hot verify path). */
  externalBlockSweepMs?: number;
  /**
   * §4.4/§4.5 — lease gate for the governor + reconciler sweep. Returns true when
   * this machine should run the (mutating) sweep — one machine in a pool. Default
   * (absent) → always run (single-machine / unconfigured is a safe no-op).
   */
  holdsLease?: () => boolean;
}

/** Escalation tunables (§5). All code-defaulted; dev-gated `enabled`. */
export interface EscalationConfig {
  enabled: boolean;
  dryRun: boolean;
  maxEscalationAttempts?: number;       // §5 default 3
  minEscalationIntervalMs?: number;     // §5 default 120_000 (hard floor)
  maxConcurrentEscalations?: number;    // §5 default 2 (I9 global semaphore)
  maxEscalationSpawnsPerTick?: number;  // §5 default 1 (I9 per-tick cap)
  reviveSettleMs?: number;              // §5 default 30_000
  escalationGraceMs?: number;           // §5 default 10_000
  rung2MaxNotifications?: number;       // §5 default 4 (§3.2 bounded)
  rung2MinIntervalMs?: number;          // §5 default 1_800_000 (per-commitment floor)
  rung2DigestWindowMs?: number;         // §5 default 600_000 (per-topic coalesce, I12)
  revalidationTtlMs?: number;           // §5 default 1_800_000
}

/**
 * The beacon-side classification of one user-send attempt (durable-
 * conversation-identity §5.1/§5.0(a)). `suppressed-delivered-equivalent` is
 * the E1 `already-delivered-recently` outcome — treated as delivered for
 * sequencing (R7-M1), never an escalation.
 */
export type BeaconSendResult =
  | 'sent'
  | 'suppressed-delivered-equivalent'
  | 'failed-transient'
  | 'failed-standdown'
  | 'failed-permanent'
  | 'suppressed-aoft'
  | 'rerouted-terminal'
  | 'skipped';

/** Recoverability state → one approved Rung-2 message template (§3.2). */
export type RecoverabilityState =
  | 'retryable'
  | 'owner-gone'
  | 'quota-limited'
  | 'disabled'
  | 'operator-needed';

export interface ReviveRequest {
  topicId: number;
  commitmentId: string;
  /** Idempotency key — a duplicate request with the same id is a no-op (I14). */
  escalationAttemptId: string;
  /** Untrusted, fenced commitment text for the CONTINUATION payload (I8). */
  userRequest: string;
  agentResponse: string;
}

export interface ReviveResult {
  /** Spawned/queued session name, or null when refused. */
  sessionName: string | null;
  /** When refused, why — drives the Rung-2 recoverability state + audit (§6). */
  refusalReason?: 'quota' | 'lease' | 'unbound' | 'budget' | 'disabled' | 'resume-queue-owns';
}

interface HotState {
  lastHeartbeatAt?: string;
  heartbeatCount: number;
  lastSnapshotHash?: string;
  sessionEpoch?: string;
  consecutiveUnchanged: number;
  templatedVariantCursor: number;
  /**
   * §5.0(a) R3-M2 — the DURABLE, MONOTONIC send sequence. `logicalSendId` =
   * `<commitmentId>:<sendSeq>` (the §3.4 pinned encoding). Advanced on a
   * DELIVERED outcome and on a DELIVERED-EQUIVALENT `already-delivered-
   * recently` outcome (R7-M1); held constant across `not-delivered`/ambiguous
   * outcomes ONLY — so the ambiguous re-fire matches the E1 guard and the
   * next real heartbeat never does. Persisted via the atomic tmp→rename
   * write (R4-minor-1).
   */
  sendSeq?: number;
  /** §5.1: consecutive typed `not-delivered` results (owning-machine real
   *  failures ONLY — never a stand-down refusal, I1 scoping). */
  consecutiveDeliveryFailures?: number;
  /** Dedupes the dead-letter attention item once the state is reached
   *  (deadLetterAttentionAfter = 1). Cleared on the next delivered outcome. */
  deliveryDeadLetteredAt?: string;
  /** §5 R3-M16 non-owning STAND-DOWN marker (restart-safe): no re-fire
   *  scheduling until the ownership recheck clears it. */
  standDownAt?: string;
  /** B1b — wall-clock (ISO) of the last sparse-liveness line, so it fires at most
   *  once per beaconLivenessIntervalMs. */
  lastLivenessAt?: string;
  /** B2 — consecutive checks where the session's live frame read as turn-finished
   *  (idle, no active-work indicator). Close-out fires at turnFinishedCloseoutChecks. */
  consecutiveTurnFinished?: number;
}

// Rotating templated phrases (spec Round 3 #9).
const TEMPLATED_VARIANTS = [
  'still on it, no new output since last update',
  'still working — snapshot unchanged since last beat',
  'holding steady on this task — no fresh output yet',
  'continuing; terminal quiet since last check-in',
  'alive, working — no visible change since last heartbeat',
];

const AT_RISK_VARIANTS = [
  'no observable progress — may be waiting on external input',
  'still watching; appears idle — flagging at-risk',
  'no recent output; continuing to monitor',
];

// ─── Helper: snapshot normalization before hashing (spec §P14 + #16a) ──────

function normalizeForHash(raw: string): string {
  let s = raw;
  // Strip ANSI CSI.
  s = s.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
  // Control chars except \n \t.
  s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  // Spinners → placeholder.
  s = s.replace(/[\u2807\u2819\u2839\u2838\u283C\u2834\u2826\u2827\u2807\u280F]/g, '·');
  // Timestamps → [TS].
  s = s.replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, '[TS]');
  s = s.replace(/\b\d{1,2}:\d{2}:\d{2}\b/g, '[TS]');
  // Progress counters.
  s = s.replace(/\b\d+(?:\.\d+)?\s?%\b/g, '[PROG]');
  s = s.replace(/\b\d+\/\d+\s+bytes\b/g, '[PROG]');
  s = s.replace(/\biter[=\s]\d+\b/gi, '[CTR]');
  // Trailing whitespace + blank lines collapse.
  s = s.split('\n').map(l => l.replace(/\s+$/, '')).filter((_l, i, arr) => {
    // Collapse >1 consecutive blank lines.
    return !(i > 0 && arr[i] === '' && arr[i - 1] === '');
  }).join('\n');
  return s.trim();
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/**
 * Build a short promise-text excerpt to suffix on heartbeat messages so the
 * user can tell *which* watched promise this heartbeat is about.
 *
 * Prefers `agentResponse` (what the agent actually said it would do),
 * falls back to `userRequest`. Strips newlines, collapses whitespace,
 * truncates with an ellipsis at ~80 chars on a word boundary.
 *
 * Returns an empty string if no usable text is available (defensive only —
 * a commitment without either field is malformed).
 */
function promiseExcerpt(c: Pick<Commitment, 'agentResponse' | 'userRequest'>): string {
  const raw = (c.agentResponse || c.userRequest || '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  const MAX = 80;
  let excerpt: string;
  if (raw.length <= MAX) {
    excerpt = raw;
  } else {
    const cut = raw.slice(0, MAX);
    const lastSpace = cut.lastIndexOf(' ');
    const boundary = lastSpace > 40 ? lastSpace : MAX;
    excerpt = cut.slice(0, boundary) + '…';
  }
  // HONEST-PROGRESS-MESSAGING B5 / FD-7 — the excerpt derives from LLM- or
  // user-originated commitment text and is embedded in every user-facing beacon
  // surface. Run it through the same proxy guard applied to tmux-derived status
  // lines; unsafe content falls back to a neutral placeholder.
  const guard = guardProxyOutput(excerpt);
  return guard.safe ? excerpt : 'this task';
}

// Human-friendly remaining-time string for the deadline-pressure line (B1a).
function humanizeMs(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60_000));
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `${hours}h ${rem}m` : `${hours}h`;
}

/**
 * Redact secret-shaped content from a Rung-2 excerpt (I10). Drops the excerpt
 * entirely (→ generic phrasing) if it contains an API-key / token / password
 * signature; otherwise returns it unchanged.
 */
function redactSecrets(excerpt: string): string {
  if (!excerpt) return '';
  const SECRET = /\b(sk-[A-Za-z0-9]{12,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{12,}|(?:secret|password|passwd|api[_-]?key|token|bearer)\b\s*[:=]?\s*\S{6,})/i;
  return SECRET.test(excerpt) ? '' : excerpt;
}

/**
 * The ONE approved Rung-2 message per recoverability state (§3.2). Wording is
 * conditional on what's actually true — never a false "still working", never a
 * resume promise the agent can't keep. `'disabled'` emits no user message.
 */
function rung2Message(state: RecoverabilityState, excerpt: string): string | null {
  const re = excerpt ? ` *${excerpt}*` : ' an action I promised you';
  switch (state) {
    case 'retryable':
      return `⏳ Still on${re} — my session ended; I'm picking it back up.`;
    case 'owner-gone':
      return `⏳ Still open:${re}. My session ended and I can't auto-resume this right now — an operator may need to step in.`;
    case 'quota-limited':
      return `⏳ Still open:${re}. Paused while I'm at capacity; I'll resume when there's headroom.`;
    case 'operator-needed':
      return `⚠️ I couldn't get back to${re} automatically and have flagged it for attention.`;
    case 'disabled':
    default:
      return null;
  }
}

// Cap tmux capture (spec #16b).
function capOutput(raw: string, maxBytes = 4096, maxLines = 200): string {
  const lines = raw.split('\n').slice(-maxLines);
  let out = lines.join('\n');
  if (Buffer.byteLength(out, 'utf8') > maxBytes) {
    out = out.slice(-maxBytes);
  }
  return out;
}

// ─── Main class ─────────────────────────────────────────────────────────────

export class PromiseBeacon extends EventEmitter {
  private config: PromiseBeaconConfig;
  private started = false;
  private stateDir: string;
  private timers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  /** C1+C2 §4.4 — the periodic external-block staleness governor sweep timer. */
  private externalBlockSweepTimer?: ReturnType<typeof setInterval>;
  private prefix: string;
  private minCadenceMs: number;
  private maxCadenceMs: number;
  private timerMult: number;
  private now: () => number;
  private maxActiveBeacons: number;
  private defaultAutoPauseAfterUnchanged: number;
  // Escalation (resolved defaults; null when the feature is off).
  private esc: Required<Omit<EscalationConfig, 'enabled' | 'dryRun'>> & { enabled: boolean; dryRun: boolean } | null;
  /** Global in-flight revive count (I9 semaphore). */
  private escInFlightGlobal = 0;
  /** Per-tick spawn budget consumed within the current fire() tick window (I9). */
  private escSpawnsThisTick = 0;
  private escTickAnchorMs = 0;
  /** Double-spawn detection counter (§6) — must stay 0; rollout stop signal. */
  private doubleSpawnCount = 0;
  /** AttemptIds already counted as a double-spawn (dedupe per episode, §6). */
  private doubleSpawnCountedAttempts = new Set<string>();
  /** §5 R3-M16 STAND-DOWN set: commitments whose delivery hit a by-design
   *  non-owning refusal — no re-fire scheduling; re-evaluated on the bounded
   *  ownership recheck riding the external-block sweep (no new timer). */
  private stoodDown = new Set<string>();

  constructor(config: PromiseBeaconConfig) {
    super();
    this.config = config;
    this.prefix = config.prefix ?? '⏳';
    this.minCadenceMs = config.minCadenceMs ?? 60_000;
    this.maxCadenceMs = config.maxCadenceMs ?? 21_600_000;
    this.timerMult = config.__dev_timerMultiplier ?? 1.0;
    this.now = config.now ?? (() => Date.now());
    this.maxActiveBeacons = config.maxActiveBeacons ?? 20;
    this.defaultAutoPauseAfterUnchanged = config.defaultAutoPauseAfterUnchanged ?? 4;
    this.stateDir = path.join(config.stateDir, 'state', 'promise-beacon');
    try { fs.mkdirSync(this.stateDir, { recursive: true }); } catch { /* ok */ }

    const e = config.escalation;
    this.esc = (e && e.enabled) ? {
      enabled: true,
      dryRun: e.dryRun ?? true,
      maxEscalationAttempts: e.maxEscalationAttempts ?? 3,
      minEscalationIntervalMs: e.minEscalationIntervalMs ?? 120_000,
      maxConcurrentEscalations: e.maxConcurrentEscalations ?? 2,
      maxEscalationSpawnsPerTick: e.maxEscalationSpawnsPerTick ?? 1,
      reviveSettleMs: e.reviveSettleMs ?? 30_000,
      escalationGraceMs: e.escalationGraceMs ?? 10_000,
      rung2MaxNotifications: e.rung2MaxNotifications ?? 4,
      rung2MinIntervalMs: e.rung2MinIntervalMs ?? 1_800_000,
      rung2DigestWindowMs: e.rung2DigestWindowMs ?? 600_000,
      revalidationTtlMs: e.revalidationTtlMs ?? 1_800_000,
    } : null;
  }

  /** Escalation metrics snapshot (§6). Read-only; surfaced at /commitments/escalation-metrics. */
  escalationMetrics(): {
    enabled: boolean; dryRun: boolean; inFlight: number; doubleSpawnCount: number;
  } {
    return {
      enabled: !!this.esc?.enabled,
      dryRun: !!this.esc?.dryRun,
      inFlight: this.escInFlightGlobal,
      doubleSpawnCount: this.doubleSpawnCount,
    };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    // Re-arm any existing beacon-enabled pending commitments.
    const active = this.config.commitmentTracker
      .getActive()
      .filter(c => c.beaconEnabled && c.status === 'pending' && !c.beaconSuppressed);

    // Boot-cap enforcement (spec Round 3 #2).
    // If the count of beacon-enabled pending commitments exceeds the cap,
    // newest-first is kept; overflow is marked `beaconSuppressed` with reason
    // `boot-cap-exceeded`. Non-terminal — status stays `pending`.
    const sorted = [...active].sort((a, b) => {
      const ta = new Date(a.createdAt).getTime();
      const tb = new Date(b.createdAt).getTime();
      return tb - ta; // newest first
    });
    const keep = sorted.slice(0, this.maxActiveBeacons);
    const overflow = sorted.slice(this.maxActiveBeacons);
    if (overflow.length > 0) {
      console.log(`[PromiseBeacon] Boot-cap exceeded: ${overflow.length} commitment(s) suppressed (cap=${this.maxActiveBeacons})`);
      for (const c of overflow) {
        // Fire-and-forget — the mutate surface handles CAS retries.
        this.config.commitmentTracker
          .mutate(c.id, prev => ({
            ...prev,
            beaconSuppressed: true,
            beaconSuppressionReason: 'boot-cap-exceeded',
          }))
          .catch(err => console.warn(`[PromiseBeacon] boot-cap suppress failed for ${c.id}:`, (err as Error).message));
      }
      this.emit('boot-cap.exceeded', { cap: this.maxActiveBeacons, suppressed: overflow.map(c => c.id) });
    }
    for (const c of keep) {
      this.schedule(c);
    }
    // React to new beacon-enabled commitments as they're recorded.
    this.config.commitmentTracker.on('recorded', (c: Commitment) => {
      if (c.beaconEnabled && c.status === 'pending' && c.topicId) {
        this.schedule(c);
      }
    });
    this.config.commitmentTracker.on('delivered', (c: Commitment) => {
      this.stopFor(c.id);
    });
    this.config.commitmentTracker.on('withdrawn', (c: Commitment) => {
      this.stopFor(c.id);
    });
    // Re-arm when a paused beacon is resumed via API / Telegram intent.
    this.config.commitmentTracker.on('resumed', (c: Commitment) => {
      if (c.beaconEnabled && c.status === 'pending' && c.topicId) {
        // Reset the hot-state counter so the resumed run starts fresh.
        const hot = this.loadHotState(c.id);
        hot.consecutiveUnchanged = 0;
        this.saveHotState(c.id, hot);
        this.schedule(c);
      }
    });
    // C1+C2 §4.4 — arm the external-block staleness governor (a slow global
    // sweep, off the per-commitment timer path). No-op each tick when the
    // feature is off; cheap O(active) scan otherwise.
    const sweepMs = this.config.externalBlockSweepMs ?? 60 * 60_000;
    this.externalBlockSweepTimer = setInterval(() => {
      // §5 R3-M16: the stand-down ownership recheck rides THIS sweep
      // (R4-minor-4 — one O(active-stood-down) pass, no new timer). It is
      // machine-LOCAL (ownership of a conversation, not pool state), so it
      // runs before the lease gate.
      try {
        this.recheckStandDowns();
      } catch (err) {
        console.warn('[PromiseBeacon] stand-down recheck error:', (err as Error).message);
      }
      // Lease-gated (§4.5): only the lease-holder runs the mutating sweep.
      if (this.config.holdsLease && !this.config.holdsLease()) return;
      this.sweepExternalBlocks()
        .then(() => this.maybeReconcileGraveyard())
        .catch(err =>
          console.warn('[PromiseBeacon] external-block sweep error:', (err as Error).message),
        );
    }, sweepMs * this.timerMult);
    if (typeof this.externalBlockSweepTimer.unref === 'function') this.externalBlockSweepTimer.unref();
    console.log(`[PromiseBeacon] Started (${this.prefix})`);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    if (this.externalBlockSweepTimer) {
      clearInterval(this.externalBlockSweepTimer);
      this.externalBlockSweepTimer = undefined;
    }
    console.log('[PromiseBeacon] Stopped');
  }

  /** Public for tests + delivery race: cancel the timer for one commitment. */
  stopFor(id: string): void {
    const t = this.timers.get(id);
    if (t) {
      clearTimeout(t);
      this.timers.delete(id);
    }
  }

  /** Schedule (or re-schedule) the next heartbeat for a commitment. */
  schedule(c: Commitment): void {
    if (!this.started) return;
    if (!c.topicId) return;
    if (c.status !== 'pending' || c.beaconSuppressed || c.beaconPaused) return;
    if (this.stoodDown.has(c.id)) return; // §5 R3-M16: no re-fire while stood down

    // atRisk doubles cadence (spec Round 3 #1) — softer-toned + less frequent.
    const baseCadence = c.cadenceMs ?? 20 * 60_000;
    const effective = c.atRisk ? baseCadence * 2 : baseCadence;
    const cadence = this.clampCadence(effective) * this.timerMult;
    const hot = this.loadHotState(c.id);
    if (hot.standDownAt) {
      // Restart-safe stand-down restoration: the marker persisted; the
      // ownership recheck (riding the external-block sweep) is what clears it.
      this.stoodDown.add(c.id);
      return;
    }
    const last = hot.lastHeartbeatAt ? new Date(hot.lastHeartbeatAt).getTime() : new Date(c.createdAt).getTime();
    const dueAt = last + cadence;
    const delay = Math.max(1_000, dueAt - this.now());

    const existing = this.timers.get(c.id);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.timers.delete(c.id);
      this.fire(c.id).catch(err => {
        console.error(`[PromiseBeacon] fire() error for ${c.id}:`, (err as Error).message);
      });
    }, delay);
    timer.unref?.();
    this.timers.set(c.id, timer);
  }

  /** Fire one heartbeat. Public for testing. */
  async fire(id: string): Promise<void> {
    const c = this.config.commitmentTracker.getAll().find(x => x.id === id);
    if (!c) return;
    if (c.status !== 'pending' || c.beaconSuppressed || c.beaconPaused) return;
    if (!c.topicId) return;

    // ── Ownership gate ──
    if (this.config.speakerElection && typeof c.topicId === 'number') {
      // WS3 one-voice election: live owner re-resolution at speak time (the
      // stamp is only the fallback, so a backfill racing a transfer cannot
      // wedge the gate), failing toward speech-with-dedup — unknown ownership
      // never silences the pool. Silent and defer verdicts both re-arm.
      const verdict = this.config.speakerElection.decide(c.topicId, c.ownerMachineId ?? null);
      if (!verdict.speak) {
        this.schedule(c);
        return;
      }
    } else if (this.config.currentMachineId && c.ownerMachineId && c.ownerMachineId !== this.config.currentMachineId) {
      // Legacy static gate (no election wired): not ours; skip + re-arm.
      this.schedule(c);
      return;
    }

    // ── Quiet hours ──
    if (this.inQuietHours()) {
      await this.suppress(c, 'quiet-hours');
      return;
    }

    // ── Daily spend cap (hard, via LlmQueue) ──
    // LlmQueue enforces this on enqueue; we additionally short-circuit here
    // so we emit beaconSuppressed (non-terminal) rather than fail-open.
    if (this.config.llmQueue.getDailySpendCents() >= (this.config.maxDailyLlmSpendCents ?? 100)) {
      await this.suppress(c, 'daily-spend-cap');
      return;
    }

    // ── Session-epoch check / escalation ──
    const sessionName = this.config.getSessionForTopic(c.topicId);
    const liveEpoch = (sessionName && this.config.getSessionEpoch)
      ? this.config.getSessionEpoch(sessionName)
      : null;

    if (this.esc?.enabled) {
      // (a) Resolve any in-flight revive deterministically (§3.1 timeout contract).
      if (c.escalationInFlight) {
        const verdict = await this.resolveInFlight(c, sessionName, liveEpoch);
        if (verdict !== 'confirmed') {
          // 'pending' (still settling) or 'failed' (cleared) → re-arm, re-evaluate next tick.
          this.schedule(c);
          return;
        }
        // 'confirmed' → epoch re-stamped, fall through to a normal heartbeat below.
      } else {
        // (b) Detect session-loss: re-epoched, OR fully gone after having had one.
        const hadEpoch = !!c.sessionEpoch;
        const reEpoched = !!(liveEpoch && c.sessionEpoch && c.sessionEpoch !== liveEpoch);
        const fullyGone = hadEpoch && !sessionName;
        if (reEpoched || fullyGone) {
          await this.escalate(c);
          return;
        }
      }
    } else {
      // Legacy behavior (escalation off): immediate terminal on epoch mismatch.
      if (sessionName && this.config.getSessionEpoch && c.sessionEpoch && liveEpoch && c.sessionEpoch !== liveEpoch) {
        await this.transitionViolated(c, 'session-lost');
        return;
      }
    }

    // ── Proxy coordinator: one proxy-class message per topic ──
    if (!this.config.proxyCoordinator.tryAcquire(c.topicId, 'promise-beacon')) {
      // PresenceProxy holds — re-arm and bow out.
      this.schedule(c);
      return;
    }

    let reArm = true;
    try {
      // ── Capture (raw frame for turn-state, sanitized for hashing) ──
      const rawFrame = sessionName ? (this.config.captureSessionOutput(sessionName, 200) ?? '') : '';
      const snapshot = rawFrame ? sanitizeTmuxOutput(capOutput(rawFrame), []) : '';
      const hash = snapshot ? sha256(normalizeForHash(snapshot)) : 'empty';
      const hot = this.loadHotState(c.id);
      const unchanged = hash === hot.lastSnapshotHash;
      const nowIso = new Date(this.now()).toISOString();

      const excerpt = promiseExcerpt(c);
      const suffix = excerpt ? ` — re: ${excerpt}` : '';

      // ── B2: turn-finished close-out (HONEST-PROGRESS-MESSAGING / FD-1) ──
      // If the session is alive but its live frame shows no active-work indicator
      // for N consecutive checks, the promised work's turn has wrapped — emit ONE
      // close-out prompt and auto-pause instead of heart-beating into a finished
      // room. Inactive (degrades safely) when looksActivelyWorking isn't wired.
      if (sessionName && this.config.looksActivelyWorking && this.config.isSessionAlive(sessionName) && rawFrame) {
        let working = true;
        try {
          working = this.config.looksActivelyWorking(rawFrame, sessionName);
        } catch {
          // @silent-fallback-ok: FD-6 fail-safe — an unreliable detector read
          // defaults to "still working" so a turn-finished close-out is never
          // FALSELY fired. The safe direction for a notification suppressor.
          working = true;
        }
        if (!working) {
          hot.consecutiveTurnFinished = (hot.consecutiveTurnFinished ?? 0) + 1;
          const closeoutAt = this.config.turnFinishedCloseoutChecks ?? 3;
          if (hot.consecutiveTurnFinished >= closeoutAt) {
            hot.lastSnapshotHash = hash;
            this.saveHotState(c.id, hot);
            reArm = false; // closed out + paused — do NOT re-arm
            await this.closeOutTurnFinished(c, excerpt);
            return;
          }
        } else {
          hot.consecutiveTurnFinished = 0;
        }
      }

      let text: string | null = null;
      let atRiskSignal = false;
      let livenessFired = false;

      if (snapshot && !unchanged) {
        // ── Genuine new output → real LLM-summarized progress line ──
        hot.consecutiveUnchanged = 0;
        try {
          const line = await this.config.llmQueue.enqueue(
            'background',
            (signal) => {
              if (this.config.generateStatusLine) {
                return this.config.generateStatusLine(c.agentResponse || c.userRequest, snapshot, signal);
              }
              // No generator wired → templated.
              return Promise.resolve('working on it — recent output observed');
            },
            // Rough Haiku estimate (~3k tokens in/out).
            1,
          );
          const guard = guardProxyOutput(line);
          let safeLine = guard.safe ? line : 'working on it';

          // ── atRisk classifier (signal-only) ──
          // If a classifier is wired, ask it whether the snapshot reads as
          // stalled. This is a *signal*, not authority: the beacon will flag
          // the commitment atRisk and soften the heartbeat, but NEVER
          // auto-transition to `violated` from this input. Spec Round 3 #1.
          if (this.config.classifyProgress) {
            try {
              const verdict = await this.config.llmQueue.enqueue(
                'background',
                (s) => this.config.classifyProgress!(c.agentResponse || c.userRequest, snapshot, s),
                1,
              );
              if (verdict === 'stalled') {
                atRiskSignal = true;
                const softPhrase = AT_RISK_VARIANTS[hot.templatedVariantCursor % AT_RISK_VARIANTS.length];
                safeLine = softPhrase;
              }
            } catch {
              // Classifier failure is non-fatal — fall through with original line.
            }
          }

          text = `${this.prefix} ${safeLine}${suffix}`;
        } catch (err) {
          if (err instanceof LlmAbortedError || (err as Error).message.includes('cap exceeded') || (err as Error).message.includes('reserve')) {
            text = `${this.prefix} still working (update deferred)${suffix}`;
          } else {
            text = `${this.prefix} still working (status fetch failed)${suffix}`;
          }
        }
      } else {
        // ── Unchanged (or no snapshot) ──
        hot.consecutiveUnchanged += 1;
        const unchangedIsAtRisk = hot.consecutiveUnchanged >= 2;
        if (unchangedIsAtRisk) atRiskSignal = true;
        // B1: suppress the "nothing changed" filler by default. Speak only on
        // deadline pressure (B1a) or a sparse liveness tick (B1b). When the
        // operator opts out (suppressUnchangedHeartbeats:false), keep the legacy
        // every-tick templated line (rollback path).
        if (this.config.suppressUnchangedHeartbeats === false) {
          const variants = unchangedIsAtRisk ? AT_RISK_VARIANTS : TEMPLATED_VARIANTS;
          const phrase = variants[hot.templatedVariantCursor % variants.length];
          text = `${this.prefix} ${phrase}${suffix}`;
          hot.templatedVariantCursor += 1;
        } else {
          const deadlineLine = this.deadlinePressureLine(c, suffix);
          if (deadlineLine) {
            text = deadlineLine;
          } else {
            const livenessLine = this.maybeLivenessLine(c, hot, suffix, sessionName);
            if (livenessLine) {
              text = livenessLine;
              livenessFired = true;
            }
          }
        }
      }

      // ── Send (only if there is something true to say — B1) ──
      const sent = text != null;
      let sendResult: BeaconSendResult = 'skipped';
      if (sent) {
        sendResult = await this.emitUserSend(c, text!, 'heartbeat');
        if (livenessFired) hot.lastLivenessAt = nowIso;
        if (sendResult === 'sent') hot.heartbeatCount += 1;
      }
      // §5 stand-down / §5.1 permanent dead-letter already persisted their
      // markers + stopped the timer inside applyDeliveryOutcome.
      if (sendResult === 'failed-standdown' || sendResult === 'failed-permanent') {
        reArm = false;
      }

      // ── Persist hot state (cadence advances every check, sent or not, so a
      //    suppressed tick can't tight-loop on a stale lastHeartbeatAt).
      //    MERGE via updateHotState — the delivery path may have advanced
      //    sendSeq / failure counters on disk during emitUserSend, and this
      //    write must never clobber them (R4-minor-1). ──
      this.updateHotState(c.id, (h) => {
        h.lastHeartbeatAt = nowIso;
        h.lastSnapshotHash = hash;
        h.consecutiveUnchanged = hot.consecutiveUnchanged;
        h.templatedVariantCursor = hot.templatedVariantCursor;
        h.consecutiveTurnFinished = hot.consecutiveTurnFinished;
        h.heartbeatCount = hot.heartbeatCount;
        if (livenessFired) h.lastLivenessAt = nowIso;
      });

      await this.config.commitmentTracker.mutate(c.id, prev => ({
        ...prev,
        lastHeartbeatAt: nowIso,
        // heartbeatCount counts messages actually SENT (B1: a suppressed,
        // unchanged-snapshot check is not a heartbeat the user saw; a typed
        // funnel non-delivery is not one either).
        heartbeatCount: (prev.heartbeatCount ?? 0) + (sendResult === 'sent' ? 1 : 0),
        lastSnapshotHash: hash,
        // atRisk is a signal-driven, non-terminal flag. Setting it does NOT
        // change status; it only nudges tone and doubles cadence below.
        atRisk: atRiskSignal ? true : prev.atRisk,
      }));

      this.emit('heartbeat.fired', {
        id: c.id,
        topicId: c.topicId,
        templated: !snapshot || unchanged,
        atRisk: atRiskSignal,
        sent: sendResult === 'sent',
      });

      // ── Auto-pause gate ───────────────────────────────────────────
      // After enough consecutive unchanged-snapshot heartbeats, emit one
      // final "auto-paused" message and stop firing. Non-terminal: status
      // stays `pending`; resume via POST /commitments/:id/resume or a
      // "keep watching" reply on the same topic.
      const threshold = c.beaconAutoPauseAfterUnchanged ?? this.defaultAutoPauseAfterUnchanged;
      const isUnchangedThisCycle = !snapshot || unchanged;
      if (threshold > 0 && isUnchangedThisCycle && hot.consecutiveUnchanged >= threshold) {
        reArm = false; // do NOT re-arm
        await this.autoPause(c, excerpt);
        return;
      }
    } finally {
      this.config.proxyCoordinator.release(c.topicId, 'promise-beacon');
      // §5.1 (lessons-F4/adversarial-A1): fire() re-arms in FINALLY — a thrown
      // send/LLM error can never silently kill the beacon timer (the
      // flagship-consumer safety; the pre-increment fire() skipped re-arm on
      // throw). Deliberate stops (auto-pause, close-out, stand-down,
      // permanent dead-letter) opt out via reArm=false.
      if (reArm && !this.stoodDown.has(c.id)) {
        const next = this.config.commitmentTracker.getAll().find(x => x.id === id);
        if (next) this.schedule(next);
      }
    }
  }

  /**
   * Auto-pause a beacon after a run of unchanged heartbeats. Emits one final
   * user-visible line telling them how to resume, mutates the commitment to
   * set `beaconPaused`, and clears the timer. Non-terminal: status stays
   * `pending`. Resume re-arms via the `resumed` event handler.
   */
  private async autoPause(c: Commitment, excerpt: string): Promise<void> {
    const suffix = excerpt ? ` — re: ${excerpt}` : '';
    const finalText = `${this.prefix} auto-paused after long quiet${suffix}\nReply "keep watching" on this topic to resume.`;
    try {
      await this.emitUserSend(c, finalText, 'closeOut');
    } catch (err) {
      console.warn(`[PromiseBeacon] auto-pause send failed for ${c.id}:`, (err as Error).message);
    }
    const hot = this.loadHotState(c.id);
    await this.config.commitmentTracker.mutate(c.id, prev => ({
      ...prev,
      beaconPaused: true,
      beaconPausedReason: 'auto-paused-no-progress',
      beaconPausedAt: new Date(this.now()).toISOString(),
      // Snapshot the streak length that triggered the pause — written ONLY
      // at the pause boundary, not on every heartbeat (review feedback).
      consecutiveUnchanged: hot.consecutiveUnchanged,
    }));
    this.stopFor(c.id);
    this.emit('auto-paused', { id: c.id, topicId: c.topicId });
  }

  /**
   * B1a (HONEST-PROGRESS-MESSAGING) — deadline-pressure exception. Total silence
   * near a hard deadline is itself dishonest. When the commitment's hard deadline
   * is within 2× the effective cadence, an unchanged tick still speaks with a
   * low-confidence, honest line. Returns null when there is no deadline pressure.
   */
  private deadlinePressureLine(c: Commitment, suffix: string): string | null {
    if (!c.hardDeadlineAt) return null;
    const deadline = Date.parse(c.hardDeadlineAt);
    if (Number.isNaN(deadline)) return null;
    const remaining = deadline - this.now();
    if (remaining <= 0) return null; // past the deadline — expiry is handled elsewhere
    const baseCadence = c.cadenceMs ?? 20 * 60_000;
    const effective = c.atRisk ? baseCadence * 2 : baseCadence;
    if (remaining > 2 * effective) return null;
    return `${this.prefix} no visible new output${suffix}, but still within your deadline (${humanizeMs(remaining)} left) — watching closely.`;
  }

  /**
   * B1b (HONEST-PROGRESS-MESSAGING) — sparse liveness. When unchanged heartbeats
   * are suppressed, a genuinely long task would go fully dark. Emit at most one
   * "still watching, N min in" line per beaconLivenessIntervalMs while a session
   * is present. Returns null when a liveness line isn't due yet.
   */
  private maybeLivenessLine(
    c: Commitment,
    hot: HotState,
    suffix: string,
    sessionName: string | null,
  ): string | null {
    if (!sessionName) return null;
    const interval = this.config.beaconLivenessIntervalMs ?? 60 * 60_000;
    const anchor = hot.lastLivenessAt
      ? Date.parse(hot.lastLivenessAt)
      : Date.parse(c.createdAt);
    if (Number.isNaN(anchor)) return null;
    if (this.now() - anchor < interval) return null;
    const createdAt = Date.parse(c.createdAt);
    const minIn = Number.isNaN(createdAt)
      ? 0
      : Math.max(1, Math.round((this.now() - createdAt) / 60_000));
    return `${this.prefix} still watching${suffix} — ${minIn} min in, no new output yet.`;
  }

  /**
   * B2 (HONEST-PROGRESS-MESSAGING) — turn-finished close-out. The promise's
   * session has wrapped its turn; emit ONE honest close-out prompt and auto-pause
   * (no clockwork heartbeats into a finished room). Non-terminal: status stays
   * `pending`; resume re-arms via the `resumed` handler.
   */
  private async closeOutTurnFinished(c: Commitment, excerpt: string): Promise<void> {
    const re = excerpt || 'this task';
    const finalText =
      `${this.prefix} I said I'd follow up on "${re}" but that work's session has wrapped — ` +
      `want me to pick it back up, or close this out?`;
    try {
      await this.emitUserSend(c, finalText, 'closeOut');
    } catch (err) {
      console.warn(`[PromiseBeacon] turn-finished close-out send failed for ${c.id}:`, (err as Error).message);
    }
    await this.config.commitmentTracker.mutate(c.id, prev => ({
      ...prev,
      beaconPaused: true,
      beaconPausedReason: 'turn-finished',
      beaconPausedAt: new Date(this.now()).toISOString(),
    }));
    this.stopFor(c.id);
    this.emit('auto-paused', { id: c.id, topicId: c.topicId, reason: 'turn-finished' });
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private async suppress(c: Commitment, reason: string): Promise<void> {
    await this.config.commitmentTracker.mutate(c.id, prev => ({
      ...prev,
      beaconSuppressed: true,
      beaconSuppressionReason: reason,
    }));
    this.emit('heartbeat.skipped', { id: c.id, reason });
    // Re-arm for re-evaluation: 10min window for quiet-hours, 1h for cap.
    const reArmDelay = reason === 'quiet-hours' ? 10 * 60_000 : 60 * 60_000;
    const timer = setTimeout(() => {
      this.timers.delete(c.id);
      // Clear suppression flag on re-evaluation attempt.
      this.config.commitmentTracker
        .mutate(c.id, prev => ({ ...prev, beaconSuppressed: false, beaconSuppressionReason: undefined }))
        .then(updated => this.schedule(updated))
        .catch(() => { /* ok — commitment may be terminal */ });
    }, reArmDelay * this.timerMult);
    timer.unref?.();
    this.timers.set(c.id, timer);
  }

  // ─── Escalation ladder (PROMISE-BEACON-ESCALATION-SPEC §3) ──────────────────

  /** Exponential backoff floor between Rung-1 attempts (I1). */
  private escBackoffMs(attempt: number): number {
    const min = this.esc!.minEscalationIntervalMs;
    return Math.max(min, Math.pow(2, Math.max(0, attempt - 1)) * min);
  }

  /** Reset the per-tick spawn budget when a new ~tick window opens (I9). */
  private rollEscTick(): void {
    const now = this.now();
    if (now - this.escTickAnchorMs > 5_000) {
      this.escTickAnchorMs = now;
      this.escSpawnsThisTick = 0;
    }
  }

  /** Emit one escalation-audit event (§6). Also covers dry-run "would" logging. */
  private auditEsc(c: Commitment, decision: string, extra: Record<string, unknown> = {}): void {
    this.emit('escalation', {
      id: c.id,
      topicId: c.topicId,
      decision,
      dryRun: !!this.esc?.dryRun,
      attempts: c.escalationAttempts ?? 0,
      ...extra,
    });
  }

  /**
   * Rung 1 — attempt to revive the owning session, with all the §4 brakes.
   * Decides between Rung 1 (spawn), Rung 2 (honest status), and Rung 3 (give up).
   */
  private async escalate(c: Commitment): Promise<void> {
    const esc = this.esc!;
    const attempts = c.escalationAttempts ?? 0;

    // Cap (I1): out of attempts → Rung 3 loud give-up.
    if (attempts >= esc.maxEscalationAttempts) {
      await this.rung3(c);
      return;
    }

    // Backoff floor (I1): not yet time for the next attempt → re-arm, no-op.
    const lastAt = c.lastEscalationAt ? Date.parse(c.lastEscalationAt) : 0;
    if (lastAt && this.now() - lastAt < this.escBackoffMs(attempts)) {
      this.auditEsc(c, 'backoff-hold');
      return; // caller re-arms
    }

    // Ownership re-check immediately before spawn (I4) — standby never spawns.
    if (this.config.speakerElection && typeof c.topicId === 'number') {
      const verdict = this.config.speakerElection.decide(c.topicId, c.ownerMachineId ?? null);
      if (!verdict.speak) { this.auditEsc(c, 'not-owner'); return; }
    }

    // Global budget (I9): concurrency + per-tick spawn cap → fall to Rung 2.
    this.rollEscTick();
    if (this.escInFlightGlobal >= esc.maxConcurrentEscalations ||
        this.escSpawnsThisTick >= esc.maxEscalationSpawnsPerTick) {
      await this.rung2(c, 'quota-limited');
      return;
    }

    // Dry-run: log the intended Rung-1 spawn; take no real action.
    if (esc.dryRun) {
      this.auditEsc(c, 'would-revive', { rung: 1 });
      return;
    }

    if (!this.config.requestRevive) {
      // No spawn path wired → honest status instead.
      await this.rung2(c, 'owner-gone');
      return;
    }

    // Rung 1 commit: increment BEFORE the spawn (I1), set in-flight + idempotency
    // key + revivalMode, all via one CAS mutate (server-written-only, I11).
    const attemptId = crypto.randomUUID();
    const nowIso = new Date(this.now()).toISOString();
    await this.config.commitmentTracker.mutate(c.id, prev => ({
      ...prev,
      escalationAttempts: (prev.escalationAttempts ?? 0) + 1,
      lastEscalationAt: nowIso,
      escalationAttemptId: attemptId,
      escalationInFlight: true,
      revivalMode: 'status-only-until-revalidated',
      currentRung: '1',
    }));
    this.escInFlightGlobal += 1;
    this.escSpawnsThisTick += 1;
    this.auditEsc(c, 'revive-requested', { rung: 1, attemptId });

    let result: ReviveResult;
    try {
      result = await this.config.requestRevive({
        topicId: c.topicId!,
        commitmentId: c.id,
        escalationAttemptId: attemptId,
        userRequest: c.userRequest,
        agentResponse: c.agentResponse,
      });
    } catch {
      result = { sessionName: null, refusalReason: 'quota' };
    }

    if (!result.sessionName) {
      // Spawn refused — release the in-flight marker now (the attempt already
      // counted) and fall to Rung 2 with the state-specific recoverability.
      this.escInFlightGlobal = Math.max(0, this.escInFlightGlobal - 1);
      await this.config.commitmentTracker.mutate(c.id, prev => ({
        ...prev,
        escalationInFlight: false,
        refusalReason: result.refusalReason,
      }));
      await this.rung2(c, this.refusalToState(result.refusalReason));
      return;
    }
    // Success: in-flight stays set; resolveInFlight() confirms it on a later
    // tick via the §3.1 timeout contract. Caller re-arms.
    this.auditEsc(c, 'revive-spawned', { rung: 1, sessionName: result.sessionName });
  }

  /** Map a spawn refusal to its Rung-2 recoverability state (§3.2). */
  private refusalToState(r?: ReviveResult['refusalReason']): RecoverabilityState {
    switch (r) {
      case 'quota': return 'quota-limited';
      case 'budget': return 'quota-limited';
      case 'resume-queue-owns': return 'retryable';
      case 'lease': return 'owner-gone';
      case 'unbound': return 'owner-gone';
      default: return 'owner-gone';
    }
  }

  /**
   * §3.1 deterministic in-flight resolution. Returns 'confirmed' (epoch
   * re-stamped, fall through to heartbeat), 'failed' (cleared, re-evaluate),
   * or 'pending' (still within the settle window).
   */
  private async resolveInFlight(
    c: Commitment,
    sessionName: string | null,
    liveEpoch: string | null,
  ): Promise<'confirmed' | 'failed' | 'pending'> {
    const esc = this.esc!;
    const lastAt = c.lastEscalationAt ? Date.parse(c.lastEscalationAt) : 0;
    const age = this.now() - lastAt;

    // ── Double-spawn detection (§6) ──
    // Two distinct live sessions bound to one topic while this commitment is
    // escalationInFlight is the partition/race double-spawn signature. Counted
    // ONCE per attempt (deduped) and surfaced at /commitments/escalation-metrics
    // — any non-zero value is the rollout hard-stop signal. The reaper's
    // single-session-per-topic closeout is the auto-correction (§9); this is the
    // detection arm.
    if (this.config.liveSessionCountForTopic && typeof c.topicId === 'number' && c.escalationAttemptId) {
      try {
        if (this.config.liveSessionCountForTopic(c.topicId) > 1 && !this.doubleSpawnCountedAttempts.has(c.escalationAttemptId)) {
          this.doubleSpawnCountedAttempts.add(c.escalationAttemptId);
          this.recordDoubleSpawn();
          this.auditEsc(c, 'double-spawn-detected', { attemptId: c.escalationAttemptId });
        }
      } catch { /* detection is best-effort; never throws into the tick */ }
    }

    // Confirmed: a live session with a NEW epoch, settled ≥ reviveSettleMs.
    const isNewLive = !!(sessionName && liveEpoch && liveEpoch !== c.sessionEpoch);
    if (isNewLive && age >= esc.reviveSettleMs) {
      this.escInFlightGlobal = Math.max(0, this.escInFlightGlobal - 1);
      if (c.escalationAttemptId) this.doubleSpawnCountedAttempts.delete(c.escalationAttemptId);
      await this.config.commitmentTracker.mutate(c.id, prev => ({
        ...prev,
        sessionEpoch: liveEpoch!,
        escalationInFlight: false,
        escalationAttemptId: undefined,
        currentRung: null,
        refusalReason: undefined,
      }));
      this.auditEsc(c, 'revive-confirmed');
      this.emit('escalation.revived', { id: c.id, topicId: c.topicId });
      return 'confirmed';
    }

    // Failed: past the settle+grace window with no confirmed session.
    if (age > esc.reviveSettleMs + esc.escalationGraceMs) {
      this.escInFlightGlobal = Math.max(0, this.escInFlightGlobal - 1);
      if (c.escalationAttemptId) this.doubleSpawnCountedAttempts.delete(c.escalationAttemptId);
      await this.config.commitmentTracker.mutate(c.id, prev => ({
        ...prev,
        escalationInFlight: false,
        escalationAttemptId: undefined,
      }));
      this.auditEsc(c, 'revive-failed');
      return 'failed';
    }

    return 'pending';
  }

  /** Rung 2 — honest, state-specific interim status, bounded (§3.2 + I12). */
  private async rung2(c: Commitment, state: RecoverabilityState): Promise<void> {
    const esc = this.esc!;
    const sent = c.rung2NotificationCount ?? 0;

    // Bounded: exhausted Rung-2 budget → Rung 3 (operator-needed).
    if (sent >= esc.rung2MaxNotifications) {
      await this.rung3(c);
      return;
    }
    // Per-commitment floor.
    const lastRung2 = c.lastRung2At ? Date.parse(c.lastRung2At) : 0;
    if (lastRung2 && this.now() - lastRung2 < esc.rung2MinIntervalMs) {
      this.auditEsc(c, 'rung2-floor-hold', { state });
      return;
    }
    // Quiet-hours re-gate (I7).
    if (this.inQuietHours()) { this.auditEsc(c, 'rung2-quiet-hours', { state }); return; }

    if (esc.dryRun) { this.auditEsc(c, 'would-rung2', { state }); return; }

    const excerpt = redactSecrets(promiseExcerpt(c));
    const text = rung2Message(state, excerpt);
    if (text && c.topicId) {
      try {
        await this.emitUserSend(c, text, 'rung2');
      } catch (err) {
        console.warn(`[PromiseBeacon] rung2 send failed for ${c.id}:`, (err as Error).message);
      }
    }
    await this.config.commitmentTracker.mutate(c.id, prev => ({
      ...prev,
      rung2NotificationCount: (prev.rung2NotificationCount ?? 0) + 1,
      lastRung2At: new Date(this.now()).toISOString(),
      currentRung: '2',
      atRisk: true,
    }));
    this.auditEsc(c, 'rung2-sent', { state });
  }

  /** Rung 3 — bounded, loud give-up: terminal + ONE deduped Attention item (§3.3). */
  private async rung3(c: Commitment): Promise<void> {
    if (this.esc?.dryRun) { this.auditEsc(c, 'would-give-up', { rung: 3 }); return; }
    await this.config.commitmentTracker.mutate(c.id, prev => ({
      ...prev,
      status: 'violated',
      resolvedAt: new Date(this.now()).toISOString(),
      resolution: 'session-lost-unrecovered',
      currentRung: '3',
      escalationInFlight: false,
    }));
    const detail = `Promise "${(c.agentResponse || c.userRequest).slice(0, 80)}" could not be revived after ${c.escalationAttempts ?? 0} attempts.`;
    try { this.config.raiseAttention?.(c.id, detail); } catch { /* non-fatal */ }
    this.stopFor(c.id);
    this.auditEsc(c, 'gave-up', { rung: 3 });
    this.emit('promise.violated', { id: c.id, reason: 'session-lost-unrecovered' });
  }

  /** Record a confirmed double-spawn (§6) — invoked by the per-topic reconciliation. */
  recordDoubleSpawn(): void { this.doubleSpawnCount += 1; }

  /**
   * C1+C2 owner-gated outbound chokepoint (spec agent-owned-followthrough §4.2).
   * EVERY beacon user-send routes through here. Beacon sends are `isProxy:true`
   * and bypass MessagingToneGate, so the owner-gate MUST live here, not at the
   * gate. Rollout-gated (§4.8): when the feature is off (fleet default) this is a
   * strict no-op — sends go out exactly as before. When on+dryRun it logs the
   * intended action but still sends (observe-first). When on+live and the
   * commitment is owner:'agent', status kinds are suppressed (the agent carries
   * the loop — the user is never status-messaged) while a `terminal` kind is
   * NEVER suppressed: it reroutes to the Attention dead-letter (raiseAttention,
   * the one always-surfaced channel) so a failure is never swallowed (C2 /
   * "never nag ≠ swallow a failure"). owner:'user' always sends normally.
   */
  private async emitUserSend(
    c: Commitment,
    text: string,
    kind: 'heartbeat' | 'closeOut' | 'rung2' | 'terminal',
  ): Promise<BeaconSendResult> {
    const sendNormally = async (): Promise<BeaconSendResult> => {
      if (c.topicId == null) return 'skipped';
      // Beacon-local B-IDLEAK pass (C1+C2 §4.3): beacon sends are isProxy:true and
      // bypass MessagingToneGate, so B20 can't run on them. Signal-only
      // observability — emit when beacon text leaks internal plumbing (never
      // blocks/scrubs; secret/path redaction stays with guardProxyOutput).
      try {
        const leak = detectInternalIdLeak(text);
        if (leak.leaked) this.emit('aoft.beacon-id-leak', { id: c.id, terms: leak.terms });
      } catch { /* non-fatal */ }
      // ── durable-conversation-identity §6.1 step 2: the funnel swap ──
      // When deliverToConversation is wired, EVERY beacon send rides it (the
      // id>0 arm is today's Telegram path unchanged; the id<0 arm delivers
      // into the exact Slack thread with the E1 guard + §5.1 typed outcomes).
      if (this.config.deliverMessage) {
        const seq = this.loadHotState(c.id).sendSeq ?? 0;
        const logicalSendId = `${c.id}:${seq}`; // the §3.4 pinned encoding
        const outcome = await this.config.deliverMessage(c.topicId, text, {
          source: 'promise-beacon',
          isProxy: true,
          tier: 1,
          logicalSendId,
          ...(c.boundTuple ? { boundTuple: c.boundTuple } : {}),
        });
        return await this.applyDeliveryOutcome(c, outcome, seq, logicalSendId);
      }
      await this.config.sendMessage(c.topicId, text, {
        source: 'promise-beacon',
        isProxy: true,
        tier: 1,
      });
      return 'sent';
    };
    const state = this.config.agentOwnedFollowthrough?.() ?? { enabled: false, dryRun: true };
    // Feature off, or not an agent-owned commitment → unchanged behavior.
    if (!state.enabled || c.owner !== 'agent') {
      return await sendNormally();
    }
    if (kind === 'terminal') {
      // Terminal failure: reroute to the Attention dead-letter (never status,
      // never swallowed). In dryRun, log the intent but preserve current behavior.
      if (state.dryRun) {
        this.emit('aoft.would-reroute-terminal', { id: c.id, topicId: c.topicId, kind });
        return await sendNormally();
      }
      const detail = text.replace(/^⚠️\s*\[?promise-beacon\]?\s*/i, '').trim() || text;
      try { this.config.raiseAttention?.(c.id, detail); } catch { /* non-fatal */ }
      this.emit('aoft.terminal-rerouted', { id: c.id, topicId: c.topicId, kind });
      return 'rerouted-terminal';
    }
    // Status kind under owner:'agent'.
    if (state.dryRun) {
      this.emit('aoft.would-suppress', { id: c.id, topicId: c.topicId, kind });
      return await sendNormally();
    }
    this.emit('aoft.suppressed', { id: c.id, topicId: c.topicId, kind });
    return 'suppressed-aoft';
  }

  /**
   * Apply one typed funnel outcome (§5.1/§5.0(a)) to the beacon's durable
   * sequencing + failure state:
   *  - delivered OR delivered-equivalent (`already-delivered-recently`, R7-M1):
   *    advance+persist `sendSeq` FIRST (atomic tmp→rename), THEN journal
   *    `send-retire` — the R5-M3 pinned inter-store order. A crash between the
   *    two leaves an unretired entry beside an advanced seq: a harmless
   *    TTL-bounded leak, never a double-post, never a suppression.
   *  - `not-delivered` + standDown: §5 non-owning STAND-DOWN — no re-fire
   *    scheduling, NEVER the dead-letter counter (I1 scoping); re-evaluated on
   *    the ownership recheck riding the external-block sweep (R3-M16).
   *  - `not-delivered` + permanent (§5.1): TERMINAL — one raiseAttention
   *    dead-letter (mass aggregation happens at the funnel emitter), the
   *    beacon suppresses (non-terminal commitment state; a reachability
   *    auto-clear + operator resume can revive it).
   *  - `not-delivered` transient: `sendSeq` held constant (so the re-fire of
   *    the SAME logical send matches the E1 guard), consecutive failures
   *    counted; at `deadLetterAfterConsecutiveFailures` (=3, R3-M15) ONE
   *    deduped raiseAttention — the beacon keeps re-arming (retry engages).
   */
  private async applyDeliveryOutcome(
    c: Commitment,
    outcome: import('../core/deliverToConversation.js').DeliveryOutcome,
    seq: number,
    logicalSendId: string,
  ): Promise<BeaconSendResult> {
    if (outcome.delivered || outcome.outcome === 'already-delivered-recently') {
      // Seq persist BEFORE send-retire (R5-M3 — the reverse order re-opens the
      // exact double-post E1 exists to prevent).
      this.updateHotState(c.id, (h) => {
        h.sendSeq = seq + 1;
        h.consecutiveDeliveryFailures = 0;
        delete h.deliveryDeadLetteredAt;
      });
      if (typeof c.topicId === 'number' && c.topicId < 0) {
        try {
          this.config.retireSend?.(c.topicId, logicalSendId);
        } catch { /* retire is guard bookkeeping — never fails the send */ }
      }
      return outcome.delivered ? 'sent' : 'suppressed-delivered-equivalent';
    }

    if (outcome.standDown) {
      this.updateHotState(c.id, (h) => {
        h.standDownAt = new Date(this.now()).toISOString();
      });
      this.stoodDown.add(c.id);
      this.stopFor(c.id);
      this.emit('delivery.stand-down', { id: c.id, topicId: c.topicId, reason: outcome.reason });
      return 'failed-standdown';
    }

    if (outcome.permanent) {
      this.updateHotState(c.id, (h) => {
        if (!h.deliveryDeadLetteredAt) h.deliveryDeadLetteredAt = new Date(this.now()).toISOString();
      });
      try {
        this.config.raiseAttention?.(
          c.id,
          `Delivery for "${(c.agentResponse || c.userRequest).slice(0, 80)}" is permanently failing (${outcome.detail ?? outcome.reason}) — conversation unreachable; beacon dead-lettered. Reachability auto-clears on the next successful delivery or authenticated inbound.`,
        );
      } catch { /* non-fatal */ }
      await this.config.commitmentTracker.mutate(c.id, prev => ({
        ...prev,
        beaconSuppressed: true,
        beaconSuppressionReason: 'conversation-unreachable',
      }));
      this.stopFor(c.id);
      this.emit('delivery.dead-letter', { id: c.id, topicId: c.topicId, permanent: true });
      return 'failed-permanent';
    }

    // Transient (§5.1): hold the seq constant; count + (once) dead-letter.
    const threshold = this.config.deadLetterAfterConsecutiveFailures ?? 3;
    let deadLetterNow = false;
    const hot = this.updateHotState(c.id, (h) => {
      h.consecutiveDeliveryFailures = (h.consecutiveDeliveryFailures ?? 0) + 1;
      if ((h.consecutiveDeliveryFailures ?? 0) >= threshold && !h.deliveryDeadLetteredAt) {
        h.deliveryDeadLetteredAt = new Date(this.now()).toISOString();
        deadLetterNow = true;
      }
    });
    if (deadLetterNow) {
      try {
        this.config.raiseAttention?.(
          c.id,
          `${hot.consecutiveDeliveryFailures} consecutive delivery failures for "${(c.agentResponse || c.userRequest).slice(0, 80)}" (last: ${outcome.reason}${outcome.detail ? ` — ${outcome.detail}` : ''}). The beacon keeps retrying.`,
        );
      } catch { /* non-fatal */ }
      this.emit('delivery.dead-letter', { id: c.id, topicId: c.topicId, permanent: false });
    }
    return 'failed-transient';
  }

  /**
   * §5 R3-M16 stand-down recheck — one O(active-stood-down) pass riding the
   * EXISTING external-block sweep (R4-minor-4: no new timer; default ≤ 1h). A
   * machine that BECOMES a stood-down conversation's owner (adoption on first
   * authenticated inbound) picks the beacon back up here. Public for tests.
   */
  recheckStandDowns(): void {
    if (this.stoodDown.size === 0) return;
    const owns = this.config.ownsConversation;
    for (const id of [...this.stoodDown]) {
      const c = this.config.commitmentTracker.get(id);
      if (!c || c.status !== 'pending' || typeof c.topicId !== 'number') {
        this.stoodDown.delete(id);
        continue;
      }
      if (!owns) continue; // no ownership oracle wired — stay stood down
      let owned = false;
      try {
        owned = owns(c.topicId);
      } catch {
        owned = false; // fail toward staying stood down (never a spurious re-fire)
      }
      if (owned) {
        this.stoodDown.delete(id);
        this.updateHotState(id, (h) => {
          delete h.standDownAt;
          h.consecutiveDeliveryFailures = 0;
        });
        this.schedule(c);
        this.emit('delivery.stand-down-cleared', { id, topicId: c.topicId });
      }
    }
  }

  /**
   * C1+C2 §4.4 — the external-block staleness governor. A slow global sweep over
   * owner:'agent', blockedOn:'external' pending commitments. The WINDOW
   * dead-letter is the hard guarantee: when no dependency-probe has landed within
   * the staleness window — OR the wait is past the absolute ceiling regardless of
   * probes — it raises ONE deduped operator Attention item (raiseAttention),
   * NEVER auto-closing (CMT-1101 scar). Deduped via externalBlockDeadLetteredAt
   * (a fresh probe re-arms it). Rollout-gated: off → no-op; dryRun → logs the
   * would-be dead-letter but does not raise it. Public for tests.
   */
  async sweepExternalBlocks(): Promise<void> {
    const state = this.config.agentOwnedFollowthrough?.() ?? { enabled: false, dryRun: true };
    if (!state.enabled) return;
    const windowMs = this.config.externalBlockWindowMs ?? 24 * 60 * 60_000;
    const ceilingMs = this.config.externalBlockCeilingMs ?? 14 * 24 * 60 * 60_000;
    const now = this.now();
    for (const c of this.config.commitmentTracker.getActive()) {
      if (c.owner !== 'agent' || c.blockedOn !== 'external' || c.status !== 'pending') continue;
      if (c.externalBlockDeadLetteredAt) continue; // already surfaced this episode
      const createdMs = Date.parse(c.createdAt);
      const lastTouchMs = c.lastProbe?.at ? Date.parse(c.lastProbe.at) : createdMs;
      const windowStale = Number.isFinite(lastTouchMs) && now - lastTouchMs > windowMs;
      const ceilingHit = Number.isFinite(createdMs) && now - createdMs > ceilingMs;
      if (!windowStale && !ceilingHit) continue;
      const reason = ceilingHit ? 'absolute-ceiling' : 'no-probe-within-window';
      if (state.dryRun) {
        this.emit('aoft.would-deadletter-external', { id: c.id, reason });
        continue;
      }
      const waited = Number.isFinite(createdMs) ? humanizeMs(now - createdMs) : 'a while';
      const detail =
        `I've been waiting on an external dependency for "${(c.agentResponse || c.userRequest).slice(0, 80)}" ` +
        `for ${waited} (${reason === 'absolute-ceiling' ? 'past the max wait' : 'no movement in a while'}) — ` +
        `want me to keep waiting or drop it?`;
      try { this.config.raiseAttention?.(c.id, detail); } catch { /* non-fatal */ }
      await this.config.commitmentTracker.mutate(c.id, prev => ({
        ...prev,
        externalBlockDeadLetteredAt: new Date(now).toISOString(),
      }));
      this.emit('aoft.deadlettered-external', { id: c.id, reason });
    }
  }

  /**
   * C1+C2 §4.5 — drive the evidence-gated graveyard reconciler on the slow sweep
   * cadence (lease-gated by the caller). Rollout-gated: off → no-op; passes the
   * feature's dryRun through so the dark→live promotion is evidence-gated.
   */
  private maybeReconcileGraveyard(): void {
    const state = this.config.agentOwnedFollowthrough?.() ?? { enabled: false, dryRun: true };
    if (!state.enabled) return;
    try {
      const r = this.config.commitmentTracker.reconcileGraveyard({ dryRun: state.dryRun });
      if (r.closed.length || r.wouldClose.length) {
        this.emit('aoft.graveyard-reconciled', {
          closed: r.closed.length,
          wouldClose: r.wouldClose.length,
          dryRun: state.dryRun,
        });
      }
    } catch (err) {
      console.warn('[PromiseBeacon] graveyard reconcile error:', (err as Error).message);
    }
  }

  private async transitionViolated(c: Commitment, reason: string): Promise<void> {
    await this.config.commitmentTracker.mutate(c.id, prev => ({
      ...prev,
      status: 'violated',
      resolvedAt: new Date().toISOString(),
      resolution: reason,
    }));
    // Route through the owner-gated chokepoint as a TERMINAL kind: under
    // owner:'agent' (live) this reroutes to the Attention dead-letter instead of
    // a topic status message (never swallowed, never C2-violating status); off /
    // owner:'user' it sends to the topic exactly as before (guarded on topicId
    // inside emitUserSend).
    await this.emitUserSend(
      c,
      `⚠️ [promise-beacon] commitment "${(c.agentResponse || c.userRequest).slice(0, 80)}" violated: ${reason}`,
      'terminal',
    );
    this.stopFor(c.id);
    this.emit('promise.violated', { id: c.id, reason });
  }

  private inQuietHours(): boolean {
    const qh = this.config.quietHours;
    if (!qh) return false;
    const [sH, sM] = (qh.start || '22:00').split(':').map(Number);
    const [eH, eM] = (qh.end || '08:00').split(':').map(Number);
    const d = new Date(this.now());
    const mins = d.getHours() * 60 + d.getMinutes();
    const startMin = sH * 60 + sM;
    const endMin = eH * 60 + eM;
    if (startMin < endMin) {
      return mins >= startMin && mins < endMin;
    }
    // Wraps midnight.
    return mins >= startMin || mins < endMin;
  }

  private clampCadence(ms: number): number {
    return Math.min(this.maxCadenceMs, Math.max(this.minCadenceMs, ms));
  }

  private loadHotState(id: string): HotState {
    const p = path.join(this.stateDir, `${id}.json`);
    try {
      const raw = fs.readFileSync(p, 'utf-8');
      const parsed = JSON.parse(raw);
      return {
        heartbeatCount: 0,
        consecutiveUnchanged: 0,
        templatedVariantCursor: 0,
        ...parsed,
      };
    } catch {
      return {
        heartbeatCount: 0,
        consecutiveUnchanged: 0,
        templatedVariantCursor: 0,
      };
    }
  }

  private saveHotState(id: string, hot: HotState): void {
    const p = path.join(this.stateDir, `${id}.json`);
    try {
      // R4-minor-1: ATOMIC tmp→rename (the house pattern) — the seq-bearing
      // file must never tear: a crash mid-write that yielded a parseable file
      // with a reset seq would re-collide against the now-DURABLE E1 entry and
      // silently suppress a legitimate post-restart heartbeat.
      const tmp = `${p}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(hot, null, 2));
      fs.renameSync(tmp, p);
    } catch (err) {
      console.error(`[PromiseBeacon] persist failed for ${id}:`, (err as Error).message);
    }
  }

  /** Read-modify-write over the on-disk hot state — the delivery path and the
   *  heartbeat path both write it, and neither may clobber the other's fields. */
  private updateHotState(id: string, fn: (hot: HotState) => void): HotState {
    const hot = this.loadHotState(id);
    fn(hot);
    this.saveHotState(id, hot);
    return hot;
  }

  /** Test accessor. */
  getScheduledIds(): string[] {
    return [...this.timers.keys()];
  }
}

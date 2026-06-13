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
  if (raw.length <= MAX) return raw;
  const cut = raw.slice(0, MAX);
  const lastSpace = cut.lastIndexOf(' ');
  const boundary = lastSpace > 40 ? lastSpace : MAX;
  return cut.slice(0, boundary) + '…';
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
    console.log(`[PromiseBeacon] Started (${this.prefix})`);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
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

    // atRisk doubles cadence (spec Round 3 #1) — softer-toned + less frequent.
    const baseCadence = c.cadenceMs ?? 10 * 60_000;
    const effective = c.atRisk ? baseCadence * 2 : baseCadence;
    const cadence = this.clampCadence(effective) * this.timerMult;
    const hot = this.loadHotState(c.id);
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

    try {
      // ── Capture & hash ──
      let snapshot = '';
      if (sessionName) {
        const raw = this.config.captureSessionOutput(sessionName, 200);
        if (raw) {
          snapshot = sanitizeTmuxOutput(capOutput(raw), []);
        }
      }
      const hash = snapshot ? sha256(normalizeForHash(snapshot)) : 'empty';
      const hot = this.loadHotState(c.id);
      const unchanged = hash === hot.lastSnapshotHash;

      const excerpt = promiseExcerpt(c);
      const suffix = excerpt ? ` — re: ${excerpt}` : '';

      let text: string;
      let atRiskSignal = false;
      if (!snapshot || unchanged) {
        // Templated — no LLM call. Prolonged unchanged output is itself a
        // soft atRisk signal (2 consecutive unchanged snapshots).
        const unchangedIsAtRisk = hot.consecutiveUnchanged >= 2;
        const variants = unchangedIsAtRisk ? AT_RISK_VARIANTS : TEMPLATED_VARIANTS;
        const phrase = variants[hot.templatedVariantCursor % variants.length];
        text = `${this.prefix} ${phrase}${suffix}`;
        if (unchangedIsAtRisk) atRiskSignal = true;
        hot.consecutiveUnchanged += 1;
        hot.templatedVariantCursor += 1;
      } else {
        // LLM call — background lane, with AbortController preemption.
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
          hot.consecutiveUnchanged = 0;
        } catch (err) {
          if (err instanceof LlmAbortedError || (err as Error).message.includes('cap exceeded') || (err as Error).message.includes('reserve')) {
            text = `${this.prefix} still working (update deferred)${suffix}`;
          } else {
            text = `${this.prefix} still working (status fetch failed)${suffix}`;
          }
        }
      }

      // ── Send ──
      await this.config.sendMessage(c.topicId, text, {
        source: 'promise-beacon',
        isProxy: true,
        tier: 1,
      });

      // ── Persist hot state + mutate cold ──
      const nowIso = new Date(this.now()).toISOString();
      hot.lastHeartbeatAt = nowIso;
      hot.heartbeatCount += 1;
      hot.lastSnapshotHash = hash;
      this.saveHotState(c.id, hot);

      await this.config.commitmentTracker.mutate(c.id, prev => ({
        ...prev,
        lastHeartbeatAt: nowIso,
        heartbeatCount: (prev.heartbeatCount ?? 0) + 1,
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
      });

      // ── Auto-pause gate ───────────────────────────────────────────
      // After enough consecutive unchanged-snapshot heartbeats, emit one
      // final "auto-paused" message and stop firing. Non-terminal: status
      // stays `pending`; resume via POST /commitments/:id/resume or a
      // "keep watching" reply on the same topic.
      const threshold = c.beaconAutoPauseAfterUnchanged ?? this.defaultAutoPauseAfterUnchanged;
      const isUnchangedThisCycle = !snapshot || unchanged;
      if (threshold > 0 && isUnchangedThisCycle && hot.consecutiveUnchanged >= threshold) {
        await this.autoPause(c, excerpt);
        return; // do NOT re-arm
      }
    } finally {
      this.config.proxyCoordinator.release(c.topicId, 'promise-beacon');
    }

    // Re-arm.
    const next = this.config.commitmentTracker.getAll().find(x => x.id === id);
    if (next) this.schedule(next);
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
      await this.config.sendMessage(c.topicId!, finalText, {
        source: 'promise-beacon',
        isProxy: true,
        tier: 1,
      });
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
        await this.config.sendMessage(c.topicId, text, { source: 'promise-beacon', isProxy: true, tier: 1 });
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

  private async transitionViolated(c: Commitment, reason: string): Promise<void> {
    await this.config.commitmentTracker.mutate(c.id, prev => ({
      ...prev,
      status: 'violated',
      resolvedAt: new Date().toISOString(),
      resolution: reason,
    }));
    if (c.topicId) {
      await this.config.sendMessage(
        c.topicId,
        `⚠️ [promise-beacon] commitment "${(c.agentResponse || c.userRequest).slice(0, 80)}" violated: ${reason}`,
        { source: 'promise-beacon', isProxy: true, tier: 1 },
      );
    }
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
      fs.writeFileSync(p, JSON.stringify(hot, null, 2));
    } catch (err) {
      console.error(`[PromiseBeacon] persist failed for ${id}:`, (err as Error).message);
    }
  }

  /** Test accessor. */
  getScheduledIds(): string[] {
    return [...this.timers.keys()];
  }
}

/**
 * Commitment Tracker — durable promise enforcement for agent infrastructure.
 *
 * When a user asks an agent to change something, the agent says "done" — but
 * often the change doesn't stick. Sessions compact, configs revert, behavioral
 * promises get forgotten. This module closes that gap.
 *
 * Three commitment types:
 *   1. config-change  — enforced by code (auto-corrects config drift)
 *   2. behavioral     — injected into every session via hooks
 *   3. one-time-action — tracked until verified, then closed
 *
 * The CommitmentTracker runs as a server-side monitor. It does NOT depend on
 * the LLM following instructions — it enforces commitments independently.
 *
 * Lifecycle:
 *   record → verify → (auto-correct if needed) → monitor → resolve
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import crypto from 'node:crypto';
import type { LiveConfig } from '../config/LiveConfig.js';
import type { ComponentHealth } from '../core/types.js';
import { DegradationReporter } from './DegradationReporter.js';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';

// ── Types ─────────────────────────────────────────────────────────

export type CommitmentType = 'config-change' | 'behavioral' | 'one-time-action';
export type CommitmentStatus = 'pending' | 'verified' | 'violated' | 'expired' | 'withdrawn' | 'delivered';

export class CommitmentPersistenceError extends Error {
  readonly code = 'COMMITMENT_PERSISTENCE_FAILED';
  constructor(readonly errorClass: 'mkdir' | 'temp-write' | 'rename') {
    super(`Commitment store persistence failed (${errorClass})`);
    this.name = 'CommitmentPersistenceError';
  }
}

export type BlockerLifecycleFactor = 'request-to-persist' | 'clear-latency';
export interface BlockerEpisode {
  schemaVersion: 1;
  episodeId: string;
  startedAtMs: number | null;
  requestEventExpected: boolean;
  originMachineId: string;
  initialClass: 'external' | 'user-input' | 'user-authorization';
  transitions: Array<{ atMs: number; from: string; to: string }>;
  transitionOverflowCount: number;
  closedAtMs?: number;
  closeReason?: 'cleared' | 'delivered' | 'withdrawn' | 'expired';
  clearSourceId?: string;
  clearTelemetryCompleteAtMs?: number;
}

export interface Commitment {
  /** Unique identifier (CMT-xxx) */
  id: string;
  /** What the user asked for, in their words */
  userRequest: string;
  /** What the agent committed to */
  agentResponse: string;
  /** Commitment type determines verification strategy */
  type: CommitmentType;
  /** Current status */
  status: CommitmentStatus;
  /** When the commitment was made */
  createdAt: string;
  /** When the commitment was last verified */
  lastVerifiedAt?: string;
  /** When the commitment was fulfilled or violated */
  resolvedAt?: string;
  /** Resolution details */
  resolution?: string;
  /** Number of consecutive successful verifications */
  verificationCount: number;
  /** Number of violations detected */
  violationCount: number;
  /** Telegram topic ID where the commitment was made */
  topicId?: number;
  /**
   * durable-conversation-identity §3.5.2 property 5 (R4-M1): for a commitment
   * bound to a MINTED (negative) conversation id, the DENORMALIZED bind-time
   * tuple — recorded at the same bind moment whose `op:"bind-pin"` journal
   * line the §3.3 WAL rule fsyncs. Delivery targets `resolve(boundTuple)`
   * (coherence-checked) on ANY machine that ever delivers the binding, so an
   * ownership migration can never reopen the C3-class misdelivery. Absent on
   * legacy/Telegram bindings (delivery falls back to `resolve(id)`).
   */
  boundTuple?: { platform: 'slack'; channelId: string; threadTs: string | null };
  /**
   * §7 bind-time authority: WHO opened this durable state — recorded from the
   * VERIFIED bind-token payload (`session:<name>`) or the server-self
   * principal (`server:<component>`), never from the request body.
   */
  boundBy?: string;
  /** Source: 'agent' (self-registered) or 'sentinel' (detected by LLM scanner) */
  source?: 'agent' | 'sentinel' | 'manual';
  /** Exact motivating correction provenance for correspondence-gated work. */
  correctionId?: string;
  classReviewRef?: string;

  // ── C1+C2 "The Agent Carries the Loop" state model (owner ⟂ blockedOn) ──
  // Two ORTHOGONAL fields (spec agent-owned-followthrough §4.1, FD1/FD6):
  // `owner` = who drives the next action; `blockedOn` = what it waits on.
  // Agent-declared, NEVER regex-auto-classified. Back-filled on load
  // (owner ??= 'agent', blockedOn ??= 'none') and clamped on commitments-sync
  // receive. `owner`/`blockedOn` are immutable via plain PATCH (a transition
  // goes through the guarded /commitments/:id/transition route that re-runs the
  // record()-time well-formedness gates).
  /** Who drives the next action. Default 'agent' (the agent owns follow-through). */
  owner?: 'agent' | 'user';
  /** What the next action waits on. Default 'none'. */
  blockedOn?: 'none' | 'external' | 'user-input' | 'user-authorization';
  /** throughput-metrics v1: authoritative bounded blocker lifecycle handoff. */
  blockerEpisodes?: BlockerEpisode[];
  /** Capacity fallback pairing one dropped open with its later clear. */
  blockerMeasurementDropped?: { openedAtMs: number };
  /**
   * For an owner:'agent' commitment whose work is side-effecting: the agent's
   * self-declared action class. INERT in C1+C2 (well-formedness-validated only,
   * no runtime consumer); forward-compatible plumbing for the C3 ratchet
   * follow-on (agent-autonomy-ratchet). Side-effect authority remains the
   * existing tool-call-time external-operation-gate, unchanged by this feature.
   */
  actionClass?: string;
  /**
   * For owner:'agent', blockedOn:'external': the last observable dependency-probe
   * recorded by the agent's own session (via POST /commitments/:id/probe). A
   * fresh probe resets the external-block staleness window (§4.4); it never
   * resets the absolute lifetime ceiling. Observation Needs Structure — the
   * refused-without-it artifact that makes "monitoring" falsifiable.
   */
  lastProbe?: { at: string; checked: string; readinessSignal: string };
  /**
   * Set when the external-block staleness governor (§4.4) has dead-lettered this
   * commitment (raised the ONE operator Attention item). Dedupes the dead-letter
   * so it fires once per stale episode. Cleared by a fresh recordProbe (a renewed
   * genuine wait re-arms the governor).
   */
  externalBlockDeadLetteredAt?: string;
  /**
   * Names a newer commitment that supersedes this one. Objective close-evidence
   * for the §4.5 graveyard reconciler: when the named superseder reaches a
   * terminal-success status, this commitment is auto-closed as superseded (a
   * disposition with evidence — NOT an "abandoned" auto-close). Settable at
   * record() or via the guarded transition route.
   */
  supersededBy?: string;

  // ── Type-specific fields ────────────────────────────────

  /** For config-change: the config path and expected value */
  configPath?: string;
  configExpectedValue?: unknown;

  /** For behavioral: the rule text injected into sessions */
  behavioralRule?: string;
  /** For behavioral/one-time: when this commitment expires (null = forever) */
  expiresAt?: string;

  /** For one-time-action: verification method */
  verificationMethod?: 'config-value' | 'file-exists' | 'manual' | 'threadline-reply';
  /** For one-time-action with file-exists: the path to check */
  verificationPath?: string;

  /**
   * For verificationMethod === 'threadline-reply': the thread we're waiting on.
   * Resolved externally by ThreadlineRouter when the awaited reply arrives —
   * the periodic verify sweep is a no-op for this method.
   * Per THREAD-TOPIC-LINKAGE-SPEC.md.
   */
  relatedThreadId?: string;
  /** For verificationMethod === 'threadline-reply': the remote agent. */
  relatedAgent?: string;
  /**
   * For verificationMethod === 'threadline-reply': ISO timestamp of the most
   * recently delivered reply on this thread. Used by the salience gate's
   * first-reply detection (a thread is "first contact" iff no `lastReplyAt`
   * has been recorded yet). Distinct from `heartbeatCount`, which counts
   * beacon emissions, not reply arrivals.
   */
  lastReplyAt?: string;

  /**
   * For CollaborationRedriveEngine — DURABLE, MONOTONIC, REPLY-INDEPENDENT
   * count of bounded follow-up nudges sent to the counterpart on this
   * objective. A counterpart reply updates `lastReplyAt` (silence clock) but
   * NEVER touches this — the load-bearing termination guarantee for the
   * mutual re-drive scenario. Spec:
   * docs/specs/collaboration-redrive-on-counterpart-silence.md §2.4.
   */
  redriveCount?: number;
  /** ISO timestamp of the most recent re-drive send (spacing window). */
  lastRedriveAt?: string;
  /** Text of the most recent re-drive (decorative novelty-tiebreaker). */
  lastRedriveText?: string;

  // ── Self-healing tracking ─────────────────────────────

  /** Number of times auto-correction has fired for this commitment */
  correctionCount: number;
  /** Timestamps of recent corrections (for pattern detection) */
  correctionHistory: string[];
  /** Whether this commitment has been escalated as a potential bug */
  escalated: boolean;
  /** Escalation details */
  escalationDetail?: string;

  // ── Concurrency ───────────────────────────────────────

  /**
   * Monotonically-increasing version for optimistic CAS in mutate().
   * Back-filled to 0 on records from store v1.
   */
  version: number;

  // ── Promise Beacon (Phase 1 — PROMISE-BEACON-SPEC.md) ──
  /** When set, this commitment is watched by PromiseBeacon. Requires topicId. */
  beaconEnabled?: boolean;
  /** Heartbeat cadence in ms. Server clamps to [60_000, 21_600_000]. */
  cadenceMs?: number;
  /**
   * Soft "I'll check in by X" marker. Past it, one atRisk notice is emitted
   * and cadence continues (see Round 3 clarification #4).
   */
  nextUpdateDueAt?: string;
  /** Soft deadline — past it, cadence doubles (no terminal transition). */
  softDeadlineAt?: string;
  /** Hard deadline — past it, commitment transitions to `expired`. */
  hardDeadlineAt?: string;
  /** Last heartbeat emission (ISO). */
  lastHeartbeatAt?: string;
  /** Count of heartbeats emitted so far. */
  heartbeatCount?: number;
  /**
   * Claude Code session UUID at declaration. On mismatch, commitment is
   * violated with reason `"session-lost"` (Round 3 #3).
   */
  sessionEpoch?: string;
  /**
   * Non-terminal flag — Tier-3 "stalled" verdicts set this; still heartbeating
   * with a softer tone. Only corroborated signals transition to `violated`.
   */
  atRisk?: boolean;
  /**
   * Non-terminal flag — boot-cap / daily-spend-cap suppression. Status stays
   * `pending`, no heartbeats fire (Round 3 #2).
   */
  beaconSuppressed?: boolean;
  /** Reason accompanying `beaconSuppressed`. */
  beaconSuppressionReason?: string;
  /** SHA-256 of the last tmux snapshot used for a heartbeat. */
  lastSnapshotHash?: string;
  /** Machine owning the beacon for this commitment. */
  ownerMachineId?: string;
  /** Provenance of the beacon-enabling mutation. */
  beaconCreatedBySource?: 'skill' | 'api-loopback' | 'sentinel' | 'manual';
  /** Idempotency key for skill retries. */
  externalKey?: string;
  /** Verified delivery message id (set by POST /commitments/:id/deliver). */
  deliveryMessageId?: string;
  /**
   * Non-terminal: beacon is paused because nothing has changed for
   * `beaconAutoPauseAfterUnchanged` consecutive heartbeats. Status stays
   * `pending`. Cleared by POST /commitments/:id/resume (or by a "keep watching"
   * Telegram reply on the same topic).
   */
  beaconPaused?: boolean;
  /** Reason accompanying `beaconPaused` (e.g. `"auto-paused-no-progress"`). */
  beaconPausedReason?: string;
  /** When the beacon was paused (ISO). */
  beaconPausedAt?: string;
  /**
   * Number of consecutive unchanged-snapshot heartbeats before auto-pausing.
   * Default 12 (≈2h at 10-min cadence). 0 disables auto-pause.
   */
  beaconAutoPauseAfterUnchanged?: number;
  /**
   * Snapshot of the unchanged-streak length at the pause boundary, written
   * only when the beacon auto-pauses or when /resume zeroes it. Hot-state
   * (in PromiseBeacon's per-id JSON) is authoritative during a live run;
   * this cold-state field exists for dashboard / API observability of paused
   * beacons. Not updated on every heartbeat to avoid serialized-write
   * amplification on the mutate queue.
   */
  consecutiveUnchanged?: number;

  // ── Commitments Coherence (P1.5 — COMMITMENTS-COHERENCE-SPEC §3.1/§3.2) ──

  /**
   * The machine that CREATED this record — the cross-machine identity is the
   * composite (originMachineId, id) because ids are per-machine sequential
   * counters (CMT-001…) and collide across machines by construction. Stamped
   * at creation, NEVER reassigned. Legacy records: absent ⇒ owned by the
   * store they live in (serve-time stamping + lazy back-fill on next mutate).
   */
  originMachineId?: string;
  /**
   * The store replicationSeq of this record's last STATE-MEANINGFUL mutation
   * (status/fields/creation — NOT beacon bookkeeping). What makes
   * commitments-sync a seq-windowed DELTA instead of a whole-store blob.
   */
  lastMutatedSeq?: number;

  // ── Promise-Beacon Escalation (PROMISE-BEACON-ESCALATION-SPEC §4) ──
  // ALL server-written-only (I11): never accepted on POST/PATCH /commitments.
  // Durable cold-state so a restart cannot reset the cap (I1).
  /** Count of Rung-1 revive attempts. Incremented BEFORE the spawn (I1). */
  escalationAttempts?: number;
  /** ISO of the most recent escalation attempt (backoff floor anchor). */
  lastEscalationAt?: string;
  /** Which rung the escalation is currently on. */
  currentRung?: '1' | '2' | '3' | null;
  /** Idempotency key for the in-flight Rung-1 spawn (I6/I14). */
  escalationAttemptId?: string;
  /** True while a Rung-1 revive is in flight (resolved by the timeout contract, §3.1). */
  escalationInFlight?: boolean;
  /**
   * Spawn-time marker on a revived session. Read by the external-operation-gate
   * to block side-effecting tools until server-recorded revalidation (I13).
   */
  revivalMode?: 'status-only-until-revalidated';
  /** Server-recorded revalidation time (ISO). Unblocks side-effects in the gate (I13). */
  revalidatedAt?: string;
  /** The authenticated session id that revalidated (I13). */
  revalidatedBy?: string;
  /** Count of Rung-2 honest-status notifications sent (bounded, §3.2). */
  rung2NotificationCount?: number;
  /** ISO of the most recent Rung-2 send (per-commitment floor). */
  lastRung2At?: string;
  /** Most recent escalation refusal reason for observability (§6). */
  refusalReason?: string;
}

export interface CommitmentStore {
  version: 2;
  commitments: Commitment[];
  lastModified: string;
  // ── Commitments Coherence (P1.5 §3.2) — ADDITIVE fields only: the schema
  // `version: 2` literal is deliberately untouched (a version bump would trip
  // loadStore's acceptance guard and wipe the store on downgrade paths).
  /** Monotonic counter bumped on state-meaningful writes (deliberately NOT
   *  named `version` — that name is taken twice already in this file). */
  replicationSeq?: number;
  /** Re-minted on rewind detection (backup restore) — receivers replace the
   *  replica wholesale on incarnation change instead of stranding behind a
   *  higher remembered seq (the journal §3.4 rule 3 cure). */
  storeIncarnation?: string;
  /** Content-free daily missing-sample counters, bounded to 30 UTC days. */
  blockerEpisodeDropBuckets?: Record<string, { request: number; clear: number }>;
}

export interface CommitmentVerificationReport {
  timestamp: string;
  active: number;
  verified: number;
  violated: number;
  pending: number;
  violations: Array<{
    id: string;
    userRequest: string;
    detail: string;
    autoCorrected: boolean;
  }>;
}

/**
 * durable-conversation-identity §6.1 step 2: the conversation-registry bind
 * surface injected at bootstrap. `bind` performs the durable-binding-forced
 * registration + the §3.5.2 bind-pin (journal line fsynced BEFORE the bind
 * returns — the §3.3 WAL rule) and hands back the bind-time tuple; `release`
 * decrements the pin's refcount when the binding closes.
 */
export interface ConversationBinder {
  bind(
    conversationId: number,
  ):
    | { ok: true; boundTuple: { platform: 'slack'; channelId: string; threadTs: string | null } }
    | { ok: false; error: string };
  release(conversationId: number): void;
}

export interface CommitmentTrackerConfig {
  stateDir: string;
  liveConfig: LiveConfig;
  /** durable-conversation-identity binder (usually late-bound via
   *  setConversationBinder at bootstrap — the registry constructs after the
   *  tracker). Absent → minted-id binds carry no pin/boundTuple (legacy). */
  conversationBinder?: ConversationBinder;
  /** This machine's mesh identity — stamped as originMachineId on every NEW
   *  commitment (P1.5 §3.1). Absent on single-machine agents pre-mesh; records
   *  created without it are legacy-local by definition. */
  originMachineId?: string;
  /** Dark measure-only blocker lifecycle instrumentation. */
  blockerLifecycleEnabled?: boolean;
  /** Check interval in ms. Default: 60_000 (1 minute) */
  checkIntervalMs?: number;
  /** Auto-expire old agent-owned open commitments. Defaults: enabled, 21d, 6h, dry-run. */
  autoExpiry?: CommitmentAutoExpiryConfig;
  /** Callback when a violation is detected */
  onViolation?: (commitment: Commitment, detail: string) => void;
  /** Callback when a commitment is verified for the first time */
  onVerified?: (commitment: Commitment) => void;
  /** Callback when repeated corrections suggest a bug. */
  onEscalation?: (commitment: Commitment, detail: string) => void;
  /** Number of corrections within the window that triggers escalation. Default: 3 */
  escalationThreshold?: number;
  /** Time window for counting corrections (ms). Default: 3_600_000 (1 hour) */
  escalationWindowMs?: number;
}

export interface CommitmentAutoExpiryConfig {
  enabled?: boolean;
  maxAgeDays?: number;
  sweepIntervalMs?: number;
  dryRun?: boolean;
}

export interface CommitmentAutoExpirySweepReport {
  timestamp: string;
  dryRun: boolean;
  enabled: boolean;
  maxAgeDays: number;
  scanned: number;
  eligible: number;
  expired: number;
  capped: boolean;
}

// ── Implementation ────────────────────────────────────────────────

/** Max depth of the per-id mutate queue. Enqueue beyond this rejects. */
const MUTATE_QUEUE_MAX_DEPTH = 256;
/** Max CAS retries when the version drifts under an apply. */
const MUTATE_CAS_MAX_RETRIES = 5;
const DEFAULT_AUTO_EXPIRY_MAX_AGE_DAYS = 21;
const DEFAULT_AUTO_EXPIRY_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const AUTO_EXPIRY_SWEEP_CAP = 500;

type MutateFn = (c: Commitment) => Commitment | Promise<Commitment>;
interface MutateQueueEntry {
  fn: MutateFn;
  resolve: (c: Commitment) => void;
  reject: (err: Error) => void;
}

export class CommitmentTracker extends EventEmitter {
  private config: CommitmentTrackerConfig;
  private store: CommitmentStore;
  private storePath: string;
  private rulesPath: string;
  private interval: ReturnType<typeof setInterval> | null = null;
  private autoExpiryInterval: ReturnType<typeof setInterval> | null = null;
  private autoExpiryInitialTimeout: ReturnType<typeof setTimeout> | null = null;
  private nextId: number;
  /**
   * Coalesce the per-mutation full-store writes of a synchronous sweep into ONE
   * write at the end. `verify()` mutates every active commitment via
   * `mutateSync()`, and each `mutateSync()` calls `saveStore()` — which
   * `JSON.stringify`s the ENTIRE store. With a large store (e.g. ~1.6MB / ~1700
   * commitments) and N active commitments that is O(N) full-store serializations
   * per sweep, which froze the single event-loop thread for MINUTES (observed
   * 2026-06-21: server `/health` HTTP 000, watchdog SIGKILL/respawn loop). While
   * batching, `saveStore()` marks the store dirty and returns; the sweep flushes
   * exactly one write at the end. SAFE because the sweep is fully synchronous and
   * never yields the event loop, so no other write path can observe or interleave
   * with the deferred window.
   */
  private batchingSaves = false;
  private pendingSave = false;
  private batchSnapshot: CommitmentStore | null = null;
  private pendingBindingReleases: Array<{ before: Commitment; after: Commitment }> = [];

  /**
   * Single-writer FIFO queues, keyed by commitment id. Every write path
   * (record/withdraw/verifyOne/expire/auto-correct/escalate) serialises
   * through mutate(), which CAS-retries on the commitment's `version`
   * field. p99 target for the caller-supplied fn is 50ms under load.
   */
  private mutateQueues: Map<string, MutateQueueEntry[]> = new Map();
  private mutateRunning: Set<string> = new Set();

  /**
   * Bounded thread→commitment index for fast O(1) findByThreadId lookups.
   * Keyed by relatedThreadId, value is the commitment id. Only includes
   * threadline-reply commitments in non-terminal states. Rebuilt on load,
   * maintained on every mutate.
   */
  private threadIdIndex: Map<string, string> = new Map();

  constructor(config: CommitmentTrackerConfig) {
    super();
    this.config = config;
    this.storePath = path.join(config.stateDir, 'state', 'commitments.json');
    this.rulesPath = path.join(config.stateDir, 'state', 'commitment-rules.md');
    this.store = this.loadStore();
    this.nextId = this.computeNextId();
    this.backfillUnverifiableOneTimeActions();
    this.rebuildThreadIdIndex();
  }

  /**
   * One-shot migration: any pre-existing one-time-action that is stuck
   * in `violated` with no real verification method (violationCount > 0,
   * verificationCount === 0, no verificationMethod) is retro-transitioned
   * to `delivered` with a clear resolution. This drains the ~270 noisy
   * rows that accumulated before this fix shipped. Idempotent — rows
   * already `delivered`/`withdrawn`/`expired` are skipped.
   */
  private backfillUnverifiableOneTimeActions(): void {
    const rollback = structuredClone(this.store);
    let changed = 0;
    for (const c of this.store.commitments) {
      if (c.type !== 'one-time-action') continue;
      if (c.status === 'delivered' || c.status === 'withdrawn' || c.status === 'expired') continue;
      if (!CommitmentTracker.isUnverifiableOneTime(c)) continue;
      // Scope to what the docstring above always claimed: ONLY the historical
      // noisy rows (stuck violated, violations accumulated, never verified).
      // Without this check, every BOOT retro-terminalized every pending
      // unverifiable promise — under restart churn that re-introduced the
      // CMT-1101 evaporation through the back door, clobbering the verify-sweep
      // fix within minutes (2026-06-05, framework-issue 5bac8d53).
      if (!((c.violationCount ?? 0) > 0 && (c.verificationCount ?? 0) === 0)) continue;
      c.status = 'delivered';
      c.resolvedAt = c.resolvedAt ?? new Date().toISOString();
      c.resolution =
        c.resolution ??
        'Backfilled: no automated verification method — trusting agent acknowledgment.';
      c.version = (c.version ?? 0) + 1;
      changed++;
    }
    if (changed > 0) {
      try {
        const saved = this.saveStore();
        if (saved.state === 'failed') {
          this.store = rollback;
          throw new CommitmentPersistenceError(saved.errorClass);
        }
        console.log(
          `[CommitmentTracker] Backfill: ${changed} unverifiable one-time-action(s) transitioned to delivered`,
        );
      } catch (err) {
        console.warn(
          `[CommitmentTracker] Backfill save failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  start(): void {
    if (this.interval) return;

    const intervalMs = this.config.checkIntervalMs ?? 60_000;
    const autoExpiry = this.resolveAutoExpiryConfig();

    // First verification after a short delay
    setTimeout(() => this.verify(), 15_000);

    this.interval = setInterval(() => this.verify(), intervalMs);
    this.interval.unref();

    if (autoExpiry.enabled) {
      this.autoExpiryInitialTimeout = setTimeout(() => {
        this.autoExpiryInitialTimeout = null;
        this.sweepAutoExpiry();
      }, 30_000);
      this.autoExpiryInitialTimeout.unref();
      this.autoExpiryInterval = setInterval(() => {
        this.sweepAutoExpiry();
      }, autoExpiry.sweepIntervalMs);
      this.autoExpiryInterval.unref();
    }

    const active = this.getActive().length;
    if (active > 0) {
      console.log(`[CommitmentTracker] Started (every ${Math.round(intervalMs / 1000)}s, ${active} active commitment(s))`);
    } else {
      console.log(`[CommitmentTracker] Started (every ${Math.round(intervalMs / 1000)}s, no active commitments)`);
    }
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.autoExpiryInitialTimeout) {
      clearTimeout(this.autoExpiryInitialTimeout);
      this.autoExpiryInitialTimeout = null;
    }
    if (this.autoExpiryInterval) {
      clearInterval(this.autoExpiryInterval);
      this.autoExpiryInterval = null;
    }
  }

  // ── Commitment CRUD ────────────────────────────────────────────

  /**
   * Record a new commitment. Returns the created commitment.
   */
  record(input: {
    userRequest: string;
    agentResponse: string;
    type: CommitmentType;
    topicId?: number;
    source?: 'agent' | 'sentinel' | 'manual';
    configPath?: string;
    configExpectedValue?: unknown;
    behavioralRule?: string;
    expiresAt?: string;
    verificationMethod?: 'config-value' | 'file-exists' | 'manual' | 'threadline-reply';
    verificationPath?: string;
    relatedThreadId?: string;
    relatedAgent?: string;
    // Promise Beacon (Phase 1) — all optional & additive.
    beaconEnabled?: boolean;
    cadenceMs?: number;
    nextUpdateDueAt?: string;
    softDeadlineAt?: string;
    hardDeadlineAt?: string;
    sessionEpoch?: string;
    ownerMachineId?: string;
    externalKey?: string;
    beaconCreatedBySource?: 'skill' | 'api-loopback' | 'sentinel' | 'manual';
    // C1+C2 "The Agent Carries the Loop" state model (spec §4.1). Optional +
    // additive; default owner='agent', blockedOn='none'.
    owner?: 'agent' | 'user';
    blockedOn?: 'none' | 'external' | 'user-input' | 'user-authorization';
    actionClass?: string;
    supersededBy?: string;
    correctionId?: string;
    classReviewRef?: string;
    /** §7: the verified bind principal (`session:<name>` from the verified
     *  token payload, or `server:<component>` for in-process callers) —
     *  recorded by the GATE, never trusted from a request body. */
    boundBy?: string;
  }): Commitment {
    // FD3 (action-claim-followthrough): idempotent create keyed on externalKey.
    // If an OPEN (non-terminal) commitment already carries this externalKey,
    // RETURN it instead of minting a duplicate — so a restated claim ("I'll
    // restart it" across turns) updates one commitment rather than spawning N.
    // Mirrors the live precedent at server.ts (getActive().some(externalKey===)).
    // Runs FIRST: a dup short-circuits before validation (the existing commitment
    // was already well-formed when created).
    if (input.externalKey) {
      const existing = this.getActive().find((c) => c.externalKey === input.externalKey);
      if (existing) return existing;
    }
    // ── C1+C2 well-formedness gates (spec §4.1) — STRUCTURAL only (Signal-vs-
    // Authority): validate the agent's own declaration; do NOT classify prose;
    // hold NO side-effect authority (that stays with the tool-call gate).
    // Shared with transitionState() so a guarded transition re-runs the SAME gate.
    const { owner, blockedOn, actionClass } = CommitmentTracker.normalizeState(input);

    // ── durable-conversation-identity §6.1 step 2: a durable bind on a MINTED
    // (negative) conversation id registers the conversation durably + records
    // the §3.5.2 bind-pin, and denormalizes the bind-time tuple onto THIS
    // record (property 5 — so any machine that ever delivers the binding can
    // reconstruct the pin). A typed binder refusal (recording disabled,
    // registration capacity, unresolvable id) THROWS — a commitment on a
    // minted id must never be created silently unpinned/undeliverable-after-
    // restart; the route maps the typed error to a client status.
    let boundTuple: Commitment['boundTuple'];
    if (typeof input.topicId === 'number' && input.topicId < 0 && this.config.conversationBinder) {
      const bindResult = this.config.conversationBinder.bind(input.topicId);
      if (!bindResult.ok) {
        throw new Error(bindResult.error);
      }
      boundTuple = bindResult.boundTuple;
    }

    const id = `CMT-${String(this.nextId++).padStart(3, '0')}`;

    // Auto-enable PromiseBeacon on time-promise commitments. If the
    // caller didn't explicitly set beaconEnabled, sniff the agent's
    // response for a time marker like "back in 20 min" or "by EOD" —
    // when present AND a topicId is attached, opt the commitment in
    // with a conservative cadence and hard deadline. This closes the
    // "I said 'back in an hour' and went silent" gap without requiring
    // every record() call-site to plumb beacon flags.
    let autoBeaconEnabled = input.beaconEnabled;
    let autoCadenceMs = input.cadenceMs;
    let autoHardDeadlineAt = input.hardDeadlineAt;
    if (autoBeaconEnabled === undefined && input.topicId !== undefined) {
      const detected = CommitmentTracker.detectTimePromise(input.agentResponse);
      if (detected) {
        autoBeaconEnabled = true;
        autoCadenceMs = autoCadenceMs ?? detected.cadenceMs;
        autoHardDeadlineAt =
          autoHardDeadlineAt ??
          new Date(Date.now() + detected.hardDeadlineOffsetMs).toISOString();
      }
    }

    const commitment: Commitment = {
      id,
      userRequest: input.userRequest,
      agentResponse: input.agentResponse,
      type: input.type,
      status: 'pending',
      createdAt: new Date().toISOString(),
      verificationCount: 0,
      violationCount: 0,
      topicId: input.topicId,
      ...(boundTuple ? { boundTuple } : {}),
      ...(input.boundBy ? { boundBy: input.boundBy } : {}),
      source: input.source ?? 'agent',
      ...(input.correctionId ? { correctionId: input.correctionId } : {}),
      ...(input.classReviewRef ? { classReviewRef: input.classReviewRef } : {}),
      // C1+C2 "The Agent Carries the Loop" state model (spec §4.1).
      owner,
      blockedOn,
      ...(actionClass ? { actionClass } : {}),
      ...(input.supersededBy ? { supersededBy: input.supersededBy } : {}),
      configPath: input.configPath,
      configExpectedValue: input.configExpectedValue,
      behavioralRule: input.behavioralRule,
      expiresAt: input.expiresAt,
      verificationMethod: input.verificationMethod,
      verificationPath: input.verificationPath,
      relatedThreadId: input.relatedThreadId,
      relatedAgent: input.relatedAgent,
      correctionCount: 0,
      correctionHistory: [],
      escalated: false,
      version: 0,
      // CollaborationRedriveEngine: default the durable cap counter so
      // newly-created threadline-reply commitments have an explicit 0
      // (existing rows are backfilled by loadStore()).
      redriveCount: 0,
      // Promise Beacon fields (Phase 1).
      beaconEnabled: autoBeaconEnabled,
      cadenceMs: autoCadenceMs,
      nextUpdateDueAt: input.nextUpdateDueAt,
      softDeadlineAt: input.softDeadlineAt,
      hardDeadlineAt: autoHardDeadlineAt,
      sessionEpoch: input.sessionEpoch,
      // WS3.2 (MULTI-MACHINE-SEAMLESSNESS-SPEC, closes F19): ownerMachineId is
      // recorded at creation — defaulting to the creating machine, which IS the
      // machine serving the topic when the promise is made. Previously this was
      // caller-supplied only and never populated, so PromiseBeacon's ownership
      // gate compared against undefined and was silently inert. The stamp is a
      // FALLBACK: the beacon re-resolves the live topic owner at speak time.
      ownerMachineId: input.ownerMachineId ?? this.config.originMachineId,
      externalKey: input.externalKey,
      beaconCreatedBySource: input.beaconCreatedBySource,
      heartbeatCount: 0,
      // P1.5 §3.1: the creator stamp — the composite (originMachineId, id) is
      // THE cross-machine identity (ids are per-machine sequential counters).
      // Distinct from ownerMachineId (a caller-supplied beacon field).
      ...(this.config.originMachineId ? { originMachineId: this.config.originMachineId } : {}),
    };

    // Insert via the same discipline future writes use: under the single-
    // writer surface, initial version is 0 and future mutations CAS from there.
    this.insertNew(commitment);

    // Regenerate behavioral rules file if this is a behavioral commitment
    if (input.type === 'behavioral') {
      this.writeBehavioralRules();
    }

    this.refreshThreadIdIndex(commitment);

    console.log(`[CommitmentTracker] Recorded ${id}: "${input.userRequest}" (${input.type})`);
    this.emit('recorded', commitment);

    // Run immediate verification for config-change commitments.
    // verifyOne goes through mutateSync, which replaces the store entry
    // with a new object — return the freshest snapshot so callers see
    // the post-verification status.
    if (input.type === 'config-change') {
      this.verifyOne(id);
    }

    return this.get(id) ?? commitment;
  }

  /**
   * Withdraw a commitment (user changed their mind).
   */
  withdraw(id: string, reason: string): boolean {
    const existing = this.store.commitments.find(c => c.id === id);
    if (!existing || existing.status === 'withdrawn' || existing.status === 'expired') {
      return false;
    }

    const updated = this.mutateSync(id, c => ({
      ...c,
      status: 'withdrawn',
      resolvedAt: new Date().toISOString(),
      resolution: reason,
    }));

    if (updated.type === 'behavioral') {
      this.writeBehavioralRules();
    }

    this.refreshThreadIdIndex(updated);

    console.log(`[CommitmentTracker] Withdrawn ${id}: ${reason}`);
    this.emit('withdrawn', updated);
    return true;
  }

  /**
   * Resume a paused beacon. Clears `beaconPaused`/`beaconPausedReason`/
   * `beaconPausedAt` and resets `consecutiveUnchanged` to zero. The caller
   * (PromiseBeacon) re-schedules on the `resumed` event.
   *
   * Returns the updated commitment, or null if not found or not in a
   * resumable state (terminal status, or not paused).
   */
  resume(id: string): Commitment | null {
    const existing = this.store.commitments.find(c => c.id === id);
    if (!existing) return null;
    // verified/violated are observation states and may oscillate; only lifecycle
    // closure states permanently forbid a blocker-state transition.
    if (['expired', 'withdrawn', 'delivered'].includes(existing.status)) {
      return null;
    }
    if (!existing.beaconPaused) return null;
    const updated = this.mutateSync(id, c => ({
      ...c,
      beaconPaused: false,
      beaconPausedReason: undefined,
      beaconPausedAt: undefined,
      consecutiveUnchanged: 0,
    }));
    console.log(`[CommitmentTracker] Resumed ${id}`);
    this.emit('resumed', updated);
    return updated;
  }

  /**
   * Mark a beacon-enabled commitment as delivered (distinct from verified).
   * Per PROMISE-BEACON-SPEC.md Round 3 #18: `delivered` is terminal; no more
   * heartbeats, no more verify attempts.
   */
  deliver(id: string, deliveryMessageId?: string): Commitment | null {
    const existing = this.store.commitments.find(c => c.id === id);
    if (!existing) return null;
    // Terminal statuses reject.
    if (['verified', 'violated', 'expired', 'withdrawn', 'delivered'].includes(existing.status)) {
      return null;
    }
    const updated = this.mutateSync(id, c => ({
      ...c,
      status: 'delivered' as CommitmentStatus,
      resolvedAt: new Date().toISOString(),
      deliveryMessageId: deliveryMessageId ?? c.deliveryMessageId,
    }));
    this.refreshThreadIdIndex(updated);

    console.log(`[CommitmentTracker] Delivered ${id}`);
    this.emit('delivered', updated);
    return updated;
  }

  /**
   * Expire a commitment through the same terminal transition used by sweeps.
   */
  expire(id: string, reason = 'Expired'): Commitment | null {
    const existing = this.store.commitments.find(c => c.id === id);
    if (!existing) return null;
    if (['expired', 'withdrawn', 'delivered'].includes(existing.status)) return null;
    const updated = this.expireSync(id, reason, new Date().toISOString());
    this.refreshThreadIdIndex(updated);
    this.emit('expired', updated);
    return updated;
  }

  /**
   * Record that a reply arrived on a threadline-reply commitment. Updates
   * `lastReplyAt` without transitioning status. Used by the salience gate's
   * first-reply detection — `heartbeatCount` is incremented by PromiseBeacon
   * for "still waiting" emissions, not by reply arrivals, so we need a
   * separate signal here.
   *
   * No-op on missing commitment or wrong type. Goes through mutateSync so
   * concurrent writes serialize cleanly.
   */
  markReplyArrived(id: string, replyAt?: string): Commitment | null {
    const existing = this.store.commitments.find(c => c.id === id);
    if (!existing) return null;
    if (existing.type !== 'one-time-action') return null;
    if (existing.verificationMethod !== 'threadline-reply') return null;
    return this.mutateSync(id, c => ({
      ...c,
      lastReplyAt: replyAt ?? new Date().toISOString(),
    }));
  }

  /**
   * C1+C2 (spec agent-owned-followthrough §4.4) — record an observable
   * dependency-probe on an owner:'agent', blockedOn:'external' commitment. The
   * agent's own session calls this (via POST /commitments/:id/probe) when it
   * checks the external dependency; a fresh probe RESETS the staleness window
   * (but never the absolute lifetime ceiling). This is the "Observation Needs
   * Structure" artifact that makes "monitoring" falsifiable. No-op (returns
   * null) on a missing commitment, a terminal status, or a commitment that is
   * not currently an external-block — a probe only means something for the
   * state it governs.
   */
  recordProbe(id: string, probe: { checked: string; readinessSignal: string }): Commitment | null {
    const existing = this.store.commitments.find(c => c.id === id);
    if (!existing) return null;
    if (['verified', 'violated', 'expired', 'withdrawn', 'delivered'].includes(existing.status)) {
      return null;
    }
    if (existing.blockedOn !== 'external') return null;
    const checked = String(probe.checked ?? '').trim().slice(0, 500);
    const readinessSignal = String(probe.readinessSignal ?? '').trim().slice(0, 500);
    if (!checked || !readinessSignal) return null;
    const updated = this.mutateSync(id, c => ({
      ...c,
      lastProbe: { at: new Date().toISOString(), checked, readinessSignal },
      // A fresh probe re-arms the governor: clear any prior dead-letter mark so a
      // future re-stale fires again (a renewed genuine wait, not a stuck one).
      externalBlockDeadLetteredAt: undefined,
    }));
    this.emit('probe-recorded', updated);
    return updated;
  }

  /**
   * C1+C2 §4.5 — evidence-gated graveyard reconciler. Auto-closes a pending
   * commitment ONLY on objective evidence: its `supersededBy` names a commitment
   * that has reached a terminal-SUCCESS status (verified | delivered). It NEVER
   * closes a row that merely looks stale — "abandoned" is never an auto-close
   * (CMT-1101 scar); evidence-less stale rows route to agent-drive / surface via
   * the give-up + the external-block governor. Bounded by maxClosesPerPass;
   * dryRun computes the close set without mutating. Each close writes a
   * disposition-evidence resolution. (Verification-method passes are handled by
   * the continuous verify() sweep, not here — this adds the supersession
   * evidence type + the bounded, dry-run-able, feature/lease-gated drain.)
   */
  reconcileGraveyard(opts: { maxClosesPerPass?: number; dryRun?: boolean } = {}): {
    closed: string[];
    wouldClose: string[];
    scanned: number;
  } {
    const max = opts.maxClosesPerPass ?? 25;
    const dryRun = opts.dryRun ?? false;
    const TERMINAL_SUCCESS = new Set<CommitmentStatus>(['verified', 'delivered']);
    const closed: string[] = [];
    const wouldClose: string[] = [];
    let scanned = 0;
    for (const c of this.getActive()) {
      if (closed.length >= max || wouldClose.length >= max) break;
      if (c.status !== 'pending') continue;
      if (!c.supersededBy) continue; // no objective evidence → NEVER auto-close
      scanned++;
      const superseder = this.store.commitments.find(s => s.id === c.supersededBy);
      if (!superseder || !TERMINAL_SUCCESS.has(superseder.status)) continue; // evidence not present yet
      if (dryRun) { wouldClose.push(c.id); continue; }
      this.mutateSync(c.id, prev => ({
        ...prev,
        status: 'withdrawn' as CommitmentStatus,
        resolvedAt: new Date().toISOString(),
        resolution: `superseded-by-${c.supersededBy} (auto-reconciled: superseder is ${superseder.status})`,
      }));
      closed.push(c.id);
      this.emit('graveyard-reconciled', { id: c.id, supersededBy: c.supersededBy, superseder: superseder.id });
    }
    return { closed, wouldClose, scanned };
  }

  /**
   * C1+C2 §4.1 — STRUCTURAL well-formedness validator for the owner⟂blockedOn
   * state. Shared by record() and transitionState() so a guarded transition
   * re-runs the SAME gate. Throws on an invalid enum or a blank
   * user-authorization. Never classifies prose; holds no side-effect authority.
   */
  static normalizeState(input: { owner?: string; blockedOn?: string; actionClass?: string }): {
    owner: 'agent' | 'user';
    blockedOn: 'none' | 'external' | 'user-input' | 'user-authorization';
    actionClass?: string;
  } {
    const OWNERS = ['agent', 'user'];
    const BLOCKED_ON = ['none', 'external', 'user-input', 'user-authorization'];
    const owner = (input.owner ?? 'agent') as 'agent' | 'user';
    const blockedOn = (input.blockedOn ?? 'none') as
      | 'none' | 'external' | 'user-input' | 'user-authorization';
    if (!OWNERS.includes(owner)) {
      throw new Error(`invalid owner '${owner}' (expected agent|user)`);
    }
    if (!BLOCKED_ON.includes(blockedOn)) {
      throw new Error(
        `invalid blockedOn '${blockedOn}' (expected none|external|user-input|user-authorization)`,
      );
    }
    const actionClass =
      typeof input.actionClass === 'string' && input.actionClass.trim().length > 0
        ? input.actionClass.trim()
        : undefined;
    if (blockedOn === 'user-authorization' && !actionClass) {
      throw new Error(
        "blockedOn:'user-authorization' requires a non-empty actionClass naming the privileged action being authorized",
      );
    }
    return { owner, blockedOn, actionClass };
  }

  /**
   * C1+C2 §4.1 — guarded in-place state transition (round-4 codex #4: blanket
   * immutability is too rigid; real commitments change as a dependency resolves /
   * auth is granted / the agent takes ownership back). Re-runs the well-formedness
   * gate on the NEW combined (current+patch) state and applies it IN PLACE — no
   * close-and-reopen, so the commitment id + its existing history are preserved.
   * Rejects a terminal commitment. Throws on an invalid new state (route → 400).
   */
  transitionState(
    id: string,
    patch: { owner?: string; blockedOn?: string; actionClass?: string; supersededBy?: string },
  ): Commitment {
    const existing = this.store.commitments.find(c => c.id === id);
    if (!existing) throw new Error(`Commitment ${id} not found`);
    if (['verified', 'violated', 'expired', 'withdrawn', 'delivered'].includes(existing.status)) {
      throw new Error(`Commitment ${id} is terminal (${existing.status}) — cannot transition state`);
    }
    const { owner, blockedOn, actionClass } = CommitmentTracker.normalizeState({
      owner: patch.owner ?? existing.owner,
      blockedOn: patch.blockedOn ?? existing.blockedOn,
      actionClass: patch.actionClass ?? existing.actionClass,
    });
    const supersededBy = patch.supersededBy !== undefined
      ? patch.supersededBy.trim() || undefined
      : existing.supersededBy;
    if (
      owner === existing.owner && blockedOn === (existing.blockedOn ?? 'none') &&
      actionClass === existing.actionClass && supersededBy === existing.supersededBy
    ) return existing;
    // Origin-local request-to-persist clock starts after all structural
    // validation and immediately before the authoritative synchronous mutation.
    const persistStartedNs = process.hrtime.bigint();
    const updated = this.mutateSync(id, c => ({
      ...c,
      owner,
      blockedOn,
      actionClass,
      supersededBy,
    }));
    if (this.config.blockerLifecycleEnabled && (existing.blockedOn ?? 'none') === 'none' && blockedOn !== 'none') {
      const episode = [...(updated.blockerEpisodes ?? [])].reverse().find(e => e.closedAtMs === undefined);
      if (episode) {
        this.emit('blocker-request-persisted', {
          commitmentId: updated.id,
          episodeId: episode.episodeId,
          sourceEventId: `blocker-lifecycle-v1:request:${episode.episodeId}`,
          observedAtMs: Date.now(),
          latencyMs: Number(process.hrtime.bigint() - persistStartedNs) / 1_000_000,
        });
      }
    }
    this.emit('state-transitioned', { id, owner, blockedOn });
    return updated;
  }

  /**
   * Find the active threadline-reply commitment for a given threadId.
   *
   * Used by ThreadlineRouter when an inbound reply arrives: looks up the
   * commitment so the router can transition it to `delivered` and pull the
   * stated purpose / topicId. Skips terminal states (delivered/expired/
   * withdrawn) so late replies don't reopen closed commitments. Returns
   * null on miss.
   *
   * Uses a thread→commitment-id index maintained alongside the store so the
   * lookup is O(1) plus one O(commitment) status check, bounded by active
   * threadline-reply commitments (not lifetime commitment count). Per
   * scalability review F1 — the lifetime store can grow unboundedly while
   * the index stays bounded by active threads.
   */
  findByThreadId(threadId: string): Commitment | null {
    if (!threadId) return null;
    const idxId = this.threadIdIndex.get(threadId);
    if (idxId) {
      const c = this.store.commitments.find(x => x.id === idxId);
      if (
        c &&
        c.type === 'one-time-action' &&
        c.verificationMethod === 'threadline-reply' &&
        c.status !== 'delivered' &&
        c.status !== 'withdrawn' &&
        c.status !== 'expired'
      ) {
        return c;
      }
      // Stale index entry — drop it so the next call doesn't re-fetch.
      this.threadIdIndex.delete(threadId);
    }
    return null;
  }

  /**
   * Maintain the threadId→commitmentId index. Called after any mutation that
   * affects a threadline-reply commitment's state. Bounded by active count.
   */
  private refreshThreadIdIndex(commitment: Commitment): void {
    if (
      commitment.type !== 'one-time-action' ||
      commitment.verificationMethod !== 'threadline-reply' ||
      !commitment.relatedThreadId
    ) {
      return;
    }
    if (
      commitment.status === 'delivered' ||
      commitment.status === 'withdrawn' ||
      commitment.status === 'expired'
    ) {
      this.threadIdIndex.delete(commitment.relatedThreadId);
    } else {
      this.threadIdIndex.set(commitment.relatedThreadId, commitment.id);
    }
  }

  /**
   * Build the threadId→commitmentId index from the persisted store. Called
   * once at startup. Linear in store size, but only runs at load time.
   */
  private rebuildThreadIdIndex(): void {
    this.threadIdIndex.clear();
    for (const c of this.store.commitments) {
      this.refreshThreadIdIndex(c);
    }
  }

  /**
   * Get all active commitments (pending or verified, not expired).
   *
   * `delivered` is a terminal state for one-time-actions that have no
   * automated verification method — once transitioned, they are not
   * re-checked (Phase 1 of commitment signal-quality fix).
   */
  getActive(): Commitment[] {
    const now = new Date().toISOString();
    return this.store.commitments.filter(c => {
      if (c.status === 'withdrawn' || c.status === 'expired' || c.status === 'delivered') return false;
      if (c.expiresAt && c.expiresAt < now) return false;
      // Active = pending, verified, or violated (violated is still "active" — it needs attention)
      return c.status === 'pending' || c.status === 'verified' || c.status === 'violated';
    });
  }

  /**
   * Get active commitments bound to a specific Telegram topic.
   *
   * GAP-B (spec: docs/specs/autonomous-registration-guarantee.md, Part B) — a
   * thin synchronous wrapper over `getActive().filter(c => c.topicId === topicId)`.
   * No new state, no I/O, no lock: Node's single thread guarantees no torn read
   * vs `mutate()`. The QUALIFYING filter (status==='pending', agent-driven,
   * not-beacon-paused/suppressed, local-origin, fresh) is applied by the CALLER
   * (the reaped-session evidence wiring), not here — this method is the cheap
   * topic-scoped read; eligibility policy stays at the decision point.
   */
  getActiveByTopicId(topicId: number): Commitment[] {
    return this.getActive().filter((c) => c.topicId === topicId);
  }

  /**
   * True if a one-time-action commitment has no way to be verified
   * automatically — no verificationMethod at all, or the `manual` method
   * (which by design cannot self-resolve). The verify sweep is a strict
   * no-op for these: no violation ticks (the #76 spam class), and NO
   * auto-delivery (the #656/CMT-1101 evaporation class) — beacon-enabled
   * or not. They stay pending until an explicit deliver()/PATCH or
   * `expiresAt` lapse; PromiseBeacon and the overdue sweep keep them
   * visible meanwhile. (#656 carved out only beaconEnabled commitments
   * here; the 2026-06-05 generalization covers every unverifiable
   * one-time-action, which makes a separate beacon carve-out redundant.)
   */
  private static isUnverifiableOneTime(c: Commitment): boolean {
    if (c.type !== 'one-time-action') return false;
    const m = c.verificationMethod;
    return m === undefined || m === null || m === 'manual';
  }

  /**
   * Sniff a commitment's agent-response text for an explicit time
   * promise — "back in 20 minutes", "in an hour", "by EOD", etc.
   * Returns a suggested beacon cadence and a hard-deadline offset when
   * a marker is found, null otherwise. Conservative by design: misses
   * are a no-op.
   *
   * Cadence heuristic: half of the promised duration, clamped to the
   * beacon's own [60_000, 21_600_000] ms range. Hard-deadline offset
   * is 3x the promised duration so a slow response isn't terminal,
   * just flagged.
   */
  static detectTimePromise(
    text: string,
  ): { cadenceMs: number; hardDeadlineOffsetMs: number } | null {
    if (!text) return null;
    const t = text.toLowerCase();

    // Explicit N-unit phrases: "back in 20 minutes", "in an hour", "in 2h".
    // Hedge-tolerant (slack-followthrough-generalization §4.2, R3 hedge fix):
    // a leading "about/around/roughly/~" must not break the match — the exact
    // S7 miss was "in about 5 minutes" (`about` broke `in\s+(an?|\d+)`).
    const numeric = t.match(
      /\b(?:back\s+)?in\s+(?:about\s+|around\s+|roughly\s+|~\s*)?(an?|\d+)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|h|m|s)\b/,
    );
    if (numeric) {
      const raw = numeric[1];
      const n = raw === 'a' || raw === 'an' ? 1 : parseInt(raw, 10);
      const unit = numeric[2];
      let unitMs: number;
      if (unit === 's' || /^secs?$/.test(unit) || /^seconds?$/.test(unit)) {
        unitMs = 1000;
      } else if (unit === 'm' || /^mins?$/.test(unit) || /^minutes?$/.test(unit)) {
        unitMs = 60_000;
      } else {
        unitMs = 3_600_000; // h / hr / hour
      }
      const totalMs = n * unitMs;
      if (totalMs >= 60_000) {
        const half = Math.floor(totalMs / 2);
        const cadence = Math.max(60_000, Math.min(half, 21_600_000));
        return {
          cadenceMs: cadence,
          hardDeadlineOffsetMs: Math.min(totalMs * 3, 24 * 3_600_000),
        };
      }
    }

    // Softer markers — shorthand time promises.
    if (/\b(by\s+eod|end\s+of\s+(the\s+)?day)\b/.test(t)) {
      return { cadenceMs: 60 * 60_000, hardDeadlineOffsetMs: 12 * 3_600_000 };
    }
    if (/\b(tomorrow|by\s+morning|by\s+tomorrow)\b/.test(t)) {
      return { cadenceMs: 2 * 3_600_000, hardDeadlineOffsetMs: 24 * 3_600_000 };
    }
    if (
      /\b(i'?ll\s+(?:check\s+in|report\s+back|get\s+back|ping|update)|back\s+(?:shortly|soon|when)|shortly|soon)\b/
        .test(t)
    ) {
      return { cadenceMs: 30 * 60_000, hardDeadlineOffsetMs: 2 * 3_600_000 };
    }

    return null;
  }

  /**
   * Get all commitments (including resolved).
   */
  getAll(): Commitment[] {
    return [...this.store.commitments];
  }

  /**
   * Get a single commitment by ID.
   */
  get(id: string): Commitment | null {
    return this.store.commitments.find(c => c.id === id) ?? null;
  }

  getBlockerEpisodeDropBuckets(): Record<string, { request: number; clear: number }> {
    return structuredClone(this.store.blockerEpisodeDropBuckets ?? {});
  }

  markBlockerClearTelemetryComplete(commitmentId: string, episodeId: string, atMs = Date.now()): boolean {
    const commitment = this.get(commitmentId);
    const episode = commitment?.blockerEpisodes?.find(e => e.episodeId === episodeId);
    if (!commitment || !episode || episode.closedAtMs === undefined) return false;
    if (episode.clearTelemetryCompleteAtMs !== undefined) return true;
    this.mutateSync(commitmentId, current => ({
      ...current,
      blockerEpisodes: (current.blockerEpisodes ?? []).map(e => e.episodeId === episodeId
        ? { ...e, clearTelemetryCompleteAtMs: atMs }
        : e),
    }));
    return true;
  }

  // ── Verification ───────────────────────────────────────────────

  /**
   * Run verification on all active commitments.
   */
  verify(): CommitmentVerificationReport {
    const active = this.getActive();
    const violations: CommitmentVerificationReport['violations'] = [];
    let verified = 0;
    let pending = 0;

    // Batch every per-commitment save in this sweep into ONE write at the end
    // (see `batchingSaves`): each `mutateSync()` below otherwise writes the whole
    // store, so a sweep over N commitments did O(N) full-store serializations and
    // froze the event loop for minutes on a large store.
    this.beginSaveBatch();
    try {
      // Expire old commitments first
      this.expireCommitments();

      for (const commitment of active) {
        const result = this.verifyOne(commitment.id);
        if (!result) continue;

        if (result.passed) {
          verified++;
        } else {
          // Attempt auto-correction for config-change commitments
          let autoCorrected = false;
          if (commitment.type === 'config-change' && commitment.configPath !== undefined) {
            autoCorrected = this.attemptAutoCorrection(commitment);
          }

          violations.push({
            id: commitment.id,
            userRequest: commitment.userRequest,
            detail: result.detail,
            autoCorrected,
          });
        }
      }

      pending = active.filter(c => c.status === 'pending').length;
    } finally {
      this.finishSaveBatch();
    }

    const report: CommitmentVerificationReport = {
      timestamp: new Date().toISOString(),
      active: active.length,
      verified,
      violated: violations.length,
      pending,
      violations,
    };

    this.emit('verification', report);
    return report;
  }

  /**
   * Verify a single commitment. Returns null if commitment not found or not active.
   */
  verifyOne(id: string): { passed: boolean; detail: string } | null {
    const commitment = this.store.commitments.find(c => c.id === id);
    if (!commitment) return null;
    if (
      commitment.status === 'withdrawn' ||
      commitment.status === 'expired' ||
      commitment.status === 'delivered'
    ) return null;

    // Threadline-reply commitments are externally resolved by ThreadlineRouter
    // when the awaited reply arrives. The periodic verify sweep is a no-op —
    // we neither increment violations nor mark delivered. Per
    // THREAD-TOPIC-LINKAGE-SPEC.md §4.1. The `expiresAt` handler still applies
    // and will mark the commitment `expired` if no reply arrives within window.
    if (
      commitment.type === 'one-time-action' &&
      commitment.verificationMethod === 'threadline-reply'
    ) {
      return { passed: false, detail: 'Awaiting threadline reply' };
    }

    // ANY unverifiable one-time-action stays PENDING — the sweep is a no-op.
    //
    // History (the causal chain matters here): #76 stopped the 51,000-tick
    // violation spam by auto-marking these `delivered` ("trusting agent
    // acknowledgment") — but `delivered` fired ~75 seconds after creation and
    // is TERMINAL, so a promise like "review the PR when it lands" silently
    // evaporated before its condition could even exist, and nothing (not the
    // PromiseBeacon, not the overdue sweep, not PATCH) could revive it. #656
    // fixed exactly that — but only for beaconEnabled commitments; everything
    // registered via a plain POST /commitments still fell through to the
    // auto-deliver (live: CMT-1101, 2026-06-05, framework-issue 5bac8d53).
    //
    // The generalization keeps every prior property: returning null neither
    // violates (the #76 spam can't recur — no per-sweep ticks) nor delivers
    // (the #656 evaporation can't recur). Closure is explicit and honest:
    // deliver()/markDelivered() when the agent fulfills it, `expiresAt` when
    // it lapses, and the overdue surfacing keeps it visible meanwhile — a
    // promise nobody can verify should NAG, not vanish.
    if (CommitmentTracker.isUnverifiableOneTime(commitment)) {
      return null;
    }

    let result: { passed: boolean; detail: string };

    switch (commitment.type) {
      case 'config-change':
        result = this.verifyConfigChange(commitment);
        break;
      case 'behavioral':
        result = this.verifyBehavioral(commitment);
        break;
      case 'one-time-action':
        result = this.verifyOneTimeAction(commitment);
        break;
      default:
        result = { passed: false, detail: `Unknown commitment type: ${commitment.type}` };
    }

    // Update commitment status based on result — route through the
    // single-writer mutateSync surface so concurrent write paths can't
    // clobber each other.
    const wasFirstVerification = commitment.status === 'pending';
    const wasViolated = commitment.status === 'violated';
    const wasVerified = commitment.status === 'verified';

    const updated = this.mutateSync(id, c => {
      if (result.passed) {
        const next: Commitment = {
          ...c,
          status: 'verified',
          lastVerifiedAt: new Date().toISOString(),
          verificationCount: c.verificationCount + 1,
        };
        if (c.type === 'one-time-action') {
          next.resolvedAt = new Date().toISOString();
          next.resolution = 'Verified complete';
        }
        return next;
      }
      return {
        ...c,
        status: 'violated',
        violationCount: c.violationCount + 1,
      };
    });

    if (result.passed) {
      if (wasFirstVerification && this.config.onVerified) {
        this.config.onVerified(updated);
      }
      if (wasViolated) {
        console.log(`[CommitmentTracker] ${id} recovered: "${updated.userRequest}"`);
      }
    } else if (wasVerified) {
      // Regression — was verified, now violated
      console.warn(`[CommitmentTracker] VIOLATION ${id}: "${updated.userRequest}" — ${result.detail}`);
      if (this.config.onViolation) {
        this.config.onViolation(updated, result.detail);
      }
    }

    return result;
  }

  // ── Session Awareness ──────────────────────────────────────────

  /**
   * Get behavioral commitments formatted for session injection.
   * This is what hooks read and inject into new sessions.
   */
  getBehavioralContext(): string {
    const behavioral = this.getActive().filter(c =>
      c.type === 'behavioral' || c.type === 'config-change'
    );

    if (behavioral.length === 0) return '';

    const lines = [
      '# Active Commitments (user-requested rules)',
      '',
      'These rules were explicitly requested by the user. They override defaults.',
      '',
    ];

    for (const c of behavioral) {
      const since = c.createdAt.split('T')[0];
      const expires = c.expiresAt ? ` (expires ${c.expiresAt.split('T')[0]})` : '';

      if (c.type === 'behavioral' && c.behavioralRule) {
        lines.push(`- [${c.id}] ${c.behavioralRule}${expires} (Since ${since})`);
      } else if (c.type === 'config-change' && c.configPath) {
        lines.push(`- [${c.id}] Config: ${c.configPath} must be ${JSON.stringify(c.configExpectedValue)}. User request: "${c.userRequest}"${expires} (Since ${since})`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Get ComponentHealth for integration with HealthChecker.
   */
  getHealth(): ComponentHealth {
    const active = this.getActive();
    const violated = active.filter(c => c.status === 'violated');

    if (active.length === 0) {
      return { status: 'healthy', message: 'No active commitments', lastCheck: new Date().toISOString() };
    }

    if (violated.length > 0) {
      return {
        status: 'degraded',
        message: `${violated.length} violated commitment(s): ${violated.map(c => c.id).join(', ')}`,
        lastCheck: new Date().toISOString(),
      };
    }

    return {
      status: 'healthy',
      message: `${active.length} commitment(s) tracked, all verified`,
      lastCheck: new Date().toISOString(),
    };
  }

  // ── Type-specific Verification ─────────────────────────────────

  private verifyConfigChange(commitment: Commitment): { passed: boolean; detail: string } {
    if (!commitment.configPath) {
      return { passed: false, detail: 'Missing configPath on config-change commitment' };
    }

    const currentValue = this.config.liveConfig.get(commitment.configPath, undefined);
    const matches = this.deepEqual(currentValue, commitment.configExpectedValue);

    return {
      passed: matches,
      detail: matches
        ? `Config ${commitment.configPath} = ${JSON.stringify(currentValue)} (matches)`
        : `Config ${commitment.configPath} = ${JSON.stringify(currentValue)}, expected ${JSON.stringify(commitment.configExpectedValue)}`,
    };
  }

  private verifyBehavioral(commitment: Commitment): { passed: boolean; detail: string } {
    // Behavioral commitments are "verified" if the rule text exists in the rules file
    if (!commitment.behavioralRule) {
      return { passed: false, detail: 'Missing behavioralRule on behavioral commitment' };
    }

    try {
      if (!fs.existsSync(this.rulesPath)) {
        this.writeBehavioralRules();
      }
      const content = fs.readFileSync(this.rulesPath, 'utf-8');
      const hasRule = content.includes(commitment.id);
      return {
        passed: hasRule,
        detail: hasRule ? 'Behavioral rule present in injection file' : 'Behavioral rule missing from injection file — regenerating',
      };
    } catch {
      return { passed: false, detail: 'Failed to read behavioral rules file' };
    }
  }

  private verifyOneTimeAction(commitment: Commitment): { passed: boolean; detail: string } {
    switch (commitment.verificationMethod) {
      case 'config-value':
        return this.verifyConfigChange(commitment);

      case 'file-exists':
        if (!commitment.verificationPath) {
          return { passed: false, detail: 'Missing verificationPath for file-exists check' };
        }
        const exists = fs.existsSync(commitment.verificationPath);
        return {
          passed: exists,
          detail: exists ? `File exists: ${commitment.verificationPath}` : `File missing: ${commitment.verificationPath}`,
        };

      case 'manual':
        // Manual commitments stay pending until explicitly resolved
        return { passed: false, detail: 'Awaiting manual verification' };

      case 'threadline-reply':
        // Externally resolved by ThreadlineRouter. verifyOne() short-circuits
        // before reaching this switch (see verifyOne); included here as a
        // belt-and-braces fallback so the `default` branch can't be hit.
        return { passed: false, detail: 'Awaiting threadline reply' };

      default:
        return { passed: false, detail: `Unknown verification method: ${commitment.verificationMethod}` };
    }
  }

  // ── Auto-correction ────────────────────────────────────────────

  private attemptAutoCorrection(commitment: Commitment): boolean {
    if (!commitment.configPath || commitment.configExpectedValue === undefined) return false;

    try {
      this.config.liveConfig.set(commitment.configPath, commitment.configExpectedValue);

      // Re-verify after correction
      const recheck = this.verifyConfigChange(commitment);
      if (recheck.passed) {
        const now = new Date().toISOString();
        const updated = this.mutateSync(commitment.id, c => ({
          ...c,
          status: 'verified',
          lastVerifiedAt: now,
          verificationCount: c.verificationCount + 1,
          correctionCount: (c.correctionCount ?? 0) + 1,
          correctionHistory: [...(c.correctionHistory ?? []), now],
        }));

        // Check for escalation: too many corrections in a time window suggests a bug
        this.checkForEscalation(updated);

        console.log(`[CommitmentTracker] Auto-corrected ${updated.id}: ${updated.configPath} → ${JSON.stringify(updated.configExpectedValue)} (correction #${updated.correctionCount})`);
        this.emit('corrected', updated);
        return true;
      }
    } catch (err) {
      DegradationReporter.getInstance().report({
        feature: 'CommitmentTracker.attemptAutoCorrection',
        primary: `Auto-correct config drift for commitment ${commitment.id}`,
        fallback: 'Config drift persists, violation remains unresolved',
        reason: `Auto-correction failed: ${err instanceof Error ? err.message : String(err)}`,
        impact: `Commitment "${commitment.userRequest}" remains violated until next cycle`,
      });
      console.error(`[CommitmentTracker] Auto-correction failed for ${commitment.id}:`, err);
    }

    return false;
  }

  /**
   * Check if a commitment has been auto-corrected too many times,
   * suggesting a bug rather than simple drift.
   */
  private checkForEscalation(commitment: Commitment): void {
    if (commitment.escalated) return; // Already escalated

    const threshold = this.config.escalationThreshold ?? 3;
    const windowMs = this.config.escalationWindowMs ?? 3_600_000; // 1 hour
    const now = Date.now();

    // Count corrections within the window
    const recentCorrections = (commitment.correctionHistory ?? []).filter(ts => {
      return (now - new Date(ts).getTime()) < windowMs;
    });

    if (recentCorrections.length >= threshold) {
      const detail = `Commitment ${commitment.id} ("${commitment.userRequest}") has been auto-corrected ${recentCorrections.length} times in the last ${Math.round(windowMs / 60_000)} minutes. Config path: ${commitment.configPath}. This pattern suggests something is actively overwriting the value — likely a bug in initialization, a conflicting process, or a default value that resets on restart.`;

      const updated = this.mutateSync(commitment.id, c => ({
        ...c,
        escalated: true,
        escalationDetail: detail,
      }));

      console.warn(`[CommitmentTracker] ESCALATION ${updated.id}: ${detail}`);
      this.emit('escalation', updated, detail);

      if (this.config.onEscalation) {
        this.config.onEscalation(updated, detail);
      }
    }
  }

  // ── Behavioral Rules File ──────────────────────────────────────

  /**
   * Write the commitment-rules.md file for hook injection.
   */
  private writeBehavioralRules(): void {
    const content = this.getBehavioralContext();
    try {
      const dir = path.dirname(this.rulesPath);
      fs.mkdirSync(dir, { recursive: true });

      if (content) {
        const tmpPath = `${this.rulesPath}.${process.pid}.tmp`;
        fs.writeFileSync(tmpPath, content + '\n');
        fs.renameSync(tmpPath, this.rulesPath);
      } else {
        // No active commitments — remove the file so hooks skip injection
        if (fs.existsSync(this.rulesPath)) {
          SafeFsExecutor.safeUnlinkSync(this.rulesPath, { operation: 'src/monitoring/CommitmentTracker.ts:907' });
        }
      }
    } catch {
      // @silent-fallback-ok — rules file is nice-to-have, monitor catches violations anyway
    }
  }

  // ── Expiration ─────────────────────────────────────────────────

  sweepAutoExpiry(now = new Date()): CommitmentAutoExpirySweepReport {
    const config = this.resolveAutoExpiryConfig();
    const timestamp = now.toISOString();
    const report: CommitmentAutoExpirySweepReport = {
      timestamp,
      dryRun: config.dryRun,
      enabled: config.enabled,
      maxAgeDays: config.maxAgeDays,
      scanned: 0,
      eligible: 0,
      expired: 0,
      capped: false,
    };

    if (!config.enabled) return report;

    const targets: string[] = [];
    for (const commitment of this.store.commitments) {
      report.scanned++;
      if (!this.isAutoExpiryEligible(commitment, now, config.maxAgeDays)) continue;
      report.eligible++;
      if (targets.length < AUTO_EXPIRY_SWEEP_CAP) {
        targets.push(commitment.id);
      } else {
        report.capped = true;
      }
    }

    if (!config.dryRun && targets.length > 0) {
      const reason = `auto-expired: aged out >${config.maxAgeDays}d, presumed completed-but-unclosed`;
      this.beginSaveBatch();
      try {
        for (const id of targets) {
          const updated = this.expireSync(id, reason, timestamp);
          this.refreshThreadIdIndex(updated);
          this.emit('expired', updated);
          report.expired++;
        }
        if (report.expired > 0) this.writeBehavioralRules();
      } finally {
        this.finishSaveBatch();
      }
    }

    console.log(
      `[CommitmentTracker] Auto-expiry sweep: scanned=${report.scanned} eligible=${report.eligible} expired=${report.expired} dryRun=${report.dryRun} maxAgeDays=${report.maxAgeDays} capped=${report.capped}`,
    );
    return report;
  }

  private expireCommitments(): void {
    const now = new Date().toISOString();
    let changed = false;

    // Snapshot ids before mutating so we don't iterate a live array under
    // concurrent mutateSync() index-preserving writes.
    const targets = this.store.commitments
      .filter(c => c.expiresAt && c.expiresAt < now && c.status !== 'expired' && c.status !== 'withdrawn')
      .map(c => c.id);

    for (const id of targets) {
      this.expireSync(id, 'Expired', now);
      changed = true;
      const c = this.get(id);
      if (c) console.log(`[CommitmentTracker] Expired ${c.id}: "${c.userRequest}"`);
    }

    if (changed) {
      this.writeBehavioralRules();
    }
  }

  private expireSync(id: string, reason: string, resolvedAt: string): Commitment {
    return this.mutateSync(id, c => ({
      ...c,
      status: 'expired',
      resolvedAt,
      resolution: reason,
    }));
  }

  private resolveAutoExpiryConfig(): Required<CommitmentAutoExpiryConfig> {
    return {
      enabled: this.config.autoExpiry?.enabled ?? true,
      maxAgeDays: this.positiveNumberOrDefault(
        this.config.autoExpiry?.maxAgeDays,
        DEFAULT_AUTO_EXPIRY_MAX_AGE_DAYS,
      ),
      sweepIntervalMs: this.positiveNumberOrDefault(
        this.config.autoExpiry?.sweepIntervalMs,
        DEFAULT_AUTO_EXPIRY_SWEEP_INTERVAL_MS,
      ),
      dryRun: this.config.autoExpiry?.dryRun ?? true,
    };
  }

  private positiveNumberOrDefault(value: number | undefined, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
  }

  private isAutoExpiryEligible(commitment: Commitment, now: Date, maxAgeDays: number): boolean {
    if (commitment.owner !== 'agent') return false;
    if (commitment.status !== 'pending' && commitment.status !== 'violated') return false;
    const createdAtMs = Date.parse(commitment.createdAt);
    if (!Number.isFinite(createdAtMs)) return false;
    const ageMs = now.getTime() - createdAtMs;
    if (ageMs <= maxAgeDays * 24 * 60 * 60 * 1000) return false;
    if (commitment.hardDeadlineAt) {
      const hardDeadlineMs = Date.parse(commitment.hardDeadlineAt);
      if (Number.isFinite(hardDeadlineMs) && hardDeadlineMs > now.getTime()) return false;
    }
    return true;
  }

  // ── Single-writer mutation ─────────────────────────────────────

  /**
   * Single-writer mutate surface. Every write path routes through here so
   * concurrent writers (CommitmentSentinel, PresenceProxy, future
   * PromiseBeacon) can't clobber each other.
   *
   * Contract:
   *   - FIFO queue per commitment id, max depth 256.
   *   - Optimistic CAS on the `version` field: read → fn(clone) → write if
   *     version unchanged, else retry (max 5). On success, version is
   *     incremented and the store is persisted atomically.
   *   - Caller-supplied fn p99 target: 50ms. Long work belongs outside.
   *
   * Returns the persisted commitment snapshot (post-increment).
   */
  async mutate(id: string, fn: MutateFn): Promise<Commitment> {
    return new Promise<Commitment>((resolve, reject) => {
      let queue = this.mutateQueues.get(id);
      if (!queue) {
        queue = [];
        this.mutateQueues.set(id, queue);
      }
      if (queue.length >= MUTATE_QUEUE_MAX_DEPTH) {
        reject(new Error(
          `CommitmentTracker.mutate: queue full for ${id} (depth ${queue.length} >= ${MUTATE_QUEUE_MAX_DEPTH})`
        ));
        return;
      }
      queue.push({ fn, resolve, reject });
      // Fire-and-forget drain; errors already propagate via entry.reject.
      void this.drainMutateQueue(id);
    });
  }

  private async drainMutateQueue(id: string): Promise<void> {
    if (this.mutateRunning.has(id)) return;
    this.mutateRunning.add(id);
    try {
      const queue = this.mutateQueues.get(id);
      while (queue && queue.length > 0) {
        const entry = queue.shift()!;
        try {
          const result = await this.applyMutationWithCAS(id, entry.fn);
          entry.resolve(result);
        } catch (err) {
          entry.reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
      // Clean up empty queue so Maps don't grow unbounded.
      if (queue && queue.length === 0) this.mutateQueues.delete(id);
    } finally {
      this.mutateRunning.delete(id);
    }
  }

  private async applyMutationWithCAS(id: string, fn: MutateFn): Promise<Commitment> {
    let attempt = 0;
    while (attempt <= MUTATE_CAS_MAX_RETRIES) {
      const idx = this.store.commitments.findIndex(c => c.id === id);
      if (idx === -1) {
        throw new Error(`CommitmentTracker.mutate: unknown commitment id ${id}`);
      }
      const current = this.store.commitments[idx];
      const observedVersion = current.version ?? 0;

      // Provide a shallow clone so fn mutations don't prematurely touch store.
      const draft: Commitment = { ...current };
      const next = await fn(draft);

      // CAS check: the record's version must not have drifted underneath us.
      const latestIdx = this.store.commitments.findIndex(c => c.id === id);
      if (latestIdx === -1) {
        throw new Error(`CommitmentTracker.mutate: commitment ${id} disappeared mid-apply`);
      }
      const latest = this.store.commitments[latestIdx];
      if ((latest.version ?? 0) !== observedVersion) {
        attempt++;
        continue;
      }

      // Snapshot only AFTER the awaited draft and successful CAS. From here to
      // save/rollback there is no await, so restoring cannot erase an unrelated
      // mutation that committed while fn() was suspended.
      const rollback = structuredClone(this.store);
      const withLifecycle = this.applyBlockerLifecycle(current, next);
      const committed: Commitment = this.stampReplicationIfMeaningful(
        current,
        { ...withLifecycle, version: observedVersion + 1 },
      );
      this.store.commitments[latestIdx] = committed;
      const saved = this.saveStore();
      if (saved.state === 'failed') {
        this.store = rollback;
        throw new CommitmentPersistenceError(saved.errorClass);
      }
      this.afterPersistedMutation(current, committed, saved.state);
      return committed;
    }
    throw new Error(
      `CommitmentTracker.mutate: CAS retry budget exhausted for ${id} after ${MUTATE_CAS_MAX_RETRIES} retries`
    );
  }

  /**
   * Synchronous mutation helper used by existing sync write paths
   * (withdraw, verifyOne, expireCommitments, attemptAutoCorrection,
   * checkForEscalation). Since JS is single-threaded, synchronous fn
   * bodies cannot race against each other — this path does a straight
   * read → apply → version++ → persist. Async callers must use
   * mutate() for proper queueing across awaits.
   */
  private mutateSync(id: string, fn: (c: Commitment) => Commitment): Commitment {
    const idx = this.store.commitments.findIndex(c => c.id === id);
    if (idx === -1) {
      throw new Error(`CommitmentTracker.mutateSync: unknown commitment id ${id}`);
    }
    const current = this.store.commitments[idx];
    const observedVersion = current.version ?? 0;
    const next = fn({ ...current });
    const rollback = this.batchingSaves ? null : structuredClone(this.store);
    const withLifecycle = this.applyBlockerLifecycle(current, next);
    const committed: Commitment = this.stampReplicationIfMeaningful(
      current,
      { ...withLifecycle, version: observedVersion + 1 },
    );
    this.store.commitments[idx] = committed;
    const saved = this.saveStore();
    if (saved.state === 'failed') {
      if (rollback) this.store = rollback;
      throw new CommitmentPersistenceError(saved.errorClass);
    }
    this.afterPersistedMutation(current, committed, saved.state);
    return committed;
  }

  private afterPersistedMutation(before: Commitment, after: Commitment, state: 'committed' | 'deferred'): void {
    if (state === 'deferred') {
      this.pendingBindingReleases.push({ before, after });
      return;
    }
    this.emitPersistedMutationEffects(before, after);
  }

  private emitPersistedMutationEffects(before: Commitment, after: Commitment): void {
    this.maybeReleaseConversationBinding(before, after);
    if (!this.config.blockerLifecycleEnabled) return;
    const beforeById = new Map((before.blockerEpisodes ?? []).map(e => [e.episodeId, e]));
    for (const episode of after.blockerEpisodes ?? []) {
      const prior = beforeById.get(episode.episodeId);
      if (episode.closedAtMs !== undefined && prior?.closedAtMs === undefined) {
        this.emit('blocker-episode-closed', { commitmentId: after.id, episode: { ...episode } });
      }
    }
  }

  private applyBlockerLifecycle(before: Commitment, candidate: Commitment): Commitment {
    if (!this.config.blockerLifecycleEnabled) return candidate;
    const now = Date.now();
    const from = before.blockedOn ?? 'none';
    const to = candidate.blockedOn ?? 'none';
    let episodes = (before.blockerEpisodes ?? []).map(e => ({ ...e, transitions: [...e.transitions] }));
    let dropped = before.blockerMeasurementDropped ? { ...before.blockerMeasurementDropped } : undefined;

    const trueTerminal = (s: CommitmentStatus): s is 'delivered' | 'withdrawn' | 'expired' =>
      s === 'delivered' || s === 'withdrawn' || s === 'expired';
    const closing = (from !== 'none' && to === 'none') ||
      (!trueTerminal(before.status) && trueTerminal(candidate.status));

    if (from === 'none' && to !== 'none') {
      const retained = episodes.filter(e => e.closedAtMs === undefined || e.clearTelemetryCompleteAtMs === undefined);
      const confirmed = episodes.filter(e => e.closedAtMs !== undefined && e.clearTelemetryCompleteAtMs !== undefined)
        .sort((a, b) => (a.closedAtMs ?? 0) - (b.closedAtMs ?? 0));
      episodes = [...retained, ...confirmed].slice(-64);
      if (retained.length >= 64) {
        this.incrementBlockerDropBucket('request', now);
        dropped = { openedAtMs: now };
      } else {
        episodes.push({
          schemaVersion: 1,
          episodeId: randomUUID(),
          startedAtMs: now,
          requestEventExpected: true,
          originMachineId: this.config.originMachineId ?? 'local',
          initialClass: to,
          transitions: [],
          transitionOverflowCount: 0,
        });
        episodes = episodes.slice(-64);
      }
    } else if (from !== 'none' && to !== 'none' && from !== to) {
      const open = [...episodes].reverse().find(e => e.closedAtMs === undefined);
      if (open) {
        const entry = { atMs: now, from, to };
        if (open.transitions.length < 16) open.transitions.push(entry);
        else {
          open.transitions = [...open.transitions.slice(0, 8), ...open.transitions.slice(-7), entry];
          open.transitionOverflowCount++;
        }
      }
    }

    if (closing) {
      if (dropped) {
        this.incrementBlockerDropBucket('clear', now);
        dropped = undefined;
      }
      const open = [...episodes].reverse().find(e => e.closedAtMs === undefined);
      if (open) {
        open.closedAtMs = now;
        open.closeReason = trueTerminal(candidate.status) ? candidate.status : 'cleared';
        open.clearSourceId = `blocker-lifecycle-v1:clear:${open.episodeId}`;
      }
    }
    return { ...candidate, blockerEpisodes: episodes, blockerMeasurementDropped: dropped };
  }

  private incrementBlockerDropBucket(kind: 'request' | 'clear', atMs: number): void {
    const day = new Date(atMs).toISOString().slice(0, 10);
    const buckets = { ...(this.store.blockerEpisodeDropBuckets ?? {}) };
    const bucket = { ...(buckets[day] ?? { request: 0, clear: 0 }) };
    bucket[kind]++;
    buckets[day] = bucket;
    const keep = Object.keys(buckets).sort().slice(-30);
    this.store.blockerEpisodeDropBuckets = Object.fromEntries(keep.map(k => [k, buckets[k]]));
  }

  /**
   * durable-conversation-identity §3.5.2 property 4: release ONE refcount on
   * the commitment's bind-pin when the binding permanently closes. `verified`/
   * `violated` are NOT release moments — config-change/behavioral commitments
   * oscillate verified↔violated and a violated one-time commitment can still
   * recover; releasing there would strand a live binding's pin. Any residue a
   * forever-violated commitment leaves is the documented harmless R6-low-4
   * orphan class (the pin routes its id to the id's OWN tuple), reclaimed by
   * the tracked pin↔binding-store GC sweep follow-up.
   */
  private static readonly BINDING_TERMINAL_STATUSES = new Set<CommitmentStatus>([
    'delivered',
    'withdrawn',
    'expired',
  ]);

  private maybeReleaseConversationBinding(prev: Commitment, next: Commitment): void {
    if (!this.config.conversationBinder) return;
    if (typeof next.topicId !== 'number' || next.topicId >= 0 || !next.boundTuple) return;
    if (CommitmentTracker.BINDING_TERMINAL_STATUSES.has(prev.status)) return;
    if (!CommitmentTracker.BINDING_TERMINAL_STATUSES.has(next.status)) return;
    try {
      this.config.conversationBinder.release(next.topicId);
    } catch {
      /* @silent-fallback-ok — a failed release leaks one refcount toward the
         documented harmless R6-low-4 orphan class; it must never fail the
         commitment mutation itself. */
    }
  }

  /** Late-bind the conversation binder (the registry constructs after the
   *  tracker at bootstrap). */
  setConversationBinder(binder: ConversationBinder): void {
    this.config.conversationBinder = binder;
  }

  /**
   * Insert a brand-new commitment under the mutate discipline. Used by
   * record(); creates an initial version-0 record, then serialises future
   * writes through mutate(id, fn).
   */
  private insertNew(commitment: Commitment): Commitment {
    const rollback = structuredClone(this.store);
    const withVersion: Commitment = this.stampReplicationIfMeaningful(
      null, // creation is always state-meaningful (P1.5 §3.2)
      { ...commitment, version: commitment.version ?? 0 },
    );
    this.store.commitments.push(withVersion);
    const saved = this.saveStore();
    if (saved.state === 'failed') {
      this.store = rollback;
      throw new CommitmentPersistenceError(saved.errorClass);
    }
    return withVersion;
  }

  // ── Persistence ────────────────────────────────────────────────

  private loadStore(): CommitmentStore {
    try {
      if (fs.existsSync(this.storePath)) {
        const data = JSON.parse(fs.readFileSync(this.storePath, 'utf-8'));
        if ((data.version === 1 || data.version === 2) && Array.isArray(data.commitments)) {
          // Migrate: add self-healing fields to existing commitments
          for (const c of data.commitments) {
            if (c.correctionCount === undefined) c.correctionCount = 0;
            if (c.correctionHistory === undefined) c.correctionHistory = [];
            if (c.escalated === undefined) c.escalated = false;
            // v1 → v2: back-fill version field on every commitment.
            if (typeof c.version !== 'number') c.version = 0;
            // CollaborationRedriveEngine fields (additive, optional). The
            // engine reads `(c.redriveCount ?? 0)` so a missing field reads
            // as 0 — backfilling here keeps the on-disk representation
            // consistent with what the engine expects.
            if (c.redriveCount === undefined) c.redriveCount = 0;
            // C1+C2 "The Agent Carries the Loop" back-fill (spec §4.7).
            // Default owner→'agent' (the agent carries the loop) and
            // blockedOn→'none'. NEVER silently classify a legacy row as
            // 'user-authorization' (that would invent an operator-approval
            // obligation that was never made). actionClass/lastProbe stay
            // absent for legacy rows (optional, read as undefined).
            if (c.owner === undefined) c.owner = 'agent';
            if (c.blockedOn === undefined) c.blockedOn = 'none';
          }
          // Bump on-disk version tag; persisted on next saveStore().
          data.version = 2;
          // ── Commitments Coherence backfill (P1.5 §3.2, additive) ──
          // Legacy store: seed replicationSeq=1 + mint a fresh incarnation —
          // peers hold nothing for the new incarnation, so the first sync is
          // a FULL pull by construction (never a 0-means-unchanged strand).
          if (typeof data.replicationSeq !== 'number' || !Number.isFinite(data.replicationSeq)) {
            data.replicationSeq = 1;
            data.storeIncarnation = randomUUID();
          }
          if (typeof data.storeIncarnation !== 'string' || !data.storeIncarnation) {
            data.storeIncarnation = randomUUID();
          }
          for (const c of data.commitments) {
            // Legacy records serve on a from-0 pull (lastMutatedSeq=1).
            if (typeof c.lastMutatedSeq !== 'number') c.lastMutatedSeq = 1;
          }
          // Rewind detection (backup restore): the meta sidecar remembers the
          // high-water replicationSeq ever advertised; a store now BELOW it
          // was rewound — re-mint the incarnation so peers re-pull wholesale
          // instead of silently stranding (journal §3.4 rule 3 verbatim).
          try {
            const metaRaw = fs.readFileSync(`${this.storePath}.meta.json`, 'utf-8');
            const meta = JSON.parse(metaRaw) as { highWaterSeq?: number };
            if (typeof meta?.highWaterSeq === 'number' && data.replicationSeq < meta.highWaterSeq) {
              data.storeIncarnation = randomUUID();
            }
          } catch { /* @silent-fallback-ok: no meta sidecar = no prior advert to rewind below (first boot) — nothing to fence (COMMITMENTS-COHERENCE-SPEC §3.2) */
          }
          return data as CommitmentStore;
        }
      }
    } catch {
      // Start fresh on corruption
    }
    // Fresh store: seed the P1.5 replication fields at birth (§3.2).
    return {
      version: 2,
      commitments: [],
      lastModified: new Date().toISOString(),
      replicationSeq: 1,
      storeIncarnation: randomUUID(),
    };
  }

  private beginSaveBatch(): void {
    if (this.batchingSaves) throw new Error('CommitmentTracker: nested save batch refused');
    this.batchSnapshot = structuredClone(this.store);
    this.pendingBindingReleases = [];
    this.pendingSave = false;
    this.batchingSaves = true;
  }

  private finishSaveBatch(): void {
    if (!this.batchingSaves) return;
    this.batchingSaves = false;
    const snapshot = this.batchSnapshot;
    this.batchSnapshot = null;
    const releases = this.pendingBindingReleases;
    this.pendingBindingReleases = [];
    if (!this.pendingSave) return;
    this.pendingSave = false;
    const saved = this.saveStore();
    if (saved.state === 'failed') {
      if (snapshot) this.store = snapshot;
      throw new CommitmentPersistenceError(saved.errorClass);
    }
    for (const { before, after } of releases) this.emitPersistedMutationEffects(before, after);
  }

  private saveStore(): { state: 'committed' } | { state: 'deferred' } | {
    state: 'failed'; errorClass: 'mkdir' | 'temp-write' | 'rename';
  } {
    // Coalesce writes during a batched sweep (see `batchingSaves`): mark dirty
    // and let the sweep flush ONE write at the end instead of O(N) here.
    if (this.batchingSaves) {
      this.pendingSave = true;
      return { state: 'deferred' };
    }
    this.store.lastModified = new Date().toISOString();
    const dir = path.dirname(this.storePath);
    const tmpPath = `${this.storePath}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      return { state: 'failed', errorClass: 'mkdir' };
    }
    try {
      // Compact (not pretty-printed): this is a machine-read state file, and at
      // ~1.6MB the indentation was pure serialization + I/O overhead per write.
      fs.writeFileSync(tmpPath, JSON.stringify(this.store) + '\n');
    } catch {
      return { state: 'failed', errorClass: 'temp-write' };
    }
    try {
      fs.renameSync(tmpPath, this.storePath);
    } catch {
      try { SafeFsExecutor.safeUnlinkSync(tmpPath, { operation: 'src/monitoring/CommitmentTracker.ts:saveStore-temp-cleanup' }); }
      catch { /* @silent-fallback-ok — best-effort temp cleanup */ }
      return { state: 'failed', errorClass: 'rename' };
    }
    // The authoritative replacement is committed. The rewind-fence sidecar is
    // deliberately best-effort and cannot retroactively turn success into
    // failure (a stale sidecar is harmless; an ahead sidecar would false-trip).
    try {
      // P1.5 §3.2 rewind fence: the meta sidecar tracks the high-water
      // replicationSeq. Written AFTER the store (a crash between leaves the
      // sidecar behind the store — harmless; ahead would false-trip the
      // rewind fence). Best-effort like the store write itself.
      const seq = this.store.replicationSeq;
      if (typeof seq === 'number') {
        const metaTmp = `${this.storePath}.meta.json.${process.pid}.tmp`;
        fs.writeFileSync(metaTmp, JSON.stringify({ highWaterSeq: seq }));
        fs.renameSync(metaTmp, `${this.storePath}.meta.json`);
      }
    } catch {
      // @silent-fallback-ok — store rename already committed; sidecar retries later
    }
    return { state: 'committed' };
  }

  /**
   * P1.5 §3.2 — replication bookkeeping at the WRITE FUNNELS. Diffs prev vs
   * next EXCLUDING beacon-bookkeeping fields (consecutiveUnchanged,
   * lastHeartbeatAt, heartbeatCount) and the CAS version: a state-meaningful
   * change bumps the store's replicationSeq and stamps the record's
   * lastMutatedSeq (creation always counts). Quiet-agent heartbeats must
   * never re-ship snapshots. Single-file atomicity: the bump, the stamp, and
   * the record persist in the SAME saveStore() write.
   */
  private stampReplicationIfMeaningful(prev: Commitment | null, next: Commitment): Commitment {
    const BOOKKEEPING = new Set(['consecutiveUnchanged', 'lastHeartbeatAt', 'heartbeatCount', 'version', 'lastMutatedSeq']);
    let meaningful = prev === null;
    if (!meaningful && prev) {
      const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
      for (const k of keys) {
        if (BOOKKEEPING.has(k)) continue;
        const a = (prev as unknown as Record<string, unknown>)[k];
        const b = (next as unknown as Record<string, unknown>)[k];
        if (JSON.stringify(a) !== JSON.stringify(b)) {
          meaningful = true;
          break;
        }
      }
    }
    if (!meaningful) return next;
    const seq = (this.store.replicationSeq ?? 1) + 1;
    this.store.replicationSeq = seq;
    return { ...next, lastMutatedSeq: seq };
  }

  /** P1.5 §3.2 — the advert, answered from MEMORY (never a disk read). */
  getReplicationAdvert(): { incarnation: string; replicationSeq: number } | null {
    const inc = this.store.storeIncarnation;
    const seq = this.store.replicationSeq;
    if (typeof inc !== 'string' || typeof seq !== 'number') return null;
    return { incarnation: inc, replicationSeq: seq };
  }

  private computeNextId(): number {
    if (this.store.commitments.length === 0) return 1;
    const maxId = Math.max(...this.store.commitments.map(c => {
      const match = c.id.match(/CMT-(\d+)/);
      return match ? parseInt(match[1], 10) : 0;
    }));
    return maxId + 1;
  }

  // ── Utility ────────────────────────────────────────────────────

  private deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a === null || b === null) return false;
    if (typeof a !== typeof b) return false;
    if (typeof a !== 'object') return false;

    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(aObj), ...Object.keys(bObj)]);

    for (const key of keys) {
      if (!this.deepEqual(aObj[key], bObj[key])) return false;
    }

    return true;
  }
}

/**
 * DegradationReporter — makes fallback activations LOUD, not silent.
 *
 * When a feature falls back to a secondary path, that's a bug. The fallback
 * keeps the system running, but someone needs to know the primary path failed.
 * Silent fallbacks are almost as bad as silent failures — the user gets a
 * degraded experience and nobody knows about it.
 *
 * This reporter:
 *   1. Logs visibly to console with [DEGRADATION] prefix
 *   2. Queues reports until downstream systems (feedback, telegram) are ready
 *   3. Drains to FeedbackManager (files bug report back to Instar)
 *   4. Sends Telegram alert to agent-attention topic
 *   5. Stores all degradations in a structured file for health checks
 *
 * Usage:
 *   const reporter = DegradationReporter.getInstance();
 *   reporter.report({
 *     feature: 'TopicMemory',
 *     primary: 'SQLite-backed context with summaries',
 *     fallback: 'JSONL-based last 20 messages',
 *     reason: 'better-sqlite3 failed to load',
 *     impact: 'Sessions start without conversation summaries',
 *   });
 *
 * Born from the insight: "Fallbacks should only and always be associated
 * with a bug report back to Instar." — Justin, 2026-02-25
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { detectJargon } from '../core/JargonDetector.js';
import type { MessagingToneGate } from '../core/MessagingToneGate.js';
import { Redactor } from './Redactor.js';
import { ErrorCodeExtractor, type ErrorProvenance } from './ErrorCodeExtractor.js';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';

export interface DegradationEvent {
  /** Which feature degraded */
  feature: string;
  /** What the primary path does */
  primary: string;
  /** What the fallback does (the degraded path) */
  fallback: string;
  /** Why the primary path failed */
  reason: string;
  /** User-facing impact of the degradation */
  impact: string;
  /** When the degradation was detected */
  timestamp: string;
  /** Whether this was reported to the feedback system */
  reported: boolean;
  /** Whether this was sent as a Telegram alert */
  alerted: boolean;
}

/**
 * Normalized degradation event — the go-forward shape per
 * SELF-HEALING-REMEDIATOR-V2-SPEC.md §A33. Replaces the legacy
 * `{feature, primary, fallback, reason, impact}` quintuple with a
 * structured form usable by the Remediator dispatcher (F-8) and the
 * runbook registry's `eventPrefilter.errorCode` matcher (§A6).
 *
 * F-3 ships this contract as additive; emit-site migration is incremental.
 * Legacy `.report(...)` flows through `_normalize()` and arrives at the
 * Remediator as `provenance: 'free-text'`, which §A6 forbids from matching
 * any runbook prefilter. Legacy events therefore route to
 * `no-matching-runbook` and feed NovelFailureReviewer's clustering pipeline.
 */
export interface NormalizedDegradationEvent {
  /** The subsystem that degraded — equivalent of the legacy `feature` field. */
  subsystem: string;
  /** Canonical error code extracted via ErrorCodeExtractor. */
  errorCode: string;
  /** Where the errorCode came from — gates runbook matching per §A6. */
  provenance: ErrorProvenance;
  /** Redacted + full reason payload. `full` stays internal; `redacted` is the only outbound form. */
  reason: {
    redacted: string;
    /** Full unredacted text — never crosses persistence/alert/LLM-prompt boundaries. */
    full: string;
  };
  /** ISO timestamp of detection. */
  timestamp: string;
  /** Monotonic timestamp (Number from `performance.now()` or equivalent) for cross-event ordering. */
  monotonicTs: number;
  /**
   * Optional legacy-event reference. Populated when a normalized event was
   * produced from a legacy `.report(...)` call so downstream consumers
   * (alert path, audit log) can recover the original quintuple.
   */
  legacy?: DegradationEvent;
  /**
   * §A40 / §A52 probe-source binding. Optional; set by probe emit-sites
   * migrated to F-8-rest Tier-2 enforcement.
   */
  source?: {
    probeSignature?: {
      probeId: string;
      subsystem: string;
      outcome: string;
      reason: string;
      monotonicTs: number;
      /** HMAC over the canonical envelope body. */
      signature: Buffer;
    };
  };
}

/**
 * Remediator dispatch surface — F-8 implements this. F-3 only exposes the
 * hook (`setRemediator`) so the dispatcher can subscribe; no consumer is
 * wired in this PR.
 */
export interface RemediatorLike {
  /**
   * The dispatcher's return type is intentionally `Promise<unknown>` (not
   * `Promise<void>`): the F-8 Remediator implementation returns a structured
   * `DispatchOutcome`, but the reporter never inspects the result — the
   * audit log is the canonical record of the dispatched attempt. Widening
   * here keeps the reporter's import surface free of F-8's type tree.
   */
  dispatch(event: NormalizedDegradationEvent): Promise<unknown>;
}

type TelegramSender = (topicId: number, text: string) => Promise<unknown>;
/**
 * Self-heal callback. Returns true if the heal succeeded and the user
 * message should be suppressed; false if the heal failed or was not
 * possible. Producers register one healer per feature name. If no healer
 * is registered for a feature, the alert path proceeds without an
 * attempt and the selfHeal signal reports `attempted: false`.
 */
export type SelfHealer = (event: DegradationEvent) => Promise<boolean>;
/**
 * Safe fallback template used when the tone gate blocks the candidate
 * health-alert message. Plain English, ends with a yes/no the user can
 * answer in one word.
 */
const SAFE_HEALTH_ALERT_TEMPLATE = 'Something on my end stopped working and I haven\'t been able to fix it on my own. Want me to dig in?';
type FeedbackSubmitter = (item: {
  type: 'bug';
  title: string;
  description: string;
  agentName: string;
  instarVersion: string;
  nodeVersion: string;
  os: string;
  context?: string;
}) => Promise<unknown>;

// How long before the same feature can trigger another Telegram alert (ms)
const ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

/**
 * Monotonic timestamp source. Prefers `performance.now()` (high-resolution,
 * monotonic across process lifetime). Falls back to `Date.now()` on
 * environments that don't expose it. Returns a Number, not a bigint, so
 * the value JSON-serializes cleanly into the durable queue.
 */
function monotonicNow(): number {
  try {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now();
    }
  } catch { /* @silent-fallback-ok: environment-capability probe, not a degradation — a runtime without the `performance` API falls back to `Date.now()`; a clock-source probe is low-risk and not a reportable degradation. */ }
  return Date.now();
}

// Durable RestartPending queue caps (per §A5). When `_setRestartPending(true)`
// is asserted (e.g., by the lifeline supervisor staging a restart), incoming
// events are appended to a JSONL queue instead of dispatched immediately.
// Drop-and-counter on overflow — older events stay on disk, new events past
// the cap increment a counter and are discarded so the queue can't grow
// unbounded during a long restart-pending window.
const RESTART_QUEUE_MAX_ENTRIES = 1000;
const RESTART_QUEUE_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB
const RESTART_QUEUE_REL_PATH = path.join('remediation', 'degradations-queue.jsonl');

/**
 * An open heuristic-fallback degradation (Resilient Degradation Ladder §4). Keyed on
 * (component, framework). `retryAttempts` is the LIVENESS signal — the number of times a
 * real-LLM call for this key was attempted and STILL failed since it opened; 0 means the
 * component degraded once and hasn't tried again (idle/run-once, not stuck → TTL-close).
 */
interface OpenDegradation {
  component: string;
  framework: string;
  openedAt: number;
  retryAttempts: number;
  lastEscalatedAt: number | null;
}

export class DegradationReporter {
  private static instance: DegradationReporter | null = null;

  private events: DegradationEvent[] = [];
  /** Reentrancy guard for gateHealthAlert (event-loop WEDGE fix, 2026-06-21). */
  private _gatingHealthAlert = false;
  /**
   * Hard cap on the in-memory `events` array (WEDGE fix, 2026-06-21). Defence in
   * depth alongside the reentrancy guard: even outside the recursion, an agent that
   * degrades steadily for a long uptime would otherwise grow `events` without bound,
   * and operations that serialize the whole array (`getEventsJson`, persistence) get
   * slower with it. Keep the most recent N.
   */
  private static readonly MAX_EVENTS = 500;
  private stateDir: string | null = null;
  private agentName: string = 'unknown';
  private instarVersion: string = '0.0.0';

  // Downstream systems — connected once the server is fully up
  private feedbackSubmitter: FeedbackSubmitter | null = null;
  private telegramSender: TelegramSender | null = null;
  private alertTopicId: number | null = null;
  private toneGate: MessagingToneGate | null = null;
  private healers: Map<string, SelfHealer> = new Map();

  // Dedup: track last alert time per feature to avoid spamming Telegram
  private lastAlertTime: Map<string, number> = new Map();

  // ── Never-silent degradation lifecycle (Resilient Degradation Ladder §4) ──────
  // Tracks open heuristic-fallback degradations so one can NEVER silently persist
  // indefinitely (the operator's principle). Designed to NOT repeat the 2026-06-21
  // wedge: bounded (MAX_OPEN), O(1) per open/resolve (no full-map serialize), the
  // escalation sweep NEVER calls report()/reportEvent()/gateHealthAlert (it surfaces
  // via telegramSender directly), and it is liveness-gated (a run-once/idle component
  // auto-closes via TTL rather than escalating a false alarm).
  private openDegradations: Map<string, OpenDegradation> = new Map();
  private neverSilentEnabled = false;
  private neverSilentEscalateMs = 15 * 60_000; // 15m before a persistent open escalates
  private neverSilentTtlMs = 30 * 60_000;       // idle/run-once auto-close window
  private neverSilentMaxOpen = 500;             // hard cap on the open map (anti-wedge)
  /** Injectable clock for the lifecycle (testing). Default Date.now. */
  private neverSilentNow: () => number = () => Date.now();

  // F-3 additions ─────────────────────────────────────────────
  // The Remediator dispatch hook (F-8 wires the consumer). When set, the
  // legacy `.report(...)` and the new `.reportStructured(...)` both route
  // their normalized events to `remediator.dispatch()` instead of the
  // legacy alert path. When unset, the legacy alert path runs unchanged
  // (backward compat — F-3 ships a shim only, no emit-site migration).
  private remediator: RemediatorLike | null = null;

  // Centralized redactor for the `reason.full → reason.redacted` step.
  // Lazily instantiated so tests that don't exercise normalization don't pay
  // the (cheap) construction cost.
  private redactor: Redactor | null = null;

  // RestartPending — when true, events queue to disk instead of dispatching.
  // Flipped by the lifeline supervisor (or test harness) via _setRestartPending.
  private restartPending = false;

  // Overflow counter — incremented when the queue cap is hit so we know
  // how many events were dropped during a restart-pending window. Persisted
  // alongside the queue file as a sidecar JSON.
  private queueDropCount = 0;

  private constructor() {}

  static getInstance(): DegradationReporter {
    if (!DegradationReporter.instance) {
      DegradationReporter.instance = new DegradationReporter();
    }
    return DegradationReporter.instance;
  }

  /**
   * Reset singleton for testing.
   */
  static resetForTesting(): void {
    DegradationReporter.instance = null;
  }

  /**
   * Configure with agent identity and storage.
   * Called during server startup before features initialize.
   */
  configure(opts: {
    stateDir: string;
    agentName: string;
    instarVersion: string;
  }): void {
    this.stateDir = opts.stateDir;
    this.agentName = opts.agentName;
    this.instarVersion = opts.instarVersion;
  }

  /**
   * Connect downstream reporting systems.
   * Called once the server is fully started and feedback/telegram are available.
   * Drains any queued events that were reported before downstream was ready.
   */
  connectDownstream(opts: {
    feedbackSubmitter?: FeedbackSubmitter;
    telegramSender?: TelegramSender;
    alertTopicId?: number | null;
    toneGate?: MessagingToneGate | null;
  }): void {
    this.feedbackSubmitter = opts.feedbackSubmitter ?? null;
    this.telegramSender = opts.telegramSender ?? null;
    this.alertTopicId = opts.alertTopicId ?? null;
    this.toneGate = opts.toneGate ?? null;

    // Drain queued events that weren't reported yet
    this.drainQueue();
  }

  /**
   * Register a self-heal callback for a feature. When a degradation for
   * that feature is reported, the callback is invoked BEFORE the user
   * alert path runs. If it returns true, the user alert is suppressed
   * (the issue is already fixed). If it returns false, the alert proceeds.
   *
   * Healers should be idempotent — they may be invoked on every report
   * for that feature.
   */
  registerHealer(feature: string, healer: SelfHealer): void {
    this.healers.set(feature, healer);
  }

  // ── Never-silent degradation lifecycle (Resilient Degradation Ladder §4) ──────

  /** Configure (and enable) never-silent tracking. Called once at server startup with the
   *  dev-gate-resolved `enabled`. `now` is injectable for tests. */
  configureNeverSilent(opts: {
    enabled: boolean;
    escalateMs?: number;
    ttlMs?: number;
    maxOpen?: number;
    now?: () => number;
  }): void {
    this.neverSilentEnabled = opts.enabled === true;
    if (opts.escalateMs && opts.escalateMs > 0) this.neverSilentEscalateMs = opts.escalateMs;
    if (opts.ttlMs && opts.ttlMs > 0) this.neverSilentTtlMs = opts.ttlMs;
    if (opts.maxOpen && opts.maxOpen > 0) this.neverSilentMaxOpen = opts.maxOpen;
    if (opts.now) this.neverSilentNow = opts.now;
    this.openDegradations.clear(); // fresh config = fresh state (startup is empty; gives test isolation)
  }

  private nsKey(component: string, framework: string): string {
    return component + '::' + framework;
  }

  /**
   * A heuristic fallback fired for (component, framework) — open a degradation, or if one is
   * already open, increment its retry-attempts (the liveness signal: it tried again and STILL
   * failed → stuck). Bounded by MAX_OPEN (oldest evicted), O(1). No-op when disabled.
   */
  openDegradation(component: string, framework: string): void {
    if (!this.neverSilentEnabled) return;
    const k = this.nsKey(component, framework);
    const existing = this.openDegradations.get(k);
    if (existing) {
      existing.retryAttempts++; // a re-attempt that also fell to heuristic = it's genuinely stuck
      return;
    }
    if (this.openDegradations.size >= this.neverSilentMaxOpen) {
      const oldest = this.openDegradations.keys().next().value; // Map preserves insertion order
      if (oldest !== undefined) this.openDegradations.delete(oldest);
    }
    this.openDegradations.set(k, {
      component, framework, openedAt: this.neverSilentNow(), retryAttempts: 0, lastEscalatedAt: null,
    });
  }

  /**
   * A real-LLM call for (component, framework) SUCCEEDED — auto-resolve the open degradation
   * (the never-silent recovery). Returns the degraded duration (ms) or null if none was open.
   * O(1). No-op when disabled.
   */
  resolveDegradation(component: string, framework: string): number | null {
    if (!this.neverSilentEnabled) return null;
    const k = this.nsKey(component, framework);
    const d = this.openDegradations.get(k);
    if (!d) return null;
    this.openDegradations.delete(k);
    return this.neverSilentNow() - d.openedAt;
  }

  /** Count of currently-open degradations (observability). */
  openDegradationCount(): number {
    return this.openDegradations.size;
  }

  /**
   * Level-triggered sweep (timer-driven): escalate a degradation OPEN past escalateMs that has
   * genuinely retried (≥1), and TTL-auto-close an idle/run-once one (0 retries past ttlMs). Deduped
   * per episode (re-escalates only after another full window). REENTRANCY-SAFE: it NEVER calls
   * report()/reportEvent()/gateHealthAlert — it surfaces via telegramSender directly (the 2026-06-21
   * wedge was that recursion). No-op when disabled.
   */
  sweepOpenDegradations(): void {
    if (!this.neverSilentEnabled) return;
    const now = this.neverSilentNow();
    for (const [k, d] of this.openDegradations) {
      const age = now - d.openedAt;
      if (d.retryAttempts === 0) {
        // Idle / run-once: degraded once, never retried → done, not stuck. Auto-close at the TTL.
        if (age > this.neverSilentTtlMs) this.openDegradations.delete(k);
        continue;
      }
      if (age > this.neverSilentEscalateMs &&
          (d.lastEscalatedAt === null || now - d.lastEscalatedAt > this.neverSilentEscalateMs)) {
        d.lastEscalatedAt = now;
        this.escalatePersistentDegradation(d, age);
      }
    }
  }

  /** Surface a persistent-degradation attention item DIRECTLY (fixed template, no toneGate, no
   *  report — reentrancy-safe per §4). Best-effort; never throws into the sweep. */
  private escalatePersistentDegradation(d: OpenDegradation, ageMs: number): void {
    try {
      if (!this.telegramSender || this.alertTopicId === null) return;
      const mins = Math.round(ageMs / 60_000);
      const msg =
        `⚠ ${d.component} has been on its heuristic fallback for ~${mins}m — the real-LLM path ` +
        `(${d.framework}) hasn't recovered. It auto-clears the next time an LLM call for it succeeds.`;
      void this.telegramSender(this.alertTopicId, msg);
    } catch {
      // @silent-fallback-ok: escalation is best-effort; a send failure must never throw into the
      // level-triggered sweep (which would stall the timer). The next sweep retries.
    }
  }

  /**
   * Report a degradation event.
   *
   * This is the primary API. Call this whenever a fallback activates.
   * If downstream systems aren't ready yet, the event is queued.
   *
   * Per spec §A33 (F-3), legacy `.report(...)` callers continue to work
   * unchanged. Internally the event is normalized via `_normalize()` and
   * either dispatched to the registered Remediator (if `setRemediator()`
   * has been called) or sent through the legacy alert path (backward
   * compat). RestartPending re-routes everything to the durable queue.
   */
  report(event: Omit<DegradationEvent, 'timestamp' | 'reported' | 'alerted'>): void {
    const full: DegradationEvent = {
      ...event,
      timestamp: new Date().toISOString(),
      reported: false,
      alerted: false,
    };

    // Always log to console — never silent
    console.warn(
      `[DEGRADATION] ${event.feature}: ${event.reason}\n` +
      `  Primary: ${event.primary}\n` +
      `  Fallback: ${event.fallback}\n` +
      `  Impact: ${event.impact}`
    );

    this.events.push(full);
    // Bound the in-memory array (WEDGE fix): never let it grow without limit.
    if (this.events.length > DegradationReporter.MAX_EVENTS) {
      this.events.splice(0, this.events.length - DegradationReporter.MAX_EVENTS);
    }
    this.persistToDisk(full);

    // F-3 path: produce a NormalizedDegradationEvent and either dispatch
    // it to the Remediator (if set) or queue it (if RestartPending).
    const normalized = this._normalize(full);

    if (this.restartPending) {
      this.enqueueRestartPending(normalized);
      return;
    }

    if (this.remediator) {
      // Fire-and-forget — dispatch errors land in console.error but never
      // crash the caller. The legacy `.report(...)` API is sync-shaped.
      this.remediator.dispatch(normalized).catch((err) => {
        console.error(
          `[DEGRADATION] Remediator dispatch failed for ${full.feature}: ${err instanceof Error ? err.message : err}`
        );
      });
      return;
    }

    // No Remediator wired — legacy alert path runs unchanged.
    this.reportEvent(full);
  }

  /**
   * Report a structured degradation event (F-3 / §A33 go-forward API).
   *
   * Callers that have already produced a NormalizedDegradationEvent (e.g.,
   * via the ErrorCodeExtractor with a verified probe emission) skip the
   * legacy normalization step. The caller's provenance is preserved verbatim
   * — F-3 does NOT downgrade structured callers to `free-text`.
   *
   * Behaviour:
   * - Always logged with `[DEGRADATION-NORMALIZED]` prefix for grep-ability.
   * - If RestartPending → queue to disk.
   * - Else if Remediator wired → dispatch.
   * - Else → no consumer (event is recorded but not alerted). Structured
   *   callers must wire the Remediator (F-8) for it to route anywhere; this
   *   is intentional, since structured callers bypass the legacy alert path.
   */
  reportStructured(event: NormalizedDegradationEvent): void {
    const stamped: NormalizedDegradationEvent = {
      ...event,
      // Preserve caller-provided timestamp/monotonicTs if present; fill if not.
      timestamp: event.timestamp || new Date().toISOString(),
      monotonicTs: typeof event.monotonicTs === 'number'
        ? event.monotonicTs
        : monotonicNow(),
    };

    console.warn(
      `[DEGRADATION-NORMALIZED] ${stamped.subsystem}: ${stamped.errorCode} (provenance=${stamped.provenance})`
    );

    if (this.restartPending) {
      this.enqueueRestartPending(stamped);
      return;
    }

    if (this.remediator) {
      this.remediator.dispatch(stamped).catch((err) => {
        console.error(
          `[DEGRADATION] Remediator dispatch failed for ${stamped.subsystem}: ${err instanceof Error ? err.message : err}`
        );
      });
    }
  }

  /**
   * Register the Remediator dispatcher (F-8 wires the consumer). When set,
   * incoming events route to `remediator.dispatch()` instead of the legacy
   * alert path. Passing `null` clears the hook.
   *
   * F-3 only exposes the hook surface — there is no consumer in this PR.
   */
  setRemediator(remediator: RemediatorLike | null): void {
    this.remediator = remediator;
  }

  /**
   * Internal: convert a legacy `DegradationEvent` into the normalized form.
   * Public for testability — F-8 / downstream consumers should never call
   * this directly. Exposed as `_normalize` (leading underscore) per the
   * project's "private-ish" convention.
   *
   * Mapping (per §A33):
   *   feature   → subsystem
   *   reason    → reason.full (and .redacted, via Redactor)
   *   errorCode → extracted via ErrorCodeExtractor from free text → 'LEGACY_DEGRADATION' fallback
   *   provenance → always 'free-text' (legacy callers are unstructured by definition)
   *
   * §A6 forbids matchers against `free-text` provenance — legacy events
   * therefore route to `no-matching-runbook` once F-8 ships.
   */
  _normalize(legacy: DegradationEvent): NormalizedDegradationEvent {
    const redactor = this.getRedactor();
    const { text: redacted } = redactor.redact(legacy.reason);

    // Attempt errorCode extraction from the legacy reason. Per §A33 the
    // canonical fallback is the literal 'LEGACY_DEGRADATION' sentinel so
    // downstream observability can count legacy emit-sites distinctly.
    const extracted = ErrorCodeExtractor.extract({ freeText: legacy.reason });
    const errorCode = extracted.code === 'UNKNOWN_ERROR'
      ? 'LEGACY_DEGRADATION'
      : extracted.code;

    return {
      subsystem: legacy.feature,
      errorCode,
      provenance: 'free-text',
      reason: { redacted, full: legacy.reason },
      timestamp: legacy.timestamp,
      monotonicTs: monotonicNow(),
      legacy,
    };
  }

  /**
   * Flip the RestartPending flag. When true, incoming events queue to disk
   * (`<stateDir>/remediation/degradations-queue.jsonl`) instead of being
   * dispatched. When flipped back to false, the queue replays through the
   * normal dispatch path.
   *
   * Caller contract (per §A5): the lifeline supervisor asserts this flag
   * during a staged restart window; flips it off once the restart has
   * completed (or aborted). F-3 exposes the hook; F-8 wires the supervisor.
   */
  _setRestartPending(pending: boolean): void {
    const prev = this.restartPending;
    this.restartPending = pending;
    if (prev && !pending) {
      // Edge transition true→false: replay queued events.
      this.replayRestartPendingQueue();
    }
  }

  /**
   * Read the durable RestartPending queue file. Public for testability /
   * external observability. Returns an empty array if no queue file exists.
   */
  _readRestartPendingQueue(): NormalizedDegradationEvent[] {
    const queuePath = this.restartQueuePath();
    if (!queuePath || !fs.existsSync(queuePath)) return [];
    try {
      const raw = fs.readFileSync(queuePath, 'utf-8');
      return raw
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try { return JSON.parse(line) as NormalizedDegradationEvent; }
          catch { return null; }
        })
        .filter((x): x is NormalizedDegradationEvent => x !== null);
    } catch {
      return [];
    }
  }

  /**
   * How many events were dropped during a RestartPending window because the
   * queue hit its cap. Persists across the queue's lifetime.
   */
  _getQueueDropCount(): number {
    return this.queueDropCount;
  }

  /**
   * Get all degradation events (for health check API).
   */
  getEvents(): DegradationEvent[] {
    return [...this.events];
  }

  /**
   * Generate a human-readable narrative for a degradation event.
   * Used for Telegram alerts and health endpoint summaries.
   * No technical identifiers, no structured fields — just plain language.
   */
  static narrativeFor(event: DegradationEvent): string {
    const impact = event.impact.replace(/\.$/, '');
    const fallbackLower = event.fallback.toLowerCase();

    // Detect failure-state fallbacks (no real alternative, just broken)
    // These describe what ISN'T working, not what IS being used instead
    const isFailureState = /^no |unavailable|never |lost|undiagnosed|unreachable|not running|not delivered|cannot|won't/i.test(fallbackLower)
      || /goes undiagnosed|left halted|in memory only|only in memory|never delivered/i.test(fallbackLower);

    if (isFailureState) {
      return `${impact}. I'll keep trying, but this may need a restart to fully resolve.`;
    }

    // Positive fallback — describe the backup approach being used
    // Strip prefixes like "Falling back to", "Message only in", etc.
    let fallback = event.fallback
      .replace(/^Falling back to /i, '')
      .replace(/^Message only in /i, 'the ')
      .replace(/\.$/, '');

    // Strip parenthetical caveats — the user doesn't need "(no search, no summary updates)"
    fallback = fallback.replace(/\s*\([^)]*\)\s*/g, ' ').trim();

    return `${impact}. Using ${fallback} in the meantime — everything else is working fine.`;
  }

  /**
   * Get unreported events (for monitoring).
   */
  getUnreportedEvents(): DegradationEvent[] {
    return this.events.filter(e => !e.reported);
  }

  /**
   * Mark events as reported by feature-name match. Used by the
   * guardian-pulse daily digest consumer (PR0c — context-death-pitfall-
   * prevention spec) after surfacing them to the attention queue. The
   * built-in feedback / Telegram pipeline marks events automatically;
   * this method is for *external* consumers that close the loop manually.
   *
   * Returns the count of events actually flipped (already-reported events
   * are not counted again — idempotent).
   *
   * `featurePattern` may be either an exact feature-name string or a
   * RegExp. The string form is exact-match; pass a RegExp for prefixes
   * (e.g. /^unjustifiedStopGate/).
   */
  markReported(featurePattern: string | RegExp): number {
    const matcher = typeof featurePattern === 'string'
      ? (name: string) => name === featurePattern
      : (name: string) => featurePattern.test(name);
    let flipped = 0;
    for (const event of this.events) {
      if (!event.reported && matcher(event.feature)) {
        event.reported = true;
        flipped++;
      }
    }
    return flipped;
  }

  /**
   * Check if any degradations have occurred.
   */
  hasDegradations(): boolean {
    return this.events.length > 0;
  }

  // ── Internal ──────────────────────────────────────────────

  private async reportEvent(event: DegradationEvent): Promise<void> {
    // Submit to feedback system
    if (this.feedbackSubmitter && !event.reported) {
      try {
        await this.feedbackSubmitter({
          type: 'bug',
          title: `[DEGRADATION] ${event.feature}: ${event.reason}`,
          description: [
            `A feature fallback was activated, indicating the primary path is broken.`,
            ``,
            `**Feature**: ${event.feature}`,
            `**Primary path**: ${event.primary}`,
            `**Fallback used**: ${event.fallback}`,
            `**Reason**: ${event.reason}`,
            `**Impact**: ${event.impact}`,
            `**Timestamp**: ${event.timestamp}`,
          ].join('\n'),
          agentName: this.agentName,
          instarVersion: this.instarVersion,
          nodeVersion: process.version,
          os: `${os.platform()} ${os.release()}`,
          context: JSON.stringify({
            feature: event.feature,
            reason: event.reason,
            nodeArch: process.arch,
            nodeVersion: process.version,
          }),
        });
        event.reported = true;
      } catch (err) {
        // @silent-fallback-ok — self-referential (cannot report own failures)
        // Don't fail on reporting failures — the console log is the safety net
        console.error(`[DEGRADATION] Failed to submit feedback: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Send Telegram alert (with per-feature cooldown to avoid spam)
    if (this.telegramSender && this.alertTopicId && !event.alerted) {
      const lastAlert = this.lastAlertTime.get(event.feature) ?? 0;
      const now = Date.now();

      if (now - lastAlert >= ALERT_COOLDOWN_MS) {
        // Self-heal-first. Try the registered healer (if any) before
        // bothering the user. If it succeeds, suppress the alert.
        const healResult = await this.attemptSelfHeal(event);
        if (healResult.succeeded === true) {
          event.alerted = true;
          this.lastAlertTime.set(event.feature, now);
          console.warn(
            `[DEGRADATION] ${event.feature}: self-heal succeeded after ${healResult.attempts} attempt(s); user alert suppressed.`
          );
        } else {
          // Compose the narrative, route it through the tone gate with
          // health-alert signals, fall back to the safe template if blocked.
          const candidate = DegradationReporter.narrativeFor(event);
          const finalText = await this.gateHealthAlert(candidate, healResult);
          try {
            await this.telegramSender(this.alertTopicId, finalText);
            event.alerted = true;
            this.lastAlertTime.set(event.feature, now);
          } catch {
            // Don't fail on alerting failures
          }
        }
      } else {
        // Within cooldown — suppress the alert but mark as handled
        event.alerted = true;
      }
    }

    // Update persisted state
    this.persistToDisk(event);
  }

  /**
   * Attempt the registered self-healer for a feature, if any. Returns the
   * structured signal payload the tone gate expects.
   *
   * No healer registered → `{attempted: false, succeeded: null, attempts: 0}`
   * Healer threw         → `{attempted: true,  succeeded: false, attempts: 1}`
   * Healer returned      → `{attempted: true,  succeeded: result, attempts: 1}`
   */
  private async attemptSelfHeal(event: DegradationEvent): Promise<{
    attempted: boolean;
    succeeded: boolean | null;
    attempts: number;
  }> {
    const healer = this.healers.get(event.feature);
    if (!healer) {
      return { attempted: false, succeeded: null, attempts: 0 };
    }
    try {
      const ok = await healer(event);
      return { attempted: true, succeeded: !!ok, attempts: 1 };
    } catch (err) {
      console.warn(
        `[DEGRADATION] ${event.feature}: self-healer threw — ${err instanceof Error ? err.message : err}`
      );
      return { attempted: true, succeeded: false, attempts: 1 };
    }
  }

  /**
   * Route a candidate health-alert message through the MessagingToneGate
   * with the jargon + selfHeal signals attached. If the gate blocks (rule
   * B12/B13/B14) the candidate is replaced with the safe-template fallback.
   *
   * The gate is the single authority. If no gate is wired (early startup,
   * tests, etc.) the candidate is sent unchanged — fail-open is consistent
   * with how the rest of the outbound surface treats gate-unavailable.
   */
  private async gateHealthAlert(
    candidate: string,
    healSignal: { attempted: boolean; succeeded: boolean | null; attempts: number },
  ): Promise<string> {
    // Reentrancy guard (event-loop WEDGE fix, 2026-06-21). `toneGate.review` runs an
    // LLM through the IntelligenceRouter, which can ITSELF degrade (e.g. an unavailable
    // configured framework) and re-enter `report → reportEvent → gateHealthAlert`. That
    // recursion is unbounded: each level pushes another event, and a `JSON.stringify` of
    // the growing `events` array eventually hangs the single event-loop thread for
    // MINUTES (observed live on Echo: /health HTTP 000, watchdog SIGKILL/respawn loop).
    // Refusing to gate-within-a-gate breaks the cycle regardless of which framework
    // degrades — the inner alert falls back to the safe template instead of recursing.
    if (!this.toneGate || this._gatingHealthAlert) {
      return this._gatingHealthAlert ? SAFE_HEALTH_ALERT_TEMPLATE : candidate;
    }
    this._gatingHealthAlert = true;
    try {
      const jargon = detectJargon(candidate);
      try {
        const result = await this.toneGate.review(candidate, {
          channel: 'telegram',
          messageKind: 'health-alert',
          signals: {
            jargon: { detected: jargon.detected, terms: jargon.terms, score: jargon.score },
            selfHeal: healSignal,
          },
        });
        if (result.pass) {
          return candidate;
        }
        return SAFE_HEALTH_ALERT_TEMPLATE;
      } catch {
        // Fail-open on unexpected gate errors — at least the user hears
        // SOMETHING about the degradation.
        return candidate;
      }
    } finally {
      this._gatingHealthAlert = false;
    }
  }

  private drainQueue(): void {
    for (const event of this.events) {
      if (!event.reported || !event.alerted) {
        this.reportEvent(event);
      }
    }
  }

  /** Lazily construct the shared Redactor used by `_normalize`. */
  private getRedactor(): Redactor {
    if (!this.redactor) this.redactor = new Redactor();
    return this.redactor;
  }

  /**
   * Absolute path to the RestartPending queue JSONL file. Returns null if
   * no stateDir is configured — in that case events are dropped (and counted
   * via `queueDropCount`) since there's nowhere durable to persist them.
   */
  private restartQueuePath(): string | null {
    if (!this.stateDir) return null;
    return path.join(this.stateDir, RESTART_QUEUE_REL_PATH);
  }

  /**
   * Append a normalized event to the durable RestartPending queue. Enforces
   * the §A5 cap (1000 entries / 5 MiB) via drop-and-counter.
   */
  private enqueueRestartPending(event: NormalizedDegradationEvent): void {
    const queuePath = this.restartQueuePath();
    if (!queuePath) {
      // No stateDir → no durable surface → count as dropped so callers can
      // observe the loss via _getQueueDropCount.
      this.queueDropCount += 1;
      return;
    }

    try {
      const dir = path.dirname(queuePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Check current size + entry count for the cap.
      let entryCount = 0;
      let byteSize = 0;
      try {
        const stat = fs.statSync(queuePath);
        byteSize = stat.size;
        const raw = fs.readFileSync(queuePath, 'utf-8');
        entryCount = raw.split('\n').filter(Boolean).length;
      } catch { /* first write */ }

      const line = JSON.stringify(event) + '\n';
      if (entryCount >= RESTART_QUEUE_MAX_ENTRIES || byteSize + line.length > RESTART_QUEUE_MAX_BYTES) {
        this.queueDropCount += 1;
        // Sidecar drop-count file so it survives across processes.
        try {
          fs.writeFileSync(
            queuePath + '.drops.json',
            JSON.stringify({ dropped: this.queueDropCount, ts: new Date().toISOString() }, null, 2)
          );
        } catch { /* best-effort */ }
        return;
      }

      fs.appendFileSync(queuePath, line);
    } catch (err) {
      // Disk failure inside the durable queue is itself a degradation. Log it
      // and bump the drop counter — the legacy alert path is unavailable
      // during RestartPending so there's nothing else to do.
      console.error(
        `[DEGRADATION] RestartPending enqueue failed: ${err instanceof Error ? err.message : err}`
      );
      this.queueDropCount += 1;
    }
  }

  /**
   * Replay the durable queue once `_setRestartPending(false)` fires. Each
   * event is dispatched (or sent through the legacy alert path) in the order
   * it was enqueued; the queue file is then removed on success.
   *
   * Replay is best-effort — if dispatch throws, the queue file is kept on
   * disk so the next replay attempt can retry. Per §A30 the higher-layer
   * Remediator dispatcher owns the 5s wall-time cap and coalescing; F-3
   * does not impose its own.
   */
  private replayRestartPendingQueue(): void {
    const queuePath = this.restartQueuePath();
    if (!queuePath || !fs.existsSync(queuePath)) return;

    const queued = this._readRestartPendingQueue();
    if (queued.length === 0) {
      // Empty / unreadable — clean up the file.
      try {
        SafeFsExecutor.safeUnlinkSync(queuePath, {
          operation: 'DegradationReporter.replayRestartPendingQueue: empty queue cleanup',
        });
      } catch { /* ignore */ }
      return;
    }

    for (const event of queued) {
      if (this.remediator) {
        // Fire-and-forget; replay does not wait for individual dispatches.
        this.remediator.dispatch(event).catch((err) => {
          console.error(
            `[DEGRADATION] Replay dispatch failed for ${event.subsystem}: ${err instanceof Error ? err.message : err}`
          );
        });
      } else if (event.legacy) {
        // Fall back to the legacy alert path for legacy-shaped queued events.
        this.reportEvent(event.legacy);
      }
    }

    // Truncate the queue file. We don't delete the drop-count sidecar — it
    // records cumulative drops across restart windows.
    try {
      SafeFsExecutor.safeUnlinkSync(queuePath, {
        operation: 'DegradationReporter.replayRestartPendingQueue: drain queue after replay',
      });
    } catch { /* ignore */ }
  }

  private persistToDisk(event: DegradationEvent): void {
    if (!this.stateDir) return;

    try {
      const filePath = path.join(this.stateDir, 'degradations.json');
      let existing: DegradationEvent[] = [];
      try {
        existing = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      } catch { /* first write */ }

      // Update or append
      const idx = existing.findIndex(
        e => e.feature === event.feature && e.timestamp === event.timestamp
      );
      if (idx >= 0) {
        existing[idx] = event;
      } else {
        existing.push(event);
      }

      // Keep only last 100 events
      if (existing.length > 100) {
        existing = existing.slice(-100);
      }

      fs.writeFileSync(filePath, JSON.stringify(existing, null, 2));
    } catch {
      // Disk persistence is best-effort
    }
  }
}

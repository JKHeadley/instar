/**
 * DurableOutputScrubber — the config-gated Layer B service that wraps the shared
 * `scrubForStore` floor at a durable-output persistence chokepoint (Durable-Output
 * Hygiene Standard, "What Persists Must Be Clean" —
 * docs/specs/durable-output-hygiene-standard.md §2).
 *
 * The pure floor (src/core/durableSecretScrub.ts) does the redaction; THIS layer
 * adds everything that is NOT pure:
 *   - config gating (enabled / dryRun) — dark-first per Graduated Rollout;
 *   - observability (FeatureMetricsLedger under feature key `durable-output-scrub`);
 *   - the MANDATORY provenance marker on every altered entry (spec Frontloaded
 *     Decision #2 — an unmarked alteration is a swallowed finding);
 *   - the per-store poisoning-rate alarm (spec §2 — a burst of credential-shaped
 *     plants is an attention event, not a quiet counter).
 *
 * SIGNAL-VS-AUTHORITY (spec §Decision points touched, P2): this is a detector
 * holding MUTATION authority over durable content — sanctioned as a deterministic
 * safety floor (the fork-bomb spawn-cap precedent) that earns that authority by
 * being observable, bounded, and reversible-in-posture:
 *   - DARK-FIRST + dryRun soak with a measured false-positive rate;
 *   - provenance marker on every alteration (no silent mutation);
 *   - typed markers + structured metadata (diagnosable after the fact);
 *   - per-store opt-out in the chokepoint inventory;
 *   - an operator-gated enforce flip (dryRun:false is Frontloaded Decision #4).
 *
 * dryRun semantics (the canary): while dryRun holds, the scrub is COMPUTED and
 * its would-redact metrics are recorded, but the ORIGINAL text is returned
 * unchanged — no durable content is ever altered until a deliberate dryRun:false.
 * Telemetry never carries the secret (the floor's metadata is kind/offset/length
 * only, and this layer records COUNTS, never bytes).
 */

import {
  scrubForStore,
  scrubStructured,
  type ScrubForStoreResult,
  type RedactionSpan,
  type StructuredRedactionSpan,
  type DurableSecretKind,
} from '../core/durableSecretScrub.js';

/** Minimal metrics sink — the real FeatureMetricsLedger satisfies this. */
export interface DurableScrubMetricsSink {
  recordEvent(feature: string, outcome: 'fired' | 'noop' | 'error' | 'shed', verdictId?: string): void;
}

/** Fired when one store's redaction rate crosses the poisoning threshold. Carries
 *  COUNTS + kinds only — never bytes (spec §2 telemetry-safety). */
export interface PoisoningSignal {
  store: string;
  /** Redaction events for this store within the current window. */
  count: number;
  /** Distinct pattern kinds seen in the burst. */
  kinds: DurableSecretKind[];
  windowMs: number;
}

export const DURABLE_SCRUB_FEATURE_KEY = 'durable-output-scrub';

export interface DurableOutputScrubberConfig {
  /** Resolved via resolveDevAgentGate at the construction boundary (live-on-dev,
   *  dark-on-fleet). When false the scrubber is a strict no-op. */
  enabled: boolean;
  /** The canary: while true, compute + record metrics but return original text
   *  unchanged (no durable mutation). Defaults to TRUE (fail-safe — a missing
   *  dryRun flag must never silently enable real redaction). */
  dryRun?: boolean;
  /** Input size bound handed to the floor (spec §2). */
  maxBytes?: number;
  metrics?: DurableScrubMetricsSink;
  /** Per-store redaction-rate alarm (spec §2 poisoning visibility). Fires ONCE
   *  per (store) window when count crosses the threshold. */
  onPoisoningSuspected?: (signal: PoisoningSignal) => void;
  /** Redactions within `poisoningWindowMs` on one store before the alarm fires. */
  poisoningThreshold?: number;
  poisoningWindowMs?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

export interface ScrubOutcome {
  /** The text to persist. In dryRun (or when disabled) this is the ORIGINAL
   *  input; live-with-redactions it is the scrubbed text + provenance marker. */
  text: string;
  /** Structured redaction metadata (kind/offset/length only). Populated even in
   *  dryRun (the would-redact record) — never carries matched bytes. */
  redactions: RedactionSpan[];
  /** True only when the returned `text` was actually altered (live, ≥1 redaction). */
  applied: boolean;
  /** The one-line human-visible provenance marker, when any span was redacted. */
  provenance?: string;
}

export interface ScrubStructuredOutcome<T> {
  record: T;
  redactions: StructuredRedactionSpan[];
  applied: boolean;
  provenance?: string;
}

const DEFAULT_POISONING_THRESHOLD = 25;
const DEFAULT_POISONING_WINDOW_MS = 10 * 60_000;

export class DurableOutputScrubber {
  private readonly enabled: boolean;
  private readonly dryRun: boolean;
  private readonly maxBytes?: number;
  private readonly metrics?: DurableScrubMetricsSink;
  private readonly onPoisoningSuspected?: (signal: PoisoningSignal) => void;
  private readonly poisoningThreshold: number;
  private readonly poisoningWindowMs: number;
  private readonly now: () => number;

  /** Per-store rolling redaction timestamps + kinds for the poisoning alarm. */
  private readonly poisoningState = new Map<string, { events: number[]; kinds: Set<DurableSecretKind>; alarmedAt: number }>();

  constructor(config: DurableOutputScrubberConfig) {
    this.enabled = config.enabled === true;
    // Fail-safe: dryRun defaults TRUE. Real redaction requires an explicit false.
    this.dryRun = config.dryRun !== false;
    this.maxBytes = config.maxBytes;
    this.metrics = config.metrics;
    this.onPoisoningSuspected = config.onPoisoningSuspected;
    this.poisoningThreshold = config.poisoningThreshold ?? DEFAULT_POISONING_THRESHOLD;
    this.poisoningWindowMs = config.poisoningWindowMs ?? DEFAULT_POISONING_WINDOW_MS;
    this.now = config.now ?? Date.now;
  }

  /** True when the scrubber will actually mutate durable content (enabled AND live). */
  isEnforcing(): boolean {
    return this.enabled && !this.dryRun;
  }

  /** True when the scrubber is engaged at all (enabled — includes dryRun soak). */
  isEngaged(): boolean {
    return this.enabled;
  }

  private buildProvenance(result: Pick<ScrubForStoreResult, 'redactions' | 'truncated' | 'error'>): string {
    const n = result.redactions.length;
    if (result.error) return '⚠ durable-output scrub error — field withheld (see feature metrics: durable-output-scrub)';
    if (result.truncated) return '⚠ durable-output oversize — field withheld (see feature metrics: durable-output-scrub)';
    return `${n} span${n === 1 ? '' : 's'} redacted by durable-output scrub (see feature metrics: durable-output-scrub)`;
  }

  private recordAndAlarm(store: string, result: Pick<ScrubForStoreResult, 'redactions' | 'error'>, kinds: DurableSecretKind[]): void {
    // Metrics: fired (any redaction), error (fail-safe path), else noop. Counts
    // only — never the matched bytes (telemetry-safety, spec §2).
    if (this.metrics) {
      const outcome = result.error ? 'error' : result.redactions.length > 0 ? 'fired' : 'noop';
      try {
        this.metrics.recordEvent(DURABLE_SCRUB_FEATURE_KEY, outcome);
      } catch { // @silent-fallback-ok — observability must never break the persist path; a metrics sink throw is dropped so the store write still completes.
        /* metrics are best-effort — never break a durable write */
      }
    }
    if (result.redactions.length === 0) return;
    this.maybeAlarm(store, kinds);
  }

  private maybeAlarm(store: string, kinds: DurableSecretKind[]): void {
    if (!this.onPoisoningSuspected) return;
    const t = this.now();
    let state = this.poisoningState.get(store);
    if (!state) {
      state = { events: [], kinds: new Set(), alarmedAt: 0 };
      this.poisoningState.set(store, state);
    }
    state.events.push(t);
    for (const k of kinds) state.kinds.add(k);
    // Drop events outside the window.
    const cutoff = t - this.poisoningWindowMs;
    while (state.events.length > 0 && state.events[0] < cutoff) state.events.shift();
    if (state.events.length >= this.poisoningThreshold && state.alarmedAt < cutoff) {
      state.alarmedAt = t;
      const signal: PoisoningSignal = {
        store,
        count: state.events.length,
        kinds: [...state.kinds],
        windowMs: this.poisoningWindowMs,
      };
      try {
        this.onPoisoningSuspected(signal);
      } catch { // @silent-fallback-ok — the alarm callback is a signal-only escalation; a throw in the consumer must not break the durable write path.
        /* escalation is best-effort — never break a durable write */
      }
      // Reset the window's kind set after alarming so a fresh burst re-signals.
      state.kinds = new Set();
    }
  }

  /**
   * Scrub a single durable string field. Returns the original text unchanged when
   * disabled or in dryRun; the scrubbed text + provenance marker when enforcing.
   * Metrics + poisoning alarm fire in BOTH dryRun and enforcing modes.
   */
  scrub(input: string, ctx: { store: string; callsite?: string }): ScrubOutcome {
    if (!this.enabled) {
      return { text: input, redactions: [], applied: false };
    }
    const result = scrubForStore(input, this.maxBytes != null ? { maxBytes: this.maxBytes } : {});
    const kinds = result.redactions
      .map((r) => r.kind)
      .filter((k): k is DurableSecretKind => k !== 'scrub-error' && k !== 'oversize');
    this.recordAndAlarm(ctx.store, result, kinds);

    const hasRedaction = result.redactions.length > 0;
    if (this.dryRun) {
      // Canary: computed + recorded, but the ORIGINAL text is what persists.
      return {
        text: input,
        redactions: result.redactions,
        applied: false,
        provenance: hasRedaction ? this.buildProvenance(result) : undefined,
      };
    }
    // Enforcing: the scrubbed text persists, carrying the provenance marker.
    return {
      text: result.text,
      redactions: result.redactions,
      applied: hasRedaction,
      provenance: hasRedaction ? this.buildProvenance(result) : undefined,
    };
  }

  /**
   * Scrub the named string fields of a structured record before serialization
   * (spec §2 — structured stores). Same dryRun/enforcing semantics as `scrub`.
   */
  scrubRecord<T extends Record<string, unknown>>(
    record: T,
    fields: readonly (keyof T)[],
    ctx: { store: string; callsite?: string },
  ): ScrubStructuredOutcome<T> {
    if (!this.enabled) {
      return { record, redactions: [], applied: false };
    }
    const result = scrubStructured(record, fields, this.maxBytes != null ? { maxBytes: this.maxBytes } : {});
    const kinds = result.redactions
      .map((r) => r.kind)
      .filter((k): k is DurableSecretKind => k !== 'scrub-error' && k !== 'oversize');
    this.recordAndAlarm(ctx.store, { redactions: result.redactions, error: result.error }, kinds);

    const hasRedaction = result.redactions.length > 0;
    const provenance = hasRedaction
      ? this.buildProvenance({ redactions: result.redactions, truncated: result.truncated, error: result.error })
      : undefined;

    if (this.dryRun) {
      return { record, redactions: result.redactions, applied: false, provenance };
    }
    return { record: result.record, redactions: result.redactions, applied: hasRedaction, provenance };
  }
}

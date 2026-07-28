/**
 * DeferralPatternSentinel — signal-only accumulation over the canonical
 * premature-deferral recognizer's EXISTING tone-decision provenance rows.
 *
 * Increment 1 is deliberately pure/injected and NOT boot-wired. It owns no
 * timer, store, route, or recognizer. The caller supplies the already-persisted
 * content-free observations produced by `detectDeferralShape()` through
 * `buildToneDecisionContext()`; this sentinel only asks whether enough recent,
 * distinct positive observations form a pattern worth one deduped Attention
 * item.
 *
 * The observation projection itself belongs to JudgmentProvenanceLog so callers
 * cannot accidentally grow a second reader over the canonical JSONL store.
 */

export interface DeferralPatternObservation {
  /** Timestamp of the existing tone-decision provenance row. */
  observedAt: number;
  /** Existing content-free recognizer output. */
  deferralShapeDetected: boolean;
  /** Existing candidate sha256; used only to avoid counting replayed rows twice. */
  candidateSha256: string;
}

export interface DeferralPatternAttention {
  title: string;
  body: string;
  priority: 'high';
  dedupKey: string;
  source: 'deferral-pattern-sentinel';
}

export interface DeferralPatternSentinelConfig {
  enabled?: boolean;
  dryRun?: boolean;
  /** Distinct positive observations required to call the accumulation a pattern. */
  threshold?: number;
  /** Only observations this recent participate. */
  windowMs?: number;
}

export interface DeferralPatternSentinelResolvedConfig {
  enabled: boolean;
  dryRun: boolean;
  threshold: number;
  windowMs: number;
}

export interface DeferralPatternSentinelDeps {
  enabled: () => boolean;
  dryRun: () => boolean;
  threshold: () => number;
  windowMs: () => number;
  /** Reads the existing provenance surface. This sentinel creates no parallel store. */
  getObservations: () => DeferralPatternObservation[];
  raiseAttention: (item: DeferralPatternAttention) => void;
  audit?: (event: string, detail: Record<string, unknown>) => void;
}

export interface DeferralPatternTickResult {
  ran: boolean;
  patternDetected: boolean;
  distinctDeferrals: number;
  raised: boolean;
}

export interface DeferralPatternSentinelStatus {
  enabled: boolean;
  dryRun: boolean;
  threshold: number;
  windowMs: number;
  lastTickAt: string | null;
  distinctDeferrals: number;
  patternDetected: boolean;
  counters: { ticks: number; raises: number; wouldRaise: number; errors: number };
}

const DEFAULT_THRESHOLD = 3;
const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60_000;
const DEDUP_KEY = 'premature-deferral-pattern';

export function resolveDeferralPatternSentinelConfig(
  block: DeferralPatternSentinelConfig | undefined,
  resolveEnabled: (explicit: boolean | undefined) => boolean,
): DeferralPatternSentinelResolvedConfig {
  const b = block ?? {};
  return {
    enabled: resolveEnabled(typeof b.enabled === 'boolean' ? b.enabled : undefined),
    dryRun: typeof b.dryRun === 'boolean' ? b.dryRun : true,
    threshold: positiveIntegerOr(b.threshold, DEFAULT_THRESHOLD),
    windowMs: positiveIntegerOr(b.windowMs, DEFAULT_WINDOW_MS),
  };
}

export function guardStatusFor(
  cfg: DeferralPatternSentinelResolvedConfig,
): 'dark' | 'dry-run' | 'live' {
  return cfg.enabled ? (cfg.dryRun ? 'dry-run' : 'live') : 'dark';
}

/**
 * Count distinct positive observations inside [now-windowMs, now].
 * Future-dated, malformed, negative, and replayed rows do not contribute.
 */
export function countRecentDistinctDeferrals(
  observations: DeferralPatternObservation[],
  now: number,
  windowMs: number,
): number {
  const floor = now - Math.max(1, windowMs);
  const hashes = new Set<string>();
  for (const row of observations) {
    if (
      row.deferralShapeDetected !== true ||
      !Number.isFinite(row.observedAt) ||
      row.observedAt < floor ||
      row.observedAt > now ||
      !/^[0-9a-f]{64}$/i.test(row.candidateSha256)
    ) {
      continue;
    }
    hashes.add(row.candidateSha256.toLowerCase());
  }
  return hashes.size;
}

export class DeferralPatternSentinel {
  private ticks = 0;
  private raises = 0;
  private wouldRaise = 0;
  private errors = 0;
  private lastTickAtMs = 0;
  private lastDistinctDeferrals = 0;
  private lastPatternDetected = false;

  constructor(
    private readonly deps: DeferralPatternSentinelDeps,
    private readonly now: () => number = Date.now,
  ) {}

  tick(): DeferralPatternTickResult {
    if (!this.deps.enabled()) {
      return { ran: false, patternDetected: false, distinctDeferrals: 0, raised: false };
    }

    this.ticks += 1;
    this.lastTickAtMs = this.now();
    try {
      const threshold = positiveIntegerOr(this.deps.threshold(), DEFAULT_THRESHOLD);
      const windowMs = positiveIntegerOr(this.deps.windowMs(), DEFAULT_WINDOW_MS);
      const distinctDeferrals = countRecentDistinctDeferrals(
        this.deps.getObservations(),
        this.lastTickAtMs,
        windowMs,
      );
      const patternDetected = distinctDeferrals >= threshold;
      this.lastDistinctDeferrals = distinctDeferrals;
      this.lastPatternDetected = patternDetected;

      if (!patternDetected) {
        this.audit('no-pattern', { distinctDeferrals, threshold, windowMs });
        return { ran: true, patternDetected: false, distinctDeferrals, raised: false };
      }
      if (this.deps.dryRun()) {
        this.wouldRaise += 1;
        this.audit('would-raise', { distinctDeferrals, threshold, windowMs });
        return { ran: true, patternDetected: true, distinctDeferrals, raised: false };
      }

      this.deps.raiseAttention(buildAttention(distinctDeferrals, windowMs));
      this.raises += 1;
      this.audit('raised', { distinctDeferrals, threshold, windowMs });
      return { ran: true, patternDetected: true, distinctDeferrals, raised: true };
    } catch (err) {
      this.errors += 1;
      this.lastPatternDetected = false;
      this.audit('tick-error', { error: err instanceof Error ? err.message : String(err) });
      return { ran: true, patternDetected: false, distinctDeferrals: 0, raised: false };
    }
  }

  status(): DeferralPatternSentinelStatus {
    return {
      enabled: this.deps.enabled(),
      dryRun: this.deps.dryRun(),
      threshold: positiveIntegerOr(this.deps.threshold(), DEFAULT_THRESHOLD),
      windowMs: positiveIntegerOr(this.deps.windowMs(), DEFAULT_WINDOW_MS),
      lastTickAt: this.lastTickAtMs ? new Date(this.lastTickAtMs).toISOString() : null,
      distinctDeferrals: this.lastDistinctDeferrals,
      patternDetected: this.lastPatternDetected,
      counters: {
        ticks: this.ticks,
        raises: this.raises,
        wouldRaise: this.wouldRaise,
        errors: this.errors,
      },
    };
  }

  private audit(event: string, detail: Record<string, unknown>): void {
    try {
      this.deps.audit?.(event, detail);
    } catch {
      /* @silent-fallback-ok — observability must never break the sentinel */
    }
  }
}

export function buildAttention(
  distinctDeferrals: number,
  windowMs: number,
): DeferralPatternAttention {
  const days = Math.max(1, Math.ceil(windowMs / (24 * 60 * 60_000)));
  return {
    title: 'Repeated operational work was deferred to the user',
    body:
      `${distinctDeferrals} distinct outbound messages in the last ${days} days matched the ` +
      `premature-deferral shape. This is a pattern signal, not a verdict on any one message. ` +
      `Review whether available self-unblock routes were exhausted before asking the user to act.`,
    priority: 'high',
    dedupKey: DEDUP_KEY,
    source: 'deferral-pattern-sentinel',
  };
}

function positiveIntegerOr(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

export const DEFERRAL_PATTERN_DEDUP_KEY = DEDUP_KEY;
export const DEFERRAL_PATTERN_DEFAULT_THRESHOLD = DEFAULT_THRESHOLD;
export const DEFERRAL_PATTERN_DEFAULT_WINDOW_MS = DEFAULT_WINDOW_MS;

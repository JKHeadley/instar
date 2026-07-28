/**
 * HybridLogicalClock — a pure, dependency-injected total-order clock (WS2
 * replicated-store foundation, Component 1).
 *
 * Spec: docs/specs/multi-machine-replicated-store-foundation.md §3 (the whole
 * section), §10.2 (the maxDriftMs clamp invariant), §13 build order step 1,
 * §15 risk-5/risk-6 (maxDriftMs sourcing — BLOCKER-5).
 *
 * HLC combines physical wall-clock time (so order tracks real time and is
 * human-readable) with a logical counter (so causality survives clock skew and
 * equal-millisecond ties). It is the load-bearing total order WS2 merges rely
 * on: "merges order by HLC, never raw wall-clock" (master spec line 229).
 *
 * Design contract (§3.6 Purity + testability):
 *   - Imports NOTHING but its injected seams. No `fs`, no `Date` (only via the
 *     injected `now`), no network. Every operation is a pure function of
 *     `(last, input, now())`.
 *   - The clock (`now`), the `node` id, and persistence (`persist.load/save`)
 *     are constructor deps, so every dangerous property — monotonicity, the
 *     skew bound, restart-monotonicity — is unit-testable with in-memory fakes.
 *
 * Posture (§11): machine-local-by-design. Each machine has its own clock; the
 * clocks CONVERGE via receive() but are never shared state. The HLC TIMESTAMPS
 * are replicated (one per record, §4); the clock OBJECT is not.
 */

/**
 * An HLC value. Carried on each replicated record as the `hlc` field (§4).
 * The triple `(physical, logical, node)` is a globally-unique, totally-ordered
 * stamp (node ids are unique across the pool, so distinct-machine stamps are
 * never "equal" in sort position — §3.3).
 */
export interface HlcTimestamp {
  /** Physical time in ms since epoch (the LARGEST seen, not necessarily now). */
  physical: number;
  /** Logical counter — breaks ties at equal physical and advances under skew. */
  logical: number;
  /** Node (machine) id of the clock that STAMPED this timestamp. The
   *  tie-breaker of LAST resort and the carrier of the origin tag (§7). */
  node: string;
}

/**
 * The persistence seam (§3.5). Injected so crash-safety is unit-testable with
 * an in-memory fake. `save` is expected to be ATOMIC (temp + rename) in the
 * real implementation; the clock calls it on EVERY advance.
 */
export interface HlcPersistence {
  /** Load the last durable stamp, or null if fresh (first boot). */
  load(): HlcTimestamp | null;
  /** Persist the last issued stamp atomically. Called on every advance. */
  save(t: HlcTimestamp): void;
}

/** Constructor config (§3.2). */
export interface HybridLogicalClockConfig {
  /** This machine's id — the `node` stamped on every timestamp this clock issues. */
  node: string;
  /** INJECTED physical-time source (ms since epoch). Tests pass a fake clock. */
  now: () => number;
  /**
   * FIXED bounded-drift ceiling (§3.4, BLOCKER-5). Default 5 minutes, CLAMPED
   * to [60s, 15min]. NOT derived from any "measured pool skew" — no such numeric
   * quantity exists today (ClockSkewStatus is a 3-value categorical enum).
   */
  maxDriftMs?: number;
  /** Persistence seam (§3.5). Omitted ⇒ the clock keeps `last` only in memory. */
  persist?: HlcPersistence;
  /**
   * Optional structured logger for the at-most-once breadcrumbs the spec
   * mandates (a regressed-wall-clock-on-load note, §3.5; a clamp note). Defaults
   * to a no-op so the primitive stays import-free.
   */
  log?: (event: string, detail: Record<string, unknown>) => void;
}

/**
 * A rejected receive (§3.4). Returned (never thrown into the hot path silently)
 * when a remote timestamp exceeds the pool-relative reference by more than the
 * clamped maxDriftMs. The local clock is NOT advanced and the caller MUST
 * quarantine the record (§5, failure-class `skew-suspicious`).
 */
export interface SkewRejection {
  rejected: true;
  reason: 'skew-ahead';
  /** The remote timestamp that was rejected. */
  remote: HlcTimestamp;
  /** The pool-relative reference R the remote was measured against. */
  reference: number;
  /** The clamped drift ceiling that R + ceiling was exceeded by. */
  maxDriftMs: number;
}

/** The result of receive(): either the merged stamp, or a typed rejection. */
export type ReceiveResult =
  | { rejected: false; hlc: HlcTimestamp }
  | SkewRejection;

/** Options for a single receive() call (§3.4 pool-relative reference). */
export interface ReceiveOptions {
  /**
   * An OBSERVED pool-relative physical-time floor (e.g. the observed-pool-median
   * physical time carried in the capacity heartbeat, §3.4). The drift check
   * references `R = max(last.physical, poolReference ?? 0)`, NOT the bare local
   * `now()` — so a receiver whose own NTP is behind does not falsely reject
   * ahead-but-honest peers. Omitted ⇒ R = last.physical.
   */
  poolReference?: number;
}

/** The default bounded-drift ceiling: 5 minutes (§3.4). */
export const DEFAULT_MAX_DRIFT_MS = 5 * 60 * 1000;
/** The floor of the maxDriftMs clamp (§3.4 / §10.2): 60 seconds. */
export const MIN_MAX_DRIFT_MS = 60 * 1000;
/** The ceiling of the maxDriftMs clamp (§3.4 / §10.2): 15 minutes. */
export const MAX_MAX_DRIFT_MS = 15 * 60 * 1000;

/**
 * Clamp a configured maxDriftMs to the [60s, 15min] window (§3.4, §10.2).
 *
 * This is the helper `validateStateSyncInvariants` (§10.2) uses for the
 * `maxDriftMs` knob: a value below the floor would start rejecting ordinary NTP
 * jitter; a value above the ceiling would defeat the fast-clock defense. The
 * spec's §10.2 invariant REJECTS an out-of-range value at config resolution;
 * this clamp helper is the in-clock guard so the primitive is correct even if a
 * caller hands it a raw value. A non-finite/undefined input falls back to the
 * default.
 */
export function clampMaxDriftMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_DRIFT_MS;
  if (value < MIN_MAX_DRIFT_MS) return MIN_MAX_DRIFT_MS;
  if (value > MAX_MAX_DRIFT_MS) return MAX_MAX_DRIFT_MS;
  return value;
}

/** Type guard: is a receive() result a skew rejection? */
export function isSkewRejection(r: ReceiveResult): r is SkewRejection {
  return r.rejected === true;
}

/**
 * Serialize an HlcTimestamp to the compact wire/disk form (§3.5).
 *
 * Default form is a 3-field JSON object (carried on each record as `hlc`). The
 * string form `"<physical>:<logical>:<node>"` is for embedding in a key — and
 * because a node id MAY contain a `:`, the node is the LAST segment and parse
 * splits on the FIRST TWO colons only (physical and logical are numeric and
 * colon-free), so the round-trip is lossless for any node id.
 */
export function serializeHlc(t: HlcTimestamp): string {
  return JSON.stringify({ physical: t.physical, logical: t.logical, node: t.node });
}

/** Serialize to the compact key-string form `"<physical>:<logical>:<node>"`. */
export function serializeHlcKey(t: HlcTimestamp): string {
  return `${t.physical}:${t.logical}:${t.node}`;
}

/**
 * Parse the JSON object form (§3.5). Throws on malformed input — a record whose
 * `hlc` cannot be parsed is a schema reject upstream, never a silent default.
 */
export function parseHlc(input: string): HlcTimestamp {
  let raw: unknown;
  try {
    raw = JSON.parse(input);
  } catch {
    throw new Error(`parseHlc: not valid JSON: ${truncateForError(input)}`);
  }
  return coerceHlc(raw);
}

/** Parse the key-string form `"<physical>:<logical>:<node>"` (§3.5). */
export function parseHlcKey(input: string): HlcTimestamp {
  if (typeof input !== 'string') {
    throw new Error('parseHlcKey: input is not a string');
  }
  // Split on the FIRST TWO colons only — the node id may contain colons.
  const firstColon = input.indexOf(':');
  const secondColon = firstColon < 0 ? -1 : input.indexOf(':', firstColon + 1);
  if (firstColon < 0 || secondColon < 0) {
    throw new Error(`parseHlcKey: expected "<physical>:<logical>:<node>", got: ${truncateForError(input)}`);
  }
  const physical = Number(input.slice(0, firstColon));
  const logical = Number(input.slice(firstColon + 1, secondColon));
  const node = input.slice(secondColon + 1);
  return coerceHlc({ physical, logical, node });
}

/**
 * Validate + narrow an unknown value to an HlcTimestamp. The single chokepoint
 * both parsers and receive() funnel untrusted input through (§3.5): physical and
 * logical must be finite non-negative integers; node must be a non-empty string.
 */
export function coerceHlc(raw: unknown): HlcTimestamp {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('coerceHlc: not an object');
  }
  const obj = raw as Record<string, unknown>;
  const { physical, logical, node } = obj;
  if (typeof physical !== 'number' || !Number.isInteger(physical) || physical < 0) {
    throw new Error(`coerceHlc: physical must be a non-negative integer, got ${String(physical)}`);
  }
  if (typeof logical !== 'number' || !Number.isInteger(logical) || logical < 0) {
    throw new Error(`coerceHlc: logical must be a non-negative integer, got ${String(logical)}`);
  }
  if (typeof node !== 'string' || node.length === 0) {
    throw new Error('coerceHlc: node must be a non-empty string');
  }
  return { physical, logical, node };
}

function truncateForError(s: string): string {
  const str = String(s);
  return str.length > 80 ? `${str.slice(0, 80)}…` : str;
}

export class HybridLogicalClock {
  private readonly node: string;
  private readonly now: () => number;
  private readonly maxDriftMs: number;
  private readonly persist?: HlcPersistence;
  private readonly log: (event: string, detail: Record<string, unknown>) => void;

  /** The largest stamp this clock has issued (the floor for every advance). */
  private last: HlcTimestamp;

  constructor(config: HybridLogicalClockConfig) {
    if (typeof config.node !== 'string' || config.node.length === 0) {
      throw new Error('HybridLogicalClock: node id must be a non-empty string');
    }
    this.node = config.node;
    this.now = config.now;
    this.maxDriftMs = clampMaxDriftMs(config.maxDriftMs);
    this.persist = config.persist;
    this.log = config.log ?? (() => {});

    const loaded = this.persist?.load() ?? null;
    // Validate the durable stamp through the same chokepoint a parser uses. A
    // CORRUPT (non-null but malformed) load must NOT crash construction (§3.5,
    // "Distrust Temporary Success"): a poisoned/partially-written persistence row
    // would otherwise brick every consumer that boots the clock. We fail TOWARD a
    // fresh-but-monotonic clock (monotonic relative to wall time) and log once,
    // mirroring the missing-file (null) path — never throw out of the constructor.
    let safeLoaded: HlcTimestamp | null;
    if (loaded === null) {
      safeLoaded = null;
    } else {
      try {
        safeLoaded = coerceHlc(loaded);
      } catch (err) {
        // @silent-fallback-ok: a corrupt persisted stamp degrades to the same
        // fresh-but-monotonic clock as the missing-file path (safeLoaded=null
        // below) rather than throwing out of construction — fail toward a usable
        // clock, the safe direction. The discard is logged with context
        // ('hlc-load-corrupt'); it is not a DegradationReporter case.
        this.log('hlc-load-corrupt', {
          error: err instanceof Error ? err.message : String(err),
        });
        safeLoaded = null;
      }
    }

    if (safeLoaded === null) {
      // Fresh (no durable stamp, or a corrupt one we just discarded): start at
      // { physical: now(), logical: 0, node } (§3.5).
      this.last = { physical: this.now(), logical: 0, node: this.node };
    } else {
      // Seed last from the durable stamp so a restart cannot rewind below it.
      // We trust our OWN durable past over a regressed wall clock: if the loaded
      // physical is ahead of now() by more than maxDriftMs (a backward wall-clock
      // jump across the restart) we honor the durable floor and log once (§3.5).
      this.last = { physical: safeLoaded.physical, logical: safeLoaded.logical, node: this.node };
      const wall = this.now();
      if (safeLoaded.physical - wall > this.maxDriftMs) {
        this.log('hlc-load-ahead-of-wall', {
          loadedPhysical: safeLoaded.physical,
          wall,
          maxDriftMs: this.maxDriftMs,
        });
      }
    }
  }

  /** The largest stamp issued so far (a copy — never the internal reference). */
  current(): HlcTimestamp {
    return { ...this.last };
  }

  /** The clamped drift ceiling this clock enforces (§3.4). */
  getMaxDriftMs(): number {
    return this.maxDriftMs;
  }

  /**
   * tick() — local-event advance (§3.2.1). Called when THIS machine AUTHORS a
   * record. `pt = max(now(), last.physical)`; `logical = (pt === last.physical)
   * ? last.logical + 1 : 0`. Persists and returns the new stamp.
   *
   * Monotonicity guarantee: the returned stamp is strictly greater (by compare)
   * than every previous tick()/receive() result on this clock — even if the wall
   * clock jumps backward, because physical never regresses.
   */
  tick(): HlcTimestamp {
    const pt = Math.max(this.now(), this.last.physical);
    const logical = pt === this.last.physical ? this.last.logical + 1 : 0;
    const next: HlcTimestamp = { physical: pt, logical, node: this.node };
    this.commit(next);
    return next;
  }

  /**
   * receive(remote) — merge an inbound peer stamp (§3.2.2 + §3.4). Runs the
   * bounded-drift check FIRST; on rejection the local clock does NOT advance and
   * a typed SkewRejection is returned (the caller quarantines the record).
   *
   * Otherwise the canonical HLC merge (Kulkarni et al.):
   *   pt = max(now(), last.physical, remote.physical)
   *   - pt === last.physical === remote.physical → max(last.logical, remote.logical)+1
   *   - pt === last.physical                     → last.logical + 1
   *   - pt === remote.physical                   → remote.logical + 1
   *   - else                                      → 0
   *
   * Monotonic vs BOTH local and remote: the receiving clock can never go
   * backward, and a received record's causal position is preserved.
   */
  receive(remote: HlcTimestamp, options: ReceiveOptions = {}): ReceiveResult {
    // Narrow untrusted input through the same chokepoint a parser uses.
    const r = coerceHlc(remote);

    // §3.4 — POOL-RELATIVE reference, never the bare local now(). A slow receiver
    // must not quarantine a legitimately-ahead peer just because its own clock lags.
    const reference = Math.max(this.last.physical, options.poolReference ?? 0);
    if (r.physical - reference > this.maxDriftMs) {
      // Clock NOT advanced — a fast peer cannot drag us into the future.
      return {
        rejected: true,
        reason: 'skew-ahead',
        remote: r,
        reference,
        maxDriftMs: this.maxDriftMs,
      };
    }

    const pt = Math.max(this.now(), this.last.physical, r.physical);
    let logical: number;
    if (pt === this.last.physical && pt === r.physical) {
      logical = Math.max(this.last.logical, r.logical) + 1;
    } else if (pt === this.last.physical) {
      logical = this.last.logical + 1;
    } else if (pt === r.physical) {
      logical = r.logical + 1;
    } else {
      logical = 0;
    }
    const next: HlcTimestamp = { physical: pt, logical, node: this.node };
    this.commit(next);
    return { rejected: false, hlc: next };
  }

  /** Advance `last` and persist atomically (§3.5 — persist on EVERY advance). */
  private commit(next: HlcTimestamp): void {
    this.last = next;
    this.persist?.save({ ...next });
  }

  /**
   * compare(a, b) — the STRICT TOTAL ORDER (§3.3, static + pure). Compares
   * physical, then logical, then node id (lexicographic). Returns 0 ONLY for an
   * identical triple — because node ids are unique, two distinct-machine stamps
   * are NEVER "equal" in sort position. This totality is what makes a
   * deterministic merge across the pool possible.
   */
  static compare(a: HlcTimestamp, b: HlcTimestamp): -1 | 0 | 1 {
    if (a.physical !== b.physical) return a.physical < b.physical ? -1 : 1;
    if (a.logical !== b.logical) return a.logical < b.logical ? -1 : 1;
    if (a.node !== b.node) return a.node < b.node ? -1 : 1;
    return 0;
  }
}

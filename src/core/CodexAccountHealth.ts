/**
 * Per-account health for Codex calls — the measurement a degradation trigger needs.
 *
 * Instar records LLM call metrics against the COMPONENT that asked (via
 * `attribution.component`), never against the account that answered. That is the
 * right shape for "what does this feature cost"; it is the wrong shape for "is
 * THIS account unwell", which is the question a swap has to answer. Without a
 * per-account reading, a latency trigger is a dial wired to a dead gauge.
 *
 * This is that gauge, and nothing more: a bounded, in-memory, time-windowed
 * record of how each account's calls actually went.
 *
 * ## The honest-unknown rule
 *
 * `read()` returns `null` when it cannot responsibly answer — no samples, or too
 * few to distinguish a degrading account from ordinary variance. It does NOT
 * return a zero, an "unknown" flag the caller might ignore, or an optimistic
 * default. A trigger acting on two samples would swap live sessions on noise,
 * and the failure mode of a too-eager swap (thrash, sessions moved for nothing)
 * is worse than the failure mode of a late one (a slow account stays slow a
 * while longer).
 *
 * ## What it deliberately does NOT do
 *
 * It records and reports. It does not decide, swap, or notify. Retention is a
 * fixed-size ring per account so a long-running process cannot grow it without
 * bound, and it is intentionally NOT persisted: health is a statement about the
 * last few minutes, and a reading resurrected from before a restart would be a
 * confident answer about a world that no longer exists.
 */

/** One observed call against one account. */
export interface CodexCallSample {
  accountId: string;
  /** Wall-clock duration of the call in ms. */
  latencyMs: number;
  /** Did the call produce a usable result? A timeout counts as NOT ok. */
  ok: boolean;
  /** Observation time (injected in tests). */
  atMs: number;
}

/** What the trigger reads. Every field is measured; none is inferred. */
export interface CodexAccountReading {
  accountId: string;
  /** Median latency across the window, in ms. */
  p50LatencyMs: number;
  /** Share of calls in the window that failed, 0..1. */
  errorRate: number;
  /** How many samples this reading rests on. */
  samples: number;
  /** Oldest and newest sample times backing it — so staleness is visible. */
  windowStartMs: number;
  windowEndMs: number;
}

export interface CodexAccountHealthOptions {
  /** Samples older than this are ignored. Default 15 minutes. */
  windowMs?: number;
  /** Below this many samples in-window, `read()` returns null. Default 5. */
  minSamples?: number;
  /** Ring capacity per account. Default 200. */
  maxSamplesPerAccount?: number;
  now?: () => number;
}

const DEFAULT_WINDOW_MS = 15 * 60_000;
const DEFAULT_MIN_SAMPLES = 5;
const DEFAULT_MAX_PER_ACCOUNT = 200;

export class CodexAccountHealth {
  private readonly windowMs: number;
  private readonly minSamples: number;
  private readonly maxPerAccount: number;
  private readonly now: () => number;
  /** accountId → ring of samples, oldest first. */
  private readonly byAccount = new Map<string, CodexCallSample[]>();

  constructor(opts: CodexAccountHealthOptions = {}) {
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.minSamples = opts.minSamples ?? DEFAULT_MIN_SAMPLES;
    this.maxPerAccount = opts.maxSamplesPerAccount ?? DEFAULT_MAX_PER_ACCOUNT;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Record one observed call. Never throws — this sits on the hot path of every
   * internal Codex call, and a measurement layer that can break the thing it
   * measures is worse than no measurement.
   */
  record(sample: CodexCallSample): void {
    try {
      if (!sample || typeof sample.accountId !== 'string' || sample.accountId.length === 0) return;
      if (!Number.isFinite(sample.latencyMs) || sample.latencyMs < 0) return;
      const ring = this.byAccount.get(sample.accountId) ?? [];
      ring.push(sample);
      // Bounded: drop oldest beyond capacity.
      if (ring.length > this.maxPerAccount) ring.splice(0, ring.length - this.maxPerAccount);
      this.byAccount.set(sample.accountId, ring);
    } catch {
      /* @silent-fallback-ok: recording is observational. Throwing here would let a
         gauge break the engine it is measuring. */
    }
  }

  /**
   * The reading for one account, or `null` when it cannot responsibly answer.
   *
   * Null means "I do not know", and callers must treat it as such — never as
   * "healthy". A trigger that reads null and swaps anyway is acting on nothing.
   */
  read(accountId: string): CodexAccountReading | null {
    const ring = this.byAccount.get(accountId);
    if (!ring || ring.length === 0) return null;

    const cutoff = this.now() - this.windowMs;
    const live = ring.filter((s) => s.atMs >= cutoff);
    if (live.length < this.minSamples) return null;

    const latencies = live.map((s) => s.latencyMs).sort((a, b) => a - b);
    const mid = Math.floor(latencies.length / 2);
    const p50 =
      latencies.length % 2 === 1
        ? latencies[mid]!
        : Math.round((latencies[mid - 1]! + latencies[mid]!) / 2);

    const failures = live.reduce((n, s) => n + (s.ok ? 0 : 1), 0);

    return {
      accountId,
      p50LatencyMs: p50,
      errorRate: failures / live.length,
      samples: live.length,
      windowStartMs: Math.min(...live.map((s) => s.atMs)),
      windowEndMs: Math.max(...live.map((s) => s.atMs)),
    };
  }

  /** Every account with a readable reading. Accounts that cannot answer are omitted. */
  readAll(): CodexAccountReading[] {
    const out: CodexAccountReading[] = [];
    for (const accountId of this.byAccount.keys()) {
      const r = this.read(accountId);
      if (r) out.push(r);
    }
    return out;
  }

  /** Drop samples outside the window for every account. Bounded housekeeping. */
  prune(): void {
    const cutoff = this.now() - this.windowMs;
    for (const [accountId, ring] of this.byAccount) {
      const live = ring.filter((s) => s.atMs >= cutoff);
      if (live.length === 0) this.byAccount.delete(accountId);
      else this.byAccount.set(accountId, live);
    }
  }
}

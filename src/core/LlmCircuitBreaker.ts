/**
 * LlmCircuitBreaker — account-global reactive circuit breaker for LLM calls.
 *
 * Motivating incident (2026-05-28): a wild agent burned $452/$455 in usage
 * credits because PromptGate's per-tick Haiku detection loop kept calling
 * `claude -p` while the account was over its weekly spend limit. The loop's
 * error handler swallowed the rate-limit error with no backoff, so every
 * monitor tick spawned another doomed (or, with auto-reload, freshly-billed)
 * subprocess. There is NO legitimate reason to keep calling the LLM once the
 * provider has told us we are over our limit — every further call is either
 * wasted (rejected) or actively harmful (auto-reload refuels the burn).
 *
 * This breaker reacts to the provider's OWN rate-limit signal in milliseconds,
 * which is distinct from (and complementary to) the volume-based
 * token-burn-detection system (BurnDetector + LlmRateGate), which reacts to
 * statistical token-share over a ~30-minute window. Where the burn system
 * answers "this path is spending too much," the breaker answers "the provider
 * just said we're rate-limited — stop."
 *
 * Scope: ACCOUNT-GLOBAL. A usage/rate limit applies to the whole subscription,
 * not one session or one component, so a single shared breaker pauses every
 * LLM-backed feature (PromptGate, PresenceProxy, PromiseBeacon, sentinels,
 * reviewers) at once. It is wired structurally at the IntelligenceProvider
 * construction chokepoint via CircuitBreakingIntelligenceProvider, so no
 * consumer has to remember to consult it (Structure > Willpower).
 *
 * State: in-memory, process-local. A restart resets it — which is correct: the
 * first call after restart probes the provider, and if still limited the
 * breaker re-trips immediately.
 */

/** Thrown by a provider (or re-thrown by the decorator) when the underlying LLM call was rejected for a usage/rate limit. */
export class RateLimitError extends Error {
  readonly isRateLimit = true as const;
  constructor(message: string, readonly providerError?: unknown) {
    super(message);
    this.name = 'RateLimitError';
  }
}

/** Thrown by the decorator when the breaker is open — the call was refused WITHOUT spawning the underlying provider. */
export class LlmCircuitOpenError extends Error {
  readonly circuitOpen = true as const;
  constructor(readonly retryAfterMs: number) {
    super(
      `LLM circuit breaker open — provider rate-limited; pausing LLM-backed work, retry in ~${Math.ceil(retryAfterMs / 1000)}s`,
    );
    this.name = 'LlmCircuitOpenError';
  }
}

/**
 * Classify whether an error message indicates a provider usage/rate/spend
 * limit (as opposed to a timeout, a parse error, a network blip, etc.).
 *
 * Pure + exported so it is unit-testable against representative CLI error
 * strings from both `claude -p` and `codex exec`. Deliberately conservative:
 * a false positive trips the breaker and degrades all LLM-backed features to
 * heuristic-only for one open window, so we match only language that is
 * unambiguously about hitting a usage/spend/quota ceiling — never generic
 * "error"/"failed"/timeout text.
 */
export function isRateLimitError(message: string | null | undefined): boolean {
  return classifyRateLimit(message).isLimit;
}

/** Sanity clamp for any parsed retry-after hint (ms). */
const RETRY_AFTER_MIN_MS = 1_000; // 1s
const RETRY_AFTER_MAX_MS = 15 * 60_000; // 15min

/**
 * Classify an error message as a rate-limit/quota condition AND, best-effort,
 * extract a retry-after hint in milliseconds.
 *
 * SUPERSET of isRateLimitError: `isLimit` uses the exact same phrase/429/402
 * detection. The CLI error text is unstructured (the underlying HTTP
 * retry-after header is invisible to us — we only see the `claude -p` error
 * string), so `retryAfterMs` is returned only when a duration phrase parses;
 * callers fall back to the flat default window otherwise.
 */
export function classifyRateLimit(message: string | null | undefined): {
  isLimit: boolean;
  retryAfterMs?: number;
} {
  if (!message) return { isLimit: false };
  const m = message.toLowerCase();

  let isLimit = false;

  // Explicit HTTP status codes for limit / billing rejections.
  if (/\b429\b/.test(m)) isLimit = true; // Too Many Requests
  if (/\b402\b/.test(m)) isLimit = true; // Payment Required

  const phrases = [
    'rate limit',
    'rate-limit',
    'rate_limit',
    'ratelimit',
    'too many requests',
    'usage limit',
    'usage_limit',
    'usage-limit',
    'limit reached',
    'limit will reset',
    'limit resets',
    'reached your limit',
    'payment required',
    'out of credit',
    'credit balance is too low',
    'insufficient credit',
    'insufficient quota',
    'quota exceeded',
    'exceeded your',
    'spend limit',
    'spending limit',
    'billing',
  ];
  if (phrases.some((p) => m.includes(p))) isLimit = true;

  // "exceeded ... (limit|quota|usage)" with words in between.
  if (/exceed(?:ed|s)?\b[^.\n]{0,40}(?:limit|quota|usage|credit)/.test(m)) isLimit = true;

  // Bare "quota" is a strong-enough signal on its own (Anthropic/OpenAI both use it).
  if (/\bquota\b/.test(m)) isLimit = true;

  const retryAfterMs = parseRetryAfterMs(m);
  return retryAfterMs !== undefined ? { isLimit, retryAfterMs } : { isLimit };
}

/**
 * Best-effort parse of a retry-after hint from an (already lower-cased) error
 * message. Returns milliseconds clamped to a sane range, or undefined. Matches,
 * in priority order: explicit retry-after, "resets/try again in Ns", then
 * "resets/try again in Nm" and a bare "N minutes" fallback.
 */
function parseRetryAfterMs(m: string): number | undefined {
  let seconds: number | undefined;

  // retry-after: <N>  /  retry after <N> seconds|s
  let match = /retry[\s-]?after:?\s*(\d+(?:\.\d+)?)\s*(?:seconds?|s)?\b/.exec(m);
  if (match) seconds = Number(match[1]);

  // resets in/after <N>s / reset in <N> seconds / try again in <N>s.
  // "(?:in|after)" also catches Gemini's "your quota will reset after 8s"
  // phrasing — without it the hint failed to parse and the breaker fell back
  // to the blunt DEFAULT_OPEN_MS (15 min), turning an 8-second provider reset
  // into a 15-minute global LLM pause (~100x over-correction; observed live on
  // the gemini-cli agent, 2026-06-03).
  if (seconds === undefined) {
    match = /(?:resets?|try again)\s+(?:in|after)\s+(\d+(?:\.\d+)?)\s*(?:seconds?|s)\b/.exec(m);
    if (match) seconds = Number(match[1]);
  }

  // resets in/after <N>m / reset in <N> minutes / try again in <N> minutes
  if (seconds === undefined) {
    match = /(?:resets?|try again)\s+(?:in|after)\s+(\d+(?:\.\d+)?)\s*(?:minutes?|m)\b/.exec(m);
    if (match) seconds = Number(match[1]) * 60;
  }

  // bare "<N> minutes" fallback.
  if (seconds === undefined) {
    match = /(\d+(?:\.\d+)?)\s*minutes?\b/.exec(m);
    if (match) seconds = Number(match[1]) * 60;
  }

  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) {
    return undefined;
  }
  const ms = seconds * 1000;
  return Math.min(Math.max(ms, RETRY_AFTER_MIN_MS), RETRY_AFTER_MAX_MS);
}

type CircuitState = 'closed' | 'open' | 'half-open';

export interface LlmCircuitBreakerOptions {
  /** How long to stay fully open before allowing a single probe. Default 15 min. */
  openMs?: number;
  /** When false, the breaker is a passthrough — acquire() always allows, records are no-ops. Default true. */
  enabled?: boolean;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Injectable logger (defaults to console.warn → server log). */
  log?: (line: string) => void;
  /** Injectable sleep for tests. Default real setTimeout-backed promise. */
  sleep?: (ms: number) => Promise<void>;
  /** Poll interval (ms) used by acquireOrWait while a probe is in flight. Default 250. */
  probePollMs?: number;
}

export interface AcquireDecision {
  /** Whether the caller may invoke the underlying provider. */
  allow: boolean;
  /** True when this acquisition is the single half-open probe. */
  probe: boolean;
  /** When blocked, how long until the next probe window (ms). */
  retryAfterMs: number;
}

export interface LlmCircuitBreakerStatus {
  state: CircuitState;
  enabled: boolean;
  openUntil: number | null;
  retryAfterMs: number;
  tripCount: number;
  lastReason: string | null;
  lastTrippedAt: number | null;
}

const DEFAULT_OPEN_MS = 15 * 60_000; // 15 minutes
const DEFAULT_PROBE_POLL_MS = 250;

export class LlmCircuitBreaker {
  private state: CircuitState = 'closed';
  private openUntil = 0;
  private firstOpenedAt = 0;
  private probeInFlight = false;
  private tripCount = 0;
  private lastReason: string | null = null;
  private lastTrippedAt: number | null = null;

  // Decoupled trip/recover observers (Phase A of the per-agent ResourceLedger).
  // A durable ledger subscribes here to persist rate-limit events without the
  // breaker depending on monitoring/. Listener errors are SWALLOWED — an
  // observer must NEVER affect the breaker, which gates real work.
  private tripListeners: Array<(e: { reason: string; retryAfterMs?: number; ts: number; tripCount: number }) => void> = [];
  private recoverListeners: Array<(e: { ts: number }) => void> = [];

  private openMs: number;
  private enabled: boolean;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly probePollMs: number;
  /**
   * The window length for the CURRENT trip — may be shortened (toward
   * min(30s, openMs)) by a parsed retry-after hint so waiters don't sit out the
   * full flat cooldown when the provider told us when it resets. Reset to openMs
   * on a clean close. The open window is [firstOpenedAt, openUntil); openUntil
   * is firstOpenedAt + currentOpenMs.
   */
  private currentOpenMs: number;

  constructor(opts: LlmCircuitBreakerOptions = {}) {
    this.openMs = opts.openMs && opts.openMs > 0 ? opts.openMs : DEFAULT_OPEN_MS;
    this.enabled = opts.enabled ?? true;
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? ((line) => console.warn(line));
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.probePollMs = opts.probePollMs && opts.probePollMs > 0 ? opts.probePollMs : DEFAULT_PROBE_POLL_MS;
    this.currentOpenMs = this.openMs;
  }

  /** Runtime reconfiguration (called once at server startup from config). */
  configure(opts: { openMs?: number; enabled?: boolean }): void {
    if (typeof opts.openMs === 'number' && opts.openMs > 0) this.openMs = opts.openMs;
    if (typeof opts.enabled === 'boolean') this.enabled = opts.enabled;
  }

  /**
   * Gate a call. Call BEFORE invoking the underlying provider. When it returns
   * { allow: false }, the caller MUST NOT call the provider — throw
   * LlmCircuitOpenError instead (the whole point is to avoid the spend).
   *
   * Exactly one probe is admitted when transitioning out of the open window;
   * concurrent callers are blocked until that probe resolves.
   */
  acquire(): AcquireDecision {
    if (!this.enabled) return { allow: true, probe: false, retryAfterMs: 0 };
    const now = this.now();

    if (this.state === 'closed') {
      return { allow: true, probe: false, retryAfterMs: 0 };
    }

    if (this.state === 'open') {
      if (now >= this.openUntil) {
        // Window elapsed → admit exactly one probe.
        this.state = 'half-open';
        this.probeInFlight = true;
        this.log(
          `[llm-circuit] half-open: admitting one probe call after ~${Math.round((now - this.firstOpenedAt) / 1000)}s open`,
        );
        return { allow: true, probe: true, retryAfterMs: 0 };
      }
      return { allow: false, probe: false, retryAfterMs: this.openUntil - now };
    }

    // half-open
    if (this.probeInFlight) {
      // A probe is already out — block everyone else until it resolves.
      return { allow: false, probe: false, retryAfterMs: Math.max(0, this.openUntil - now) };
    }
    // No probe in flight (defensive) — admit one.
    this.probeInFlight = true;
    return { allow: true, probe: true, retryAfterMs: 0 };
  }

  /**
   * Record that the underlying call returned (or threw a non-rate-limit
   * error). Either way the rate-limit condition is not currently present, so
   * the breaker closes. A non-rate-limit error is handled by the caller's own
   * fallback — it is not the breaker's concern, and staying open on unrelated
   * errors would needlessly keep all LLM features down.
   */
  /** Subscribe to circuit-open (trip) events. Returns an unsubscribe fn. */
  onTrip(cb: (e: { reason: string; retryAfterMs?: number; ts: number; tripCount: number }) => void): () => void {
    this.tripListeners.push(cb);
    return () => { this.tripListeners = this.tripListeners.filter((l) => l !== cb); };
  }

  /** Subscribe to circuit-recover (open→closed) events. Returns an unsubscribe fn. */
  onRecover(cb: (e: { ts: number }) => void): () => void {
    this.recoverListeners.push(cb);
    return () => { this.recoverListeners = this.recoverListeners.filter((l) => l !== cb); };
  }

  private emitTrip(e: { reason: string; retryAfterMs?: number; ts: number; tripCount: number }): void {
    for (const l of this.tripListeners) {
      try { l(e); } catch { /* an observer must never affect the breaker */ }
    }
  }

  private emitRecover(e: { ts: number }): void {
    for (const l of this.recoverListeners) {
      try { l(e); } catch { /* an observer must never affect the breaker */ }
    }
  }

  onResolved(): void {
    if (!this.enabled) return;
    const wasOpen = this.state !== 'closed';
    if (wasOpen) {
      this.log(`[llm-circuit] closing: provider responded (was ${this.state})`);
    }
    this.state = 'closed';
    this.probeInFlight = false;
    this.openUntil = 0;
    // Clean slate — the next trip with no retry-after hint gets the full window.
    this.currentOpenMs = this.openMs;
    if (wasOpen) this.emitRecover({ ts: this.now() });
  }

  /**
   * Record that the underlying call was rejected for a usage/rate limit. Opens
   * (or re-extends) the breaker for a window.
   *
   * When `retryAfterMs` is a finite, positive number (parsed best-effort from
   * the provider error), the open window for THIS trip is shortened to that
   * value, clamped to [min(30s, openMs), openMs] — so coherence-critical
   * waiters don't sit out the full flat cooldown when the provider told us when
   * it resets. Without a hint, the flat default window is used.
   */
  onRateLimited(reason: string, retryAfterMs?: number): void {
    if (!this.enabled) return;
    const now = this.now();
    if (this.state === 'closed') {
      this.firstOpenedAt = now;
    }
    if (
      typeof retryAfterMs === 'number' &&
      Number.isFinite(retryAfterMs) &&
      retryAfterMs > 0
    ) {
      const floor = Math.min(30_000, this.openMs);
      this.currentOpenMs = Math.min(Math.max(retryAfterMs, floor), this.openMs);
    } else {
      this.currentOpenMs = this.openMs;
    }
    this.tripCount += 1;
    this.lastReason = reason.slice(0, 200);
    this.lastTrippedAt = now;
    this.state = 'open';
    this.openUntil = now + this.currentOpenMs;
    this.probeInFlight = false;
    this.log(
      `[llm-circuit] OPEN: provider rate-limited — pausing ALL LLM-backed work for ~${Math.round(
        this.currentOpenMs / 1000,
      )}s (trip #${this.tripCount}); reason: ${this.lastReason}`,
    );
    this.emitTrip({ reason: this.lastReason, retryAfterMs, ts: now, tripCount: this.tripCount });
  }

  /**
   * Bounded wait-and-retry acquire — the coherence-critical primitive.
   *
   * Loops until either the breaker admits the caller (allow:true) or `maxWaitMs`
   * elapses (allow:false — bounded fallback so the caller can fail open/closed
   * on its own terms). When the breaker is open, sleeps until just past the
   * window edge; when half-open with another caller's probe in flight, polls at
   * probePollMs. This serializes waiters behind the single half-open probe:
   * exactly one re-acquires the probe after the window, the rest poll until that
   * probe's onResolved closes the breaker (then acquire returns closed→allow) or
   * its onRateLimited reopens it (then they keep waiting until the deadline). No
   * thundering herd — only one probe hits the provider.
   *
   * A passthrough (disabled) breaker allows immediately with no sleep.
   */
  async acquireOrWait(maxWaitMs: number): Promise<AcquireDecision> {
    const deadline = this.now() + maxWaitMs;
    let gate = this.acquire();
    while (!gate.allow) {
      const remaining = deadline - this.now();
      if (remaining <= 0) break;
      let waitMs: number;
      if (this.state === 'open') {
        // Sleep just past the window edge (gate.retryAfterMs is the remaining
        // open window) so the next acquire() flips us to half-open.
        waitMs = Math.min(gate.retryAfterMs + 1, remaining);
      } else {
        // half-open: someone else holds the probe — poll.
        waitMs = Math.min(this.probePollMs, remaining);
      }
      await this.sleep(Math.max(0, waitMs));
      gate = this.acquire();
    }
    return gate;
  }

  status(): LlmCircuitBreakerStatus {
    const now = this.now();
    return {
      state: this.state,
      enabled: this.enabled,
      openUntil: this.state === 'closed' ? null : this.openUntil,
      retryAfterMs: this.state === 'open' ? Math.max(0, this.openUntil - now) : 0,
      tripCount: this.tripCount,
      lastReason: this.lastReason,
      lastTrippedAt: this.lastTrippedAt,
    };
  }

  /** Reset to a clean closed state. For tests + an explicit operator override. */
  reset(): void {
    this.state = 'closed';
    this.openUntil = 0;
    this.firstOpenedAt = 0;
    this.probeInFlight = false;
    this.currentOpenMs = this.openMs;
  }
}

let _singleton: LlmCircuitBreaker | null = null;

/** Process-wide account-global breaker. All wrapped providers share this instance. */
export function getLlmCircuitBreaker(): LlmCircuitBreaker {
  if (!_singleton) _singleton = new LlmCircuitBreaker();
  return _singleton;
}

/** Configure the singleton at startup. Safe to call before first use. */
export function configureLlmCircuitBreaker(opts: { openMs?: number; enabled?: boolean }): void {
  getLlmCircuitBreaker().configure(opts);
}

/**
 * Read-only convenience: is the shared LLM circuit currently AVAILABLE for new
 * LLM-backed work? True when the breaker is disabled, or its state is 'closed'.
 * False when 'open' or 'half-open' (the provider is rate-limited / probing).
 * Non-mutating — unlike the admission check, it does NOT consume a half-open
 * probe slot, so callers can use it as a pure gate (e.g. the mentor tick backing
 * off rather than re-tripping the circuit). */
export function llmCircuitAvailable(): boolean {
  const s = getLlmCircuitBreaker().status();
  return !s.enabled || s.state === 'closed';
}

/** Test-only: drop the singleton so a fresh one is built next access. */
export function __resetLlmCircuitBreakerSingleton(): void {
  _singleton = null;
}

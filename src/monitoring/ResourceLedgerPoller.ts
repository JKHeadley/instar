/**
 * ResourceLedgerPoller — feeds the ResourceLedger (Phase A: rate-limit events).
 *
 * Event-driven, not polled: subscribes to the LlmCircuitBreaker's trip/recover
 * observer (the primary, account-level rate-limit signal) and, when wired, the
 * RateLimitSentinel's session-scoped events. Each emission becomes one durable
 * `rate_limit_events` row. A per-source monotonic sequence makes same-millisecond
 * events distinct and lets the ledger dedupe replays idempotently.
 *
 * Strictly observation: it only reads signals that already fire and writes them
 * down. It never gates, throttles, or reaches back into the breaker (and the
 * breaker swallows observer errors, so this poller can never affect it).
 *
 * CPU/memory sampling (async, bounded) is Phase B and is not in this file yet.
 *
 * Spec: docs/specs/per-agent-resource-ledger.md.
 */
import type { ResourceLedger, RateLimitEventKind } from './ResourceLedger.js';

/** The minimal breaker surface this poller needs (avoids importing the class so
 *  monitoring/ stays decoupled from the concrete breaker). */
export interface TripObservableBreaker {
  onTrip(cb: (e: { reason: string; retryAfterMs?: number; ts: number; tripCount: number }) => void): () => void;
  onRecover(cb: (e: { ts: number }) => void): () => void;
}

/** The minimal sentinel surface (EventEmitter-shaped). Optional. */
export interface RateLimitEventSentinel {
  on(event: string, listener: (...args: any[]) => void): unknown;
  off?(event: string, listener: (...args: any[]) => void): unknown;
}

export interface ResourceLedgerPollerOptions {
  ledger: ResourceLedger;
  breaker: TripObservableBreaker;
  /** Optional — wired in commands/server.ts where the sentinel is constructed. */
  rateLimitSentinel?: RateLimitEventSentinel | null;
  /** Clock seam for tests. */
  now?: () => number;
  /** Account identifier (single shared key today; reserved for fleet roll-up). */
  accountKey?: string;
}

export class ResourceLedgerPoller {
  private readonly ledger: ResourceLedger;
  private readonly breaker: TripObservableBreaker;
  private readonly sentinel: RateLimitEventSentinel | null;
  private readonly now: () => number;
  private readonly accountKey: string;

  // Per-source monotonic sequence — combined with ts it forms the event id, so
  // two events in the same millisecond stay distinct and a restart can't replay
  // (the seq resets to 0 on restart, but the ledger row id is source:ts:seq and
  // INSERT OR IGNORE — a genuinely new post-restart event has a new ts).
  private breakerSeq = 0;
  private sentinelSeq = 0;
  private unsubs: Array<() => void> = [];
  private started = false;

  constructor(opts: ResourceLedgerPollerOptions) {
    this.ledger = opts.ledger;
    this.breaker = opts.breaker;
    this.sentinel = opts.rateLimitSentinel ?? null;
    this.now = opts.now ?? (() => Date.now());
    this.accountKey = opts.accountKey && opts.accountKey.trim() ? opts.accountKey.trim() : 'default';
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    this.unsubs.push(
      this.breaker.onTrip((e) => {
        this.ledger.recordRateLimitEvent({
          ts: e.ts,
          kind: 'circuit-open',
          source: 'circuit-breaker',
          seq: this.breakerSeq++,
          accountKey: this.accountKey,
          reason: e.reason,
          detail: typeof e.retryAfterMs === 'number' ? `retryAfterMs=${e.retryAfterMs}` : undefined,
        });
      }),
    );

    this.unsubs.push(
      this.breaker.onRecover((e) => {
        this.ledger.recordRateLimitEvent({
          ts: e.ts,
          kind: 'circuit-recover',
          source: 'circuit-breaker',
          seq: this.breakerSeq++,
          accountKey: this.accountKey,
        });
      }),
    );

    if (this.sentinel) {
      const onDetected = (state: any) => {
        this.ledger.recordRateLimitEvent({
          ts: this.now(),
          kind: this.classifySentinel(state),
          source: 'session-sentinel',
          seq: this.sentinelSeq++,
          accountKey: this.accountKey,
          sessionName: typeof state?.sessionName === 'string' ? state.sessionName : undefined,
          reason: typeof state?.reason === 'string' ? state.reason : undefined,
        });
      };
      this.sentinel.on('rate-limit:detected', onDetected);
      this.unsubs.push(() => this.sentinel?.off?.('rate-limit:detected', onDetected));
    }
  }

  /** Map a sentinel detection to a kind. Session-scoped server throttles are the
   *  common case; 529-overload is distinguished when the reason says so. */
  private classifySentinel(state: any): RateLimitEventKind {
    const reason = typeof state?.reason === 'string' ? state.reason.toLowerCase() : '';
    if (/529|overloaded/.test(reason)) return '529';
    if (/usage|quota|weekly|session limit/.test(reason)) return 'quota';
    return 'throttle';
  }

  stop(): void {
    for (const u of this.unsubs) { try { u(); } catch { /* ignore */ } }
    this.unsubs = [];
    this.started = false;
  }
}

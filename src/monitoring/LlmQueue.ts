/**
 * LlmQueue — Shared priority-laned LLM call queue
 *
 * Extracted from PresenceProxy (per PROMISE-BEACON-SPEC.md Phase 1) so both
 * PresenceProxy and PromiseBeacon can share a single concurrency + daily
 * spend budget.
 *
 * Two lanes with a reservation rule:
 *   - interactive (default 40% reserve): PresenceProxy tiers, delivery verify
 *   - background: PromiseBeacon heartbeats, Sentinel shadow scans
 *
 * When the interactive lane has work and the provider concurrency limit is
 * hit, the queue aborts the lowest-priority in-flight background call via
 * AbortController, freeing a slot for the interactive arrival. Aborted
 * background callers see an `LlmAbortedError` and can fall back to a
 * templated response.
 */
export type LlmLane = 'interactive' | 'background';

export class LlmAbortedError extends Error {
  constructor() {
    super('LLM call aborted by higher-priority lane');
    this.name = 'LlmAbortedError';
  }
}

export interface LlmQueueOptions {
  /** Max concurrent in-flight calls (default 3). */
  maxConcurrent?: number;
  /** Fraction of `maxDailyCents` reserved for the interactive lane. Default 0.4. */
  interactiveReservePct?: number;
  /** Daily spend cap in cents across both lanes. Default 100. */
  maxDailyCents?: number;
  /**
   * Herd-aware drain pacing (Resilient Degradation Ladder §3c). A jittered minimum gap (ms) between
   * BACKGROUND-lane dispatches so a burst of queued background calls can't re-trip a just-recovered
   * provider on recovery. Interactive-lane dispatches BYPASS pacing (latency-sensitive + preemptive).
   * Default 0 = OFF (today's greedy drain, zero behavior change for existing callers).
   */
  backgroundDispatchMinGapMs?: number;
  /** Provide `Date.now()` — injectable for tests. */
  now?: () => number;
}

export interface LlmMeteredRequest {
  component: string;
  estimatedInputTokens: number;
  maxOutputTokens: number;
  estimatedCostCents: number;
  hourly: { requests: number; perTopicRequests?: number; topic?: string };
  daily: { requests: number; inputTokens: number; outputTokens: number; costCents: number };
  run: (signal: AbortSignal, reportUsage: (usage: { inputTokens: number; outputTokens: number; costCents?: number }) => void) => Promise<string>;
}

interface InFlight {
  lane: LlmLane;
  controller: AbortController;
  reject: (err: Error) => void;
}

interface Waiter {
  lane: LlmLane;
  fn: (signal: AbortSignal) => Promise<string>;
  costCents: number;
  resolve: (v: string) => void;
  reject: (e: Error) => void;
}

export class LlmQueue {
  private maxConcurrent: number;
  private interactiveReservePct: number;
  private maxDailyCents: number;
  private backgroundDispatchMinGapMs: number;
  private now: () => number;

  private inFlight: Set<InFlight> = new Set();
  private waiters: Waiter[] = [];

  /** Wall-clock (via `now`) of the last BACKGROUND-lane dispatch — herd-pacing window anchor. */
  private lastBackgroundStartAt = 0;
  /** At most one pending paced re-drain timer; null when none scheduled. */
  private pacingTimer: ReturnType<typeof setTimeout> | null = null;

  /** Daily spend ledger: { dateKey: 'YYYY-MM-DD', cents: number, interactive: number } */
  private dailySpendCents = 0;
  private dailyInteractiveCents = 0;
  private dailyDateKey = '';
  private readonly metered = new Map<string, Array<{ at: number; topic?: string; inputTokens: number; outputTokens: number; costCents: number }>>();

  constructor(opts: LlmQueueOptions = {}) {
    this.maxConcurrent = opts.maxConcurrent ?? 3;
    this.interactiveReservePct = opts.interactiveReservePct ?? 0.4;
    this.maxDailyCents = opts.maxDailyCents ?? 100;
    this.backgroundDispatchMinGapMs = opts.backgroundDispatchMinGapMs ?? 0;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Enqueue a call.
   *
   * `fn` receives an AbortSignal — callers MUST honor it. Aborted callers
   * should throw (the queue will reject with LlmAbortedError).
   *
   * `costCents` is the caller's best estimate of the call cost. Used only
   * for the daily cap — if the cap is already exceeded the call is rejected.
   */
  async enqueue(
    lane: LlmLane,
    fn: (signal: AbortSignal) => Promise<string>,
    costCents = 0,
  ): Promise<string> {
    this.rollDateIfNeeded();

    // Daily cap check.
    if (this.dailySpendCents + costCents > this.maxDailyCents) {
      throw new Error('LLM daily spend cap exceeded');
    }
    // Per-lane reserve: interactive lane is guaranteed ≥ reservePct; background
    // lane cannot push total into the reserved portion once interactive floor
    // is unmet.
    const reservedForInteractive = Math.floor(this.maxDailyCents * this.interactiveReservePct);
    if (lane === 'background') {
      const remainingAfter = this.maxDailyCents - (this.dailySpendCents + costCents);
      if (remainingAfter < reservedForInteractive - this.dailyInteractiveCents) {
        throw new Error('LLM background lane would breach interactive reserve');
      }
    }

    return new Promise<string>((resolve, reject) => {
      this.waiters.push({ lane, fn, costCents, resolve, reject });
      this.drain();
    });
  }

  /** Atomically reserves a component budget before entering the shared background lane. */
  async enqueueMetered(request: LlmMeteredRequest): Promise<string> {
    const now = this.now();
    const rows = (this.metered.get(request.component) ?? []).filter((row) => now - row.at <= 86_400_000);
    const hourly = rows.filter((row) => now - row.at <= 3_600_000);
    if (hourly.length >= request.hourly.requests
      || (request.hourly.topic && request.hourly.perTopicRequests !== undefined
        && hourly.filter((row) => row.topic === request.hourly.topic).length >= request.hourly.perTopicRequests)
      || rows.length >= request.daily.requests
      || rows.reduce((sum, row) => sum + row.inputTokens, 0) + request.estimatedInputTokens > request.daily.inputTokens
      || rows.reduce((sum, row) => sum + row.outputTokens, 0) + request.maxOutputTokens > request.daily.outputTokens
      || rows.reduce((sum, row) => sum + row.costCents, 0) + request.estimatedCostCents > request.daily.costCents) {
      throw new Error('LLM metered component budget exhausted');
    }
    const reservation = { at: now, ...(request.hourly.topic ? { topic: request.hourly.topic } : {}),
      inputTokens: request.estimatedInputTokens, outputTokens: request.maxOutputTokens, costCents: request.estimatedCostCents };
    rows.push(reservation);
    this.metered.set(request.component, rows);
    let actual: { inputTokens: number; outputTokens: number; costCents?: number } | undefined;
    try {
      const value = await this.enqueue('background', (signal) => request.run(signal, (usage) => { actual = usage; }), request.estimatedCostCents);
      if (actual) {
        reservation.inputTokens = Math.max(0, Math.floor(actual.inputTokens));
        reservation.outputTokens = Math.max(0, Math.floor(actual.outputTokens));
        reservation.costCents = Math.max(0, actual.costCents ?? request.estimatedCostCents);
      }
      return value;
    } catch (error) {
      // Provider uncertainty retains the conservative reservation. Admission
      // failures before provider execution are also counted to prevent storms.
      throw error;
    }
  }

  getMeteredUsage(component: string): { requests: number; inputTokens: number; outputTokens: number; costCents: number } {
    const now = this.now();
    const rows = (this.metered.get(component) ?? []).filter((row) => now - row.at <= 86_400_000);
    return { requests: rows.length, inputTokens: rows.reduce((sum, row) => sum + row.inputTokens, 0),
      outputTokens: rows.reduce((sum, row) => sum + row.outputTokens, 0), costCents: rows.reduce((sum, row) => sum + row.costCents, 0) };
  }

  /**
   * Try to start as many waiters as concurrency allows. Interactive waiters
   * that cannot start because the concurrency limit is hit will trigger
   * abort() of an in-flight background call.
   */
  private drain(): void {
    // Sort waiters so interactive comes first.
    this.waiters.sort((a, b) => (a.lane === b.lane ? 0 : a.lane === 'interactive' ? -1 : 1));

    while (this.waiters.length > 0) {
      const next = this.waiters[0];

      if (this.inFlight.size < this.maxConcurrent) {
        // Herd guard (§3c): pace BACKGROUND-lane dispatches so a burst of queued calls can't re-trip
        // a just-recovered provider. Interactive bypasses (latency-sensitive + preemptive). When a
        // background dispatch is too soon after the previous one, schedule a paced re-drain instead of
        // starting now. Because interactive waiters sort ahead, a background head means no interactive
        // is waiting — so deferring it blocks nothing else. OFF when backgroundDispatchMinGapMs <= 0.
        if (next.lane === 'background' && this.backgroundDispatchMinGapMs > 0 && this.lastBackgroundStartAt > 0) {
          const since = this.now() - this.lastBackgroundStartAt;
          // Jitter the gap (full-jitter low half) so independent recoveries don't re-sync into a herd.
          const gap = Math.floor(this.backgroundDispatchMinGapMs * (0.5 + Math.random() * 0.5));
          if (since < gap) {
            this.schedulePacedDrain(gap - since);
            break;
          }
        }
        if (next.lane === 'background' && this.backgroundDispatchMinGapMs > 0) {
          this.lastBackgroundStartAt = this.now();
        }
        this.waiters.shift();
        this.start(next);
        continue;
      }

      // Full. If the waiter is interactive, try to preempt a background.
      if (next.lane === 'interactive') {
        const victim = [...this.inFlight].find(f => f.lane === 'background');
        if (victim) {
          victim.controller.abort();
          victim.reject(new LlmAbortedError());
          this.inFlight.delete(victim);
          // Loop again; next iteration starts the interactive waiter.
          continue;
        }
      }

      // Either the waiter is background and pool is full, or pool is full
      // of interactive calls. Wait for something to complete.
      break;
    }
  }

  /**
   * Schedule a single paced re-drain (§3c herd guard). Coalesces to at most one pending timer so a
   * burst of background enqueues can't stack timers. `unref`'d so it never holds the process open.
   */
  private schedulePacedDrain(delayMs: number): void {
    if (this.pacingTimer) return;
    this.pacingTimer = setTimeout(() => {
      this.pacingTimer = null;
      this.drain();
    }, Math.max(1, delayMs));
    this.pacingTimer.unref?.();
  }

  private start(w: Waiter): void {
    const controller = new AbortController();
    const inflight: InFlight = {
      lane: w.lane,
      controller,
      reject: w.reject,
    };
    this.inFlight.add(inflight);

    w.fn(controller.signal)
      .then(result => {
        if (!this.inFlight.has(inflight)) return; // aborted
        this.inFlight.delete(inflight);
        this.dailySpendCents += w.costCents;
        if (w.lane === 'interactive') this.dailyInteractiveCents += w.costCents;
        w.resolve(result);
        this.drain();
      })
      .catch(err => {
        if (!this.inFlight.has(inflight)) return; // already rejected by abort
        this.inFlight.delete(inflight);
        w.reject(err);
        this.drain();
      });
  }

  private rollDateIfNeeded(): void {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    if (today !== this.dailyDateKey) {
      this.dailyDateKey = today;
      this.dailySpendCents = 0;
      this.dailyInteractiveCents = 0;
    }
  }

  /** Test / diagnostic accessors. */
  getDailySpendCents(): number {
    this.rollDateIfNeeded();
    return this.dailySpendCents;
  }
  getInFlightCount(): number {
    return this.inFlight.size;
  }
  getWaitingCount(): number {
    return this.waiters.length;
  }
  getInFlightLanes(): LlmLane[] {
    return [...this.inFlight].map(f => f.lane);
  }
}

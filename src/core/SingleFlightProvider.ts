/**
 * SingleFlightProvider — one model call in flight at a time, owned by the
 * provider itself (job-cost-reduction §5.6.2, "The single slot is owned by a
 * provider wrapper").
 *
 * Why a wrapper and not a counter in the caller: `askReferee` races its call
 * against a timeout and returns on the timeout, but the underlying call keeps
 * running. A caller-side "one at a time" flag would be cleared on that return
 * and let a second call overlap the first. Here the slot is freed only when the
 * UNDERLYING call settles — so a provider that ignores its own timeout keeps
 * the slot — or when it is abandoned after `abandonAfterMs` (default 120 s).
 *
 * Abandoning frees the slot and opens this instance's breaker for
 * `breakerOpenMs` (default 10 min, longer than any abandoned call can run).
 * After that one test call is let through (half-open): success closes the
 * breaker, failure (an error, or another abandonment) re-opens it.
 *
 * Busy behaviour is per instance: `waitMs: 0` fails at once (the referee: the
 * floor decides); a positive `waitMs` waits up to that long for the slot (the
 * backup check: 60 s). A call refused by the slot or the breaker rejects with
 * a `SingleFlightRefusedError` and never reaches the real provider.
 */
import type { IntelligenceOptions, IntelligenceProvider } from './types.js';

export const SINGLE_FLIGHT_ABANDON_MS = 120_000;
export const SINGLE_FLIGHT_BREAKER_OPEN_MS = 10 * 60_000;

export type SingleFlightRefusal = 'busy' | 'breaker-open' | 'wait-timeout';

export class SingleFlightRefusedError extends Error {
  readonly reason: SingleFlightRefusal;
  constructor(reason: SingleFlightRefusal) {
    super(`single-flight-refused: ${reason}`);
    this.name = 'SingleFlightRefusedError';
    this.reason = reason;
  }
}

export interface SingleFlightOptions {
  /** How long a call waits for the slot when it is taken. 0 = fail at once. */
  waitMs?: number;
  abandonAfterMs?: number;
  breakerOpenMs?: number;
  now?: () => number;
  /** Timer seam for tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  log?: (msg: string) => void;
}

export interface SingleFlightStatus {
  busy: boolean;
  breaker: 'closed' | 'open' | 'half-open';
  openUntil: number | null;
  abandoned: number;
  refused: number;
}

export class SingleFlightProvider implements IntelligenceProvider {
  private readonly inner: IntelligenceProvider;
  private readonly waitMs: number;
  private readonly abandonAfterMs: number;
  private readonly breakerOpenMs: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (h: unknown) => void;
  private readonly log: (msg: string) => void;
  /** Token of the call that holds the slot; null when free. */
  private holder: symbol | null = null;
  private openUntil: number | null = null;
  /** True while the single half-open test call is outstanding. */
  private probing = false;
  private waiters: Array<() => void> = [];
  private abandonedCount = 0;
  private refusedCount = 0;

  constructor(inner: IntelligenceProvider, opts: SingleFlightOptions = {}) {
    this.inner = inner;
    this.waitMs = typeof opts.waitMs === 'number' && opts.waitMs > 0 ? opts.waitMs : 0;
    this.abandonAfterMs = typeof opts.abandonAfterMs === 'number' && opts.abandonAfterMs > 0 ? opts.abandonAfterMs : SINGLE_FLIGHT_ABANDON_MS;
    this.breakerOpenMs = typeof opts.breakerOpenMs === 'number' && opts.breakerOpenMs > 0 ? opts.breakerOpenMs : SINGLE_FLIGHT_BREAKER_OPEN_MS;
    this.now = opts.now ?? Date.now;
    this.setTimer = opts.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); (t as { unref?: () => void }).unref?.(); return t; });
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.log = opts.log ?? (() => {});
  }

  status(): SingleFlightStatus {
    const now = this.now();
    const breaker = this.openUntil === null ? 'closed' : now < this.openUntil ? 'open' : 'half-open';
    return { busy: this.holder !== null, breaker, openUntil: this.openUntil, abandoned: this.abandonedCount, refused: this.refusedCount };
  }

  private refuse(reason: SingleFlightRefusal): never {
    this.refusedCount++;
    throw new SingleFlightRefusedError(reason);
  }

  /** Takes the slot, waiting up to waitMs. Resolves with the holder token. */
  private async acquire(): Promise<symbol> {
    if (this.holder === null) return this.take();
    if (this.waitMs <= 0) this.refuse('busy');
    const deadline = this.now() + this.waitMs;
    while (this.holder !== null) {
      const left = deadline - this.now();
      if (left <= 0) this.refuse('wait-timeout');
      await new Promise<void>((resolve) => {
        let done = false;
        const wake = () => { if (done) return; done = true; this.clearTimer(h); resolve(); };
        const h = this.setTimer(wake, left);
        this.waiters.push(wake);
      });
    }
    return this.take();
  }

  private take(): symbol {
    const token = Symbol('single-flight');
    this.holder = token;
    return token;
  }

  private release(token: symbol): void {
    if (this.holder !== token) return; // already abandoned
    this.holder = null;
    const w = this.waiters.shift();
    if (w) w();
  }

  async evaluate(prompt: string, options?: IntelligenceOptions): Promise<string> {
    // Breaker: open ⇒ refuse; past its window ⇒ exactly one test call.
    let isProbe = false;
    if (this.openUntil !== null) {
      if (this.now() < this.openUntil || this.probing) this.refuse('breaker-open');
      isProbe = true;
    }
    if (isProbe) this.probing = true;
    let token: symbol;
    try {
      token = await this.acquire();
    } catch (err) {
      if (isProbe) this.probing = false;
      throw err;
    }
    let abandoned = false;
    const abandonTimer = this.setTimer(() => {
      if (this.holder !== token) return;
      abandoned = true;
      this.abandonedCount++;
      this.openUntil = this.now() + this.breakerOpenMs;
      this.probing = false;
      this.log(`[SingleFlightProvider] call unsettled after ${this.abandonAfterMs}ms — slot freed, breaker open ${this.breakerOpenMs}ms`);
      this.release(token);
    }, this.abandonAfterMs);
    try {
      const out = await this.inner.evaluate(prompt, options);
      if (isProbe && !abandoned) { this.openUntil = null; this.probing = false; }
      return out;
    } catch (err) {
      if (isProbe && !abandoned) { this.openUntil = this.now() + this.breakerOpenMs; this.probing = false; }
      throw err;
    } finally {
      this.clearTimer(abandonTimer);
      this.release(token);
    }
  }
}

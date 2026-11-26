/**
 * Serializes overlapping invocations of an async tick without dropping any.
 *
 * Contract: every caller receives the result of an evaluation that STARTED
 * AT OR AFTER its call. At most one evaluation runs at a time and at most one
 * more is queued behind it; callers that arrive while one is already queued
 * share that queued evaluation (it has not started yet, so it still satisfies
 * the contract). A failed in-flight evaluation does not reject the queued
 * callers — they get their own evaluation's outcome.
 *
 * This replaces a "skip if already ticking, return the last snapshot" guard,
 * which handed an explicit caller a stale mid-flight read (null before the
 * first durable save) whenever a background tick happened to be running.
 */
export class TickSerializer<T> {
  private inFlight: Promise<T> | null = null;
  private queued: Promise<T> | null = null;

  run(evaluate: () => Promise<T>): Promise<T> {
    if (this.queued) return this.queued;
    if (!this.inFlight) return this.start(evaluate);
    const prior = this.inFlight;
    const queued = prior.then(() => undefined, () => undefined).then(() => {
      this.queued = null;
      return this.start(evaluate);
    });
    this.queued = queued;
    return queued;
  }

  private start(evaluate: () => Promise<T>): Promise<T> {
    let current: Promise<T>;
    try {
      current = evaluate();
    } catch (error) {
      // @silent-fallback-ok — not a fallback: a synchronous throw is surfaced to the caller as the returned rejection.
      current = Promise.reject(error);
    }
    const tracked = current.finally(() => {
      if (this.inFlight === tracked) this.inFlight = null;
    });
    this.inFlight = tracked;
    return tracked;
  }
}

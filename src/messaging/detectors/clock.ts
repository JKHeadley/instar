/** Small clock seam for deterministic user-visible timing assertions. */
export interface Clock { now(): number; }

export class RealClock implements Clock {
  now(): number { return Date.now(); }
}

export class TestClock implements Clock {
  private current: number;
  constructor(startAt = 0) { this.current = startAt; }
  now(): number { return this.current; }
  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new Error('clock advance must be non-negative');
    this.current += ms;
  }
}

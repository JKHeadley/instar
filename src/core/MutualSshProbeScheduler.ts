export interface ScheduledSshDirection {
  sourceMachineId: string;
  targetMachineId: string;
  healthy: boolean;
}

export interface ProbeSweepResult {
  attempted: string[];
  peakConcurrency: number;
  elapsedMs: number;
}

/** Fair global work bucket with a 25% reserve for healthy refreshes. */
export class MutualSshProbeScheduler {
  constructor(readonly concurrency = 4, readonly freshnessMs = 300_000, readonly probeDeadlineMs = 8_000) {
    if (concurrency < 1 || concurrency > 32) throw new Error('mutual-ssh-concurrency-out-of-range');
  }

  validate(machineCount: number): void {
    const sweepMs = this.worstCaseSweepMs(machineCount);
    if (sweepMs >= this.freshnessMs) throw new Error(`mutual-ssh-capacity-invalid machines=${machineCount} sweepMs=${sweepMs} freshnessMs=${this.freshnessMs}`);
  }

  worstCaseSweepMs(machineCount: number): number {
    return Math.ceil(machineCount * (machineCount - 1) / this.concurrency) * this.probeDeadlineMs;
  }

  async sweep(directions: ScheduledSshDirection[], probe: (direction: ScheduledSshDirection) => Promise<void>): Promise<ProbeSweepResult> {
    const started = Date.now();
    const healthy = directions.filter(x => x.healthy);
    const unhealthy = directions.filter(x => !x.healthy);
    const ordered: ScheduledSshDirection[] = [];
    const reserveEvery = Math.max(1, Math.floor(this.concurrency / Math.max(1, Math.ceil(this.concurrency * 0.25))));
    while (healthy.length || unhealthy.length) {
      for (let i = 0; i < reserveEvery - 1 && unhealthy.length; i += 1) ordered.push(unhealthy.shift()!);
      if (healthy.length) ordered.push(healthy.shift()!);
      else if (unhealthy.length) ordered.push(unhealthy.shift()!);
    }
    let cursor = 0;
    let active = 0;
    let peak = 0;
    const attempted: string[] = [];
    const workers = Array.from({ length: Math.min(this.concurrency, ordered.length) }, async () => {
      while (cursor < ordered.length) {
        const item = ordered[cursor++];
        active += 1;
        peak = Math.max(peak, active);
        attempted.push(`${item.sourceMachineId}->${item.targetMachineId}`);
        try { await probe(item); } finally { active -= 1; }
      }
    });
    await Promise.all(workers);
    return { attempted, peakConcurrency: peak, elapsedMs: Date.now() - started };
  }
}

/**
 * IdleAwareCadence — a self-rescheduling timer that runs work on a SHORT interval
 * while the agent is active and a LONG interval while it is idle (no active
 * sessions). Background pollers on an idle agent are pure waste: they wake on a
 * fixed cadence and scan/capture even when there is nothing happening, which is a
 * meaningful slice of the always-on CPU floor on a multi-agent box. This primitive
 * lets a poller back off when idle and snap back to full cadence the moment work
 * resumes — the building block for both poller-cadence backoff and (later) agent
 * sleep mode. Part of the Responsible Resource Usage standard.
 *
 * Safety: `isIdle()` throwing → treated as ACTIVE (full cadence — it never backs
 * off on an ambiguous signal). `tick()` throwing → swallowed (never crashes the
 * timer loop). The idle state is re-evaluated on EVERY reschedule, so resuming
 * activity restores full cadence within at most one idle interval.
 */
export interface IdleAwareCadenceOptions {
  /** Interval (ms) while the agent is active. */
  activeMs: number;
  /** Interval (ms) while the agent is idle. Should be >= activeMs. */
  idleMs: number;
  /** True when the agent is idle (e.g. no running sessions) — back off. */
  isIdle: () => boolean;
  /** The work to run each tick. */
  tick: () => void | Promise<void>;
}

export class IdleAwareCadence {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private running = false;

  constructor(private readonly opts: IdleAwareCadenceOptions) {}

  start(): void {
    if (this.timer || this.stopped) return;
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  /** The delay (ms) the NEXT tick will wait, given the current idle state. */
  currentIntervalMs(): number {
    return this.idleSafe() ? this.opts.idleMs : this.opts.activeMs;
  }

  private idleSafe(): boolean {
    try { return this.opts.isIdle(); }
    catch { return false; } // @silent-fallback-ok — ambiguous ⇒ ACTIVE (never back off on error)
  }

  private schedule(): void {
    if (this.stopped) return;
    const delay = this.idleSafe() ? this.opts.idleMs : this.opts.activeMs;
    this.timer = setTimeout(() => { void this.run(); }, delay);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  private async run(): Promise<void> {
    if (this.stopped || this.running) { this.schedule(); return; }
    this.running = true;
    try { await this.opts.tick(); }
    catch { /* never throw out of the timer loop */ }
    finally { this.running = false; }
    this.schedule(); // re-evaluate idle state on every reschedule
  }
}

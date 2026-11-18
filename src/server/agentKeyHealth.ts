/**
 * identity-security-piece1h: an agent key the secret store did not load.
 *
 * While the configured key is a placeholder (`{ secret: true }`), every request that needs it is
 * refused (503 agent-credential-unavailable). This watcher re-reads the store with backoff
 * (1, 2, 4 … minutes, capped at 30), applies the key the moment it loads, and tells the owner only
 * after 3 failed re-reads (Self-Heal Before Notify). It stops after 24 hours of failures and says
 * so in a final notice. Bounded: one timer at a time, never more than one re-read in flight.
 */
import { isUnreadableToken } from './middleware.js';

export const KEY_REREAD_NOTIFY_AFTER = 3;
export const KEY_REREAD_MAX_DELAY_MS = 30 * 60_000;
export const KEY_REREAD_GIVE_UP_MS = 24 * 60 * 60_000;
export const KEY_REREAD_FIRST_DELAY_MS = 60_000;

/** The wait before the next re-read after `failures` failed ones: 1 minute doubling, capped at 30. */
export function nextRereadDelayMs(failures: number): number {
  return Math.min(KEY_REREAD_FIRST_DELAY_MS * 2 ** Math.max(0, failures), KEY_REREAD_MAX_DELAY_MS);
}

/** Whether re-reading stops: 24 hours after the first failure. */
export function rereadGivesUp(firstFailureAt: number, now: number): boolean {
  return now - firstFailureAt >= KEY_REREAD_GIVE_UP_MS;
}

export interface AgentKeyHealthDeps {
  /** The key the server uses right now. */
  current: () => unknown;
  /** Re-read the key through the same merge loadConfig uses (config file + secret store). May throw. */
  reload: () => unknown;
  /** Put a freshly loaded key in use. */
  apply: (key: string) => void;
  /** Tell the owner. `final` is the 24-hour give-up notice. True once raised. */
  notify: (final: boolean) => Promise<boolean>;
  /** Close the owner's notice: the key loaded. */
  resolved: () => void;
  /**
   * The re-read window, kept across restarts so a restart loop cannot reset the 24-hour give-up
   * or the backoff. Absent → kept in memory only (tests).
   */
  loadWindow?: () => { firstFailureAt: number; failures: number; gaveUp?: boolean } | null;
  saveWindow?: (window: { firstFailureAt: number; failures: number; gaveUp?: boolean } | null) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class AgentKeyHealth {
  private failures = 0;
  private firstFailureAt: number | null = null;
  private timer: unknown = null;
  private notified = false;
  private stopped = false;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly deps: AgentKeyHealthDeps) {
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; });
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  }

  /** Begin watching if the key is unreadable now. Idempotent. */
  start(): void {
    if (this.stopped || this.timer) return;
    if (!isUnreadableToken(this.deps.current())) { this.saveWindow(null); return; }
    const kept = this.loadWindow();
    if (kept) {
      // A restart continues the same window: same give-up time, same backoff step.
      this.firstFailureAt = kept.firstFailureAt;
      this.failures = kept.failures;
      if (kept.gaveUp || rereadGivesUp(kept.firstFailureAt, this.now())) { this.stopped = true; return; }
      this.schedule(nextRereadDelayMs(this.failures));
      return;
    }
    this.firstFailureAt = this.now();
    this.saveWindow({ firstFailureAt: this.firstFailureAt, failures: 0 });
    this.schedule(KEY_REREAD_FIRST_DELAY_MS);
  }

  private loadWindow(): { firstFailureAt: number; failures: number; gaveUp?: boolean } | null {
    try { return this.deps.loadWindow?.() ?? null; } catch { return null; /* @silent-fallback-ok: an unreadable window starts a new one, still bounded */ }
  }
  private saveWindow(window: { firstFailureAt: number; failures: number; gaveUp?: boolean } | null): void {
    try { this.deps.saveWindow?.(window); } catch { /* @silent-fallback-ok: the in-memory window still bounds this run */ }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }

  /** Whether the watcher is waiting for its next re-read. */
  get waiting(): boolean { return this.timer !== null; }

  private schedule(ms: number): void {
    this.timer = this.setTimer(() => { this.timer = null; void this.tick(); }, ms);
  }

  /** One re-read. Exposed for tests. */
  async tick(): Promise<void> {
    if (this.stopped) return;
    let fresh: unknown;
    try { fresh = this.deps.reload(); } catch { fresh = undefined; /* @silent-fallback-ok: counted as a failed re-read below */ }
    if (typeof fresh === 'string' && fresh) {
      this.deps.apply(fresh);
      if (this.notified) this.deps.resolved();
      this.notified = false;
      this.failures = 0;
      this.firstFailureAt = null;
      this.saveWindow(null);
      return;
    }
    this.failures += 1;
    if (rereadGivesUp(this.firstFailureAt ?? this.now(), this.now())) {
      this.saveWindow({ firstFailureAt: this.firstFailureAt ?? this.now(), failures: this.failures, gaveUp: true });
      await this.deps.notify(true);
      this.stop();
      return;
    }
    this.saveWindow({ firstFailureAt: this.firstFailureAt ?? this.now(), failures: this.failures });
    if (this.failures >= KEY_REREAD_NOTIFY_AFTER && !this.notified) {
      this.notified = await this.deps.notify(false);
    }
    this.schedule(nextRereadDelayMs(this.failures));
  }
}

/**
 * DeviceLimitSessionMover — moves live interactive Codex sessions off an account the
 * device-limit tripwire just benched on this machine (spec codex-device-limit-tripwire §4).
 *
 * It reuses the reactive swap funnel (`QuotaAwareScheduler.onQuotaPressure`, framework-safe:
 * Codex to Codex only) and the interactive login-expired brakes (`decideLoginExpiredSwap`: one
 * try per session per 10 minutes, at most 3). Moves are serialised per machine, at most one every
 * {@link DEVICE_LIMIT_MOVE_SPACING_MS}, and each re-checks just before it runs that the source
 * account is still benched, so simultaneous benches never pile every displaced session onto one
 * account in one burst. Job sessions and protected sessions are never moved.
 */
import {
  decideLoginExpiredSwap,
  INTERACTIVE_LOGIN_SWAP_COOLDOWN_MS,
  INTERACTIVE_LOGIN_SWAP_MAX_ATTEMPTS,
} from './InteractiveLoginExpiredRecovery.js';

export const DEVICE_LIMIT_MOVE_SPACING_MS = 30_000;

export interface DeviceLimitMoverSession {
  tmuxSession: string;
  name: string;
  subscriptionAccountId?: string | null;
  jobSlug?: string | null;
  protected: boolean;
}

export interface DeviceLimitSessionMoverDeps {
  listSessions: () => DeviceLimitMoverSession[];
  /** Live check of the bench predicate on the pool record. */
  isBenched: (accountId: string) => boolean;
  swap: (args: { sessionName: string; exhaustedAccountId: string; nowMs: number }) =>
    Promise<{ swapped: boolean; toAccountId?: string | null; reason?: string }>;
  enabled?: () => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  logger?: { log: (m: string) => void; warn: (m: string) => void };
}

/* @self-action-controller: device-limit-session-move */
export class DeviceLimitSessionMover {
  private readonly attempts = new Map<string, { count: number; lastAt: number }>();
  private readonly queue: Array<{ session: string; accountId: string }> = [];
  private draining = false;
  private lastMoveAt = 0;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger: { log: (m: string) => void; warn: (m: string) => void };
  readonly counters = { queued: 0, moved: 0, refused: 0, skipped: 0 };

  constructor(private readonly deps: DeviceLimitSessionMoverDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => { const t = setTimeout(r, ms); (t as { unref?: () => void }).unref?.(); }));
    this.logger = deps.logger ?? { log: () => {}, warn: () => {} };
  }

  /** Queue every live interactive session on the benched account. Resolves when the queue drains. */
  async moveOff(accountId: string): Promise<void> {
    if (this.deps.enabled && !this.deps.enabled()) return;
    for (const s of this.deps.listSessions()) {
      if (s.subscriptionAccountId !== accountId || s.jobSlug || s.protected) continue;
      if (this.queue.some((q) => q.session === s.tmuxSession)) continue;
      this.queue.push({ session: s.tmuxSession, accountId });
      this.counters.queued++;
    }
    await this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const wait = this.lastMoveAt + DEVICE_LIMIT_MOVE_SPACING_MS - this.now();
        if (wait > 0) await this.sleep(wait);
        const next = this.queue.shift()!;
        await this.moveOne(next.session, next.accountId);
      }
    } finally {
      this.draining = false;
    }
  }

  private async moveOne(session: string, accountId: string): Promise<void> {
    if (!this.deps.isBenched(accountId)) { this.counters.skipped++; return; } // released meanwhile
    const live = this.deps.listSessions().find((s) => s.tmuxSession === session);
    if (!live || live.subscriptionAccountId !== accountId) { this.counters.skipped++; return; }
    const nowMs = this.now();
    const prior = this.attempts.get(session);
    const decision = decideLoginExpiredSwap({
      attempts: prior?.count ?? 0, lastAttemptAtMs: prior?.lastAt ?? null, nowMs,
      cooldownMs: INTERACTIVE_LOGIN_SWAP_COOLDOWN_MS, maxAttempts: INTERACTIVE_LOGIN_SWAP_MAX_ATTEMPTS,
    });
    if (decision !== 'attempt') { this.counters.skipped++; return; }
    this.attempts.set(session, { count: (prior?.count ?? 0) + 1, lastAt: nowMs });
    this.lastMoveAt = nowMs;
    try {
      const r = await this.deps.swap({ sessionName: session, exhaustedAccountId: accountId, nowMs });
      if (r.swapped) {
        this.attempts.delete(session);
        this.counters.moved++;
        this.logger.log(`[DeviceLimit] ${session}: moved off benched ${accountId} → ${r.toAccountId ?? 'another account'} (conversation resumed)`);
      } else {
        this.counters.refused++;
        this.logger.warn(`[DeviceLimit] ${session}: move off benched ${accountId} refused (${r.reason ?? 'unknown'})`);
      }
    } catch (err) {
      this.counters.refused++;
      this.logger.warn(`[DeviceLimit] ${session}: move off benched ${accountId} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (this.attempts.size > 500) {
      for (const [k, v] of this.attempts) if (nowMs - v.lastAt > 24 * 60 * 60_000) this.attempts.delete(k);
    }
  }
}

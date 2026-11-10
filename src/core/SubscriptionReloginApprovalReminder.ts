/**
 * Approval reminder for sign-in repairs (CMT-1541, operator 2026-11-09).
 *
 * A repair in `approval` mode waits in state `suggested` until the operator taps
 * Repair. Its first notice is raised once, on the attention path; if that notice
 * is missed the repair can wait unseen for a day (a gearfinity3d repair on the
 * Mac Studio waited from 2026-11-08 10:30 UTC). This reminds ONCE per waiting
 * spell, after `thresholdMs`, on the same attention row as the first notice
 * (same condition key), with a direct link to the Accounts page's "Needs you"
 * section.
 *
 * No reminder is sent during the operator's night hours (the same local window the slow
 * retry's re-offers respect, default 23:00-08:00); it goes out at the first pass after.
 *
 * Signal only: it never approves, starts, or changes a repair. Delivery goes
 * through the caller's notify (the existing attention path), so Quiet-by-Default
 * holds: the row lands in the attention queue / Notifications feed, and pushes
 * only where the operator chose to push that category.
 *
 * Restart-safe without new state: the reminder text names the absolute time the
 * wait started, so a restart that re-sends it lands as an unchanged repeat on
 * the same attention row (no second push). A new waiting spell (re-offered
 * repair) has a new start time and gets its own reminder.
 */

/* @self-action-controller: relogin-approval-reminder */
import type { SubscriptionReloginEpisode, SubscriptionReloginEvent } from './SubscriptionReloginStore.js';

export const DEFAULT_APPROVAL_REMINDER_HOURS = 4;
const MIN_TICK_MS = 60_000;

export interface ApprovalReminderDue {
  episode: SubscriptionReloginEpisode;
  waitingSinceMs: number;
  /** One reminder per waiting spell: episode id + the moment the wait began. */
  key: string;
}

/** When the current wait began: the newest event INTO `suggested`, else the row's last update. */
export function waitingSinceMs(episode: SubscriptionReloginEpisode, eventsNewestFirst: SubscriptionReloginEvent[]): number | null {
  const entered = eventsNewestFirst.find((e) => e.toState === 'suggested');
  const t = Date.parse(entered?.at ?? episode.updatedAt);
  return Number.isFinite(t) ? t : null;
}

/** Approval-mode repairs that have waited at least `thresholdMs` and were not reminded this spell. */
export function dueApprovalReminders(
  episodes: SubscriptionReloginEpisode[],
  opts: { nowMs: number; thresholdMs: number; waitingSince: (ep: SubscriptionReloginEpisode) => number | null; sent: ReadonlySet<string> },
): ApprovalReminderDue[] {
  if (!(opts.thresholdMs > 0)) return [];
  const out: ApprovalReminderDue[] = [];
  for (const episode of episodes) {
    if (episode.state !== 'suggested' || episode.mode !== 'approval') continue;
    const since = opts.waitingSince(episode);
    if (since === null || opts.nowMs - since < opts.thresholdMs) continue;
    const key = `${episode.id}@${new Date(since).toISOString()}`;
    if (opts.sent.has(key)) continue;
    out.push({ episode, waitingSinceMs: since, key });
  }
  return out;
}

/** "Nov 8, 3:30 AM" in this machine's time zone — absolute, so the text never changes for one wait. */
export function waitStartWords(ms: number): string {
  return new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function approvalReminderSummary(input: {
  doorway: string; account: string | null; machine: string | null; waitingSinceMs: number; link: string;
}): string {
  const who = input.account ? ` for ${input.account}` : '';
  const where = input.machine ? ` on ${input.machine}` : '';
  return `A ${input.doorway} sign-in repair${who}${where} has been waiting for your approval since ${waitStartWords(input.waitingSinceMs)}. `
    + `Nothing happens until you approve it. Open Accounts and tap Repair: ${input.link}`;
}

export interface ApprovalReminderDeps {
  /** Episodes on THIS machine in state `suggested`. */
  listSuggested: () => SubscriptionReloginEpisode[];
  waitingSince: (ep: SubscriptionReloginEpisode) => number | null;
  /** Deliver one reminder (the existing attention path). A rejection retries next tick. */
  remind: (due: ApprovalReminderDue) => Promise<void> | void;
  thresholdMs: number;
  /** True while a reminder must not be sent (the operator's night hours); the pass waits for the next tick. */
  inQuietHours?: (nowMs: number) => boolean;
  intervalMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

export class SubscriptionReloginApprovalReminder {
  private readonly sent = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  constructor(private readonly d: ApprovalReminderDeps) {}

  /** One pass. Returns the keys reminded on this pass. */
  async tick(): Promise<string[]> {
    if (this.running) return [];
    this.running = true;
    const done: string[] = [];
    try {
      const nowMs = (this.d.now ?? Date.now)();
      if (this.d.inQuietHours?.(nowMs)) return done;
      let episodes: SubscriptionReloginEpisode[] = [];
      try { episodes = this.d.listSuggested(); }
      catch { return done; /* @silent-fallback-ok: an unreadable store reminds nothing this pass; the next pass reads again */ }
      for (const due of dueApprovalReminders(episodes, { nowMs, thresholdMs: this.d.thresholdMs, waitingSince: this.d.waitingSince, sent: this.sent })) {
        try {
          await this.d.remind(due);
          this.sent.add(due.key);
          done.push(due.key);
        } catch (err) {
          this.d.log?.(`[relogin-reminder] delivery failed for ${due.episode.id}; retrying next pass: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      // Forget spells that ended (approved, cancelled, re-offered) so the set stays bounded.
      const live = new Set(episodes.map((e) => e.id));
      for (const key of this.sent) if (!live.has(key.slice(0, key.indexOf('@')))) this.sent.delete(key);
      return done;
    } finally {
      this.running = false;
    }
  }

  start(): void {
    if (this.timer || !(this.d.thresholdMs > 0)) return;
    const every = Math.max(MIN_TICK_MS, this.d.intervalMs ?? 15 * 60_000);
    this.timer = setInterval(() => { void this.tick(); }, every);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

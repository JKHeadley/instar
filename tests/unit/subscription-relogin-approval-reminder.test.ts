import { describe, expect, it, vi } from 'vitest';
import {
  SubscriptionReloginApprovalReminder, dueApprovalReminders, waitingSinceMs, approvalReminderSummary, DEFAULT_APPROVAL_REMINDER_HOURS,
} from '../../src/core/SubscriptionReloginApprovalReminder.js';
import type { SubscriptionReloginEpisode, SubscriptionReloginEvent } from '../../src/core/SubscriptionReloginStore.js';

// CMT-1541: a repair waiting for the operator's approval is reminded once after a few hours. Never approves.
const H = 3_600_000;
const NOW = Date.parse('2026-11-09T12:00:00Z');
const ep = (over: Partial<SubscriptionReloginEpisode> = {}): SubscriptionReloginEpisode => ({
  id: 'e1', sourceEpisodeId: 1, accountId: 'acct', machineId: 'studio', mode: 'approval', state: 'suggested',
  inputDigest: 'd', profileId: 'p', framework: 'claude-code', provider: 'anthropic', attemptCount: 0, reissueCount: 0,
  approvedAt: null, approvalExpiresAt: null, startedAt: null, finishedAt: null, nextAttemptAt: null, failureClass: null,
  version: 1, createdAt: new Date(NOW - 26 * H).toISOString(), updatedAt: new Date(NOW - 26 * H).toISOString(),
  loginMethod: null, slowRetryCount: 0, loginCreatedAt: null, slowRetryHeld: false, ...over,
});
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

describe('approval reminder: who is due', () => {
  const since = (e: SubscriptionReloginEpisode) => Date.parse(e.updatedAt);
  it('defaults to 4 hours', () => expect(DEFAULT_APPROVAL_REMINDER_HOURS).toBe(4));
  it('an approval-mode repair waiting past the threshold is due; one just under is not', () => {
    const due = dueApprovalReminders([ep({ id: 'old' }), ep({ id: 'new', updatedAt: at(4 * H - 60_000) })], { nowMs: NOW, thresholdMs: 4 * H, waitingSince: since, sent: new Set() });
    expect(due.map((d) => d.episode.id)).toEqual(['old']);
  });
  it('observe-mode, approved, and already-reminded spells are not due; threshold 0 is off', () => {
    const e = ep();
    const key = `e1@${new Date(since(e)).toISOString()}`;
    expect(dueApprovalReminders([ep({ mode: 'observe' }), ep({ state: 'approved' })], { nowMs: NOW, thresholdMs: H, waitingSince: since, sent: new Set() })).toEqual([]);
    expect(dueApprovalReminders([e], { nowMs: NOW, thresholdMs: H, waitingSince: since, sent: new Set([key]) })).toEqual([]);
    expect(dueApprovalReminders([e], { nowMs: NOW, thresholdMs: 0, waitingSince: since, sent: new Set() })).toEqual([]);
  });
  it('the wait starts at the newest move into suggested, not at creation', () => {
    const events = [
      { id: 3, episodeId: 'e1', at: at(H), fromState: 'failed', toState: 'suggested', eventClass: 'slow-retry-suggested', attempt: 0 },
      { id: 1, episodeId: 'e1', at: at(26 * H), fromState: null, toState: 'suggested', eventClass: 'candidate-admitted', attempt: 0 },
    ] as SubscriptionReloginEvent[];
    expect(waitingSinceMs(ep(), events)).toBe(NOW - H);
    expect(waitingSinceMs(ep(), [])).toBe(NOW - 26 * H);
  });
});

describe('approval reminder: delivery', () => {
  it('reminds once per waiting spell, retries a failed delivery, and skips night hours', async () => {
    const remind = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue(undefined);
    let quiet = true;
    const r = new SubscriptionReloginApprovalReminder({
      listSuggested: () => [ep()], waitingSince: (e) => Date.parse(e.updatedAt), remind, thresholdMs: 4 * H,
      inQuietHours: () => quiet, now: () => NOW,
    });
    expect(await r.tick()).toEqual([]);
    expect(remind).not.toHaveBeenCalled();
    quiet = false;
    expect(await r.tick()).toEqual([]); // delivery failed
    expect((await r.tick()).length).toBe(1);
    expect(await r.tick()).toEqual([]);
    expect(remind).toHaveBeenCalledTimes(2);
  });

  it('an unreadable store reminds nothing and does not throw', async () => {
    const r = new SubscriptionReloginApprovalReminder({ listSuggested: () => { throw new Error('locked'); }, waitingSince: () => 0, remind: vi.fn(), thresholdMs: H, now: () => NOW });
    await expect(r.tick()).resolves.toEqual([]);
  });

  it('the text names the wait start, the account, and the direct link; it never says it approved anything', () => {
    const text = approvalReminderSummary({ doorway: 'Claude Code', account: 'gearfinity3d@example.com', machine: null, waitingSinceMs: NOW - 26 * H,
      link: 'https://x.example/dashboard/console/#/capacity/accounts?s=needs' });
    expect(text).toMatch(/^A Claude Code sign-in repair for gearfinity3d@example\.com has been waiting for your approval since /);
    expect(text).toMatch(/Nothing happens until you approve it/);
    expect(text).toContain('#/capacity/accounts?s=needs');
    // Stable for one wait (restart-safe): the same inputs give the same words.
    expect(approvalReminderSummary({ doorway: 'Claude Code', account: 'gearfinity3d@example.com', machine: null, waitingSinceMs: NOW - 26 * H,
      link: 'https://x.example/dashboard/console/#/capacity/accounts?s=needs' })).toBe(text);
  });
});

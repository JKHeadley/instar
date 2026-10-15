/**
 * Slow automatic retry of a failed sign-in repair (spec
 * relogin-unattended-agent-session-and-slow-retry), unit tier: the store's durable
 * schedule/retry primitives and the service's decision boundary on both sides
 * (eligible failures retry; refusals, cancels, closed incidents and spent caps never do).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { SubscriptionReloginOrchestrator } from '../../src/core/SubscriptionReloginOrchestrator.js';
import { DEFAULT_SLOW_RETRY, SubscriptionReloginService, outsideQuietHours } from '../../src/core/SubscriptionReloginService.js';
import { countBackupCodes, isOwnLeftoverLogin, unattendedBackupCodeFloor } from '../../src/core/SubscriptionReloginRuntime.js';
import {
  isSlowRetryEligible,
  SubscriptionReloginStore,
  type SubscriptionReloginFailureClass,
} from '../../src/core/SubscriptionReloginStore.js';

const HOUR = 60 * 60_000;
const DIGEST = `sha256:${'a'.repeat(64)}`;
const NEW_DIGEST = `sha256:${'b'.repeat(64)}`;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'relogin-slow-retry.test cleanup' });
});

function harness(opts: { mode?: 'approval' | 'unattended'; failure?: SubscriptionReloginFailureClass;
  terminal?: 'failed' | 'refused' | 'cancelled'; incidentOpen?: boolean; admissible?: boolean;
  slowRetry?: { enabled?: boolean; delaysMs?: unknown; maxRetries?: number; quietHours?: { startHour: number; endHour: number } | null };
  startAt?: number } = {}) {
  // Noon local time, so the default quiet window (23:00–08:00 local) never interferes unless a test wants it.
  const start = new Date(2026, 9, 14, 12, 0, 0, 0).getTime();
  let now = opts.startAt ?? start;
  const clock = { advance: (ms: number) => { now += ms; }, now: () => now };
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-slow-retry-')); dirs.push(stateDir);
  let n = 0;
  const store = new SubscriptionReloginStore({ stateDir, now: () => now, idFactory: () => (n++ === 0 ? 'repair-1' : `repair-${n}`) });
  let ep = store.suggest({ sourceEpisodeId: 7, accountId: 'acct-1', machineId: 'machine-1', mode: opts.mode ?? 'unattended',
    inputDigest: DIGEST, profileId: 'profile-1', framework: 'claude-code', provider: 'anthropic' });
  ep = store.approve(ep.id, { inputDigest: DIGEST });
  ep = store.transition(ep.id, { expectedVersion: ep.version, to: 'cli-starting', eventClass: 'cli-starting', incrementAttempt: true });
  const terminal = opts.terminal ?? 'failed';
  if (terminal === 'cancelled') ep = store.cancel(ep.id);
  else {
    if (terminal === 'refused') {
      ep = store.transition(ep.id, { expectedVersion: ep.version, to: 'artifact-ready', eventClass: 'artifact-ready' });
      ep = store.transition(ep.id, { expectedVersion: ep.version, to: 'browser-driving', eventClass: 'browser-drive-started' });
    }
    ep = store.transition(ep.id, { expectedVersion: ep.version, to: terminal, eventClass: 'test-terminal',
      failureClass: opts.failure ?? 'attempt-budget-exhausted' });
  }
  let incidentOpen = opts.incidentOpen ?? true;
  const revalidate = vi.fn(async () => (opts.admissible ?? true)
    ? { admissible: true as const, inputDigest: NEW_DIGEST, mode: opts.mode ?? 'unattended' }
    : { admissible: false as const, reason: 'account-not-needs-reauth' });
  const onTerminal = vi.fn(async () => undefined);
  const orchestrator = { tick: vi.fn(async () => ({ outcome: 'waiting' })) } as unknown as SubscriptionReloginOrchestrator;
  const service = new SubscriptionReloginService({ store, orchestrator, scanCandidates: async () => [], revalidate,
    sourceIncidentOpen: () => incidentOpen, onTerminal, now: () => now, slowRetry: opts.slowRetry as never });
  return { store, service, revalidate, orchestrator, onTerminal, clock, id: ep.id,
    closeIncident: () => { incidentOpen = false; } };
}

describe('slow-retry eligibility', () => {
  it('a budget/transient failure is eligible; safety failures, refusals and cancels are not', () => {
    expect(isSlowRetryEligible({ state: 'failed', failureClass: 'attempt-budget-exhausted' })).toBe(true);
    expect(isSlowRetryEligible({ state: 'failed', failureClass: 'agent-sign-in-unfinished' })).toBe(true);
    expect(isSlowRetryEligible({ state: 'failed', failureClass: 'repair-time-budget-exhausted' })).toBe(true);
    for (const cls of ['authority-degraded', 'provider-rejected', 'other', 'no-healthy-seat'] as const)
      expect(isSlowRetryEligible({ state: 'failed', failureClass: cls })).toBe(false); // explicit allowlist
    expect(isSlowRetryEligible({ state: 'failed', failureClass: 'attempt-budget-exhausted', slowRetryHeld: true })).toBe(false);
    for (const cls of ['wrong-identity', 'unexpected-origin', 'captcha', 'phone-confirmation', 'permission-expansion',
      'vault-reference-missing', 'passkey-refused'] as const)
      expect(isSlowRetryEligible({ state: 'failed', failureClass: cls })).toBe(false);
    expect(isSlowRetryEligible({ state: 'refused', failureClass: 'unexpected-origin' })).toBe(false);
    expect(isSlowRetryEligible({ state: 'cancelled', failureClass: 'cancelled-by-operator' })).toBe(false);
    expect(isSlowRetryEligible({ state: 'succeeded', failureClass: null })).toBe(false);
  });
});

describe('SubscriptionReloginStore slow-retry primitives', () => {
  it('slowRetry(unattended) → approved with fresh budgets, new digest, count+1 and an audit event', () => {
    const h = harness();
    const ep = h.store.get(h.id)!;
    const retried = h.store.slowRetry(h.id, { expectedVersion: ep.version, inputDigest: NEW_DIGEST, mode: 'unattended', maxRetries: 3 });
    expect(retried).toMatchObject({ state: 'approved', mode: 'unattended', attemptCount: 0, reissueCount: 0, slowRetryCount: 1,
      inputDigest: NEW_DIGEST, failureClass: null, startedAt: null, finishedAt: null, nextAttemptAt: null });
    expect(retried.approvalExpiresAt).not.toBeNull();
    expect(h.store.listEvents(h.id)[0]).toMatchObject({ eventClass: 'slow-retry-approved', fromState: 'failed', toState: 'approved' });
    h.store.close();
  });

  it('slowRetry(approval) → suggested, re-offered with a fresh notice keyed by the retry number', () => {
    const h = harness({ mode: 'approval' });
    // Drain the first run's notices so only the retry's notice is pending.
    for (const n of h.store.claimNotifications(20)) h.store.completeNotification(n.id);
    const ep = h.store.get(h.id)!;
    const retried = h.store.slowRetry(h.id, { expectedVersion: ep.version, inputDigest: NEW_DIGEST, mode: 'approval', maxRetries: 3 });
    expect(retried).toMatchObject({ state: 'suggested', approvedAt: null, approvalExpiresAt: null, slowRetryCount: 1 });
    const notices = h.store.claimNotifications(20);
    expect(notices.map((n) => [n.kind, n.deliveryKey])).toEqual([['suggested', 'subscription-relogin:repair-1:suggested:0.r1']]);
    h.store.close();
  });

  it('refuses past the cap, on a non-eligible row, and on a stale version', () => {
    const h = harness();
    let ep = h.store.get(h.id)!;
    expect(() => h.store.slowRetry(h.id, { expectedVersion: ep.version, inputDigest: NEW_DIGEST, mode: 'unattended', maxRetries: 0 }))
      .toThrow('slow-retry-budget-exhausted');
    expect(() => h.store.slowRetry(h.id, { expectedVersion: ep.version - 1, inputDigest: NEW_DIGEST, mode: 'unattended', maxRetries: 3 }))
      .toThrow('episode-version-conflict');
    h.store.close();
    const refused = harness({ terminal: 'refused', failure: 'unexpected-origin' });
    ep = refused.store.get(refused.id)!;
    expect(() => refused.store.slowRetry(refused.id, { expectedVersion: ep.version, inputDigest: NEW_DIGEST, mode: 'unattended', maxRetries: 3 }))
      .toThrow('episode-not-slow-retryable');
    expect(() => refused.store.scheduleSlowRetry(refused.id, ep.version, new Date().toISOString())).toThrow('episode-not-slow-retryable');
    refused.store.close();
  });

  it('a FAILED row is never re-admitted on changed inputs; an operator retry then re-offers it on the current inputs', async () => {
    const h = harness();
    const base = { sourceEpisodeId: 7, accountId: 'acct-1', machineId: 'machine-1', mode: 'unattended' as const,
      profileId: 'profile-1', framework: 'claude-code', provider: 'anthropic' };
    expect(h.store.suggest({ ...base, inputDigest: NEW_DIGEST })).toMatchObject({ state: 'failed', slowRetryCount: 0 });
    // revalidate answers NEW_DIGEST ≠ the stored DIGEST: the operator's retry re-offers instead of refusing.
    const reoffered = await h.service.retry(h.id);
    expect(reoffered).toMatchObject({ state: 'suggested', mode: 'approval', inputDigest: NEW_DIGEST, slowRetryCount: 0 });
    expect(h.store.listEvents(h.id)[0]).toMatchObject({ eventClass: 'operator-retry-readmitted' });
    expect(h.orchestrator.tick).not.toHaveBeenCalled();
    h.store.close();
  });

  it('an operator cancel keeps later re-admissions approval-only until the operator approves again', () => {
    const h = harness({ terminal: 'cancelled' });
    const base = { sourceEpisodeId: 7, accountId: 'acct-1', machineId: 'machine-1', profileId: 'profile-1', framework: 'claude-code', provider: 'anthropic' };
    expect(h.store.suggest({ ...base, mode: 'unattended', inputDigest: NEW_DIGEST })).toMatchObject({ state: 'suggested', mode: 'approval' });
    expect(h.store.suggest({ ...base, mode: 'unattended', inputDigest: `sha256:${'c'.repeat(64)}` })).toMatchObject({ state: 'suggested', mode: 'approval' });
    h.store.close();
  });

  it('an operator cancel during the approval\'s revalidation wins: the row is never re-admitted into a tap-free run', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-cancel-race-')); dirs.push(stateDir);
    const store = new SubscriptionReloginStore({ stateDir, idFactory: () => 'repair-race' });
    const ep = store.suggest({ sourceEpisodeId: 3, accountId: 'acct-1', machineId: 'machine-1', mode: 'unattended',
      inputDigest: DIGEST, profileId: 'profile-1', framework: 'claude-code', provider: 'anthropic' });
    const orchestrator = { tick: vi.fn(async () => ({ outcome: 'waiting' })) } as unknown as SubscriptionReloginOrchestrator;
    const service = new SubscriptionReloginService({ store, orchestrator, scanCandidates: async () => [],
      revalidate: async () => { store.cancel(ep.id); return { admissible: true as const, inputDigest: NEW_DIGEST, mode: 'unattended' as const }; } });
    await expect(service.approve(ep.id)).rejects.toThrow('approval-input-digest-mismatch');
    expect(store.get(ep.id)).toMatchObject({ state: 'cancelled' });
    expect(orchestrator.tick).not.toHaveBeenCalled();
    store.close();
  });

  it('Try repair again on changed inputs is refused when the fresh mode is observe (dry-run): no transition', async () => {
    const h = harness({ mode: 'approval' });
    h.revalidate.mockImplementation(async () => ({ admissible: true as const, inputDigest: NEW_DIGEST, mode: 'observe' as const }) as never);
    const before = h.store.get(h.id)!;
    await expect(h.service.retry(h.id)).rejects.toThrow('retry-revalidation-refused:observe-only');
    expect(h.store.get(h.id)).toMatchObject({ state: 'failed', version: before.version });
    h.store.close();
  });

  it('a slow retry writes the fresh profile and login method with the fresh digest', () => {
    const h = harness();
    const ep = h.store.get(h.id)!;
    const retried = h.store.slowRetry(h.id, { expectedVersion: ep.version, inputDigest: NEW_DIGEST, mode: 'unattended', maxRetries: 3,
      profileId: 'profile-2', loginMethod: 'password+totp' });
    expect(retried).toMatchObject({ profileId: 'profile-2', loginMethod: 'password+totp' });
    h.store.close();
  });

  it('a stale terminal notice for a repair that is running again is never sent', async () => {
    const h = harness();
    // The failure's terminal notice is queued; a retry starts before it is delivered.
    let ep = h.store.get(h.id)!;
    h.store.retryFailed(h.id, { inputDigest: ep.inputDigest });
    const claimed = h.store.claimNotifications(20); // nothing pending: retryFailed cleared it
    expect(claimed).toEqual([]);
    ep = h.store.get(h.id)!;
    expect(ep.state).toBe('approved');
    await h.service.tick();
    expect(h.onTerminal).not.toHaveBeenCalled();
    h.store.close();
  });

  it('an operator-cancelled repair re-admitted on changed inputs is only ever re-offered, never auto-run', async () => {
    const h = harness({ terminal: 'cancelled' });
    const candidate = { sourceEpisodeId: 7, accountId: 'acct-1', machineId: 'machine-1', mode: 'unattended' as const,
      inputDigest: NEW_DIGEST, profileId: 'profile-1', framework: 'claude-code', provider: 'anthropic' };
    const service = new SubscriptionReloginService({ store: h.store, orchestrator: h.orchestrator,
      scanCandidates: async () => [candidate], revalidate: h.revalidate, now: () => h.clock.now() });
    await service.tick();
    await service.tick();
    expect(h.store.get(h.id)).toMatchObject({ state: 'suggested', mode: 'approval' });
    expect(h.orchestrator.tick).not.toHaveBeenCalled();
    h.store.close();
  });

  it('helper-reported hard lines since the last success are counted as evidence', () => {
    const h = harness();
    let ep = h.store.suggest({ sourceEpisodeId: 9, accountId: 'acct-1', machineId: 'machine-1', mode: 'unattended',
      inputDigest: DIGEST, profileId: 'profile-1', framework: 'claude-code', provider: 'anthropic' });
    ep = h.store.approve(ep.id, { inputDigest: DIGEST });
    ep = h.store.transition(ep.id, { expectedVersion: ep.version, to: 'cli-starting', eventClass: 'cli-starting', incrementAttempt: true });
    ep = h.store.transition(ep.id, { expectedVersion: ep.version, to: 'waiting-operator-only', eventClass: 'operator-only-challenge', failureClass: 'agent-hard-line', reason: 'agent-hard-line-wrong-account' });
    const evidence = h.store.getUnattendedEvidence('acct-1', 'machine-1', 'anthropic', 'claude-code');
    expect(evidence).toMatchObject({ helperHardLines: 1, identityMismatches: 0, unexpectedOrigins: 0 });
    expect(h.store.isBreakerOpen('acct-1', 'anthropic')).toBe(false); // an unverified claim is not breaker evidence
    // A sign-in verified by hand (the cell found healthy) clears the hold.
    h.store.cancel(ep.id);
    const other = h.store.suggest({ sourceEpisodeId: 10, accountId: 'acct-1', machineId: 'machine-1', mode: 'approval',
      inputDigest: DIGEST, profileId: 'profile-1', framework: 'claude-code', provider: 'anthropic' });
    h.clock.advance(60_000);
    h.store.resolveElsewhere(other.id);
    expect(h.store.getUnattendedEvidence('acct-1', 'machine-1', 'anthropic', 'claude-code').helperHardLines).toBe(0);
    h.store.close();
  });

  it('the slow-retry count is durable across a store reopen (restart cannot refill the cap)', () => {
    const h = harness();
    const ep = h.store.get(h.id)!;
    h.store.slowRetry(h.id, { expectedVersion: ep.version, inputDigest: NEW_DIGEST, mode: 'unattended', maxRetries: 3 });
    const dir = path.dirname(path.dirname(path.dirname(h.store.dbPath)));
    h.store.close();
    const reopened = new SubscriptionReloginStore({ stateDir: dir });
    expect(reopened.get(h.id)!.slowRetryCount).toBe(1);
    reopened.close();
  });
});

describe('SubscriptionReloginService slow retry', () => {
  it('first schedules (visible), waits, then retries once due — unattended starts a run with no tap', async () => {
    const h = harness();
    const finishedAt = Date.parse(h.store.get(h.id)!.finishedAt!);
    await h.service.tick();
    expect(Date.parse(h.store.get(h.id)!.nextAttemptAt!)).toBe(finishedAt + DEFAULT_SLOW_RETRY.delaysMs[0]);
    expect(h.revalidate).not.toHaveBeenCalled();
    h.clock.advance(5 * HOUR);
    await h.service.tick();
    expect(h.store.get(h.id)!.state).toBe('failed');
    h.clock.advance(1 * HOUR);
    await h.service.tick();
    expect(h.revalidate).toHaveBeenCalledOnce();
    expect(h.store.get(h.id)).toMatchObject({ state: 'approved', slowRetryCount: 1 });
    await vi.waitFor(() => expect(h.orchestrator.tick).toHaveBeenCalled());
    h.store.close();
  });

  it('later retries wait the longer delay', async () => {
    const h = harness();
    let ep = h.store.get(h.id)!;
    ep = h.store.slowRetry(h.id, { expectedVersion: ep.version, inputDigest: NEW_DIGEST, mode: 'unattended', maxRetries: 3 });
    ep = h.store.transition(ep.id, { expectedVersion: ep.version, to: 'failed', eventClass: 'test-terminal', failureClass: 'attempt-budget-exhausted' });
    await h.service.tick();
    expect(Date.parse(h.store.get(h.id)!.nextAttemptAt!) - Date.parse(ep.finishedAt!)).toBe(24 * HOUR);
    h.store.close();
  });

  for (const [label, opts] of [
    ['a refused (safety) episode', { terminal: 'refused', failure: 'unexpected-origin' }],
    ['an operator-cancelled episode', { terminal: 'cancelled' }],
    ['a failed episode with a security failure class', { failure: 'wrong-identity' }],
  ] as const) {
    it(`never touches ${label}`, async () => {
      const h = harness(opts as never);
      const before = h.store.get(h.id)!;
      for (let i = 0; i < 3; i++) { await h.service.tick(); h.clock.advance(48 * HOUR); }
      expect(h.store.get(h.id)).toMatchObject({ state: before.state, version: before.version, nextAttemptAt: null, slowRetryCount: 0 });
      expect(h.revalidate).not.toHaveBeenCalled();
      h.store.close();
    });
  }

  it('a closed source incident clears a scheduled retry and never retries', async () => {
    const h = harness();
    await h.service.tick();
    expect(h.store.get(h.id)!.nextAttemptAt).not.toBeNull();
    h.closeIncident();
    h.clock.advance(7 * HOUR);
    await h.service.tick();
    expect(h.store.get(h.id)).toMatchObject({ state: 'failed', nextAttemptAt: null, slowRetryCount: 0 });
    expect(h.revalidate).not.toHaveBeenCalled();
    h.store.close();
  });

  it('a refusal at revalidation pushes the next check to the longest delay, with the reason (no tight loop)', async () => {
    const h = harness({ admissible: false });
    await h.service.tick();
    h.clock.advance(7 * HOUR);
    await h.service.tick();
    expect(h.revalidate).toHaveBeenCalledOnce();
    const ep = h.store.get(h.id)!;
    expect(ep).toMatchObject({ state: 'failed', slowRetryCount: 0 });
    expect(Date.parse(ep.nextAttemptAt!)).toBe(h.clock.now() + Math.max(...DEFAULT_SLOW_RETRY.delaysMs));
    expect(h.store.listEvents(h.id)[0]).toMatchObject({ eventClass: 'slow-retry-scheduled', reason: 'relogin-postponed-account-not-needs-reauth' });
    await h.service.tick();
    expect(h.revalidate).toHaveBeenCalledOnce();
    h.store.close();
  });

  it('a long-failed row falls due one delay after it is first seen, not at once', async () => {
    const h = harness();
    h.clock.advance(30 * 24 * HOUR); // the failure is a month old when the upgrade lands
    await h.service.tick();
    const due = Date.parse(h.store.get(h.id)!.nextAttemptAt!) - h.clock.now();
    expect(due).toBeGreaterThanOrEqual(DEFAULT_SLOW_RETRY.delaysMs[0]); // one delay after first seen…
    expect(due).toBeLessThan(DEFAULT_SLOW_RETRY.delaysMs[0] + HOUR); // …plus a stable per-cell offset under an hour
    h.store.close();
  });

  it('an approval re-offer never goes out in the quiet window; it waits for the end of it', async () => {
    const h = harness({ mode: 'approval', startAt: new Date(2026, 9, 14, 17, 0, 0, 0).getTime() }); // due 23:00 local
    await h.service.tick();
    h.clock.advance(6 * HOUR + 60_000);
    await h.service.tick();
    const ep = h.store.get(h.id)!;
    expect(ep.state).toBe('failed');
    expect(new Date(ep.nextAttemptAt!).getHours()).toBe(DEFAULT_SLOW_RETRY.quietHours.endHour);
    expect(h.store.listEvents(h.id)[0]).toMatchObject({ reason: 'relogin-postponed-quiet-hours' });
    h.clock.advance(Date.parse(ep.nextAttemptAt!) - h.clock.now() + 1_000);
    await h.service.tick();
    expect(h.store.get(h.id)).toMatchObject({ state: 'suggested', slowRetryCount: 1 });
    h.store.close();
  });

  it('outsideQuietHours: inside the window → its end; outside → unchanged; null disables', () => {
    const q = { startHour: 23, endHour: 8 };
    const late = new Date(2026, 9, 14, 23, 30).getTime();
    const early = new Date(2026, 9, 15, 3, 0).getTime();
    const day = new Date(2026, 9, 15, 12, 0).getTime();
    expect(outsideQuietHours(late, q)).toBe(new Date(2026, 9, 15, 8, 0).getTime());
    expect(outsideQuietHours(early, q)).toBe(new Date(2026, 9, 15, 8, 0).getTime());
    expect(outsideQuietHours(day, q)).toBe(day);
    expect(outsideQuietHours(late, null)).toBe(late);
  });

  it('holds the failure notice while a retry will follow; delivers it once the retries are spent', async () => {
    const h = harness({ slowRetry: { maxRetries: 1 } });
    await h.service.tick();
    expect(h.onTerminal).not.toHaveBeenCalled(); // first failure: a retry follows
    h.clock.advance(7 * HOUR);
    await h.service.tick();
    let ep = h.store.get(h.id)!;
    expect(ep).toMatchObject({ state: 'approved', slowRetryCount: 1 });
    ep = h.store.transition(ep.id, { expectedVersion: ep.version, to: 'failed', eventClass: 'test-terminal', failureClass: 'attempt-budget-exhausted' });
    await h.service.tick();
    expect(h.onTerminal).toHaveBeenCalledOnce(); // budget spent: the operator hears the final outcome
    h.store.close();
  });

  it('a held failure notice is delivered once its hold window passes, even if the retry keeps being deferred', async () => {
    const h = harness({ admissible: false });
    await h.service.tick();
    expect(h.onTerminal).not.toHaveBeenCalled();
    h.clock.advance(DEFAULT_SLOW_RETRY.delaysMs[0] + 2 * HOUR); // past failure + delay + 1 h; admission keeps refusing
    await h.service.tick();
    await h.service.tick();
    expect(h.onTerminal).toHaveBeenCalledOnce();
    h.store.close();
  });

  it('a run that hit an operator-only challenge is never slow-retried, even after a resume clears its class', async () => {
    const h = harness();
    // A fresh run (re-offer) that stops at a CAPTCHA, is resumed by the operator, then times out.
    let ep = h.store.get(h.id)!;
    ep = h.store.slowRetry(h.id, { expectedVersion: ep.version, inputDigest: NEW_DIGEST, mode: 'approval', maxRetries: 3 });
    ep = h.store.approve(ep.id, { inputDigest: NEW_DIGEST });
    ep = h.store.transition(ep.id, { expectedVersion: ep.version, to: 'cli-starting', eventClass: 'cli-starting', incrementAttempt: true });
    ep = h.store.transition(ep.id, { expectedVersion: ep.version, to: 'waiting-operator-only', eventClass: 'operator-only-challenge', failureClass: 'captcha' });
    ep = h.store.approve(ep.id, { inputDigest: NEW_DIGEST }); // operator resume clears the class
    ep = h.store.transition(ep.id, { expectedVersion: ep.version, to: 'failed', eventClass: 'repair-time-budget-exhausted', failureClass: 'repair-time-budget-exhausted' });
    expect(isSlowRetryEligible(ep)).toBe(true); // the row alone looks retryable…
    expect(h.store.challengedSinceAdmission(ep.id)).toBe(true); // …the events say otherwise
    await h.service.tick();
    h.clock.advance(30 * HOUR);
    await h.service.tick();
    expect(h.store.get(h.id)).toMatchObject({ state: 'failed', nextAttemptAt: null, slowRetryCount: 1 });
    expect(() => h.store.slowRetry(h.id, { expectedVersion: h.store.get(h.id)!.version, inputDigest: NEW_DIGEST, mode: 'unattended', maxRetries: 3 }))
      .toThrow('episode-not-slow-retryable');
    expect(h.onTerminal).toHaveBeenCalled(); // no retry follows, so the outcome is delivered
    h.store.close();
  });

  it('the account breaker counts failed RUNS (a reused row\'s retries count; schedule/hold events do not)', async () => {
    const h = harness({ slowRetry: { delaysMs: [60_000] } }); // 1-minute delay so three runs fit in 24 h
    for (let i = 0; i < 2; i++) {
      await h.service.tick(); // schedule (an event on the failed row — must not count)
      h.clock.advance(2 * 60_000);
      await h.service.tick(); // retry starts
      let ep = h.store.get(h.id)!;
      expect(ep.state).toBe('approved');
      ep = h.store.transition(ep.id, { expectedVersion: ep.version, to: 'failed', eventClass: 'test-terminal', failureClass: 'attempt-budget-exhausted' });
    }
    expect(h.store.isBreakerOpen('acct-1', 'anthropic')).toBe(true); // 3 failed runs on one row
    h.store.close();
    const one = harness();
    await one.service.tick();
    one.store.cancel(one.id);
    expect(one.store.isBreakerOpen('acct-1', 'anthropic')).toBe(false); // 1 run + schedule + hold events
    one.store.close();
  });

  it('a run that asked for a phone tap and then did not finish is never slow-retried', async () => {
    const h = harness();
    let ep = h.store.get(h.id)!;
    ep = h.store.slowRetry(h.id, { expectedVersion: ep.version, inputDigest: NEW_DIGEST, mode: 'unattended', maxRetries: 3 });
    ep = h.store.transition(ep.id, { expectedVersion: ep.version, to: 'cli-starting', eventClass: 'cli-starting', incrementAttempt: true });
    h.store.enqueuePhoneTap(ep.id);
    ep = h.store.get(ep.id)!;
    ep = h.store.transition(ep.id, { expectedVersion: ep.version, to: 'failed', eventClass: 'agent-sign-in-unfinished', failureClass: 'agent-sign-in-unfinished' });
    expect(h.store.challengedSinceAdmission(ep.id)).toBe(true);
    await h.service.tick();
    expect(h.store.get(h.id)!.nextAttemptAt).toBeNull();
    h.store.close();
  });

  it('an operator re-offer gets its own notice key (never de-duplicated against the first suggestion)', async () => {
    const h = harness({ mode: 'approval' });
    for (const n of h.store.claimNotifications(20)) h.store.completeNotification(n.id);
    await h.service.retry(h.id); // revalidate answers a new digest ⇒ operator re-offer
    expect(h.store.claimNotifications(20).map((n) => n.deliveryKey)).toEqual(['subscription-relogin:repair-1:suggested:0.o1']);
    h.store.close();
  });

  it('an operator Try-repair-again run delivers its own outcome (notice rows cleared, keys carry .oN)', async () => {
    const h = harness({ mode: 'approval', slowRetry: { enabled: false } });
    await h.service.tick();
    expect(h.onTerminal).toHaveBeenCalledTimes(1); // slow retry off: the first failure is delivered
    const firstKey = (h.onTerminal.mock.calls[0] as unknown[])[1];
    let ep = h.store.retryFailed(h.id, { inputDigest: DIGEST });
    ep = h.store.transition(ep.id, { expectedVersion: ep.version, to: 'cli-starting', eventClass: 'cli-starting', incrementAttempt: true });
    h.store.transition(ep.id, { expectedVersion: ep.version, to: 'failed', eventClass: 'test-terminal', failureClass: 'attempt-budget-exhausted' });
    await h.service.tick();
    expect(h.onTerminal).toHaveBeenCalledTimes(2);
    expect((h.onTerminal.mock.calls[1] as unknown[])[1]).not.toBe(firstKey);
    expect(String((h.onTerminal.mock.calls[1] as unknown[])[1])).toMatch(/\.o1$/);
    h.store.close();
  });

  it('for approval mode the failure-notice hold runs past quiet hours to the morning re-offer', async () => {
    const h = harness({ mode: 'approval', startAt: new Date(2026, 9, 14, 17, 0, 0, 0).getTime() });
    await h.service.tick();
    h.clock.advance(7 * HOUR + 30 * 60_000); // 00:30 local — past failure + 6 h + 1 h
    await h.service.tick();
    expect(h.onTerminal).not.toHaveBeenCalled();
    h.store.close();
  });

  it('backup-code floor: a full run of drives plus one', () => {
    expect(unattendedBackupCodeFloor()).toBe(4);
    expect(unattendedBackupCodeFloor(1)).toBe(2);
    expect(countBackupCodes('1234 5678 87654321\n1111-2222')).toBe(2);
    expect(countBackupCodes(null)).toBe(0);
  });

  it('"cancel" on a failed repair holds retries without erasing the failure (breaker evidence intact)', async () => {
    const h = harness();
    await h.service.tick();
    expect(h.store.get(h.id)!.nextAttemptAt).not.toBeNull();
    const held = h.store.cancel(h.id);
    expect(held).toMatchObject({ state: 'failed', failureClass: 'attempt-budget-exhausted', slowRetryHeld: true, nextAttemptAt: null });
    h.clock.advance(30 * 24 * HOUR);
    await h.service.tick();
    await h.service.tick();
    expect(h.store.get(h.id)).toMatchObject({ state: 'failed', slowRetryCount: 0, nextAttemptAt: null });
    expect(h.revalidate).not.toHaveBeenCalled();
    expect(h.store.listEvents(h.id).map((e) => e.eventClass)).toContain('slow-retry-held-by-operator');
    h.store.close();
  });

  it('only one retry starts per machine at a time', async () => {
    const h = harness();
    // A second, live repair on the same machine (another account) holds the seat.
    const other = h.store.suggest({ sourceEpisodeId: 8, accountId: 'acct-2', machineId: 'machine-1', mode: 'unattended',
      inputDigest: DIGEST, profileId: 'profile-2', framework: 'claude-code', provider: 'anthropic' });
    h.store.approve(other.id, { inputDigest: DIGEST });
    await h.service.tick();
    h.clock.advance(7 * HOUR);
    await h.service.tick();
    expect(h.store.get(h.id)).toMatchObject({ state: 'failed', slowRetryCount: 0 });
    expect(h.revalidate).not.toHaveBeenCalled();
    h.store.close();
  });

  it('a waiting-operator-only repair on another account does not starve a due retry', async () => {
    const h = harness();
    let other = h.store.suggest({ sourceEpisodeId: 8, accountId: 'acct-2', machineId: 'machine-1', mode: 'unattended',
      inputDigest: DIGEST, profileId: 'profile-2', framework: 'claude-code', provider: 'anthropic' });
    other = h.store.approve(other.id, { inputDigest: DIGEST });
    other = h.store.transition(other.id, { expectedVersion: other.version, to: 'cli-starting', eventClass: 'cli-starting', incrementAttempt: true });
    h.store.transition(other.id, { expectedVersion: other.version, to: 'waiting-operator-only', eventClass: 'operator-only-challenge', failureClass: 'agent-hard-line' });
    await h.service.tick();
    h.clock.advance(7 * HOUR);
    await h.service.tick();
    expect(h.store.get(h.id)).toMatchObject({ state: 'approved', slowRetryCount: 1 });
    h.store.close();
  });

  it('own-leftover login: exact recorded match; legacy rows fall back to the run window', () => {
    expect(isOwnLeftoverLogin('2026-10-14T10:00:00.000Z', { loginCreatedAt: '2026-10-14T10:00:00.000Z' })).toBe(true);
    expect(isOwnLeftoverLogin('2026-10-14T11:00:00.000Z', { loginCreatedAt: '2026-10-14T10:00:00.000Z',
      startedAt: '2026-10-14T09:00:00.000Z', finishedAt: '2026-10-14T12:00:00.000Z' })).toBe(false);
    const legacy = { loginCreatedAt: null, startedAt: '2026-10-14T09:00:00.000Z', finishedAt: '2026-10-14T12:00:00.000Z' };
    expect(isOwnLeftoverLogin('2026-10-14T10:00:00.000Z', legacy)).toBe(true);
    expect(isOwnLeftoverLogin('2026-10-14T13:00:00.000Z', legacy)).toBe(false);
    expect(isOwnLeftoverLogin('2026-10-14T10:00:00.000Z', undefined)).toBe(false);
  });

  it('enabled: "false" (a hand-edited string) turns slow retry off', async () => {
    const h = harness({ slowRetry: { enabled: 'false' as never } });
    await h.service.tick();
    expect(h.store.get(h.id)!.nextAttemptAt).toBeNull();
    h.store.close();
  });

  it('a malformed delaysMs falls back to the defaults instead of breaking the service', () => {
    expect(() => harness({ slowRetry: { delaysMs: 21_600_000 } })).not.toThrow();
  });

  it('turning slow retry off clears any shown next-try time', async () => {
    const h = harness();
    await h.service.tick();
    expect(h.store.get(h.id)!.nextAttemptAt).not.toBeNull();
    const off = new SubscriptionReloginService({ store: h.store, orchestrator: h.orchestrator, scanCandidates: async () => [],
      revalidate: h.revalidate, sourceIncidentOpen: () => true, now: () => h.clock.now(), slowRetry: { enabled: false } });
    await off.tick();
    expect(h.store.get(h.id)!.nextAttemptAt).toBeNull();
    h.store.close();
  });

  it('a spent cap clears the schedule; enabled:false does nothing at all', async () => {
    const capped = harness({ slowRetry: { maxRetries: 0 } });
    await capped.service.tick();
    expect(capped.store.get(capped.id)!.nextAttemptAt).toBeNull();
    capped.store.close();
    const off = harness({ slowRetry: { enabled: false } });
    await off.service.tick();
    off.clock.advance(30 * 24 * HOUR);
    await off.service.tick();
    expect(off.store.get(off.id)).toMatchObject({ state: 'failed', nextAttemptAt: null, slowRetryCount: 0 });
    expect(off.revalidate).not.toHaveBeenCalled();
    off.store.close();
  });

  it('a revalidation with no resolved mode (observe / legacy port) never starts a retry', async () => {
    const h = harness();
    h.revalidate.mockImplementation(async () => ({ admissible: true as const, inputDigest: NEW_DIGEST }) as never);
    await h.service.tick();
    h.clock.advance(7 * HOUR);
    await h.service.tick();
    expect(h.store.get(h.id)).toMatchObject({ state: 'failed', slowRetryCount: 0 });
    h.store.close();
  });
});

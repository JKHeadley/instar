import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  SubscriptionReloginConflictError,
  SubscriptionReloginStore,
  reloginReasonToken,
} from '../../src/core/SubscriptionReloginStore.js';
import Database from 'better-sqlite3';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'subscription-relogin-store.test cleanup' });
  }
});

function fixture(now = Date.parse('2026-08-28T07:00:00.000Z')) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subscription-relogin-'));
  dirs.push(stateDir);
  let id = 0;
  const store = new SubscriptionReloginStore({ stateDir, now: () => now, idFactory: () => `repair-${++id}` });
  const suggest = (overrides: Partial<Parameters<typeof store.suggest>[0]> = {}) => store.suggest({
    sourceEpisodeId: 41,
    accountId: 'acct-1',
    machineId: 'machine-1',
    mode: 'approval',
    inputDigest: `sha256:${'a'.repeat(64)}`,
    profileId: 'justin-google',
    framework: 'claude-code',
    provider: 'anthropic',
    at: new Date(now).toISOString(),
    ...overrides,
  });
  return { stateDir, store, suggest };
}

describe('SubscriptionReloginStore', () => {
  it('persists only closed metadata with private filesystem permissions', () => {
    const { store, suggest } = fixture();
    const episode = suggest();
    expect(episode.state).toBe('suggested');
    expect(episode.version).toBe(1);
    expect(store.listEvents(episode.id)[0]).toMatchObject({
      toState: 'suggested', eventClass: 'candidate-admitted', attempt: 0,
    });
    expect(fs.statSync(store.dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(store.dbPath).mode & 0o777).toBe(0o600);
    expect(Object.keys(episode).join(',')).not.toMatch(/token|password|cookie|verificationUrl|userCode/i);
    store.close();
  });

  it('is idempotent for the same source incident and refuses a second live owner', () => {
    const { store, suggest } = fixture();
    const first = suggest();
    expect(suggest().id).toBe(first.id);
    expect(() => suggest({ sourceEpisodeId: 42 })).toThrowError(SubscriptionReloginConflictError);
    store.close();
  });

  it('binds approval to the immutable input digest and gives it a bounded expiry', () => {
    const { store, suggest } = fixture();
    const episode = suggest();
    expect(() => store.approve(episode.id, { inputDigest: `sha256:${'b'.repeat(64)}` }))
      .toThrowError('approval-input-digest-mismatch');
    const approved = store.approve(episode.id, { inputDigest: episode.inputDigest });
    expect(approved).toMatchObject({ state: 'approved', version: 2, approvedAt: '2026-08-28T07:00:00.000Z' });
    expect(approved.approvalExpiresAt).toBe('2026-08-28T07:15:00.000Z');
    expect(() => store.approve(episode.id, { inputDigest: episode.inputDigest }))
      .toThrowError('episode-not-approvable');
    store.close();
  });

  it('enforces the state graph and optimistic concurrency', () => {
    const { store, suggest } = fixture();
    const suggested = suggest();
    expect(() => store.transition(suggested.id, {
      expectedVersion: suggested.version, to: 'succeeded', eventClass: 'invalid-shortcut',
    })).toThrowError('invalid-transition:suggested->succeeded');
    const approved = store.approve(suggested.id, { inputDigest: suggested.inputDigest });
    const starting = store.transition(approved.id, {
      expectedVersion: approved.version, to: 'cli-starting', eventClass: 'cli-started', incrementAttempt: true,
    });
    expect(starting).toMatchObject({ state: 'cli-starting', attemptCount: 1, version: 3 });
    expect(() => store.transition(starting.id, {
      expectedVersion: approved.version, to: 'artifact-ready', eventClass: 'artifact-captured',
    })).toThrowError('episode-version-conflict');
    store.close();
  });

  it('makes cancellation authoritative and idempotent from every nonterminal state', () => {
    const { store, suggest } = fixture();
    const approved = store.approve(suggest().id, { inputDigest: `sha256:${'a'.repeat(64)}` });
    const cancelled = store.cancel(approved.id);
    expect(cancelled).toMatchObject({ state: 'cancelled', failureClass: 'cancelled-by-operator' });
    expect(cancelled.finishedAt).toBe('2026-08-28T07:00:00.000Z');
    expect(store.cancel(approved.id).version).toBe(cancelled.version);
    expect(() => store.transition(cancelled.id, {
      expectedVersion: cancelled.version, to: 'approved', eventClass: 'illegal-revival',
    })).toThrowError('invalid-transition:cancelled->approved');
    store.close();
  });

  it('survives restart without losing the exact state or audit history', () => {
    const { stateDir, store, suggest } = fixture();
    const approved = store.approve(suggest().id, { inputDigest: `sha256:${'a'.repeat(64)}` });
    store.close();
    const reopened = new SubscriptionReloginStore({ stateDir });
    expect(reopened.get(approved.id)).toMatchObject({ state: 'approved', inputDigest: approved.inputDigest, version: 2 });
    expect(reopened.listEvents(approved.id).map((event) => event.eventClass))
      .toEqual(['operator-approved', 'candidate-admitted']);
    reopened.close();
  });

  it('rejects free-form and credential-shaped values at every bounded identifier surface', () => {
    const { store, suggest } = fixture();
    expect(() => suggest({ accountId: 'person@example.com' })).toThrowError('invalid-account-id');
    expect(() => suggest({ profileId: 'profile with spaces' })).toThrowError('invalid-profile-id');
    expect(() => suggest({ inputDigest: 'secret-token' })).toThrowError('invalid-input-digest');
    const episode = suggest();
    expect(() => store.transition(episode.id, {
      expectedVersion: episode.version, to: 'cancelled', eventClass: 'raw error from provider',
    })).toThrowError('invalid-event-class');
    store.close();
  });

  it('durably queues approval and terminal notifications with stable idempotency keys', () => {
    const { stateDir, store, suggest } = fixture();
    const episode = suggest();
    const [suggested] = store.claimNotifications();
    expect(suggested).toMatchObject({ episodeId: episode.id, kind: 'suggested', state: 'delivering', attemptCount: 1 });
    expect(suggested.deliveryKey).toBe(`subscription-relogin:${episode.id}:suggested:0`);
    store.completeNotification(suggested.id);
    const approved = store.approve(episode.id, { inputDigest: episode.inputDigest });
    store.cancel(approved.id);
    store.close();

    const reopened = new SubscriptionReloginStore({ stateDir, now: () => Date.parse('2026-08-28T07:00:00.000Z') });
    const [terminal] = reopened.claimNotifications();
    expect(terminal).toMatchObject({ episodeId: episode.id, kind: 'terminal' });
    reopened.completeNotification(terminal.id);
    expect(reopened.claimNotifications()).toEqual([]);
    reopened.close();
  });

  it('releases failed notification deliveries into bounded retry instead of losing them', () => {
    const { store, suggest } = fixture();
    suggest();
    const [notification] = store.claimNotifications();
    store.retryNotification(notification.id, 5_000);
    expect(store.claimNotifications()).toEqual([]);
    store.close();
  });

  it('opens the account/provider breaker after three recent failed episodes', () => {
    const { store, suggest } = fixture();
    for (let sourceEpisodeId = 41; sourceEpisodeId <= 43; sourceEpisodeId++) {
      const suggested = suggest({ sourceEpisodeId });
      const approved = store.approve(suggested.id, { inputDigest: suggested.inputDigest });
      const starting = store.transition(approved.id, { expectedVersion: approved.version,
        to: 'cli-starting', eventClass: 'cli-starting', incrementAttempt: true });
      store.transition(starting.id, { expectedVersion: starting.version, to: 'failed',
        eventClass: 'provider-rejected', failureClass: 'provider-rejected' });
    }
    expect(store.isBreakerOpen('acct-1', 'anthropic')).toBe(true);
    expect(store.isBreakerOpen('acct-1', 'other-provider')).toBe(false);
    store.close();
  });

  it.each(['wrong-identity', 'unexpected-origin', 'permission-expansion', 'captcha', 'phone-confirmation'] as const)(
    'opens the account/provider breaker immediately for security failure %s', (failureClass) => {
      const { store, suggest } = fixture();
      const suggested = suggest();
      const approved = store.approve(suggested.id, { inputDigest: suggested.inputDigest });
      const starting = store.transition(approved.id, { expectedVersion: approved.version,
        to: 'cli-starting', eventClass: 'cli-starting', incrementAttempt: true });
      const ready = store.transition(starting.id, { expectedVersion: starting.version,
        to: 'artifact-ready', eventClass: 'artifact-ready' });
      const driving = store.transition(ready.id, { expectedVersion: ready.version,
        to: 'browser-driving', eventClass: 'browser-driving' });
      store.transition(driving.id, { expectedVersion: driving.version,
        to: failureClass === 'wrong-identity' || failureClass === 'unexpected-origin' ? 'refused' : 'failed',
        eventClass: 'security-terminal', failureClass });
      expect(store.isBreakerOpen('acct-1', 'anthropic')).toBe(true);
      store.close();
    });

  it('computes unattended security evidence over all retained rows, not the 500-row display window', () => {
    const { store, suggest } = fixture();
    const security = suggest({ sourceEpisodeId: 1 });
    const securityApproved = store.approve(security.id, { inputDigest: security.inputDigest });
    const securityStarted = store.transition(securityApproved.id, { expectedVersion: securityApproved.version,
      to: 'cli-starting', eventClass: 'cli-starting' });
    const securityReady = store.transition(securityStarted.id, { expectedVersion: securityStarted.version,
      to: 'artifact-ready', eventClass: 'artifact-ready' });
    const securityDriving = store.transition(securityReady.id, { expectedVersion: securityReady.version,
      to: 'browser-driving', eventClass: 'browser-driving' });
    store.transition(securityDriving.id, { expectedVersion: securityDriving.version, to: 'refused',
      eventClass: 'wrong-identity', failureClass: 'wrong-identity' });
    for (let sourceEpisodeId = 2; sourceEpisodeId <= 501; sourceEpisodeId++) {
      const row = suggest({ sourceEpisodeId });
      const approved = store.approve(row.id, { inputDigest: row.inputDigest });
      store.transition(approved.id, { expectedVersion: approved.version, to: 'failed',
        eventClass: 'ordinary-failure', failureClass: 'provider-rejected' });
    }
    expect(store.list({ accountId: 'acct-1', limit: 500 })).toHaveLength(500);
    expect(store.getUnattendedEvidence('acct-1', 'machine-1', 'anthropic', 'claude-code'))
      .toMatchObject({ identityMismatches: 1, unexpectedOrigins: 0 });
    store.close();
  });

  it('allows an explicit retry only for a non-security failed terminal and resets its budgets', () => {
    const { store, suggest } = fixture();
    const suggested = suggest();
    const approved = store.approve(suggested.id, { inputDigest: suggested.inputDigest });
    const starting = store.transition(approved.id, { expectedVersion: approved.version,
      to: 'cli-starting', eventClass: 'cli-starting', incrementAttempt: true });
    const failed = store.transition(starting.id, { expectedVersion: starting.version, to: 'failed',
      eventClass: 'provider-rejected', failureClass: 'provider-rejected', incrementReissue: true });
    const retried = store.retryFailed(failed.id, { inputDigest: failed.inputDigest });
    expect(retried).toMatchObject({ state: 'approved', attemptCount: 0, reissueCount: 0,
      startedAt: null, finishedAt: null, failureClass: null });
    expect(store.listEvents(failed.id).map((event) => event.eventClass)).toContain('operator-retry-approved');
    store.close();
  });
  it('re-admits a suggested, cancelled or failed row for the same incident when its admitted inputs changed', () => {
    const { store, suggest } = fixture();
    const changed = { inputDigest: `sha256:${'b'.repeat(64)}`, mode: 'unattended' as const };
    // Stale suggestion (the live 2026-09-23 case: account joined the unattended list after suggest).
    const stale = suggest();
    const readmitted = suggest(changed);
    expect(readmitted).toMatchObject({ id: stale.id, state: 'suggested', mode: 'unattended',
      inputDigest: changed.inputDigest, attemptCount: 0, reissueCount: 0 });
    expect(store.approve(readmitted.id, { inputDigest: changed.inputDigest }).state).toBe('approved');
    // A failed attempt (the 2026-09-21 Adriana case) re-admits once inputs change again…
    const approved = store.get(readmitted.id)!;
    const starting = store.transition(approved.id, { expectedVersion: approved.version,
      to: 'cli-starting', eventClass: 'cli-starting', incrementAttempt: true });
    const failed = store.transition(starting.id, { expectedVersion: starting.version, to: 'failed',
      eventClass: 'artifact-reissue-budget-exhausted', failureClass: 'attempt-budget-exhausted', incrementReissue: true });
    expect(suggest(changed)).toMatchObject({ state: 'failed' }); // unchanged inputs: still waits for an operator retry
    const third = { ...changed, inputDigest: `sha256:${'c'.repeat(64)}` };
    expect(suggest(third)).toMatchObject({ id: failed.id, state: 'suggested', failureClass: null,
      startedAt: null, approvedAt: null, attemptCount: 0, reissueCount: 0 });
    expect(store.listEvents(failed.id).map((event) => event.eventClass)).toContain('candidate-readmitted-inputs-changed');
    // …and a cancelled one too, but only on changed inputs.
    const cancelled = store.cancel(failed.id);
    expect(cancelled.state).toBe('cancelled');
    expect(suggest(third).state).toBe('cancelled');
    expect(suggest({ ...third, inputDigest: `sha256:${'d'.repeat(64)}` }).state).toBe('suggested');
    store.close();
  });

  it('never re-admits a refused or succeeded row, and never steals the cell from another live repair', () => {
    const { store, suggest } = fixture();
    const first = suggest();
    const refused = store.transition(first.id, { expectedVersion: first.version, to: 'refused',
      eventClass: 'wrong-identity', failureClass: 'wrong-identity' });
    expect(suggest({ inputDigest: `sha256:${'b'.repeat(64)}` })).toMatchObject({ id: refused.id, state: 'refused' });
    const other = suggest({ sourceEpisodeId: 42 });
    expect(other.state).toBe('suggested');
    const cancelled = store.cancel(other.id);
    const live = suggest({ sourceEpisodeId: 43 });
    expect(live.state).toBe('suggested');
    expect(() => suggest({ sourceEpisodeId: 42, inputDigest: `sha256:${'e'.repeat(64)}` }))
      .toThrowError(SubscriptionReloginConflictError);
    expect(store.get(cancelled.id)?.state).toBe('cancelled');
    store.close();
  });

  it('keeps a security-class failure terminal so re-admission cannot erase breaker evidence', () => {
    const { store, suggest } = fixture();
    const first = suggest();
    const approved = store.approve(first.id, { inputDigest: first.inputDigest });
    const starting = store.transition(approved.id, { expectedVersion: approved.version,
      to: 'cli-starting', eventClass: 'cli-starting', incrementAttempt: true });
    store.transition(starting.id, { expectedVersion: starting.version, to: 'failed',
      eventClass: 'captcha', failureClass: 'captcha' });
    expect(suggest({ inputDigest: `sha256:${'b'.repeat(64)}` })).toMatchObject({ id: first.id, state: 'failed', failureClass: 'captcha' });
    store.close();
  });

  it('re-queues the suggestion notification on an approval-mode re-admission', () => {
    const { store, suggest } = fixture();
    const first = suggest();
    store.cancel(first.id);
    suggest({ inputDigest: `sha256:${'b'.repeat(64)}` });
    expect(store.claimNotifications(10).map((notification) => notification.kind)).toEqual(['suggested']);
    store.close();
  });

  it('keeps only short machine reason tokens; free text or page content becomes "unclassified"', () => {
    expect(reloginReasonToken('chrome-launch-timeout')).toBe('chrome-launch-timeout');
    expect(reloginReasonToken('plain-browser-apple-event-error--1743')).toBe('plain-browser-apple-event-error--1743');
    expect(reloginReasonToken('relogin-profile-in-use')).toBe('relogin-profile-in-use');
    expect(reloginReasonToken('Wrong password for justin@example.com')).toBe('unclassified');
    expect(reloginReasonToken('hunter2secret')).toBe('unclassified');
    expect(reloginReasonToken(undefined)).toBeNull();
  });

  it('adds the reason column to an existing database and records reasons on events', () => {
    const { store, suggest } = fixture();
    const ep = suggest();
    const approved = store.approve(ep.id, { inputDigest: ep.inputDigest });
    const dbPath = (store as unknown as { dbPath: string }).dbPath;
    const stateDir = path.dirname(path.dirname(path.dirname(dbPath)));
    store.close();
    // Simulate a database created before the column existed.
    const raw = new Database(dbPath);
    raw.exec('ALTER TABLE repair_events DROP COLUMN reason');
    raw.close();
    const reopened = new SubscriptionReloginStore({ stateDir, now: () => Date.parse('2026-08-28T07:00:00.000Z') });
    const moved = reopened.transition(approved.id, { expectedVersion: approved.version, to: 'cli-starting',
      eventClass: 'cli-starting', reason: 'chrome-launch-timeout' });
    const events = reopened.listEvents(moved.id);
    expect(events.find((e) => e.eventClass === 'cli-starting')?.reason).toBe('chrome-launch-timeout');
    reopened.close();
  });
});

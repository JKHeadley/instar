/**
 * CMT-1008 — a pane-observed expired login outranks a successful usage read.
 *
 * 2026-10-25, sagemind agent "Luna": sagemind-justin's stored token still answered the OAuth
 * usage endpoint (`loginCheck` stayed usable, status `active`) while every Claude Code session
 * placed on it showed "Not logged in · Run /login". A manual needs-reauth was reverted by the next
 * poll. Now one session at that screen (past SessionManager's dwell) moves the account to
 * needs-reauth when the credential READS, and the poller does not restore it while the stored
 * credential is still the one the CLI refused.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SubscriptionPool } from '../../src/core/SubscriptionPool.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { QuotaPoller, CLI_LOGIN_EXPIRED_HOLD_MAX_MS, type TokenResolution } from '../../src/core/QuotaPoller.js';
import { evaluateSubscriptionReloginAdmission } from '../../src/core/SubscriptionReloginPolicy.js';

const NOW = Date.parse('2026-10-25T12:00:00Z');
const HOME = '/home/x/.claude-sagemind-justin';
const CLAUDE = { nickname: 'sj', email: 'sj@example.test', provider: 'anthropic' as const,
  framework: 'claude-code' as const, configHome: HOME };
const usageOk = async () => ({ ok: true, status: 200, json: async () => ({ five_hour: { utilization: 5, resets_at: '2026-10-25T15:00:00Z' } }) });

describe('QuotaPoller: pane-observed expired login is authoritative over a readable credential', () => {
  let dir: string;
  let pool: SubscriptionPool;
  let clock = NOW;
  let token: TokenResolution = 'sk-ant-oat-original';
  beforeEach(() => { clock = NOW; token = 'sk-ant-oat-original'; dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qpoll-pane-')); pool = new SubscriptionPool({ stateDir: dir }); });
  afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'quota-poller-pane-login-authority cleanup' }); });

  function poller(observed: unknown[] = []) {
    return new QuotaPoller({
      pool, now: () => clock,
      tokenResolver: () => token,
      fetchImpl: usageOk,
      refresher: async () => { throw new Error('no refresh expected'); },
      loginObservationSink: (input) => { observed.push(input.outcome); },
    });
  }

  it('one session at the screen + readable credential → needs-reauth at once, actionable for repair', async () => {
    pool.addFixture({ ...CLAUDE, id: 'sj' });
    const observed: unknown[] = [];
    const p = poller(observed);
    const r = await p.observeCliLoginExpired({ configHome: `${HOME}/`, session: 'topic-1' });
    expect(r).toEqual({ accountId: 'sj', marked: true, reason: 'marked', accountStatus: 'needs-reauth' });
    expect(pool.get('sj')!.status).toBe('needs-reauth');
    expect(p.loginCheck('sj')).toBe('signed-out');
    expect(observed).toContainEqual({ kind: 'transition-to-needs-reauth', causeClass: 'cli-login-expired-observed', corroboration: 'exchange-corroborated' });
    const admission = evaluateSubscriptionReloginAdmission({
      configuredMode: 'approval', poolAuthority: 'ready',
      account: { ...pool.get('sj')!, machineId: 'm1', identityHash: 'h' },
      sourceEpisode: { id: 1, accountId: 'sj', machineId: 'm1', openedAt: '', closedAt: null,
        causeClass: 'cli-login-expired-observed', corroboration: 'exchange-corroborated', outcome: null, provenance: 'observed' },
      hasLiveRepair: false, hasLivePendingLogin: false, profile: null, breakerOpen: false,
      unattended: { successfulRepairs: 0, evidenceDays: 0, identityMismatches: 0, unexpectedOrigins: 0 },
    } as never);
    expect(admission).toEqual({ admitted: false, reason: 'profile-unresolved' }); // past the cause gate
  });

  it('a successful usage read does NOT restore the account while the credential is unchanged', async () => {
    pool.addFixture({ ...CLAUDE, id: 'sj' });
    const p = poller();
    await p.observeCliLoginExpired({ configHome: HOME, session: 'topic-1' });
    clock += 15 * 60_000;
    const res = await p.pollAll();
    expect(res.polled).toBe(1); // the quota itself is still recorded
    expect(pool.get('sj')!.status).toBe('needs-reauth');
    expect(pool.get('sj')!.lastQuota?.source).toBe('oauth-usage-endpoint-fallback');
    expect(p.loginCheck('sj')).toBe('signed-out');
  });

  it('a restore to active from outside the poller (repair success, operator) wins and releases the hold', async () => {
    pool.addFixture({ ...CLAUDE, id: 'sj' });
    const p = poller();
    await p.observeCliLoginExpired({ configHome: HOME, session: 'topic-1' });
    pool.update('sj', { status: 'active' }); // e.g. SubscriptionReloginRuntime.finalizeSuccess
    await p.pollAll();
    expect(pool.get('sj')!.status).toBe('active');
    expect(p.loginCheck('sj')).toBe('ok');
    // …and a later poll does not resurrect the hold.
    await p.pollAll();
    expect(pool.get('sj')!.status).toBe('active');
  });

  it('a fresh sign-in (credential changed) releases the hold → the next clean read restores active', async () => {
    pool.addFixture({ ...CLAUDE, id: 'sj' });
    const p = poller();
    await p.observeCliLoginExpired({ configHome: HOME, session: 'topic-1' });
    token = 'sk-ant-oat-after-relogin';
    await p.pollAll();
    expect(pool.get('sj')!.status).toBe('active');
    expect(p.loginCheck('sj')).toBe('ok');
  });

  it('a credential swap on the slot releases the hold', async () => {
    pool.addFixture({ ...CLAUDE, id: 'sj' });
    const p = poller();
    await p.observeCliLoginExpired({ configHome: HOME, session: 'topic-1' });
    p.invalidateIdentityCache([HOME]);
    await p.pollAll();
    expect(pool.get('sj')!.status).toBe('active');
  });

  it('the hold lapses at its ceiling (a still-broken login is observed again by the next session)', async () => {
    pool.addFixture({ ...CLAUDE, id: 'sj' });
    const p = poller();
    await p.observeCliLoginExpired({ configHome: HOME, session: 'topic-1' });
    clock += CLI_LOGIN_EXPIRED_HOLD_MAX_MS - 1;
    await p.pollAll();
    expect(pool.get('sj')!.status).toBe('needs-reauth');
    clock += 2;
    await p.pollAll();
    expect(pool.get('sj')!.status).toBe('active');
  });

  it('an UNREADABLE credential is never flipped on one screen (locked keychain guard)', async () => {
    pool.addFixture({ ...CLAUDE, id: 'sj' });
    token = { observationOnly: true, reason: 'credential-absent-or-unreadable' };
    const p = poller();
    const r = await p.observeCliLoginExpired({ configHome: HOME, session: 'topic-1' });
    expect(r).toEqual({ accountId: 'sj', marked: false, reason: 'credential-unreadable', accountStatus: 'active' });
    expect(pool.get('sj')!.status).toBe('active');
  });

  it('a home no pool account owns → no-account, nothing changes', async () => {
    pool.addFixture({ ...CLAUDE, id: 'sj' });
    const p = poller();
    const r = await p.observeCliLoginExpired({ configHome: '/home/x/.claude-someone-else', session: 'topic-1' });
    expect(r).toEqual({ accountId: null, marked: false, reason: 'no-account', accountStatus: null });
    expect(pool.get('sj')!.status).toBe('active');
  });

  it('an account already at needs-reauth is held, not re-transitioned', async () => {
    pool.addFixture({ ...CLAUDE, id: 'sj' });
    pool.update('sj', { status: 'needs-reauth' });
    const observed: unknown[] = [];
    const p = poller(observed);
    const r = await p.observeCliLoginExpired({ configHome: HOME, session: 'topic-1' });
    expect(r.reason).toBe('already-held');
    expect(observed).toEqual([]);
    await p.pollAll();
    expect(pool.get('sj')!.status).toBe('needs-reauth');
  });
});

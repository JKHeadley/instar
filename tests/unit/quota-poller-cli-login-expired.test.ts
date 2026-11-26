/**
 * Claude Code's own "Login expired" screen corroborates an unreadable stored credential.
 *
 * The failure this closes (2026-10-22, Mac Studio): headley.justin@gmail.com's stored credential
 * stopped reading as a valid token at ~04:10. The poller logged only a provisional
 * credential-read observation (never actionable, by design) and made no usage read, so no
 * exchange ever failed and the account stayed `active`. Meanwhile SessionManager ended 40+
 * sessions stuck at "Login expired · Please run /login" under that home, and the sign-in repair
 * never started. Now two distinct sessions seeing that frame within an hour, plus an unreadable
 * credential, move the account to needs-reauth with an exchange-corroborated, actionable cause.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SubscriptionPool } from '../../src/core/SubscriptionPool.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { QuotaPoller, type TokenResolution } from '../../src/core/QuotaPoller.js';
import { evaluateSubscriptionReloginAdmission } from '../../src/core/SubscriptionReloginPolicy.js';

const NOW = Date.parse('2026-10-22T12:00:00Z');
const HOME = '/home/x/.claude-followme-justin-gmail';
const CLAUDE = { nickname: 'jg', email: 'jg@example.test', provider: 'anthropic' as const,
  framework: 'claude-code' as const, configHome: HOME };

describe('QuotaPoller: CLI "Login expired" corroborates an unreadable credential', () => {
  let dir: string;
  let pool: SubscriptionPool;
  let clock = NOW;
  beforeEach(() => { clock = NOW; dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qpoll-cle-')); pool = new SubscriptionPool({ stateDir: dir }); });
  afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'quota-poller-cli-login-expired cleanup' }); });

  function poller(resolution: TokenResolution, observed: unknown[] = []) {
    return new QuotaPoller({
      pool, now: () => clock,
      tokenResolver: () => resolution,
      fetchImpl: async () => { throw new Error('no usage read expected'); },
      refresher: async () => { throw new Error('no refresh expected'); },
      loginObservationSink: (input) => { observed.push(input.outcome); },
    });
  }
  const unreadable: TokenResolution = { observationOnly: true, reason: 'credential-token-shape-invalid' };

  it('two distinct sessions at "Login expired" + an unreadable credential → needs-reauth (actionable)', async () => {
    pool.addFixture({ ...CLAUDE, id: 'jg' });
    const observed: unknown[] = [];
    const p = poller(unreadable, observed);
    p.noteCliLoginExpired({ configHome: HOME, session: 'job-a' });
    p.noteCliLoginExpired({ configHome: `${HOME}/`, session: 'job-b' }); // same home, normalised
    await p.pollAll();
    expect(pool.get('jg')!.status).toBe('needs-reauth');
    expect(p.loginCheck('jg')).toBe('signed-out');
    const outcome = { kind: 'transition-to-needs-reauth', causeClass: 'cli-login-expired-observed',
      corroboration: 'exchange-corroborated' };
    expect(observed).toContainEqual(outcome);
    // The repair admission accepts this cause (it is not refused as non-actionable).
    const admission = evaluateSubscriptionReloginAdmission({
      configuredMode: 'approval', poolAuthority: 'ready',
      account: { ...pool.get('jg')!, machineId: 'm1', identityHash: 'h' },
      sourceEpisode: { id: 1, accountId: 'jg', machineId: 'm1', openedAt: '', closedAt: null,
        causeClass: 'cli-login-expired-observed', corroboration: 'exchange-corroborated',
        outcome: null, provenance: 'observed' },
      hasLiveRepair: false, hasLivePendingLogin: false, profile: null, breakerOpen: false,
      unattended: { successfulRepairs: 0, evidenceDays: 0, identityMismatches: 0, unexpectedOrigins: 0 },
    } as never);
    expect(admission).toEqual({ admitted: false, reason: 'profile-unresolved' }); // got past the cause gate
  });

  it('one session (even sighted repeatedly) is not enough', async () => {
    pool.addFixture({ ...CLAUDE, id: 'jg' });
    const observed: unknown[] = [];
    const p = poller(unreadable, observed);
    p.noteCliLoginExpired({ configHome: HOME, session: 'job-a' });
    p.noteCliLoginExpired({ configHome: HOME, session: 'job-a' });
    await p.pollAll();
    expect(pool.get('jg')!.status).toBe('active');
    expect(observed).toContainEqual({ kind: 'observation-absence', causeClass: 'credential-token-shape-invalid' });
  });

  it('sightings older than the window, or under another home, do not count', async () => {
    pool.addFixture({ ...CLAUDE, id: 'jg' });
    const p = poller(unreadable);
    p.noteCliLoginExpired({ configHome: HOME, session: 'job-old', at: NOW - 61 * 60_000 });
    p.noteCliLoginExpired({ configHome: '/home/x/.claude-other', session: 'job-other' });
    p.noteCliLoginExpired({ configHome: HOME, session: 'job-new' });
    await p.pollAll();
    expect(pool.get('jg')!.status).toBe('active');
  });

  it('an ABSENT/unreadable credential (locked keychain) never corroborates — only a malformed one does', async () => {
    pool.addFixture({ ...CLAUDE, id: 'jg' });
    const observed: unknown[] = [];
    const p = poller({ observationOnly: true, reason: 'credential-absent-or-unreadable' }, observed);
    p.noteCliLoginExpired({ configHome: HOME, session: 'job-a' });
    p.noteCliLoginExpired({ configHome: HOME, session: 'job-b' });
    await p.pollAll();
    expect(pool.get('jg')!.status).toBe('active');
    expect(observed).toContainEqual({ kind: 'observation-absence', causeClass: 'credential-absent-or-unreadable' });
  });

  it('a missing oauth block corroborates like an invalid token shape', async () => {
    pool.addFixture({ ...CLAUDE, id: 'jg' });
    const p = poller({ observationOnly: true, reason: 'credential-missing-oauth-block' });
    p.noteCliLoginExpired({ configHome: HOME, session: 'job-a' });
    p.noteCliLoginExpired({ configHome: HOME, session: 'job-b' });
    await p.pollAll();
    expect(pool.get('jg')!.status).toBe('needs-reauth');
  });

  it('a credential swap on the slot clears its sightings', async () => {
    pool.addFixture({ ...CLAUDE, id: 'jg' });
    const p = poller(unreadable);
    p.noteCliLoginExpired({ configHome: HOME, session: 'job-a' });
    p.noteCliLoginExpired({ configHome: HOME, session: 'job-b' });
    p.invalidateIdentityCache([HOME]);
    await p.pollAll();
    expect(pool.get('jg')!.status).toBe('active');
  });

  it('a readable credential is never flipped by sightings alone (the usage read decides)', async () => {
    pool.addFixture({ ...CLAUDE, id: 'jg' });
    const p = new QuotaPoller({
      pool, now: () => clock,
      tokenResolver: () => 'sk-ant-oat-test',
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ five_hour: { utilization: 5, resets_at: '2026-10-22T15:00:00Z' } }) }),
      refresher: async () => { throw new Error('no refresh expected'); },
    });
    p.noteCliLoginExpired({ configHome: HOME, session: 'job-a' });
    p.noteCliLoginExpired({ configHome: HOME, session: 'job-b' });
    await p.pollAll();
    expect(pool.get('jg')!.status).toBe('active');
    expect(p.loginCheck('jg')).toBe('ok');
  });
});

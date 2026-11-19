/**
 * An account whose stored credential is gone entirely is noticed (never-silent-conversation §3.6,
 * the every-poll engine login read).
 *
 * The failure this closes (2026-11-15, unattended-recovery proof): a Claude slot pointed at an
 * empty config home read `active` with loginCheck `unavailable` forever. A missing credential is
 * deliberately not evidence on its own (a locked keychain looks the same), so the automatic repair
 * never started. Now the engine's own trusted "signed out" (canary-proven, credential store open)
 * on two polls at least 5 minutes apart moves the account to needs-reauth, and the repair admits it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SubscriptionPool } from '../../src/core/SubscriptionPool.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { QuotaPoller, type TokenResolution } from '../../src/core/QuotaPoller.js';
import { evaluateSubscriptionReloginAdmission } from '../../src/core/SubscriptionReloginPolicy.js';
import { engineTrustedSignedOut, ENGINE_CREDENTIAL_STORE_OPEN, ENGINE_LOGIN_READERS } from '../../src/providers/adapters/engineSessionHooks.js';

const NOW = Date.parse('2026-11-15T12:00:00Z');
const HOME = '/home/x/.claude-followme-proof';
const CLAUDE = { nickname: 'proof', email: 'proof@example.test', provider: 'anthropic' as const,
  framework: 'claude-code' as const, configHome: HOME };
const ABSENT: TokenResolution = { observationOnly: true, reason: 'credential-absent-or-unreadable' };

describe('QuotaPoller: no stored credential + the engine says signed out', () => {
  let dir: string;
  let pool: SubscriptionPool;
  let clock = NOW;
  beforeEach(() => { clock = NOW; dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qpoll-absent-')); pool = new SubscriptionPool({ stateDir: dir }); });
  afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'quota-poller-credential-absent cleanup' }); });

  function poller(resolution: TokenResolution, answer: () => Promise<boolean | null>, observed: unknown[] = [], asked: string[] = []) {
    return new QuotaPoller({
      pool, now: () => clock,
      tokenResolver: () => resolution,
      fetchImpl: async () => { throw new Error('no usage read expected'); },
      refresher: async () => { throw new Error('no refresh expected'); },
      loginObservationSink: (input) => { observed.push(input.outcome); },
      engineLoginSignedOut: async (account) => { asked.push(account.configHome); return answer(); },
    });
  }

  it('two trusted NOs 5+ minutes apart → needs-reauth with an actionable cause', async () => {
    pool.addFixture({ ...CLAUDE, id: 'proof' });
    const observed: unknown[] = [];
    const asked: string[] = [];
    const p = poller(ABSENT, async () => true, observed, asked);
    await p.pollAll();
    expect(pool.get('proof')!.status).toBe('active'); // one answer is not enough
    expect(p.loginCheck('proof')).toBe('signed-out'); // but the gap is visible at once
    expect(asked).toEqual([HOME]);
    clock += 2 * 60_000;
    await p.pollAll();
    expect(pool.get('proof')!.status).toBe('active'); // too soon to count twice
    clock += 4 * 60_000;
    await p.pollAll();
    expect(pool.get('proof')!.status).toBe('needs-reauth');
    const outcome = { kind: 'transition-to-needs-reauth', causeClass: 'cli-auth-status-signed-out', corroboration: 'exchange-corroborated' };
    expect(observed).toContainEqual(outcome);
    const admission = evaluateSubscriptionReloginAdmission({
      configuredMode: 'unattended', poolAuthority: 'ready',
      account: { ...pool.get('proof')!, machineId: 'm1', identityHash: 'h' },
      sourceEpisode: { id: 1, accountId: 'proof', machineId: 'm1', openedAt: '', closedAt: null,
        causeClass: 'cli-auth-status-signed-out', corroboration: 'exchange-corroborated', outcome: null, provenance: 'observed' },
      hasLiveRepair: false, hasLivePendingLogin: false, profile: null, breakerOpen: false,
      unattended: { successfulRepairs: 0, evidenceDays: 0, identityMismatches: 0, unexpectedOrigins: 0 },
    } as never);
    expect(admission).toEqual({ admitted: false, reason: 'profile-unresolved' }); // got past the cause gate
  });

  it('an unknown or YES answer in between resets the streak; status and check stay as before', async () => {
    pool.addFixture({ ...CLAUDE, id: 'proof' });
    const answers: Array<boolean | null> = [true, null, true];
    const observed: unknown[] = [];
    const p = poller(ABSENT, async () => answers.shift() ?? null, observed);
    await p.pollAll();
    clock += 6 * 60_000;
    await p.pollAll(); // unknown (e.g. keychain locked)
    expect(p.loginCheck('proof')).toBe('unavailable');
    expect(observed).toContainEqual({ kind: 'observation-absence', causeClass: 'credential-absent-or-unreadable' });
    clock += 6 * 60_000;
    await p.pollAll(); // a single NO again
    expect(pool.get('proof')!.status).toBe('active');
  });

  it('a throwing check is no signal; a credential that reads (any other reason) never asks the engine', async () => {
    pool.addFixture({ ...CLAUDE, id: 'proof' });
    const p = poller(ABSENT, async () => { throw new Error('spawn failed'); });
    await p.pollAll();
    expect(p.loginCheck('proof')).toBe('unavailable');
    const asked: string[] = [];
    const q = poller({ observationOnly: true, reason: 'credential-token-shape-invalid' }, async () => true, [], asked);
    await q.pollAll();
    expect(asked).toEqual([]);
    expect(pool.get('proof')!.status).toBe('active');
  });

  it('without the check wired, a missing credential stays unavailable (unchanged behaviour)', async () => {
    pool.addFixture({ ...CLAUDE, id: 'proof' });
    const p = new QuotaPoller({ pool, now: () => clock, tokenResolver: () => ABSENT,
      fetchImpl: async () => { throw new Error('no read'); }, refresher: async () => { throw new Error('no refresh'); } });
    await p.pollAll();
    clock += 10 * 60_000;
    await p.pollAll();
    expect(pool.get('proof')!.status).toBe('active');
    expect(p.loginCheck('proof')).toBe('unavailable');
  });
});

describe('engineTrustedSignedOut: a NO counts only while the credential store is open', () => {
  const realReader = ENGINE_LOGIN_READERS['claude-code'];
  const realStore = ENGINE_CREDENTIAL_STORE_OPEN['claude-code'];
  afterEach(() => { ENGINE_LOGIN_READERS['claude-code'] = realReader; ENGINE_CREDENTIAL_STORE_OPEN['claude-code'] = realStore; });

  it('NO + store open → true; store locked or unknown → null; YES → false; unknown engine → null', async () => {
    ENGINE_LOGIN_READERS['claude-code'] = async () => ({ loggedIn: false });
    ENGINE_CREDENTIAL_STORE_OPEN['claude-code'] = async () => true;
    expect(await engineTrustedSignedOut('claude-code', '/h')).toBe(true);
    ENGINE_CREDENTIAL_STORE_OPEN['claude-code'] = async () => false;
    expect(await engineTrustedSignedOut('claude-code', '/h')).toBeNull();
    ENGINE_CREDENTIAL_STORE_OPEN['claude-code'] = async () => null;
    expect(await engineTrustedSignedOut('claude-code', '/h')).toBeNull();
    ENGINE_LOGIN_READERS['claude-code'] = async () => ({ loggedIn: true });
    expect(await engineTrustedSignedOut('claude-code', '/h')).toBe(false);
    ENGINE_LOGIN_READERS['claude-code'] = async () => ({ loggedIn: null });
    expect(await engineTrustedSignedOut('claude-code', '/h')).toBeNull();
    expect(await engineTrustedSignedOut('no-such-engine', '/h')).toBeNull();
    expect(await engineTrustedSignedOut('claude-code', '')).toBeNull();
  });
});

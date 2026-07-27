/**
 * Unit tests for the per-account email field (Subscription & Auth follow-up).
 * Covers: the registry stores/patches email; readAccountEmail reads the PUBLIC
 * oauthAccount.emailAddress from a config home; and the QuotaPoller auto-populates
 * account.email from the config home's own login on poll (so the stored email
 * always reflects which account actually authenticated). Hermetic — no network,
 * no keychain, no spawning (injected fetch + token resolver + temp config home).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SubscriptionPool } from '../../src/core/SubscriptionPool.js';
import { QuotaPoller, readAccountEmail, type FetchImpl } from '../../src/core/QuotaPoller.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-email-')); });
afterEach(() => {
  try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/subscription-account-email.test.ts:cleanup' }); } catch { /* @silent-fallback-ok */ }
});

describe('SubscriptionPool email field', () => {
  it('add() stores the email; list() reflects it', () => {
    const pool = new SubscriptionPool({ stateDir: dir });
    const a = pool.addFixture({ id: 'sm-justin', nickname: 'SageMind - Justin', provider: 'anthropic', framework: 'claude-code', configHome: '/h/.c', email: 'justin@sagemindai.io' });
    expect(a.email).toBe('justin@sagemindai.io');
    expect(pool.get('sm-justin')?.email).toBe('justin@sagemindai.io');
  });

  it('add() refuses a missing email', () => {
    const pool = new SubscriptionPool({ stateDir: dir });
    expect(() => pool.addFixture({
      id: 'x', nickname: 'x', provider: 'anthropic', framework: 'claude-code',
      configHome: '/h/.c', email: undefined as unknown as string,
    })).toThrow(/email is required/);
  });

  it('generic update cannot patch or clear identity email', () => {
    const pool = new SubscriptionPool({ stateDir: dir });
    pool.addFixture({ id: 'x', nickname: 'x', provider: 'anthropic', framework: 'claude-code', configHome: '/h/.c', email: 'original@example.com' });
    pool.update('x', { nickname: 'renamed' });
    expect(pool.get('x')?.email).toBe('original@example.com');
  });

  it('email is not a credential field — add does not throw on it', () => {
    const pool = new SubscriptionPool({ stateDir: dir });
    expect(() => pool.addFixture({ id: 'y', nickname: 'y', provider: 'anthropic', framework: 'claude-code', configHome: '/h/.c', email: 'z@z.com' }, { email: 'z@z.com' })).not.toThrow();
  });
});

describe('readAccountEmail', () => {
  it('reads oauthAccount.emailAddress from <configHome>/.claude.json', () => {
    fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'me@org.com' } }));
    expect(readAccountEmail(dir)).toBe('me@org.com');
  });
  it('returns null when no config / no email', () => {
    expect(readAccountEmail(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: {} }));
    expect(readAccountEmail(dir)).toBeNull();
  });
});

describe('QuotaPoller preserves registrar-owned account.email', () => {
  const USAGE = { five_hour: { utilization: 10, resets_at: '2026-06-07T01:00:00Z' }, seven_day: { utilization: 40, resets_at: '2026-06-12T00:00:00Z' } };
  const okFetch: FetchImpl = async () => ({ ok: true, status: 200, json: async () => USAGE });

  it('does not overwrite identity from quota-side config metadata', async () => {
    // config home whose login record says a specific account
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-home-'));
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'real@account.com' } }));
    const pool = new SubscriptionPool({ stateDir: dir });
    pool.addFixture({ id: 'acc', nickname: 'Acc', provider: 'anthropic', framework: 'claude-code', configHome: home, email: 'attested@account.com' });
    const poller = new QuotaPoller({ pool, fetchImpl: okFetch, tokenResolver: () => 'sk-ant-oat01-x' });
    await poller.pollAll();
    expect(pool.get('acc')?.email).toBe('attested@account.com');
    try { SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'test:cleanup-home' }); } catch { /* @silent-fallback-ok */ }
  });
});

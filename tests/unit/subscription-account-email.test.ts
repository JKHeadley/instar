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
    const a = pool.add({ id: 'sm-justin', nickname: 'SageMind - Justin', provider: 'anthropic', framework: 'claude-code', configHome: '/h/.c', email: 'justin@sagemindai.io' });
    expect(a.email).toBe('justin@sagemindai.io');
    expect(pool.get('sm-justin')?.email).toBe('justin@sagemindai.io');
  });

  it('add() without email leaves it undefined (back-compat)', () => {
    const pool = new SubscriptionPool({ stateDir: dir });
    const a = pool.add({ id: 'x', nickname: 'x', provider: 'anthropic', framework: 'claude-code', configHome: '/h/.c' });
    expect(a.email).toBeUndefined();
  });

  it('update() patches the email; empty string clears it', () => {
    const pool = new SubscriptionPool({ stateDir: dir });
    pool.add({ id: 'x', nickname: 'x', provider: 'anthropic', framework: 'claude-code', configHome: '/h/.c' });
    expect(pool.update('x', { email: 'a@b.com' })?.email).toBe('a@b.com');
    expect(pool.update('x', { email: '' })?.email).toBeUndefined();
  });

  it('email is not a credential field — add does not throw on it', () => {
    const pool = new SubscriptionPool({ stateDir: dir });
    expect(() => pool.add({ id: 'y', nickname: 'y', provider: 'anthropic', framework: 'claude-code', configHome: '/h/.c', email: 'z@z.com' }, { email: 'z@z.com' })).not.toThrow();
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

describe('QuotaPoller auto-populates account.email from the real login', () => {
  const USAGE = { five_hour: { utilization: 10, resets_at: '2026-06-07T01:00:00Z' }, seven_day: { utilization: 40, resets_at: '2026-06-12T00:00:00Z' } };
  const okFetch: FetchImpl = async () => ({ ok: true, status: 200, json: async () => USAGE });

  it('writes the email read from the config home onto the account', async () => {
    // config home whose login record says a specific account
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-home-'));
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'real@account.com' } }));
    const pool = new SubscriptionPool({ stateDir: dir });
    // registered with NO email (or a stale one) — poll should fill it from reality
    pool.add({ id: 'acc', nickname: 'Acc', provider: 'anthropic', framework: 'claude-code', configHome: home });
    const poller = new QuotaPoller({ pool, fetchImpl: okFetch, tokenResolver: () => 'sk-ant-oat01-x' });
    await poller.pollAll();
    expect(pool.get('acc')?.email).toBe('real@account.com');
    try { SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'test:cleanup-home' }); } catch { /* @silent-fallback-ok */ }
  });
});

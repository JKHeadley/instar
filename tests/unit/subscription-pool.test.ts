/**
 * Unit tests for SubscriptionPool (P1.1 of the Subscription & Auth Standard).
 * Module in isolation with a real filesystem (temp dir). Covers both sides of
 * every validation boundary + the never-store-credentials structural guard.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_BOUNDED_POOL_SCAN,
  SubscriptionPool,
  SubscriptionPoolUnavailableError,
  ValidationError,
} from '../../src/core/SubscriptionPool.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'subpool-'));
}

const VALID = {
  id: 'claude-acct-2',
  nickname: 'personal-max',
  provider: 'anthropic' as const,
  framework: 'claude-code' as const,
  configHome: '/Users/x/.claude-personal',
  email: 'person@example.com',
};

describe('SubscriptionPool', () => {
  let dir: string;
  let pool: SubscriptionPool;

  beforeEach(() => {
    dir = tmpDir();
    pool = new SubscriptionPool({ stateDir: dir });
  });

  afterEach(() => {
    try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/subscription-pool.test.ts:cleanup' }); } catch { /* @silent-fallback-ok: best-effort temp-dir cleanup */ }
  });

  // ── Dark default ────────────────────────────────────────────────
  it('starts empty (dark / no-op default)', () => {
    expect(pool.size()).toBe(0);
    expect(pool.list()).toEqual([]);
  });

  // ── add: happy path ─────────────────────────────────────────────
  it('adds a valid account and persists it', () => {
    const a = pool.addFixture({ ...VALID });
    expect(a.id).toBe('claude-acct-2');
    expect(a.status).toBe('active');     // default
    expect(a.version).toBe(1);
    expect(a.lastQuota).toBeNull();
    expect(typeof a.enrolledAt).toBe('string');
    expect(pool.size()).toBe(1);

    // Persisted to disk and reloadable
    const reloaded = new SubscriptionPool({ stateDir: dir });
    expect(reloaded.get('claude-acct-2')?.nickname).toBe('personal-max');
  });

  it('stores configHome (the login location), never tokens', () => {
    const a = pool.addFixture({ ...VALID });
    const raw = fs.readFileSync(path.join(dir, 'subscription-pool.json'), 'utf-8');
    expect(a.configHome).toBe('/Users/x/.claude-personal');
    // No credential-ish keys ever land in the persisted file.
    expect(raw.toLowerCase()).not.toContain('accesstoken');
    expect(raw.toLowerCase()).not.toContain('refreshtoken');
  });

  // ── add: validation — both sides of each boundary ───────────────
  it('refuses to create an account without a provider identity email', () => {
    expect(() => pool.addFixture({ ...VALID, email: undefined as unknown as string })).toThrow(/email is required/);
    expect(() => pool.addFixture({ ...VALID, email: 'not-an-email' })).toThrow(/valid non-blank/);
  });
  it('rejects a missing id', () => {
    expect(() => pool.addFixture({ ...VALID, id: '' })).toThrow(ValidationError);
  });

  it('rejects an id with illegal charset, accepts a clean one', () => {
    expect(() => pool.addFixture({ ...VALID, id: 'Has Space' })).toThrow(/\^\[a-z0-9-\]/);
    expect(() => pool.addFixture({ ...VALID, id: 'UPPER' })).toThrow(ValidationError);
    expect(pool.addFixture({ ...VALID, id: 'ok-123' }).id).toBe('ok-123');
  });

  it('rejects a duplicate id', () => {
    pool.addFixture({ ...VALID });
    expect(() => pool.addFixture({ ...VALID })).toThrow(/already exists/);
  });

  it('rejects a missing nickname', () => {
    expect(() => pool.addFixture({ ...VALID, nickname: '   ' })).toThrow(/nickname is required/);
  });

  it('rejects an unknown provider, accepts a known one', () => {
    expect(() => pool.addFixture({ ...VALID, provider: 'bogus' as any })).toThrow(/provider must be/);
    expect(pool.addFixture({ ...VALID, id: 'p1', provider: 'openai' }).provider).toBe('openai');
  });

  it('rejects an unknown framework, accepts a known one', () => {
    expect(() => pool.addFixture({ ...VALID, framework: 'bogus' as any })).toThrow(/framework must be/);
    expect(pool.addFixture({ ...VALID, id: 'f1', framework: 'pi-cli' }).framework).toBe('pi-cli');
  });

  it('rejects a missing configHome', () => {
    expect(() => pool.addFixture({ ...VALID, configHome: '' })).toThrow(/configHome is required/);
  });

  it('rejects an unknown status, accepts a known one', () => {
    expect(() => pool.addFixture({ ...VALID, status: 'bogus' as any })).toThrow(/status must be/);
    expect(pool.addFixture({ ...VALID, id: 's1', status: 'disabled' }).status).toBe('disabled');
  });

  // ── the never-store-credentials structural guard ────────────────
  it('rejects any credential-bearing field (accessToken/refreshToken/token/secret/...)', () => {
    for (const bad of ['accessToken', 'refreshToken', 'token', 'apiKey', 'secret', 'password', 'oauth', 'credentials']) {
      expect(() =>
        pool.addFixture({ ...VALID, id: 'cred' }, { ...VALID, [bad]: 'sk-leak' }),
      ).toThrow(/never credentials/);
    }
    // None of the rejected attempts persisted anything.
    expect(pool.size()).toBe(0);
  });

  // ── update: happy + CAS + immutability + validation ─────────────
  it('updates mutable fields and bumps version (CAS)', () => {
    pool.addFixture({ ...VALID });
    const u = pool.update('claude-acct-2', { nickname: 'renamed', status: 'rate-limited' });
    expect(u?.nickname).toBe('renamed');
    expect(u?.status).toBe('rate-limited');
    expect(u?.version).toBe(2);   // bumped from 1
  });

  it('excludes identity-drifted accounts from local execution until self-closed', () => {
    pool.addFixture({ ...VALID });
    pool.update(VALID.id, {
      identityDrifted: true,
      identityDrift: {
        expectedAccountId: VALID.id, actualAccountId: 'other', slot: VALID.configHome,
        detectedAt: '2026-01-01T00:00:00.000Z', lastConfirmedAt: '2026-01-01T00:00:00.000Z',
        repairState: 'planned',
      },
    });
    expect(pool.locallyExecutable()).toEqual([]);
    pool.update(VALID.id, { identityDrifted: false, identityDrift: null });
    expect(pool.locallyExecutable().map((a) => a.id)).toEqual([VALID.id]);
  });

  it('unconfigured authority permits safe reads and first-create, but no other mutation', () => {
    expect(pool.get('nope')).toBeNull();
    expect(() => pool.update('nope', { nickname: 'x' })).toThrow(SubscriptionPoolUnavailableError);
    pool.addFixture({ ...VALID });
    expect(pool.update('nope', { nickname: 'x' })).toBeNull();
  });

  it('update rejects an empty nickname and bad enum values', () => {
    pool.addFixture({ ...VALID });
    expect(() => pool.update('claude-acct-2', { nickname: '  ' })).toThrow(/cannot be empty/);
    expect(() => pool.update('claude-acct-2', { status: 'bogus' as any })).toThrow(/status must be/);
    expect(() => pool.update('claude-acct-2', { configHome: '' })).toThrow(/cannot be empty/);
  });

  it('update rejects credential-bearing input', () => {
    pool.addFixture({ ...VALID });
    expect(() =>
      pool.update('claude-acct-2', { nickname: 'x' }, { nickname: 'x', token: 'sk-leak' }),
    ).toThrow(/never credentials/);
  });

  it('update can carry a lastQuota snapshot (P1.2 forward-compat)', () => {
    pool.addFixture({ ...VALID });
    const u = pool.update('claude-acct-2', {
      lastQuota: {
        fiveHour: { utilizationPct: 10, resetsAt: '2026-06-07T00:20:00Z' },
        sevenDay: { utilizationPct: 71, resetsAt: '2026-06-12T18:59:59Z' },
        source: 'oauth-usage-endpoint-fallback',
      },
    });
    expect(u?.lastQuota?.sevenDay?.utilizationPct).toBe(71);
  });

  // ── remove ──────────────────────────────────────────────────────
  it('removes an account; returns false for an unknown id', () => {
    pool.addFixture({ ...VALID });
    expect(pool.remove('claude-acct-2')).toBe(true);
    expect(pool.size()).toBe(0);
    expect(pool.remove('claude-acct-2')).toBe(false);
  });

  // ── health ──────────────────────────────────────────────────────
  it('reports health with usable counts', () => {
    pool.addFixture({ ...VALID, id: 'a', status: 'active' });
    pool.addFixture({ ...VALID, id: 'b', status: 'disabled' });
    const h = pool.getHealth();
    expect(h.status).toBe('healthy');
    expect(h.message).toContain('2 account(s)');
    expect(h.message).toContain('1 usable');
  });

  // ── authority foundation ────────────────────────────────────────
  it('advertises static v1 compatibility independently from live authority state', () => {
    expect(SubscriptionPool.getContractCapability()).toEqual({ version: 1 });
    expect(pool.getContractCapability()).toEqual({ version: 1 });
    expect(pool.getAvailability()).toEqual({
      state: 'unconfigured', reason: 'not-initialized', maintenance: null,
    });
  });

  it('fails closed on corrupt authority instead of silently publishing an empty pool', () => {
    fs.writeFileSync(path.join(dir, 'subscription-pool.json'), '{ not valid json');
    const invalid = new SubscriptionPool({ stateDir: dir });
    expect(invalid.getAvailability()).toEqual({ state: 'invalid', reason: 'parse', maintenance: null });
    expect(() => invalid.size()).toThrow(SubscriptionPoolUnavailableError);
    expect(() => invalid.list()).toThrow(SubscriptionPoolUnavailableError);
    expect(() => invalid.addFixture({ ...VALID })).toThrow(SubscriptionPoolUnavailableError);
  });

  it('rejects duplicate ids during load before publishing array or index', () => {
    const account = pool.addFixture({ ...VALID });
    const file = path.join(dir, 'subscription-pool.json');
    const store = JSON.parse(fs.readFileSync(file, 'utf8'));
    store.accounts.push({ ...account });
    fs.writeFileSync(file, JSON.stringify(store));
    const invalid = new SubscriptionPool({ stateDir: dir });
    expect(invalid.getAvailability().reason).toBe('duplicate-id');
    expect(() => invalid.get(VALID.id)).toThrow(SubscriptionPoolUnavailableError);
  });

  it('uses indexed get and a backing-prefix bounded scan with an honest examined count', () => {
    for (let i = 0; i < 6; i += 1) {
      pool.addFixture({ ...VALID, id: `acct-${i}`, email: `p${i}@example.com` });
    }
    const file = path.join(dir, 'subscription-pool.json');
    const store = JSON.parse(fs.readFileSync(file, 'utf8'));
    store.accounts[0].email = '';
    store.accounts[1].email = '   ';
    fs.writeFileSync(file, JSON.stringify(store));
    pool = new SubscriptionPool({ stateDir: dir });
    // Repair-only rows consume the prefix even though they are not publicly visible.
    const scan = pool.scanAccountsBounded(4);
    expect(scan.examined).toBe(4);
    expect(scan.truncated).toBe(true);
    expect(scan.accounts.map((account) => account.id)).toEqual(['acct-2', 'acct-3']);
    expect(pool.get('acct-5')?.id).toBe('acct-5');
    expect(pool.scanAccountsBounded(MAX_BOUNDED_POOL_SCAN + 1).examined).toBe(6);
  });

  it('uses the machine-bound authority directory for fresh production-style callers', () => {
    pool = new SubscriptionPool({ stateDir: dir, machineId: 'm_local' });
    pool.addFixture({ ...VALID });
    expect(fs.existsSync(path.join(dir, 'subscription-pool.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'state', 'subscription-pool', 'accounts.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'state', 'subscription-pool.initialized.json'))).toBe(true);
    const restarted = new SubscriptionPool({ stateDir: dir, machineId: 'm_local' });
    expect(restarted.getAvailability()).toEqual({ state: 'ready', reason: null, maintenance: null });
    expect(restarted.get(VALID.id)?.email).toBe(VALID.email);
    restarted.update(VALID.id, { nickname: 'after-restart' });
    const twiceRestarted = new SubscriptionPool({ stateDir: dir, machineId: 'm_local' });
    expect(twiceRestarted.get(VALID.id)?.nickname).toBe('after-restart');
  });

  it('reports missing machine identity as unavailable without weakening static compatibility', () => {
    pool = new SubscriptionPool({ stateDir: dir, machineId: null });
    expect(pool.getContractCapability()).toEqual({ version: 1 });
    expect(pool.getAvailability()).toEqual({
      state: 'unavailable', reason: 'machine-identity-unavailable', maintenance: null,
    });
    expect(() => pool.list()).toThrow(SubscriptionPoolUnavailableError);
  });
});

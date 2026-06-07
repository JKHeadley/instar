/**
 * Unit tests for SubscriptionPool (P1.1 of the Subscription & Auth Standard).
 * Module in isolation with a real filesystem (temp dir). Covers both sides of
 * every validation boundary + the never-store-credentials structural guard.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SubscriptionPool, ValidationError } from '../../src/core/SubscriptionPool.js';
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
    const a = pool.add({ ...VALID });
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
    const a = pool.add({ ...VALID });
    const raw = fs.readFileSync(path.join(dir, 'subscription-pool.json'), 'utf-8');
    expect(a.configHome).toBe('/Users/x/.claude-personal');
    // No credential-ish keys ever land in the persisted file.
    expect(raw.toLowerCase()).not.toContain('accesstoken');
    expect(raw.toLowerCase()).not.toContain('refreshtoken');
  });

  // ── add: validation — both sides of each boundary ───────────────
  it('rejects a missing id', () => {
    expect(() => pool.add({ ...VALID, id: '' })).toThrow(ValidationError);
  });

  it('rejects an id with illegal charset, accepts a clean one', () => {
    expect(() => pool.add({ ...VALID, id: 'Has Space' })).toThrow(/\^\[a-z0-9-\]/);
    expect(() => pool.add({ ...VALID, id: 'UPPER' })).toThrow(ValidationError);
    expect(pool.add({ ...VALID, id: 'ok-123' }).id).toBe('ok-123');
  });

  it('rejects a duplicate id', () => {
    pool.add({ ...VALID });
    expect(() => pool.add({ ...VALID })).toThrow(/already exists/);
  });

  it('rejects a missing nickname', () => {
    expect(() => pool.add({ ...VALID, nickname: '   ' })).toThrow(/nickname is required/);
  });

  it('rejects an unknown provider, accepts a known one', () => {
    expect(() => pool.add({ ...VALID, provider: 'bogus' as any })).toThrow(/provider must be/);
    expect(pool.add({ ...VALID, id: 'p1', provider: 'openai' }).provider).toBe('openai');
  });

  it('rejects an unknown framework, accepts a known one', () => {
    expect(() => pool.add({ ...VALID, framework: 'bogus' as any })).toThrow(/framework must be/);
    expect(pool.add({ ...VALID, id: 'f1', framework: 'pi-cli' }).framework).toBe('pi-cli');
  });

  it('rejects a missing configHome', () => {
    expect(() => pool.add({ ...VALID, configHome: '' })).toThrow(/configHome is required/);
  });

  it('rejects an unknown status, accepts a known one', () => {
    expect(() => pool.add({ ...VALID, status: 'bogus' as any })).toThrow(/status must be/);
    expect(pool.add({ ...VALID, id: 's1', status: 'disabled' }).status).toBe('disabled');
  });

  // ── the never-store-credentials structural guard ────────────────
  it('rejects any credential-bearing field (accessToken/refreshToken/token/secret/...)', () => {
    for (const bad of ['accessToken', 'refreshToken', 'token', 'apiKey', 'secret', 'password', 'oauth', 'credentials']) {
      expect(() =>
        pool.add({ ...VALID, id: 'cred' }, { ...VALID, [bad]: 'sk-leak' }),
      ).toThrow(/never credentials/);
    }
    // None of the rejected attempts persisted anything.
    expect(pool.size()).toBe(0);
  });

  // ── update: happy + CAS + immutability + validation ─────────────
  it('updates mutable fields and bumps version (CAS)', () => {
    pool.add({ ...VALID });
    const u = pool.update('claude-acct-2', { nickname: 'renamed', status: 'rate-limited' });
    expect(u?.nickname).toBe('renamed');
    expect(u?.status).toBe('rate-limited');
    expect(u?.version).toBe(2);   // bumped from 1
  });

  it('update returns null for an unknown id', () => {
    expect(pool.update('nope', { nickname: 'x' })).toBeNull();
  });

  it('update rejects an empty nickname and bad enum values', () => {
    pool.add({ ...VALID });
    expect(() => pool.update('claude-acct-2', { nickname: '  ' })).toThrow(/cannot be empty/);
    expect(() => pool.update('claude-acct-2', { status: 'bogus' as any })).toThrow(/status must be/);
    expect(() => pool.update('claude-acct-2', { configHome: '' })).toThrow(/cannot be empty/);
  });

  it('update rejects credential-bearing input', () => {
    pool.add({ ...VALID });
    expect(() =>
      pool.update('claude-acct-2', { nickname: 'x' }, { nickname: 'x', token: 'sk-leak' }),
    ).toThrow(/never credentials/);
  });

  it('update can carry a lastQuota snapshot (P1.2 forward-compat)', () => {
    pool.add({ ...VALID });
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
    pool.add({ ...VALID });
    expect(pool.remove('claude-acct-2')).toBe(true);
    expect(pool.size()).toBe(0);
    expect(pool.remove('claude-acct-2')).toBe(false);
  });

  // ── health ──────────────────────────────────────────────────────
  it('reports health with usable counts', () => {
    pool.add({ ...VALID, id: 'a', status: 'active' });
    pool.add({ ...VALID, id: 'b', status: 'disabled' });
    const h = pool.getHealth();
    expect(h.status).toBe('healthy');
    expect(h.message).toContain('2 account(s)');
    expect(h.message).toContain('1 usable');
  });

  // ── corruption resilience ───────────────────────────────────────
  it('starts fresh on a corrupt store file (loses no credentials — there are none)', () => {
    fs.writeFileSync(path.join(dir, 'subscription-pool.json'), '{ not valid json');
    const fresh = new SubscriptionPool({ stateDir: dir });
    expect(fresh.size()).toBe(0);
    // And is writable again afterwards.
    expect(fresh.add({ ...VALID }).id).toBe('claude-acct-2');
  });
});

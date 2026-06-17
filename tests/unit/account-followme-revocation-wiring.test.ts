/**
 * WS5.2 R12 wiring unit tests — the REAL deps the server constructs for AccountFollowMeRevocation:
 *   - buildCooperativeWipe (accountFollowMeCooperativeWipe.ts): the three-step local wipe over a
 *     real SubscriptionPool, fail-closed per step (a throw → false, never a silent true).
 *   - DurablePendingWipeStore (AccountFollowMeRevocationStore.ts): a crash-safe JSON ledger that
 *     survives a restart (a fresh store re-loads from disk).
 *
 * These are the deps a pure-executor unit test cannot exercise; the wiring-integrity standard
 * requires every injected dep to be proven non-null AND a real implementation (not a no-op).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SubscriptionPool } from '../../src/core/SubscriptionPool.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { buildCooperativeWipe, isProtectedConfigHome } from '../../src/core/accountFollowMeCooperativeWipe.js';
import { DurablePendingWipeStore } from '../../src/core/AccountFollowMeRevocationStore.js';
import { AccountFollowMeRevocation } from '../../src/core/AccountFollowMeRevocation.js';
import type { PendingWipeRecord } from '../../src/core/AccountFollowMeRevocation.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-revoke-wiring-'));
});
afterEach(() => {
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'test-cleanup' });
});

function poolWithAccount(): SubscriptionPool {
  const pool = new SubscriptionPool({ stateDir: dir });
  pool.add({
    id: 'acct-x',
    nickname: 'SageMind - Justin',
    email: 'justin@example.com',
    provider: 'anthropic',
    framework: 'claude-code',
    configHome: path.join(dir, 'home-acct-x'),
  });
  return pool;
}

const req = {
  accountId: 'acct-x',
  accountEmail: 'justin@example.com',
  targetMachineId: 'machine-self',
  targetMachineNickname: 'the mini',
  provider: 'anthropic',
  mandateId: 'MND-1',
} as const;

describe('buildCooperativeWipe — real SubscriptionPool, fail-closed per step', () => {
  it('a clean wipe returns all-true AND actually removes the account from the pool', () => {
    const pool = poolWithAccount();
    const wipe = buildCooperativeWipe({
      pool,
      frameworkLogout: () => true,
      deleteSlot: () => true,
    });
    const r = wipe(req);
    expect(r).toEqual({ loggedOut: true, slotDeleted: true, poolRemoved: true });
    // poolRemoved is a REAL effect, not a no-op: the account is gone.
    expect(pool.get('acct-x')).toBeNull();
  });

  it('a logout that THROWS is fail-closed to loggedOut:false (never a silent true)', () => {
    const pool = poolWithAccount();
    const wipe = buildCooperativeWipe({
      pool,
      frameworkLogout: () => { throw new Error('logout CLI exploded'); },
      deleteSlot: () => true,
    });
    const r = wipe(req);
    expect(r.loggedOut).toBe(false);
  });

  it('a slot delete that returns false yields slotDeleted:false (partial → not removed)', () => {
    const pool = poolWithAccount();
    const wipe = buildCooperativeWipe({
      pool,
      frameworkLogout: () => true,
      deleteSlot: () => false,
    });
    const r = wipe(req);
    expect(r.slotDeleted).toBe(false);
    // pool.remove still runs (independent step) but the executor will treat the partial as pending.
    expect(r.loggedOut).toBe(true);
  });

  it('an unknown local account = nothing to wipe here (all false)', () => {
    const pool = new SubscriptionPool({ stateDir: dir });
    const wipe = buildCooperativeWipe({ pool, frameworkLogout: () => true, deleteSlot: () => true });
    const r = wipe(req);
    expect(r).toEqual({ loggedOut: false, slotDeleted: false, poolRemoved: false });
  });

  it('the default deleteSlot really removes the config-home directory via SafeFsExecutor', () => {
    const pool = poolWithAccount();
    const home = path.join(dir, 'home-acct-x');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'token.json'), '{}');
    // Real deleteSlot (default), stub only the logout so we don't spawn a CLI.
    const wipe = buildCooperativeWipe({ pool, frameworkLogout: () => true });
    const r = wipe(req);
    expect(r.slotDeleted).toBe(true);
    expect(fs.existsSync(home)).toBe(false);
  });
});

describe('DurablePendingWipeStore — survives a restart', () => {
  const rec: PendingWipeRecord = {
    accountId: 'acct-x',
    targetMachineId: 'machine-self',
    mandateId: 'MND-1',
    provider: 'anthropic',
    accountEmail: 'justin@example.com',
    targetMachineNickname: 'the mini',
    mechanism: 're-mint',
    revokedAt: 1000,
    deadlineAt: 5000,
  };

  it('put → a NEW store instance reads it back from disk (durable, not in-memory)', () => {
    const s1 = new DurablePendingWipeStore({ stateDir: dir });
    s1.put(rec);
    const s2 = new DurablePendingWipeStore({ stateDir: dir });
    expect(s2.get('acct-x', 'machine-self')).toEqual(rec);
    expect(s2.all()).toHaveLength(1);
  });

  it('remove → a NEW store instance no longer sees it', () => {
    const s1 = new DurablePendingWipeStore({ stateDir: dir });
    s1.put(rec);
    s1.remove('acct-x', 'machine-self');
    const s2 = new DurablePendingWipeStore({ stateDir: dir });
    expect(s2.get('acct-x', 'machine-self')).toBeUndefined();
  });

  it('a corrupt ledger file is treated as empty (fail-safe, never throws on load)', () => {
    fs.writeFileSync(path.join(dir, 'account-follow-me-revocation-pending.json'), 'not json{');
    const s = new DurablePendingWipeStore({ stateDir: dir });
    expect(s.all()).toEqual([]);
  });
});

describe('executor + real deps end-to-end (the composed wiring)', () => {
  it('cooperative-online clean wipe → removed, account gone, durable store untouched', () => {
    const pool = poolWithAccount();
    const store = new DurablePendingWipeStore({ stateDir: dir });
    const rev = new AccountFollowMeRevocation({
      enabled: () => true,
      cooperativeWipe: buildCooperativeWipe({ pool, frameworkLogout: () => true, deleteSlot: () => true }),
      pendingStore: store,
      emitRevocationFailed: () => {},
      reconnectDeadlineMs: () => 60_000,
    });
    const out = rev.revoke(req, 'cooperative-online');
    expect(out.state).toBe('removed');
    expect(pool.get('acct-x')).toBeNull();
    expect(store.all()).toHaveLength(0);
  });

  it('a partial wipe is fail-closed to pending in the DURABLE store (never falsely removed)', () => {
    const pool = poolWithAccount();
    const store = new DurablePendingWipeStore({ stateDir: dir });
    const rev = new AccountFollowMeRevocation({
      enabled: () => true,
      cooperativeWipe: buildCooperativeWipe({ pool, frameworkLogout: () => false, deleteSlot: () => true }),
      pendingStore: store,
      emitRevocationFailed: () => {},
      reconnectDeadlineMs: () => 60_000,
    });
    const out = rev.revoke(req, 'cooperative-online');
    expect(out.state).toBe('revocation-pending');
    // Durable: a fresh store sees the pending record.
    expect(new DurablePendingWipeStore({ stateDir: dir }).get('acct-x', 'machine-self')).toBeTruthy();
  });
});

describe('deletion-safety guard — never recursively delete a shared/default/root home', () => {
  it('isProtectedConfigHome refuses catastrophic targets', () => {
    expect(isProtectedConfigHome('/')).toBe(true);
    expect(isProtectedConfigHome(os.homedir())).toBe(true);
    expect(isProtectedConfigHome('~')).toBe(true); // expands to $HOME
    expect(isProtectedConfigHome(path.dirname(os.homedir()))).toBe(true); // ancestor of $HOME (e.g. /Users)
    expect(isProtectedConfigHome('~/.claude')).toBe(true); // operator's PRIMARY claude login
    expect(isProtectedConfigHome(path.join(os.homedir(), '.claude'))).toBe(true);
    expect(isProtectedConfigHome('~/.codex')).toBe(true);
    expect(isProtectedConfigHome('~/.gemini')).toBe(true);
    expect(isProtectedConfigHome('~/.CLAUDE')).toBe(true); // case-insensitive volume: same dir as ~/.claude
    expect(isProtectedConfigHome('~/.claude/')).toBe(true); // trailing slash
    expect(isProtectedConfigHome('~/.claude/../.claude')).toBe(true); // traversal collapsing back
    expect(isProtectedConfigHome('')).toBe(true); // unresolvable → fail-closed
  });

  it('isProtectedConfigHome ALLOWS a genuine per-account follow-me slot', () => {
    expect(isProtectedConfigHome(path.join(os.homedir(), '.claude-adriana'))).toBe(false);
    expect(isProtectedConfigHome(path.join(os.homedir(), '.instar', 'accounts', 'adriana'))).toBe(false);
    expect(isProtectedConfigHome(path.join(os.tmpdir(), 'follow-me-acct-xyz'))).toBe(false);
  });

  it('a revoke targeting an account whose configHome is the operator PRIMARY ~/.claude NEVER deletes it and is NOT "removed"', () => {
    // Account whose configHome IS the operator's primary login (the exact catastrophic case the
    // second-pass review flagged). Uses the REAL defaultDeleteSlot (deleteSlot NOT injected) so the
    // production guard is exercised — the guard returns false BEFORE any safeRmSync, so ~/.claude is
    // never touched.
    const protectedHome = path.join(os.homedir(), '.claude');
    const pool = new SubscriptionPool({ stateDir: dir });
    pool.add({
      id: 'acct-default',
      nickname: 'Primary',
      email: 'justin@example.com',
      provider: 'anthropic',
      framework: 'claude-code',
      configHome: protectedHome,
    });
    const wipe = buildCooperativeWipe({ pool, frameworkLogout: () => true }); // real deleteSlot
    const r = wipe({ ...req, accountId: 'acct-default' });
    expect(r.slotDeleted).toBe(false); // refused — never deleted
    // Fail-closed end-to-end: the executor must NOT report "removed" for a refused wipe.
    const store = new DurablePendingWipeStore({ stateDir: dir });
    const rev = new AccountFollowMeRevocation({
      enabled: () => true,
      cooperativeWipe: wipe,
      pendingStore: store,
      emitRevocationFailed: () => {},
      reconnectDeadlineMs: () => 60_000,
    });
    const out = rev.revoke({ ...req, accountId: 'acct-default' }, 'cooperative-online');
    expect(out.state).not.toBe('removed');
  });
});

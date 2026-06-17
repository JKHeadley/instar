/**
 * WS5.2 §6.2 — the `locallyExecutable` selection gate.
 *
 * An account is executable on THIS machine iff this machine holds it with a real
 * local `configHome` AND a valid login (active/warming). A credential-less meta
 * projection replicated in from a peer (empty `configHome`) must be invisible to
 * every account-selection / swap-target / placement path — closing the force-mode
 * "use an account I have metadata for but no credential" hole at SELECTION time.
 *
 * Wiring-integrity: a meta-only account is provably UNSELECTABLE by `selectAccount`
 * and is excluded from `poolHeadroom`, preserving the never-loop invariant
 * (`placeable ⟺ selectAccount(...) !== null`).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SubscriptionPool,
  isLocallyExecutable,
  type SubscriptionAccount,
} from '../../src/core/SubscriptionPool.js';
import { selectAccount, poolHeadroom } from '../../src/core/QuotaAwareScheduler.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const NOW = Date.parse('2026-06-17T00:00:00Z');

function acct(
  id: string,
  over: Partial<SubscriptionAccount> = {},
): SubscriptionAccount {
  return {
    id,
    nickname: id,
    provider: 'anthropic',
    framework: 'claude-code',
    configHome: `/h/.claude-${id}`,
    status: 'active',
    lastQuota: null,
    enrolledAt: '2026-06-01T00:00:00Z',
    version: 1,
    ...over,
  };
}

describe('WS5.2 §6.2 isLocallyExecutable predicate', () => {
  it('TRUE for a held account with a real configHome and a valid login', () => {
    expect(isLocallyExecutable(acct('a', { status: 'active' }))).toBe(true);
    expect(isLocallyExecutable(acct('b', { status: 'warming' }))).toBe(true);
  });

  it('FALSE for a meta-only account (empty / whitespace configHome) even when active', () => {
    expect(isLocallyExecutable(acct('meta', { configHome: '', status: 'active' }))).toBe(false);
    expect(isLocallyExecutable(acct('meta2', { configHome: '   ', status: 'active' }))).toBe(false);
  });

  it('FALSE for an invalid login even with a real configHome', () => {
    expect(isLocallyExecutable(acct('r', { status: 'needs-reauth' }))).toBe(false);
    expect(isLocallyExecutable(acct('d', { status: 'disabled' }))).toBe(false);
    expect(isLocallyExecutable(acct('l', { status: 'rate-limited' }))).toBe(false);
  });
});

describe('WS5.2 §6.2 selectAccount excludes meta-only accounts', () => {
  it('never selects a credential-less meta account, even if it is the only "active" one', () => {
    const metaOnly = acct('peer-meta', { configHome: '', status: 'active' });
    expect(selectAccount([metaOnly], { nowMs: NOW })).toBeNull();
  });

  it('picks the real local account over a meta-only peer account', () => {
    const metaOnly = acct('peer-meta', { configHome: '', status: 'active' });
    const real = acct('local-real', { status: 'active' });
    const picked = selectAccount([metaOnly, real], { nowMs: NOW });
    expect(picked?.id).toBe('local-real');
  });

  it('genuinely-held accounts are unaffected (pure tightening — no regression)', () => {
    const a = acct('a', { status: 'active' });
    const b = acct('b', { status: 'warming' });
    expect(selectAccount([a, b], { nowMs: NOW })).not.toBeNull();
  });
});

describe('WS5.2 §6.2 poolHeadroom shares the predicate (never-loop invariant)', () => {
  it('placeable:false when the only account is meta-only — matching selectAccount() === null', () => {
    const metaOnly = acct('peer-meta', { configHome: '', status: 'active' });
    expect(poolHeadroom([metaOnly], { nowMs: NOW }).placeable).toBe(false);
    expect(selectAccount([metaOnly], { nowMs: NOW })).toBeNull();
  });

  it('placeable:true when a real account exists — matching selectAccount() !== null', () => {
    const metaOnly = acct('peer-meta', { configHome: '', status: 'active' });
    const real = acct('local-real', { status: 'active' });
    expect(poolHeadroom([metaOnly, real], { nowMs: NOW }).placeable).toBe(true);
    expect(selectAccount([metaOnly, real], { nowMs: NOW })).not.toBeNull();
  });
});

describe('WS5.2 §6.2 SubscriptionPool.locallyExecutable()', () => {
  let dir: string;
  let pool: SubscriptionPool;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subpool-le-'));
    pool = new SubscriptionPool({ stateDir: dir });
  });
  afterEach(() => {
    try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/account-follow-me-locally-executable.test.ts:cleanup' }); } catch { /* @silent-fallback-ok: best-effort temp-dir cleanup */ }
  });

  it('returns only accounts with a valid login (a real pool account always has a configHome)', () => {
    pool.add({ id: 'a', nickname: 'a', provider: 'anthropic', framework: 'claude-code', configHome: '/h/.claude-a', status: 'active' });
    pool.add({ id: 'b', nickname: 'b', provider: 'anthropic', framework: 'claude-code', configHome: '/h/.claude-b', status: 'needs-reauth' });
    const ex = pool.locallyExecutable();
    expect(ex.map((a) => a.id)).toEqual(['a']);
  });
});

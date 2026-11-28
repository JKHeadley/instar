// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import type { SubscriptionAccount, SubscriptionPool } from '../../../src/core/SubscriptionPool.js';
import type { CodexUsageSnapshot } from '../../../src/providers/adapters/openai-codex/observability/codexRateLimitReader.js';
import { FeedbackTriageAccountSelector } from '../../../src/feedback-factory/triage/FeedbackTriageAccountSelector.js';
import {
  buildReadinessAccountAdmission, resolveReadinessAccountConfig, type ReadinessAccountConfig,
} from '../../../src/feedback-factory/drain/readinessAccountAdmission.js';

const NOW = Date.parse('2026-11-26T09:00:00Z');
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => SafeFsExecutor.safeRmSync(dir, {
  recursive: true, force: true, operation: 'readiness-account-admission.test.ts',
})));

function account(id: string, status: SubscriptionAccount['status'] = 'active'): SubscriptionAccount {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'readiness-codex-'));
  dirs.push(home);
  const email = `${id}@example.test`;
  const token = `x.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.x`;
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ tokens: { id_token: token, account_id: id } }));
  return { id, nickname: id, email, provider: 'openai', framework: 'codex-cli',
    configHome: home, status, enrolledAt: new Date(NOW).toISOString(), version: 1 } as SubscriptionAccount;
}

const pool = (accounts: SubscriptionAccount[]): SubscriptionPool => ({ list: () => accounts }) as unknown as SubscriptionPool;

function snapshot(used: number): CodexUsageSnapshot {
  const window = { usedPercent: used, remainingPercent: 100 - used, windowMinutes: 10080, resetsAt: 1795909829, resetsAtIso: null, resetsInSeconds: null };
  return { source: 'codex-app-server', rolloutPath: '', threadId: null, capturedAt: new Date(NOW).toISOString(), model: null,
    planType: 'pro', rateLimitReachedType: null, primary: window, secondary: null };
}

function harness(accounts: SubscriptionAccount[], used: Record<string, number | null>, config: ReadinessAccountConfig) {
  const roster = pool(accounts);
  const reads: string[] = [];
  const selector = new FeedbackTriageAccountSelector(roster, async ({ codexHome }) => {
    const entry = accounts.find((a) => a.configHome === codexHome)!;
    reads.push(entry.id);
    const value = used[entry.id];
    return value === null || value === undefined ? null : snapshot(value);
  }, () => NOW);
  const admission = buildReadinessAccountAdmission({ config: () => config, selector, pool: roster, clock: () => NOW });
  return { admission, reads, roster };
}

describe('resolveReadinessAccountConfig', () => {
  it('defaults to off with no pin, and follows the triage selection mode', () => {
    expect(resolveReadinessAccountConfig(undefined)).toEqual({ mode: 'off', pinnedAccountId: null });
    expect(resolveReadinessAccountConfig({ triage: { accountSelectionMode: 'on' } })).toEqual({ mode: 'on', pinnedAccountId: null });
    expect(resolveReadinessAccountConfig({ triage: { accountSelectionMode: 'bogus' } }).mode).toBe('off');
    expect(resolveReadinessAccountConfig({ readiness: { account: '  codex-justin-gmail ' } }).pinnedAccountId).toBe('codex-justin-gmail');
    expect(resolveReadinessAccountConfig({ readiness: { account: '' } }).pinnedAccountId).toBeNull();
    expect(resolveReadinessAccountConfig({ readiness: { account: 7 } }).pinnedAccountId).toBeNull();
  });
});

describe('readiness account admission', () => {
  it('off with no pin keeps the shared provider and reads no quota', async () => {
    const h = harness([account('a')], { a: 5 }, { mode: 'off', pinnedAccountId: null });
    expect(await h.admission.admit('codex-cli', NOW + 30_000)).toEqual({ kind: 'shared', reason: 'selection-off', observedAccountId: null });
    expect(h.reads).toEqual([]);
  });

  it('on uses the least-used verified account below 75%', async () => {
    const h = harness([account('dawn'), account('gmail')], { dawn: 95, gmail: 13 }, { mode: 'on', pinnedAccountId: null });
    const result = await h.admission.admit('codex-cli', NOW + 30_000);
    expect(result).toMatchObject({ kind: 'account', pinned: false, account: { accountId: 'gmail', usedPercent: 13 } });
  });

  it('on refuses, never falls back, when every account is saturated', async () => {
    const h = harness([account('dawn')], { dawn: 95 }, { mode: 'on', pinnedAccountId: null });
    expect(await h.admission.admit('codex-cli', NOW + 30_000)).toEqual({ kind: 'refused', reason: 'all-accounts-saturated', pinned: false });
  });

  it('observe records the account it would choose but stays on the shared provider', async () => {
    const h = harness([account('gmail')], { gmail: 13 }, { mode: 'observe', pinnedAccountId: null });
    expect(await h.admission.admit('codex-cli', NOW + 30_000)).toEqual({ kind: 'shared', reason: 'observe-only', observedAccountId: 'gmail' });
  });

  it('a non-codex authority provider keeps the shared provider when unpinned', async () => {
    const h = harness([account('gmail')], { gmail: 13 }, { mode: 'on', pinnedAccountId: null });
    expect(await h.admission.admit('claude-code', NOW + 30_000)).toMatchObject({ kind: 'shared', reason: 'non-codex-provider' });
  });

  it('a pin uses exactly the pinned account, even when another account has more room', async () => {
    const h = harness([account('zero'), account('gmail')], { zero: 1, gmail: 13 }, { mode: 'on', pinnedAccountId: 'gmail' });
    const result = await h.admission.admit('codex-cli', NOW + 30_000);
    expect(result).toMatchObject({ kind: 'account', pinned: true, account: { accountId: 'gmail' } });
    expect(h.reads).toEqual(['gmail']);
  });

  it('a pin applies even when the selection mode is off', async () => {
    const h = harness([account('gmail')], { gmail: 13 }, { mode: 'off', pinnedAccountId: 'gmail' });
    expect(await h.admission.admit('codex-cli', NOW + 30_000)).toMatchObject({ kind: 'account', pinned: true });
  });

  it.each([
    ['missing pinned account', [] as string[], {}, 'pinned-account-missing'],
    ['saturated pinned account', ['gmail'], { gmail: 80 }, 'pinned-account-saturated'],
    ['unreadable pinned quota', ['gmail'], { gmail: null }, 'pinned-account-quota-unreadable'],
  ] as const)('a pin refuses with a named reason: %s', async (_label, ids, used, reason) => {
    const h = harness(ids.map((id) => account(id)), used as Record<string, number | null>, { mode: 'on', pinnedAccountId: 'gmail' });
    expect(await h.admission.admit('codex-cli', NOW + 30_000)).toMatchObject({ kind: 'refused', reason, pinned: true });
  });

  // 2026-11-28, codex-amrch: two pinned refusals were most likely read timeouts under a 5 s cap.
  it('an unreadable pin says why, and retries a transient read once within the deadline', async () => {
    const h = harness([account('gmail')], { gmail: null }, { mode: 'on', pinnedAccountId: 'gmail' });
    expect(await h.admission.admit('codex-cli', NOW + 30_000)).toEqual({ kind: 'refused', reason: 'pinned-account-quota-unreadable', pinned: true, cause: 'no-snapshot', attempts: 2 });
    expect(h.reads).toEqual(['gmail', 'gmail']);
  });

  it('a pin recovers on the retry when the first live read fails', async () => {
    const acct = account('gmail');
    const roster = pool([acct]);
    let calls = 0;
    const selector = new FeedbackTriageAccountSelector(roster, async () => (++calls === 1 ? null : snapshot(20)), () => NOW);
    const admission = buildReadinessAccountAdmission({ config: () => ({ mode: 'on', pinnedAccountId: 'gmail' }), selector, pool: roster, clock: () => NOW });
    expect(await admission.admit('codex-cli', NOW + 30_000)).toMatchObject({ kind: 'account', pinned: true, account: { accountId: 'gmail', usedPercent: 20 } });
    expect(calls).toBe(2);
  });

  it('a slow read is classed as a timeout, and the retry never runs past the deadline', async () => {
    const acct = account('gmail');
    const roster = pool([acct]);
    let clock = NOW;
    const timeouts: number[] = [];
    const selector = new FeedbackTriageAccountSelector(roster, async ({ timeoutMs }) => { timeouts.push(timeoutMs); clock += timeoutMs; return null; }, () => clock);
    const admission = buildReadinessAccountAdmission({ config: () => ({ mode: 'on', pinnedAccountId: 'gmail' }), selector, pool: roster, clock: () => clock });
    const deadline = NOW + 6_000;
    expect(await admission.admit('codex-cli', deadline)).toMatchObject({ kind: 'refused', reason: 'pinned-account-quota-unreadable', cause: 'timeout', attempts: 2 });
    expect(timeouts[0]).toBe(4_200);
    expect(clock).toBeLessThanOrEqual(deadline);
    expect(timeouts.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(6_000 - 700);
  });

  it('a pin with less time than one safe read left refuses with cause deadline and reads nothing', async () => {
    const h = harness([account('gmail')], { gmail: 13 }, { mode: 'on', pinnedAccountId: 'gmail' });
    expect(await h.admission.admit('codex-cli', NOW + 500)).toEqual({ kind: 'refused', reason: 'pinned-account-quota-unreadable', pinned: true, cause: 'deadline', attempts: 0 });
    expect(h.reads).toEqual([]);
  });

  it('a non-transient failure (stale capture, rate limit reached) is not retried and keeps its class', async () => {
    const acct = account('gmail');
    const roster = pool([acct]);
    let calls = 0;
    const stale = { ...snapshot(20), capturedAt: new Date(NOW - 10 * 60_000).toISOString() };
    const selector = new FeedbackTriageAccountSelector(roster, async () => { calls++; return stale; }, () => NOW);
    const admission = buildReadinessAccountAdmission({ config: () => ({ mode: 'on', pinnedAccountId: 'gmail' }), selector, pool: roster, clock: () => NOW });
    expect(await admission.admit('codex-cli', NOW + 30_000)).toMatchObject({ cause: 'stale-capture', attempts: 1 });
    expect(calls).toBe(1);
    let calls2 = 0;
    const limited = { ...snapshot(20), rateLimitReachedType: 'primary' } as CodexUsageSnapshot;
    const s2 = new FeedbackTriageAccountSelector(roster, async () => { calls2++; return limited; }, () => NOW);
    const a2 = buildReadinessAccountAdmission({ config: () => ({ mode: 'on', pinnedAccountId: 'gmail' }), selector: s2, pool: roster, clock: () => NOW });
    expect(await a2.admit('codex-cli', NOW + 30_000)).toMatchObject({ cause: 'rate-limit-reached', attempts: 1 });
    expect(calls2).toBe(1);
  });

  it('a pinned account that is paused or signed out is refused as unverified', async () => {
    const paused = account('gmail', 'paused' as SubscriptionAccount['status']);
    const h = harness([paused], { gmail: 13 }, { mode: 'on', pinnedAccountId: 'gmail' });
    expect(await h.admission.admit('codex-cli', NOW + 30_000)).toEqual({ kind: 'refused', reason: 'pinned-account-unverified', pinned: true });
    const signedOut = account('gmail');
    fs.writeFileSync(path.join(signedOut.configHome, 'auth.json'), '{}');
    const h2 = harness([signedOut], { gmail: 13 }, { mode: 'on', pinnedAccountId: 'gmail' });
    expect(await h2.admission.admit('codex-cli', NOW + 30_000)).toEqual({ kind: 'refused', reason: 'pinned-account-unverified', pinned: true });
  });

  it('a pin refuses a non-codex authority provider and a malformed id', async () => {
    const h = harness([account('gmail')], { gmail: 13 }, { mode: 'on', pinnedAccountId: 'gmail' });
    expect(await h.admission.admit('claude-code', NOW + 30_000)).toEqual({ kind: 'refused', reason: 'pinned-account-provider-mismatch', pinned: true });
    const bad = harness([account('gmail')], { gmail: 13 }, { mode: 'on', pinnedAccountId: 'gm ail; rm' });
    expect(await bad.admission.admit('codex-cli', NOW + 30_000)).toEqual({ kind: 'refused', reason: 'pinned-account-invalid-id', pinned: true });
  });

  it('a pin with no selector available refuses instead of using the shared provider', async () => {
    const admission = buildReadinessAccountAdmission({ config: () => ({ mode: 'off', pinnedAccountId: 'gmail' }), selector: null, pool: null });
    expect(await admission.admit('codex-cli', NOW + 30_000)).toEqual({ kind: 'refused', reason: 'account-selection-unavailable', pinned: true });
  });

  it('execution identity verification detects a credential changed after the call started', async () => {
    const entry = account('gmail');
    const h = harness([entry], { gmail: 13 }, { mode: 'on', pinnedAccountId: 'gmail' });
    const result = await h.admission.admit('codex-cli', NOW + 30_000);
    if (result.kind !== 'account') throw new Error('expected an account');
    expect(h.admission.revalidate(result.account)).toBe(true);
    expect(h.admission.verifyExecutionIdentity(result.account)).toBe(true);
    fs.appendFileSync(path.join(entry.configHome, 'auth.json'), ' ');
    expect(h.admission.verifyExecutionIdentity(result.account)).toBe(false);
    expect(h.admission.revalidate(result.account)).toBe(false);
  });
});

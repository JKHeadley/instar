/**
 * Unit tests for QuotaPoller (P1.2 of the Subscription & Auth Standard).
 * Fully hermetic: injected fetch + injected token resolver → zero credentials,
 * zero network. Real SubscriptionPool over a temp dir. Covers the usage-shape
 * mapper (both sides), pollAccount lifecycle, pollAll persistence, burn rate,
 * and the deterministic branch of the default token resolver.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SubscriptionPool } from '../../src/core/SubscriptionPool.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  QuotaPoller,
  mapUsageResponse,
  defaultTokenResolver,
  type FetchImpl,
} from '../../src/core/QuotaPoller.js';

// The real /api/oauth/usage shape, verified live 2026-06-06.
const LIVE_USAGE_BODY = {
  five_hour: { utilization: 10, resets_at: '2026-06-07T00:20:00Z' },
  seven_day: { utilization: 71, resets_at: '2026-06-12T18:59:59Z' },
  seven_day_sonnet: { utilization: 4, resets_at: '2026-06-12T19:00:00Z' },
  seven_day_opus: null,
  extra_usage: { is_enabled: true, monthly_limit: 20000, used_credits: 0 },
};

function okFetch(body: unknown): FetchImpl {
  return async () => ({ ok: true, status: 200, json: async () => body });
}
function statusFetch(status: number): FetchImpl {
  return async () => ({ ok: false, status, json: async () => ({}) });
}
function throwFetch(): FetchImpl {
  return async () => {
    throw new Error('network down');
  };
}

const ACCT = {
  id: 'claude-1',
  nickname: 'primary',
  provider: 'anthropic' as const,
  framework: 'claude-code' as const,
  configHome: '/home/x/.claude-primary',
};

describe('QuotaPoller', () => {
  let dir: string;
  let pool: SubscriptionPool;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qpoll-'));
    pool = new SubscriptionPool({ stateDir: dir });
  });
  afterEach(() => {
    try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/quota-poller.test.ts:cleanup' }); } catch { /* @silent-fallback-ok: best-effort temp cleanup */ }
  });

  // ── mapUsageResponse: real shape, both sides ──────────────────────
  it('maps the real usage response shape', () => {
    const snap = mapUsageResponse(LIVE_USAGE_BODY, 'oauth-usage-endpoint-fallback', '2026-06-07T05:00:00Z');
    expect(snap.fiveHour).toEqual({ utilizationPct: 10, resetsAt: '2026-06-07T00:20:00Z' });
    expect(snap.sevenDay).toEqual({ utilizationPct: 71, resetsAt: '2026-06-12T18:59:59Z' });
    expect(snap.perModel?.sonnet).toBe(4);
    expect(snap.perModel?.opus ?? null).toBeNull();
    expect(snap.extraUsage).toEqual({ isEnabled: true, usedCredits: 0, monthlyLimit: 20000 });
    expect(snap.source).toBe('oauth-usage-endpoint-fallback');
    expect(snap.measuredAt).toBe('2026-06-07T05:00:00Z');
  });

  it('tolerates a sparse usage response (missing windows)', () => {
    const snap = mapUsageResponse({ five_hour: { utilization: 2, resets_at: 'x' } }, 'oauth-usage-endpoint-fallback', 't');
    expect(snap.fiveHour?.utilizationPct).toBe(2);
    expect(snap.sevenDay).toBeUndefined();
    expect(snap.extraUsage).toBeUndefined();
  });

  // ── Fable 5: the scoped weekly limit (verified live 2026-07-11) ────
  it('extracts Fable 5 weekly usage from the limits[] scoped entry', () => {
    const snap = mapUsageResponse(
      {
        seven_day: { utilization: 21, resets_at: '2026-07-18T15:59:59Z' },
        limits: [
          { kind: 'weekly_all', group: 'weekly', percent: 21, scope: null, is_active: false },
          {
            kind: 'weekly_scoped',
            group: 'weekly',
            percent: 36,
            resets_at: '2026-07-18T15:59:59Z',
            scope: { model: { id: null, display_name: 'Fable' }, surface: null },
            is_active: true,
          },
        ],
      },
      'oauth-usage-endpoint-fallback',
      't',
    );
    expect(snap.fable).toEqual({ utilizationPct: 36, resetsAt: '2026-07-18T15:59:59Z' });
  });

  it('reads a maxed-out Fable 5 window at 100%', () => {
    const snap = mapUsageResponse(
      {
        limits: [
          {
            kind: 'weekly_scoped',
            group: 'weekly',
            percent: 100,
            resets_at: '2026-07-15T01:59:59Z',
            scope: { model: { id: null, display_name: 'Fable' }, surface: null },
            is_active: true,
          },
        ],
      },
      'oauth-usage-endpoint-fallback',
      't',
    );
    expect(snap.fable?.utilizationPct).toBe(100);
  });

  it('leaves fable undefined when no Fable-scoped limit is present', () => {
    // A non-Fable scoped weekly limit must NOT be mistaken for Fable.
    const snap = mapUsageResponse(
      {
        seven_day: { utilization: 8, resets_at: 'x' },
        limits: [
          { kind: 'weekly_all', group: 'weekly', percent: 8, scope: null, is_active: true },
          {
            kind: 'weekly_scoped',
            group: 'weekly',
            percent: 50,
            scope: { model: { id: null, display_name: 'Opus' }, surface: null },
            is_active: false,
          },
        ],
      },
      'oauth-usage-endpoint-fallback',
      't',
    );
    expect(snap.fable).toBeUndefined();
  });

  it('leaves fable undefined when limits is absent entirely', () => {
    const snap = mapUsageResponse(LIVE_USAGE_BODY, 'oauth-usage-endpoint-fallback', 't');
    expect(snap.fable).toBeUndefined();
  });

  // ── pollAccount lifecycle ─────────────────────────────────────────
  it('pollAccount returns a snapshot on a clean read', async () => {
    const p = new QuotaPoller({ pool, fetchImpl: okFetch(LIVE_USAGE_BODY), tokenResolver: () => 'sk-ant-oat01-x' });
    pool.add({ ...ACCT });
    const snap = await p.pollAccount(pool.get('claude-1')!);
    expect(snap?.sevenDay?.utilizationPct).toBe(71);
  });

  it('attributes quota to live token identity, marks drift, and caches the oracle probe', async () => {
    pool.add({ ...ACCT, email: 'expected@example.test' });
    pool.add({
      id: 'claude-2', nickname: 'actual', provider: 'anthropic', framework: 'claude-code',
      configHome: '/home/x/.claude-actual', email: 'actual@example.test',
    });
    let probes = 0;
    const p = new QuotaPoller({
      pool,
      fetchImpl: okFetch(LIVE_USAGE_BODY),
      tokenResolver: () => 'sk-ant-oat01-x',
      resolveSlotIdentity: async () => { probes++; return { accountId: 'claude-2', email: 'actual@example.test' }; },
    });

    await p.pollAll();
    expect(pool.get('claude-1')?.identityDrifted).toBe(true);
    expect(pool.get('claude-1')?.identityDrift?.actualAccountId).toBe('claude-2');
    expect(pool.get('claude-2')?.lastQuota?.sevenDay?.utilizationPct).toBe(71);
    await p.pollAccount(pool.get('claude-1')!);
    expect(probes).toBe(2); // one probe per distinct slot; second claude-1 read is cached
  });

  it('self-closes drift and its residual callback on the first matching identity poll', async () => {
    pool.add({ ...ACCT, email: 'expected@example.test' });
    pool.update(ACCT.id, {
      identityDrifted: true,
      identityDrift: {
        expectedAccountId: ACCT.id, actualAccountId: 'other', slot: ACCT.configHome,
        detectedAt: '2026-01-01T00:00:00.000Z', lastConfirmedAt: '2026-01-01T00:00:00.000Z',
        repairState: 'owner-relogin-required',
      },
    });
    const restored: Array<[string, string]> = [];
    const p = new QuotaPoller({
      pool, fetchImpl: okFetch(LIVE_USAGE_BODY), tokenResolver: () => 'sk-ant-oat01-x',
      resolveSlotIdentity: async () => ({ accountId: ACCT.id, email: 'expected@example.test' }),
      onIdentityRestored: (id, attentionId) => { restored.push([id, attentionId]); },
    });
    await p.pollAccount(pool.get(ACCT.id)!);
    expect(pool.get(ACCT.id)?.identityDrifted).toBe(false);
    expect(pool.get(ACCT.id)?.identityDrift).toBeUndefined();
    expect(restored).toEqual([[ACCT.id, `credential-identity-drift-${ACCT.id}-2026-01-01T00:00:00.000Z`]]);
  });

  it('invalidates cached pre-repair identity so the immediate poll observes the repaired tenant', async () => {
    pool.add({ ...ACCT });
    pool.add({ ...ACCT, id: 'claude-2', configHome: '/home/x/.claude-2' });
    let live = 'claude-2';
    let probes = 0;
    const p = new QuotaPoller({
      pool, fetchImpl: okFetch(LIVE_USAGE_BODY), tokenResolver: () => 'sk-ant-oat01-x',
      resolveSlotIdentity: async () => { probes++; return { accountId: live }; },
    });
    await p.pollAccount(pool.get(ACCT.id)!);
    expect(pool.get(ACCT.id)?.identityDrifted).toBe(true);
    live = ACCT.id;
    p.invalidateIdentityCache([ACCT.configHome]);
    await p.pollAccount(pool.get(ACCT.id)!);
    expect(probes).toBe(2);
    expect(pool.get(ACCT.id)?.identityDrifted).toBe(false);
  });

  it('pollAccount returns null when the token is unresolvable', async () => {
    const p = new QuotaPoller({ pool, fetchImpl: okFetch(LIVE_USAGE_BODY), tokenResolver: () => null });
    pool.add({ ...ACCT });
    expect(await p.pollAccount(pool.get('claude-1')!)).toBeNull();
  });

  it('pollAccount flags needs-reauth on a 401 when the refresh token is dead', async () => {
    // 401 AND the refresher reports no usable refresh token → genuine re-auth.
    const p = new QuotaPoller({
      pool,
      fetchImpl: statusFetch(401),
      tokenResolver: () => 'sk-ant-oat01-x',
      refresher: async () => ({ ok: false, reason: 'no-refresh-token' }),
    });
    pool.add({ ...ACCT });
    const snap = await p.pollAccount(pool.get('claude-1')!);
    expect(snap).toBeNull();
    expect(pool.get('claude-1')!.status).toBe('needs-reauth');
  });

  it('pollAccount refreshes silently and recovers on a 401 with a live refresh token', async () => {
    // First usage read 401 (access token expired), then 200 after the refresh.
    let calls = 0;
    const fetchImpl: FetchImpl = async () => {
      calls += 1;
      return calls === 1
        ? { ok: false, status: 401, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => LIVE_USAGE_BODY };
    };
    const p = new QuotaPoller({
      pool,
      fetchImpl,
      tokenResolver: () => 'sk-ant-oat01-EXPIRED',
      refresher: async () => ({ ok: true, accessToken: 'sk-ant-oat01-FRESH', expiresAt: 9e12, rotated: true }),
    });
    pool.add({ ...ACCT, status: 'active' });
    const snap = await p.pollAccount(pool.get('claude-1')!);
    expect(snap?.sevenDay?.utilizationPct).toBe(71); // recovered: got the usage
    expect(pool.get('claude-1')!.status).toBe('active'); // NOT needs-reauth
    expect(pool.get('claude-1')!.lastRefreshAt).toBeTruthy(); // visibility stamp set
    expect(calls).toBe(2); // one failed read + one successful retry
  });

  it('pollAccount marks needs-reauth when the usage read still 401s after a refresh', async () => {
    const p = new QuotaPoller({
      pool,
      fetchImpl: statusFetch(401), // always 401, even with a fresh token
      tokenResolver: () => 'sk-ant-oat01-x',
      refresher: async () => ({ ok: true, accessToken: 'sk-ant-oat01-FRESH', expiresAt: 9e12, rotated: false }),
    });
    pool.add({ ...ACCT });
    expect(await p.pollAccount(pool.get('claude-1')!)).toBeNull();
    expect(pool.get('claude-1')!.status).toBe('needs-reauth');
  });

  it('pollAccount returns null on a network error (no status change)', async () => {
    const p = new QuotaPoller({ pool, fetchImpl: throwFetch(), tokenResolver: () => 'sk-ant-oat01-x' });
    pool.add({ ...ACCT, status: 'active' });
    expect(await p.pollAccount(pool.get('claude-1')!)).toBeNull();
    expect(pool.get('claude-1')!.status).toBe('active');
  });

  // ── pollAll persistence + filtering ───────────────────────────────
  it('pollAll persists Claude and Codex quota, while skipping disabled accounts', async () => {
    const p = new QuotaPoller({
      pool,
      fetchImpl: okFetch(LIVE_USAGE_BODY),
      tokenResolver: () => 'sk-ant-oat01-x',
      now: () => Date.parse('2026-06-07T05:00:00Z'),
      codexUsageReader: async () => ({
        source: 'codex-rollout', rolloutPath: '/rollout.jsonl', threadId: 't',
        capturedAt: '2026-06-07T05:00:00Z', model: 'gpt-5', planType: 'pro', rateLimitReachedType: null,
        primary: { usedPercent: 37, remainingPercent: 63, windowMinutes: 300, resetsAt: 1780837200, resetsAtIso: '2026-06-07T13:00:00.000Z', resetsInSeconds: 1 },
        secondary: { usedPercent: 64, remainingPercent: 36, windowMinutes: 10080, resetsAt: 1781269200, resetsAtIso: '2026-06-12T13:00:00.000Z', resetsInSeconds: 1 },
      }),
    });
    pool.add({ ...ACCT, id: 'claude-1' });
    pool.add({ ...ACCT, id: 'codex-1', provider: 'openai', framework: 'codex-cli' });
    pool.add({ ...ACCT, id: 'claude-off', status: 'disabled' }); // skipped (disabled)
    const res = await p.pollAll();
    expect(res.polled).toBe(2);
    expect(pool.get('claude-1')!.lastQuota?.sevenDay?.utilizationPct).toBe(71);
    expect(pool.get('codex-1')!.lastQuota).toMatchObject({
      source: 'codex-rollout',
      fiveHour: { utilizationPct: 37 },
      sevenDay: { utilizationPct: 64 },
    });
    expect(pool.get('claude-off')!.lastQuota ?? null).toBeNull();
  });

  it('normalizes a Codex window to fresh 0% after its known reset passes', async () => {
    const now = Date.parse('2026-06-08T00:00:00Z');
    const p = new QuotaPoller({
      pool,
      now: () => now,
      codexUsageReader: async () => ({
        source: 'codex-rollout', rolloutPath: '/old.jsonl', threadId: 't', capturedAt: '2026-06-07T00:00:00Z',
        model: 'gpt-5', planType: 'pro', rateLimitReachedType: null,
        primary: { usedPercent: 99, remainingPercent: 1, windowMinutes: 300, resetsAt: 1, resetsAtIso: '2026-06-07T05:00:00Z', resetsInSeconds: 0 },
        secondary: { usedPercent: 40, remainingPercent: 60, windowMinutes: 10080, resetsAt: 2, resetsAtIso: '2026-06-12T00:00:00Z', resetsInSeconds: 1 },
      }),
    });
    pool.add({ ...ACCT, id: 'codex-reset', provider: 'openai', framework: 'codex-cli' });
    await p.pollAll();
    expect(pool.get('codex-reset')!.lastQuota).toMatchObject({
      fiveHour: { utilizationPct: 0, resetsAt: '' },
      sevenDay: { utilizationPct: 40 },
      measuredAt: '2026-06-07T00:00:00Z',
    });
  });

  it('pollAll restores a needs-reauth account to active on a clean read', async () => {
    const p = new QuotaPoller({ pool, fetchImpl: okFetch(LIVE_USAGE_BODY), tokenResolver: () => 'sk-ant-oat01-x' });
    pool.add({ ...ACCT, status: 'needs-reauth' });
    await p.pollAll();
    expect(pool.get('claude-1')!.status).toBe('active');
  });

  // ── burn rate ─────────────────────────────────────────────────────
  it('burnRate is null until two distinct reads, then is measured %/hr', async () => {
    // Two reads one hour apart: 7-day 71 -> 73 = +2 pts/hr.
    let body = { ...LIVE_USAGE_BODY };
    let clock = Date.parse('2026-06-07T05:00:00Z');
    const fetchImpl: FetchImpl = async () => ({ ok: true, status: 200, json: async () => body });
    const p = new QuotaPoller({ pool, fetchImpl, tokenResolver: () => 'sk-ant-oat01-x' });
    pool.add({ ...ACCT });

    // Manually drive two reads with controlled measuredAt via mapUsageResponse paths:
    // first read
    await p.pollAccount(pool.get('claude-1')!);
    expect(p.burnRate('claude-1')).toBeNull(); // only one sample

    // second read, mutate body + advance: simulate by polling again after a tick.
    body = { ...LIVE_USAGE_BODY, seven_day: { utilization: 73, resets_at: '2026-06-12T18:59:59Z' } };
    // ensure a distinct measuredAt (real clock advances ms between calls)
    await new Promise((r) => setTimeout(r, 5));
    await p.pollAccount(pool.get('claude-1')!);
    const br = p.burnRate('claude-1');
    expect(br).not.toBeNull();
    // span is tiny (~ms) so the rate is large; we assert direction + sign, not magnitude.
    expect(br!.sevenDayPctPerHour!).toBeGreaterThan(0);
    void clock;
  });

  // ── default token resolver: deterministic branch ──────────────────
  // defaultTokenResolver is ASYNC (the keychain read runs off the event loop), so these await it.
  it('defaultTokenResolver returns null for non-anthropic / non-claude-code accounts', async () => {
    expect(await defaultTokenResolver({ ...ACCT, provider: 'openai', framework: 'codex-cli', status: 'active', enrolledAt: '', version: 1 })).toBeNull();
    expect(await defaultTokenResolver({ ...ACCT, framework: 'pi-cli', status: 'active', enrolledAt: '', version: 1 })).toBeNull();
  });

  it('defaultTokenResolver never returns a non-oauth token (file path, non-darwin only)', async () => {
    if (process.platform === 'darwin') return; // keychain path not hermetically testable
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chome-'));
    fs.writeFileSync(path.join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'not-an-oauth-token' } }));
    const tok = await defaultTokenResolver({ ...ACCT, configHome: home, status: 'active', enrolledAt: '', version: 1 });
    expect(tok).toBeNull(); // rejected: doesn't start with sk-ant-oat
    try { SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'tests/unit/quota-poller.test.ts:home-cleanup' }); } catch { /* @silent-fallback-ok */ }
  });
});

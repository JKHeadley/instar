import { describe, it, expect, vi, afterEach } from 'vitest';
import { selectRoutineCodexAccount, routineCodexReviewLease } from '../../src/core/routineCodexPlacement.js';
import type { SubscriptionAccount } from '../../src/core/SubscriptionPool.js';
import { SUPPORTED_REVIEWER_FRAMEWORKS } from '../../src/core/crossModelReviewer.js';

const NOW = Date.parse('2026-11-23T22:00:00Z');
const policy = { enabled: true, accountIds: ['amrch', 'sagemindai'], expiresAt: '2026-11-25T06:38:10Z' };
const context = { routine: true, model: 'gpt-6.2-sol' };
function account(id: string, used = 11): SubscriptionAccount {
  return { id, nickname: id, provider: 'openai', framework: 'codex-cli', status: 'active', configHome: `/local/${id}`,
    lastQuota: { measuredAt: new Date(NOW - 60_000).toISOString(), windowsListed: ['sevenDay'],
      sevenDay: { utilizationPct: used, resetsAt: '2026-11-26T09:00:00Z' } } } as SubscriptionAccount;
}
const pick = (accounts: SubscriptionAccount[], cfg = policy, ctx = context) => selectRoutineCodexAccount(accounts, cfg, ctx, { nowMs: NOW, homeReady: () => true });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('temporary routine Sol placement', () => {
  it('uses the declared order rather than earliest reset or least used, and bounds the lease by freshness', () => {
    const first = account('amrch', 40); const tuesday = account('tuesday', 5);
    tuesday.lastQuota!.sevenDay!.resetsAt = '2026-11-25T06:38:10Z';
    expect(pick([tuesday, account('sagemindai', 1), first, account('saturday', 1)]))
      .toEqual({ kind: 'selected', accountId: 'amrch', configHome: '/local/amrch', validUntil: NOW + 59 * 60_000 });
  });
  it('falls through only to the second named eligible account', () => {
    expect(pick([account('amrch', 100), account('sagemindai'), account('saturday')])).toMatchObject({ kind: 'selected', accountId: 'sagemindai' });
  });
  it.each(['stale', 'future', 'unknown-week', 'five-hour-full', 'unknown-five', 'drift', 'disabled', 'relative-home', 'suspected-device', 'synthesized'])('refuses %s candidates instead of default/Saturday', (reason) => {
    const a = account('amrch');
    if (reason === 'stale') a.lastQuota!.measuredAt = new Date(NOW - 3_600_000).toISOString();
    if (reason === 'future') a.lastQuota!.measuredAt = new Date(NOW + 1).toISOString();
    if (reason === 'unknown-week') a.lastQuota!.sevenDay = undefined;
    if (reason === 'five-hour-full') a.lastQuota!.fiveHour = { utilizationPct: 100, resetsAt: '2026-11-24T01:00:00Z' };
    if (reason === 'unknown-five') a.lastQuota!.windowsListed = undefined;
    if (reason === 'drift') a.identityDrifted = true;
    if (reason === 'disabled') a.status = 'disabled';
    if (reason === 'relative-home') a.configHome = 'relative';
    if (reason === 'suspected-device') a.deviceLimitSuspectedAt = '2026-11-23T21:00:00Z';
    if (reason === 'synthesized') a.lastQuota!.measuredAtSynthesized = true;
    expect(pick([a, account('saturday'), account('tuesday')])).toMatchObject({ kind: 'refused' });
  });
  it('requires an accessible local directory, a unique account and an explicit finite policy', () => {
    expect(selectRoutineCodexAccount([account('amrch')], policy, context, { nowMs: NOW, homeReady: () => false }).kind).toBe('refused');
    expect(pick([account('amrch'), account('amrch')]).kind).toBe('refused');
    expect(pick([], { ...policy, expiresAt: 'invalid' }).kind).toBe('refused');
    expect(pick([], { ...policy, accountIds: [] }).kind).toBe('refused');
  });
  it('leaves disabled, expired, interactive and Astra paths to ordinary placement', () => {
    expect(pick([], { ...policy, enabled: false }).kind).toBe('inactive');
    expect(pick([], { ...policy, expiresAt: new Date(NOW).toISOString() }).kind).toBe('inactive');
    expect(pick([], policy, { ...context, routine: false }).kind).toBe('inactive');
    expect(pick([], policy, { ...context, model: 'gpt-6.2-astra' }).kind).toBe('inactive');
  });
});

describe('standalone Sol review account lease', () => {
  const config = { port: 4042, subscriptionPool: { routineCodexPlacement: policy } };
  const env = { INSTAR_AUTH_TOKEN: 'fixture-only' };
  const leaseResponse = () => new Response(JSON.stringify({ mode: 'selected', accountOverride: { accountId: 'amrch', configHome: '/local/amrch' }, validUntil: NOW + 60_000 }));
  it('uses an authenticated loopback read and refuses launching after its evidence expires', async () => {
    let now = NOW;
    const fetcher = vi.fn(async () => leaseResponse());
    const lease = await routineCodexReviewLease(config, context.model, { fetch: fetcher, env, now: () => now });
    expect(fetcher.mock.calls[0][0]).toContain('http://127.0.0.1:4042/subscription-pool/routine-codex-placement');
    expect(lease?.accountOverride.accountId).toBe('amrch');
    expect(await lease?.launchGuard()).toBe(true);
    now += 60_000;
    expect(await lease?.launchGuard()).toBe(false);
  });
  it('off/absent policy never gains a local server dependency', async () => {
    const fetcher = vi.fn(async () => { throw new Error('server-down'); });
    expect(await routineCodexReviewLease({ port: 4042 }, context.model, { fetch: fetcher, env, now: () => NOW })).toBeNull();
    expect(await routineCodexReviewLease({ ...config, subscriptionPool: { routineCodexPlacement: { ...policy, enabled: false } } }, context.model, { fetch: fetcher, env, now: () => NOW })).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rechecks live eligibility and rollback before the child boundary', async () => {
    let active = true;
    const lease = await routineCodexReviewLease(config, context.model, { env, now: () => NOW,
      fetch: async () => active ? leaseResponse() : new Response(JSON.stringify({ mode: 'inactive' })) });
    active = false;
    expect(await lease?.launchGuard()).toBe(false);
  });
  it.each([409, 503])('refuses HTTP %s without a model call or fallback', async status => {
    await expect(routineCodexReviewLease(config, context.model, { env, now: () => NOW, fetch: async () => new Response('{}', { status }) })).rejects.toThrow('preferred local account unavailable');
  });
  it('rejects inactive or unapproved account responses, missing auth and invalid expiry', async () => {
    for (const body of [{ mode: 'inactive' }, { mode: 'selected', accountOverride: { accountId: 'saturday', configHome: '/local/saturday' }, validUntil: NOW + 60_000 }]) {
      await expect(routineCodexReviewLease(config, context.model, { env, now: () => NOW, fetch: async () => new Response(JSON.stringify(body)) })).rejects.toThrow('no current account lease');
    }
    await expect(routineCodexReviewLease(config, context.model, { env: {}, now: () => NOW })).rejects.toThrow('credentials unavailable');
  });
  it('the actual Codex reviewer passes the selected home, strict route and launch guard to its provider', async () => {
    vi.stubEnv('INSTAR_AUTH_TOKEN', 'fixture-only');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ mode: 'selected', accountOverride: { accountId: 'amrch', configHome: '/local/amrch' }, validUntil: Date.now() + 60_000 }))));
    const evaluate = vi.fn(async () => 'VERDICT: CLEAN\nNo issues.');
    const reviewer = SUPPORTED_REVIEWER_FRAMEWORKS.find(f => f.id === 'codex-cli')!;
    await reviewer.review({ promptText: 'Review source', timeoutMs: 1000, reviewerConfig: { ...config, subscriptionPool: { routineCodexPlacement: { ...policy, expiresAt: '2099-01-01T00:00:00Z' } } },
      detectionOverride: { available: true, framework: 'codex-cli', model: 'gpt-6.2-sol' }, providerOverride: { evaluate } });
    expect(evaluate).toHaveBeenCalledOnce();
    expect(evaluate.mock.calls[0][1]).toMatchObject({ accountOverride: { accountId: 'amrch', configHome: '/local/amrch' }, requiredRoute: { framework: 'codex-cli', modelId: 'gpt-6.2-sol' }, strictModelPin: true, launchGuard: expect.any(Function) });
    vi.unstubAllEnvs();
  });
  it('the actual reviewer degrades without calling the provider when both preferred accounts are unavailable', async () => {
    vi.stubEnv('INSTAR_AUTH_TOKEN', 'fixture-only');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 409 })));
    const evaluate = vi.fn(async () => 'VERDICT: CLEAN');
    const result = await SUPPORTED_REVIEWER_FRAMEWORKS.find(f => f.id === 'codex-cli')!.review({ promptText: 'Review source', timeoutMs: 1000,
      reviewerConfig: { ...config, subscriptionPool: { routineCodexPlacement: { ...policy, expiresAt: '2099-01-01T00:00:00Z' } } },
      detectionOverride: { available: true, framework: 'codex-cli', model: 'gpt-6.2-sol' }, providerOverride: { evaluate } });
    expect(result.status).toBe('degraded'); expect(evaluate).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
});

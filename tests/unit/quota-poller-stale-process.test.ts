/**
 * Spec stale-process-login-expired: one session's expired-login screen must not bench a working
 * login. The 2026-11-20 Studio case (sagemind-adriana): one session showed "Login expired", the
 * account was benched for hours while every usage read and a fresh `claude -p` worked.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SubscriptionPool } from '../../src/core/SubscriptionPool.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { QuotaPoller, type TokenResolution } from '../../src/core/QuotaPoller.js';
import { FreshProbeScheduler, type PersistedState } from '../../src/core/FreshProbeScheduler.js';
import type { FreshProbeResult } from '../../src/core/freshLoginProbe.js';

const NOW = Date.parse('2026-11-20T19:39:00Z');
const HOME = '/home/x/.claude-followme-sagemind-adriana';
const ACCT = { nickname: 'sa', email: 'sa@example.test', provider: 'anthropic' as const, framework: 'claude-code' as const, configHome: HOME };
const usageOk = async () => ({ ok: true, status: 200, json: async () => ({ five_hour: { utilization: 5, resets_at: '2026-11-20T23:00:00Z' } }) });

describe('QuotaPoller + fresh-login probe (stale process)', () => {
  let dir: string;
  let pool: SubscriptionPool;
  let clock = NOW;
  let token: TokenResolution = 'sk-ant-oat-original';
  let verdict: FreshProbeResult['verdict'] = 'ok';
  let gate: Promise<void> | null = null;
  let spawns = 0;
  let enabled = true;
  beforeEach(() => {
    clock = NOW; token = 'sk-ant-oat-original'; verdict = 'ok'; gate = null; spawns = 0; enabled = true;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qpoll-stale-')); pool = new SubscriptionPool({ stateDir: dir });
    pool.addFixture({ ...ACCT, id: 'sa' });
  });
  afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'quota-poller-stale-process cleanup' }); });

  function build() {
    const p = new QuotaPoller({ pool, now: () => clock, tokenResolver: () => token, fetchImpl: usageOk, refresher: async () => { throw new Error('no refresh expected'); } });
    let state: PersistedState = {};
    const sched = new FreshProbeScheduler({
      now: () => clock, enabled: () => enabled,
      fingerprint: () => (typeof token === 'string' ? token : null),
      load: () => state, persist: async (s) => { state = s; },
      probe: async (_id, reserve) => {
        if (!(await reserve())) return { verdict: 'not-run', reason: 'reserve-refused' };
        spawns++;
        if (gate) await gate;
        return { verdict, reason: 'x' };
      },
      onVerdict: (id, v) => p.applyFreshVerdict(id, v),
    });
    p.setFreshProbe(sched);
    return { p, sched };
  }

  it('the 2026-11-20 case: a probe answering ok within the wait ⇒ not benched, reason stale-process', async () => {
    const { p } = build();
    const r = await p.observeCliLoginExpired({ configHome: HOME, session: 'echo-topic-1' }, { awaitProbeMs: 1000 });
    expect(r).toMatchObject({ accountId: 'sa', marked: false, reason: 'stale-process', staleProcess: true, probe: 'ok', accountStatus: 'active' });
    expect(pool.get('sa')!.status).toBe('active');
    expect(spawns).toBe(1);
  });

  it('a refused probe keeps today\'s behaviour: marked + held', async () => {
    verdict = 'refused';
    const { p } = build();
    const r = await p.observeCliLoginExpired({ configHome: HOME, session: 'echo-topic-1' }, { awaitProbeMs: 1000 });
    expect(r).toMatchObject({ marked: true, reason: 'marked', probe: 'refused' });
    expect(pool.get('sa')!.status).toBe('needs-reauth');
  });

  it('an ok landing after the wait releases the hold the wait created', async () => {
    let release!: () => void; gate = new Promise((r) => { release = r; });
    const { p } = build();
    const r = await p.observeCliLoginExpired({ configHome: HOME, session: 'echo-topic-1' }, { awaitProbeMs: 5 });
    expect(r).toMatchObject({ marked: true, probe: 'pending' });
    expect(pool.get('sa')!.status).toBe('needs-reauth');
    release(); await new Promise((res) => setTimeout(res, 10));
    expect(pool.get('sa')!.status).toBe('active');
    expect(p.loginCheck('sa')).toBe('ok');
  });

  it('NeverSilent (markWhilePending false) never marks while a probe is pending', async () => {
    gate = new Promise(() => { /* never lands */ });
    const { p } = build();
    const r = await p.observeCliLoginExpired({ configHome: HOME, session: 'echo-topic-1' }, { awaitProbeMs: 0, markWhilePending: false });
    expect(r).toMatchObject({ marked: false, reason: 'probe-pending', probe: 'pending' });
    expect(pool.get('sa')!.status).toBe('active');
  });

  it('a stronger bench survives a later pane sighting and an ok probe', async () => {
    const { p } = build();
    // Simulate a stronger mark (e.g. still-authfailed-after-refresh) through the poller's own path.
    (p as unknown as { markNeedsReauth: (a: unknown, r: string) => void }).markNeedsReauth(pool.get('sa')!, 'still-authfailed-after-refresh');
    const r = await p.observeCliLoginExpired({ configHome: HOME, session: 'echo-topic-1' }, { awaitProbeMs: 1000 });
    expect(r.staleProcess).not.toBe(true);
    expect(pool.get('sa')!.status).toBe('needs-reauth');
    p.applyFreshVerdict('sa', 'ok');
    expect(pool.get('sa')!.status).toBe('needs-reauth');
  });

  it('an existing pane hold (no probe at sighting) is released by a poll once a probe answers ok', async () => {
    const plain = new QuotaPoller({ pool, now: () => clock, tokenResolver: () => token, fetchImpl: usageOk, refresher: async () => { throw new Error('x'); } });
    await plain.observeCliLoginExpired({ configHome: HOME, session: 'echo-topic-1' });
    expect(pool.get('sa')!.status).toBe('needs-reauth');
    // The same poller gains a probe (as after this update installs): the next polls clear it.
    let state: PersistedState = {};
    plain.setFreshProbe(new FreshProbeScheduler({
      now: () => clock, enabled: () => true, fingerprint: () => 'sk-ant-oat-original',
      load: () => state, persist: async (s) => { state = s; },
      probe: async (_id, reserve) => { await reserve(); return { verdict: 'ok', reason: 'x' }; },
      onVerdict: (id, v) => plain.applyFreshVerdict(id, v),
    }));
    clock += 15 * 60_000;
    await plain.pollAll();
    await new Promise((res) => setTimeout(res, 10));
    expect(pool.get('sa')!.status).toBe('active');
  });

  it('with the switch off, nothing is probed and today\'s behaviour applies', async () => {
    enabled = false;
    const { p } = build();
    const r = await p.observeCliLoginExpired({ configHome: HOME, session: 'echo-topic-1' }, { awaitProbeMs: 1000 });
    expect(r).toMatchObject({ marked: true, reason: 'marked', probe: 'inconclusive' });
    expect(spawns).toBe(0);
  });

  it('with no probe attached, the result is byte-identical to today', async () => {
    const p = new QuotaPoller({ pool, now: () => clock, tokenResolver: () => token, fetchImpl: usageOk, refresher: async () => { throw new Error('x'); } });
    const r = await p.observeCliLoginExpired({ configHome: HOME, session: 'echo-topic-1' });
    expect(r).toEqual({ accountId: 'sa', marked: true, reason: 'marked', accountStatus: 'needs-reauth' });
  });

  it('overlapping pollAll calls share one pass', async () => {
    const { p } = build();
    const [a, b] = await Promise.all([p.pollAll(), p.pollAll()]);
    expect(a).toEqual(b);
  });
});

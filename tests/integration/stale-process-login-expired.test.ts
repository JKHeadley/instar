/**
 * Spec stale-process-login-expired, integration: the real QuotaPoller, InteractiveLoginExpiredRecovery,
 * the server wiring builder (buildFreshProbeScheduler) and the real probe runner, against a stand-in
 * `claude` that replays the REAL captured CLI output. Replays the 2026-11-20 Mac Studio timeline.
 */
// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SubscriptionPool } from '../../src/core/SubscriptionPool.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { QuotaPoller } from '../../src/core/QuotaPoller.js';
import { InteractiveLoginExpiredRecovery } from '../../src/core/InteractiveLoginExpiredRecovery.js';
import { buildFreshProbeScheduler, loadFreshProbeState } from '../../src/core/freshLoginProbeWiring.js';
import { runFreshLoginProbe } from '../../src/core/freshLoginProbe.js';

import { configureHostSpawnSemaphore, getHostSpawnSemaphore, _resetHostSpawnSemaphoreForTest } from '../../src/core/hostSpawnSemaphore.js';

const FIX = path.join(__dirname, '..', 'fixtures', 'fresh-login-probe');
const usageOk = async () => ({ ok: true, status: 200, json: async () => ({ five_hour: { utilization: 5, resets_at: '2099-01-01T00:00:00Z' } }) });

describe('stale-process login expired (integration)', () => {
  let dir = '';
  let home = '';
  let pool: SubscriptionPool;
  let bin = '';
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-int-'));
    // The real probe uses the host semaphore, not stateDir. Keep stand-in CLI
    // admissions independent of live agents and other verification workers.
    vi.spyOn(os, 'homedir').mockReturnValue(dir);
    _resetHostSpawnSemaphoreForTest();
    home = path.join(dir, 'login');
    fs.mkdirSync(home);
    pool = new SubscriptionPool({ stateDir: dir });
    pool.addFixture({ id: 'sa', nickname: 'sa', email: 'sa@example.test', provider: 'anthropic', framework: 'claude-code', configHome: home });
  });
  afterEach(() => {
    _resetHostSpawnSemaphoreForTest();
    vi.restoreAllMocks();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'stale-process integration cleanup' });
  });

  function standIn(fixture: string) {
    bin = path.join(dir, 'claude');
    fs.writeFileSync(bin, `#!/bin/sh\ncat "${path.join(FIX, fixture)}"\n${fixture.startsWith('ok') ? 'exit 0' : 'exit 1'}\n`);
    fs.chmodSync(bin, 0o755);
  }

  function build(fixture: string) {
    expect(getHostSpawnSemaphore().status().holdersPath).toBe(path.join(dir, '.instar', 'host-spawn-holders.json'));
    standIn(fixture);
    const poller = new QuotaPoller({ pool, tokenResolver: () => 'sk-ant-oat-stored', fetchImpl: usageOk, refresher: async () => { throw new Error('no refresh'); } });
    const sched = buildFreshProbeScheduler({
      stateDir: dir,
      enabled: () => true,
      claudePath: () => bin,
      routedConfigHome: (id) => poller.routedConfigHome(id),
      fingerprint: (id) => poller.lastCredentialFingerprint(id),
      applyVerdict: (id, v) => poller.applyFreshVerdict(id, v),
      onBreaker: () => {},
      readExpiresAt: async () => Date.now() + 60 * 60_000,
      run: (h, cwd) => runFreshLoginProbe({ claudePath: () => bin, cwd }, h),
    });
    poller.setFreshProbe(sched);
    const refreshed: string[] = [];
    const swapped: string[] = [];
    const recovery = new InteractiveLoginExpiredRecovery({
      observe: (input, opts) => poller.observeCliLoginExpired(input, opts ?? {}),
      swap: async (a) => { swapped.push(a.sessionName); return { swapped: true, toAccountId: 'other', reason: 'ok' }; },
      staleProcessEnabled: () => true,
      refreshInPlace: async (s) => { refreshed.push(s); return { ok: true }; },
      sessionIdentity: () => 'same',
      stillShowsExpired: () => true,
      ownsConversation: () => true,
      noteContrary: (id) => poller.noteFreshProbeContrary(id),
    });
    return { poller, recovery, refreshed, swapped };
  }

  const signal = { session: 'echo-topic-1', sessionName: 'echo-topic-1', configHome: '', accountId: 'sa', matchedLine: 'Login expired · Please run /login', protected: false };

  it('the 2026-11-20 timeline: the stored login answers, the account stays usable, the session restarts on its own account', async () => {
    const { recovery, refreshed, swapped } = build('ok.stream.jsonl');
    const r = await recovery.handle({ ...signal, configHome: home });
    expect(r.outcome).toBe('refreshed-in-place');
    expect(pool.get('sa')!.status).toBe('active');
    expect(refreshed).toEqual(['echo-topic-1']);
    expect(swapped).toEqual([]);
    // The spawn was reserved and persisted.
    expect(loadFreshProbeState(dir).sa.spawns).toHaveLength(1);
  });

  it('a genuinely signed-out login (real not-logged-in output) keeps today\'s path: marked and swapped', async () => {
    const { recovery, refreshed, swapped } = build('not-logged-in.stream.jsonl');
    const r = await recovery.handle({ ...signal, configHome: home });
    expect(r.outcome).toBe('swapped');
    expect(pool.get('sa')!.status).toBe('needs-reauth');
    expect(refreshed).toEqual([]);
    expect(swapped).toEqual(['echo-topic-1']);
  });

  it('NeverSilent arriving first never marks; the recovery then finds the cached ok', async () => {
    const { poller, recovery } = build('ok.stream.jsonl');
    const ns = await poller.observeCliLoginExpired({ configHome: home, session: 'echo-topic-1' }, { awaitProbeMs: 0, markWhilePending: false });
    expect(ns.marked).toBe(false);
    expect(pool.get('sa')!.status).toBe('active');
    const r = await recovery.handle({ ...signal, configHome: home });
    expect(r.outcome).toBe('refreshed-in-place');
    expect(loadFreshProbeState(dir).sa.spawns).toHaveLength(1); // one shared spawn
  });

  it('a genuinely saturated fixture cap sheds the probe and keeps the conservative swap path', async () => {
    configureHostSpawnSemaphore({ maxConcurrent: 1, acquireMs: 0 });
    const cap = getHostSpawnSemaphore();
    expect(cap.acquire('other-fixture-work')).toBe(true);
    try {
      const { recovery, refreshed, swapped } = build('ok.stream.jsonl');
      const r = await recovery.handle({ ...signal, configHome: home });
      expect(r.outcome).toBe('swapped');
      expect(pool.get('sa')!.status).toBe('needs-reauth');
      expect(refreshed).toEqual([]);
      expect(swapped).toEqual(['echo-topic-1']);
      // The cap refused admission before the child and durable reservation.
      expect(loadFreshProbeState(dir).sa?.spawns ?? []).toEqual([]);
    } finally {
      cap.release('other-fixture-work');
    }
  });

});

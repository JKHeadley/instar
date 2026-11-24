// safe-fs-allow: test file — reads source and uses temp dirs via mkdtemp/rm only.
/**
 * e2e — spec stale-process-login-expired is ALIVE on the production path:
 *  1. server.ts builds the fresh-login probe scheduler and attaches it to the QuotaPoller, gated by the
 *     live switch, and passes each caller its wait (rerouted sink 20 s, recovery 20 s via the recovery,
 *     NeverSilent 0 s join-only, never marking while pending); the recovery gets real refresh,
 *     identity, screen and ownership hooks, and NeverSilent gets the recovery's inPlaceRefreshPossible.
 *  2. The production builder (buildFreshProbeScheduler) with the real runner and a stand-in CLI
 *     replaying real captured output persists a reservation and lets the poller release a hold.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SubscriptionPool } from '../../src/core/SubscriptionPool.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { QuotaPoller } from '../../src/core/QuotaPoller.js';
import { buildFreshProbeScheduler, loadFreshProbeState } from '../../src/core/freshLoginProbeWiring.js';
import { runFreshLoginProbe } from '../../src/core/freshLoginProbe.js';

import { getHostSpawnSemaphore, _resetHostSpawnSemaphoreForTest } from '../../src/core/hostSpawnSemaphore.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVER = fs.readFileSync(path.join(ROOT, 'src', 'commands', 'server.ts'), 'utf8');

describe('stale-process login expired — wired in server.ts', () => {
  it('builds the scheduler, attaches it to the poller, behind the live switch', () => {
    expect(SERVER).toContain("buildFreshProbeScheduler");
    expect(SERVER).toContain('quotaPoller.setFreshProbe(freshProbe)');
    expect(SERVER).toMatch(/subscriptionPool\.freshLoginProbe\.enabled/);
    expect(SERVER).toContain('applyVerdict: (id, verdict) => quotaPoller.applyFreshVerdict(id, verdict)');
  });
  it('gives each caller its wait, and NeverSilent never marks while pending', () => {
    expect(SERVER).toContain('observeCliLoginExpired(input, { awaitProbeMs: 20_000 })');
    expect(SERVER).toContain('observe: (input, opts) => quotaPoller.observeCliLoginExpired(input, opts ?? {})');
    expect(SERVER).toContain('{ awaitProbeMs: 0, markWhilePending: false }');
    expect(SERVER).toContain('inPlaceRefreshPossible: (tmux, accountId) => interactiveLoginExpiredRecovery.inPlaceRefreshPossible(tmux, accountId)');
  });
  it('gives the recovery real, non-null hooks (refresh on its own account, identity, screen, ownership)', () => {
    for (const hook of ['staleProcessEnabled: freshLoginProbeEnabled', 'refreshInPlace: async (session)', 'sessionIdentity: (session)', 'stillShowsExpired: (session)', 'ownsConversation: (session)', 'noteContrary: (accountId)']) {
      expect(SERVER).toContain(hook);
    }
    expect(SERVER).toMatch(/refreshSession\(\{ sessionName: session, reason: 'stale-login-token', fresh: false, configHome, accountId, callerClass: 'recovery' \}/);
  });
});

describe('stale-process login expired — production builder with the real runner', () => {
  let dir = '';
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-e2e-'));
    vi.spyOn(os, 'homedir').mockReturnValue(dir);
    _resetHostSpawnSemaphoreForTest();
  });
  afterEach(() => {
    _resetHostSpawnSemaphoreForTest();
    vi.restoreAllMocks();
    if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'stale-process e2e cleanup' });
  });

  it('a pane hold is released by a real probe answering ok, and the spawn is persisted', async () => {
    expect(getHostSpawnSemaphore().status().holdersPath).toBe(path.join(dir, '.instar', 'host-spawn-holders.json'));
    const home = path.join(dir, 'login'); fs.mkdirSync(home);
    const bin = path.join(dir, 'claude');
    fs.writeFileSync(bin, `#!/bin/sh\ncat "${path.join(ROOT, 'tests', 'fixtures', 'fresh-login-probe', 'ok.stream.jsonl')}"\n`);
    fs.chmodSync(bin, 0o755);
    const pool = new SubscriptionPool({ stateDir: dir });
    pool.addFixture({ id: 'sa', nickname: 'sa', email: 'sa@example.test', provider: 'anthropic', framework: 'claude-code', configHome: home });
    const poller = new QuotaPoller({ pool, tokenResolver: () => 'sk-ant-oat-stored', fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }), refresher: async () => { throw new Error('x'); } });
    // A hold from before the probe existed (as after this update installs).
    await poller.observeCliLoginExpired({ configHome: home, session: 'echo-topic-1' });
    expect(pool.get('sa')!.status).toBe('needs-reauth');
    poller.setFreshProbe(buildFreshProbeScheduler({
      stateDir: dir, enabled: () => true, claudePath: () => bin,
      routedConfigHome: (id) => poller.routedConfigHome(id), fingerprint: (id) => poller.lastCredentialFingerprint(id),
      applyVerdict: (id, v) => poller.applyFreshVerdict(id, v), onBreaker: () => {},
      readExpiresAt: async () => Date.now() + 60 * 60_000,
      run: (h, cwd) => runFreshLoginProbe({ claudePath: () => bin, cwd }, h),
    }));
    const r = await poller.observeCliLoginExpired({ configHome: home, session: 'echo-topic-1' }, { awaitProbeMs: 5_000 });
    expect(r.staleProcess).toBe(true);
    expect(pool.get('sa')!.status).toBe('active');
    expect(loadFreshProbeState(dir).sa.spawns).toHaveLength(1);
  });
});

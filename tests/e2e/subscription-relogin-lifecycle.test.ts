import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SubscriptionReloginStore } from '../../src/core/SubscriptionReloginStore.js';
import { createSubscriptionReloginRuntime } from '../../src/core/SubscriptionReloginRuntime.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { getInitDefaults } from '../../src/config/ConfigDefaults.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';

const roots: string[] = [];
const servers: AgentServer[] = [];

function config(root: string): InstarConfig {
  const stateDir = path.join(root, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  return {
    projectName: 'relogin-e2e', projectDir: root, stateDir, port: 0,
    authToken: 'relogin-api-token', dashboardPin: '123456', requestTimeoutMs: 10_000, version: '0.0.0',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {},
  } as InstarConfig;
}

function makeServer(cfg: InstarConfig, runtime?: any): AgentServer {
  const server = new AgentServer({
    config: cfg,
    sessionManager: { listRunningSessions: () => [], getSession: () => null, on: vi.fn() } as never,
    state: new StateManager(cfg.stateDir),
    subscriptionRelogin: runtime,
  });
  servers.push(server);
  return server;
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  for (const root of roots.splice(0)) {
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'subscription-relogin-lifecycle cleanup' });
  }
});

describe('assisted subscription re-login production AgentServer lifecycle', () => {
  it('is honestly dark when production composition is absent', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-dark-e2e-')); roots.push(root);
    const server = makeServer(config(root));
    await server.start();
    const response = await request(server.getApp()).get('/subscription-relogin')
      .set('Authorization', 'Bearer relogin-api-token');
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ enabled: false });
  });

  it('is alive through real auth, PIN unlock, one click, durable CAS, and clean shutdown', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-live-e2e-')); roots.push(root);
    const cfg = config(root);
    const store = new SubscriptionReloginStore({ stateDir: cfg.stateDir, idFactory: () => 'repair-e2e' });
    store.suggest({ sourceEpisodeId: 42, accountId: 'acct-1', machineId: 'machine-1', mode: 'approval',
      inputDigest: `sha256:${'b'.repeat(64)}`, profileId: 'profile-1', framework: 'claude-code', provider: 'anthropic' });
    const close = vi.fn(() => store.close());
    const server = makeServer(cfg, {
      store,
      approve: async (id: string) => {
        const current = store.get(id); if (!current) throw new Error('relogin-episode-not-found');
        return store.approve(id, { inputDigest: current.inputDigest });
      },
      cancel: async (id: string) => store.cancel(id),
      close,
    });
    await server.start();

    expect((await request(server.getApp()).get('/subscription-relogin')).status).toBe(401);
    const list = await request(server.getApp()).get('/subscription-relogin')
      .set('Authorization', 'Bearer relogin-api-token');
    expect(list.status).toBe(200);
    expect(list.body.episodes[0]).toMatchObject({ id: 'repair-e2e', state: 'suggested' });

    const unlock = await request(server.getApp()).post('/dashboard/unlock').send({ pin: '123456' });
    expect(unlock.status).toBe(200);
    expect(unlock.body.token).toBe('relogin-api-token');
    expect(unlock.body.operatorSessionToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);

    const bearerOnly = await request(server.getApp()).post('/subscription-relogin/repair-e2e/approve')
      .set('Authorization', 'Bearer relogin-api-token').send({});
    expect(bearerOnly.status).toBe(401);
    const approved = await request(server.getApp()).post('/subscription-relogin/repair-e2e/approve')
      .set('Authorization', 'Bearer relogin-api-token')
      .set('X-Instar-Operator-Session', unlock.body.operatorSessionToken).send({});
    expect(approved.status).toBe(202);
    expect(approved.body.episode).toMatchObject({ state: 'approved', sourceEpisodeId: 42 });

    await server.stop(); servers.splice(servers.indexOf(server), 1);
    expect(close).toHaveBeenCalledOnce();
  });

  it('exercises the same pre-listen late-binding seam used by production and refuses post-listen replacement', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-wiring-e2e-')); roots.push(root);
    const cfg = config(root);
    const store = new SubscriptionReloginStore({ stateDir: cfg.stateDir, idFactory: () => 'repair-wired' });
    const server = makeServer(cfg);
    server.setSubscriptionRelogin({
      store,
      approve: async () => { throw new Error('not exercised'); },
      cancel: async (id: string) => store.cancel(id),
      close: () => store.close(),
    });
    await server.start();
    const response = await request(server.getApp()).get('/subscription-relogin')
      .set('Authorization', 'Bearer relogin-api-token');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ enabled: true, episodes: [] });
    expect(() => server.setSubscriptionRelogin(undefined)).toThrow('must be bound before server start');
  });

  it('completes a synthetic provider repair through the production AgentServer approval surface and real runtime', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-complete-e2e-')); roots.push(root);
    const cfg = config(root);
    const userDataDir = path.join(root, 'browser-profile'); fs.mkdirSync(userDataDir, { recursive: true });
    let account: any = { id: 'acct-1', nickname: 'Disposable Claude', email: 'disposable@example.test',
      provider: 'anthropic', framework: 'claude-code', configHome: path.join(root, 'slot'),
      status: 'needs-reauth', enrolledAt: '2026-01-01T00:00:00Z', version: 1 };
    let source: any = { id: 71, accountId: account.id, machineId: 'machine-1',
      openedAt: '2026-08-28T00:00:00Z', closedAt: null, causeClass: 'exchange-failed',
      corroboration: 'exchange-corroborated', outcome: null, provenance: 'observed' };
    const pool: any = { getAvailability: () => ({ state: 'ready' }),
      get: (id: string) => id === account.id ? { ...account } : null,
      update: vi.fn((_id: string, patch: Record<string, unknown>) => {
        account = { ...account, ...patch, version: account.version + 1 }; return account;
      }) };
    const ledger: any = { listEpisodes: () => [{ ...source }], recordStatus: vi.fn(() => {
      source = { ...source, closedAt: '2026-08-28T01:00:00Z', outcome: 'resolved' };
      return { changed: true, episodeId: source.id };
    }) };
    let pending: any = null;
    const enrollment: any = { getById: () => pending, start: vi.fn(async () => (pending = {
      id: account.id, label: account.nickname, provider: 'anthropic', framework: 'claude-code',
      kind: 'url-code-paste', configHome: account.configHome,
      verificationUrl: 'https://claude.ai/oauth/authorize', ttlExpiresAt: '2099-01-01T00:00:00Z',
      status: 'pending', reissueCount: 0, createdAt: '2026-08-28T00:00:00Z',
      updatedAt: '2026-08-28T00:00:00Z', version: 1 })), refresh: vi.fn() };
    const profiles: any = { resolve: () => ({ profile: { id: 'profile-1' }, dirExists: true }),
      listProfiles: () => [{ id: 'profile-1', userDataDir, description: '', isDefault: false,
        createdAt: '', dirExists: true, accounts: [{ service: 'anthropic', identity: account.email,
          owner: 'operator', vaultRefs: [], loginMethod: 'session-cookie', lastAsserted: true,
          lastVerifiedAt: null, note: '', danglingRefs: [] }] }] };
    const browser: any = { open: vi.fn(async () => {}), snapshot: vi.fn(async () => ({
      origin: 'https://claude.ai', pageClass: 'success', expectedAccountVisible: true,
      hasNext: false, hasAuthorize: false, requestedScopes: [] })), chooseExpectedAccount: vi.fn(),
      fillPublic: vi.fn(), fillSecret: vi.fn(), click: vi.fn(), readPasteCode: vi.fn(),
      wait: vi.fn(), close: vi.fn(async () => {}) };
    const runtime = createSubscriptionReloginRuntime({ stateDir: cfg.stateDir, projectDir: root,
      machineId: 'machine-1', mode: 'approval', pool, ledger, enrollment, profiles,
      quotaPoller: { pollAccount: vi.fn(async () => ({ source: 'oauth-api', measuredAt: new Date().toISOString() })) } as any,
      identityOracle: { resolveSlotTenant: vi.fn(async () => ({ email: account.email })) } as any,
      pasteBack: { finish: vi.fn(async () => 'complete') } as any,
      createBrowser: () => browser, resolveSecret: async () => null,
      supervise: async ({ allowedActions }) => allowedActions[0]!,
    });
    await runtime.service.tick();
    const suggested = runtime.store.list()[0];
    expect(suggested).toMatchObject({ state: 'suggested', accountId: 'acct-1' });
    const server = makeServer(cfg, { store: runtime.store,
      approve: (id: string) => runtime.service.approve(id),
      cancel: (id: string) => runtime.service.cancel(id),
      retry: (id: string) => runtime.service.retry(id), close: () => runtime.close() });
    await server.start();
    const unlock = await request(server.getApp()).post('/dashboard/unlock').send({ pin: '123456' });
    const approved = await request(server.getApp()).post(`/subscription-relogin/${suggested.id}/approve`)
      .set('Authorization', 'Bearer relogin-api-token')
      .set('X-Instar-Operator-Session', unlock.body.operatorSessionToken).send({});
    expect(approved.status).toBe(202);
    await vi.waitFor(() => expect(runtime.store.get(suggested.id)?.state).toBe('succeeded'));
    const events = await request(server.getApp()).get(`/subscription-relogin/${suggested.id}/events`)
      .set('Authorization', 'Bearer relogin-api-token');
    expect(events.status).toBe(200);
    expect(events.body.episode).toMatchObject({ state: 'succeeded', sourceEpisodeId: 71 });
    expect(account.status).toBe('active');
    expect(source.closedAt).not.toBeNull();
    expect(browser.open).toHaveBeenCalledWith('https://claude.ai/oauth/authorize');
  });

  it('keeps clean installs and upgraded agents on the same fleet-dark approval-shaped defaults', async () => {
    const init = getInitDefaults('managed-project') as any;
    expect(init.subscriptionPool.assistedRelogin).toMatchObject({
      enabled: false, dryRun: true, mode: 'approval', maxAttempts: 3,
      tickMs: 30_000, retryBaseMs: 5_000, allowedScopes: ['user:profile'],
    });

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-migration-e2e-')); roots.push(root);
    const stateDir = path.join(root, '.instar'); fs.mkdirSync(stateDir, { recursive: true });
    const configPath = path.join(stateDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ projectName: 'legacy', authToken: 'legacy-token',
      subscriptionPool: { accounts: [] } }, null, 2));
    const migrator = new PostUpdateMigrator({ projectDir: root, stateDir, port: 4042,
      hasTelegram: false, projectName: 'legacy' });
    const result = await migrator.migrate();
    expect(result.errors).toEqual([]);
    const migrated = JSON.parse(fs.readFileSync(configPath, 'utf8')) as any;
    expect(migrated.subscriptionPool.assistedRelogin).toEqual(init.subscriptionPool.assistedRelogin);
    await migrator.migrate();
    const twice = JSON.parse(fs.readFileSync(configPath, 'utf8')) as any;
    expect(twice.subscriptionPool.assistedRelogin).toEqual(init.subscriptionPool.assistedRelogin);
  });
});

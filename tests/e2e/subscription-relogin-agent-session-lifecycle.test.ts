/**
 * Skill-driven sign-in repair — "is the feature actually alive?" (spec skill-driven-signin-repair).
 *
 * Production composition: createSubscriptionReloginRuntime(navigation: 'agent-session') wired into a
 * REAL AgentServer through `subscriptionReloginRouteContext` — the same function server.ts uses — and
 * the real auth stack. A fake helper session does what section 3 ends with: it posts the code over
 * real HTTP to the loopback code route with ONLY its per-episode token (no bearer). The server's
 * arbiter then decides success.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { PlaywrightSeatLease } from '../../src/core/PlaywrightSeatLease.js';
import { createSubscriptionReloginRuntime, subscriptionReloginRouteContext } from '../../src/core/SubscriptionReloginRuntime.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';

const roots: string[] = [];
const servers: AgentServer[] = [];
const listeners: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of listeners.splice(0)) await close();
  for (const server of servers.splice(0)) await server.stop();
  for (const root of roots.splice(0)) SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'relogin-agent-session e2e cleanup' });
});

function config(root: string): InstarConfig {
  const stateDir = path.join(root, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  return {
    projectName: 'relogin-agent-session-e2e', projectDir: root, stateDir, port: 0,
    authToken: 'relogin-api-token', dashboardPin: '123456', requestTimeoutMs: 10_000, version: '0.0.0',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {},
  } as InstarConfig;
}

const CODE = 'e'.repeat(32) + '#' + 'f'.repeat(32);

async function listen(server: AgentServer): Promise<string> {
  return new Promise((resolve) => {
    const listener = server.getApp().listen(0, () => {
      listeners.push(() => new Promise<void>((done) => listener.close(() => done())));
      resolve(`http://127.0.0.1:${(listener.address() as AddressInfo).port}`);
    });
  });
}

describe('skill-driven sign-in repair through the production AgentServer', () => {
  it('is alive: a helper posts the code with only its token, and the server verifies the repair to success', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-agent-session-e2e-')); roots.push(root);
    const cfg = config(root);
    const userDataDir = path.join(root, 'browser-profile'); fs.mkdirSync(userDataDir);
    const accounts: Record<string, any> = {
      'acct-broken': { id: 'acct-broken', nickname: 'Broken', email: 'person@example.test', provider: 'anthropic', framework: 'claude-code',
        configHome: path.join(root, 'slot-broken'), status: 'needs-reauth', enrolledAt: '2026-01-01T00:00:00Z', version: 1 },
      'acct-helper': { id: 'acct-helper', nickname: 'Helper', email: 'helper@example.test', provider: 'anthropic', framework: 'claude-code',
        configHome: path.join(root, 'slot-helper'), status: 'active', enrolledAt: '2026-01-01T00:00:00Z', version: 1 },
    };
    let source: any = { id: 91, accountId: 'acct-broken', machineId: 'machine-1', openedAt: '2026-09-25T00:00:00Z', closedAt: null,
      causeClass: 'exchange-failed', corroboration: 'exchange-corroborated', outcome: null, provenance: 'observed' };
    const pool: any = { getAvailability: () => ({ state: 'ready' }), get: (id: string) => accounts[id] ? { ...accounts[id] } : null,
      list: () => Object.values(accounts).map((a) => ({ ...a })),
      update: vi.fn((id: string, patch: Record<string, unknown>) => (accounts[id] = { ...accounts[id], ...patch })) };
    const ledger: any = { listEpisodes: () => [{ ...source }], recordStatus: vi.fn(() => {
      source = { ...source, closedAt: '2026-09-25T01:00:00Z', outcome: 'resolved' }; return { changed: true, episodeId: source.id };
    }) };
    let pending: any = null;
    const enrollment: any = { getById: () => pending, abandon: vi.fn(), refresh: vi.fn(), start: vi.fn(async () => (pending = {
      id: 'acct-broken', label: 'Broken', provider: 'anthropic', framework: 'claude-code', kind: 'url-code-paste',
      configHome: accounts['acct-broken'].configHome, verificationUrl: 'https://claude.ai/oauth/authorize?code=true',
      ttlExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), status: 'pending', reissueCount: 0,
      createdAt: '', updatedAt: '', version: 1 })) };
    const profiles: any = { resolve: () => ({ profile: { id: 'profile-1' }, dirExists: true }), listProfiles: () => [{
      id: 'profile-1', userDataDir, description: '', isDefault: false, createdAt: '', dirExists: true,
      accounts: [{ service: 'google', identity: 'person@example.test', owner: 'operator', vaultRefs: [], loginMethod: 'password',
        lastAsserted: true, lastVerifiedAt: null, note: '', danglingRefs: [] }] }] };
    const pasteBack: any = { finish: vi.fn(async () => 'complete') };
    let serverUrl = '';
    let routeStatus = 0;
    const live = new Set<string>();
    const spawn = vi.fn(async ({ name, prompt }: { name: string; prompt: string }) => {
      const tmux = `e2e-${name}`;
      live.add(tmux);
      const token = /X-Relogin-Helper-Token: ([A-Za-z0-9_-]+)/.exec(prompt)![1]!;
      const route = /http:\/\/127\.0\.0\.1:\d+(\/subscription-relogin\/[^/]+\/code)/.exec(prompt)![1]!;
      setTimeout(async () => {
        const response = await fetch(`${serverUrl}${route}`, { method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Relogin-Helper-Token': token }, body: JSON.stringify({ code: CODE }) });
        routeStatus = response.status;
      }, 30);
      return tmux;
    });
    const runtime = createSubscriptionReloginRuntime({ stateDir: cfg.stateDir, projectDir: root, machineId: 'machine-1', mode: 'approval',
      pool, ledger, enrollment, profiles,
      quotaPoller: { pollAccount: vi.fn(async () => ({ source: 'oauth-usage-endpoint-fallback', measuredAt: new Date().toISOString() })) } as any,
      identityOracle: { resolveSlotTenant: vi.fn(async () => ({ email: 'person@example.test' })) } as any,
      pasteBack, createBrowser: () => { throw new Error('driver browser must not open'); }, resolveSecret: async () => null,
      supervise: async () => { throw new Error('no supervisor'); },
      navigation: 'agent-session', seatLease: new PlaywrightSeatLease({ filePath: path.join(root, 'seat.json') }),
      helperSession: { spawn, isAlive: (t) => live.has(t), kill: (t) => { live.delete(t); }, listHelpers: () => [],
        hasCapacity: () => true, serverPort: 4042, timing: { pollMs: 10, startGraceMs: 5_000 } },
    });
    expect(runtime.helper).not.toBeNull();
    const ctx = subscriptionReloginRouteContext(runtime);
    expect(typeof ctx.helperSubmit).toBe('function'); // wired, not a no-op
    const server = new AgentServer({ config: cfg, state: new StateManager(cfg.stateDir),
      sessionManager: { listRunningSessions: () => [], getSession: () => null, on: vi.fn() } as never, subscriptionRelogin: ctx });
    servers.push(server);
    await server.start();
    serverUrl = await listen(server);

    // Alive, not dark: with no live helper the route answers 409 (never 503), and needs no bearer.
    const idle = await fetch(`${serverUrl}/subscription-relogin/nope/code`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Relogin-Helper-Token': 'x' }, body: JSON.stringify({ code: CODE }) });
    expect(idle.status).toBe(409);

    await runtime.service.tick();
    const suggested = runtime.store.list()[0]!;
    expect(suggested.state).toBe('suggested');
    const unlock = await request(server.getApp()).post('/dashboard/unlock').send({ pin: '123456' });
    const approved = await request(server.getApp()).post(`/subscription-relogin/${suggested.id}/approve`)
      .set('Authorization', 'Bearer relogin-api-token').set('X-Instar-Operator-Session', unlock.body.operatorSessionToken).send({});
    expect(approved.status).toBe(202);
    await vi.waitFor(() => expect(runtime.store.get(suggested.id)?.state).toBe('succeeded'), { timeout: 5_000 });
    // The route resolves the server-side wait before the helper's own fetch promise settles, so the
    // episode can reach `succeeded` first; wait for the helper to see its 202.
    await vi.waitFor(() => expect(routeStatus).toBe(202), { timeout: 5_000 });
    expect(spawn.mock.calls[0]![0]).toMatchObject({ seat: { accountId: 'acct-helper' } });
    expect(pasteBack.finish).toHaveBeenCalledWith(expect.anything(), CODE, expect.any(AbortSignal));
    expect(live.size).toBe(0); // the helper was killed on exit from browser-driving
    const events = await request(server.getApp()).get(`/subscription-relogin/${suggested.id}/events`)
      .set('Authorization', 'Bearer relogin-api-token');
    expect(events.body.events.map((e: { eventClass: string }) => e.eventClass)).toEqual(
      expect.arrayContaining(['agent-session-drive-started', 'browser-approved', 'identity-verified', 'authenticated-use-verified']));
    expect(accounts['acct-broken'].status).toBe('active');
  });

  it('is honestly dark on the legacy path: the code route answers 503', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-agent-session-dark-e2e-')); roots.push(root);
    const cfg = config(root);
    const runtime = createSubscriptionReloginRuntime({ stateDir: cfg.stateDir, projectDir: root, machineId: 'machine-1', mode: 'approval',
      pool: { getAvailability: () => ({ state: 'ready' }), get: () => null, list: () => [] } as any,
      ledger: { listEpisodes: () => [] } as any, enrollment: {} as any, profiles: {} as any, quotaPoller: {} as any,
      identityOracle: {} as any, pasteBack: {} as any, createBrowser: () => { throw new Error('x'); },
      resolveSecret: async () => null, supervise: async () => { throw new Error('x'); }, navigation: 'closed' });
    const ctx = subscriptionReloginRouteContext(runtime);
    expect(ctx.helperSubmit).toBeUndefined();
    const server = new AgentServer({ config: cfg, state: new StateManager(cfg.stateDir),
      sessionManager: { listRunningSessions: () => [], getSession: () => null, on: vi.fn() } as never, subscriptionRelogin: ctx });
    servers.push(server);
    await server.start();
    const response = await request(server.getApp()).post('/subscription-relogin/ep/code')
      .set('Content-Type', 'application/json').set('X-Relogin-Helper-Token', 'x').send({ code: CODE });
    expect(response.status).toBe(503);
  });
});

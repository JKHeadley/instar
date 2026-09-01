import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoutes } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SubscriptionReloginStore } from '../../src/core/SubscriptionReloginStore.js';

interface TestServer { url: string; close: () => Promise<void> }
async function listen(app: express.Express): Promise<TestServer> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      close: () => new Promise<void>((done) => server.close(() => done())),
    }));
  });
}

describe('/subscription-relogin routes', () => {
  let dir: string;
  let server: TestServer;
  let store: SubscriptionReloginStore;
  let episodeId: string;
  let approve: ReturnType<typeof vi.fn>;
  let retry: ReturnType<typeof vi.fn>;
  let config: { authToken: string; dashboardPin: string; stateDir: string; port: number };
  let gateDecision: 'allow' | 'deny';
  let deliveredBounds: { accountId: string; targetMachineId: string; mechanism: string; episodeId?: string; inputDigest?: string; repairAction?: string } | null;
  let peerUrls: Array<{ machineId: string; url: string }>;
  let issue: ReturnType<typeof vi.fn>;
  let revoke: ReturnType<typeof vi.fn>;
  let deliveredConsumeCalls: number;
  const extraServers: TestServer[] = [];

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subscription-relogin-routes-'));
    let idSequence = 0;
    store = new SubscriptionReloginStore({ stateDir: dir, idFactory: () => `repair-${++idSequence}` });
    const episode = store.suggest({ sourceEpisodeId: 1, accountId: 'acct-1', machineId: 'machine-1',
      mode: 'approval', inputDigest: `sha256:${'a'.repeat(64)}`, profileId: 'profile-1',
      framework: 'claude-code', provider: 'anthropic' });
    episodeId = episode.id;
    approve = vi.fn(async (id: string) => {
      const current = store.get(id); if (!current) throw new Error('relogin-episode-not-found');
      return store.approve(id, { inputDigest: current.inputDigest });
    });
    retry = vi.fn(async (id: string) => {
      const current = store.get(id); if (!current) throw new Error('relogin-episode-not-found');
      return store.retryFailed(id, { inputDigest: current.inputDigest });
    });
    gateDecision = 'allow';
    deliveredBounds = null;
    peerUrls = [];
    issue = vi.fn(() => ({ id: 'mandate-1' }));
    revoke = vi.fn(() => ({ id: 'mandate-1', revoked: { at: new Date().toISOString(), reason: 'consumed' } }));
    deliveredConsumeCalls = 0;
    config = { authToken: 'test', dashboardPin: '123456', stateDir: dir, port: 0 };
    const app = express(); app.use(express.json());
    app.use(createRoutes({
      config,
      startTime: new Date(),
      meshSelfId: 'machine-1',
      verifyDashboardOperatorSession: (token: string | undefined) => token === 'operator-proof',
      subscriptionRelogin: { store, approve, cancel: async (id: string) => store.cancel(id), retry },
      coordination: {
        store: { issue, revoke },
        gate: { evaluate: vi.fn(() => ({ decision: gateDecision, reason: 'test verdict' })) },
      },
      verifyDeliveredMandate: () => deliveredBounds,
      consumeDeliveredMandate: () => { deliveredConsumeCalls += 1; return true; },
      resolvePeerUrls: () => peerUrls,
    } as any));
    server = await listen(app);
    config.port = Number(new URL(server.url).port);
  });

  afterEach(async () => {
    for (const extra of extraServers.splice(0)) await extra.close();
    await server?.close();
    store?.close();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'subscription-relogin-routes.test cleanup' });
  });

  const api = (url: string, init?: RequestInit) => fetch(server.url + url, {
    headers: { 'Content-Type': 'application/json' }, ...init,
  }).then(async (response) => ({ status: response.status, body: await response.json() }));

  it('serves bounded closed-metadata episode and event views', async () => {
    const list = await api('/subscription-relogin?state=suggested&limit=1');
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ enabled: true, episodes: [{ id: episodeId, state: 'suggested' }] });
    const events = await api(`/subscription-relogin/${episodeId}/events`);
    expect(events.status).toBe(200);
    expect(events.body.events[0]).toMatchObject({ eventClass: 'candidate-admitted' });
    expect(JSON.stringify({ list: list.body, events: events.body })).not.toMatch(/password|cookie|verificationUrl|userCode/i);
  });

  it('serves a machine-tagged pool view and drives one-click repair through an exact mandate', async () => {
    const list = await api('/subscription-relogin?scope=pool');
    expect(list).toMatchObject({
      status: 200,
      body: { scope: 'pool', episodes: [{ id: episodeId, accountId: 'acct-1', machineId: 'machine-1', remote: false }] },
    });
    const bearerOnly = await api('/subscription-relogin/repair-cell', {
      method: 'POST', body: JSON.stringify({ accountId: 'acct-1', machineId: 'machine-1', episodeId }),
    });
    expect(bearerOnly.status).toBe(401);
    const accepted = await api('/subscription-relogin/repair-cell', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Instar-Operator-Session': 'operator-proof' },
      body: JSON.stringify({ accountId: 'acct-1', machineId: 'machine-1', episodeId }),
    });
    expect(accepted).toMatchObject({ status: 202, body: { accepted: true, episode: { state: 'approved' } } });
    expect(approve).toHaveBeenCalledOnce();
    expect(issue).toHaveBeenCalledWith(expect.objectContaining({ authorities: [{
      action: 'account-follow-me',
      bounds: expect.objectContaining({ accountId: 'acct-1', targetMachineId: 'machine-1', episodeId, inputDigest: store.get(episodeId)!.inputDigest, repairAction: 'approve' }),
    }] }));
    const issued = issue.mock.calls.at(-1)?.[0];
    const remainingMs = Date.parse(issued.expiresAt) - Date.now();
    expect(remainingMs).toBeGreaterThan(14 * 60_000);
    expect(remainingMs).toBeLessThanOrEqual(15 * 60_000);
    expect(revoke).toHaveBeenCalledWith('mandate-1', 'consumed by subscription re-login');
  });

  it('merges machine-tagged peer episodes into the pool view', async () => {
    const peerApp = express();
    peerApp.get('/subscription-relogin', (_req, res) => res.json({ enabled: true, episodes: [
      { id: 'remote-repair', accountId: 'acct-2', machineId: 'machine-2', state: 'suggested' },
    ] }));
    const peer = await listen(peerApp); extraServers.push(peer);
    peerUrls = [{ machineId: 'machine-2', url: peer.url }];
    const list = await api('/subscription-relogin?scope=pool');
    expect(list.body.episodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'remote-repair', machineId: 'machine-2', remote: true }),
    ]));
    expect(list.body.pool.failed).toEqual([]);
  });

  it('keeps remote pool status and one-click dispatch alive when the dashboard host has no local runtime', async () => {
    const remoteEpisode = { id: 'remote-repair', accountId: 'acct-2', machineId: 'machine-2',
      state: 'suggested', inputDigest: `sha256:${'c'.repeat(64)}` };
    const peerApp = express(); peerApp.use(express.json());
    peerApp.get('/subscription-relogin', (_req, res) => res.json({ enabled: true, episodes: [remoteEpisode] }));
    peerApp.get('/subscription-relogin/:id/events', (_req, res) => res.json({ enabled: true, episode: remoteEpisode, events: [] }));
    peerApp.post('/subscription-relogin/:id/approve-with-mandate', (_req, res) => res.status(202).json({ accepted: true }));
    const peer = await listen(peerApp); extraServers.push(peer);

    await server.close();
    const frontApp = express(); frontApp.use(express.json());
    frontApp.use(createRoutes({
      config, startTime: new Date(), meshSelfId: 'machine-1',
      verifyDashboardOperatorSession: (token: string | undefined) => token === 'operator-proof',
      resolvePeerUrls: () => [{ machineId: 'machine-2', url: peer.url }],
      coordination: { store: { issue }, gate: { evaluate: vi.fn() } },
      packageMandateForDelivery: vi.fn((mandate) => ({ mandate, issuanceSignature: {} })),
      deliverMandateToMachine: vi.fn(async () => ({ ok: true, status: 202 })),
    } as any));
    server = await listen(frontApp);
    config.port = Number(new URL(server.url).port);

    const pool = await api('/subscription-relogin?scope=pool');
    expect(pool.body.episodes).toContainEqual(expect.objectContaining({ id: 'remote-repair', remote: true }));
    expect(pool.body.pool.failed).toEqual([]);
    expect(pool.body.pool.unavailable).toContainEqual({ machineId: 'machine-1', reason: 'feature-unavailable' });
    const started = await api('/subscription-relogin/repair-cell', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Instar-Operator-Session': 'operator-proof' },
      body: JSON.stringify({ accountId: 'acct-2', machineId: 'machine-2', episodeId: 'remote-repair' }),
    });
    expect(started.status).toBe(202);
    expect(issue).toHaveBeenCalledWith(expect.objectContaining({ authorities: [{ action: 'account-follow-me', bounds: expect.objectContaining({
      episodeId: 'remote-repair', inputDigest: remoteEpisode.inputDigest, repairAction: 'approve',
    }) }] }));
  });

  it('fails closed unless the point-of-use mandate exactly matches account and machine', async () => {
    gateDecision = 'deny';
    const denied = await api(`/subscription-relogin/${episodeId}/approve-with-mandate`, {
      method: 'POST', body: JSON.stringify({ mandateId: 'mandate-1', accountId: 'acct-1' }),
    });
    expect(denied.status).toBe(403);
    expect(approve).not.toHaveBeenCalled();
    deliveredBounds = { accountId: 'different', targetMachineId: 'machine-1', mechanism: 're-mint' };
    expect((await api(`/subscription-relogin/${episodeId}/approve-with-mandate`, {
      method: 'POST', body: JSON.stringify({ mandateId: 'mandate-1', accountId: 'acct-1' }),
    })).status).toBe(403);
    deliveredBounds = { accountId: 'acct-1', targetMachineId: 'machine-1', mechanism: 're-mint',
      episodeId, inputDigest: store.get(episodeId)!.inputDigest, repairAction: 'approve' };
    const accepted = await api(`/subscription-relogin/${episodeId}/approve-with-mandate`, {
      method: 'POST', body: JSON.stringify({ mandateId: 'mandate-1', accountId: 'acct-1' }),
    });
    expect(accepted.status).toBe(202);
    expect(approve).toHaveBeenCalledOnce();
    expect(deliveredConsumeCalls).toBe(1);
  });

  it('requires the operator PIN and starts exactly one immutable approval', async () => {
    const missing = await api(`/subscription-relogin/${episodeId}/approve`, { method: 'POST', body: '{}' });
    expect(missing.status).toBe(401);
    expect(approve).not.toHaveBeenCalled();
    const wrong = await api(`/subscription-relogin/${episodeId}/approve`, {
      method: 'POST', body: JSON.stringify({ pin: '654321' }),
    });
    expect(wrong.status).toBe(401);
    const accepted = await api(`/subscription-relogin/${episodeId}/approve`, {
      method: 'POST', body: JSON.stringify({ pin: '123456' }),
    });
    expect(accepted.status).toBe(202);
    expect(accepted.body).toMatchObject({ accepted: true, episode: { state: 'approved' } });
    expect(approve).toHaveBeenCalledOnce();
    const replay = await api(`/subscription-relogin/${episodeId}/approve`, {
      method: 'POST', body: JSON.stringify({ pin: '123456' }),
    });
    expect(replay.status).toBe(409);
  });

  it('accepts a scoped dashboard operator session but not an ordinary bearer-shaped value', async () => {
    const bearerOnly = await api(`/subscription-relogin/${episodeId}/approve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Instar-Operator-Session': 'test' }, body: '{}',
    });
    expect(bearerOnly.status).toBe(401);
    const accepted = await api(`/subscription-relogin/${episodeId}/approve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Instar-Operator-Session': 'operator-proof' }, body: '{}',
    });
    expect(accepted.status).toBe(202);
  });

  it('makes PIN-gated cancellation authoritative and idempotent', async () => {
    const cancelled = await api(`/subscription-relogin/${episodeId}/cancel`, {
      method: 'POST', body: JSON.stringify({ pin: '123456' }),
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ cancelled: true, episode: { state: 'cancelled' } });
    const again = await api(`/subscription-relogin/${episodeId}/cancel`, {
      method: 'POST', body: JSON.stringify({ pin: '123456' }),
    });
    expect(again.body).toMatchObject({ cancelled: true, episode: { state: 'cancelled' } });
  });

  it('requires operator proof for an explicit bounded retry and invokes the real retry seam once', async () => {
    const approved = store.approve(episodeId, { inputDigest: store.get(episodeId)!.inputDigest });
    const starting = store.transition(episodeId, { expectedVersion: approved.version, to: 'cli-starting',
      eventClass: 'cli-starting', incrementAttempt: true });
    store.transition(episodeId, { expectedVersion: starting.version, to: 'failed',
      eventClass: 'provider-rejected', failureClass: 'provider-rejected' });
    expect((await api(`/subscription-relogin/${episodeId}/retry`, { method: 'POST', body: '{}' })).status).toBe(401);
    const response = await api(`/subscription-relogin/${episodeId}/retry`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Instar-Operator-Session': 'operator-proof' }, body: '{}',
    });
    expect(response).toMatchObject({ status: 202, body: { accepted: true, episode: { state: 'approved', attemptCount: 0 } } });
    expect(retry).toHaveBeenCalledOnce();
  });

  it('returns typed disabled and not-found outcomes', async () => {
    expect((await api('/subscription-relogin/missing/events')).status).toBe(404);
    await server.close();
    const app = express(); app.use(express.json());
    app.use(createRoutes({ config: { authToken: 't', stateDir: dir, port: 0 }, startTime: new Date() } as any));
    server = await listen(app);
    expect(await api('/subscription-relogin')).toMatchObject({ status: 503, body: { enabled: false } });
  });
});

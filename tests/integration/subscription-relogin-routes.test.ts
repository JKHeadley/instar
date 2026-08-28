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

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subscription-relogin-routes-'));
    store = new SubscriptionReloginStore({ stateDir: dir, idFactory: () => 'repair-1' });
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
    const app = express(); app.use(express.json());
    app.use(createRoutes({
      config: { authToken: 'test', dashboardPin: '123456', stateDir: dir, port: 0 },
      startTime: new Date(),
      verifyDashboardOperatorSession: (token: string | undefined) => token === 'operator-proof',
      subscriptionRelogin: { store, approve, cancel: async (id: string) => store.cancel(id), retry },
    } as any));
    server = await listen(app);
  });

  afterEach(async () => {
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

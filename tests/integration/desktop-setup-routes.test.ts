import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { DesktopSetupRefused } from '../../src/core/DesktopSetupTarget.js';

const AUTH = 'desktop-setup-token';
const SELF = `m_${'a'.repeat(32)}`;
const PEER = `m_${'b'.repeat(32)}`;
const OLD = `m_${'c'.repeat(32)}`;

const liveOff = { platform: 'darwin', configured: false, configuredAtBoot: false, targetConstructed: false, status: 'off' };
const liveReady = { platform: 'darwin', configured: true, configuredAtBoot: true, frontMachineId: SELF,
  targetConstructed: true, status: 'ready', sessionActive: true, displayCount: 1,
  screenPermission: true, inputPermission: true, screenGrant: 'own', inputGrant: 'own' };

function app(extras: Partial<RouteContext> & { self?: Record<string, unknown>; config?: unknown } = {}) {
  const run = vi.fn(async (req: { action: string }) => (req.action === 'status' ? (extras.self ?? liveReady) : { restartRequested: true }));
  const peerCall = vi.fn(async (id: string, body: Record<string, unknown>) => {
    if (id === OLD) throw Object.assign(new Error('old'), { status: 404 });
    if (body.action === 'status') return liveOff;
    if (body.action === 'show-prompt') throw Object.assign(new Error('no'), { status: 409, code: 'locked' });
    return { restartRequested: true };
  });
  const { config: configOverride, self: _self, ...rest } = extras;
  const ctx = {
    config: { projectName: 'setup', projectDir: '/tmp', stateDir: '/tmp', port: 0, authToken: AUTH,
      developmentAgent: true, remoteDesktop: { enabled: true, frontMachineId: SELF }, ...(configOverride as object) },
    sessionManager: { listRunningSessions: () => [] }, state: {}, scheduler: null, startTime: new Date(),
    meshSelfId: SELF,
    listPoolMachines: () => [
      { machineId: SELF, nickname: 'Mac Studio' }, { machineId: PEER, nickname: 'Mac M5 Pro' }, { machineId: OLD, nickname: 'Laptop' },
    ],
    desktopSetupTarget: { run },
    desktopSetupPeerCall: peerCall,
    desktopMeshBroker: {},
    desktopTargetSigningKey: () => 'key',
    verifyDashboardOperatorSession: (token: string) => token === 'operator-proof',
    ...rest,
  } as unknown as RouteContext;
  const server = express();
  server.use(express.json());
  server.use(authMiddleware(AUTH));
  server.use('/', createRoutes(ctx));
  return { server, run, peerCall };
}

const pin = (r: request.Test) => r.set('Authorization', `Bearer ${AUTH}`).set('X-Instar-Operator-Session', 'operator-proof');

describe('guided setup routes', () => {
  it('needs the PIN session: a Bearer token alone is refused on every route', async () => {
    const { server, run } = app();
    const bearer = { Authorization: `Bearer ${AUTH}`, 'X-Instar-Request': '1' };
    expect((await request(server).get('/desktop/setup').set(bearer)).status).toBe(403);
    expect((await request(server).get(`/desktop/setup/${PEER}`).set(bearer)).status).toBe(403);
    expect((await request(server).post(`/desktop/setup/${PEER}`).set(bearer).send({ action: 'turn-on' })).status).toBe(403);
    expect(run).not.toHaveBeenCalled();
  });

  it('lists each machine under the pool’s name, with an old peer named as such', async () => {
    const { server } = app();
    const response = await pin(request(server).get('/desktop/setup'));
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.machines.map((row: { label: string; state: string }) => [row.label, row.state])).toEqual([
      ['Mac Studio', 'ready'], ['Mac M5 Pro', 'off'], ['Laptop', 'needs-update'],
    ]);
  });

  it('turns a peer on, then reads it as restarting while it is silent', async () => {
    const { server, peerCall } = app();
    const response = await pin(request(server).post(`/desktop/setup/${PEER}`)).set('X-Instar-Request', '1').send({ action: 'turn-on' });
    expect(response.status).toBe(200);
    expect(peerCall).toHaveBeenCalledWith(PEER, { action: 'turn-on', frontMachineId: SELF });
    peerCall.mockRejectedValueOnce(new Error('down'));
    expect((await pin(request(server).get(`/desktop/setup/${PEER}`))).body.state).toBe('restarting');
  });

  it('needs the intent header and a known action', async () => {
    const { server } = app();
    expect((await pin(request(server).post(`/desktop/setup/${PEER}`)).send({ action: 'turn-on' })).status).toBe(403);
    expect((await pin(request(server).post(`/desktop/setup/${PEER}`)).set('X-Instar-Request', '1').send({ action: 'exec' })).status).toBe(400);
    expect((await pin(request(server).post(`/desktop/setup/${PEER}`)).set('X-Instar-Request', '1')
      .send({ action: 'open-settings', pane: 'other' })).status).toBe(400);
  });

  it('refuses an unknown machine', async () => {
    const { server } = app();
    const unknown = `m_${'d'.repeat(32)}`;
    expect((await pin(request(server).get(`/desktop/setup/${unknown}`))).status).toBe(404);
    expect((await pin(request(server).post(`/desktop/setup/${unknown}`)).set('X-Instar-Request', '1').send({ action: 'turn-on' })).status).toBe(404);
  });

  it('turns a peer refusal into fixed wording and a fresh step', async () => {
    const { server } = app();
    const response = await pin(request(server).post(`/desktop/setup/${PEER}`)).set('X-Instar-Request', '1').send({ action: 'show-prompt' });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('locked');
    expect(response.body.error).toContain('locked');
    expect(response.body.step.machineId).toBe(PEER);
  });

  it('carries this machine’s own refusal the same way', async () => {
    const { server, run } = app();
    run.mockImplementation(async (req: { action: string }) => {
      if (req.action === 'status') return liveReady;
      throw new DesktopSetupRefused('wait', 'x', 429);
    });
    const response = await pin(request(server).post(`/desktop/setup/${SELF}`)).set('X-Instar-Request', '1').send({ action: 'show-prompt' });
    expect(response.status).toBe(429);
    expect(response.body.code).toBe('wait');
  });

  it('sends the operator to the front when this machine is not it, keeping its own undo', async () => {
    const { server, peerCall, run } = app({ config: { remoteDesktop: { enabled: true, frontMachineId: PEER } } });
    const list = await pin(request(server).get('/desktop/setup'));
    expect(list.body.frontElsewhere).toBe(true);
    expect(list.body.frontLabel).toBe('Mac M5 Pro');
    expect(list.body.machines.map((row: { machineId: string }) => row.machineId)).toEqual([SELF]);
    const refused = await pin(request(server).post(`/desktop/setup/${OLD}`)).set('X-Instar-Request', '1').send({ action: 'turn-on' });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('front-elsewhere');
    expect(peerCall).not.toHaveBeenCalled();
    const own = await pin(request(server).post(`/desktop/setup/${SELF}`)).set('X-Instar-Request', '1').send({ action: 'turn-off' });
    expect(own.status).toBe(200);
    expect(run).toHaveBeenCalledWith({ action: 'turn-off' }, null);
  });

  it('checks for an existing front on the action itself, not only on the list', async () => {
    const { server, peerCall, run } = app({ config: { remoteDesktop: { enabled: false } }, self: liveOff, desktopMeshBroker: null });
    peerCall.mockImplementation(async () => ({ ...liveReady, frontMachineId: PEER }));
    const refused = await pin(request(server).post(`/desktop/setup/${SELF}`)).set('X-Instar-Request', '1').send({ action: 'turn-on' });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('front-elsewhere');
    expect(run).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'turn-on' }), null);
  });

  it('does not found a second front when a peer already names one', async () => {
    const { server, peerCall } = app({ config: { remoteDesktop: { enabled: false } }, self: liveOff, desktopMeshBroker: null });
    peerCall.mockImplementation(async () => ({ ...liveReady, frontMachineId: PEER }));
    const list = await pin(request(server).get('/desktop/setup'));
    expect(list.body.frontElsewhere).toBe(true);
    expect(list.body.frontLabel).toBe('Mac M5 Pro');
  });

  it('with this machine still off, offers it first and holds peers', async () => {
    const { server, peerCall } = app({ config: { remoteDesktop: { enabled: false } }, self: liveOff, desktopMeshBroker: null });
    const list = await pin(request(server).get('/desktop/setup'));
    expect(list.body.machines.map((row: { state: string }) => row.state).slice(0, 2)).toEqual(['off', 'front-first']);
    expect(list.body.machines[0].detail).toContain('becomes the front');
    const held = await pin(request(server).post(`/desktop/setup/${PEER}`)).set('X-Instar-Request', '1').send({ action: 'turn-on' });
    expect(held.status).toBe(409);
    expect(held.body.error).toBe('front-first');
    expect(peerCall).not.toHaveBeenCalledWith(PEER, expect.objectContaining({ action: 'turn-on' }));
  });

  it('can still turn a peer off once the front itself is off', async () => {
    const { server, peerCall } = app({ desktopMeshBroker: null });
    const off = await pin(request(server).post(`/desktop/setup/${PEER}`)).set('X-Instar-Request', '1').send({ action: 'turn-off' });
    expect(off.status).toBe(200);
    expect(peerCall).toHaveBeenCalledWith(PEER, { action: 'turn-off' });
  });

  it('never calls a machine ready that the picker would refuse', async () => {
    const { server } = app({ desktopTargetSigningKey: () => null });
    const row = (await pin(request(server).get(`/desktop/setup/${SELF}`))).body;
    expect(row.ready).toBe(false);
    expect(row.state).toBe('identity-unverified');
  });

  it('shows a peer under the pool’s name in the picker, not its own', async () => {
    const access = { targetInfo: () => ({ machineId: SELF, label: 'Mac Studio' }),
      probe: async () => ({ ready: true, screenPermission: true, inputPermission: true, displayCount: 1 }) };
    const { server } = app({ directDesktopAccess: access as never,
      desktopProbePeer: async machineId => ({ machineId, label: 'Mac Lan', ready: true }),
      topicOperatorStore: { all: () => ({}) } as never });
    const response = await pin(request(server).get('/desktop/targets'));
    const labels = response.body.machines.map((machine: { label: string }) => machine.label);
    expect(labels).toContain('Mac M5 Pro');
    expect(labels).not.toContain('Mac Lan');
  });
});

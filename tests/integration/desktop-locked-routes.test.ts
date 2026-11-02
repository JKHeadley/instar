import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';

const AUTH = 'desktop-locked-token';
const headers = { Authorization: `Bearer ${AUTH}`, 'X-Instar-Request': '1', 'X-Instar-Operator-Session': 'operator-proof' };

function app(extras: Partial<RouteContext> = {}) {
  const ctx = {
    config: { projectName: 'desktop-test', projectDir: '/tmp', stateDir: '/tmp', port: 0, authToken: AUTH },
    sessionManager: { listRunningSessions: () => [] }, state: {}, scheduler: null,
    verifyDashboardOperatorSession: (token: string) => token === 'operator-proof',
    startTime: new Date(), ...extras,
  } as unknown as RouteContext;
  const server = express();
  server.use(express.json());
  server.use(authMiddleware(AUTH));
  server.use('/', createRoutes(ctx));
  return server;
}
const levers = (over: Record<string, unknown> = {}) => ({ machineId: 'm_self', status: async () => ({ enabled: false, refusal: 'unsupported-macos' }),
  settings: vi.fn(async (patch: Record<string, unknown>) => patch), disable: vi.fn(async () => {}), ...over });

describe('locked-screen routes', () => {
  it('answer 503 where the machine has no locked-screen levers', async () => {
    expect((await request(app()).get('/desktop/locked/status').set(headers)).status).toBe(503);
  });

  it('require the bearer token', async () => {
    expect((await request(app({ desktopLocked: levers() as never })).get('/desktop/locked/status')).status).toBe(401);
  });

  it('report state, and name a dark peer rather than hiding it', async () => {
    const broker = { lockedStatus: vi.fn(async (id: string) => { if (id === 'm_dark') throw new Error('down'); return { enabled: false }; }) };
    const server = app({ desktopLocked: levers() as never, desktopMeshBroker: broker as never, desktopTargets: () => ['m_peer', 'm_dark'] });
    const local = await request(server).get('/desktop/locked/status').set(headers);
    expect(local.body).toMatchObject({ machineId: 'm_self', refusal: 'unsupported-macos' });
    const pool = await request(server).get('/desktop/locked/status?scope=pool').set(headers);
    expect(pool.body.machines.map((row: { machineId: string }) => row.machineId)).toEqual(['m_self', 'm_peer']);
    expect(pool.body.failed).toEqual([{ machineId: 'm_dark', reason: 'unreachable' }]);
  });

  it('settings need a PIN session, the intent header and a real setting', async () => {
    const desktopLocked = levers();
    const server = app({ desktopLocked: desktopLocked as never });
    expect((await request(server).post('/desktop/locked/settings').set({ ...headers, 'X-Instar-Operator-Session': 'nope' }).send({ enabled: true })).status).toBe(403);
    expect((await request(server).post('/desktop/locked/settings').set({ Authorization: headers.Authorization, 'X-Instar-Operator-Session': 'operator-proof' }).send({ enabled: true })).status).not.toBe(200);
    expect((await request(server).post('/desktop/locked/settings').set(headers).send({ password: 'x' })).status).toBe(400);
    expect((await request(server).post('/desktop/locked/settings').set(headers).send({ enabled: 'yes' })).status).toBe(400);
    expect(desktopLocked.settings).not.toHaveBeenCalled();
  });

  it('an unproven macOS refuses the enable with a named reason', async () => {
    const server = app({ desktopLocked: levers({ settings: async () => { throw new Error('unsupported-macos'); } }) as never });
    const reply = await request(server).post('/desktop/locked/settings').set(headers).send({ enabled: true });
    expect(reply.status).toBe(409);
    expect(reply.body.error).toBe('unsupported-macos');
  });

  it('disable needs only the bearer token and intent header', async () => {
    const desktopLocked = levers();
    const server = app({ desktopLocked: desktopLocked as never });
    const reply = await request(server).post('/desktop/locked/disable')
      .set({ Authorization: headers.Authorization, 'X-Instar-Request': '1' }).send({});
    expect(reply.body).toEqual({ disabled: true });
    expect(desktopLocked.disable).toHaveBeenCalledOnce();
  });

  it('a phone reaches another Mac through the front', async () => {
    const broker = { locked: vi.fn(async () => ({ enabled: true })) };
    const server = app({ desktopLocked: levers() as never, desktopMeshBroker: broker as never });
    await request(server).post('/desktop/locked/settings').set(headers).send({ machineId: 'm_other', chime: false });
    expect(broker.locked).toHaveBeenCalledWith('operator-proof', 'm_other', 'locked-settings', { chime: false });
    await request(server).post('/desktop/locked/disable').set(headers).send({ machineId: 'm_other' });
    expect(broker.locked).toHaveBeenCalledWith('operator-proof', 'm_other', 'locked-disable', {});
  });

  it('PATCH /config cannot reach the setting', async () => {
    const server = app({ desktopLocked: levers() as never });
    const reply = await request(server).patch('/config').set(headers).send({ remoteDesktop: { lockedScreen: { enabled: true } } });
    expect(reply.status).toBe(400);
  });
});

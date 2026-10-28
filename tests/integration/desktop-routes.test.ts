import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import type { DirectDesktopAccess } from '../../src/core/DirectDesktopAccess.js';

const AUTH = 'desktop-route-token';
const operator = { platform: 'telegram', uid: '7812716706' };

function app(access: DirectDesktopAccess | null) {
  const received: unknown[] = [];
  const ctx = {
    config: { projectName: 'desktop-test', projectDir: '/tmp', stateDir: '/tmp', port: 0, authToken: AUTH },
    sessionManager: { listRunningSessions: () => [] }, state: {}, scheduler: null,
    directDesktopAccess: access,
    telegram: { getTopicName: (id: number) => id === 131439 ? 'Remote access + blocker hand-off design' : null },
    verifyDashboardOperatorSession: (token: string) => token === 'operator-proof',
    topicOperatorStore: { all: () => ({ 131439: operator }), getOperator: (id: number) => id === 131439 ? operator : null },
    startTime: new Date(),
  } as unknown as RouteContext;
  const server = express();
  server.use(express.json());
  server.use(authMiddleware(AUTH));
  server.use('/', createRoutes(ctx));
  return { server, received };
}

function fakeAccess(): DirectDesktopAccess {
  return {
    requiresTelegramStepUp: () => false,
    targetInfo: () => ({ machineId: 'machine-1', label: 'Echo Mac' }),
    probe: async () => ({ ready: true, screenPermission: true, inputPermission: true, displayCount: 1 }),
    begin: async input => { expect(input.operatorUid).toBe('dashboard-pin'); return { requestId: 'request-1' }; },
    status: () => ({ status: 'approved', connectionNonce: 'nonce-1' }),
    cursor: async () => ({ x: 0.25, y: 0.75 }),
    ticket: () => 'ticket-1',
    revoke: () => {},
  } as unknown as DirectDesktopAccess;
}

describe('remote desktop HTTP routes', () => {
  it('requires bearer auth and remains 503 when the gate is dark', async () => {
    const { server } = app(null);
    expect((await request(server).get('/desktop/targets')).status).toBe(401);
    expect((await request(server).get('/desktop/targets').set('Authorization', `Bearer ${AUTH}`)).status).toBe(503);
    expect((await request(server).get('/desktop/availability').set('Authorization', `Bearer ${AUTH}`)).status).toBe(503);
  });

  it('requires a dashboard operator proof for the target list', async () => {
    const { server } = app(fakeAccess());
    const availability = await request(server).get('/desktop/availability').set('Authorization', `Bearer ${AUTH}`);
    expect(availability.body).toEqual({ machineId: 'machine-1', label: 'Echo Mac', ready: true });
    expect((await request(server).get('/desktop/targets').set('Authorization', `Bearer ${AUTH}`)).status).toBe(403);
    const listed = await request(server).get('/desktop/targets').set('Authorization', `Bearer ${AUTH}`)
      .set('X-Instar-Operator-Session', 'operator-proof');
    expect(listed.status).toBe(200);
    expect(listed.body.machines).toEqual([{ machineId: 'machine-1', label: 'Echo Mac', ready: true }]);
    expect(listed.body.topics[0].topicId).toBe(131439);
    expect(listed.body.topics[0].label).toBe('Remote access + blocker hand-off design');
    expect(listed.headers['cache-control']).toBe('no-store');
  });

  it('uses the dashboard PIN session and gates writes on intent', async () => {
    const { server } = app(fakeAccess());
    const headers = { Authorization: `Bearer ${AUTH}`, 'X-Instar-Operator-Session': 'operator-proof' };
    const body = { machineId: 'machine-1',
      browserPublicKey: 'fixture', browserNonce: '0123456789abcdef', operatorUid: 'attacker' };
    expect((await request(server).post('/desktop/requests').set(headers).send(body)).status).toBe(403);
    expect((await request(server).post('/desktop/requests').set({ Authorization: `Bearer ${AUTH}`,
      'X-Instar-Request': '1' }).send(body)).status).toBe(403);
    const created = await request(server).post('/desktop/requests').set({ ...headers, 'X-Instar-Request': '1' }).send(body);
    expect(created.status).toBe(201);
    expect(created.body.requestId).toBe('request-1');
    const status = await request(server).get('/desktop/requests/request-1').set(headers);
    expect(status.body.status).toBe('approved');
    expect((await request(server).get('/desktop/requests/request-1/cursor')
      .set({ Authorization: `Bearer ${AUTH}` })).status).toBe(403);
    const cursor = await request(server).get('/desktop/requests/request-1/cursor').set(headers);
    expect(cursor.status).toBe(200);
    expect(cursor.body).toEqual({ x: 0.25, y: 0.75 });
    const ticket = await request(server).post('/desktop/requests/request-1/ticket')
      .set({ ...headers, 'X-Instar-Request': '1' }).send({ connectionNonce: 'nonce-1', signature: 'fixture' });
    expect(ticket.body).toMatchObject({ ticket: 'ticket-1', machineId: 'machine-1' });
    expect((await request(server).post('/desktop/requests/request-1/revoke')
      .set({ ...headers, 'X-Instar-Request': '1' }).send({})).body).toEqual({ revoked: true });
  });

  it('explains a locked desktop after PIN verification', async () => {
    const access = fakeAccess();
    access.probe = async () => ({ ready: false, screenPermission: true,
      inputPermission: true, displayCount: 1, sessionActive: false });
    const { server } = app(access);
    const listed = await request(server).get('/desktop/targets')
      .set('Authorization', `Bearer ${AUTH}`)
      .set('X-Instar-Operator-Session', 'operator-proof');
    expect(listed.status).toBe(200);
    expect(listed.body.machines[0]).toMatchObject({ ready: false,
      unavailableReason: expect.stringContaining('locked or inactive') });
  });
});

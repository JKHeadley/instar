import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { desktopRouteAccess } from '../../src/server/desktopRouteContext.js';
import { authMiddleware } from '../../src/server/middleware.js';
import type { DirectDesktopAccess } from '../../src/core/DirectDesktopAccess.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const AUTH = 'desktop-route-token';
const operator = { platform: 'telegram', uid: '7812716706' };

function app(access: DirectDesktopAccess | null, extras: Partial<RouteContext> = {}) {
  const received: unknown[] = [];
  const ctx = {
    config: { projectName: 'desktop-test', projectDir: '/tmp', stateDir: '/tmp', port: 0, authToken: AUTH },
    sessionManager: { listRunningSessions: () => [] }, state: {}, scheduler: null,
    directDesktopAccess: access,
    desktopTargetSigningKey: (machineId: string) =>
      machineId === 'machine-1' || machineId.startsWith('m_') ? 'registered-key' : null,
    telegram: { getTopicName: (id: number) => id === 131439 ? 'Remote access + blocker hand-off design' : null },
    verifyDashboardOperatorSession: (token: string) => token === 'operator-proof',
    topicOperatorStore: { all: () => ({ 131439: operator }), getOperator: (id: number) => id === 131439 ? operator : null },
    startTime: new Date(),
    ...extras,
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
    resume: async (_id, _token, _input, attemptId) => ({ status: 'approved', connectionNonce: attemptId }),
    cursor: async () => ({ x: 0.25, y: 0.75 }),
    displays: async () => ({ supported: true, platform: 'macos', canShowAll: false, currentDisplayId: '1',
      displays: [{ id: '1', name: 'Built-in', width: 3024, height: 1964, main: true }] }),
    ticket: () => 'ticket-1',
    revoke: () => {},
  } as unknown as DirectDesktopAccess;
}

describe('remote desktop HTTP routes', () => {
  it('permits only explicit enabled-state rollout through the config API', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-config-'));
    const stateDir = path.join(root, '.instar');
    fs.mkdirSync(stateDir);
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ remoteDesktop: { enabled: false } }));
    try {
      const restarts: { reason: string; requestedBy?: string }[] = [];
      const { server } = app(null, { config: { projectName: 'desktop-test', projectDir: root,
        stateDir, port: 0, authToken: AUTH, remoteDesktop: { enabled: false } } as never,
        requestSupervisedRestart: (reason, requestedBy) => {
          restarts.push({ reason, requestedBy }); return true;
        } });
      const headers = { Authorization: `Bearer ${AUTH}`, 'X-Instar-Request': '1' };
      expect((await request(server).post('/desktop/activate-config').set(headers).send({})).status).toBe(409);
      expect((await request(server).patch('/config').set(headers)
        .send({ remoteDesktop: { endpoint: 'http://attacker.invalid/' } })).status).toBe(400);
      expect((await request(server).patch('/config').set(headers)
        .send({ remoteDesktop: { enabled: true } })).status).toBe(200);
      expect(JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf8')).remoteDesktop.enabled).toBe(true);
      const frontMachineId = `m_${'a'.repeat(32)}`;
      expect((await request(server).patch('/config').set(headers)
        .send({ remoteDesktop: { frontMachineId } })).status).toBe(200);
      expect(JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf8')).remoteDesktop.frontMachineId)
        .toBe(frontMachineId);
      expect((await request(server).patch('/config').set(headers)
        .send({ remoteDesktop: { frontMachineId: 'attacker' } })).status).toBe(400);
      expect((await request(server).post('/desktop/activate-config').set('Authorization', `Bearer ${AUTH}`)
        .send({})).status).toBe(403);
      const activated = await request(server).post('/desktop/activate-config').set(headers).send({});
      expect(activated.status).toBe(202);
      expect(activated.body).toEqual({ restartRequested: true });
      expect(restarts).toEqual([{ reason: 'remote desktop configuration activation',
        requestedBy: 'remote-desktop-config' }]);
    } finally {
      SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'desktop config test cleanup' });
    }
  });

  it('requires bearer auth and remains 503 when the gate is dark', async () => {
    const { server } = app(null);
    expect((await request(server).get('/desktop/targets')).status).toBe(401);
    expect((await request(server).get('/desktop/targets').set('Authorization', `Bearer ${AUTH}`)).status).toBe(503);
    expect((await request(server).get('/desktop/availability').set('Authorization', `Bearer ${AUTH}`)).status).toBe(503);
    expect((await request(server).post('/desktop/activate-config').set('Authorization', `Bearer ${AUTH}`)
      .set('X-Instar-Request', '1').send({})).status).toBe(409);
    expect((await request(server).post('/desktop/request-permission').set('Authorization', `Bearer ${AUTH}`)
      .set('X-Instar-Request', '1').send({})).status).toBe(503);
  });

  it('keeps target diagnostics bearer-only and reports probe signals without a desktop grant', async () => {
    const probe = { configured: true, targetConstructed: true, status: 'not-ready',
      screenPermission: true, inputPermission: true, displayCount: 1, sessionActive: false };
    const getter = vi.fn(async () => probe);
    const { server } = app(null, { desktopLocalDiagnostics: getter });
    expect((await request(server).get('/desktop/diagnostics')).status).toBe(401);
    const result = await request(server).get('/desktop/diagnostics')
      .set('Authorization', `Bearer ${AUTH}`);
    expect(result.status).toBe(200);
    expect(result.body).toEqual(probe);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(getter).toHaveBeenCalledOnce();
    expect((await request(server).get('/desktop/availability')
      .set('Authorization', `Bearer ${AUTH}`)).status).toBe(503);
  });

  it('shows the Mac permission prompt only on an authenticated, intentional, paced request', async () => {
    let requests = 0;
    const access = { ...fakeAccess(), requestPermission: async () => { requests++; return { screenPermission: false, inputPermission: true }; } };
    const { server } = app(access as unknown as DirectDesktopAccess,
      desktopRouteAccess(access as unknown as DirectDesktopAccess, 'machine-1', 'machine-1'));
    const url = '/desktop/request-permission';
    expect((await request(server).post(url).set('X-Instar-Request', '1')).status).toBe(401);
    expect((await request(server).post(url).set('Authorization', `Bearer ${AUTH}`)).status).toBe(403);
    const headers = { Authorization: `Bearer ${AUTH}`, 'X-Instar-Request': '1' };
    const first = await request(server).post(url).set(headers);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ screenPermission: false, inputPermission: true });
    expect((await request(server).post(url).set(headers)).status).toBe(429);
    expect(requests).toBe(1);
  });

  it('answers the permission prompt on a non-front target while front-only routes stay refused', async () => {
    let requests = 0;
    const access = { ...fakeAccess(), requestPermission: async () => {
      requests++; return { screenPermission: true, inputPermission: false }; } } as unknown as DirectDesktopAccess;
    const routeAccess = desktopRouteAccess(access, 'm_front', 'm_target');
    const { server } = app(routeAccess.directDesktopAccess, routeAccess);
    const headers = { Authorization: `Bearer ${AUTH}`, 'X-Instar-Request': '1' };
    const operatorHeaders = { ...headers, 'X-Instar-Operator-Session': 'operator-proof' };

    const prompted = await request(server).post('/desktop/request-permission').set(headers);
    expect(prompted.status).toBe(200);
    expect(prompted.body).toEqual({ screenPermission: true, inputPermission: false });
    expect(requests).toBe(1);

    const refused = [
      await request(server).get('/desktop/availability').set(headers),
      await request(server).get('/desktop/targets').set(operatorHeaders),
      await request(server).post('/desktop/requests').set(operatorHeaders).send({}),
      await request(server).get('/desktop/requests/request-1').set(operatorHeaders),
      await request(server).post('/desktop/requests/request-1/resume').set(operatorHeaders).send({}),
      await request(server).get('/desktop/requests/request-1/cursor').set(operatorHeaders),
      await request(server).post('/desktop/requests/request-1/ticket').set(operatorHeaders).send({}),
      await request(server).post('/desktop/requests/request-1/revoke').set(operatorHeaders).send({}),
    ];
    expect(refused.map(result => result.status)).toEqual(Array(refused.length).fill(503));
    expect(refused.every(result => result.body.error === 'Remote desktop is off on this agent')).toBe(true);
  });

  it('reports a fixed Windows bootstrap failure through the authenticated diagnostic only', async () => {
    const getter = vi.fn(async () => ({ configured: false, targetConstructed: false,
      status: 'off', bootstrapFailure: { phase: 'update', code: 'prepare-local-timeout' } }));
    const { server } = app(null, { desktopLocalDiagnostics: getter });
    expect((await request(server).get('/desktop/diagnostics')).status).toBe(401);
    const diagnostic = await request(server).get('/desktop/diagnostics')
      .set('Authorization', `Bearer ${AUTH}`);
    expect(diagnostic.status).toBe(200);
    expect(diagnostic.body.bootstrapFailure).toEqual({ phase: 'update', code: 'prepare-local-timeout' });
    expect((await request(server).get('/desktop/availability')
      .set('Authorization', `Bearer ${AUTH}`)).status).toBe(503);
  });

  it('reports an unavailable restart without claiming activation', async () => {
    const { server } = app(null, { config: { projectName: 'desktop-test', projectDir: '/tmp',
      stateDir: '/tmp', port: 0, authToken: AUTH,
      remoteDesktop: { enabled: true, frontMachineId: `m_${'a'.repeat(32)}` } } as never });
    const response = await request(server).post('/desktop/activate-config')
      .set('Authorization', `Bearer ${AUTH}`).set('X-Instar-Request', '1').send({});
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'Supervised restart is unavailable' });
  });

  it('requires a dashboard operator proof for the target list', async () => {
    const { server } = app(fakeAccess());
    const availability = await request(server).get('/desktop/availability').set('Authorization', `Bearer ${AUTH}`);
    expect(availability.body).toEqual({ machineId: 'machine-1', label: 'Echo Mac', ready: true });
    expect((await request(server).get('/desktop/targets').set('Authorization', `Bearer ${AUTH}`)).status).toBe(403);
    const listed = await request(server).get('/desktop/targets').set('Authorization', `Bearer ${AUTH}`)
      .set('X-Instar-Operator-Session', 'operator-proof');
    expect(listed.status).toBe(200);
    expect(listed.body.machines).toEqual([{ machineId: 'machine-1', label: 'Echo Mac',
      ready: true, targetSigningPublicKey: 'registered-key' }]);
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
    expect((await request(server).post('/desktop/requests/request-1/resume')
      .set(headers).send({ attemptId: 'attempt-1234567890' })).status).toBe(403);
    const resumed = await request(server).post('/desktop/requests/request-1/resume')
      .set({ ...headers, 'X-Instar-Request': '1' }).send({ attemptId: 'attempt-1234567890' });
    expect(resumed.status).toBe(200);
    expect(resumed.body.connectionNonce).toBe('attempt-1234567890');
    expect((await request(server).get('/desktop/requests/request-1/cursor')
      .set({ Authorization: `Bearer ${AUTH}` })).status).toBe(403);
    const cursor = await request(server).get('/desktop/requests/request-1/cursor').set(headers);
    expect(cursor.status).toBe(200);
    expect(cursor.body).toEqual({ x: 0.25, y: 0.75 });
    expect((await request(server).get('/desktop/requests/request-1/displays')
      .set({ Authorization: `Bearer ${AUTH}` })).status).toBe(403);
    const displays = await request(server).get('/desktop/requests/request-1/displays').set(headers);
    expect(displays.status).toBe(200);
    expect(displays.headers['cache-control']).toBe('no-store');
    expect(displays.body).toMatchObject({ supported: true, platform: 'macos', currentDisplayId: '1' });
    const ticket = await request(server).post('/desktop/requests/request-1/ticket')
      .set({ ...headers, 'X-Instar-Request': '1' }).send({ connectionNonce: 'nonce-1', signature: 'fixture' });
    expect(ticket.body).toMatchObject({ ticket: 'ticket-1', machineId: 'machine-1' });
    expect((await request(server).post('/desktop/requests/request-1/revoke')
      .set({ ...headers, 'X-Instar-Request': '1' }).send({})).body).toEqual({ revoked: true });
  });

  it('passes the requested codec and signed resume downgrade through HTTP unchanged', async () => {
    const access = fakeAccess();
    let beginCodec: string | undefined;
    let resumeCodecs: { videoCodec?: string; previousVideoCodec?: string } | undefined;
    access.begin = async input => { beginCodec = input.videoCodec; return { requestId: 'request-1' }; };
    access.resume = async (_id, _token, input, attemptId) => {
      resumeCodecs = input;
      return { status: 'approved', connectionNonce: attemptId };
    };
    const { server } = app(access);
    const headers = { Authorization: `Bearer ${AUTH}`, 'X-Instar-Operator-Session': 'operator-proof',
      'X-Instar-Request': '1' };
    const created = await request(server).post('/desktop/requests').set(headers).send({
      machineId: 'machine-1', browserPublicKey: 'fixture', browserNonce: '0123456789abcdef',
      videoCodec: 'h264',
    });
    expect(created.status).toBe(201);
    expect(beginCodec).toBe('h264');
    const resumed = await request(server).post('/desktop/requests/request-1/resume').set(headers).send({
      attemptId: 'attempt-1234567890', previousVideoCodec: 'h264', videoCodec: 'jpeg',
    });
    expect(resumed.status).toBe(200);
    expect(resumeCodecs).toMatchObject({ previousVideoCodec: 'h264', videoCodec: 'jpeg' });
  });

  it('does not misdiagnose a missing Mac console session as a locked computer', async () => {
    const access = fakeAccess();
    access.probe = async () => ({ ready: false, screenPermission: true,
      inputPermission: true, displayCount: 1, sessionActive: false });
    const { server } = app(access);
    const listed = await request(server).get('/desktop/targets')
      .set('Authorization', `Bearer ${AUTH}`)
      .set('X-Instar-Operator-Session', 'operator-proof');
    expect(listed.status).toBe(200);
    expect(listed.body.machines[0]).toMatchObject({ ready: false,
      unavailableReason: expect.stringContaining('helper has no active console session') });
  });

  it('lists a probed peer and routes its control calls without returning the target session token', async () => {
    const remoteId = `m_${'b'.repeat(32)}`;
    const requestId = '12345678-1234-1234-1234-123456789abc';
    const calls: string[] = [];
    const broker = {
      hasRequest: (id: string) => id === requestId,
      begin: async (_token: string, input: { machineId: string }) => {
        calls.push(`begin:${input.machineId}`);
        return { requestId };
      },
      control: async (_token: string, _id: string, operation: string) => {
        calls.push(operation);
        return operation === 'ticket'
          ? { machineId: remoteId, label: 'Mac Mini', ticket: 'K'.repeat(43) }
          : operation === 'revoke' ? { revoked: true } : { status: 'approved' };
      },
    } as unknown as RouteContext['desktopMeshBroker'];
    const { server } = app(fakeAccess(), {
      desktopMeshBroker: broker,
      listPoolMachines: () => [{ machineId: remoteId, nickname: 'Mac Mini' }],
      desktopProbePeer: async () => ({ machineId: remoteId, label: 'Mac Mini', ready: true }),
    });
    const headers = { Authorization: `Bearer ${AUTH}`, 'X-Instar-Operator-Session': 'operator-proof',
      'X-Instar-Request': '1' };
    const listed = await request(server).get('/desktop/targets').set(headers);
    expect(listed.status).toBe(200);
    expect(listed.body.machines[1]).toMatchObject({ machineId: remoteId, label: 'Mac Mini', ready: true });
    const created = await request(server).post('/desktop/requests').set(headers)
      .send({ machineId: remoteId, browserPublicKey: 'browser', browserNonce: '0123456789abcdef' });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ requestId });
    expect((await request(server).get(`/desktop/requests/${requestId}`).set(headers)).body.status).toBe('approved');
    expect((await request(server).post(`/desktop/requests/${requestId}/ticket`).set(headers)
      .send({ connectionNonce: 'nonce', signature: 'proof' })).body.machineId).toBe(remoteId);
    expect((await request(server).post(`/desktop/requests/${requestId}/revoke`).set(headers)
      .send({})).body).toEqual({ revoked: true });
    expect(calls).toEqual([`begin:${remoteId}`, 'status', 'ticket', 'revoke']);
  });

  it('does not close another PIN session’s relay when its revoke is refused', async () => {
    const requestId = '12345678-1234-1234-1234-123456789abc';
    const closeDesktopMeshRequest = vi.fn();
    const broker = {
      hasRequest: (id: string) => id === requestId,
      control: async (token: string) => {
        if (token !== 'owner') throw new Error('desktop request unavailable');
        return { revoked: true };
      },
    } as unknown as RouteContext['desktopMeshBroker'];
    const { server } = app(fakeAccess(), {
      desktopMeshBroker: broker,
      wsManager: { closeDesktopMeshRequest } as unknown as RouteContext['wsManager'],
      verifyDashboardOperatorSession: token => token === 'owner' || token === 'other',
    });
    const headers = { Authorization: `Bearer ${AUTH}`, 'X-Instar-Request': '1' };
    const refused = await request(server).post(`/desktop/requests/${requestId}/revoke`)
      .set({ ...headers, 'X-Instar-Operator-Session': 'other' }).send({});
    expect(refused.status).toBe(403);
    expect(closeDesktopMeshRequest).not.toHaveBeenCalled();
    const stopped = await request(server).post(`/desktop/requests/${requestId}/revoke`)
      .set({ ...headers, 'X-Instar-Operator-Session': 'owner' }).send({});
    expect(stopped.status).toBe(200);
  });

  it('marks a ready peer unavailable when its registered signing key is missing', async () => {
    const remoteId = `m_${'c'.repeat(32)}`;
    const { server } = app(fakeAccess(), {
      desktopMeshBroker: {} as RouteContext['desktopMeshBroker'],
      listPoolMachines: () => [{ machineId: remoteId, nickname: 'Unverified' }],
      desktopProbePeer: async () => ({ machineId: remoteId, label: 'Unverified', ready: true }),
      desktopTargetSigningKey: machineId => machineId === 'machine-1' ? 'registered-key' : null,
    });
    const listed = await request(server).get('/desktop/targets')
      .set('Authorization', `Bearer ${AUTH}`)
      .set('X-Instar-Operator-Session', 'operator-proof');
    expect(listed.status).toBe(200);
    expect(listed.body.machines[1]).toMatchObject({ machineId: remoteId, ready: false,
      targetSigningPublicKey: null, unavailableReason: expect.stringContaining('identity is not verified') });
  });
});

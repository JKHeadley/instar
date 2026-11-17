/**
 * Feature-is-alive proof for the Mac app's first owner device (docs/specs/mac-app-creates-agent.md)
 * on the production AgentServer boot path: the public route is mounted with its own small parser
 * (200, not 404/503), the enrolled device's signed requests are accepted over loopback, and refused
 * through a forwarding header.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { writeLocalOwnerTicket } from '../../src/core/localOwnerTicket.js';
import { localOwnerProofMessage } from '../../src/server/mobileLocalOwnerDevice.js';

const PORT = 4799;
const HOST = `127.0.0.1:${PORT}`;
const servers: AgentServer[] = [];
const dirs: string[] = [];
afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/mac-app-creates-agent-alive.test.ts' });
});

async function boot() {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'mac-create-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  await new MachineIdentityManager(stateDir).generateIdentity({ name: 'e2e machine' });
  // The installer's own defaults for an installed agent (install.ts INSTALLED_AGENT_MOBILE_PAIRING).
  const config = {
    projectName: 'scout', projectDir: dir, stateDir, port: PORT, authToken: 'e2e-token',
    mobilePairing: { enabled: true, multiRoute: { enabled: true }, native: { enabled: true, media: { enabled: true } } },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
  } as unknown as InstarConfig;
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir) });
  servers.push(server);
  return { app: server.getApp(), mp: server.mobilePairing!, stateDir };
}

describe('mac-app-creates-agent is alive on the production boot path', () => {
  it('a fresh install ticket enrolls the app, and the app\'s signed requests work only from this Mac', async () => {
    const { app, mp, stateDir } = await boot();
    expect(mp.keyLedger).toBeTruthy();
    const dev = makeDevice();
    // No ticket: the route does not exist.
    const none = await request(app).post('/mobile/local-owner-device').set('Host', HOST).send({});
    expect(none.status).toBe(404);
    const ticket = writeLocalOwnerTicket(stateDir);
    const timeMs = String(Date.now());
    const body = { ticket, publicKey: dev.publicKey, timeMs, proof: dev.sign(localOwnerProofMessage(HOST, dev.publicKey, ticket, timeMs)), label: 'Studio' };
    // Through a tunnel it is not found, and the ticket survives.
    const tunneled = await request(app).post('/mobile/local-owner-device').set('Host', HOST).set('X-Forwarded-For', '203.0.113.9').send(body);
    expect(tunneled.status).toBe(404);
    const r = await request(app).post('/mobile/local-owner-device').set('Host', HOST).send(body);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ host: HOST, agentName: 'scout' });
    const deviceId = r.body.deviceId as string;

    const p = '/mobile/pairing-requests';
    const signed = (extra: Record<string, string> = {}) => {
      const time = String(Date.now());
      const q = request(app).get(p).set('Host', HOST).set('X-Instar-Device', deviceId).set('X-Instar-Device-Time', time)
        .set('X-Instar-Device-Sig', dev.sign(canonicalString(deviceId, HOST, 'GET', p, time, undefined)));
      for (const [k, v] of Object.entries(extra)) q.set(k, v);
      return q;
    };
    const ok = await signed();
    expect(ok.status).toBe(200);
    const viaTunnel = await signed({ 'X-Forwarded-For': '203.0.113.9' });
    expect(viaTunnel.status).toBe(401);
    // The first owner exists now: a second app is refused.
    const other = makeDevice();
    const t2 = writeLocalOwnerTicket(stateDir);
    const time2 = String(Date.now());
    const second = await request(app).post('/mobile/local-owner-device').set('Host', HOST)
      .send({ ticket: t2, publicKey: other.publicKey, timeMs: time2, proof: other.sign(localOwnerProofMessage(HOST, other.publicKey, t2, time2)) });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('owner-device-exists');
  });
});

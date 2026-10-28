import { describe, expect, it } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { MacDesktopHost } from '../../src/core/MacDesktopHost.js';

async function boot(enabled: boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-boot-'));
  const stateDir = path.join(dir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'desktop-boot', port: 0 }));
  const machineId = enabled
    ? (await new MachineIdentityManager(stateDir).generateIdentity({ name: 'Echo Mac' })).machineId
    : 'machine-1';
  const config = {
    projectName: 'desktop-boot', projectDir: dir, stateDir, port: 0,
    authToken: 'desktop-e2e-token', dashboardPin: '123456', developmentAgent: true,
    remoteDesktop: { enabled },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30,
      protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {},
  } as InstarConfig;
  const server = new AgentServer({
    config, state: new StateManager(stateDir), telegram: null,
    meshSelfId: machineId,
    listPoolMachines: () => [{ machineId, nickname: 'Echo Mac', online: true }] as any,
    sessionManager: { listRunningSessions: () => [], getSession: () => null,
      getRunningSessionPanePids: () => [] } as any,
  });
  await server.start();
  return { server, dir, machineId, stateDir, config };
}

describe('native desktop production boot', () => {
  it('stays dark without explicit opt-in', async () => {
    const { server, dir } = await boot(false);
    try {
      const response = await request(server.getApp()).get('/desktop/targets')
        .set('Authorization', 'Bearer desktop-e2e-token');
      expect(response.status).toBe(503);
    } finally {
      await server.stop();
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'desktop-boot-lifecycle dark cleanup' });
    }
  });

  it.skipIf(process.platform !== 'darwin')('wires a live Mac target into the production route', async () => {
    const { server, dir, machineId, config } = await boot(true);
    try {
      const unlock = await request(server.getApp()).post('/dashboard/unlock').send({ pin: '123456' });
      expect(unlock.status).toBe(200);
      const listed = await request(server.getApp()).get('/desktop/targets')
        .set('Authorization', 'Bearer desktop-e2e-token')
        .set('X-Instar-Operator-Session', unlock.body.operatorSessionToken);
      expect(listed.status).toBe(200);
      expect(listed.body.machines).toEqual([{ machineId, label: 'Echo Mac', ready: expect.any(Boolean),
        ...(listed.body.machines[0]?.ready ? {} : { unavailableReason: expect.any(String) }) }]);
      expect(listed.body.topics).toEqual([]);
      const viewer = await request(server.getApp()).get('/dashboard/desktop.html');
      expect(viewer.status).toBe(200);
      expect(viewer.text).toContain('Remote desktop: Echo Mac');
      expect(viewer.text).toContain('signed in and unlocked');
      expect(viewer.text).toContain('id="retryButton"');
      expect(viewer.text).toMatch(/desktop\.js\?v=[a-f0-9]{16}/);
      expect(viewer.text).toMatch(/desktop\.css\?v=[a-f0-9]{16}/);
      expect(viewer.headers['cache-control']).toBe('no-store');
      const viewerScript = await request(server.getApp()).get('/dashboard/desktop.js');
      expect(viewerScript.status).toBe(200);
      expect(viewerScript.headers['cache-control']).toBe('no-store');
      expect(viewerScript.text).not.toContain("$('topic').replaceChildren()");
      expect(viewerScript.text).toContain("$('retryButton').addEventListener('click'");
      const viewerStyle = await request(server.getApp()).get('/dashboard/desktop.css');
      expect(viewerStyle.status).toBe(200);
      expect(viewerStyle.headers['cache-control']).toBe('no-store');
      expect(viewerStyle.text).toContain('body.desktop-live');
      expect(viewer.headers['content-security-policy']).toContain("script-src 'self'");
      expect(viewer.headers['content-security-policy']).toContain('wss://');
      config.dashboardPin = '654321';
      const stale = await request(server.getApp()).get('/desktop/targets')
        .set('Authorization', 'Bearer desktop-e2e-token')
        .set('X-Instar-Operator-Session', unlock.body.operatorSessionToken);
      expect(stale.status).toBe(403);
      expect((await request(server.getApp()).post('/dashboard/unlock').send({ pin: '123456' })).status).toBe(403);
      expect((await request(server.getApp()).post('/dashboard/unlock').send({ pin: '654321' })).status).toBe(200);
    } finally {
      await server.stop();
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'desktop-boot-lifecycle cleanup' });
    }
  });

  it.skipIf(process.platform !== 'darwin')('limits desktop PIN guesses and persists the attempt budget', async () => {
    const { server, dir, stateDir } = await boot(true);
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        expect((await request(server.getApp()).post('/dashboard/unlock').send({ pin: '000000' })).status).toBe(403);
      }
      expect((await request(server.getApp()).post('/dashboard/unlock').send({ pin: '123456' })).status).toBe(429);
      const saved = JSON.parse(fs.readFileSync(path.join(stateDir, 'state', 'pin-attempts.json'), 'utf8'));
      expect(saved.__dashboard_unlock_global__.count).toBe(5);
    } finally {
      await server.stop();
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'desktop PIN limit cleanup' });
    }
  });

  it.skipIf(process.platform !== 'darwin' || process.env.DESKTOP_LIVE_TEST !== '1')
    ('captures and controls the live Mac through the production boot path, then revokes', async () => {
      const { server, dir, machineId, stateDir } = await boot(true);
      let ws: WebSocket | undefined;
      try {
        const app = server.getApp();
        const unlock = await request(app).post('/dashboard/unlock').send({ pin: '123456' });
        expect(unlock.status).toBe(200);
        const headers = { Authorization: 'Bearer desktop-e2e-token',
          'X-Instar-Operator-Session': unlock.body.operatorSessionToken, 'X-Instar-Request': '1' };
        const ed = crypto.generateKeyPairSync('ed25519');
        const browserEcdh = crypto.createECDH('prime256v1');
        browserEcdh.generateKeys();
        const browserPublicKey = ed.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
        const browserEcdhPublicKey = browserEcdh.getPublicKey().toString('base64');
        const created = await request(app).post('/desktop/requests').set(headers).send({
          machineId, browserPublicKey,
          browserEcdhPublicKey, browserNonce: '0123456789abcdef',
        });
        expect(created.status).toBe(201);
        const requestId = created.body.requestId;
        const status = await request(app).get(`/desktop/requests/${requestId}`).set(headers);
        expect(status.body.status).toBe('approved');
        const key = Buffer.from(crypto.hkdfSync('sha256',
          browserEcdh.computeSecret(Buffer.from(status.body.targetEcdhPublicKey, 'base64')),
          Buffer.from(status.body.salt, 'base64'),
          Buffer.from(`instar-desktop-aead-v1:${requestId}:${machineId}`), 32));
        const proof = crypto.sign(null, Buffer.from(JSON.stringify(['desktop-browser-possession-v1', requestId,
          status.body.connectionNonce])), ed.privateKey).toString('base64');
        const issued = await request(app).post(`/desktop/requests/${requestId}/ticket`).set(headers).send({
          connectionNonce: status.body.connectionNonce, signature: proof,
        });
        expect(issued.status).toBe(200);
        const httpServer = (server as unknown as { server: { address(): { port: number } } }).server;
        const port = httpServer.address().port;
        ws = new WebSocket(`ws://127.0.0.1:${port}/desktop-stream`,
          ['instar-desktop-v1', `ticket.${issued.body.ticket}`],
          { origin: `http://127.0.0.1:${port}` });
        const firstFrame = once(ws, 'message');
        await once(ws, 'open');
        const [data] = await firstFrame as [Buffer];
        const record = Buffer.from(data);
        const sequence = record.readBigUInt64BE(0);
        const frameIv = Buffer.alloc(12); frameIv.writeUInt32BE(1, 0); frameIv.writeBigUInt64BE(sequence, 4);
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, frameIv);
        decipher.setAAD(Buffer.from(JSON.stringify(['instar-desktop-aead-v1', requestId, 'frame'])));
        decipher.setAuthTag(record.subarray(record.length - 16));
        const jpeg = Buffer.concat([decipher.update(record.subarray(8, record.length - 16)), decipher.final()]);
        expect(jpeg[0]).toBe(0xff); expect(jpeg[1]).toBe(0xd8);
        // A live stream must remain connected beyond the short sessions that
        // previously closed during normal phone use.
        await new Promise(resolve => setTimeout(resolve, 3_500));
        expect(ws.readyState).toBe(WebSocket.OPEN);
        const inputIv = Buffer.alloc(12); inputIv.writeUInt32BE(2, 0); inputIv.writeBigUInt64BE(1n, 4);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, inputIv);
        cipher.setAAD(Buffer.from(JSON.stringify(['instar-desktop-aead-v1', requestId, 'input'])));
        const host = new MacDesktopHost();
        const before = await host.cursor();
        const target = { x: before.x < 0.8 ? before.x + 0.05 : before.x - 0.05,
          y: before.y < 0.8 ? before.y + 0.05 : before.y - 0.05 };
        const command = Buffer.from(JSON.stringify({ type: 'input', action: { kind: 'move', ...target } }));
        const encrypted = Buffer.concat([cipher.update(command), cipher.final()]);
        const inputHeader = Buffer.alloc(8); inputHeader.writeBigUInt64BE(1n);
        ws.send(Buffer.concat([inputHeader, encrypted, cipher.getAuthTag()]));
        let observed = before;
        for (let attempt = 0; attempt < 20; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 100));
          observed = await host.cursor();
          if (Math.abs(observed.x - target.x) < 0.02 && Math.abs(observed.y - target.y) < 0.02) break;
        }
        expect(Math.abs(observed.x - target.x)).toBeLessThan(0.02);
        expect(Math.abs(observed.y - target.y)).toBeLessThan(0.02);
        const closed = once(ws, 'close');
        const revoke = await request(app).post(`/desktop/requests/${requestId}/revoke`).set(headers).send({});
        expect(revoke.body.revoked).toBe(true);
        await closed;
        const after = await request(app).get(`/desktop/requests/${requestId}`).set(headers);
        expect(after.body.status).toBe('revoked');
        const auditFile = path.join(stateDir, 'logs', `desktop-access-${new Date().toISOString().slice(0, 10)}.jsonl`);
        expect(fs.readFileSync(auditFile, 'utf8')).toContain('"inputBucket":"1-9"');
      } finally {
        ws?.terminate();
        await server.stop();
        SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'desktop live lifecycle cleanup' });
      }
    });
});

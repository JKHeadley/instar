import { describe, expect, it } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { MacDesktopHost } from '../../src/core/MacDesktopHost.js';
import { publishDashboardPreview } from '../../src/server/dashboardPreview.js';

async function boot(enabled: boolean, frontConfigured = true) {
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
    remoteDesktop: { enabled, ...(enabled && frontConfigured ? { frontMachineId: machineId } : {}) },
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
      expect((await request(server.getApp()).get('/dashboard/unlock-check')).body).toEqual({ accepted: true });
      // The dashboard preview is alive on the production boot path: absent until
      // published, then served from the state folder without a restart.
      const before = await request(server.getApp()).get('/dashboard/preview/');
      expect(before.status).toBe(404);
      const { stateDir: sd } = { stateDir: path.join(dir, '.instar') };
      const src = path.join(dir, 'preview-src');
      fs.mkdirSync(src);
      fs.writeFileSync(path.join(src, 'index.html'), '<title>Instar console</title>');
      publishDashboardPreview(sd, src, { branch: 'b', commit: 'c', uncommitted: false, publishedAt: new Date().toISOString() });
      const after = await request(server.getApp()).get('/dashboard/preview/');
      expect(after.status).toBe(200);
      expect(after.text).toContain('Instar console');
      expect(after.headers['cache-control']).toBe('no-store');
      const response = await request(server.getApp()).get('/desktop/targets')
        .set('Authorization', 'Bearer desktop-e2e-token');
      expect(response.status).toBe(503);
    } finally {
      await server.stop();
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'desktop-boot-lifecycle dark cleanup' });
    }
  });

  it('stays dark when enabled without a designated front machine', async () => {
    const { server, dir } = await boot(true, false);
    try {
      // The console asks before it shows a PIN box; a local connection may unlock.
      const check = await request(server.getApp()).get('/dashboard/unlock-check');
      expect(check.status).toBe(200);
      expect(check.body).toEqual({ accepted: true });
      expect(check.headers['cache-control']).toBe('no-store');
      const unlock = await request(server.getApp()).post('/dashboard/unlock').send({ pin: '123456' });
      expect(unlock.status).toBe(200);
      const listed = await request(server.getApp()).get('/desktop/targets')
        .set('Authorization', 'Bearer desktop-e2e-token')
        .set('X-Instar-Operator-Session', unlock.body.operatorSessionToken);
      expect(listed.status).toBe(503);
    } finally {
      await server.stop();
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'desktop missing front cleanup' });
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
        targetSigningPublicKey: expect.any(String),
        ...(listed.body.machines[0]?.ready ? {} : { unavailableReason: expect.any(String) }) }]);
      expect(listed.body.topics).toEqual([]);
      const viewer = await request(server.getApp()).get('/dashboard/desktop.html');
      expect(viewer.status).toBe(200);
      expect(viewer.text).toContain('<h1>Remote desktop</h1>');
      expect(viewer.text).toContain('signed in and unlocked');
      expect(viewer.text).toContain('id="retryButton"');
      expect(viewer.text).toContain('id="dragButton"');
      expect(viewer.text).toContain('data-remote-key="Meta"');
      expect(viewer.text).toMatch(/desktop\.js\?v=[a-f0-9]{16}/);
      expect(viewer.text).toMatch(/desktop\.css\?v=[a-f0-9]{16}/);
      expect(viewer.headers['cache-control']).toBe('no-store');
      const viewerScript = await request(server.getApp()).get('/dashboard/desktop.js');
      expect(viewerScript.status).toBe(200);
      expect(viewerScript.headers['cache-control']).toBe('no-store');
      expect(viewerScript.text).not.toContain("$('topic').replaceChildren()");
      expect(viewerScript.text).toContain("$('retryButton').addEventListener('click'");
      expect(viewerScript.text).toContain('function beginKey(key)');
      expect(viewerScript.text).toContain('function beginHold(button)');
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
    ('captures and controls the live Mac through the production boot path, then revokes', async context => {
      const { server, dir, machineId, stateDir } = await boot(true);
      let ws: WebSocket | undefined;
      let targetProcess: ReturnType<typeof spawn> | undefined;
      try {
        const targetBinary = path.join(dir, 'desktop-live-target');
        const compiled = spawnSync('swiftc', ['-o', targetBinary,
          path.resolve('tests/fixtures/desktop-live-target.swift')], { encoding: 'utf8' });
        expect(compiled.status, compiled.stderr).toBe(0);
        targetProcess = spawn(targetBinary, [], { stdio: ['ignore', 'pipe', 'pipe'] });
        const targetEvents: string[] = [];
        let targetReady: { x: number; y: number } | undefined;
        let targetOutput = '';
        targetProcess.stdout.on('data', (chunk: Buffer) => {
          targetOutput += chunk.toString('utf8');
          let newline = targetOutput.indexOf('\n');
          while (newline >= 0) {
            const line = JSON.parse(targetOutput.slice(0, newline)) as {
              ready?: { x: number; y: number }; event?: string;
            };
            if (line.ready) targetReady = line.ready;
            if (line.event) targetEvents.push(line.event);
            targetOutput = targetOutput.slice(newline + 1);
            newline = targetOutput.indexOf('\n');
          }
        });
        const waitForEvents = async (events: string[]) => {
          for (let attempt = 0; attempt < 50; attempt++) {
            if (events.every(event => targetEvents.includes(event))) return;
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          throw new Error(`live target events missing: ${events.join(', ')}; saw ${targetEvents.join(', ')}`);
        };
        const anotherControllerActive = () => {
          const processes = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' });
          if (processes.status !== 0) throw new Error('cannot check live desktop occupancy');
          return processes.stdout.split('\n').some(line => {
            const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
            return !!match && Number(match[2]) !== process.pid
              && /\/instar-desktop-host (indicator|capture-stream(?:-h264)?|input-stream)$/.test(match[3]);
          });
        };
        const localUserRecentlyActive = () => {
          const idle = spawnSync('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-d', '4'], { encoding: 'utf8' });
          if (idle.status !== 0) return true;
          const nanos = idle.stdout.match(/"HIDIdleTime"\s*=\s*(\d+)/)?.[1];
          // The test moves the real pointer and posts keyboard events. If
          // local presence cannot be established, preserve the user's input.
          return !nanos || Number(nanos) < 30_000_000_000;
        };
        for (let attempt = 0; attempt < 50 && !targetReady; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        expect(targetReady).toBeDefined();
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
        const sendLiveInput = (stream: WebSocket, streamKey: Buffer, sequence: bigint,
          action: Record<string, unknown>) => {
          const inputIv = Buffer.alloc(12); inputIv.writeUInt32BE(2, 0);
          inputIv.writeBigUInt64BE(sequence, 4);
          const cipher = crypto.createCipheriv('aes-256-gcm', streamKey, inputIv);
          cipher.setAAD(Buffer.from(JSON.stringify(['instar-desktop-aead-v1', requestId, 'input'])));
          const command = Buffer.from(JSON.stringify({ type: 'input', action }));
          const encrypted = Buffer.concat([cipher.update(command), cipher.final()]);
          const inputHeader = Buffer.alloc(8); inputHeader.writeBigUInt64BE(sequence);
          stream.send(Buffer.concat([inputHeader, encrypted, cipher.getAuthTag()]));
        };
        const host = new MacDesktopHost();
        const before = await host.cursor();
        const target = targetReady!;
        if (anotherControllerActive() || localUserRecentlyActive()) {
          context.skip('the Mac is in use by another controller or local user');
        }
        sendLiveInput(ws, key, 1n, { kind: 'move', ...target });
        let observed = before;
        for (let attempt = 0; attempt < 20; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 100));
          observed = await host.cursor();
          if (Math.abs(observed.x - target.x) < 0.02 && Math.abs(observed.y - target.y) < 0.02) break;
        }
        expect(Math.abs(observed.x - target.x)).toBeLessThan(0.02);
        expect(Math.abs(observed.y - target.y)).toBeLessThan(0.02);
        sendLiveInput(ws, key, 2n, { kind: 'buttonDown', ...target, button: 'left' });
        sendLiveInput(ws, key, 3n, { kind: 'move', x: target.x + 0.015, y: target.y });
        sendLiveInput(ws, key, 4n, { kind: 'buttonUp', x: target.x + 0.015, y: target.y, button: 'left' });
        await waitForEvents(['down', 'drag', 'up']);
        sendLiveInput(ws, key, 5n, { kind: 'keyDown', key: 'Meta' });
        await waitForEvents(['metaDown']);
        sendLiveInput(ws, key, 6n, { kind: 'keyUp', key: 'Meta' });
        await waitForEvents(['metaUp']);
        sendLiveInput(ws, key, 7n, { kind: 'scroll', dx: 0, dy: 60 });
        await waitForEvents(['scroll']);
        const originalExpiry = status.body.expiresAt;
        const lost = once(ws, 'close');
        ws.terminate();
        await lost;
        let interrupted;
        for (let attempt = 0; attempt < 50; attempt++) {
          interrupted = await request(app).get(`/desktop/requests/${requestId}`).set(headers);
          if (interrupted.body.status === 'interrupted') break;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        expect(interrupted?.body.status).toBe('interrupted');
        const resumedEd = crypto.generateKeyPairSync('ed25519');
        const resumedEcdh = crypto.createECDH('prime256v1'); resumedEcdh.generateKeys();
        const resumeAttemptId = 'live-resume-attempt-123456';
        const resumedBrowserNonce = 'fedcba9876543210';
        const resumedBrowserPublicKey = resumedEd.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
        const resumedBrowserEcdhPublicKey = resumedEcdh.getPublicKey().toString('base64');
        const resumeSignature = crypto.sign(null, Buffer.from(JSON.stringify(['desktop-resume-v1',
          requestId, status.body.connectionNonce, resumeAttemptId, resumedBrowserPublicKey,
          resumedBrowserEcdhPublicKey, resumedBrowserNonce, 'jpeg', 'jpeg'])), ed.privateKey).toString('base64');
        const resumed = await request(app).post(`/desktop/requests/${requestId}/resume`).set(headers).send({
          attemptId: resumeAttemptId, browserNonce: resumedBrowserNonce,
          browserPublicKey: resumedBrowserPublicKey, browserEcdhPublicKey: resumedBrowserEcdhPublicKey,
          previousConnectionNonce: status.body.connectionNonce, previousSignature: resumeSignature,
        });
        expect(resumed.status).toBe(200);
        expect(resumed.body.expiresAt).toBe(originalExpiry);
        const resumedProof = crypto.sign(null, Buffer.from(JSON.stringify([
          'desktop-browser-possession-v1', requestId, resumed.body.connectionNonce])),
        resumedEd.privateKey).toString('base64');
        const resumedTicket = await request(app).post(`/desktop/requests/${requestId}/ticket`).set(headers).send({
          connectionNonce: resumed.body.connectionNonce, signature: resumedProof,
        });
        expect(resumedTicket.status).toBe(200);
        ws = new WebSocket(`ws://127.0.0.1:${port}/desktop-stream`,
          ['instar-desktop-v1', `ticket.${resumedTicket.body.ticket}`],
          { origin: `http://127.0.0.1:${port}` });
        const resumedFrame = once(ws, 'message');
        await once(ws, 'open');
        const [resumedRecord] = await resumedFrame as [Buffer];
        const resumedKey = Buffer.from(crypto.hkdfSync('sha256',
          resumedEcdh.computeSecret(Buffer.from(resumed.body.targetEcdhPublicKey, 'base64')),
          Buffer.from(resumed.body.salt, 'base64'),
          Buffer.from(`instar-desktop-aead-v1:${requestId}:${machineId}`), 32));
        const resumedSequence = Buffer.from(resumedRecord).readBigUInt64BE(0);
        const resumedIv = Buffer.alloc(12); resumedIv.writeUInt32BE(1, 0); resumedIv.writeBigUInt64BE(resumedSequence, 4);
        const resumedDecipher = crypto.createDecipheriv('aes-256-gcm', resumedKey, resumedIv);
        resumedDecipher.setAAD(Buffer.from(JSON.stringify(['instar-desktop-aead-v1', requestId, 'frame'])));
        resumedDecipher.setAuthTag(Buffer.from(resumedRecord).subarray(resumedRecord.length - 16));
        const resumedJpeg = Buffer.concat([resumedDecipher.update(Buffer.from(resumedRecord).subarray(8,
          resumedRecord.length - 16)), resumedDecipher.final()]);
        expect(resumedJpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
        targetEvents.length = 0;
        // Our own CGEvent mouse/key posts reset HIDIdleTime. The initial
        // pre-input check established local idleness; repeating it here would
        // always skip the revoke/release half of this live proof. Still refuse
        // a second remote controller before resuming input.
        if (anotherControllerActive()) {
          context.skip('another desktop controller is using this Mac');
        }
        sendLiveInput(ws, resumedKey, 1n, { kind: 'buttonDown', ...target, button: 'left' });
        sendLiveInput(ws, resumedKey, 2n, { kind: 'keyDown', key: 'Meta' });
        await waitForEvents(['down', 'metaDown']);
        const closed = once(ws, 'close');
        const revoke = await request(app).post(`/desktop/requests/${requestId}/revoke`).set(headers).send({});
        expect(revoke.body.revoked).toBe(true);
        await closed;
        await waitForEvents(['up', 'metaUp']);
        const after = await request(app).get(`/desktop/requests/${requestId}`).set(headers);
        expect(after.body.status).toBe('revoked');
        const auditFile = path.join(stateDir, 'logs', `desktop-access-${new Date().toISOString().slice(0, 10)}.jsonl`);
        expect(fs.readFileSync(auditFile, 'utf8')).toContain('"inputBucket":"1-9"');
      } finally {
        ws?.terminate();
        targetProcess?.kill('SIGKILL');
        await server.stop();
        SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'desktop live lifecycle cleanup' });
      }
    });

  it.skipIf(process.platform !== 'darwin' || process.env.DESKTOP_H264_LIVE_TEST !== '1')
    ('negotiates, decrypts, and decodes a live hardware AVC keyframe through production boot', async context => {
      // A combined live run exercises mouse/keyboard first. Its CGEvents reset
      // HIDIdleTime, so let that signal become quiet before the next host check.
      // The occupancy and idle guards below still refuse an active Mac.
      if (process.env.DESKTOP_LIVE_TEST === '1') {
        await new Promise(resolve => setTimeout(resolve, 31_000));
      }
      const { server, dir, machineId } = await boot(true);
      let ws: WebSocket | undefined;
      let requestId = '';
      let headers: Record<string, string> = {};
      try {
        // The suite lane can be acquired long after launch. Check occupancy
        // immediately before opening the target grant.
        const processes = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' });
        if (processes.status !== 0) throw new Error('cannot check live desktop occupancy');
        const occupied = processes.stdout.split('\n').some(line => {
          const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
          return !!match && Number(match[2]) !== process.pid
            && /\/instar-desktop-host (indicator|capture-stream(?:-h264)?|input-stream)$/.test(match[3]);
        });
        if (occupied) context.skip('another desktop controller is using this Mac');
        const idle = spawnSync('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-d', '4'], { encoding: 'utf8' });
        const idleNanos = idle.status === 0 ? idle.stdout.match(/"HIDIdleTime"\s*=\s*(\d+)/)?.[1] : undefined;
        if (!idleNanos || Number(idleNanos) < 30_000_000_000) {
          context.skip('the Mac is in use by a local user or HID idle state is unavailable');
        }
        const ffmpegLookup = spawnSync('/usr/bin/which', ['ffmpeg'], { encoding: 'utf8' });
        if (ffmpegLookup.status !== 0 || !ffmpegLookup.stdout.trim()) {
          context.skip('ffmpeg is unavailable for the live codec check');
        }
        const ffmpeg = ffmpegLookup.stdout.trim();
        const app = server.getApp();
        const unlock = await request(app).post('/dashboard/unlock').send({ pin: '123456' });
        expect(unlock.status).toBe(200);
        headers = { Authorization: 'Bearer desktop-e2e-token',
          'X-Instar-Operator-Session': unlock.body.operatorSessionToken, 'X-Instar-Request': '1' };
        const ed = crypto.generateKeyPairSync('ed25519');
        const browserEcdh = crypto.createECDH('prime256v1'); browserEcdh.generateKeys();
        const created = await request(app).post('/desktop/requests').set(headers).send({
          machineId, videoCodec: 'h264',
          browserPublicKey: ed.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
          browserEcdhPublicKey: browserEcdh.getPublicKey().toString('base64'),
          browserNonce: '0123456789abcdef',
        });
        expect(created.status).toBe(201);
        requestId = created.body.requestId;
        const state = await request(app).get(`/desktop/requests/${requestId}`).set(headers);
        expect(state.body.videoCodec).toBe('h264');
        const key = Buffer.from(crypto.hkdfSync('sha256', browserEcdh.computeSecret(
          Buffer.from(state.body.targetEcdhPublicKey, 'base64')),
        Buffer.from(state.body.salt, 'base64'),
        Buffer.from(`instar-desktop-aead-v1:${requestId}:${machineId}`), 32));
        const proof = crypto.sign(null, Buffer.from(JSON.stringify(['desktop-browser-possession-v1',
          requestId, state.body.connectionNonce])), ed.privateKey).toString('base64');
        const ticket = await request(app).post(`/desktop/requests/${requestId}/ticket`).set(headers)
          .send({ connectionNonce: state.body.connectionNonce, signature: proof });
        expect(ticket.status).toBe(200);
        const port = (server as unknown as { server: { address(): { port: number } } }).server.address().port;
        ws = new WebSocket(`ws://127.0.0.1:${port}/desktop-stream`,
          ['instar-desktop-v1', `ticket.${ticket.body.ticket}`],
          { origin: `http://127.0.0.1:${port}` });
        const firstFrame = once(ws, 'message');
        await once(ws, 'open');
        const [data] = await firstFrame as [Buffer];
        const record = Buffer.from(data);
        const iv = Buffer.alloc(12); iv.writeUInt32BE(1); iv.writeBigUInt64BE(record.readBigUInt64BE(0), 4);
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAAD(Buffer.from(JSON.stringify(['instar-desktop-aead-v1', requestId, 'frame'])));
        decipher.setAuthTag(record.subarray(record.length - 16));
        const frame = Buffer.concat([decipher.update(record.subarray(8, -16)), decipher.final()]);
        expect(frame.subarray(0, 6)).toEqual(Buffer.from([73, 68, 86, 49, 1, 1]));
        const width = frame.readUInt16BE(6), height = frame.readUInt16BE(8);
        expect(width).toBeGreaterThan(1); expect(width).toBeLessThanOrEqual(1920);
        expect(height).toBeGreaterThan(1); expect(height).toBeLessThanOrEqual(1080);
        const annexB = frame.subarray(18);
        const nalTypes: number[] = [];
        for (let i = 0; i + 4 < annexB.length; i++) {
          if (annexB[i] === 0 && annexB[i + 1] === 0 && annexB[i + 2] === 0
            && annexB[i + 3] === 1) nalTypes.push(annexB[i + 4] & 31);
        }
        expect(nalTypes).toEqual(expect.arrayContaining([7, 8, 5]));
        const decoded = spawnSync(ffmpeg, ['-v', 'error', '-f', 'h264', '-i', 'pipe:0',
          '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'],
        { input: annexB, maxBuffer: 4_000_000, timeout: 10_000 });
        expect(decoded.status, decoded.stderr?.toString()).toBe(0);
        expect(decoded.stdout.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        expect(decoded.stdout.readUInt32BE(16)).toBe(width);
        expect(decoded.stdout.readUInt32BE(20)).toBe(height);
        expect(decoded.stdout.length).toBeGreaterThan(1_000);
        const closed = once(ws, 'close');
        const revoked = await request(app).post(`/desktop/requests/${requestId}/revoke`).set(headers).send({});
        expect(revoked.body.revoked).toBe(true);
        await closed;
      } finally {
        ws?.terminate();
        if (requestId && headers.Authorization) {
          await request(server.getApp()).post(`/desktop/requests/${requestId}/revoke`).set(headers).send({});
        }
        await server.stop();
        SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'desktop H264 live lifecycle cleanup' });
      }
    });
});

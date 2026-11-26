import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { expect, it } from 'vitest';
import { AgentServer } from '../../dist/server/AgentServer.js';
import { canonicalString } from '../../dist/core/MobileDeviceKeys.js';
import { deviceKeyHashOf } from '../../dist/core/AppRecordSignatures.js';
import { MachineIdentityManager } from '../../dist/core/MachineIdentity.js';
import { StateManager } from '../../dist/core/StateManager.js';
import { SafeFsExecutor } from '../../dist/core/SafeFsExecutor.js';
import { mediaDiskFloorBytes } from '../../dist/core/AppMediaStore.js';
import { ImportedHistoryStore } from '../../dist/import/ImportedHistoryStore.js';
import { LocalHistoryChannel } from '../../dist/import/LocalHistoryChannel.js';
import { finishLocalHistoryHandshake } from '../../dist/import/LocalHistoryHandshake.js';
import { LocalHistoryDiskLedger } from '../../dist/import/LocalHistoryDiskLedger.js';
import { LOCAL_HISTORY_DISPOSABLE_PILOT_LINES } from '../../dist/import/LocalHistoryDisposablePilot.js';
import { SIGNED_LOCAL_HISTORY_PREFIX as prefix } from '../../dist/server/signedLocalHistoryIntake.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { createMockSessionManager } from '../helpers/setup.js';

it('runs the dark-by-default clean signed pilot over AgentServer with live disk refusal', async () => {
  const testHomes = path.join(fs.realpathSync(os.homedir()), '.instar', 'test-deploys');
  fs.mkdirSync(testHomes, { recursive: true, mode: 0o700 });
  const projectDir = path.join(testHomes, 'local-history-reserve-pilot-' + crypto.randomBytes(16).toString('hex'));
  fs.mkdirSync(projectDir, { mode: 0o700 });
  const stateDir = path.join(projectDir, '.instar');
  fs.mkdirSync(stateDir, { mode: 0o700 });
  let server: AgentServer | undefined, channel: LocalHistoryChannel | undefined, ledger: LocalHistoryDiskLedger | undefined;
  try {
    for (const dir of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, dir), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
    const owner = { id: 'synthetic-owner', name: 'Synthetic Owner', permissions: ['owner'], channels: [], preferences: {} };
    fs.writeFileSync(path.join(stateDir, 'users.json'), JSON.stringify([owner]));
    const manager = new MachineIdentityManager(stateDir), identity = await manager.generateIdentity({ name: 'Disposable pilot machine' });
    const pin = crypto.createPublicKey(manager.getSigningPublicKeyPem(identity.machineId)!);
    const config = { projectName: 'synthetic-history-pilot', projectDir, stateDir, host: '127.0.0.1', port: 0,
      authToken: 'synthetic-token', developmentAgent: false,
      mobilePairing: { enabled: true, native: { enabled: true }, multiRoute: { enabled: false } },
      users: [owner], sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
      monitoring: { deliveryFailureSentinel: { enabled: false }, burnDetection: { enabled: false } }, threadline: { ownerName: owner.name },
    } as any;
    const sessions = createMockSessionManager() as any; sessions.on = () => undefined;
    server = new AgentServer({ config, sessionManager: sessions, state: new StateManager(stateDir) } as any);
    const observer = server.getTokenLedger();
    if (observer) {
      const claude = path.join(projectDir, 'synthetic-claude'), codex = path.join(projectDir, 'synthetic-codex');
      fs.mkdirSync(claude); fs.mkdirSync(codex);
      observer['claudeProjectsDir'] = claude; observer['claudeProjectsDirsOpt'] = [claude];
      const scan = observer.scanCodexRolloutsAsync.bind(observer);
      observer.scanCodexRolloutsAsync = options => scan({ ...options, codexHome: codex });
    }
    await server.start();
    const address = server['server']!.address();
    if (!address || typeof address === 'string') throw new Error('synthetic HTTP listener unavailable');
    const url = new URL('http://127.0.0.1:' + address.port), pairing = server.mobilePairing!;
    const phone = makeDevice();
    const enrolled = pairing.devices.createPending({ publicKey: phone.publicKey, host: url.host, userId: owner.id,
      role: 'owner', deviceName: 'Synthetic Owner Phone', label: null });
    if (!enrolled.ok) throw new Error('synthetic owner enrollment refused');
    const deviceId = enrolled.device.id;
    pairing.devices.applyConfirm(deviceId, { ok: true }); pairing.keyLedger!.reconcile(pairing.devices);
    let lastTime = 0;
    const signed = (method: 'GET' | 'POST' | 'PUT', target: string, raw?: Buffer, media?: string) => {
      const timestamp = String(lastTime = Math.max(Date.now(), lastTime + 1));
      const client = request(url.origin);
      const req = method === 'GET' ? client.get(target) : method === 'POST' ? client.post(target) : client.put(target);
      req.set('Host', url.host).set('X-Instar-Device', deviceId).set('X-Instar-Device-Time', timestamp)
        .set('X-Instar-Device-Sig', phone.sign(canonicalString(deviceId, url.host, method, target, timestamp, raw)));
      if (media) req.set('Content-Type', media);
      return raw ? req.send(media === 'application/json' ? raw.toString() : raw) : req;
    };
    expect((await signed('GET', prefix + '/targets')).status).not.toBe(200);
    expect(fs.existsSync(path.join(stateDir, 'local-history-upload'))).toBe(false);
    config.localHistoryDisposablePilot = { enabled: true };
    const store = new ImportedHistoryStore(stateDir);
    fs.mkdirSync(path.join(store.dir, '.local-history-temporary'), { mode: 0o700 });
    const discovery = await signed('GET', prefix + '/targets');
    expect(discovery.status).toBe(200);
    expect(discovery.body.importAvailable).toBe(false);
    const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
    const handshake = { machineId: identity.machineId, clientPublicKey: ecdh.getPublicKey().toString('base64'),
      clientNonce: crypto.randomBytes(32).toString('base64') };
    const grant = await signed('POST', prefix + '/channels', Buffer.from(JSON.stringify(handshake)), 'application/json');
    expect(grant.status).toBe(200);
    const expected = { agentId: config.projectName, machineId: identity.machineId, bootId: pairing.bootId,
      deviceId, deviceKeyHash: deviceKeyHashOf(phone.publicKey) };
    const keys = finishLocalHistoryHandshake(grant.body, handshake, expected, ecdh, pin, Date.now());
    try {
      channel = new LocalHistoryChannel(keys, { channelId: grant.body.channelId, machineId: expected.machineId,
        bootId: expected.bootId, deviceKeyHash: expected.deviceKeyHash }, 'client');
    } finally { keys.request.fill(0); keys.response.fill(0); }
    const sealed = async (method: 'GET' | 'POST' | 'PUT', pathname: string, data?: Buffer | object) => {
      const plaintext = Buffer.isBuffer(data) ? data : method === 'GET' ? Buffer.alloc(0) : Buffer.from(JSON.stringify(data ?? {}));
      const record = channel!.sealRequest(plaintext, {method, path: pathname});
      const target = pathname + '?channelId=' + grant.body.channelId + '&sequence=' + record.readBigUInt64BE().toString();
      const req = method === 'GET' ? signed(method, target).set('X-Instar-Local-History-Record', record.toString('base64'))
        : signed(method, target, record, 'application/octet-stream');
      const res = await req.buffer(true).parse((stream, done) => {
        const parts: Buffer[] = [];
        stream.on('data', part => parts.push(part));
        stream.on('end', () => done(null, Buffer.concat(parts)));
        stream.on('error', done);
      });
      expect(res.headers['content-type']).toContain('application/octet-stream');
      const response = channel!.openResponse(res.body, {method, path: pathname});
      try { return { status: res.status, body: JSON.parse(response.toString()) }; }
      finally { response.fill(0); }
    };
    const challenge = await sealed('POST', prefix + '/challenge');
    expect(challenge.status).toBe(200);
    const bytes = Buffer.from(LOCAL_HISTORY_DISPOSABLE_PILOT_LINES.join('\n'));
    const manifest = { bootId: pairing.bootId, targetMachineId: identity.machineId, selectionChallenge: challenge.body.challenge,
      selectionRequestId: crypto.randomBytes(16).toString('hex'), purpose: 'upload-selected-local-conversations', project: '/synthetic/project',
      files: [{ source: 'codex', fileId: 'fixture', expectedSessionId: 'synthetic-session', displayName: 'synthetic.jsonl',
        bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }] };
    const upload = await sealed('POST', prefix + '/uploads', manifest);
    expect(upload.status).toBe(201);
    const { operationId, uploadId } = upload.body;
    const chunk = prefix + '/uploads/' + uploadId + '/files/fixture/chunks/0';
    expect((await sealed('PUT', chunk, Buffer.alloc(bytes.length))).status).toBeGreaterThanOrEqual(400);
    expect((await sealed('PUT', chunk, bytes)).status).toBe(200);
    expect((await sealed('POST', prefix + '/uploads/' + uploadId + '/complete')).status).toBe(202);
    const statusPath = prefix + '/operations/' + operationId;
    const preparedDeadline = Date.now() + 10_000;
    let phase = '';
    while (Date.now() < preparedDeadline) {
      phase = (await sealed('GET', statusPath)).body.phase;
      if (phase === 'prepared') break;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    expect(phase).toBe('prepared');
    const preview = await sealed('POST', prefix + '/preview', {operationId});
    expect(preview.status).toBe(200);
    const intent = { previewId: preview.body.previewId, machineId: identity.machineId, bootId: pairing.bootId,
      confirmationChallenge: preview.body.confirmation.challenge, applyRequestId: crypto.randomBytes(16).toString('hex') };
    ledger = new LocalHistoryDiskLedger(stateDir);
    const volume = fs.statfsSync(stateDir);
    const outstanding = ledger.inventory().reduce((sum, row) => sum + row.planned - row.written, 0);
    const pressure = ledger.create('synthetic-signed-pilot-test', Math.floor(volume.bavail * volume.bsize
      - mediaDiskFloorBytes(volume.blocks * volume.bsize) - outstanding - 16 * 1024 ** 2));
    const claim = path.join(store.dir, 'source-claims.sqlite');
    try {
      expect((await sealed('POST', prefix + '/apply', intent)).status).toBeGreaterThanOrEqual(400);
      expect(fs.existsSync(claim)).toBe(false);
      expect((await sealed('GET', statusPath)).body.phase).toBe('prepared');
    } finally { ledger.dispose(pressure); }
    expect(await sealed('POST', prefix + '/apply', intent)).toEqual({ status: 200, body: { claimWritten: true, phase: 'interrupted' } });
    expect(fs.statSync(claim).size).toBeGreaterThan(0);
    expect((await sealed('GET', statusPath)).body.phase).toBe('interrupted');
    expect((await sealed('POST', prefix + '/apply', intent)).status).toBe(409);
  } finally {
    channel?.dispose(); ledger?.close();
    try {
      const poller = server?.['tokenLedgerPoller'];
      poller?.stop();
      const deadline = Date.now() + 5000;
      while (poller?.['running'] && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      await server?.stop();
    } finally {
      SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'owned synthetic signed pilot' });
    }
  }
});

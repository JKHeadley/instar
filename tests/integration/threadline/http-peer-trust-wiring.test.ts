/**
 * docs/specs/threadline-http-peer-trust.md — the production route factory wires the HTTP peer
 * trust check: through the real AgentServer (auth middleware + routes.ts), a freshly paired
 * stranger is refused before the router; a fingerprint the trust manager has granted is admitted.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import request from 'supertest';
import { AgentServer } from '../../../src/server/AgentServer.js';
import { HandshakeManager } from '../../../src/threadline/HandshakeManager.js';
import { AgentTrustManager } from '../../../src/threadline/AgentTrustManager.js';
import { sign, generateIdentityKeyPair } from '../../../src/threadline/ThreadlineCrypto.js';
import { computeFingerprint } from '../../../src/threadline/client/MessageEncryptor.js';
import { createTempProject, createMockSessionManager } from '../../helpers/setup.js';
import type { TempProject } from '../../helpers/setup.js';
import type { InstarConfig } from '../../../src/core/types.js';

const AUTH = 'http-peer-trust-auth';

describe('HTTP peer trust — production wiring', () => {
  let project: TempProject | null = null;
  let server: AgentServer | null = null;
  afterEach(async () => { await server?.stop(); project?.cleanup(); server = null; project = null; });

  async function boot(withTrust: AgentTrustManager | null, opened = true) {
    project = createTempProject();
    const config = {
      projectName: 'host', projectDir: project.dir, stateDir: project.stateDir, port: 0, authToken: AUTH,
      requestTimeoutMs: 5000, version: '0.9.81', developmentAgent: false,
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {}, users: [],
      threadline: { relayEnabled: false, ...(opened ? { directPeerProtocol: { enabled: true } } : {}) },
    } as InstarConfig;
    const handleInboundMessage = vi.fn(async () => ({ handled: true, accepted: true, delivered: true, threadId: 't' }));
    server = new AgentServer({
      config, sessionManager: createMockSessionManager() as never, state: project.state,
      handshakeManager: new HandshakeManager(project.stateDir, 'host'),
      threadlineRouter: { handleInboundMessage } as never,
      ...(withTrust ? { unifiedTrust: { trustManager: withTrust } } : {}),
    } as never);
    await server.start();
    return { app: server.getApp(), handleInboundMessage };
  }

  function stranger(dir: string, name: string) {
    fs.mkdirSync(path.join(dir, 'threadline'), { recursive: true });
    const kp = generateIdentityKeyPair();
    fs.writeFileSync(path.join(dir, 'threadline', 'identity.json'), JSON.stringify({ publicKey: kp.publicKey.toString('hex'), privateKey: kp.privateKey.toString('hex') }));
    return { mgr: new HandshakeManager(dir, name), name, priv: kp.privateKey, fp: computeFingerprint(kp.publicKey) };
  }

  async function pairAndSend(app: Parameters<typeof request>[0], s: ReturnType<typeof stranger>) {
    const init = s.mgr.initiateHandshake('host'); if (!('payload' in init)) throw new Error('init');
    const hello = await request(app).post('/threadline/handshake/hello').send(init.payload);
    if (hello.status !== 200) return hello;
    const c = s.mgr.handleHelloResponse({ agent: hello.body.agent, identityPub: hello.body.identityPub, ephemeralPub: hello.body.ephemeralPub, nonce: hello.body.nonce, challengeResponse: hello.body.challengeResponse });
    if (!('confirmPayload' in c)) throw new Error('confirm');
    expect((await request(app).post('/threadline/handshake/confirm').send(c.confirmPayload)).status).toBe(200);
    const body = { message: { id: crypto.randomUUID(), threadId: crypto.randomUUID(), from: { agent: s.name }, body: 'hello' } };
    const nonce = crypto.randomBytes(16).toString('hex'); const ts = new Date().toISOString();
    const data = Buffer.concat([Buffer.from(`POST\n/threadline/messages/receive\n${nonce}\n${ts}\n`, 'utf-8'), crypto.createHash('sha256').update(JSON.stringify(body)).digest()]);
    const r = await request(app).post('/threadline/messages/receive').set({
      Authorization: `Threadline-Relay ${s.mgr.getRelayToken('host')!}`, 'X-Threadline-Agent': s.name,
      'X-Threadline-Nonce': nonce, 'X-Threadline-Timestamp': ts, 'X-Threadline-Signature': sign(s.priv, data).toString('hex'),
    }).send(body);
    await new Promise((res) => setImmediate(res));
    return r;
  }

  it('default config: the direct peer routes are closed through the real server, health still answers', async () => {
    const { app, handleInboundMessage } = await boot(null, false);
    expect((await request(app).post('/threadline/handshake/hello').send({ agent: 'x', identityPub: '00'.repeat(32), ephemeralPub: '00'.repeat(32), nonce: 'n' })).status).toBe(404);
    expect((await request(app).post('/threadline/messages/receive').send({})).status).toBe(404);
    expect((await request(app).get('/threadline/health')).status).toBe(200);
    expect(handleInboundMessage).not.toHaveBeenCalled();
  });

  it('relay off, no trust manager: a stranger is refused at the handshake and never routed', async () => {
    const { app, handleInboundMessage } = await boot(null);
    const r = await pairAndSend(app, stranger(path.join(project!.dir, 'peer'), 'stranger'));
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('TL_SENDER_NOT_TRUSTED');
    expect(handleInboundMessage).not.toHaveBeenCalled();
  });

  it('a fingerprint the trust manager has granted is admitted through the same server', async () => {
    const tmDir = fs.mkdtempSync(path.join(path.dirname(createTempProject().stateDir), 'tm-'));
    const tm = new AgentTrustManager({ stateDir: tmDir });
    const { app, handleInboundMessage } = await boot(tm);
    const s = stranger(path.join(project!.dir, 'peer'), 'friend');
    tm.setTrustLevelByFingerprint(s.fp, 'trusted', 'user-granted', 'test grant');
    const r = await pairAndSend(app, s);
    expect(r.status).toBe(200);
    expect(handleInboundMessage).toHaveBeenCalledTimes(1);
  });
});

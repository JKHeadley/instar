// docs/specs/threadline-http-peer-trust.md — a handshake is not a grant; an existing pairing keeps its key.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { HandshakeManager } from '../../../src/threadline/HandshakeManager.js';
import { createThreadlineRoutes } from '../../../src/threadline/ThreadlineEndpoints.js';
import { decideHttpPeerAdmission, resolveHttpPeerTrust, type HttpPeerTrustDeps } from '../../../src/threadline/httpPeerTrust.js';
import { isUsablePeerName } from '../../../src/threadline/HandshakeManager.js';
import { DIRECT_PEER_ROUTES, isDirectPeerRoute } from '../../../src/threadline/ThreadlineEndpoints.js';
import { THREADLINE_PUBLIC_ROUTES } from '../../../src/server/middleware.js';
import { AgentTrustManager } from '../../../src/threadline/AgentTrustManager.js';
import { sign, generateIdentityKeyPair } from '../../../src/threadline/ThreadlineCrypto.js';
import { computeFingerprint } from '../../../src/threadline/client/MessageEncryptor.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

const OP = 'tests/unit/threadline/threadline-http-peer-trust.test.ts';

function peer(dir: string, name: string) {
  fs.mkdirSync(path.join(dir, 'threadline'), { recursive: true });
  const kp = generateIdentityKeyPair();
  fs.writeFileSync(path.join(dir, 'threadline', 'identity.json'), JSON.stringify({
    publicKey: kp.publicKey.toString('hex'), privateKey: kp.privateKey.toString('hex'),
  }));
  return { mgr: new HandshakeManager(dir, name), name, priv: kp.privateKey, pubHex: kp.publicKey.toString('hex'), fp: computeFingerprint(kp.publicKey) };
}

async function handshake(app: express.Express, initiator: HandshakeManager, target: string) {
  const init = initiator.initiateHandshake(target);
  if (!('payload' in init)) throw new Error('init');
  const hello = await request(app).post('/threadline/handshake/hello').send(init.payload);
  if (hello.status !== 200) return hello;
  const c = initiator.handleHelloResponse({
    agent: hello.body.agent, identityPub: hello.body.identityPub, ephemeralPub: hello.body.ephemeralPub,
    nonce: hello.body.nonce, challengeResponse: hello.body.challengeResponse,
  });
  if (!('confirmPayload' in c)) throw new Error('response: ' + JSON.stringify(c));
  return request(app).post('/threadline/handshake/confirm').send(c.confirmPayload);
}

function send(app: express.Express, p: ReturnType<typeof peer>, target: string, body: unknown) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const timestamp = new Date().toISOString();
  const hash = crypto.createHash('sha256').update(JSON.stringify(body)).digest();
  const data = Buffer.concat([Buffer.from(`POST\n/threadline/messages/receive\n${nonce}\n${timestamp}\n`, 'utf-8'), hash]);
  return request(app).post('/threadline/messages/receive').set({
    Authorization: `Threadline-Relay ${p.mgr.getRelayToken(target)!}`,
    'X-Threadline-Agent': p.name, 'X-Threadline-Nonce': nonce, 'X-Threadline-Timestamp': timestamp,
    'X-Threadline-Signature': sign(p.priv, data).toString('hex'),
  }).send(body);
}

const msg = (from: string) => ({ message: { id: crypto.randomUUID(), threadId: crypto.randomUUID(), from: { agent: from }, body: 'hello' } });
const settle = () => new Promise((r) => setImmediate(r));

describe('threadline HTTP peer trust', () => {
  let tmp: string;
  let calls: any[];
  const router = { handleInboundMessage: async (...a: any[]) => { calls.push(a); return { handled: true }; } };
  /** Grants every key: the pinning and name tests are about the handshake, not admission. */
  const GRANT_ALL: HttpPeerTrustDeps = { resolve: () => ({ level: 'trusted', operation: 'message', allowed: true, hasProfile: true }) };
  /** No trust source wired at all. */
  const NO_TRUST: HttpPeerTrustDeps = {};
  function appFor(mgr: HandshakeManager, deps: HttpPeerTrustDeps = GRANT_ALL) {
    const app = express(); app.use(express.json());
    app.use(createThreadlineRoutes(mgr, router as never, { localAgent: 'host', version: '1.0', stateDir: path.join(tmp, 'host'), httpPeerTrust: deps, directPeerProtocol: () => true }));
    return app;
  }
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'http-peer-trust-')); calls = []; });
  afterEach(() => { SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: OP }); });

  describe('key pinning on the handshake', () => {
    it('refuses a second pairing under an already-paired name with a different key, and keeps the pinned key', async () => {
      const host = new HandshakeManager(path.join(tmp, 'host'), 'host');
      const app = appFor(host);
      const real = peer(path.join(tmp, 'real'), 'friend');
      expect((await handshake(app, real.mgr, 'host')).status).toBe(200);
      const impostor = peer(path.join(tmp, 'imp'), 'friend');
      const second = await handshake(app, impostor.mgr, 'host');
      expect(second.status).toBe(400);
      expect(JSON.stringify(second.body)).toContain('Handshake refused');
      expect(host.getPairedIdentityPub('friend')).toBe(real.pubHex);
    });

    it('still lets the same peer re-pair with its own key', async () => {
      const host = new HandshakeManager(path.join(tmp, 'host'), 'host');
      const app = appFor(host);
      const real = peer(path.join(tmp, 'real'), 'friend');
      expect((await handshake(app, real.mgr, 'host')).status).toBe(200);
      expect((await handshake(app, real.mgr, 'host')).status).toBe(200);
      expect(host.getPairedIdentityPub('friend')).toBe(real.pubHex);
    });

    it('the initiator refuses a responder that answers with a different key than the one it paired with', () => {
      const a = peer(path.join(tmp, 'a'), 'agent-a');
      const b1 = peer(path.join(tmp, 'b1'), 'agent-b');
      const i1 = a.mgr.initiateHandshake('agent-b'); if (!('payload' in i1)) throw new Error('i1');
      const r1 = b1.mgr.handleHello(i1.payload); if (!('payload' in r1)) throw new Error('r1');
      expect('confirmPayload' in a.mgr.handleHelloResponse(r1.payload)).toBe(true);
      const b2 = peer(path.join(tmp, 'b2'), 'agent-b');
      const i2 = a.mgr.initiateHandshake('agent-b'); if (!('payload' in i2)) throw new Error('i2');
      const r2 = b2.mgr.handleHello(i2.payload); if (!('payload' in r2)) throw new Error('r2');
      const out = a.mgr.handleHelloResponse(r2.payload);
      expect('error' in out && out.error).toBe('Handshake refused');
      expect(a.mgr.getPairedIdentityPub('agent-b')).toBe(b1.pubHex);
    });
  });

  describe('admission on /threadline/messages/receive', () => {
    it('refuses a stranger at the handshake: 403, nothing paired, no handshake state', async () => {
      const host = new HandshakeManager(path.join(tmp, 'host'), 'host');
      const app = appFor(host, { resolve: () => null });
      const s = peer(path.join(tmp, 's'), 'stranger');
      const r = await handshake(app, s.mgr, 'host');
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('TL_SENDER_NOT_TRUSTED');
      expect(host.listPairedAgents()).toHaveLength(0);
      expect(host.isHandshakeInProgress('stranger')).toBe(false);
      expect((host as any).rateLimits.size).toBe(0);
      expect(calls).toHaveLength(0);
    });

    it('a flood of strangers under fresh names leaves no state behind', async () => {
      const host = new HandshakeManager(path.join(tmp, 'host'), 'host');
      const app = appFor(host, { resolve: () => null });
      for (let i = 0; i < 25; i++) {
        const s = peer(path.join(tmp, `f${i}`), `name-${i}`);
        expect((await handshake(app, s.mgr, 'host')).status).toBe(403);
      }
      expect((host as any).rateLimits.size).toBe(0);
      expect((host as any).handshakes.size).toBe(0);
    });

    it('refuses when no trust source is wired at all (fails closed)', async () => {
      const host = new HandshakeManager(path.join(tmp, 'host'), 'host');
      const app = appFor(host, NO_TRUST);
      const s = peer(path.join(tmp, 's'), 'stranger');
      expect((await handshake(app, s.mgr, 'host')).status).toBe(403);
      expect(calls).toHaveLength(0);
    });

    it('uses the real trust manager: no profile is untrusted (refused); a granted profile is admitted with its level', async () => {
      const host = new HandshakeManager(path.join(tmp, 'host'), 'host');
      const tm = new AgentTrustManager({ stateDir: path.join(tmp, 'tm') });
      const app = appFor(host, { resolve: (fp, wt) => resolveHttpPeerTrust(tm, fp, String(wt)) });
      const s = peer(path.join(tmp, 's'), 'friend');
      expect((await handshake(app, s.mgr, 'host')).status).toBe(403);
      tm.setTrustLevelByFingerprint(s.fp, 'trusted', 'user-granted', 'test grant');
      expect((await handshake(app, s.mgr, 'host')).status).toBe(200);
      const ok = await send(app, s, 'host', msg('friend'));
      await settle();
      expect(ok.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0][2].localTrustLevel).toBe('trusted');
    });

    it('a pairing that already existed when the check shipped gets no free pass', async () => {
      const hostDir = path.join(tmp, 'host');
      const old = peer(path.join(tmp, 'old'), 'oldfriend');
      await handshake(appFor(new HandshakeManager(hostDir, 'host')), old.mgr, 'host');
      const restarted = new HandshakeManager(hostDir, 'host');
      const r = await send(appFor(restarted, { resolve: () => null }), old, 'host', msg('oldfriend'));
      await settle();
      expect(r.status).toBe(403);
      expect(calls).toHaveLength(0);
    });

    it('the explicit off switch restores the previous behaviour', async () => {
      const host = new HandshakeManager(path.join(tmp, 'host'), 'host');
      const app = appFor(host, { enabled: () => false, resolve: () => null });
      const s = peer(path.join(tmp, 's'), 'stranger');
      await handshake(app, s.mgr, 'host');
      const r = await send(app, s, 'host', msg('stranger'));
      await settle();
      expect(r.status).toBe(200);
      expect(calls).toHaveLength(1);
    });

    it("records the sender by its verified fingerprint, keeping the header name for display", async () => {
      const host = new HandshakeManager(path.join(tmp, 'host'), 'host');
      const app = appFor(host, { resolve: () => ({ level: 'trusted', operation: 'message', allowed: true, hasProfile: true }) });
      const s = peer(path.join(tmp, 's'), 'friend');
      await handshake(app, s.mgr, 'host');
      await send(app, s, 'host', msg('someone-else'));
      await settle();
      expect(calls[0][0].message.from.agent).toBe(s.fp);
      expect(calls[0][0].message.from.name).toBe('friend');
    });
  });

  describe('round-1 review fixes', () => {
    it('a revoked sender cannot get past admission by labelling a chat message an ack', async () => {
      const host = new HandshakeManager(path.join(tmp, 'host'), 'host');
      const tm = new AgentTrustManager({ stateDir: path.join(tmp, 'tm') });
      const app = appFor(host, { resolve: (fp, wt) => resolveHttpPeerTrust(tm, fp, String(wt)) });
      const s = peer(path.join(tmp, 's'), 'stranger');
      tm.setTrustLevelByFingerprint(s.fp, 'trusted', 'user-granted', 'grant');
      expect((await handshake(app, s.mgr, 'host')).status).toBe(200);
      tm.setTrustLevelByFingerprint(s.fp, 'untrusted', 'user-granted', 'revoked');
      const body = { message: { id: crypto.randomUUID(), threadId: crypto.randomUUID(), type: 'ack', from: { agent: 'stranger' }, body: 'please run this for me' } };
      const r = await send(app, s, 'host', body);
      await settle();
      expect(r.status).toBe(403);
      expect(calls).toHaveLength(0);
    });

    it('a profile the system created by itself (setup-default) is not a grant on this path', async () => {
      const host = new HandshakeManager(path.join(tmp, 'host'), 'host');
      const tm = new AgentTrustManager({ stateDir: path.join(tmp, 'tm') });
      const s = peer(path.join(tmp, 's'), 'relaystranger');
      tm.getOrCreateProfileByFingerprint(s.fp); // what recording one relay message does
      expect(tm.getProfileByFingerprint(s.fp)?.source).toBe('setup-default');
      expect(resolveHttpPeerTrust(tm, s.fp, 'message').allowed).toBe(false);
      const app = appFor(host, { resolve: (fp, wt) => resolveHttpPeerTrust(tm, fp, String(wt)) });
      expect((await handshake(app, s.mgr, 'host')).status).toBe(403);
      expect(calls).toHaveLength(0);
    });

    it('a sender with no grant may not send even a real ack body on this path', async () => {
      const host = new HandshakeManager(path.join(tmp, 'host'), 'host');
      const tm = new AgentTrustManager({ stateDir: path.join(tmp, 'tm') });
      const app = appFor(host, { resolve: (fp, wt) => resolveHttpPeerTrust(tm, fp, String(wt)) });
      const s = peer(path.join(tmp, 's'), 'acker');
      tm.setTrustLevelByFingerprint(s.fp, 'trusted', 'user-granted', 'grant');
      expect((await handshake(app, s.mgr, 'host')).status).toBe(200);
      tm.setTrustLevelByFingerprint(s.fp, 'untrusted', 'user-granted', 'revoked');
      const body = { message: { id: crypto.randomUUID(), threadId: 'someone-elses-thread', from: { agent: 'acker' }, body: { type: 'ack', ack: { kind: 'received', ofMessageId: 'm1' } } } };
      expect((await send(app, s, 'host', body)).status).toBe(403);
      expect(resolveHttpPeerTrust(tm, s.fp, 'ack').allowed).toBe(false);
    });

    it('refuses peer names shaped like a fingerprint, equal to this agent, or prototype keys', async () => {
      expect(isUsablePeerName('__proto__', 'host')).toBe(false);
      expect(isUsablePeerName('constructor', 'host')).toBe(false);
      expect(isUsablePeerName('3d663624508f321ce4ac5e46f136cfb0', 'host')).toBe(false);
      expect(isUsablePeerName('Host', 'host')).toBe(false);
      expect(isUsablePeerName('dawn', 'host')).toBe(true);
      const host = new HandshakeManager(path.join(tmp, 'host'), 'host');
      const app = appFor(host);
      const fpName = peer(path.join(tmp, 'f'), 'abcdef0123456789abcdef0123456789');
      expect((await handshake(app, fpName.mgr, 'host')).status).toBe(400);
      const self = peer(path.join(tmp, 'h2'), 'host');
      expect((await handshake(app, self.mgr, 'host')).status).toBe(400);
    });

    it('wrong-key attempts under a paired name do not lock the real peer out of re-pairing', async () => {
      const host = new HandshakeManager(path.join(tmp, 'host'), 'host');
      const app = appFor(host);
      const real = peer(path.join(tmp, 'real'), 'friend');
      expect((await handshake(app, real.mgr, 'host')).status).toBe(200);
      for (let i = 0; i < 12; i++) {
        const imp = peer(path.join(tmp, `imp${i}`), 'friend');
        expect((await handshake(app, imp.mgr, 'host')).status).toBe(400);
      }
      expect((await handshake(app, real.mgr, 'host')).status).toBe(200);
    });

    it('confirm is refused when a different key paired the name after hello (race)', () => {
      const host = new HandshakeManager(path.join(tmp, 'host'), 'host');
      const a = peer(path.join(tmp, 'a'), 'racer');
      const b = peer(path.join(tmp, 'b'), 'racer');
      const ia = a.mgr.initiateHandshake('host'); if (!('payload' in ia)) throw new Error('ia');
      const ha = host.handleHello(ia.payload); if (!('payload' in ha)) throw new Error('ha');
      // b completes a full pairing under the same name first
      const ib = b.mgr.initiateHandshake('host'); if (!('payload' in ib)) throw new Error('ib');
      const hb = host.handleHello(ib.payload); if (!('payload' in hb)) throw new Error('hb');
      const cb = b.mgr.handleHelloResponse(hb.payload); if (!('confirmPayload' in cb)) throw new Error('cb');
      expect('relayToken' in host.handleConfirm(cb.confirmPayload)).toBe(true);
      const ca = a.mgr.handleHelloResponse(ha.payload); if (!('confirmPayload' in ca)) throw new Error('ca');
      const out = host.handleConfirm(ca.confirmPayload);
      expect('error' in out).toBe(true);
      expect(host.getPairedIdentityPub('racer')).toBe(b.pubHex);
    });

    it('the owner can remove a pairing, which frees the name for a new key', async () => {
      const host = new HandshakeManager(path.join(tmp, 'host'), 'host');
      const app = appFor(host);
      const old = peer(path.join(tmp, 'old'), 'friend');
      await handshake(app, old.mgr, 'host');
      const del = await request(app).delete('/threadline/pairings/friend');
      expect(del.status).toBe(200);
      expect((await request(app).delete('/threadline/pairings/friend')).status).toBe(404);
      const reinstalled = peer(path.join(tmp, 'new'), 'friend');
      expect((await handshake(app, reinstalled.mgr, 'host')).status).toBe(200);
      expect(host.getPairedIdentityPub('friend')).toBe(reinstalled.pubHex);
    });
  });

  describe('closed by default (§0)', () => {
    it('with no switch, every direct peer route answers 404 before any processing, health still answers', async () => {
      const host = new HandshakeManager(path.join(tmp, 'host'), 'host');
      const app = express(); app.use(express.json());
      app.use(createThreadlineRoutes(host, router as never, { localAgent: 'host', version: '1.0', stateDir: path.join(tmp, 'host') }));
      const s = peer(path.join(tmp, 's'), 'stranger');
      const init = s.mgr.initiateHandshake('host'); if (!('payload' in init)) throw new Error('init');
      const probes: Array<['post' | 'get', string]> = [['post', '/threadline/handshake/hello'], ['post', '/Threadline/Handshake/Hello/'], ['post', '/threadline/handshake/confirm'], ['post', '/threadline/messages/receive'], ['post', '/threadline/threads/backfill'], ['get', '/threadline/blobs/x']];
      for (const [m, u] of probes) {
        const r = m === 'post' ? await request(app).post(u).send(init.payload) : await request(app).get(u);
        expect(r.status, u).toBe(404);
      }
      expect(host.listPairedAgents()).toHaveLength(0);
      expect((await request(app).get('/threadline/health')).status).toBe(200);
      expect(calls).toHaveLength(0);
    });

    it('a switch that throws keeps the routes closed', async () => {
      const host = new HandshakeManager(path.join(tmp, 'host'), 'host');
      const app = express(); app.use(express.json());
      app.use(createThreadlineRoutes(host, router as never, { localAgent: 'host', version: '1.0', stateDir: path.join(tmp, 'host'), directPeerProtocol: () => { throw new Error('x'); } }));
      expect((await request(app).post('/threadline/handshake/hello').send({})).status).toBe(404);
    });

    it('an unreadable pairing store refuses new pairings instead of forgetting the pins', async () => {
      const hostDir = path.join(tmp, 'host');
      fs.mkdirSync(path.join(hostDir, 'threadline'), { recursive: true });
      fs.writeFileSync(path.join(hostDir, 'threadline', 'relay-tokens.json'), '{ not json');
      const host = new HandshakeManager(hostDir, 'host');
      const s = peer(path.join(tmp, 's'), 'friend');
      expect((await handshake(appFor(host), s.mgr, 'host')).status).toBe(400);
      expect(fs.readFileSync(path.join(hostDir, 'threadline', 'relay-tokens.json'), 'utf-8')).toBe('{ not json');
    });

    it('unsolicited confirms do not lock a name out', async () => {
      const host = new HandshakeManager(path.join(tmp, 'host'), 'host');
      const app = appFor(host);
      for (let i = 0; i < 12; i++) {
        await request(app).post('/threadline/handshake/confirm').send({ agent: 'friend', challengeResponse: '00'.repeat(64) });
      }
      const real = peer(path.join(tmp, 'real'), 'friend');
      expect((await handshake(app, real.mgr, 'host')).status).toBe(200);
    });
  });

  describe('round-3 review fixes', () => {
    it('the closed list is exactly the public Threadline routes minus health and the loopback secret request', () => {
      const pub = THREADLINE_PUBLIC_ROUTES.filter((r) => r.path !== '/threadline/health' && r.path !== '/threadline/secrets/request');
      expect([...DIRECT_PEER_ROUTES].map((r) => `${r.method} ${r.path}`).sort()).toEqual(pub.map((r) => `${r.method} ${r.path}`).sort());
      expect(isDirectPeerRoute('GET', '/threadline/blobs/abc')).toBe(true);
      expect(isDirectPeerRoute('post', '/THREADLINE/messages/receive/')).toBe(true);
      expect(isDirectPeerRoute('GET', '/threadline/health')).toBe(false);
    });

    it('only decided trust sources are grants (an unknown source is not)', () => {
      const fake = (source: string) => ({
        getProfileByFingerprint: () => ({ fingerprint: 'fp', level: 'trusted', source } as any),
        getAllowedOperationsByFingerprint: () => ['message', 'query', 'task-request'],
      });
      expect(resolveHttpPeerTrust(fake('user-granted') as any, 'fp', 'message').allowed).toBe(true);
      expect(resolveHttpPeerTrust(fake('mutual-verified') as any, 'fp', 'message').allowed).toBe(true);
      expect(resolveHttpPeerTrust(fake('setup-default') as any, 'fp', 'message').allowed).toBe(false);
      expect(resolveHttpPeerTrust(fake('some-future-auto-source') as any, 'fp', 'message').allowed).toBe(false);
    });

    it('failed confirms under a paired name do not block its re-pairing', async () => {
      const host = new HandshakeManager(path.join(tmp, 'host'), 'host');
      const app = appFor(host);
      const real = peer(path.join(tmp, 'real'), 'friend');
      expect((await handshake(app, real.mgr, 'host')).status).toBe(200);
      for (let i = 0; i < 12; i++) {
        // a hello with the real (public) key, then a garbage confirm
        const imp = new HandshakeManager(path.join(tmp, `i${i}`), 'friend');
        const init = imp.initiateHandshake('host'); if (!('payload' in init)) throw new Error('init');
        await request(app).post('/threadline/handshake/hello').send({ ...init.payload, identityPub: real.pubHex });
        await request(app).post('/threadline/handshake/confirm').send({ agent: 'friend', challengeResponse: '00'.repeat(64) });
      }
      // The per-minute attempt limit may still apply (documented residual: the hello is
      // unsigned); the hour-long block for failures must not.
      const again = await handshake(app, real.mgr, 'host');
      expect(JSON.stringify(again.body)).not.toContain('too many failures');
      expect((host as any).rateLimits.get('friend')?.failures ?? 0).toBe(0);
    });
  });

  describe('round-5 review fixes', () => {
    it('a garbage confirm does not end a granted peer\'s handshake or count against its name', async () => {
      const host = new HandshakeManager(path.join(tmp, 'host'), 'host');
      const app = appFor(host);
      const real = peer(path.join(tmp, 'real'), 'newfriend');
      const init = real.mgr.initiateHandshake('host'); if (!('payload' in init)) throw new Error('init');
      const hello = await request(app).post('/threadline/handshake/hello').send(init.payload);
      expect(hello.status).toBe(200);
      for (let i = 0; i < 12; i++) {
        await request(app).post('/threadline/handshake/confirm').send({ agent: 'newfriend', challengeResponse: '00'.repeat(64) });
      }
      const c = real.mgr.handleHelloResponse({ agent: hello.body.agent, identityPub: hello.body.identityPub, ephemeralPub: hello.body.ephemeralPub, nonce: hello.body.nonce, challengeResponse: hello.body.challengeResponse });
      if (!('confirmPayload' in c)) throw new Error('resp');
      expect((await request(app).post('/threadline/handshake/confirm').send(c.confirmPayload)).status).toBe(200);
      expect((host as any).rateLimits.get('newfriend')?.failures ?? 0).toBe(0);
    });
  });

  describe('round-6 review fixes', () => {
    it('a granted PUBLIC key presented without its private key under fresh names leaves bounded state', async () => {
      const host = new HandshakeManager(path.join(tmp, 'host'), 'host');
      const app = appFor(host); // grants every key, as if this key were granted
      const granted = peer(path.join(tmp, 'g'), 'granted');
      for (let i = 0; i < 30; i++) {
        const imp = new HandshakeManager(path.join(tmp, `n${i}`), `fresh-${i}`);
        const init = imp.initiateHandshake('host'); if (!('payload' in init)) throw new Error('init');
        await request(app).post('/threadline/handshake/hello').send({ ...init.payload, identityPub: granted.pubHex });
      }
      expect((host as any).handshakes.size).toBeLessThanOrEqual(1);
      expect((host as any).rateLimits.size).toBeLessThanOrEqual(1);
      expect(host.listPairedAgents()).toHaveLength(0);
    });

    it('rejects a key that is not exactly 64 hex, so it cannot be respelled into extra rate entries', async () => {
      const host = new HandshakeManager(path.join(tmp, 'host'), 'host');
      const app = appFor(host);
      const g = peer(path.join(tmp, 'g'), 'granted');
      expect((await handshake(app, g.mgr, 'host')).status).toBe(200);
      for (const bad of [g.pubHex + 'zz', g.pubHex.slice(0, 63), g.pubHex.toUpperCase() + 'GG']) {
        const init = new HandshakeManager(path.join(tmp, bad.slice(-6)), 'other').initiateHandshake('host');
        if (!('payload' in init)) throw new Error('init');
        const r = await request(app).post('/threadline/handshake/hello').send({ ...init.payload, identityPub: bad });
        expect(r.status).toBe(400);
      }
    });

    it('refuses names with surrounding whitespace or a non-NFC spelling', () => {
      expect(isUsablePeerName(' alice', 'host')).toBe(false);
      expect(isUsablePeerName('alice ', 'host')).toBe(false);
      expect(isUsablePeerName('cafe\u0301', 'host')).toBe(false);
      expect(isUsablePeerName('caf\u00e9', 'host')).toBe(true);
    });
  });

  describe('decideHttpPeerAdmission', () => {
    const allowed = { level: 'verified' as const, operation: 'message', allowed: true, hasProfile: true };
    const denied = { level: 'untrusted' as const, operation: 'message', allowed: false, hasProfile: false };
    it('admits trusted, refuses untrusted', () => {
      expect(decideHttpPeerAdmission({ deps: { resolve: () => allowed }, fingerprint: 'fp', wireType: undefined }))
        .toEqual({ admit: true, reason: 'trusted', level: 'verified' });
      expect(decideHttpPeerAdmission({ deps: { resolve: () => denied }, fingerprint: 'fp', wireType: undefined }))
        .toEqual({ admit: false, reason: 'not-trusted', level: 'untrusted' });
    });
    it('refuses with no verified principal', () => {
      expect(decideHttpPeerAdmission({ deps: { resolve: () => allowed }, fingerprint: undefined, wireType: undefined }).admit).toBe(false);
    });
    it('a throwing trust source refuses; a throwing switch stays on', () => {
      const boom = () => { throw new Error('x'); };
      expect(decideHttpPeerAdmission({ deps: { resolve: boom }, fingerprint: 'fp', wireType: undefined }).admit).toBe(false);
      expect(decideHttpPeerAdmission({ deps: { enabled: boom, resolve: () => denied }, fingerprint: 'fp', wireType: undefined }).admit).toBe(false);
    });
  });
});

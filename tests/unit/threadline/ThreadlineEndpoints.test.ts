import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { HandshakeManager } from '../../../src/threadline/HandshakeManager.js';
import { createThreadlineRoutes } from '../../../src/threadline/ThreadlineEndpoints.js';
import { sign, generateIdentityKeyPair } from '../../../src/threadline/ThreadlineCrypto.js';
import { computeFingerprint } from '../../../src/threadline/client/MessageEncryptor.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

/** Write a canonical (unencrypted) identity.json into a state dir and return its expected fingerprint. */
function writeCanonicalIdentity(stateDir: string): { fingerprint: string; publicKeyHex: string } {
  fs.mkdirSync(stateDir, { recursive: true });
  const kp = generateIdentityKeyPair();
  fs.writeFileSync(
    path.join(stateDir, 'identity.json'),
    JSON.stringify({
      publicKey: kp.publicKey.toString('base64'),
      privateKey: kp.privateKey.toString('base64'),
      privateKeyEncryption: 'none',
      createdAt: new Date().toISOString(),
    }, null, 2),
  );
  return { fingerprint: computeFingerprint(kp.publicKey), publicKeyHex: kp.publicKey.toString('hex') };
}

describe('ThreadlineEndpoints', () => {
  let tmpDir: string;
  let stateDirA: string;
  let stateDirB: string;
  let appA: express.Express;
  let appB: express.Express;
  let managerA: HandshakeManager;
  let managerB: HandshakeManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'threadline-ep-test-'));
    stateDirA = path.join(tmpDir, 'agent-a');
    stateDirB = path.join(tmpDir, 'agent-b');

    managerA = new HandshakeManager(stateDirA, 'agent-a');
    managerB = new HandshakeManager(stateDirB, 'agent-b');

    appA = express();
    appA.use(express.json());
    appA.use(createThreadlineRoutes(managerA, null, {
      localAgent: 'agent-a',
      version: '1.0',
      stateDir: stateDirA,
    }));

    appB = express();
    appB.use(express.json());
    appB.use(createThreadlineRoutes(managerB, null, {
      localAgent: 'agent-b',
      version: '1.0',
      stateDir: stateDirB,
    }));
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/threadline/ThreadlineEndpoints.test.ts:46' });
  });

  describe('GET /threadline/health', () => {
    it('returns health status', async () => {
      const res = await request(appA).get('/threadline/health');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.protocol).toBe('threadline');
      expect(res.body.version).toBe('1.0');
      expect(res.body.agent).toBe('agent-a');
      expect(res.body.identityPub).toBeDefined();
      expect(res.body.identityPub).toHaveLength(64); // 32 bytes hex
      expect(res.body.pairedAgents).toBe(0);
    });

    it('sets correct content type', async () => {
      const res = await request(appA).get('/threadline/health');
      expect(res.headers['content-type']).toContain('application/threadline+json');
    });

    // THREADLINE-IDENTITY-DISCOVERY-UNIFICATION: health must advertise the
    // canonical routing identity (the address the relay answers to), with
    // identityPub and fingerprint internally consistent.
    it('reports the canonical routing fingerprint + consistent identityPub when an identity exists', async () => {
      const stateDir = path.join(tmpDir, 'agent-canonical');
      const expected = writeCanonicalIdentity(stateDir);

      const app = express();
      app.use(express.json());
      app.use(createThreadlineRoutes(new HandshakeManager(stateDir, 'agent-canonical'), null, {
        localAgent: 'agent-canonical',
        version: '1.0',
        stateDir,
      }));

      const res = await request(app).get('/threadline/health');
      expect(res.status).toBe(200);
      expect(res.body.fingerprint).toBe(expected.fingerprint);
      expect(res.body.identityPub).toBe(expected.publicKeyHex);
      // Internal consistency: fingerprint === computeFingerprint(identityPub)
      expect(computeFingerprint(Buffer.from(res.body.identityPub, 'hex'))).toBe(res.body.fingerprint);
    });

    // No-fabrication boundary: no canonical identity → fall back to the
    // handshake key and OMIT the fingerprint (never invent a dead address).
    it('omits fingerprint and falls back to the handshake key when no routing identity exists', async () => {
      // appA's stateDirA has no canonical identity.json (only the handshake manager key).
      const res = await request(appA).get('/threadline/health');
      expect(res.status).toBe(200);
      expect(res.body.fingerprint).toBeUndefined();
      // Falls back to the handshake-layer key so existing behavior is preserved.
      expect(res.body.identityPub).toBeDefined();
      expect(res.body.identityPub).toHaveLength(64);
    });
  });

  describe('POST /threadline/handshake/hello', () => {
    it('processes a hello and returns hello-response', async () => {
      // Agent A initiates locally, then sends hello to agent B's endpoint
      const initResult = managerA.initiateHandshake('agent-b');
      if (!('payload' in initResult)) throw new Error('unexpected');

      const res = await request(appB)
        .post('/threadline/handshake/hello')
        .send(initResult.payload);

      expect(res.status).toBe(200);
      expect(res.body.type).toBe('hello-response');
      expect(res.body.agent).toBe('agent-b');
      expect(res.body.identityPub).toHaveLength(64);
      expect(res.body.ephemeralPub).toHaveLength(64);
      expect(res.body.nonce).toBeDefined();
      expect(res.body.challengeResponse).toBeDefined();
    });

    it('rejects invalid payload — missing fields', async () => {
      const res = await request(appA)
        .post('/threadline/handshake/hello')
        .send({ agent: 'test' }); // missing identityPub, ephemeralPub, nonce

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('TL_INVALID_PAYLOAD');
      expect(res.body.error.retryable).toBe(false);
    });

    it('rejects invalid hex encoding', async () => {
      const res = await request(appA)
        .post('/threadline/handshake/hello')
        .send({
          agent: 'test',
          identityPub: 'not-hex',
          ephemeralPub: 'also-not-hex',
          nonce: 'test-nonce',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('TL_INVALID_PAYLOAD');
    });
  });

  describe('POST /threadline/handshake/confirm', () => {
    it('rejects confirm with no pending handshake', async () => {
      const res = await request(appA)
        .post('/threadline/handshake/confirm')
        .send({
          agent: 'unknown',
          challengeResponse: 'aa'.repeat(64),
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('TL_HANDSHAKE_FAILED');
    });

    it('rejects confirm missing fields', async () => {
      const res = await request(appA)
        .post('/threadline/handshake/confirm')
        .send({ agent: 'test' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('TL_INVALID_PAYLOAD');
    });
  });

  describe('Full handshake flow via HTTP', () => {
    it('completes handshake between two agents via endpoints', async () => {
      // Step 1: Agent A initiates locally
      const initResult = managerA.initiateHandshake('agent-b');
      if (!('payload' in initResult)) throw new Error('unexpected');

      // Step 2: Send hello to agent B's endpoint
      const helloRes = await request(appB)
        .post('/threadline/handshake/hello')
        .send(initResult.payload);

      expect(helloRes.status).toBe(200);
      expect(helloRes.body.type).toBe('hello-response');

      // Step 3: Agent A processes B's hello response
      const helloResponsePayload = {
        agent: helloRes.body.agent,
        identityPub: helloRes.body.identityPub,
        ephemeralPub: helloRes.body.ephemeralPub,
        nonce: helloRes.body.nonce,
        challengeResponse: helloRes.body.challengeResponse,
      };
      const confirmResult = managerA.handleHelloResponse(helloResponsePayload);
      if (!('confirmPayload' in confirmResult)) throw new Error('unexpected: ' + JSON.stringify(confirmResult));

      // Step 4: Send confirm to agent B's endpoint
      const confirmRes = await request(appB)
        .post('/threadline/handshake/confirm')
        .send(confirmResult.confirmPayload);

      expect(confirmRes.status).toBe(200);
      expect(confirmRes.body.status).toBe('paired');

      // Verify both have relay tokens
      expect(managerA.getRelayToken('agent-b')).toBeTruthy();
      expect(managerB.getRelayToken('agent-a')).toBeTruthy();
      expect(managerA.getRelayToken('agent-b')).toBe(managerB.getRelayToken('agent-a'));
    });
  });

  describe('Authenticated endpoints', () => {
    // Helper to complete handshake and get tokens
    async function completeHandshake() {
      const init = managerA.initiateHandshake('agent-b');
      if (!('payload' in init)) throw new Error('unexpected');

      const resp = managerB.handleHello(init.payload);
      if (!('payload' in resp)) throw new Error('unexpected');

      const confirm = managerA.handleHelloResponse(resp.payload);
      if (!('confirmPayload' in confirm)) throw new Error('unexpected');

      managerB.handleConfirm(confirm.confirmPayload);

      return managerA.getRelayToken('agent-b')!;
    }

    it('rejects requests without Authorization header', async () => {
      const res = await request(appA)
        .post('/threadline/messages/receive')
        .send({ message: {} });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('TL_AUTH_MISSING');
    });

    it('rejects requests with wrong Authorization scheme', async () => {
      const res = await request(appA)
        .post('/threadline/messages/receive')
        .set('Authorization', 'Bearer some-token')
        .send({ message: {} });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('TL_AUTH_MISSING');
    });

    it('rejects requests missing required threadline headers', async () => {
      await completeHandshake();

      const res = await request(appB)
        .post('/threadline/messages/receive')
        .set('Authorization', `Threadline-Relay ${managerA.getRelayToken('agent-b')}`)
        .send({ message: {} });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('TL_AUTH_MISSING');
    });

    it('rejects requests with invalid relay token', async () => {
      await completeHandshake();

      const res = await request(appB)
        .post('/threadline/messages/receive')
        .set('Authorization', 'Threadline-Relay ' + 'deadbeef'.repeat(8))
        .set('X-Threadline-Agent', 'agent-a')
        .set('X-Threadline-Nonce', crypto.randomBytes(16).toString('hex'))
        .set('X-Threadline-Timestamp', new Date().toISOString())
        .set('X-Threadline-Signature', 'aa'.repeat(64))
        .send({ message: {} });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('TL_AUTH_FAILED');
    });

    it('rejects expired timestamps', async () => {
      await completeHandshake();
      const token = managerA.getRelayToken('agent-b')!;

      const oldTimestamp = new Date(Date.now() - 60_000).toISOString(); // 1 minute ago
      const nonce = crypto.randomBytes(16).toString('hex');

      const res = await request(appB)
        .post('/threadline/messages/receive')
        .set('Authorization', `Threadline-Relay ${token}`)
        .set('X-Threadline-Agent', 'agent-a')
        .set('X-Threadline-Nonce', nonce)
        .set('X-Threadline-Timestamp', oldTimestamp)
        .set('X-Threadline-Signature', 'aa'.repeat(64))
        .send({ message: {} });

      // Token is valid, but timestamp is outside the 30s window
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('TL_TIMESTAMP_EXPIRED');
    });
  });

  // Accept-boundary (#3 / issue-580): the receive handler must respond the
  // instant the message is accepted + authenticated and run the (slow) spawn in
  // the background — NOT await it — so a sender on a ~10s timeout can't time out,
  // treat delivery as failed, and retry with a fresh nonce → duplicate spawn.
  describe('POST /threadline/messages/receive — accept-boundary', () => {
    // Self-contained agents so we control agent-a's signing key directly: write a
    // KNOWN hex identity for agent-a before constructing its manager, then sign
    // with that exact private key (the outer managers persist their identity
    // lazily/in-memory, which we can't read back).
    let abA: HandshakeManager;
    let abB: HandshakeManager;
    let abDirB: string;
    let aPriv: Buffer;

    beforeEach(() => {
      const dirA = path.join(tmpDir, 'ab-a');
      abDirB = path.join(tmpDir, 'ab-b');
      // HandshakeManager keeps identity under <stateDir>/threadline/identity.json.
      fs.mkdirSync(path.join(dirA, 'threadline'), { recursive: true });
      fs.mkdirSync(abDirB, { recursive: true });
      const kp = generateIdentityKeyPair();
      aPriv = kp.privateKey;
      fs.writeFileSync(path.join(dirA, 'threadline', 'identity.json'), JSON.stringify({
        publicKey: kp.publicKey.toString('hex'),
        privateKey: kp.privateKey.toString('hex'),
      }, null, 2));
      abA = new HandshakeManager(dirA, 'agent-a');
      abB = new HandshakeManager(abDirB, 'agent-b');
      // Sanity: the manager loaded OUR known key (so our signature will verify).
      expect(abA.getIdentityPublicKey()).toBe(kp.publicKey.toString('hex'));
    }, 20000);

    /** Complete the A→B handshake so agent-b trusts agent-a's identity. */
    function completeHandshake() {
      const init = abA.initiateHandshake('agent-b');
      if (!('payload' in init)) throw new Error('unexpected');
      const resp = abB.handleHello(init.payload);
      if (!('payload' in resp)) throw new Error('unexpected');
      const confirm = abA.handleHelloResponse(resp.payload);
      if (!('confirmPayload' in confirm)) throw new Error('unexpected');
      abB.handleConfirm(confirm.confirmPayload);
    }

    /** Build agent-b's app wired to a controllable mock router (not null). */
    function appBWithRouter(router: unknown) {
      const app = express();
      app.use(express.json());
      app.use(createThreadlineRoutes(abB, router as never, {
        localAgent: 'agent-b',
        version: '1.0',
        stateDir: abDirB,
      }));
      return app;
    }

    /** Sign a receive request exactly as the threadlineAuth middleware verifies:
     *  Ed25519 over (METHOD\nPATH\nNONCE\nTIMESTAMP\n + sha256(JSON.stringify(body))). */
    function signedReceiveHeaders(body: unknown) {
      const nonce = crypto.randomBytes(16).toString('hex');
      const timestamp = new Date().toISOString();
      const bodyHash = crypto.createHash('sha256').update(JSON.stringify(body)).digest();
      const signedData = Buffer.concat([
        Buffer.from(`POST\n/threadline/messages/receive\n${nonce}\n${timestamp}\n`, 'utf-8'),
        bodyHash,
      ]);
      const signature = sign(aPriv, signedData).toString('hex');
      return {
        Authorization: `Threadline-Relay ${abA.getRelayToken('agent-b')!}`,
        'X-Threadline-Agent': 'agent-a',
        'X-Threadline-Nonce': nonce,
        'X-Threadline-Timestamp': timestamp,
        'X-Threadline-Signature': signature,
      };
    }

    it('responds {accepted, async} BEFORE the slow spawn finishes, then runs it in the background', async () => {
      completeHandshake();

      // A handler we hold open: started=true on entry, finished=true only once
      // we release it — so we can prove the response returned WITHOUT awaiting.
      let started = false;
      let finished = false;
      let release: () => void = () => {};
      const held = new Promise<void>((r) => { release = r; });
      const router = {
        handleInboundMessage: async () => {
          started = true;
          await held;
          finished = true;
          // Deliberately a DIFFERENT threadId than the body's, to prove the
          // accept response sources threadId from the envelope (not the router
          // result it no longer awaits).
          return { handled: true, threadId: 'router-thread' };
        },
      };

      const body = { message: { threadId: 't-1', from: { agent: 'agent-a' }, body: 'hi' } };
      const res = await request(appBWithRouter(router))
        .post('/threadline/messages/receive')
        .set(signedReceiveHeaders(body))
        .send(body);

      // Accepted immediately, async flagged, no spawn-outcome fields.
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ accepted: true, async: true, threadId: 't-1' });
      expect(res.body.spawned).toBeUndefined();
      expect(res.body.resumed).toBeUndefined();
      // The handler STARTED but the response did NOT await it (still pending).
      expect(started).toBe(true);
      expect(finished).toBe(false);

      // Background work completes after we release it.
      release();
      await new Promise((r) => setImmediate(r));
      expect(finished).toBe(true);
    });

    it('still returns 200 accepted even when the background spawn rejects', async () => {
      await completeHandshake();
      const router = {
        handleInboundMessage: async () => { throw new Error('spawn boom'); },
      };
      const body = { message: { threadId: 't-2', from: { agent: 'agent-a' }, body: 'yo' } };
      const res = await request(appBWithRouter(router))
        .post('/threadline/messages/receive')
        .set(signedReceiveHeaders(body))
        .send(body);

      // A background rejection can't break a response that already returned.
      expect(res.status).toBe(200);
      expect(res.body.accepted).toBe(true);
      await new Promise((r) => setImmediate(r));
    });
  });

  // Robustness Phase 2 (D-C): the placeholder GET /threadline/messages/thread/:id
  // that unconditionally returned `{ messages: [], messageCount: 0 }` (a second F3
  // hard-zero source) is DELETED. Canonical history is read via the bearer-gated
  // GET /threadline/threads/:id on the agent server; the participant-authorized
  // convergence backfill replaces this relay-auth surface.
  describe('POST /threadline/threads/backfill (convergence backfill)', () => {
    it('requires authentication', async () => {
      const res = await request(appA).post('/threadline/threads/backfill').send({ threadId: 'test-thread', missingDigests: [] });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('TL_AUTH_MISSING');
    });
  });

  describe('GET /threadline/blobs/:id', () => {
    it('requires authentication', async () => {
      const res = await request(appA).get('/threadline/blobs/test-blob');

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('TL_AUTH_MISSING');
    });
  });

  describe('Error response format', () => {
    it('follows the TL_ error code format', async () => {
      const res = await request(appA)
        .post('/threadline/handshake/hello')
        .send({});

      expect(res.body).toHaveProperty('error');
      expect(res.body.error).toHaveProperty('code');
      expect(res.body.error).toHaveProperty('message');
      expect(res.body.error).toHaveProperty('retryable');
      expect(res.body.error.code).toMatch(/^TL_/);
    });
  });
});

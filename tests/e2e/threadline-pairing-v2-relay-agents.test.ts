/**
 * E2E — verified pairing v2 between RELAY-ONLY agents (spec §3.2 / FD4 v2, amended 2026-10-10).
 *
 * Why this test exists: v1 recorded a pending pairing only from a handshake that no live
 * path ever ran between relay agents, and the old "feature is alive" test hand-recorded
 * the pending state, so it passed while no real pairing could start (issue #2117 gap G).
 * Here each agent STARTS the pairing through the real route, from nothing but the two
 * identity keys its relay client knows. Nothing is hand-seeded.
 *
 * What it proves (the two checks Echo named for review, plus the gates around them):
 *   1. two relay-only agents each POST /start and reach pending-verification with the
 *      SAME 12 words (shown only to a PIN-authed operator);
 *   2. a substituted key on one side gives DIFFERENT words;
 *   3. a credential to a verified peer is allowed only while the encryption key in use is
 *      the one derived from the pinned identity key (the REAL ThreadlineClient check);
 *   4. a denied match stays verification-failed: starting again is refused until an
 *      operator clears it with the dashboard PIN.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { AgentTrustManager } from '../../src/threadline/AgentTrustManager.js';
import { generateIdentityKeyPair } from '../../src/threadline/ThreadlineCrypto.js';
import { computeFingerprint, deriveX25519PublicKey } from '../../src/threadline/client/MessageEncryptor.js';
import { ThreadlineClient } from '../../src/threadline/client/ThreadlineClient.js';
import { evaluateOutboundCredentialShare } from '../../src/threadline/CredentialShareGate.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const AUTH = 'test-e2e-pairing-v2';
const PIN = '246810';

interface Agent {
  name: string;
  idPub: Buffer;
  idPriv: Buffer;
  fp: string;
  x25519: Buffer;
}

function makeAgent(name: string): Agent {
  const kp = generateIdentityKeyPair();
  return {
    name,
    idPub: kp.publicKey,
    idPriv: kp.privateKey,
    fp: computeFingerprint(kp.publicKey),
    x25519: deriveX25519PublicKey(kp.privateKey),
  };
}

/**
 * A relay client with only what pairing needs: our identity's PUBLIC key and the
 * known-agent cache the relay would have filled. `isChannelBoundToPairing` is the REAL
 * ThreadlineClient method, run against this cache.
 */
function relayClientFor(self: Agent, known: Array<{ agent: Agent; x25519?: Buffer; as?: Agent }>) {
  const knownAgents = new Map(
    known.map(({ agent, x25519, as }) => {
      const shown = as ?? agent; // `as`: the relay presents THIS agent's fingerprint+name for a different key
      return [shown.fp, { agentId: shown.fp, name: shown.name, publicKey: agent.idPub, x25519PublicKey: x25519 ?? agent.x25519 }];
    }),
  );
  const fake = {
    publicKey: self.idPub,
    fingerprint: self.fp,
    knownAgents,
    identity: { publicKey: self.idPub },
    getKnownAgents: () => [...knownAgents.values()],
    hasEncryptedSendPath: (fp: string) => Boolean(knownAgents.get(fp)?.x25519PublicKey),
  } as Record<string, unknown>;
  fake.isChannelBoundToPairing = ThreadlineClient.prototype.isChannelBoundToPairing.bind(fake as never);
  return fake as never;
}

function mockSessionManager() {
  return { listRunningSessions: () => [], getCachedRunningSessions: () => ({ count: 0, sessions: [] }), getSession: () => null };
}

async function startServer(label: string, relayClient: unknown) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `pairing-v2-${label}-`));
  const stateDir = path.join(tmpDir, '.instar');
  for (const d of ['state/sessions', 'threadline', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: label, agentName: label }));
  const config = {
    projectName: label,
    projectDir: tmpDir,
    stateDir,
    port: 0,
    authToken: AUTH,
    dashboardPin: PIN,
    requestTimeoutMs: 10000,
    version: '0.0.0',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
    messaging: [],
    monitoring: {},
    updates: {},
    threadline: { verifiedPairing: { enabled: true, dryRun: false, credentialShareEnforced: true } },
  } as InstarConfig;
  const trustManager = new AgentTrustManager({ stateDir });
  const server = new AgentServer({
    config,
    sessionManager: mockSessionManager() as never,
    state: new StateManager(stateDir),
    unifiedTrust: { trustManager } as never,
    threadlineRelayClient: relayClient,
  } as never);
  await server.start();
  return { server, app: server.getApp(), trustManager, tmpDir };
}

const authed = (r: request.Test) => r.set('Authorization', `Bearer ${AUTH}`);

describe('Verified pairing v2 — two relay-only agents (FD4 v2)', () => {
  const dawn = makeAgent('dawn');
  const scout = makeAgent('scout');
  const mallory = makeAgent('mallory');
  let A: Awaited<ReturnType<typeof startServer>>; // dawn's server
  let B: Awaited<ReturnType<typeof startServer>>; // scout's server
  let dawnRelay: never;

  beforeAll(async () => {
    dawnRelay = relayClientFor(dawn, [{ agent: scout }]);
    A = await startServer('dawn', dawnRelay);
    B = await startServer('scout', relayClientFor(scout, [{ agent: dawn }]));
  });

  afterAll(async () => {
    await A?.server.stop();
    await B?.server.stop();
    for (const s of [A, B]) if (s) SafeFsExecutor.safeRmSync(s.tmpDir, { recursive: true, force: true, operation: 'tests/e2e/threadline-pairing-v2-relay-agents.test.ts:cleanup' });
  });

  it('both agents start the pairing on their own and reach pending with the SAME 12 words', async () => {
    const a = await authed(request(A.app).post(`/threadline/pairing/${scout.fp}/start`)).send({});
    const b = await authed(request(B.app).post(`/threadline/pairing/${dawn.fp}/start`)).send({});
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.outcome).toBe('started');
    expect(b.body.outcome).toBe('started');
    expect(a.body.pairingId).toBe(b.body.pairingId);
    expect(a.body.sasFingerprint).toBe(b.body.sasFingerprint);

    // Words only with the PIN.
    const noPin = await authed(request(A.app).get(`/threadline/pairing/${scout.fp}`)).send({});
    expect(noPin.body.pairing.state).toBe('pending-verification');
    expect(noPin.body.pairing.sasWords).toBeUndefined();
    const wa = await authed(request(A.app).get(`/threadline/pairing/${scout.fp}`)).send({ pin: PIN });
    const wb = await authed(request(B.app).get(`/threadline/pairing/${dawn.fp}`)).send({ pin: PIN });
    expect(wa.body.pairing.sasWords).toHaveLength(12);
    expect(wa.body.pairing.sasWords).toEqual(wb.body.pairing.sasWords);

    // Starting again is idempotent.
    const again = await authed(request(A.app).post(`/threadline/pairing/${scout.fp}/start`)).send({});
    expect(again.body.outcome).toBe('already-pending');
  });

  it('a substituted key on one side gives DIFFERENT words', async () => {
    // The relay shows Scout's server a key it controls (Mallory) under Dawn's NAME. The
    // fingerprint follows the key, so Scout pairs with Mallory's fingerprint; Dawn pairs
    // with the real Scout. The humans compare and see different words.
    const C = await startServer('scout-mitm', relayClientFor(scout, [{ agent: mallory, as: { ...mallory, name: 'dawn' } }]));
    try {
      const c = await authed(request(C.app).post(`/threadline/pairing/${mallory.fp}/start`)).send({});
      expect(c.body.outcome).toBe('started');
      const wc = await authed(request(C.app).get(`/threadline/pairing/${mallory.fp}`)).send({ pin: PIN });
      const wa = await authed(request(A.app).get(`/threadline/pairing/${scout.fp}`)).send({ pin: PIN });
      expect(wc.body.pairing.sasWords).toHaveLength(12);
      expect(wc.body.pairing.sasWords).not.toEqual(wa.body.pairing.sasWords);
    } finally {
      await C.server.stop();
      SafeFsExecutor.safeRmSync(C.tmpDir, { recursive: true, force: true, operation: 'tests/e2e/threadline-pairing-v2-relay-agents.test.ts:cleanup-mitm' });
    }
  });

  it('a cached key that does not match the fingerprint is refused', async () => {
    // The relay presents Mallory's key under Scout's fingerprint.
    const D = await startServer('dawn-bad-cache', relayClientFor(dawn, [{ agent: mallory, as: scout }]));
    try {
      const r = await authed(request(D.app).post(`/threadline/pairing/${scout.fp}/start`)).send({});
      expect(r.status).toBe(409);
    } finally {
      await D.server.stop();
      SafeFsExecutor.safeRmSync(D.tmpDir, { recursive: true, force: true, operation: 'tests/e2e/threadline-pairing-v2-relay-agents.test.ts:cleanup-bad' });
    }
  });

  it('after the operator confirms, a credential is allowed only over an encryption key bound to the pinned identity key', async () => {
    const v = await authed(request(A.app).post(`/threadline/pairing/${scout.fp}/verify`)).send({ match: true, pin: PIN });
    expect(v.status).toBe(200);
    const after = await authed(request(A.app).get(`/threadline/pairing/${scout.fp}`)).send({});
    expect(after.body.pairing.state).toBe('mutual-verified');

    // Real binding check against the honest cache → allowed.
    expect(evaluateOutboundCredentialShare(A.trustManager, dawnRelay as never, scout.fp)).toEqual({ allow: true });

    // Same verified peer, but the relay has handed over a DIFFERENT encryption key
    // (Mallory's) next to Scout's real identity key → refused.
    const swapped = relayClientFor(dawn, [{ agent: scout, x25519: mallory.x25519 }]);
    expect(evaluateOutboundCredentialShare(A.trustManager, swapped, scout.fp)).toEqual({
      allow: false,
      reason: 'encryption-key-not-bound',
    });

    // Our own identity key rotated since verification → the pairing no longer matches → refused.
    const rotatedSelf = { ...makeAgent('dawn') };
    const rotated = relayClientFor(rotatedSelf, [{ agent: scout }]);
    expect(evaluateOutboundCredentialShare(A.trustManager, rotated, scout.fp).allow).toBe(false);
  });

  it('a denied match stays failed; only an operator with the PIN can clear it', async () => {
    const deny = await authed(request(B.app).post(`/threadline/pairing/${dawn.fp}/verify`)).send({ match: false, pin: PIN });
    expect(deny.status).toBe(200);
    expect(deny.body.state).toBe('verification-failed');

    const restart = await authed(request(B.app).post(`/threadline/pairing/${dawn.fp}/start`)).send({});
    expect(restart.status).toBe(409);
    const stillFailed = await authed(request(B.app).get(`/threadline/pairing/${dawn.fp}`)).send({});
    expect(stillFailed.body.pairing.state).toBe('verification-failed');

    const badPin = await authed(request(B.app).post(`/threadline/pairing/${dawn.fp}/start`)).send({ clearFailed: true, pin: '000000' });
    expect(badPin.status).toBeGreaterThanOrEqual(400);

    const cleared = await authed(request(B.app).post(`/threadline/pairing/${dawn.fp}/start`)).send({ clearFailed: true, pin: PIN });
    expect(cleared.status).toBe(200);
    expect(cleared.body.outcome).toBe('started');
  });
});

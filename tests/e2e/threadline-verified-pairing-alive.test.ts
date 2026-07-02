// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-3 E2E "feature is alive" lifecycle test for Secure A2A Verified Pairing
 * (docs/specs/secure-a2a-verified-pairing.md §6 — the single most important test).
 *
 * Boots the REAL AgentServer on the production boot path (mirroring
 * tests/e2e/threadline-negotiator-alive.test.ts: a real AgentServer + StateManager,
 * with the production-shaped dependency — here the real AgentTrustManager injected
 * via `unifiedTrust`, exactly as server.ts does). Then it drives the FULL feature
 * end-to-end to prove it is wired, not unit-green-only:
 *
 *   1. Production init → `threadline.verifiedPairing.enabled = true` (explicit, so the
 *      dev-gate honors it regardless of developmentAgent).
 *   2. The pairing routes are ALIVE (200, never 503) — list/detail.
 *   3. Two in-process agents derive the SAME SAS from a shared secret (the handshake
 *      output), recorded as a pending-verification pairing on the real trust manager.
 *   4. The operator-PIN verify route flips the pairing to `mutual-verified`
 *      (markMutualVerified — the SOLE writer; the agent Bearer token alone cannot).
 *   5. A credential-share to the verified peer is ALLOWED (encrypted path).
 *   6. A credential-share to a NON-verified peer is REFUSED (fail-closed, FD9).
 *   7. A credential to a verified peer over the PLAINTEXT-only path is REFUSED
 *      (a credential must traverse the encrypted+signed path, §3.5).
 *
 * If this file is hit by a better-sqlite3 NODE_MODULE_VERSION ABI mismatch in the
 * worktree, that is an environment artifact (the worktree symlinks instar-main's
 * node_modules); it builds fresh and passes in CI. This test deliberately avoids any
 * sqlite-backed store so it stays clean of that artifact.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { AgentTrustManager } from '../../src/threadline/AgentTrustManager.js';
import {
  assertCanShareCredential,
  evaluateOutboundCredentialShare,
} from '../../src/threadline/CredentialShareGate.js';
import {
  generateIdentityKeyPair,
  deriveSAS,
  deriveSasBits,
  deriveSasFingerprint,
} from '../../src/threadline/ThreadlineCrypto.js';
import { computeFingerprint } from '../../src/threadline/client/MessageEncryptor.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function createMockSessionManager() {
  return {
    listRunningSessions: () => [],
    getCachedRunningSessions: () => ({ count: 0, sessions: [] }),
    getSession: () => null,
  };
}

interface Peer {
  idPub: Buffer;
  idPriv: Buffer;
  fp: string;
}
function makePeer(): Peer {
  const kp = generateIdentityKeyPair();
  return { idPub: kp.publicKey, idPriv: kp.privateKey, fp: computeFingerprint(kp.publicKey) };
}

// Encrypted-path probe stub (the §3.5 "this peer has an encrypted+signed channel" oracle).
const encryptedPath = (known: boolean) => ({ hasEncryptedSendPath: () => known });

const AUTH = 'test-e2e-verified-pairing';
const DASHBOARD_PIN = '654321';

describe('Secure A2A Verified Pairing E2E lifecycle (feature is alive)', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: express.Express;
  let trustManager: AgentTrustManager;

  // The local agent and the peer it pairs with (Dawn).
  const self = makePeer();
  const peer = makePeer();
  // A second, NON-verified peer (the fail-closed control).
  const stranger = makePeer();

  // Shared-secret-derived SAS for the self↔peer handshake (computed inline at
  // handshake completion per FD4 — never persisted).
  const sharedSecret = crypto.randomBytes(32);
  const sasWords = deriveSAS(sharedSecret, self.idPub, peer.idPub);
  const sasFingerprint = deriveSasFingerprint(deriveSasBits(sharedSecret, self.idPub, peer.idPub));
  const pairingId = crypto.randomBytes(16).toString('hex');

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verified-pairing-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'threadline'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'config.json'),
      JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }),
    );

    const config: InstarConfig = {
      projectName: 'e2e',
      projectDir: tmpDir,
      stateDir,
      port: 0,
      authToken: AUTH,
      dashboardPin: DASHBOARD_PIN,
      requestTimeoutMs: 10000,
      version: '0.0.0',
      sessions: {
        claudePath: '/usr/bin/echo',
        maxSessions: 3,
        defaultMaxDurationMinutes: 30,
        protectedSessions: [],
        monitorIntervalMs: 5000,
      },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [],
      monitoring: {},
      updates: {},
      // The feature flag is set EXPLICITLY true so the dev-gate honors it
      // regardless of developmentAgent (the route uses resolveDevAgentGate).
      threadline: { verifiedPairing: { enabled: true, dryRun: false, credentialShareEnforced: true } },
    } as InstarConfig;

    // Mirror production: a REAL AgentTrustManager wired via `unifiedTrust`.
    trustManager = new AgentTrustManager({ stateDir });
    server = new AgentServer({
      config,
      sessionManager: createMockSessionManager() as never,
      state: new StateManager(stateDir),
      unifiedTrust: { trustManager } as never,
    } as never);
    await server.start();
    app = server.getApp();

    // ── Step 3: the two in-process agents complete a handshake. Both ends derive
    // the SAME SAS from the same shared secret (deterministic, FD2). Record the
    // pending pairing on the REAL trust manager (the post-handshake state).
    const peerSas = deriveSAS(sharedSecret, peer.idPub, self.idPub);
    // SAS is order-independent (salt = sort(idPubA‖idPubB)) — both sides agree.
    expect(peerSas).toEqual(sasWords);
    trustManager.recordPendingVerification(peer.fp, {
      pairingId,
      peerIdentityPub: peer.idPub.toString('hex'),
      sasWords,
      sasFingerprint,
      ownFp: self.fp,
      displayName: 'dawn',
    });
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, {
      recursive: true,
      force: true,
      operation: 'tests/e2e/threadline-verified-pairing-alive.test.ts',
    });
  });

  it('GET /threadline/pairing is ALIVE (200, not 503/404) when enabled', async () => {
    const res = await request(app).get('/threadline/pairing').set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.pairings)).toBe(true);
    const p = res.body.pairings.find((x: { peerFp: string }) => x.peerFp === peer.fp);
    expect(p).toBeDefined();
    expect(p.state).toBe('pending-verification');
    // SAS words NEVER appear on the list route. Assert on the FIELD and on the
    // joined 6-word phrase — never a lone word: SAS words come from a 2048-word
    // common-English list, and a single word can legitimately collide with other
    // response content (observed 2026-07-02: sasWords[0] === 'setup' false-
    // positived against trustSource 'setup-default').
    expect(p.sasWords).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(sasWords.join(' '));
    expect(JSON.stringify(res.body)).not.toContain(JSON.stringify(sasWords).slice(1, -1));
  });

  it('GET /threadline/pairing/:peerFp WITH a valid PIN surfaces the SAS while pending (§3.9)', async () => {
    const res = await request(app)
      .get(`/threadline/pairing/${peer.fp}`)
      .set('Authorization', `Bearer ${AUTH}`)
      .send({ pin: DASHBOARD_PIN });
    expect(res.status).toBe(200);
    expect(res.body.pairing.sasWords).toEqual(sasWords);
  });

  it('credential-share to the pending (not-yet-verified) peer is REFUSED — fail-closed', () => {
    const d = evaluateOutboundCredentialShare(trustManager, encryptedPath(true), peer.fp);
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('peer-not-mutually-verified');
  });

  it('the operator-PIN verify route flips the pairing to mutual-verified (markMutualVerified, FD7)', async () => {
    const res = await request(app)
      .post(`/threadline/pairing/${peer.fp}/verify`)
      .set('Authorization', `Bearer ${AUTH}`)
      .send({ match: true, pin: DASHBOARD_PIN });
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('mutual-verified');
    // The REAL trust manager state mutated through the SOLE writer.
    const profile = trustManager.getProfileByFingerprint(peer.fp);
    expect(profile?.pairingState).toBe('mutual-verified');
    expect(profile?.source).toBe('mutual-verified');
  });

  it('credential-share to the VERIFIED peer is now ALLOWED (encrypted path)', () => {
    const d = evaluateOutboundCredentialShare(trustManager, encryptedPath(true), peer.fp);
    expect(d.allow).toBe(true);
    expect(d.reason).toBeUndefined();
    // assertCanShareCredential (the agent-facing READ) agrees.
    expect(assertCanShareCredential(trustManager, peer.fp).allow).toBe(true);
  });

  it('credential-share to the verified peer over the PLAINTEXT-only path is REFUSED (§3.5)', () => {
    const d = evaluateOutboundCredentialShare(trustManager, encryptedPath(false), peer.fp);
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('credential-requires-encrypted-path');
  });

  it('credential-share to a NON-verified stranger is REFUSED (fail-closed, FD9)', () => {
    const d = evaluateOutboundCredentialShare(trustManager, encryptedPath(true), stranger.fp);
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('peer-not-mutually-verified');
  });

  it('the routes 503 when the feature flag is OFF (byte-identical legacy behavior)', async () => {
    // A fresh server with the flag explicitly OFF — proves the dark posture.
    const offDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verified-pairing-off-'));
    const offState = path.join(offDir, '.instar');
    fs.mkdirSync(path.join(offState, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(offState, 'threadline'), { recursive: true });
    fs.mkdirSync(path.join(offState, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(offState, 'config.json'), JSON.stringify({ port: 0 }));
    const offTm = new AgentTrustManager({ stateDir: offState });
    const offServer = new AgentServer({
      config: {
        projectName: 'e2e-off', projectDir: offDir, stateDir: offState, port: 0, authToken: AUTH,
        requestTimeoutMs: 10000, version: '0.0.0',
        sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
        scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
        messaging: [], monitoring: {}, updates: {},
        // Explicit false — NOT developmentAgent, so the dev-gate resolves OFF.
        threadline: { verifiedPairing: { enabled: false } },
      } as InstarConfig,
      sessionManager: createMockSessionManager() as never,
      state: new StateManager(offState),
      unifiedTrust: { trustManager: offTm } as never,
    } as never);
    await offServer.start();
    const offApp = offServer.getApp();
    try {
      const res = await request(offApp).get('/threadline/pairing').set('Authorization', `Bearer ${AUTH}`);
      expect(res.status).toBe(503);
    } finally {
      await offServer.stop();
      SafeFsExecutor.safeRmSync(offDir, { recursive: true, force: true, operation: 'tests/e2e/threadline-verified-pairing-alive.test.ts:off' });
    }
  });
});

/**
 * Tier-2 integration tests for the Secure A2A Verified Pairing surfaces (§3.6)
 * over the full HTTP pipeline:
 *   GET  /threadline/pairing
 *   GET  /threadline/pairing/:peerFp
 *   POST /threadline/pairing/:peerFp/verify   (PIN-gated, FD7)
 *
 * Verifies: 503 when the feature flag is off; list/detail when on; the verify
 * route REQUIRES the dashboard PIN (bearer-only is rejected); a valid PIN +
 * match:true flips to mutual-verified; match:false → verification-failed; the SAS
 * words are returned ONLY with a valid PIN while pending-verification (§3.9);
 * mutualVerifiedCount on /threadline/health reflects state.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { AgentTrustManager } from '../../src/threadline/AgentTrustManager.js';
import { createThreadlineRoutes } from '../../src/threadline/ThreadlineEndpoints.js';
import { HandshakeManager } from '../../src/threadline/HandshakeManager.js';

const PEER_FP = '8c7928aa9f04fbda947172a2f9b2d81a';
const OWN_FP = '1111111111111111111111111111aaaa';
const PAIRING_ID = 'cafef00dcafef00dcafef00dcafef00d';
const SAS_WORDS = ['abandon', 'ability', 'able', 'about', 'above', 'absent'];
const DASHBOARD_PIN = '123456';

let tmpDirs: string[] = [];

function mkStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairing-routes-'));
  tmpDirs.push(dir);
  return dir;
}

function appWith(opts: {
  enabled: boolean;
  trustManager: AgentTrustManager | null;
  dashboardPin?: string;
}): express.Express {
  const ctx = {
    config: {
      projectName: 'test',
      projectDir: '/tmp',
      stateDir: '/tmp',
      port: 0,
      sessions: {} as any,
      scheduler: {} as any,
      // enabled flag controls the dark gate; developmentAgent omitted so the
      // explicit flag wins (resolveDevAgentGate honors an explicit value).
      threadline: { verifiedPairing: { enabled: opts.enabled } },
      dashboardPin: opts.dashboardPin,
    } as any,
    sessionManager: {} as any,
    state: {} as any,
    unifiedTrust: opts.trustManager ? ({ trustManager: opts.trustManager } as any) : null,
    startTime: new Date(),
  } as unknown as RouteContext;
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctx));
  return app;
}

/** Seed a pending-verification pairing into a real (in-memory-backed) trust manager. */
function seedPending(tm: AgentTrustManager): void {
  tm.recordPendingVerification(PEER_FP, {
    pairingId: PAIRING_ID,
    peerIdentityPub: 'deadbeef'.repeat(8),
    sasWords: SAS_WORDS,
    sasFingerprint: 'a1b2c3d4e5f60718',
    ownFp: OWN_FP,
    displayName: 'dawn',
  });
}

describe('Secure A2A Verified Pairing routes (integration)', () => {
  afterEach(() => {
    for (const d of tmpDirs) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    tmpDirs = [];
  });

  describe('feature flag off', () => {
    let tm: AgentTrustManager;
    let app: express.Express;
    beforeEach(() => {
      tm = new AgentTrustManager({ stateDir: mkStateDir() });
      seedPending(tm);
      app = appWith({ enabled: false, trustManager: tm, dashboardPin: DASHBOARD_PIN });
    });

    it('503s the list route when the flag is off', async () => {
      const res = await request(app).get('/threadline/pairing');
      expect(res.status).toBe(503);
    });
    it('503s the detail route when the flag is off', async () => {
      const res = await request(app).get(`/threadline/pairing/${PEER_FP}`);
      expect(res.status).toBe(503);
    });
    it('503s the verify route when the flag is off', async () => {
      const res = await request(app)
        .post(`/threadline/pairing/${PEER_FP}/verify`)
        .send({ match: true, pin: DASHBOARD_PIN });
      expect(res.status).toBe(503);
    });
  });

  describe('feature flag on', () => {
    let tm: AgentTrustManager;
    let app: express.Express;
    beforeEach(() => {
      tm = new AgentTrustManager({ stateDir: mkStateDir() });
      seedPending(tm);
      app = appWith({ enabled: true, trustManager: tm, dashboardPin: DASHBOARD_PIN });
    });

    it('lists the pending pairing WITHOUT SAS words', async () => {
      const res = await request(app).get('/threadline/pairing');
      expect(res.status).toBe(200);
      expect(res.body.pairings).toHaveLength(1);
      const p = res.body.pairings[0];
      expect(p.peerFp).toBe(PEER_FP);
      expect(p.state).toBe('pending-verification');
      expect(p.peerName).toBe('dawn');
      // SAS words must never appear on the list route.
      expect(JSON.stringify(res.body)).not.toContain('abandon');
    });

    it('detail WITHOUT a PIN omits the SAS words', async () => {
      const res = await request(app).get(`/threadline/pairing/${PEER_FP}`);
      expect(res.status).toBe(200);
      expect(res.body.pairing.state).toBe('pending-verification');
      expect(res.body.pairing.sasFingerprint).toBe('a1b2c3d4e5f60718');
      expect(res.body.pairing.sasWords).toBeUndefined();
    });

    it('detail WITH a valid PIN while pending includes the SAS words (§3.9)', async () => {
      const res = await request(app)
        .get(`/threadline/pairing/${PEER_FP}`)
        .send({ pin: DASHBOARD_PIN });
      expect(res.status).toBe(200);
      expect(res.body.pairing.sasWords).toEqual(SAS_WORDS);
    });

    it('detail with an INCORRECT PIN still omits the SAS words', async () => {
      const res = await request(app)
        .get(`/threadline/pairing/${PEER_FP}`)
        .send({ pin: '000000' });
      expect(res.status).toBe(200);
      expect(res.body.pairing.sasWords).toBeUndefined();
    });

    it('detail 404s for an unknown fingerprint', async () => {
      const res = await request(app).get('/threadline/pairing/deadbeefdeadbeefdeadbeefdeadbeef');
      expect(res.status).toBe(404);
    });

    it('verify WITHOUT a PIN is rejected (FD7 — bearer is insufficient)', async () => {
      const res = await request(app)
        .post(`/threadline/pairing/${PEER_FP}/verify`)
        .send({ match: true });
      expect(res.status).toBe(403);
      // The pairing must NOT have flipped.
      expect(tm.getProfileByFingerprint(PEER_FP)?.pairingState).toBe('pending-verification');
    });

    it('verify with an INCORRECT PIN is rejected and does not flip', async () => {
      const res = await request(app)
        .post(`/threadline/pairing/${PEER_FP}/verify`)
        .send({ match: true, pin: '000000' });
      expect(res.status).toBe(403);
      expect(tm.getProfileByFingerprint(PEER_FP)?.pairingState).toBe('pending-verification');
    });

    it('verify with a valid PIN + match:true flips to mutual-verified', async () => {
      const res = await request(app)
        .post(`/threadline/pairing/${PEER_FP}/verify`)
        .send({ match: true, pin: DASHBOARD_PIN });
      expect(res.status).toBe(200);
      expect(res.body.state).toBe('mutual-verified');
      const profile = tm.getProfileByFingerprint(PEER_FP);
      expect(profile?.pairingState).toBe('mutual-verified');
      expect(profile?.source).toBe('mutual-verified');
      // credential-share is now allowed for this peer.
      expect(tm.isCredentialShareAllowedByFingerprint(PEER_FP)).toBe(true);
    });

    it('verify with a valid PIN + match:false marks verification-failed', async () => {
      const res = await request(app)
        .post(`/threadline/pairing/${PEER_FP}/verify`)
        .send({ match: false, pin: DASHBOARD_PIN });
      expect(res.status).toBe(200);
      expect(res.body.state).toBe('verification-failed');
      const profile = tm.getProfileByFingerprint(PEER_FP);
      expect(profile?.pairingState).toBe('verification-failed');
      expect(profile?.level).toBe('untrusted');
      expect(tm.isCredentialShareAllowedByFingerprint(PEER_FP)).toBe(false);
    });

    it('verify with a non-boolean match is a 400', async () => {
      const res = await request(app)
        .post(`/threadline/pairing/${PEER_FP}/verify`)
        .send({ pin: DASHBOARD_PIN });
      expect(res.status).toBe(400);
    });
  });

  describe('mutualVerifiedCount on /threadline/health', () => {
    it('reflects the count of mutual-verified pairings', async () => {
      const tm = new AgentTrustManager({ stateDir: mkStateDir() });
      seedPending(tm);
      // health route lives in the threadline relay router, only mounted when a
      // handshakeManager is present; verify the count callback math directly via
      // the verify-then-list path instead (the route field is wired in routes.ts).
      // Before verification: 0 mutual-verified.
      expect(tm.listProfiles().filter((p) => p.pairingState === 'mutual-verified').length).toBe(0);
      // After a PIN-authed confirm via the route, the count is 1.
      const app = appWith({ enabled: true, trustManager: tm, dashboardPin: DASHBOARD_PIN });
      await request(app)
        .post(`/threadline/pairing/${PEER_FP}/verify`)
        .send({ match: true, pin: DASHBOARD_PIN });
      expect(tm.listProfiles().filter((p) => p.pairingState === 'mutual-verified').length).toBe(1);
    });

    it('surfaces mutualVerifiedCount on the real /threadline/health route', async () => {
      const stateDir = mkStateDir();
      const tm = new AgentTrustManager({ stateDir });
      seedPending(tm);
      const countFn = () =>
        tm.listProfiles().filter((p) => p.pairingState === 'mutual-verified').length;
      const app = express();
      app.use(express.json());
      app.use(
        createThreadlineRoutes(new HandshakeManager(stateDir, 'agent'), null, {
          localAgent: 'agent',
          version: '1.0',
          stateDir,
          mutualVerifiedCount: countFn,
        }),
      );

      // Pending only → 0.
      let res = await request(app).get('/threadline/health');
      expect(res.status).toBe(200);
      expect(res.body.mutualVerifiedCount).toBe(0);

      // Confirm via the SOLE writer, then health reports 1.
      tm.markMutualVerified(PEER_FP, { pairingId: PAIRING_ID, operatorConfirm: true });
      res = await request(app).get('/threadline/health');
      expect(res.body.mutualVerifiedCount).toBe(1);
    });

    it('omits mutualVerifiedCount when no count callback is wired (legacy shape)', async () => {
      const stateDir = mkStateDir();
      const app = express();
      app.use(express.json());
      app.use(
        createThreadlineRoutes(new HandshakeManager(stateDir, 'agent'), null, {
          localAgent: 'agent',
          version: '1.0',
          stateDir,
        }),
      );
      const res = await request(app).get('/threadline/health');
      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty('mutualVerifiedCount');
    });
  });
});

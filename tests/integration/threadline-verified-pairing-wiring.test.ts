/**
 * Tier-2 WIRING-INTEGRITY tests for Secure A2A Verified Pairing (spec §6).
 *
 * The Testing Integrity Standard requires that every dependency-injected piece be
 * REAL — not null, not a no-op, and actually delegating to the real implementation.
 * These tests pin exactly that for the verified-pairing surfaces:
 *
 *  1. The credential gate's `AgentTrustManager` dep is the REAL instance (not a
 *     no-op): a real verified pairing flips the gate's decision; a no-op-shaped dep
 *     fails closed — proving the gate reads live trust state, not a constant.
 *  2. The verify route actually MUTATES the store via markMutualVerified (not a
 *     stubbed 200): the real trust profile transitions pending → mutual-verified.
 *  3. markMutualVerified is the SOLE writer of source 'mutual-verified' — the
 *     generic setter REJECTS it (so a route that "set the source directly" could
 *     never have worked; the route MUST go through the dedicated writer).
 *  4. The flip requires a REAL PIN-authed operator confirm — a bearer-only request
 *     (no PIN) is refused and the store is NOT mutated (anti-confabulation, FD7).
 *  5. The relay-send funnel actually INVOKES the credential gate — a credential to
 *     an unverified resolvable target is refused with reason 'peer-not-mutually-
 *     verified' at the funnel, not silently sent.
 *  6. The pair-verify path actually VERIFIES signatures — a bad signature is a no-op
 *     on pairing state (the receipt cannot self-assert peerAcked).
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { AgentTrustManager } from '../../src/threadline/AgentTrustManager.js';
import {
  assertCanShareCredential,
  evaluateOutboundCredentialShare,
} from '../../src/threadline/CredentialShareGate.js';
import {
  processPairVerifyReceipt,
  receiptMessageBytes,
  PAIR_VERIFY_OP,
} from '../../src/threadline/PairVerifyReceipt.js';
import {
  generateIdentityKeyPair,
  sign,
  deriveSAS,
  deriveSasBits,
  deriveSasFingerprint,
} from '../../src/threadline/ThreadlineCrypto.js';
import { computeFingerprint } from '../../src/threadline/client/MessageEncryptor.js';

const DASHBOARD_PIN = '777111';

let tmpDirs: string[] = [];
function mkStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-wiring-'));
  fs.mkdirSync(path.join(dir, 'threadline'), { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

interface Peer { idPub: Buffer; idPriv: Buffer; fp: string; }
function makePeer(): Peer {
  const kp = generateIdentityKeyPair();
  return { idPub: kp.publicKey, idPriv: kp.privateKey, fp: computeFingerprint(kp.publicKey) };
}
const encryptedPath = (known: boolean) => ({ hasEncryptedSendPath: () => known });

/** Record a pending pairing on a real trust manager and (optionally) verify it. */
function seedPairing(tm: AgentTrustManager, self: Peer, peer: Peer, verify: boolean): { pairingId: string; sasWords: string[]; sasFingerprint: string } {
  const sharedSecret = crypto.randomBytes(32);
  const sasWords = deriveSAS(sharedSecret, self.idPub, peer.idPub);
  const sasFingerprint = deriveSasFingerprint(deriveSasBits(sharedSecret, self.idPub, peer.idPub));
  const pairingId = crypto.randomBytes(16).toString('hex');
  tm.recordPendingVerification(peer.fp, {
    pairingId, peerIdentityPub: peer.idPub.toString('hex'), sasWords, sasFingerprint, ownFp: self.fp,
  });
  if (verify) tm.markMutualVerified(peer.fp, { pairingId, operatorConfirm: true, ownFp: self.fp });
  return { pairingId, sasWords, sasFingerprint };
}

function appWith(opts: { enabled: boolean; trustManager: AgentTrustManager; stateDir: string; dashboardPin?: string; knownAgents?: unknown }): express.Express {
  const ctx = {
    config: {
      projectName: 'test', projectDir: opts.stateDir, stateDir: opts.stateDir, port: 0,
      sessions: {} as never, scheduler: {} as never,
      threadline: { verifiedPairing: { enabled: opts.enabled } },
      dashboardPin: opts.dashboardPin,
    },
    sessionManager: {} as never,
    state: {} as never,
    unifiedTrust: { trustManager: opts.trustManager },
    threadlineReplyWaiters: new Map(),
    startTime: new Date(),
  } as unknown as RouteContext;
  if (opts.knownAgents) {
    fs.writeFileSync(path.join(opts.stateDir, 'threadline', 'known-agents.json'), JSON.stringify(opts.knownAgents));
  }
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctx));
  return app;
}

describe('Verified Pairing — wiring integrity (deps are real, not null/no-op)', () => {
  afterEach(() => {
    for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
    tmpDirs = [];
  });

  it('1. the credential gate reads LIVE trust state from the real AgentTrustManager (not a constant)', () => {
    const tm = new AgentTrustManager({ stateDir: mkStateDir() });
    const self = makePeer(); const peer = makePeer();
    // Unverified → refused.
    seedPairing(tm, self, peer, false);
    expect(evaluateOutboundCredentialShare(tm, encryptedPath(true), peer.fp).allow).toBe(false);
    // Verify it → the SAME gate, same dep, now ALLOWS — proving it delegates to live state.
    tm.markMutualVerified(peer.fp, { pairingId: tm.getProfileByFingerprint(peer.fp)!.pairingId!, operatorConfirm: true, ownFp: self.fp });
    expect(evaluateOutboundCredentialShare(tm, encryptedPath(true), peer.fp).allow).toBe(true);
    expect(assertCanShareCredential(tm, peer.fp).allow).toBe(true);
  });

  it('1b. a no-op-shaped trust dep fails CLOSED (proving a no-op would NOT silently allow)', () => {
    const noop = { isCredentialShareAllowedByFingerprint: () => false };
    const peer = makePeer();
    expect(evaluateOutboundCredentialShare(noop, encryptedPath(true), peer.fp).allow).toBe(false);
  });

  it('2 + 4. the verify route MUTATES via markMutualVerified ONLY with a real PIN-authed confirm', async () => {
    const stateDir = mkStateDir();
    const tm = new AgentTrustManager({ stateDir });
    const self = makePeer(); const peer = makePeer();
    seedPairing(tm, self, peer, false);
    const app = appWith({ enabled: true, trustManager: tm, stateDir, dashboardPin: DASHBOARD_PIN });

    // No PIN (bearer-only) → refused AND no mutation (anti-confabulation, FD7).
    const noPin = await request(app).post(`/threadline/pairing/${peer.fp}/verify`).send({ match: true });
    expect(noPin.status).toBe(403);
    expect(tm.getProfileByFingerprint(peer.fp)?.pairingState).toBe('pending-verification');
    expect(tm.getProfileByFingerprint(peer.fp)?.source).not.toBe('mutual-verified');

    // Valid PIN → real mutation through the SOLE writer.
    const withPin = await request(app).post(`/threadline/pairing/${peer.fp}/verify`).send({ match: true, pin: DASHBOARD_PIN });
    expect(withPin.status).toBe(200);
    const profile = tm.getProfileByFingerprint(peer.fp);
    expect(profile?.pairingState).toBe('mutual-verified');
    expect(profile?.source).toBe('mutual-verified');
  });

  it('3. markMutualVerified is the SOLE writer — the generic setter REJECTS source mutual-verified', () => {
    const tm = new AgentTrustManager({ stateDir: mkStateDir() });
    const self = makePeer(); const peer = makePeer();
    const { pairingId } = seedPairing(tm, self, peer, false);
    // The generic path cannot grant the credential-gating source.
    const generic = tm.setTrustLevelByFingerprint(peer.fp, 'trusted', 'mutual-verified' as never, 'attempted-self-grant');
    expect(generic).toBe(false);
    expect(tm.getProfileByFingerprint(peer.fp)?.source).not.toBe('mutual-verified');
    // The dedicated writer (operator-confirm precondition) is the ONLY path that works.
    expect(tm.markMutualVerified(peer.fp, { pairingId, operatorConfirm: true, ownFp: self.fp })).toBe(true);
    expect(tm.getProfileByFingerprint(peer.fp)?.source).toBe('mutual-verified');
  });

  it('5. the relay-send funnel INVOKES the credential gate — credential to an unverified target is REFUSED', async () => {
    const stateDir = mkStateDir();
    const tm = new AgentTrustManager({ stateDir });
    const self = makePeer(); const peer = makePeer();
    seedPairing(tm, self, peer, false); // pending, NOT verified
    // A co-located resolvable target (has a port + fingerprint) so the funnel reaches
    // the local-delivery credential chokepoint BEFORE any network call.
    const app = appWith({
      enabled: true, trustManager: tm, stateDir, dashboardPin: DASHBOARD_PIN,
      knownAgents: { agents: [{ name: 'dawn', port: 4099, fingerprint: peer.fp }] },
    });
    const res = await request(app)
      .post('/threadline/relay-send')
      .send({ targetAgent: 'dawn', message: 'here is the API key', kind: 'credential-share' });
    expect(res.status).toBe(403);
    expect(res.body.refused).toBe(true);
    expect(res.body.reason).toBe('peer-not-mutually-verified');
  });

  it('5b. a NON-credential send is NOT gated by the funnel (the gate is credential-keyed only)', async () => {
    const stateDir = mkStateDir();
    const tm = new AgentTrustManager({ stateDir });
    const self = makePeer(); const peer = makePeer();
    seedPairing(tm, self, peer, false);
    const app = appWith({
      enabled: true, trustManager: tm, stateDir, dashboardPin: DASHBOARD_PIN,
      knownAgents: { agents: [{ name: 'dawn', port: 4099, fingerprint: peer.fp }] },
    });
    // No kind:'credential-share' → the credential chokepoint is a no-op; the send
    // proceeds past it (it will fail later on the unreachable port, NOT with the
    // credential refusal — proving the gate did not engage).
    const res = await request(app)
      .post('/threadline/relay-send')
      .send({ targetAgent: 'dawn', message: 'just saying hi' });
    expect(res.body.reason).not.toBe('peer-not-mutually-verified');
  });

  it('6. the pair-verify path actually VERIFIES signatures — a bad signature is a no-op on state', () => {
    const tm = new AgentTrustManager({ stateDir: mkStateDir() });
    const self = makePeer(); const peer = makePeer();
    const { pairingId, sasFingerprint } = seedPairing(tm, self, peer, false);
    // A receipt with a TAMPERED signature must be rejected (no peerAcked set).
    const msg = receiptMessageBytes(pairingId, peer.fp, self.fp, sasFingerprint);
    const badSig = sign(makePeer().idPriv, msg); // signed by the WRONG key
    const payload = {
      type: PAIR_VERIFY_OP, pairingId, ownFp: peer.fp, peerFp: self.fp,
      sasFingerprint, signature: badSig.toString('hex'),
    };
    // senderFp = the PEER (the receipt's author); ownFp = us (self).
    const outcome = processPairVerifyReceipt(tm, peer.fp, payload, self.fp);
    expect(outcome.processed).toBe(false);
    expect(tm.getProfileByFingerprint(peer.fp)?.peerAcked).toBeUndefined();
    // A correctly-signed receipt is processed (sets peerAcked) — proving the verify is real.
    const goodSig = sign(peer.idPriv, msg);
    const good = processPairVerifyReceipt(tm, peer.fp, { ...payload, signature: goodSig.toString('hex') }, self.fp);
    expect(good.processed).toBe(true);
    expect(tm.getProfileByFingerprint(peer.fp)?.peerAcked).toBe(true);
    // ...but the receipt ALONE never flips to mutual-verified (FD8 — operator confirm is the bar).
    expect(tm.getProfileByFingerprint(peer.fp)?.source).not.toBe('mutual-verified');
  });
});

/**
 * fb-1e30d109-e50 — Tier-2 integration over the REAL pair route (createMachineRoutes, real
 * MachineIdentityManager, real PairingSessionStore, real IdentityManager mint guard) and the
 * REAL joiner-side installer.
 *
 * The incident: a new agent with the Threadline relay off had no agent identity, so its first
 * pairing handed nothing over; the joiner said the inviter was "on an older version" (both were
 * on the same release); and once the joiner was registered the inviter refused to create one.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import request from 'supertest';
import {
  MachineIdentityManager, generateSigningKeyPair, generateEncryptionKeyPair,
  generateMachineId, pemToBase64,
} from '../../src/core/MachineIdentity.js';
import { HeartbeatManager } from '../../src/core/HeartbeatManager.js';
import { NonceStore } from '../../src/core/NonceStore.js';
import { SecurityLog } from '../../src/core/SecurityLog.js';
import { createMachineRoutes } from '../../src/server/machineRoutes.js';
import { PairingSessionStore } from '../../src/core/PairingSessionStore.js';
import { createPairingSession } from '../../src/core/PairingProtocol.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { installAgentIdentityFromPairing, readAgentIdentityForHandover } from '../../src/core/AgentIdentityHandover.js';
import { describeMissingAgentIdentity } from '../../src/core/firstPairAgentIdentity.js';
import type { MachineIdentity } from '../../src/core/types.js';
import type { MachineAuthDeps } from '../../src/server/machineAuth.js';

function makeIdentity(name: string): { id: MachineIdentity; encPrivatePem: string } {
  const enc = generateEncryptionKeyPair();
  return {
    id: {
      machineId: generateMachineId(),
      signingPublicKey: pemToBase64(generateSigningKeyPair().publicKey),
      encryptionPublicKey: pemToBase64(enc.publicKey),
      name, platform: 'test', createdAt: new Date().toISOString(), capabilities: ['sessions'],
    },
    encPrivatePem: enc.privateKey,
  };
}

function makeInviter(dir: string, opts: { extraMachine?: boolean } = {}) {
  const identityManager = new MachineIdentityManager(dir);
  const awake = makeIdentity('studio').id;
  fs.mkdirSync(path.join(dir, 'machine'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'machine', 'identity.json'), JSON.stringify(awake));
  identityManager.registerMachine(awake, 'awake');
  if (opts.extraMachine) identityManager.registerMachine(makeIdentity('old-peer').id, 'standby');
  const securityLog = new SecurityLog(dir);
  securityLog.initialize();
  const authDeps: MachineAuthDeps = { identityManager, nonceStore: new NonceStore(path.join(dir, 'nonces')), securityLog, localMachineId: awake.machineId };
  const app = express();
  app.use(express.json());
  app.use(createMachineRoutes({
    identityManager, heartbeatManager: new HeartbeatManager(dir, awake.machineId), securityLog, authDeps,
    localMachineId: awake.machineId, localSigningKeyPem: '', stateDir: dir, agentName: 'xmproof',
  }));
  return { app, pairingStore: new PairingSessionStore(dir) };
}

describe('pairing a fresh agent with no agent identity (fb-1e30d109-e50)', () => {
  let dir: string;
  let joinerDir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-fresh-'));
    joinerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-fresh-joiner-'));
  });
  afterEach(() => {
    for (const d of [dir, joinerDir]) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/pair-fresh-agent-identity.test.ts' });
  });

  it('the inviter creates the identity at its first pairing and the joiner installs the same one', async () => {
    const { app, pairingStore } = makeInviter(dir);
    expect(readAgentIdentityForHandover(dir)).toBeNull(); // relay off: never minted
    pairingStore.save(createPairingSession({ code: 'FRESH-AGENT-0001', expiryMs: 600000 }));
    const joiner = makeIdentity('m5');

    const res = await request(app).post('/api/pair').send({ pairingCode: 'FRESH-AGENT-0001', machineIdentity: joiner.id, ephemeralPublicKey: joiner.id.encryptionPublicKey });
    expect(res.status).toBe(200);
    expect(res.body.agentIdentityEnvelope).toBeTruthy();
    expect(res.body.agentIdentityAbsent).toBeUndefined();
    expect(res.body.agentName).toBe('xmproof');

    const inviterId = readAgentIdentityForHandover(dir);
    expect(inviterId).not.toBeNull();
    const out = installAgentIdentityFromPairing({
      envelope: res.body.agentIdentityEnvelope,
      stateDir: joinerDir,
      expected: { pairingSessionId: 'FRESH-AGENT-0001', joinerMachineId: joiner.id.machineId, joinerEncryptionPublicKey: joiner.id.encryptionPublicKey, agentName: res.body.agentName, expiresAt: '' },
      encryptionPrivateKeyPem: joiner.encPrivatePem,
      pinnedFingerprint: null,
    });
    expect(out.ok).toBe(true);
    expect(readAgentIdentityForHandover(joinerDir)?.fingerprint).toBe(inviterId!.fingerprint);
  });

  it('a second pairing reuses the identity (the registered joiner no longer blocks the handover)', async () => {
    const { app, pairingStore } = makeInviter(dir);
    pairingStore.save(createPairingSession({ code: 'FRESH-AGENT-0002', expiryMs: 600000 }));
    const a = makeIdentity('m5');
    await request(app).post('/api/pair').send({ pairingCode: 'FRESH-AGENT-0002', machineIdentity: a.id, ephemeralPublicKey: a.id.encryptionPublicKey });
    const first = readAgentIdentityForHandover(dir)!.fingerprint;
    pairingStore.save(createPairingSession({ code: 'FRESH-AGENT-0003', expiryMs: 600000 }));
    const b = makeIdentity('mini');
    const res = await request(app).post('/api/pair').send({ pairingCode: 'FRESH-AGENT-0003', machineIdentity: b.id, ephemeralPublicKey: b.id.encryptionPublicKey });
    expect(res.body.agentIdentityEnvelope).toBeTruthy();
    expect(readAgentIdentityForHandover(dir)!.fingerprint).toBe(first);
  });

  it('an inviter that already lists another machine refuses to mint — and the joiner is told why, not "older version"', async () => {
    const { app, pairingStore } = makeInviter(dir, { extraMachine: true });
    pairingStore.save(createPairingSession({ code: 'FRESH-AGENT-0004', expiryMs: 600000 }));
    const joiner = makeIdentity('m5');
    const res = await request(app).post('/api/pair').send({ pairingCode: 'FRESH-AGENT-0004', machineIdentity: joiner.id, ephemeralPublicKey: joiner.id.encryptionPublicKey });
    expect(res.status).toBe(200); // the MACHINE pairing still completes
    expect(res.body.agentIdentityEnvelope).toBeUndefined();
    expect(res.body.agentIdentityAbsent).toMatchObject({ reason: 'inviter-mint-refused' });
    expect(readAgentIdentityForHandover(dir)).toBeNull(); // never minted over a mesh
    const said = describeMissingAgentIdentity(res.body.agentIdentityAbsent);
    expect(said).not.toMatch(/older version/);
    expect(said).toMatch(/already lists another machine/);
  });
});

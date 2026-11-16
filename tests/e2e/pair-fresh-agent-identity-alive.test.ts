/**
 * fb-1e30d109-e50 — E2E, production order. A fresh agent (relay off, no agent identity) pairs
 * with a joiner whose folder is NOT named after the agent:
 *   inviter POST /api/pair (real routes) → joiner adopts the agent name into its real config
 *   file → loadConfig (the real derivation) → installAgentIdentityFromPairing bound to
 *   config.projectName, exactly as `instar join` does.
 * Before: no envelope ("older version"), and a folder-named joiner refused the handover
 * (transcript-agent-mismatch). Plus the wiring order in the real source.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { MachineIdentityManager, generateSigningKeyPair, generateEncryptionKeyPair, generateMachineId, pemToBase64 } from '../../src/core/MachineIdentity.js';
import { HeartbeatManager } from '../../src/core/HeartbeatManager.js';
import { NonceStore } from '../../src/core/NonceStore.js';
import { SecurityLog } from '../../src/core/SecurityLog.js';
import { createMachineRoutes } from '../../src/server/machineRoutes.js';
import { PairingSessionStore } from '../../src/core/PairingSessionStore.js';
import { createPairingSession } from '../../src/core/PairingProtocol.js';
import { installAgentIdentityFromPairing, readAgentIdentityForHandover } from '../../src/core/AgentIdentityHandover.js';
import { joinerAgentNameToAdopt } from '../../src/core/firstPairAgentIdentity.js';
import { loadConfig } from '../../src/core/Config.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/pair-fresh-agent-identity-alive.test.ts' }); });

describe('first pairing of a fresh agent (E2E, production order)', () => {
  it('hands over the identity and a differently-named joiner folder installs it', async () => {
    const inviterDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfa-inviter-'));
    const joinerHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pfa-joiner-'));
    dirs.push(inviterDir, joinerHome);

    // Inviter: a fresh agent's state dir — machine identity + registry naming only itself.
    const identityManager = new MachineIdentityManager(inviterDir);
    const awake = { machineId: generateMachineId(), signingPublicKey: pemToBase64(generateSigningKeyPair().publicKey), encryptionPublicKey: pemToBase64(generateEncryptionKeyPair().publicKey), name: 'studio', platform: 'test', createdAt: new Date().toISOString(), capabilities: ['sessions'] };
    fs.mkdirSync(path.join(inviterDir, 'machine'), { recursive: true });
    fs.writeFileSync(path.join(inviterDir, 'machine', 'identity.json'), JSON.stringify(awake));
    identityManager.registerMachine(awake as never, 'awake');
    const securityLog = new SecurityLog(inviterDir);
    securityLog.initialize();
    const app = express();
    app.use(express.json());
    app.use(createMachineRoutes({
      identityManager, heartbeatManager: new HeartbeatManager(inviterDir, awake.machineId), securityLog,
      authDeps: { identityManager, nonceStore: new NonceStore(path.join(inviterDir, 'nonces')), securityLog, localMachineId: awake.machineId },
      localMachineId: awake.machineId, localSigningKeyPem: '', stateDir: inviterDir, agentName: 'xmproof',
    }));
    new PairingSessionStore(inviterDir).save(createPairingSession({ code: 'XM-PROOF-1115', expiryMs: 600000 }));

    // Joiner: a project folder named "robust-xm" (not the agent's name), with a config that names no agent.
    const projectDir = path.join(joinerHome, 'robust-xm');
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    const configFilePath = path.join(projectDir, '.instar', 'config.json');
    fs.writeFileSync(configFilePath, JSON.stringify({ port: 4999 }, null, 2));
    expect(loadConfig(projectDir).projectName).toBe('robust-xm');
    const enc = generateEncryptionKeyPair();
    const joinerId = { machineId: generateMachineId(), signingPublicKey: pemToBase64(generateSigningKeyPair().publicKey), encryptionPublicKey: pemToBase64(enc.publicKey), name: 'm5', platform: 'test', createdAt: new Date().toISOString(), capabilities: ['sessions'] };

    const res = await request(app).post('/api/pair').send({ pairingCode: 'XM-PROOF-1115', machineIdentity: joinerId, ephemeralPublicKey: joinerId.encryptionPublicKey });
    expect(res.status).toBe(200);
    expect(res.body.agentIdentityEnvelope).toBeTruthy();

    // The join flow: bind the inviter's name, install, and only then write it to config.
    const joinedConfig = JSON.parse(fs.readFileSync(configFilePath, 'utf8'));
    const adopt = joinerAgentNameToAdopt(joinedConfig, res.body.agentName);
    expect(adopt).toBe('xmproof');
    const before = loadConfig(projectDir);
    const out = installAgentIdentityFromPairing({
      envelope: res.body.agentIdentityEnvelope,
      stateDir: before.stateDir,
      expected: { pairingSessionId: 'XM-PROOF-1115', joinerMachineId: joinerId.machineId, joinerEncryptionPublicKey: joinerId.encryptionPublicKey, agentName: adopt ?? before.projectName, expiresAt: '' },
      encryptionPrivateKeyPem: enc.privateKey,
      pinnedFingerprint: null,
    });
    expect(out.ok).toBe(true);
    // Bound to the folder name instead, the same envelope is refused (the incident).
    const wrong = installAgentIdentityFromPairing({
      envelope: res.body.agentIdentityEnvelope,
      stateDir: fs.mkdtempSync(path.join(joinerHome, 'x-')),
      expected: { pairingSessionId: 'XM-PROOF-1115', joinerMachineId: joinerId.machineId, joinerEncryptionPublicKey: joinerId.encryptionPublicKey, agentName: 'robust-xm', expiresAt: '' },
      encryptionPrivateKeyPem: enc.privateKey,
      pinnedFingerprint: null,
    });
    expect(wrong).toMatchObject({ ok: false, reason: 'transcript-agent-mismatch' });
    joinedConfig.projectName = adopt;
    fs.writeFileSync(configFilePath, JSON.stringify(joinedConfig, null, 2));
    const config = loadConfig(projectDir);
    expect(config.projectName).toBe('xmproof');
    expect(readAgentIdentityForHandover(config.stateDir)?.fingerprint).toBe(readAgentIdentityForHandover(inviterDir)?.fingerprint);
  });
});

describe('wiring (real source order)', () => {
  const routes = fs.readFileSync(path.join(process.cwd(), 'src/server/machineRoutes.ts'), 'utf-8');
  const join = fs.readFileSync(path.join(process.cwd(), 'src/commands/machine.ts'), 'utf-8');
  it('the inviter ensures the identity inside handlePair, before the joiner is stored', () => {
    const handler = routes.indexOf('const handlePair = async');
    const ensure = routes.indexOf('ensureAgentIdentityForPairing(ctx.stateDir)');
    expect(ensure).toBeGreaterThan(handler);
    expect(ensure).toBeLessThan(routes.indexOf('storeRemoteIdentity(acceptedMachineIdentity'));
  });
  it('the response carries the reason when there is no envelope, and the agent name', () => {
    expect(routes).toContain('agentIdentityAbsent ? { agentIdentityAbsent } : {}');
    expect(routes).toMatch(/ctx\.agentName \? \{ agentName: ctx\.agentName \}/);
  });
  it('the joiner binds the name before installing, writes it only after, and prints the real reason', () => {
    expect(join.indexOf('joinerAgentNameToAdopt(')).toBeLessThan(join.indexOf('installAgentIdentityFromPairing({'));
    expect(join).toContain('agentName: adoptedAgentName ?? config.projectName');
    expect(join.indexOf('joinedConfig.projectName = adoptedAgentName')).toBeGreaterThan(join.indexOf('installAgentIdentityFromPairing({'));
    expect(join).toContain('if (agentIdentityOutcome.ok && adoptedAgentName)');
    expect(join).toContain('describeMissingAgentIdentity(result.agentIdentityAbsent)');
  });
});

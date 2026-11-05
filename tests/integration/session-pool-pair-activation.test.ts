/**
 * The real /api/pair route and the joiner's real half, on two homes that start from the
 * shipped defaults (docs/specs/session-pool-activation-at-pairing.md).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import request from 'supertest';
import {
  MachineIdentityManager, generateEncryptionKeyPair, generateMachineId, generateSigningKeyPair, pemToBase64,
} from '../../src/core/MachineIdentity.js';
import { HeartbeatManager } from '../../src/core/HeartbeatManager.js';
import { NonceStore } from '../../src/core/NonceStore.js';
import { SecurityLog } from '../../src/core/SecurityLog.js';
import { createMachineRoutes } from '../../src/server/machineRoutes.js';
import { PairingSessionStore } from '../../src/core/PairingSessionStore.js';
import { createPairingSession } from '../../src/core/PairingProtocol.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SecretStore } from '../../src/core/SecretStore.js';
import { applyDefaults, getMigrationDefaults } from '../../src/config/ConfigDefaults.js';
import { applyJoinerPairActivation, readPairDecision } from '../../src/core/sessionPoolPairActivation.js';
import type { MachineIdentity } from '../../src/core/types.js';

const BOT_TOKEN = '123456:real-looking-bot-token';

function makeIdentity(name: string) {
  const enc = generateEncryptionKeyPair();
  const identity: MachineIdentity = {
    machineId: generateMachineId(),
    signingPublicKey: pemToBase64(generateSigningKeyPair().publicKey),
    encryptionPublicKey: pemToBase64(enc.publicKey),
    name, platform: 'test', createdAt: new Date().toISOString(), capabilities: ['sessions'],
  };
  return { identity, encryptionPrivateKeyPem: enc.privateKey };
}

function writeShippedConfig(dir: string, extra: (c: any) => void = () => {}) {
  const config: Record<string, unknown> = { projectName: 'test-agent' };
  applyDefaults(config, getMigrationDefaults('claude-code' as never));
  extra(config);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2));
}

const readConfig = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8'));
const restartFlag = (dir: string) => path.join(dir, 'state', 'restart-requested.json');

function makeInviter(dir: string, telegram: ({ botToken: string; chatId: string; authorizedUserIds?: number[]; ownerUserId?: number }) | null) {
  const identityManager = new MachineIdentityManager(dir);
  const { identity: awake } = makeIdentity('first-machine');
  fs.mkdirSync(path.join(dir, 'machine'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'machine', 'identity.json'), JSON.stringify(awake));
  identityManager.registerMachine(awake, 'awake');
  const securityLog = new SecurityLog(dir);
  securityLog.initialize();
  const routes = createMachineRoutes({
    identityManager,
    heartbeatManager: new HeartbeatManager(dir, awake.machineId),
    securityLog,
    authDeps: { identityManager, nonceStore: new NonceStore(path.join(dir, 'nonces')), securityLog, localMachineId: awake.machineId },
    localMachineId: awake.machineId,
    localSigningKeyPem: '',
    stateDir: dir,
    getTelegramHandoverSource: () => telegram,
  });
  const app = express();
  app.use(express.json());
  app.use(routes);
  const pair = (code: string, joiner: MachineIdentity) => {
    new PairingSessionStore(dir).save(createPairingSession({ code, expiryMs: 600_000 }));
    return request(app).post('/api/pair').send({ pairingCode: code, machineIdentity: joiner, ephemeralPublicKey: joiner.encryptionPublicKey });
  };
  return { pair };
}

describe('sharing turns on at the first pairing', () => {
  let root: string; let inviterDir: string; let joinerDir: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-activation-'));
    inviterDir = path.join(root, 'inviter'); joinerDir = path.join(root, 'joiner');
    fs.mkdirSync(inviterDir); fs.mkdirSync(joinerDir);
  });
  afterEach(() => SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/integration/session-pool-pair-activation.test.ts:cleanup' }));

  const joinerApply = (body: any, code: string, identity: MachineIdentity, pem: string | null) => applyJoinerPairActivation({
    configPath: path.join(joinerDir, 'config.json'),
    stateDir: joinerDir,
    response: body,
    binding: { pairingSessionId: code, joinerMachineId: identity.machineId },
    encryptionPrivateKeyPem: pem,
    now: new Date(),
  });

  it('both machines end with sharing on, the joiner holds the token, and it is not in its config', async () => {
    writeShippedConfig(inviterDir);
    writeShippedConfig(joinerDir);
    const { pair } = makeInviter(inviterDir, { botToken: BOT_TOKEN, chatId: '-100123' });
    const { identity, encryptionPrivateKeyPem } = makeIdentity('second-machine');

    const res = await pair('CODE-ONE', identity);
    expect(res.status).toBe(200);
    expect(res.body.sessionPoolActivation).toEqual({ version: 1 });
    expect(JSON.stringify(res.body)).not.toContain(BOT_TOKEN);

    const inviter = readConfig(inviterDir).multiMachine;
    expect(inviter.sessionPool).toMatchObject({ enabled: true, promotionCeiling: 'shadow', promotionModel: 'auto-climb' });
    expect(fs.existsSync(restartFlag(inviterDir))).toBe(true);
    expect(JSON.parse(fs.readFileSync(restartFlag(inviterDir), 'utf-8')).requestedBy).toBe('session-pool-activation');

    expect(joinerApply(res.body, 'CODE-ONE', identity, encryptionPrivateKeyPem)).toMatchObject({ activated: true, telegram: 'written' });
    const joinerRaw = fs.readFileSync(path.join(joinerDir, 'config.json'), 'utf-8');
    expect(joinerRaw).not.toContain(BOT_TOKEN);
    const joiner = JSON.parse(joinerRaw);
    expect(joiner.multiMachine.sessionPool).toMatchObject({ enabled: true, promotionCeiling: 'shadow' });
    expect(joiner.multiMachine.sessionPool.stage).toBeUndefined();
    expect(joiner.messaging.find((m: any) => m.type === 'telegram').config.token).toEqual({ secret: true });
    expect((new SecretStore({ stateDir: joinerDir }).read() as any).messaging.find(Boolean).config.token).toBe(BOT_TOKEN);
  });

  it('a failed token leaves the pair recoverable: pairing the same machine again resends it', async () => {
    writeShippedConfig(inviterDir);
    writeShippedConfig(joinerDir);
    const { pair } = makeInviter(inviterDir, { botToken: BOT_TOKEN, chatId: '-100123' });
    const { identity, encryptionPrivateKeyPem } = makeIdentity('second-machine');

    const first = await pair('CODE-ONE', identity);
    expect(joinerApply(first.body, 'CODE-ONE', identity, null).telegram).toBe('no-key');
    expect(readConfig(joinerDir).messaging ?? []).toEqual([]);

    // The owner turned sharing off on the joiner in between; pairing again must not undo that.
    const joinerConfig = readConfig(joinerDir);
    joinerConfig.multiMachine.sessionPool.enabled = false;
    fs.writeFileSync(path.join(joinerDir, 'config.json'), JSON.stringify(joinerConfig));

    SafeFsExecutor.safeRmSync(restartFlag(inviterDir), { force: true, operation: 'tests/integration/session-pool-pair-activation.test.ts:clear-restart-flag' });
    const again = await pair('CODE-TWO', identity);
    expect(again.body.telegramHandover).toBeDefined();
    expect(fs.existsSync(restartFlag(inviterDir))).toBe(false); // nothing new on the inviter
    expect(joinerApply(again.body, 'CODE-TWO', identity, encryptionPrivateKeyPem).telegram).toBe('written');
    expect(readConfig(joinerDir).multiMachine.sessionPool.enabled).toBe(false);
  });

  it('the joined machine answers only the people the first machine answers', async () => {
    writeShippedConfig(inviterDir);
    writeShippedConfig(joinerDir);
    const { pair } = makeInviter(inviterDir, { botToken: BOT_TOKEN, chatId: '-100123', authorizedUserIds: [111, 222], ownerUserId: 111 });
    const { identity, encryptionPrivateKeyPem } = makeIdentity('second-machine');
    const res = await pair('CODE-ONE', identity);
    expect(joinerApply(res.body, 'CODE-ONE', identity, encryptionPrivateKeyPem).telegram).toBe('written');
    const entry = readConfig(joinerDir).messaging.find((m: { type: string }) => m.type === 'telegram');
    expect(entry.config.authorizedUserIds).toEqual([111, 222]);
    expect(entry.config.ownerUserId).toBe(111);
  });

  it('pairing again gives a machine its missing list and leaves one it already has', async () => {
    writeShippedConfig(inviterDir);
    writeShippedConfig(joinerDir);
    const { pair } = makeInviter(inviterDir, { botToken: BOT_TOKEN, chatId: '-100123', authorizedUserIds: [111], ownerUserId: 111 });
    const { identity, encryptionPrivateKeyPem } = makeIdentity('second-machine');
    const withEntry = (config: Record<string, unknown>) => {
      const joinerConfig = readConfig(joinerDir);
      joinerConfig.messaging = [{ type: 'telegram', enabled: true, config: { token: 'kept', chatId: '-100123', ...config } }];
      fs.writeFileSync(path.join(joinerDir, 'config.json'), JSON.stringify(joinerConfig));
    };
    const entry = () => readConfig(joinerDir).messaging[0].config;

    withEntry({});
    const filled = joinerApply((await pair('CODE-ONE', identity)).body, 'CODE-ONE', identity, encryptionPrivateKeyPem);
    expect(filled).toMatchObject({ telegram: 'kept-existing', peopleFilled: true, peopleUnchecked: false });
    expect(entry()).toMatchObject({ token: 'kept', authorizedUserIds: [111], ownerUserId: 111 });

    withEntry({ authorizedUserIds: [999], ownerUserId: 999 });
    SafeFsExecutor.safeRmSync(restartFlag(inviterDir), { force: true, operation: 'tests/integration/session-pool-pair-activation.test.ts:clear-restart' });
    const kept = joinerApply((await pair('CODE-TWO', identity)).body, 'CODE-TWO', identity, encryptionPrivateKeyPem);
    expect(kept).toMatchObject({ telegram: 'kept-existing', peopleFilled: false, peopleUnchecked: false });
    expect(entry()).toMatchObject({ authorizedUserIds: [999], ownerUserId: 999 });

    withEntry({ authorizedUserIds: [999], promptGate: { ownerId: 999 } });
    SafeFsExecutor.safeRmSync(restartFlag(inviterDir), { force: true, operation: 'tests/integration/session-pool-pair-activation.test.ts:clear-restart' });
    const ownOwner = joinerApply((await pair('CODE-OWNER', identity)).body, 'CODE-OWNER', identity, encryptionPrivateKeyPem);
    expect(ownOwner.peopleFilled).toBe(false);
    expect(entry().ownerUserId).toBeUndefined();

    withEntry({});
    SafeFsExecutor.safeRmSync(restartFlag(inviterDir), { force: true, operation: 'tests/integration/session-pool-pair-activation.test.ts:clear-restart' });
    const unchecked = joinerApply((await pair('CODE-THREE', identity)).body, 'CODE-THREE', identity, null);
    expect(unchecked).toMatchObject({ telegram: 'kept-existing', peopleFilled: false, peopleUnchecked: true });
    expect(entry().authorizedUserIds).toBeUndefined();
  });

  it('a third machine pairs normally and activates nothing', async () => {
    writeShippedConfig(inviterDir);
    const { pair } = makeInviter(inviterDir, null);
    await pair('CODE-ONE', makeIdentity('second-machine').identity);
    SafeFsExecutor.safeRmSync(restartFlag(inviterDir), { force: true, operation: 'tests/integration/session-pool-pair-activation.test.ts:clear-restart-flag' });
    const res = await pair('CODE-TWO', makeIdentity('third-machine').identity);
    expect(res.status).toBe(200);
    expect(res.body.sessionPoolActivation).toBeUndefined();
    expect(res.body.telegramHandover).toBeUndefined();
    expect(fs.existsSync(restartFlag(inviterDir))).toBe(false);
  });

  it.each([
    ['an owner choice', (c: any) => { c.multiMachine.sessionPool.autoActivate = false; }, 'owner-choice'],
    ['an existing pool', (c: any) => { c.multiMachine.sessionPool.enabled = true; }, 'owner-choice'],
    ['the money layer', (c: any) => { c.routingSpend = { money: { enabled: true } }; }, 'money-layer-on'],
  ])('%s: the pairing works, sharing stays off, and it says why', async (_name, extra, reason) => {
    writeShippedConfig(inviterDir, extra);
    const before = readConfig(inviterDir);
    const { pair } = makeInviter(inviterDir, { botToken: BOT_TOKEN, chatId: '-100123' });
    const res = await pair('CODE-ONE', makeIdentity('second-machine').identity);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('paired');
    expect(res.body.sessionPoolActivation).toBeUndefined();
    expect(res.body.telegramHandover).toBeUndefined();
    expect(readConfig(inviterDir)).toEqual(before);
    expect(fs.existsSync(restartFlag(inviterDir))).toBe(false);
    expect(readPairDecision(inviterDir)).toMatchObject({ activate: false, reason });
  });

  it('an older inviter sends nothing and the joiner stays as it was', () => {
    writeShippedConfig(joinerDir);
    const before = readConfig(joinerDir);
    const { identity } = makeIdentity('second-machine');
    expect(joinerApply({}, 'CODE-ONE', identity, null)).toEqual({ activated: false, telegram: 'not-offered' });
    expect(readConfig(joinerDir)).toEqual(before);
  });
});

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { MeshRpcClient } from '../../src/core/MeshRpcClient.js';
import { MeshRpcDispatcher } from '../../src/core/MeshRpc.js';
import { createRoutes } from '../../src/server/routes.js';
import { TelegramOriginRuntime } from '../../src/messaging/telegram-origin/TelegramOriginRuntime.js';
import { handleOriginMesh, type OriginMeshCommand } from '../../src/messaging/telegram-origin/OriginMesh.js';
import { OriginProductionEnrollment } from '../../src/messaging/telegram-origin/OriginProductionEnrollment.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { originCertificationFixture } from '../helpers/originCertification.js';
import { compileOriginWorker, temporaryState } from '../helpers/telegramOriginStore.js';

let worker: URL;
beforeAll(async () => { worker = await compileOriginWorker(); });
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
describe('origin enrollment signed mesh HTTP observations', () => {
  it('accepts an authenticated compatible peer and refuses revoked, wrong-recipient and wrong-account observations', async () => {
    const f = await originCertificationFixture();
    cleanups.push(() => SafeFsExecutor.safeRm(f.root, { recursive: true, force: true, operation: 'test:origin-enrollment-http:cleanup' }));
    const keys = generateKeyPairSync('ed25519');
    const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const runtime = await TelegramOriginRuntime.open({ storage: { stateDir: temporaryState(), agentId: 'echo' }, workerUrl: worker,
      identity: { agentId: 'echo', agentName: 'Echo', originMachineId: 'peer', originMachineName: 'Peer' },
      signingKey: { privateKey, keyId: 'peer:1', keyEpoch: 1 }, bot: { accountId: '123', token: '123:fixture' },
      display: () => ({ agent: { enabled: false } }), authorize: () => true, diagnoseUnknown: async () => undefined,
      alertDestinations: () => [], getAlertPolicy: () => null, onNoticeState: () => undefined });
    cleanups.push(() => runtime.close());
    let revoked = false, recipient = 'peer';
    const nonces = new Set<string>();
    const dispatcher = new MeshRpcDispatcher({ verify: { selfMachineId: 'peer',
      verify: (bytes, signature, sender) => sender === 'source' && verify(null, Buffer.from(bytes), publicKey, Buffer.from(signature, 'base64url')),
      isRegisteredPeer: sender => !revoked && sender === 'source', seenNonce: (_, nonce) => nonces.has(nonce), now: Date.now },
      rbac: { routerHolder: () => 'peer', ownerOf: () => null, placementTargetOf: () => null }, recordNonce: (_, nonce) => { nonces.add(nonce); },
      handlers: { 'telegram-origin': (command, sender) => handleOriginMesh({ runtime, command: command as OriginMeshCommand,
        authenticatedSender: sender, resolveKey: machineId => !revoked && machineId === 'source'
          ? { machineId, agentId: 'echo', keyId: 'source:1', keyEpoch: 1, publicKey, validFrom: 0, validUntil: null, revokedAt: null } : null }) } });
    const app = express(); app.use(express.json()); app.use(createRoutes({ config: { authToken: 'fixture', stateDir: runtime.options.storage.stateDir, port: 0 }, telegramOrigin: runtime, meshRpcDispatcher: dispatcher } as never));
    const server = await new Promise<import('node:http').Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const client = new MeshRpcClient({ selfMachineId: 'source', nonce: randomUUID, sign: bytes => sign(null, Buffer.from(bytes), privateKey).toString('base64url') });
    const collect = (accountId = '123') => new OriginProductionEnrollment({ packageRoot: f.root, selfMachineId: 'source', accountId,
      activePeerIds: () => ['source', 'peer'], producerIds: () => ['telegram-server'], peerTransport: () =>
        (_machineId, command, timeoutMs) => client.send({ machineId: recipient, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }, command, 0, { timeoutMs }) }).inspect();
    expect((await collect()).at(-1)).toMatchObject({ obligation: 'peers', subject: 'peer', state: 'ready' });
    expect((await collect('456')).at(-1)?.state).toBe('unknown');
    recipient = 'other'; expect((await collect()).at(-1)?.state).toBe('unknown');
    recipient = 'peer'; revoked = true; expect((await collect()).at(-1)?.state).toBe('unknown');
  });
});

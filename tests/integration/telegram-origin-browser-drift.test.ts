import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { createRoutes } from '../../src/server/routes.js';
import { TelegramOriginRuntime } from '../../src/messaging/telegram-origin/TelegramOriginRuntime.js';
import type { OriginSessionLifecycle } from '../../src/messaging/telegram-origin/OriginSessionRegistry.js';
import { OriginBrowserExecutor } from '../../src/messaging/telegram-origin/OriginBrowserExecutor.js';
import type { BrowserRecoveryAction } from '../../src/messaging/telegram-origin/OriginBrowserRecovery.js';
import { generateIdentityKeyPair } from '../../src/threadline/ThreadlineCrypto.js';
import { signMessage } from '../../src/core/agentSignatureProvenance.js';
import { compileOriginWorker, temporaryState } from '../helpers/telegramOriginStore.js';

// A Telegram Web K update must never hold the typed browser route silently:
// the HTTP send and snapshot routes record the failed build durably and raise
// exactly one attention item per failed build (docs/specs/telegram-message-origin.md).
let worker: URL;
const runtimes: TelegramOriginRuntime[] = [];
const privateKey = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
beforeAll(async () => { worker = await compileOriginWorker(); });
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.close(); });

async function harness(buildId: () => string) {
  const stateDir = temporaryState();
  let lifecycle: OriginSessionLifecycle | undefined;
  const runtime = await TelegramOriginRuntime.open({ storage: { stateDir, agentId: 'echo' }, workerUrl: worker,
    identity: { agentId: 'echo', agentName: 'Echo', originMachineId: 'studio', originMachineName: 'Mac Studio' },
    signingKey: { privateKey, keyId: 'studio-1', keyEpoch: 1 }, bot: { token: `123:${randomUUID()}`, accountId: 'bot-1', chatId: '-100123' },
    isSessionLive: () => true, attachSessionLifecycle: l => { lifecycle = l; }, display: () => ({}),
    authorize: () => true, diagnoseUnknown: async () => undefined, alertDestinations: () => [],
    getAlertPolicy: () => null, onNoticeState: () => undefined });
  runtimes.push(runtime);
  const sessionToken = await lifecycle!.issue({ sessionId: 'source-session', harnessId: 'codex-cli', projectDir: process.cwd(), configuredModel: 'gpt-6-astra' });
  const asp = generateIdentityKeyPair();
  const attention = vi.fn(async (_input: { id: string; profileId: string; publicTransportAlternative: boolean }) => undefined);
  const invoke = vi.fn();
  const factory = vi.fn(async () => ({
    canary: async () => ({ transport: 'web-k' as const, accountId: '7812716706', buildId: buildId(), supported: buildId() === 'web-k-2.2-679' }),
    readSnapshot: async () => ({ text: 'page', accountId: '7812716706' }),
    resolvePeer: async () => ({ _: 'inputPeerChannel', channel_id: '123', access_hash: '456' }),
    invoke, close: async () => undefined }));
  // The same recovery wrapper the production boot installs (TelegramOriginBoot).
  const executor = new OriginBrowserExecutor({ service: runtime.service, store: () => runtime.store,
    accountId: '7812716706', transport: 'telegram-web', authorize: () => true,
    signBody: (body, topicId, timestamp) => signMessage({ agentId: 'echo', body, topicId, timestamp, privateKey: asp.privateKey }).text,
    driverFactory: factory, resolveAgentPublicKey: () => asp.publicKey, clockSkewMs: () => 0, isProfileExclusivelyOwned: () => true,
    recovery: async (action: BrowserRecoveryAction) => {
      const result = await runtime.store.browserRecovery({ profileId: 'operator', action });
      if (result.state.attentionId && !result.state.attentionAccepted) {
        await attention({ id: `operator:${result.state.attentionId}`, profileId: 'operator', publicTransportAlternative: result.state.failedBuilds.length >= 2 });
        await runtime.store.browserRecovery({ profileId: 'operator', action: { kind: 'attention-accepted', fence: result.state.fence } });
      }
      return result;
    } });
  runtime.browsers.set('operator', { executor, resolvePeer: destination => executor.broker.resolvePeer(destination) });
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { if (req.get('Authorization') !== 'Bearer agent-test') { res.sendStatus(401); return; } next(); });
  app.use(createRoutes({ config: { authToken: 'agent-test', stateDir, port: 0, projectName: 'echo',
    messaging: [{ type: 'telegram', enabled: true, config: { token: '123:x', chatId: '-100123', lifelineTopicId: 7848 } }] },
    telegramOrigin: runtime, sessionManager: { clearInjectionTracker: () => undefined } } as never));
  const send = () => request(app).post('/telegram/browser/operator/send').set('Authorization', 'Bearer agent-test')
    .set('X-Instar-Origin-Session', sessionToken).send({ text: 'hello', destination: { kind: 'channel', id: '123', topicId: 42 } });
  const snapshot = () => request(app).get('/telegram/browser/operator/snapshot').set('Authorization', 'Bearer agent-test')
    .set('X-Instar-Origin-Session', sessionToken);
  return { runtime, attention, invoke, factory, send, snapshot };
}

describe('Telegram browser route under Web K drift', () => {
  it('a send on an unreviewed build is held with failedBuilds recorded and one attention item', async () => {
    const h = await harness(() => 'unrecognized:new-build');
    const first = await h.send();
    expect(first.status).toBe(409);
    expect(first.body).toMatchObject({ error: 'telegram-browser-held' });
    expect(h.invoke).not.toHaveBeenCalled();
    expect(h.factory).toHaveBeenCalledTimes(2); // one bounded fresh-process recheck, no loop
    expect(h.attention).toHaveBeenCalledOnce();
    expect(h.attention.mock.calls[0][0].id).toMatch(/^operator:browser-canary:\d+:[0-9a-f]{16}$/);
    expect(await h.runtime.store.getBrowserRecoveryStates()).toEqual([expect.objectContaining({ profileId: 'operator',
      failedBuilds: ['unrecognized:new-build'], failures: 2, attentionPending: false })]);
    // Repeated requests during the 15-minute floor neither start a browser nor raise a second item.
    expect((await h.send()).status).toBe(409);
    expect((await h.snapshot()).status).toBe(409);
    expect(h.factory).toHaveBeenCalledTimes(2);
    expect(h.attention).toHaveBeenCalledOnce();
  });
  it('a supported build serves the snapshot and records recovery success', async () => {
    const h = await harness(() => 'web-k-2.2-679');
    const response = await h.snapshot();
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ text: 'page', accountId: '7812716706' });
    expect(h.attention).not.toHaveBeenCalled();
  });
});

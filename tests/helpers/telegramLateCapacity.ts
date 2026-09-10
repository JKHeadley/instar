import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { TelegramOriginRuntime } from '../../src/messaging/telegram-origin/TelegramOriginRuntime.js';
import type { OriginSessionLifecycle } from '../../src/messaging/telegram-origin/OriginSessionRegistry.js';
import { telegramFetch } from '../../src/messaging/telegram-egress.js';
import { fixtureOriginContentDedup } from './originContentDedup.js';
import { temporaryState } from './telegramOriginStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const privateKey = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

/** Real runtime, durable worker and owner authority; only the remote Bot API is
 * a fixture. Callers own runtime.close and restoring the fetch stub/spies. */
export async function lateCapacityHarness(workerUrl: URL) {
  const stateDir = temporaryState(), token = `123:${randomUUID()}`;
  let lifecycle: OriginSessionLifecycle | undefined;
  const runtime = await TelegramOriginRuntime.open({ storage: { stateDir, agentId: 'echo' }, workerUrl,
    identity: { agentId: 'echo', agentName: 'Echo', originMachineId: 'studio', originMachineName: 'Studio' },
    signingKey: { privateKey, keyId: 'studio-1', keyEpoch: 1 },
    bot: { token, accountId: '123', chatId: '-100123' },
    isSessionLive: () => true, attachSessionLifecycle: value => { lifecycle = value; },
    display: () => ({}), authorize: () => true, diagnoseUnknown: async () => undefined,
    alertDestinations: () => [], getAlertPolicy: () => null, onNoticeState: () => undefined });
  const sessionToken = await lifecycle!.issue({ sessionId: 'capacity-session', harnessId: 'codex-cli',
    projectDir: process.cwd(), configuredModel: 'fixture-model' });
  runtime.attachSendPolicy({ review: async () => ({ ok: true }), authorizeDispatch: () => ({ ok: true }),
    ...fixtureOriginContentDedup(stateDir) });
  const network = vi.fn(async (_url: string, init: RequestInit) => {
    init.signal?.throwIfAborted();
    const body = JSON.parse(init.body as string);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 91,
      chat: { id: -100123 }, message_thread_id: body.message_thread_id } }));
  });
  vi.stubGlobal('fetch', network);
  const send = () => runtime.service.runWithSessionToken(sessionToken,
    () => telegramFetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', body: JSON.stringify({ chat_id: '-100123', message_thread_id: 42,
        text: 'The requested capacity report.' }), networkTimeoutMs: 15_000 }));
  const close = async () => {
    await runtime.close();
    await SafeFsExecutor.safeRm(stateDir, { recursive: true, force: true, operation: 'test:late-capacity:cleanup' });
  };
  return { runtime, network, send, stateDir, token, sessionToken, close };
}

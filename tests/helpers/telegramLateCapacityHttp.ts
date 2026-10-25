import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { vi } from 'vitest';
import { bootTelegramOrigin } from '../../src/messaging/telegram-origin/TelegramOriginBoot.js';
import type { OriginSessionLifecycle } from '../../src/messaging/telegram-origin/OriginSessionRegistry.js';
import { originCapacityClient } from '../../src/messaging/telegram-origin/OriginNoticeIpc.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { createRoutes } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { waitForOriginDisplayReady } from './telegramOriginReady.js';

/** Production Boot + real adapter/reply HTTP route. IPC mode uses the actual
 * socket/client against Boot's owner; it does not claim a second process boot. */
export async function lateCapacityHttpHarness(workerUrl: URL, useIpc: boolean) {
  const root = await mkdtemp('/tmp/lcap-'), stateDir = path.join(root, '.instar');
  await mkdir(path.join(stateDir, 'state'), { recursive: true });
  const token = '123:late-capacity-fixture';
  const config = { projectDir: root, stateDir, projectName: 'echo', port: 0, authToken: 'agent-test',
    messaging: [{ type: 'telegram', enabled: true, config: { token, chatId: '-100123', lifelineTopicId: 7848 } }] };
  await writeFile(path.join(stateDir, 'config.json'), JSON.stringify(config));
  let boot: Awaited<ReturnType<typeof bootTelegramOrigin>>;
  let adapter: TelegramAdapter, app: express.Express, sessionToken: string;
  let ownsLease = true, generation = 0, messageId = 120;
  const nativeFetch = globalThis.fetch;
  const network = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    return new Response(JSON.stringify({ ok: true, result: { message_id: ++messageId,
      chat: { id: -100123 }, message_thread_id: body.message_thread_id } }));
  });
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => String(url).startsWith('https://api.telegram.org/')
    ? network(url, init) : nativeFetch(url, init));
  const start = async () => {
    let lifecycle: OriginSessionLifecycle | undefined;
    boot = await bootTelegramOrigin({ config: config as never, token, noticeOwner: true,
      workerUrl, holdsLease: () => ownsLease, isSessionLive: () => true,
      attachSessionLifecycle: value => { lifecycle = value; },
      diagnoseUnknown: async () => undefined, onNoticeState: () => undefined });
    if (useIpc) {
      const socketPath = boot.runtime.options.noticeProcess?.socketPath;
      if (!socketPath) throw new Error('actual Boot capacity socket was not wired');
      boot.runtime.service.options.capacity = originCapacityClient(socketPath);
    }
    adapter = new TelegramAdapter({ token, chatId: '-100123' }, stateDir, { suppressLifelineAutoCreate: true });
    app = express(); app.use(express.json());
    app.use((req, res, next) => { if (req.get('Authorization') !== 'Bearer agent-test') { res.sendStatus(401); return; } next(); });
    app.use(createRoutes({ config, telegramOrigin: boot.runtime, telegram: adapter,
      messagingToneGate: { review: async () => ({ pass: true, latencyMs: 0 }) },
      sessionManager: { clearInjectionTracker: () => undefined } } as never));
    await waitForOriginDisplayReady(boot.runtime, { chatId: '-100123', topicId: '42' });
    sessionToken = await lifecycle!.issue({ sessionId: `http-capacity-${++generation}`, harnessId: 'codex-cli',
      projectDir: root, configuredModel: 'fixture-model' });
  };
  const close = async () => {
    await adapter?.stop(); await boot?.close();
    await SafeFsExecutor.safeRm(root, { recursive: true, force: true, operation: 'test:late-capacity-http:cleanup' });
  };
  try { await start(); } catch (error) { await close(); throw error; }
  return {
    get app() { return app; }, get runtime() { return boot.runtime; }, get sessionToken() { return sessionToken; },
    network, close, revokeLease: () => { ownsLease = false; },
    restart: async () => { await adapter.stop(); await boot.close(); await start(); },
  };
}

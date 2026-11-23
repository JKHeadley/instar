import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { bootTelegramOrigin } from '../../src/messaging/telegram-origin/TelegramOriginBoot.js';
import { telegramFetch } from '../../src/messaging/telegram-egress.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { compileOriginWorker } from '../helpers/telegramOriginStore.js';
import { waitForOriginDisplayReady } from '../helpers/telegramOriginReady.js';
import { fixtureOriginContentDedup } from '../helpers/originContentDedup.js';
import type { OriginSessionLifecycle } from '../../src/messaging/telegram-origin/OriginSessionRegistry.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  try { for (const close of cleanup.splice(0).reverse()) await close(); }
  finally { vi.restoreAllMocks(); vi.unstubAllGlobals(); }
}, 30_000);
describe('Telegram send timing production origin bootstrap', () => {
  it('observes the real authorized network boundary and keeps pre-network refusals silent', async () => {
    const root = await mkdtemp('/tmp/telegram-timing-boot-');
    cleanup.push(async () => { await SafeFsExecutor.safeRm(root, { recursive: true, force: true, operation: 'test:telegram-timing-boot:cleanup' }); });
    const stateDir = path.join(root, '.instar'); await mkdir(path.join(stateDir, 'state'), { recursive: true });
    const token = '123:timing-private-token';
    const config = { projectDir: root, stateDir, projectName: 'echo', port: 0, authToken: 'fixture-auth',
      messaging: [{ type: 'telegram', enabled: true, config: { token, chatId: '-100123', lifelineTopicId: 7848 } }] };
    await writeFile(path.join(stateDir, 'config.json'), JSON.stringify(config));
    let lifecycle: OriginSessionLifecycle | undefined;
    const boot = await bootTelegramOrigin({ config: config as never, token, noticeOwner: true,
      workerUrl: await compileOriginWorker(), holdsLease: () => true, isSessionLive: () => true,
      attachSessionLifecycle: value => { lifecycle = value; }, diagnoseUnknown: async () => undefined, onNoticeState: () => undefined });
    cleanup.push(() => boot.close());
    boot.runtime.attachSendPolicy({ review: async () => ({ ok: true }), authorizeDispatch: () => ({ ok: true }),
      ...fixtureOriginContentDedup(stateDir) });
    await vi.waitFor(async () => expect(await boot.runtime.service.options.authorize({ accountId: '123', destination: { chatId: '-100123' } } as never)).toBe(true), { timeout: 20_000, interval: 100 });
    const session = await lifecycle!.issue({ sessionId: 'timing-session', harnessId: 'codex-cli', projectDir: root });
    const rows: Record<string, unknown>[] = [];
    vi.spyOn(console, 'info').mockImplementation(line => {
      if (String(line).startsWith('[telegram-send-timing] ')) rows.push(JSON.parse(String(line).slice('[telegram-send-timing] '.length)));
    });
    const network = vi.fn(async (_url: unknown, init: RequestInit) => {
      const params = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 9101, chat: { id: -100123 }, message_thread_id: Number(params.message_thread_id) } }));
    });
    vi.stubGlobal('fetch', network);
    await boot.runtime.service.runWithSessionToken(session, async () => {
      await waitForOriginDisplayReady(boot.runtime, { chatId: '-100123', topicId: '42' });
      const response = await telegramFetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', body: JSON.stringify({ chat_id: '-100123', message_thread_id: 42, text: 'PRIVATE_DIAGNOSTIC_BODY' }), networkTimeoutMs: 15000,
      });
      expect(response.ok).toBe(true);
    });
    expect(network).toHaveBeenCalledOnce();
    expect(rows.map(row => row.event)).toEqual(['start', 'headers']);
    expect(JSON.stringify(rows)).not.toMatch(/PRIVATE_DIAGNOSTIC_BODY|timing-private-token|-100123/);
    rows.length = 0;
    await expect(telegramFetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', body: JSON.stringify({ chat_id: '-100123', text: '\u200b' }), networkTimeoutMs: 15000,
    })).rejects.toThrow();
    expect(network).toHaveBeenCalledOnce(); expect(rows).toEqual([]);
  }, 60_000);
});

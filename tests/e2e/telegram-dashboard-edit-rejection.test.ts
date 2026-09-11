import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { bootTelegramOrigin } from '../../src/messaging/telegram-origin/TelegramOriginBoot.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { TelegramOriginHoldError } from '../../src/messaging/telegram-origin/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { compileOriginWorker } from '../helpers/telegramOriginStore.js';
import { waitForOriginDisplayReady } from '../helpers/telegramOriginReady.js';
import { fixtureOriginContentDedup } from '../helpers/originContentDedup.js';

let worker: URL;
beforeAll(async () => { worker = await compileOriginWorker(); });
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

async function fixture() {
  // macOS's long os.tmpdir() exceeds the Unix-domain socket path limit.
  const root = fs.mkdtempSync('/tmp/dashboard-rejection-boot-');
  cleanup.push(() => SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'test:dashboard-rejection-boot:cleanup' }));
  const stateDir = path.join(root, '.instar'); fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  const savedPath = path.join(stateDir, 'state', 'dashboard-message.json');
  const saved = JSON.stringify({ messageId: 88, savedAt: '2026-09-10T00:00:00.000Z' }); fs.writeFileSync(savedPath, saved);
  const telegramConfig = { token: '123:dashboard-boot-fixture', chatId: '-100123', dashboardTopicId: 5, dashboardPin: '123456',
    messageOrigin: { display: { enabled: false } } };
  const config = { projectDir: root, stateDir, projectName: 'echo', port: 0, authToken: 'fixture-auth',
    messaging: [{ type: 'telegram', enabled: true, config: telegramConfig }] };
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify(config));
  let ownsLease = true;
  const boot = await bootTelegramOrigin({ config: config as never, token: telegramConfig.token, workerUrl: worker,
    noticeOwner: true, holdsLease: () => ownsLease, isSessionLive: () => false,
    diagnoseUnknown: async () => undefined, onNoticeState: () => undefined });
  cleanup.push(() => boot.close());
  boot.runtime.attachSendPolicy({ review: async () => ({ ok: true }), authorizeDispatch: () => ({ ok: true }),
    ...fixtureOriginContentDedup(stateDir) });
  await waitForOriginDisplayReady(boot.runtime, { chatId: '-100123', topicId: null });
  await vi.waitFor(async () => expect(await boot.runtime.service.options.authorize({
    accountId: '123', destination: { chatId: '-100123' },
  } as never)).toBe(true), { timeout: 7000 });
  const telegram = new TelegramAdapter(telegramConfig, stateDir, { suppressLifelineAutoCreate: true });
  cleanup.push(() => telegram.stop());
  return { ...boot, telegram, saved, savedPath, loseLease: () => { ownsLease = false; } };
}

describe('dashboard edits through production origin startup', () => {
  it.each([true, false])('requires durable evidence for a managed unchanged no-op (recorded: %s)', async recorded => {
    const f = await fixture();
    if (!recorded) vi.spyOn(f.runtime.store, 'recordOutcome').mockResolvedValue({ recorded: false } as never);
    const wire = vi.fn(async () => new Response(JSON.stringify({ ok: false, error_code: 400,
      description: 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message',
    }), { status: 400 })); vi.stubGlobal('fetch', wire);
    const send = vi.spyOn(f.telegram, 'sendToTopic');
    const result = await f.telegram.broadcastDashboardUrl('https://fixture.example.test', 'quick').catch(error => error);
    if (recorded) expect(result).toMatchObject({ edited: true, messageId: 88 });
    else expect(result).toBeInstanceOf(TelegramOriginHoldError);
    expect(wire).toHaveBeenCalledOnce(); expect(send).not.toHaveBeenCalled();
    expect(fs.readFileSync(f.savedPath, 'utf8')).toBe(f.saved);
    const rows = (await f.runtime.store.listOrigins()).records;
    expect(rows).toHaveLength(1); expect(rows[0].attempts).toHaveLength(1);
    if (recorded) expect(rows[0].attempts[0].outcome).toBe('known-failed');
  });

  it.each(['before-wire', 'after-wire'] as const)('preserves one original operation when held %s', async boundary => {
    const f = await fixture();
    if (boundary === 'before-wire') f.loseLease();
    const wire = vi.fn(async () => { throw new Error('connection closed without a receipt'); }); vi.stubGlobal('fetch', wire);
    const send = vi.spyOn(f.telegram, 'sendToTopic');
    const error = await f.telegram.broadcastDashboardUrl('https://fixture.example.test', 'quick').catch(error => error);
    expect(error).toBeInstanceOf(TelegramOriginHoldError);
    expect(error.outcome).toBe(boundary === 'before-wire' ? 'held' : 'outcome-unknown');
    expect(wire).toHaveBeenCalledTimes(boundary === 'before-wire' ? 0 : 1);
    expect(send).not.toHaveBeenCalled(); expect(fs.readFileSync(f.savedPath, 'utf8')).toBe(f.saved);
    const rows = (await f.runtime.store.listOrigins()).records;
    expect(rows).toHaveLength(1); expect(rows[0].operation?.operationId).toBe(error.operationId);
    expect(rows[0].attempts).toHaveLength(boundary === 'before-wire' ? 0 : 1);
  });

  it.each(['recorded', 'refused', 'throws'] as const)('permits replacement only after durable missing-message outcome is %s', async persistence => {
    const f = await fixture(), methods: string[] = [];
    const originalRecordOutcome = f.runtime.store.recordOutcome.bind(f.runtime.store);
    const persistenceFailure = new Error('fixture outcome recording unavailable');
    let originalSendError: unknown;
    const sendBot = f.runtime.service.sendBot.bind(f.runtime.service);
    vi.spyOn(f.runtime.service, 'sendBot').mockImplementation(async (...args) => {
      try { return await sendBot(...args); }
      catch (error) { originalSendError = error; throw error; }
    });
    vi.spyOn(f.runtime.store, 'recordOutcome').mockImplementation(async input => {
      if (input.outcome === 'known-failed') {
        if (persistence === 'throws') throw persistenceFailure;
        if (persistence === 'refused') return { recorded: false } as never;
      }
      return originalRecordOutcome(input);
    });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const method = new URL(url).pathname.split('/').pop()!; methods.push(method);
      if (method === 'editMessageText') return new Response(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: message to edit not found' }), { status: 400 });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 99, chat: { id: -100123 }, message_thread_id: 5 } }));
    }));
    const send = vi.spyOn(f.telegram, 'sendToTopic');
    const result = await f.telegram.broadcastDashboardUrl('https://fixture.example.test', 'quick').catch(error => error);
    if (persistence === 'recorded') {
      expect(result).toMatchObject({ edited: false, messageId: 99 }); expect(send).toHaveBeenCalledOnce();
      expect(methods).toEqual(['editMessageText', 'sendMessage', 'unpinAllForumTopicMessages', 'pinChatMessage']);
      expect(JSON.parse(fs.readFileSync(f.savedPath, 'utf8')).messageId).toBe(99);
      const rows = (await f.runtime.store.listOrigins()).records;
      expect(rows).toHaveLength(2);
      expect(rows.flatMap(row => row.attempts).map(attempt => attempt.outcome).sort()).toEqual(['accepted', 'known-failed']);
    } else {
      expect(result).toBe(originalSendError);
      expect(result).toBeInstanceOf(TelegramOriginHoldError);
      if (persistence === 'throws') expect(result.reason).toBe('origin-execution-state-unavailable');
      expect(send).not.toHaveBeenCalled(); expect(methods).toEqual(['editMessageText']);
      expect(fs.readFileSync(f.savedPath, 'utf8')).toBe(f.saved);
    }
  });
});

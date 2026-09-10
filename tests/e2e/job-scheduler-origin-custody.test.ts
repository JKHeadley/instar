import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { bootTelegramOrigin } from '../../src/messaging/telegram-origin/TelegramOriginBoot.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { compileOriginWorker } from '../helpers/telegramOriginStore.js';
import { waitForOriginDisplayReady } from '../helpers/telegramOriginReady.js';

let worker: URL;
beforeAll(async () => { worker = await compileOriginWorker(); });
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllGlobals();
});

describe('scheduled completion through the production Telegram origin boundary', () => {
  it('keeps one uncertain operation and the original topic when Telegram loses its response', async () => {
    const root = await mkdtemp('/tmp/scheduler-origin-');
    cleanup.push(() => SafeFsExecutor.safeRm(root, { recursive: true, force: true, operation: 'test:scheduler-origin:cleanup' }));
    const stateDir = path.join(root, '.instar');
    await mkdir(path.join(stateDir, 'state'), { recursive: true });
    const telegramConfig = { token: '123:scheduler-fixture', chatId: '-100123', messageOrigin: { display: { enabled: false } } };
    const config = { projectDir: root, stateDir, projectName: 'echo', port: 0,
      messaging: [{ type: 'telegram', enabled: true, config: telegramConfig }] };
    await writeFile(path.join(stateDir, 'config.json'), JSON.stringify(config));
    const options = { config: config as never, token: telegramConfig.token, noticeOwner: true,
      workerUrl: worker, holdsLease: () => true, diagnoseUnknown: async () => undefined, onNoticeState: () => undefined };
    let boot = await bootTelegramOrigin(options);
    cleanup.push(() => boot.close());
    boot.runtime.attachSendPolicy({ review: async () => ({ ok: true }), authorizeDispatch: () => ({ ok: true }) });
    const telegram = new TelegramAdapter(telegramConfig, stateDir, { suppressLifelineAutoCreate: true });
    const recreate = vi.spyOn(telegram, 'findOrCreateForumTopic').mockResolvedValue({ topicId: 99, name: 'Replacement', reused: false });
    const send = vi.spyOn(telegram, 'sendToTopic');
    const state = new StateManager(stateDir);
    const scheduler = new JobScheduler({ jobsFile: path.join(root, 'jobs.json'), projectDir: root },
      { captureOutput: () => 'Job completed with useful output.' } as never, state, stateDir);
    const job = { slug: 'fixture-job', name: 'Fixture Job', topicId: 42, telegramNotify: true };
    (scheduler as any).jobs = [job];
    scheduler.setTelegram(telegram);
    state.saveSession({ id: 'session', name: 'session', tmuxSession: 'fixture', jobSlug: job.slug,
      status: 'completed', startedAt: new Date().toISOString() });
    const wire = vi.fn(async () => {
      const rows = (await boot.runtime.store.listOrigins()).records;
      expect(rows).toHaveLength(1);
      expect(rows[0].attempts[0].phase).toBe('dispatched');
      // Telegram may have accepted the bytes; only its response is missing.
      throw new Error('response lost after request transmission');
    });
    vi.stubGlobal('fetch', wire);

    await waitForOriginDisplayReady(boot.runtime, { chatId: '-100123', topicId: '42' });
    await scheduler.notifyJobComplete('session', 'fixture');

    expect(wire).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
    expect(recreate).not.toHaveBeenCalled();
    expect(job.topicId).toBe(42);
    expect(state.getJobState(job.slug)?.lastResult).toBe('success');
    const original = (await boot.runtime.store.listOrigins()).records;
    expect(original).toHaveLength(1);
    expect(original[0].operation?.state).toBe('outcome-unknown');
    await boot.close();
    boot = await bootTelegramOrigin(options);
    const recovered = (await boot.runtime.store.listOrigins()).records;
    expect(recovered).toHaveLength(1);
    expect(recovered[0].record.originId).toBe(original[0].record.originId);
    expect(recovered[0].operation?.state).toBe('outcome-unknown');
    expect(wire).toHaveBeenCalledOnce();
  });
});

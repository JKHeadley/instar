import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { bootTelegramOrigin } from '../../src/messaging/telegram-origin/TelegramOriginBoot.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { triageOriginSender, readTriageSessionAuthor } from '../../src/monitoring/TriageOrigin.js';
import { StallTriageNurse } from '../../src/monitoring/StallTriageNurse.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { compileOriginWorker } from '../helpers/telegramOriginStore.js';
import { waitForOriginDisplayReady } from '../helpers/telegramOriginReady.js';
import type { OriginSessionLifecycle } from '../../src/messaging/telegram-origin/OriginSessionRegistry.js';

let worker: URL;
beforeAll(async () => { worker = await compileOriginWorker(); });
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllGlobals(); });

describe('production triage author binding', () => {
  it('records a native observed triage model, the actual nurse call, and honest missing-session evidence', async () => {
    const root = await mkdtemp('/tmp/triage-origin-');
    cleanup.push(() => SafeFsExecutor.safeRm(root, { recursive: true, force: true, operation: 'test:triage-origin:cleanup' }));
    const stateDir = path.join(root, '.instar'); await mkdir(path.join(stateDir, 'state'), { recursive: true });
    const telegramConfig = { token: '123:triage-fixture', chatId: '-100123', messageOrigin: { display: { enabled: false } } };
    const config = { projectDir: root, stateDir, projectName: 'echo', port: 0,
      messaging: [{ type: 'telegram', enabled: true, config: telegramConfig }] };
    await writeFile(path.join(stateDir, 'config.json'), JSON.stringify(config));
    let lifecycle: OriginSessionLifecycle | undefined;
    const boot = await bootTelegramOrigin({ config: config as never, token: telegramConfig.token, noticeOwner: true,
      workerUrl: worker, holdsLease: () => true, isSessionLive: () => true,
      attachSessionLifecycle: value => { lifecycle = value; }, diagnoseUnknown: async () => undefined, onNoticeState: () => undefined });
    cleanup.push(() => boot.close());
    boot.runtime.attachSendPolicy({ review: async () => ({ ok: true }), authorizeDispatch: () => ({ ok: true }) });
    const telegram = new TelegramAdapter(telegramConfig, stateDir, { suppressLifelineAutoCreate: true });
    let messageId = 1;
    const wire = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ ok: true, result: { message_id: messageId++, chat: { id: -100123 }, message_thread_id: body.message_thread_id } }));
    });
    vi.stubGlobal('fetch', wire);
    await lifecycle!.issue({ sessionId: 'triage-session', harnessId: 'claude-code', projectDir: root,
      nativeSessionId: 'native-triage', configuredModel: 'requested-model' });
    const source = path.join(root, 'native-triage.jsonl');
    const timestamp = new Date().toISOString();
    await writeFile(source, [
      { type: 'user', sessionId: 'native-triage', uuid: 'turn-1', timestamp, message: { content: 'Diagnose this stall' } },
      { type: 'assistant', sessionId: 'native-triage', uuid: 'reply-1', timestamp, message: { model: 'actual-native-model', content: 'Diagnosis' } },
    ].map(record => JSON.stringify(record)).join('\n') + '\n');
    boot.runtime.observer.track(boot.runtime.sessions.getBinding('triage-session')!, { path: source, nativeSessionId: 'native-triage' });
    const nativeAuthor = await readTriageSessionAuthor(boot.runtime, 'triage-session');
    const surfaceTriage = triageOriginSender(boot.runtime.service, 'triage-orchestrator', (topicId, text) => telegram.sendToTopic(topicId, text));
    await waitForOriginDisplayReady(boot.runtime, { chatId: '-100123', topicId: '42' });
    await surfaceTriage(42, 'The scoped triage session found the cause.', nativeAuthor);

    const nurse = new StallTriageNurse({} as never, { intelligence: { evaluate: async (_prompt: string, options: any) => {
      options.onModel({ model: 'actual-nurse-model', framework: 'codex-cli' });
      return JSON.stringify({ summary: 'Busy', action: 'status_update', confidence: 'high', userMessage: 'The nurse found a running calculation.' });
    } } as never });
    const diagnosis = await (nurse as any).diagnose({ sessionName: 'target', topicId: 42, sessionStatus: 'alive',
      tmuxOutput: 'Calculation progress', recentMessages: [], pendingMessage: 'status?', waitMinutes: 1 });
    await triageOriginSender(boot.runtime.service, 'stall-triage-nurse', (topicId, text) => telegram.sendToTopic(topicId, text))(
      42, diagnosis.userMessage, diagnosis.originAuthor);
    await lifecycle!.revoke('triage-session');
    await surfaceTriage(42, 'The earlier triage output has no retained session evidence.', await readTriageSessionAuthor(boot.runtime, 'triage-session'));
    const fallback = nurse.parseDiagnosis('unparseable diagnosis', diagnosis.originAuthor);
    await triageOriginSender(boot.runtime.service, 'stall-triage-nurse', (topicId, text) => telegram.sendToTopic(topicId, text))(
      42, fallback.userMessage, fallback.originAuthor);
    const records = (await boot.runtime.store.listOrigins()).records.map(row => JSON.parse(row.record.envelopeJson));
    expect(records).toHaveLength(4); expect(wire).toHaveBeenCalledTimes(4);
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ producerId: 'triage-orchestrator', model: expect.objectContaining({ value: 'actual-native-model', status: 'observed' }),
        harness: expect.objectContaining({ value: 'claude-code', status: 'observed', sourceEventRef: expect.stringContaining('session:triage-session:') }) }),
      expect.objectContaining({ producerId: 'stall-triage-nurse', model: expect.objectContaining({ value: 'actual-nurse-model', status: 'configured' }) }),
      expect.objectContaining({ producerId: 'triage-orchestrator', model: expect.objectContaining({ value: null, status: 'unknown', reason: 'triage-session-not-enrolled' }) }),
      expect.objectContaining({ producerId: 'stall-triage-nurse', model: expect.objectContaining({ value: null, status: 'not-applicable', reason: 'deterministic-automation' }) }),
    ]));
  });
});

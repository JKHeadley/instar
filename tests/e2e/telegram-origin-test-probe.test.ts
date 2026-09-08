import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { sendRecordedTestProbe } from '../../src/messaging/telegram-origin/OriginTestProbe.js';
import { OriginStore } from '../../src/messaging/telegram-origin/OriginStore.js';
import { compileOriginWorker, temporaryState } from '../helpers/telegramOriginStore.js';
let worker: URL;
beforeAll(async () => { worker = await compileOriginWorker(); });
afterEach(() => vi.unstubAllGlobals());
describe('standalone test-as-self probe custody', () => {
  it('records a deterministic CLI probe and retains its actual receipt after the runtime closes', async () => {
    const projectDir = temporaryState(), stateDir = path.join(projectDir, '.instar');
    await mkdir(stateDir);
    await writeFile(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'test-agent', messaging: [] }));
    await new MachineIdentityManager(stateDir).generateIdentity({ name: 'Test machine' });
    const observer = await OriginStore.open({ stateDir, agentId: 'test-agent' }, worker);
    let beforeNetwork: Awaited<ReturnType<OriginStore['listOrigins']>> | undefined;
    const network = vi.fn(async () => {
      beforeNetwork = await observer.listOrigins();
      return new Response(JSON.stringify({ ok: true, result: { message_id: 321, chat: { id: -100123 } } }));
    });
    vi.stubGlobal('fetch', network);
    try {
      await sendRecordedTestProbe({ projectDir, botToken: '789:fixture', chatId: -100123, nonce: 'n123', timeoutMs: 3000, workerUrl: worker });
      expect(network).toHaveBeenCalledOnce();
      expect(beforeNetwork?.records[0].attempts[0].phase).toBe('dispatched');
      const row = (await observer.listOrigins({ accountId: '789', chatId: '-100123', messageId: '321' })).records[0];
      expect(JSON.parse(row.record.envelopeJson)).toMatchObject({ producerId: 'test-as-self',
        producerKind: 'server-automation', model: { status: 'not-applicable' }, display: { enabled: true } });
      expect(row.operation?.state).toBe('accepted');
    } finally { await observer.close(); }
  });
});

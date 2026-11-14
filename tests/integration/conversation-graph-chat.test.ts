import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { SlackAdapter } from '../../src/messaging/slack/SlackAdapter.js';
import { wireConversationsPointers } from '../../src/messaging/shared/conversationGraphChat.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).reverse().forEach((f) => f()); vi.restoreAllMocks(); });
function state() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-chat-integration-')); cleanup.push(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'graph-chat-integration-cleanup' })); return dir; }

describe('Conversations chat through authenticated adapter ingress', () => {
  it.each(['private', 'supergroup'])('Telegram %s commands never reach a model or contain private graph data', async (type) => {
    const adapter = new TelegramAdapter({ token: 'test', chatId: '-1001', authorizedUserIds: [1] } as never, state());
    cleanup.push(() => adapter.stopPromptGate());
    wireConversationsPointers([adapter], () => 'https://echo.example');
    const send = vi.spyOn(adapter, 'sendToTopic').mockResolvedValue(1 as never);
    const direct = vi.spyOn(adapter as never, 'apiCall' as never).mockResolvedValue({ message_id: 1 } as never);
    const model = vi.fn(async () => {});
    adapter.onMessage(model);
    await (adapter as unknown as { processUpdate: (update: unknown) => Promise<void> }).processUpdate({
      update_id: 1, message: { message_id: 1, ...(type === 'private' ? {} : { message_thread_id: 42 }), chat: { id: type === 'private' ? 1 : -1001, type },
        from: { id: 1, first_name: 'Owner' }, date: Math.floor(Date.now() / 1000),
        text: '/conversations reveal CANARY-PRIVATE-EFFORT' },
    });
    expect(model).not.toHaveBeenCalled();
    if (type === 'private') {
      expect(send).not.toHaveBeenCalled();
      expect(direct).toHaveBeenCalledWith('sendMessage', { chat_id: 1, text: expect.stringContaining('/dashboard/console/#/work/conversations') });
      expect(JSON.stringify(direct.mock.calls)).not.toContain('CANARY');
    } else {
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][1]).not.toContain('CANARY');
      expect(send.mock.calls[0][1]).toContain('/dashboard/console/#/work/conversations');
    }
  });

  it.each(['D_OWNER', 'C_SHARED', 'G_PRIVATE'])('Slack %s uses one neutral reply in the original thread, no model dispatch', async (channel) => {
    const adapter = new SlackAdapter({ botToken: 'xoxb-test', appToken: 'xapp-test', authorizedUserIds: ['U_OWNER'], workspaceMode: channel === 'C_SHARED' ? 'shared' : 'dedicated' } as never, state());
    wireConversationsPointers([adapter], () => 'https://echo.example');
    const send = vi.spyOn(adapter, 'sendToChannel').mockResolvedValue('100.2');
    const model = vi.fn(async () => {});
    adapter.onMessage(model);
    const event = { user: 'U_OWNER', channel, ts: '100.2', thread_ts: '100.0', text: '!conversations reveal CANARY-PRIVATE-EFFORT' };
    await adapter._testInjectMessage(event);
    await adapter._testInjectMessage(event); // Socket reconnection redelivery.
    expect(model).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][2]).toEqual({ thread_ts: '100.0' });
    expect(send.mock.calls[0][1]).not.toContain('CANARY');
  });
});

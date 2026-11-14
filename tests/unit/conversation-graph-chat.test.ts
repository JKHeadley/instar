import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { conversationsPointer, wireConversationsPointers } from '../../src/messaging/shared/conversationGraphChat.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { SlackAdapter } from '../../src/messaging/slack/SlackAdapter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach((cleanup) => cleanup()); vi.restoreAllMocks(); });
function temp() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-chat-')); cleanups.push(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'graph-chat-test-cleanup' })); return dir; }

describe('Conversations audience-safe pointer', () => {
  it('never forwards secrets, source identifiers, queries or fragments', () => {
    const result = conversationsPointer('https://echo.example/view/private?token=SECRET#CANARY-PRIVATE-TITLE');
    expect(result).toContain('https://echo.example/dashboard/console/#/work/conversations');
    for (const privateText of ['SECRET', 'CANARY', '/view/private', '?token']) expect(result).not.toContain(privateText);
  });
  it('unknown destinations and unsafe addresses still get only the neutral app pointer', () => {
    const neutral = conversationsPointer(null);
    for (const address of ['javascript:alert(1)', 'http://localhost:4040', 'https://u:p@echo.example', 'broken']) {
      expect(conversationsPointer(address)).toBe(neutral);
    }
    expect(neutral).not.toContain('effort');
  });
  it('wires real adapters to a live URL resolver, so a tunnel replacement does not strand the link', async () => {
    const telegram = new TelegramAdapter({ token: 'test', chatId: '-1001', authorizedUserIds: [1] } as never, temp());
    cleanups.push(() => telegram.stopPromptGate());
    const slack = new SlackAdapter({ botToken: 'xoxb-test', appToken: 'xapp-test', authorizedUserIds: ['U_OWNER'] } as never, temp());
    let address = 'https://first.example';
    wireConversationsPointers([telegram, slack], () => address);
    const tg = vi.spyOn(telegram, 'sendToTopic').mockResolvedValue(1 as never);
    const sl = vi.spyOn(slack, 'sendToChannel').mockResolvedValue('100.2');
    expect(await telegram.handleCommand('/conversations reveal CANARY-PRIVATE-TITLE', 42, 1)).toBe(true);
    expect(tg.mock.calls[0][1]).toContain('https://first.example/dashboard/console/');
    expect(tg.mock.calls[0][1]).not.toContain('CANARY');
    address = 'https://second.example';
    const command = (slack as unknown as { _handleSlashCommand: (text: string, channel: string, ts: string, thread: string) => Promise<boolean> })._handleSlashCommand.bind(slack);
    expect(await command('/conversations CANARY-PRIVATE-TITLE', 'C_SHARED', '100.2', '100.0')).toBe(true);
    expect(sl.mock.calls[0]).toEqual(['C_SHARED', conversationsPointer(address), { thread_ts: '100.0' }]);
    expect(sl.mock.calls[0][1]).not.toContain('CANARY');
  });
});

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';

describe('Telegram history authorship wiring', () => {
  it('the production adapter re-read surface returns the joined column', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-authorship-'));
    const text = 'agent words without a magic prefix';
    fs.writeFileSync(path.join(dir, 'telegram-messages.jsonl'), JSON.stringify({
      messageId: 99, topicId: 43003, text, fromUser: true,
      timestamp: '2026-08-22T21:32:10.808Z', sessionName: null,
    }) + '\n');
    fs.writeFileSync(path.join(dir, 'asp-classifications.jsonl'), JSON.stringify({
      messageId: 99, topicId: 43003, classification: 'agent-verified',
      bodyHash: createHash('sha256').update(text).digest('hex'),
    }) + '\n');
    const adapter = new TelegramAdapter({ token: 'test', chatId: '-1001' }, dir);
    expect(adapter.getTopicHistory(43003, 20)[0].authorship).toBe('agent-verified');
    expect(adapter.searchLog({ topicId: 43003 })[0].authorship).toBe('agent-verified');
  });
});

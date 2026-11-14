import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/telegram-recovered-reply-history.test.ts' }); });

it('records a recovered issues-group reply once under its internal topic id', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-recovered-history-'));
  dirs.push(dir);
  const adapter = new TelegramAdapter({ token: 'test-token', chatId: '-100111', issuesChatId: '-100222' }, dir);
  const receipt = { chatId: '-100222', threadId: 1534, messageId: 1550, text: 'Recovered session reply', acceptedAt: Date.now(), producerKind: 'session' };
  adapter.logRecoveredOriginMessage(receipt);
  adapter.logRecoveredOriginMessage(receipt);
  const rows = adapter.getTopicHistory(10000001534, 10).filter(row => row.messageId === 1550);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ text: 'Recovered session reply', fromUser: false, provenance: 'agent' });
});

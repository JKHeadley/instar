/**
 * Tests that the Telegram bot token is never exposed in error messages.
 *
 * Security: Bot tokens in logs/errors could be harvested by log aggregators.
 */

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { QuietRecordedError } from '../../src/messaging/NotificationSelectivityGate.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { createTempProject } from '../helpers/setup.js';

describe('TelegramAdapter — token redaction', () => {
  it.each(['sendMessage', 'editMessageText'])('redacts the token in an actual %s rejection', async method => {
    const project = createTempProject();
    const token = '123456:platform-redaction-fixture';
    const adapter = new TelegramAdapter({ token, chatId: '-100123' }, project.stateDir);
    const body = { ok: false, error_code: 403, description: 'Forbidden: bot was kicked' };
    const wire = vi.fn(async (_url: string) => new Response(JSON.stringify(body), { status: 403 }));
    vi.stubGlobal('fetch', wire);
    try {
      const api = adapter as unknown as { apiCall(method: string, params: Record<string, unknown>): Promise<unknown> };
      const request = api.apiCall(method, { chat_id: '-100123', message_id: 88, text: 'The client report is ready for review.' });
      await expect(request).rejects.toThrow(`Telegram API error https://api.telegram.org/bot[REDACTED]/${method} (403): ${JSON.stringify(body)}`);
      await expect(request).rejects.not.toThrow(token);
      expect(wire).toHaveBeenCalledOnce();
      expect(wire.mock.calls[0]?.[0]).toBe(`https://api.telegram.org/bot${token}/${method}`);
    } finally {
      try { await adapter.stop(); }
      finally { vi.unstubAllGlobals(); project.cleanup(); }
    }
  });

  it.each([400, 403])('generic send retries only a rejected parse (%s)', async status => {
    const project = createTempProject();
    const adapter = new TelegramAdapter({ token: '123:retry-fixture', chatId: '-100123' }, project.stateDir,
      { suppressLifelineAutoCreate: true });
    const api = vi.spyOn(adapter as never, 'apiCall' as never)
      .mockRejectedValueOnce(new Error(`Telegram API error (${status})`))
      .mockResolvedValue({ message_id: 42 } as never);
    try {
      const result = adapter.send({ content: 'The requested result is ready.', channel: { identifier: '10' } } as never);
      if (status === 400) {
        await expect(result).resolves.toMatchObject({ messageId: 42 });
        expect(api).toHaveBeenCalledTimes(2);
      } else {
        await expect(result).rejects.toThrow('(403)');
        expect(api).toHaveBeenCalledTimes(1);
      }
    } finally { api.mockRestore(); await adapter.stop(); project.cleanup(); }
  });

  it('a delegated quiet receipt is terminal before any formatting retry', async () => {
    const project = createTempProject();
    const adapter = new TelegramAdapter({ token: '123:quiet-fixture', chatId: '-100123' }, project.stateDir,
      { suppressLifelineAutoCreate: true });
    const receipt = { recorded: true as const, delivered: false as const, quietId: 'quiet-origin' };
    const api = vi.spyOn(adapter as never, 'apiCall' as never).mockRejectedValue(new QuietRecordedError(receipt));
    try {
      await expect(adapter.sendToTopic(10, 'Routine report.')).resolves.toEqual(receipt);
      expect(api).toHaveBeenCalledTimes(1);
    } finally { api.mockRestore(); await adapter.stop(); project.cleanup(); }
  });

  it('onTopicMessage has try/catch like the general handler', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/messaging/TelegramAdapter.ts'),
      'utf-8',
    );

    // The onTopicMessage call should be wrapped in try/catch
    expect(source).toContain('Topic message handler error');
  });
});

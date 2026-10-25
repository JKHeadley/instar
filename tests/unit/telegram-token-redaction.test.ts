/**
 * Tests that the Telegram bot token is never exposed in error messages.
 *
 * Security: Bot tokens in logs/errors could be harvested by log aggregators.
 */

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
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

  it('send() only retries on 400 errors (parse failures)', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/messaging/TelegramAdapter.ts'),
      'utf-8',
    );

    // Should check for 400 status before retrying
    expect(source).toContain("(400)");
    expect(source).toContain('parse_mode');
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

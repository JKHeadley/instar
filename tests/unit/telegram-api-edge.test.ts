/**
 * Edge case tests for TelegramAdapter API behavior.
 *
 * Covers: token redaction in logs, 429 retry cap, send with markdown fallback,
 * and apiCall timeout configuration.
 */

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { createTempProject } from '../helpers/setup.js';

describe('TelegramAdapter — API edge cases', () => {
  const sourcePath = path.join(process.cwd(), 'src/messaging/TelegramAdapter.ts');
  let source: string;

  // Read source once for all tests
  source = fs.readFileSync(sourcePath, 'utf-8');

  describe('token redaction', () => {
    it('never logs the raw bot token in API URLs', () => {
      // Should use a redacted URL for error messages
      expect(source).toContain('[REDACTED]');
      expect(source).toContain('safeUrl');
    });

    it.each([403, 500])('redacts the request URL in HTTP %s errors with a non-JSON body', async status => {
      const project = createTempProject();
      const token = '123456:edge-redaction-fixture';
      const adapter = new TelegramAdapter({ token, chatId: '-100123' }, project.stateDir);
      const wire = vi.fn(async (_url: string) => new Response('Gateway refused the request', { status }));
      vi.stubGlobal('fetch', wire);
      try {
        // Exercise the real API boundary, including its malformed-body branch.
        const api = adapter as unknown as { apiCall(method: string, params: Record<string, unknown>): Promise<unknown> };
        const request = api.apiCall('getMe', {});
        await expect(request).rejects.toThrow(`Telegram API error https://api.telegram.org/bot[REDACTED]/getMe (${status}): Gateway refused the request`);
        await expect(request).rejects.not.toThrow(token);
        expect(wire).toHaveBeenCalledOnce();
        expect(wire.mock.calls[0]?.[0]).toBe(`https://api.telegram.org/bot${token}/getMe`);
      } finally {
        try { await adapter.stop(); }
        finally { vi.unstubAllGlobals(); project.cleanup(); }
      }
    });
  });

  describe('429 retry cap', () => {
    it('has a retry limit of 3 for rate-limited requests', () => {
      expect(source).toContain('retryCount >= 3');
    });

    it('passes retryCount parameter to prevent infinite recursion', () => {
      expect(source).toContain('retryCount + 1');
    });

    it('reads retry_after from Telegram API response', () => {
      expect(source).toContain('retry_after');
    });

    it('defaults to 5s when retry_after is not provided', () => {
      expect(source).toContain('?? 5');
    });
  });

  describe('timeout configuration', () => {
    it('uses longer timeout for getUpdates (long polling)', () => {
      expect(source).toContain('60_000');
    });

    it('uses shorter timeout for regular API calls', () => {
      expect(source).toContain('15_000');
    });

    it('uses AbortController for timeout enforcement', () => {
      expect(source).toContain('AbortController');
      expect(source).toContain('controller.abort');
      expect(source).toContain('controller.signal');
    });

    it('cleans up timeout timer in finally block', () => {
      expect(source).toContain('finally');
      expect(source).toContain('clearTimeout(timer)');
    });
  });

  describe('send with markdown fallback', () => {
    it('sends with Markdown parse_mode by default', () => {
      expect(source).toContain("parse_mode: 'Markdown'");
    });

    it('retries without parse_mode on 400 error', () => {
      // The send method should catch 400 errors and retry without parse_mode
      expect(source).toContain("(400)");
      expect(source).toContain('delete params.parse_mode');
    });

    it('sendToTopic also has markdown fallback', () => {
      // sendToTopic tries with Markdown first, catches and retries without
      const sendToTopicSection = source.slice(source.indexOf('async sendToTopic'));
      const nextMethod = sendToTopicSection.indexOf('async ', 10);
      const methodBody = sendToTopicSection.slice(0, nextMethod > 0 ? nextMethod : undefined);

      expect(methodBody).toContain("parse_mode: 'Markdown'");
      expect(methodBody).toContain('catch');
    });
  });

  describe('polling safety', () => {
    it('checks polling flag before each poll cycle', () => {
      expect(source).toContain('if (!this.polling) return');
    });

    it('wraps poll in try-catch to prevent crash on network errors', () => {
      const pollSection = source.slice(source.indexOf('private async poll'));
      expect(pollSection).toContain('catch (err)');
    });

    it('schedules next poll regardless of errors', () => {
      // The setTimeout for next poll should be outside the try-catch
      const pollSection = source.slice(source.indexOf('private async poll'));
      const catchIndex = pollSection.lastIndexOf('catch (err)');
      const setTimeoutIndex = pollSection.lastIndexOf('setTimeout');
      // setTimeout should come AFTER the catch block
      expect(setTimeoutIndex).toBeGreaterThan(catchIndex);
    });
  });
});

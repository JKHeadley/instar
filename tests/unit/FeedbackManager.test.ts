import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FeedbackManager } from '../../src/core/FeedbackManager.js';
import type { FeedbackConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('FeedbackManager', () => {
  let tmpDir: string;
  let feedbackFile: string;
  let config: FeedbackConfig;
  let manager: FeedbackManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-feedback-test-'));
    feedbackFile = path.join(tmpDir, 'feedback.json');
    config = {
      enabled: true,
      webhookUrl: 'https://example.com/feedback',
      feedbackFile,
    };
    manager = new FeedbackManager(config);
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/FeedbackManager.test.ts:27' });
  });

  describe('submit', () => {
    it('stores feedback locally', async () => {
      // Mock fetch to simulate webhook failure (so we test local storage)
      const originalFetch = global.fetch;
      global.fetch = vi.fn().mockRejectedValue(new Error('network error'));

      const item = await manager.submit({
        type: 'bug',
        title: 'Server crashes on startup',
        description: 'When I run instar server start, it crashes immediately.',
        agentName: 'test-agent',
        instarVersion: '0.1.8',
        nodeVersion: 'v20.0.0',
        os: 'darwin arm64',
      });

      expect(item.id).toMatch(/^fb-/);
      expect(item.title).toBe('Server crashes on startup');
      expect(item.type).toBe('bug');
      expect(item.forwarded).toBe(false);
      expect(item.submittedAt).toBeTruthy();

      // Verify local storage
      const stored = JSON.parse(fs.readFileSync(feedbackFile, 'utf-8'));
      expect(stored).toHaveLength(1);
      expect(stored[0].id).toBe(item.id);

      global.fetch = originalFetch;
    });

    it('marks as forwarded when webhook succeeds', async () => {
      const originalFetch = global.fetch;
      global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, headers: { get: () => null } });

      const item = await manager.submit({
        type: 'feature',
        title: 'Add Discord support',
        description: 'Would love Discord integration.',
        agentName: 'test-agent',
        instarVersion: '0.1.8',
        nodeVersion: 'v20.0.0',
        os: 'darwin arm64',
      });

      expect(item.forwarded).toBe(true);

      global.fetch = originalFetch;
    });

    it('stores multiple feedback items', async () => {
      const originalFetch = global.fetch;
      global.fetch = vi.fn().mockRejectedValue(new Error('offline'));

      await manager.submit({
        type: 'bug',
        title: 'Bug 1',
        description: 'First bug',
        agentName: 'test',
        instarVersion: '0.1.8',
        nodeVersion: 'v20.0.0',
        os: 'linux x64',
      });

      await manager.submit({
        type: 'feature',
        title: 'Feature 1',
        description: 'First feature',
        agentName: 'test',
        instarVersion: '0.1.8',
        nodeVersion: 'v20.0.0',
        os: 'linux x64',
      });

      const items = manager.list();
      expect(items).toHaveLength(2);

      global.fetch = originalFetch;
    });
  });

  describe('list', () => {
    it('returns empty array when no feedback file', () => {
      expect(manager.list()).toEqual([]);
    });

    it('returns stored feedback', async () => {
      const originalFetch = global.fetch;
      global.fetch = vi.fn().mockRejectedValue(new Error('offline'));

      await manager.submit({
        type: 'bug',
        title: 'Test',
        description: 'Test desc',
        agentName: 'test',
        instarVersion: '0.1.0',
        nodeVersion: 'v20.0.0',
        os: 'darwin arm64',
      });

      const items = manager.list();
      expect(items).toHaveLength(1);
      expect(items[0].title).toBe('Test');

      global.fetch = originalFetch;
    });
  });

  describe('get', () => {
    it('returns null for non-existent ID', () => {
      expect(manager.get('nonexistent')).toBeNull();
    });

    it('returns specific feedback item', async () => {
      const originalFetch = global.fetch;
      global.fetch = vi.fn().mockRejectedValue(new Error('offline'));

      const item = await manager.submit({
        type: 'question',
        title: 'How do jobs work?',
        description: 'I need help.',
        agentName: 'test',
        instarVersion: '0.1.0',
        nodeVersion: 'v20.0.0',
        os: 'darwin arm64',
      });

      const retrieved = manager.get(item.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.title).toBe('How do jobs work?');

      global.fetch = originalFetch;
    });
  });

  describe('retryUnforwarded', () => {
    it('returns zero counts when nothing to retry', async () => {
      const result = await manager.retryUnforwarded();
      expect(result).toEqual({ retried: 0, succeeded: 0 });
    });

    it('retries and marks forwarded on success', async () => {
      const originalFetch = global.fetch;

      // First submit fails
      global.fetch = vi.fn().mockRejectedValue(new Error('offline'));
      await manager.submit({
        type: 'bug',
        title: 'Retry test',
        description: 'Should be retried',
        agentName: 'test',
        instarVersion: '0.1.0',
        nodeVersion: 'v20.0.0',
        os: 'darwin arm64',
      });

      expect(manager.list()[0].forwarded).toBe(false);

      // Retry succeeds
      global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, headers: { get: () => null } });
      const result = await manager.retryUnforwarded();

      expect(result.retried).toBe(1);
      expect(result.succeeded).toBe(1);
      expect(manager.list()[0].forwarded).toBe(true);

      global.fetch = originalFetch;
    });

    // The 2026-06-20 storm fix (L364): a 429 must HALT the batch — not re-POST the
    // whole backlog — and back off so the very next cycle does not POST at all.
    it('a 429 halts the batch after one POST and backs off the next cycle', async () => {
      const originalFetch = global.fetch;

      // Seed a backlog of 3 unforwarded items (submit offline so none forward).
      global.fetch = vi.fn().mockRejectedValue(new Error('offline'));
      for (let i = 0; i < 3; i++) {
        await manager.submit({
          type: 'bug', title: `b${i}`, description: 'd', agentName: 't',
          instarVersion: '0.1.0', nodeVersion: 'v20.0.0', os: 'darwin arm64',
        });
      }
      expect(manager.list().filter(f => !f.forwarded).length).toBe(3);

      // Endpoint is rate-limiting. The batch must stop after the FIRST POST.
      const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 429, statusText: 'Too Many Requests', headers: { get: () => null } });
      global.fetch = fetchMock;
      const r1 = await manager.retryUnforwarded();
      expect(fetchMock).toHaveBeenCalledTimes(1);      // halted after one, NOT 3
      expect(r1.succeeded).toBe(0);
      expect(manager.list().filter(f => !f.forwarded).length).toBe(3); // none lost

      // Next cycle is inside the backoff window → zero POSTs (the storm is dead).
      const fetchMock2 = vi.fn().mockResolvedValue({ ok: false, status: 429, headers: { get: () => null } });
      global.fetch = fetchMock2;
      const r2 = await manager.retryUnforwarded();
      expect(fetchMock2).not.toHaveBeenCalled();
      expect(r2).toEqual({ retried: 0, succeeded: 0 });

      global.fetch = originalFetch;
    });

    it('honors a Retry-After header on a 429 (backoff window)', async () => {
      const originalFetch = global.fetch;
      global.fetch = vi.fn().mockRejectedValue(new Error('offline'));
      await manager.submit({ type: 'bug', title: 'b', description: 'd', agentName: 't', instarVersion: '0.1.0', nodeVersion: 'v20.0.0', os: 'darwin arm64' });

      global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 429, headers: { get: (h: string) => (h.toLowerCase() === 'retry-after' ? '120' : null) } });
      await manager.retryUnforwarded();
      // Inside the 120s window the next cycle must not POST.
      const fm = vi.fn().mockResolvedValue({ ok: true, status: 200, headers: { get: () => null } });
      global.fetch = fm;
      await manager.retryUnforwarded();
      expect(fm).not.toHaveBeenCalled();

      global.fetch = originalFetch;
    });

    it('does not retry when feedback is disabled', async () => {
      const disabledConfig: FeedbackConfig = {
        enabled: false,
        webhookUrl: 'https://example.com/feedback',
        feedbackFile,
      };
      const disabledManager = new FeedbackManager(disabledConfig);

      const result = await disabledManager.retryUnforwarded();
      expect(result).toEqual({ retried: 0, succeeded: 0 });
    });
  });
});

/**
 * Tier-1 unit — the attention lifecycle pass runs on a SEND-ONLY adapter.
 *
 * Bug (after PR 2361): the boot + hourly lifecycle timers were armed only by
 * TelegramAdapter.start() (the long-polling path). Every server whose lifeline
 * holds the poll lease boots send-only and never calls start(), so no pass
 * ever ran automatically. startSendOnlyMaintenance() arms the same timers.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const MIN = 60_000;

describe('attention lifecycle on a send-only adapter', () => {
  let adapter: TelegramAdapter;
  let tmpDir: string;

  function makeAdapter(): { calls: string[] } {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-attn-sendonly-'));
    adapter = new TelegramAdapter({ token: 'test-token-123', chatId: '-100123456', pollIntervalMs: 100, getAttentionHubTopicId: () => 4242 }, tmpDir);
    const calls: string[] = [];
    vi.spyOn(adapter as unknown as { apiCall: (m: string, p: Record<string, unknown>) => Promise<unknown> }, 'apiCall')
      .mockImplementation(async (method) => { calls.push(method); return { ok: true, message_id: 1, message_thread_id: 9999 }; });
    return { calls };
  }

  afterEach(async () => {
    await adapter.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'attention-lifecycle send-only test cleanup' });
  });

  it('a send-only adapter without startSendOnlyMaintenance runs no pass (the bug, both sides of the boundary)', () => {
    vi.useFakeTimers();
    makeAdapter();
    const pass = vi.spyOn(adapter, 'runAttentionLifecyclePass');
    vi.advanceTimersByTime(130 * MIN);
    expect(pass).not.toHaveBeenCalled();
    expect(adapter.attentionLifecycleTimersRunning).toBe(false);
  });

  it('runs the boot pass at 2 minutes and then every hour, without ever polling', () => {
    vi.useFakeTimers();
    const { calls } = makeAdapter();
    const pass = vi.spyOn(adapter, 'runAttentionLifecyclePass');
    adapter.startSendOnlyMaintenance();
    expect(adapter.isPolling).toBe(false);
    expect(adapter.attentionLifecycleTimersRunning).toBe(true);
    vi.advanceTimersByTime(2 * MIN - 1);
    expect(pass).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(1);
    expect(pass).toHaveBeenCalledTimes(1); // boot pass
    vi.advanceTimersByTime(58 * MIN);
    expect(pass).toHaveBeenCalledTimes(2); // first hourly pass at 60 min
    vi.advanceTimersByTime(60 * MIN);
    expect(pass).toHaveBeenCalledTimes(3);
    expect(calls).not.toContain('getUpdates');
    expect(adapter.getAttentionLifecycleStatus().lastSweepAt).toBeTruthy();
  });

  it('is idempotent: a second call and a later start() never add a second timer', async () => {
    vi.useFakeTimers();
    makeAdapter();
    const pass = vi.spyOn(adapter, 'runAttentionLifecyclePass');
    adapter.startSendOnlyMaintenance();
    adapter.startSendOnlyMaintenance();
    // Stub the polling loop itself so start() only does its setup.
    vi.spyOn(adapter as unknown as { poll: () => void }, 'poll').mockImplementation(() => {});
    await adapter.start();
    vi.advanceTimersByTime(2 * MIN);
    expect(pass).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(58 * MIN);
    expect(pass).toHaveBeenCalledTimes(2);
  });

  it('stop() clears the timers it armed', async () => {
    vi.useFakeTimers();
    makeAdapter();
    const pass = vi.spyOn(adapter, 'runAttentionLifecyclePass');
    adapter.startSendOnlyMaintenance();
    await adapter.stop();
    expect(adapter.attentionLifecycleTimersRunning).toBe(false);
    vi.advanceTimersByTime(130 * MIN);
    expect(pass).not.toHaveBeenCalled();
  });
});

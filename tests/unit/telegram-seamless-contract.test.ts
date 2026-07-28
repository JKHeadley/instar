/**
 * Channel Seamlessness Contract conformance — Telegram reference adapter (spec §).
 * dedupeKey stability, getIngressPosition shape, stopConsuming returns the durable
 * position, resumeConsuming restores the offset without replaying.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('TelegramAdapter — Channel Seamlessness Contract', () => {
  let adapter: TelegramAdapter;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-tg-contract-'));
    adapter = new TelegramAdapter({ token: 't', chatId: '-100123456', pollIntervalMs: 100 }, tmpDir);
  });
  afterEach(async () => {
    await adapter.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/telegram-seamless-contract.test.ts' });
  });

  it('implements all four contract methods', () => {
    expect(typeof adapter.dedupeKey).toBe('function');
    expect(typeof adapter.getIngressPosition).toBe('function');
    expect(typeof adapter.stopConsuming).toBe('function');
    expect(typeof adapter.resumeConsuming).toBe('function');
  });

  it('dedupeKey is stable for the same update_id and distinct across updates', () => {
    expect(adapter.dedupeKey!({ update_id: 555 })).toBe('telegram:555');
    expect(adapter.dedupeKey!({ update_id: 555 })).toBe(adapter.dedupeKey!({ update_id: 555 }));
    expect(adapter.dedupeKey!({ update_id: 556 })).not.toBe(adapter.dedupeKey!({ update_id: 555 }));
  });

  it('dedupeKey falls back to normalized message metadata', () => {
    expect(adapter.dedupeKey!({ metadata: { update_id: 777 }, id: 'x' })).toBe('telegram:777');
  });

  it('getIngressPosition reports the telegram offset', () => {
    const pos = adapter.getIngressPosition!();
    expect(pos.platform).toBe('telegram');
    expect(typeof pos.cursor).toBe('number');
    expect(pos.capturedAt).toBeTruthy();
  });

  it('stopConsuming returns the durable position and resumeConsuming restores it (no replay)', async () => {
    const pos = await adapter.stopConsuming!();
    expect(pos.platform).toBe('telegram');
    expect(adapter.isPolling).toBe(false);
    // Resuming from a higher offset advances; never lowers below known (no replay).
    await adapter.resumeConsuming!({ platform: 'telegram', cursor: 12345, capturedAt: new Date().toISOString() });
    const after = adapter.getIngressPosition!();
    expect(Number(after.cursor)).toBeGreaterThanOrEqual(12345);
    await adapter.stop();
  });

  it('resumeConsuming rejects a wrong-platform position', async () => {
    await expect(
      adapter.resumeConsuming!({ platform: 'slack', cursor: 1, capturedAt: new Date().toISOString() }),
    ).rejects.toThrow(/wrong platform/);
  });
});

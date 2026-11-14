import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('topic names never send visible probes', () => {
  let dir: string;
  afterEach(() => { vi.restoreAllMocks(); SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'topic-name test cleanup' }); });

  it('keeps unknown names as fallback labels through startup and explicit lookup', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-name-'));
    const adapter = new TelegramAdapter({ token: 't', chatId: '-100123' } as never, dir, { suppressLifelineAutoCreate: true });
    (adapter as unknown as { topicToSession: Map<number, string> }).topicToSession.set(659199, 's-659199');
    const api = vi.spyOn(adapter as unknown as { apiCall: (...args: unknown[]) => Promise<unknown> }, 'apiCall');
    await adapter.resolveUnknownTopicNames();
    expect(await adapter.resolveTopicName(659199)).toBeNull();
    expect(api).not.toHaveBeenCalled();
    await adapter.stop();
  });
});

/**
 * Unit tests for the tokenless-standby outbound relay decision (bug #7).
 *
 * A multi-machine pool standby serving a moved session is tokenless: its bot
 * token is externalized and arrives UNRESOLVED as a non-string placeholder
 * (`{ secret: true }`), not null. The old `!this.config.token` check treated that
 * truthy object as "has a token" and attempted a doomed direct API send — the
 * moved session's reply 200'd internally but never reached Telegram. The fix
 * treats only a non-empty STRING as a usable token; anything else routes through
 * `outboundRelay` (which POSTs to the Telegram-owning router's /telegram/reply).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('TelegramAdapter — tokenless-standby relay decision (bug #7)', () => {
  let adapter: TelegramAdapter | undefined;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-relay-'));
  });

  afterEach(async () => {
    if (adapter) await adapter.stop();
    adapter = undefined;
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/telegram-tokenless-relay.test.ts' });
    vi.unstubAllGlobals();
  });

  function makeAdapter(token: unknown): TelegramAdapter {
    // token is intentionally non-string in the placeholder cases — that is the bug.
    return new TelegramAdapter({ token: token as string, chatId: '-1001' }, tmpDir);
  }

  it('relays when the bot token is an unresolved {secret:true} placeholder (the real standby bug)', async () => {
    adapter = makeAdapter({ secret: true });
    const relay = vi.fn().mockResolvedValue({ messageId: 99, topicId: 42 });
    adapter.outboundRelay = relay;
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    await adapter.sendToTopic(42, 'hello from the moved session');

    expect(relay).toHaveBeenCalledTimes(1);
    expect(relay).toHaveBeenCalledWith(42, 'hello from the moved session', expect.anything());
    expect(mockFetch).not.toHaveBeenCalled(); // never attempt a doomed direct API send
  });

  it('relays when the bot token is null (genuinely tokenless)', async () => {
    adapter = makeAdapter(null);
    const relay = vi.fn().mockResolvedValue({ messageId: 1, topicId: 42 });
    adapter.outboundRelay = relay;
    vi.stubGlobal('fetch', vi.fn());

    await adapter.sendToTopic(42, 'x');

    expect(relay).toHaveBeenCalledTimes(1);
  });

  it('sends DIRECTLY (no relay) when a real string token is present', async () => {
    adapter = makeAdapter('123456:realbottoken');
    const relay = vi.fn();
    adapter.outboundRelay = relay;
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 7 } }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await adapter.sendToTopic(42, 'direct send');

    expect(relay).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalled(); // real token → direct Telegram API call
  });
});

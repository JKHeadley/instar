import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('topic-name probes do not repeat refused sends every start', () => {
  let dir: string;
  afterEach(() => { vi.restoreAllMocks(); SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'probe-backoff test cleanup' }); });

  function adapterWith(topics: number[], api: (m: string, p: Record<string, unknown>) => Promise<unknown>) {
    const a = new TelegramAdapter({ token: 't', chatId: '-100123' } as never, dir, { suppressLifelineAutoCreate: true });
    const map = (a as unknown as { topicToSession: Map<number, string> }).topicToSession;
    for (const t of topics) map.set(t, `s-${t}`);
    const spy = vi.spyOn(a as unknown as { apiCall: typeof api }, 'apiCall').mockImplementation(api);
    return { a, spy };
  }

  it('never probes General, records a refusal, and skips that topic on the next start', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));
    const refuse = async () => { throw new Error('TelegramOriginHoldError: Telegram message held: telegram-400'); };
    const first = adapterWith([1, 659199], refuse);
    await first.a.resolveUnknownTopicNames();
    expect(first.spy.mock.calls.filter((c) => c[0] === 'sendMessage').map((c) => c[1].message_thread_id)).toEqual([659199]);
    await first.a.stop();
    const second = adapterWith([1, 659199], refuse);
    await second.a.resolveUnknownTopicNames();
    expect(second.spy).not.toHaveBeenCalled();
    await second.a.stop();
  });

  it('a transient failure is not recorded: the topic is probed again next start', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));
    const flaky = async () => { throw new Error('fetch failed'); };
    const first = adapterWith([135187], flaky);
    await first.a.resolveUnknownTopicNames();
    await first.a.stop();
    const second = adapterWith([135187], flaky);
    await second.a.resolveUnknownTopicNames();
    expect(second.spy.mock.calls.some((c) => c[0] === 'sendMessage')).toBe(true);
    await second.a.stop();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { observeTelegramSend } from '../../src/messaging/TelegramSendTiming.js';
import { telegramFetch } from '../../src/messaging/telegram-egress.js';
import { performance } from 'node:perf_hooks';
const capture = () => {
  const rows: Record<string, unknown>[] = [];
  vi.spyOn(console, 'info').mockImplementation(line => {
    if (String(line).startsWith('[telegram-send-timing] ')) rows.push(JSON.parse(String(line).slice('[telegram-send-timing] '.length)));
  });
  return rows;
};
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('Telegram send timing observations', () => {
  it('preserves response identity and an unread body; zero samples are unavailable', async () => {
    const rows = capture(), response = new Response('private text');
    expect(await observeTelegramSend(async () => response, 15000)).toBe(response);
    expect(response.bodyUsed).toBe(false);
    expect(rows.map(r => r.event)).toEqual(['start', 'headers']);
    expect(rows[1].id).toBe(rows[0].id);
    if (rows[1].samples === 0) expect(rows[1].eventLoopDelayMaxMs).toBeNull();
    expect(JSON.stringify(rows)).not.toContain('private text');
  });
  it('preserves error identity without printing exception messages or custom properties', async () => {
    const rows = capture(), error = Object.assign(new Error('TOKEN_AND_TEXT_SENTINEL'), { token: 'SECRET' });
    await expect(observeTelegramSend(async () => { throw error; })).rejects.toBe(error);
    expect(rows.map(r => r.event)).toEqual(['start', 'error']);
    expect(JSON.stringify(rows)).not.toMatch(/SENTINEL|SECRET/);
  });
  it('logging failures cannot replace either result or error', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => { throw new Error('broken logger'); });
    const response = new Response('ok'), error = new Error('original');
    expect(await observeTelegramSend(async () => response)).toBe(response);
    await expect(observeTelegramSend(async () => { throw error; })).rejects.toBe(error);
  });
  it('diagnostic clock failures preserve results and errors and release all probe slots', async () => {
    const rows = capture(), clock = vi.spyOn(performance, 'now');
    const response = new Response('clock-private'), error = new Error('original');
    clock.mockImplementationOnce(() => { throw new Error('start clock failed'); });
    const success = await observeTelegramSend(async () => response);
    expect(success).toBe(response);
    expect(rows.at(-1)?.elapsedMs).toBeNull();
    for (let n = 0; n < 18; n++) {
      await expect(observeTelegramSend(async () => {
        clock.mockImplementationOnce(() => { throw new Error('finish clock failed'); });
        throw error;
      })).rejects.toBe(error);
      expect(rows.at(-1)?.elapsedMs).toBeNull();
    }
    clock.mockRestore();
    await observeTelegramSend(async () => response);
    expect(rows.filter(row => row.event === 'start').every(row => row.sampled === true)).toBe(true);
  });
  it('caps native probes and releases slots after concurrent mixed outcomes', async () => {
    const rows = capture(), finish: (() => void)[] = [];
    const pending = Array.from({ length: 20 }, (_, i) => observeTelegramSend(() => new Promise<void>((resolve, reject) => {
      finish.push(() => i % 2 ? resolve() : reject(new Error('fixture')));
    })));
    const settled = Promise.allSettled(pending);
    expect(rows.filter(r => r.event === 'start' && r.sampled)).toHaveLength(16);
    for (const done of finish) done();
    await settled;
    expect(new Set(rows.filter(r => r.event === 'start').map(r => r.id)).size).toBe(20);
    expect(rows.filter(r => r.event !== 'start')).toHaveLength(20);
    await observeTelegramSend(async () => undefined);
    expect(rows.at(-2)?.sampled).toBe(true);
  });
  it('observes only visible sends, without changing an existing caller signal', async () => {
    const rows = capture(), response = new Response('{}'), caller = new AbortController();
    const f = vi.fn(async (_url: unknown, _init: RequestInit) => response); vi.stubGlobal('fetch', f);
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    expect(await telegramFetch('https://api.telegram.org/bot123:PRIVATE_TOKEN/sendMessage', {
      method: 'POST', body: JSON.stringify({ chat_id: 'PRIVATE_CHAT', text: 'PRIVATE_BODY', message_thread_id: 999123 }), signal: caller.signal,
    })).toBe(response);
    expect(f.mock.calls[0][1].signal).toBe(caller.signal);
    expect(timeout).not.toHaveBeenCalled();
    expect(rows.map(r => r.event)).toEqual(['start', 'headers']);
    expect(JSON.stringify(rows)).not.toMatch(/PRIVATE|999123/);
    rows.length = 0;
    await telegramFetch('https://api.telegram.org/bot123:PRIVATE_TOKEN/getUpdates', { networkTimeoutMs: 60000 });
    expect(timeout).toHaveBeenLastCalledWith(60000);
    expect(rows).toEqual([]);
  });
  it('does not observe a refused payload or invoke the network', async () => {
    const rows = capture(), f = vi.fn(); vi.stubGlobal('fetch', f);
    await expect(telegramFetch('https://api.telegram.org/bot123:fixture/sendMessage', {
      method: 'POST', body: JSON.stringify({ chat_id: 1, text: '\u200b' }), networkTimeoutMs: 15000,
    })).rejects.toThrow();
    expect(f).not.toHaveBeenCalled(); expect(rows).toEqual([]);
  });
  it('creates the original send deadline after start logging and composes caller cancellation', async () => {
    const rows = capture(), caller = new AbortController(), reason = new Error('PRIVATE_CALLER_REASON');
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      expect(rows.at(-1)?.event).toBe('start');
      return nativeTimeout(ms);
    });
    const f = vi.fn(async (_url: unknown, init: RequestInit) => {
      expect(init.signal).not.toBe(caller.signal);
      expect(init.signal?.aborted).toBe(false);
      caller.abort(reason);
      expect(init.signal?.reason).toBe(reason);
      throw reason;
    });
    vi.stubGlobal('fetch', f);
    await expect(telegramFetch('https://api.telegram.org/bot123:fixture/sendMessage', {
      method: 'POST', body: JSON.stringify({ chat_id: 1, text: 'An authorized report' }),
      signal: caller.signal, networkTimeoutMs: 15000,
    })).rejects.toBe(reason);
    expect(timeout).toHaveBeenCalledOnce(); expect(timeout).toHaveBeenCalledWith(15000);
    expect(rows.map(row => row.event)).toEqual(['start', 'error']);
    expect(JSON.stringify(rows)).not.toContain('PRIVATE_CALLER_REASON');
  });
});

/**
 * The conversation list's in-memory view of the Telegram log (fb-52447f16-7d3,
 * docs/specs/conversation-list-log-view.md). getTopicHistoryForList must answer exactly what
 * getTopicHistory (a real file read) answers; with the view ready it reads no file; without it, it
 * runs the old read immediately, never waits; and nothing but the list path ever reads the view.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const N = 60;
const OP = 'tests/unit/telegram-list-log-view.test.ts';
const at = (i: number) => new Date(1_700_000_000_000 + i * 1000).toISOString();
const make = (d: string) => new TelegramAdapter({ token: 'test-token', chatId: '-100123' }, d);
type Inner = { logView: Map<number, unknown[]> | null; topicTailCache: Map<number, unknown[]>; noteLogRotated(): void };

describe('Telegram log view', () => {
  let dir: string; let logPath: string; let adapter: TelegramAdapter; const extra: TelegramAdapter[] = [];
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-view-'));
    logPath = path.join(dir, 'telegram-messages.jsonl');
    const lines: string[] = []; let id = 1;
    for (let round = 0; round < 3; round++) for (let t = 1; t <= N; t++) {
      lines.push(JSON.stringify({ messageId: id, topicId: 1000 + t, text: `r${round} t${t}`, fromUser: round % 2 === 0, timestamp: at(id), sessionName: null })); id++;
    }
    lines.push(JSON.stringify({ messageId: id++, channelId: 1001, text: 'shared logger row', fromUser: false, timestamp: at(id), sessionName: null }));
    lines.push(JSON.stringify({ messageId: id++, channelId: '1002', text: 'string channel id: never this topic', fromUser: false, timestamp: at(id), sessionName: null }));
    lines.push('{not json');
    fs.writeFileSync(logPath, lines.join('\n') + '\n');
    adapter = make(dir);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await adapter.stop();
    for (const a of extra.splice(0)) await a.stop();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: OP });
  });

  const fileRead = (topicId: number, limit = 500) => { const fresh = make(dir); extra.push(fresh); return fresh.getTopicHistory(topicId, limit); };

  it('with the view ready, every topic answers exactly as the file read does, with no file read', async () => {
    const expected = Array.from({ length: N }, (_, i) => fileRead(1001 + i));
    expect(await adapter.loadHistory()).toBe(true);
    const reads = vi.spyOn(fs, 'readFileSync');
    for (let i = 0; i < N; i++) expect(adapter.getTopicHistoryForList(1001 + i, 500)).toEqual(expected[i]);
    expect(adapter.getTopicHistoryForList(424242, 5)).toEqual([]);
    expect(reads.mock.calls.filter((c) => String(c[0]) === logPath)).toHaveLength(0);
  });

  it('with the view not ready, the old read runs immediately (no wait) and a background build starts', async () => {
    const load = vi.spyOn(adapter, 'loadHistory');
    const reads = vi.spyOn(fs, 'readFileSync');
    const started = performance.now();
    const rows = adapter.getTopicHistoryForList(1003, 500); // synchronous: there is nothing to wait on
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(rows).toEqual(fileRead(1003));
    expect(reads.mock.calls.filter((c) => String(c[0]) === logPath).length).toBeGreaterThan(0);
    expect(load).toHaveBeenCalled();
  });

  it('other readers never use the view: getTopicHistory reads the file even when the view is ready', async () => {
    await adapter.loadHistory();
    const reads = vi.spyOn(fs, 'readFileSync');
    expect(adapter.getTopicHistory(1004, 500)).toEqual(fileRead(1004));
    expect(reads.mock.calls.filter((c) => String(c[0]) === logPath).length).toBeGreaterThan(0);
  });

  it('a row logged during or after the build appears once, in the shape a file read gives', async () => {
    const loading = adapter.loadHistory();
    adapter.logInboundMessage({ messageId: 9_000, topicId: 1002, text: 'during', timestamp: at(9_000) });
    await loading;
    adapter.logInboundMessage({ messageId: 9_001, topicId: 7777, text: 'after', timestamp: at(9_001) });
    (adapter as unknown as Inner).topicTailCache.clear();
    for (const id of [1002, 7777]) expect(adapter.getTopicHistoryForList(id, 500)).toEqual(fileRead(id));
  });

  it('after a rotation the view is dropped and rebuilt; until then the old read runs', async () => {
    await adapter.loadHistory();
    const kept = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean).filter((l) => !l.includes('"topicId":1060'));
    fs.writeFileSync(logPath, kept.join('\n') + '\n');
    (adapter as unknown as Inner).noteLogRotated();
    expect(adapter.isHistoryLoaded()).toBe(false);
    expect(adapter.getTopicHistoryForList(1060, 5)).toEqual([]);
    await adapter.loadHistory();
    expect(adapter.isHistoryLoaded()).toBe(true);
    expect(adapter.getTopicHistoryForList(1060, 5)).toEqual([]);
  });

  it('injected: an append onto a torn last line drops the view, so the list matches the file', async () => {
    fs.appendFileSync(logPath, '{"messageId":8000,"topicId":1005,"text":"torn');
    await adapter.loadHistory();
    adapter.logInboundMessage({ messageId: 8001, topicId: 1005, text: 'joined the torn line', timestamp: at(8001) });
    expect(adapter.isHistoryLoaded()).toBe(false);
    await adapter.loadHistory();
    (adapter as unknown as Inner).topicTailCache.clear();
    expect(adapter.getTopicHistoryForList(1005, 500)).toEqual(fileRead(1005));
  });

  it('injected: an append that fails part-way drops the view, so a message is never visible only in memory', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await adapter.loadHistory();
    const realAppend = fs.appendFileSync.bind(fs);
    const spy = vi.spyOn(fs, 'appendFileSync').mockImplementationOnce(((file: fs.PathOrFileDescriptor, data: string | Uint8Array) => {
      realAppend(file, String(data).slice(0, 25));
      throw new Error('disk full');
    }) as typeof fs.appendFileSync);
    adapter.logInboundMessage({ messageId: 8400, topicId: 1009, text: 'partly written', timestamp: at(8400) });
    spy.mockRestore();
    adapter.logInboundMessage({ messageId: 8401, topicId: 1009, text: 'lands on the broken line', timestamp: at(8401) });
    await adapter.loadHistory();
    (adapter as unknown as Inner).topicTailCache.clear();
    expect(adapter.getTopicHistoryForList(1009, 500)).toEqual(fileRead(1009));
    expect(adapter.getTopicHistoryForList(1009, 500).some((r) => r.messageId === 8401)).toBe(false);
  });

  it('injected: a rotation while the build closes its file is read again in the same build', async () => {
    const real = fs.promises.open.bind(fs.promises);
    let rotated = false;
    vi.spyOn(fs.promises, 'open').mockImplementation((async (...a: Parameters<typeof fs.promises.open>) => {
      const fh = await real(...a); const close = fh.close.bind(fh);
      (fh as unknown as { close: unknown }).close = async () => {
        if (!rotated) {
          rotated = true;
          const kept = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean).filter((l) => !l.includes('"topicId":1059'));
          fs.writeFileSync(logPath, kept.join('\n') + '\n');
          (adapter as unknown as Inner).noteLogRotated();
        }
        await close();
      };
      return fh;
    }) as typeof fs.promises.open);
    expect(await adapter.loadHistory()).toBe(true);
    expect(adapter.isHistoryLoaded()).toBe(true);
    expect(adapter.getTopicHistoryForList(1059, 5)).toEqual([]);
  });

  it('an append landing while the build closes its file is in the published view', async () => {
    const real = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation((async (...a: Parameters<typeof fs.promises.open>) => {
      const fh = await real(...a); const close = fh.close.bind(fh);
      (fh as unknown as { close: unknown }).close = async () => { adapter.logInboundMessage({ messageId: 8300, topicId: 1008, text: 'during close', timestamp: at(8300) }); await close(); };
      return fh;
    }) as typeof fs.promises.open);
    await adapter.loadHistory();
    expect(adapter.getTopicHistoryForList(1008, 1)[0].text).toBe('during close');
  });

  it('non-row JSON lines and malformed ids cannot stop the build', async () => {
    fs.appendFileSync(logPath, 'null\n42\n' + JSON.stringify({ messageId: { toString: null }, topicId: 1006, text: 'odd', fromUser: false, timestamp: at(8100) }) + '\n');
    expect(await adapter.loadHistory()).toBe(true);
    (adapter as unknown as Inner).topicTailCache.clear();
    expect(adapter.getTopicHistoryForList(1006, 500)).toEqual(fileRead(1006));
  });

  it('a failed build publishes nothing, the list keeps the old read, and the next build waits (braked)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const real = fs.promises.open.bind(fs.promises);
    const spy = vi.spyOn(fs.promises, 'open').mockRejectedValue(Object.assign(new Error('read failed'), { code: 'EIO' }));
    expect(await adapter.loadHistory()).toBe(false);
    expect(adapter.isHistoryLoaded()).toBe(false);
    expect(adapter.getTopicHistoryForList(1003, 500)).toEqual(fileRead(1003));
    spy.mockClear();
    for (let i = 0; i < 5; i++) adapter.getTopicHistoryForList(1004, 1);
    expect(spy).not.toHaveBeenCalled();
    spy.mockImplementation(real as typeof fs.promises.open);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6_000);
    expect(await adapter.loadHistory()).toBe(true);
  });

  it('the off switch returns the list to the old read and drops the view', async () => {
    await adapter.loadHistory();
    let on = true;
    adapter.setHistoryViewSwitch(() => on);
    on = false;
    const reads = vi.spyOn(fs, 'readFileSync');
    expect(adapter.isHistoryLoaded()).toBe(false);
    expect(adapter.getTopicHistoryForList(1003, 1)[0].text).toBe('r2 t3');
    expect(reads.mock.calls.filter((c) => String(c[0]) === logPath).length).toBeGreaterThan(0);
    expect(await adapter.loadHistory()).toBe(false);
    on = true;
    expect(await adapter.loadHistory()).toBe(true);
  });

  it('the build is single flight, and a missing log is simply empty', async () => {
    const spy = vi.spyOn(fs.promises, 'open');
    await Promise.all([adapter.loadHistory(), adapter.loadHistory()]);
    expect(spy.mock.calls.filter((c) => String(c[0]) === logPath)).toHaveLength(1);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-view-empty-'));
    const a = make(empty); extra.push(a);
    expect(await a.loadHistory()).toBe(true);
    expect(a.getTopicHistoryForList(1, 5)).toEqual([]);
    SafeFsExecutor.safeRmSync(empty, { recursive: true, force: true, operation: OP });
  });
});

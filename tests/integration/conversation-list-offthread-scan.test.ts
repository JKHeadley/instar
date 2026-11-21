/**
 * docs/specs/conversation-list-offthread-scan.md through the real HTTP routes: the conversation list
 * and a chat opened before any list read the Telegram log off the main thread (no synchronous read of
 * the log) and answer exactly what the old synchronous read answers; concurrent lists share one scan;
 * and the live switch `telegramHistoryScan.offMainThread: false` returns both to the old read.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { startOffthreadScanServer, setOffMainThread, type OffthreadScanServer } from '../helpers/offthreadScanServer.js';

const N = 40;
let s: OffthreadScanServer;
beforeAll(async () => { s = await startOffthreadScanServer({ topics: N, perTopic: 30, padBytes: 120, label: 'clist-offthread-int' }); });
afterAll(async () => { await s.close(); });
afterEach(() => { vi.restoreAllMocks(); setOffMainThread(s, undefined); });

type Row = { platform: string; id: number; lastPreview: string | null; lastActivity: string | null };
const telegramRows = (body: { conversations: Row[] }) => body.conversations.filter((c) => c.platform === 'telegram');
const spyLog = () => {
  const reads = vi.spyOn(fs, 'readFileSync');
  const opens = vi.spyOn(fs.promises, 'open');
  return {
    syncReads: () => reads.mock.calls.filter((c) => String(c[0]) === s.logPath).length,
    asyncOpens: () => opens.mock.calls.filter((c) => String(c[0]) === s.logPath).length,
  };
};

describe('conversation list and first chat read — off the main thread', () => {
  it('switched off, the list reads the log the old way; switched on (the default), it answers the same with no synchronous read', async () => {
    setOffMainThread(s, false);
    s.coldCache();
    let spy = spyLog();
    const old = await s.list();
    expect(old.status).toBe(200);
    expect(spy.syncReads()).toBeGreaterThan(0);
    expect(spy.asyncOpens()).toBe(0);
    vi.restoreAllMocks();

    setOffMainThread(s, undefined); // absent = on
    s.coldCache();
    spy = spyLog();
    const now = await s.list();
    expect(now.status).toBe(200);
    expect(spy.syncReads()).toBe(0);
    expect(spy.asyncOpens()).toBe(1);
    expect(telegramRows(now.body)).toHaveLength(N);
    expect(telegramRows(now.body)).toEqual(telegramRows(old.body));
    expect(now.body.conversations).toEqual(old.body.conversations);
  });

  it('switched back off live (no restart), the next cold list uses the old read again', async () => {
    setOffMainThread(s, true);
    s.coldCache();
    await s.list();
    setOffMainThread(s, false);
    s.coldCache();
    const spy = spyLog();
    expect((await s.list()).status).toBe(200);
    expect(spy.asyncOpens()).toBe(0);
    expect(spy.syncReads()).toBeGreaterThan(0);
  });

  it('concurrent cold lists share one scan', async () => {
    s.coldCache();
    const before = (s.telegram as unknown as { tailWarmScans: number }).tailWarmScans;
    const spy = spyLog();
    const [a, b, c] = await Promise.all([s.list(), s.list(), s.list()]);
    for (const r of [a, b, c]) { expect(r.status).toBe(200); expect(telegramRows(r.body)).toHaveLength(N); }
    expect((s.telegram as unknown as { tailWarmScans: number }).tailWarmScans - before).toBe(1);
    expect(spy.asyncOpens()).toBe(1);
    expect(spy.syncReads()).toBe(0);
  });

  it('a chat opened before any list waits on the scan instead of a synchronous read, and shows the same messages', async () => {
    setOffMainThread(s, false);
    s.coldCache();
    const old = await s.chat(7003);
    expect(old.status).toBe(200);
    expect(old.body.messages.length).toBe(30);
    setOffMainThread(s, undefined);
    s.coldCache();
    const spy = spyLog();
    const now = await s.chat(7003);
    expect(now.status).toBe(200);
    expect(spy.syncReads()).toBe(0);
    expect(spy.asyncOpens()).toBe(1);
    expect(now.body.messages).toEqual(old.body.messages);
  });

  it('switched off, a cold chat read uses the old read', async () => {
    setOffMainThread(s, false);
    s.coldCache();
    const spy = spyLog();
    expect((await s.chat(7005)).status).toBe(200);
    expect(spy.asyncOpens()).toBe(0);
    expect(spy.syncReads()).toBeGreaterThan(0);
  });
});

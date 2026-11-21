/**
 * GET /mobile/conversations over the real HTTP pipeline with a real TelegramAdapter
 * (docs/specs/main-loop-freeze-conversation-list.md). A cold list pages losslessly in activity order
 * without a synchronous log read, chats open and scroll back without one, and when history cannot
 * be read the list says "try again" instead of scanning or hanging.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import http from 'node:http';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';

const N = 120;
const cleanup: Array<() => Promise<void> | void> = [];
afterAll(async () => { for (const c of cleanup.reverse()) await c(); });

async function boot(opts: { peerUrls?: string[]; config?: Record<string, unknown> } = {}) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'clist-int-'));
  cleanup.push(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/conversation-list-no-log-scan.test.ts' }));
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  await new MachineIdentityManager(stateDir).generateIdentity({ name: 'integration machine' });
  const logPath = path.join(stateDir, 'telegram-messages.jsonl');
  const rows: string[] = []; let id = 1;
  for (let t = 1; t <= N; t++) for (let k = 0; k < 4; k++, id++) rows.push(JSON.stringify({ messageId: id, topicId: 5000 + t, text: `msg ${k} in ${t}`, fromUser: k % 2 === 0, timestamp: new Date(1_700_000_000_000 + id * 1000).toISOString(), sessionName: null }));
  fs.writeFileSync(logPath, rows.join('\n') + '\n');
  const telegram = new TelegramAdapter({ token: 'test-token', chatId: '-100123' }, stateDir);
  cleanup.push(() => telegram.stop());
  for (let t = 1; t <= N; t++) { telegram.registerTopicSession(5000 + t, `s-${t}`, `Planning notes ${t}`); telegram.unregisterTopic(5000 + t); }
  const config = {
    projectName: 'clist-int', projectDir: dir, stateDir, port: 0, authToken: 'tok-1', developmentAgent: true, mobilePairing: { multiRoute: { enabled: false } },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {}, threadline: { ownerName: 'Justin' }, ...(opts.config ?? {}),
  } as unknown as InstarConfig;
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  const resolvePeerUrls = () => (opts.peerUrls ?? []).map((url, i) => ({ machineId: `m_peer${i}`, url, kind: 'lan' }));
  const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), telegram, resolvePeerUrls, meshSelfId: 'm1' } as never);
  cleanup.push(() => server.stop());
  return { server, telegram, logPath };
}

describe('GET /mobile/conversations with many closed Telegram topics', () => {
  it('a cold list pages every topic once, newest first, with no synchronous log read', async () => {
    const e = await boot();
    const reads = vi.spyOn(fs, 'readFileSync');
    try {
      const seen: number[] = []; let cursor: string | null = null;
      for (let page = 0; page < 10; page++) {
        const r = await request(e.server.getApp()).get(`/mobile/conversations?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`).set('Authorization', 'Bearer tok-1').set('X-Instar-AgentId', 'clist-int');
        expect(r.status).toBe(200);
        seen.push(...r.body.conversations.filter((c: { platform: string }) => c.platform === 'telegram').map((c: { id: number }) => c.id));
        cursor = r.body.nextCursor ?? null;
        if (!cursor) break;
      }
      expect(seen).toEqual(Array.from({ length: N }, (_, i) => 5000 + N - i));
      expect(reads.mock.calls.filter((c) => String(c[0]) === e.logPath)).toHaveLength(0);
    } finally { reads.mockRestore(); }
  });

  it('opening a chat and scrolling back never read the whole log synchronously', async () => {
    const e = await boot();
    const reads = vi.spyOn(fs, 'readFileSync');
    const syncScrollBack = vi.spyOn(e.telegram, 'getTopicHistoryBefore');
    try {
      const auth = (q: request.Test) => q.set('Authorization', 'Bearer tok-1').set('X-Instar-AgentId', 'clist-int');
      const chat = await auth(request(e.server.getApp()).get('/telegram/topics/5001/messages?limit=2'));
      expect(chat.status).toBe(200);
      expect(chat.body.messages.map((m: { text: string }) => m.text)).toEqual(['msg 2 in 1', 'msg 3 in 1']);
      const first = chat.body.messages[0];
      const back = await auth(request(e.server.getApp()).get(`/telegram/topics/5001/messages?limit=2&before=${encodeURIComponent(first.timestamp)}&beforeMessageId=${first.messageId}`));
      expect(back.body.messages.map((m: { text: string }) => m.text)).toEqual(['msg 0 in 1', 'msg 1 in 1']);
      expect(reads.mock.calls.filter((c) => String(c[0]) === e.logPath)).toHaveLength(0);
      expect(syncScrollBack).not.toHaveBeenCalled();
    } finally { reads.mockRestore(); syncScrollBack.mockRestore(); }
  });

  it('injected: when the view cannot be rebuilt after a trim, chats and the list answer from the file, as the old code does', async () => {
    const e = await boot();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const auth = (q: request.Test) => q.set('Authorization', 'Bearer tok-1').set('X-Instar-AgentId', 'clist-int');
    expect(await e.telegram.loadHistory()).toBe(true);
    // A trim: the file loses topic 5001's rows, then the view's rebuild fails to read it.
    const kept = fs.readFileSync(e.logPath, 'utf-8').split('\n').filter(Boolean).filter((l) => !l.includes('"topicId":5001,'));
    fs.writeFileSync(e.logPath, kept.join('\n') + '\n');
    const open = vi.spyOn(fs.promises, 'open').mockRejectedValue(Object.assign(new Error('simulated read failure'), { code: 'EIO' }));
    (e.telegram as unknown as { noteLogRotated(): void }).noteLogRotated();
    const chat = await auth(request(e.server.getApp()).get('/telegram/topics/5002/messages?limit=2'));
    expect(chat.status).toBe(200);
    expect(chat.body.messages.map((m: { text: string }) => m.text)).toEqual(['msg 2 in 2', 'msg 3 in 2']);
    const trimmed = await auth(request(e.server.getApp()).get('/telegram/topics/5001/messages?limit=2'));
    expect(trimmed.status).toBe(200);
    expect(trimmed.body.messages).toEqual([]); // what the file now holds, as a file read returns
    const list = await auth(request(e.server.getApp()).get('/mobile/conversations?limit=200'));
    expect(list.status).toBe(200);
    const rows = list.body.conversations.filter((c: { platform: string }) => c.platform === 'telegram');
    expect(rows).toHaveLength(N);
    expect(rows.find((r: { id: number }) => r.id === 5000 + N)?.lastPreview).toBe(`msg 3 in ${N}`);
    expect(e.telegram.isHistoryLoaded()).toBe(false);
    open.mockRestore();
  });

  it('injected: a persistent rebuild failure does not rebuild on every request', async () => {
    const e = await boot();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const open = vi.spyOn(fs.promises, 'open').mockRejectedValue(Object.assign(new Error('simulated read failure'), { code: 'EIO' }));
    const auth = (q: request.Test) => q.set('Authorization', 'Bearer tok-1').set('X-Instar-AgentId', 'clist-int');
    for (let i = 0; i < 10; i++) {
      const r = await auth(request(e.server.getApp()).get('/telegram/topics/5003/messages?limit=1'));
      expect(r.status).toBe(200);
      expect(r.body.messages.map((m: { text: string }) => m.text)).toEqual(['msg 3 in 3']);
    }
    const attempts = open.mock.calls.filter((c) => String(c[0]) === e.logPath).length;
    expect(attempts).toBe(1); // braked: the next rebuild waits 5 s, doubling to 5 min
    open.mockRestore();
  });

  it('injected: a peer still loading its history is reported as loading, never as off', async () => {
    const peer = http.createServer((_req, res) => { res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '5' }); res.end(JSON.stringify({ error: 'conversations-loading', retryable: true })); });
    const off = http.createServer((_req, res) => { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'native-conversations-off' })); });
    await Promise.all([new Promise<void>((r) => peer.listen(0, '127.0.0.1', r)), new Promise<void>((r) => off.listen(0, '127.0.0.1', r))]);
    cleanup.push(() => { peer.close(); off.close(); });
    const url = (s: http.Server) => `http://127.0.0.1:${(s.address() as { port: number }).port}`;
    const e = await boot({ peerUrls: [url(peer), url(off)] });
    const r = await request(e.server.getApp()).get('/mobile/conversations?scope=pool').set('Authorization', 'Bearer tok-1').set('X-Instar-AgentId', 'clist-int');
    expect(r.status).toBe(200);
    const failed = Object.fromEntries(r.body.pool.failed.map((f: { machineId: string; reason: string }) => [f.machineId, f.reason]));
    expect(failed).toEqual({ m_peer0: 'loading', m_peer1: 'off' });
  });

  it('with telegramHistoryView.enabled false the list takes the old read path', async () => {
    const e = await boot({ config: { telegramHistoryView: { enabled: false } } });
    const reads = vi.spyOn(fs, 'readFileSync');
    try {
      const r = await request(e.server.getApp()).get('/mobile/conversations?limit=5').set('Authorization', 'Bearer tok-1').set('X-Instar-AgentId', 'clist-int');
      expect(r.status).toBe(200);
      expect(r.body.conversations[0]).toMatchObject({ id: 5000 + N, lastPreview: `msg 3 in ${N}` });
      expect(reads.mock.calls.filter((c) => String(c[0]) === e.logPath).length).toBeGreaterThan(0);
      expect(e.telegram.isHistoryLoaded()).toBe(false);
    } finally { reads.mockRestore(); }
  });
});

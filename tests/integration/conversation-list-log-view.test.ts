/**
 * GET /mobile/conversations over the real HTTP pipeline with a real TelegramAdapter
 * (docs/specs/conversation-list-log-view.md). With the in-memory log view ready, a cold list pages
 * every topic in order without one synchronous log read. Without it, the list runs the old read
 * immediately, with no wait, and answers the same rows. The off switch returns it to the old read.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
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

async function boot(opts: { peerUrls?: string[]; config?: Record<string, unknown>; live?: number[]; base?: number } = {}) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'clist-int-'));
  cleanup.push(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/conversation-list-no-log-scan.test.ts' }));
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  await new MachineIdentityManager(stateDir).generateIdentity({ name: 'integration machine' });
  const logPath = path.join(stateDir, 'telegram-messages.jsonl');
  const rows: string[] = []; let id = 1;
  const B = opts.base ?? 5000;
  for (let t = 1; t <= N; t++) for (let k = 0; k < 4; k++, id++) rows.push(JSON.stringify({ messageId: id, topicId: B + t, text: `msg ${k} in ${t}`, fromUser: k % 2 === 0, timestamp: new Date(1_700_000_000_000 + id * 1000).toISOString(), sessionName: null }));
  fs.writeFileSync(logPath, rows.join('\n') + '\n');
  const telegram = new TelegramAdapter({ token: 'test-token', chatId: '-100123' }, stateDir);
  cleanup.push(() => telegram.stop());
  for (let t = 1; t <= N; t++) { telegram.registerTopicSession(B + t, `s-${t}`, `Planning notes ${t}`); if (!opts.live?.includes(B + t)) telegram.unregisterTopic(B + t); }
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
  const list = (e: Awaited<ReturnType<typeof boot>>, q: string) => request(e.server.getApp()).get(`/mobile/conversations${q}`).set('Authorization', 'Bearer tok-1').set('X-Instar-AgentId', 'clist-int');

  it('with the view ready, a cold list pages every topic once, newest first, with no synchronous log read', async () => {
    const e = await boot();
    expect(await e.telegram.loadHistory()).toBe(true);
    const reads = vi.spyOn(fs, 'readFileSync');
    try {
      const seen: number[] = []; let cursor: string | null = null;
      for (let page = 0; page < 10; page++) {
        const r = await list(e, `?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        expect(r.status).toBe(200);
        seen.push(...r.body.conversations.filter((c: { platform: string }) => c.platform === 'telegram').map((c: { id: number }) => c.id));
        cursor = r.body.nextCursor ?? null;
        if (!cursor) break;
      }
      expect(seen).toEqual(Array.from({ length: N }, (_, i) => 5000 + N - i));
      expect(reads.mock.calls.filter((c) => String(c[0]) === e.logPath)).toHaveLength(0);
    } finally { reads.mockRestore(); }
  });

  it('injected: with the view unavailable (its build failing), the list runs the old read immediately and answers every row', async () => {
    const e = await boot();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(fs.promises, 'open').mockRejectedValue(Object.assign(new Error('simulated read failure'), { code: 'EIO' }));
    expect(await e.telegram.loadHistory()).toBe(false);
    const reads = vi.spyOn(fs, 'readFileSync');
    const started = Date.now();
    const r = await list(e, '?limit=200');
    expect(Date.now() - started).toBeLessThan(5_000); // no wait for a view that is not coming
    expect(r.status).toBe(200);
    const rows = r.body.conversations.filter((c: { platform: string }) => c.platform === 'telegram');
    expect(rows).toHaveLength(N);
    expect(rows[0]).toMatchObject({ id: 5000 + N, lastPreview: `msg 3 in ${N}` });
    expect(reads.mock.calls.filter((c) => String(c[0]) === e.logPath).length).toBeGreaterThan(0); // the old read
  });

  it('injected: with the view still building (hung), the list does not wait for it', async () => {
    const e = await boot();
    vi.spyOn(fs.promises, 'open').mockImplementation((() => new Promise(() => undefined)) as unknown as typeof fs.promises.open);
    void e.telegram.loadHistory();
    const started = Date.now();
    const r = await list(e, '?limit=5');
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(r.status).toBe(200);
    expect(r.body.conversations[0]).toMatchObject({ id: 5000 + N, lastPreview: `msg 3 in ${N}` });
  });

  it('with telegramHistoryView.enabled false the list takes the old read path', async () => {
    const e = await boot({ config: { telegramHistoryView: { enabled: false } } });
    await e.telegram.loadHistory();
    const reads = vi.spyOn(fs, 'readFileSync');
    try {
      const r = await list(e, '?limit=5');
      expect(r.status).toBe(200);
      expect(r.body.conversations[0]).toMatchObject({ id: 5000 + N, lastPreview: `msg 3 in ${N}` });
      expect(reads.mock.calls.filter((c) => String(c[0]) === e.logPath).length).toBeGreaterThan(0);
      expect(e.telegram.isHistoryLoaded()).toBe(false);
    } finally { reads.mockRestore(); }
  });
});

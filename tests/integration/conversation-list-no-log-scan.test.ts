/**
 * GET /mobile/conversations over the real HTTP pipeline with a real TelegramAdapter
 * (docs/specs/main-loop-freeze-conversation-list.md). A cold list pages losslessly in activity order
 * without a synchronous log read, and a background reader gets the list's explicit partial answer
 * while the load runs instead of scanning the log.
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
import { localConversationListPage } from '../../src/server/mobileConversationRoutes.js';

const N = 120;
const cleanup: Array<() => Promise<void> | void> = [];
afterAll(async () => { for (const c of cleanup.reverse()) await c(); });

async function boot() {
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
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {}, threadline: { ownerName: 'Justin' },
  } as unknown as InstarConfig;
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), telegram } as never);
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

  it('a background reader during the load gets an explicit partial answer, then the full list', async () => {
    const e = await boot();
    const loading = e.telegram.ensureAllTopicTailsLoaded();
    expect(e.telegram.topicTailsLoadState()).toBe('loading');
    const throwing = { service: { store: { listConversations: () => ({ conversations: [], nextCursor: null }) } }, telegramTopics: () => { if (e.telegram.topicTailsLoadState() === 'loading') throw new Error('telegram-history-loading'); return []; } };
    expect(localConversationListPage(throwing as never, 10, null).partial).toBe(true);
    await loading;
    expect(localConversationListPage(throwing as never, 10, null).partial).toBe(false);
  });
});

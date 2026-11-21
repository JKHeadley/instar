/**
 * Feature-is-alive proof for docs/specs/main-loop-freeze-conversation-list.md: an AgentServer built
 * through its production constructor with a real TelegramAdapter answers the conversation list for
 * many closed topics with zero synchronous reads of the Telegram log (the old code read it once per
 * topic), with each topic's real newest message, and the unread source is wired to the same tails.
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
import { wireReadMarkerStore } from '../../src/core/ConversationReadMarkersWiring.js';

const N = 80;
const cleanup: Array<() => Promise<void> | void> = [];
afterAll(async () => { for (const c of cleanup.reverse()) await c(); });

describe('conversation list — production wiring', () => {
  it('lists every closed topic with no synchronous log read, and concurrent cold requests share one load', async () => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'clist-e2e-'));
    cleanup.push(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/conversation-list-no-log-scan-alive.test.ts' }));
    const stateDir = path.join(dir, '.instar');
    for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
    await new MachineIdentityManager(stateDir).generateIdentity({ name: 'e2e machine' });
    const logPath = path.join(stateDir, 'telegram-messages.jsonl');
    const lines: string[] = []; let id = 1;
    for (let t = 1; t <= N; t++) for (let k = 0; k < 3; k++, id++) lines.push(JSON.stringify({ messageId: id, topicId: 7000 + t, text: `note ${k} for ${t}`, fromUser: k === 0, timestamp: new Date(1_700_000_000_000 + id * 1000).toISOString(), sessionName: null }));
    fs.writeFileSync(logPath, lines.join('\n') + '\n');
    const telegram = new TelegramAdapter({ token: 'test-token', chatId: '-100123' }, stateDir);
    cleanup.push(() => telegram.stop());
    for (let t = 1; t <= N; t++) { telegram.registerTopicSession(7000 + t, `s-${t}`, `Planning notes ${t}`); telegram.unregisterTopic(7000 + t); }
    const config = {
      projectName: 'clist-e2e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token', developmentAgent: true,
      mobilePairing: { multiRoute: { enabled: false } },
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {}, threadline: { ownerName: 'Justin' },
    } as unknown as InstarConfig;
    const sessionManager = createMockSessionManager() as any;
    sessionManager.on = () => undefined;
    const readMarkers = wireReadMarkerStore({ stateDir, emitter: null, peerStreams: null, ownMachineId: null, report: () => undefined, removalEvidence: () => false });
    readMarkers.markCatchUpSettled();
    const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), telegram, readMarkers } as never);
    cleanup.push(() => server.stop());
    const list = () => request(server.getApp()).get('/mobile/conversations?limit=200').set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'clist-e2e');
    const reads = vi.spyOn(fs, 'readFileSync');
    const streams = vi.spyOn(fs, 'createReadStream');
    try {
      const [a, b] = await Promise.all([list(), list()]);
      for (const r of [a, b]) {
        expect(r.status).toBe(200);
        expect(r.body.partial ?? false).toBe(false);
        const tg = r.body.conversations.filter((c: { platform: string }) => c.platform === 'telegram');
        expect(tg).toHaveLength(N);
        expect(tg[0]).toMatchObject({ id: 7000 + N, lastPreview: `note 2 for ${N}` });
      }
      expect(streams.mock.calls.filter((c) => String(c[0]) === logPath)).toHaveLength(1);
      const unread = server.conversationUnread as unknown as { deps: { telegram: { history: (i: number, l: number) => Array<{ messageId: number }> } } };
      expect(unread.deps.telegram.history(7001, 100).map((r) => r.messageId)).toEqual([1, 2, 3]);
      expect(reads.mock.calls.filter((c) => String(c[0]) === logPath)).toHaveLength(0);
    } finally { reads.mockRestore(); streams.mockRestore(); }
  });
});

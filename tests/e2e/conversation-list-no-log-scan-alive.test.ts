/**
 * Feature-is-alive proof for docs/specs/main-loop-freeze-conversation-list.md: an AgentServer
 * booted through its production constructor with a REAL TelegramAdapter (history for many closed
 * topics) answers GET /mobile/conversations with every topic, reads the Telegram log zero times
 * synchronously while doing so (the 2026-11-21 Echo Studio freeze read it once per topic), and
 * shows each topic's newest message once the background index is built.
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
const servers: AgentServer[] = [];
const adapters: TelegramAdapter[] = [];
const dirs: string[] = [];

afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const a of adapters) await a.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/conversation-list-no-log-scan-alive.test.ts' });
});

describe('conversation list — production wiring never scans the Telegram log per topic', () => {
  it('lists every closed topic with zero synchronous log reads, previews arriving from the index', async () => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'clist-e2e-'));
    dirs.push(dir);
    const stateDir = path.join(dir, '.instar');
    for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
    await new MachineIdentityManager(stateDir).generateIdentity({ name: 'e2e machine' });

    // History from a previous server life; every session since closed.
    const writer = new TelegramAdapter({ token: 'test-token', chatId: '-100123' }, stateDir);
    let id = 1;
    for (let t = 1; t <= N; t++) {
      for (let k = 0; k < 3; k++, id++) writer.logInboundMessage({ messageId: id, topicId: 7000 + t, text: `note ${k} for ${t}`, timestamp: new Date(1_700_000_000_000 + id * 1000).toISOString() });
    }
    await writer.stop();
    const telegram = new TelegramAdapter({ token: 'test-token', chatId: '-100123' }, stateDir);
    adapters.push(telegram);
    for (let t = 1; t <= N; t++) { telegram.registerTopicSession(7000 + t, `s-${t}`, `Planning notes ${t}`); telegram.unregisterTopic(7000 + t); }
    const logPath = path.join(stateDir, 'telegram-messages.jsonl');
    expect(fs.existsSync(logPath)).toBe(true);

    const config = {
      projectName: 'clist-e2e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token', developmentAgent: true,
      mobilePairing: { multiRoute: { enabled: false } },
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
      threadline: { ownerName: 'Justin' },
    } as unknown as InstarConfig;
    const sessionManager = createMockSessionManager() as any;
    sessionManager.on = () => undefined;
    const readMarkers = wireReadMarkerStore({ stateDir, emitter: null, peerStreams: null, ownMachineId: null, report: () => undefined, removalEvidence: () => false });
    readMarkers.markCatchUpSettled();
    const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), telegram, readMarkers } as never);
    servers.push(server);
    const app = server.getApp();
    const list = () => request(app).get('/mobile/conversations?limit=200').set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'clist-e2e');

    const spy = vi.spyOn(fs, 'readFileSync');
    const logReads = () => spy.mock.calls.filter((c) => String(c[0]) === logPath).length;
    try {
      const first = await list();
      expect(first.status).toBe(200);
      const tg = first.body.conversations.filter((c: { platform: string }) => c.platform === 'telegram');
      expect(tg.length).toBe(N);
      expect(logReads()).toBe(0);

      await telegram.buildLastEntryIndex();
      const second = await list();
      expect(second.status).toBe(200);
      const row = second.body.conversations.find((c: { id: unknown; platform: string }) => c.platform === 'telegram' && c.id === 7000 + N);
      expect(row?.lastPreview).toBe(`note 2 for ${N}`);
      expect(typeof row?.lastActivity).toBe('string');
      expect(logReads()).toBe(0);

      // Wiring integrity: the unread counter's Telegram source is the in-memory, non-blocking read.
      const unread = server.conversationUnread as unknown as { deps: { telegram: { history: (id: number, limit: number) => unknown[] | null } } } | null;
      expect(unread).not.toBeNull();
      expect(unread!.deps.telegram.history(7001, 100)).toBeNull(); // cold: unknown, queued for a background load
      expect(logReads()).toBe(0);
      await telegram.warmTopicTails([]);
      expect(unread!.deps.telegram.history(7001, 100)?.length).toBe(3);
      expect(logReads()).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});

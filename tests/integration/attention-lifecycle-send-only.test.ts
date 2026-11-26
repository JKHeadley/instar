/**
 * Tier-2 integration — a send-only adapter's automatic lifecycle passes are
 * visible through the REAL HTTP pipeline: GET /attention/lifecycle reports a
 * lastSweepAt after the boot pass and a newer one after the hourly pass,
 * with no manual sweep.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { generateAgentToken, deleteAgentToken } from '../../src/messaging/AgentTokenManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const PROJECT_NAME = 'attention-lifecycle-send-only-int';
const MIN = 60_000;
let AUTH = '';
let tmpDir: string;
let adapter: TelegramAdapter;

function mount(): express.Express {
  adapter = new TelegramAdapter(
    { token: 'test-token-123', chatId: '-100123456', pollIntervalMs: 100, attentionHubFilter: 'all', getAttentionHubTopicId: () => 5151 },
    tmpDir,
  );
  vi.spyOn(adapter as unknown as { apiCall: (m: string, p: Record<string, unknown>) => Promise<unknown> }, 'apiCall')
    .mockImplementation(async () => ({ ok: true, message_id: 1, message_thread_id: 9999 }));
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes({
    config: { projectName: PROJECT_NAME, projectDir: tmpDir, stateDir: path.join(tmpDir, '.instar'), port: 0, authToken: AUTH } as never,
    telegram: adapter, meshSelfId: null, machinePoolRegistry: null, resolvePeerUrls: null,
    state: { getJobState: () => null, getSession: () => null, listSessions: () => [] } as never,
    sessionManager: null, scheduler: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, discoveryEvaluator: null, startTime: new Date(),
    mentorRunner: null, currentInboundByTopic: new Map(),
  } as unknown as RouteContext));
  return app;
}
const auth = () => ({ Authorization: `Bearer ${AUTH}` });
const fakeTimers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] });

describe('attention lifecycle passes on a send-only server (HTTP)', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-attn-sendonly-int-'));
    AUTH = generateAgentToken(PROJECT_NAME);
  });
  afterEach(async () => {
    vi.useRealTimers();
    deleteAgentToken(PROJECT_NAME);
    await adapter?.stop();
    vi.restoreAllMocks();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'test-cleanup' });
  });

  it('boot pass then hourly pass advance lastSweepAt with no manual sweep', async () => {
    const app = mount();
    fakeTimers();
    vi.setSystemTime(new Date('2026-10-26T18:00:00Z'));
    adapter.startSendOnlyMaintenance();
    const before = await request(app).get('/attention/lifecycle').set(auth());
    expect(before.status).toBe(200);
    expect(before.body.lastSweepAt).toBeNull();

    vi.advanceTimersByTime(2 * MIN);
    const boot = await request(app).get('/attention/lifecycle').set(auth());
    expect(boot.body.lastSweepAt).toBe('2026-10-26T18:02:00.000Z');
    expect(boot.body.firstPassAt).toBe('2026-10-26T18:02:00.000Z');

    vi.advanceTimersByTime(58 * MIN);
    const hourly = await request(app).get('/attention/lifecycle').set(auth());
    expect(hourly.body.lastSweepAt).toBe('2026-10-26T19:00:00.000Z');
    expect(hourly.body.firstPassAt).toBe('2026-10-26T18:02:00.000Z');
  });
});

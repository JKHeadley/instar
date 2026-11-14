// safe-git-allow: e2e fixture cleanup uses fs.rmSync on tmp dirs only.
/**
 * E2E — the attention lifecycle is alive on a SEND-ONLY server.
 *
 * Every instar server whose lifeline holds the Telegram poll lease boots
 * "Telegram send-only mode" and never calls TelegramAdapter.start(). Before
 * this fix the lifecycle timers were armed only by start(), so those servers
 * never ran an automatic pass (lastSweepAt stuck at the last manual sweep).
 *
 * This test proves both halves of the production path:
 *  1. server.ts's send-only branch arms the timers (startSendOnlyMaintenance
 *     is called inside that branch, before the polling branch begins);
 *  2. an adapter built exactly as that branch builds it, with the production
 *     defaults and the real routes, records the boot pass and the hourly pass
 *     on GET /attention/lifecycle (200, never 503), while never polling.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { generateAgentToken, deleteAgentToken } from '../../src/messaging/AgentTokenManager.js';

const PROJECT_NAME = 'attention-lifecycle-send-only-e2e';
const MIN = 60_000;
const SERVER_TS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/commands/server.ts');
let AUTH = '';
let tmp: string;
let adapter: TelegramAdapter;

beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attn-sendonly-e2e-')); AUTH = generateAgentToken(PROJECT_NAME); });
afterEach(async () => { vi.useRealTimers(); deleteAgentToken(PROJECT_NAME); await adapter?.stop(); vi.restoreAllMocks(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe('E2E: attention lifecycle runs on a send-only server', () => {
  it('server.ts arms the lifecycle timers inside the send-only branch', () => {
    const src = fs.readFileSync(SERVER_TS, 'utf-8');
    const branchStart = src.indexOf("if (telegramTopology?.mode === 'send-only' && telegramConfig) {");
    expect(branchStart).toBeGreaterThan(-1);
    const pollingStart = src.indexOf('await telegram.start();', branchStart);
    expect(pollingStart).toBeGreaterThan(branchStart);
    const sendOnlyBranch = src.slice(branchStart, pollingStart);
    expect(sendOnlyBranch).toMatch(/telegram\.startSendOnlyMaintenance\(\);/);
    // The send-only branch must never start polling itself.
    expect(sendOnlyBranch).not.toMatch(/telegram\.start\(\)/);
  });

  it('a send-only adapter with production defaults records the boot and hourly passes on GET /attention/lifecycle', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date('2026-10-26T18:00:00Z'));
    // Built the way the send-only branch builds it: no lifecycle config (ships ON), then maintenance armed.
    adapter = new TelegramAdapter({ token: 'test-token-123', chatId: '-100123456', pollIntervalMs: 100, getAttentionHubTopicId: () => 777 }, tmp);
    const calls: string[] = [];
    vi.spyOn(adapter as unknown as { apiCall: (m: string, p: Record<string, unknown>) => Promise<unknown> }, 'apiCall')
      .mockImplementation(async (m) => { calls.push(m); return { ok: true, message_id: 1, message_thread_id: 777 }; });
    adapter.startSendOnlyMaintenance();

    const app = express();
    app.use(express.json());
    app.use('/', createRoutes({
      config: { projectName: PROJECT_NAME, projectDir: tmp, stateDir: path.join(tmp, '.instar'), port: 0, authToken: AUTH } as never,
      telegram: adapter, meshSelfId: null, machinePoolRegistry: null, resolvePeerUrls: null,
      state: { getJobState: () => null, getSession: () => null, listSessions: () => [] } as never,
      sessionManager: null, scheduler: null, relationships: null, feedback: null, dispatches: null,
      updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
      publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
      triageNurse: null, topicMemory: null, discoveryEvaluator: null, startTime: new Date(),
      mentorRunner: null, currentInboundByTopic: new Map(),
    } as unknown as RouteContext));
    const auth = { Authorization: `Bearer ${AUTH}` };

    const before = await request(app).get('/attention/lifecycle').set(auth);
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ enabled: true, lastSweepAt: null });

    vi.advanceTimersByTime(2 * MIN);
    expect((await request(app).get('/attention/lifecycle').set(auth)).body.lastSweepAt).toBe('2026-10-26T18:02:00.000Z');

    vi.advanceTimersByTime(58 * MIN);
    expect((await request(app).get('/attention/lifecycle').set(auth)).body.lastSweepAt).toBe('2026-10-26T19:00:00.000Z');

    expect(adapter.isPolling).toBe(false);
    expect(calls).not.toContain('getUpdates');
  });
});

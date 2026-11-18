// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier 3 — overdue-promise follow-through is ALIVE on the production path
 * (docs/specs/overdue-promise-follow-through.md).
 *
 * Real AgentServer, real server timer (CheckInReminderTicker), real
 * CommitmentTracker file store, real TelegramAdapter; only Telegram's HTTP
 * endpoint is stubbed. Nothing calls the pass route for the timer test: the
 * claim is that a promise whose own time passed reaches the person by itself,
 * exactly once, and an old backlog promise does not.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import { StateManager } from '../../src/core/StateManager.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';

const AUTH = 'test-e2e-overdue-promise';
const TICK_MS = 1000;
const dirs: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const d of dirs.splice(0)) {
    SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/overdue-promise-follow-through-alive.test.ts' });
  }
});

function makeHome() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overdue-promise-e2e-'));
  dirs.push(tmpDir);
  const stateDir = path.join(tmpDir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));
  return { tmpDir, stateDir };
}

function makeConfig(tmpDir: string, stateDir: string, checkInReminder: Record<string, unknown>): InstarConfig {
  return {
    projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH,
    requestTimeoutMs: 10000, version: '0.0.0', developmentAgent: true,
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
    messaging: [], monitoring: {}, updates: {},
    commitments: { checkInReminder: { tickIntervalMs: TICK_MS, ...checkInReminder } },
  } as unknown as InstarConfig;
}

function stubTelegramHttp() {
  const sends: Array<{ thread: unknown; text: string }> = [];
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    if (!String(url).startsWith('https://api.telegram.org/')) return realFetch(url, init);
    if (String(url).endsWith('/sendMessage')) {
      const body = JSON.parse(String(init?.body));
      sends.push({ thread: body.message_thread_id, text: body.text });
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: sends.length + 1 } }), { status: 200 });
  }));
  return sends;
}

async function boot(config: InstarConfig, stateDir: string, telegram?: TelegramAdapter) {
  const spawnSession = vi.fn();
  const tracker = new CommitmentTracker({ stateDir, liveConfig: () => config as never });
  tracker.start();
  const server = new AgentServer({
    config,
    sessionManager: { listRunningSessions: () => [], getSession: () => null, spawnSession, spawnInteractiveSession: spawnSession, isSessionAlive: () => false } as never,
    state: new StateManager(stateDir),
    commitmentTracker: tracker,
    ...(telegram ? { telegram } : {}),
  } as never);
  await server.start();
  return { server, tracker, spawnSession, stop: async () => { tracker.stop(); await server.stop(); } };
}

const promise = (tracker: CommitmentTracker, topicId: number, agentResponse: string, softDeadlineAt: string) =>
  tracker.record({
    type: 'one-time-action', userRequest: 'the scaling plan', agentResponse, topicId, source: 'agent',
    beaconEnabled: true, softDeadlineAt,
  } as never);

const until = async (cond: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  expect(cond()).toBe(true);
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A clock time three hours ahead in this machine's zone, e.g. "4:07 PM" — always inside the detector's horizon. */
const inThreeHours = () => new Date(Date.now() + 3 * 3600_000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

describe('overdue promise follow-through (feature is alive)', () => {
  it('the server timer tells the person once when a promised time passes; an old backlog promise is left alone; no session is spawned', async () => {
    const { tmpDir, stateDir } = makeHome();
    const sends = stubTelegramHttp();
    const config = makeConfig(tmpDir, stateDir, { dryRun: false });
    const telegram = new TelegramAdapter({ token: 't', chatId: '-1001' } as never, stateDir);
    const running = await boot(config, stateDir, telegram);

    const late = promise(running.tracker, 4242, 'Trial the Mac Mini as a third helper and tell you the run time.', new Date(Date.now() - 2 * 3600_000).toISOString());
    const backlog = promise(running.tracker, 4343, 'An old promise from last week.', new Date(Date.now() - 5 * 24 * 3600_000).toISOString());

    await until(() => !!running.tracker.get(late.id)?.lateNoticeFor, 6 * TICK_MS);
    const toTopic = sends.filter((s) => s.thread === 4242);
    expect(toTopic).toHaveLength(1);
    expect(toTopic[0].text).toContain("That time has passed and it isn't marked done");
    expect(toTopic[0].text).toContain('Trial the Mac Mini');

    await wait(2.5 * TICK_MS);
    expect(sends.filter((s) => s.thread === 4242)).toHaveLength(1); // exactly once across ticks
    expect(sends.filter((s) => s.thread === 4343)).toHaveLength(0); // backlog before the epoch
    expect(running.tracker.get(backlog.id)?.lateNoticeFor).toBeUndefined();
    expect(running.spawnSession).not.toHaveBeenCalled(); // the handoff never starts a session
    expect(fs.existsSync(path.join(stateDir, 'state', 'late-notice-epoch.json'))).toBe(true);
    await running.stop();
  }, 25_000);

  it('dry-run (the fleet default) sends nothing, stamps nothing, and reports would-send', async () => {
    const { tmpDir, stateDir } = makeHome();
    const sends = stubTelegramHttp();
    const telegram = new TelegramAdapter({ token: 't', chatId: '-1001' } as never, stateDir);
    const running = await boot(makeConfig(tmpDir, stateDir, { tickEnabled: false }), stateDir, telegram);
    const late = promise(running.tracker, 4444, 'soak me', new Date(Date.now() - 3600_000).toISOString());
    const res = await request(running.server.getApp()).post('/commitments/check-in-reminder/pass').set({ Authorization: `Bearer ${AUTH}` }).send({});
    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.late).toMatchObject({ ran: true, wouldSendTopics: 1, topicsSent: 0 });
    expect(sends).toHaveLength(0);
    expect(running.tracker.get(late.id)?.lateNoticeFor).toBeUndefined();
    await running.stop();
  }, 15_000);

  it('POST /commitments returns dateMissing when the words name a time but no promised time is set, and the PATCH it suggests is accepted', async () => {
    const { tmpDir, stateDir } = makeHome();
    const running = await boot(makeConfig(tmpDir, stateDir, { tickEnabled: false }), stateDir);
    const app = running.server.getApp();
    const auth = { Authorization: `Bearer ${AUTH}` };
    const created = await request(app).post('/commitments').set(auth).send({
      type: 'one-time-action', userRequest: 'the scaling plan', agentResponse: `I'll have it done before ${inThreeHours()}.`,
      topicId: 4545, followThroughOptOutReason: 'test fixture',
    });
    expect(created.status).toBe(201);
    expect(created.body.dateMissing?.found).toMatch(/^before \d{1,2}:\d{2} (AM|PM)$/i);
    const iso = created.body.dateMissing.suggestedSoftDeadlineAt as string;
    const patched = await request(app).patch(`/commitments/${created.body.id}`).set(auth).send({ softDeadlineAt: iso });
    expect(patched.status).toBe(200);
    expect(patched.body.softDeadlineAt).toBe(iso);
    expect(patched.body.followThroughOptOutReason).toBeUndefined(); // a promised time IS follow-through
    await running.stop();
  }, 15_000);
});

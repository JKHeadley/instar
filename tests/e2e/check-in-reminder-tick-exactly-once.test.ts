// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier 3 proof for the check-in reminder server tick (CMT-1130;
 * docs/specs/check-in-reminder-server-tick.md).
 *
 * The claim: a genuinely due reminder reaches Telegram exactly once with no
 * session, driven only by the real timer. Everything here is the production
 * object except the Telegram HTTP endpoint: real AgentServer, real timer, real
 * CommitmentTracker file store, real TelegramAdapter, and a restart on the same
 * state. Nothing calls the pass route.
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

const AUTH = 'test-e2e-check-in-tick';
const TICK_MS = 1000;
const dirs: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const d of dirs.splice(0)) {
    SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/check-in-reminder-tick-exactly-once.test.ts' });
  }
});

function makeHome() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-in-tick-e2e-'));
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
    sessionManager: { listRunningSessions: () => [], getSession: () => null, spawnSession, spawnInteractiveSession: spawnSession } as never,
    state: new StateManager(stateDir),
    commitmentTracker: tracker,
    ...(telegram ? { telegram } : {}),
  } as never);
  await server.start();
  return { server, tracker, spawnSession, stop: async () => { tracker.stop(); await server.stop(); } };
}

const openCommitment = (tracker: CommitmentTracker, topicId: number, userRequest: string, checkInAt: string) =>
  tracker.record({
    type: 'one-time-action', userRequest, agentResponse: 'will do', topicId, source: 'agent',
    beaconEnabled: false, followThroughOptOutReason: 'test fixture', checkInAt,
  } as never);

const until = async (cond: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  expect(cond()).toBe(true);
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const statusOf = (server: AgentServer) => request(server.getApp())
  .get('/commitments/check-in-reminder').set({ Authorization: `Bearer ${AUTH}` });

describe('check-in reminder server tick', () => {
  it('delivers one genuinely due reminder exactly once, with no session, across ticks and a restart', async () => {
    const { tmpDir, stateDir } = makeHome();
    const sends = stubTelegramHttp();
    const config = makeConfig(tmpDir, stateDir, { dryRun: false });
    const telegram = new TelegramAdapter({ token: 't', chatId: '-1001' } as never, stateDir);

    const first = await boot(config, stateDir, telegram);
    const past = new Date(Date.now() - 3_600_000).toISOString();
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const due = openCommitment(first.tracker, 4321, 'report back on the refresh', past);
    const notYet = openCommitment(first.tracker, 4322, 'not due yet', future);
    const closed = openCommitment(first.tracker, 4323, 'already delivered', past);
    first.tracker.withdraw(closed.id, 'test fixture');

    await until(() => !!first.tracker.get(due.id)?.checkInReminderSentAt, 5 * TICK_MS);
    await wait(2.5 * TICK_MS);

    expect(sends).toHaveLength(1);
    expect(sends[0].thread).toBe(4321);
    expect(sends[0].text).toContain('report back on the refresh');
    expect(first.tracker.get(notYet.id)?.checkInReminderSentAt).toBeUndefined();
    expect(first.spawnSession).not.toHaveBeenCalled();

    const status = await statusOf(first.server);
    expect(status.body.tick).toMatchObject({ armed: true, enabled: true, consecutiveFailures: 0, intervalMs: TICK_MS });
    expect(status.body.tick.ticks).toBeGreaterThanOrEqual(2);
    await first.stop();

    const second = await boot(config, stateDir, telegram);
    await wait(2.5 * TICK_MS);
    expect(sends).toHaveLength(1);
    expect(second.tracker.get(due.id)?.checkInReminderSentAt).toBeTruthy();
    await second.stop();
  }, 30_000);

  it('by default ticks in dry-run: records what it would send and sends nothing', async () => {
    const { tmpDir, stateDir } = makeHome();
    const sends = stubTelegramHttp();
    const telegram = new TelegramAdapter({ token: 't', chatId: '-1001' } as never, stateDir);
    const running = await boot(makeConfig(tmpDir, stateDir, {}), stateDir, telegram);
    const due = openCommitment(running.tracker, 4321, 'soak me', new Date(Date.now() - 1000).toISOString());
    const ledger = path.join(stateDir, 'logs', 'check-in-reminder-tick.jsonl');
    await until(() => fs.existsSync(ledger) && fs.readFileSync(ledger, 'utf-8').includes(due.id), 5 * TICK_MS);

    expect(sends).toHaveLength(0);
    expect(running.tracker.get(due.id)?.checkInReminderSentAt).toBeUndefined();
    expect(running.tracker.get(due.id)?.checkInReminderAttempts).toBeUndefined();
    const row = JSON.parse(fs.readFileSync(ledger, 'utf-8').trim().split('\n').pop()!);
    expect(row).toMatchObject({ dryRun: true, wouldSend: 1, sent: 0 });
    expect(JSON.stringify(row)).not.toContain('soak me');
    await running.stop();
  }, 20_000);

  it('tickEnabled:false leaves the timer idle', async () => {
    const { tmpDir, stateDir } = makeHome();
    const running = await boot(makeConfig(tmpDir, stateDir, { tickEnabled: false }), stateDir);
    await wait(1.5 * TICK_MS);
    const status = await statusOf(running.server);
    expect(status.body.tick).toMatchObject({ enabled: false, lastSkip: 'tick-disabled' });
    await running.stop();
  }, 15_000);
});

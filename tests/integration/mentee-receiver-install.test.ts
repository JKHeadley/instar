/**
 * Tier-2 integration tests for the mentee receiver wiring
 * (MENTOR-LIVE-READINESS-SPEC §Recipient side).
 *
 * Exercises the full AgentServer.start() init path with a mock primary
 * TelegramAdapter that records `setAgentMessageHook` calls. Verifies the
 * structural gating contract: the hook IS installed iff the full
 * `config.mentee` block is set; partial / dormant configs leave the adapter
 * untouched (no half-wired state).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type express from 'express';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';
import type { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';

function createMockSessionManager() {
  return { listRunningSessions: () => [], getSession: () => null };
}

/**
 * Minimal recording mock — only the methods AgentServer's `start()` and the
 * mentee installer actually touch. `as unknown as TelegramAdapter` lets the
 * type check pass without satisfying the full adapter interface.
 */
function createRecordingAdapter() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let hookInstalled = false;
  const adapter = {
    setAgentMessageHook(...args: unknown[]) {
      calls.push({ method: 'setAgentMessageHook', args });
      hookInstalled = true;
    },
    sendToTopic: async (_topicId: number, _text: string) => ({ messageId: 1 }),
    stop: async () => undefined,
    startPolling: async () => undefined,
    stopPolling: () => undefined,
    on: () => undefined,
    off: () => undefined,
    emit: () => undefined,
  };
  return {
    adapter: adapter as unknown as TelegramAdapter,
    get hookInstalled() { return hookInstalled; },
    get calls() { return calls; },
  };
}

function buildConfig(tmpDir: string, stateDir: string, mentee?: Record<string, unknown>): InstarConfig {
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'i', agentName: 'I' }));
  return {
    projectName: 'i', projectDir: tmpDir, stateDir, port: 0, authToken: 'test-mentee-install',
    requestTimeoutMs: 10000, version: '0.0.0',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
    messaging: [], monitoring: {}, updates: {},
    ...(mentee ? { mentee } : {}),
  } as unknown as InstarConfig;
}

describe('Mentee receiver wiring (integration — install gating)', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer | null = null;
  let app: express.Express | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mentee-install-'));
    stateDir = path.join(tmpDir, '.instar');
  });

  afterEach(async () => {
    if (server) {
      try { await server.stop(); } catch { /* best-effort */ }
      server = null;
    }
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/mentee-receiver-install.test.ts' });
  });

  it('INSTALLS the hook when mentee.enabled + all required pieces are set', async () => {
    const { adapter, calls } = createRecordingAdapter();
    const config = buildConfig(tmpDir, stateDir, {
      enabled: true,
      localAgentName: 'instar-codey',
      knownMentors: { echo: { botId: '8781020500' } },
      replyChatId: '-1003947546311',
      replyTopicId: 458,
      sessionTimeoutMs: 60_000,
    });
    server = new AgentServer({ config, sessionManager: createMockSessionManager() as any, state: new StateManager(stateDir), telegram: adapter });
    await server.start();
    app = server.getApp();
    expect(app).toBeDefined();
    const setHookCalls = calls.filter((c) => c.method === 'setAgentMessageHook');
    expect(setHookCalls.length).toBe(1);
    expect(typeof setHookCalls[0].args[0]).toBe('function');
  });

  it('SKIPS the install when mentee.enabled === false (ships dormant by default)', async () => {
    const { adapter, calls } = createRecordingAdapter();
    const config = buildConfig(tmpDir, stateDir); // no mentee block at all → defaults dormant
    server = new AgentServer({ config, sessionManager: createMockSessionManager() as any, state: new StateManager(stateDir), telegram: adapter });
    await server.start();
    expect(calls.filter((c) => c.method === 'setAgentMessageHook').length).toBe(0);
  });

  it('SKIPS the install when mentee.enabled:true but localAgentName is missing (partial config = no half-wire)', async () => {
    const { adapter, calls } = createRecordingAdapter();
    const config = buildConfig(tmpDir, stateDir, {
      enabled: true,
      // localAgentName missing
      knownMentors: { echo: { botId: '8781020500' } },
      replyChatId: '-1003947546311',
      replyTopicId: 458,
    });
    server = new AgentServer({ config, sessionManager: createMockSessionManager() as any, state: new StateManager(stateDir), telegram: adapter });
    await server.start();
    expect(calls.filter((c) => c.method === 'setAgentMessageHook').length).toBe(0);
  });

  it('SKIPS the install when mentee.enabled:true but knownMentors is empty (allowlist must have at least one entry)', async () => {
    const { adapter, calls } = createRecordingAdapter();
    const config = buildConfig(tmpDir, stateDir, {
      enabled: true,
      localAgentName: 'instar-codey',
      knownMentors: {},
      replyChatId: '-1003947546311',
      replyTopicId: 458,
    });
    server = new AgentServer({ config, sessionManager: createMockSessionManager() as any, state: new StateManager(stateDir), telegram: adapter });
    await server.start();
    expect(calls.filter((c) => c.method === 'setAgentMessageHook').length).toBe(0);
  });

  it('SKIPS the install when reply destination is missing (replyChatId / replyTopicId)', async () => {
    const { adapter, calls } = createRecordingAdapter();
    const config = buildConfig(tmpDir, stateDir, {
      enabled: true,
      localAgentName: 'instar-codey',
      knownMentors: { echo: { botId: '8781020500' } },
      // replyChatId/replyTopicId missing
    });
    server = new AgentServer({ config, sessionManager: createMockSessionManager() as any, state: new StateManager(stateDir), telegram: adapter });
    await server.start();
    expect(calls.filter((c) => c.method === 'setAgentMessageHook').length).toBe(0);
  });

  it('SKIPS cleanly when there is no telegramAdapter (agents without Telegram are safe)', async () => {
    // No adapter passed at all. Even with mentee.enabled:true + full config, the
    // installer must no-op cleanly because there is no primary adapter to hook.
    const config = buildConfig(tmpDir, stateDir, {
      enabled: true,
      localAgentName: 'instar-codey',
      knownMentors: { echo: { botId: '8781020500' } },
      replyChatId: '-1003947546311',
      replyTopicId: 458,
    });
    server = new AgentServer({ config, sessionManager: createMockSessionManager() as any, state: new StateManager(stateDir) });
    await expect(server.start()).resolves.not.toThrow();
  });
});

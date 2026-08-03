/**
 * Regression for the production topology gap where the server constructed a
 * send-capable TelegramAdapter in Lifeline-owned/send-only mode, but only wired
 * scheduler and notification consumers inside the server-polls branch.
 *
 * This deliberately composes topology + handoff. JobScheduler tests that inject
 * an already-wired adapter cannot catch a startup branch forgetting the handoff.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateManager } from '../../src/core/StateManager.js';
import { SessionManager } from '../../src/core/SessionManager.js';
import type { JobDefinition, SessionManagerConfig } from '../../src/core/types.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { NotificationBatcher } from '../../src/messaging/NotificationBatcher.js';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import {
  resolveTelegramStartupTopology,
  wireTelegramSendSide,
} from '../../src/commands/telegramSendSideComposition.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn().mockReturnValue(''),
  execFile: vi.fn(),
}));

vi.mock('croner', () => ({
  Cron: vi.fn().mockImplementation(() => ({ stop: vi.fn() })),
}));

vi.mock('../../src/scheduler/JobLoader.js', () => ({
  loadJobs: vi.fn().mockReturnValue([]),
}));

describe('server Telegram send-side composition', () => {
  let tmpDir: string;
  let stateDir: string;
  let scheduler: JobScheduler;
  let adapter: TelegramAdapter;
  let batcher: NotificationBatcher;

  const job: JobDefinition = {
    slug: 'health-check',
    name: 'Health Check',
    description: 'health',
    schedule: '*/5 * * * *',
    enabled: true,
    priority: 'critical',
    model: 'haiku',
    execute: { type: 'prompt', value: 'health' },
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-send-side-compose-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'jobs.json'), '[]');

    const state = new StateManager(stateDir);
    const sessionConfig: SessionManagerConfig = {
      tmuxPath: '/usr/bin/tmux',
      claudePath: '/usr/local/bin/claude',
      projectDir: tmpDir,
      maxSessions: 5,
      protectedSessions: [],
      completionPatterns: [],
    };
    const sessions = new SessionManager(sessionConfig, state);
    scheduler = new JobScheduler({ jobsFile: path.join(tmpDir, 'jobs.json'), projectDir: tmpDir }, sessions, state, stateDir);
    adapter = new TelegramAdapter({ token: 'fake-token', chatId: '-100123' }, stateDir);
    batcher = new NotificationBatcher();
  });

  afterEach(() => {
    batcher.stop();
    vi.restoreAllMocks();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/server-telegram-send-side-composition.test.ts' });
  });

  it.each([
    {
      name: 'explicit send-only',
      input: { telegramConfigured: true, skipTelegram: true, coordinatorAwake: true, lifelineOwnsPolling: false },
      expectedMode: 'send-only',
      expectedBridgeOwner: true,
    },
    {
      name: 'standby laptop',
      input: { telegramConfigured: true, skipTelegram: false, coordinatorAwake: false, lifelineOwnsPolling: false },
      expectedMode: 'send-only',
      expectedBridgeOwner: false,
    },
    {
      name: 'Lifeline polling owner',
      input: { telegramConfigured: true, skipTelegram: false, coordinatorAwake: true, lifelineOwnsPolling: true },
      expectedMode: 'send-only',
      expectedBridgeOwner: true,
    },
    {
      name: 'server polling owner',
      input: { telegramConfigured: true, skipTelegram: false, coordinatorAwake: true, lifelineOwnsPolling: false },
      expectedMode: 'server-polling',
      expectedBridgeOwner: true,
    },
  ] as const)(
    'composes production $name topology into a usable scheduler and batcher sink',
    async ({ input, expectedMode, expectedBridgeOwner }) => {
      const genericSend = vi.spyOn(adapter, 'send').mockResolvedValue({ messageId: 1 });
      const topicSend = vi.spyOn(adapter, 'sendToTopic').mockResolvedValue({ messageId: 2, topicId: 77 });

      const topology = resolveTelegramStartupTopology(input);
      expect(topology).toEqual({ mode: expectedMode, bridgeOwner: expectedBridgeOwner });
      if (!topology) throw new Error('expected a configured Telegram topology');

      const result = wireTelegramSendSide({ mode: topology.mode, telegram: adapter, scheduler, notificationBatcher: batcher });
      expect(result).toEqual({ mode: expectedMode, schedulerAttached: true, batcherAttached: true });

      await (scheduler as unknown as {
        alertOnConsecutiveFailures(j: JobDefinition, failures: number, error: string): Promise<void>;
      }).alertOnConsecutiveFailures(job, 2, 'spawn refused');
      expect(genericSend).toHaveBeenCalledTimes(1);

      await batcher.enqueue({
        tier: 'IMMEDIATE',
        category: 'composition-test',
        message: 'send-side alive',
        timestamp: new Date(),
        topicId: 77,
      });
      expect(topicSend).toHaveBeenCalledWith(77, 'send-side alive');
    },
  );

  it('keeps all polling-independent handoffs after both ownership branches', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/commands/server.ts'), 'utf8');
    const topology = src.indexOf('const telegramTopology = resolveTelegramStartupTopology({');
    const sendOnly = src.indexOf("if (telegramTopology?.mode === 'send-only' && telegramConfig)");
    const polling = src.indexOf("if (telegramTopology?.mode === 'server-polling' && telegramConfig)");
    const sharedWiring = src.indexOf('wireTelegramSendSide({');
    const bridge = src.indexOf('telegramBridge = new TelegramBridge({');
    const liveBridgeOwner = src.indexOf('isOwner: () => coordinator.isAwake && coordinator.holdsLease()');
    const roleGuard = src.indexOf('scheduler.setRoleGuard(');
    const alertDeliveryActivation = src.indexOf('scheduler?.activateFailureAlertDelivery()');
    const coherenceSeam = src.indexOf('// ── Coherence Journal × Telegram emergency-stop seam');
    const topicMemoryOpen = src.indexOf('await topicMemory.open()');
    const topicMemoryHandoff = src.indexOf('scheduler.setTopicMemory(topicMemory)');

    for (const index of [topology, sendOnly, polling, sharedWiring, bridge, liveBridgeOwner, roleGuard, alertDeliveryActivation, coherenceSeam, topicMemoryOpen, topicMemoryHandoff]) {
      expect(index).toBeGreaterThan(-1);
    }
    expect(topology).toBeLessThan(sendOnly);
    expect(sharedWiring).toBeGreaterThan(polling);
    expect(sharedWiring).toBeLessThan(coherenceSeam);
    expect(bridge).toBeGreaterThan(sharedWiring);
    expect(liveBridgeOwner).toBeGreaterThan(bridge);
    expect(bridge).toBeLessThan(coherenceSeam);
    expect(roleGuard).toBeGreaterThan(polling);
    expect(roleGuard).toBeLessThan(coherenceSeam);
    expect(alertDeliveryActivation).toBeGreaterThan(roleGuard);
    expect(alertDeliveryActivation).toBeLessThan(coherenceSeam);
    expect(topicMemoryHandoff).toBeGreaterThan(topicMemoryOpen);

    const pollingOnlySlice = src.slice(polling, sharedWiring);
    expect(pollingOnlySlice).not.toContain('scheduler.setMessenger(');
    expect(pollingOnlySlice).not.toContain('scheduler.setTelegram(');
    expect(pollingOnlySlice).not.toContain('notificationBatcher.setSendFunction(');
    expect(pollingOnlySlice).not.toContain('telegramBridge = new TelegramBridge(');
    expect(pollingOnlySlice).not.toContain('scheduler.setRoleGuard(');
  });
});

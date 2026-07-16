/**
 * Tier-3 alive test for the cross-machine mentor carrier. Telegram bot-to-bot
 * delivery is intentionally NOT used as authority: the signed-machine seam
 * must reach the recipient's existing A2A hook before the visible mirror fires.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { handleA2aMeshInbox, type A2aInboxDeliverCommand } from '../../src/core/A2aMeshInbox.js';
import type { InstarConfig } from '../../src/core/types.js';
import type { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function hookAdapter() {
  let hook: ((ctx: Record<string, unknown>) => Promise<{ handled: boolean }>) | null = null;
  return {
    setAgentMessageHook(h: typeof hook) { hook = h; },
    async dispatchAgentMessageHook(ctx: { text: string; topicId: number; senderIsBot: boolean; senderBotId?: string }) {
      if (!hook) return false;
      return (await hook({ ...ctx, now: Date.now() })).handled === true;
    },
    sendToTopic: vi.fn(async () => ({ messageId: 1 })),
    stop: async () => undefined, startPolling: async () => undefined,
    stopPolling: () => undefined, on: () => undefined, off: () => undefined, emit: () => undefined,
  } as unknown as TelegramAdapter;
}

function config(projectName: string, projectDir: string, extra: Record<string, unknown>): InstarConfig {
  const stateDir = path.join(projectDir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  return {
    projectName, projectDir, stateDir, port: 0, authToken: 'test', requestTimeoutMs: 10_000, version: '0',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {}, ...extra,
  } as unknown as InstarConfig;
}

describe('mentor cross-machine A2A relay (E2E)', () => {
  let root: string;
  let mentor: AgentServer;
  let mentee: AgentServer;
  const visible = hookAdapter();

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-mesh-e2e-'));
    const menteeAdapter = hookAdapter();
    const menteeSessions = {
      listRunningSessions: () => [], getSession: () => null,
      spawnSession: async () => ({ id: 'mentee-1', tmuxSession: 'mentee-1', framework: 'test' }),
      captureOutput: () => 'Mentee handled the real mentor prompt.', killSession: () => undefined,
    };
    const menteeConfig = config('remote-codey', path.join(root, 'mentee'), {
      mentee: {
        enabled: true, localAgentName: 'remote-codey', knownMentors: { echo: { botId: 'mentor-bot', machineId: 'echo-mac' } },
        replyChatId: '-1001', replyTopicId: 458, sessionTimeoutMs: 100,
      },
    });
    mentee = new AgentServer({ config: menteeConfig, sessionManager: menteeSessions as never, state: new StateManager(menteeConfig.stateDir), telegram: menteeAdapter });
    await mentee.start();

    const mentorConfig = config('echo', path.join(root, 'mentor'), {});
    mentor = new AgentServer({
      config: mentorConfig,
      sessionManager: { listRunningSessions: () => [], getSession: () => null } as never,
      state: new StateManager(mentorConfig.stateDir),
      telegram: visible,
      // Production uses signed MeshRpc here. This E2E seam invokes the exact
      // recipient handler that MeshRpc dispatch wires after authentication.
      deliverA2aToMachine: async (input) => handleA2aMeshInbox(
        { type: 'a2a-inbox-deliver', targetAgent: input.targetAgent, text: input.text, topicId: input.topicId, senderAgent: input.senderAgent, senderBotId: input.senderBotId } as A2aInboxDeliverCommand,
        { localAgent: 'remote-codey', authenticatedSenderMachine: 'echo-mac', authorizedMentorMachine: () => 'echo-mac', dispatch: (message) => menteeAdapter.dispatchAgentMessageHook(message) },
      ),
    });
    await mentor.start();
  });

  afterAll(async () => {
    await mentor.stop();
    await mentee.stop();
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/e2e/mentor-cross-machine-a2a-relay.test.ts' });
  });

  it('delivers through the recipient inbox and only then emits the Telegram mirror', async () => {
    const delivered = await (mentor as any).deliverA2aMessage({
      fromAgent: 'echo', toAgent: 'remote-codey', targetMachineId: 'mini', role: 'mentor', corr: 'e2e-1',
      body: 'Drive this task over the authenticated relay.', allowedRoles: new Set(['mentor']),
      telegramTopicId: 458, fromBotId: 'mentor-bot',
      visibleEcho: { enabled: true, topicId: 458, roleTag: '[mentor]', bot: visible },
    });
    expect(delivered).toBe(true);
    await vi.waitFor(() => expect((visible as any).sendToTopic).toHaveBeenCalled());
  });
});

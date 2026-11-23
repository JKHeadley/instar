import express from 'express';
import { vi } from 'vitest';
import { createTempProject } from './setup.js';
import { SessionManager } from '../../src/core/SessionManager.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import { wireTelegramRouting } from '../../src/commands/server.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';

/** Real production components and callback composition; native transport and its framework environment observation are replaced. */
export function telegramInjectionFailureFixture() {
  const project = createTempProject();
  const config = { projectName: 'n80-isolated', projectDir: project.dir, stateDir: project.stateDir,
    port: 0, authToken: 'n80-synthetic-auth' };
  const manager = new SessionManager({ tmuxPath: '/usr/bin/tmux', claudePath: '/usr/bin/false', projectDir: project.dir,
    framework: 'codex-cli', maxSessions: 2, protectedSessions: [], completionPatterns: [] }, project.state, {
    stageBActivation: { configured: true, pendingActivation: false, active: true, artifactDigest: null, reason: 'candidate-canary' },
    codexRolloutPathForSession: () => null,
  });
  project.state.saveSession({ id: 'isolated-id', name: 'idle', tmuxSession: 'isolated-idle', status: 'running', framework: 'codex-cli',
    startedAt: new Date().toISOString(), model: 'fixture', maxDurationMinutes: 5 });
  // Production resolves framework from tmux INSTAR_FRAMEWORK; a saved session field is not that observation.
  vi.spyOn(manager as unknown as { getSessionFramework: () => 'codex-cli' }, 'getSessionFramework').mockReturnValue('codex-cli');
  const effect = vi.spyOn(manager as unknown as { performTmuxInjectionEffect: () => void }, 'performTmuxInjectionEffect').mockImplementation(() => {});
  vi.spyOn(manager, 'isSessionAlive').mockReturnValue(true);
  const telegram = new TelegramAdapter({ token: '123:synthetic-n80', chatId: '-100123', authorizedUserIds: [777] }, project.stateDir);
  telegram.registerTopicSession(41, 'isolated-idle', '🧪 Isolated Conversation');
  const notices: string[] = [];
  const send = vi.spyOn(telegram, 'sendToTopic').mockImplementation(async (_topic, text) => {
    notices.push(text); return { messageId: 900 + notices.length };
  });
  const tracker = new CommitmentTracker({ stateDir: project.stateDir });
  wireTelegramRouting(telegram, manager, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, () => tracker);
  const app = express(); app.use(express.json()); app.use(authMiddleware(config.authToken));
  app.use(createRoutes({ config, sessionManager: manager, state: project.state, telegram, commitmentTracker: tracker,
    startTime: new Date(), currentInboundByTopic: new Map(), scheduler: null,
  } as unknown as RouteContext));
  return { project, config, manager, telegram, tracker, app, effect, notices, send,
    close: async () => { tracker.stop(); manager.stopMonitoring(); await telegram.stop(); project.cleanup(); } };
}

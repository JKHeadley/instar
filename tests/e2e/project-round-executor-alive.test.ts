import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { ProjectAutoAdvancePoller } from '../../src/core/ProjectAutoAdvancePoller.js';
import { createProjectRoundExecutor } from '../../src/core/ProjectRoundExecution.js';
import { readProjectRoundDiagnostic } from '../../src/core/ProjectRoundDiagnostics.js';
import { ProjectRoundRunner } from '../../src/core/ProjectRoundRunner.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';
import { SessionManager } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import { TopicProfileResolver } from '../../src/core/TopicProfileResolver.js';
import { TopicProfileStore } from '../../src/core/TopicProfileStore.js';
import type { SessionManagerConfig } from '../../src/core/types.js';

describe('scheduled project round through the production executor', () => {
  it('reads the saved topic model and persists the child diagnostic across a fresh tracker', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-project-round-e2e-'));
    try {
      const stateDir = path.join(root, '.instar');
      fs.mkdirSync(stateDir);
      const git = (args: string[]) => SafeGitExecutor.run(args, {
        cwd: root, operation: 'tests/e2e/project-round-executor-alive.test.ts',
      });
      git(['init', '-q']);
      git(['-c', 'user.name=Round fixture', '-c', 'user.email=round@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'initial']);

      const binaryPath = path.join(root, 'codex-fixture');
      fs.writeFileSync(binaryPath, [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then echo "codex-cli 0.170.0"; exit 0; fi',
        'case "$*" in *INSTAR_STOP_CONDITION*) ;; *) exit 0 ;; esac',
        'if [ "$1" = exec ] && [ "$INSTAR_PROJECT_ID" = test-project ]; then',
        '  echo "project round reached the selected binary" >&2',
        '  exit 0',
        'fi',
        'exit 12',
      ].join('\n'), { mode: 0o755 });

      const machineId = 'round-test-machine';
      const tracker = new InitiativeTracker(stateDir);
      const topicKey = '147723';
      const stateFilePath = path.join(stateDir, 'topic-profiles.json');
      await new TopicProfileStore({ stateFilePath }).mutate(topicKey, {
        framework: 'codex-cli', model: 'gpt-6-luna', updatedBy: 'operator:fixture',
      });
      const profileResolver = new TopicProfileResolver({
        store: new TopicProfileStore({ stateFilePath }),
        defaultFramework: () => 'claude-code',
        configTopicFrameworks: () => ({}),
        configProfileDefaults: () => ({}),
        frameworkDefaultModels: () => ({}),
        tierEscalationConfig: () => undefined,
        localModelBinding: () => null,
        frameworkBinaryPath: (framework) => framework === 'codex-cli' ? binaryPath : null,
      });
      const now = new Date();
      const project = await tracker.create({
        id: 'test-project', title: 'Scheduled fixture', description: 'Scheduled fixture',
        phases: [{ id: 'overview', name: 'Overview' }], kind: 'project', targetRepoPath: root,
        telegramTopicId: topicKey, ownerMachineId: machineId,
        rounds: [{
          name: 'First', itemIds: ['test-item'], status: 'pending',
          autoAdvanceAt: new Date(now.getTime() - 1000).toISOString(),
        }],
      });
      await tracker.update(project.id, { firstLaunchAckAt: now.toISOString(), ifMatch: project.version });
      await tracker.create({
        id: 'test-item', title: 'Item', description: 'Item', phases: [{ id: 'work', name: 'Work' }],
        parentProjectId: 'test-project', pipelineStage: 'outline',
      });
      const sessionManager = new SessionManager({
        tmuxPath: '/usr/bin/false', claudePath: '/usr/bin/false', projectDir: root,
        maxSessions: 1, protectedSessions: [], completionPatterns: [],
      } as SessionManagerConfig, new StateManager(stateDir));
      const executor = createProjectRoundExecutor(tracker, {
        stateDir,
        prepareLaunch: (profile, cwd) => sessionManager.prepareProjectRoundLaunch(profile, cwd),
      }, (topicId) => {
        expect(topicId).toBe(topicKey);
        return { ...profileResolver.resolve(topicId!), binaryPath };
      });
      const runner = new ProjectRoundRunner({ tracker, stateDir, machineId });
      const poller = new ProjectAutoAdvancePoller({ tracker, runner, machineId, executor, now: () => now });
      const tick = await poller.tick();
      expect(tick.executed, JSON.stringify(tick.rejected)).toEqual(['test-project']);
      await expect.poll(() => poller.inFlightCount(), { timeout: 8000 }).toBe(0);
      expect(tick.executorErrors).toEqual([]);
      const restored = new InitiativeTracker(stateDir).get('test-project');
      expect(restored?.rounds?.[0]).toMatchObject({
        status: 'partially-complete',
        lastChildExit: {
          framework: 'codex-cli', model: 'gpt-6-luna', code: 0, signal: null,
        },
      });
      const exit = restored?.rounds?.[0]?.lastChildExit;
      expect(exit).not.toHaveProperty('stderr');
      expect(readProjectRoundDiagnostic(stateDir, 'test-project', 0, exit?.diagnosticRef)?.stderr)
        .toBe('project round reached the selected binary');
    } finally {
      SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/e2e/project-round-executor-alive.test.ts' });
    }
  }, 25_000);
});

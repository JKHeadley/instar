import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { createTempProject } from '../helpers/setup.js';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { ProjectRoundRunner } from '../../src/core/ProjectRoundRunner.js';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';
import { dispatchManagedCodexProject } from '../../src/core/ManagedCodexProjectDispatch.js';
import { verifyManagedCodexStop } from '../../src/core/ManagedCodexStopVerifier.js';
import { ManagedCodexStopStore } from '../../src/core/ManagedCodexStopStore.js';
import type { InstarConfig } from '../../src/core/types.js';
import { resolveCodexNativeCanaryBinary } from '../../src/messaging/telegram-origin/OriginCodexModelCanary.js';
import { CODEX_CANARY_MODELS, openCodexCanaryProvider } from '../../src/messaging/telegram-origin/OriginCodexModelCanaryProtocol.js';

const codex = process.platform === 'darwin'
  ? await resolveCodexNativeCanaryBinary('/usr/local/bin/codex')
    ?? await resolveCodexNativeCanaryBinary('/opt/homebrew/bin/codex')
  : null;

it.skipIf(!codex).each([true, false])('drives an enrolled worker through packaged Stop (enabled=%s)', async (enabled) => {
  const project = createTempProject();
  const projectDir = path.join(project.dir, 'worker');
  const home = path.join(project.dir, 'codex-home');
  const stateDir = path.join(projectDir, '.instar');
  const hookPath = path.join(projectDir, '.claude/skills/autonomous/hooks/autonomous-stop-hook.sh');
  for (const dir of [home, stateDir, path.dirname(hookPath), path.join(projectDir, '.codex')]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.copyFileSync(path.resolve('.claude/skills/autonomous/hooks/autonomous-stop-hook.sh'), hookPath);
  const db = new Database(path.join(stateDir, 'managed-stop.sqlite'));
  const store = new ManagedCodexStopStore(db);
  const cfg = {
    projectName: 'managed-stop-e2e', projectDir, stateDir, port: 0, authToken: 'disposable-managed-stop',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false }, messaging: [], updates: {}, monitoring: {},
    autonomousSessions: { managedCodexContinuation: { enabled } },
  } as InstarConfig;
  const sessionManager = { listRunningSessions: () => [], getSession: () => null, on: () => sessionManager };
  let workerId = '';
  let verifiedCallbacks = 0;
  const server = new AgentServer({
    config: cfg, state: new StateManager(stateDir), sessionManager: sessionManager as never,
    managedCodexStop: {
      store,
      verify: (request, enrollment) => {
        if (request.topicId !== '147616' || request.sessionId !== workerId) return undefined;
        verifiedCallbacks++;
        const rollouts = fs.readdirSync(home, { recursive: true }).map(String)
          .filter(name => name.endsWith(workerId + '.jsonl'));
        if (rollouts.length !== 1) return undefined;
        return verifyManagedCodexStop(request, {
          topicId: '147616', nativeSessionId: workerId,
          machineId: 'fixture-one-member', ownerEpoch: 1,
          codexHome: home, rolloutPath: fs.realpathSync(path.join(home, rollouts[0])),
        }, enrollment, 256 * 1024);
      },
    },
  });
  const abort = new AbortController();
  const provider = await openCodexCanaryProvider(abort.signal);
  try {
    await server.start();
    cfg.port = (server as unknown as { server: { address(): { port: number } } }).server.address().port;
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify(cfg));
    fs.writeFileSync(path.join(stateDir, 'topic-session-registry.json'), JSON.stringify({ topicToSession: { 147616: 'fixture-worker' } }));
    fs.mkdirSync(path.join(stateDir, 'autonomous'));
    fs.writeFileSync(path.join(stateDir, 'autonomous', '147616.local.md'), '---\nactive: true\n---\n');
    const startHook = path.join(projectDir, 'start-hook.cjs');
    fs.writeFileSync(startHook, [
      "const fs = require('node:fs');",
      "const input = JSON.parse(fs.readFileSync(0, 'utf8'));",
      "fs.writeFileSync('.instar/native-session', input.session_id);",
      "const ready = setInterval(() => { if (fs.existsSync('.instar/managed-ready')) { clearInterval(ready); clearTimeout(deadline); } }, 10);",
      "const deadline = setTimeout(() => { clearInterval(ready); process.exitCode = 1; }, 5000);",
    ].join('\n'));
    const hook = (command: string) => [{ matcher: '', hooks: [{ type: 'command', command, timeout: 10 }] }];
    fs.writeFileSync(path.join(projectDir, '.codex/hooks.json'), JSON.stringify({
      hooks: { SessionStart: hook(JSON.stringify(process.execPath) + ' ' + JSON.stringify(startHook)),
        Stop: hook('bash ' + JSON.stringify(hookPath) + ' --codex') },
    }));
    fs.writeFileSync(path.join(home, 'config.toml'), [
      `model = "${CODEX_CANARY_MODELS[0]}"`, 'model_provider = "fixture"', 'approval_policy = "never"',
      'sandbox_mode = "workspace-write"', 'web_search = "disabled"',
      '[sandbox_workspace_write]', 'exclude_tmpdir_env_var = true', 'exclude_slash_tmp = true',
      '[features]', 'shell_snapshot = false', 'codex_hooks = true', '[analytics]', 'enabled = false',
      '[model_providers.fixture]', 'name = "Fixture"', `base_url = "http://127.0.0.1:${provider.port}/v1"`,
      'wire_api = "responses"', 'requires_openai_auth = false', 'supports_websockets = false',
    ].join('\n'));
    SafeGitExecutor.run(['init', '-q'], { cwd: projectDir, operation: 'managed-codex-stop-lifecycle-fixture' });
    const tracker = new InitiativeTracker(stateDir);
    const runner = new ProjectRoundRunner({ tracker, stateDir, machineId: 'fixture-one-member' });
    await tracker.create({
      id: 'managed-project', title: 'Managed test project', description: 'Disposable lifecycle',
      phases: [{ id: 'work', name: 'Work' }], kind: 'project', targetRepoPath: projectDir,
      ownerMachineId: 'fixture-one-member', telegramTopicId: '147616',
      rounds: [{ name: 'Round', itemIds: ['managed-action'], status: 'pending' }],
    });
    await tracker.create({
      id: 'managed-action', title: 'Managed test action', description: 'Disposable approved action',
      phases: [{ id: 'work', name: 'Work' }], parentProjectId: 'managed-project', pipelineStage: 'approved',
    });
    await runner.recordAck('managed-project', 0);
    const readAdmission = () => {
      const candidate = runner.managedRoundCandidate('managed-project', 0);
      return candidate && { ...candidate, ownerEpoch: 1, remaining: 1 };
    };
    const candidate = readAdmission();
    expect(candidate).toBeDefined();
    let child: ReturnType<typeof spawn> | undefined;
    let exited: Promise<unknown[]> | undefined;
    let stderr = '';
    try {
      const admitted = await dispatchManagedCodexProject(candidate!.workKey, {
        // Admit a test worker in both cases. The server switch separately
        // controls whether its authenticated Stop gets a directive.
        enabled: () => true,
        store,
        readAdmission,
        launch: async (_admission, launchId) => {
          child = spawn(codex!, ['exec', '--json', '--trust', '--skip-git-repo-check',
            '--dangerously-bypass-hook-trust', 'Return CANARY_OK without calling tools.'], {
            cwd: projectDir,
            env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home,
              INSTAR_SESSION_ID: launchId, INSTAR_HOOK_TMUX_SESSION: 'fixture-worker', INSTAR_MANAGED_CODEX_STOP: '1' },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          exited = once(child, 'close');
          child.stdout?.resume();
          child.stderr?.on('data', chunk => { stderr += chunk; });
          await vi.waitFor(() => { workerId = fs.readFileSync(path.join(stateDir, 'native-session'), 'utf8'); }, { timeout: 4000 });
          return { launchId, nativeSessionId: workerId };
        },
        verifyLaunch: (_admission, launch) => launch.nativeSessionId === workerId && child?.exitCode === null,
        releaseLaunch: () => fs.writeFileSync(path.join(stateDir, 'managed-ready'), 'ready'),
        cancelLaunch: () => { child?.kill('SIGKILL'); },
      });
      expect(admitted?.nativeSessionId).toBe(workerId);
      expect(exited).toBeDefined();
      const [code] = await exited!;
      expect(code, stderr).toBe(0);
      expect(provider.failed()).toBe(false);
      expect(provider.models).toHaveLength(enabled ? 2 : 1);
      expect(verifiedCallbacks).toBe(enabled ? 2 : 1);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
    }
  } finally {
    await provider.close();
    await server.stop();
    db.close();
    project.cleanup();
  }
}, 30_000);

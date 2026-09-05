// safe-fs-allow: test file — SafeFsExecutor removes only the per-test tmpdir.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';

const AUTH = 'preparation-carrier-e2e';
const TOPIC = '36966';
const TMUX = 'echo-w32';
const HOOK = path.join(process.cwd(), '.claude', 'skills', 'autonomous', 'hooks', 'autonomous-stop-hook.sh');

function runHook(projectDir: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [HOOK, '--codex'], {
      cwd: projectDir,
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: projectDir,
        INSTAR_HOOK_TMUX_SESSION: TMUX,
        INSTAR_HOOK_BACKOFF_DISABLE: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify({ session_id: 'w32-codex-session', transcript_path: '' }));
  });
}

describe('autonomous preparation carrier — production lifecycle (e2e)', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let config: InstarConfig;
  const sentInputs: Array<{ tmux: string; input: string }> = [];
  const auth = () => ({ Authorization: `Bearer ${AUTH}`, 'X-Instar-AgentId': 'preparation-e2e' });

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preparation-carrier-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'autonomous'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'autonomous', `${TOPIC}.local.md`), [
      '---', 'active: false', 'paused: false', `report_topic: "${TOPIC}"`, 'goal: "Window 32"', '---', '',
    ].join('\n'));
    fs.writeFileSync(path.join(stateDir, 'topic-session-registry.json'), JSON.stringify({ topicToSession: { [TOPIC]: TMUX } }));

    config = {
      projectName: 'preparation-e2e', projectDir: tmpDir, stateDir, port: 0,
      authToken: AUTH, requestTimeoutMs: 10000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], updates: {}, monitoring: {},
      autonomousSessions: {
        codexLoopDriver: { enabled: false },
        codexTaskContinuation: {
          enabled: true, preparationCarrierEnabled: true,
          maxDurationSeconds: 3600, maxContinuations: 3,
        },
      },
    } as unknown as InstarConfig;
    const sessionManager = {
      listRunningSessions: () => [], getSession: () => null,
      sendInput: (tmux: string, input: string) => { sentInputs.push({ tmux, input }); return true; },
      on: () => sessionManager,
    };
    server = new AgentServer({
      config,
      state: new StateManager(stateDir),
      sessionManager: sessionManager as never,
    });
    await server.start();
    const port = ((server as unknown as { server: { address(): { port: number } } }).server.address()).port;
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ ...config, port }));
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'autonomous-preparation-carrier-e2e.cleanup' });
  });

  it('is alive through production boot, remains inactive, and drives the real Stop hook', async () => {
    const started = await request(server.getApp()).post('/autonomous/preparation/start').set(auth()).send({
      topicId: TOPIC, sessionId: 'w32-codex-session', tasks: ['repair admission', 'admit W32'],
    });
    expect(started.status).toBe(201);
    expect(started.body).toMatchObject({ preparationState: 'preparing', autonomousRunActive: false });

    const sessions = await request(server.getApp()).get('/autonomous/sessions').set(auth());
    expect(sessions.status).toBe(200);
    expect(sessions.body.sessions[0]).toMatchObject({ active: false, preparationState: 'preparing' });

    const hook = await runHook(tmpDir);
    expect(hook.code).toBe(0);
    expect(hook.stderr).not.toMatch(/state file is missing or malformed/i);
    expect(JSON.parse(hook.stdout)).toMatchObject({ decision: 'block' });

    // Native goal configuration remains an orthogonal framework instruction;
    // it does not promote the autonomous record or consume the active cap.
    const goal = await request(server.getApp()).post('/autonomous/native-goal/set').set(auth())
      .send({ topicId: TOPIC, condition: 'all W32 checks pass' });
    expect(goal.status).toBe(200);
    expect(sentInputs).toContainEqual({ tmux: TMUX, input: '/goal all W32 checks pass' });
    const afterGoal = await request(server.getApp()).get('/autonomous/sessions').set(auth());
    expect(afterGoal.body.sessions[0].active).toBe(false);

    const terminal = await request(server.getApp()).post(`/autonomous/preparation/${TOPIC}/terminalize`).set(auth());
    expect(terminal.status).toBe(200);
    const stoppedHook = await runHook(tmpDir);
    expect(stoppedHook.code).toBe(0);
    expect(stoppedHook.stdout.trim()).toBe('');
  });
});

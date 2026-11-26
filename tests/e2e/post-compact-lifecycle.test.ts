/**
 * context-budget-layered-summaries §9.1 — e2e lifecycle: an existing agent's
 * update path (PostUpdateMigrator.migrateHooks + migrateSettings) installs
 * post-compact.sh and a PostCompact settings entry; running that INSTALLED hook
 * with the stdin Claude Code sends (shape measured on 2.1.321) against a real
 * AgentServer stores the scrubbed summary under the session's topic. The
 * feature is alive end to end: hook → route → store.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { listPostCompactRecords } from '../../src/monitoring/PostCompactStore.js';
import type { InstarConfig } from '../../src/core/types.js';

const AUTH = 'post-compact-e2e-token-abcdef0123';
const CS = 'c1a2b3c4-0000-4000-8000-0000000000e2';

describe('PostCompact lifecycle — installed hook to stored record', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let listener: http.Server;
  let port: number;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'post-compact-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e' }));
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.claude', 'settings.json'), JSON.stringify({ hooks: {} }));

    const migrator = new PostUpdateMigrator({ projectDir: tmpDir, stateDir, port: 0, hasTelegram: true, projectName: 'e2e' });
    const result = { upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] };
    (migrator as unknown as { migrateHooks(r: typeof result): void }).migrateHooks(result);
    (migrator as unknown as { migrateSettings(r: typeof result): void }).migrateSettings(result);
    expect(result.errors.filter(e => e.includes('post-compact'))).toEqual([]);

    const config = {
      projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH,
      requestTimeoutMs: 10000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {},
    } as unknown as InstarConfig;
    const sessionManager = {
      listRunningSessions: () => [], getCachedRunningSessions: () => ({ count: 0, sessions: [] }),
      getSession: () => null, setClaudeSessionId: () => undefined,
      getSessionById: (id: string) => (id === 'inst-e2e' ? { id, tmuxSession: 'e2e-topic', telegramTopicId: 4242 } : undefined),
    };
    server = new AgentServer({ config, sessionManager: sessionManager as never, state: new StateManager(stateDir) });
    await server.start();
    listener = http.createServer(server.getApp());
    await new Promise<void>((r) => listener.listen(0, '127.0.0.1', () => r()));
    port = (listener.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((r) => listener.close(() => r()));
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/post-compact-lifecycle.test.ts' });
  });

  it('the update path installs the hook and its settings entry', () => {
    const hook = path.join(stateDir, 'hooks', 'instar', 'post-compact.sh');
    expect(fs.statSync(hook).mode & 0o100).toBe(0o100);
    const settings = JSON.parse(fs.readFileSync(path.join(tmpDir, '.claude', 'settings.json'), 'utf-8'));
    const entries = settings.hooks.PostCompact as Array<{ hooks: Array<{ command: string }> }>;
    expect(entries.filter(e => e.hooks.some(h => h.command.includes('post-compact.sh')))).toHaveLength(1);
  });

  it('the installed hook stores the summary through the real server', async () => {
    const stdin = JSON.stringify({
      session_id: CS, transcript_path: '/x.jsonl', cwd: tmpDir, hook_event_name: 'PostCompact',
      trigger: 'auto', compact_summary: `Summary: the fold ladder; leaked ${AUTH} once.`,
    });
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn('bash', [path.join(stateDir, 'hooks', 'instar', 'post-compact.sh')], {
        env: { PATH: process.env.PATH ?? '', HOME: tmpDir, CLAUDE_PROJECT_DIR: tmpDir, INSTAR_PORT: String(port), INSTAR_AUTH_TOKEN: AUTH, INSTAR_SESSION_ID: 'inst-e2e' },
      });
      child.on('close', resolve);
      child.stdin.end(stdin);
    });
    expect(code).toBe(0);
    const recs = listPostCompactRecords(stateDir, '4242');
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ trigger: 'auto', claudeSessionId: CS, instarSessionId: 'inst-e2e' });
    expect(recs[0].summary).toContain('the fold ladder');
    expect(recs[0].summary).not.toContain(AUTH);
  });
});

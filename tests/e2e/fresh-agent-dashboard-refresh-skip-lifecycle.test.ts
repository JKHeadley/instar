/**
 * E2E lifecycle — the dashboard-link-refresh job exactly as a new agent gets
 * it (getDefaultJobs → gate + script) run against a REAL listening AgentServer
 * with no Telegram: the gate passes, the script exits 0 and says "skipped",
 * so the scheduler records no failure. With Telegram configured but not
 * running, the same script still exits 1 (the real failure keeps reporting).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { getDefaultJobs } from '../../src/commands/init.js';
import type { InstarConfig, MessagingAdapterConfig } from '../../src/core/types.js';
import { createMockSessionManager } from '../helpers/setup.js';

const run = promisify(execFile);
const AUTH = 'fresh-agent-e2e-token';

type Job = { slug: string; gate?: string; execute: { type: string; value: string } };

describe('dashboard-link-refresh on a fresh agent — production job lifecycle', () => {
  let server: AgentServer | null = null;
  let dir = '';
  afterEach(async () => {
    await server?.stop();
    server = null;
    if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/fresh-agent-dashboard-refresh-skip-lifecycle.test.ts' });
    dir = '';
  });

  async function boot(messaging: MessagingAdapterConfig[]) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-refresh-e2e-'));
    const stateDir = path.join(dir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ authToken: AUTH }));
    const config = {
      projectName: 'fresh-refresh-e2e', projectDir: dir, stateDir, port: 0, host: '127.0.0.1', authToken: AUTH,
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, protectedSessions: [] },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      users: [], messaging, monitoring: {},
    } as unknown as InstarConfig;
    server = new AgentServer({ config, sessionManager: createMockSessionManager() as never, state: new StateManager(stateDir) });
    await server.start();
    const addr = (server as unknown as { server: { address(): { port: number } } }).server.address();
    const job = (getDefaultJobs(addr.port) as Job[]).find(j => j.slug === 'dashboard-link-refresh')!;
    expect(job).toBeDefined();
    const env = { ...process.env, INSTAR_PORT: String(addr.port), INSTAR_AUTH_TOKEN: AUTH };
    return { job, env, cwd: dir };
  }

  it('no Telegram: the gate passes and the script exits 0 with "skipped"', async () => {
    const { job, env, cwd } = await boot([]);
    await run('/bin/sh', ['-c', job.gate!], { env, cwd, timeout: 20_000 });
    const out = await run('/bin/sh', ['-c', job.execute.value], { env, cwd, timeout: 20_000 });
    expect(out.stdout).toContain('[dashboard-link-refresh] skipped');
  }, 60_000);

  it('Telegram configured but not running: the same script still fails (exit 1)', async () => {
    const { job, env, cwd } = await boot([{ type: 'telegram', enabled: true, config: { token: 'x', chatId: '-1' } }]);
    const err = await run('/bin/sh', ['-c', job.execute.value], { env, cwd, timeout: 20_000 }).then(() => null, (e: { code?: number; stderr?: string }) => e);
    expect(err).not.toBeNull();
    expect(err!.code).toBe(1);
    expect(err!.stderr).toContain('HTTP 503');
  }, 60_000);
});

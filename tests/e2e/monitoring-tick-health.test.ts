import { expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import type { InstarConfig } from '../../src/core/types.js';
import type { SessionManager } from '../../src/core/SessionManager.js';
import { OrphanProcessReaper } from '../../src/monitoring/OrphanProcessReaper.js';
import { AgentServer } from '../../src/server/AgentServer.js';
import { createMockSessionManager, createTempProject } from '../helpers/setup.js';

it('serves HTTP health while a monitoring child is slow and coalesces overlapping scans', async () => {
  const project = createTempProject();
  const tmux = path.join(project.dir, 'slow-tmux');
  const started = path.join(project.dir, 'started');
  const release = path.join(project.dir, 'release');
  fs.writeFileSync(tmux, `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(started)}, 'started\\n');
const timer = setInterval(() => {
  if (fs.existsSync(${JSON.stringify(release)})) clearInterval(timer);
}, 20);
`, { mode: 0o700 });

  const sessionManager = Object.assign(createMockSessionManager(), {
    listRecordedRunningSessions: () => [],
    listKnownTmuxSessions: () => new Set<string>(),
  }) as unknown as SessionManager;
  const config = {
    projectName: 'monitoring-health-test', projectDir: project.dir, stateDir: project.stateDir,
    port: 0, authToken: 'test-monitoring-health',
    sessions: { tmuxPath: tmux, claudePath: process.execPath, maxSessions: 1, protectedSessions: [] },
    scheduler: { enabled: false }, messaging: [], updates: {},
  } as unknown as InstarConfig;
  const server = new AgentServer({ config, state: project.state, sessionManager });
  const reaper = new OrphanProcessReaper(config, sessionManager, {
    autoKillOrphans: false, reportExternalProcesses: false,
  });
  let pending: Promise<unknown> | undefined;
  try {
    let finished = false;
    pending = reaper.scan().finally(() => { finished = true; });
    const joined = reaper.scan();
    await expect.poll(() => fs.existsSync(started), { timeout: 3_000 }).toBe(true);
    const health = await request(server.getApp()).get('/health').timeout({ deadline: 1_500 });
    expect(health.status).toBe(200);
    expect(finished).toBe(false);
    expect(fs.readFileSync(started, 'utf8')).toBe('started\n');
    fs.writeFileSync(release, '');
    await Promise.all([pending, joined]);
  } finally {
    fs.writeFileSync(release, '');
    await pending?.catch(() => undefined);
    await server.stop();
    project.cleanup();
  }
}, 12_000);

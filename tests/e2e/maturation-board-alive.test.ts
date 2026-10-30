/** Production-path proof (docs/specs/maturation-board.md): AgentServer mounts
 * GET /maturation/board behind the development-agent gate, reads real review
 * files from the project dir, and hands the board the SAME dark-flag registry
 * instance the growth analyst owns (wiring integrity: not null, not a stub). */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';

const servers: AgentServer[] = [];
const dirs: string[] = [];

async function boot(developmentAgent: boolean) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'mb-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  const reviews = path.join(dir, 'docs/research/feature-maturation/reviews');
  fs.mkdirSync(reviews, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(reviews, `${date}.json`), JSON.stringify({
    schema: 'maturation-review/1', date,
    features: [{ id: 'monitoring.example', title: 'Example', verdict: 'stalled', evidence: 'no runs this week', evidenceReadToday: true, commitments: [] }],
  }));
  const config: InstarConfig = {
    projectName: 'mb-e2e', projectDir: dir, stateDir, port: 0,
    developmentAgent,
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
    monitoring: { growthAnalyst: { enabled: true } } as InstarConfig['monitoring'],
  };
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir) });
  servers.push(server);
  await new Promise((resolve) => setTimeout(resolve, 30));
  return { server, date };
}

afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/maturation-board-alive.test.ts' });
});

describe('maturation board — production wiring', () => {
  it('is alive on a development agent: 200, real review rows, advisory, registry wired', async () => {
    const { server, date } = await boot(true);
    const res = await request(server.getApp()).get('/maturation/board');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ schema: 'maturation-board/1', advisory: true, authority: 'none', reviewDate: date, reviewState: 'ok' });
    expect(res.body.features[0]).toMatchObject({ id: 'monitoring.example', review: { verdict: 'stalled' } });
    // Wiring integrity: the hoisted registry reached the route. "registry-not-running"
    // would mean the route got null instead of the analyst's instance.
    const df = res.body.sources.find((s: { name: string }) => s.name === 'dark-flag');
    expect(df).toBeDefined();
    expect(df.reason).not.toBe('registry-not-running');
    // The console tile probe answers.
    const probe = await request(server.getApp()).get('/maturation/board?part=probe');
    expect(probe.status).toBe(200);
  });

  it('is off on a fleet agent: 503', async () => {
    const { server } = await boot(false);
    const res = await request(server.getApp()).get('/maturation/board');
    expect(res.status).toBe(503);
  });

  it('serves the standalone page shell', async () => {
    const { server } = await boot(true);
    const res = await request(server.getApp()).get('/dashboard/maturation/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Feature maturation');
  });
});

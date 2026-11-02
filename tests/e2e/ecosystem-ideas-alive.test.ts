/**
 * Production-path proof (docs/specs/ecosystem-idea-pipeline.md, Testing): AgentServer builds the
 * pipeline behind the development-agent gate, the route answers 200 not 503, and a full run on a
 * local project holding a hostile CLAUDE.md and a marker-writing script finds the planted idea,
 * writes no marker, and lets no instruction in the project change an outcome. The same run with
 * the file-read step disabled must fail the planted-idea assertion, which proves the test can fail.
 */
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
import { fakeSearch, makeFixtureProject, scriptedCaller } from '../helpers/ecosystemFixture.js';
import type { InstarConfig } from '../../src/core/types.js';
import type { EcosystemRouteContext } from '../../src/ecosystem/buildEcosystemIdeas.js';

const servers: AgentServer[] = [];
const dirs: string[] = [];

async function boot(developmentAgent: boolean, opts: { skipFileRead?: boolean; ecosystem?: object } = {}) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'eco-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  const marker = path.join(dir, 'EXECUTED');
  const project = makeFixtureProject(dir, marker);
  const config = {
    projectName: 'eco-e2e', projectDir: dir, stateDir, port: 0, host: '127.0.0.1', version: '0.0.0', developmentAgent,
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 60_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
    ...(opts.ecosystem ? { ecosystemIdeas: opts.ecosystem } : {}),
  } as unknown as InstarConfig;
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  const server = new AgentServer({
    config, sessionManager, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir),
    ecosystemDeps: {
      search: fakeSearch(),
      callers: () => [scriptedCaller({ framework: 'fw-a' }), scriptedCaller({ framework: 'fw-b' })],
      frameworkVersion: async () => '1',
      quotaUsedPercent: async () => 1,
      fetch: { testOnlyRepoUrl: () => `file://${project.dir}`, scratchRoot: dir },
      testOnlySkipFileRead: opts.skipFileRead,
    },
  } as any);
  servers.push(server);
  await new Promise((r) => setTimeout(r, 30));
  const eco = (server as unknown as { ecosystemIdeas: EcosystemRouteContext | { unavailable: string } | null }).ecosystemIdeas;
  return { server, stateDir, marker, project, eco };
}

afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/ecosystem-ideas-alive.test.ts' });
});

describe('ecosystem ideas: production wiring', () => {
  it('is alive on a development agent: the real service, a 200, and a real run through it', async () => {
    const { server, marker, eco, stateDir } = await boot(true);
    expect(eco).not.toBeNull();
    expect(eco && 'service' in eco).toBe(true);
    const live = eco as EcosystemRouteContext;
    expect(typeof live.service.tick).toBe('function');
    const before = await request(server.getApp()).get('/ecosystem-ideas');
    expect(before.status).toBe(200);
    expect(before.body.neverRun).toBe(true);

    const run = await live.service.tick();
    expect(run?.stoppedBy).toBeNull();
    const after = await request(server.getApp()).get('/ecosystem-ideas');
    expect(after.status).toBe(200);
    expect(after.body.neverRun).toBe(false);
    expect(after.body.watchlist.map((w: { repo: string }) => w.repo)).toEqual(expect.arrayContaining(['openclaw/openclaw', 'NousResearch/hermes-agent', 'mattabate/life-distributable']));
    expect(after.body.admission.every((a: { admitted: boolean }) => a.admitted)).toBe(true);
    // The planted idea was found on every seed, each served by the fixture here.
    expect(after.body.ideas.some((i: { claim: string }) => /watchdog/.test(i.claim))).toBe(true);
    // The hostile file said to mark everything have-it and to run a script. Neither happened.
    expect(fs.existsSync(marker)).toBe(false);
    expect(after.body.ideas.every((i: { verdict: string }) => i.verdict === 'gap')).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'logs', 'ecosystem-ideas.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'state', 'ecosystem', 'events.jsonl'))).toBe(true);
  }, 60_000);

  it('the planted-idea assertion can fail: with the file-read step off, no idea is found', async () => {
    const { eco, marker } = await boot(true, { skipFileRead: true });
    const live = eco as EcosystemRouteContext;
    await live.service.tick();
    expect(live.service.summary().ideas).toEqual([]);
    expect(fs.existsSync(marker)).toBe(false);
  }, 60_000);

  it('is off on a fleet agent: 503, and no service', async () => {
    const { server, eco } = await boot(false);
    expect(eco).toBeNull();
    const res = await request(server.getApp()).get('/ecosystem-ideas');
    expect(res.status).toBe(503);
    expect(res.body.reason).toBe('disabled');
  });

  it('an operator can opt a fleet agent in, and the kill switch beats the dev gate', async () => {
    const opted = await boot(false, { ecosystem: { enabled: true, sourceRoots: [{ repo: 'mine/project' }] } });
    expect((await request(opted.server.getApp()).get('/ecosystem-ideas')).status).toBe(200);
    const killed = await boot(true, { ecosystem: { enabled: false } });
    expect((await request(killed.server.getApp()).get('/ecosystem-ideas')).status).toBe(503);
  });
});

/** Production-path proof (docs/specs/feature-maturation-ladder.md): AgentServer mounts the ladder behind the development-agent gate, and its real D7 service scores a real log. */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { featureEvidence } from '../../src/monitoring/FeatureEvidenceLog.js';
import type { InstarConfig } from '../../src/core/types.js';

const servers: AgentServer[] = [];
const dirs: string[] = [];

async function boot(developmentAgent: boolean) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'ml-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs', 'server-data']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ developmentAgent }));
  const config: InstarConfig = {
    projectName: 'ml-e2e', projectDir: dir, stateDir, port: 0, developmentAgent,
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
    monitoring: {},
  } as unknown as InstarConfig;
  const sessionManager = createMockSessionManager() as never as { on?: unknown };
  sessionManager.on = () => undefined;
  const server = new AgentServer({ config, sessionManager: sessionManager as never, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), commitmentTracker: new CommitmentTracker({ stateDir }) } as never);
  servers.push(server);
  await new Promise(resolve => setTimeout(resolve, 30));
  return { server, dir };
}

afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/maturation-ladder-alive.test.ts' });
});

describe('maturation ladder — production wiring', () => {
  it('is alive on a development agent: 200, the shipped registry parsed, real dependencies', async () => {
    const { server } = await boot(true);
    const res = await request(server.getApp()).get('/maturation/ladder');
    expect(res.status).toBe(200);
    expect(res.body.schema).toBe('maturation-ladder/1');
    expect(res.body.registry).toBe('ok');
    expect(res.body.counts.total).toBeGreaterThan(100);
    // Wiring integrity: not null and not a no-op.
    const ladder = (server as unknown as { maturationLadder: unknown }).maturationLadder as { deps: Record<string, unknown> };
    expect(ladder).not.toBeNull();
    const d = ladder.deps;
    expect(d.d7).not.toBeNull();
    expect(typeof (d.commitments as { record: unknown }).record).toBe('function');
    expect(typeof d.setConfig).toBe('function');
  });

  it('the board carries a ladder owner source', async () => {
    const { server } = await boot(true);
    const res = await request(server.getApp()).get('/maturation/board');
    expect(res.status).toBe(200);
    expect(res.body.sources.find((s: { name: string }) => s.name === 'ladder')).toMatchObject({ ok: true });
    expect(res.body.features.some((f: { owners: Array<{ source: string }> }) => f.owners.some(o => o.source === 'ladder'))).toBe(true);
  });

  it('the evidence call reaches the file, and POST /maturation/evidence works', async () => {
    const { server, dir } = await boot(true);
    const list = await request(server.getApp()).get('/maturation/ladder');
    const id = list.body.features[0].id;
    const res = await request(server.getApp()).post('/maturation/evidence').send({ featureId: id, kind: 'fired', reason: 'a real row' });
    expect(res.status).toBe(200);
    expect(featureEvidence.record(id, { kind: 'held', reason: 'via the shared call' })).toBeTypeOf('string');
    const rows = fs.readFileSync(path.join(dir, 'logs/feature-evidence.jsonl'), 'utf-8').trim().split('\n');
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it('is off on a fleet agent: 503', async () => {
    const { server } = await boot(false);
    expect((await request(server.getApp()).get('/maturation/ladder')).status).toBe(503);
  });
});

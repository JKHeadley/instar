/** Production-path proof (docs/specs/queue-pace.md): AgentServer builds the queue-pace ledger and
 * tuner, mounts GET /queue-pace behind the development-agent gate, and the ledger's real tick
 * reads the review files through the maturation.fix adapter (wiring integrity: the ledger is
 * not null, its adapters are the real ones, and a tick writes a real row to logs/queue-pace.jsonl). */
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
const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

async function boot(developmentAgent: boolean) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'qp-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  const reviews = path.join(dir, 'docs/research/feature-maturation/reviews');
  fs.mkdirSync(reviews, { recursive: true });
  const write = (date: string, features: Array<{ id: string; verdict: string }>) => fs.writeFileSync(path.join(reviews, `${date}.json`), JSON.stringify({
    schema: 'maturation-review/1', date,
    features: features.map((f) => ({ ...f, title: f.id, evidence: 'measured', evidenceReadToday: true, commitments: [] })),
  }));
  write(day(7), [{ id: 'a', verdict: 'stalled' }, { id: 'b', verdict: 'blind' }]);
  write(day(0), [{ id: 'a', verdict: 'on-track' }, { id: 'b', verdict: 'blind' }, { id: 'c', verdict: 'regressed' }]);
  const config: InstarConfig = {
    projectName: 'qp-e2e', projectDir: dir, stateDir, port: 0,
    developmentAgent,
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
  };
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir) });
  servers.push(server);
  await new Promise((resolve) => setTimeout(resolve, 30));
  return { server, stateDir };
}

afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/queue-pace-alive.test.ts' });
});

describe('queue pace — production wiring', () => {
  it('is alive on a development agent: 200, a real tick measures maturation fixes', async () => {
    const { server, stateDir } = await boot(true);
    const internals = server as unknown as { queuePaceLedger: { adapters: Array<{ queue: string }>; tick(): Promise<number> } | null; queuePaceTuner: unknown };
    expect(internals.queuePaceLedger).not.toBeNull();
    expect(internals.queuePaceTuner).not.toBeNull();
    expect(internals.queuePaceLedger!.adapters.map((a) => a.queue)).toContain('maturation.fix');
    expect(await internals.queuePaceLedger!.tick()).toBeGreaterThan(0);
    const rows = fs.readFileSync(path.join(stateDir, 'logs', 'queue-pace.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows.find((r) => r.queue === 'maturation.fix')).toMatchObject({ ok: true, openStart: 2, open: 2, entered: 1, completed: 1 });
    // A single-machine development agent runs the feedback drain, so its queues are measured
    // too: their first row is a baseline (the open set is never counted as arrivals).
    for (const r of rows.filter((x) => String(x.queue).startsWith('feedback.'))) expect(r).toMatchObject({ ok: false, reason: 'baseline' });
    const res = await request(server.getApp()).get('/queue-pace');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ schema: 'queue-pace/1', scope: 'local' });
    const mf = res.body.queues.find((q: { id: string }) => q.id === 'maturation.fix');
    expect(mf).toMatchObject({ label: 'Maturation fixes', open: 2 });
    const pool = await request(server.getApp()).get('/queue-pace?scope=pool');
    expect(pool.status).toBe(200);
  });

  it('is off on a fleet agent: 503', async () => {
    const { server } = await boot(false);
    const res = await request(server.getApp()).get('/queue-pace');
    expect(res.status).toBe(503);
  });
});

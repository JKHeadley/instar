import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type StubStatus = 'OPEN' | 'ACKNOWLEDGED' | 'IN_PROGRESS' | 'DONE' | 'WONT_DO';
type StubItem = {
  id: string;
  title: string;
  summary: string;
  category: string;
  priority: 'URGENT' | 'HIGH' | 'NORMAL' | 'LOW';
  status: StubStatus;
  sourceContext?: string;
  createdAt: string;
  updatedAt: string;
};

function createMockSessionManager() {
  return { listRunningSessions: () => [], getSession: () => null };
}

function createAttentionAdapter() {
  const items = new Map<string, StubItem>();
  return {
    createAttentionItem: async (item: Omit<StubItem, 'createdAt' | 'updatedAt' | 'status'>) => {
      const now = new Date().toISOString();
      const stored: StubItem = { ...item, status: 'OPEN', createdAt: now, updatedAt: now };
      items.set(stored.id, stored);
      return stored;
    },
    getAttentionItems: (status?: string) => {
      const values = [...items.values()];
      return status ? values.filter(i => i.status === status) : values;
    },
    getAttentionItem: (id: string) => items.get(id),
    updateAttentionStatus: async (id: string, status: StubStatus, opts?: { resolution?: string }) => {
      const item = items.get(id) as (StubItem & { resolution?: string }) | undefined;
      if (!item) return false;
      item.status = status;
      if (opts?.resolution !== undefined) item.resolution = opts.resolution;
      item.updatedAt = new Date().toISOString();
      return true;
    },
  };
}

describe('Attention queue vocabulary lifecycle', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  const AUTH = 'test-attention-vocab-e2e';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attention-vocab-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });

    const config: InstarConfig = {
      projectName: 'attention-vocab-e2e',
      projectDir: tmpDir,
      stateDir,
      port: 0,
      authToken: AUTH,
      requestTimeoutMs: 10000,
      version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [],
      monitoring: {},
      updates: {},
    } as InstarConfig;

    server = new AgentServer({
      config,
      sessionManager: createMockSessionManager() as any,
      state: new StateManager(stateDir),
      telegram: createAttentionAdapter() as any,
    });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, {
      recursive: true,
      force: true,
      operation: 'tests/e2e/attention-queue-vocabulary-lifecycle.test.ts',
    });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('creates with documented field aliases and resolves through the documented status alias', async () => {
    const created = await request(app)
      .post('/attention')
      .set(auth())
      .send({
        id: 'att-e2e',
        title: 'Attention e2e',
        body: 'This item uses body/source/medium aliases.',
        category: 'general',
        priority: 'medium',
        source: 'attention-vocabulary-e2e',
      })
      .expect(201);

    expect(created.body.priority).toBe('NORMAL');
    expect(created.body.summary).toBe('This item uses body/source/medium aliases.');
    expect(created.body.sourceContext).toBe('attention-vocabulary-e2e');

    const patched = await request(app)
      .patch('/attention/att-e2e')
      .set(auth())
      .send({ status: 'resolved' })
      .expect(200);

    expect(patched.body.status).toBe('DONE');

    const filtered = await request(app)
      .get('/attention?status=resolved')
      .set(auth())
      .expect(200);

    expect(filtered.body.count).toBe(1);
    expect(filtered.body.items[0]).toMatchObject({ id: 'att-e2e', status: 'DONE' });
  });

  it('refuses a status change carrying a field it would not apply, and stores the resolution it does', async () => {
    await request(app).post('/attention').set(auth()).send({
      id: 'att-partial', title: 'Partial write', summary: 'original', category: 'general', priority: 'NORMAL',
    }).expect(201);

    // The 2026-10-19 case: status + body answered 200, applied the status, dropped the body.
    const refused = await request(app).patch('/attention/att-partial').set(auth())
      .send({ status: 'resolved', body: 'new text' }).expect(400);
    expect(refused.body.unsupportedFields).toEqual(['body']);
    expect(refused.body.supportedFields).toEqual(['status', 'resolution', 'reason']);
    const untouched = await request(app).get('/attention?status=OPEN').set(auth()).expect(200);
    expect(untouched.body.items.find((i: StubItem) => i.id === 'att-partial')).toMatchObject({ status: 'OPEN', summary: 'original' });

    const resolved = await request(app).patch('/attention/att-partial').set(auth())
      .send({ status: 'resolved', resolution: 'Fixed in PR 1' }).expect(200);
    expect(resolved.body).toMatchObject({ status: 'DONE', resolution: 'Fixed in PR 1' });
  });

  it('bounds the live HTTP read without truncating the underlying queue', async () => {
    for (const id of ['bound-a', 'bound-b', 'bound-c']) {
      await request(app).post('/attention').set(auth()).send({
        id, title: id, summary: id, category: 'general', priority: 'NORMAL',
      }).expect(201);
    }
    const bounded = await request(app).get('/attention?limit=2').set(auth()).expect(200);
    const unbounded = await request(app).get('/attention').set(auth()).expect(200);
    expect(bounded.body.count).toBe(2);
    expect(bounded.body.items).toHaveLength(2);
    expect(unbounded.body.count).toBeGreaterThanOrEqual(3);
  });
});

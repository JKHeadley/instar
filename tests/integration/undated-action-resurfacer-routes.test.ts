import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { UndatedActionResurfacer } from '../../src/monitoring/UndatedActionResurfacer.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/undated-action-resurfacer-routes.test.ts' });
});

function appWith(resurfacer: UndatedActionResurfacer | null): express.Express {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'undated-routes-'));
  dirs.push(dir);
  const ctx = {
    config: { projectName: 'test', projectDir: dir, stateDir: path.join(dir, '.instar'), port: 0, sessions: {}, scheduler: {} },
    sessionManager: { listRunningSessions: () => [] },
    state: { getJobState: () => null, getSession: () => null, listSessions: () => [] },
    tokenLedger: null,
    undatedActionResurfacer: resurfacer,
    startTime: new Date(),
  } as unknown as RouteContext;
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctx));
  return app;
}

describe('undated action resurfacer routes', () => {
  it('returns an honest 503 when production construction is absent', async () => {
    const res = await request(appWith(null)).get('/evolution/actions/undated-resurfacer');
    expect(res.status).toBe(503);
    expect(res.body.enabled).toBe(false);
  });

  it('exposes ledger health and drives one dry-run pass', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'undated-engine-'));
    dirs.push(stateDir);
    const resurfacer = new UndatedActionResurfacer(
      { enabled: true, dryRun: true },
      {
        stateDir,
        listActions: () => [{ id: 'ACT-007', title: 'Old invisible row', description: 'Needs review', priority: 'critical', status: 'pending', createdAt: '2026-06-01T00:00:00.000Z' }],
        emitAttention: async () => { throw new Error('dry-run must not emit'); },
        holdsLease: () => true,
        now: () => Date.parse('2026-08-01T00:00:00.000Z'),
      },
    );
    const app = appWith(resurfacer);
    const pass = await request(app).post('/evolution/actions/undated-resurfacer/pass');
    expect(pass.status).toBe(200);
    expect(pass.body.reason).toBe('dry-run');
    expect(pass.body.selectedActionId).toBe('ACT-007');
    const status = await request(app).get('/evolution/actions/undated-resurfacer');
    expect(status.status).toBe(200);
    expect(status.body.ledgerReadable).toBe(true);
    expect(status.body.lastRunError).toBeNull();
    expect(status.body.operational).toBe(true);
    expect(status.body.blockedReason).toBeNull();
    expect(status.body.stateAuthority.mode).toBe('single-machine');
    expect(status.body.totalRuns).toBe(1);
    expect(status.body.lastRun.selectedActionId).toBe('ACT-007');
    expect(status.body.lastAttempt.reason).toBe('dry-run');
  });

  it('refuses at the on-disk byte ceiling and raises one stable capacity signal without truncating history', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'undated-capacity-'));
    dirs.push(stateDir);
    let now = Date.parse('2026-08-01T00:00:00.000Z');
    const attentionIds: string[] = [];
    const rows = Array.from({ length: 20 }, (_, i) => ({
      id: `ACT-${String(i + 1).padStart(3, '0')}`,
      title: `Capacity row ${i + 1}`,
      description: 'Bounded growth fixture',
      priority: 'critical' as const,
      status: 'pending' as const,
      createdAt: new Date(Date.parse('2026-06-01T00:00:00.000Z') + i * 1_000).toISOString(),
    }));
    const resurfacer = new UndatedActionResurfacer(
      { enabled: true, dryRun: false, runIntervalMs: 60_000, cooldownMs: 86_400_000, maxLedgerBytes: 2_048 },
      {
        stateDir,
        listActions: () => rows,
        emitAttention: async (item) => { attentionIds.push(item.id); },
        holdsLease: () => true,
        now: () => now,
      },
    );
    let reason: string | undefined;
    for (let i = 0; i < rows.length && reason !== 'ledger-capacity'; i++) {
      reason = (await resurfacer.run()).reason;
      now += 61_000;
    }
    expect(reason).toBe('ledger-capacity');
    expect(attentionIds).toContain('undated-actions:ledger-capacity');
    expect(resurfacer.status()).toMatchObject({ operational: false, capacityExceeded: true });
    expect(fs.statSync(path.join(stateDir, 'state', 'undated-action-resurfacer.jsonl')).size).toBeLessThanOrEqual(2_048);
  });

  it('uses a new durable series identity after reset under the real Attention dedupe store', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'undated-real-attention-'));
    dirs.push(stateDir);
    const adapter = new TelegramAdapter(
      { token: 'test-token-123', chatId: '-100123456', pollIntervalMs: 100 },
      stateDir,
    );
    let thread = 7_000;
    vi.spyOn(adapter as unknown as { apiCall: (method: string, params: Record<string, unknown>) => Promise<unknown> }, 'apiCall')
      .mockImplementation(async (method: string) => method === 'createForumTopic'
        ? { message_thread_id: ++thread, name: 'Attention' }
        : { message_id: ++thread, ok: true });
    let now = Date.parse('2026-08-01T00:00:00.000Z');
    const row = { id: 'ACT-001', title: 'Original title', description: 'Needs review', priority: 'critical' as const, status: 'pending' as const, createdAt: '2026-06-01T00:00:00.000Z' };
    const resurfacer = new UndatedActionResurfacer(
      { enabled: true, dryRun: false, runIntervalMs: 60_000, cooldownMs: 60_000 },
      {
        stateDir, listActions: () => [row], holdsLease: () => true, now: () => now,
        emitAttention: (item) => adapter.createAttentionItem(item),
      },
    );
    try {
      expect((await resurfacer.run()).reason).toBe('emitted');
      row.title = 'Meaningfully revised title';
      now += 61_000;
      expect((await resurfacer.run()).reason).toBe('no-eligible');
      now += 61_000;
      expect((await resurfacer.run()).reason).toBe('emitted');

      const ids = adapter.getAttentionItems()
        .filter((item) => item.category === 'evolution-action-resurfacing')
        .map((item) => item.id)
        .sort();
      expect(ids).toEqual(['resurface:ACT-001:s1:1', 'resurface:ACT-001:s2:1']);
    } finally {
      await adapter.stop();
    }
  });
});

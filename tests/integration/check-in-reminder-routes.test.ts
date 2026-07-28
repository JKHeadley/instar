/**
 * Tier 2 — the check-in reminder through the REAL Express routes + auth.
 * Spec: docs/specs/dated-commitment-reminder.md (ACT-724).
 *
 * The unit tiers prove the predicate and the reconciler. This proves the wiring:
 * that the route reaches a real tracker and a real transport, that the gate
 * actually gates, and that the idempotency survives the HTTP boundary.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { authMiddleware } from '../../src/server/middleware.js';
import type { Commitment } from '../../src/monitoring/CommitmentTracker.js';

const AUTH = 'test-check-in-reminder';
const PAST = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();

function commitment(over: Partial<Commitment> = {}): Commitment {
  return {
    id: 'CMT-1',
    userRequest: 'report back on the benchmark refresh',
    status: 'pending',
    topicId: 33368,
    checkInAt: PAST,
    ...over,
  } as Commitment;
}

let sent: Array<{ topicId: number; text: string }> = [];
let tmpDirs: string[] = [];

afterEach(() => {
  sent = [];
  for (const d of tmpDirs) {
    try {
      SafeFsExecutor.safeRmSync(d, {
        recursive: true, force: true,
        operation: 'tests/integration/check-in-reminder-routes.test.ts',
      });
    } catch {
      /* best-effort cleanup of a test tmpdir */
    }
  }
  tmpDirs = [];
  vi.restoreAllMocks();
});

function appWith(opts: {
  commitments?: Commitment[];
  enabled?: boolean;
  dryRun?: boolean;
  developmentAgent?: boolean;
  noTransport?: boolean;
  sendThrows?: boolean;
}): express.Express {
  const rows = new Map((opts.commitments ?? []).map((c) => [c.id, { ...c }]));
  const tracker = {
    getAll: () => [...rows.values()],
    mutate: async (id: string, fn: (c: Commitment) => Commitment) => {
      const cur = rows.get(id);
      if (!cur) throw new Error('missing');
      const next = fn({ ...cur });
      rows.set(id, next);
      return next;
    },
  };

  const telegram = opts.noTransport
    ? null
    : {
        sendToTopic: async (topicId: number, text: string) => {
          if (opts.sendThrows) throw new Error('telegram down');
          sent.push({ topicId, text });
          return undefined;
        },
      };

  const commitmentsCfg =
    opts.enabled === undefined && opts.dryRun === undefined
      ? undefined
      : {
          checkInReminder: {
            ...(opts.enabled !== undefined ? { enabled: opts.enabled } : {}),
            ...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {}),
          },
        };

  const ctx = {
    config: {
      projectName: 'test',
      projectDir: '/tmp',
      // A FRESH stateDir per app: the outbound content dedup is durably backed
      // (SQLite, per stateDir) and survives restarts BY DESIGN — which is what
      // makes it a real crash-window mitigation. A shared path would let one
      // test's reminder suppress the next test's identical text.
      stateDir: (() => {
        const d = fs.mkdtempSync(path.join(os.tmpdir(), 'checkin-routes-'));
        tmpDirs.push(d);
        return d;
      })(),
      port: 0,
      authToken: AUTH,
      developmentAgent: opts.developmentAgent ?? true,
      ...(commitmentsCfg ? { commitments: commitmentsCfg } : {}),
      sessions: {} as any,
      scheduler: {} as any,
    } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null } as any,
    commitmentTracker: tracker as any,
    telegram: telegram as any,
    startTime: new Date(),
  } as unknown as RouteContext;

  const app = express();
  app.use(express.json());
  app.use(authMiddleware(() => AUTH, 'test'));
  app.use('/', createRoutes(ctx));
  return app;
}

const auth = { Authorization: `Bearer ${AUTH}` };

describe('POST /commitments/check-in-reminder/pass', () => {
  it('delivers one reminder for a due commitment and reports it', async () => {
    const app = appWith({ commitments: [commitment()], dryRun: false });
    const res = await request(app).post('/commitments/check-in-reminder/pass').set(auth).send({});

    expect(res.status).toBe(200);
    expect(res.body.ran).toBe(true);
    expect(res.body.sent).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].topicId).toBe(33368);
    expect(sent[0].text).toContain('report back on the benchmark refresh');
  });

  it('is idempotent across the HTTP boundary — a second POST sends nothing', async () => {
    const app = appWith({ commitments: [commitment()], dryRun: false });
    await request(app).post('/commitments/check-in-reminder/pass').set(auth).send({});
    const second = await request(app).post('/commitments/check-in-reminder/pass').set(auth).send({});

    expect(second.status).toBe(200);
    expect(second.body.sent).toBe(0);
    expect(second.body.skippedByReason['already-reminded']).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it('sends nothing for a future-dated or delivered commitment', async () => {
    const app = appWith({
      commitments: [
        commitment({ id: 'A', checkInAt: FUTURE }),
        commitment({ id: 'B', status: 'delivered' as any }),
      ],
      dryRun: false,
    });
    const res = await request(app).post('/commitments/check-in-reminder/pass').set(auth).send({});
    expect(res.body.sent).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('dryRun DEFAULTS on when the config omits it — graduation is never implicit', async () => {
    // Only `enabled` is set. The absence of dryRun must NOT be read as "go live".
    const app = appWith({ commitments: [commitment()], enabled: true });
    const res = await request(app).post('/commitments/check-in-reminder/pass').set(auth).send({});
    expect(res.body.dryRun).toBe(true);
    expect(res.body.wouldSend).toBe(1);
    expect(res.body.sent).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('a failed send is NOT recorded as delivered', async () => {
    const app = appWith({ commitments: [commitment()], dryRun: false, sendThrows: true });
    const res = await request(app).post('/commitments/check-in-reminder/pass').set(auth).send({});
    expect(res.body.sent).toBe(0);
    expect(res.body.failed).toBe(1);

    // And the read surface does not claim it went out.
    const view = await request(app).get('/commitments/check-in-reminder').set(auth);
    expect(view.body.pending.map((p: any) => p.id)).toContain('CMT-1');
  });

  it('503s when the feature is dark (fleet posture)', async () => {
    const app = appWith({ commitments: [commitment()], enabled: false, developmentAgent: false });
    const res = await request(app).post('/commitments/check-in-reminder/pass').set(auth).send({});
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('check-in-reminder-not-enabled');
    expect(sent).toHaveLength(0);
  });

  it('503s rather than pretending when there is no delivery transport', async () => {
    const app = appWith({ commitments: [commitment()], dryRun: false, noTransport: true });
    const res = await request(app).post('/commitments/check-in-reminder/pass').set(auth).send({});
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('no-delivery-transport');
  });

  it('requires Bearer auth', async () => {
    const app = appWith({ commitments: [commitment()], dryRun: false });
    const res = await request(app).post('/commitments/check-in-reminder/pass').send({});
    expect(res.status).toBe(401);
  });
});

describe('GET /commitments/check-in-reminder', () => {
  it('lists dated commitments and separates pending from undelivered', async () => {
    const app = appWith({
      commitments: [
        commitment({ id: 'A' }),
        commitment({ id: 'B', checkInReminderFailedAt: new Date().toISOString(), checkInReminderAttempts: 5 }),
        commitment({ id: 'C', checkInAt: undefined }),
      ],
      dryRun: false,
    });
    const res = await request(app).get('/commitments/check-in-reminder').set(auth);

    expect(res.status).toBe(200);
    expect(res.body.datedCount).toBe(2); // C has no date
    expect(res.body.pending.map((p: any) => p.id)).toEqual(['A']);
    expect(res.body.undelivered.map((u: any) => u.id)).toEqual(['B']);
    expect(res.body.undelivered[0].attempts).toBe(5);
  });

  it('503s when dark', async () => {
    const app = appWith({ enabled: false, developmentAgent: false });
    const res = await request(app).get('/commitments/check-in-reminder').set(auth);
    expect(res.status).toBe(503);
  });
});

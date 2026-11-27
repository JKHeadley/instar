/**
 * Tier 2 — a promised update that came due, through the REAL route + auth
 * (docs/specs/promised-update-capture.md).
 *
 * Proves the routes.ts wiring: the pass sends the promised-update line (not the
 * generic check-in text) and hands the promise to the topic's session through
 * telegram.onTopicMessage — the same inbound path that resumes or respawns a
 * topic session. Without that path the line must not claim a pickup.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { authMiddleware } from '../../src/server/middleware.js';
import type { Commitment } from '../../src/monitoring/CommitmentTracker.js';

const AUTH = 'test-promised-update';
const TOPIC = 137342;

function promised(over: Partial<Commitment> = {}): Commitment {
  return {
    id: 'CMT-9',
    userRequest: 'Send the update promised for 7:00 PM',
    agentResponse: 'Next update by about 7 PM.',
    externalKey: `promised-update:${TOPIC}:140584`,
    status: 'pending',
    topicId: TOPIC,
    checkInAt: new Date(Date.now() - 60_000).toISOString(),
    ...over,
  } as Commitment;
}

let tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs) {
    try { SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/promised-update-routes.test.ts' }); } catch { /* best-effort */ }
  }
  tmpDirs = [];
});

function appWith(opts: { commitments: Commitment[]; withSessionPath: boolean }) {
  const rows = new Map(opts.commitments.map((c) => [c.id, { ...c }]));
  const sent: Array<{ topicId: number; text: string }> = [];
  const handed: Array<{ content: string; topicId: unknown; senderUnverified: unknown }> = [];
  const tracker = {
    getAll: () => [...rows.values()],
    mutate: async (id: string, fn: (c: Commitment) => Commitment) => {
      const next = fn({ ...rows.get(id)! });
      rows.set(id, next);
      return next;
    },
  };
  const telegram: Record<string, unknown> = {
    sendToTopic: async (topicId: number, text: string) => { sent.push({ topicId, text }); return undefined; },
  };
  if (opts.withSessionPath) {
    telegram.onTopicMessage = async (m: { content: string; metadata: Record<string, unknown> }) => {
      handed.push({ content: m.content, topicId: m.metadata.messageThreadId, senderUnverified: m.metadata.senderUnverified });
    };
  }
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promised-update-routes-'));
  tmpDirs.push(stateDir);
  const ctx = {
    config: {
      projectName: 'test', projectDir: '/tmp', stateDir, port: 0, authToken: AUTH,
      developmentAgent: true,
      commitments: { checkInReminder: { dryRun: false } },
      sessions: {} as any, scheduler: {} as any,
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
  return { app, sent, handed, rows };
}

const auth = { Authorization: `Bearer ${AUTH}` };
const flush = () => new Promise((r) => setTimeout(r, 20));

describe('POST /commitments/check-in-reminder/pass — promised update overdue', () => {
  it('sends the late-update line and hands the promise to the topic session', async () => {
    const { app, sent, handed, rows } = appWith({ commitments: [promised()], withSessionPath: true });
    const res = await request(app).post('/commitments/check-in-reminder/pass').set(auth).send({});
    await flush();

    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].topicId).toBe(TOPIC);
    expect(sent[0].text).toContain("I said you'd have my next update by 7:00 PM, and I haven't sent it.");
    expect(sent[0].text).toContain("I'm picking it back up now");
    expect(sent[0].text).not.toContain('Check-in I promised you');

    expect(handed).toHaveLength(1);
    expect(handed[0].topicId).toBe(TOPIC);
    expect(handed[0].senderUnverified).toBe(true); // never operator authority
    expect(handed[0].content).toContain('[promised update overdue]');
    expect(handed[0].content).toContain('Next update by about 7 PM.');
    expect(rows.get('CMT-9')?.checkInReminderSentAt).toBeTruthy();
  });

  it('a second pass neither re-sends nor re-hands', async () => {
    const { app, sent, handed } = appWith({ commitments: [promised()], withSessionPath: true });
    await request(app).post('/commitments/check-in-reminder/pass').set(auth).send({});
    await request(app).post('/commitments/check-in-reminder/pass').set(auth).send({});
    await flush();
    expect(sent).toHaveLength(1);
    expect(handed).toHaveLength(1);
  });

  it('with no session path the line does not claim a pickup', async () => {
    const { app, sent } = appWith({ commitments: [promised()], withSessionPath: false });
    await request(app).post('/commitments/check-in-reminder/pass').set(auth).send({});
    expect(sent).toHaveLength(1);
    expect(sent[0].text).not.toContain('picking it back up');
  });

  it('an ordinary dated commitment is not handed to the session', async () => {
    const { app, sent, handed } = appWith({
      commitments: [promised({ id: 'CMT-1', externalKey: undefined, userRequest: 'report back on the benchmark' })],
      withSessionPath: true,
    });
    await request(app).post('/commitments/check-in-reminder/pass').set(auth).send({});
    await flush();
    expect(sent[0].text).toContain('Check-in I promised you');
    expect(handed).toHaveLength(0);
  });
});

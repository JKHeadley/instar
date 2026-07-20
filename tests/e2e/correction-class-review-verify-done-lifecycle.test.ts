/** Tier 3: production AgentServer boot → correction shell/fill + completion audit. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { JSDOM } from 'jsdom';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createMockSessionManager } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';
import { renderClassReviews, renderCompletionAudit } from '../../dashboard/preferences-learning.js';

const AUTH = 'ws1-e2e-token';
const auth = () => ({ Authorization: `Bearer ${AUTH}` });

describe('Correction class review + Verify Before Done production lifecycle', () => {
  let dir: string;
  let server: AgentServer;
  const events: string[] = [];
  const initiatives: Array<Record<string, unknown>> = [];
  const actions: Array<Record<string, unknown>> = [];

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws1-review-e2e-'));
    fs.mkdirSync(path.join(dir, '.instar', 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.instar', 'state', 'jobs'), { recursive: true });
    const config = {
      projectName: 'ws1-e2e', agentName: 'E2E', projectDir: dir, stateDir: path.join(dir, '.instar'),
      port: 0, authToken: AUTH, dashboardPin: '123456', developmentAgent: true,
      monitoring: {
        correctionLearning: { enabled: true },
        correctionClassReview: { enabled: true, dryRun: false },
        completionClaimVerification: { enabled: true, dryRun: true },
      },
    } as InstarConfig;
    const intelligence = { evaluate: vi.fn(async (prompt: string) => prompt.includes('standardReview')
      ? prompt.includes('discard low-value noise')
        ? JSON.stringify({ standardReview: { verdict: 'not-applicable', isPolicyRelaxation: false },
          processReview: { verdict: 'not-applicable' }, rationale: 'noise only', confidence: 'high' })
        : JSON.stringify({ standardReview: { verdict: 'needs-upgrade', standardRef: 'Class-Before-Instance',
          proposedDelta: 'Require class review before fixing an instance.', isPolicyRelaxation: false },
          processReview: { verdict: 'process-gap', proposedDelta: 'Add a record-time durable drain.' },
          rationale: 'the founding correction exposed a whole-class gap', confidence: 'high' })
      : JSON.stringify({ clauses: [{ clauseId: 0, label: 'completed-or-in-progress-assertion',
        completionScope: 'this-turn', actionKind: 'pushed', target: 'ws1',
        corroborated: false, rationale: 'no matching push' }] })) } as any;
    const sessionManager = Object.assign(createMockSessionManager() as any, { on: vi.fn() });
    server = new AgentServer({ config, intelligence, sessionManager,
      state: new StateManager(path.join(dir, '.instar')),
      initiativeTracker: { create: vi.fn(async (input: Record<string, unknown>) => {
        events.push('initiative'); initiatives.push(input); return { id: `INIT-${initiatives.length}` };
      }) } as any,
      evolution: { addAction: vi.fn((input: Record<string, unknown>) => {
        events.push('action'); actions.push(input); return { id: `ACT-${actions.length}` };
      }) } as any,
    });
  });

  afterAll(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'ws1-review-e2e' }));

  it('runs the founding correction through class review before creating its Initiative and Action', async () => {
    const app = server.getApp();
    const created = await request(app).post('/corrections').set(auth()).set('X-Instar-Request', '1')
      .send({ learning: 'the instance was fixed before the missing standard and process gap were reviewed', kind: 'infra-gap' });
    expect(created.status).toBe(201);
    await vi.waitFor(async () => {
      const list = await request(app).get('/class-reviews').set(auth());
      expect(list.status).toBe(200);
      expect(list.body.records).toEqual([expect.objectContaining({
        fillState: 'filled', reviewLifecycle: 'open',
        standardReview: expect.objectContaining({ verdict: 'needs-upgrade', standardRef: 'Class-Before-Instance' }),
        processReview: expect.objectContaining({ verdict: 'process-gap' }),
        initiativeId: 'INIT-1', actionId: 'ACT-1',
      })]);
    });
    expect(initiatives).toHaveLength(1);
    expect(actions).toHaveLength(1);
    expect(events).toEqual(['initiative', 'action']);
    const audit = fs.readFileSync(path.join(dir, '.instar', 'logs', 'correction-class-review.jsonl'), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line));
    expect(audit.findIndex(row => row.event === 'shell-created')).toBeLessThan(audit.findIndex(row => row.event === 'filled'));
    const corrections = await request(app).get('/corrections').set(auth());
    expect(corrections.body.records[0].status).toBe('open');
  });

  it('closes a garbage correction as not-applicable with zero downstream artifacts', async () => {
    const created = await request(server.getApp()).post('/corrections').set(auth()).set('X-Instar-Request', '1')
      .send({ learning: 'discard low-value noise', kind: 'infra-gap' });
    expect(created.status).toBe(201);
    await vi.waitFor(async () => {
      const list = await request(server.getApp()).get('/class-reviews').set(auth());
      expect(list.body.records).toContainEqual(expect.objectContaining({
        reviewLifecycle: 'resolved', standardOutcome: 'no-action', processOutcome: 'no-action',
        standardReview: expect.objectContaining({ verdict: 'not-applicable' }),
        processReview: expect.objectContaining({ verdict: 'not-applicable' }),
      }));
    });
    expect(initiatives).toHaveLength(1);
    expect(actions).toHaveLength(1);
  });

  it('records an uncorroborated signal without blocking the response', async () => {
    const observed = await request(server.getApp()).post('/completion-claim/observe').set(auth())
      .set('X-Instar-Request', '1').send({ message: 'I pushed ws1', evidence: {
        hadToolCalls: true, toolCalls: [{ tool: 'Bash', actionKind: 'other', ok: true }],
        truncated: false, unavailable: false, canaryOk: true,
      } });
    expect(observed.status).toBe(202);
    expect(observed.body).toMatchObject({ blocked: false, queued: true });
    await vi.waitFor(async () => {
      const audit = await request(server.getApp()).get('/completion-claim/audit').set(auth());
      expect(audit.body.records).toEqual([expect.objectContaining({ evaluated: true, flagged: true, dryRun: true })]);

      const doc = new JSDOM('<div id="reviews"></div><div id="claims"></div>').window.document;
      const reviews = await request(server.getApp()).get('/class-reviews').set(auth());
      renderClassReviews(doc, doc.getElementById('reviews'), reviews.body);
      renderCompletionAudit(doc, doc.getElementById('claims'), audit.body);
      expect(doc.getElementById('reviews')?.textContent).toContain('Needs a standard upgrade');
      expect(doc.getElementById('claims')?.textContent).toContain('No — advisory only');
    });
  });
});

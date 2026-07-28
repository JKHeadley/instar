/**
 * Integration tests — /blockers routes (Blocker Ledger, Autonomy Principles
 * Enforcement Piece 1). Tier 2: the REAL inline routes in createRoutes(), behind
 * the real authMiddleware, backed by a real BlockerLedger.
 *
 * Covers (spec §Integration):
 *   - GET /blockers 503 when the ledger is null/dark
 *   - GET /blockers 200 when wired
 *   - a full create → advance → settle(resolved) flow over HTTP
 *   - mutations without `X-Instar-Request: 1` get 403
 *   - the settle writes an audit line to logs/blocker-decisions.jsonl with
 *     origin + the gate decision hash
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { BlockerLedger } from '../../src/monitoring/BlockerLedger.js';
import type { SettleAuthority } from '../../src/monitoring/BlockerLedger.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const AUTH = 'blocker-routes-token';
const auth = () => ({ Authorization: `Bearer ${AUTH}` });
const intent = () => ({ 'X-Instar-Request': '1' });

function ctxFor(stateDir: string, ledger: BlockerLedger | null): RouteContext {
  return {
    config: {
      projectName: 'blocker-routes', projectDir: path.dirname(stateDir), stateDir, port: 0,
      authToken: AUTH,
      monitoring: { blockerLedger: { enabled: !!ledger } },
      sessions: {} as any, scheduler: {} as any,
    } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null } as any,
    scheduler: null, telegram: null, relationships: null, feedback: null,
    dispatches: null, updateChecker: null, autoUpdater: null, autoDispatcher: null,
    quotaTracker: null, publisher: null, viewer: null, tunnel: null, evolution: null,
    watchdog: null, triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null,
    discoveryEvaluator: null, blockerLedger: ledger, startTime: new Date(),
  } as unknown as RouteContext;
}

function appWith(ctx: RouteContext): express.Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware(AUTH));
  app.use('/', createRoutes(ctx));
  return app;
}

/** A fake Tier-1 settle authority that always allows (the resolved path never
 *  invokes it, but we wire it for completeness of the wired ledger). */
const allowAuthority: SettleAuthority = async () => ({
  allow: true,
  reason: 'fake allow authority (test)',
  decisionHash: 'deadbeefdeadbeefdeadbeefdeadbeef',
});

describe('/blockers routes (integration)', () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blocker-routes-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/blocker-ledger-routes.test.ts:afterEach' });
  });

  function wiredLedger(): BlockerLedger {
    // Confine the resolved-playbook check to a dir inside the tmp state so the
    // test can place a real playbook there.
    return new BlockerLedger({
      stateDir,
      settleAuthority: allowAuthority,
      confinedPlaybookRoots: [path.join(stateDir, 'playbooks')],
    });
  }

  it('401 without a bearer token', async () => {
    const res = await request(appWith(ctxFor(stateDir, wiredLedger()))).get('/blockers');
    expect(res.status).toBe(401);
  });

  it('503 on every route when the ledger is null/dark', async () => {
    const app = appWith(ctxFor(stateDir, null));
    const list = await request(app).get('/blockers').set(auth());
    expect(list.status).toBe(503);
    expect(list.body.error).toContain('BlockerLedger not initialized');

    const create = await request(app).post('/blockers').set(auth()).set(intent()).send({ detectedText: 'x', origin: 'o' });
    expect(create.status).toBe(503);
  });

  it('200 with an empty list when wired but no entries', async () => {
    const res = await request(appWith(ctxFor(stateDir, wiredLedger()))).get('/blockers').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  it('POST /blockers requires X-Instar-Request: 1 (403 without)', async () => {
    const app = appWith(ctxFor(stateDir, wiredLedger()));
    const noHeader = await request(app).post('/blockers').set(auth()).send({ detectedText: 'I cannot do this', origin: 'session-1' });
    expect(noHeader.status).toBe(403);
    expect(noHeader.body.error).toContain('X-Instar-Request');

    const withHeader = await request(app).post('/blockers').set(auth()).set(intent()).send({ detectedText: 'I cannot do this', origin: 'session-1' });
    expect(withHeader.status).toBe(201);
    expect(withHeader.body.state).toBe('candidate');
    expect(withHeader.body.id).toMatch(/^BLK-/);
  });

  it('POST /blockers/:id/advance + /settle require X-Instar-Request: 1 (403 without)', async () => {
    const ledger = wiredLedger();
    const app = appWith(ctxFor(stateDir, ledger));
    const created = await request(app).post('/blockers').set(auth()).set(intent()).send({ detectedText: 'd', origin: 'o' });
    const id = created.body.id as string;

    const advNoHeader = await request(app).post(`/blockers/${id}/advance`).set(auth()).send({ origin: 'o' });
    expect(advNoHeader.status).toBe(403);

    const settleNoHeader = await request(app).post(`/blockers/${id}/settle`).set(auth()).send({ origin: 'o', kind: 'resolved', playbookPath: 'x' });
    expect(settleNoHeader.status).toBe(403);
  });

  it('full create → advance → settle(resolved) flow over HTTP', async () => {
    const ledger = wiredLedger();
    const app = appWith(ctxFor(stateDir, ledger));

    // 1. open a candidate
    const created = await request(app).post('/blockers').set(auth()).set(intent())
      .send({ detectedText: 'I cannot fetch this token', origin: 'session-1' });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    expect(created.body.state).toBe('candidate');

    // 2. advance candidate → authority-checked
    const a1 = await request(app).post(`/blockers/${id}/advance`).set(auth()).set(intent())
      .send({ origin: 'session-1', authorityCheck: { agentHasAuthority: true, userHasAuthority: false, note: 'I have a vault token' } });
    expect(a1.status).toBe(200);
    expect(a1.body.state).toBe('authority-checked');

    // 3. → access-requested
    const a2 = await request(app).post(`/blockers/${id}/advance`).set(auth()).set(intent())
      .send({ origin: 'session-1', accessRequest: { messageRef: 'relay-msg-1' } });
    expect(a2.status).toBe(200);
    expect(a2.body.state).toBe('access-requested');

    // 4. → dry-run
    const a3 = await request(app).post(`/blockers/${id}/advance`).set(auth()).set(intent())
      .send({ origin: 'session-1', dryRun: { detail: 'dry-run of the fetch succeeded against staging' } });
    expect(a3.status).toBe(200);
    expect(a3.body.state).toBe('dry-run');

    // 5. → live-run (successful)
    const a4 = await request(app).post(`/blockers/${id}/advance`).set(auth()).set(intent())
      .send({ origin: 'session-1', liveRun: { at: new Date().toISOString(), outcome: 'fetched the token live', succeeded: true } });
    expect(a4.status).toBe(200);
    expect(a4.body.state).toBe('live-run');

    // 6. settle resolved — write a confined playbook that references the id first.
    const playbookDir = path.join(stateDir, 'playbooks');
    fs.mkdirSync(playbookDir, { recursive: true });
    const playbookPath = path.join(playbookDir, `${id}-resolution.md`);
    fs.writeFileSync(playbookPath, `# Resolution for ${id}\n\nFetched the token from the vault.\n`);

    const settled = await request(app).post(`/blockers/${id}/settle`).set(auth()).set(intent())
      .send({ origin: 'session-1', kind: 'resolved', playbookPath });
    expect(settled.status).toBe(200);
    expect(settled.body.state).toBe('resolved');
    expect(settled.body.terminal.kind).toBe('resolved');

    // GET reflects the terminal state.
    const fetched = await request(app).get(`/blockers/${id}`).set(auth());
    expect(fetched.status).toBe(200);
    expect(fetched.body.state).toBe('resolved');
  });

  it('the settle writes an audit line to logs/blocker-decisions.jsonl with origin + gate hash', async () => {
    const ledger = wiredLedger();
    const app = appWith(ctxFor(stateDir, ledger));

    // Walk a blocker to live-run, then settle as a true-blocker so the gate hash
    // is recorded (the resolved settle has no gate hash; the true-blocker one does).
    const created = await request(app).post('/blockers').set(auth()).set(intent())
      .send({ detectedText: 'only the operator holds this password', origin: 'session-7' });
    const id = created.body.id as string;

    // advance to access-requested so the entry has a recorded access-request `at`.
    await request(app).post(`/blockers/${id}/advance`).set(auth()).set(intent())
      .send({ origin: 'session-7', authorityCheck: { agentHasAuthority: false, userHasAuthority: true, note: 'only the user has it' } });
    await request(app).post(`/blockers/${id}/advance`).set(auth()).set(intent())
      .send({ origin: 'session-7', accessRequest: { messageRef: 'relay-7' } });

    const attemptAt = '2026-06-01T10:00:00.000Z';
    const requestAt = '2026-06-01T10:05:00.000Z';
    const settled = await request(app).post(`/blockers/${id}/settle`).set(auth()).set(intent())
      .send({
        origin: 'session-7',
        kind: 'true-blocker',
        reasonKind: 'operator-only-secret',
        rebuttal: 'I checked my vault and gh; neither holds this credential.',
        failedAttempt: { type: 'self-fetch', detail: 'secret-get.mjs returned no such key; gh has no matching secret', at: attemptAt },
        accessRequest: { messageRef: 'relay-7', at: requestAt },
      });
    expect(settled.status).toBe(200);
    expect(settled.body.state).toBe('true-blocker');
    expect(settled.body.terminal.gateDecisionHash).toBe('deadbeefdeadbeefdeadbeefdeadbeef');

    // The audit trail lives at <stateDir>/../logs/blocker-decisions.jsonl.
    const auditPath = path.join(stateDir, '..', 'logs', 'blocker-decisions.jsonl');
    expect(fs.existsSync(auditPath)).toBe(true);
    const lines = fs.readFileSync(auditPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    const settleLine = lines.find((l) => l.event === 'settle' && l.to === 'true-blocker');
    expect(settleLine).toBeTruthy();
    expect(settleLine.origin).toBe('session-7');
    expect(settleLine.gateDecisionHash).toBe('deadbeefdeadbeefdeadbeefdeadbeef');
  });
});

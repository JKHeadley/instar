/**
 * E2E lifecycle — design review records on the production server composition
 * (docs/specs/frontier-design-review-standard.md §3, §4).
 *
 *   Phase 1 — alive: a real AgentServer serves GET /design/review (200, not 503/404)
 *             and GET /design/lane.
 *   Phase 2 — a recorded run comes back as the provenance line.
 *   Phase 3 — a spooled report is taken in when a server starts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { designFingerprint } from '../../src/core/designReviewRecord.js';
import { readDesignReviewLedger } from '../../src/core/designReviewLedger.js';
import { createMockSessionManager } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

const AUTH = 'test-design-review-e2e';

describe('Design review records E2E lifecycle', () => {
  let tmpDir: string;
  let stateDir: string;
  let doc: string;
  const servers: AgentServer[] = [];

  const serverFor = (extra: Partial<InstarConfig> = {}) => {
    const s = new AgentServer({
      config: { projectName: 'design-review-e2e', agentName: 'E2E Agent', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH, ...extra } as InstarConfig,
      sessionManager: createMockSessionManager() as any,
      state: new StateManager(stateDir),
    } as any);
    servers.push(s);
    return s;
  };

  beforeAll(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'design-review-e2e-')));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'design-review-e2e' }));
    doc = path.join(tmpDir, 'plan.md');
    fs.writeFileSync(doc, '# Export plan\n\nShip it.\n');
  });

  afterAll(async () => {
    for (const s of servers) { try { await (s as unknown as { stop?: () => Promise<void> }).stop?.(); } catch { /* ignore */ } }
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'design-review-routes-lifecycle' });
  });

  const report = () => ({
    runId: crypto.randomBytes(16).toString('hex'), path: doc, fingerprint: designFingerprint(fs.readFileSync(doc, 'utf8')), sessionId: null,
    passes: [{ family: 'claude', door: 'claude-code', attempts: [{ askedModel: 'claude-fable-5-2', outcome: 'ok' }], model: 'claude-fable-5-2', modelBasis: 'requested', status: 'ok', verdict: 'CLEAN' }],
  });

  it('Phase 1 — the routes are alive on the production server', async () => {
    const app = serverFor().getApp();
    const get = await request(app).get('/design/review').set('Authorization', `Bearer ${AUTH}`).query({ path: doc });
    expect(get.status).toBe(200);
    expect(get.body.status).toBe('not-reviewed');
    const lane = await request(app).get('/design/lane').set('Authorization', `Bearer ${AUTH}`);
    expect(lane.status).toBe(200);
    expect(lane.body).toMatchObject({ enabled: false, model: 'claude-fable-5-2', wouldRoute: false, reason: 'standard-off' });
    const unauth = await request(app).get('/design/review').query({ path: doc });
    expect(unauth.status).toBe(401);
  });

  it('Phase 2 — a recorded run comes back as the line', async () => {
    const app = serverFor({ developmentAgent: true } as Partial<InstarConfig>).getApp();
    const post = await request(app).post('/design/review/runs').set('Authorization', `Bearer ${AUTH}`).send(report());
    expect(post.status).toBe(201);
    const get = await request(app).get('/design/review').set('Authorization', `Bearer ${AUTH}`).query({ path: doc });
    expect(get.body.status).toBe('reviewed');
    expect(get.body.line).toBe(post.body.line);
    expect(get.body.line).toContain('Claude Fable 5.2 found no issues');
    // The default login now has plan evidence, so a design session would launch on the design model.
    const lane = await request(app).get('/design/lane').set('Authorization', `Bearer ${AUTH}`);
    expect(lane.body).toMatchObject({ enabled: true, wouldRoute: true });
  });

  it('Phase 3 — a spooled report is taken in when the server starts', () => {
    const before = readDesignReviewLedger(stateDir).runs.length;
    fs.writeFileSync(path.join(stateDir, 'design-review-spool.jsonl'), JSON.stringify({ report: report() }) + '\n');
    serverFor();
    expect(readDesignReviewLedger(stateDir).runs.length).toBe(before + 1);
    expect(fs.readFileSync(path.join(stateDir, 'design-review-spool.jsonl'), 'utf8')).toBe('');
  });
});

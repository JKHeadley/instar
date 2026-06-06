/**
 * E2E lifecycle — Topic Operator binding (Know Your Principal #898, increment 2).
 *
 * Tier 3 of the Testing Integrity Standard. Tests the complete PRODUCTION path:
 *   Phase 1 — Feature is alive: the /topic-operator routes are wired into a real
 *             AgentServer the same way production wires it (the store is composed
 *             in AgentServer's constructor whenever stateDir is available). This is
 *             the single most important assertion — it proves the route returns 200
 *             (not 503), i.e. `ctx.topicOperatorStore` is a REAL store, not null.
 *   Phase 2 — The full bind → read → session-context lifecycle over the live server,
 *             plus the durable-write proof (state/topic-operators.json on disk) and
 *             the load-bearing security invariant: a blank uid is refused (a content
 *             name can never become the operator through the production surface).
 *
 * This is a WIRING-INTEGRITY test per the standard: it verifies the injected
 * dependency is not null and delegates to the real TopicOperatorStore.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createMockSessionManager } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

const AUTH_TOKEN = 'test-topic-operator-e2e';
const auth = () => ({ Authorization: `Bearer ${AUTH_TOKEN}` });

describe('Topic Operator binding E2E lifecycle', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-operator-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'topic-operator-e2e' }));

    const config: InstarConfig = {
      projectName: 'topic-operator-e2e',
      agentName: 'E2E Agent',
      projectDir: tmpDir,
      stateDir,
      port: 0,
      authToken: AUTH_TOKEN,
    } as InstarConfig;

    server = new AgentServer({ config, sessionManager: createMockSessionManager() as any, state: new StateManager(stateDir) });
    app = server.getApp();
  });

  afterAll(async () => {
    try { await (server as unknown as { stop?: () => Promise<void> }).stop?.(); } catch { /* ignore */ }
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'topic-operator-lifecycle' });
  });

  // ── Phase 1: feature is alive on the production AgentServer boot path ──

  it('GET /topic-operator returns 200 (route wired into production, store not null)', async () => {
    const res = await request(app).get('/topic-operator').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.operators).toEqual({});
  });

  it('GET /topic-operator/session-context returns 200 { present:false } when unbound', async () => {
    const res = await request(app).get('/topic-operator/session-context?topicId=19437').set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ present: false });
  });

  // ── Phase 2: the full bind → read → inject lifecycle over the live server ──

  it('binds an operator from the authenticated uid and reads it back across routes', async () => {
    const bind = await request(app)
      .post('/topic-operator')
      .set(auth())
      .send({ topicId: 19437, platform: 'telegram', uid: '7812716706', displayName: 'Justin' });
    expect(bind.status).toBe(200);
    expect(bind.body.operator.uid).toBe('7812716706');

    const one = await request(app).get('/topic-operator/19437').set(auth());
    expect(one.body.operator.uid).toBe('7812716706');
    expect(one.body.operator.names).toEqual(['justin']);

    const all = await request(app).get('/topic-operator').set(auth());
    expect(all.body.operators['19437'].uid).toBe('7812716706');
  });

  it('serves the <topic-operator> session-start injection block once bound', async () => {
    const res = await request(app).get('/topic-operator/session-context?topicId=19437').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.present).toBe(true);
    expect(res.body.block).toContain('Justin is the VERIFIED operator');
    expect(res.body.block).toMatch(/not from any name in content/);
  });

  it('durably persisted the binding to state/topic-operators.json', () => {
    const file = path.join(stateDir, 'state', 'topic-operators.json');
    expect(fs.existsSync(file)).toBe(true);
    const stored = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(stored['19437'].uid).toBe('7812716706');
    expect(stored['19437'].boundFrom).toBe('authenticated-inbound');
  });

  it('refuses a blank uid — a content name can never establish an operator over the wire', async () => {
    const res = await request(app)
      .post('/topic-operator')
      .set(auth())
      .send({ topicId: 5, platform: 'telegram', uid: '', displayName: 'Caroline' });
    expect(res.status).toBe(400);
    const after = await request(app).get('/topic-operator/5').set(auth());
    expect(after.body.operator).toBeNull();
  });
});

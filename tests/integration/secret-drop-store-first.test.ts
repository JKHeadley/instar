/**
 * Store-first durable persistence for Secret Drop (2026-06-04).
 *
 * Root problem: a submitted Secret Drop previously lived ONLY in the in-memory
 * `received` map. Any session restart / compaction / cross-machine handoff
 * before the agent consumed it lost the secret outright — the recurring
 * "I handed you a secret and you dropped it" failure (Justin, topic 13481).
 *
 * The fix: on submission the server persists the values store-first to the
 * durable, AES-256-GCM encrypted SecretStore. The retrieve route transparently
 * falls back to that copy when the in-memory one is gone, and a successful
 * consume deletes it. Opt out with config.secrets.persistDrops=false.
 *
 * These tests pin the full route-level contract on BOTH sides of every
 * decision boundary (persist on/off, in-memory hit vs durable fallback,
 * consume vs peek cleanup).
 *
 * Note on the encryption key: these tests run with `secrets.forceFileKey: true`
 * so every SecretStore (route-side AND test-side) uses a per-tmpDir file key and
 * NEVER touches the machine-global OS keychain entry. Without this, a SecretStore
 * constructed against a fresh stateDir generates a new master key and silently
 * OVERWRITES the global keychain entry — which is exactly how an earlier run of
 * this test broke the real agent's vault on 2026-06-05. Tests must never construct
 * a SecretStore without forceFileKey.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { generateAgentToken, deleteAgentToken } from '../../src/messaging/AgentTokenManager.js';
import { SecretStore } from '../../src/core/SecretStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const PROJECT_NAME = 'secret-store-first-test';
let AUTH = '';

function buildCtx(tmpDir: string, secrets?: { persistDrops?: boolean }): RouteContext {
  return {
    config: {
      projectName: PROJECT_NAME,
      projectDir: tmpDir,
      stateDir: path.join(tmpDir, '.instar'),
      port: 0,
      authToken: AUTH,
      // forceFileKey keeps every route-side SecretStore off the machine-global
      // keychain (see header comment) — file key lives inside the tmpDir.
      secrets: { forceFileKey: true, ...(secrets ?? {}) },
    } as never,
    // null sessionManager → the submit handler skips the agent-nudge/spawn path,
    // keeping the test focused on persistence. null telegram → skips the confirm.
    sessionManager: null,
    state: { getJobState: () => null, getSession: () => null } as never,
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, discoveryEvaluator: null, startTime: new Date(),
    mentorRunner: null, currentInboundByTopic: new Map(),
  } as unknown as RouteContext;
}

function mount(tmpDir: string, secrets?: { persistDrops?: boolean }): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(buildCtx(tmpDir, secrets)));
  return app;
}

/** Create a request, fetch the form, and submit values — returns the token. */
async function dropSecret(app: express.Express, values: Record<string, string>, label = 'API Key'): Promise<string> {
  const fields = Object.keys(values).map((name) => ({ name, label: name }));
  const reqRes = await request(app)
    .post('/secrets/request')
    .set('Authorization', `Bearer ${AUTH}`)
    .send({ label, fields, topicId: 13481 });
  expect(reqRes.status).toBe(201);
  const token = reqRes.body.token as string;
  expect(token).toBeTruthy();

  // Fetch the form (unauthed — token+csrf is the auth) and pull the CSRF token.
  const formRes = await request(app).get(`/secrets/drop/${token}`);
  expect(formRes.status).toBe(200);
  const csrf = /name="_csrf" value="([^"]+)"/.exec(formRes.text)?.[1];
  expect(csrf).toBeTruthy();

  const submitRes = await request(app)
    .post(`/secrets/drop/${token}`)
    .send({ _csrf: csrf, ...values });
  expect(submitRes.status).toBe(200);
  expect(submitRes.body.ok).toBe(true);
  return token;
}

describe('Secret Drop — store-first durable persistence', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-store-first-'));
    AUTH = generateAgentToken(PROJECT_NAME);
  });

  afterEach(() => {
    deleteAgentToken(PROJECT_NAME);
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'test-cleanup' });
  });

  it('persists a submission to the durable store the instant it is received', async () => {
    const app = mount(tmpDir);
    const token = await dropSecret(app, { apiKey: 'sk-live-abc123' });

    const store = new SecretStore({ stateDir: path.join(tmpDir, '.instar'), forceFileKey: true });
    const durable = store.get(`secretDrops.${token}`) as
      | { label?: string; topicId?: number; receivedAt?: string; fields?: string[]; values?: Record<string, string> }
      | undefined;

    expect(durable).toBeDefined();
    expect(durable!.values).toEqual({ apiKey: 'sk-live-abc123' });
    expect(durable!.label).toBe('API Key');
    expect(durable!.topicId).toBe(13481);
    expect(durable!.fields).toEqual(['apiKey']);
    expect(typeof durable!.receivedAt).toBe('string');
  });

  it('retrieve falls back to the durable copy when the in-memory copy is gone (churn)', async () => {
    const app = mount(tmpDir);
    // Simulate a submission that survived a restart: only the durable copy
    // exists (a fresh server process has an empty in-memory `received` map).
    const token = 'churn-token-deadbeef';
    const store = new SecretStore({ stateDir: path.join(tmpDir, '.instar'), forceFileKey: true });
    store.set(`secretDrops.${token}`, {
      label: 'Recovered Secret',
      topicId: 13481,
      receivedAt: new Date().toISOString(),
      fields: ['password'],
      values: { password: 'p@ss-survives-churn' },
    });

    const res = await request(app)
      .post(`/secrets/retrieve/${token}`)
      .set('Authorization', `Bearer ${AUTH}`);

    expect(res.status).toBe(200);
    expect(res.body.values).toEqual({ password: 'p@ss-survives-churn' });
    expect(res.body.consumed).toBe(false);

    // Peek (non-consume) must NOT delete the durable copy.
    expect(store.get(`secretDrops.${token}`)).toBeDefined();
  });

  it('a consuming retrieve against the durable copy deletes it', async () => {
    const app = mount(tmpDir);
    const token = 'consume-token-cafef00d';
    const store = new SecretStore({ stateDir: path.join(tmpDir, '.instar'), forceFileKey: true });
    store.set(`secretDrops.${token}`, {
      label: 'One-Time Code',
      topicId: 13481,
      receivedAt: new Date().toISOString(),
      fields: ['code'],
      values: { code: '987654' },
    });

    const res = await request(app)
      .post(`/secrets/retrieve/${token}?consume=true`)
      .set('Authorization', `Bearer ${AUTH}`);

    expect(res.status).toBe(200);
    expect(res.body.values).toEqual({ code: '987654' });
    expect(res.body.consumed).toBe(true);

    // Durable copy is gone after a successful consume — no lingering one-time code.
    expect(store.get(`secretDrops.${token}`)).toBeUndefined();
    // And a second retrieve now 404s (nothing in-memory, nothing durable).
    const second = await request(app)
      .post(`/secrets/retrieve/${token}`)
      .set('Authorization', `Bearer ${AUTH}`);
    expect(second.status).toBe(404);
  });

  it('an in-memory consume also cleans the durable copy', async () => {
    const app = mount(tmpDir);
    // Real submission → both in-memory AND durable copies exist.
    const token = await dropSecret(app, { token: 'ghp_inmemoryconsume' });
    const store = new SecretStore({ stateDir: path.join(tmpDir, '.instar'), forceFileKey: true });
    expect(store.get(`secretDrops.${token}`)).toBeDefined();

    // Consume via the in-memory fast path.
    const res = await request(app)
      .post(`/secrets/retrieve/${token}?consume=true`)
      .set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(200);
    expect(res.body.values).toEqual({ token: 'ghp_inmemoryconsume' });

    // Durable copy cleaned too — a consumed secret never lingers.
    expect(store.get(`secretDrops.${token}`)).toBeUndefined();
  });

  it('persistDrops=false reverts to in-memory-only (nothing durable, no fallback)', async () => {
    const app = mount(tmpDir, { persistDrops: false });
    const token = await dropSecret(app, { apiKey: 'sk-not-persisted' });

    const store = new SecretStore({ stateDir: path.join(tmpDir, '.instar'), forceFileKey: true });
    // Nothing was persisted.
    expect(store.get(`secretDrops.${token}`)).toBeUndefined();

    // The in-memory copy still serves a retrieve (feature is opt-out, not a regression)...
    const peek = await request(app)
      .post(`/secrets/retrieve/${token}`)
      .set('Authorization', `Bearer ${AUTH}`);
    expect(peek.status).toBe(200);
    expect(peek.body.values).toEqual({ apiKey: 'sk-not-persisted' });

    // ...but a churn (only-durable) token has no fallback when the flag is off.
    store.set(`secretDrops.orphan-token`, {
      label: 'Orphan', topicId: 13481, receivedAt: new Date().toISOString(),
      fields: ['x'], values: { x: 'y' },
    });
    const fallback = await request(app)
      .post(`/secrets/retrieve/orphan-token`)
      .set('Authorization', `Bearer ${AUTH}`);
    expect(fallback.status).toBe(404);
  });
});

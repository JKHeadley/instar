// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * E2E lifecycle — durable conversation identity on the PRODUCTION init path
 * (spec durable-conversation-identity §10 Tier 3 — "the single most important
 * test in the spec").
 *
 * Phase 1 (FEATURE IS ALIVE): the real AgentServer init path answers
 * GET /conversations/health 200 — NOT 503 — even when the bootstrap passes no
 * registry (the AgentServer fallback keeps the read surface alive) AND when
 * the bootstrap passes its fully-wired instance.
 *
 * Phase 2 (the increment-1 cycle): inbound-shaped mint → durable restart
 * (a NEW registry instance over the same stateDir, no snapshot flush — the
 * WAL/replay path) → the SAME id resolves → the routes serve it.
 *
 * Phase 3 (behavior-identical): Telegram ids pass through unregistered; the
 * registry stays sparse.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { ConversationRegistry } from '../../src/core/ConversationRegistry.js';
import { slackRoutingKeySyntheticId } from '../../src/core/slackRefreshBinding.js';
import { createMockSessionManager } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const AUTH_TOKEN = 'test-e2e-conversation-identity';

function makeConfig(tmpDir: string, stateDir: string): InstarConfig {
  return {
    projectName: 'e2e-conversation-identity',
    projectDir: tmpDir,
    stateDir,
    port: 0,
    authToken: AUTH_TOKEN,
    requestTimeoutMs: 10000,
    version: '0.0.0-test',
    sessions: {
      claudePath: '/usr/bin/echo',
      maxSessions: 3,
      defaultMaxDurationMinutes: 30,
      protectedSessions: [],
      monitorIntervalMs: 5000,
    },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
    messaging: [],
    monitoring: {},
    updates: {},
  } as unknown as InstarConfig;
}

function makeMockSM() {
  return Object.assign(createMockSessionManager(), {
    on: () => {},
    getProtectedSessions: () => [] as string[],
    captureMeaningfulTail: () => null,
  });
}

describe('durable conversation identity E2E lifecycle (production init path)', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  let registry: ConversationRegistry;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });

    // The bootstrap-parity wiring: a REAL registry passed as the option, the
    // way src/commands/server.ts constructs + passes one.
    registry = new ConversationRegistry({ stateDir, machineId: () => 'e2e-machine' });
    registry.load();

    server = new AgentServer({
      config: makeConfig(tmpDir, stateDir),
      sessionManager: makeMockSM() as never,
      state: new StateManager(stateDir),
      conversationRegistry: registry,
    });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/conversation-registry-lifecycle.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH_TOKEN}` });

  // ── Phase 1: FEATURE IS ALIVE ──────────────────────────────────────────
  it('FEATURE IS ALIVE: GET /conversations/health answers 200, not 503, on the real init path', async () => {
    const res = await request(app).get('/conversations/health').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.recordingEnabled).toBe(true);
    expect(res.body.snapshotSuspended).toBe(false);
    expect(typeof res.body.entryCount).toBe('number');
  });

  it('FEATURE IS ALIVE even without the bootstrap option: the AgentServer fallback keeps the read surface up', async () => {
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-e2e-fallback-'));
    const stateDir2 = path.join(tmp2, '.instar');
    fs.mkdirSync(path.join(stateDir2, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir2, 'logs'), { recursive: true });
    const server2 = new AgentServer({
      config: makeConfig(tmp2, stateDir2),
      sessionManager: makeMockSM() as never,
      state: new StateManager(stateDir2),
      // deliberately NO conversationRegistry option
    });
    await server2.start();
    try {
      const res = await request(server2.getApp()).get('/conversations/health').set(auth());
      expect(res.status).toBe(200);
      expect(res.body.entryCount).toBe(0);
    } finally {
      await server2.stop();
      SafeFsExecutor.safeRmSync(tmp2, { recursive: true, force: true, operation: 'tests/e2e/conversation-registry-lifecycle.test.ts:fallback' });
    }
  });

  // ── Phase 2: the increment-1 cycle (mint → restart → same id → served) ──
  it('inbound mint → durable restart (journal replay, no snapshot flush) → the SAME id resolves and the routes serve it', async () => {
    // §6.3-shaped eager mint for a THREAD conversation (the durable-binding
    // path fsyncs its WAL line; the crash-window proof needs a durable id).
    const routingKey = 'C0BA4F4E0FP:1751412345.123456';
    const minted = registry.mintForDurableBinding(routingKey);
    expect(minted.ok).toBe(true);
    const id = minted.ok ? minted.id : 0;
    expect(id).toBe(slackRoutingKeySyntheticId(routingKey)); // golden parity

    // "Restart": a NEW registry over the same stateDir with NO snapshot flush —
    // the id must come back from the journal (§3.3 WAL rule / §6.2 replay).
    const reopened = new ConversationRegistry({ stateDir, machineId: () => 'e2e-machine' });
    reopened.load();
    const resolved = reopened.resolve(id);
    expect(resolved?.platform === 'slack' && resolved.threadTs).toBe('1751412345.123456');

    // The HTTP surface serves the same identity (the live server's registry).
    const viaRoute = await request(app).get(`/conversations/${id}`).set(auth());
    expect(viaRoute.status).toBe(200);
    expect(viaRoute.body.channelId).toBe('C0BA4F4E0FP');
    expect(viaRoute.body.threadTs).toBe('1751412345.123456');

    const health = await request(app).get('/conversations/health').set(auth());
    expect(health.body.entryCount).toBeGreaterThan(0);
    expect(health.body.lastMintAt).toBeTruthy();
  });

  // ── Phase 3: behavior-identical for existing flows ──────────────────────
  it('Telegram positive ids pass through unregistered — the registry stays SPARSE', async () => {
    const res = await request(app).get('/conversations/12476').set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ platform: 'telegram', topicId: 12476, passThrough: true });
    const list = await request(app).get('/conversations').set(auth());
    // Only the Slack mint from Phase 2 is registered; 12476 never entered.
    expect(list.body.conversations.every((c: { platform: string }) => c.platform === 'slack')).toBe(true);
  });
});

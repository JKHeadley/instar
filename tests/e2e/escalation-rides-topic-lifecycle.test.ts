// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * E2E lifecycle — WS5.3 (escalation-rides-topic) on the PRODUCTION init path.
 *
 * Spec: docs/specs/ws53-escalation-rides-topic.md.
 *
 * Phase 1 (the single most important test): the feature is ALIVE. AgentServer
 * constructs the EscalationHintStore internally on its real init path and
 * exposes it via getEscalationHintStore() — the carry+re-admit seams are wired,
 * not dropped. The integration tests hand-build the carrier and cannot catch a
 * dropped AgentServer wiring; this can.
 *
 * Phase 2 (strict no-op under the dark default): with tierEscalation.enabled
 * false (the fleet default), the store is alive but the path is inert — filing
 * + peeking a hint never throws and the store is empty by default, so a
 * transfer/resume on a default agent does NOTHING.
 *
 * Phase 3: POST /pool/transfer is alive and returns the honest dark 503 on a
 * single-machine install (no session pool wired) — the route through which the
 * WS5.3 source-capture rides is present, never 404/500.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { createMockSessionManager } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const AUTH_TOKEN = 'test-e2e-ws53';

describe('WS5.3 escalation-rides-topic E2E lifecycle (production init path)', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  let config: InstarConfig;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws53-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });

    const mockSM = Object.assign(createMockSessionManager(), {
      on: () => {},
      getProtectedSessions: () => [] as string[],
      captureMeaningfulTail: () => null,
    });

    config = {
      projectName: 'e2e-ws53',
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
      // The dark fleet default: escalation off, ridesTopic off.
      models: {
        tierEscalation: { enabled: false, dryRun: true, ridesTopic: false, costGuards: { requireQuotaHeadroom: false } },
      },
    } as InstarConfig;

    server = new AgentServer({
      config,
      sessionManager: mockSM as never,
      state: new StateManager(stateDir),
    });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/escalation-rides-topic-lifecycle.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH_TOKEN}` });

  // ── Phase 1: FEATURE IS ALIVE ────────────────────────────────────────
  it('FEATURE IS ALIVE: AgentServer constructs the EscalationHintStore on the real init path', () => {
    const store = server.getEscalationHintStore();
    expect(store).not.toBeNull();
  });

  // ── Phase 2: strict no-op under the dark default ─────────────────────
  it('with tierEscalation.enabled false the store is alive but inert (file/peek never throw; empty by default)', () => {
    const store = server.getEscalationHintStore()!;
    // No hint exists for any topic by default — the path is a strict no-op.
    expect(store.peek('13481')).toBeNull();
    // Filing + peeking never throws even though the feature is dark (the store
    // is config-gated at the route/resume seam, not at the store itself).
    expect(() => store.file('13481', { trigger: 'transfer', sourceTier: 'escalated' })).not.toThrow();
    const peeked = store.peek('13481');
    expect(peeked).not.toBeNull();
    expect(peeked!.sourceTier).toBe('escalated');
    // consume-once leaves it clean.
    expect(store.consume('13481')).not.toBeNull();
    expect(store.peek('13481')).toBeNull();
  });

  // ── Phase 3: the transfer route is alive (dark 503 on single-machine) ─
  it('POST /pool/transfer is alive and returns the honest dark 503 (no pool wired), never 404/500', async () => {
    const res = await request(app)
      .post('/pool/transfer')
      .set(auth())
      .send({ topic: 13481, to: 'mini' });
    expect(res.status).toBe(503);
    expect(String(res.body.error)).toMatch(/session pool not available/i);
  });
});

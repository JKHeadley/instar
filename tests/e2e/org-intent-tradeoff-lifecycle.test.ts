/**
 * E2E test — ORG-INTENT tradeoff helper (Phase 3) full lifecycle.
 *
 * Tests the complete PRODUCTION path:
 *   1. Server starts; `/intent/tradeoff-resolve` is reachable (not 503).
 *   2. With a real ORG-INTENT.md on disk, posting valueA/valueB returns a
 *      deterministic resolution per the organization's tradeoff hierarchy.
 *   3. Pair-pattern entries ("X over Y") are honored.
 *   4. List-order entries (plain ranked bullets) are honored.
 *   5. No-match cases return null winner with basis='no-match'.
 *
 * WHY THIS TEST EXISTS:
 * Tier 1 (unit) pins the resolver branches; Tier 2 (integration) pins the
 * HTTP route. This Tier 3 test pins the wiring — boot path through
 * AgentServer / createRoutes / OrgIntentManager / TradeoffResolver.
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

describe('ORG-INTENT tradeoff helper E2E lifecycle', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  const AUTH_TOKEN = 'test-e2e-tradeoff';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'org-intent-tradeoff-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });

    fs.writeFileSync(
      path.join(stateDir, 'config.json'),
      JSON.stringify({ port: 0, projectName: 'tradeoff-e2e', agentName: 'E2E Agent' }),
    );

    fs.writeFileSync(
      path.join(stateDir, 'AGENT.md'),
      '# E2E Agent\n## Intent\n- Be helpful\n',
    );

    fs.writeFileSync(
      path.join(stateDir, 'ORG-INTENT.md'),
      `# Organizational Intent: Acme Inc

## Constraints (Mandatory)
- Never quote internal pricing to external contacts

## Tradeoff Hierarchy
- customer trust over resolution speed
- compliance over convenience
- ethical clarity
- responsiveness
`,
    );

    const config: InstarConfig = {
      projectName: 'tradeoff-e2e',
      agentName: 'E2E Agent',
      projectDir: tmpDir,
      stateDir,
      port: 0,
      authToken: AUTH_TOKEN,
    } as InstarConfig;

    const mockSM = createMockSessionManager();
    const state = new StateManager(stateDir);

    server = new AgentServer({
      config,
      sessionManager: mockSM as any,
      state,
    });

    app = server.getApp();
  });

  afterAll(async () => {
    if (server) {
      try { await (server as unknown as { stop?: () => Promise<void> }).stop?.(); } catch { /* ignore */ }
    }
    SafeFsExecutor.safeRmSync(tmpDir, {
      recursive: true,
      force: true,
      operation: 'tests/e2e/org-intent-tradeoff-lifecycle.test.ts:afterAll',
    });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH_TOKEN}` });

  describe('Phase 1: Feature is alive', () => {
    it('returns 200 from POST /intent/tradeoff-resolve, not 503 — route is wired into production', async () => {
      const res = await request(app)
        .post('/intent/tradeoff-resolve')
        .set(auth())
        .set('Content-Type', 'application/json')
        .send({ valueA: 'speed', valueB: 'trust' });

      // The "feature is alive" check — route reachable through createRoutes
      expect(res.status).toBe(200);
    });
  });

  describe('Phase 2: Pair-pattern resolution', () => {
    it('honors "customer trust over resolution speed"', async () => {
      const res = await request(app)
        .post('/intent/tradeoff-resolve')
        .set(auth())
        .set('Content-Type', 'application/json')
        .send({ valueA: 'customer trust', valueB: 'speed' });

      expect(res.status).toBe(200);
      expect(res.body.winner).toBe('A');
      expect(res.body.basis).toBe('pair-pattern');
      expect(res.body.explanation).toContain('"customer trust"');
    });
  });

  describe('Phase 3: List-order resolution', () => {
    it('returns the earlier-indexed value when only list-order matches', async () => {
      const res = await request(app)
        .post('/intent/tradeoff-resolve')
        .set(auth())
        .set('Content-Type', 'application/json')
        .send({ valueA: 'responsiveness', valueB: 'ethical clarity' });

      expect(res.status).toBe(200);
      expect(res.body.basis).toBe('list-order');
      expect(res.body.winner).toBe('B'); // ethical clarity at position 3, responsiveness at 4
    });
  });

  describe('Phase 4: No-match resolution', () => {
    it('returns null winner when neither value appears in the hierarchy', async () => {
      const res = await request(app)
        .post('/intent/tradeoff-resolve')
        .set(auth())
        .set('Content-Type', 'application/json')
        .send({ valueA: 'foo', valueB: 'bar' });

      expect(res.status).toBe(200);
      expect(res.body.winner).toBe(null);
      expect(res.body.basis).toBe('no-match');
      expect(res.body.explanation).toContain('escalate to value-alignment review');
    });
  });

  describe('Phase 5: Input validation', () => {
    it('returns 400 when valueA is missing', async () => {
      const res = await request(app)
        .post('/intent/tradeoff-resolve')
        .set(auth())
        .set('Content-Type', 'application/json')
        .send({ valueB: 'speed' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('valueA');
    });
  });
});

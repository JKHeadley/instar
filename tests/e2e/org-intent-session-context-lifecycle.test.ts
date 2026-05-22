/**
 * E2E test — ORG-INTENT session-start injection (Phase 2) full lifecycle.
 *
 * Tests the complete PRODUCTION path:
 *   1. Server starts; `/intent/org/session-context` is reachable (not 503).
 *   2. With a real ORG-INTENT.md on disk, the route returns a parsed,
 *      formatted block ready for the session-start hook to inject.
 *   3. With ORG-INTENT.md absent / template-only, the route responds
 *      `{ present: false }` and the session-start hook will inject nothing.
 *   4. The format matches what the session-start hook (installed by
 *      `PostUpdateMigrator.getSessionStartHook()`) expects to consume.
 *
 * WHY THIS TEST EXISTS:
 * Tier-1 unit tests pin the formatter shape; Tier-2 integration tests
 * pin the HTTP route. This Tier-3 test pins the wiring — the boot path
 * from `AgentServer` through `createRoutes` to the response.
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

describe('ORG-INTENT session-start injection E2E lifecycle', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  const AUTH_TOKEN = 'test-e2e-session-context';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'org-intent-session-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });

    fs.writeFileSync(
      path.join(stateDir, 'config.json'),
      JSON.stringify({ port: 0, projectName: 'org-intent-session-e2e', agentName: 'E2E Agent' }),
    );

    fs.writeFileSync(
      path.join(stateDir, 'AGENT.md'),
      '# E2E Agent\n## Intent\n- Be helpful\n- Respect org intent\n',
    );

    fs.writeFileSync(
      path.join(stateDir, 'ORG-INTENT.md'),
      `# Organizational Intent: Acme Inc

## Constraints (Mandatory)
- Never quote internal pricing to external contacts
- Always disclose AI nature on first interaction

## Goals (Defaults)
- Resolve customer questions on first contact when possible

## Values
- Honesty over expedience

## Tradeoff Hierarchy
- Customer trust over resolution speed
- Compliance over convenience
`,
    );

    const config: InstarConfig = {
      projectName: 'org-intent-session-e2e',
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
      operation: 'tests/e2e/org-intent-session-context-lifecycle.test.ts:afterAll',
    });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH_TOKEN}` });

  describe('Phase 1: Feature is alive', () => {
    it('returns 200 from /intent/org/session-context, not 503 — route is wired into production', async () => {
      const res = await request(app)
        .get('/intent/org/session-context')
        .set(auth());

      // The single most important assertion: route is wired through createRoutes()
      // into AgentServer the same way production wires it.
      expect(res.status).toBe(200);
    });
  });

  describe('Phase 2: ORG-INTENT.md surfaces through the HTTP pipeline', () => {
    it('returns a populated block with all four sections when ORG-INTENT.md is authored', async () => {
      const res = await request(app)
        .get('/intent/org/session-context')
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body.present).toBe(true);
      expect(res.body.name).toBe('Acme Inc');
      expect(res.body.block).toContain('=== ORGANIZATIONAL INTENT ===');
      expect(res.body.block).toContain('CONSTRAINTS (mandatory');
      expect(res.body.block).toContain('GOALS (organizational defaults');
      expect(res.body.block).toContain('VALUES (representation');
      expect(res.body.block).toContain('TRADEOFF HIERARCHY (when two values pull in opposite directions');
      expect(res.body.block).toContain('Never quote internal pricing to external contacts');
      expect(res.body.block).toContain('Customer trust over resolution speed');
      expect(res.body.block).toContain('=== END ORGANIZATIONAL INTENT ===');

      // Counts mirror the bullets in the source file
      expect(res.body.counts).toEqual({
        constraints: 2,
        goals: 1,
        values: 1,
        tradeoffHierarchy: 2,
      });
    });
  });

  describe('Phase 3: Absent / template-only ORG-INTENT.md', () => {
    it('returns { present: false } and nothing more', async () => {
      // Replace ORG-INTENT.md with a template-only (HTML-comments-only) version
      fs.writeFileSync(
        path.join(stateDir, 'ORG-INTENT.md'),
        `# Organizational Intent: <!-- name -->

<!-- This is a template placeholder. -->

## Constraints (Mandatory)
<!-- list constraints here -->
`,
      );

      const res = await request(app)
        .get('/intent/org/session-context')
        .set(auth());

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ present: false });
    });
  });
});

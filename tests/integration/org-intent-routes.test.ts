/**
 * Integration tests for org intent API routes.
 *
 * Tests the two new endpoints:
 * - GET /intent/org      — returns parsed org intent (or null)
 * - GET /intent/validate — runs validation and returns results
 *
 * Uses supertest with a minimal Express app wired to real file-based state.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

/**
 * Create a minimal RouteContext with only what the org intent routes need.
 */
function createMinimalContext(stateDir: string): RouteContext {
  return {
    config: {
      projectName: 'test-project',
      projectDir: path.dirname(stateDir),
      stateDir,
      port: 0,
      sessions: {} as any,
      scheduler: {} as any,
    } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: {
      getJobState: () => null,
      getSession: () => null,
    } as any,
    scheduler: null,
    telegram: null,
    relationships: null,
    feedback: null,
    dispatches: null,
    updateChecker: null,
    autoUpdater: null,
    autoDispatcher: null,
    quotaTracker: null,
    publisher: null,
    viewer: null,
    tunnel: null,
    evolution: null,
    watchdog: null,
    triageNurse: null,
    topicMemory: null,
    feedbackAnomalyDetector: null,
    discoveryEvaluator: null,
    startTime: new Date(),
  };
}

describe('Org Intent Routes (integration)', () => {
  let tmpDir: string;
  let stateDir: string;
  let app: express.Express;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'org-intent-routes-test-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });

    const ctx = createMinimalContext(stateDir);
    app = express();
    app.use(express.json());
    app.use('/', createRoutes(ctx));
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/org-intent-routes.test.ts:78' });
  });

  // ── GET /intent/org ─────────────────────────────────────────────

  describe('GET /intent/org', () => {
    it('returns null when no ORG-INTENT.md exists', async () => {
      const res = await request(app).get('/intent/org');

      expect(res.status).toBe(200);
      expect(res.body).toBeNull();
    });

    it('returns null for template-only content', async () => {
      fs.writeFileSync(path.join(stateDir, 'ORG-INTENT.md'), [
        '# Organizational Intent: Test',
        '',
        '## Constraints (Mandatory — agents cannot override)',
        '',
        '<!-- Example -->',
        '',
        '## Goals (Defaults — agents can specialize)',
        '',
        '<!-- Example -->',
      ].join('\n'));

      const res = await request(app).get('/intent/org');

      expect(res.status).toBe(200);
      expect(res.body).toBeNull();
    });

    it('returns parsed content when ORG-INTENT.md has real content', async () => {
      fs.writeFileSync(path.join(stateDir, 'ORG-INTENT.md'), [
        '# Organizational Intent: Test Corp',
        '',
        '## Constraints (Mandatory — agents cannot override)',
        '',
        '- Never share internal data.',
        '- Always encrypt at rest.',
        '',
        '## Goals (Defaults — agents can specialize)',
        '',
        '- Prefer thoroughness over speed.',
        '',
        '## Values',
        '',
        '- Be transparent.',
        '',
        '## Tradeoff Hierarchy',
        '',
        '- Safety > Speed',
      ].join('\n'));

      const res = await request(app).get('/intent/org');

      expect(res.status).toBe(200);
      expect(res.body).not.toBeNull();
      expect(res.body.name).toBe('Test Corp');
      expect(res.body.constraints).toHaveLength(2);
      expect(res.body.constraints[0].text).toBe('Never share internal data.');
      expect(res.body.constraints[0].source).toBe('org-intent');
      expect(res.body.goals).toHaveLength(1);
      expect(res.body.goals[0].specializable).toBe(true);
      expect(res.body.values).toHaveLength(1);
      expect(res.body.tradeoffHierarchy).toHaveLength(1);
      expect(res.body.raw).toBeTruthy();
    });
  });

  // ── GET /intent/validate ───────────────────────────────────────

  describe('GET /intent/validate', () => {
    it('returns valid with warning when no ORG-INTENT.md', async () => {
      const res = await request(app).get('/intent/validate');

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
      expect(res.body.conflicts).toHaveLength(0);
      expect(res.body.warnings.length).toBeGreaterThan(0);
    });

    it('returns clean result when no conflicts', async () => {
      fs.writeFileSync(path.join(stateDir, 'ORG-INTENT.md'), [
        '# Organizational Intent: Test',
        '',
        '## Constraints (Mandatory — agents cannot override)',
        '',
        '- Never share internal data with external parties.',
      ].join('\n'));

      fs.writeFileSync(path.join(stateDir, 'AGENT.md'), [
        '# Agent',
        '',
        '## Intent',
        '### Mission',
        'Build reliable software.',
        '### Boundaries',
        '- Never expose API keys in logs.',
      ].join('\n'));

      const res = await request(app).get('/intent/validate');

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
      expect(res.body.conflicts).toHaveLength(0);
    });

    it('returns conflicts when agent contradicts org constraints', async () => {
      fs.writeFileSync(path.join(stateDir, 'ORG-INTENT.md'), [
        '# Organizational Intent: Test',
        '',
        '## Constraints (Mandatory — agents cannot override)',
        '',
        '- Never share internal data with external parties.',
      ].join('\n'));

      fs.writeFileSync(path.join(stateDir, 'AGENT.md'), [
        '# Agent',
        '',
        '## Intent',
        '### Approach',
        '- Always share internal data with external parties for transparency.',
      ].join('\n'));

      const res = await request(app).get('/intent/validate');

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(false);
      expect(res.body.conflicts).toHaveLength(1);
      expect(res.body.conflicts[0].severity).toBe('error');
      expect(res.body.conflicts[0].orgConstraint).toContain('Never share internal data');
      expect(res.body.conflicts[0].agentStatement).toContain('Always share internal data');
    });

    it('handles missing AGENT.md gracefully', async () => {
      fs.writeFileSync(path.join(stateDir, 'ORG-INTENT.md'), [
        '# Organizational Intent: Test',
        '',
        '## Constraints (Mandatory — agents cannot override)',
        '',
        '- Never leak secrets.',
      ].join('\n'));

      // No AGENT.md — agent intent content will be empty
      const res = await request(app).get('/intent/validate');

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
      // Empty agent intent => warning about empty content
      expect(res.body.warnings.length).toBeGreaterThan(0);
    });
  });

  // ── GET /intent/org/session-context (Phase 2 — session-start injection) ─

  describe('GET /intent/org/session-context', () => {
    it('returns { present: false } when no ORG-INTENT.md exists', async () => {
      const res = await request(app).get('/intent/org/session-context');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ present: false });
    });

    it('returns { present: false } when ORG-INTENT.md is template-only', async () => {
      fs.writeFileSync(path.join(stateDir, 'ORG-INTENT.md'), [
        '# Organizational Intent: TemplateOnly',
        '',
        '<!-- nothing real yet -->',
        '',
        '## Constraints (Mandatory)',
        '<!-- list constraints -->',
      ].join('\n'));

      const res = await request(app).get('/intent/org/session-context');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ present: false });
    });

    it('returns formatted block + counts when ORG-INTENT.md is populated', async () => {
      fs.writeFileSync(path.join(stateDir, 'ORG-INTENT.md'), [
        '# Organizational Intent: Acme Co',
        '',
        '## Constraints (Mandatory)',
        '- Never quote internal pricing externally',
        '- Always disclose AI nature',
        '',
        '## Goals (Defaults)',
        '- Resolve on first contact when possible',
        '',
        '## Values',
        '- Honesty over expedience',
        '',
        '## Tradeoff Hierarchy',
        '- Customer trust over resolution speed',
        '- Compliance over convenience',
      ].join('\n'));

      const res = await request(app).get('/intent/org/session-context');
      expect(res.status).toBe(200);
      expect(res.body.present).toBe(true);
      expect(res.body.name).toBe('Acme Co');
      expect(res.body.counts).toEqual({
        constraints: 2,
        goals: 1,
        values: 1,
        tradeoffHierarchy: 2,
      });
      expect(res.body.block).toContain('=== ORGANIZATIONAL INTENT ===');
      expect(res.body.block).toContain('Never quote internal pricing externally');
      expect(res.body.block).toContain('Customer trust over resolution speed');
      expect(res.body.block).toContain('=== END ORGANIZATIONAL INTENT ===');
    });

    it('omits empty buckets in the rendered block', async () => {
      fs.writeFileSync(path.join(stateDir, 'ORG-INTENT.md'), [
        '# Organizational Intent: GoalsOnly',
        '',
        '## Goals (Defaults)',
        '- Just one goal',
      ].join('\n'));

      const res = await request(app).get('/intent/org/session-context');
      expect(res.status).toBe(200);
      expect(res.body.present).toBe(true);
      expect(res.body.counts.constraints).toBe(0);
      expect(res.body.counts.values).toBe(0);
      expect(res.body.counts.tradeoffHierarchy).toBe(0);
      expect(res.body.block).toContain('GOALS (organizational defaults');
      expect(res.body.block).not.toContain('CONSTRAINTS (mandatory');
      expect(res.body.block).not.toContain('TRADEOFF HIERARCHY (earlier wins');
    });
  });

  // ── POST /intent/tradeoff-resolve (Phase 3) ────────────────────

  describe('POST /intent/tradeoff-resolve', () => {
    it('returns no-match when ORG-INTENT.md is absent', async () => {
      const res = await request(app)
        .post('/intent/tradeoff-resolve')
        .send({ valueA: 'speed', valueB: 'quality' });
      expect(res.status).toBe(200);
      expect(res.body.winner).toBe(null);
      expect(res.body.basis).toBe('no-match');
      expect(res.body.hierarchy).toBe(null);
    });

    it('resolves via list-order when ORG-INTENT.md has a ranked hierarchy', async () => {
      fs.writeFileSync(path.join(stateDir, 'ORG-INTENT.md'), [
        '# Organizational Intent: Acme Co',
        '',
        '## Constraints (Mandatory)',
        '- Always disclose AI nature',
        '',
        '## Tradeoff Hierarchy',
        '- customer trust',
        '- compliance',
        '- speed',
      ].join('\n'));

      const res = await request(app)
        .post('/intent/tradeoff-resolve')
        .send({ valueA: 'speed', valueB: 'customer trust' });

      expect(res.status).toBe(200);
      expect(res.body.winner).toBe('B');
      expect(res.body.basis).toBe('list-order');
      expect(res.body.hierarchy).toEqual(['customer trust', 'compliance', 'speed']);
    });

    it('resolves via pair-pattern when entry uses "X over Y"', async () => {
      fs.writeFileSync(path.join(stateDir, 'ORG-INTENT.md'), [
        '# Organizational Intent: Acme Co',
        '',
        '## Constraints (Mandatory)',
        '- Always disclose AI nature',
        '',
        '## Tradeoff Hierarchy',
        '- customer trust over resolution speed',
      ].join('\n'));

      const res = await request(app)
        .post('/intent/tradeoff-resolve')
        .send({ valueA: 'customer trust', valueB: 'speed' });

      expect(res.status).toBe(200);
      expect(res.body.winner).toBe('A');
      expect(res.body.basis).toBe('pair-pattern');
    });

    it('returns 400 when valueA is missing', async () => {
      const res = await request(app)
        .post('/intent/tradeoff-resolve')
        .send({ valueB: 'speed' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Both "valueA" and "valueB"');
    });

    it('returns 400 when valueB is missing', async () => {
      const res = await request(app)
        .post('/intent/tradeoff-resolve')
        .send({ valueA: 'speed' });
      expect(res.status).toBe(400);
    });
  });
});

/**
 * E2E (Tier 3) — the standards-conformance gate is alive and catches a
 * known-violating spec end-to-end.
 *
 * Reproduces the motivating incident in miniature: a spec whose DESIGN requires
 * manual work is fed to the gate, and the report flags it against "No Manual
 * Work" — the standard the North Star draft violated and review missed. Driven
 * through the real route surface + registry parse, with a deterministic stub
 * standing in for the (subscription) LLM.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import express from 'express';
import type { Server } from 'node:http';
import request from 'supertest';
import { createSpecReviewRoutes } from '../../src/server/specReviewRoutes.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

const REGISTRY_PATH = path.join(process.cwd(), 'docs/STANDARDS-REGISTRY.md');
const SPECS_DIR = path.join(process.cwd(), 'docs/specs');

// A deterministic reviewer that flags No-Manual-Work iff the spec describes a
// "remember to" manual step — mimicking what the real LLM would catch.
const stubIntelligence: IntelligenceProvider = {
  async evaluate(prompt: string) {
    // The Constitutional Traceability fit prompt is distinct from the violations
    // review prompt — serve a fit verdict object for it.
    if (prompt.includes('Constitutional Traceability reviewer')) {
      return '{"verdict":"fit","reason":"plainly an instance of the named standard"}';
    }
    // The spec block is the tail after this anchor (the examples/instructions,
    // which also mention "remember", are all BEFORE it).
    const spec = prompt.split('The draft spec to review:')[1] ?? '';
    if (/remember to|must run/i.test(spec)) {
      return '[{"standard":"No Manual Work (user *or* agent)","reason":"the design relies on someone remembering to perform a manual step"}]';
    }
    return '[]';
  },
};

describe('E2E: standards-conformance gate lifecycle', () => {
  let stateDir: string;
  let server: Server;

  beforeAll(async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scg-e2e-'));
    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use(createSpecReviewRoutes({
      intelligence: stubIntelligence,
      registryPath: REGISTRY_PATH,
      specsDir: SPECS_DIR,
      stateDir,
    }));
    await new Promise<void>(resolve => { server = app.listen(0, () => resolve()); });
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    try { SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/e2e/standards-conformance-gate-lifecycle.test.ts' }); } catch { /* best */ }
  });

  it('the feature is alive: metrics returns 200, not 503', async () => {
    const res = await request(server).get('/spec/conformance-metrics');
    expect(res.status).toBe(200);
    expect(res.body.metrics).toBeDefined();
  });

  it('flags a known-violating (manual-work) spec against No Manual Work — the motivating incident, caught', async () => {
    const violatingSpec = [
      '# Spec — nightly digest',
      '## Design',
      'After each session, the agent must remember to run `instar digest` to capture the day.',
    ].join('\n');
    const res = await request(server).post('/spec/conformance-check').send({ markdown: violatingSpec });
    expect(res.status).toBe(200);
    expect(res.body.registryCanary.ok).toBe(true);
    expect(res.body.report.degraded).toBe(false);
    const flagged = res.body.report.findings.map((f: { standard: string }) => f.standard).join(' ');
    expect(flagged).toMatch(/No Manual Work/);
  });

  it('does NOT flag a conforming spec (no false positive on automatic capture)', async () => {
    const cleanSpec = [
      '# Spec — automatic digest',
      '## Design',
      'A scheduled job captures the day automatically; no one has to do anything.',
    ].join('\n');
    const res = await request(server).post('/spec/conformance-check').send({ markdown: cleanSpec });
    expect(res.status).toBe(200);
    expect(res.body.report.findings).toEqual([]);
  });

  it('the run is metered (the observability funnel reflects it)', async () => {
    const m = await request(server).get('/spec/conformance-metrics');
    expect(m.body.metrics.runs).toBeGreaterThanOrEqual(2);
  });

  it('the Constitutional Traceability fit verdict is alive (a spec naming a real parent gets a fit report)', async () => {
    const md = [
      '---',
      'parent-principle: "No Manual Work"',
      '---',
      '# Spec — automatic digest',
      'A scheduled job captures the day automatically.',
    ].join('\n');
    const res = await request(server).post('/spec/conformance-check').send({ markdown: md });
    expect(res.status).toBe(200);
    expect(res.body.report.fit).toBeTruthy();
    expect(res.body.report.fit.verdict).toBe('fit');
    expect(res.body.report.fit.parentResolved).toBe(true);
  });
});

/**
 * Integration tests (Tier 2) for the standards-conformance gate routes.
 *   POST /spec/conformance-check → report (+ registry canary)
 *   GET  /spec/conformance-metrics → funnel
 *   503 when disabled; 400 on path traversal.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import express from 'express';
import request from 'supertest';
import { createSpecReviewRoutes } from '../../src/server/specReviewRoutes.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

const REGISTRY_PATH = path.join(process.cwd(), 'docs/STANDARDS-REGISTRY.md');
const SPECS_DIR = path.join(process.cwd(), 'docs/specs');

let tempDir: string;
function app(opts: { intelligence?: IntelligenceProvider | null; enabled?: boolean } = {}) {
  const a = express();
  a.use(express.json({ limit: '2mb' }));
  a.use(createSpecReviewRoutes({
    intelligence: opts.intelligence ?? null,
    registryPath: REGISTRY_PATH,
    specsDir: SPECS_DIR,
    stateDir: tempDir,
    enabled: opts.enabled,
  }));
  return a;
}

beforeEach(() => { tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scg-int-')); });
afterEach(() => { try { SafeFsExecutor.safeRmSync(tempDir, { recursive: true, force: true, operation: 'tests/integration/standards-conformance-gate.test.ts' }); } catch { /* best */ } });

const flagNoManualWork: IntelligenceProvider = {
  async evaluate() {
    return '[{"standard":"No Manual Work (user *or* agent)","reason":"the design requires the user to remember to run a manual sync step"}]';
  },
};

describe('POST /spec/conformance-check', () => {
  it('returns a report flagging a possible violation + a passing registry canary', async () => {
    const res = await request(app({ intelligence: flagNoManualWork }))
      .post('/spec/conformance-check')
      .send({ markdown: '# Spec\nThe user must remember to run `sync` after each edit.' });
    expect(res.status).toBe(200);
    expect(res.body.registryCanary.ok).toBe(true);
    expect(res.body.report.degraded).toBe(false);
    expect(res.body.report.findings.length).toBeGreaterThanOrEqual(1);
    expect(res.body.report.findings[0].standard).toMatch(/No Manual Work/);
  });

  it('degrades safe (empty report) with no intelligence provider', async () => {
    const res = await request(app({ intelligence: null }))
      .post('/spec/conformance-check')
      .send({ markdown: '# Spec\nsomething' });
    expect(res.status).toBe(200);
    expect(res.body.report.degraded).toBe(true);
    expect(res.body.report.findings).toEqual([]);
  });

  it('400 when neither markdown nor specPath is given', async () => {
    const res = await request(app()).post('/spec/conformance-check').send({});
    expect(res.status).toBe(400);
  });

  it('400 when specPath escapes specsDir (traversal guard)', async () => {
    const res = await request(app({ intelligence: flagNoManualWork }))
      .post('/spec/conformance-check')
      .send({ specPath: '../../etc/passwd' });
    expect(res.status).toBe(400);
  });
});

describe('GET /spec/conformance-metrics', () => {
  it('reflects runs + per-standard counts after a check', async () => {
    const a = app({ intelligence: flagNoManualWork });
    await request(a).post('/spec/conformance-check').send({ markdown: '# Spec\nthe user must remember to do X' });
    const m = await request(a).get('/spec/conformance-metrics');
    expect(m.status).toBe(200);
    expect(m.body.metrics.runs).toBe(1);
    expect(m.body.metrics.findings_total).toBeGreaterThanOrEqual(1);
    expect(Object.keys(m.body.metrics.by_standard).join(' ')).toMatch(/No Manual Work/);
  });
});

describe('disabled', () => {
  it('503-stubs every /spec route when disabled', async () => {
    const res = await request(app({ enabled: false })).post('/spec/conformance-check').send({ markdown: 'x' });
    expect(res.status).toBe(503);
  });
});

describe('POST /spec/conformance-check — Constitutional Traceability fit verdict', () => {
  // The route calls reviewer.review() (expects a findings array) AND, when a
  // parent-principle is present, reviewer.judgeFit() (expects a {verdict} object) —
  // both via the same IntelligenceProvider. Key the stub on the fit prompt's marker.
  const fitStub: IntelligenceProvider = {
    async evaluate(prompt: string) {
      if (prompt.includes('Constitutional Traceability reviewer')) {
        return '{"verdict":"fit","reason":"plainly an instance of the named standard"}';
      }
      return '[]';
    },
  };

  it('attaches report.fit when the spec frontmatter names a resolvable parent-principle', async () => {
    const md = '---\nparent-principle: "No Manual Work"\n---\n# Spec\nA design.';
    const res = await request(app({ intelligence: fitStub })).post('/spec/conformance-check').send({ markdown: md });
    expect(res.status).toBe(200);
    expect(res.body.report.fit).toBeTruthy();
    expect(res.body.report.fit.verdict).toBe('fit');
    expect(res.body.report.fit.parentResolved).toBe(true);
  });

  it('accepts parentPrinciple from the request body', async () => {
    const res = await request(app({ intelligence: fitStub }))
      .post('/spec/conformance-check')
      .send({ markdown: '# Spec\nno frontmatter here', parentPrinciple: 'Signal vs. Authority' });
    expect(res.status).toBe(200);
    expect(res.body.report.fit.parentResolved).toBe(true);
    expect(res.body.report.fit.verdict).toBe('fit');
  });

  it('omits report.fit when no parent-principle is determinable', async () => {
    const res = await request(app({ intelligence: fitStub }))
      .post('/spec/conformance-check')
      .send({ markdown: '# Spec\nno frontmatter, no parent.' });
    expect(res.status).toBe(200);
    expect(res.body.report.fit).toBeUndefined();
  });

  it('verdict "none" when the named parent does not resolve to a real standard', async () => {
    const md = '---\nparent-principle: "Totally Made Up Standard"\n---\n# Spec\nx';
    const res = await request(app({ intelligence: fitStub })).post('/spec/conformance-check').send({ markdown: md });
    expect(res.status).toBe(200);
    expect(res.body.report.fit.verdict).toBe('none');
    expect(res.body.report.fit.parentResolved).toBe(false);
  });
});

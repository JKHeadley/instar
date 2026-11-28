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
import { resolveStandardsRegistryFromPath } from '../../src/core/standardsRegistryPath.js';
import express from 'express';
import request from 'supertest';
import { createSpecReviewRoutes, CONFORMANCE_ROUTE_BUDGET_MS, fitTimeLeft } from '../../src/server/specReviewRoutes.js';
import { SPEC_REVIEW_TIMEOUT_MS } from '../../src/server/middleware.js';
import { AutonomousRunStore } from '../../src/core/AutonomousRunStore.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

const REGISTRY_PATH = path.join(process.cwd(), 'docs/STANDARDS-REGISTRY.md');
const SPECS_DIR = path.join(process.cwd(), 'docs/specs');

let tempDir: string;
function app(opts: { intelligence?: IntelligenceProvider | null; enabled?: boolean } = {}) {
  const a = express();
  a.use(express.json({ limit: '2mb' }));
  a.use(createSpecReviewRoutes({
    intelligence: opts.intelligence ?? null,
    // Explicit test injection against a CONTROLLED constitution fixture.
    registryResolution: resolveStandardsRegistryFromPath(REGISTRY_PATH),
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

  it('records the result in the constitution-check ledger read by B24 (Echo Bugs topic 10000002750)', async () => {
    const res = await request(app({ intelligence: flagNoManualWork }))
      .post('/spec/conformance-check')
      .send({ markdown: '---\nslug: sync-design\n---\n# Sync design\nThe user must remember to run `sync`.' });
    expect(res.status).toBe(200);
    const ledger = JSON.parse(fs.readFileSync(path.join(tempDir, 'spec-constitution-checks.json'), 'utf-8'));
    expect(ledger[0].slug).toBe('sync-design');
    expect(ledger[0].title).toBe('Sync design');
    expect(ledger[0].findingsCount).toBeGreaterThanOrEqual(1);
    expect(ledger[0].atRisk[0]).toMatch(/No Manual Work/);
  });

  it('degrades safe (empty report) with no intelligence provider', async () => {
    const res = await request(app({ intelligence: null }))
      .post('/spec/conformance-check')
      .send({ markdown: '# Spec\nsomething' });
    expect(res.status).toBe(200);
    expect(res.body.report.degraded).toBe(true);
    expect(res.body.report.findings).toEqual([]);
    // Loud at the top level: an unchecked spec is never readable as a clean one.
    expect(res.body.checked).toBe(false);
    expect(res.body.notChecked).toMatch(/^not checked: /);
  });

  it('a check that could not run is recorded as not checked and is not ceremony evidence', async () => {
    const tooLong: IntelligenceProvider = { async evaluate() { throw new Error('Prompt is too long'); } };
    const res = await request(app({ intelligence: tooLong }))
      .post('/spec/conformance-check')
      .send({ markdown: '---\nslug: big-spec\n---\n# Big spec\nbody' });
    expect(res.status).toBe(200);
    expect(res.body.checked).toBe(false);
    expect(res.body.report.degradeReason).toBe('too-long');
    expect(res.body.notChecked).toMatch(/too long for the model to judge whole/);
    const ledger = JSON.parse(fs.readFileSync(path.join(tempDir, 'spec-constitution-checks.json'), 'utf-8'));
    expect(ledger[0].slug).toBe('big-spec');
    expect(ledger[0].degraded).toBe(true);
    expect(ledger[0].degradeReason).toBe('too-long');
    expect(new AutonomousRunStore(tempDir).conformanceInvocationsInWindow('big-spec', '1970-01-01T00:00:00Z', '2999-01-01T00:00:00Z')).toBe(0);
  });

  it('a real check is recorded as ceremony evidence and marked checked', async () => {
    const res = await request(app({ intelligence: flagNoManualWork }))
      .post('/spec/conformance-check')
      .send({ markdown: '---\nslug: small-spec\n---\n# Small\nThe user must remember to sync.' });
    expect(res.status).toBe(200);
    expect(res.body.checked).toBe(true);
    expect(res.body.notChecked).toBeUndefined();
    expect(new AutonomousRunStore(tempDir).conformanceInvocationsInWindow('small-spec', '1970-01-01T00:00:00Z', '2999-01-01T00:00:00Z')).toBe(1);
  });

  it('400 when neither markdown nor specPath is given', async () => {
    const res = await request(app()).post('/spec/conformance-check').send({});
    expect(res.status).toBe(400);
  });

  it('the fit judgment gets only the time left in the route budget, and still runs after a too-long review', async () => {
    expect(CONFORMANCE_ROUTE_BUDGET_MS).toBe(SPEC_REVIEW_TIMEOUT_MS);
    // A request that spent 5 s reading and 140 s in review leaves 25 s for fit; 160 s in, under 20 s, so fit is not started.
    expect(fitTimeLeft(0, 145_000)).toBe(25_000);
    expect(fitTimeLeft(0, 160_000)).toBeLessThan(20_000);
    const seen: Array<number | undefined> = [];
    const timed: IntelligenceProvider = { async evaluate(_p, o) { seen.push(o?.timeoutMs); return seen.length === 1 ? '[]' : '{"verdict":"fit","reason":"ok"}'; } };
    const res = await request(app({ intelligence: timed })).post('/spec/conformance-check')
      .send({ markdown: '---\nparent-principle: "No Manual Work"\n---\n# Spec\nok' });
    expect(res.status).toBe(200);
    expect(seen.length).toBe(2);
    expect(seen[1]!).toBeLessThanOrEqual(150_000);
    let calls = 0;
    const tooLong: IntelligenceProvider = { async evaluate() { calls++; if (calls === 1) throw new Error('Prompt is too long'); return '{"verdict":"fit","reason":"ok"}'; } };
    const r2 = await request(app({ intelligence: tooLong })).post('/spec/conformance-check')
      .send({ markdown: '---\nparent-principle: "No Manual Work"\n---\n# Spec\nok' });
    expect(calls).toBe(2);
    expect(r2.body.checked).toBe(false);
    expect(r2.body.fitChecked).toBe(true);
    const rec = JSON.parse(fs.readFileSync(path.join(tempDir, 'spec-constitution-checks.json'), 'utf-8'))[0];
    expect(rec.fitVerdict).toBe('fit');
    expect(rec.degraded).toBe(true);
  });

  it('413, not checked, when a specPath file is over the body ceiling (never read in part)', async () => {
    const big = path.join(tempDir, 'huge-spec.md');
    fs.writeFileSync(big, '# Spec\n');
    fs.truncateSync(big, 12 * 1024 * 1024 + 1); // sparse: cheap on disk
    let called = 0;
    const counting: IntelligenceProvider = { async evaluate() { called++; return '[]'; } };
    const a = express();
    a.use(express.json({ limit: '2mb' }));
    a.use(createSpecReviewRoutes({
      intelligence: counting,
      registryResolution: resolveStandardsRegistryFromPath(REGISTRY_PATH),
      specsDir: tempDir,
      stateDir: tempDir,
    }));
    const res = await request(a).post('/spec/conformance-check').send({ specPath: 'huge-spec.md' });
    expect(res.status).toBe(413);
    expect(res.body.checked).toBe(false);
    expect(res.body.error).toMatch(/too large to judge/);
    expect(res.body.notChecked).toMatch(/not checked/);
    expect(called).toBe(0);
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

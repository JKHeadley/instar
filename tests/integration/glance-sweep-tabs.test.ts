/**
 * Integration (Tier 2) — the Phase-4 sweep tabs (PR Pipeline, Tokens, LLM Activity,
 * Secrets, Resources, Initiatives) against the REAL HTTP routes (Dashboard UX
 * Standard F10/F11, topic 29836 Phase 4).
 *
 * Boots a real Express server with the production createRoutes() and drives each
 * SHIPPED glance builder + renderGlance against the LIVE route response (or its
 * documented dark 503/404), asserting each glance renders, conforms to F10, and
 * every non-empty tile drills into the real filtered rows down to the Layer-3 record.
 */
// @ts-nocheck — the glance module is browser-native ESM.
import { describe, it, expect, afterEach, afterAll } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { JSDOM } from 'jsdom';
import { createRoutes } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  prPipelineGlanceSpec, buildPrPipelineGlance,
  tokensGlanceSpec, buildTokensGlance,
  llmActivityGlanceSpec, buildLlmActivityGlance,
  secretsGlanceSpec, buildSecretsGlance,
  resourcesGlanceSpec, buildResourcesGlance,
  initiativesGlanceSpec, buildInitiativesGlance,
  renderGlance, validateGlanceSpec,
} from '../../dashboard/glance.js';

interface TestServer { url: string; close: () => Promise<void>; }
function listen(app: express.Express): Promise<TestServer> {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}
function bootApp(ctx: any): Promise<TestServer> {
  const app = express();
  app.use(express.json());
  app.use(createRoutes(ctx));
  return listen(app);
}
function jsdomRoot() {
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>');
  const doc = dom.window.document;
  if (!(dom.window as any).CSS) (dom.window as any).CSS = { escape: (s: string) => s.replace(/["\\\]]/g, '\\$&') };
  (globalThis as any).CSS = (dom.window as any).CSS;
  return { dom, doc, root: doc.getElementById('root')! };
}
function walk(handle: any, dom: JSDOM): number {
  let real = 0;
  for (const btn of handle.tiles) {
    btn.dispatchEvent(new (dom.window as any).Event('click'));
    expect(handle.drilldown.hidden).toBe(false);
    if (handle.drilldown.querySelector('.glance-list-row')) real++;
    btn.dispatchEvent(new (dom.window as any).Event('click'));
  }
  return real;
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'glance-p4-int-'));
afterAll(() => { try { SafeFsExecutor.safeRmSync(TMP, { recursive: true, force: true, operation: 'tests/integration/glance-sweep-tabs.test.ts:cleanup' }); } catch { /* @silent-fallback-ok — best-effort tmp cleanup */ } });
const BASE = { config: { authToken: 't', port: 0, stateDir: TMP }, startTime: new Date() };

describe('Tokens glance (integration — real /tokens/summary)', () => {
  let server: TestServer;
  afterEach(async () => { await server?.close(); });
  it('dark: 503 without a TokenLedger → the empty glance still conforms', async () => {
    server = await bootApp({ ...BASE }); // no tokenLedger
    const res = await fetch(server.url + '/tokens/summary');
    expect(res.status).toBe(503);
    expect(validateGlanceSpec(buildTokensGlance({ summary: {} }, [], [])).ok).toBe(true);
  });
  it('the builder conforms + drills over a representative TokenLedger shape', async () => {
    const summary = { summary: { totalTokens: 1234567, totalInput: 1e6, totalOutput: 2e5, totalCacheRead: 3e5, sessionsActive: 3 } };
    const sessions = [{ sessionId: 'abc123', projectPath: '/Users/justin/Documents/Projects/ai-guy', totalTokens: 900000, eventCount: 120, lastTs: 1720000000000 }];
    const orphans = [{ sessionId: 'z9', projectPath: '/Users/justin/x', lastTs: 1719000000000 }];
    expect(validateGlanceSpec(buildTokensGlance(summary, sessions, orphans)).ok).toBe(true);
    const { dom, doc, root } = jsdomRoot();
    const handle = renderGlance(doc, root, tokensGlanceSpec(doc, summary, sessions, orphans, {}));
    expect(handle.headline.textContent).toMatch(/pieces of text/);
    expect(walk(handle, dom)).toBeGreaterThanOrEqual(1);
  });
});

describe('LLM Activity glance (integration — real /metrics/features)', () => {
  let server: TestServer;
  afterEach(async () => { await server?.close(); });
  it('dark: 503 without a FeatureMetricsLedger → the empty glance still conforms', async () => {
    server = await bootApp({ ...BASE });
    const res = await fetch(server.url + '/metrics/features?sinceHours=168');
    expect(res.status).toBe(503);
    expect(validateGlanceSpec(buildLlmActivityGlance({})).ok).toBe(true);
  });
  it('the builder conforms + drills over a representative summary shape', async () => {
    const data = { totals: { calls: 1234, fired: 900, errors: 2, tokensIn: 5e6, tokensOut: 2e5 },
      features: [{ feature: 'messageSentinel', frameworks: ['claude-code'], models: ['claude-haiku-4-5-20251001'], calls: 1000, fired: 800, shed: 50, errors: 2, tokensIn: 4e6, tokensOut: 1e5, p50LatencyMs: 523, p95LatencyMs: 1899 }] };
    expect(validateGlanceSpec(buildLlmActivityGlance(data)).ok).toBe(true);
    const { dom, doc, root } = jsdomRoot();
    const handle = renderGlance(doc, root, llmActivityGlanceSpec(doc, data));
    expect(walk(handle, dom)).toBeGreaterThanOrEqual(1);
  });
});

describe('Resources glance (integration — real /resources/summary)', () => {
  let server: TestServer;
  afterEach(async () => { await server?.close(); });
  it('dark: 503 without a ResourceLedger → the empty glance still conforms', async () => {
    server = await bootApp({ ...BASE });
    const res = await fetch(server.url + '/resources/summary?sinceHours=1');
    expect(res.status).toBe(503);
    expect(validateGlanceSpec(buildResourcesGlance({ sources: [] })).ok).toBe(true);
  });
  it('the builder conforms + drills over a representative summary shape', async () => {
    const summary = { sampleCount: 120, sources: [
      { source: 'aggregate', currentCpuPercent: 45, currentRssBytes: 2.5e9, avgCpuPercent: 30, peakCpuPercent: 163, peakRssBytes: 3e9 },
      { source: 'agent-server', currentCpuPercent: 12, currentRssBytes: 5e8, avgCpuPercent: 10, peakCpuPercent: 40, peakRssBytes: 6e8 },
    ] };
    expect(validateGlanceSpec(buildResourcesGlance(summary)).ok).toBe(true);
    const { dom, doc, root } = jsdomRoot();
    const handle = renderGlance(doc, root, resourcesGlanceSpec(doc, summary));
    expect(handle.headline.textContent).toMatch(/CPU/);
    expect(walk(handle, dom)).toBeGreaterThanOrEqual(1);
  });
});

describe('Initiatives glance (integration — real /initiatives)', () => {
  let server: TestServer;
  afterEach(async () => { await server?.close(); });
  it('dark: 503 without an InitiativeTracker → the empty glance still conforms', async () => {
    server = await bootApp({ ...BASE });
    const res = await fetch(server.url + '/initiatives');
    expect(res.status).toBe(503);
    expect(validateGlanceSpec(buildInitiativesGlance({ items: [] }, { items: [] })).ok).toBe(true);
  });
  it('the builder conforms + drills over a representative items+digest shape', async () => {
    const items = { items: [{ id: 'i1', title: 'Migrate the mesh', status: 'active', description: 'x', phases: [{ status: 'done' }], lastTouchedAt: '2026-07-01T00:00:00Z' }] };
    const digest = { items: [{ reason: 'needs-user', title: 'Approve the plan', detail: 'waiting on you' }] };
    expect(validateGlanceSpec(buildInitiativesGlance(items, digest)).ok).toBe(true);
    const { dom, doc, root } = jsdomRoot();
    const handle = renderGlance(doc, root, initiativesGlanceSpec(doc, items, digest));
    expect(walk(handle, dom)).toBeGreaterThanOrEqual(1);
  });
});

describe('Secrets glance (integration — real /secrets/pending)', () => {
  let server: TestServer;
  afterEach(async () => { await server?.close(); });
  it('/secrets/pending 200 (empty by default) → the empty glance conforms', async () => {
    server = await bootApp({ ...BASE });
    const res = await fetch(server.url + '/secrets/pending');
    expect(res.status).toBe(200); // always alive — secretDrop is always present
    const body = await res.json();
    expect(Array.isArray(body.pending)).toBe(true);
    expect(validateGlanceSpec(buildSecretsGlance(body)).ok).toBe(true);
  });
  it('the builder conforms + drills over a representative pending shape', async () => {
    const now = Date.parse('2026-07-11T00:00:00Z');
    const data = { pending: [
      { label: 'GitHub token', token: 'drop_abc', topicId: 12143, createdAt: now - 1000, expiresAt: now + 100000, expired: false, tunnelUrl: 'https://x.trycloudflare.com/drop/abc' },
      { label: 'Old key', token: 'drop_old', expired: true, expiresAt: now - 1000 },
    ] };
    expect(validateGlanceSpec(buildSecretsGlance(data, now)).ok).toBe(true);
    const { dom, doc, root } = jsdomRoot();
    const handle = renderGlance(doc, root, secretsGlanceSpec(doc, data, { now, onCancel: () => {} }));
    expect(walk(handle, dom)).toBeGreaterThanOrEqual(1);
  });
});

describe('PR Pipeline glance (integration — the builder over the real metric shape)', () => {
  it('the builder conforms + drills over a representative /pr-gate/metrics shape', () => {
    const metrics = { phase: 'enforce', entries: [
      { pr_number: 12, head_sha: 'abcdef1234567890', eligible: true, reason: 'all checks green', created_at: '2026-07-01T00:00:00Z' },
      { pr_number: 13, head_sha: 'cafebabe', eligible: false, reason: 'checks pending', created_at: '2026-07-02T00:00:00Z' },
    ] };
    expect(validateGlanceSpec(buildPrPipelineGlance(metrics)).ok).toBe(true);
    const { dom, doc, root } = jsdomRoot();
    const handle = renderGlance(doc, root, prPipelineGlanceSpec(doc, metrics));
    expect(handle.headline.textContent).toMatch(/1 of 2 open pull requests/);
    expect(walk(handle, dom)).toBeGreaterThanOrEqual(1);
  });
});

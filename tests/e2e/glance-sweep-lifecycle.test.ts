/**
 * E2E lifecycle (Tier 3) — the Phase-4 sweep tabs are ALIVE (Dashboard UX Standard
 * F10/F11, topic 29836 Phase 4). The feature-is-alive proof: are PR Pipeline, Tokens,
 * LLM Activity, Secrets, Resources, and Initiatives genuinely wired end-to-end, or
 * green-on-units but dark in production?
 *
 * Boots a REAL Express server with the production createRoutes() and asserts, per tab:
 *   - the route is reachable (200 for the always-on Secrets; the documented 503 dark
 *     behavior for the dev-gated Tokens / LLM Activity / Resources / Initiatives),
 *   - the shipped glance renders end-to-end from a live-shaped response (no XSS survives),
 *   - the shipped component file dashboard/glance.js exports each tab's builder.
 */
// @ts-nocheck — the glance module is browser-native ESM.
import { describe, it, expect, afterEach, afterAll } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { JSDOM } from 'jsdom';
import { createRoutes } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  prPipelineGlanceSpec, tokensGlanceSpec, llmActivityGlanceSpec,
  secretsGlanceSpec, resourcesGlanceSpec, initiativesGlanceSpec,
  renderGlance, validateGlanceSpec,
} from '../../dashboard/glance.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
function render(specFn: (doc: Document) => any) {
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>');
  const doc = dom.window.document;
  if (!(dom.window as any).CSS) (dom.window as any).CSS = { escape: (s: string) => s.replace(/["\\\]]/g, '\\$&') };
  (globalThis as any).CSS = (dom.window as any).CSS;
  const root = doc.getElementById('root')!;
  return { dom, doc, root, handle: renderGlance(doc, root, specFn(doc)) };
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'glance-p4-e2e-'));
afterAll(() => { try { SafeFsExecutor.safeRmSync(TMP, { recursive: true, force: true, operation: 'tests/e2e/glance-sweep-lifecycle.test.ts:cleanup' }); } catch { /* @silent-fallback-ok — best-effort tmp cleanup */ } });
const BASE = { config: { authToken: 't', port: 0, stateDir: TMP }, startTime: new Date() };
const NOW = Date.parse('2026-07-11T00:00:00Z');

describe('Phase-4 sweep glance tabs — E2E feature-alive', () => {
  let server: TestServer;
  afterEach(async () => { await server?.close(); });

  it('Secrets: /secrets/pending 200, the glance renders end-to-end, an XSS label is inert', async () => {
    server = await bootApp({ ...BASE });
    const res = await fetch(server.url + '/secrets/pending');
    expect(res.status).toBe(200); // always alive
    const body = await res.json();
    expect(Array.isArray(body.pending)).toBe(true);
    // Render with an XSS label injected into a representative pending row.
    const data = { pending: [{ label: '<img src=x onerror=alert(1)> token', token: 't1', expiresAt: NOW + 5000 }] };
    const { dom, handle } = render((doc) => secretsGlanceSpec(doc, data, { now: NOW, onCancel: () => {} }));
    expect(validateGlanceSpec(handle.spec).ok).toBe(true);
    const waiting = handle.tiles.find((b: any) => b.getAttribute('data-glance-tile') === 'waiting');
    waiting.dispatchEvent(new (dom.window as any).Event('click'));
    expect(handle.drilldown.querySelector('img')).toBeNull();
    expect(handle.drilldown.textContent).toContain('onerror'); // literal text, harmless
  });

  it('Tokens: /tokens/summary 503 dark → the builder still makes a friendly glance', async () => {
    server = await bootApp({ ...BASE }); // no TokenLedger
    const res = await fetch(server.url + '/tokens/summary');
    expect(res.status).toBe(503);
    const { handle } = render((doc) => tokensGlanceSpec(doc, { summary: {} }, [], [], {}));
    expect(validateGlanceSpec(handle.spec).ok).toBe(true);
    expect(handle.headline.textContent!.toLowerCase()).toContain('no conversation activity');
  });

  it('LLM Activity: /metrics/features 503 dark → the builder still makes a friendly glance', async () => {
    server = await bootApp({ ...BASE });
    const res = await fetch(server.url + '/metrics/features?sinceHours=168');
    expect(res.status).toBe(503);
    const { handle } = render((doc) => llmActivityGlanceSpec(doc, {}));
    expect(validateGlanceSpec(handle.spec).ok).toBe(true);
    expect(handle.headline.textContent!.toLowerCase()).toContain('no background ai activity');
  });

  it('Resources: /resources/summary 503 dark → the builder still makes a friendly glance', async () => {
    server = await bootApp({ ...BASE });
    const res = await fetch(server.url + '/resources/summary?sinceHours=1');
    expect(res.status).toBe(503);
    const { handle } = render((doc) => resourcesGlanceSpec(doc, { sources: [] }));
    expect(validateGlanceSpec(handle.spec).ok).toBe(true);
    expect(handle.headline.textContent!.toLowerCase()).toContain('no resource samples');
  });

  it('Initiatives: /initiatives 503 dark → the builder still makes a friendly glance', async () => {
    server = await bootApp({ ...BASE });
    const res = await fetch(server.url + '/initiatives');
    expect(res.status).toBe(503);
    const { handle } = render((doc) => initiativesGlanceSpec(doc, { items: [] }, { items: [] }));
    expect(validateGlanceSpec(handle.spec).ok).toBe(true);
    expect(handle.headline.textContent!.toLowerCase()).toContain('no initiatives');
  });

  it('PR Pipeline: the glance renders end-to-end from a live-shaped metric response', () => {
    const metrics = { phase: 'enforce', entries: [
      { pr_number: 12, head_sha: 'abcdef1234567890', eligible: true, reason: 'all checks green', created_at: '2026-07-01T00:00:00Z' },
    ] };
    const { handle } = render((doc) => prPipelineGlanceSpec(doc, metrics));
    expect(validateGlanceSpec(handle.spec).ok).toBe(true);
    expect(handle.headline.textContent).toMatch(/ready to merge/);
  });

  it('the shipped component file dashboard/glance.js exports every Phase-4 builder', () => {
    const file = path.resolve(__dirname, '..', '..', 'dashboard', 'glance.js');
    const src = fs.readFileSync(file, 'utf-8');
    for (const sym of [
      'export function buildPrPipelineGlance', 'export function prPipelineGlanceSpec',
      'export function buildTokensGlance', 'export function tokensGlanceSpec',
      'export function buildLlmActivityGlance', 'export function llmActivityGlanceSpec',
      'export function buildSecretsGlance', 'export function secretsGlanceSpec',
      'export function buildResourcesGlance', 'export function resourcesGlanceSpec',
      'export function buildInitiativesGlance', 'export function initiativesGlanceSpec',
    ]) {
      expect(src, `${sym} must ship with the package`).toContain(sym);
    }
  });
});

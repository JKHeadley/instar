/**
 * E2E lifecycle (Tier 3) — the Phase-3 jargon-belt tabs are ALIVE (Dashboard UX
 * Standard F10/F11, topic 29836 Phase 3). The feature-is-alive proof: are Machines,
 * Health, Spend, and Routing Map genuinely wired end-to-end, or green-on-units but
 * dark in production?
 *
 * Boots a REAL Express server with the production createRoutes() and asserts, per tab:
 *   - the route is reachable (200 for the always-on Machines/Health; the documented
 *     503 dark behavior for the dev-/provider-gated Routing/Spend),
 *   - the shipped glance renders end-to-end from the live response (no XSS survives),
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
  machinesGlanceSpec, healthGlanceSpec, spendGlanceSpec, routingMapGlanceSpec,
  buildSpendGlance, renderGlance, validateGlanceSpec,
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'glance-p3-e2e-'));
afterAll(() => { try { SafeFsExecutor.safeRmSync(TMP, { recursive: true, force: true, operation: 'tests/e2e/glance-jargon-belt-lifecycle.test.ts:cleanup' }); } catch { /* @silent-fallback-ok — best-effort tmp cleanup */ } });
const BASE = { config: { authToken: 't', port: 0, stateDir: TMP }, startTime: new Date() };

describe('Jargon-belt glance tabs — E2E feature-alive', () => {
  let server: TestServer;
  afterEach(async () => { await server?.close(); });

  it('Machines: /pool 200, the glance renders end-to-end, an XSS nickname is inert', async () => {
    const machines = [
      { machineId: 'm_1', nickname: 'Laptop', online: true, clockSkewStatus: 'ok', activeSessionCount: 1, maxSessions: 6,
        hardware: { cpuModel: 'Apple M2', cpuCores: 8, totalMemBytes: 17179869184 }, guardPosture: { onConfirmed: 16 } },
      { machineId: 'm_2', nickname: '<img src=x onerror=alert(1)> Mini', online: true, clockSkewStatus: 'ok' },
    ];
    server = await bootApp({ ...BASE, machinePoolRegistry: { getCapacities: () => machines } });
    const res = await fetch(server.url + '/pool');
    expect(res.status).toBe(200); // alive, not 503
    const pool = await res.json();

    const { dom, handle } = render((doc) => machinesGlanceSpec(doc, pool, null, {}));
    expect(validateGlanceSpec(handle.spec).ok).toBe(true);
    expect(handle.headline.textContent).toMatch(/machines online|online and healthy/);
    // Drill "online" and confirm the XSS payload rendered inert.
    const onlineBtn = handle.tiles.find((b: any) => b.getAttribute('data-glance-tile') === 'online');
    onlineBtn.dispatchEvent(new (dom.window as any).Event('click'));
    expect(handle.drilldown.querySelector('img')).toBeNull();
    expect(handle.drilldown.querySelector('script')).toBeNull();
    expect(handle.drilldown.textContent).toContain('onerror'); // literal text, harmless
  });

  it('Health: /systems/status 200, the full glance renders end-to-end from live subsystems', async () => {
    server = await bootApp({ ...BASE, watchdog: {}, triageNurse: {}, scheduler: {}, commitmentTracker: { getActive: () => [] } });
    const res = await fetch(server.url + '/systems/status');
    expect(res.status).toBe(200); // always alive
    const systems = await res.json();

    const { handle } = render((doc) => healthGlanceSpec(doc, systems));
    expect(validateGlanceSpec(handle.spec).ok).toBe(true);
    expect(handle.tiles.map((t: any) => t.getAttribute('data-glance-tile'))).toEqual(['subsystems', 'attention', 'events']);
  });

  it('Routing Map: /intelligence/routing/chains 503 dark → the builder still makes a friendly glance', async () => {
    server = await bootApp({ ...BASE }); // no LLM provider → dark
    const res = await fetch(server.url + '/intelligence/routing/chains');
    expect(res.status).toBe(503); // documented dark behavior — the route is gated
    // The empty-map glance the component builds is honest and conforms.
    const { handle } = render((doc) => routingMapGlanceSpec(doc, { chains: [], components: [] }));
    expect(validateGlanceSpec(handle.spec).ok).toBe(true);
    expect(handle.headline.textContent!.toLowerCase()).toContain('no background ai routing');
  });

  it('Spend: /routing-spend/summary 503 dark → the builder still makes a friendly glance', async () => {
    server = await bootApp({ ...BASE }); // dev-gated dark on the fleet
    const res = await fetch(server.url + '/routing-spend/summary?grain=day');
    expect(res.status).toBe(503);
    const glance = buildSpendGlance({ totals: {}, rows: [] }, { keys: [] });
    expect(validateGlanceSpec(glance).ok).toBe(true);
    const { handle } = render((doc) => spendGlanceSpec(doc, { totals: {}, rows: [] }, { keys: [] }));
    expect(handle.headline.textContent!.toLowerCase()).toContain('nothing is being billed');
  });

  it('the shipped component file dashboard/glance.js exports every jargon-belt builder', () => {
    const file = path.resolve(__dirname, '..', '..', 'dashboard', 'glance.js');
    const src = fs.readFileSync(file, 'utf-8');
    for (const sym of [
      'export function buildMachinesGlance', 'export function machinesGlanceSpec',
      'export function buildHealthGlance', 'export function healthGlanceSpec',
      'export function buildSpendGlance', 'export function spendGlanceSpec',
      'export function buildRoutingMapGlance', 'export function routingMapGlanceSpec',
    ]) {
      expect(src, `${sym} must ship with the package`).toContain(sym);
    }
  });
});

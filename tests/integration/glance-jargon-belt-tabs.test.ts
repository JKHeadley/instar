/**
 * Integration (Tier 2) — the Phase-3 jargon-belt tabs (Machines, Health, Spend,
 * Routing Map) against the REAL HTTP routes (Dashboard UX Standard F10/F11, topic
 * 29836 Phase 3).
 *
 * Boots a real Express server with the production createRoutes() and drives each
 * SHIPPED glance builder + renderGlance against the LIVE route response:
 *   - Machines: GET /pool (feature ON via a seeded pool registry, and dark → enabled:false)
 *   - Health:   GET /systems/status (always 200; live subsystems)
 *   - Routing:  GET /intelligence/routing/chains (dark → 503) + the builder over the
 *               REAL buildNatureRoutingMap() shape the route emits
 *   - Spend:    GET /routing-spend/summary (dark → 503) + the builder over a
 *               representative SpendSummary shape
 * asserting each glance renders, conforms to F10, and every non-empty tile drills
 * into the real filtered rows down to the Layer-3 record.
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
import { buildNatureRoutingMap } from '../../src/core/natureRoutingMap.js';
import {
  machinesGlanceSpec, buildMachinesGlance,
  healthGlanceSpec, buildHealthGlance, healthPopulation,
  spendGlanceSpec, buildSpendGlance,
  routingMapGlanceSpec, buildRoutingMapGlance,
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'glance-p3-int-'));
afterAll(() => { try { SafeFsExecutor.safeRmSync(TMP, { recursive: true, force: true, operation: 'tests/integration/glance-jargon-belt-tabs.test.ts:cleanup' }); } catch { /* @silent-fallback-ok — best-effort tmp cleanup */ } });
const BASE = { config: { authToken: 't', port: 0, stateDir: TMP }, startTime: new Date() };

describe('Machines glance (integration — real /pool)', () => {
  let server: TestServer;
  afterEach(async () => { await server?.close(); });

  it('feature ON: /pool 200, glance renders from live machines + drills to a record', async () => {
    const machines = [
      { machineId: 'm_1', nickname: 'Laptop', online: true, clockSkewStatus: 'ok', activeSessionCount: 2, maxSessions: 6,
        hardware: { cpuModel: 'Apple M2', cpuCores: 8, totalMemBytes: 17179869184 }, guardPosture: { onConfirmed: 16, offDeviant: 6 } },
      { machineId: 'm_2', nickname: 'Mini', online: false, clockSkewStatus: 'ok' },
    ];
    server = await bootApp({
      ...BASE,
      machinePoolRegistry: { getCapacities: () => machines },
      coordinator: { getSyncStatus: () => ({ leaseHolder: 'm_1', leaseEpoch: 1, holdsLease: true, awakeMachineCount: 1, awakeMachineCountSource: 'lease-live', splitBrainState: 'clear' }) },
    });

    const res = await fetch(server.url + '/pool');
    expect(res.status).toBe(200); // alive, not 503
    const pool = await res.json();
    expect(pool.enabled).toBe(true);
    expect(pool.machines.length).toBe(2);

    const base = buildMachinesGlance(pool, null);
    expect(validateGlanceSpec(base).ok).toBe(true);
    expect(Number(base.tiles.find((t: any) => t.key === 'online').value)).toBe(1); // 1 of 2 online

    const { dom, doc, root } = jsdomRoot();
    const handle = renderGlance(doc, root, machinesGlanceSpec(doc, pool, null, {}));
    expect(handle.headline.textContent).toMatch(/1 of 2 machines online/);
    expect(walk(handle, dom)).toBeGreaterThanOrEqual(1);

    const onlineBtn = handle.tiles.find((b: any) => b.getAttribute('data-glance-tile') === 'online');
    onlineBtn.dispatchEvent(new (dom.window as any).Event('click'));
    const row = handle.drilldown.querySelector('.glance-list-row');
    row.dispatchEvent(new (dom.window as any).Event('click'));
    expect(handle.drilldown.querySelector('[data-glance-record]')!.textContent).toMatch(/Specs|Status/);
  });

  it('dark: /pool enabled:false → the tab builds a friendly single-machine glance', async () => {
    server = await bootApp({ ...BASE }); // no machinePoolRegistry
    const res = await fetch(server.url + '/pool');
    expect(res.status).toBe(200);
    const pool = await res.json();
    expect(pool.enabled).toBe(false);
    // The empty-population glance the component builds still conforms.
    expect(validateGlanceSpec(buildMachinesGlance(pool, null)).ok).toBe(true);
  });
});

describe('Health glance (integration — real /systems/status)', () => {
  let server: TestServer;
  afterEach(async () => { await server?.close(); });

  it('/systems/status 200 with live subsystems → conforming glance that drills to a record', async () => {
    server = await bootApp({
      ...BASE,
      watchdog: {}, triageNurse: {}, spawnManager: {},
      scheduler: {}, commitmentTracker: { getActive: () => [] },
    });
    const res = await fetch(server.url + '/systems/status');
    expect(res.status).toBe(200); // always alive
    const systems = await res.json();
    expect(Array.isArray(systems.activeCapabilities)).toBe(true);
    expect(systems.activeCapabilities.length).toBeGreaterThanOrEqual(1); // wired subsystems appear

    const base = buildHealthGlance(systems);
    expect(validateGlanceSpec(base).ok).toBe(true);
    expect(Number(base.tiles.find((t: any) => t.key === 'subsystems').value)).toBe(healthPopulation(systems).length);

    const { dom, doc, root } = jsdomRoot();
    const handle = renderGlance(doc, root, healthGlanceSpec(doc, systems));
    expect(walk(handle, dom)).toBeGreaterThanOrEqual(1);

    const subsBtn = handle.tiles.find((b: any) => b.getAttribute('data-glance-tile') === 'subsystems');
    subsBtn.dispatchEvent(new (dom.window as any).Event('click'));
    handle.drilldown.querySelector('.glance-list-row').dispatchEvent(new (dom.window as any).Event('click'));
    expect(handle.drilldown.querySelector('[data-glance-record]')!.textContent).toMatch(/What it does/);
  });
});

describe('Routing Map glance (integration — real /intelligence/routing/chains)', () => {
  let server: TestServer;
  afterEach(async () => { await server?.close(); });

  it('dark: 503 without an IntelligenceRouter → the tab shows an honest note', async () => {
    server = await bootApp({ ...BASE }); // no intelligence router
    const res = await fetch(server.url + '/intelligence/routing/chains');
    expect(res.status).toBe(503); // documented dark behavior — the route is gated
  });

  it('the builder conforms + drills over the REAL buildNatureRoutingMap() shape', async () => {
    // The route returns { defaultFramework, ...buildNatureRoutingMap() }; drive the
    // builder against that exact shipped structure (no LLM provider needed).
    const map = { defaultFramework: 'claude-code', ...buildNatureRoutingMap({}) };
    const base = buildRoutingMapGlance(map);
    expect(validateGlanceSpec(base).ok).toBe(true);
    expect(base.headline).toMatch(/Background AI work runs on/);

    const { dom, doc, root } = jsdomRoot();
    const handle = renderGlance(doc, root, routingMapGlanceSpec(doc, map));
    expect(walk(handle, dom)).toBeGreaterThanOrEqual(1);
  });
});

describe('Spend glance (integration — real /routing-spend/summary)', () => {
  let server: TestServer;
  afterEach(async () => { await server?.close(); });

  it('dark: 503 when the dev-gated view is off (fleet default) → an honest note', async () => {
    server = await bootApp({ ...BASE }); // routingSpend not enabled
    const res = await fetch(server.url + '/routing-spend/summary?grain=day');
    expect(res.status).toBe(503); // dev-gated dark on the fleet
    // The empty glance the component builds still conforms.
    expect(validateGlanceSpec(buildSpendGlance({ totals: {}, rows: [] }, { keys: [] })).ok).toBe(true);
  });

  it('the builder conforms + drills over a representative SpendSummary shape', async () => {
    const summary = { totals: { netUsd: 0, tokensIn: 123456, tokensOut: 6543 }, meteredLiveYet: false,
      rows: [{ door: 'claude-cli', modelId: 'claude-haiku-4-5-20251001', doorClass: 'cli', tokensIn: 123456, tokensOut: 6543, grossUsd: 0, netUsd: 0, priceBasis: 'subscription-zero' }] };
    const caps = { keys: [{ keyRef: 'k1', provider: 'openai', door: 'openai-metered', dailyCapUsd: 5, lifetimeCapUsd: 50, committedDayUsd: 0, committedLifetimeUsd: 0, goLiveState: 'not-live', frozen: false }] };
    const base = buildSpendGlance(summary, caps);
    expect(validateGlanceSpec(base).ok).toBe(true);
    expect(base.headline.toLowerCase()).toContain('nothing is being billed');

    const { dom, doc, root } = jsdomRoot();
    const handle = renderGlance(doc, root, spendGlanceSpec(doc, summary, caps));
    expect(walk(handle, dom)).toBeGreaterThanOrEqual(1);
    const accessBtn = handle.tiles.find((b: any) => b.getAttribute('data-glance-tile') === 'access');
    accessBtn.dispatchEvent(new (dom.window as any).Event('click'));
    handle.drilldown.querySelector('.glance-list-row').dispatchEvent(new (dom.window as any).Event('click'));
    expect(handle.drilldown.querySelector('[data-glance-record]')!.textContent).toMatch(/Daily limit|Not switched on/);
  });
});

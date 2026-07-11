/**
 * E2E lifecycle (Tier 3) — Blockers glance is ALIVE (Dashboard UX Standard F10/F11,
 * topic 29836 Phase 2). The single most important test for the feature: is it
 * genuinely wired end-to-end, or green-on-units but dark in production?
 *
 * Boots a REAL Express server with the production createRoutes() and asserts:
 *   - feature ON (a real BlockerLedger seeded with entries): /blockers returns 200
 *     (never 503), the full glance renders end-to-end from live data, and no injected
 *     <script> survives the round-trip.
 *   - feature OFF (no ledger → 503, the documented dark behavior): the tab's glance
 *     builder still produces a friendly empty glance, never a crash.
 *   - the shipped component file dashboard/glance.js exports the Blockers builder
 *     (deployed via the package's static serving, not a stub).
 */
// @ts-nocheck — the glance module is browser-native ESM.
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { JSDOM } from 'jsdom';
import { createRoutes } from '../../src/server/routes.js';
import { BlockerLedger } from '../../src/monitoring/BlockerLedger.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { blockersGlanceSpec, renderGlance, validateGlanceSpec, buildBlockersGlance } from '../../dashboard/glance.js';

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

function seedLedger(stateDir: string, entries: any[]): void {
  const dir = path.join(stateDir, 'state');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'blocker-ledger.json'),
    JSON.stringify({ version: 1, lastModified: '2026-07-09T00:00:00.000Z', nextId: entries.length + 1, entries }, null, 2));
}

function render(entries: any[]) {
  const doc = new JSDOM('<!doctype html><body><div id="root"></div></body>').window.document;
  const root = doc.getElementById('root')!;
  const spec = blockersGlanceSpec(doc, entries);
  const handle = renderGlance(doc, root, spec);
  return { doc, root, handle };
}

describe('Blockers glance — E2E feature-alive', () => {
  let server: TestServer;
  let dir: string;

  afterEach(async () => {
    await server?.close();
    try { if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/glance-blockers-tab-lifecycle.test.ts:cleanup' }); } catch { /* @silent-fallback-ok — best-effort tmp cleanup */ }
  });

  it('feature ON: /blockers 200, the glance renders end-to-end, no XSS survives', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glance-blk-e2e-'));
    seedLedger(dir, [
      { id: 'BLK-001', version: 1, state: 'live-run', detectedText: 'the vendor <img src=x onerror=alert(1)> has not replied',
        origin: 'sess-1', createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-09T09:00:00Z', history: [] },
      { id: 'BLK-002', version: 5, state: 'true-blocker', detectedText: 'need the operator password for the bank portal',
        origin: 'sess-1', createdAt: '2026-07-04T00:00:00Z', updatedAt: '2026-07-09T06:00:00Z', history: [],
        terminal: { kind: 'true-blocker', reasonKind: 'operator-only-secret', rebuttal: 'vault miss',
          failedAttempt: { type: 'self-fetch', at: '2026-07-09T05:00:00Z', detail: 'miss', succeeded: false },
          accessRequestRef: 'relay-1', gateDecisionHash: 'deadbeef', at: '2026-07-09T06:00:00Z',
          recheckAfter: '2026-08-01T00:00:00Z', noEvidenceResettleCount: 0 } },
    ]);
    const ledger = new BlockerLedger({ stateDir: dir });

    server = await bootApp({ config: { authToken: 't', stateDir: dir, port: 0 }, startTime: new Date(), blockerLedger: ledger });

    const res = await fetch(server.url + '/blockers');
    expect(res.status).toBe(200); // alive, not 503
    const body = await res.json();
    expect(body.entries.length).toBe(2);

    const { handle } = render(body.entries);
    expect(validateGlanceSpec(handle.spec).ok).toBe(true);
    expect(handle.tiles.length).toBe(3); // Truly stuck · Being worked · Resolved
    expect(handle.headline.textContent).toMatch(/1 thing is truly stuck/i);

    // Drill "Being worked" and confirm the XSS payload rendered inert.
    const workingBtn = handle.tiles.find((b: any) => b.getAttribute('data-glance-tile') === 'working');
    workingBtn.dispatchEvent(new (handle.drilldown.ownerDocument.defaultView as any).Event('click'));
    expect(handle.drilldown.querySelector('img')).toBeNull();
    expect(handle.drilldown.querySelector('script')).toBeNull();
    expect(handle.drilldown.textContent).toContain('onerror'); // literal text, harmless
  });

  it('feature OFF: /blockers 503 (dark) → the tab still builds a friendly empty glance, not a crash', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glance-blk-e2e-off-'));
    server = await bootApp({ config: { authToken: 't', stateDir: dir, port: 0 }, startTime: new Date() }); // no blockerLedger
    const res = await fetch(server.url + '/blockers');
    expect(res.status).toBe(503); // documented dark behavior — the route is gated

    // The glance the component builds for the empty/dark case is honest and conforms.
    const glance = buildBlockersGlance([]);
    expect(validateGlanceSpec(glance).ok).toBe(true);
    expect(glance.headline.toLowerCase()).toContain('no blockers');
    const { handle } = render([]);
    expect(handle.headline.textContent!.toLowerCase()).toContain('no blockers');
  });

  it('the shipped component file dashboard/glance.js exports the Blockers builder (deployed)', () => {
    const file = path.resolve(__dirname, '..', '..', 'dashboard', 'glance.js');
    expect(fs.existsSync(file), 'dashboard/glance.js must ship with the package').toBe(true);
    const src = fs.readFileSync(file, 'utf-8');
    expect(src).toContain('export function buildBlockersGlance');
    expect(src).toContain('export function blockersGlanceSpec');
  });
});

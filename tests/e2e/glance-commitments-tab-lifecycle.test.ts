/**
 * E2E lifecycle (Tier 3) — Commitments glance is ALIVE (Dashboard UX Standard
 * F10/F11, topic 29836). The single most important test for the feature: is it
 * genuinely wired end-to-end, or green-on-units but dark in production?
 *
 * Boots a REAL Express server with the production createRoutes() and asserts:
 *   - feature ON (a real CommitmentTracker with open promises): /commitments returns
 *     200 (never 503), the full glance renders end-to-end from live data, and no
 *     injected <script> survives the round-trip.
 *   - feature OFF (no tracker → 200 { enabled:false }): the friendly empty glance,
 *     never a 503 / crash.
 *   - the shipped component file dashboard/glance.js exists and is real (deployed via
 *     the package's static serving, not a stub).
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
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { commitmentsGlanceSpec, renderGlance, validateGlanceSpec, buildCommitmentsGlance } from '../../dashboard/glance.js';

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

function render(commitments: any[]) {
  const doc = new JSDOM('<!doctype html><body><div id="root"></div></body>').window.document;
  const root = doc.getElementById('root')!;
  const spec = commitmentsGlanceSpec(doc, commitments, { now: Date.now() });
  const handle = renderGlance(doc, root, spec);
  return { doc, root, handle };
}

describe('Commitments glance — E2E feature-alive', () => {
  let server: TestServer;
  let dir: string;

  afterEach(async () => {
    await server?.close();
    try { if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/glance-commitments-tab-lifecycle.test.ts:cleanup' }); } catch { /* @silent-fallback-ok — best-effort tmp cleanup */ }
  });

  it('feature ON: /commitments 200, the glance renders end-to-end, no XSS survives', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glance-cmt-e2e-'));
    const tracker = new CommitmentTracker({ stateDir: dir, liveConfig: new LiveConfig(dir) });
    tracker.record({ type: 'one-time-action', topicId: 100, beaconEnabled: true,
      userRequest: 'send code', agentResponse: 'will send the code <img src=x onerror=alert(1)> once ready' });
    tracker.record({ type: 'one-time-action', topicId: 100, beaconEnabled: true, blockedOn: 'user-authorization', actionClass: 'deploy',
      userRequest: 'approve', agentResponse: 'awaiting your approval on the deploy' });

    server = await bootApp({ config: { authToken: 't', stateDir: dir, port: 0 }, startTime: new Date(), commitmentTracker: tracker });

    const res = await fetch(server.url + '/commitments?status=active');
    expect(res.status).toBe(200); // alive, not 503
    const body = await res.json();
    expect(body.enabled).toBe(true);

    const { handle } = render(body.commitments);
    expect(validateGlanceSpec(handle.spec).ok).toBe(true);
    expect(handle.tiles.length).toBe(5); // Open · Due soon · Overdue · Waiting · Quiet (#1435 Overdue tile)
    expect(handle.headline.textContent).toMatch(/carrying 2 open promises/i);

    // Drill "Open" and confirm the XSS payload rendered inert (textContent, no element).
    const openBtn = handle.tiles.find((b: any) => b.getAttribute('data-glance-tile') === 'open');
    openBtn.dispatchEvent(new (handle.drilldown.ownerDocument.defaultView as any).Event('click'));
    expect(handle.drilldown.querySelector('img')).toBeNull();
    expect(handle.drilldown.querySelector('script')).toBeNull();
    expect(handle.drilldown.textContent).toContain('onerror'); // literal text, harmless
  });

  it('feature OFF: /commitments 200 { enabled:false } → friendly empty glance, not a crash', async () => {
    server = await bootApp({ config: { authToken: 't', stateDir: '/tmp/.instar', port: 0 }, startTime: new Date() }); // no commitmentTracker
    const res = await fetch(server.url + '/commitments?status=active');
    expect(res.status).toBe(200); // NOT 503
    const body = await res.json();
    expect(body.enabled).toBe(false);

    // The glance handles the empty/disabled case honestly.
    const glance = buildCommitmentsGlance(body.commitments || []);
    expect(validateGlanceSpec(glance).ok).toBe(true);
    expect(glance.headline.toLowerCase()).toContain('no open promises');
    const { handle } = render(body.commitments || []);
    expect(handle.headline.textContent!.toLowerCase()).toContain('no open promises');
  });

  it('the shipped component file dashboard/glance.js exists and is real (deployed)', () => {
    const file = path.resolve(__dirname, '..', '..', 'dashboard', 'glance.js');
    expect(fs.existsSync(file), 'dashboard/glance.js must ship with the package').toBe(true);
    const src = fs.readFileSync(file, 'utf-8');
    expect(src.length).toBeGreaterThan(2000); // not a stub
    expect(src).toContain('export function validateGlanceSpec');
    expect(src).toContain('export function renderGlance');
  });
});

/**
 * Integration (Tier 2) — Commitments glance against the REAL /commitments HTTP
 * pipeline (Dashboard UX Standard F10/F11, topic 29836).
 *
 * Boots a real Express server with the production createRoutes() + a real
 * CommitmentTracker, fetches GET /commitments?status=active over HTTP, and drives
 * the SHIPPED commitmentsGlanceSpec + renderGlance against the live response —
 * asserting the glance renders, conforms to F10, the "open" count equals the served
 * list length, and every tile drills into the real filtered list.
 */
// @ts-nocheck — the glance module is browser-native ESM.
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { JSDOM } from 'jsdom';
import { createRoutes } from '../../src/server/routes.js';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  commitmentsGlanceSpec,
  buildCommitmentsGlance,
  validateGlanceSpec,
  renderGlance,
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

describe('Commitments glance (integration — real /commitments)', () => {
  let server: TestServer;
  let dir: string;

  afterEach(async () => {
    await server?.close();
    try { if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/glance-commitments-tab.test.ts:cleanup' }); } catch { /* @silent-fallback-ok — best-effort tmp cleanup */ }
  });

  it('renders a conforming glance from the live HTTP response and drills into the real list', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glance-cmt-int-'));
    const tracker = new CommitmentTracker({ stateDir: dir, liveConfig: new LiveConfig(dir) });
    tracker.record({ type: 'one-time-action', topicId: 100, beaconEnabled: true,
      userRequest: 'send the code', agentResponse: 'will send the launch code once the vendor replies' });
    tracker.record({ type: 'one-time-action', topicId: 100, beaconEnabled: true, blockedOn: 'user-input',
      userRequest: 'confirm invoice', agentResponse: 'waiting on your confirmation of the invoice' });
    tracker.record({ type: 'one-time-action', topicId: 100, beaconEnabled: true,
      userRequest: 'weekly report', agentResponse: 'will ship the weekly report' });

    server = await bootApp({ config: { authToken: 't', stateDir: dir, port: 0 }, startTime: new Date(), commitmentTracker: tracker });

    const res = await fetch(server.url + '/commitments?status=active');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(true);
    const open = body.commitments.filter((c: any) => c.beaconEnabled && c.status === 'pending');
    expect(open.length).toBe(3);

    // Build + validate the glance from the REAL response.
    const base = buildCommitmentsGlance(body.commitments);
    expect(validateGlanceSpec(base).ok).toBe(true);
    expect(Number(base.tiles.find((t: any) => t.key === 'open').value)).toBe(open.length);

    // Render + walk every tile against the live data.
    const doc = new JSDOM('<!doctype html><body><div id="root"></div></body>').window.document;
    const root = doc.getElementById('root')!;
    const spec = commitmentsGlanceSpec(doc, body.commitments, { now: Date.now() });
    const handle = renderGlance(doc, root, spec);
    expect(handle.headline.textContent).toContain('3');
    let realDrills = 0;
    for (const btn of handle.tiles) {
      btn.dispatchEvent(new (doc.defaultView as any).Event('click'));
      expect(handle.drilldown.hidden).toBe(false);
      if (handle.drilldown.querySelector('.glance-list-row')) realDrills++;
      btn.dispatchEvent(new (doc.defaultView as any).Event('click')); // toggle closed
    }
    expect(realDrills).toBeGreaterThanOrEqual(1);

    // The "Open" tile drills into exactly the served open-promises list.
    const openBtn = handle.tiles.find((b: any) => b.getAttribute('data-glance-tile') === 'open');
    openBtn.dispatchEvent(new (doc.defaultView as any).Event('click'));
    expect(handle.drilldown.querySelectorAll('.glance-list-row').length).toBe(open.length);
  });
});

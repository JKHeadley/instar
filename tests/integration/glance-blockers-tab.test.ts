/**
 * Integration (Tier 2) — Blockers glance against the REAL /blockers HTTP pipeline
 * (Dashboard UX Standard F10/F11, topic 29836 Phase 2).
 *
 * Boots a real Express server with the production createRoutes() + a real
 * BlockerLedger (seeded on disk with entries in every state bucket), fetches
 * GET /blockers over HTTP, and drives the SHIPPED blockersGlanceSpec + renderGlance
 * against the live response — asserting the glance renders, conforms to F10, the
 * tile counts partition the served list, and every non-empty tile drills into the
 * real filtered entries down to the Layer-3 record.
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
import { BlockerLedger } from '../../src/monitoring/BlockerLedger.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  blockersGlanceSpec,
  buildBlockersGlance,
  blockersPopulation,
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

/** Seed a blocker-ledger store on disk so a real BlockerLedger loads entries in every
 *  state bucket (non-terminal / true-blocker / resolved) without the heavy settle path. */
function seedLedger(stateDir: string): void {
  const dir = path.join(stateDir, 'state');
  fs.mkdirSync(dir, { recursive: true });
  const store = {
    version: 1,
    lastModified: '2026-07-09T00:00:00.000Z',
    nextId: 5,
    entries: [
      { id: 'BLK-001', version: 1, state: 'live-run', detectedText: 'the vendor has not sent the API key yet',
        origin: 'sess-1', createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-09T09:00:00Z', history: [] },
      { id: 'BLK-002', version: 1, state: 'candidate', detectedText: 'cannot reach the deploy host',
        origin: 'sess-1', createdAt: '2026-07-02T00:00:00Z', updatedAt: '2026-07-09T08:00:00Z', history: [] },
      { id: 'BLK-003', version: 3, state: 'resolved', detectedText: 'thought the token was missing but it was there',
        origin: 'sess-1', createdAt: '2026-07-03T00:00:00Z', updatedAt: '2026-07-09T07:00:00Z', history: [],
        terminal: { kind: 'resolved', playbookPath: '.claude/skills/x/SKILL.md', at: '2026-07-09T07:00:00Z' } },
      { id: 'BLK-004', version: 5, state: 'true-blocker', detectedText: 'need the operator password for the bank portal',
        origin: 'sess-1', createdAt: '2026-07-04T00:00:00Z', updatedAt: '2026-07-09T06:00:00Z', history: [],
        terminal: { kind: 'true-blocker', reasonKind: 'operator-only-secret', rebuttal: 'vault miss',
          failedAttempt: { type: 'self-fetch', at: '2026-07-09T05:00:00Z', detail: 'vault decrypt miss', succeeded: false },
          accessRequestRef: 'relay-1', gateDecisionHash: 'deadbeef', at: '2026-07-09T06:00:00Z',
          recheckAfter: '2026-08-01T00:00:00Z', noEvidenceResettleCount: 0 } },
    ],
  };
  fs.writeFileSync(path.join(dir, 'blocker-ledger.json'), JSON.stringify(store, null, 2));
}

describe('Blockers glance (integration — real /blockers)', () => {
  let server: TestServer;
  let dir: string;

  afterEach(async () => {
    await server?.close();
    try { if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/glance-blockers-tab.test.ts:cleanup' }); } catch { /* @silent-fallback-ok — best-effort tmp cleanup */ }
  });

  it('renders a conforming glance from the live HTTP response and drills into the real list', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glance-blk-int-'));
    seedLedger(dir);
    const ledger = new BlockerLedger({ stateDir: dir });

    server = await bootApp({ config: { authToken: 't', stateDir: dir, port: 0 }, startTime: new Date(), blockerLedger: ledger });

    const res = await fetch(server.url + '/blockers');
    expect(res.status).toBe(200); // alive, not 503
    const body = await res.json();
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.entries.length).toBe(4);

    // Build + validate the glance from the REAL response.
    const base = buildBlockersGlance(body.entries);
    expect(validateGlanceSpec(base).ok).toBe(true);
    const pop = blockersPopulation(body.entries);
    const sum = base.tiles.reduce((n: number, t: any) => n + Number(t.value), 0);
    expect(sum).toBe(pop.length); // partition: 2 working + 1 stuck + 1 resolved = 4

    // Render + walk every tile against the live data.
    const doc = new JSDOM('<!doctype html><body><div id="root"></div></body>').window.document;
    const root = doc.getElementById('root')!;
    const spec = blockersGlanceSpec(doc, body.entries);
    const handle = renderGlance(doc, root, spec);
    expect(handle.headline.textContent).toMatch(/1 thing is truly stuck/);

    let realDrills = 0;
    for (const btn of handle.tiles) {
      btn.dispatchEvent(new (doc.defaultView as any).Event('click'));
      expect(handle.drilldown.hidden).toBe(false);
      if (handle.drilldown.querySelector('.glance-list-row')) realDrills++;
      btn.dispatchEvent(new (doc.defaultView as any).Event('click')); // toggle closed
    }
    expect(realDrills).toBeGreaterThanOrEqual(1);

    // The "Truly stuck" tile drills into exactly the 1 true-blocker, and its row opens
    // a Layer-3 record with the raw id + the recheck date (decaying-hypothesis honesty).
    const stuckBtn = handle.tiles.find((b: any) => b.getAttribute('data-glance-tile') === 'stuck');
    stuckBtn.dispatchEvent(new (doc.defaultView as any).Event('click'));
    const rows = handle.drilldown.querySelectorAll('.glance-list-row');
    expect(rows.length).toBe(1);
    rows[0].dispatchEvent(new (doc.defaultView as any).Event('click'));
    const record = handle.drilldown.querySelector('[data-glance-record]');
    expect(record).toBeTruthy();
    expect(record!.textContent).toContain('BLK-004');
    expect(record!.textContent).toMatch(/recheck after/i);
  });

  it('GET /blockers 503 when the ledger is dark → the tab shows an honest note, never a crash', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glance-blk-dark-'));
    server = await bootApp({ config: { authToken: 't', stateDir: dir, port: 0 }, startTime: new Date() }); // no blockerLedger
    const res = await fetch(server.url + '/blockers');
    expect(res.status).toBe(503);
    // The empty-population glance the component builds for the dark case still conforms.
    const glance = buildBlockersGlance([]);
    expect(validateGlanceSpec(glance).ok).toBe(true);
    expect(glance.headline.toLowerCase()).toContain('no blockers');
  });
});

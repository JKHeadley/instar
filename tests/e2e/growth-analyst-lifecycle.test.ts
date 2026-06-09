/**
 * E2E (HTTP) lifecycle test for the GrowthMilestoneAnalyst /growth/* routes.
 * Tier-3 of the Testing Integrity Standard — boots a REAL Express server on a
 * real port and makes REAL HTTP calls.
 *
 * The single most important assertion (Phase-1 "feature is alive"): with the
 * analyst wired, /growth/digest returns 200 (NOT 404/503) and a real digest, and
 * a seeded past-window feature produces the expected R1/R2 milestone end-to-end.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes } from '../../src/server/routes.js';
import { GrowthMilestoneAnalyst, resolveGrowthSettings } from '../../src/monitoring/GrowthMilestoneAnalyst.js';
import type { Initiative, RolloutStage } from '../../src/core/InitiativeTracker.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

interface TestServer { url: string; close: () => Promise<void>; }
async function listen(app: express.Express): Promise<TestServer> {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

function feat(id: string, stage: RolloutStage): Initiative {
  return { id, title: id, rollout: { flagPath: `monitoring.${id}`, stage } } as unknown as Initiative;
}
function fakeTracker(initiatives: Initiative[]) {
  return { list: () => initiatives, digest: (now: Date) => ({ generatedAt: now.toISOString(), items: [] }) } as any;
}

let tmp: string;

describe('GrowthMilestoneAnalyst /growth/* — (E2E over HTTP)', () => {
  let server: TestServer;
  let serverDisabled: TestServer;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gma-e2e-'));

    // Seed: a feature that entered 'live' 30 days ago and has REAL activations →
    // must surface as an R1 promotion-ready milestone. We stamp the journal in
    // the past directly so "days in stage" is large without a fake clock leaking
    // into the HTTP layer.
    const analyst = new GrowthMilestoneAnalyst({
      stateDir: tmp,
      settings: resolveGrowthSettings({ enabled: true }),
      tracker: fakeTracker([feat('seeded-feature', 'live')]),
      evidenceCounter: () => 5, // proved
    });
    const journalDir = path.join(tmp, 'state', 'growth-milestone-analyst');
    fs.mkdirSync(journalDir, { recursive: true });
    const longAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
    fs.writeFileSync(path.join(journalDir, 'stage-journal.json'), JSON.stringify({ 'seeded-feature': { stage: 'live', firstObservedAt: longAgo } }));

    const app = express();
    app.use(express.json());
    app.use(createRoutes({ config: { authToken: 'test', stateDir: tmp, port: 0 }, startTime: new Date(), growthMilestoneAnalyst: analyst } as any));
    server = await listen(app);

    // A second server with the analyst absent (the dark default) — must 503.
    const appOff = express();
    appOff.use(express.json());
    appOff.use(createRoutes({ config: { authToken: 'test', stateDir: tmp, port: 0 }, startTime: new Date(), growthMilestoneAnalyst: null } as any));
    serverDisabled = await listen(appOff);
  });

  afterEach(async () => {
    await server?.close();
    await serverDisabled?.close();
    try { SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/e2e/growth-analyst-lifecycle.test.ts' }); } catch { /* ok */ }
  });

  async function get(s: TestServer, p: string) {
    const res = await fetch(s.url + p);
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  it('FEATURE IS ALIVE: GET /growth/digest returns 200 (not 404/503) with a real digest', async () => {
    const r = await get(server, '/growth/digest');
    expect(r.status).toBe(200);
    expect(r.body.generatedAt).toBeDefined();
    expect(Array.isArray(r.body.findings)).toBe(true);
    expect(r.body.counts).toBeDefined();
  });

  it('a seeded past-window proved feature surfaces an R1 promotion milestone end-to-end', async () => {
    const r = await get(server, '/growth/findings');
    expect(r.status).toBe(200);
    const r1 = r.body.findings.find((f: any) => f.rule === 'R1' && f.subjectId === 'seeded-feature');
    expect(r1).toBeDefined();
    expect(r1.suggestedAction).toBe('promote');
  });

  it('DARK by default: with the analyst unwired every /growth route 503s', async () => {
    for (const p of ['/growth/digest', '/growth/findings', '/growth/status']) {
      const r = await get(serverDisabled, p);
      expect(r.status).toBe(503);
    }
  });
});

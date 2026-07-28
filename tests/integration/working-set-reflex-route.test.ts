// safe-git-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
// safe-fs-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
/**
 * Integration test (WORKING-SET-HANDOFF-SPEC §3.3): the fetch reflex route —
 * POST /coherence/fetch-working-set through the real express router.
 *
 * Covers: 503 while the working-set layer is dark (no coordinator wired);
 * 400 on a missing/non-numeric topic; 200 + outcome through a REAL
 * coordinator (fake puller seam); 429 on the per-topic rate limit.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { createRoutes } from '../../src/server/routes.js';
import { WorkingSetPullCoordinator } from '../../src/core/WorkingSetPullCoordinator.js';
import { PendingPullLedger } from '../../src/core/PendingPullLedger.js';
import { CoherenceJournalReader } from '../../src/core/CoherenceJournalReader.js';
import type { PullReport, WorkingSetPuller } from '../../src/core/WorkingSetPull.js';

const SELF = 'm_self';
const PEER = 'm_peer';

let tmpDir: string;
let server: { url: string; close: () => Promise<void> } | null = null;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-reflex-route-'));
});

afterEach(async () => {
  await server?.close();
  server = null;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

async function listen(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const srv = app.listen(0, () =>
      resolve({
        url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
        close: () => new Promise<void>((r) => srv.close(() => r())),
      }),
    );
  });
}

function seedProducer(topic: number): void {
  const dir = path.join(tmpDir, 'state', 'coherence-journal', 'peers');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${PEER}.autonomous-run.jsonl`),
    JSON.stringify({
      seq: 1,
      ts: '2026-06-06T00:00:01.000Z',
      machine: PEER,
      kind: 'autonomous-run',
      topic,
      data: { action: 'started', runId: 'r1', artifactPaths: [] },
    }) + '\n',
  );
}

function makeApp(coordinator?: WorkingSetPullCoordinator): express.Express {
  const ctx: any = {
    config: { authToken: 'test', stateDir: tmpDir, port: 0 },
    stateDir: tmpDir,
    ...(coordinator ? { workingSetPullCoordinator: coordinator } : {}),
  };
  const app = express();
  app.use(express.json());
  app.use(createRoutes(ctx));
  return app;
}

describe('POST /coherence/fetch-working-set (the reflex, §3.3)', () => {
  it('503 while the working-set layer is dark', async () => {
    server = await listen(makeApp());
    const res = await fetch(`${server.url}/coherence/fetch-working-set`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
      body: JSON.stringify({ topic: 10 }),
    });
    expect(res.status).toBe(503);
  });

  it('400 on a missing topic; 200 + outcome through a real coordinator; 429 on the rate limit', async () => {
    seedProducer(10);
    const okReport: PullReport = { topic: 10, files: [{ relPath: 'x', outcome: 'written' }], assembledBytes: 3, needsPendingPull: false };
    const coordinator = new WorkingSetPullCoordinator({
      stateDir: tmpDir,
      ownMachineId: SELF,
      reader: new CoherenceJournalReader({ stateDir: tmpDir }),
      ledger: new PendingPullLedger({ stateDir: tmpDir }),
      makePuller: () => ({ pullTopic: async () => okReport } as unknown as WorkingSetPuller),
      ownerOf: () => ({ owner: SELF, epoch: 1 }),
      reflexMinIntervalMs: 60_000,
    });
    server = await listen(makeApp(coordinator));

    const bad = await fetch(`${server.url}/coherence/fetch-working-set`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
      body: JSON.stringify({}),
    });
    expect(bad.status).toBe(400);

    const ok = await fetch(`${server.url}/coherence/fetch-working-set`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
      body: JSON.stringify({ topic: 10 }),
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { scheduled: boolean; reports?: { nominee: string }[] };
    expect(body.scheduled).toBe(true);
    expect(body.reports?.[0].nominee).toBe(PEER);

    const limited = await fetch(`${server.url}/coherence/fetch-working-set`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
      body: JSON.stringify({ topic: 10 }),
    });
    expect(limited.status).toBe(429);
  });
});

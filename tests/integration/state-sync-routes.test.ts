/**
 * Feature-alive integration tests for the replicated-store conflict + rollback
 * HTTP surface (multi-machine-replicated-store-foundation §7.2/§7.3/§7.4): the
 * REAL router with REAL ConflictStore + DroppedOriginRegistry on a tmpdir, plus
 * the ships-dark contract (deps absent → 503, the production default state).
 *
 * Routes:
 *   GET  /state/conflicts        — open conflicts, 503 dark.
 *   GET  /state/quarantine       — dropped origins + loss counter, 503 dark.
 *   POST /state/resolve-conflict — operator designates winner / merged, 503 dark.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { ConflictStore } from '../../src/core/ConflictStore.js';
import { DroppedOriginRegistry } from '../../src/core/RollbackUnmerge.js';
import type { ConflictDescriptor, OriginRecord } from '../../src/core/UnionReader.js';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

interface Server { url: string; close: () => Promise<void>; }
async function listen(app: express.Express): Promise<Server> {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

function hlc(p: number, l: number, n: string): HlcTimestamp { return { physical: p, logical: l, node: n }; }
function oRec(origin: string, h: HlcTimestamp): OriginRecord {
  return { origin, envelope: { recordKey: 'k', hlc: h, op: 'put', origin }, data: {} };
}
function descriptor(id: string): ConflictDescriptor {
  return { conflictId: id, recordKey: 'k', versions: [oRec('A', hlc(1, 0, 'A')), oRec('B', hlc(2, 0, 'B'))] };
}

describe('replicated-store conflict + rollback routes', () => {
  let dir: string;
  let server: Server;

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-sync-route-')); });
  afterEach(async () => {
    await server.close();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/state-sync-routes.test.ts' });
  });

  async function start(opts: { conflictStore?: ConflictStore | null; droppedOriginRegistry?: DroppedOriginRegistry | null } = {}): Promise<void> {
    const ctx: any = {
      config: { authToken: 'test', stateDir: dir, port: 0 },
      stateDir: dir,
      coordinator: null,
      conflictStore: opts.conflictStore ?? null,
      droppedOriginRegistry: opts.droppedOriginRegistry ?? null,
    };
    const app = express();
    app.use(express.json());
    app.use(createRoutes(ctx));
    server = await listen(app);
  }

  it('SHIPS-DARK: all three routes → 503 naming the flag when deps absent', async () => {
    await start();
    for (const p of ['/state/conflicts', '/state/quarantine']) {
      const res = await fetch(`${server.url}${p}`);
      expect(res.status).toBe(503);
      expect((await res.json()).error).toContain('multiMachine.stateSync');
    }
    const post = await fetch(`${server.url}/state/resolve-conflict`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conflictId: 'c1', winnerOrigin: 'A' }),
    });
    expect(post.status).toBe(503);
  });

  it('FEATURE-ALIVE: GET /state/conflicts returns open conflicts; resolve closes one', async () => {
    const conflictStore = new ConflictStore({ stateDir: dir, now: () => new Date() });
    conflictStore.recordConflict('pref', descriptor('c1'));
    await start({ conflictStore });

    let res = await fetch(`${server.url}/state/conflicts`);
    expect(res.status).toBe(200);
    let body = await res.json();
    expect(body.enabled).toBe(true);
    expect(body.open).toHaveLength(1);
    expect(body.open[0].conflictId).toBe('c1');

    // Resolve it (operator designates winner A).
    const post = await fetch(`${server.url}/state/resolve-conflict`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conflictId: 'c1', winnerOrigin: 'A' }),
    });
    expect(post.status).toBe(200);
    expect((await post.json()).entry.resolution).toBe('operator-winner');

    res = await fetch(`${server.url}/state/conflicts`);
    body = await res.json();
    expect(body.open).toHaveLength(0); // closed
  });

  it('resolve-conflict: unknown id → 404; bad input (both winner+merged) → 400', async () => {
    const conflictStore = new ConflictStore({ stateDir: dir, now: () => new Date() });
    conflictStore.recordConflict('pref', descriptor('c1'));
    await start({ conflictStore });

    const r404 = await fetch(`${server.url}/state/resolve-conflict`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conflictId: 'nope', winnerOrigin: 'A' }),
    });
    expect(r404.status).toBe(404);

    const r400 = await fetch(`${server.url}/state/resolve-conflict`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conflictId: 'c1', winnerOrigin: 'A', mergedVersion: { x: 1 } }),
    });
    expect(r400.status).toBe(400);

    const rNoId = await fetch(`${server.url}/state/resolve-conflict`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    expect(rNoId.status).toBe(400);
  });

  it('FEATURE-ALIVE: GET /state/quarantine reports dropped origins', async () => {
    const dropped = new DroppedOriginRegistry({ stateDir: dir });
    dropped.add('pref', 'B', new Date().toISOString());
    await start({ droppedOriginRegistry: dropped, conflictStore: new ConflictStore({ stateDir: dir, now: () => new Date() }) });

    const res = await fetch(`${server.url}/state/quarantine`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(true);
    expect(body.droppedOrigins).toHaveLength(1);
    expect(body.droppedOrigins[0].origin).toBe('B');
  });
});

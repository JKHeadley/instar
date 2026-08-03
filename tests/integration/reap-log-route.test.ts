/**
 * GET /sessions/reap-log through the real createRoutes pipeline (§P4).
 *  - 503 when the reap-log is not wired.
 *  - 200 with recorded reaped/skipped entries when present.
 *  - read-only (no write methods), ?limit bounds the tail.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { ReapLog } from '../../src/monitoring/ReapLog.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function ctxWith(
  stateDir: string,
  reapLog: ReapLog | null,
  overrides: Partial<RouteContext> = {},
): RouteContext {
  const base = {
    config: {
      projectName: 'test', projectDir: path.dirname(stateDir), stateDir, port: 0,
      authToken: 'test-token', sessions: {} as any, scheduler: {} as any,
    } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null, listSessions: () => [] } as any,
    tokenLedger: null,
    reapLog,
    startTime: new Date(),
  } as unknown as RouteContext;
  return { ...base, ...overrides };
}

async function startPeer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
  };
}

describe('GET /sessions/reap-log (integration §P4)', () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reaplog-route-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/reap-log-route.test.ts' });
  });

  function appWith(reapLog: ReapLog | null, overrides: Partial<RouteContext> = {}): express.Express {
    const app = express();
    app.use(express.json());
    app.use('/', createRoutes(ctxWith(stateDir, reapLog, overrides)));
    return app;
  }

  it('returns 503 when the reap-log is not wired', async () => {
    const res = await request(appWith(null)).get('/sessions/reap-log');
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/unavailable/);
  });

  it('returns 200 with recorded reaped + skipped entries', async () => {
    const log = new ReapLog(stateDir, () => 'm1');
    log.recordReaped({ session: 'sess-a', tmuxSession: 'ta', reason: 'idle-zombie', disposition: 'terminal', origin: 'autonomous' });
    log.recordSkipped({ session: 'sess-b', tmuxSession: 'tb', reason: 'age-limit', skipped: 'protected', origin: 'autonomous' });

    const res = await request(appWith(log)).get('/sessions/reap-log');
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(2);
    expect(res.body.entries[0]).toMatchObject({ type: 'reaped', session: 'sess-a', reason: 'idle-zombie' });
    expect(res.body.entries[1]).toMatchObject({
      type: 'skipped',
      skipped: 'protected',
      disposition: 'skipped:protected',
    });
    expect(res.body.pool).toBeUndefined();
  });

  it('honours ?limit by returning only the most-recent N', async () => {
    const log = new ReapLog(stateDir);
    for (let i = 0; i < 8; i++) log.recordReaped({ session: `s${i}`, tmuxSession: `t${i}`, reason: 'idle-zombie' });
    const res = await request(appWith(log)).get('/sessions/reap-log?limit=3');
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(3);
    expect(res.body.entries.map((e: { session: string }) => e.session)).toEqual(['s5', 's6', 's7']);
  });

  it('includePage=1 reports whether the local reap-log tail was truncated without changing ordinary responses', async () => {
    const log = new ReapLog(stateDir);
    for (let i = 0; i < 3; i++) log.recordReaped({ session: `s${i}`, tmuxSession: `t${i}`, reason: 'idle-zombie' });
    fs.appendFileSync(path.join(stateDir, '..', 'logs', 'reap-log.jsonl'), '{\n');

    const ordinary = await request(appWith(log)).get('/sessions/reap-log?limit=2');
    expect(ordinary.body).toEqual({ entries: expect.any(Array) });

    const res = await request(appWith(log)).get('/sessions/reap-log?limit=2&includePage=1');
    expect(res.status).toBe(200);
    expect(res.body.entries.map((entry: { session: string }) => entry.session)).toEqual(['s1', 's2']);
    expect(res.body.page).toEqual({ returned: 2, truncated: true });
  });

  it('includePage and pool sources conservatively expose the reap-log byte-window ceiling', async () => {
    const log = new ReapLog(stateDir, undefined, { tailReadBytes: 900 });
    for (let i = 0; i < 4; i++) {
      log.recordReaped({
        session: `s${i}-${'x'.repeat(400)}`,
        tmuxSession: `t${i}`,
        reason: 'idle-zombie',
      });
    }

    const local = await request(appWith(log)).get('/sessions/reap-log?limit=2&includePage=1');
    expect(local.status).toBe(200);
    expect(local.body.page.truncated).toBe(true);
    expect(local.body.page.returned).toBeLessThanOrEqual(2);

    const pool = await request(appWith(log)).get('/sessions/reap-log?scope=pool&limit=2');
    expect(pool.status).toBe(200);
    expect(pool.body.pool.sources).toEqual([{
      machineId: null,
      returned: local.body.page.returned,
      truncated: true,
    }]);
  });

  it('is read-only — POST/PUT/DELETE are not registered', async () => {
    const app = appWith(new ReapLog(stateDir));
    expect((await request(app).post('/sessions/reap-log')).status).toBe(404);
    expect((await request(app).delete('/sessions/reap-log')).status).toBe(404);
  });

  it('scope=pool merges a real peer log and tags every row with registry identity', async () => {
    const localLog = new ReapLog(stateDir, () => 'local-host');
    localLog.recordSkipped({
      session: 'local-session', tmuxSession: 'tl', reason: 'age-limit',
      skipped: 'not-lease-holder', origin: 'autonomous',
    });
    const peer = await startPeer((req, res) => {
      expect(req.url).toBe('/sessions/reap-log?limit=500&includePage=1');
      expect(req.headers.authorization).toBe('Bearer test-token');
      expect(req.headers['x-instar-agentid']).toBe('test');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        entries: [{
          ts: new Date(0).toISOString(), type: 'skipped', session: 'remote-session',
          tmuxSession: 'tr', reason: 'age-limit', disposition: 'skipped:not-lease-holder',
          skipped: 'not-lease-holder', machine: 'self-reported-remote-host',
          machineId: 'spoofed-machine', machineNickname: 'Spoofed nickname', remote: false,
        }],
        page: { returned: 1, truncated: false },
      }));
    });
    try {
      const res = await request(appWith(localLog, {
        meshSelfId: 'm-self',
        listPoolMachines: () => [{ machineId: 'm-peer', nickname: 'Laptop', lastKnownUrl: peer.url }],
      })).get('/sessions/reap-log?scope=pool&limit=500');

      expect(res.status).toBe(200);
      expect(res.body.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({
          session: 'local-session', machine: 'local-host', machineId: 'm-self',
          machineNickname: null, remote: false,
        }),
        expect.objectContaining({
          session: 'remote-session', machine: 'self-reported-remote-host', machineId: 'm-peer',
          machineNickname: 'Laptop', remote: true,
        }),
      ]));
      expect(res.body.entries.map((entry: { session: string }) => entry.session)).toEqual([
        'remote-session', 'local-session',
      ]);
      expect(res.body.pool).toMatchObject({
        enabled: false,
        selfMachineId: 'm-self',
        peersQueried: 1,
        peersOk: 1,
        limitPerMachine: 500,
        sources: [
          { machineId: 'm-self', returned: 1, truncated: false },
          { machineId: 'm-peer', returned: 1, truncated: false },
        ],
        failed: [],
      });
    } finally {
      await peer.close();
    }
  });

  it('scope=pool preserves local refused-shutoff evidence and classifies a dark registered peer', async () => {
    const localLog = new ReapLog(stateDir, () => 'local-host');
    for (const session of ['local-session-a', 'local-session-b', 'local-session']) {
      localLog.recordSkipped({
        session, tmuxSession: `t-${session}`, reason: 'age-limit',
        skipped: 'not-lease-holder', origin: 'autonomous',
      });
    }
    fs.appendFileSync(path.join(stateDir, '..', 'logs', 'reap-log.jsonl'), '{\n');
    const res = await request(appWith(localLog, {
      meshSelfId: 'm-self',
      listPoolMachines: () => [{ machineId: 'm-dark', nickname: 'Dark laptop', lastKnownUrl: null }],
    })).get('/sessions/reap-log?scope=pool&limit=2');

    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(2);
    expect(res.body.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        session: 'local-session', skipped: 'not-lease-holder', machineId: 'm-self', remote: false,
      }),
    ]));
    expect(res.body.pool.sources).toEqual([{ machineId: 'm-self', returned: 2, truncated: true }]);
    expect(res.body.pool.peersOk).toBe(0);
    expect(res.body.pool.failed).toEqual([{ machineId: 'm-dark', error: 'no-known-url' }]);
  });

  it('scope=pool distinguishes a successful empty peer log from failed fan-out', async () => {
    const peer = await startPeer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ entries: [], page: { returned: 0, truncated: false } }));
    });
    try {
      const res = await request(appWith(new ReapLog(stateDir), {
        meshSelfId: 'm-self',
        listPoolMachines: () => [{ machineId: 'm-empty', lastKnownUrl: peer.url }],
      })).get('/sessions/reap-log?scope=pool&limit=500');

      expect(res.status).toBe(200);
      expect(res.body.entries).toEqual([]);
      expect(res.body.pool.peersQueried).toBe(1);
      expect(res.body.pool.peersOk).toBe(1);
      expect(res.body.pool.sources).toEqual([
        { machineId: 'm-self', returned: 0, truncated: false },
        { machineId: 'm-empty', returned: 0, truncated: false },
      ]);
      expect(res.body.pool.failed).toEqual([]);
    } finally {
      await peer.close();
    }
  });
});

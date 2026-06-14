// safe-fs-allow: test file — tmpdir fixtures only, cleaned via SafeFsExecutor.

/**
 * E2E lifecycle — POST /sessions/:name/remote-close (REMOTE-SESSION-CLOSE-SPEC
 * §3 Tier 3). "Is the feature actually alive?": a REAL Express server on a
 * real port; the route answers (404 for an unknown peer machineId — never a
 * 503/route-missing), the full relay path executes end-to-end against a real
 * ephemeral peer, and WIRED source guards pin the via-claim plumb through
 * SessionManager → sessionReaped → ReapLog so the §2.3 trail cannot silently
 * become dead code.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const AUTH = 'remote-close-e2e';

interface TestServer { url: string; close: () => Promise<void>; }
async function listen(app: express.Express): Promise<TestServer> {
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

describe('POST /sessions/:name/remote-close — E2E lifecycle', () => {
  let dir: string;
  let relayServer: TestServer | null = null;
  let peerServer: TestServer | null = null;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-close-e2e-'));
    fs.mkdirSync(path.join(dir, '.instar', 'state'), { recursive: true });
  });

  afterEach(async () => {
    await relayServer?.close();
    await peerServer?.close();
    relayServer = peerServer = null;
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/remote-session-close-lifecycle.test.ts:cleanup' });
  });

  function buildRelay(machines: Array<{ machineId: string; nickname?: string; lastKnownUrl?: string | null }>): express.Express {
    const ctx = {
      config: {
        projectName: 'rce2e', projectDir: dir, stateDir: path.join(dir, '.instar'), port: 0,
        authToken: AUTH, monitoring: {}, sessions: { protectedSessions: [] }, scheduler: {},
      },
      sessionManager: { listRunningSessions: () => [] },
      state: { getJobState: () => null, getSession: () => null, listSessions: () => [] },
      startTime: new Date(),
      meshSelfId: 'm-relay',
      listPoolMachines: () => machines,
    } as unknown as RouteContext;
    const app = express();
    app.use(express.json());
    app.use(authMiddleware(AUTH));
    app.use('/', createRoutes(ctx));
    return app;
  }

  it('FEATURE IS ALIVE: the route answers 404 for an unknown machineId — never 503/route-missing', async () => {
    relayServer = await listen(buildRelay([]));
    const res = await fetch(`${relayServer.url}/sessions/some-session/remote-close`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${AUTH}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ machineId: 'm-unknown', sessionUuid: 'u-1' }),
    });
    expect(res.status).toBe(404); // alive and answering — a pre-feature server would 404 the PATH; this is the route's own 404
    const body = await res.json() as { error: string };
    expect(body.error).toBe('unknown machine');
  });

  it('end-to-end relay over real HTTP: order placed on the relay, kill executed on the peer, both trails written', async () => {
    const peerKills: string[] = [];
    const peerApp = express();
    peerApp.delete('/sessions/:id', (req, res) => {
      peerKills.push(`${req.params.id}|via=${req.headers['x-instar-close-via']}`);
      res.json({ ok: true, killed: req.params.id });
    });
    peerServer = await listen(peerApp);
    relayServer = await listen(buildRelay([{ machineId: 'm-mini', nickname: 'mini', lastKnownUrl: peerServer.url }]));

    const res = await fetch(`${relayServer.url}/sessions/echo-task/remote-close`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${AUTH}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ machineId: 'm-mini', sessionUuid: 'uuid-real-1' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; killed: string; nickname?: string };
    expect(body.ok).toBe(true);
    expect(body.killed).toBe('uuid-real-1');
    expect(peerKills).toEqual(['uuid-real-1|via=remote-dashboard']);

    // The relay-side ORDER trail (§2.3) survives on disk.
    const audit = fs.readFileSync(path.join(dir, 'logs', 'remote-close-audit.jsonl'), 'utf-8').trim();
    const row = JSON.parse(audit.split('\n').at(-1)!) as Record<string, unknown>;
    expect(row.targetMachineId).toBe('m-mini');
    expect(row.sessionUuid).toBe('uuid-real-1');
    expect(row.outcome).toBe('closed');
  });

  it('401 without auth — the relay verb never rides an exemption', async () => {
    relayServer = await listen(buildRelay([]));
    const res = await fetch(`${relayServer.url}/sessions/x/remote-close`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ machineId: 'm-x', sessionUuid: 'u-1' }),
    });
    expect(res.status).toBe(401);
  });
});

describe('remote-close — WIRED source guards (the via plumb cannot silently die)', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf-8');

  it.each([
    ['terminateSession accepts the untrusted via claim', 'src/core/SessionManager.ts', 'via?: string'],
    ['sessionReaped event carries via', 'src/core/SessionManager.ts', "...(opts?.via ? { via: opts.via } : {})"],
    ['server handler records viaClaim', 'src/commands/server.ts', '...(e.via ? { viaClaim: e.via } : {})'],
    ['ReapLog persists viaClaim', 'src/monitoring/ReapLog.ts', 'viaClaim?: string'],
    ['DELETE route sanitizes the via header', 'src/server/routes.ts', "x-instar-close-via"],
    ['relay route exists', 'src/server/routes.ts', "/sessions/:name/remote-close"],
    ['relay sends the via claim', 'src/server/routes.ts', "'X-Instar-Close-Via': 'remote-dashboard'"],
    ['relay checks the URL allowlist', 'src/server/routes.ts', 'isPeerUrlAllowedForCredentials(machine.lastKnownUrl'],
  ])('%s', (_name, file, needle) => {
    expect(read(file)).toContain(needle);
  });
});

// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-1 + Tier-2 — POST /sessions/:name/remote-close + the protected flag +
 * viaClaim recording (REMOTE-SESSION-CLOSE-SPEC §3).
 *
 * The REAL route behind the real authMiddleware against real (ephemeral,
 * localhost) peer servers. Pins: machineId is a lookup key only (crafted /
 * unknown → 404 with ZERO outbound fetch); allowlist rejection sends NO
 * token; single-hop (relayed request carries no relay params); peer-404 →
 * calm already-closed; timeout → outcome-unknown (delivery honesty);
 * non-JSON peer body normalized; UUID targeting on a ghost-bearing peer;
 * forged via header cannot alter authority and is stored unverified;
 * GET /sessions rows carry the additive protected flag; relay-audit rows
 * land at both rejection and success.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const AUTH = 'remote-close-token';
const auth = () => ({ Authorization: `Bearer ${AUTH}` });

let tmpDir: string;
let stateDir: string;
const peerServers: http.Server[] = [];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-close-'));
  stateDir = path.join(tmpDir, 'project', '.instar');
  fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
});

afterEach(async () => {
  await Promise.all(peerServers.map((s) => new Promise((r) => s.close(r))));
  peerServers.length = 0;
  SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/remote-session-close.test.ts:afterEach' });
});

function startPeer(app: express.Express): Promise<string> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      peerServers.push(server);
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

interface CtxOpts {
  machines?: Array<{ machineId: string; nickname?: string; lastKnownUrl?: string | null }>;
  protectedSessions?: string[];
  sessions?: Array<{ id: string; tmuxSession: string; name: string; status: string }>;
  terminateCalls?: Array<{ sessionId: string; opts: Record<string, unknown> }>;
}

function ctxFor(o: CtxOpts = {}): RouteContext {
  const sessions = o.sessions ?? [];
  return {
    config: {
      projectName: 'remote-close', projectDir: path.dirname(stateDir), stateDir, port: 0,
      authToken: AUTH, monitoring: {},
      sessions: { protectedSessions: o.protectedSessions ?? [] },
      scheduler: {},
    } as never,
    sessionManager: {
      listRunningSessions: () => [],
      terminateSession: async (sessionId: string, _reason: string, opts: Record<string, unknown>) => {
        o.terminateCalls?.push({ sessionId, opts });
        return { terminated: true };
      },
      clearInjectionTracker: () => {},
    } as never,
    state: {
      getJobState: () => null,
      getSession: (id: string) => sessions.find((s) => s.id === id) ?? null,
      listSessions: (q?: { status?: string }) =>
        q?.status ? sessions.filter((s) => s.status === q.status) : sessions,
    } as never,
    scheduler: null, telegram: null, relationships: null, feedback: null,
    dispatches: null, updateChecker: null, autoUpdater: null, autoDispatcher: null,
    quotaTracker: null, publisher: null, viewer: null, tunnel: null, evolution: null,
    watchdog: null, triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null,
    discoveryEvaluator: null, startTime: new Date(),
    meshSelfId: 'm-self',
    listPoolMachines: () => o.machines ?? [],
  } as unknown as RouteContext;
}

function appWith(ctx: RouteContext): express.Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware(AUTH));
  app.use('/', createRoutes(ctx));
  return app;
}

function auditRows(): Array<Record<string, unknown>> {
  try {
    return fs.readFileSync(path.join(stateDir, '..', 'logs', 'remote-close-audit.jsonl'), 'utf-8')
      .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

describe('POST /sessions/:name/remote-close — targeting + containment (Tier 1)', () => {
  it('requires Bearer (401 without)', async () => {
    const res = await request(appWith(ctxFor())).post('/sessions/x/remote-close')
      .send({ machineId: 'm-peer', sessionUuid: 'u-1' });
    expect(res.status).toBe(401);
  });

  it('crafted / URL-shaped machineId → 404 with ZERO outbound fetch (lookup key only)', async () => {
    let peerHit = false;
    const peerApp = express();
    peerApp.use(() => { peerHit = true; });
    const url = await startPeer(peerApp);
    const app = appWith(ctxFor({ machines: [{ machineId: 'm-real', lastKnownUrl: url }] }));
    for (const machineId of ['http://evil.example.com', '../../../etc', 'unknown-machine', 'm real', '']) {
      const res = await request(app).post('/sessions/x/remote-close').set(auth())
        .send({ machineId, sessionUuid: 'u-1' });
      expect(res.status, `machineId=${JSON.stringify(machineId)}`).toBe(404);
    }
    expect(peerHit).toBe(false);
  });

  it('machine with no lastKnownUrl → 404, zero outbound', async () => {
    const res = await request(appWith(ctxFor({ machines: [{ machineId: 'm-dark', lastKnownUrl: null }] })))
      .post('/sessions/x/remote-close').set(auth()).send({ machineId: 'm-dark', sessionUuid: 'u-1' });
    expect(res.status).toBe(404);
  });

  it('non-allowlisted URL → 502 url-rejected, NO token sent, audit row written', async () => {
    const res = await request(appWith(ctxFor({
      machines: [{ machineId: 'm-evil', lastKnownUrl: 'https://evil.example.com' }],
    }))).post('/sessions/x/remote-close').set(auth()).send({ machineId: 'm-evil', sessionUuid: 'u-1' });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('url-rejected');
    const rows = auditRows();
    expect(rows.length).toBe(1);
    expect(rows[0].outcome).toBe('url-rejected');
  });

  it('missing/invalid sessionUuid → 400', async () => {
    const app = appWith(ctxFor({ machines: [{ machineId: 'm-peer', lastKnownUrl: 'http://127.0.0.1:1' }] }));
    expect((await request(app).post('/sessions/x/remote-close').set(auth()).send({ machineId: 'm-peer' })).status).toBe(400);
    expect((await request(app).post('/sessions/x/remote-close').set(auth()).send({ machineId: 'm-peer', sessionUuid: 'u/../1' })).status).toBe(400);
  });

  it('single-hop by construction: the relayed request is the peer PLAIN local close (no relay params, no machineId)', async () => {
    let seen: { method?: string; url?: string; body?: unknown; via?: unknown; auth?: unknown } = {};
    const peerApp = express();
    peerApp.use(express.json());
    peerApp.delete('/sessions/:id', (req, res) => {
      seen = { method: 'DELETE', url: req.originalUrl, body: req.body, via: req.headers['x-instar-close-via'], auth: req.headers.authorization };
      res.json({ ok: true, killed: req.params.id });
    });
    const url = await startPeer(peerApp);
    const res = await request(appWith(ctxFor({ machines: [{ machineId: 'm-peer', nickname: 'mini', lastKnownUrl: url }] })))
      .post('/sessions/my-sess/remote-close').set(auth()).send({ machineId: 'm-peer', sessionUuid: 'uuid-123' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.killed).toBe('uuid-123');
    expect(seen.url).toBe('/sessions/uuid-123'); // UUID-targeted, no query params
    expect(seen.url).not.toContain('machineId');
    expect(seen.url).not.toContain('remote');
    expect(seen.via).toBe('remote-dashboard');
    expect(seen.auth).toBe(`Bearer ${AUTH}`);
    expect(auditRows().at(-1)?.outcome).toBe('closed');
  });

  it('rate limit: the relay path refuses a kill sweep (>10/min → 429)', async () => {
    const app = appWith(ctxFor({ machines: [] }));
    let limited = 0;
    for (let i = 0; i < 14; i++) {
      const res = await request(app).post('/sessions/x/remote-close').set(auth())
        .send({ machineId: `m-${i}`, sessionUuid: 'u-1' });
      if (res.status === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
  });
});

describe('relay outcomes — delivery honesty (Tier 2, mocked peers)', () => {
  it('peer 404 → CALM already-closed success, never a scary error', async () => {
    const peerApp = express();
    peerApp.delete('/sessions/:id', (_req, res) => { res.status(404).json({ error: 'Session not found' }); });
    const url = await startPeer(peerApp);
    const res = await request(appWith(ctxFor({ machines: [{ machineId: 'm-peer', nickname: 'mini', lastKnownUrl: url }] })))
      .post('/sessions/x/remote-close').set(auth()).send({ machineId: 'm-peer', sessionUuid: 'u-gone' });
    expect(res.status).toBe(200);
    expect(res.body.alreadyClosed).toBe(true);
    expect(auditRows().at(-1)?.outcome).toBe('already-closed');
  });

  it('non-JSON peer body (tunnel HTML error page) normalizes to a reasoned error', async () => {
    const peerApp = express();
    peerApp.delete('/sessions/:id', (_req, res) => { res.status(530).send('<html>cloudflare sad</html>'); });
    const url = await startPeer(peerApp);
    const res = await request(appWith(ctxFor({ machines: [{ machineId: 'm-peer', nickname: 'mini', lastKnownUrl: url }] })))
      .post('/sessions/x/remote-close').set(auth()).send({ machineId: 'm-peer', sessionUuid: 'u-1' });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('530 from mini');
  });

  it('peer 401 → unauthorized classification', async () => {
    const peerApp = express();
    peerApp.delete('/sessions/:id', (_req, res) => { res.status(401).json({ error: 'nope' }); });
    const url = await startPeer(peerApp);
    const res = await request(appWith(ctxFor({ machines: [{ machineId: 'm-peer', nickname: 'mini', lastKnownUrl: url }] })))
      .post('/sessions/x/remote-close').set(auth()).send({ machineId: 'm-peer', sessionUuid: 'u-1' });
    expect(res.status).toBe(502);
    expect(res.body.error).toContain('unauthorized');
    expect(auditRows().at(-1)?.outcome).toBe('unauthorized');
  });

  it('relay timeout → outcome UNKNOWN (504), never "closed nothing"', async () => {
    const peerApp = express();
    peerApp.delete('/sessions/:id', () => { /* never answer */ });
    const url = await startPeer(peerApp);
    const res = await request(appWith(ctxFor({ machines: [{ machineId: 'm-slow', nickname: 'mini', lastKnownUrl: url }] })))
      .post('/sessions/x/remote-close').set(auth()).send({ machineId: 'm-slow', sessionUuid: 'u-1' });
    expect(res.status).toBe(504);
    expect(res.body.outcomeUnknown).toBe(true);
    expect(res.body.error).toContain('outcome unknown');
    expect(auditRows().at(-1)?.outcome).toBe('unknown');
  }, 15_000);

  it('dead peer (connection refused) → unreachable classification', async () => {
    const res = await request(appWith(ctxFor({ machines: [{ machineId: 'm-dead', nickname: 'mini', lastKnownUrl: 'http://127.0.0.1:1' }] })))
      .post('/sessions/x/remote-close').set(auth()).send({ machineId: 'm-dead', sessionUuid: 'u-1' });
    expect(res.status).toBe(502);
    expect(res.body.error).toContain('unreachable');
    expect(auditRows().at(-1)?.outcome).toBe('unreachable');
  });
});

describe('peer-side semantics (Tier 1+2)', () => {
  it('forged via header is recorded as a claim and CANNOT alter authority (origin stays route-stamped operator)', async () => {
    const terminateCalls: Array<{ sessionId: string; opts: Record<string, unknown> }> = [];
    const app = appWith(ctxFor({
      sessions: [{ id: 'u-1', tmuxSession: 'sess-a', name: 'sess-a', status: 'running' }],
      terminateCalls,
    }));
    const res = await request(app).delete('/sessions/u-1').set(auth())
      .set({ 'X-Instar-Close-Via': 'remote-dashboard' });
    expect(res.status).toBe(200);
    expect(terminateCalls.length).toBe(1);
    expect(terminateCalls[0].opts.origin).toBe('operator'); // route-stamped, untouched by the header
    expect(terminateCalls[0].opts.via).toBe('remote-dashboard'); // recorded as a claim
  });

  it('a junk via header is dropped (sanitized), close still works', async () => {
    const terminateCalls: Array<{ sessionId: string; opts: Record<string, unknown> }> = [];
    const app = appWith(ctxFor({
      sessions: [{ id: 'u-1', tmuxSession: 'sess-a', name: 'sess-a', status: 'running' }],
      terminateCalls,
    }));
    const res = await request(app).delete('/sessions/u-1').set(auth())
      .set({ 'X-Instar-Close-Via': '<script>alert(1)</script>'.repeat(5) });
    expect(res.status).toBe(200);
    expect(terminateCalls[0].opts.via).toBeUndefined();
    expect(terminateCalls[0].opts.origin).toBe('operator');
  });

  it('UUID targeting on a ghost-bearing peer closes exactly the targeted record (ghost-safe)', async () => {
    // Peer carries TWO records for one tmux name (the PR #1067 ghost shape);
    // a UUID-targeted DELETE picks exactly the requested record.
    const terminateCalls: Array<{ sessionId: string; opts: Record<string, unknown> }> = [];
    const app = appWith(ctxFor({
      sessions: [
        { id: 'u-ghost', tmuxSession: 'same-name', name: 'same-name', status: 'running' },
        { id: 'u-live', tmuxSession: 'same-name', name: 'same-name', status: 'running' },
      ],
      terminateCalls,
    }));
    const res = await request(app).delete('/sessions/u-live').set(auth());
    expect(res.status).toBe(200);
    expect(terminateCalls.length).toBe(1);
    expect(terminateCalls[0].sessionId).toBe('u-live'); // exactly the tile the operator saw
  });

  it('GET /sessions rows carry the additive protected flag (informed-consent input)', async () => {
    const app = appWith(ctxFor({
      protectedSessions: ['keep-me'],
      sessions: [
        { id: 'u-1', tmuxSession: 'keep-me', name: 'keep-me', status: 'running' },
        { id: 'u-2', tmuxSession: 'normal', name: 'normal', status: 'running' },
      ],
    }));
    const res = await request(app).get('/sessions').set(auth());
    expect(res.status).toBe(200);
    const byName = Object.fromEntries((res.body as Array<{ tmuxSession: string; protected: boolean }>).map((s) => [s.tmuxSession, s.protected]));
    expect(byName['keep-me']).toBe(true);
    expect(byName['normal']).toBe(false);
  });
});

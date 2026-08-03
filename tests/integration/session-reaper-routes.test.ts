/**
 * GET /sessions/reaper through the real createRoutes pipeline.
 *  - 503 when the reaper is not wired.
 *  - 200 with the snapshot (pressure tier + per-session verdicts) when present.
 *  - Dry-run end-to-end: a reap-eligible session is logged-but-not-killed.
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
import { SessionReaper, type SessionReaperDeps } from '../../src/monitoring/SessionReaper.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { Session } from '../../src/core/types.js';

function ctxWith(
  stateDir: string,
  reaper: SessionReaper | null,
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
    sessionReaper: reaper,
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

function reaperDeps(sessions: Session[]): SessionReaperDeps {
  return {
    listRunningSessions: () => sessions,
    captureOutput: () => 'output\n? for shortcuts\n> ',
    hasActiveProcesses: () => false,
    frameworkForSession: () => 'claude-code',
    probeTranscript: () => ({ resolved: true, path: '/t', size: 1, mtime: 1 }),
    isRecoveryActive: () => false,
    isRelayLeaseActive: () => false,
    hasPendingInjection: () => false,
    topicBinding: () => null,
    recentUserMessage: () => false,
    activeCommitmentForTopic: () => false,
    activeSubagentCount: () => 0,
    buildOrAutonomousActive: () => false,
    protectedSessions: () => [],
    pressure: () => ({ tier: 'critical' }),
    terminate: async () => ({ terminated: true }),
    markReaping: () => {},
    clearReaping: () => {},
  };
}

describe('GET /sessions/reaper (integration)', () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reaper-routes-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/session-reaper-routes.test.ts' });
  });

  function appWith(reaper: SessionReaper | null, overrides: Partial<RouteContext> = {}): express.Express {
    const app = express();
    app.use(express.json());
    app.use('/', createRoutes(ctxWith(stateDir, reaper, overrides)));
    return app;
  }

  it('returns 503 when the reaper is not wired', async () => {
    const res = await request(appWith(null)).get('/sessions/reaper');
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/unavailable/);
  });

  it('returns 200 with a snapshot when the reaper is present', async () => {
    const session: Session = {
      id: 's1', name: 'sess', status: 'running', tmuxSession: 't1',
      startedAt: new Date(0).toISOString(), framework: 'claude-code', claudeSessionId: 'c1',
    };
    const reaper = new SessionReaper(reaperDeps([session]), { enabled: true });
    const res = await request(appWith(reaper)).get('/sessions/reaper');
    expect(res.status).toBe(200);
    expect(res.body.pressure.tier).toBe('critical');
    expect(Array.isArray(res.body.sessions)).toBe(true);
    expect(res.body.sessions[0].name).toBe('sess');
    expect(['keep', 'reap-eligible']).toContain(res.body.sessions[0].verdict);
    expect(res.body.pool).toBeUndefined();
  });

  it('dry-run snapshot reports dryRun:true and never reaps', async () => {
    const session: Session = {
      id: 's1', name: 'sess', status: 'running', tmuxSession: 't1',
      startedAt: new Date(0).toISOString(), framework: 'claude-code', claudeSessionId: 'c1',
    };
    let killed = 0;
    const deps = reaperDeps([session]);
    deps.terminate = async () => { killed++; return { terminated: true }; };
    const reaper = new SessionReaper(deps, {
      enabled: true, dryRun: true, minAgeMinutes: 0, confirmObservations: 1,
      confirmWindowMinutes: 0, idleThresholdCriticalMinutes: 0, finalGraceSec: 0,
    });
    // Drive a few ticks; in dry-run nothing must be killed.
    for (let i = 0; i < 4; i++) await reaper.tick();
    const res = await request(appWith(reaper)).get('/sessions/reaper');
    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(killed).toBe(0);
  });

  it('scope=pool fetches a real peer snapshot and keeps the local snapshot at the top level', async () => {
    const peer = await startPeer((req, res) => {
      expect(req.url).toBe('/sessions/reaper');
      expect(req.headers.authorization).toBe('Bearer test-token');
      expect(req.headers['x-instar-agentid']).toBe('test');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        enabled: true,
        dryRun: false,
        autoDisabled: false,
        lastTickAt: 123,
        pressure: { tier: 'moderate', inputs: { freePct: 9 } },
        activeThresholdMinutes: 45,
        reapsLastHour: 2,
        machineId: 'spoofed-machine',
        machineNickname: 'Spoofed machine nickname',
        nickname: 'Spoofed nickname',
        remote: false,
        sessions: [{
          name: 'remote-session', sessionId: 'remote-1', verdict: 'keep', keptBy: 'active-process',
          confidence: 'high', consecutive: 0, idleMs: 0, reapPending: false,
          machineId: 'nested-spoof', machineNickname: 'Nested spoof', remote: false,
        }],
      }));
    });
    try {
      const localSession: Session = {
        id: 'local-1', name: 'local-session', status: 'running', tmuxSession: 'local-tmux',
        startedAt: new Date(0).toISOString(), framework: 'claude-code', claudeSessionId: 'local-claude',
      };
      const reaper = new SessionReaper(reaperDeps([localSession]), { enabled: true });
      const overrides = {
        meshSelfId: 'm-self',
        // Prove the live resolver supersedes a stale registry address.
        resolvePeerUrls: () => [{ machineId: 'm-peer', url: peer.url }],
        listPoolMachines: () => [{ machineId: 'm-peer', nickname: 'Laptop', lastKnownUrl: 'http://127.0.0.1:1' }],
      } satisfies Partial<RouteContext>;
      const res = await request(appWith(reaper, overrides)).get('/sessions/reaper?scope=pool');

      expect(res.status).toBe(200);
      expect(res.body.sessions[0].name).toBe('local-session');
      expect(res.body.pool).toMatchObject({
        enabled: false,
        selfMachineId: 'm-self',
        peersQueried: 1,
        peersOk: 1,
        failed: [],
      });
      expect(res.body.pool.machines[0]).toMatchObject({
        machineId: 'm-peer',
        nickname: 'Laptop',
        pressure: { tier: 'moderate' },
      });
      expect(res.body.pool.machines[0].sessions[0].name).toBe('remote-session');
      expect(res.body.pool.machines[0].machineNickname).toBeUndefined();
      expect(res.body.pool.machines[0].remote).toBeUndefined();
      expect(res.body.pool.machines[0].sessions[0].machineId).toBeUndefined();
      expect(res.body.pool.machines[0].sessions[0].machineNickname).toBeUndefined();
      expect(res.body.pool.machines[0].sessions[0].remote).toBeUndefined();
    } finally {
      await peer.close();
    }
  });

  it('scope=pool rejects a public HTTP peer URL before attaching credentials', async () => {
    const reaper = new SessionReaper(reaperDeps([]), { enabled: true });
    const res = await request(appWith(reaper, {
      meshSelfId: 'm-self',
      listPoolMachines: () => [{ machineId: 'm-public', lastKnownUrl: 'http://example.com:43123' }],
    })).get('/sessions/reaper?scope=pool');

    expect(res.status).toBe(200);
    expect(res.body.pool.peersQueried).toBe(0);
    expect(res.body.pool.peersOk).toBe(0);
    expect(res.body.pool.failed).toEqual([{ machineId: 'm-public', error: 'url-rejected' }]);
  });

  it('scope=pool is explicit on a single-machine install instead of silently looking local', async () => {
    const reaper = new SessionReaper(reaperDeps([]), { enabled: true });
    const res = await request(appWith(reaper)).get('/sessions/reaper?scope=pool');

    expect(res.status).toBe(200);
    expect(res.body.pool).toEqual({
      enabled: false,
      selfMachineId: null,
      selfMachineNickname: null,
      peersQueried: 0,
      peersOk: 0,
      machines: [],
      failed: [],
    });
  });

  it('scope=pool classifies a dark registered peer while the local snapshot still answers', async () => {
    const reaper = new SessionReaper(reaperDeps([]), { enabled: true });
    const overrides = {
      meshSelfId: 'm-self',
      listPoolMachines: () => [{ machineId: 'm-dark', nickname: 'Dark laptop', lastKnownUrl: null }],
    } satisfies Partial<RouteContext>;
    const res = await request(appWith(reaper, overrides)).get('/sessions/reaper?scope=pool');

    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.pool.peersQueried).toBe(0);
    expect(res.body.pool.peersOk).toBe(0);
    expect(res.body.pool.failed).toEqual([{ machineId: 'm-dark', error: 'no-known-url' }]);
  });

  it('scope=pool classifies malformed peer sessions instead of reporting a successful snapshot', async () => {
    const peer = await startPeer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        enabled: true,
        dryRun: false,
        autoDisabled: false,
        lastTickAt: 123,
        pressure: { tier: 'normal' },
        activeThresholdMinutes: null,
        reapsLastHour: 0,
        sessions: ['not-a-session-row'],
      }));
    });
    try {
      const reaper = new SessionReaper(reaperDeps([]), { enabled: true });
      const res = await request(appWith(reaper, {
        meshSelfId: 'm-self',
        listPoolMachines: () => [{ machineId: 'm-malformed', lastKnownUrl: peer.url }],
      })).get('/sessions/reaper?scope=pool');

      expect(res.status).toBe(200);
      expect(res.body.pool.peersOk).toBe(0);
      expect(res.body.pool.machines).toEqual([]);
      expect(res.body.pool.failed).toEqual([{ machineId: 'm-malformed', error: 'invalid-body' }]);
    } finally {
      await peer.close();
    }
  });

  it('scope=pool bounds a chunked peer response while preserving the local snapshot', async () => {
    const peer = await startPeer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Transfer-Encoding', 'chunked');
      res.write(Buffer.alloc(1024 * 1024, 'x'));
      res.write(Buffer.alloc(1024 * 1024, 'x'));
      res.end('x');
    });
    try {
      const reaper = new SessionReaper(reaperDeps([]), { enabled: true });
      const res = await request(appWith(reaper, {
        meshSelfId: 'm-self',
        listPoolMachines: () => [{ machineId: 'm-oversized', lastKnownUrl: peer.url }],
      })).get('/sessions/reaper?scope=pool');

      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(true);
      expect(res.body.pool.peersOk).toBe(0);
      expect(res.body.pool.failed).toEqual([{ machineId: 'm-oversized', error: 'response-bound' }]);
    } finally {
      await peer.close();
    }
  });
});

describe('GET /sessions/reaper/audit (integration)', () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reaper-audit-routes-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/session-reaper-routes.test.ts' });
  });

  function app(overrides: Partial<RouteContext> = {}): express.Express {
    const a = express();
    a.use(express.json());
    a.use('/', createRoutes(ctxWith(stateDir, null, overrides)));
    return a;
  }

  function writeAudit(rows: Array<Record<string, unknown>>): void {
    const logPath = path.join(stateDir, '..', 'logs', 'reaper-audit.jsonl');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  }

  function appendAuditRaw(line: string): void {
    fs.appendFileSync(path.join(stateDir, '..', 'logs', 'reaper-audit.jsonl'), `${line}\n`);
  }

  it('returns an empty list when no audit trail exists yet', async () => {
    const res = await request(app()).get('/sessions/reaper/audit');
    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([]);
    expect(res.body.pool).toBeUndefined();
  });

  it('returns the audit tail and honors ?limit', async () => {
    writeAudit([
      { event: 'decision', session: 'a', verdict: 'keep', keptBy: 'active-process' },
      { event: 'decision', session: 'a', verdict: 'reap-eligible', keptBy: 'all-clear' },
      { event: 'reaped', session: 'a', tier: 'critical' },
    ]);
    const res = await request(app()).get('/sessions/reaper/audit');
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(3);
    expect(res.body.entries[2]).toMatchObject({ event: 'reaped', tier: 'critical' });

    const limited = await request(app()).get('/sessions/reaper/audit?limit=1');
    expect(limited.body.entries).toHaveLength(1);
    expect(limited.body.entries[0]).toMatchObject({ event: 'reaped' });
  });

  it('includePage=1 reports whether the local audit tail was truncated without changing ordinary responses', async () => {
    writeAudit([
      { ts: '2026-01-01T00:00:00.000Z', event: 'decision', session: 'a', verdict: 'keep' },
      { ts: '2026-01-02T00:00:00.000Z', event: 'decision', session: 'b', verdict: 'keep' },
      { ts: '2026-01-03T00:00:00.000Z', event: 'reaped', session: 'c', tier: 'critical' },
    ]);
    appendAuditRaw('{');

    const ordinary = await request(app()).get('/sessions/reaper/audit?limit=2');
    expect(ordinary.body).toEqual({ entries: expect.any(Array) });

    const res = await request(app()).get('/sessions/reaper/audit?limit=2&includePage=1');
    expect(res.status).toBe(200);
    expect(res.body.entries.map((entry: { session: string }) => entry.session)).toEqual(['b', 'c']);
    expect(res.body.page).toEqual({ returned: 2, truncated: true });
  });

  it('scope=pool merges a real peer audit and tags its entries with registry identity', async () => {
    writeAudit([{ ts: '2026-01-01T00:00:00.000Z', event: 'decision', session: 'local', verdict: 'keep' }]);
    const peer = await startPeer((req, res) => {
      expect(req.url).toBe('/sessions/reaper/audit?limit=2&includePage=1');
      expect(req.headers.authorization).toBe('Bearer test-token');
      expect(req.headers['x-instar-agentid']).toBe('test');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        entries: [{
          ts: '2025-01-01T00:00:00.000Z', event: 'reaped', session: 'remote', authorityDomain: 'local-age-monitor',
          machineId: 'spoofed-machine', machineNickname: 'Spoofed nickname', remote: false,
        }],
        page: { returned: 1, truncated: false },
      }));
    });
    try {
      const res = await request(app({
        meshSelfId: 'm-self',
        listPoolMachines: () => [{ machineId: 'm-peer', nickname: 'Laptop', lastKnownUrl: peer.url }],
      })).get('/sessions/reaper/audit?scope=pool&limit=2');

      expect(res.status).toBe(200);
      expect(res.body.pool).toMatchObject({
        enabled: false,
        selfMachineId: 'm-self',
        peersQueried: 1,
        peersOk: 1,
        limitPerMachine: 2,
        sources: [
          { machineId: 'm-self', returned: 1, truncated: false },
          { machineId: 'm-peer', returned: 1, truncated: false },
        ],
        failed: [],
      });
      expect(res.body.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ event: 'decision', session: 'local', machineId: 'm-self', remote: false }),
        expect.objectContaining({
          event: 'reaped', session: 'remote', authorityDomain: 'local-age-monitor',
          machineId: 'm-peer', machineNickname: 'Laptop', remote: true,
        }),
      ]));
      expect(res.body.entries.map((entry: { session: string }) => entry.session)).toEqual(['remote', 'local']);
    } finally {
      await peer.close();
    }
  });

  it('scope=pool exposes a peer audit tail that was truncated at the per-machine limit', async () => {
    const peer = await startPeer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        entries: [
          { ts: '2026-01-02T00:00:00.000Z', event: 'decision', session: 'remote-b', verdict: 'keep' },
          { ts: '2026-01-03T00:00:00.000Z', event: 'reaped', session: 'remote-c', tier: 'critical' },
        ],
        page: { returned: 2, truncated: true },
      }));
    });
    try {
      const res = await request(app({
        meshSelfId: 'm-self',
        listPoolMachines: () => [{ machineId: 'm-peer', lastKnownUrl: peer.url }],
      })).get('/sessions/reaper/audit?scope=pool&limit=2');

      expect(res.status).toBe(200);
      expect(res.body.entries.map((entry: { session: string }) => entry.session)).toEqual(['remote-b', 'remote-c']);
      expect(res.body.pool.sources).toEqual([
        { machineId: 'm-self', returned: 0, truncated: false },
        { machineId: 'm-peer', returned: 2, truncated: true },
      ]);
    } finally {
      await peer.close();
    }
  });

  it('scope=pool accepts an exact-limit peer page that proves it is complete', async () => {
    const peer = await startPeer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        entries: [
          { ts: '2026-01-02T00:00:00.000Z', event: 'decision', session: 'remote-b' },
          { ts: '2026-01-03T00:00:00.000Z', event: 'reaped', session: 'remote-c' },
        ],
        page: { returned: 2, truncated: false },
      }));
    });
    try {
      const res = await request(app({
        meshSelfId: 'm-self',
        listPoolMachines: () => [{ machineId: 'm-peer', lastKnownUrl: peer.url }],
      })).get('/sessions/reaper/audit?scope=pool&limit=2');

      expect(res.status).toBe(200);
      expect(res.body.pool.sources).toEqual([
        { machineId: 'm-self', returned: 0, truncated: false },
        { machineId: 'm-peer', returned: 2, truncated: false },
      ]);
    } finally {
      await peer.close();
    }
  });

  it('scope=pool preserves a peer incomplete flag even when its byte window returned fewer than the limit', async () => {
    const peer = await startPeer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        entries: [{ ts: '2026-01-03T00:00:00.000Z', event: 'reaped', session: 'remote-c' }],
        page: { returned: 1, truncated: true },
      }));
    });
    try {
      const res = await request(app({
        meshSelfId: 'm-self',
        listPoolMachines: () => [{ machineId: 'm-peer', lastKnownUrl: peer.url }],
      })).get('/sessions/reaper/audit?scope=pool&limit=2');

      expect(res.status).toBe(200);
      expect(res.body.pool.sources).toEqual([
        { machineId: 'm-self', returned: 0, truncated: false },
        { machineId: 'm-peer', returned: 1, truncated: true },
      ]);
    } finally {
      await peer.close();
    }
  });

  it('scope=pool exposes local truncation on a single-machine audit', async () => {
    writeAudit([
      { ts: '2026-01-01T00:00:00.000Z', event: 'decision', session: 'a', verdict: 'keep' },
      { ts: '2026-01-02T00:00:00.000Z', event: 'decision', session: 'b', verdict: 'keep' },
      { ts: '2026-01-03T00:00:00.000Z', event: 'reaped', session: 'c', tier: 'critical' },
    ]);
    appendAuditRaw('{');

    const res = await request(app({ meshSelfId: 'm-self' })).get('/sessions/reaper/audit?scope=pool&limit=2');

    expect(res.status).toBe(200);
    expect(res.body.entries.map((entry: { session: string }) => entry.session)).toEqual(['b', 'c']);
    expect(res.body.pool).toMatchObject({
      limitPerMachine: 2,
      sources: [{ machineId: 'm-self', returned: 2, truncated: true }],
    });
  });

  it('scope=pool classifies a peer missing the route and preserves local audit entries', async () => {
    writeAudit([{ event: 'decision', session: 'local', verdict: 'keep' }]);
    const peer = await startPeer((_req, res) => {
      res.statusCode = 404;
      res.end('missing');
    });
    try {
      const res = await request(app({
        meshSelfId: 'm-self',
        listPoolMachines: () => [{ machineId: 'm-old', lastKnownUrl: peer.url }],
      })).get('/sessions/reaper/audit?scope=pool');

      expect(res.status).toBe(200);
      expect(res.body.entries).toEqual([
        expect.objectContaining({ event: 'decision', session: 'local', machineId: 'm-self', remote: false }),
      ]);
      expect(res.body.pool.failed).toEqual([{ machineId: 'm-old', error: 'route-missing' }]);
    } finally {
      await peer.close();
    }
  });

  it('scope=pool classifies malformed peer entries instead of reporting a successful empty audit', async () => {
    const peer = await startPeer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ entries: ['not-an-audit-row'] }));
    });
    try {
      const res = await request(app({
        meshSelfId: 'm-self',
        listPoolMachines: () => [{ machineId: 'm-malformed', lastKnownUrl: peer.url }],
      })).get('/sessions/reaper/audit?scope=pool');

      expect(res.status).toBe(200);
      expect(res.body.pool.peersQueried).toBe(1);
      expect(res.body.pool.peersOk).toBe(0);
      expect(res.body.pool.failed).toEqual([{ machineId: 'm-malformed', error: 'invalid-body' }]);
      expect(res.body.entries).toEqual([]);
    } finally {
      await peer.close();
    }
  });

  it('scope=pool classifies invalid peer JSON instead of calling it unreachable', async () => {
    const peer = await startPeer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end('{not-json');
    });
    try {
      const res = await request(app({
        meshSelfId: 'm-self',
        listPoolMachines: () => [{ machineId: 'm-invalid-json', lastKnownUrl: peer.url }],
      })).get('/sessions/reaper/audit?scope=pool');

      expect(res.status).toBe(200);
      expect(res.body.pool.peersOk).toBe(0);
      expect(res.body.pool.failed).toEqual([{ machineId: 'm-invalid-json', error: 'invalid-body' }]);
    } finally {
      await peer.close();
    }
  });

  it('scope=pool rejects deeply nested peer data before response serialization can fail', async () => {
    const nested = '['.repeat(64) + '0' + ']'.repeat(64);
    const peer = await startPeer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(`{"entries":[{"deep":${nested}}]}`);
    });
    try {
      const res = await request(app({
        meshSelfId: 'm-self',
        listPoolMachines: () => [{ machineId: 'm-deep', lastKnownUrl: peer.url }],
      })).get('/sessions/reaper/audit?scope=pool');

      expect(res.status).toBe(200);
      expect(res.body.pool.peersOk).toBe(0);
      expect(res.body.pool.failed).toEqual([{ machineId: 'm-deep', error: 'invalid-body' }]);
    } finally {
      await peer.close();
    }
  });

  it('scope=pool distinguishes a successful empty peer audit from failed fan-out', async () => {
    const peer = await startPeer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ entries: [], page: { returned: 0, truncated: false } }));
    });
    try {
      const res = await request(app({
        meshSelfId: 'm-self',
        listPoolMachines: () => [{ machineId: 'm-empty', lastKnownUrl: peer.url }],
      })).get('/sessions/reaper/audit?scope=pool');

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

  it('scope=pool treats a peer without page metadata as incomplete rather than silently complete', async () => {
    const peer = await startPeer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ entries: [] }));
    });
    try {
      const res = await request(app({
        meshSelfId: 'm-self',
        listPoolMachines: () => [{ machineId: 'm-old', lastKnownUrl: peer.url }],
      })).get('/sessions/reaper/audit?scope=pool&limit=2');

      expect(res.status).toBe(200);
      expect(res.body.pool.peersOk).toBe(0);
      expect(res.body.pool.sources).toEqual([{ machineId: 'm-self', returned: 0, truncated: false }]);
      expect(res.body.pool.failed).toEqual([{ machineId: 'm-old', error: 'invalid-body' }]);
    } finally {
      await peer.close();
    }
  });
});

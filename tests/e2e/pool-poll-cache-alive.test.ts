// safe-fs-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
/**
 * Tier-3 "feature is alive" E2E for WS4.4(f) global pool-cache unification
 * (MULTI-MACHINE-SEAMLESSNESS-SPEC §WS4.4 clause (f)). Per CLAUDE.md the Tier-3
 * test is "the single most important test for any feature with API routes": it
 * proves the route is reachable through the REAL AgentServer stack (auth
 * middleware, error handling) and behaves — not 503 because a dep wasn't wired.
 *
 * Spins up TWO real AgentServers:
 *   - WIRED: a real AgentServer with a real PoolPollCache on its RouteContext.
 *     GET /pool/poll-cache returns 200 with the live snapshot, and sits behind
 *     auth (no Bearer → 401/403).
 *   - DARK: a real AgentServer with NO poolPollCache (the ships-dark default).
 *     GET /pool/poll-cache returns 503 with { enabled: false } — the ships-dark
 *     contract, so the route's presence honestly reflects whether the
 *     unification is engaged on this agent.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SessionManager } from '../../src/core/SessionManager.js';
import { PoolPollCache } from '../../src/server/PoolPollCache.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const TOKEN = 'ws44f-e2e-token';
const WIRED_PORT = 47271;
const DARK_PORT = 47272;

describe('E2E: WS4.4(f) /pool/poll-cache is ALIVE through the real AgentServer', () => {
  let dir: string;
  let wiredServer: AgentServer;
  let darkServer: AgentServer;
  const wiredBase = `http://127.0.0.1:${WIRED_PORT}`;
  const darkBase = `http://127.0.0.1:${DARK_PORT}`;
  const auth = { Authorization: `Bearer ${TOKEN}` };

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws44f-alive-'));

    // ── WIRED server (poolPollCache present) ──
    wiredServer = new AgentServer({
      config: { projectName: 'ws44f-wired', projectDir: dir, stateDir: dir, port: WIRED_PORT, authToken: TOKEN } as unknown as InstarConfig,
      sessionManager: new SessionManager({ projectDir: dir, port: WIRED_PORT }),
      state: new StateManager(dir),
      poolPollCache: new PoolPollCache({ ttlMs: 3000 }),
      meshSelfId: 'm_wired',
    });
    await wiredServer.start();

    // ── DARK server (ships-dark default — no poolPollCache) ──
    darkServer = new AgentServer({
      config: { projectName: 'ws44f-dark', projectDir: dir, stateDir: dir, port: DARK_PORT, authToken: TOKEN } as unknown as InstarConfig,
      sessionManager: new SessionManager({ projectDir: dir, port: DARK_PORT }),
      state: new StateManager(dir),
      meshSelfId: 'm_dark',
    });
    await darkServer.start();
  }, 30000);

  afterAll(async () => {
    await wiredServer?.stop();
    await darkServer?.stop();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/pool-poll-cache-alive.test.ts' });
  });

  it('WIRED: GET /pool/poll-cache is ALIVE — 200 with the live snapshot (not 503)', async () => {
    const res = await fetch(`${wiredBase}/pool/poll-cache`, { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enabled?: boolean; ttlMs?: number; stats?: Record<string, number> };
    expect(body.enabled).toBe(true);
    expect(body.ttlMs).toBe(3000);
    expect(body.stats).toMatchObject({ fetches: 0, cacheHits: 0, loadSheds: 0 });
  });

  it('the /pool/poll-cache route sits behind auth (no Bearer → 401/403) — proves the real middleware stack', async () => {
    const res = await fetch(`${wiredBase}/pool/poll-cache`);
    expect([401, 403]).toContain(res.status);
  });

  it('DARK (ships-dark default): GET /pool/poll-cache 503s with { enabled: false }', async () => {
    const res = await fetch(`${darkBase}/pool/poll-cache`, { headers: auth });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { enabled?: boolean; error?: string };
    expect(body.enabled).toBe(false);
    expect(body.error).toContain('ws44PoolCache');
  });
});

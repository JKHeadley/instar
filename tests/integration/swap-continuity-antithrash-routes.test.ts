/**
 * Integration tests — full HTTP pipeline for the swap-continuity-antithrash
 * surfaces (docs/specs/swap-continuity-antithrash.md §12, Tier 2):
 *
 *   - GET /subscription-pool/proactive-swap serves the ADDITIVE
 *     `antiThrash`/`brakes`/`deferrals` blocks when the engine is wired
 *     (superset of the legacy shape — nothing renamed, nothing 503s);
 *   - POST /sessions/refresh answers busy PRE-202 with 409 `session-busy`
 *     (counts + ages only), `force: true` overrides the gate (202), and a
 *     non-boolean `force` is a 400.
 *
 * Boots a real Express app with createRoutes() and REAL core modules
 * (ProactiveSwapMonitor + SwapAntiThrashEngine + SwapLedger + SessionRefresh)
 * — hermetic, no process spawn.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { ProactiveSwapMonitor } from '../../src/core/ProactiveSwapMonitor.js';
import {
  SwapAntiThrashEngine,
  resolveAntiThrashKnobs,
  retentionBoundMs,
} from '../../src/core/SwapAntiThrash.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SwapLedger } from '../../src/core/SwapLedger.js';
import { SessionRefresh, type SwapContinuityGateContext } from '../../src/core/SessionRefresh.js';
import type { WorkProbeResult } from '../../src/core/SwapWorkGate.js';
import type { SubscriptionAccount, AccountQuotaSnapshot } from '../../src/core/SubscriptionPool.js';
import type { SessionManager } from '../../src/core/SessionManager.js';
import type { StateManager } from '../../src/core/StateManager.js';
import type { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import type { TopicResumeMap } from '../../src/core/TopicResumeMap.js';

const NOW = Date.parse('2026-07-02T15:00:00Z');

function acct(id: string, util: number): SubscriptionAccount {
  const lastQuota: AccountQuotaSnapshot = {
    sevenDay: { utilizationPct: util, resetsAt: '2026-07-03T00:00:00Z' },
    source: 'oauth-usage-endpoint-fallback',
    measuredAt: new Date(NOW - 60_000).toISOString(),
  };
  return {
    id,
    nickname: id,
    provider: 'anthropic',
    framework: 'claude-code',
    configHome: `/h/.claude-${id}`,
    status: 'active',
    lastQuota,
    enrolledAt: '2026-06-01T00:00:00Z',
    version: 1,
  };
}

interface TestServer {
  url: string;
  close: () => Promise<void>;
}
async function listen(app: express.Express): Promise<TestServer> {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

const AUTH = { Authorization: 'Bearer t' };

describe('swap-continuity-antithrash routes (integration)', () => {
  let server: TestServer | null = null;
  let dir: string;

  afterEach(async () => {
    await server?.close();
    server = null;
    if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/swap-continuity-antithrash-routes.test.ts:cleanup' });
    dir = '';
  });

  function ensureDir(): string {
    if (!dir) dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swap-int-'));
    return dir;
  }

  function makeEngine() {
    ensureDir();
    const knobs = () => resolveAntiThrashKnobs({ enabled: true, dryRun: false }, { thresholdPct: 80, tickMs: 180_000 });
    const ledger = new SwapLedger({
      filePath: path.join(dir, 'state', 'swap-ledger.jsonl'),
      windowMs: () => retentionBoundMs(knobs()),
      now: () => NOW,
    });
    const engine = new SwapAntiThrashEngine({ ledger, getKnobs: knobs, now: () => NOW });
    engine.hydrate();
    return { engine, knobs };
  }

  async function boot(ctxExtra: Record<string, unknown>): Promise<void> {
    ensureDir();
    const ctx: Record<string, unknown> = {
      config: { authToken: 't', stateDir: dir, port: 0 },
      startTime: new Date(),
      ...ctxExtra,
    };
    const app = express();
    app.use(express.json());
    app.use(createRoutes(ctx as never));
    server = await listen(app);
  }

  describe('GET /subscription-pool/proactive-swap (additive brakes/deferrals blocks)', () => {
    it('serves the legacy shape PLUS antiThrash/brakes/deferrals when the engine is wired', async () => {
      const { engine, knobs } = makeEngine();
      const accounts = [acct('hot', 85), acct('warm', 70)]; // all-hot pool
      const monitor = new ProactiveSwapMonitor({
        listAccounts: () => accounts,
        listRunningSessions: () => [{ sessionName: 's1', accountId: 'hot', startedAt: '2026-07-02T14:00:00Z' }],
        resolveDefaultAccountId: async () => null,
        swap: async () => ({ swapped: true, toAccountId: null }),
        now: () => NOW,
        antiThrash: { engine, getKnobs: knobs },
      });
      await monitor.evaluate(); // produces one all-hot refusal
      await boot({ proactiveSwapMonitor: monitor });

      const res = await fetch(`${server!.url}/subscription-pool/proactive-swap`, { headers: AUTH });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      // Legacy superset (nothing renamed):
      expect(body).toMatchObject({ thresholdPct: 80, running: false });
      // Additive §6.3 blocks:
      expect(body.antiThrash).toEqual({ enabled: true, dryRun: false });
      const brakes = body.brakes as Record<string, unknown>;
      expect((brakes.refusals as { byReason: Record<string, number> }).byReason['all-hot']).toBe(1);
      expect((brakes.thrash as Record<string, unknown>).breakerState).toBe('closed');
      expect(brakes.hydration).toBe('complete');
      expect((brakes.ledger as Record<string, unknown>).writable).toBe(true);
      expect(body.deferrals).toEqual({ active: 0, sessions: [] });
    });

    it('stays the plain legacy shape when the engine is NOT wired (back-compat)', async () => {
      const monitor = new ProactiveSwapMonitor({
        listAccounts: () => [acct('hot', 85)],
        listRunningSessions: () => [],
        resolveDefaultAccountId: async () => null,
        swap: async () => ({ swapped: false, toAccountId: null }),
        now: () => NOW,
      });
      await boot({ proactiveSwapMonitor: monitor });
      const res = await fetch(`${server!.url}/subscription-pool/proactive-swap`, { headers: AUTH });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.brakes).toBeUndefined();
      expect(body.deferrals).toBeUndefined();
    });
  });

  describe('POST /sessions/refresh — §4.5 pre-202 refusal + force', () => {
    function makeSessionRefresh(over: { probe: () => Promise<WorkProbeResult>; dryRun?: boolean }) {
      const respawner = vi.fn(async () => 'new-tmux');
      const killSession = vi.fn().mockReturnValue(true);
      const workGateCtx: SwapContinuityGateContext = {
        probe: over.probe,
        getKnobs: () => ({ enabled: true, dryRun: over.dryRun ?? false, reactiveGraceMs: 1_000, recheckMs: 250 }),
        wait: async () => {},
      };
      const refresh = new SessionRefresh({
        sessionManager: { killSession } as unknown as SessionManager,
        state: {
          listSessions: vi.fn().mockReturnValue([{ id: 'st-1', tmuxSession: 'echo-busy' }]),
        } as unknown as StateManager,
        telegram: { getTopicForSession: vi.fn().mockReturnValue(42) } as unknown as TelegramAdapter,
        topicResumeMap: { findUuidForSession: vi.fn(), save: vi.fn(), remove: vi.fn() } as unknown as TopicResumeMap,
        respawner,
        workGateCtx,
      });
      return { refresh, respawner, killSession };
    }

    const busyProbe = async (): Promise<WorkProbeResult> => ({
      busy: true,
      turnLeg: 'working',
      subagentLeg: 'ok',
      turnInFlight: true,
      subagents: [{ agentType: 'general-purpose', ageMinutes: 7 }],
      reason: 'busy-turn',
    });

    it('busy → synchronous 409 session-busy with counts + ages ONLY (no paths, no content)', async () => {
      const { refresh, respawner } = makeSessionRefresh({ probe: busyProbe });
      await boot({ sessionRefresh: refresh });
      const res = await fetch(`${server!.url}/sessions/refresh`, {
        method: 'POST',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionName: 'echo-busy' }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.code).toBe('session-busy');
      expect(body.turnInFlight).toBe(true);
      expect(body.subagents).toEqual([{ agentType: 'general-purpose', ageMinutes: 7 }]);
      // The wire payload never carries transcript paths or message content.
      expect(JSON.stringify(body)).not.toContain('transcriptPath');
      expect(respawner).not.toHaveBeenCalled();
    });

    it('force:true overrides the work gate → 202 (the refresh is scheduled)', async () => {
      const { refresh } = makeSessionRefresh({ probe: busyProbe });
      await boot({ sessionRefresh: refresh });
      const res = await fetch(`${server!.url}/sessions/refresh`, {
        method: 'POST',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionName: 'echo-busy', force: true }),
      });
      expect(res.status).toBe(202);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.ok).toBe(true);
    });

    it('idle → 202 exactly as before (the gate releases)', async () => {
      const { refresh } = makeSessionRefresh({
        probe: async () => ({ busy: false, turnLeg: 'idle', subagentLeg: 'ok', turnInFlight: false, subagents: [], reason: null }),
      });
      await boot({ sessionRefresh: refresh });
      const res = await fetch(`${server!.url}/sessions/refresh`, {
        method: 'POST',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionName: 'echo-busy' }),
      });
      expect(res.status).toBe(202);
    });

    it('dryRun soaks: busy would-refuse is logged, the route stays 202 (no behavior change)', async () => {
      const { refresh } = makeSessionRefresh({ probe: busyProbe, dryRun: true });
      await boot({ sessionRefresh: refresh });
      const res = await fetch(`${server!.url}/sessions/refresh`, {
        method: 'POST',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionName: 'echo-busy' }),
      });
      expect(res.status).toBe(202);
    });

    it('a non-boolean force is a 400 (validation, never coercion)', async () => {
      const { refresh } = makeSessionRefresh({ probe: busyProbe });
      await boot({ sessionRefresh: refresh });
      const res = await fetch(`${server!.url}/sessions/refresh`, {
        method: 'POST',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionName: 'echo-busy', force: 'yes' }),
      });
      expect(res.status).toBe(400);
    });

    it('I11: a request-supplied callerClass is IGNORED — the route pins interactive semantics (409, not exempt)', async () => {
      const { refresh, respawner } = makeSessionRefresh({ probe: busyProbe });
      await boot({ sessionRefresh: refresh });
      const res = await fetch(`${server!.url}/sessions/refresh`, {
        method: 'POST',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionName: 'echo-busy', callerClass: 'recovery' }),
      });
      // A wire-derived 'recovery' would bypass the gate — it must not.
      expect(res.status).toBe(409);
      expect(respawner).not.toHaveBeenCalled();
    });
  });
});

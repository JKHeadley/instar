/**
 * E2E (HTTP) lifecycle test for swap-continuity anti-thrash
 * (docs/specs/swap-continuity-antithrash.md §12, Tier 3). Boots a REAL
 * Express server with the PRODUCTION-SHAPED spine mirroring server.ts:
 * a real SwapLedger on a real state file, a real hydrated
 * SwapAntiThrashEngine, a real SwapWorkGate, a braked ProactiveSwapMonitor,
 * and a SessionRefresh carrying the workGateCtx.
 *
 * Key assertion: the feature is ALIVE —
 *   - DARK: the status route answers 200 (never 503) with the legacy shape
 *     when nothing is wired;
 *   - LIVE: the additive antiThrash/brakes/deferrals blocks are served over
 *     HTTP, the §4.5 work gate refuses a busy refresh PRE-202 with 409
 *     `session-busy` (force:true overrides → 202), and the refusal leaves a
 *     DURABLE trace in state/swap-ledger.jsonl on disk.
 */

import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { ProactiveSwapMonitor } from '../../src/core/ProactiveSwapMonitor.js';
import { SwapAntiThrashEngine, resolveAntiThrashKnobs, retentionBoundMs } from '../../src/core/SwapAntiThrash.js';
import { SwapLedger } from '../../src/core/SwapLedger.js';
import { SwapWorkGate } from '../../src/core/SwapWorkGate.js';
import { SessionRefresh, type SwapContinuityGateContext } from '../../src/core/SessionRefresh.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
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

interface TestServer { url: string; close: () => Promise<void>; }
function boot(ctx: Record<string, unknown>): Promise<TestServer> {
  const app = express();
  app.use(express.json());
  app.use(createRoutes(ctx as never));
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

describe('swap-continuity anti-thrash — E2E feature-alive', () => {
  let server: TestServer | null = null;
  let dir = '';

  afterEach(async () => {
    await server?.close();
    server = null;
    try {
      if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/swap-continuity-antithrash-lifecycle.test.ts:cleanup' });
    } catch { /* @silent-fallback-ok */ }
    dir = '';
  });

  it('DARK: the status route answers 200 with the legacy shape when nothing is wired (never 503)', async () => {
    server = await boot({ config: { authToken: 't', stateDir: '/tmp/.instar', port: 0 }, startTime: new Date() });
    const res = await fetch(`${server.url}/subscription-pool/proactive-swap`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.enabled).toBe(false);
    expect(body.brakes).toBeUndefined();
    expect(body.deferrals).toBeUndefined();
  });

  it('LIVE: the production-shaped spine serves the brakes over HTTP and the work gate refuses a busy refresh — durably ledgered', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swap-e2e-'));
    const ledgerPath = path.join(dir, 'state', 'swap-ledger.jsonl');

    // ── The spine, mirroring server.ts (constructed + hydrated at boot) ──
    const knobs = () => resolveAntiThrashKnobs({ enabled: true, dryRun: false }, { thresholdPct: 80, tickMs: 180_000 });
    const ledger = new SwapLedger({ filePath: ledgerPath, windowMs: () => retentionBoundMs(knobs()), now: () => NOW });
    const engine = new SwapAntiThrashEngine({ ledger, getKnobs: knobs, now: () => NOW });
    engine.hydrate();

    // A real SwapWorkGate over deterministic session-manager-shaped deps:
    // the turn leg reports a live turn (the session is mid-work).
    const workGate = new SwapWorkGate({
      checkSessionWorkState: async () => 'working',
      getClaudeSessionId: () => 'claude-uuid-1',
      hasActiveSubagents: () => false,
      getActiveSubagents: () => [],
      now: () => NOW,
    });

    // ── The braked monitor (all-hot pool → stay-put refusal) ──
    const accounts = [acct('hot', 85), acct('warm', 72)];
    const monitor = new ProactiveSwapMonitor({
      listAccounts: () => accounts,
      listRunningSessions: () => [{ sessionName: 'echo-busy', accountId: 'hot', startedAt: '2026-07-02T14:00:00Z' }],
      resolveDefaultAccountId: async () => null,
      swap: async () => ({ swapped: true, toAccountId: null }),
      now: () => NOW,
      antiThrash: { engine, getKnobs: knobs },
    });
    await monitor.evaluate();

    // ── SessionRefresh with the workGateCtx (the §4.2 funnel) ──
    const workGateCtx: SwapContinuityGateContext = {
      probe: (tmux) => workGate.probe(tmux),
      getKnobs: () => ({ enabled: true, dryRun: false, reactiveGraceMs: 1_000, recheckMs: 250 }),
      recordProceeded: (args) => engine.recordProceeded(args),
      recordInteractiveRefusal: (args) => engine.recordInteractiveRefusal(args),
      wait: async () => {},
    };
    const refresh = new SessionRefresh({
      sessionManager: { killSession: () => true } as unknown as SessionManager,
      state: { listSessions: () => [{ id: 'st-1', tmuxSession: 'echo-busy' }] } as unknown as StateManager,
      telegram: { getTopicForSession: () => 42 } as unknown as TelegramAdapter,
      topicResumeMap: { findUuidForSession: () => null, save: () => {}, remove: () => {} } as unknown as TopicResumeMap,
      respawner: async () => 'echo-busy-new',
      workGateCtx,
    });

    server = await boot({
      config: { authToken: 't', stateDir: dir, port: 0 },
      startTime: new Date(),
      proactiveSwapMonitor: monitor,
      sessionRefresh: refresh,
    });

    // Feature alive #1: the additive status blocks over real HTTP.
    const status = await fetch(`${server.url}/subscription-pool/proactive-swap`, { headers: { Authorization: 'Bearer t' } });
    expect(status.status).toBe(200);
    const body = (await status.json()) as Record<string, unknown>;
    expect(body.antiThrash).toEqual({ enabled: true, dryRun: false });
    const brakes = body.brakes as { refusals: { byReason: Record<string, number> }; hydration: string };
    expect(brakes.refusals.byReason['all-hot']).toBe(1);
    expect(brakes.hydration).toBe('complete');
    expect(body.deferrals).toEqual({ active: 0, sessions: [] });

    // Feature alive #2: the §4.5 work gate refuses the busy refresh PRE-202.
    const busy = await fetch(`${server.url}/sessions/refresh`, {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionName: 'echo-busy' }),
    });
    expect(busy.status).toBe(409);
    const busyBody = (await busy.json()) as Record<string, unknown>;
    expect(busyBody.code).toBe('session-busy');
    expect(busyBody.turnInFlight).toBe(true);

    // force:true overrides ONLY the work gate → the refresh is scheduled.
    const forced = await fetch(`${server.url}/sessions/refresh`, {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionName: 'echo-busy', force: true }),
    });
    expect(forced.status).toBe(202);

    // Feature alive #3: the decisions left a DURABLE trace on disk — the
    // restart-proof substrate the dwell/breaker derivations hydrate from.
    expect(fs.existsSync(ledgerPath)).toBe(true);
    const rows = fs
      .readFileSync(ledgerPath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(rows.some((r) => r.reason === 'all-hot')).toBe(true);
    expect(rows.some((r) => r.kind === 'interactive' && r.reason === 'session-busy')).toBe(true);

    // And a SECOND boot hydrates from that same file (restart-proof: the
    // in-memory index is warm without any new observation).
    const engine2 = new SwapAntiThrashEngine({
      ledger: new SwapLedger({ filePath: ledgerPath, windowMs: () => retentionBoundMs(knobs()), now: () => NOW }),
      getKnobs: knobs,
      now: () => NOW,
    });
    engine2.hydrate();
    expect((engine2.status() as { hydration?: string }).hydration).toBe('complete');
  });
});

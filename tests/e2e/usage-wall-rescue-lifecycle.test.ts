/**
 * E2E lifecycle — usage-wall-rescue (docs/specs/usage-wall-rescue.md).
 *
 * Mirrors the production chain in server.ts end to end, with only tmux and the
 * session restart as seams:
 *   shipped config defaults (applyDefaults over an EXISTING agent's config —
 *   the PostUpdateMigrator path) → real SessionWatchdog reading the walled pane
 *   → 'usage-wall' → real UsageWallRescue → real QuotaAwareScheduler → the
 *   restart under another account's config home; plus the HTTP status route
 *   and the standby wording.
 *
 * The 2026-11-04 incident shape: an UNTAGGED Telegram session on a default
 * login at 100% weekly, pool accounts at 10% and 47%. Before this change the
 * session sat at the wall with no move and no notice.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { SubscriptionPool } from '../../src/core/SubscriptionPool.js';
import { QuotaAwareScheduler } from '../../src/core/QuotaAwareScheduler.js';
import { UsageWallRescue, type WallRescueConfigView } from '../../src/core/UsageWallRescue.js';
import { SessionWatchdog } from '../../src/monitoring/SessionWatchdog.js';
import { detectQuotaExhaustion } from '../../src/monitoring/PresenceProxy.js';
import { applyDefaults, getMigrationDefaults } from '../../src/config/ConfigDefaults.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const WALLED_PANE = [
  '⏺ Bash(tail -n 40 .instar/logs/server.log)',
  '  ⎿  Running…',
  '',
  '  ⎿  Usage limit reached · limit resets 8am',
  '     Continuing automatically at 8am · esc to cancel · /usage-credits to continue now',
  '',
  '╭──────────────────────────────────────────────────────────────────────────────╮',
  '│ >                                                                            │',
  '╰──────────────────────────────────────────────────────────────────────────────╯',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
  '',
].join('\n');

describe('usage-wall-rescue — E2E lifecycle', () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
  });

  async function boot(existingConfig: Record<string, unknown>, accounts: Array<[string, number]>) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wall-rescue-e2e-'));
    cleanups.push(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/usage-wall-rescue-lifecycle.test.ts:cleanup' }));

    // The update path: the shipped defaults land on an existing agent's config.
    applyDefaults(existingConfig, getMigrationDefaults('standalone'));
    const poolCfg = existingConfig.subscriptionPool as WallRescueConfigView;

    const pool = new SubscriptionPool({ stateDir: dir });
    for (const [id, util] of accounts) {
      pool.addFixture({ id, nickname: id, email: `${id}@example.test`, provider: 'anthropic', framework: 'claude-code', configHome: path.join(dir, `.claude-${id}`) });
      pool.update(id, { lastQuota: { sevenDay: { utilizationPct: util, resetsAt: new Date(Date.now() + 2 * 86_400_000).toISOString() }, measuredAt: new Date().toISOString() } });
    }
    const restarts: Array<{ sessionName: string; configHome: string; accountId: string }> = [];
    const noRoom: string[] = [];
    const notices: string[] = [];
    const scheduler = new QuotaAwareScheduler({
      listAccounts: () => pool.list(),
      refreshFn: async (o) => { restarts.push({ sessionName: o.sessionName, configHome: o.configHome, accountId: o.accountId }); return true; },
      onNoAlternate: (s) => { noRoom.push(s); },
    });
    const sessions = [{ tmuxSession: 'tg-7230', framework: 'claude-code' as const }]; // untagged
    const rescue = new UsageWallRescue({
      readConfig: () => poolCfg,
      listAccounts: () => pool.list(),
      getSession: (name) => sessions.find((s) => s.tmuxSession === name),
      configHomeForSession: () => undefined, // rides the default login
      resolveDefaultAccountId: async () => 'default-walled',
      swap: (a) => scheduler.onQuotaPressure(a),
      notifyUser: (_name, text) => { notices.push(text); },
    });
    await rescue.refreshDefaultAccount();

    const sessionManager = {
      listRunningSessions: vi.fn().mockReturnValue([]),
      captureOutput: vi.fn().mockReturnValue(WALLED_PANE),
      sendKey: vi.fn(),
      isSessionAlive: vi.fn().mockReturnValue(true),
    } as any;
    const watchdog = new SessionWatchdog({
      stateDir: dir,
      sessions: { tmuxPath: 'tmux' },
      monitoring: { watchdog: { enabled: true, stuckCommandSec: 180, pollIntervalMs: 30_000, rateLimitSettleMs: 0 } },
    } as any, sessionManager, {} as any);
    cleanups.push(() => watchdog.stop());
    // Wired exactly as server.ts does.
    const settled: Array<Promise<unknown>> = [];
    watchdog.on('usage-wall', (name: string) => { settled.push(rescue.onUsageWall(name)); });

    const app = express();
    app.use(express.json());
    app.use(createRoutes({
      config: { authToken: 't', stateDir: dir, port: 0 },
      startTime: new Date(),
      subscriptionPool: pool,
      quotaAwareScheduler: scheduler,
      usageWallRescue: rescue,
    } as any));
    const url = await new Promise<string>((resolve) => {
      const srv = app.listen(0, () => {
        cleanups.push(() => new Promise<void>((r) => srv.close(() => r())));
        resolve(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`);
      });
    });

    const pollTwice = async () => {
      watchdog.checkRateLimited('tg-7230'); // first sighting → settle clock
      watchdog.checkRateLimited('tg-7230'); // settled → usage-wall
      await Promise.all(settled);
    };
    return { rescue, restarts, noRoom, notices, url, pollTwice, poolCfg };
  }

  it('FEATURE ALIVE: an existing agent with no setting gets it ON, and the untagged walled session moves and continues', async () => {
    const b = await boot({ subscriptionPool: {} }, [['default-walled', 100], ['roomy', 10], ['mid', 47]]);
    expect(b.poolCfg.wallRescue).toEqual({ enabled: true });

    const status = await (await fetch(b.url + '/subscription-pool/wall-rescue')).json();
    expect(status).toMatchObject({ enabled: true, effective: true, usableAccounts: 3, defaultAccountId: 'default-walled' });

    // The standby tells the truth: the wall is seen on the current footer, and
    // because another account has room the wording is "being moved".
    expect(detectQuotaExhaustion(WALLED_PANE)).toContain('8am');
    expect(b.rescue.describeWall('tg-7230')).toMatch(/moved to another account/);

    await b.pollTwice();
    expect(b.restarts).toHaveLength(1);
    expect(b.restarts[0].sessionName).toBe('tg-7230');
    expect(['roomy', 'mid']).toContain(b.restarts[0].accountId);
    expect(b.noRoom).toEqual([]);
    expect(b.notices).toEqual([]); // moved: nothing to tell
  });

  it('an operator who set it false keeps it off: nothing moves', async () => {
    const b = await boot({ subscriptionPool: { wallRescue: { enabled: false } } }, [['default-walled', 100], ['roomy', 10]]);
    expect(b.poolCfg.wallRescue).toEqual({ enabled: false });
    await b.pollTwice();
    expect(b.restarts).toEqual([]);
  });

  it('a single-account agent is unchanged: nothing moves', async () => {
    const b = await boot({}, [['default-walled', 100]]);
    await b.pollTwice();
    expect(b.restarts).toEqual([]);
  });

  it('when no account has room the session is not moved and the no-room notice fires', async () => {
    const b = await boot({}, [['default-walled', 100], ['also-full', 96]]);
    expect(b.rescue.describeWall('tg-7230')).toBeNull(); // standard "paused until reset" notice stands
    await b.pollTwice();
    expect(b.restarts).toEqual([]);
    expect(b.noRoom).toEqual(['tg-7230']);
    // The conversation is told plainly, in words, with no ids or jargon.
    expect(b.notices).toHaveLength(1);
    expect(b.notices[0]).toMatch(/no other connected account has enough room right now/);
  });
});

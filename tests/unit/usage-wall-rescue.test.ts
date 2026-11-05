/**
 * usage-wall-rescue (docs/specs/usage-wall-rescue.md) — unit tier.
 *
 * Regression for 2026-11-04 (feedback fb-6e43a66a-75d + fb-d2862f4d-b52): two
 * Telegram sessions launched untagged on a default login at 100% weekly sat at
 * the usage wall with no swap and no notice, while the pool held accounts at
 * 10% and 47%. Covers: the wall signal (detection + settle + watchdog emit),
 * the standby notice on the CURRENT footer, the rescue's decisions (untagged
 * resolution, 2+ account condition, switches, dedupe), spawn tagging + the
 * walled-default guard, and the config/CLAUDE.md migration.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  detectUsageWall,
  evaluateUsageWallSettle,
  isPaneChromeLine,
  detectRateLimited,
} from '../../src/monitoring/rateLimitDetection.js';
import { detectQuotaExhaustion, PresenceProxy } from '../../src/monitoring/PresenceProxy.js';
import { SessionWatchdog } from '../../src/monitoring/SessionWatchdog.js';
import {
  UsageWallRescue,
  wallRescueEffective,
  WALL_NOTICE_NO_ROOM,
  WALL_NOTICE_GAVE_UP,
  WALL_NOTICE_MOVING,
  QUOTA_WALL_ALREADY_TOLD,
  type UsageWallRescueDeps,
  type WallRescueConfigView,
} from '../../src/core/UsageWallRescue.js';
import type { SubscriptionAccount } from '../../src/core/SubscriptionPool.js';
import { applyDefaults, getMigrationDefaults } from '../../src/config/ConfigDefaults.js';
import {
  rewriteUsageWallRescueAwareness,
  USAGE_WALL_RESCUE_OLD_CONTINUITY,
  USAGE_WALL_RESCUE_OLD_PROACTIVE,
} from '../../src/core/PostUpdateMigrator.js';

// The pane as Claude Code 2.1.300 rendered it on 2026-11-04 (the lines quoted
// in fb-d2862f4d-b52), with the input box and status line under the banner.
export const WALLED_PANE = [
  '⏺ I\'ll check the scheduler logs next.',
  '',
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
  '',
].join('\n');

// Same session after the window reset: real work below the old banner.
const RESUMED_PANE = [
  '  ⎿  Usage limit reached · limit resets 8am',
  '     Continuing automatically at 8am · esc to cancel · /usage-credits to continue now',
  '⏺ Continuing where I left off — the scheduler log shows two skipped runs.',
  '⏺ Read(src/scheduler/JobScheduler.ts)',
  '  ⎿  Read 120 lines',
  '✽ Pondering… (12s · ↓ 1.1k tokens)',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n');

const NOW = Date.parse('2026-11-04T17:00:00Z');

function acct(id: string, util: number | null, opts: Partial<SubscriptionAccount> = {}): SubscriptionAccount {
  return {
    id,
    nickname: id,
    email: `${id}@example.com`,
    provider: 'anthropic',
    framework: 'claude-code',
    configHome: `/h/.claude-${id}`,
    status: 'active',
    lastQuota: util === null ? null : { sevenDay: { utilizationPct: util, resetsAt: '2026-11-06T00:00:00Z' }, measuredAt: new Date(NOW - 5 * 60_000).toISOString() },
    ...opts,
  } as SubscriptionAccount;
}

// ── Detection ───────────────────────────────────────────────────────────────

describe('usage-wall detection', () => {
  it('reads the current footer as a live wall', () => {
    expect(detectUsageWall(WALLED_PANE)).toBe(true);
  });

  it('is not a server throttle (the throttle path stays out of it)', () => {
    expect(detectRateLimited(WALLED_PANE, 45)).toBe(false);
  });

  it('a session that resumed work past the banner is not walled', () => {
    expect(detectUsageWall(RESUMED_PANE)).toBe(false);
  });

  it('wall words quoted mid-line (grep output, a spec) are not a wall', () => {
    expect(detectUsageWall('src/x.ts:12:  // the banner reads "Usage limit reached · limit resets 8am"\n❯ ')).toBe(false);
    expect(detectUsageWall('⏺ The pane said: Usage limit reached · limit resets 8am\n❯ ')).toBe(false);
  });

  it('a retry spinner after the banner vetoes, even on a line that also carries chrome', () => {
    expect(detectUsageWall('  ⎿  Usage limit reached · limit resets 8am\n  Retrying in 10s · esc to cancel\n❯ ')).toBe(false);
  });

  it('the auto-continue row counts as chrome with any time phrase', () => {
    expect(isPaneChromeLine('     Continuing automatically at 8:00 AM · esc to cancel')).toBe(true);
    expect(isPaneChromeLine('Continuing automatically at Nov 6, 8am')).toBe(true);
  });

  it('real output that only starts like a chrome row is session output', () => {
    expect(detectUsageWall('  ⎿  Usage limit reached · limit resets 8am\n/upgrade completed successfully\n❯ ')).toBe(false);
    expect(detectUsageWall('  ⎿  Usage limit reached · limit resets 8am\nbypass permissions on the staging host were removed\n❯ ')).toBe(false);
  });

  it('prose that merely mentions chrome words after the banner is session output', () => {
    expect(detectUsageWall('  ⎿  Usage limit reached · limit resets 8am\n⏺ I reviewed how to upgrade your plan and the /extra-usage docs.\n❯ ')).toBe(false);
  });

  it('any session output after the banner means it is not a wall now', () => {
    expect(detectUsageWall('  ⎿  Usage limit reached · limit resets 8am\n⏺ Done — the fix is in.\n❯ ')).toBe(false);
  });

  it('a bare "resets 8am" in ordinary output is not a wall', () => {
    expect(detectUsageWall('⏺ The cron job resets 8am every day.\n❯ ')).toBe(false);
  });

  it('classifies footer furniture as chrome and real output as not', () => {
    expect(isPaneChromeLine('     Continuing automatically at 8am · esc to cancel · /usage-credits to continue now')).toBe(true);
    expect(isPaneChromeLine('  ⏵⏵ bypass permissions on (shift+tab to cycle)')).toBe(true);
    expect(isPaneChromeLine('│ >                                     │')).toBe(true);
    expect(isPaneChromeLine('╰────────────────╯')).toBe(true);
    expect(isPaneChromeLine('⏺ Read(src/scheduler/JobScheduler.ts)')).toBe(false);
  });

  it('settles only after the pane stays identical for the settle window', () => {
    const first = evaluateUsageWallSettle(WALLED_PANE, undefined, NOW, { settleMs: 20_000 });
    expect(first.decision).toBe('waiting');
    const early = evaluateUsageWallSettle(WALLED_PANE, first.next, NOW + 5_000, { settleMs: 20_000 });
    expect(early.decision).toBe('waiting');
    const settled = evaluateUsageWallSettle(WALLED_PANE, early.next, NOW + 20_000, { settleMs: 20_000 });
    expect(settled.decision).toBe('settled');
    expect(evaluateUsageWallSettle(RESUMED_PANE, settled.next, NOW + 25_000).decision).toBe('no-throttle');
  });
});

// ── Standby notice (fb-d2862f4d-b52 regression) ─────────────────────────────

describe('detectQuotaExhaustion on the current Claude Code footer', () => {
  it('detects the wall under the auto-continue line and status line, with the reset time', () => {
    const msg = detectQuotaExhaustion(WALLED_PANE);
    expect(msg).not.toBeNull();
    expect(msg).toContain('usage limit');
    expect(msg).toContain('8am');
  });

  it('still reports recovery when real work follows the banner', () => {
    expect(detectQuotaExhaustion(RESUMED_PANE)).toBeNull();
  });

  it('uses the rescue wording when another account has room, the standard notice otherwise', () => {
    const quotaWallMessage = (PresenceProxy.prototype as unknown as {
      quotaWallMessage: (this: unknown, s: string, snap: string) => string | null;
    }).quotaWallMessage;
    const moving = quotaWallMessage.call({ config: { describeQuotaWall: () => 'moving you' } }, 's', WALLED_PANE);
    expect(moving).toBe('moving you');
    const noRoom = quotaWallMessage.call({ config: { describeQuotaWall: () => null } }, 's', WALLED_PANE);
    expect(noRoom).toContain('paused until');
    const notWalled = quotaWallMessage.call({ config: { describeQuotaWall: () => 'moving you' } }, 's', RESUMED_PANE);
    expect(notWalled).toBeNull();
    // Already told directly → a distinct "say nothing" result (not null, which
    // would fall through to the generic standby, and not a string to send).
    const told = quotaWallMessage.call({ config: { describeQuotaWall: () => false } }, 's', WALLED_PANE);
    expect(told).not.toBeNull();
    expect(typeof told).toBe('symbol');
  });
});

// ── Watchdog signal ─────────────────────────────────────────────────────────

describe('SessionWatchdog usage-wall signal', () => {
  let watchdog: SessionWatchdog | undefined;
  afterEach(() => watchdog?.stop());

  function setup(pane: string | null) {
    const sm = {
      listRunningSessions: vi.fn().mockReturnValue([]),
      captureOutput: vi.fn().mockReturnValue(pane),
      sendKey: vi.fn(),
      isSessionAlive: vi.fn().mockReturnValue(true),
    } as any;
    const cfg = {
      stateDir: '/tmp/test-watchdog-usage-wall',
      sessions: { tmuxPath: 'tmux' },
      monitoring: { watchdog: { enabled: true, stuckCommandSec: 180, pollIntervalMs: 30_000, rateLimitSettleMs: 0 } },
    } as any;
    watchdog = new SessionWatchdog(cfg, sm, {} as any);
    const walls: string[] = [];
    const throttles: string[] = [];
    watchdog.on('usage-wall', (s: string) => walls.push(s));
    watchdog.on('rate-limited', (s: string) => throttles.push(s));
    return { walls, throttles, sm };
  }

  it('emits usage-wall (not rate-limited) once the walled pane settles, then holds a cooldown', () => {
    const { walls, throttles } = setup(WALLED_PANE);
    watchdog!.checkRateLimited('s1'); // waiting
    expect(walls).toEqual([]);
    watchdog!.checkRateLimited('s1'); // settled
    watchdog!.checkRateLimited('s1'); // cooldown
    expect(walls).toEqual(['s1']);
    expect(throttles).toEqual([]);
  });

  it('emits usage-wall-cleared once when a settled wall goes away', () => {
    const { sm } = setup(WALLED_PANE);
    const cleared: string[] = [];
    watchdog!.on('usage-wall-cleared', (s: string) => cleared.push(s));
    watchdog!.checkRateLimited('s1');
    watchdog!.checkRateLimited('s1'); // settled → usage-wall
    sm.captureOutput.mockReturnValue(RESUMED_PANE);
    watchdog!.checkRateLimited('s1');
    watchdog!.checkRateLimited('s1');
    expect(cleared).toEqual(['s1']);
  });

  it('stays quiet for a resumed session', () => {
    const { walls } = setup(RESUMED_PANE);
    watchdog!.checkRateLimited('s1');
    watchdog!.checkRateLimited('s1');
    expect(walls).toEqual([]);
  });
});

// ── The rescue ──────────────────────────────────────────────────────────────

function makeRescue(over: Partial<UsageWallRescueDeps> & { accounts?: SubscriptionAccount[]; cfg?: WallRescueConfigView; sessions?: Record<string, { subscriptionAccountId?: string | null; framework?: string }> } = {}) {
  const accounts = over.accounts ?? [acct('walled', 100), acct('roomy', 10), acct('mid', 47)];
  const sessions = over.sessions ?? { s1: {} };
  const swap = vi.fn(async (a: { exhaustedAccountId: string }) => ({
    swapped: true,
    toAccountId: accounts.find((x) => x.id !== a.exhaustedAccountId)!.id,
    reason: 'swapped-and-resumed',
  }));
  let now = NOW;
  const notices: Array<[string, string]> = [];
  const rescue = new UsageWallRescue({
    notifyUser: over.notifyUser ?? ((n, t) => { notices.push([n, t]); return true; }),
    readConfig: () => over.cfg ?? { wallRescue: { enabled: true } },
    listAccounts: () => accounts,
    getSession: (n) => sessions[n],
    configHomeForSession: over.configHomeForSession ?? (() => undefined),
    resolveDefaultAccountId: over.resolveDefaultAccountId ?? (async () => 'walled'),
    swap: over.swap ?? swap,
    now: () => now,
  });
  return { rescue, swap, accounts, notices, advance: (ms: number) => { now += ms; } };
}

describe('wallRescueEffective', () => {
  it('needs the switch on and 2+ usable accounts of the framework', () => {
    const two = [acct('a', 10), acct('b', 20)];
    expect(wallRescueEffective(undefined, two)).toBe(true); // missing = default on
    expect(wallRescueEffective({ wallRescue: { enabled: false } }, two)).toBe(false);
    expect(wallRescueEffective({ autoSwapOnRateLimit: false }, two)).toBe(false);
    expect(wallRescueEffective({}, [acct('a', 10)])).toBe(false);
    expect(wallRescueEffective({}, [])).toBe(false);
    expect(wallRescueEffective({}, [acct('a', 10), acct('b', 20, { status: 'needs-reauth' as SubscriptionAccount['status'] })])).toBe(false);
    expect(wallRescueEffective({}, [acct('a', 10), acct('c', 20, { framework: 'codex-cli' as SubscriptionAccount['framework'] })])).toBe(false);
  });
});

describe('UsageWallRescue.onUsageWall', () => {
  it('moves an UNTAGGED session off the default login it is actually on (the 2026-11-04 case)', async () => {
    const { rescue, swap } = makeRescue();
    expect(await rescue.onUsageWall('s1')).toBe('swapped');
    expect(swap).toHaveBeenCalledWith(expect.objectContaining({
      sessionName: 's1', exhaustedAccountId: 'walled', framework: 'claude-code', callerClass: 'reactive-swap', sourceWasUntagged: true,
    }));
  });

  it('prefers an explicit CLAUDE_CONFIG_DIR that matches a pool account over the default login', async () => {
    const accounts = [acct('walled', 100), acct('roomy', 10), acct('hot', 97)];
    const { rescue, swap } = makeRescue({ accounts, configHomeForSession: () => '/h/.claude-hot' });
    await rescue.onUsageWall('s1');
    expect(swap.mock.calls[0][0].exhaustedAccountId).toBe('hot');
  });

  it('uses the tag when the session has one', async () => {
    const accounts = [acct('walled', 100), acct('roomy', 10), acct('hot', 97)];
    const { rescue, swap } = makeRescue({ accounts, sessions: { s1: { subscriptionAccountId: 'hot' } } });
    await rescue.onUsageWall('s1');
    expect(swap.mock.calls[0][0].exhaustedAccountId).toBe('hot');
    expect(swap.mock.calls[0][0].sourceWasUntagged).toBe(false);
  });

  it('an explicit config home that matches no pool account is unresolved, never the default login', async () => {
    const { rescue, swap } = makeRescue({ configHomeForSession: () => '/somewhere/else' });
    expect(await rescue.onUsageWall('s1')).toBe('unresolved-account');
    expect(swap).not.toHaveBeenCalled();
  });

  it('a reset time already in the past does not hold the move', async () => {
    const past = acct('walled', 100, { lastQuota: { sevenDay: { utilizationPct: 100, resetsAt: new Date(NOW - 60_000).toISOString() }, measuredAt: new Date(NOW).toISOString() } });
    const { rescue } = makeRescue({ accounts: [past, acct('roomy', 10)] });
    expect(await rescue.onUsageWall('s1')).toBe('swapped');
  });

  it('a stale full reading whose window already reset is not "known walled"', () => {
    const old = acct('walled', 100, { lastQuota: { sevenDay: { utilizationPct: 100, resetsAt: new Date(NOW - 60_000).toISOString() }, measuredAt: new Date(NOW - 5 * 60 * 60_000).toISOString() } });
    const { rescue } = makeRescue({ accounts: [old, acct('roomy', 10)] });
    expect(rescue.isKnownWalled('walled')).toBe(false);
  });

  it('holds (never guesses) when the account cannot be resolved', async () => {
    const { rescue, swap } = makeRescue({ resolveDefaultAccountId: async () => null });
    expect(await rescue.onUsageWall('s1')).toBe('unresolved-account');
    expect(swap).not.toHaveBeenCalled();
  });

  it('does nothing with fewer than 2 usable accounts, or when switched off', async () => {
    const one = makeRescue({ accounts: [acct('walled', 100)] });
    expect(await one.rescue.onUsageWall('s1')).toBe('disabled');
    expect(one.swap).not.toHaveBeenCalled();
    const off = makeRescue({ cfg: { wallRescue: { enabled: false } } });
    expect(await off.rescue.onUsageWall('s1')).toBe('disabled');
    const legacyOff = makeRescue({ cfg: { autoSwapOnRateLimit: false } });
    expect(await legacyOff.rescue.onUsageWall('s1')).toBe('disabled');
  });

  it('no room: tells the conversation plainly, once per episode, and does not count it as a failure', async () => {
    const { rescue, notices, advance } = makeRescue({
      swap: async () => ({ swapped: false, toAccountId: null, reason: 'no-eligible-alternate' }),
    });
    expect(await rescue.onUsageWall('s1')).toBe('no-room');
    expect(notices).toEqual([['s1', WALL_NOTICE_NO_ROOM]]);
    for (let i = 0; i < 8; i++) { advance(10 * 60_000); expect(await rescue.onUsageWall('s1')).toBe('no-room'); }
    expect(notices).toHaveLength(1);       // no repeat inside 6h; never breaker-open
  });

  it('holds when the account\'s own fresh reading contradicts the banner', async () => {
    const accounts = [acct('walled', 100), acct('roomy', 10), acct('mid', 47)];
    const { rescue, swap } = makeRescue({ accounts, sessions: { s1: { subscriptionAccountId: 'mid' } } });
    expect(await rescue.onUsageWall('s1')).toBe('source-not-walled');
    expect(swap).not.toHaveBeenCalled();
  });

  it('a healthy reading on a DEFAULT-SLOT candidate does not veto (identity unproven); the move proceeds', async () => {
    // The default slot now holds a healthy account; the session may still be on the walled one.
    const { rescue, swap } = makeRescue({ resolveDefaultAccountId: async () => 'mid' });
    expect(await rescue.onUsageWall('s1')).toBe('swapped');
    // Not blamed (never recorded as walled), but still excluded as a target so
    // the session cannot be "moved" back onto the account it may be on.
    expect(swap.mock.calls[0][0]).toMatchObject({ exhaustedAccountId: 'mid', sourceWasUntagged: true });
    expect(rescue.isKnownWalled('mid')).toBe(false);
  });

  it('an error while checking (not while moving) is a hold, never a failed move', async () => {
    const { rescue, swap } = makeRescue({ resolveDefaultAccountId: async () => { throw new Error('keychain locked'); } });
    expect(await rescue.onUsageWall('s1')).toBe('unresolved-account');
    expect(swap).not.toHaveBeenCalled();
  });

  it('waits when the window actually blocking service resets soon, even if another window is pressured longer', async () => {
    const mixed = acct('walled', 100, { lastQuota: {
      fiveHour: { utilizationPct: 100, resetsAt: new Date(NOW + 5 * 60_000).toISOString() },
      sevenDay: { utilizationPct: 95, resetsAt: new Date(NOW + 20 * 60 * 60_000).toISOString() },
      measuredAt: new Date(NOW).toISOString() } });
    const { rescue } = makeRescue({ accounts: [mixed, acct('roomy', 10)], sessions: { s1: { subscriptionAccountId: 'walled' } } });
    expect(await rescue.onUsageWall('s1')).toBe('resets-soon');
    // An unproven default-slot candidate's reset time never holds the session.
    const cand = makeRescue({ accounts: [mixed, acct('roomy', 10)] });
    expect(await cand.rescue.onUsageWall('s1')).toBe('swapped');
  });

  it('a stale or absent reading does not veto the settled banner', async () => {
    const stale = acct('walled', 40, { lastQuota: { sevenDay: { utilizationPct: 40, resetsAt: '2026-11-06T00:00:00Z' }, measuredAt: new Date(NOW - 3 * 60 * 60_000).toISOString() } });
    const { rescue } = makeRescue({ accounts: [stale, acct('roomy', 10)] });
    expect(await rescue.onUsageWall('s1')).toBe('swapped');
  });

  it('does not restart a session whose walled window resets within 15 minutes', async () => {
    const soon = acct('walled', 100, { lastQuota: { fiveHour: { utilizationPct: 100, resetsAt: new Date(NOW + 10 * 60_000).toISOString() }, measuredAt: new Date(NOW).toISOString() } });
    const { rescue, swap } = makeRescue({ accounts: [soon, acct('roomy', 10)], sessions: { s1: { subscriptionAccountId: 'walled' } } });
    expect(await rescue.onUsageWall('s1')).toBe('resets-soon');
    expect(swap).not.toHaveBeenCalled();
  });

  it('untagged codex sessions are out of scope (disabled, not a failure)', async () => {
    const { rescue, swap } = makeRescue({ sessions: { s1: { framework: 'codex-cli' } } });
    expect(await rescue.onUsageWall('s1')).toBe('disabled');
    expect(swap).not.toHaveBeenCalled();
  });

  it('throttle escalations move a session only under an explicit autoSwapOnRateLimit:true', async () => {
    const dflt = makeRescue();
    expect(await dflt.rescue.onThrottleEscalated('s1')).toBe('disabled');
    const optIn = makeRescue({ cfg: { autoSwapOnRateLimit: true } });
    expect(await optIn.rescue.onThrottleEscalated('s1')).toBe('swapped');
  });

  it('dedupes a concurrent trigger and backs off before retrying', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const swap = vi.fn(async () => { await gate; return { swapped: false, toAccountId: 'roomy', reason: 'refresh-failed' }; });
    const { rescue, advance } = makeRescue({ swap });
    const first = rescue.onUsageWall('s1');
    expect(await rescue.onUsageWall('s1')).toBe('in-flight');
    release();
    expect(await first).toBe('failed');
    expect(await rescue.onUsageWall('s1')).toBe('cooling-down');
    advance(10 * 60_000);
    await rescue.onUsageWall('s1');
    expect(swap).toHaveBeenCalledTimes(2);
  });

  it('doubles the back-off per failed move, opens a breaker after 5, and tells the user once', async () => {
    const swap = vi.fn(async () => ({ swapped: false, toAccountId: 'roomy', reason: 'refresh-failed' }));
    const farReset = acct('walled', 100, { lastQuota: { sevenDay: { utilizationPct: 100, resetsAt: '2026-11-20T00:00:00Z' }, measuredAt: new Date(NOW).toISOString() } });
    const { rescue, advance, notices } = makeRescue({ swap, accounts: [farReset, acct('roomy', 10)] });
    expect(await rescue.onUsageWall('s1')).toBe('failed');       // 1 → wait 10m
    advance(10 * 60_000);
    expect(await rescue.onUsageWall('s1')).toBe('failed');       // 2 → wait 20m
    advance(10 * 60_000);
    expect(await rescue.onUsageWall('s1')).toBe('cooling-down');
    advance(10 * 60_000);
    expect(await rescue.onUsageWall('s1')).toBe('failed');       // 3 → 40m
    advance(40 * 60_000);
    expect(await rescue.onUsageWall('s1')).toBe('failed');       // 4 → 80m
    advance(80 * 60_000);
    expect(notices).toEqual([]);
    expect(await rescue.onUsageWall('s1')).toBe('failed');       // 5 → breaker
    expect(notices).toEqual([['s1', WALL_NOTICE_GAVE_UP]]);
    advance(6 * 60 * 60_000);
    expect(await rescue.onUsageWall('s1')).toBe('breaker-open');
    expect(swap).toHaveBeenCalledTimes(5);
    advance(24 * 60 * 60_000);
    expect(await rescue.onUsageWall('s1')).toBe('failed');       // one probe after the hold
  });

  it('caps move attempts per machine per hour', async () => {
    const sessions: Record<string, object> = {};
    for (let i = 0; i < 14; i++) sessions[`s${i}`] = {};
    const { rescue, swap, advance } = makeRescue({ sessions });
    const outcomes: string[] = [];
    for (let i = 0; i < 14; i++) outcomes.push(await rescue.onUsageWall(`s${i}`));
    expect(outcomes.filter((o) => o === 'swapped')).toHaveLength(12);
    expect(outcomes.slice(12)).toEqual(['rate-capped', 'rate-capped']);
    expect(swap).toHaveBeenCalledTimes(12);
    advance(60 * 60_000);
    expect(await rescue.onUsageWall('s13')).toBe('swapped');
  });

  it('never throws when the swap throws', async () => {
    const { rescue } = makeRescue({ swap: async () => { throw new Error('boom'); } });
    expect(await rescue.onUsageWall('s1')).toBe('failed');
  });

  it('unknown session is a no-op', async () => {
    const { rescue, swap } = makeRescue();
    expect(await rescue.onUsageWall('nope')).toBe('unknown-session');
    expect(swap).not.toHaveBeenCalled();
  });
});

describe('UsageWallRescue.spawnAccount (tagging + walled-default guard)', () => {
  it('tags every spawn with the best account when the pool has 2+ usable accounts', () => {
    const { rescue } = makeRescue();
    const pick = rescue.spawnAccount();
    expect(pick?.accountId).toBe('roomy');
    expect(pick?.configHome).toBe('/h/.claude-roomy');
  });

  it('never tags onto an account without a fresh reading (a working login is not proven)', () => {
    const unread = acct('unread', null);
    const stale = acct('stale', 5, { lastQuota: { sevenDay: { utilizationPct: 5, resetsAt: '2026-11-06T00:00:00Z' }, measuredAt: new Date(NOW - 3 * 60 * 60_000).toISOString() } });
    const { rescue } = makeRescue({ accounts: [acct('walled', 100), unread, stale, acct('mid', 47)] });
    expect(rescue.spawnAccount()?.accountId).toBe('mid');
    const none = makeRescue({ accounts: [unread, stale] });
    expect(none.rescue.spawnAccount()).toBeNull();
  });

  it('leaves the default login alone with 0 or 1 usable accounts', () => {
    expect(makeRescue({ accounts: [acct('only', 10)] }).rescue.spawnAccount()).toBeNull();
    expect(makeRescue({ accounts: [] }).rescue.spawnAccount()).toBeNull();
  });

  it('with pinning explicitly off, still refuses a default login the pool knows is walled', async () => {
    const { rescue } = makeRescue({ cfg: { pinSessionsToPool: false } });
    expect(rescue.spawnAccount()).toBeNull(); // default not resolved yet → unknown → no action
    await rescue.refreshDefaultAccount();
    expect(rescue.spawnAccount()?.accountId).toBe('roomy');
  });

  it('with pinning explicitly off, a healthy default login is used as before', async () => {
    const { rescue } = makeRescue({ cfg: { pinSessionsToPool: false }, resolveDefaultAccountId: async () => 'mid' });
    await rescue.refreshDefaultAccount();
    expect(rescue.spawnAccount()).toBeNull();
  });

  it('switched off → the default login, exactly as before', () => {
    expect(makeRescue({ cfg: { wallRescue: { enabled: false } } }).rescue.spawnAccount()).toBeNull();
  });
});

describe('UsageWallRescue.describeWall', () => {
  it('says the session is being moved when another account has room', async () => {
    const { rescue } = makeRescue();
    await rescue.refreshDefaultAccount();
    expect(rescue.describeWall('s1')).toBe(WALL_NOTICE_MOVING);
  });

  it('never promises a move after a failed one', async () => {
    const { rescue } = makeRescue({ swap: async () => ({ swapped: false, toAccountId: 'roomy', reason: 'refresh-failed' }) });
    await rescue.refreshDefaultAccount();
    expect(rescue.describeWall('s1')).toBe(WALL_NOTICE_MOVING);
    await rescue.onUsageWall('s1');
    expect(rescue.describeWall('s1')).toBeNull();
  });

  it('speaks from the last real check: held → standard notice, no room → the no-room words', async () => {
    const held = makeRescue({ accounts: [acct('walled', 100), acct('roomy', 10), acct('mid', 47)], sessions: { s1: { subscriptionAccountId: 'mid' } } });
    expect(held.rescue.describeWall('s1')).toBeNull();          // the fresh 47% reading contradicts the wall
    const full = makeRescue({ swap: async () => ({ swapped: false, toAccountId: null, reason: 'no-eligible-alternate' }) });
    await full.rescue.refreshDefaultAccount();
    await full.rescue.onUsageWall('s1');
    await new Promise((r) => setTimeout(r, 0)); // delivery confirmation settles
    // Already told directly → the standby says nothing more (no duplicate).
    expect(full.rescue.describeWall('s1')).toBe(QUOTA_WALL_ALREADY_TOLD);
    // An outcome older than the current wall episode is not reused: the live
    // admission decides again (here the pool shows room, so a move is due).
    full.advance(25 * 60_000);
    expect(full.rescue.describeWall('s1')).toBe(WALL_NOTICE_MOVING);
  });

  it('a direct notice that was not delivered never silences the standby', async () => {
    const failing = makeRescue({
      swap: async () => ({ swapped: false, toAccountId: null, reason: 'no-eligible-alternate' }),
      notifyUser: async () => false,
    });
    await failing.rescue.refreshDefaultAccount();
    await failing.rescue.onUsageWall('s1');
    await new Promise((r) => setTimeout(r, 0));
    expect(failing.rescue.describeWall('s1')).toBe(WALL_NOTICE_NO_ROOM);
  });

  it('a no-room check does not use up the hourly move budget', async () => {
    const sessions: Record<string, object> = {};
    for (let i = 0; i < 14; i++) sessions[`s${i}`] = {};
    const { rescue } = makeRescue({ sessions, swap: async () => ({ swapped: false, toAccountId: null, reason: 'no-eligible-alternate' }) });
    for (let i = 0; i < 14; i++) expect(await rescue.onUsageWall(`s${i}`)).toBe('no-room');
    expect(rescue.status().movesLastHour).toBe(0);
  });

  it('no restart loop: the default candidate stays excluded, and wording agrees with the move', async () => {
    // The session may be on 'candidate' (a reading taken before the wall says
    // 10%). Moving it "back" onto candidate would count as success and loop.
    const accounts = [acct('candidate', 10), acct('full', 99)];
    const { rescue, swap } = makeRescue({ accounts, resolveDefaultAccountId: async () => 'candidate' });
    await rescue.refreshDefaultAccount();
    expect(rescue.describeWall('s1')).toBeNull();   // nothing else has room → standard notice
    await rescue.onUsageWall('s1');
    expect(swap.mock.calls[0][0].exhaustedAccountId).toBe('candidate');
  });

  it('a cleared wall ends the episode: an earlier no-room outcome no longer speaks', async () => {
    const full = makeRescue({ swap: async () => ({ swapped: false, toAccountId: null, reason: 'no-eligible-alternate' }) });
    await full.rescue.refreshDefaultAccount();
    await full.rescue.onUsageWall('s1');
    await new Promise((r) => setTimeout(r, 0));
    expect(full.rescue.describeWall('s1')).toBe(QUOTA_WALL_ALREADY_TOLD);
    full.rescue.onWallCleared('s1');
    expect(full.rescue.describeWall('s1')).toBe(WALL_NOTICE_MOVING);
  });

  it('does not promise a move while the session\'s account is unknown', () => {
    const { rescue } = makeRescue();               // default never resolved
    expect(rescue.describeWall('s1')).toBeNull();
  });

  it('returns null (standard notice) when no other account has room', async () => {
    const { rescue } = makeRescue({ accounts: [acct('walled', 100), acct('also', 99)] });
    await rescue.refreshDefaultAccount();
    expect(rescue.describeWall('s1')).toBeNull();
  });
});

// ── Migration parity ───────────────────────────────────────────────────────

describe('migration', () => {
  it('adds subscriptionPool.wallRescue.enabled=true where missing and keeps an explicit false', () => {
    const missing: Record<string, unknown> = { subscriptionPool: { swapSoftThresholdPct: 85 } };
    applyDefaults(missing, getMigrationDefaults('standalone' as never));
    expect((missing.subscriptionPool as any).wallRescue).toEqual({ enabled: true });
    expect((missing.subscriptionPool as any).swapSoftThresholdPct).toBe(85);

    const optedOut: Record<string, unknown> = { subscriptionPool: { wallRescue: { enabled: false } } };
    applyDefaults(optedOut, getMigrationDefaults('standalone' as never));
    expect((optedOut.subscriptionPool as any).wallRescue.enabled).toBe(false);
  });

  it('rewrites the two stale CLAUDE.md sentences once, idempotently', () => {
    const before = `- **Continuity guarantee** — x. ${USAGE_WALL_RESCUE_OLD_CONTINUITY}\n- **Pre-limit (proactive) swap** — y. ${USAGE_WALL_RESCUE_OLD_PROACTIVE} Opt-in.`;
    const once = rewriteUsageWallRescueAwareness(before);
    expect(once.changed).toBe(true);
    expect(once.content).toContain('Usage-wall rescue is ON by default');
    expect(once.content).toContain('It does NOT move untagged sessions');
    expect(once.content).not.toContain('It also covers the UNTAGGED');
    const twice = rewriteUsageWallRescueAwareness(once.content);
    expect(twice.changed).toBe(false);
  });
});

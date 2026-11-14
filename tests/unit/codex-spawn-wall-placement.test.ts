/**
 * Codex spawn placement at the wall — unit tier (fb-39e55b95-f00, fb-fb4d0e68-3a2).
 *
 * 2026-11-12, Mama PC: POST /sessions/spawn with framework codex-cli launched
 * five sessions on codex-sagemindai, which the pool read at weekly 100%
 * (resetsAt 2026-11-14T18:01Z). Each died at its first turn with the Codex
 * usage-limit error while other Codex accounts read 30, 34 and 62%. The
 * headless lane only asked the pool for an account when the framework was
 * claude-code, so a Codex spawn rode the default CODEX_HOME login untagged.
 *
 * Covers UsageWallRescue.codexSpawnAccount (both sides of every boundary),
 * the refusal classification, and the reap-log account field.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UsageWallRescue, type WallRescueConfigView } from '../../src/core/UsageWallRescue.js';
import type { SubscriptionAccount } from '../../src/core/SubscriptionPool.js';
import { classifySpawnRefusal, classifySpawnRefusalMessage } from '../../src/core/heavyWorkPlacement.js';
import { ReapLog } from '../../src/monitoring/ReapLog.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const NOW = Date.parse('2026-11-12T23:58:00Z');
const WEEKLY_RESET = '2026-11-14T18:01:00Z';

function codex(id: string, weekly: number | null, opts: { fiveHour?: number; measuredAgoMs?: number; resetsAt?: string; framework?: 'codex-cli' | 'claude-code'; status?: string } = {}): SubscriptionAccount {
  return {
    id,
    nickname: id,
    email: `${id}@example.com`,
    provider: 'openai',
    framework: opts.framework ?? 'codex-cli',
    configHome: `/h/.codex-${id}`,
    status: opts.status ?? 'active',
    lastQuota: weekly === null ? null : {
      sevenDay: { utilizationPct: weekly, resetsAt: opts.resetsAt ?? WEEKLY_RESET },
      ...(opts.fiveHour !== undefined ? { fiveHour: { utilizationPct: opts.fiveHour, resetsAt: '2026-11-13T03:00:00Z' } } : {}),
      measuredAt: new Date(NOW - (opts.measuredAgoMs ?? 5 * 60_000)).toISOString(),
    },
  } as SubscriptionAccount;
}

function rescueWith(accounts: SubscriptionAccount[], cfg: WallRescueConfigView = { wallRescue: { enabled: true } }, nowMs = NOW) {
  return new UsageWallRescue({
    readConfig: () => cfg,
    listAccounts: () => accounts,
    getSession: () => undefined,
    configHomeForSession: () => undefined,
    resolveDefaultAccountId: async () => null,
    swap: async () => ({ swapped: false, toAccountId: null, reason: 'unused' }),
    now: () => nowMs,
  });
}

// The Mama PC pool on 2026-11-12 (fb-39e55b95-f00 lists 28/32/61/90/100).
const MAMA_POOL = () => [
  codex('codex-sagemindai', 100),
  codex('codex-dawn-sagemind', 62),
  codex('codex-a', 30),
  codex('codex-b', 34),
  codex('codex-c', 90),
];

describe('UsageWallRescue.codexSpawnAccount', () => {
  it('the incident pool: never the 100% account; the coolest account with room', () => {
    const pick = rescueWith(MAMA_POOL()).codexSpawnAccount();
    expect(pick).toEqual({ configHome: '/h/.codex-codex-a', accountId: 'codex-a' });
  });

  it('a weekly reading of exactly 100 is walled until resetsAt, even when the reading is old', () => {
    const stale = 3 * 86_400_000;
    const pick = rescueWith([codex('walled', 100, { measuredAgoMs: stale }), codex('room', 50)]).codexSpawnAccount();
    expect(pick && 'accountId' in pick ? pick.accountId : null).toBe('room');
  });

  it('a stale 100% reading whose window already reset is no longer walled: not refused, default login', () => {
    expect(rescueWith([codex('was-walled', 100, { measuredAgoMs: 3 * 86_400_000, resetsAt: '2026-11-12T00:00:00Z' })]).codexSpawnAccount()).toBeNull();
  });

  it('99% weekly is not the wall: not refused', () => {
    expect(rescueWith([codex('near', 99)]).codexSpawnAccount()).toBeNull();
  });

  it('the five-hour window at 100% walls the account too', () => {
    const pick = rescueWith([codex('five-walled', 10, { fiveHour: 100 }), codex('ok', 40)]).codexSpawnAccount();
    expect(pick && 'accountId' in pick ? pick.accountId : null).toBe('ok');
  });

  it('every Codex account at its wall → a plain refusal naming the soonest reset', () => {
    const r = rescueWith([codex('a', 100), codex('b', 100, { resetsAt: '2026-11-13T10:00:00Z' })]).codexSpawnAccount();
    expect(r).toEqual({
      refused: 'codex-accounts-walled: every Codex account on this machine is at its usage limit, so the session was not started. The soonest limit resets at 2026-11-13T10:00:00.000Z.',
    });
  });

  it('a single Codex account at its wall is refused too (launching would die at the first turn)', () => {
    const r = rescueWith([codex('only', 100)]).codexSpawnAccount();
    expect(r && 'refused' in r).toBe(true);
  });

  it('no Codex accounts in the pool → null: the default login, exactly as before', () => {
    expect(rescueWith([]).codexSpawnAccount()).toBeNull();
    expect(rescueWith([codex('claude-only', 100, { framework: 'claude-code' })]).codexSpawnAccount()).toBeNull();
  });

  it('the rescue switch off → null (operator choice honored)', () => {
    expect(rescueWith(MAMA_POOL(), { wallRescue: { enabled: false } }).codexSpawnAccount()).toBeNull();
    expect(rescueWith(MAMA_POOL(), { autoSwapOnRateLimit: false }).codexSpawnAccount()).toBeNull();
  });

  it('pinning explicitly off: default login unless some Codex account is walled', () => {
    expect(rescueWith([codex('a', 30), codex('b', 60)], { pinSessionsToPool: false }).codexSpawnAccount()).toBeNull();
    const guarded = rescueWith(MAMA_POOL(), { pinSessionsToPool: false }).codexSpawnAccount();
    expect(guarded && 'accountId' in guarded ? guarded.accountId : null).toBe('codex-a');
  });

  it('mirrors the Claude rule: only a fresh reading under the soft threshold is picked; otherwise the default login', () => {
    // An unread account may be an expired login; a pressured one is about to wall; a stale one is unproven.
    expect(rescueWith([codex('walled', 100), codex('unread', null)]).codexSpawnAccount()).toBeNull();
    expect(rescueWith([codex('walled', 100), codex('hot', 95)]).codexSpawnAccount()).toBeNull();
    expect(rescueWith([codex('walled', 100), codex('stale', 20, { measuredAgoMs: 2 * 3_600_000 })]).codexSpawnAccount()).toBeNull();
  });

  it('nothing walled: 2+ usable accounts tag the coolest (rescue effective); a single account keeps the default login', () => {
    expect(rescueWith([codex('a', 60), codex('b', 30)]).codexSpawnAccount()).toEqual({ configHome: '/h/.codex-b', accountId: 'b' });
    expect(rescueWith([codex('only', 30)]).codexSpawnAccount()).toBeNull();
  });
});

describe('codex-accounts-walled spawn refusal classification', () => {
  it('is a definite refusal by code and by message', () => {
    const err = Object.assign(new Error('codex-accounts-walled: every Codex account on this machine is at its usage limit, so the session was not started.'), { code: 'codex-accounts-walled' });
    expect(classifySpawnRefusal(err)).toBe('codex-accounts-walled');
    expect(classifySpawnRefusal(new Error(err.message))).toBe('codex-accounts-walled');
    expect(classifySpawnRefusalMessage('Codex hit codex-accounts-walled somewhere')).toBeNull();
  });
});

describe('ReapLog exited rows name the launch account', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reap-log-account-'));
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/codex-spawn-wall-placement.test.ts:cleanup' });
  });

  it('round-trips subscriptionAccountId, and omits it for an untagged session', () => {
    const log = new ReapLog(path.join(dir, 'state'), () => 'm_test');
    log.recordExited({ session: 'b1', tmuxSession: 'echo-b1', reason: 'process-exited-during-startup', framework: 'codex-cli', subscriptionAccountId: 'codex-a', exitCode: 1, midWork: true, outcome: 'stopped-mid-work' });
    log.recordExited({ session: 'b2', tmuxSession: 'echo-b2', reason: 'process-exited', outcome: 'completed' });
    const rows = log.read();
    expect(rows.find((r) => r.session === 'b1')?.subscriptionAccountId).toBe('codex-a');
    expect(rows.find((r) => r.session === 'b2')?.subscriptionAccountId).toBeUndefined();
  });
});

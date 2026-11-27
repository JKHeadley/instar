// safe-fs-allow: temp fixture cleanup uses SafeFsExecutor.
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ManualQuotaBalance, selectManualBalanceTarget, type BalanceSession } from '../../src/core/ManualQuotaBalance.js';
import { QuotaAwareScheduler } from '../../src/core/QuotaAwareScheduler.js';
import type { SubscriptionAccount } from '../../src/core/SubscriptionPool.js';
import { identityKey, type LoginSummary } from '../../src/monitoring/quotaPacing.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
const now = Date.parse('2026-11-23T23:00:00Z');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'manual balance test cleanup' }); });
function account(id: string): SubscriptionAccount {
  return { id, nickname: id, email: `${id}@example.test`, framework: 'codex-cli', provider: 'openai', status: 'active', configHome: `/local/${id}`,
    lastQuota: { measuredAt: new Date(now).toISOString(), windowsListed: ['sevenDay'], sevenDay: { utilizationPct: 11, resetsAt: new Date(now + 60 * 3_600_000).toISOString() } } } as SubscriptionAccount;
}
function summary(id: string, central = 20): LoginSummary {
  return { accountId: id, identity: identityKey('openai', `${id}@example.test`), framework: 'codex-cli', provider: 'openai', fresh: true, sourceKind: 'live', newestMeasuredAt: new Date(now).toISOString(),
    sevenDay: { central, hoursLeft: 60, resetsAt: new Date(now + 60 * 3_600_000).toISOString() } } as LoginSummary;
}
const session = (id: string, accountId = 'source'): BalanceSession => ({ id, tmuxSession: `topic-${id}`, framework: 'codex-cli', subscriptionAccountId: accountId, status: 'running' });
const choose = (accounts: SubscriptionAccount[], summaries: LoginSummary[], sessions: BalanceSession[] = []) => selectManualBalanceTarget(accounts, summaries, sessions, 'source', now, 90, () => true);

function freshReset(id: string, hoursLeft = 166) {
  const local = account(id);
  const resetsAt = new Date(now + hoursLeft * 3_600_000).toISOString();
  local.lastQuota!.source = 'codex-app-server';
  local.lastQuota!.sevenDay = { utilizationPct: 0, resetsAt };
  const forecast = summary(id);
  forecast.sevenDay = {
    ...forecast.sevenDay!, used: 0, central: null, hoursLeft, resetsAt, reason: 'not-enough-readings',
  };
  return { local, forecast };
}

describe('manual unused-quota selection', () => {
  it('selects forecast pace gap per occupied session, not reset-first or the fixed first account', () => {
    const a = account('amrch'); const b = account('sagemindai');
    expect(choose([a, b], [summary('amrch'), summary('sagemindai', 30)])?.accountId).toBe('amrch');
    expect(choose([a, b], [summary('amrch'), summary('sagemindai', 30)], [session('busy', 'amrch')])?.accountId).toBe('sagemindai');
  });
  it('uses verified fresh resets, favoring more remaining hours and fewer assigned sessions', () => {
    const earlier = freshReset('earlier', 163);
    const later = freshReset('later', 166);
    const candidates = [account('source'), earlier.local, later.local, account('warm')];
    const readings = [earlier.forecast, later.forecast, summary('warm')];
    expect(choose(candidates, readings)?.accountId).toBe('later');
    expect(choose(candidates, readings, [session('assigned', 'later')])?.accountId).toBe('earlier');
  });
  it('spreads successive moves between a fresh reset and an eligible forecast-backed account', () => {
    const fresh = freshReset('fresh');
    const candidates = [account('source'), fresh.local, account('warm')];
    const readings = [fresh.forecast, summary('warm')];
    const running = Array.from({ length: 8 }, (_, index) => session(String(index)));
    const targets = running.map(current => {
      const target = choose(candidates, readings, running)?.accountId;
      current.subscriptionAccountId = target;
      return target;
    });
    expect(targets).toEqual(['fresh', 'warm', 'fresh', 'warm', 'fresh', 'warm', 'fresh', 'warm']);
  });
  it.each(['weekly-use-began', 'short-window-full'])('chooses a forecast-backed target when fresh eligibility ends (%s)', reason => {
    const fresh = freshReset('fresh');
    if (reason === 'weekly-use-began') {
      fresh.local.lastQuota!.sevenDay!.utilizationPct = 1;
      fresh.forecast.sevenDay!.used = 1;
    } else {
      fresh.local.lastQuota!.windowsListed = ['fiveHour', 'sevenDay'];
      fresh.local.lastQuota!.fiveHour = { utilizationPct: 100, resetsAt: new Date(now + 3_600_000).toISOString() };
    }
    expect(choose([account('source'), fresh.local, account('warm')], [fresh.forecast, summary('warm')])?.accountId).toBe('warm');
  });
  it.each(['rollout-source', 'older-window', 'future-window', 'old-reading', 'nonzero', 'unexpected-short-window', 'invalid-reason'])(
    'requires fresh and corroborated zero usage even when the forecast is warming up (%s)', reason => {
      const { local, forecast } = freshReset('target', reason === 'older-window' ? 150 : reason === 'future-window' ? 169 : 166);
      if (reason === 'rollout-source') local.lastQuota!.source = 'codex-rollout';
      if (reason === 'old-reading') local.lastQuota!.measuredAt = new Date(now - 3 * 3_600_000).toISOString();
      if (reason === 'nonzero') local.lastQuota!.sevenDay!.utilizationPct = 1;
      if (reason === 'unexpected-short-window') local.lastQuota!.windowsListed = undefined;
      if (reason === 'invalid-reason') forecast.sevenDay!.reason = 'window-invalid';
      expect(choose([account('source'), local], [forecast])).toBeNull();
    },
  );
  it('does not use newer account-wide history to qualify a weekly reading before the agreed reset boundary', () => {
    const { local, forecast } = freshReset('target', 167.95);
    const localReset = Date.parse(local.lastQuota!.sevenDay!.resetsAt!);
    local.lastQuota!.measuredAt = new Date(now - 2 * 60_000).toISOString();
    forecast.sevenDay!.resetsAt = new Date(localReset + 2 * 60_000).toISOString();
    expect(choose([account('source'), local], [forecast])).toBeNull();
  });
  it.each(['no-forecast','wrong-identity','stale','future','drifted','full','five-unknown','no-local','unknown-central','no-gap','old-reset','duplicate'])('refuses %s instead of falling back', reason => {
    const a = account('amrch'); const f = summary('amrch'); let forecasts = [f];
    if (reason === 'no-forecast') forecasts = [];
    if (reason === 'wrong-identity') f.identity = identityKey('openai', 'other@example.test');
    if (reason === 'stale') f.newestMeasuredAt = new Date(now - 3_600_000).toISOString();
    if (reason === 'future') a.lastQuota!.measuredAt = new Date(now + 1).toISOString();
    if (reason === 'drifted') a.identityDrifted = true;
    if (reason === 'full') a.lastQuota!.sevenDay!.utilizationPct = 100;
    if (reason === 'five-unknown') a.lastQuota!.windowsListed = undefined;
    if (reason === 'no-local') a.configHome = '';
    if (reason === 'unknown-central') f.sevenDay!.central = null;
    if (reason === 'no-gap') f.sevenDay!.central = 120;
    if (reason === 'old-reset') f.sevenDay!.resetsAt = new Date(now - 1000).toISOString();
    if (reason === 'duplicate') forecasts.push(f);
    expect(choose([account('source'), a], forecasts)).toBeNull();
  });
  it('never moves to a second ID for the same login and counts candidate login aliases together', () => {
    const source = account('source'); const alias = { ...account('alias'), email: source.email };
    expect(choose([source, alias], [{ ...summary('alias'), identity: identityKey('openai', source.email) }])).toBeNull();
    const a = account('amrch'); const aAlias = { ...account('amrch-copy'), email: a.email };
    expect(choose([source, a, aAlias, account('sagemindai')], [summary('amrch'), summary('sagemindai', 30)], [session('alias-busy','amrch-copy')])?.accountId).toBe('sagemindai');
  });
  it('the scheduler manual mode permits a healthy source but preserves work-gate refusal and existing placement', async () => {
    const accounts = [account('source'), account('target')];
    const refresh = vi.fn(async () => ({ ok: false, code: 'session-busy' }));
    const q = new QuotaAwareScheduler({ listAccounts: () => accounts, refreshFn: refresh });
    const r = await q.onQuotaPressure({ sessionName: 'topic', exhaustedAccountId: 'source', nowMs: now,
      manualBalanceTarget: 'target', manualBalanceSourceCurrent: () => true });
    expect(r.reason).toBe('session-busy'); expect(refresh).toHaveBeenCalledWith(expect.objectContaining({ callerClass: 'interactive-refresh', accountId: 'target' }));
    expect(q.placeNewSession(now, 'codex-cli')?.id).toBe('source');
    refresh.mockClear();
    expect((await q.onQuotaPressure({ sessionName: 'topic', exhaustedAccountId: 'source', nowMs: now,
      manualBalanceTarget: 'target', manualBalanceSourceCurrent: () => false })).reason).toBe('manual-balance-source-changed');
    expect(refresh).not.toHaveBeenCalled();
  });
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-balance-')); dirs.push(dir);
  const accounts = ['source', 'amrch', 'sagemindai'].map(account);
  for (const a of accounts) { a.configHome = path.join(dir, a.id); fs.mkdirSync(a.configHome); }
  const sessions = ['one', 'two', 'three', 'four'].map(id => session(id));
  const summaries = [summary('amrch'), summary('sagemindai', 30)];
  return { dir, accounts, sessions, summaries };
}
describe('manual balance serialization and durable settlement', () => {
  it('four concurrent requests distribute despite unchanged forecasts and wait through settlement', async () => {
    const x = fixture(); const picked: string[] = []; let active = 0;
    const balance = new ManualQuotaBalance({ stateDir: x.dir, accounts: () => x.accounts, sessions: () => x.sessions, forecasts: async () => x.summaries, now: () => now,
      execute: async intent => { expect(++active).toBe(1); picked.push(intent.targetId); await new Promise(r => setTimeout(r, 2));
        const s = x.sessions.find(s => s.tmuxSession === intent.sessionName)!; s.subscriptionAccountId = intent.targetId; s.id += '-new'; active--;
        return { swapped: true, toAccountId: intent.targetId, reason: 'swapped-and-resumed' }; } });
    const results = await Promise.all(x.sessions.map(s => balance.balance(s.tmuxSession, 'source')));
    expect(results.every(r => r.swapped)).toBe(true); expect(picked).toEqual(['amrch','sagemindai','amrch','sagemindai']);
  });
  it('retains an ambiguous refresh across restart until the exact replacement record reconciles', async () => {
    const x = fixture(); const execute = vi.fn(async () => { throw new Error('connection lost after refresh'); });
    const deps = { stateDir: x.dir, accounts: () => x.accounts, sessions: () => x.sessions, forecasts: async () => x.summaries, now: () => now, execute };
    const balance = new ManualQuotaBalance(deps);
    expect((await balance.balance('topic-one', 'source')).reason).toBe('manual-balance-settlement-pending');
    const restarted = new ManualQuotaBalance(deps);
    expect((await restarted.balance('topic-two', 'source')).reason).toBe('manual-balance-settlement-pending'); expect(execute).toHaveBeenCalledOnce();
    x.sessions[0].subscriptionAccountId = 'amrch'; x.sessions[0].id = 'one-reconciled';
    await restarted.balance('topic-two', 'source'); expect(execute).toHaveBeenCalledTimes(2);
  });
  it('a source change during history reading prevents execution; definite refusal releases the serial slot', async () => {
    const x = fixture(); const execute = vi.fn(async () => ({ swapped: false, toAccountId: 'amrch', reason: 'session-busy' }));
    const balance = new ManualQuotaBalance({ stateDir: x.dir, accounts: () => x.accounts, sessions: () => x.sessions,
      forecasts: async () => { x.sessions[0].subscriptionAccountId = 'other'; return x.summaries; }, execute, now: () => now });
    expect((await balance.balance('topic-one','source')).reason).toBe('manual-balance-source-changed'); expect(execute).not.toHaveBeenCalled();
    expect((await balance.balance('topic-two','source')).reason).toBe('session-busy');
    expect((await balance.balance('topic-three','source')).reason).toBe('session-busy'); expect(execute).toHaveBeenCalledTimes(2);
  });
});

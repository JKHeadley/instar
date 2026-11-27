/**
 * quota pacing step 2 (docs/specs/quota-pacing-account-choice.md) — the pure core:
 * windowNow states (§1), Fable binding (§2), the shared score and tiers (§3),
 * window-aware poolHeadroom and the never-loop invariant.
 */
import { describe, it, expect } from 'vitest';
import {
  windowNow,
  rankAccounts,
  classifyLaunchModel,
  assessAccount,
  FIVE_HOUR_WINDOW_MS,
  WEEKLY_WINDOW_MS,
} from '../../src/core/windowAwareChoice.js';
import { selectAccount, poolHeadroom, bindingUtilization } from '../../src/core/QuotaAwareScheduler.js';
import type { AccountQuotaSnapshot, SubscriptionAccount } from '../../src/core/SubscriptionPool.js';

const NOW = Date.parse('2026-11-18T08:00:00Z');
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const fresh = iso(NOW - 5 * 60_000);

function acct(id: string, q: Partial<AccountQuotaSnapshot> | null, framework: 'claude-code' | 'codex-cli' = 'claude-code'): SubscriptionAccount {
  return {
    id,
    nickname: id,
    provider: framework === 'codex-cli' ? 'openai' : 'anthropic',
    framework,
    configHome: `/h/${id}`,
    status: 'active',
    lastQuota: q === null ? null : ({ source: 'oauth-usage-endpoint-fallback', measuredAt: fresh, ...q } as AccountQuotaSnapshot),
    enrolledAt: '2026-06-01T00:00:00Z',
    version: 1,
  };
}
const win = (pct: number, resetInH: number) => ({ utilizationPct: pct, resetsAt: iso(NOW + resetInH * H) });

describe('windowNow — every state in order', () => {
  it('measured when the reset is in the future and the reading is fresh', () => {
    const r = windowNow({ sevenDay: win(40, 10), measuredAt: fresh }, 'sevenDay', NOW);
    expect(r).toMatchObject({ state: 'measured', pct: 40 });
  });
  it('rolled when the reset is exactly now or hours ago', () => {
    expect(windowNow({ sevenDay: { utilizationPct: 92, resetsAt: iso(NOW) }, measuredAt: fresh }, 'sevenDay', NOW).state).toBe('rolled');
    const r = windowNow({ sevenDay: win(92, -3), measuredAt: fresh }, 'sevenDay', NOW);
    expect(r).toMatchObject({ state: 'rolled', pct: null, resetsAtMs: null });
  });
  it('the same snapshot advanced across several cycles reads unread-old-cycle', () => {
    const snap = { fiveHour: win(10, 1), sevenDay: win(50, 24), measuredAt: fresh };
    expect(windowNow(snap, 'sevenDay', NOW + 24 * H + WEEKLY_WINDOW_MS).state).toBe('unread-old-cycle');
    expect(windowNow(snap, 'fiveHour', NOW + H + FIVE_HOUR_WINDOW_MS).state).toBe('unread-old-cycle');
  });
  it('fableUnknown and an unparseable reset are unknown', () => {
    expect(windowNow({ fable: win(0, 10), fableUnknown: true, measuredAt: fresh }, 'fable', NOW).state).toBe('unknown');
    expect(windowNow({ sevenDay: { utilizationPct: 5, resetsAt: 'soon' }, measuredAt: fresh }, 'sevenDay', NOW).state).toBe('unknown');
  });
  it('an empty reset from a live read is idle (measured room), from rollout or an older snapshot is rolled', () => {
    const live = { sevenDay: { utilizationPct: 0, resetsAt: '' }, windowBasis: { sevenDay: 'idle-live' as const }, measuredAt: fresh };
    expect(windowNow(live, 'sevenDay', NOW)).toMatchObject({ state: 'idle', pct: 0, resetsAtMs: null });
    const hist = { sevenDay: { utilizationPct: 0, resetsAt: '' }, windowBasis: { sevenDay: 'rolled-history' as const }, measuredAt: fresh };
    expect(windowNow(hist, 'sevenDay', NOW).state).toBe('rolled');
    const old = { sevenDay: { utilizationPct: 0, resetsAt: '' }, measuredAt: fresh };
    expect(windowNow(old, 'sevenDay', NOW).state).toBe('rolled');
  });
  it('a Codex window rewritten weeks ago reads unread-old-cycle via resetsAtBeforeRewrite', () => {
    const snap = {
      sevenDay: { utilizationPct: 0, resetsAt: '' },
      windowBasis: { sevenDay: 'rolled-history' as const },
      resetsAtBeforeRewrite: { sevenDay: iso(NOW - 3 * WEEKLY_WINDOW_MS) },
      measuredAt: fresh,
    };
    expect(windowNow(snap, 'sevenDay', NOW, { provider: 'openai' }).state).toBe('unread-old-cycle');
  });
  it('not-offered only from the provider list or the framework table; otherwise unread-none', () => {
    expect(windowNow({ sevenDay: win(1, 5), windowsListed: ['fiveHour', 'sevenDay'], measuredAt: fresh }, 'fable', NOW).state).toBe('not-offered');
    expect(windowNow({ sevenDay: win(1, 5), measuredAt: fresh }, 'fable', NOW).state).toBe('unread-none');
    expect(windowNow({ sevenDay: win(1, 5), measuredAt: fresh }, 'fable', NOW, { provider: 'openai' }).state).toBe('not-offered');
    expect(windowNow(null, 'sevenDay', NOW).state).toBe('unread-none');
  });
  it('a stale or synthesized reading time is never fresh', () => {
    expect(windowNow({ sevenDay: win(10, 5), measuredAt: iso(NOW - 3 * 24 * H) }, 'sevenDay', NOW).state).toBe('unread-stale');
    expect(windowNow({ sevenDay: win(10, 5), measuredAt: fresh, measuredAtSynthesized: true }, 'sevenDay', NOW).state).toBe('unread-stale');
  });
});

describe('classifyLaunchModel', () => {
  it('Fable, non-Fable and unknown', () => {
    expect(classifyLaunchModel('claude-fable-5-2')).toBe('fable');
    expect(classifyLaunchModel('fable')).toBe('fable');
    expect(classifyLaunchModel('claude-opus-5-5')).toBe('non-fable');
    expect(classifyLaunchModel('capable')).toBe('non-fable');
    expect(classifyLaunchModel(undefined)).toBe('unknown');
    expect(classifyLaunchModel('')).toBe('unknown');
  });
});

describe('the shared score and tiers', () => {
  // The spec's example: A 40% into a week resetting in 6 days, 10% into 5 hours resetting in 30 min;
  // B 20% into a week resetting in 2 hours.
  const A = acct('a', { fiveHour: win(10, 0.5), sevenDay: win(40, 144) });
  const B = acct('b', { sevenDay: win(20, 2), windowsListed: ['sevenDay'] });

  it('the A/B example picks B (the 5-hour reset never sets urgency)', () => {
    expect(selectAccount([A, B], { nowMs: NOW, windowAware: true })?.id).toBe('b');
    // today's rule picks A
    expect(selectAccount([A, B], { nowMs: NOW })?.id).toBe('a');
  });

  it('weekly 80 room in 1h with Fable 20 room in 6 days scores 20 for a Fable session', () => {
    const x = acct('x', { sevenDay: win(20, 1), fable: win(80, 144), windowsListed: ['sevenDay', 'fable'] });
    const s = assessAccount(x, { nowMs: NOW, fableBinding: true }).score;
    expect(s).toBeCloseTo(20, 5);
  });

  it('B plus an untouched Fable window resetting in 6 days still beats A for a Fable session', () => {
    const Bf = acct('b', { sevenDay: win(20, 2), fable: win(0, 144), windowsListed: ['sevenDay', 'fable'] });
    const Af = acct('a', { fiveHour: win(10, 0.5), sevenDay: win(40, 144), fable: win(0, 144) });
    expect(selectAccount([Af, Bf], { nowMs: NOW, windowAware: true, model: 'claude-fable-5-2' })?.id).toBe('b');
  });

  it('a known Fable launch skips the Fable-heavy account; a non-Fable launch does not see it', () => {
    const heavy = acct('heavy', { sevenDay: win(10, 2), fable: win(98, 100), windowsListed: ['sevenDay', 'fable'] });
    const other = acct('other', { sevenDay: win(30, 50), fable: win(10, 100), windowsListed: ['sevenDay', 'fable'] });
    expect(selectAccount([heavy, other], { nowMs: NOW, windowAware: true, model: 'claude-fable-5-2' })?.id).toBe('other');
    expect(selectAccount([heavy, other], { nowMs: NOW, windowAware: true, model: 'claude-opus-5-5' })?.id).toBe('heavy');
  });

  it('with every Fable window full a Fable session still gets an account (fable-no-room), ranked by Fable room', () => {
    const p = acct('p', { sevenDay: win(10, 2), fable: win(99, 100), windowsListed: ['sevenDay', 'fable'] });
    const q = acct('q', { sevenDay: win(10, 3), fable: win(95, 100), windowsListed: ['sevenDay', 'fable'] });
    const r = rankAccounts([p, q], { nowMs: NOW, model: 'claude-fable-5-2' });
    expect(r.fableNoRoom).toBe(true);
    expect(r.ranked[0].account.id).toBe('q');
  });

  it('an unknown model uses Fable room only as a tie-break', () => {
    const p = acct('p', { sevenDay: win(10, 24), fable: win(90, 100), windowsListed: ['sevenDay', 'fable'] });
    const q = acct('q', { sevenDay: win(10, 24), fable: win(10, 100), windowsListed: ['sevenDay', 'fable'] });
    expect(selectAccount([p, q], { nowMs: NOW, windowAware: true })?.id).toBe('q');
    // a Fable window over the line does not exclude an account for an unknown model
    const full = acct('full', { sevenDay: win(10, 1), fable: win(99, 100), windowsListed: ['sevenDay', 'fable'] });
    expect(selectAccount([full, q], { nowMs: NOW, windowAware: true })?.id).toBe('full');
  });

  it('the measured tier always beats the unmeasured tier; unmeasured is used only when measured is empty', () => {
    const justReset = acct('reset', { sevenDay: { utilizationPct: 92, resetsAt: iso(NOW - 60_000) }, windowsListed: ['sevenDay'] });
    const measured = acct('m', { sevenDay: win(80, 150), windowsListed: ['sevenDay'] });
    expect(selectAccount([justReset, measured], { nowMs: NOW, windowAware: true })?.id).toBe('m');
    expect(selectAccount([justReset], { nowMs: NOW, windowAware: true })?.id).toBe('reset');
  });

  it('a rolled account triggers one read request; an idle account triggers none', () => {
    const asked: string[] = [];
    const justReset = acct('reset', { sevenDay: win(92, -0.1), windowsListed: ['sevenDay'] });
    const idle = acct('idle', { sevenDay: { utilizationPct: 0, resetsAt: '' }, windowBasis: { sevenDay: 'idle-live' }, windowsListed: ['sevenDay'] });
    selectAccount([justReset, idle], { nowMs: NOW, windowAware: true, requestRead: (id) => asked.push(id) });
    expect(asked).toEqual(['reset']);
  });

  it('an idle Claude account and an idle Codex account (live read) stay in the measured tier', () => {
    const idleClaude = acct('ic', { fiveHour: { utilizationPct: 0, resetsAt: '' }, sevenDay: { utilizationPct: 3, resetsAt: '' }, windowBasis: { fiveHour: 'idle-live', sevenDay: 'idle-live' }, windowsListed: ['fiveHour', 'sevenDay'] });
    expect(assessAccount(idleClaude, { nowMs: NOW, fableBinding: false }).tier).toBe('measured');
    const idleCodex = acct('ix', { source: 'codex-app-server', sevenDay: { utilizationPct: 0, resetsAt: '' }, windowBasis: { sevenDay: 'idle-live' }, windowsListed: ['sevenDay'] } as Partial<AccountQuotaSnapshot>, 'codex-cli');
    expect(assessAccount(idleCodex, { nowMs: NOW, fableBinding: false }).tier).toBe('measured');
  });

  it('an account with one idle and one measured window (idle nonzero) is measured', () => {
    const x = acct('x', { fiveHour: { utilizationPct: 12, resetsAt: '' }, sevenDay: win(30, 40), windowBasis: { fiveHour: 'idle-live' }, windowsListed: ['fiveHour', 'sevenDay'] });
    const a = assessAccount(x, { nowMs: NOW, fableBinding: false });
    expect(a.tier).toBe('measured');
    expect(a.bindingPct).toBe(30);
  });

  it('a just-rolled 5-hour window keeps the account measured inside the grace, and demotes after it or after a failed read', () => {
    const mk = (minAgo: number) => acct('g', { fiveHour: { utilizationPct: 99, resetsAt: iso(NOW - minAgo * 60_000) }, sevenDay: win(20, 50), windowsListed: ['fiveHour', 'sevenDay'] });
    expect(assessAccount(mk(10), { nowMs: NOW, fableBinding: false }).tier).toBe('measured');
    expect(assessAccount(mk(40), { nowMs: NOW, fableBinding: false }).tier).toBe('unmeasured');
    expect(assessAccount(mk(10), { nowMs: NOW, fableBinding: false, failedReads: () => 1 }).tier).toBe('unmeasured');
  });

  it('a 3-day-old reading with a future reset ranks in the unmeasured tier for selectAccount', () => {
    const stale = acct('stale', { sevenDay: win(5, 100), measuredAt: iso(NOW - 72 * H), windowsListed: ['sevenDay'] });
    const ok = acct('ok', { sevenDay: win(70, 100), windowsListed: ['sevenDay'] });
    expect(rankAccounts([stale, ok], { nowMs: NOW }).ranked.map((x) => [x.account.id, x.tier])).toEqual([['ok', 'measured'], ['stale', 'unmeasured']]);
  });

  it('no measured weekly window keeps today\'s no-reading rule (room 100 at urgency 0.0001)', () => {
    expect(assessAccount(acct('n', null), { nowMs: NOW, fableBinding: false }).score).toBeCloseTo(0.01, 6);
  });

  it('switch off gives today\'s results', () => {
    const pool = [acct('a', { fiveHour: win(10, 0.5), sevenDay: win(40, 144) }), acct('b', { sevenDay: win(20, 2) }), acct('c', { sevenDay: win(95, 1) })];
    expect(selectAccount(pool, { nowMs: NOW })?.id).toBe(selectAccount(pool, { nowMs: NOW, windowAware: false })?.id);
    expect(poolHeadroom(pool, { nowMs: NOW })).toEqual(poolHeadroom(pool, { nowMs: NOW, windowAware: false }));
  });
});

describe('bindingUtilization window-aware form', () => {
  it('highest valid percent, null when none is valid; the one-argument form is unchanged', () => {
    const snap = { fiveHour: win(30, 1), sevenDay: win(92, -1), measuredAt: fresh } as AccountQuotaSnapshot;
    expect(bindingUtilization(snap)).toBe(92);
    expect(bindingUtilization(snap, { nowMs: NOW })).toBe(30);
    expect(bindingUtilization({ sevenDay: win(92, -1), measuredAt: fresh }, { nowMs: NOW })).toBeNull();
    expect(bindingUtilization({ sevenDay: win(10, 9), fable: win(97, 9), measuredAt: fresh }, { nowMs: NOW, model: 'claude-fable-5' })).toBe(97);
  });
});

describe('window-aware poolHeadroom and the never-loop invariant', () => {
  it('reports null (never last cycle\'s number) for a rolled window and degraded only for an unmeasured best', () => {
    const rolled = acct('r', { sevenDay: win(92, -1), windowsListed: ['sevenDay'] });
    const h = poolHeadroom([rolled], { nowMs: NOW, windowAware: true });
    expect(h).toMatchObject({ placeable: true, weeklyPercent: null, degraded: true });
    const m = acct('m', { sevenDay: win(40, 50), windowsListed: ['sevenDay'] });
    expect(poolHeadroom([rolled, m], { nowMs: NOW, windowAware: true })).toMatchObject({ placeable: true, weeklyPercent: 40, degraded: false });
  });

  it('placeable ⟺ selectAccount !== null over randomized pools, every model case', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const pickWin = () => {
      const k = rnd();
      if (k < 0.15) return undefined;
      if (k < 0.3) return { utilizationPct: Math.floor(rnd() * 100), resetsAt: iso(NOW - rnd() * 3 * H) };
      if (k < 0.4) return { utilizationPct: 0, resetsAt: '' };
      return { utilizationPct: Math.floor(rnd() * 100), resetsAt: iso(NOW + rnd() * 100 * H) };
    };
    for (let i = 0; i < 300; i++) {
      const n = 1 + Math.floor(rnd() * 4);
      const pool: SubscriptionAccount[] = [];
      for (let j = 0; j < n; j++) {
        const q: Partial<AccountQuotaSnapshot> = { fiveHour: pickWin(), sevenDay: pickWin(), fable: pickWin() };
        if (rnd() < 0.2) q.fableUnknown = true;
        if (rnd() < 0.3) q.windowBasis = { sevenDay: 'idle-live' };
        if (rnd() < 0.2) q.measuredAt = iso(NOW - 5 * H);
        pool.push(acct(`a${j}`, rnd() < 0.1 ? null : q));
      }
      const placeable = poolHeadroom(pool, { nowMs: NOW, windowAware: true }).placeable;
      for (const model of ['claude-fable-5-2', 'claude-opus-5-5', undefined]) {
        expect(selectAccount(pool, { nowMs: NOW, windowAware: true, model }) !== null).toBe(placeable);
      }
    }
  });
});

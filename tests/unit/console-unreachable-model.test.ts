import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain ES module from the dashboard
import { unreachableSentence, unreachableClause, sinceWords, fixWords, poolMachine, lastReachedAt } from '../../dashboard/console/unreachable-model.js';
// @ts-expect-error — plain ES module from the dashboard
import { unreachedLine, machineNames } from '../../dashboard/console/home-model.js';
// @ts-expect-error — plain ES module from the dashboard
import { buildAccountsPage } from '../../dashboard/console/accounts-model.js';
// @ts-expect-error — plain ES module from the dashboard
import { buildReachPage } from '../../dashboard/console/reach-model.js';

// CMT-1541 (operator 2026-11-09): every "no answer from <machine>" notice says HOW LONG and WHETHER
// anything is working to fix it, and never invents a duration.
const NOW = Date.parse('2026-11-09T12:00:00Z');
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
const direct = (m: number) => ({ state: 'unreachable', source: 'direct', evidenceAt: minsAgo(m) });

describe('unreachable notice words', () => {
  it('names the duration from the last direct contact', () => {
    expect(sinceWords({ liveness: direct(12) }, NOW)).toBe('for 12 min');
    expect(sinceWords({ liveness: direct(180) }, NOW)).toBe('for 3 hours');
    expect(sinceWords({ liveness: direct(60 * 50) }, NOW)).toBe('for 2 days');
    expect(sinceWords({ liveness: { state: 'unreachable', source: 'saved', evidenceAt: minsAgo(30) } }, NOW)).toBe('for 30 min');
    expect(sinceWords({ liveness: direct(1) }, NOW)).toBe('just now');
  });

  it('never invents a duration: a relayed heartbeat is not a contact, no evidence is "not known"', () => {
    expect(lastReachedAt({ liveness: { state: 'stale', source: 'relayed', evidenceAt: minsAgo(5) } })).toBeNull();
    expect(sinceWords(null, NOW)).toBeNull();
    expect(sinceWords({ liveness: { state: 'unknown', source: 'none', evidenceAt: null } }, NOW)).toBeNull();
    expect(unreachableSentence('Laptop', null, { machineId: 'l', error: 'timeout' }, NOW))
      .toBe("Couldn't reach Laptop (for how long is not known); not known whether anything is fixing it.");
  });

  it('falls back to the moment every connection went down', () => {
    expect(sinceWords({ ropeAllDownSince: minsAgo(45) }, NOW)).toBe('for 45 min');
  });

  it('says whether anything is fixing it, on both sides of each decision', () => {
    expect(fixWords({ reconnect: { state: 'retrying' } }, null, NOW)).toBe('reconnecting by itself');
    expect(fixWords({ reconnect: { state: 'retrying', nextTryAt: new Date(NOW + 5 * 60_000).toISOString() } }, null, NOW)).toBe('reconnecting by itself (next try in 5 min)');
    expect(fixWords({ reconnect: { state: 'retrying-slowly' } }, null, NOW)).toMatch(/slow rate.*nothing has worked yet/);
    expect(fixWords({ reconnect: { state: 'connected' } }, null, NOW)).toMatch(/connection works/);
    expect(fixWords({ ropeCondition: 'peer-offline', reconnect: { state: 'retrying' } }, null, NOW)).toMatch(/switched off or asleep/);
    expect(fixWords({ ropeCondition: 'urgent' }, null, NOW)).toMatch(/cut off.*nothing has fixed it yet/);
    expect(fixWords({ ropeCondition: 'auth-rejected' }, null, NOW)).toMatch(/will not fix itself/);
    expect(fixWords({ reconnect: { state: 'retrying' } }, { error: 'unauthorized' }, NOW)).toMatch(/refused this machine, so this will not fix itself/);
    expect(fixWords({}, null, NOW)).toBe('not known whether anything is fixing it');
  });

  it('the operator\'s two examples', () => {
    expect(unreachableSentence('Laptop', { liveness: direct(12), reconnect: { state: 'retrying' } }, { error: 'timeout' }, NOW))
      .toBe("Couldn't reach Laptop for 12 min; reconnecting by itself.");
    expect(unreachableClause({ liveness: direct(180), reconnect: { state: 'retrying-slowly' } }, { error: 'timeout' }, NOW))
      .toBe('not answering for 3 hours; retrying by itself at a slow rate, but nothing has worked yet');
  });

  it('reads a /pool row from a get() result or its data', () => {
    const row = { machineId: 'a', nickname: 'A' };
    expect(poolMachine({ ok: true, data: { machines: [row] } }, 'a')).toBe(row);
    expect(poolMachine({ machines: [row] }, 'a')).toBe(row);
    expect(poolMachine({ ok: false, reason: 'x' }, 'a')).toBeNull();
    expect(poolMachine(null, 'a')).toBeNull();
  });
});

describe('notices across pages use the same shape', () => {
  const pool = { ok: true, data: { machines: [{ machineId: 'mini', nickname: 'Mac Mini', liveness: direct(180), reconnect: { state: 'retrying' } }] } };

  it('Home: machineNames carries the /pool rows without changing its id → name keys', () => {
    const names = machineNames(pool);
    expect(Object.keys(names)).toEqual(['mini']);
    expect(unreachedLine([{ machineId: 'mini' }], names, 'items', NOW))
      .toBe("Couldn't reach Mac Mini for 3 hours; reconnecting by itself. Its items may be missing.");
    expect(unreachedLine([], names, 'items', NOW)).toBe('');
  });

  it('Accounts: the partial line says how long and whether anything is fixing it', () => {
    const res = { ok: true, data: { accounts: [], pool: { failed: [{ machineId: 'mini', error: 'timeout' }] } } };
    const page = buildAccountsPage(res, NOW, { names: { mini: 'Mac Mini' }, poolMachines: pool });
    expect(page.partial).toBe("Couldn't reach Mac Mini for 3 hours; reconnecting by itself. Its accounts may be out of date.");
  });

  it('Who can reach me: a named machine, never a raw id', () => {
    const page = buildReachPage({ ok: true, data: { people: [], count: 0, pool: { failed: [{ machineId: 'mini', reason: 'timeout' }] } } }, { pool, now: NOW });
    expect(page.notes).toContain("Couldn't reach Mac Mini for 3 hours; reconnecting by itself.");
    expect(page.notes.join(' ')).not.toMatch(/\bmini did not answer/);
  });
});

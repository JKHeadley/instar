/**
 * shared-counts.js — the ONE source every console page counts from. Each rule is
 * pinned here on both sides of its boundary; the cross-page invariants (Home's
 * number equals the page's number) live in console-home-coherence.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  sortPromises, promiseTopic, promiseRefs, promisesAbout, promiseNeed,
  attentionNeeds, cellRepair, accountNeeds, accountsHeadline, prsNeedingYou,
  guardNeedsLook, guardsNeedingLook, loadOf, liveState, groupFailures, needsYou, readState,
} from '../../dashboard/console/shared-counts.js';

const NOW = Date.parse('2026-10-26T18:00:00Z');
const iso = (minsAgo: number) => new Date(NOW - minsAgo * 60_000).toISOString();
const DAY = 1440;
const ok = (data: unknown) => ({ ok: true, data });
let seqN = 0;
const c = (over: Record<string, unknown> = {}) => { const id = `CMT-${++seqN}`; return { id, status: 'pending', owner: 'agent', blockedOn: 'none', createdAt: iso(60), agentResponse: `I will report back on ${id}`, ...over }; };

describe('promises: one partition of "open"', () => {
  it('waiting / missed / due soon / carrying / older / closed, with open = waiting + missed + due soon + carrying', () => {
    const s = sortPromises([
      c({ owner: 'user', blockedOn: 'user-input' }),
      c({ status: 'violated' }),
      c({ hardDeadlineAt: iso(5) }),
      c({ nextUpdateDueAt: iso(-120) }),
      c({}),
      c({ createdAt: iso(30 * DAY) }),                                   // older (carried)
      c({ owner: 'user', blockedOn: 'user-input', createdAt: iso(20 * DAY) }), // older, waiting
      c({ status: 'violated', createdAt: iso(90 * DAY) }),                // missed at any age
      c({ status: 'delivered', resolvedAt: iso(60) }),
      c({ status: 'delivered', resolvedAt: iso(10 * DAY) }),
    ], NOW);
    expect(s.counts).toEqual({ waiting: 1, missed: 3, missedUnclear: 0, dueSoon: 1, carrying: 1, older: 2, olderWaiting: 1, closed: 1, open: 6 });
    expect(s.older[0].owner).toBe('user'); // older rows that wait on the operator come first and still say so
  });
  it('missed: a fragment with no promise language is listed apart; the same sentence said twice is one miss', () => {
    const s = sortPromises([
      c({ status: 'violated', agentResponse: 'Changing the schedule now' }),
      c({ status: 'violated', agentResponse: 'I’ll report back shortly.', createdAt: iso(10) }),
      c({ status: 'violated', agentResponse: 'I’ll report back  shortly.', createdAt: iso(20) }),
    ], NOW);
    expect(s.counts).toMatchObject({ missed: 1, missedUnclear: 1, open: 2 });
    expect(s.repeats.get(s.missed[0])).toHaveLength(1);
  });
  it('newest first inside a section, so Home never leads with a 67-day-old promise', () => {
    const s = sortPromises([c({ status: 'violated', createdAt: iso(67 * DAY) }), c({ status: 'violated', createdAt: iso(4 * DAY) })], NOW);
    expect(s.missed.map((x) => x.createdAt)).toEqual([iso(4 * DAY), iso(67 * DAY)]);
  });
  it('knows what a waiting promise is about and which things it names', () => {
    expect(promiseTopic(c({ agentResponse: 'merge PR 2350 only after Justin confirms in topic 9210' }))).toBe('pr');
    expect(promiseTopic(c({ agentResponse: 'luna needs a password from Justin' }))).toBe('password');
    expect(promiseTopic(c({ agentResponse: 'Sign the Claude login (luna@x.io) back in on the laptop' }))).toBe('sign-in');
    expect(promiseTopic(c({ agentResponse: 'which of the four agent servers matter least' }))).toBeNull();
    expect(promiseRefs(c({ agentResponse: 'After Justin approves attention item agent:echo-disk-cleanup-2026-10-23, clear 51 worktrees; also PR #2350 and pull request 2357' }))).toEqual({ prs: [2350, 2357], attentionIds: ['agent:echo-disk-cleanup-2026-10-23'], emails: [] });
    const about = promisesAbout([c({ owner: 'user', blockedOn: 'user-authorization', agentResponse: 'merge PR 2350 after you confirm' }), c({ owner: 'user', blockedOn: 'user-input', agentResponse: 'needs a password' }), c({ agentResponse: 'PR 1 merged by me' })], 'pr', NOW);
    expect(about.map((p) => p.subKind)).toEqual(['approval']);
    expect(promiseNeed(c({ owner: 'user', blockedOn: 'user-input' }), NOW).sub).toBe('Needs your answer');
  });
});

describe('attention: who needs the operator, repeats folded', () => {
  it('routine notices never count; URGENT, agent-raised and decision categories do; 14+ untouched days is stale (security never)', () => {
    const items = [
      ...Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, title: 'Worktree scan', status: 'OPEN', priority: 'HIGH', createdAt: iso(i) })),
      { id: 'a', title: 'Approve the cleanup', status: 'OPEN', priority: 'HIGH', source: 'agent', createdAt: iso(10) },
      { id: 'a2', title: 'Approve the cleanup', status: 'OPEN', priority: 'HIGH', source: 'agent', createdAt: iso(12), machineNickname: 'Mac Mini' },
      { id: 'u', title: 'Disk full', status: 'OPEN', priority: 'URGENT', createdAt: iso(20 * DAY) },
      { id: 's', title: 'Token leaked', status: 'OPEN', priority: 'HIGH', category: 'security', createdAt: iso(30 * DAY) },
      { id: 'd', title: 'Done thing', status: 'DONE', priority: 'URGENT', createdAt: iso(1) },
    ];
    const a = attentionNeeds(items, NOW);
    expect(a.routine).toBe(5);
    // Same priority: the most recently touched first; security never goes stale however old.
    expect(a.current.map((g) => g.main)).toEqual(['Approve the cleanup', 'Token leaked']);
    expect(a.current[0].ids).toEqual(['a', 'a2']);
    expect(a.current[0].sub).toContain('2 copies');
    expect(a.stale.map((g) => g.main)).toEqual(['Disk full']);
  });
});

describe('sign-ins: a tap is the operator’s, an expired login is the agent’s chore', () => {
  const row = (over: Record<string, unknown> = {}) => ({ id: 'luna', nickname: 'Luna', email: 'luna@x.io', framework: 'claude-code', status: 'needs-reauth', loginCheck: 'unavailable', machineId: 'm2', machineNickname: 'Mac Mini', ...over });
  it('cell states', () => {
    expect(cellRepair(row({ status: 'active', loginCheck: 'ok' }), null)).toMatchObject({ state: 'ok', needsTap: false, expired: false });
    expect(cellRepair(row(), { state: 'browser-driving' })).toMatchObject({ state: 'working', needsTap: false });
    expect(cellRepair(row(), { state: 'suggested', mode: 'approval' })).toMatchObject({ state: 'tap', needsTap: true, action: 'approve' });
    expect(cellRepair(row(), { state: 'waiting-operator-only' })).toMatchObject({ state: 'tap', needsTap: true });
    expect(cellRepair(row(), { state: 'failed', nextAttemptAt: iso(-600) }, { now: NOW })).toMatchObject({ state: 'scheduled', needsTap: false, action: 'retry' });
    expect(cellRepair(row(), { state: 'failed', nextAttemptAt: null }, { now: NOW })).toMatchObject({ state: 'stopped', needsTap: false, action: 'retry' });
    expect(cellRepair(row(), null)).toMatchObject({ state: 'none', needsTap: false, action: 'start' });
    expect(cellRepair(row(), null, { unavailable: true })).toMatchObject({ state: 'unavailable', needsTap: false });
  });
  it('the split and the honest headline', () => {
    const rows = [row(), row({ id: 'dawn', nickname: 'Dawn', email: 'dawn@x.io' }), row({ id: 'echo', machineId: 'm4', machineNickname: 'Mama PC' }), row({ id: 'fine', status: 'active', loginCheck: 'ok' })];
    const eps = [{ accountId: 'luna', machineId: 'm2', state: 'suggested', mode: 'approval', updatedAt: iso(1) }, { accountId: 'dawn', machineId: 'm2', state: 'cli-starting', updatedAt: iso(1) }];
    const n = accountNeeds(rows, eps, { unavailable: ['m4'], now: NOW });
    expect(n.tap.map((t) => t.key)).toEqual(['account:luna:m2']);
    expect(n.expired.map((t) => t.key)).toEqual(['account:dawn:m2', 'account:echo:m4']);
    expect(n.repairing).toBe(1);
    expect(accountsHeadline(n)).toBe('1 sign-in needs your tap; 2 other sign-ins expired on Mac Mini and Mama PC, mine to repair.');
    expect(accountsHeadline(accountNeeds(rows.slice(1), eps, { unavailable: ['m4'], now: NOW }))).toBe('2 sign-ins expired on Mac Mini and Mama PC — mine to repair (1 repairing); none needs your tap.');
    expect(accountsHeadline(accountNeeds([rows[3]], [], { now: NOW }))).toBeNull();
  });
});

describe('pull requests needing the operator', () => {
  it('code-owner review entries and approval-required episodes, each PR once', () => {
    const w = { snapshot: { at: NOW - 60_000, entries: [{ pr: 2350, kind: 'code-owner-review' }, { pr: 2357, kind: 'mergeable' }] }, episodes: [{ pr: 2350, lastOutcome: 'refused:approval-required' }, { pr: 2371, lastOutcome: 'refused:approval-required', lastAttemptAt: NOW - 120_000 }, { pr: 2375, state: 'gave-up', lastOutcome: 'refused:verify-failed' }] };
    expect(prsNeedingYou(w, NOW).map((p) => [p.pr, p.why])).toEqual([[2350, 'waiting for your code-owner review on GitHub'], [2371, 'waiting for your approval on GitHub']]);
    expect(prsNeedingYou(null)).toEqual([]);
  });
});

describe('safety checks: one rule, one count, scope stated, can’t-tell apart', () => {
  const g = (key: string, effective: string, over: Record<string, unknown> = {}) => ({ key, effective, ...over });
  const local = [
    g('monitoring.a.enabled', 'off', { offClass: 'diverged-from-default' }), g('monitoring.b.enabled', 'off', { offClass: 'dark-default' }),
    g('monitoring.c.enabled', 'on-confirmed'), g('monitoring.d.enabled', 'on-unverified'), g('monitoring.e.enabled', 'on-dry-run'),
    g('multiMachine.f.enabled', 'on-dry-run', { loadBearingGap: true, criticalPath: 'serving-lease returns to captain' }),
    g('monitoring.g.enabled', 'missing'), g('monitoring.h.enabled', 'on-dry-run', { loadBearingGap: true, loadBearingAccepted: true }),
  ];
  const res = ok({ machineId: 'm1', nickname: 'Mac Studio', guards: local, pool: { machines: [{ machineId: 'm2', nickname: 'Mac Mini', guards: [g('monitoring.a.enabled', 'off', { offClass: 'diverged-from-default' }), g('monitoring.z.enabled', 'errored')] }, { machineId: 'm3', nickname: 'Laptop' }], failed: [{ machineId: 'm4', reason: 'no-known-url' }] } });
  it('the rule', () => {
    expect(local.map(guardNeedsLook)).toEqual([true, false, false, false, false, true, true, false]);
  });
  it('local scope counts this machine only', () => {
    const l = guardsNeedingLook(res, { scope: 'local' });
    expect(l.count).toBe(3);
    expect(l.scopeWords).toBe('on Mac Studio');
    expect(l.breakdownWords).toBe('1 off that should be on · 1 guarding a critical path with nothing on · 1 missing');
    expect(l.rows.map((r) => r.main)).toEqual(['A', 'serving-lease returns to captain', 'G']);
    expect(l.cantTell).toEqual([]);
  });
  it('pool scope adds every machine that answered; the ones that could not are named, never counted', () => {
    const p = guardsNeedingLook(res, { scope: 'pool' });
    expect(p.count).toBe(5);
    expect(p.machines).toBe(2);
    expect(p.scopeWords).toBe('across 2 machines');
    expect(p.cantTell.map((x) => [x.machine, x.words])).toEqual([['Laptop', 'it answered without a list'], ['a machine with no name yet', 'no address known for it']]);
    expect(guardsNeedingLook(res, { scope: 'pool', names: { m4: 'Mama PC' } }).cantTell[1].machine).toBe('Mama PC');
    expect(p.byMachine).toEqual({ 'Mac Studio': 3, 'Mac Mini': 2 });
    expect(p.cantTellWords).toBe('Laptop, a machine with no name yet can’t tell');
  });
  it('a failed read is honest', () => {
    expect(guardsNeedingLook({ ok: false, reason: 'timeout' }).ok).toBe(false);
    expect(guardsNeedingLook(ok({ summary: {} })).ok).toBe(false);
  });
});

describe('machine state: the server liveness wins, the load reading rides along, struggling is one word everywhere', () => {
  it('liveState', () => {
    const base = { machineId: 'm1', nickname: 'Mac Studio', online: true, routerReceivedAt: iso(16), loadAvg: 17, hardware: { cpuCores: 16 } };
    // No liveness: the estimate (over 15 min silent → not answering).
    expect(liveState(base, NOW)).toMatchObject({ state: 'bad', label: 'not answering', estimated: true });
    // Liveness live wins over the heartbeat age; a fresh impaired load makes it struggling on every page.
    expect(liveState({ ...base, liveness: { state: 'live', evidenceAt: iso(0.2), source: 'direct' } }, NOW)).toMatchObject({ state: 'ok', label: 'live', estimated: false, perCore: 17 / 16 });
    expect(liveState({ ...base, liveness: { state: 'live', evidenceAt: iso(0.2) }, loadReport: { loadPerCore: 1.6, verdict: 'impaired' }, loadReportAgeMs: 5_000, loadVerdict: 'impaired' }, NOW)).toMatchObject({ state: 'attn', label: 'struggling', perCore: 1.6 });
    expect(liveState({ ...base, liveness: { state: 'silent', evidenceAt: iso(40) } }, NOW)).toMatchObject({ state: 'bad', label: 'silent' });
    // The server's `unreachable` is read by its shape: a slow or refusing machine is struggling (amber), a silent one is not answering (red).
    expect(liveState({ ...base, liveness: { state: 'unreachable', shape: 'silent', evidenceAt: iso(13) } }, NOW)).toMatchObject({ state: 'bad', label: 'unreachable' });
    expect(liveState({ ...base, liveness: { state: 'unreachable', shape: 'struggling', evidenceAt: iso(1) } }, NOW)).toMatchObject({ state: 'attn', label: 'struggling' });
    expect(JSON.stringify(liveState({ ...base, liveness: { state: 'unreachable', shape: 'silent' } }, NOW))).not.toMatch(/offline/i);
  });
});

describe('load: one reading per machine', () => {
  it('the fresh server report wins, the load average is a labelled estimate, else no reading', () => {
    expect(loadOf({ loadReport: { loadPerCore: 1.15, verdict: 'ok' }, loadReportAgeMs: 21_000, loadVerdict: 'ok', loadAvg: 17.6, hardware: { cpuCores: 16 } }, NOW)).toMatchObject({ perCore: 1.15, verdict: 'ok', source: 'report', estimated: false });
    expect(loadOf({ loadReport: { loadPerCore: 1.75, verdict: 'saturated' }, loadReportAgeMs: 10_000, loadVerdict: 'saturated' }, NOW)).toMatchObject({ verdict: 'overloaded', source: 'report' });
    expect(loadOf({ loadReport: { loadPerCore: 1.75, verdict: 'ok' }, loadReportAgeMs: 120_000, loadAvg: 7.8, hardware: { cpuCores: null } }, NOW)).toMatchObject({ perCore: null, source: null, words: 'no load reading' });
    expect(loadOf({ loadAvg: 64, hardware: { cpuCores: 16 } }, NOW)).toMatchObject({ perCore: 4, verdict: 'overloaded', source: 'estimate', estimated: true });
    expect(loadOf({ loadReport: { loadPerCore: 0.2, verdict: 'unknown' }, loadReportAgeMs: 5_000, loadVerdict: 'unknown' }, NOW)).toMatchObject({ perCore: 0.2, verdict: 'ok', source: 'report' });
  });
});

describe('problems: identical ones fold, repeating means seen more than once', () => {
  it('groups by category + summary, open first, counts every record’s occurrences', () => {
    const f = (id: string, summary: string, n: number, status = 'open', h = 1) => ({ id, category: 'unknown', summary, occurrenceCount: n, status, detectedAt: iso(h * 60) });
    const g = groupFailures([f('a', 'CI CI failure', 1), f('b', 'CI Publish to npm failure', 5, 'resolved', 30), f('c', 'CI Publish to npm failure', 5, 'resolved', 50), f('d', 'CI CI failure', 3, 'open', 10), f('e', 'one-off', 1)]);
    expect(g.groups.map((x) => [x.top.summary, x.times, x.open, x.repeating])).toEqual([['CI CI failure', 4, true, true], ['one-off', 1, true, false], ['CI Publish to npm failure', 10, false, true]]);
    expect(g.repeating).toHaveLength(2);
  });
});

describe('needsYou: one deduplicated list across sources', () => {
  const promise = (over: Record<string, unknown>) => promiseNeed(c({ owner: 'user', blockedOn: 'user-authorization', ...over }), NOW);
  it('folds a promise into the PR, attention item or account cell it is about; labels a mixed list by kind', () => {
    const attention = attentionNeeds([{ id: 'agent:echo-disk-cleanup-2026-10-23', title: 'Approve clearing 51 worktrees', status: 'OPEN', priority: 'HIGH', source: 'agent', createdAt: iso(30) }], NOW).all;
    const prs = prsNeedingYou({ snapshot: { at: NOW, entries: [{ pr: 2350, kind: 'code-owner-review' }] } }, NOW);
    const accounts = accountNeeds([{ id: 'luna', email: 'luna@x.io', nickname: 'Luna', status: 'needs-reauth', machineId: 'm2', machineNickname: 'Mac Mini' }], [{ accountId: 'luna', machineId: 'm2', state: 'suggested', mode: 'approval', updatedAt: iso(1) }], { now: NOW }).tap;
    const promises = [
      promise({ agentResponse: 'merge PR 2350 only after Justin confirms' }),
      promise({ agentResponse: 'After Justin approves attention item agent:echo-disk-cleanup-2026-10-23, clear 51 worktrees' }),
      promise({ agentResponse: 'Sign luna@x.io back in on Mac Mini once you tap approve' }),
      promise({ agentResponse: 'Which of the four agent servers matter least?', blockedOn: 'user-input' }),
    ];
    const list = needsYou({ attention: { state: 'ok', items: attention }, prs: { state: 'ok', items: prs }, accounts: { state: 'ok', items: accounts }, promises: { state: 'ok', items: promises } }, NOW);
    expect(list.count).toBe(4);
    expect(list.items.map((i) => i.kind).sort()).toEqual(['account', 'attention', 'pr', 'promise']);
    expect(list.items.find((i) => i.kind === 'pr')!.also).toHaveLength(1);
    expect(list.items.find((i) => i.kind === 'attention')!.also).toHaveLength(1);
    expect(list.items.find((i) => i.kind === 'account')!.also).toHaveLength(1);
    expect(list.label).toBe('4 things: 1 notice, 1 review, 1 sign-in, 1 answer');
    expect(list.complete).toBe(true);
  });
  it('a loading or failed source is pending or named, never a silent zero; an off source is not a failure', () => {
    const l = needsYou({ attention: { state: 'loading' }, promises: { state: 'ok', items: [] }, accounts: { state: 'off' }, prs: { state: 'failed', reason: 'timeout' } }, NOW);
    expect(l.pending).toEqual(['attention']);
    expect(l.failed).toEqual([{ source: 'prs', what: 'the merge watcher', why: 'timeout' }]);
    expect(l.off).toEqual(['accounts']);
    expect(l.complete).toBe(false);
    expect(readState({ ok: false, reason: 'switched off on this agent' })).toBe('off');
    expect(readState({ ok: false, status: 503 })).toBe('off');
    expect(readState({ ok: false, reason: 'x' })).toBe('failed');
  });
});

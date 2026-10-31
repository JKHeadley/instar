/**
 * Console Home view-models (docs/specs/console-makeover.md §1, "Design rule").
 *
 * The rule under test: a value that could not be read says so; it never renders
 * as fine. Each builder is exercised on both sides of every decision boundary:
 * HTTP failure, timeout, a 200 with the feature disabled, a 200 with fields
 * missing, partial pool coverage, stale evidence, and the healthy case.
 */
import { describe, it, expect } from 'vitest';
import {
  failure, ago, buildNeeds, buildDoing, buildPromised, buildRunning, buildAllowed,
  machineState, headline, needsOperator, isActiveCommitment, sessionLabel, MAX_ROWS,
  combineNeeds, machineNames, machineLabel,
} from '../../dashboard/console/home-model.js';

const NOW = Date.parse('2026-10-25T23:30:00Z');
const ok = (data: unknown) => ({ ok: true, data });
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

describe('ago()', () => {
  it('formats minutes, hours and days, and refuses junk', () => {
    expect(ago(minsAgo(0.2), NOW)).toBe('just now');
    expect(ago(minsAgo(7), NOW)).toBe('7 min ago');
    expect(ago(minsAgo(180), NOW)).toBe('3 h ago');
    expect(ago(minsAgo(60 * 24 * 5), NOW)).toBe('5 d ago');
    expect(ago('not a date', NOW)).toBeNull();
  });
});

describe('What needs you', () => {
  const item = (over: Record<string, unknown>) => ({ id: Math.random().toString(36), title: 'T', status: 'OPEN', priority: 'HIGH', createdAt: minsAgo(5), ...over });

  it('fails honestly', () => {
    expect(buildNeeds(failure('the server answered 500'), NOW).state).toBe('unknown');
    expect(buildNeeds(ok({ count: 3 }), NOW).state).toBe('unknown');
  });
  it('separates what needs the operator from routine automated notices', () => {
    expect(needsOperator(item({ priority: 'URGENT' }))).toBe(true);
    expect(needsOperator(item({ source: 'agent' }))).toBe(true);
    expect(needsOperator(item({ category: 'telegram-origin' }))).toBe(false);
    const m = buildNeeds(ok({ items: [item({ priority: 'URGENT' }), item({}), item({}), item({ status: 'DONE', priority: 'URGENT' })], pool: { failed: [] } }), NOW);
    expect(m.state).toBe('attn');
    expect(m.value).toBe('1 thing');
    expect(m.line).not.toMatch(/notice/); // routine items ask nothing of the operator: not on the front page
  });
  it('shows at most three rows but keeps the full list for See all, newest first', () => {
    const items = [1, 2, 3, 4, 5].map((n) => item({ priority: 'URGENT', title: `i${n}`, createdAt: minsAgo(n * 10) }));
    const m = buildNeeds(ok({ items, pool: { failed: [] } }), NOW);
    expect(m.rows).toHaveLength(MAX_ROWS);
    expect(m.all).toHaveLength(5);
    expect(m.rows[0].main).toBe('i1');
  });
  it('a pool read with a dark peer is partial and names the peer', () => {
    const m = buildNeeds(ok({ items: [], pool: { failed: [{ machineId: 'm1', nickname: 'Mama PC' }] } }), NOW);
    expect(m.state).toBe('partial');
    expect(m.line).toContain('Mama PC');
  });
  it('the same notice raised many times, on several machines, is one thing to do', () => {
    const items = [1, 2, 3].map((n) => item({ title: 'Claude Code sign-in repair', category: 'subscription-relogin', source: 'agent', machineNickname: n === 1 ? 'Mac Mini' : 'Mac Studio' }));
    const m = buildNeeds(ok({ items, pool: { failed: [] } }), NOW);
    expect(m.count).toBe(1);
    expect(m.rows[0].sub).toContain('3 copies');
  });
  it('an item untouched for 14+ days is not counted as needing you, but stays listed', () => {
    const m = buildNeeds(ok({ items: [item({ priority: 'URGENT', title: 'old', createdAt: minsAgo(60 * 24 * 20) }), item({ priority: 'URGENT', title: 'new' })], pool: { failed: [] } }), NOW);
    expect(m.count).toBe(1);
    expect(m.all).toHaveLength(2);
    expect(m.all[1].main).toBe('old');
    expect(m.line).not.toMatch(/14\+ days/);
  });
  it('a security item never ages out', () => {
    const m = buildNeeds(ok({ items: [item({ category: 'security', source: 'agent', title: 'Rotate token', createdAt: minsAgo(60 * 24 * 40) })], pool: { failed: [] } }), NOW);
    expect(m.count).toBe(1);
  });
  it('an empty, complete queue is fine', () => {
    expect(buildNeeds(ok({ items: [], pool: { failed: [] } }), NOW).state).toBe('ok');
  });
});

describe('What I am doing', () => {
  const s = (over: Record<string, unknown>) => ({ name: 'Fix the dashboard', status: 'running', startedAt: minsAgo(20), machineNickname: 'Mac Studio', ...over });

  it('fails honestly', () => {
    expect(buildDoing(failure('x'), NOW).state).toBe('unknown');
    expect(buildDoing(ok({}), NOW).state).toBe('unknown');
  });
  it('never presents the initial prompt as the latest action', () => {
    const m = buildDoing(ok({ sessions: [s({ prompt: '[IMPORTANT: Read /path/bootstrap.txt]', telemetry: { lastActivity: minsAgo(2) } })], pool: { failed: [] } }), NOW);
    expect(JSON.stringify(m.rows)).not.toContain('bootstrap');
    expect(m.rows[0].end).toBe('active 2 min ago');
  });
  it('names an unreachable peer instead of dropping it', () => {
    const m = buildDoing(ok({ sessions: [s({})], pool: { failed: [{ nickname: 'Laptop' }] } }), NOW);
    expect(m.state).toBe('partial');
    expect(m.line).toContain('Laptop');
  });
  it('ignores finished sessions and counts machines', () => {
    const m = buildDoing(ok({ sessions: [s({}), s({ machineNickname: 'Mac Mini' }), s({ status: 'completed' })], pool: { failed: [] } }), NOW);
    expect(m.value).toBe('2 sessions');
    expect(m.line).toContain('2 machines');
  });
  it('cleans a bracketed prefix from a session name', () => {
    expect(sessionLabel({ name: '[auto] Nightly digest' })).toBe('Nightly digest');
  });
});

describe('What I have promised', () => {
  const c = (over: Record<string, unknown>) => ({ id: 'CMT-1', status: 'pending', owner: 'agent', blockedOn: 'none', createdAt: minsAgo(60), agentResponse: 'Do X', ...over });

  it('fails honestly, including a disabled tracker', () => {
    expect(buildPromised(failure('x'), NOW).state).toBe('unknown');
    expect(buildPromised(ok({ enabled: false, commitments: [] }), NOW).state).toBe('unknown');
  });
  it('applies the tracker active rule to every row, including replicas', () => {
    expect(isActiveCommitment(c({ status: 'violated' }), NOW)).toBe(true);
    expect(isActiveCommitment(c({ status: 'delivered' }), NOW)).toBe(false);
    expect(isActiveCommitment(c({ expiresAt: minsAgo(1) }), NOW)).toBe(false);
  });
  it('a remote violated promise is not hidden', () => {
    const m = buildPromised(ok({ enabled: true, scope: 'mesh', commitments: [c({ status: 'violated', viewSource: 'replica', originMachineId: 'm2', stalenessMs: 60_000 })] }), NOW);
    expect(m.state).toBe('bad');
    expect(m.rows[0].sub).toContain('another machine');
  });
  it('a promise waiting on the operator but untouched for 14+ days is not counted', () => {
    const m = buildPromised(ok({ enabled: true, scope: 'mesh', commitments: [c({ blockedOn: 'user-input', createdAt: minsAgo(60 * 24 * 30) })] }), NOW, 0);
    expect(m.count).toBe(0);
    expect(m.line).toBe('Nothing recent waiting on you.');
  });
  it('promises waiting on the operator lead', () => {
    const m = buildPromised(ok({ enabled: true, scope: 'mesh', commitments: [c({}), c({ blockedOn: 'user-authorization' }), c({ owner: 'user', blockedOn: 'user-input' })] }), NOW);
    expect(m.state).toBe('attn');
    expect(m.value).toBe('2 waiting on you');
  });
  it('without replica rows it says only this machine is visible', () => {
    const m = buildPromised(ok({ enabled: true, scope: 'mesh', commitments: [c({ viewSource: 'own' })] }), NOW);
    expect(m.state).toBe('partial');
    expect(m.note).toContain('Only this machine');
  });
  it('a replica with no age is unknown freshness, never "All quiet" (round-4 blocker)', () => {
    const m = buildPromised(ok({ enabled: true, scope: 'mesh', commitments: [c({ viewSource: 'replica', originMachineId: 'm2' })] }), NOW, 1);
    expect(m.coverage).toBe('partial view');
    expect(headline({ needs: { state: 'ok', value: '', count: 0 }, promised: m }).text).not.toBe('All quiet.');
  });
  it('coverage is verified only when every other machine is represented', () => {
    const rows = [c({ viewSource: 'replica', originMachineId: 'm2', stalenessMs: 1000 })];
    expect(buildPromised(ok({ enabled: true, scope: 'mesh', commitments: rows }), NOW, 3).note).toContain('2 machines not represented');
    expect(buildPromised(ok({ enabled: true, scope: 'mesh', commitments: rows }), NOW, null).note).toContain('unverified');
    const full = buildPromised(ok({ enabled: true, scope: 'mesh', commitments: rows }), NOW, 1);
    expect(full.coverage).toBeNull();
    expect(full.state).toBe('ok');
  });
  it('an old replica is flagged out of date', () => {
    const m = buildPromised(ok({ enabled: true, scope: 'mesh', commitments: [c({ viewSource: 'replica', originMachineId: 'm2', stalenessMs: 60 * 60_000 })] }), NOW);
    expect(m.note).toContain('out of date');
  });
});

describe('Where I am running: machineState precedence', () => {
  const base = { nickname: 'Mama PC', online: true, routerReceivedAt: minsAgo(0.5), loadAvg: 4, hardware: { cpuCores: 16 } };

  it('an explicit peer-offline rope signal beats a recent heartbeat', () => {
    expect(machineState({ ...base, ropeCondition: 'peer-offline' }, NOW).label).toBe('unreachable');
  });
  it('no timestamp at all is no reading, never live', () => {
    expect(machineState({ ...base, routerReceivedAt: undefined }, NOW).state).toBe('unknown');
  });
  it('silence over 15 min is not answering; over 2 min is quiet', () => {
    expect(machineState({ ...base, routerReceivedAt: minsAgo(16) }, NOW).label).toBe('not answering');
    expect(machineState({ ...base, routerReceivedAt: minsAgo(3) }, NOW).label).toBe('quiet');
  });
  it('stale evidence never supports a present-tense overload diagnosis', () => {
    expect(machineState({ ...base, routerReceivedAt: minsAgo(3), loadAvg: 64 }, NOW).label).toBe('quiet');
  });
  it('fresh heavy load is struggling, not dead and not fine', () => {
    expect(machineState({ ...base, loadAvg: 64 }, NOW).label).toBe('struggling');
    expect(machineState({ ...base, ropeCondition: 'degraded' }, NOW).label).toBe('struggling');
  });
  it('fresh and calm is live', () => {
    expect(machineState(base, NOW).label).toBe('live');
  });
  it('the card counts states and fails honestly', () => {
    expect(buildRunning(failure('x'), NOW).state).toBe('unknown');
    const m = buildRunning(ok({ machines: [base, { ...base, nickname: 'Laptop', loadAvg: 64 }] }), NOW);
    expect(m.value).toBe('1 of 2 live');
    expect(m.state).toBe('attn');
  });
});

describe('What I am allowed to do', () => {
  const summary = { onConfirmed: 20, onUnverified: 50, onStale: 0, onBlind: 0, onDryRun: 7, off: 19, offDeviant: 7, offDarkDefault: 12, offRuntimeDivergent: 0, errored: 0, missing: 1, loadBearingGapKeys: ['a', 'b'] };
  const guards = [
    { key: 'a.enabled', effective: 'off', offClass: 'diverged-from-default' },
    { key: 'b.enabled', effective: 'off', offClass: 'dark-default' },
    { key: 'c.enabled', effective: 'on-confirmed' },
  ];

  it('reads the server summary, never recomputes it from string fields', () => {
    const m = buildAllowed(ok({ summary, guards }), ok({ mandates: [] }), NOW);
    expect(m.value).toBe('70 of 97 on');
    expect(m.state).toBe('attn');
  });
  it('lists the guards that are not on, deviants before by-design', () => {
    const m = buildAllowed(ok({ summary, guards }), ok({ mandates: [] }), NOW);
    expect(m.all.map((r: { sub?: string; main: string }) => r.main)).toEqual(['a.enabled', 'b.enabled']);
    expect(m.all[1].end).toBe('off by design');
  });
  it('a failed mandate read is partial, not zero', () => {
    const m = buildAllowed(ok({ summary, guards }), failure('x'), NOW);
    expect(JSON.stringify(m.rows)).toContain("Can't tell which permission slips");
  });
  it('a summary missing its counts is not "0 of 0 on"', () => {
    expect(buildAllowed(ok({ summary: {} }), ok({}), NOW).state).toBe('unknown');
  });
  it('a failed mandate read makes the card a partial view when nothing else needs you', () => {
    const calm = { onConfirmed: 9, onUnverified: 0, onStale: 0, onBlind: 0, onDryRun: 0, offDeviant: 0, offDarkDefault: 1, offRuntimeDivergent: 0, errored: 0, missing: 0 };
    const m = buildAllowed(ok({ summary: calm, guards: [] }), failure('x'), NOW);
    expect(m.state).toBe('partial');
    expect(m.coverage).toBe('partial view');
  });
  it('every field used in the total is required', () => {
    const { onStale, ...partialSummary } = summary;
    void onStale;
    expect(buildAllowed(ok({ summary: partialSummary, guards }), ok({ mandates: [] }), NOW).state).toBe('unknown');
  });
  it('a failed guard read keeps the mandate reading', () => {
    const m = buildAllowed(failure('x'), ok({ mandates: [] }), NOW);
    expect(m.state).toBe('unknown');
    expect(m.rows[0].main).toBe('0 permission slips active');
  });
  it('fails honestly without a summary', () => {
    expect(buildAllowed(failure('x'), ok({}), NOW).state).toBe('unknown');
    expect(buildAllowed(ok({ guards: [] }), ok({}), NOW).state).toBe('unknown');
  });
});

describe('headline()', () => {
  const card = (state: string, value = '', count?: number) => ({ state, value, count });

  it('waits for both counting cards before announcing anything', () => {
    expect(headline({ needs: card('loading'), promised: card('attn', '3 need you', 3), doing: card('ok') }).text).toBe('Checking in…');
  });
  it('sums what needs the operator', () => {
    expect(headline({ needs: card('attn', '2 things', 2), promised: card('attn', '1 need you', 1), doing: card('ok') }).text).toBe('3 things need you.');
  });
  it('never says all quiet while a card cannot tell', () => {
    const h = headline({ needs: card('ok'), promised: card('ok'), doing: card('unknown') });
    expect(h.text).toBe('Nothing urgent that I can see.');
    expect(h.tone).toBe('muted');
    expect(h.sub).toMatch(/can't fully see/i);
  });
  it('a partial-coverage card blocks "all quiet" even when its state is ok', () => {
    expect(headline({ needs: card('ok'), promised: { state: 'ok', value: '', coverage: 'partial view' } }).text).not.toBe('All quiet.');
  });
  it('attention outside the two queues is still announced', () => {
    expect(headline({ needs: card('ok'), promised: card('ok'), allowed: card('attn', '70 of 99 on') }).text).toBe('One area needs a look.');
  });
  it('a known total keeps its coverage qualification', () => {
    expect(headline({ needs: card('attn', '2 things', 2), promised: card('unknown') }).sub).toMatch(/can't fully see/i);
  });
  it('a partial queue keeps its known urgency in the headline (round-4 blocker)', () => {
    const n = buildNeeds(ok({ items: [{ id: 'a', title: 'T', status: 'OPEN', priority: 'URGENT', createdAt: minsAgo(1) }], pool: { failed: [{ nickname: 'Laptop' }] } }), NOW);
    expect(n.state).toBe('partial');
    const h = headline({ needs: n, promised: card('ok', '', 0), doing: card('ok') });
    expect(h.text).toBe('One thing needs you.');
    expect(h.sub).toMatch(/can't fully see/i);
  });
  it('all quiet only when everything is known and fine', () => {
    expect(headline({ needs: card('ok'), promised: card('ok'), doing: card('ok') }).text).toBe('All quiet.');
  });
});

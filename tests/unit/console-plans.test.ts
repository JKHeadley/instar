/**
 * Console Plans page (docs/specs/console-features/work.md: Projects + Initiatives +
 * Blockers): every decision in the model on both sides, and the shipped page in
 * jsdom (In the way above In flight, the project sheet, Stop this round through
 * its confirm, Resume with that round's index).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  buildPlansPage, buildInTheWay, buildAutonomousRuns, projectNeedsOk, currentRoundIndex, projectLine, initiativeLine, needsYouWords,
  roundWord, roundsTrack, projectActions, resultWords, refusalWords, driftSentence, blockerRow, blockerStory, linkChips, stepList, autonomousRow, OLDER_MS, MOVING_MS,
} from '../../dashboard/console/plans-model.js';
import { NATIVE_PAGES, tabHref } from '../../dashboard/console/nav-model.js';

const NOW = Date.parse('2026-10-25T23:30:00Z');
const ok = (data: unknown) => ({ ok: true, data });
const daysAgo = (d: number) => new Date(NOW - d * 86400000).toISOString();
const minsAgo = (m: number) => new Date(NOW - m * 60000).toISOString();

const init = (over: Record<string, unknown> = {}) => ({ id: `i-${Math.random().toString(36).slice(2, 7)}`, title: 'Telegram issues group', description: 'd', status: 'active', kind: 'task',
  phases: [{ id: 'a', name: 'Design', status: 'done', completedAt: daysAgo(3) }, { id: 'b', name: 'Build', status: 'in-progress', startedAt: daysAgo(1) }, { id: 'c', name: 'Ship', status: 'pending' }],
  currentPhaseIndex: 1, lastTouchedAt: minsAgo(120), needsUser: false, blockers: [], links: [], createdAt: daysAgo(5), updatedAt: minsAgo(120), ...over });
const round = (over: Record<string, unknown> = {}) => ({ name: 'Home screen', itemIds: [], status: 'pending', ...over });
const project = (over: Record<string, unknown> = {}) => init({ id: 'console-makeover', title: 'Console makeover', kind: 'project', firstLaunchAckAt: daysAgo(4),
  rounds: [round({ name: 'Home', status: 'complete', itemIds: ['c1'] }), round({ name: 'Work group', status: 'in-progress', itemIds: ['c2', 'c3', 'c4'] }), round({ name: 'Capacity' }), round({ name: 'Switch-over' })], ...over });
const child = (id: string, stage: string, over: Record<string, unknown> = {}) => init({ id, title: `Piece ${id}`, parentProjectId: 'console-makeover', pipelineStage: stage, ...over });
const detail = (p: Record<string, unknown>, children: unknown[]) => ({ [p.id as string]: ok({ project: p, children }) });
const blocker = (over: Record<string, unknown> = {}) => ({ id: `B-${Math.random().toString(36).slice(2, 6)}`, version: 1, state: 'dry-run', detectedText: 'Vercel token expired', origin: 'sess', createdAt: daysAgo(2), updatedAt: minsAgo(30), history: [], ...over });
const full = (over: Record<string, unknown> = {}) => ({ initiatives: ok({ items: [], count: 0 }), digest: ok({ items: [] }), projects: ok({ items: [], count: 0 }), details: {}, blockers: ok({ entries: [], total: 0 }), floor: { ok: false, reason: 'switched off on this agent' }, ...over });

describe('plans page model — honesty', () => {
  it('fails honestly, and tells tracker-off from a failed read', () => {
    expect(buildPlansPage(full({ initiatives: { ok: false, reason: 'no answer within 5 seconds' } }), NOW).reason).toContain('no answer within 5 seconds');
    expect(buildPlansPage(full({ initiatives: { ok: false, reason: 'switched off on this agent' } }), NOW).reason).toBe('Plan tracking is off on this agent.');
    expect(buildPlansPage(full({ initiatives: ok({ nope: 1 }) }), NOW).reason).toContain('without records');
  });

  it('is empty in words when nothing is running', () => {
    const p = buildPlansPage(full(), NOW);
    expect(p.ok).toBe(true);
    expect(p.headline).toBe('No longer plans are running.');
    expect(p.sub).toContain('Plans on this machine.');
  });

  it('a failed digest is a note, never a fabricated zero; needs-you still comes from the records', () => {
    const p = buildPlansPage(full({ initiatives: ok({ items: [init({ needsUser: true, needsUserReason: 'pick a name' })] }), digest: { ok: false, reason: 'the server answered 500' } }), NOW);
    expect(p.notes.some((n: string) => n.includes("Couldn't read the check-in digest"))).toBe(true);
    expect(p.counts.needsYou).toBe(1);
    expect(p.sections.needsYou[0].needs).toBe('Waiting on you: pick a name');
  });

  it('the In the way fact says Can’t tell when blockers failed, off when tracking is off, a count when read', () => {
    const items = [init()];
    expect(buildPlansPage(full({ initiatives: ok({ items }), blockers: { ok: false, reason: 'the server answered 500' } }), NOW).facts[1].n).toBe('Can’t tell');
    expect(buildPlansPage(full({ initiatives: ok({ items }), blockers: { ok: false, reason: 'switched off on this agent' } }), NOW).facts[1].n).toBe('off');
    expect(buildPlansPage(full({ initiatives: ok({ items }), blockers: ok({ entries: [blocker({ state: 'true-blocker' })], total: 1 }) }), NOW).facts[1]).toMatchObject({ n: 1, tone: 'bad' });
  });
});

describe('plans page model — sorting', () => {
  it('needs you first: needsUser, awaiting-user, a project waiting for its OK, a blocker that asked for access', () => {
    const p1 = project({ unacknowledgedAdvanceCount: 1 });
    const items = [init({ needsUser: true, needsUserReason: 'approve the copy' }), init({ status: 'awaiting-user' }), p1, init()];
    const page = buildPlansPage(full({ initiatives: ok({ items }), projects: ok({ items: [p1] }), details: detail(p1, []), blockers: ok({ entries: [blocker({ state: 'access-requested', detectedText: 'Need Cloudflare' })], total: 1 }) }), NOW);
    expect(page.counts.needsYou).toBe(4);
    const needs = page.sections.needsYou.map((r: { needs: string }) => r.needs);
    expect(needs).toContain('Waiting on you: approve the copy');
    expect(needs).toContain('Waiting on you');
    expect(needs).toContain('Waiting for your OK on round 2');
    expect(needs).toContain('I need access to continue');
    expect(page.headline).toBe('4 plans in flight. 4 need you.'); // the blocker is counted as needing you, not as a plan
    expect(page.tone).toBe('attn');
  });

  it('moving within 7 days, idle after, and "Older, still open" at 14+ days — never counted as handled', () => {
    const items = [init({ lastTouchedAt: minsAgo(5), updatedAt: minsAgo(5) }), init({ lastTouchedAt: daysAgo(9), updatedAt: daysAgo(9) }), init({ lastTouchedAt: daysAgo(20), updatedAt: daysAgo(20) }), init({ lastTouchedAt: daysAgo(30), updatedAt: daysAgo(30), needsUser: true })];
    const p = buildPlansPage(full({ initiatives: ok({ items }) }), NOW);
    expect(p.counts).toMatchObject({ inFlight: 1, idle: 1, older: 2, olderNeedsYou: 1, needsYou: 0 });
    expect(p.headline).toBe('2 plans in flight.');
    expect(p.sub).toContain('2 older, still open.');
    expect(p.sections.older.find((r: { needs: string }) => r.needs)!.needs).toBe('Waiting on you');
    expect(JSON.stringify(p)).not.toMatch(/handled/i);
    expect(OLDER_MS).toBeGreaterThan(MOVING_MS);
  });

  it('children fold under a parent that is listed, and stay their own row when it is not', () => {
    const p1 = project();
    const kids = [child('c2', 'building'), child('c3', 'spec-drafted'), child('c4', 'merged')];
    const page = buildPlansPage(full({ initiatives: ok({ items: [p1, ...kids, child('orphan', 'outline', { parentProjectId: 'gone' })] }), projects: ok({ items: [p1] }), details: detail(p1, kids) }), NOW);
    const mains = [...page.sections.inFlight].map((r: { main: string }) => r.main);
    expect(mains).toEqual(expect.arrayContaining(['Console makeover', 'Piece orphan']));
    expect(mains).not.toContain('Piece c2');
    expect(page.sections.inFlight.find((r: { type: string }) => r.type === 'project')!.sub).toBe('round 2 of 4 · 1 of 3 pieces merged · running · worked on 2 h ago');
  });

  it('finished plans are collapsed with Completed / Archived / Abandoned chips, and the status chips show only states present', () => {
    const items = [init({ status: 'completed' }), init({ status: 'archived' }), init({ status: 'paused' }), init({ status: 'halted' })];
    const p = buildPlansPage(full({ initiatives: ok({ items }) }), NOW);
    expect(p.doneChips.map((c: { key: string; n: number }) => [c.key, c.n])).toEqual([['completed', 1], ['archived', 1]]);
    expect(p.chips.map((c: { key: string }) => c.key)).toEqual(['paused', 'halted']);
    const filtered = buildPlansPage(full({ initiatives: ok({ items }) }), NOW, { filter: { status: 'paused', done: 'archived' } });
    expect(filtered.sections.inFlight.map((r: { status: string }) => r.status)).toEqual(['paused']);
    expect(filtered.sections.finished.map((r: { status: string }) => r.status)).toEqual(['archived']);
    expect(filtered.chips.find((c: { key: string }) => c.key === 'paused')!.on).toBe(true);
    expect(filtered.counts.inFlight).toBe(2); // counts are of the whole list, not the filtered view
  });

  it('a project whose detail read failed keeps its row and says so; others render', () => {
    const p1 = project(); const p2 = project({ id: 'second', title: 'Second' });
    const page = buildPlansPage(full({ initiatives: ok({ items: [p1, p2] }), projects: ok({ items: [p1, p2] }), details: { ...detail(p1, []), second: { ok: false, reason: 'the server answered 500' } } }), NOW);
    expect(page.sections.inFlight.find((r: { id: string }) => r.id === 'second')!.sub).toContain("Couldn't load its rounds");
    expect(page.sections.inFlight.find((r: { id: string }) => r.id === 'console-makeover')!.sub).toContain('round 2 of 4');
  });

  it('says when more projects exist than it loaded detail for', () => {
    const many = Array.from({ length: 27 }, (_, i) => project({ id: `p${i}`, title: `P${i}` }));
    const page = buildPlansPage(full({ initiatives: ok({ items: many }), projects: ok({ items: many }) }), NOW);
    expect(page.sub).toContain('25 of 27 projects');
  });
});

describe('project decisions', () => {
  it('waits for an OK on an unacknowledged advance or an un-acked first launch, not otherwise', () => {
    expect(projectNeedsOk(project({ unacknowledgedAdvanceCount: 1 }))).toBe(true);
    expect(projectNeedsOk(project({ firstLaunchAckAt: undefined, rounds: [round(), round()] }))).toBe(true);
    expect(projectNeedsOk(project())).toBe(false);
    expect(projectNeedsOk(project({ status: 'completed', unacknowledgedAdvanceCount: 1 }))).toBe(false);
    expect(needsYouWords(project({ firstLaunchAckAt: undefined, rounds: [round(), round()] }), null)).toBe('Waiting for your OK on round 1');
  });

  it('the current round is the first not done; the line reads in words', () => {
    expect(currentRoundIndex(project())).toBe(1);
    expect(currentRoundIndex(project({ rounds: [round({ status: 'complete' })] }))).toBe(-1);
    expect(projectLine(project({ rounds: [round({ status: 'complete-with-skips' })] }), [], NOW)).toContain('all 1 rounds done');
    expect(projectLine(project({ status: 'paused' }), [], NOW)).toContain('paused');
    expect(initiativeLine(init({ feedbackWorkKey: 'feedback-work:x' }), NOW)).toBe('step 2 of 3 · from user feedback · worked on 2 h ago');
  });

  it('says "running" only when a read shows the round in progress; a halted round is "stopped"', () => {
    expect(roundWord({ status: 'in-progress' })).toBe('running');
    expect(roundWord({ status: 'pending', autoAdvanceAt: minsAgo(1) })).toBe('not started');
    expect(roundWord({ status: 'in-progress', haltedAt: minsAgo(1) })).toBe('stopped');
    expect(roundWord({ status: 'failed' })).toBe('failed');
  });

  it('offers OK with the CURRENT round, Resume with THAT round’s index, Stop only on a round that is not stopped', () => {
    const p = project({ unacknowledgedAdvanceCount: 1, rounds: [round({ status: 'complete' }), round({ status: 'failed' }), round({ status: 'in-progress', haltedAt: minsAgo(5) }), round()] });
    expect(projectActions(p)).toEqual({ ack: 1, stop: null, resume: [1, 2] });
    expect(projectActions(project())).toEqual({ ack: null, stop: 1, resume: [] });
    expect(projectActions(project({ status: 'abandoned' }))).toEqual({ ack: null, stop: null, resume: [] });
  });

  it('the three answers are told apart by what the server returned', () => {
    expect(resultWords('ack', { lastAckedRoundIndex: 1 })).toContain('Your OK is recorded');
    expect(resultWords('ack', { lastAckedRoundIndex: 1 })).not.toMatch(/running/i);
    expect(resultWords('resume', { scheduledAt: minsAgo(0) })).toContain('Scheduled to resume');
    expect(resultWords('stop', { roundIndex: 1 })).toBe('Stop requested for round 2. It shows as stopped once the next read confirms it.');
  });

  it('refusals keep the server’s meaning; only a version conflict means refresh', () => {
    expect(refusalWords('version mismatch')).toEqual({ text: 'Changed while you looked; refreshed.', refresh: true });
    expect(refusalWords('project has no halt-able round').text).toContain('Nothing to stop');
    expect(refusalWords('round is not halted or failed').refresh).toBe(false);
    expect(refusalWords('round at resume-attempts cap; pass {force:true} to override').text).toContain('retry limit');
    expect(refusalWords('ProjectRoundRunner not configured').text).toContain('off on this agent');
    expect(refusalWords('something else').text).toBe('something else');
  });

  it('reads drift as a sentence with a tone', () => {
    expect(driftSentence({ lastDriftVerdict: { verdict: 'no-drift' } })).toEqual({ text: 'Last check: the plan still holds.', tone: 'ok' });
    expect(driftSentence({ lastDriftVerdict: { verdict: 'premise-violated' } }).tone).toBe('bad');
    expect(driftSentence({ lastDriftVerdict: { verdict: 'manual-review-required', reason: 'over-budget' } })).toEqual({ text: 'Needs a human look (over budget).', tone: 'unknown' });
    expect(driftSentence({})).toMatchObject({ tone: 'unknown' });
  });

  it('builds the rounds track with plain-word piece chips', () => {
    const t = roundsTrack(project(), [child('c2', 'building'), child('c3', 'spec-drafted'), child('c4', 'merged')]);
    expect(t.map((r) => r.state)).toEqual(['done', 'current', 'future', 'future']);
    expect(t[1].pieces.chips.map((c) => `${c.n} ${c.word}`)).toEqual(['1 merged', '1 being built', '1 written up']);
    expect(t[1].items[0].stage).toBe('being built');
  });

  it('links become chips; a topic ref resolves through the given link maker', () => {
    const chips = linkChips(init({ links: [{ type: 'pr', label: 'PR 12', url: 'https://github.com/x/y/pull/12' }, { type: 'topic', label: 'Thread', ref: '9210' }, { type: 'spec', label: 'Spec', ref: 'docs/a.md' }], telegramTopicId: '55' }), (id: string) => `https://t.me/c/1/${id}`);
    expect(chips.map((c) => [c.label, c.href])).toEqual([['Its conversation', 'https://t.me/c/1/55'], ['PR 12', 'https://github.com/x/y/pull/12'], ['Thread', 'https://t.me/c/1/9210'], ['Spec (docs/a.md)', null]]);
    expect(stepList(init(), NOW).map((s) => [s.done, s.current, s.when])).toEqual([[true, false, 'done 3 d ago'], [false, true, 'started 24 h ago'], [false, false, '']]);
  });
});

describe('in the way (blockers)', () => {
  it('tells off from failed from empty', () => {
    expect(buildInTheWay({ ok: false, reason: 'switched off on this agent' }, NOW)).toMatchObject({ state: 'off', reason: 'Blocker tracking is off on this agent.' });
    expect(buildInTheWay({ ok: false, reason: 'the server answered 500' }, NOW).state).toBe('failed');
    expect(buildInTheWay(ok({ nope: 1 }), NOW).state).toBe('failed');
    expect(buildInTheWay(ok({ entries: [], total: 0 }), NOW)).toMatchObject({ state: 'ok', stuck: [], working: [] });
  });

  it('sorts stuck, working, access-requested and cleared (this week vs older) — resolved never pads the front', () => {
    const w = buildInTheWay(ok({ entries: [
      blocker({ state: 'true-blocker', terminal: { kind: 'true-blocker', reasonKind: 'operator-only-secret', recheckAfter: daysAgo(1) } }),
      blocker({ state: 'true-blocker', terminal: { kind: 'true-blocker', reasonKind: 'operator-only-secret', recheckAfter: new Date(NOW + 3 * 86400000).toISOString() } }),
      blocker({ state: 'authority-checked' }), blocker({ state: 'access-requested' }),
      blocker({ state: 'resolved', updatedAt: daysAgo(2), terminal: { kind: 'resolved', playbookPath: 'playbooks/vercel-token.md' } }),
      blocker({ state: 'resolved', updatedAt: daysAgo(40) }),
    ], total: 6 }), NOW);
    expect([w.stuck.length, w.working.length, w.needsYou.length, w.clearedWeek.length, w.clearedOlder.length]).toEqual([2, 1, 1, 1, 1]);
    expect(w.stuck[0].sub).toBe('Truly stuck for now · recheck overdue');
    expect(w.stuck[0].overdue).toBe(true);
    expect(w.stuck[1].overdue).toBe(false);
    expect(w.working[0].sub).toBe('Checking who can clear it');
    expect(blockerRow(blocker({ state: 'dry-run' }), NOW).sub).toBe('Trying it safely first');
    const story = blockerStory(w.clearedWeek[0].record, NOW);
    expect(story.find((l) => l.label === 'Outcome')!.text).toBe('It turned out not to be a wall — playbook: vercel-token.md.');
  });

  it('the story says what was tried', () => {
    const s = blockerStory(blocker({ dryRun: { type: 'dry-run', at: minsAgo(9), detail: 'vault read: no such key', succeeded: false }, liveRun: { at: minsAgo(3), outcome: 'deploy refused', succeeded: false } }), NOW);
    expect(s.find((l) => l.label === 'What was tried')!.text).toBe('Tried safely first: vault read: no such key\nTried for real, and it did not work: deploy refused');
  });
});

describe('autonomous runs', () => {
  it('tells not-observed from failed from none', () => {
    expect(buildAutonomousRuns({ ok: false, reason: 'switched off on this agent' })).toMatchObject({ state: 'off', reason: 'Autonomous runs aren’t observed on this agent.' });
    expect(buildAutonomousRuns({ ok: false, reason: 'no answer within 5 seconds' }).state).toBe('failed');
    expect(buildAutonomousRuns(ok({ runs: [] }))).toMatchObject({ state: 'ok', rows: [], openOnArrival: false });
  });

  it('puts each decision in words with the smaller of the two flat minutes, and opens on a flatline', () => {
    const r = buildAutonomousRuns(ok({ runs: [
      { topicId: 13481, decision: 'healthy' }, { topicId: 2, decision: 'flatline-observed', outputFlatForMs: 125 * 60000, managerSilentForMs: 95 * 60000 },
      { topicId: 3, decision: 'baseline' }, { topicId: 4, decision: 'breaker-open', reason: 'read-breaker-open' },
    ] }), { 2: 'Console build' });
    expect(r.openOnArrival).toBe(true);
    expect(r.rows.map((x) => [x.main, x.sub])).toEqual([
      ['Conversation name unavailable', 'making progress'], ['Console build', 'no new work and no message from me for 1 h 35 min'],
      ['Conversation name unavailable', 'just started being watched'], ['Conversation name unavailable', 'can’t tell · read breaker open'],
    ]);
    expect(autonomousRow({ topicId: 1, decision: 'unknown' }).tone).toBe('unknown');
  });
});

describe('navigation', () => {
  it('the three legacy tabs open Plans natively; blockers land on In the way', () => {
    expect(NATIVE_PAGES.projects).toBe('#/work/plans');
    expect(NATIVE_PAGES.initiatives).toBe('#/work/plans');
    expect(tabHref('blockers')).toBe('#/work/plans?s=in-the-way');
  });
});

describe('plans page in a DOM', () => {
  let dom: JSDOM;
  // The page reads Date.now(); pin it to the fixtures' NOW so the rows stay "moving"
  // (touched within 7 days) whatever day the suite runs. Only Date is faked — the
  // page's setTimeout/rAF still run on real timers.
  beforeEach(() => vi.useFakeTimers({ toFake: ['Date'], now: NOW }));
  afterEach(() => { vi.useRealTimers(); dom?.window.close(); });

  it('renders In the way above In flight, opens the project sheet, and stops the round through its confirm; Resume sends that round’s index', async () => {
    const posted: Array<[string, unknown]> = [];
    const p1 = project({ id: 'console-makeover', firstLaunchAckAt: daysAgo(4) });
    const p2 = project({ id: 'stopped-one', title: 'Stopped one', rounds: [round({ status: 'complete' }), round({ name: 'Second', status: 'in-progress', haltedAt: minsAgo(10), haltReason: 'operator' })] });
    const items = [p1, p2, child('c2', 'building'), child('c3', 'spec-drafted'), child('c4', 'merged'), init({ id: 'tg', title: 'Telegram issues group' })];
    dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:4040/dashboard/console/#/work/plans' });
    const g = globalThis as Record<string, unknown>;
    Object.assign(g, { window: dom.window, document: dom.window.document, location: dom.window.location, history: dom.window.history, localStorage: dom.window.localStorage, requestAnimationFrame: (f: () => void) => setTimeout(f, 0) });
    dom.window.localStorage.setItem('instar_token', 't');
    g.fetch = async (url: string, opts?: { method?: string; body?: string }) => {
      if (opts && opts.method === 'POST') {
        posted.push([url, JSON.parse(opts.body || '{}')]);
        const body = url.endsWith('/halt') ? { id: 'console-makeover', roundIndex: 1, version: 3 } : { id: 'stopped-one', roundIndex: 1, scheduledAt: new Date().toISOString(), version: 2 };
        return { ok: true, status: 200, json: async () => body };
      }
      const table: Record<string, unknown> = {
        '/sessions': { sessions: [] },
        '/health': { project: { name: 'echo' } },
        '/initiatives': { items, count: items.length },
        '/initiatives/digest': { items: [] },
        '/projects': { items: [p1, p2], count: 2 },
        '/projects/console-makeover?reconcile=false': { project: p1, children: items.slice(2, 5) },
        '/projects/stopped-one?reconcile=false': { project: p2, children: [] },
        '/blockers': { entries: [blocker({ state: 'true-blocker', terminal: { kind: 'true-blocker', reasonKind: 'operator-only-secret', recheckAfter: daysAgo(1) } })], total: 1 },
        '/autonomous/throughput-floor': { runs: [{ topicId: 7, decision: 'healthy' }] },
        '/pool': { selfMachineId: 'm1', machines: [{ machineId: 'm1', nickname: 'Mac Studio' }] },
      };
      const body = table[url];
      return body === undefined ? { ok: false, status: 404, json: async () => ({}) } : { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) };
    };
    vi.resetModules();
    await import('../../dashboard/console/console.js');
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 20));
    const doc = dom.window.document;
    expect(doc.querySelector('.page-title')!.textContent).toBe('3 plans in flight. 1 is stuck.');
    const ids = [...doc.querySelectorAll('.page-sections section[id]')].map((s) => s.id);
    expect(ids.indexOf('sec-stuck')).toBeGreaterThan(-1);
    expect(ids.indexOf('sec-stuck')).toBeLessThan(ids.indexOf('sec-inFlight'));
    expect(doc.querySelector('#sec-stuck .row-sub')!.textContent).toBe('Truly stuck for now · recheck overdue');
    expect(doc.querySelector('#sec-runs .list-rows')!.hasAttribute('hidden')).toBe(true);
    expect(doc.querySelectorAll('#sec-inFlight button.row')).toHaveLength(3);

    // Open the running project, stop its round through the confirm.
    const projRow = [...doc.querySelectorAll('#sec-inFlight button.row')].find((b) => b.querySelector('.row-title')!.textContent === 'Console makeover') as HTMLButtonElement;
    projRow.click();
    await new Promise((r) => setTimeout(r, 10));
    expect([...doc.querySelectorAll('.round')].map((r) => r.getAttribute('data-state'))).toEqual(['done', 'current', 'future', 'future']);
    expect(doc.querySelector('.drift')!.textContent).toBe('No plan check recorded yet.');
    const stop = [...doc.querySelectorAll('.sheet-danger button')].find((b) => b.textContent === 'Stop this round') as HTMLButtonElement;
    stop.click();
    expect(doc.querySelector('.confirm-text')!.textContent).toContain('interrupted, not paused at a checkpoint');
    (doc.querySelector('.confirm textarea') as HTMLTextAreaElement).value = 'wrong branch';
    const go = [...doc.querySelectorAll('.confirm-row button')].find((b) => b.textContent === 'Stop this round') as HTMLButtonElement;
    go.click();
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 10));
    expect(posted).toEqual([['/projects/console-makeover/halt', { reason: 'wrong branch' }]]);
    expect(doc.querySelector('.sheet .action-status')!.textContent).toContain('Stop requested for round 2');
    for (let i = 0; i < 60; i++) await new Promise((r) => setTimeout(r, 20));

    // The stopped project offers Resume on ITS halted round (index 1), never round 0.
    const stoppedRow = [...doc.querySelectorAll('#sec-inFlight button.row')].find((b) => b.querySelector('.row-title')!.textContent === 'Stopped one') as HTMLButtonElement;
    stoppedRow.click();
    await new Promise((r) => setTimeout(r, 10));
    const resume = [...doc.querySelectorAll('.sheet button')].find((b) => b.textContent === 'Resume this round') as HTMLButtonElement;
    expect(resume).toBeTruthy();
    expect([...doc.querySelectorAll('.sheet button')].some((b) => b.textContent === 'Stop this round')).toBe(false);
    resume.click();
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 10));
    expect(posted[1]).toEqual(['/projects/stopped-one/resume', { roundIndex: 1 }]);
    expect(doc.querySelector('.sheet .action-status')!.textContent).toContain('Scheduled to resume');
  });
});

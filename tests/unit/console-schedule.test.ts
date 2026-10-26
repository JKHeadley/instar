/**
 * Console Schedule page (docs/specs/console-features/work.md: Jobs → Schedule):
 * every decision in the model on both sides (late only for a job that is on and
 * runs on that machine, worded "past its recorded next-run time"; skipped with its
 * recorded reason; running long against a real baseline; one row per job across
 * machines with each machine's own outcome and action target; failure states),
 * and the shipped page in jsdom driving Run now to its end and the Off switch
 * through its confirm.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  buildSchedulePage, buildHistory, buildSetupIssues, entryStatus, jobRow, sortRows, scheduleWords, storySentence, storyLines, jobActions, toggleConfirm,
  runStartWords, runFollowWords, saveRefusalWords, originWords, skipWords, medianDurations, baselineFor, markText, LATE_GRACE_MS, COMING_UP,
} from '../../dashboard/console/schedule-model.js';
import { NATIVE_PAGES, tabHref, GROUPS } from '../../dashboard/console/nav-model.js';

const NOW = Date.parse('2026-10-25T23:30:00Z');
const ok = (data: unknown) => ({ ok: true, data });
const minsAgo = (m: number) => new Date(NOW - m * 60000).toISOString();
const minsAhead = (m: number) => new Date(NOW + m * 60000).toISOString();

type J = Record<string, unknown>;
const job = (over: J = {}): J => ({
  slug: 'git-sync', name: 'Git sync', description: 'Sync the repos', schedule: '0 */4 * * *', priority: 'medium', expectedDurationMinutes: 3, model: 'haiku', enabled: true,
  execute: { type: 'skill', value: 'git-sync' }, origin: 'instar', hasUserFork: false, runsOnThisMachine: true,
  state: { slug: 'git-sync', lastRun: minsAgo(120), lastResult: 'success', nextScheduled: minsAhead(120), consecutiveFailures: 0 }, ...over,
});
const withState = (over: J, st: J) => job({ ...over, state: { slug: (over.slug as string) || 'git-sync', lastRun: minsAgo(120), lastResult: 'success', nextScheduled: minsAhead(120), consecutiveFailures: 0, ...st } });
const entry = (j: J, over: J = {}) => ({ job: j, state: j.state, enabled: j.enabled !== false, local: j.runsOnThisMachine !== false, remote: false, machineId: 'm1', machine: 'Mac Studio', ...over });
const pool = (jobs: J[], extra: J = {}) => ok({ jobs, count: jobs.length, pool: { enabled: true, selfMachineId: 'm1', peersQueried: 1, peersOk: 1, failed: [], ...extra } });
const res = (jobs: J[], over: J = {}) => ({
  local: ok({ jobs, queue: [] }), pool: pool(jobs.map((j) => ({ ...j, machineId: 'm1' }))), history: ok({ runs: [], total: 0, stats: [] }),
  migration: ok({ hasLegacyJobsJson: false, hasMigrationComplete: true, hasMigrationAbandoned: false, canConfirm: false, canAbandon: false, scheduleEntryCount: 0 }),
  reconcile: ok({ findings: [], summary: { total: 0, byKind: {} } }), ...over,
});
const NAMES = { m1: 'Mac Studio', m2: 'Mac Mini' };

describe('schedule model — honesty', () => {
  it('fails honestly: a failed read, an absent scheduler, an answer without jobs', () => {
    expect(buildSchedulePage(res([], { local: { ok: false, reason: 'no answer within 5 seconds' } }), NOW).reason).toBe("Couldn't read scheduled work: no answer within 5 seconds.");
    expect(buildSchedulePage(res([], { local: ok({ jobs: [], scheduler: null }), pool: pool([]) }), NOW).reason).toBe('The scheduler is not running on this machine.');
    expect(buildSchedulePage(res([], { local: ok({ nope: 1 }), pool: { ok: false, reason: 'the server answered 500' } }), NOW).reason).toBe('The job list answered without jobs.');
  });

  it('an absent local scheduler with other machines’ jobs still lists them, with a note', () => {
    const remote = job({ slug: 'remote-only', name: 'Remote only', machineId: 'm2', remote: true });
    const p = buildSchedulePage(res([], { local: ok({ jobs: [], scheduler: null }), pool: pool([remote]) }), NOW, { names: NAMES });
    expect(p.ok).toBe(true);
    expect(p.notes[0]).toBe('The scheduler is not running on this machine; only other machines’ jobs are shown.');
    expect(p.counts.total).toBe(1);
  });

  it('is empty in words when nothing is scheduled', () => {
    const p = buildSchedulePage(res([]), NOW);
    expect(p.ok).toBe(true);
    expect(p.headline).toBe('No scheduled work yet.');
    expect(p.sub).toBe('Ask me in chat to do something on a schedule.');
    expect(p.facts.map((f: { n: number }) => f.n)).toEqual([0, 0, 0, 0]);
  });

  it('a machine that did not answer is named; a failed pool read falls back to this machine; stale is said', () => {
    const jobs = [job()];
    expect(buildSchedulePage(res(jobs, { pool: pool(jobs, { failed: [{ machineId: 'm2', error: 'timeout' }] }) }), NOW, { names: NAMES }).notes).toContain('Mac Mini did not answer; its jobs are not shown.');
    const fb = buildSchedulePage(res(jobs, { pool: { ok: false, reason: 'no answer within 8 seconds' } }), NOW);
    expect(fb.ok).toBe(true);
    expect(fb.counts.total).toBe(1);
    expect(fb.notes[0]).toContain("Couldn't read other machines’ jobs: no answer within 8 seconds");
    expect(buildSchedulePage(res(jobs, { pool: pool(jobs, { stale: true }) }), NOW).notes[0]).toContain('last reading');
  });

  it('a failed duration read is a note only while something is running, and never a fabricated baseline', () => {
    const running = withState({}, { lastResult: 'pending', lastRun: minsAgo(30) });
    const p = buildSchedulePage(res([running], { history: { ok: false, reason: 'the server answered 500' } }), NOW);
    expect(p.notes.some((n: string) => n.includes("Couldn't read run durations"))).toBe(true);
    expect(buildSchedulePage(res([job()], { history: { ok: false, reason: 'the server answered 500' } }), NOW).notes).toEqual([]);
    // Declared duration still gives "longer than usual" a baseline: 30 min against 3 min expected.
    expect(p.counts.runningLong).toBe(1);
    expect(JSON.stringify(p)).not.toMatch(/handled/i);
  });
});

describe('late — only for a job that is on and runs on that machine', () => {
  const past = minsAgo(40);
  it('is late when enabled, local, not running and past its recorded next-run time by over 10 min', () => {
    const st = entryStatus(entry(withState({}, { nextScheduled: past })), NOW);
    expect(st.kind).toBe('late');
    expect(st.words).toBe('past its recorded next-run time by 40 min, not running');
    expect(st.words).not.toMatch(/missed/i);
    expect(LATE_GRACE_MS).toBe(600000);
  });
  it('is not late inside the 10-minute grace', () => {
    expect(entryStatus(entry(withState({}, { nextScheduled: minsAgo(5) })), NOW).kind).toBe('ok');
    expect(entryStatus(entry(withState({}, { nextScheduled: minsAgo(5) })), NOW).words).toBe('due now');
  });
  it('a disabled job is never late and never a failure: it is "off"', () => {
    const st = entryStatus(entry(withState({ enabled: false }, { nextScheduled: past, consecutiveFailures: 3 })), NOW);
    expect(st).toMatchObject({ kind: 'off', words: 'off', tone: null });
  });
  it('a job scoped to another machine is never late: it says where it runs', () => {
    const st = entryStatus(entry(withState({ runsOnThisMachine: false, machines: ['mac-mini'] }, { nextScheduled: past })), NOW);
    expect(st).toMatchObject({ kind: 'elsewhere', words: 'runs on mac-mini' });
    expect(entryStatus(entry(withState({ runsOnThisMachine: false }, { nextScheduled: past })), NOW).words).toBe('not on this machine');
  });
  it('a running job is running, not late; no recorded next run is "unknown", not on time', () => {
    expect(entryStatus(entry(withState({}, { nextScheduled: past, lastResult: 'pending', lastRun: minsAgo(1) })), NOW).kind).toBe('running');
    const st = entryStatus(entry(withState({}, { nextScheduled: undefined })), NOW);
    expect(st).toMatchObject({ kind: 'next-unknown', words: 'next run unknown', tone: 'unknown' });
  });
  it('the page counts late per job and words the headline', () => {
    const jobs = [withState({ slug: 'a', name: 'A' }, { nextScheduled: past }), withState({ slug: 'b', name: 'B', enabled: false }, { nextScheduled: past }), withState({ slug: 'c', name: 'C', runsOnThisMachine: false }, { nextScheduled: past })];
    const p = buildSchedulePage(res(jobs), NOW);
    expect(p.counts).toMatchObject({ total: 3, late: 1, failing: 0, off: 1 });
    expect(p.headline).toBe('3 scheduled jobs. 1 is late.');
    expect(p.tone).toBe('attn');
    expect(p.sections.needs.map((r: { slug: string; end: string }) => [r.slug, r.end])).toEqual([['a', 'late']]);
    expect(p.facts[0]).toMatchObject({ n: 1, label: 'late', tone: 'attn' });
  });
});

describe('failing, running and running long', () => {
  it('failing: the failure count, and late is added to it when both hold', () => {
    const st = entryStatus(entry(withState({}, { lastResult: 'failure', consecutiveFailures: 2, nextScheduled: minsAgo(30) })), NOW);
    expect(st).toMatchObject({ kind: 'failing', tone: 'bad', failures: 2 });
    expect(st.words).toBe('failed its last 2 runs · past its recorded next-run time by 30 min, not running');
    expect(entryStatus(entry(withState({}, { lastResult: 'failure', consecutiveFailures: 1 })), NOW).words).toBe('failed its last run');
  });
  it('running long only against a real baseline: measured median first, declared duration second, none → no claim', () => {
    const run = (mins: number, over: J = {}) => entry(withState(over, { lastResult: 'pending', lastRun: minsAgo(mins) }));
    expect(entryStatus(run(25), NOW, { 'git-sync': 180 })).toMatchObject({ kind: 'running-long', tone: 'attn', words: 'running for 25 min, usually 3 min' });
    expect(entryStatus(run(2), NOW, { 'git-sync': 180 })).toMatchObject({ kind: 'running', words: 'running for 2 min' });
    expect(entryStatus(run(25, { expectedDurationMinutes: 20 }), NOW).kind).toBe('running'); // 25 < 2×20 declared
    expect(entryStatus(run(45, { expectedDurationMinutes: 20 }), NOW).kind).toBe('running-long');
    expect(entryStatus(run(500, { expectedDurationMinutes: undefined }), NOW).kind).toBe('running'); // nothing says what usual is
    expect(baselineFor({ slug: 'x', expectedDurationMinutes: 5 }, { x: 30 })).toEqual({ seconds: 30, source: 'measured' });
    expect(baselineFor({ slug: 'x' }, {})).toBeNull();
  });
  it('medians come from completed runs with a measured duration', () => {
    const m = medianDurations(ok({ runs: [{ slug: 'a', result: 'success', durationSeconds: 10 }, { slug: 'a', result: 'failure', durationSeconds: 100 }, { slug: 'a', result: 'success', durationSeconds: 30 }, { slug: 'a', result: 'pending', durationSeconds: 999 }, { slug: 'b', result: 'success' }] }));
    expect(m).toEqual({ a: 30 });
    expect(medianDurations({ ok: false, reason: 'x' })).toEqual({});
  });
  it('the headline names failing and running long; facts say how many run longer than usual', () => {
    const jobs = [withState({ slug: 'a', name: 'A' }, { lastResult: 'failure', consecutiveFailures: 2 }), withState({ slug: 'b', name: 'B' }, { lastResult: 'pending', lastRun: minsAgo(30) }), withState({ slug: 'c', name: 'C' }, { lastResult: 'pending', lastRun: minsAgo(1) })];
    const p = buildSchedulePage(res(jobs), NOW);
    expect(p.headline).toBe('3 scheduled jobs. 1 failed its last 2 runs; 1 is running longer than usual.');
    expect(p.tone).toBe('bad');
    expect(p.facts[2]).toMatchObject({ n: 2, label: 'running, 1 longer than usual', tone: 'attn' });
    expect(p.sections.needs.map((r: { slug: string }) => r.slug)).toEqual(['a', 'b']);
    expect(p.sections.coming.map((r: { slug: string }) => r.slug)).toEqual([]);
    expect(p.sections.everything.map((r: { slug: string }) => r.slug)).toEqual(['c']);
    const two = buildSchedulePage(res([jobs[0], withState({ slug: 'd', name: 'D' }, { lastResult: 'failure', consecutiveFailures: 1 })]), NOW);
    expect(two.headline).toBe('2 scheduled jobs. 2 are failing.');
  });
  it('a clean schedule says so, and Coming up holds the next three by next run', () => {
    const jobs = [10, 30, 5, 90].map((m, i) => withState({ slug: `j${i}`, name: `J${i}` }, { nextScheduled: minsAhead(m) }));
    const p = buildSchedulePage(res(jobs), NOW);
    expect(p.headline).toBe('4 scheduled jobs. Nothing is late or failing.');
    expect(p.sections.coming.map((r: { slug: string; end: string }) => [r.slug, r.end])).toEqual([['j2', 'in 5 min'], ['j0', 'in 10 min'], ['j1', 'in 30 min']]);
    expect(p.sections.everything.map((r: { slug: string }) => r.slug)).toEqual(['j3']);
    expect(COMING_UP).toBe(3);
    expect(p.sections.coming[0].sub).toBe('Every 4 hours · last ran 2 h ago ✓');
  });
});

describe('one row per job across machines', () => {
  const local = withState({}, { lastResult: 'success', lastRun: minsAgo(60) });
  const remote = withState({ machineId: 'm2', remote: true }, { lastResult: 'failure', consecutiveFailures: 3, lastRun: minsAgo(20) });
  it('shows once with the worst status and names the machine; each machine keeps its own outcome and action target', () => {
    const r = jobRow([entry(local), entry(remote, { remote: true, machineId: 'm2', machine: 'Mac Mini' })], NOW);
    expect(r).toMatchObject({ kind: 'failing', tone: 'bad', grouped: true, machines: ['Mac Studio', 'Mac Mini'], end: '3 fails' });
    expect(r.sub).toBe('failed its last 3 runs on Mac Mini · last ran 20 min ago ✕');
    expect(r.statuses.map((x: { entry: { machine: string }; status: { kind: string } }) => [x.entry.machine, x.status.kind])).toEqual([['Mac Studio', 'ok'], ['Mac Mini', 'failing']]);
    expect(r.statuses.filter((x: { entry: { remote: boolean } }) => !x.entry.remote).map((x: { entry: { machine: string } }) => x.entry.machine)).toEqual(['Mac Studio']);
    expect(r.allOff).toBe(false);
  });
  it('a success on one machine never hides a failure on the other in the page counts', () => {
    const p = buildSchedulePage(res([local], { pool: pool([{ ...local, machineId: 'm1' }, remote]) }), NOW, { names: NAMES, selfMachineId: 'm1' });
    expect(p.counts).toMatchObject({ total: 1, failing: 1 });
    expect(p.sub).toBe('Jobs across 2 machines.');
    expect(p.sections.needs[0].statuses).toHaveLength(2);
  });
  it('this machine’s own read wins over the pool’s cached copy of its jobs; the pool adds the other machines', () => {
    const fresh = withState({ enabled: false }, {});                                  // just switched off: the uncached /jobs says so
    const cached = { ...withState({}, {}), machineId: 'm1', machineNickname: 'Mac Studio' }; // the 3-second pool cache still says on
    const p = buildSchedulePage(res([fresh], { pool: pool([cached, remote]) }), NOW, { names: NAMES, selfMachineId: 'm1' });
    const row = p.sections.needs.concat(p.sections.coming, p.sections.everything).find((x: { slug: string }) => x.slug === 'git-sync')!;
    expect(row.statuses.map((x: { entry: { machine: string }; status: { kind: string } }) => [x.entry.machine, x.status.kind])).toEqual([['Mac Studio', 'off'], ['Mac Mini', 'failing']]);
    expect(p.counts.total).toBe(1);
    // When the pool did not answer, the local read alone is used (and said so); when local has no scheduler, only remote jobs remain.
    expect(buildSchedulePage(res([fresh], { pool: { ok: false, reason: 'x' } }), NOW).sections.everything[0].statuses).toHaveLength(1);
  });

  it('off counts only when the job is off on every machine; both-off groups say so', () => {
    const offA = withState({ enabled: false }, {}); const offB = withState({ enabled: false, machineId: 'm2', remote: true }, {});
    const r = jobRow([entry(offA), entry(offB, { remote: true, machineId: 'm2', machine: 'Mac Mini' })], NOW);
    expect(r.allOff).toBe(true);
    expect(r.sub).toBe('Every 4 hours · off on Mac Studio and Mac Mini');
    const mixed = jobRow([entry(offA), entry(local, { remote: true, machineId: 'm2', machine: 'Mac Mini' })], NOW);
    expect(mixed.allOff).toBe(false);
    expect(mixed.kind).toBe('ok');
  });
});

describe('sorting, filtering and words', () => {
  const rows = [
    jobRow([entry(withState({ slug: 'b', name: 'Beta', priority: 'low' }, { lastRun: minsAgo(10) }))], NOW),
    jobRow([entry(withState({ slug: 'a', name: 'Alpha', priority: 'critical' }, { lastRun: minsAgo(300) }))], NOW),
    jobRow([entry(withState({ slug: 'c', name: 'Gamma', priority: 'high' }, { lastResult: 'failure', consecutiveFailures: 1, lastRun: minsAgo(100) }))], NOW),
  ];
  it('keeps the legacy orders: failing first, priority, name, last run', () => {
    expect(sortRows(rows, 'status').map((r) => r.slug)).toEqual(['c', 'a', 'b']);
    expect(sortRows(rows, 'priority').map((r) => r.slug)).toEqual(['a', 'c', 'b']);
    expect(sortRows(rows, 'name').map((r) => r.slug)).toEqual(['a', 'b', 'c']);
    expect(sortRows(rows, 'lastRun').map((r) => r.slug)).toEqual(['b', 'c', 'a']);
  });
  it('Everything else takes the origin chips and the search; counts are of the whole list', () => {
    const jobs = [job({ slug: 'a', name: 'Alpha', origin: 'instar' }), job({ slug: 'b', name: 'Beta', origin: 'user' }), job({ slug: 'c', name: 'Gamma', origin: 'user', description: 'cleans up' })].map((j) => ({ ...j, state: { ...(j.state as J), nextScheduled: undefined } }));
    const p = buildSchedulePage(res(jobs), NOW, { filter: { origin: 'user', q: 'clean' } });
    expect(p.sections.everything.map((r: { slug: string }) => r.slug)).toEqual(['c']);
    expect(p.counts.everything).toBe(3);
    expect(p.chips.map((c: { key: string; n: number; on: boolean }) => [c.key, c.n, c.on])).toEqual([['instar', 1, false], ['user', 2, true]]);
    expect(p.sorts.find((s: { on: boolean }) => s.on)!.key).toBe('status');
  });
  it('schedules read in plain words; the raw cron stays for Details', () => {
    expect(scheduleWords('0 */4 * * *')).toBe('Every 4 hours');
    expect(scheduleWords('*/15 * * * *')).toBe('Every 15 minutes');
    expect(scheduleWords('30 9 * * 1')).toBe('Monday at 9:30 am');
    expect(scheduleWords('0 18 * * *')).toBe('Daily at 6 pm');
    expect(scheduleWords('0 9 * * 1-5')).toBe('Weekdays at 9 am');
    expect(scheduleWords('0 0 1 1 *')).toBe('Yearly on January 1 at 12 am');
    expect(scheduleWords('5 4 */2 * *')).toBe('5 4 */2 * *');
    expect(scheduleWords('')).toBe('no schedule');
  });
  it('the sheet sentence reads in words and gains the last run’s duration once history is read', () => {
    const e = entry(job());
    const st = entryStatus(e, NOW);
    expect(storySentence(e, st, NOW)).toContain('Runs every 4 hours. Last run 2 h ago succeeded. Next in 2 h (');
    expect(storySentence(e, st, NOW, { durationSeconds: 180 })).toContain('Last run 2 h ago took 3 min and succeeded.');
    const late = entry(withState({}, { nextScheduled: minsAgo(40) }));
    expect(storySentence(late, entryStatus(late, NOW), NOW)).toContain('Its recorded next-run time was 40 min ago and it is not running.');
    const off = entry(withState({ enabled: false }, {}));
    expect(storySentence(off, entryStatus(off, NOW), NOW)).toContain('It is switched off.');
    expect(storyLines(e, st, NOW).map((l) => l.label)).toEqual(['State', 'Last run', 'Next run', 'Origin']);
    expect(storyLines(e, st, NOW)[3].text).toBe('instar default');
    expect(originWords({ origin: 'user', hasUserFork: true })).toBe('your copy of an instar default');
    expect(originWords({})).toBe('from the legacy job list');
  });
});

describe('actions', () => {
  it('Edit for yours, Make my own copy for a default, Go back to the default for your copy', () => {
    expect(jobActions({ origin: 'user' })).toEqual({ edit: true, copy: false, revert: false });
    expect(jobActions({ origin: 'instar' })).toEqual({ edit: false, copy: true, revert: false });
    expect(jobActions({ origin: 'instar', hasUserFork: true })).toEqual({ edit: false, copy: false, revert: false });
    expect(jobActions({ origin: 'user', hasUserFork: true })).toEqual({ edit: true, copy: false, revert: true });
    expect(jobActions({})).toEqual({ edit: false, copy: false, revert: false });
  });
  it('the switch asks only when switching OFF a high or critical job', () => {
    expect(toggleConfirm({ name: 'Git sync', priority: 'high' }, false)).toBe('Switch off Git sync? It is a high-priority job; nothing runs it until it is switched back on.');
    expect(toggleConfirm({ name: 'Git sync', priority: 'high' }, true)).toBeNull();
    expect(toggleConfirm({ name: 'Git sync', priority: 'low' }, false)).toBeNull();
  });
  it('Run now answers are told apart by what the server returned', () => {
    expect(runStartWords(202, { status: 'accepted', result: 'triggered' })).toMatchObject({ ok: true, text: 'Started.' });
    expect(runStartWords(202, { result: 'queued' })).toMatchObject({ ok: true, queued: true, text: 'Queued behind other work…' });
    expect(runStartWords(409, { error: 'Job is already running' }).text).toBe('Already running.');
    expect(runStartWords(409, { error: 'Job admission refused by live scheduler', result: 'skipped' }).text).toBe('The scheduler did not admit it (skipped). It may be switched off, paused, or meant for another machine.');
    expect(runStartWords(429, { error: 'Too soon', retryAfterSeconds: 90 }).text).toBe('Too soon after the last manual run; try again in 2 min.');
    expect(runStartWords(429, { error: 'Too many concurrent manual triggers' }).text).toBe('Too many manual runs at once; try again in a moment.');
    expect(runStartWords(503, {}).text).toBe('The scheduler is not running on this machine.');
    expect(runStartWords(0, {}).text).toBe('The server could not be reached.');
  });
  it('the follower waits for the run to start, follows it, and reports the real outcome', () => {
    const t0 = NOW - 30000;
    expect(runFollowWords({ lastResult: 'success', lastRun: minsAgo(120) }, t0, NOW, false)).toMatchObject({ done: false, text: 'Waiting for it to start…' });
    expect(runFollowWords({ lastResult: 'pending', lastRun: new Date(t0).toISOString() }, t0, NOW, false)).toMatchObject({ done: false, pending: true, text: 'Running 30 s' });
    expect(runFollowWords({ lastResult: 'success', lastRun: minsAgo(120) }, t0, NOW, true)).toMatchObject({ done: true, ok: true });
    expect(runFollowWords({ lastResult: 'success', lastRun: new Date(t0).toISOString() }, t0, NOW, true).text).toBe('Done: succeeded in 30 s.');
    expect(runFollowWords({ lastResult: 'failure', lastRun: new Date(t0).toISOString(), lastError: 'exit 1' }, t0, NOW, true).text).toBe('Failed: exit 1');
    expect(runFollowWords({ lastResult: 'timeout', lastRun: new Date(t0).toISOString() }, t0, NOW, false).text).toBe('Timed out.');
  });
  it('a refused save keeps its meaning', () => {
    expect(saveRefusalWords(409, { error: 'manifestVersion stale; another save has occurred' })).toContain('saved by someone else since you opened it');
    expect(saveRefusalWords(403, { error: 'Cannot save into instar namespace' })).toContain('Make your own copy first');
    expect(saveRefusalWords(500, { error: 'atomic save failed at stage md' })).toBe('atomic save failed at stage md');
  });
});

describe('run history with skips', () => {
  const hist = ok({ runs: [
    { runId: 'r1', slug: 'git-sync', startedAt: minsAgo(30), completedAt: minsAgo(27), durationSeconds: 180, result: 'success', trigger: 'scheduled' },
    { runId: 'r2', slug: 'git-sync', startedAt: minsAgo(2100), durationSeconds: 12, result: 'failure', error: 'exit 1', trigger: 'dashboard-manual' },
  ], total: 2 });
  it('skips carry their recorded reason, or say none was recorded; they sort into the strip by time', () => {
    const h = buildHistory(hist, ok({ events: [{ slug: 'git-sync', timestamp: minsAgo(10), reason: 'quota' }, { slug: 'git-sync', timestamp: minsAgo(2000) }] }), NOW);
    expect(h.ok).toBe(true);
    expect(h.marks.map((m) => m.word)).toEqual(['skipped (usage limit)', 'succeeded', 'skipped (no reason recorded)', 'failed']);
    // Day labels follow the local clock: the two recent marks share a day; the old ones are over 25 h back, so they are not "Today" in any timezone (CI runs in UTC).
    expect(h.marks[0].day).toBe(h.marks[1].day);
    expect(h.marks[2].day).not.toBe('Today');
    expect(h.marks[3].day).not.toBe('Today');
    expect(markText(h.marks[1], NOW)).toContain('succeeded · 3 min');
    expect(markText(h.marks[3], NOW)).toContain('failed · 12 s · exit 1 · started by dashboard manual');
    expect(skipWords('gate')).toBe('skipped (nothing to do, by its pre-flight check)');
    expect(skipWords('something-new')).toBe('skipped (something new)');
  });
  it('tells a failed history read from a failed skip read (runs still shown)', () => {
    expect(buildHistory({ ok: false, reason: 'the server answered 500' }, ok({ events: [] }), NOW)).toMatchObject({ ok: false, reason: "Couldn't read its run history: the server answered 500." });
    expect(buildHistory(ok({ nope: 1 }), null, NOW).reason).toBe('The run history answered without runs.');
    const h = buildHistory(hist, { ok: false, reason: 'no answer within 5 seconds' }, NOW);
    expect(h.marks).toHaveLength(2);
    expect(h.notes).toEqual(["Couldn't read its skips: no answer within 5 seconds."]);
  });
});

describe('setup issues', () => {
  it('the migration banner becomes one explained item with the two actions it can take', () => {
    const both = buildSetupIssues(ok({ hasLegacyJobsJson: true, canConfirm: true, canAbandon: true, scheduleEntryCount: 12 }), ok({ findings: [] }));
    expect(both.count).toBe(1);
    expect(both.items[0]).toMatchObject({ kind: 'migration', title: 'Your jobs were moved to the new layout', migration: { confirm: true, abandon: true } });
    expect(both.items[0].text).toContain('12 jobs are on the new per-job layout');
    const partial = buildSetupIssues(ok({ hasLegacyJobsJson: false, canConfirm: false, canAbandon: true, scheduleEntryCount: 1 }), ok({ findings: [] }));
    expect(partial.items[0]).toMatchObject({ migration: { confirm: false, abandon: true } });
    expect(buildSetupIssues(ok({ canConfirm: false, canAbandon: false }), ok({ findings: [] })).count).toBe(0);
  });
  it('file issues are explained by kind, sorted by severity, and dismissable; failed reads are notes', () => {
    const findings = [
      { kind: 'staged-new', slug: 'new-one', severity: 'info', summary: 'staged' },
      { kind: 'orphan-manifest', slug: 'ghost', filePath: '/x/ghost.json', severity: 'error', summary: 'manifest without body' },
      { kind: 'shadow-md', slug: 'git-sync', severity: 'warning', summary: 'user copy shadows default' },
    ];
    const s = buildSetupIssues(ok({ canConfirm: false }), ok({ findings }));
    expect(s.items.map((i) => i.title)).toEqual(['A schedule entry has no job file: ghost', 'Your copy shadows an instar default: git-sync', 'A new job is staged but not live: new-one']);
    const dismissed = new Set(['orphan-manifest|ghost|/x/ghost.json']);
    expect(buildSetupIssues(ok({ canConfirm: false }), ok({ findings }), dismissed).count).toBe(2);
    const failed = buildSetupIssues({ ok: false, reason: 'the server answered 500' }, { ok: false, reason: 'no answer within 5 seconds' });
    expect(failed.count).toBe(0);
    expect(failed.notes).toEqual(["Couldn't read the job-layout migration state: the server answered 500.", "Couldn't check the job files: no answer within 5 seconds."]);
  });
});

describe('navigation', () => {
  it('the Jobs tile opens Schedule natively and is titled Schedule', () => {
    expect(NATIVE_PAGES.jobs).toBe('#/work/schedule');
    expect(tabHref('jobs')).toBe('#/work/schedule');
    expect(GROUPS[0].tabs.find((t) => t.id === 'jobs')!.label).toBe('Schedule');
  });
});

describe('schedule page in a DOM', () => {
  let dom: JSDOM;
  afterEach(() => { vi.useRealTimers(); dom?.window.close(); });

  it('renders Needs a look above Coming up, opens the sheet, runs the job to its end, and switches it off through the confirm', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const writes: Array<[string, string, unknown]> = [];
    let phase = 0; // 0 before Run now, 1 the run is pending, 2 it finished
    // The shipped page reads the real clock, so these fixtures are relative to it.
    const rAgo = (m: number) => new Date(Date.now() - m * 60000).toISOString();
    const rAhead = (m: number) => new Date(Date.now() + m * 60000).toISOString();
    const st = (over: J) => ({ lastRun: rAgo(120), lastResult: 'success', nextScheduled: rAhead(120), consecutiveFailures: 0, ...over });
    const gitSync = () => job({ slug: 'git-sync', name: 'Git sync', priority: 'high', origin: 'user', state: st(phase === 0 ? { lastResult: 'failure', consecutiveFailures: 2 } : phase === 1 ? { lastResult: 'pending', lastRun: new Date().toISOString(), consecutiveFailures: 2 } : { lastResult: 'success', lastRun: new Date().toISOString() }) });
    const jobs = () => [gitSync(), job({ slug: 'memory-hygiene', name: 'Memory hygiene', state: st({ nextScheduled: rAhead(12) }) }), job({ slug: 'feedback-process', name: 'Feedback process', state: st({ nextScheduled: rAgo(40) }) }), job({ slug: 'old-one', name: 'Old one', enabled: false, state: st({}) })];
    dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:4040/dashboard/console/#/work/schedule' });
    const g = globalThis as Record<string, unknown>;
    Object.assign(g, { window: dom.window, document: dom.window.document, location: dom.window.location, history: dom.window.history, localStorage: dom.window.localStorage, requestAnimationFrame: (f: () => void) => setTimeout(f, 0) });
    dom.window.localStorage.setItem('instar_token', 't');
    g.fetch = async (url: string, opts?: { method?: string; body?: string }) => {
      const method = (opts && opts.method) || 'GET';
      if (method !== 'GET') {
        writes.push([method, url, opts && opts.body ? JSON.parse(opts.body) : null]);
        if (url === '/jobs/git-sync/run') { phase = 1; return { ok: true, status: 202, json: async () => ({ status: 'accepted', runId: 'manual-1', result: 'triggered' }) }; }
        if (url === '/jobs/git-sync') return { ok: true, status: 200, json: async () => ({ slug: 'git-sync', enabled: false, message: 'Job disabled' }) };
        return { ok: false, status: 404, json: async () => ({ error: 'nope' }) };
      }
      if (url === '/jobs') { const body = { jobs: jobs(), queue: [] }; if (phase === 1) phase = 2; return { ok: true, status: 200, json: async () => body }; }
      const table: Record<string, unknown> = {
        '/sessions': { sessions: [] },
        '/health': { project: { name: 'echo' } },
        '/jobs?scope=pool': { jobs: jobs().map((j) => ({ ...j, machineId: 'm1' })), count: 4, pool: { enabled: false, selfMachineId: 'm1', peersQueried: 0, peersOk: 0, failed: [] } },
        '/pool': { selfMachineId: 'm1', machines: [{ machineId: 'm1', nickname: 'Mac Studio', isSelf: true }] },
        '/jobs/history?limit=500': { runs: [{ slug: 'git-sync', result: 'success', durationSeconds: 60 }], total: 1, stats: [] },
        '/jobs/migration-status': { hasLegacyJobsJson: true, canConfirm: true, canAbandon: true, scheduleEntryCount: 4 },
        '/jobs/reconcile': { findings: [{ kind: 'shadow-md', slug: 'git-sync', severity: 'warning', summary: 'your copy shadows the default' }], summary: { total: 1 } },
        '/jobs/git-sync/history?limit=50': { runs: [{ runId: 'r1', slug: 'git-sync', startedAt: rAgo(120), durationSeconds: 12, result: 'failure', error: 'exit 1' }, { runId: 'r0', slug: 'git-sync', startedAt: rAgo(1500), durationSeconds: 60, result: 'success' }], total: 2 },
        '/skip-ledger?slug=git-sync&sinceHours=720': { events: [{ slug: 'git-sync', timestamp: rAgo(50), reason: 'quota' }] },
      };
      const body = table[url];
      return body === undefined ? { ok: false, status: 404, json: async () => ({}) } : { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) };
    };
    vi.resetModules();
    await import('../../dashboard/console/console.js');
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 20));
    const doc = dom.window.document;
    expect(doc.querySelector('.page-title')!.textContent).toBe('4 scheduled jobs. 1 failed its last 2 runs; 1 is late.');
    const ids = [...doc.querySelectorAll('.page-sections section[id]')].map((s) => s.id);
    expect(ids.indexOf('sec-needs')).toBeLessThan(ids.indexOf('sec-coming'));
    expect([...doc.querySelectorAll('#sec-needs button.row .row-title')].map((e) => e.textContent)).toEqual(['Git sync', 'Feedback process']);
    expect(doc.querySelector('#sec-needs button.row:nth-of-type(2) .row-sub')!.textContent).toBe('past its recorded next-run time by 40 min, not running · last ran 2 h ago ✓');
    expect([...doc.querySelectorAll('#sec-coming button.row .row-title')].map((e) => e.textContent)).toEqual(['Memory hygiene']);
    expect(doc.querySelector('#sec-everything .list-count')!.textContent).toBe('1');
    expect(doc.querySelector('#sec-everything .list-rows')!.hasAttribute('hidden')).toBe(true);
    expect(doc.querySelector('#sec-setup .list-count')!.textContent).toBe('2');
    expect(doc.body.textContent).not.toMatch(/handled/i);

    // Open the failing job: the sheet, its history with the skip reason, then Run now to its end.
    (doc.querySelector('#sec-needs button.row') as HTMLButtonElement).click();
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 10));
    expect(doc.querySelector('.sheet .sheet-summary')!.textContent).toContain('Last run 2 h ago took 12 s and failed, the 2nd failure in a row.');
    expect([...doc.querySelectorAll('.sheet .run-strip .run-mark')].map((m) => m.className)).toEqual(['run-mark skipped', 'run-mark failure', 'run-mark success']);
    (doc.querySelector('.sheet .run-strip .run-mark') as HTMLButtonElement).click();
    expect(doc.querySelector('.sheet .mark-detail')!.textContent).toContain('skipped (usage limit)');
    expect(doc.querySelector('.sheet .show-more')!.textContent).toBe('Show all 3');
    const run = [...doc.querySelectorAll('.sheet button')].find((b) => b.textContent === 'Run now') as HTMLButtonElement;
    run.click();
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 10));
    expect(writes[0]).toEqual(['POST', '/jobs/git-sync/run', {}]);
    expect(doc.querySelector('.sheet .run-live')!.textContent).toBe('Started.');
    await vi.advanceTimersByTimeAsync(5000);           // first poll: the run is pending
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 10));
    expect(doc.querySelector('.sheet .run-live')!.textContent).toMatch(/^Running \d+ s$/);
    await vi.advanceTimersByTimeAsync(5000);           // second poll: it finished
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 10));
    expect(doc.querySelector('.sheet .run-live')).toBeNull();
    expect(doc.querySelector('.sheet .run-action .action-status')!.textContent).toMatch(/^Done: succeeded in \d+ s\.$/);

    // Switch it off: a high-priority job asks first, then PATCHes { enabled: false }.
    const sw = doc.querySelector('.sheet .switch') as HTMLButtonElement;
    expect(sw.getAttribute('aria-checked')).toBe('true');
    sw.click();
    expect(doc.querySelector('.sheet .confirm-text')!.textContent).toBe('Switch off Git sync? It is a high-priority job; nothing runs it until it is switched back on.');
    ([...doc.querySelectorAll('.sheet .confirm-row button')].find((b) => b.textContent === 'Switch off') as HTMLButtonElement).click();
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 10));
    expect(writes[1]).toEqual(['PATCH', '/jobs/git-sync', { enabled: false }]);
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(doc.querySelector('.sheet .switch-action .action-status')!.textContent).toBe('Off. Nothing runs it until it is switched back on.');
    // Your job: Edit is offered; a default's actions are not.
    expect([...doc.querySelectorAll('.sheet .more-actions button')].map((b) => b.textContent)).toEqual(['Edit']);
  });
});

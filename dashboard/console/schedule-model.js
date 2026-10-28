// Schedule page — pure view-model (docs/specs/console-features/work.md, "Jobs → Schedule").
//
// Every decision lives here so it can be unit-tested; schedule.js only renders.
// The honesty rules the legacy Jobs tab lacks are written out as functions:
//   late          = enabled AND runs on that machine AND its RECORDED next-run time is
//                   more than 10 min in the past AND it is not running. A disabled or
//                   out-of-scope job is never late; no recorded time → "next run unknown".
//                   The words are "past its recorded next-run time", never "missed".
//   running long  = running for more than twice its usual duration (the median of its
//                   measured runs, else its declared expected duration; no baseline → no claim).
//   skipped       = a skip-ledger event with its recorded reason, or "no reason recorded".
// A job that runs on several machines is ONE row whose status is the worst of them, and
// every machine keeps its own outcome, next run and action target inside the row.

import { ago, failure } from './home-model.js';

export { failure, ago };

export const LATE_GRACE_MS = 10 * 60000;
export const RUNNING_LONG_FACTOR = 2;
export const HISTORY_LIMIT = 50;
export const STRIP_LIMIT = 20;
export const COMING_UP = 3;

const PRIORITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };
// Worst-first, for the status a grouped row shows and for "failing first" sorting.
const SEVERITY = { failing: 6, late: 5, 'running-long': 4, 'next-unknown': 3, running: 2, ok: 1, elsewhere: 0, off: 0 };
export const NEEDS_LOOK = new Set(['failing', 'late', 'running-long']);

// ── words ──────────────────────────────────────────────────────────────────
/** A cron expression in plain words; the raw text stays in Details. */
export function scheduleWords(cron) {
  if (!cron || typeof cron !== 'string') return 'no schedule';
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return cron;
  const [min, hour, dom, mon, dow] = parts;
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const clock = (h, m) => `${h % 12 || 12}${m ? ':' + String(m).padStart(2, '0') : ''} ${h >= 12 ? 'pm' : 'am'}`;
  if (/^\*\/(\d+)$/.test(min) && hour === '*' && dom === '*' && mon === '*' && dow === '*') { const n = Number(min.slice(2)); return n === 1 ? 'Every minute' : `Every ${n} minutes`; }
  if (min === '*' && hour === '*' && dom === '*' && mon === '*' && dow === '*') return 'Every minute';
  if (/^\d+$/.test(min) && /^\*\/(\d+)$/.test(hour) && dom === '*' && mon === '*' && dow === '*') { const n = Number(hour.slice(2)); return n === 1 ? 'Every hour' : `Every ${n} hours`; }
  if (/^\d+$/.test(min) && hour === '*' && dom === '*' && mon === '*' && dow === '*') return 'Every hour';
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && mon === '*') {
    if (dow === '*') return `Daily at ${clock(Number(hour), Number(min))}`;
    if (/^\d$/.test(dow)) return `${DAYS[Number(dow)] || dow} at ${clock(Number(hour), Number(min))}`;
    if (dow === '1-5') return `Weekdays at ${clock(Number(hour), Number(min))}`;
  }
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && /^\d+$/.test(dom) && mon === '*' && dow === '*') return `Monthly on the ${ordinal(Number(dom))} at ${clock(Number(hour), Number(min))}`;
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && /^\d+$/.test(dom) && /^\d+$/.test(mon) && dow === '*') return `Yearly on ${monthName(Number(mon))} ${Number(dom)} at ${clock(Number(hour), Number(min))}`;
  return cron;
}
function ordinal(n) { const s = ['th', 'st', 'nd', 'rd']; const v = n % 100; return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`; }
function monthName(m) { return ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][m - 1] || String(m); }

/** "in 12 min", "in 3 h", "in 2 d", "now". */
export function until(ts, now = Date.now()) {
  const m = Math.round((ts - now) / 60000);
  if (m <= 0) return 'now';
  if (m < 60) return `in ${m} min`;
  const h = Math.round(m / 60); if (h < 48) return `in ${h} h`;
  return `in ${Math.round(h / 24)} d`;
}

/** A length of time in plain words: "45 s", "3 min", "1 h 20 min", "2 d". */
export function spell(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60); const rm = m % 60;
  if (h < 48) return rm ? `${h} h ${rm} min` : `${h} h`;
  return `${Math.round(h / 24)} d`;
}

export function clock(ts) { const d = new Date(ts); return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
export function dayLabel(ts, now = Date.now()) {
  const d = new Date(ts); const n = new Date(now);
  if (d.toDateString() === n.toDateString()) return 'Today';
  const y = new Date(now - 86400000);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}
/** "at 4:00 pm" today, else "Mon, Oct 26 at 4:00 pm". */
export function whenWords(ts, now = Date.now()) {
  const label = dayLabel(ts, now);
  return label === 'Today' ? `at ${clock(ts)}` : `${label} at ${clock(ts)}`;
}

const RESULT_WORD = { success: 'succeeded', failure: 'failed', timeout: 'timed out', 'spawn-error': 'could not start', pending: 'still running' };
export function resultWord(r) { return RESULT_WORD[r] || (r ? String(r).replace(/[-_]/g, ' ') : 'no result'); }

const SKIP_WORD = {
  disabled: 'switched off', paused: 'the scheduler was paused', quota: 'usage limit', 'memory-pressure': 'low memory', capacity: 'no free session slot',
  claimed: 'another machine took it', 'machine-scope': 'not this machine', 'already-running': 'already running', 'role-guard': 'this machine was standby', 'throwaway-agent': 'test agent in a temporary folder', gate: 'nothing to do, by its pre-flight check',
};
export function skipWords(reason) { return `skipped (${reason ? (SKIP_WORD[reason] || String(reason).replace(/[-_]/g, ' ')) : 'no reason recorded'})`; }

const ORIGIN_WORD = { instar: 'instar default', user: 'yours' };
export function originWords(job) {
  if (!job || !job.origin) return 'from the legacy job list';
  if (job.origin === 'user' && job.hasUserFork) return 'your copy of an instar default';
  return ORIGIN_WORD[job.origin] || String(job.origin);
}

function machinesWords(job) {
  const m = Array.isArray(job && job.machines) ? job.machines.filter(Boolean) : [];
  return m.length ? `runs on ${m.join(' and ')}` : 'not on this machine';
}

// ── baselines (what "usual" means) ─────────────────────────────────────────
/** Median measured duration per slug from GET /jobs/history?limit=500 (completed runs only). */
export function medianDurations(res) {
  const out = {};
  const runs = res && res.ok && Array.isArray(res.data && res.data.runs) ? res.data.runs : [];
  const by = {};
  for (const r of runs) {
    if (!r || r.result === 'pending') continue;
    const d = Number(r.durationSeconds);
    if (!(d > 0)) continue;
    (by[r.slug] = by[r.slug] || []).push(d);
  }
  for (const [slug, ds] of Object.entries(by)) { ds.sort((a, b) => a - b); out[slug] = ds[Math.floor(ds.length / 2)]; }
  return out;
}
/** { seconds, source: 'measured'|'declared' } or null when nothing says what usual is. */
export function baselineFor(job, medians = {}) {
  if (job && medians[job.slug] > 0) return { seconds: medians[job.slug], source: 'measured' };
  const exp = Number(job && job.expectedDurationMinutes);
  if (exp > 0) return { seconds: exp * 60, source: 'declared' };
  return null;
}

// ── one job on one machine ─────────────────────────────────────────────────
/**
 * The status of one job on one machine.
 * kind: off | running-long | running | failing | late | elsewhere | next-unknown | ok
 */
export function entryStatus(e, now = Date.now(), medians = {}) {
  const s = e.state || {};
  const failures = Number(s.consecutiveFailures) || 0;
  const failWords = failures ? (failures === 1 ? 'failed its last run' : `failed its last ${failures} runs`) : null;
  if (!e.enabled) return { kind: 'off', tone: null, words: 'off', failures };
  if (s.lastResult === 'pending') {
    const since = Date.parse(s.lastRun);
    const forS = Number.isFinite(since) ? Math.max(0, (now - since) / 1000) : null;
    const b = baselineFor(e.job, medians);
    if (forS !== null && b && forS > b.seconds * RUNNING_LONG_FACTOR) {
      return { kind: 'running-long', tone: 'attn', words: `running for ${spell(forS)}, usually ${spell(b.seconds)}`, runningFor: forS, usual: b, failures };
    }
    return { kind: 'running', tone: failures ? 'bad' : null, words: [forS !== null ? `running for ${spell(forS)}` : 'running', failWords].filter(Boolean).join(' · '), runningFor: forS, failures };
  }
  const next = Date.parse(s.nextScheduled);
  const late = e.local && Number.isFinite(next) && now - next > LATE_GRACE_MS;
  const lateWords = late ? `past its recorded next-run time by ${spell((now - next) / 1000)}, not running` : null;
  if (failures) return { kind: 'failing', tone: 'bad', words: [failWords, lateWords].filter(Boolean).join(' · '), failures, late };
  if (!e.local) return { kind: 'elsewhere', tone: null, words: machinesWords(e.job), failures };
  if (!Number.isFinite(next)) return { kind: 'next-unknown', tone: 'unknown', words: 'next run unknown', failures };
  if (late) return { kind: 'late', tone: 'attn', words: lateWords, byMs: now - next, failures, late: true };
  return { kind: 'ok', tone: null, words: next > now ? `next ${until(next, now)}` : 'due now', next, failures };
}

function lastRunWords(s, now) {
  if (!s || !s.lastRun) return 'never ran';
  const a = ago(s.lastRun, now);
  if (s.lastResult === 'pending') return `started ${a}`;
  const mark = s.lastResult === 'success' ? ' ✓' : s.lastResult ? ' ✕' : '';
  return `last ran ${a}${mark}`;
}

/** One row for one job across the machines it was read from. */
export function jobRow(entries, now = Date.now(), medians = {}) {
  const sorted = entries.slice().sort((a, b) => (a.remote ? 1 : 0) - (b.remote ? 1 : 0));
  const statuses = sorted.map((e) => ({ entry: e, status: entryStatus(e, now, medians) }));
  const worst = statuses.reduce((w, x) => (SEVERITY[x.status.kind] > SEVERITY[w.status.kind] ? x : w), statuses[0]);
  const job = sorted[0].job;
  const grouped = sorted.length > 1;
  const machines = sorted.map((e) => e.machine);
  const kind = worst.status.kind;
  const needsLook = NEEDS_LOOK.has(kind);
  const sched = scheduleWords(job.schedule);
  const where = grouped ? ` on ${worst.entry.machine}` : '';
  let sub;
  if (needsLook) sub = `${worst.status.words}${where} · ${lastRunWords(worst.entry.state, now)}`;
  else if (kind === 'running') sub = `${worst.status.words}${where} · ${sched}`;
  else if (kind === 'off') sub = `${sched} · off${grouped ? ` on ${machines.join(' and ')}` : ''}`;
  else if (kind === 'elsewhere') sub = `${sched} · ${worst.status.words}`;
  else sub = `${sched} · ${lastRunWords(worst.entry.state, now)}${grouped ? ` · on ${machines.join(' and ')}` : ''}`;
  const nexts = statuses.map((x) => x.status.next).filter((t) => Number.isFinite(t) && t > now);
  const nextAt = nexts.length ? Math.min(...nexts) : null;
  const lasts = sorted.map((e) => Date.parse(e.state && e.state.lastRun)).filter(Number.isFinite);
  let end;
  if (kind === 'late') end = 'late';
  else if (kind === 'failing') end = `${worst.status.failures} ${worst.status.failures === 1 ? 'fail' : 'fails'}`;
  else if (kind === 'running' || kind === 'running-long') end = 'running';
  else if (kind === 'off') end = 'off';
  else if (nextAt) end = until(nextAt, now);
  else if (kind === 'next-unknown') end = 'next unknown';
  else end = '';
  return {
    key: `job:${job.slug}`, slug: job.slug, main: job.name || job.slug, sub, end, tone: worst.status.tone, kind, needsLook,
    statuses, worst, job, machines, grouped, nextAt, lastRunAt: lasts.length ? Math.max(...lasts) : 0,
    failures: Math.max(0, ...statuses.map((x) => x.status.failures || 0)), priority: job.priority || 'medium', origin: job.origin || null,
    allOff: statuses.every((x) => x.status.kind === 'off'), anyRunning: statuses.some((x) => x.status.kind === 'running' || x.status.kind === 'running-long'),
    anyLate: statuses.some((x) => x.status.kind === 'late' || x.status.late), anyFailing: statuses.some((x) => x.status.kind === 'failing'), anyLong: statuses.some((x) => x.status.kind === 'running-long'),
  };
}

/** The legacy orders, kept: failing first (then priority), priority, name, last run. */
export function sortRows(rows, sort = 'status') {
  const by = {
    status: (a, b) => (SEVERITY[b.kind] - SEVERITY[a.kind]) || (b.failures - a.failures) || ((PRIORITY_ORDER[a.priority] ?? 2) - (PRIORITY_ORDER[b.priority] ?? 2)) || a.main.localeCompare(b.main),
    priority: (a, b) => ((PRIORITY_ORDER[a.priority] ?? 2) - (PRIORITY_ORDER[b.priority] ?? 2)) || a.main.localeCompare(b.main),
    name: (a, b) => a.main.localeCompare(b.main),
    lastRun: (a, b) => (b.lastRunAt - a.lastRunAt) || a.main.localeCompare(b.main),
  };
  return rows.slice().sort(by[sort] || by.status);
}

// ── the page ───────────────────────────────────────────────────────────────
function machineNameFor(j, names, selfMachineId) {
  const id = j.machineId || (j.remote ? null : selfMachineId);
  if (id && names[id]) return names[id];
  if (j.machineNickname) return j.machineNickname;
  return j.remote ? 'another machine' : 'This machine';
}

/** The jobs as per-machine entries grouped by slug. */
export function groupJobs(jobs, opts = {}) {
  const names = opts.names || {};
  const groups = new Map();
  for (const j of jobs) {
    if (!j || typeof j.slug !== 'string') continue;
    const entry = {
      job: j, state: j.state || null, enabled: j.enabled !== false, local: j.runsOnThisMachine !== false, remote: Boolean(j.remote),
      machineId: j.machineId || (j.remote ? null : opts.selfMachineId || null), machine: machineNameFor(j, names, opts.selfMachineId),
    };
    if (!groups.has(j.slug)) groups.set(j.slug, []);
    groups.get(j.slug).push(entry);
  }
  return groups;
}

/**
 * Build the whole page.
 * res: { local: GET /jobs, pool: GET /jobs?scope=pool, history: GET /jobs/history?limit=500, migration, reconcile }
 * opts: { names, selfMachineId, filter: { origin, sort, q }, dismissed: Set }
 */
export function buildSchedulePage(res, now = Date.now(), opts = {}) {
  const r = res || {};
  const local = r.local;
  if (!local || !local.ok) return { ok: false, reason: `Couldn't read scheduled work: ${local ? local.reason : 'not read'}.` };
  const localJobs = Array.isArray(local.data && local.data.jobs) ? local.data.jobs : null;
  const schedulerAbsent = local.data && local.data.scheduler === null;
  const notes = [];
  const names = opts.names || {};
  let jobs = localJobs || [];
  let multi = false;
  const pool = r.pool;
  if (pool && pool.ok && Array.isArray(pool.data && pool.data.jobs)) {
    // This machine's jobs come from its own uncached read (the pool merge is served from
    // a short server-side cache, so right after a switch it can still show the old value);
    // the pool supplies the other machines' jobs and this machine's identity tags.
    const p = pool.data.pool || {};
    const selfId = p.selfMachineId || opts.selfMachineId || null;
    const tags = new Map(pool.data.jobs.filter((j) => j && !j.remote).map((j) => [j.slug, j]));
    const mine = (localJobs || []).map((j) => { const t = tags.get(j.slug); return { ...j, machineId: j.machineId || (t && t.machineId) || selfId || undefined, machineNickname: j.machineNickname || (t && t.machineNickname) || undefined }; });
    jobs = [...mine, ...pool.data.jobs.filter((j) => j && j.remote)];
    multi = (Number(p.peersQueried) || 0) > 0;
    for (const f of (Array.isArray(p.failed) ? p.failed : [])) notes.push(`${names[f.machineId] || f.machineId || 'A machine'} did not answer; its jobs are not shown.`);
    if (p.stale) notes.push('Other machines’ jobs are from the last reading; the server is shedding load.');
  } else if (pool && !pool.ok) notes.push(`Couldn't read other machines’ jobs: ${pool.reason}. Showing this machine only.`);
  if (!localJobs && !jobs.length) return { ok: false, reason: schedulerAbsent ? 'The scheduler is not running on this machine.' : 'The job list answered without jobs.' };
  if (schedulerAbsent) {
    if (!jobs.some((j) => j && j.remote)) return { ok: false, reason: 'The scheduler is not running on this machine.' };
    notes.unshift('The scheduler is not running on this machine; only other machines’ jobs are shown.');
  }
  const medians = medianDurations(r.history);
  if (r.history && !r.history.ok && jobs.some((j) => j && j.state && j.state.lastResult === 'pending')) notes.push(`Couldn't read run durations: ${r.history.reason}. “Longer than usual” uses each job’s expected duration.`);

  const groups = groupJobs(jobs, { names, selfMachineId: opts.selfMachineId });
  const rows = [...groups.values()].map((entries) => jobRow(entries, now, medians));
  const needs = sortRows(rows.filter((x) => x.needsLook), 'status');
  const rest = rows.filter((x) => !x.needsLook);
  const coming = rest.filter((x) => x.nextAt).sort((a, b) => a.nextAt - b.nextAt).slice(0, COMING_UP);
  const comingKeys = new Set(coming.map((x) => x.key));
  const everythingAll = rest.filter((x) => !comingKeys.has(x.key));
  const filter = opts.filter || {};
  const q = (filter.q || '').trim().toLowerCase();
  let everything = everythingAll;
  if (filter.origin === 'instar') everything = everything.filter((x) => x.origin === 'instar');
  else if (filter.origin === 'user') everything = everything.filter((x) => x.origin === 'user');
  if (q) everything = everything.filter((x) => `${x.main} ${x.slug} ${x.job.description || ''}`.toLowerCase().includes(q));
  everything = sortRows(everything, filter.sort || 'status');

  const counts = {
    total: rows.length, late: rows.filter((x) => x.anyLate).length, failing: rows.filter((x) => x.anyFailing).length,
    running: rows.filter((x) => x.anyRunning).length, runningLong: rows.filter((x) => x.anyLong).length, off: rows.filter((x) => x.allOff).length,
    needs: needs.length, coming: coming.length, everything: everythingAll.length, instar: everythingAll.filter((x) => x.origin === 'instar').length, user: everythingAll.filter((x) => x.origin === 'user').length,
  };
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  let headline; let tone = 'ok';
  if (!rows.length) headline = 'No scheduled work yet.';
  else {
    const clauses = [];
    if (counts.failing) {
      const one = counts.failing === 1 ? needs.find((x) => x.anyFailing) : null;
      clauses.push(one ? `1 ${one.failures === 1 ? 'failed its last run' : `failed its last ${one.failures} runs`}` : `${counts.failing} are failing`);
    }
    if (counts.late) clauses.push(`${plural(counts.late, 'is', 'are')} late`);
    if (counts.runningLong) clauses.push(`${plural(counts.runningLong, 'is', 'are')} running longer than usual`);
    headline = `${plural(rows.length, 'scheduled job', 'scheduled jobs')}. ${clauses.length ? clauses.join('; ') + '.' : 'Nothing is late or failing.'}`;
    tone = counts.failing ? 'bad' : (counts.late || counts.runningLong) ? 'attn' : 'ok';
  }
  const machineCount = new Set(rows.flatMap((x) => x.statuses.map((s) => s.entry.machineId || 'self'))).size;
  const sub = !rows.length ? 'Ask me in chat to do something on a schedule.' : multi ? `Jobs across ${machineCount} ${machineCount === 1 ? 'machine' : 'machines'}.` : 'Jobs on this machine.';
  const facts = [
    { n: counts.late, label: 'late', tone: counts.late ? 'attn' : null, href: '#/work/schedule?s=needs' },
    { n: counts.failing, label: 'failing', tone: counts.failing ? 'bad' : null, href: '#/work/schedule?s=needs' },
    { n: counts.running, label: counts.runningLong ? `running, ${counts.runningLong} longer than usual` : 'running', tone: counts.runningLong ? 'attn' : null, href: counts.runningLong ? '#/work/schedule?s=needs' : '#/work/schedule?s=everything' },
    { n: counts.off, label: 'off', href: '#/work/schedule?s=everything' },
  ];
  const chips = [
    { key: 'instar', label: 'Instar defaults', n: counts.instar, on: filter.origin === 'instar' },
    { key: 'user', label: 'Your jobs', n: counts.user, on: filter.origin === 'user' },
  ].filter((c) => c.n);
  const sorts = [['status', 'Failing first'], ['priority', 'Priority'], ['name', 'Name'], ['lastRun', 'Last run']].map(([key, label]) => ({ key, label, on: (filter.sort || 'status') === key }));
  return {
    ok: true, headline, sub, tone, facts, counts, notes, multi,
    sections: { needs, coming, everything }, chips, sorts,
    setup: buildSetupIssues(r.migration, r.reconcile, opts.dismissed),
  };
}

// ── setup issues (migration banner + file issues card, one line) ───────────
const ISSUE_TITLE = {
  'orphan-manifest': 'A schedule entry has no job file', 'shadow-md': 'Your copy shadows an instar default', 'missing-from-jobs-json': 'A job file is not in the legacy list',
  'staged-new': 'A new job is staged but not live', 'case-collision': 'Two job files differ only by letter case',
};
export function issueKey(f) { return `${f.kind || ''}|${f.slug || ''}|${f.filePath || ''}`; }

/** { items:[{ key, title, text, kind, severity, record, migration? }], notes, count } */
export function buildSetupIssues(migRes, recRes, dismissed = new Set()) {
  const items = []; const notes = [];
  if (migRes && migRes.ok && migRes.data) {
    const d = migRes.data;
    if (d.canConfirm) items.push({ key: 'migration', kind: 'migration', severity: 'warning', title: 'Your jobs were moved to the new layout', text: `${d.scheduleEntryCount} ${d.scheduleEntryCount === 1 ? 'job is' : 'jobs are'} on the new per-job layout and the old list is still there. Confirm the move is complete, or roll it back.`, migration: { confirm: true, abandon: true }, record: d });
    else if (d.canAbandon) items.push({ key: 'migration', kind: 'migration', severity: 'warning', title: 'The move to the new layout is partly done', text: `${d.scheduleEntryCount} ${d.scheduleEntryCount === 1 ? 'job is' : 'jobs are'} on the new per-job layout; the old list is gone, so there is nothing to confirm. You can still roll back.`, migration: { confirm: false, abandon: true }, record: d });
  } else if (migRes && !migRes.ok && !/switched off/.test(migRes.reason || '')) notes.push(`Couldn't read the job-layout migration state: ${migRes.reason}.`);
  if (recRes && recRes.ok && Array.isArray(recRes.data && recRes.data.findings)) {
    const sev = { error: 0, warning: 1, info: 2 };
    const fs = recRes.data.findings.filter((f) => f && !dismissed.has(issueKey(f))).sort((a, b) => ((sev[a.severity] ?? 3) - (sev[b.severity] ?? 3)) || String(a.slug || '').localeCompare(String(b.slug || '')));
    for (const f of fs) items.push({ key: issueKey(f), kind: f.kind, severity: f.severity || 'info', title: `${ISSUE_TITLE[f.kind] || String(f.kind || 'issue').replace(/[-_]/g, ' ')}${f.slug ? `: ${f.slug}` : ''}`, text: f.summary || '', record: f });
  } else if (recRes && !recRes.ok) notes.push(`Couldn't check the job files: ${recRes.reason}.`);
  return { items, notes, count: items.length };
}

// ── detail sheet ───────────────────────────────────────────────────────────
/** The sentence at the top of a job's sheet, for one machine's entry. */
export function storySentence(entry, status, now = Date.now(), lastRun = null) {
  const s = entry.state || {};
  const bits = [`Runs ${scheduleWords(entry.job.schedule).replace(/^Every/, 'every').replace(/^Daily/, 'daily').replace(/^Weekdays/, 'weekdays').replace(/^Monthly/, 'monthly').replace(/^Yearly/, 'yearly')}.`];
  if (!entry.enabled) bits.push('It is switched off.');
  else if (!entry.local) bits.push(`It ${machinesWords(entry.job)}, not here.`);
  if (status.kind === 'running' || status.kind === 'running-long') bits.push(`It has been running ${status.runningFor !== null && status.runningFor !== undefined ? `for ${spell(status.runningFor)}` : 'since an unrecorded time'}${status.kind === 'running-long' ? `, longer than its usual ${spell(status.usual.seconds)}` : ''}.`);
  else if (s.lastRun) {
    const took = lastRun && Number(lastRun.durationSeconds) > 0 ? ` took ${spell(lastRun.durationSeconds)} and` : '';
    bits.push(`Last run ${ago(s.lastRun, now)}${took} ${resultWord(s.lastResult)}${status.failures > 1 ? `, the ${ordinal(status.failures)} failure in a row` : ''}.`);
  } else bits.push('It has not run yet.');
  if (entry.enabled && entry.local && status.kind !== 'running' && status.kind !== 'running-long') {
    const next = Date.parse(s.nextScheduled);
    if (!Number.isFinite(next)) bits.push('Next run unknown.');
    else if (status.kind === 'late') bits.push(`Its recorded next-run time was ${ago(next, now)} and it is not running.`);
    else if (next > now) bits.push(`Next ${until(next, now)} (${whenWords(next, now)}).`);
    else bits.push(`Its recorded next-run time was ${ago(next, now)}.`);
  }
  return bits.join(' ');
}

/** Story lines for one machine's entry (identifiers stay in Details). */
export function storyLines(entry, status, now = Date.now()) {
  const s = entry.state || {};
  const lines = [{ label: 'State', text: status.words }];
  if (s.lastRun) lines.push({ label: 'Last run', text: `${whenWords(Date.parse(s.lastRun), now)} (${ago(s.lastRun, now)}) · ${resultWord(s.lastResult)}` });
  if (s.lastError) lines.push({ label: 'Last error', text: String(s.lastError) });
  if (entry.enabled && entry.local) {
    const next = Date.parse(s.nextScheduled);
    lines.push({ label: 'Next run', text: Number.isFinite(next) ? `${whenWords(next, now)}${next > now ? ` (${until(next, now)})` : ' (recorded; now past)'}` : 'unknown' });
  }
  lines.push({ label: 'Origin', text: originWords(entry.job) });
  return lines;
}

/** Which secondary actions a job offers: Edit (yours), Make my own copy (a default), Go back to the default (your copy). */
export function jobActions(job) {
  const j = job || {};
  return { edit: j.origin === 'user', copy: j.origin === 'instar' && !j.hasUserFork, revert: j.origin === 'user' && Boolean(j.hasUserFork) };
}

/** The confirm sentence for the On/Off switch, or null when it is one tap (as today: only switching OFF high/critical asks). */
export function toggleConfirm(job, enabled) {
  if (enabled) return null;
  if (job && (job.priority === 'critical' || job.priority === 'high')) return `Switch off ${job.name || job.slug}? It is a ${job.priority}-priority job; nothing runs it until it is switched back on.`;
  return null;
}

/** What a Run now answer means, from the status and body the server returned. */
export function runStartWords(status, data) {
  const d = data || {};
  const msg = String(d.error || d.message || '');
  if (status === 202) return { ok: true, queued: d.result === 'queued', text: d.result === 'queued' ? 'Queued behind other work…' : 'Started.' };
  if (status === 409 && /already running/i.test(msg)) return { ok: false, text: 'Already running.' };
  if (status === 409) return { ok: false, text: `The scheduler did not admit it${d.result ? ` (${String(d.result)})` : ''}. It may be switched off, paused, or meant for another machine.` };
  if (status === 429 && Number(d.retryAfterSeconds) > 0) return { ok: false, text: `Too soon after the last manual run; try again in ${spell(d.retryAfterSeconds)}.` };
  if (status === 429) return { ok: false, text: 'Too many manual runs at once; try again in a moment.' };
  if (status === 503) return { ok: false, text: 'The scheduler is not running on this machine.' };
  if (status === 404) return { ok: false, text: 'This job is no longer configured.' };
  if (status === 0) return { ok: false, text: 'The server could not be reached.' };
  return { ok: false, text: msg || `The server answered ${status}.` };
}

/** The follower's verdict from a later read of the job's state. { done, text } */
export function runFollowWords(state, startedAt, now = Date.now(), seenPending = false) {
  const s = state || {};
  const last = Date.parse(s.lastRun);
  if (s.lastResult === 'pending') return { done: false, pending: true, text: `Running ${spell((now - (Number.isFinite(last) ? last : startedAt)) / 1000)}` };
  const fresh = Number.isFinite(last) && last >= startedAt - 1000;
  if (!seenPending && !fresh) return { done: false, pending: false, text: 'Waiting for it to start…' };
  const took = Number.isFinite(last) ? ` in ${spell((now - last) / 1000)}` : '';
  if (s.lastResult === 'success') return { done: true, ok: true, text: `Done: succeeded${took}.` };
  if (s.lastResult === 'failure') return { done: true, ok: false, text: `Failed${s.lastError ? `: ${s.lastError}` : '.'}` };
  if (s.lastResult === 'timeout') return { done: true, ok: false, text: 'Timed out.' };
  return { done: true, ok: false, text: `Ended: ${resultWord(s.lastResult)}.` };
}

/** A refused save in words; the conflict message keeps its meaning and the operator's input. */
export function saveRefusalWords(status, data) {
  const d = data || {}; const msg = String(d.error || d.message || '');
  if (status === 409) return 'This job was saved by someone else since you opened it. Your edits here were not saved; close and reopen to see the newer copy.';
  if (status === 403) return 'Instar defaults cannot be edited directly. Make your own copy first.';
  if (status === 0) return 'The server could not be reached.';
  return msg || `The server answered ${status}.`;
}

// ── run history ────────────────────────────────────────────────────────────
/**
 * Marks for the strip and the dated list, newest first: runs from GET /jobs/:slug/history
 * merged with skips from GET /skip-ledger?slug= (each with its recorded reason).
 * { ok, reason, marks, strip, notes, total }
 */
export function buildHistory(histRes, skipRes, now = Date.now()) {
  if (!histRes || !histRes.ok) return { ok: false, reason: `Couldn't read its run history: ${histRes ? histRes.reason : 'not read'}.`, marks: [], strip: [], notes: [], total: 0 };
  const runs = Array.isArray(histRes.data && histRes.data.runs) ? histRes.data.runs : null;
  if (!runs) return { ok: false, reason: 'The run history answered without runs.', marks: [], strip: [], notes: [], total: 0 };
  const notes = [];
  const marks = runs.filter((r) => r && r.startedAt).map((r) => {
    const at = Date.parse(r.startedAt);
    const dur = Number(r.durationSeconds) > 0 ? spell(r.durationSeconds) : r.result === 'pending' ? `running ${spell((now - at) / 1000)}` : null;
    return { key: `run:${r.runId || r.startedAt}`, at, kind: r.result || 'pending', word: resultWord(r.result), duration: dur, error: r.error ? String(r.error) : null, trigger: r.trigger || null, machineId: r.machineId || null, record: r };
  });
  if (skipRes && skipRes.ok) {
    const events = Array.isArray(skipRes.data && skipRes.data.events) ? skipRes.data.events : [];
    for (const e of events) {
      if (!e || !e.timestamp) continue;
      marks.push({ key: `skip:${e.timestamp}`, at: Date.parse(e.timestamp), kind: 'skipped', word: skipWords(e.reason), duration: null, error: null, reason: e.reason || null, record: e });
    }
  } else if (skipRes && !skipRes.ok) notes.push(`Couldn't read its skips: ${skipRes.reason}.`);
  marks.sort((a, b) => b.at - a.at);
  const all = marks.slice(0, HISTORY_LIMIT);
  for (const m of all) m.day = dayLabel(m.at, now);
  return { ok: true, reason: null, marks: all, strip: all.slice(0, STRIP_LIMIT), notes, total: Number(histRes.data.total) || runs.length };
}

/** One mark's full text: date, time, what happened, how long, and the error or skip reason. */
export function markText(m, now = Date.now()) {
  const bits = [`${dayLabel(m.at, now)} ${clock(m.at)}`, m.word];
  if (m.duration) bits.push(m.duration);
  if (m.error) bits.push(m.error);
  if (m.trigger && m.trigger !== 'scheduled') bits.push(`started by ${String(m.trigger).replace(/[-_:]/g, ' ')}`);
  return bits.join(' · ');
}

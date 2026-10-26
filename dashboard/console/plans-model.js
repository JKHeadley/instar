// Plans page — pure view-model (docs/specs/console-features/work.md: "Projects",
// "Initiatives (the Plans page)", "Blockers — In the way inside Plans").
//
// One list for projects and initiatives (the same records, GET /initiatives with
// no excludeKind), with blockers as the "In the way" section ABOVE "In flight".
// Every decision lives here so it can be unit-tested; plans.js only renders.
// A value that could not be read says so; a zero is only "nothing" when the
// source proved it observed.

import { ago, failure, STALE_DAYS } from './home-model.js';

export { failure, ago };

const DAY = 86400000;
export const MOVING_MS = 7 * DAY;            // touched within 7 days = moving
export const OLDER_MS = STALE_DAYS * DAY;    // untouched 14+ days = "Older, still open"
export const CLEARED_WINDOW_MS = 7 * DAY;    // resolved blockers shown by default
export const PROJECT_DETAIL_CAP = 25;        // the legacy cap on per-project reads

export const OPEN_STATUSES = new Set(['active', 'paused', 'halted', 'awaiting-user']);
export const FINISHED_STATUSES = new Set(['completed', 'archived', 'abandoned']);

const STATUS_WORD = { active: 'in progress', paused: 'paused', halted: 'halted', 'awaiting-user': 'waiting on you', completed: 'completed', archived: 'archived', abandoned: 'abandoned' };
export function statusWord(s) { return STATUS_WORD[s] || String(s || 'unknown').replace(/[-_]/g, ' '); }

const STAGE_WORD = { outline: 'outlined', 'spec-drafted': 'written up', 'spec-converged': 'reviewed', approved: 'approved', building: 'being built', merged: 'merged', regressed: 'slipped back', skipped: 'skipped' };
export function stageWord(s) { return STAGE_WORD[s] || String(s || 'outline').replace(/[-_]/g, ' '); }

const ROUND_WORD = { pending: 'not started', ready: 'ready to start', 'in-progress': 'running', 'partially-complete': 'partly done', complete: 'done', 'complete-with-skips': 'done, some skipped', failed: 'failed', regressed: 'slipped back' };
/** A round's state in words. "Running" is said ONLY when a read shows it in progress. */
export function roundWord(r) {
  if (!r) return 'unknown';
  if (r.haltedAt) return 'stopped';
  return ROUND_WORD[r.status] || String(r.status || 'pending').replace(/[-_]/g, ' ');
}
export function roundDone(r) { return Boolean(r) && (r.status === 'complete' || r.status === 'complete-with-skips'); }

/** The round the project is on: the first that is not done; null when every round is done. */
export function currentRoundIndex(p) {
  const rounds = Array.isArray(p && p.rounds) ? p.rounds : [];
  const i = rounds.findIndex((r) => !roundDone(r));
  return i;
}

/** Whether a project is waiting for the operator's OK (an unacknowledged advance, or the first launch). */
export function projectNeedsOk(p) {
  if (!p || !OPEN_STATUSES.has(p.status)) return false;
  if ((Number(p.unacknowledgedAdvanceCount) || 0) > 0) return true;
  const cur = currentRoundIndex(p);
  return cur === 0 && !p.firstLaunchAckAt;
}

/** Pieces of a round, counted by stage in plain words: { total, merged, chips:[{word,n}] }. */
export function roundPieces(round, childrenById) {
  const ids = Array.isArray(round && round.itemIds) ? round.itemIds : [];
  const counts = {};
  for (const id of ids) {
    const c = childrenById.get(id);
    const st = (c && c.pipelineStage) || 'outline';
    counts[st] = (counts[st] || 0) + 1;
  }
  const order = ['merged', 'building', 'approved', 'spec-converged', 'spec-drafted', 'outline', 'regressed', 'skipped'];
  const chips = order.filter((k) => counts[k]).map((k) => ({ stage: k, word: stageWord(k), n: counts[k] }));
  return { total: ids.length, merged: counts.merged || 0, chips };
}

/** The drift verdict as a sentence with a tone (ok / attn / bad / unknown). */
export function driftSentence(round) {
  const v = round && round.lastDriftVerdict;
  if (!v || !v.verdict) return { text: 'No plan check recorded yet.', tone: 'unknown' };
  if (v.verdict === 'no-drift') return { text: 'Last check: the plan still holds.', tone: 'ok' };
  if (v.verdict === 'minor-drift') return { text: 'Last check: the plan has drifted a little; still workable.', tone: 'attn' };
  if (v.verdict === 'premise-violated') return { text: 'The plan’s starting assumption no longer holds — the agent paused it.', tone: 'bad' };
  if (v.verdict === 'manual-review-required') return { text: `Needs a human look${v.reason ? ` (${String(v.reason).replace(/[-_]/g, ' ')})` : ''}.`, tone: 'unknown' };
  return { text: `Last check: ${String(v.verdict).replace(/[-_]/g, ' ')}.`, tone: 'unknown' };
}

/** When a record was last touched (its own stamp, or its latest child's). */
export function touchedAt(rec, children = []) {
  const ts = [rec && rec.lastTouchedAt, rec && rec.updatedAt, ...children.map((c) => c && c.lastTouchedAt)]
    .map((t) => Date.parse(t)).filter(Number.isFinite);
  return ts.length ? Math.max(...ts) : 0;
}

/** The detail for one project: { project, children } | null (not loaded) | { failed: reason }. */
function detailOf(details, id) {
  const d = details && details[id];
  if (!d) return null;
  if (d.ok === false) return { failed: d.reason };
  const data = d.ok ? d.data : d;
  if (!data || !data.project) return { failed: 'the answer had no project in it' };
  return { project: data.project, children: Array.isArray(data.children) ? data.children : [] };
}

/** One project's round line: "Round 2 of 4 · 3 of 5 pieces merged · waiting for your OK". */
export function projectLine(p, children, now = Date.now()) {
  const rounds = Array.isArray(p.rounds) ? p.rounds : [];
  const cur = currentRoundIndex(p);
  const bits = [];
  if (!rounds.length) bits.push('no rounds yet');
  else if (cur === -1) bits.push(`all ${rounds.length} rounds done`);
  else {
    bits.push(`round ${cur + 1} of ${rounds.length}`);
    const pieces = roundPieces(rounds[cur], new Map(children.map((c) => [c.id, c])));
    if (pieces.total) bits.push(`${pieces.merged} of ${pieces.total} ${pieces.total === 1 ? 'piece' : 'pieces'} merged`);
    const w = roundWord(rounds[cur]);
    if (w !== 'not started') bits.push(w);
  }
  if (projectNeedsOk(p)) bits.push('waiting for your OK');
  else if (p.status === 'paused' || p.status === 'halted') bits.push(statusWord(p.status));
  const t = touchedAt(p, children);
  if (t) bits.push(`worked on ${ago(t, now)}`);
  return bits.join(' · ');
}

/** One initiative's line: "Step 3 of 5 · worked on 2 h ago". */
export function initiativeLine(i, now = Date.now()) {
  const phases = Array.isArray(i.phases) ? i.phases : [];
  const bits = [];
  if (phases.length) {
    const done = phases.filter((ph) => ph && ph.status === 'done').length;
    const step = Math.min(phases.length, (Number(i.currentPhaseIndex) || 0) + 1);
    bits.push(done === phases.length ? `all ${phases.length} steps done` : `step ${step} of ${phases.length}`);
  }
  if (i.needsUser) bits.push(i.needsUserReason ? `waiting on you: ${i.needsUserReason}` : 'waiting on you');
  else if (i.status === 'awaiting-user') bits.push('waiting on you');
  else if (i.status === 'paused' || i.status === 'halted') bits.push(statusWord(i.status));
  if (i.feedbackWorkKey) bits.push('from user feedback');
  const t = touchedAt(i);
  if (t) bits.push(`worked on ${ago(t, now)}`);
  return bits.join(' · ');
}

/** What a record waits for from the operator, or null when it does not. */
export function needsYouWords(rec, detail) {
  if (!rec || !OPEN_STATUSES.has(rec.status)) return null;
  if ((rec.kind || 'task') === 'project') {
    const p = detail && detail.project ? detail.project : rec;
    if (projectNeedsOk(p)) {
      const cur = currentRoundIndex(p);
      return cur === -1 ? 'Waiting for your OK' : `Waiting for your OK on round ${cur + 1}`;
    }
  }
  if (rec.needsUser) return rec.needsUserReason ? `Waiting on you: ${rec.needsUserReason}` : 'Waiting on you';
  if (rec.status === 'awaiting-user') return 'Waiting on you';
  return null;
}

// ── blockers ───────────────────────────────────────────────────────────────
const WORKING_STATES = new Set(['candidate', 'authority-checked', 'dry-run', 'live-run']);
const BLOCKER_WORD = {
  candidate: 'Just spotted', 'authority-checked': 'Checking who can clear it', 'access-requested': 'Waiting on you for access',
  'dry-run': 'Trying it safely first', 'live-run': 'Attempting it for real', resolved: 'Cleared — it turned out not to be a wall', 'true-blocker': 'Truly stuck for now',
};
export function blockerStateWord(e) { return BLOCKER_WORD[e && e.state] || String((e && e.state) || 'unknown').replace(/[-_]/g, ' '); }

function recheckText(e, now) {
  const t = e.terminal && e.terminal.kind === 'true-blocker' ? Date.parse(e.terminal.recheckAfter) : NaN;
  if (!Number.isFinite(t)) return { text: 'recheck not scheduled', overdue: false };
  if (t <= now) return { text: 'recheck overdue', overdue: true };
  return { text: `rechecking ${new Date(t).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}`, overdue: false };
}

/** A blocker as a row: { key, main, sub, end, tone, kind, record }. */
export function blockerRow(e, now = Date.now()) {
  const main = e.detectedText || e.origin || 'A blocker';
  let sub; let tone = null; let kind;
  if (e.state === 'true-blocker') { const r = recheckText(e, now); sub = `Truly stuck for now · ${r.text}`; tone = 'bad'; kind = 'stuck'; }
  else if (e.state === 'access-requested') { sub = 'Waiting on you for access'; tone = 'attn'; kind = 'needs-you'; }
  else if (e.state === 'resolved') { sub = 'Cleared — it turned out not to be a wall'; kind = 'cleared'; }
  else { sub = blockerStateWord(e); kind = 'working'; }
  return { key: `b:${e.id}`, id: e.id, type: 'blocker', main, sub, end: ago(e.updatedAt || e.createdAt, now) || '', tone, kind, overdue: kind === 'stuck' && recheckText(e, now).overdue, record: e };
}

/**
 * The In the way model from GET /blockers.
 * { state: 'off'|'failed'|'ok', reason, needsYou, stuck, working, clearedWeek, clearedOlder }
 */
export function buildInTheWay(res, now = Date.now()) {
  if (!res || !res.ok) {
    if (res && /switched off/.test(res.reason || '')) return { state: 'off', reason: 'Blocker tracking is off on this agent.', needsYou: [], stuck: [], working: [], clearedWeek: [], clearedOlder: [] };
    return { state: 'failed', reason: `Couldn't read what is in the way: ${res ? res.reason : 'not read'}.`, needsYou: [], stuck: [], working: [], clearedWeek: [], clearedOlder: [] };
  }
  const entries = Array.isArray(res.data && res.data.entries) ? res.data.entries : null;
  if (!entries) return { state: 'failed', reason: 'The blocker list answered without entries.', needsYou: [], stuck: [], working: [], clearedWeek: [], clearedOlder: [] };
  const out = { state: 'ok', reason: null, needsYou: [], stuck: [], working: [], clearedWeek: [], clearedOlder: [], total: Number(res.data.total) || entries.length };
  for (const e of entries) {
    if (!e || typeof e.state !== 'string') continue;
    const r = blockerRow(e, now);
    if (r.kind === 'needs-you') out.needsYou.push(r);
    else if (r.kind === 'stuck') out.stuck.push(r);
    else if (WORKING_STATES.has(e.state)) out.working.push(r);
    else if (e.state === 'resolved') {
      const t = Date.parse(e.updatedAt);
      if (Number.isFinite(t) && now - t <= CLEARED_WINDOW_MS) out.clearedWeek.push(r); else out.clearedOlder.push(r);
    }
  }
  return out;
}

/** The blocker detail story. */
export function blockerStory(e, now = Date.now()) {
  const lines = [{ label: 'What looked stuck', text: e.detectedText || '—' }];
  const tried = [];
  if (e.dryRun && e.dryRun.detail) tried.push(`Tried safely first: ${e.dryRun.detail}`);
  if (e.liveRun && e.liveRun.outcome) tried.push(`${e.liveRun.succeeded ? 'Tried for real, and it worked' : 'Tried for real, and it did not work'}: ${e.liveRun.outcome}`);
  if (e.authorityCheck && e.authorityCheck.note) tried.push(`Who can clear it: ${e.authorityCheck.note}`);
  if (tried.length) lines.push({ label: 'What was tried', text: tried.join('\n') });
  lines.push({ label: 'Where it stands', text: blockerStateWord(e) });
  if (e.terminal && e.terminal.kind === 'true-blocker') {
    const r = recheckText(e, now);
    lines.push({ label: 'Why', text: `${String(e.terminal.reasonKind || 'reason unknown').replace(/-/g, ' ')}${e.terminal.rebuttal ? ` — ${e.terminal.rebuttal}` : ''}` });
    lines.push({ label: 'Recheck', text: r.text });
  }
  if (e.terminal && e.terminal.kind === 'resolved') {
    const pb = e.terminal.playbookPath ? String(e.terminal.playbookPath).split('/').pop() : null;
    lines.push({ label: 'Outcome', text: `It turned out not to be a wall${pb ? ` — playbook: ${pb}` : ''}.` });
  }
  lines.push({ label: 'First seen', text: ago(e.createdAt, now) || '—' });
  return lines;
}

// ── autonomous runs ────────────────────────────────────────────────────────
function minutes(ms) { return Math.floor((Number(ms) || 0) / 60000); }
function spell(mins) { if (mins < 60) return `${mins} min`; const h = Math.floor(mins / 60); const m = mins % 60; return m ? `${h} h ${m} min` : `${h} h`; }
/** One observed run as a row. */
export function autonomousRow(r, topicNames = {}) {
  const topic = r.topicId;
  const main = topicNames[String(topic)] || (topic != null ? `Topic ${topic}` : 'A conversation');
  const d = r.decision;
  let sub; let tone = null;
  if (d === 'healthy') sub = 'making progress';
  else if (d === 'flatline-observed') { sub = `no new work and no message from me for ${spell(minutes(Math.min(Number(r.outputFlatForMs || 0), Number(r.managerSilentForMs || 0))))}`; tone = 'attn'; }
  else if (d === 'baseline') sub = 'just started being watched';
  else { sub = `can’t tell${r.reason ? ` · ${String(r.reason).replace(/[-_]/g, ' ')}` : ''}`; tone = 'unknown'; }
  return { key: `run:${r.signalRunId || topic}`, type: 'run', main, sub, end: r.at ? ago(r.at) || '' : '', tone, record: r };
}
/** The Autonomous runs model: { state:'off'|'failed'|'ok', reason, rows, openOnArrival }. */
export function buildAutonomousRuns(res, topicNames = {}) {
  if (!res || !res.ok) {
    if (res && /switched off/.test(res.reason || '')) return { state: 'off', reason: 'Autonomous runs aren’t observed on this agent.', rows: [], openOnArrival: false };
    return { state: 'failed', reason: `Couldn't read autonomous runs: ${res ? res.reason : 'not read'}.`, rows: [], openOnArrival: false };
  }
  const runs = Array.isArray(res.data && res.data.runs) ? res.data.runs : null;
  if (!runs) return { state: 'failed', reason: 'The autonomous-run status answered without its runs.', rows: [], openOnArrival: false };
  const rows = runs.filter(Boolean).map((r) => autonomousRow(r, topicNames));
  return { state: 'ok', reason: null, rows, openOnArrival: rows.some((r) => r.record.decision === 'flatline-observed') };
}

// ── the page ───────────────────────────────────────────────────────────────
/** A plan (project or initiative) as a row. */
export function planRow(rec, detail, now = Date.now()) {
  const isProject = (rec.kind || 'task') === 'project';
  const p = isProject && detail && detail.project ? detail.project : rec;
  const children = isProject && detail && detail.children ? detail.children : [];
  const need = needsYouWords(rec, detail);
  let sub;
  if (isProject) sub = detail && detail.failed ? `Couldn't load its rounds: ${detail.failed}` : projectLine(p, children, now);
  else sub = initiativeLine(rec, now);
  return {
    key: `plan:${rec.id}`, id: rec.id, type: isProject ? 'project' : 'initiative', main: rec.title || rec.id, sub,
    end: need ? 'Open' : statusWord(rec.status), tone: need ? 'attn' : rec.status === 'halted' ? 'bad' : null,
    needs: need, status: rec.status, record: p, children, detailFailed: detail && detail.failed ? detail.failed : null, touched: touchedAt(p, children),
  };
}

/**
 * Build the whole Plans page.
 * res: { initiatives, digest, projects, details: {id → detail read}, blockers, floor }
 * opts: { filter: {status?, done?}, topicNames }
 * Returns { ok:false, reason } or { ok:true, headline, sub, tone, facts, counts, sections, chips, doneChips,
 *   inTheWay, runs, notes, digestReasons, truncated }.
 */
export function buildPlansPage(res, now = Date.now(), opts = {}) {
  const r = res || {};
  const init = r.initiatives;
  if (!init || !init.ok) {
    if (init && /switched off/.test(init.reason || '')) return { ok: false, reason: 'Plan tracking is off on this agent.' };
    return { ok: false, reason: `Couldn't read plans: ${init ? init.reason : 'not read'}.` };
  }
  const items = Array.isArray(init.data && init.data.items) ? init.data.items.filter((i) => i && typeof i === 'object') : null;
  if (!items) return { ok: false, reason: 'The plan list answered without records.' };
  const filter = opts.filter || {};
  const byId = new Map(items.map((i) => [i.id, i]));
  const notes = [];

  // Projects: the same records; /projects (when it answered) and the per-project
  // detail reads add rounds and children. A failed read marks that one row only.
  const projects = r.projects;
  if (projects && !projects.ok && !/switched off/.test(projects.reason || '')) notes.push(`Couldn't read the project list: ${projects.reason}. Round detail may be missing.`);
  const details = r.details || {};
  const projectCount = items.filter((i) => (i.kind || 'task') === 'project' && OPEN_STATUSES.has(i.status)).length;
  const truncated = projectCount > PROJECT_DETAIL_CAP ? { shown: PROJECT_DETAIL_CAP, total: projectCount } : null;

  // The digest adds its reasons (check-in due, ready to move on, idle) to detail sheets.
  const digest = r.digest;
  const digestReasons = {};
  if (!digest || !digest.ok) notes.push(`Couldn't read the check-in digest: ${digest ? digest.reason : 'not read'}. What needs you is read from each plan’s own record.`);
  else for (const s of (Array.isArray(digest.data && digest.data.items) ? digest.data.items : [])) if (s && s.initiativeId) (digestReasons[s.initiativeId] = digestReasons[s.initiativeId] || []).push(s);

  // Children fold under a parent that is in the list.
  const topLevel = items.filter((i) => !(i.parentProjectId && byId.has(i.parentProjectId)));
  const rows = topLevel.map((rec) => planRow(rec, (rec.kind || 'task') === 'project' ? detailOf(details, rec.id) : null, now));

  const s = { needsYou: [], inFlight: [], idle: [], older: [], finished: [] };
  const olderNeedsYou = [];
  for (const row of rows) {
    if (FINISHED_STATUSES.has(row.status)) { s.finished.push(row); continue; }
    if (!OPEN_STATUSES.has(row.status)) continue;
    const age = row.touched ? now - row.touched : 0;
    if (age >= OLDER_MS) { s.older.push(row); if (row.needs) olderNeedsYou.push(row); continue; }
    if (row.needs) s.needsYou.push(row);
    else if (age <= MOVING_MS) s.inFlight.push(row);
    else s.idle.push(row);
  }
  const inTheWay = buildInTheWay(r.blockers, now);
  // A blocker that asked for access is a needs-you item, not a working one.
  for (const b of inTheWay.needsYou) s.needsYou.push({ ...b, needs: 'I need access to continue', end: 'Open' });

  // Status chips above In flight: only the states present, with counts, computed before filtering.
  const openRows = [...s.inFlight, ...s.idle, ...s.older];
  const chipCounts = { paused: 0, halted: 0, 'awaiting-user': 0 };
  for (const row of openRows) if (row.status in chipCounts) chipCounts[row.status]++;
  const chips = [['paused', 'Paused'], ['halted', 'Halted'], ['awaiting-user', 'Waiting on you']].filter(([k]) => chipCounts[k]).map(([k, label]) => ({ key: k, label, n: chipCounts[k], on: filter.status === k }));
  const doneCounts = { completed: 0, archived: 0, abandoned: 0 };
  for (const row of s.finished) doneCounts[row.status]++;
  const doneChips = [['completed', 'Completed'], ['archived', 'Archived'], ['abandoned', 'Abandoned']].filter(([k]) => doneCounts[k]).map(([k, label]) => ({ key: k, label, n: doneCounts[k], on: filter.done === k }));

  const byTouched = (a, b) => (b.touched || 0) - (a.touched || 0);
  for (const k of Object.keys(s)) s[k].sort(byTouched);
  const planNeedsYou = s.needsYou.filter((x) => x.type !== 'blocker').length;
  const counts = { needsYou: s.needsYou.length, planNeedsYou, inFlight: s.inFlight.length, idle: s.idle.length, older: s.older.length, finished: s.finished.length, olderNeedsYou: olderNeedsYou.length, stuck: inTheWay.stuck.length, working: inTheWay.working.length };
  const sections = {
    needsYou: s.needsYou,
    inFlight: filter.status ? s.inFlight.filter((x) => x.status === filter.status) : s.inFlight,
    idle: filter.status ? s.idle.filter((x) => x.status === filter.status) : s.idle,
    older: filter.status ? s.older.filter((x) => x.status === filter.status) : s.older,
    finished: filter.done ? s.finished.filter((x) => x.status === filter.done) : s.finished,
  };

  const open = counts.inFlight + counts.idle + counts.planNeedsYou; // plans, not blockers
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  let headline;
  if (open === 0 && counts.older === 0 && counts.stuck === 0) headline = 'No longer plans are running.';
  else {
    const clauses = [];
    if (counts.needsYou) clauses.push(`${plural(counts.needsYou, 'needs', 'need')} you`);
    if (counts.stuck) clauses.push(`${plural(counts.stuck, 'is', 'are')} stuck`);
    headline = `${plural(open, 'plan', 'plans')} in flight.${clauses.length ? ` ${clauses.join('; ')}.` : ''}`;
  }
  const sub = [
    counts.older ? `${counts.older} older, still open.` : null,
    truncated ? `Round detail loaded for ${truncated.shown} of ${truncated.total} projects.` : null,
    'Plans on this machine.',
  ].filter(Boolean).join(' ');
  const facts = [
    { n: counts.needsYou, label: counts.needsYou === 1 ? 'needs you' : 'need you', tone: counts.needsYou ? 'attn' : null, href: '#/work/plans?s=needsYou' },
    inTheWay.state === 'ok' ? { n: counts.stuck + counts.working, label: 'in the way', tone: counts.stuck ? 'bad' : null, href: '#/work/plans?s=in-the-way' }
      : inTheWay.state === 'off' ? { n: 'off', label: 'blocker tracking', tone: 'unknown', href: '#/work/plans?s=in-the-way' }
        : { n: 'Can’t tell', label: 'in the way', tone: 'unknown', href: '#/work/plans?s=in-the-way' },
    { n: counts.inFlight, label: 'moving', href: '#/work/plans?s=inFlight' },
    { n: counts.idle + counts.older, label: 'idle', href: '#/work/plans?s=idle' },
  ];
  return {
    ok: true, headline, sub, tone: counts.needsYou ? 'attn' : counts.stuck ? 'bad' : 'ok', facts, counts, sections, chips, doneChips,
    inTheWay, runs: buildAutonomousRuns(r.floor, opts.topicNames || {}), notes, digestReasons, truncated,
  };
}

// ── project detail ─────────────────────────────────────────────────────────
/** The rounds track for the detail sheet. */
export function roundsTrack(p, children = []) {
  const rounds = Array.isArray(p.rounds) ? p.rounds : [];
  const cur = currentRoundIndex(p);
  const byId = new Map(children.map((c) => [c.id, c]));
  return rounds.map((r, i) => {
    const pieces = roundPieces(r, byId);
    const state = roundDone(r) ? 'done' : r.haltedAt || r.status === 'failed' ? 'halted' : i === cur ? 'current' : 'future';
    return { index: i, name: r.name || `Round ${i + 1}`, state, word: roundWord(r), pieces, round: r,
      items: (Array.isArray(r.itemIds) ? r.itemIds : []).map((id) => { const c = byId.get(id); return { id, title: c ? c.title || id : id, stage: c ? stageWord(c.pipelineStage) : 'not loaded', pr: c && c.prNumber ? c.prNumber : null }; }) };
  });
}

/** Which actions a project offers: { ack: roundIndex|null, stop: roundIndex|null, resume: [roundIndex…] }. */
export function projectActions(p) {
  const out = { ack: null, stop: null, resume: [] };
  if (!p || !OPEN_STATUSES.has(p.status)) return out;
  const rounds = Array.isArray(p.rounds) ? p.rounds : [];
  const cur = currentRoundIndex(p);
  if (projectNeedsOk(p)) out.ack = cur === -1 ? 0 : cur;
  rounds.forEach((r, i) => { if (r.haltedAt || r.status === 'failed') out.resume.push(i); });
  if (cur !== -1 && !rounds[cur].haltedAt && rounds[cur].status !== 'failed') out.stop = cur;
  return out;
}

/** The three answers, told apart by what the server returned — never by the button pressed. */
export function resultWords(kind, data) {
  const d = data || {};
  if (kind === 'ack') return typeof d.lastAckedRoundIndex === 'number' || d.firstLaunchAckAt ? 'Your OK is recorded. It does not start the round by itself.' : 'Your OK was accepted.';
  if (kind === 'resume') return d.scheduledAt ? 'Scheduled to resume. It says “running” only once a later read shows the round in progress.' : 'Resume accepted.';
  if (kind === 'stop') return typeof d.roundIndex === 'number' ? `Stop requested for round ${d.roundIndex + 1}. It shows as stopped once the next read confirms it.` : 'Stop requested.';
  return 'Done.';
}

/** A refusal in words; a version conflict is the one that means "refresh". */
export function refusalWords(reason) {
  const r = String(reason || 'That did not work.');
  if (/version mismatch/i.test(r)) return { text: 'Changed while you looked; refreshed.', refresh: true };
  if (/no halt-able round/i.test(r)) return { text: 'Nothing to stop: no round of this plan is running.', refresh: false };
  if (/not halted or failed/i.test(r)) return { text: 'This round is not stopped or failed, so there is nothing to resume.', refresh: false };
  if (/resume-attempts cap/i.test(r)) return { text: 'This round has hit its retry limit; the agent has to clear it.', refresh: false };
  if (/not configured/i.test(r)) return { text: 'The round runner is off on this agent, so this cannot be done from here.', refresh: false };
  return { text: r, refresh: false };
}

/** Links on a record as chips: { label, href|null, text }. */
export function linkChips(rec, topicHref) {
  const links = Array.isArray(rec && rec.links) ? rec.links : [];
  const out = links.map((l) => {
    if (!l) return null;
    const label = l.label || l.type || 'link';
    if (l.url && /^https?:\/\//.test(l.url)) return { label, href: l.url, text: l.type || 'link' };
    if (l.type === 'topic' && l.ref && topicHref) { const h = topicHref(l.ref); if (h) return { label, href: h, text: 'topic' }; }
    return { label: l.ref ? `${label} (${l.ref})` : label, href: null, text: l.type || 'link' };
  }).filter(Boolean);
  if (rec && rec.telegramTopicId && topicHref) { const h = topicHref(rec.telegramTopicId); if (h) out.unshift({ label: 'Its conversation', href: h, text: 'topic' }); }
  return out;
}

/** The initiative's steps as a checklist with dates. */
export function stepList(rec, now = Date.now()) {
  const phases = Array.isArray(rec && rec.phases) ? rec.phases : [];
  return phases.map((ph, i) => ({
    name: ph.name || ph.id || `Step ${i + 1}`, done: ph.status === 'done', current: i === Number(rec.currentPhaseIndex), blocked: ph.status === 'blocked',
    when: ph.completedAt ? `done ${ago(ph.completedAt, now)}` : ph.startedAt ? `started ${ago(ph.startedAt, now)}` : ph.status === 'blocked' ? 'blocked' : ph.status === 'in-progress' ? 'in progress' : '',
  }));
}

const REASON_WORD = { 'needs-user': 'Waiting on you', 'next-check-due': 'Time for a check-in', 'ready-to-advance': 'Ready to move forward', stale: 'Hasn’t moved in a while', 'feedback-summary': 'Feedback work items' };
export function reasonWord(r) { return REASON_WORD[r] || String(r || '').replace(/[-_]/g, ' '); }

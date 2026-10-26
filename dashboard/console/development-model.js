// Development page — pure view-model (docs/specs/console-features/under-the-hood.md:
// "PR pipeline" → Shipping, "Feedback drain" → Feedback, "Throughput" → Pace, and
// "The two combined pages"). Maintainer-only by VISIBILITY: nothing here grants or
// relies on authority; every write keeps its server gate.
//
// Every decision lives here so it can be unit-tested; development.js only renders.
// The honesty rules this file enforces:
//   - each read is tracked on its own: a 503 is "off on this agent", any other
//     failure is "Can't tell" with the reason, and a failed read never becomes a
//     calm zero ("Nothing needs you" is said only when every read that feeds the
//     to-do list answered);
//   - a plan's rendered text is carried VERBATIM and its planId + nonce are bound to
//     the commit; the console never paraphrases in its place;
//   - Pace shows the window's own sums and labels medians as per-day values (the
//     route returns one median per day; a whole-window median cannot be recovered
//     from them, so none is claimed) and never does client-side comparison math;
//   - the release line reports the release watchdog's unresolved episodes only;
//     it is never a release inventory.

import { ago } from './home-model.js';

export const DEV_TOOLS_KEY = 'instar_console_dev_tools';   // per-browser "show developer tools" switch
export const WATCHER_CADENCE_MS = 600000;                  // GreenPrAutoMerger tickIntervalMs default (10 min)
export const VERIFY_MINUTES = 45;                           // a full local verify takes about this long
export const ARMED_OVERDUE_MS = 24 * 3600000;               // the watcher's own armed-confirm ceiling
export const STALL_TICKS = 6;                               // readiness ticks in a row with no usable answer (about 3 h)
export const PACE_WINDOWS = [7, 14, 30];
export const PACE_PEOPLE = [{ key: 'team', label: 'Everyone' }, { key: 'codey', label: 'Codey' }, { key: 'echo', label: 'Echo' }, { key: 'other', label: 'Others' }];
export const PACE_METRICS = [
  { key: 'merges', label: 'Merged', unit: '', perDay: false, explain: 'Pull requests merged that day.' },
  { key: 'medianLatencyH', label: 'Time to merge', unit: 'h', perDay: true, explain: 'The median hours from opening to merge, among that day’s merges.' },
  { key: 'redone', label: 'Redone', unit: '', perDay: false, explain: 'Rework loops (changes requested) plus reverts that day.' },
  { key: 'medianLoc', label: 'Size', unit: 'lines', perDay: true, explain: 'The median changed lines, among that day’s merges.' },
  { key: 'medianPushIters', label: 'Push iterations', unit: '', perDay: true, explain: 'The median number of commits on a merged pull request that day.' },
  { key: 'index', label: 'Index', unit: '', perDay: false, teamOnly: true, explain: 'A weighted blend of the four above, 0–100, for everyone together.' },
];

// ── read outcomes ────────────────────────────────────────────────────────────
/** 'ok' | 'off' (503) | 'failed' (anything else). A 503 reads as switched off, never as broken. */
export function sourceState(res) {
  if (!res) return 'failed';
  if (res.ok) return 'ok';
  return res.status === 503 || /switched off/.test(res.reason || '') ? 'off' : 'failed';
}
const reasonOf = (res) => (res && res.reason) || 'no answer';
const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
const at = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// ── maintainer mode (visibility only) ────────────────────────────────────────
/**
 * Whether the Development tile is shown. The plan proposed a `consoleProfile` field on
 * /health; it does not exist, so this is decided client-side from two repo-gated reads
 * (/local-verify, /green-pr-automerge: 200 = an Instar source checkout is being watched).
 * `override` is the per-browser switch: 'on' forces the tile; anything else defers to the reads.
 * It is a VISIBILITY preference only — every server gate stays.
 */
export function maintainerMode({ localVerify, greenPr } = {}, override = null) {
  const states = { localVerify: sourceState(localVerify), greenPr: sourceState(greenPr) };
  const detected = states.localVerify === 'ok' || states.greenPr === 'ok' ? 'yes'
    : states.localVerify === 'off' && states.greenPr === 'off' ? 'no' : 'cant-tell';
  const basis = detected === 'yes' ? `${states.localVerify === 'ok' ? 'local verify' : 'the merge watcher'} answered on this agent`
    : detected === 'no' ? 'neither local verify nor the merge watcher is set up on this agent'
      : `couldn’t tell: ${reasonOf(states.localVerify === 'failed' ? localVerify : greenPr)}`;
  return { visible: override === 'on' || detected === 'yes', detected, basis, forced: override === 'on' };
}

// ── Shipping (legacy pr-pipeline; reads the three live systems) ──────────────
const STAGES = ['queued', 'verifying', 'passed', 'set to merge', 'merged'];
function prHref(repo, pr) { return repo ? `https://github.com/${repo}/pull/${pr}/files` : null; }

function shippingRow(group, pr, sub, end, tone, record, repo, stage) {
  return { key: `${group}:${pr}`, pr, group, main: `#${pr}`, sub, end: end || '', tone, record, href: prHref(repo, pr), stage, stages: STAGES };
}

/** The watcher's own health line (slow vs stuck vs silently failed are separate states). */
export function watcherLine(w, now = Date.now()) {
  if (!w) return { text: 'Merge watcher: no reading.', tone: 'unknown' };
  if (w.invariantOk === false) return { text: 'Merge watcher: its safety invariant failed; it will not arm anything until that clears.', tone: 'bad' };
  if (w.breaker && w.breaker.open) return { text: 'Merge watcher paused itself after repeated failures.', tone: 'bad' };
  const gate = w.gate || {};
  if (Array.isArray(gate.rollback) && gate.rollback.length) return { text: 'Auto-merging is stopped (you or the agent rolled it back). Turn it back on below.', tone: 'attn', stopped: true };
  if (!w.lastTickAt) return { text: 'Merge watcher has not checked yet.', tone: 'unknown' };
  const age = now - w.lastTickAt;
  if (age > 2 * WATCHER_CADENCE_MS) return { text: `Merge watcher last checked ${ago(w.lastTickAt, now)}, usually every ${Math.round(WATCHER_CADENCE_MS / 60000)} min.`, tone: 'attn' };
  return { text: `Merge watcher checked ${ago(w.lastTickAt, now)}.`, tone: 'ok' };
}

/** The release watchdog line: unresolved episodes only, never a release inventory. */
export function releaseLine(res, now = Date.now()) {
  const st = sourceState(res);
  if (st === 'off') return { text: 'Release watchdog: off on this agent.', tone: 'off' };
  if (st === 'failed') return { text: `Release watchdog: can’t tell (${reasonOf(res)}).`, tone: 'unknown' };
  const d = res.data || {};
  if (d.disabled) return { text: 'Release watchdog: switched off.', tone: 'attn' };
  // No tick yet means no finding either way: "nothing unresolved" would be a calm zero nobody measured.
  if (!d.lastTickAt) return { text: 'Release status unknown: the release watchdog has not checked yet.', tone: 'unknown' };
  const when = ` · last checked ${ago(d.lastTickAt, now)}`;
  const n = Number(d.openEpisodes) || 0;
  if (n > 0) return { text: `Release watchdog: ${plural(n, 'unresolved episode')}${when}.`, tone: 'attn', attentionId: d.openAttentionId || null, sha: d.oldestOpenSha || null };
  return { text: `Release watchdog: nothing unresolved${when}.`, tone: 'ok' };
}

/**
 * Shipping from /green-pr-automerge (watcher), /local-verify (verify) and /release-readiness
 * (release). Each tile comes from its own source; a failed source dashes its tile only.
 */
export function buildShipping({ watcher, verify, release } = {}, now = Date.now(), { repo = null } = {}) {
  const ws = sourceState(watcher), vs = sourceState(verify);
  const vStatus = verify && verify.status;
  if (ws === 'off' && vs === 'off') {
    return { state: 'off', reason: 'Shipping tools aren’t set up on this machine (no Instar source checkout is being watched here).', tiles: [], rows: [], headline: 'Shipping tools aren’t set up on this machine.', tone: 'muted', release: releaseLine(release, now), watcher: null };
  }
  const w = ws === 'ok' ? (watcher.data || {}) : null;
  const v = vs === 'ok' ? (verify.data || {}) : null;
  const rows = [];
  const tile = (key, label, n, tone, reason) => ({ key, label, n, tone, reason: reason || null });
  const tiles = [];

  // Needs you: code-owner review entries + approval-required episodes (watcher).
  if (w) {
    const entries = Array.isArray(w.snapshot && w.snapshot.entries) ? w.snapshot.entries : [];
    const episodes = Array.isArray(w.episodes) ? w.episodes : [];
    const seen = new Set();
    for (const e of entries) if (e && e.kind === 'code-owner-review' && !seen.has(e.pr)) { seen.add(e.pr); rows.push(shippingRow('needs', e.pr, 'waiting for your code-owner review on GitHub', w.snapshot.at ? ago(w.snapshot.at, now) : '', 'attn', e, repo, 'passed')); }
    for (const ep of episodes) if (ep && ep.lastOutcome === 'refused:approval-required' && !seen.has(ep.pr)) { seen.add(ep.pr); rows.push(shippingRow('needs', ep.pr, 'waiting for your approval on GitHub', ep.lastAttemptAt ? ago(ep.lastAttemptAt, now) : '', 'attn', ep, repo, 'passed')); }
    tiles.push(tile('needs', 'Needs you', seen.size, seen.size ? 'attn' : null));
    // Stuck: stuck-red PRs + episodes that gave up.
    const stuck = new Set();
    for (const s of Array.isArray(w.stuckRed) ? w.stuckRed : []) { stuck.add(s.pr); rows.push(shippingRow('stuck', s.pr, `checks have been red for ${String(ago(now - (s.redForMs || 0), now)).replace(' ago', '')}${s.failingChecks && s.failingChecks.length ? ` (${s.failingChecks.slice(0, 3).join(', ')})` : ''}`, '', 'bad', s, repo, 'queued')); }
    for (const ep of episodes) if (ep && ep.state === 'gave-up' && !stuck.has(ep.pr)) { stuck.add(ep.pr); rows.push(shippingRow('stuck', ep.pr, `the watcher gave up after ${plural(ep.attempts || 0, 'attempt')}${ep.lastOutcome ? ` · last: ${String(ep.lastOutcome).replace(/[:-]/g, ' ')}` : ''}`, ep.lastAttemptAt ? ago(ep.lastAttemptAt, now) : '', 'bad', ep, repo, 'queued')); }
    // Held: a deliberate marker; shown, never counted as stuck.
    for (const ep of episodes) if (ep && ep.lastOutcome === 'held' && ep.state !== 'gave-up' && !stuck.has(ep.pr) && !seen.has(ep.pr)) rows.push(shippingRow('held', ep.pr, 'held by its [HOLD] marker or label; the watcher leaves it alone', ep.lastAttemptAt ? ago(ep.lastAttemptAt, now) : '', 'unknown', ep, repo, 'queued'));
  } else {
    tiles.push(tile('needs', 'Needs you', 'Can’t tell', 'unknown', ws === 'off' ? 'the merge watcher is off on this agent' : reasonOf(watcher)));
  }

  // Testing: the local-verify queue (position = index) and the in-flight run.
  if (v) {
    const queue = (Array.isArray(v.queue) ? v.queue : []).filter((q) => q && q.kind !== 'main');
    const inflight = v.inFlight && v.inFlight.kind !== 'main' ? v.inFlight : null;
    if (inflight) rows.push(shippingRow('testing', inflight.pr, `testing now · about ${VERIFY_MINUTES} min`, '', null, inflight, repo, 'verifying'));
    queue.forEach((q, i) => rows.push(shippingRow('testing', q.pr, `${ordinal(i + 1)} in line · about ${VERIFY_MINUTES} min each`, q.firstQueuedAt ? ago(q.firstQueuedAt, now) : '', null, q, repo, 'queued')));
    const n = queue.length + (inflight ? 1 : 0);
    tiles.push(tile('testing', 'Testing', n, null, v.blocked ? 'the verifier is blocked' : null));
  } else if (vStatus === 409) {
    const holder = verify.data && verify.data.holderMachineId;
    tiles.push(tile('testing', 'Testing', 'Can’t tell', 'unknown', `testing runs on ${holder || 'the lease-holding machine'}; open the console there for the queue`));
  } else {
    tiles.push(tile('testing', 'Testing', 'Can’t tell', 'unknown', vs === 'off' ? 'local verify is off on this agent' : reasonOf(verify)));
  }

  // Set to merge: armed episodes (GitHub merges when checks pass); overdue past 24 h.
  if (w) {
    const armed = Array.isArray(w.armed) ? w.armed : [];
    let overdue = 0;
    for (const a of armed) {
      const late = a.overdue === true || (a.armedAt && now - a.armedAt > ARMED_OVERDUE_MS);
      if (late) overdue++;
      rows.push(shippingRow('armed', a.pr, late ? 'set to merge, but waiting on checks for over a day' : 'set to merge · GitHub merges when checks pass', a.armedAt ? ago(a.armedAt, now) : '', late ? 'attn' : null, a, repo, 'set to merge'));
    }
    tiles.push(tile('armed', 'Set to merge', armed.length, overdue ? 'attn' : null, overdue ? `${plural(overdue, 'is', 'are')} overdue` : null));
    const stuckN = rows.filter((r) => r.group === 'stuck').length;
    tiles.push(tile('stuck', 'Stuck', stuckN, stuckN ? 'bad' : null));
  } else {
    tiles.push(tile('armed', 'Set to merge', 'Can’t tell', 'unknown', ws === 'off' ? 'the merge watcher is off on this agent' : reasonOf(watcher)));
    tiles.push(tile('stuck', 'Stuck', 'Can’t tell', 'unknown', ws === 'off' ? 'the merge watcher is off on this agent' : reasonOf(watcher)));
  }

  // One row per PR. A PR the three systems each know (stuck-red in the watcher AND queued in
  // local verify, say) keeps ONE main state by this precedence, worst news first:
  //   needs you > stuck > set to merge > testing > held
  // and carries the other states as `also` for its sheet. The tiles count the SAME rows, so
  // Needs you + Testing + Set to merge + Stuck = the PRs on the way, exactly.
  const precedence = { needs: 0, stuck: 1, armed: 2, testing: 3, held: 4 };
  const byPr = new Map();
  for (const r of rows.slice().sort((a, b) => precedence[a.group] - precedence[b.group])) {
    const kept = byPr.get(r.pr);
    if (!kept) byPr.set(r.pr, { ...r, also: [] });
    else kept.also.push({ group: r.group, sub: r.sub, record: r.record });
  }
  // Listed worst-news first, then the pipeline order: needs you, stuck, testing, set to merge, held.
  const order = { needs: 0, stuck: 1, testing: 2, armed: 3, held: 4 };
  rows.length = 0; rows.push(...[...byPr.values()].sort((a, b) => order[a.group] - order[b.group] || a.pr - b.pr));
  const countOf = (g) => rows.filter((r) => r.group === g).length;
  for (const t of tiles) if (typeof t.n === 'number') t.n = countOf(t.key);
  const needs = countOf('needs');
  const stuck = countOf('stuck');
  const held = countOf('held');
  const moving = rows.length - held;
  // Why they are stuck, for the page's sub line (never a repeat of the count).
  const stuckRows = rows.filter((r) => r.group === 'stuck');
  const redChecks = stuckRows.filter((r) => r.record && typeof r.record.redForMs === 'number').length;
  const gaveUp = stuckRows.length - redChecks;
  const stuckWhy = stuckRows.length ? [redChecks ? `${redChecks} ${redChecks === 1 ? 'has' : 'have'} red checks` : null, gaveUp ? `the merge watcher gave up on ${gaveUp}` : null].filter(Boolean).join('; ') : null;
  const wl = w ? watcherLine(w, now) : null;
  const listFresh = Boolean(w && w.lastSuccessfulListAt && now - w.lastSuccessfulListAt <= 2 * WATCHER_CADENCE_MS);

  let headline, tone = 'ok';
  if (!w) { headline = `Can’t tell what is on the way to merge: ${ws === 'off' ? 'the merge watcher is off on this agent' : reasonOf(watcher)}.`; tone = 'muted'; }
  else if (moving === 0) {
    headline = listFresh ? 'Nothing on the way to merge.' : `No pull requests listed, but the watcher’s last successful look was ${w.lastSuccessfulListAt ? ago(w.lastSuccessfulListAt, now) : 'never'}.`;
    tone = listFresh ? 'ok' : 'muted';
  } else {
    headline = `${plural(moving, 'pull request')} on the way.${needs ? ` ${plural(needs, 'needs', 'need')} your approval on GitHub.` : ''}${stuck ? ` ${plural(stuck, 'is', 'are')} stuck.` : ''}`;
    tone = needs ? 'attn' : stuck ? 'bad' : 'ok';
  }
  const armedPrs = w && Array.isArray(w.armed) ? w.armed.map((a) => a.pr) : [];
  return {
    state: 'ok', headline, tone, tiles, rows, watcher: wl, release: releaseLine(release, now),
    partial: !w || !v, armedPrs, stopped: Boolean(wl && wl.stopped), rollbackLatches: (w && w.gate && Array.isArray(w.gate.rollback)) ? w.gate.rollback : [],
    line: !w ? 'Shipping: can’t tell' : `Shipping: ${moving === 0 ? 'nothing on the way' : `${moving} on the way`}${needs ? `, ${needs} need${needs === 1 ? 's' : ''} you` : ''}${stuck ? `, ${stuck} stuck` : ''}`,
    counts: { needs, stuck, held, moving, testing: countOf('testing'), armed: countOf('armed') }, stuckWhy,
    repoKnown: Boolean(repo),
  };
}
function ordinal(n) { return n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`; }

/** Words for the hold result (never a blanket "held": the server says whether an armed merge was disarmed). */
export function holdWords(status, data) {
  const d = data || {};
  if (status >= 200 && status < 300 && d.ok !== false) return { ok: true, text: `Held. #${d.pr} is marked [HOLD]; the watcher will not arm it, and any in-flight merge was disarmed.` };
  if (status === 502 && /could not disable/.test(d.detail || '')) return { ok: false, text: `The hold marker was applied, but the in-flight auto-merge could NOT be disabled — #${d.pr} may still merge. Disable it on GitHub directly.` };
  if (status === 404 || status === 400) return { ok: false, text: d.detail || d.error || 'That pull request is not eligible for a hold.' };
  return { ok: false, text: d.detail || d.error || `The server answered ${status}.` };
}

/** Words for POST /local-verify. */
export function verifyWords(status, data) {
  const d = data || {};
  if (d.ok === true) {
    if (d.status === 'queued') return { ok: true, text: `Queued${typeof d.position === 'number' ? `, ${ordinal(d.position + 1)} in line` : ''}. A full verify takes about ${VERIFY_MINUTES} min.` };
    if (d.status === 'already-queued') return { ok: true, text: 'Already in line; nothing changed.' };
    if (d.status === 'in-flight') return { ok: true, text: 'It is being tested right now.' };
    if (d.status === 'recorded') return { ok: true, text: `Already verified at this commit: ${d.record && d.record.verdict ? String(d.record.verdict) : 'a record exists'}.` };
    return { ok: true, text: 'Requested.' };
  }
  if (status === 409 && d.error === 'not-lease-holder') return { ok: false, text: `Testing runs on ${d.holderMachineId || 'another machine'}; ask there.` };
  const codes = { 'queue-full': 'The test queue is full; try later.', 'untrusted-head': 'That pull request’s head is not from a trusted login, so it is not tested here.', 'pr-closed': 'That pull request is closed.', 'main-unhealthy': 'main is not healthy right now, so nothing new is tested until it is.', 'pr-unreadable': 'GitHub could not be read for that pull request.', 'invalid-pr': 'That is not a valid pull request number.', 'pr-invalid-shas': 'That pull request’s commits could not be read.', stopping: 'The verifier is shutting down.' };
  return { ok: false, text: codes[d.code] || d.error || `The server answered ${status}.` };
}

/** Words for the rollback (stop auto-merging) answer: disarmed and could-not-disarm are reported apart. */
export function rollbackWords(status, data) {
  const d = data || {};
  if (!(status >= 200 && status < 300)) return { ok: false, text: d.error || `The server answered ${status}.` };
  const ok = Array.isArray(d.disarmed) ? d.disarmed : [];
  const failed = Array.isArray(d.disarmFailed) ? d.disarmFailed : [];
  let text = 'Auto-merging is stopped; nothing new will be armed.';
  if (ok.length) text += ` Disarmed ${ok.map((p) => `#${p}`).join(', ')}.`;
  if (failed.length) text += ` Could NOT disarm ${failed.map((p) => `#${p}`).join(', ')} — disable ${failed.length === 1 ? 'it' : 'them'} on GitHub directly.`;
  return { ok: true, text, failed };
}

// ── Pace (legacy throughput) ─────────────────────────────────────────────────
const PACIFIC_DAY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });
/** The route buckets merges by Pacific calendar day; the chart draws today hollow. */
export function pacificDay(ms) {
  const parts = Object.fromEntries(PACIFIC_DAY.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function median(values) {
  if (!values.length) return 0;
  const a = [...values].sort((x, y) => x - y); const m = Math.floor(a.length / 2);
  return Math.round((a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2) * 10) / 10;
}

/** Why Pace cannot show numbers, from the route's own answer (the status + its error code are needed; a bare 503 is not enough). */
export function paceFailure(res) {
  const code = res && res.code ? res.code : (res && res.data && res.data.error) || '';
  if (code === 'github-auth-unavailable') return { state: 'cant-tell', reason: 'Can’t reach GitHub from this machine: no GitHub sign-in found.', fix: 'Sign in with gh on this machine, or set a GitHub token for the agent.' };
  if (code === 'github-throughput-result-cap-exceeded') return { state: 'cant-tell', reason: 'Too many pull requests in this window to count; try a shorter window.', fix: null };
  if (code === 'invalid-throughput-window') return { state: 'cant-tell', reason: 'That window is not one the server counts (7, 14 or 30 days).', fix: null };
  if (code === 'throughput-series-unavailable' || (res && res.status === 503)) {
    // The route folds every GitHub/read failure — including its 1,000-PR result cap — into this one code.
    return { state: 'cant-tell', reason: 'GitHub didn’t answer, or this window holds too many pull requests to count (the server refuses rather than truncating). Try a shorter window.', fix: null };
  }
  return { state: 'cant-tell', reason: `Couldn’t read the pace: ${reasonOf(res)}.`, fix: null };
}

/** The person's metrics for a day row (team or one author); null when that author had no merges that day. */
export function personMetrics(row, person) {
  if (!row) return null;
  if (person === 'team' || !person) return row.team || null;
  return (row.authors && row.authors[person]) || null;
}

/**
 * Pace for the selected window and person. Sums merges, rework loops and reverts over the
 * days; medians are shown per day ("a typical day" = the median of the daily medians, said
 * so); the composite index is team-only. No previous-window comparison is computed.
 */
export function buildPace(res, { days = 14, person = 'team' } = {}, now = Date.now()) {
  const window = PACE_WINDOWS.includes(Number(days)) ? Number(days) : 14;
  const who = PACE_PEOPLE.find((p) => p.key === person) || PACE_PEOPLE[0];
  const base = { window, person: who.key, personLabel: who.label, people: PACE_PEOPLE, windows: PACE_WINDOWS, metrics: PACE_METRICS };
  if (!res || !res.ok) {
    const f = paceFailure(res);
    return { ...base, ...f, headline: `Pace: ${f.reason}`, numbers: [], days: [], line: 'Pace: can’t tell' };
  }
  const d = res.data || {};
  const rows = Array.isArray(d.rows) ? d.rows : [];
  if (!Array.isArray(d.rows)) return { ...base, state: 'cant-tell', reason: 'The pace answer had no day rows in it.', headline: 'Pace: can’t tell (the answer had no day rows).', numbers: [], days: [], line: 'Pace: can’t tell' };
  const today = pacificDay(now);
  const dayModels = rows.map((r) => {
    const m = personMetrics(r, who.key);
    return { day: r.day, isToday: r.day === today, metrics: m, values: {
      merges: m ? m.merges : 0, medianLatencyH: m ? m.medianLatencyH : 0, redone: m ? (m.reworkLoops || 0) + (m.reverts || 0) : 0,
      medianLoc: m ? m.medianLoc : 0, medianPushIters: m ? m.medianPushIters : 0, index: r.team ? r.team.index : 0,
    } };
  });
  const withMerges = dayModels.filter((x) => x.metrics && x.metrics.merges > 0);
  const merges = withMerges.reduce((n, x) => n + x.metrics.merges, 0);
  const rework = withMerges.reduce((n, x) => n + (x.metrics.reworkLoops || 0), 0);
  const reverts = withMerges.reduce((n, x) => n + (x.metrics.reverts || 0), 0);
  const typical = (key) => (withMerges.length ? median(withMerges.map((x) => x.metrics[key])) : null);
  const tLat = typical('medianLatencyH'), tLoc = typical('medianLoc'), tPush = typical('medianPushIters');
  const perDay = 'median of each day’s median';
  const numbers = [
    { key: 'merges', label: 'Merged', value: String(merges), note: `in ${window} days` },
    { key: 'medianLatencyH', label: 'Time to merge', value: tLat === null ? '—' : `${tLat} h`, note: tLat === null ? 'no merges' : `a typical day (${perDay})` },
    { key: 'redone', label: 'Redone', value: String(rework + reverts), note: `${plural(rework, 'rework loop')}, ${plural(reverts, 'revert')}` },
    { key: 'medianLoc', label: 'Size', value: tLoc === null ? '—' : `${tLoc} lines`, note: tLoc === null ? 'no merges' : `a typical day (${perDay})` },
    { key: 'medianPushIters', label: 'Push iterations', value: tPush === null ? '—' : String(tPush), note: tPush === null ? 'no merges' : `a typical day (${perDay})`, more: true },
  ];
  const whoWords = who.key === 'team' ? '' : ` by ${who.label}`;
  const headline = merges === 0 ? `No merges${whoWords} in the last ${window} days.` : `Last ${window} days${whoWords}: ${plural(merges, 'merge')}, ${plural(reverts, 'revert')}.`;
  const weights = d.weights || {};
  return {
    ...base, state: 'ok', reason: null, headline, numbers, days: dayModels, repo: d.repo || null, asOf: d.generatedAt || null, asOfLabel: d.generatedAt ? `as of ${at(Date.parse(d.generatedAt))}` : '',
    weights, weightLines: Object.keys(weights).length ? [
      `Velocity ${Math.round((weights.velocity || 0) * 100)}%: that day’s merges against the window’s busiest day.`,
      `Speed ${Math.round((weights.speed || 0) * 100)}%: how short that day’s median time to merge is against the window’s slowest day.`,
      `Quality ${Math.round((weights.quality || 0) * 100)}%: one minus (rework loops + 2 × reverts) per merge.`,
      `Output ${Math.round((weights.output || 0) * 100)}%: that day’s changed lines, on a log scale, against the window’s largest day.`,
    ] : [],
    hasToday: dayModels.some((x) => x.isToday), source: `${d.repo || 'the repository'} · ${PACE_PEOPLE.slice(1).map((p) => p.label).join(', ')}`,
    line: `Pace: ${plural(merges, 'merge')} in ${window} days`,
  };
}

// ── Feedback (legacy feedback-drain) ─────────────────────────────────────────
const pending = (p) => Boolean(p && p.approveAction);
const EXEC_WORDS = { queued: 'queued', running: 'being worked on', 'pr-open': 'fix waiting for your approval', 'spec-pr-open': 'design draft waiting for your approval', merged: 'fixed — checking it stays fixed', failed: 'the last attempt did not work' };
const SEVERITY_TONE = { critical: 'bad', serious: 'bad', high: 'attn', medium: null, low: null };
const AUTHORITY_WORDS = { 'awaiting-approval': 'waiting for your approval', active: 'sorting', paused: 'paused by a safety brake', 'self-healing': 'retrying on its own after unusable answers', exhausted: 'stopped after its automatic retries; approve again to restart', 'binding-stale': 'needs a fresh approval for this machine' };
const EXECUTOR_WORDS = {
  ok: 'ready to work on the top items', 'dry-run': 'in practice mode: it picks what it would work on but starts nothing', disabled: 'turned off',
  'no-source-repo': 'not available here (no copy of the source code on this machine)', 'github-unavailable': 'waiting: GitHub could not be reached',
  'auto-merge-disabled': 'waiting: the repository does not allow auto-merge', 'approver-unset': 'waiting: no approver is set for this organization repository',
  'approver-not-independent': 'waiting for your one-time OK: this agent could approve its own fixes as the repository owner',
  'profile-unenforceable': 'stopped: the sandbox check did not hold, so no attempts start (retried daily)', 'deps-unavailable': 'waiting: installing the code dependencies failed (retrying)',
  'publish-fork-unset': 'waiting: no fork is set to publish fixes from, so no new attempts start', 'not-canonical-owner': 'runs on another machine', 'not-checked-yet': 'not checked yet',
};

/** Fixes whose pull request waits for the operator's GitHub approval (same rule as the legacy headline). */
export function fixesAwaitingReview(queue) {
  const items = queue && Array.isArray(queue.items) ? queue.items : [];
  return items.filter((i) => (i.executionState === 'pr-open' || i.executionState === 'spec-pr-open') && typeof i.prLink === 'string' && /^https:\/\/github\.com\//.test(i.prLink));
}

/** Where an authority stands, in plain words (an authority "generation" is said as such, never "version"). */
export function authorityStatusLine(kind, p) {
  const what = kind === 'readiness' ? 'sorting model' : 'triage model';
  const s = (p && p.status) || 'none';
  const cur = (p && p.current) || null;
  if (s === 'none') return `No ${what} is approved yet; ${kind === 'readiness' ? 'incoming reports are not being sorted' : 'work items are not being decided'} until you approve one.`;
  if (s === 'revoked') return `The ${what} was revoked (generation ${cur ? cur.generation : '?'}); nothing is being ${kind === 'readiness' ? 'sorted' : 'decided'}.`;
  if (s === 'proposal-only') return `The ${what} is paused: ${(p && p.pausedBecause) || 'a safety brake fired.'} Only your approval restarts it.`;
  if (cur && cur.matchesProposal === false) return `The ${what} is approved (generation ${cur.generation}) but out of date for this machine; approve to update it.`;
  return `The ${what} is approved (generation ${cur ? cur.generation : '?'}): up to ${cur ? cur.maxBatch : '?'} ${kind === 'readiness' ? 'reports' : 'items'} a batch${kind === 'readiness' && cur ? `, $${cur.maxDailySpendUsd} a day` : ''}.`;
}

/** The card for one authority approval: everything the page shows above the Approve button. */
export function authorityCard(kind, p) {
  const title = kind === 'readiness' ? 'Approve which model sorts incoming reports' : 'Approve which model decides which reports get fixed';
  const env = (p && p.proposal) || (kind === 'readiness' ? { maxBatch: 50, maxTokens: 1200, maxDailySpendUsd: 5 } : { maxBatch: 50, maxTokens: 1200, maxDailySpendUsd: 5 });
  const why = p && p.status === 'proposal-only' ? `It was paused: ${p.pausedBecause || 'a safety brake fired.'}` : p && p.status === 'revoked' ? 'You turned it off earlier.' : '';
  return {
    kind, title, summary: (p && p.summary) || '', why, blockers: (p && p.blockers) || [], statusLine: authorityStatusLine(kind, p),
    envelope: { maxBatch: env.maxBatch, maxTokens: env.maxTokens, maxDailySpendUsd: env.maxDailySpendUsd },
    boundTo: p && p.proposal ? `agent ${p.proposal.agentId} · machine ${p.proposal.ownerMachineId} (epoch ${p.proposal.ownerEpoch}) · model ${p.proposal.modelFamily} via ${p.proposal.provider}` : '',
    approveAction: (p && p.approveAction) || null,
    approveLabel: p && p.approveAction === 'restore' ? 'Approve (restore)' : 'Approve',
    restoreNote: p && p.approveAction === 'restore' ? 'Restore brings back the last approved limits. To change them, restore first, then save new limits.' : null,
    canSaveLimits: Boolean(p && p.status === 'active' && !p.approveAction && (p.blockers || []).length === 0),
    canRevoke: Boolean(p && (p.status === 'active' || p.status === 'proposal-only')),
  };
}

/** Everything on this page that is the operator's to do, most important first. */
export function operatorTodos({ readiness, triageProposal, execute, queue } = {}) {
  const todos = [];
  const r = sourceState(readiness) === 'ok' ? readiness.data : null;
  if (pending(r)) todos.push({ kind: 'readiness-authority', action: r.approveAction, sentence: 'Feedback is waiting on one approval from you.', detail: `Approve which model sorts incoming reports.${r.status === 'proposal-only' ? ` It was paused: ${r.pausedBecause || 'a safety brake fired.'}` : r.status === 'revoked' ? ' You turned it off earlier.' : ''}`, button: r.approveAction === 'restore' ? 'Approve (restore)' : 'Approve', proposal: r });
  const t = sourceState(triageProposal) === 'ok' ? triageProposal.data : null;
  if (pending(t)) todos.push({ kind: 'triage-authority', action: t.approveAction, sentence: 'Feedback is waiting on one approval from you.', detail: 'Approve which model decides which reports get fixed.', button: t.approveAction === 'restore' ? 'Approve (restore)' : 'Approve', proposal: t });
  const x = sourceState(execute) === 'ok' ? execute.data : null;
  if (x && x.reason === 'approver-not-independent') todos.push({ kind: 'plan', action: 'accept-approver-dependence', sentence: 'The fix worker needs your one-time OK to run.', detail: 'This agent could approve its own fixes on GitHub, so it waits for you. Every fix still needs your GitHub approval to merge.', button: 'Let it run anyway…' });
  const held = ((x && x.attempts) || []).filter((a) => a.state === 'held' && a.reason === 'needs-review-secret-shape');
  for (const a of held) todos.push({ kind: 'plan', action: 'publish-secret-shape', attemptId: a.attemptId, sentence: `${held.length === 1 ? 'A fix needs' : `${held.length} fixes need`} your look before publishing.`, detail: `It touched files that look like they hold a secret (${(a.secretFiles || []).slice(0, 5).join(', ') || 'names withheld'}), so it is on hold.`, button: 'Review and publish…' });
  const prs = sourceState(queue) === 'ok' ? fixesAwaitingReview(queue.data) : [];
  if (prs.length) todos.push({ kind: 'link', sentence: `${prs.length === 1 ? 'A fix is' : `${prs.length} fixes are`} waiting for your approval on GitHub.`, detail: 'Approve it there and it merges on its own.', button: prs.length === 1 ? 'Open the fix' : 'Open the first fix', href: prs[0].prLink, prs });
  return todos;
}

/** The sorting progress line from /feedback-factory/drain/status (stall is a separate state from paused). */
export function progressLine(drain, readiness, now = Date.now()) {
  const ds = sourceState(drain);
  if (ds === 'failed') return { tone: 'unknown', text: `Can’t tell whether sorting is making progress: ${reasonOf(drain)}.`, n: 'Can’t tell' };
  if (ds === 'off') return { tone: 'off', text: 'The feedback drain is off on this agent.', n: 'off' };
  const d = drain.data || {};
  const r = sourceState(readiness) === 'ok' ? readiness.data : null;
  if (r && r.status === 'proposal-only') return { tone: 'attn', text: `Sorting is paused: ${r.pausedBecause || 'a safety brake fired.'} Only your approval restarts it.`, n: 'paused' };
  const p = d.readinessProgress;
  if (!p) return { tone: 'unknown', text: 'No sorting model is approved yet, so there is no progress to measure.', n: 'not set up' };
  if ((p.consecutiveFailedTicks || 0) >= STALL_TICKS) return { tone: 'attn', text: `Sorting hasn’t produced a usable answer since ${p.stalledSince ? at(p.stalledSince) : 'a while'} (${plural(p.consecutiveFailedTicks, 'run')} in a row; a provider problem — nothing is paused).`, n: `no answer for ${plural(p.consecutiveFailedTicks, 'run')}` };
  if (p.lastSuccessAt) return { tone: 'ok', text: `Last sorted ${ago(p.lastSuccessAt, now)}${p.consecutiveFailedTicks ? `; ${plural(p.consecutiveFailedTicks, 'run')} since produced no usable answer` : ''}.`, n: ago(p.lastSuccessAt, now) };
  return { tone: 'unknown', text: 'No sorting run has produced an answer yet.', n: 'none yet' };
}

/** One queue item as a row (severity as a coloured word, state in words). */
export function queueRow(item) {
  const sev = String(item.severity || 'unrated');
  const state = EXEC_WORDS[item.executionState] || '';
  return {
    key: `q:${item.initiativeId || item.rank}`, main: String(item.title || item.clusterId || 'A feedback item').slice(0, 140),
    sub: [`${item.rank}`, sev, state].filter(Boolean).join(' · '), end: item.priority ? `P${item.priority}` : '', tone: SEVERITY_TONE[sev.toLowerCase()] || null,
    href: typeof item.prLink === 'string' && /^https:\/\/github\.com\//.test(item.prLink) ? item.prLink : null, record: item,
  };
}

/**
 * Feedback from the five reads the legacy headline used plus the drain status. Each is
 * tracked on its own: a failed read makes the headline "can't tell", never calm.
 */
export function buildFeedback(res = {}, now = Date.now()) {
  const names = { readiness: 'the sorting-model proposal', triageSummary: 'the triage summary', triageProposal: 'the triage-model proposal', execute: 'the fix worker status', queue: 'the work queue', drain: 'the drain status' };
  const states = Object.fromEntries(Object.keys(names).map((k) => [k, sourceState(res[k])]));
  const failed = Object.keys(names).filter((k) => states[k] === 'failed');
  const todoFeeds = ['readiness', 'triageSummary', 'triageProposal', 'execute', 'queue'];
  const allOff = todoFeeds.every((k) => states[k] === 'off');
  const drainOff = states.drain === 'off' || (states.drain === 'ok' && res.drain.data && res.drain.data.posture && res.drain.data.posture.state === 'unavailable');
  const todos = operatorTodos(res);
  const progress = progressLine(res.drain, res.readiness, now);
  const summary = states.triageSummary === 'ok' ? (res.triageSummary.data || {}) : null;
  const exec = states.execute === 'ok' ? (res.execute.data || {}) : null;
  const queueRows = states.queue === 'ok' ? ((res.queue.data && res.queue.data.items) || []).map(queueRow) : [];
  const counts = (summary && summary.counts) || null;
  const waiting = counts ? (counts.untriaged || 0) + (counts.queued || 0) : null;

  const tiles = [
    { key: 'needs', label: 'Needs you', n: failed.some((k) => todoFeeds.includes(k)) && !todos.length ? 'Can’t tell' : todos.length, tone: todos.length ? 'attn' : failed.length ? 'unknown' : null },
    { key: 'fixing', label: 'Being fixed', n: exec ? (Number(exec.live) || 0) + (Number(exec.openPrs) || 0) : states.execute === 'off' ? 'off' : 'Can’t tell', tone: exec ? null : states.execute === 'off' ? 'off' : 'unknown', reason: exec ? `${plural(Number(exec.live) || 0, 'attempt')} running, ${plural(Number(exec.openPrs) || 0, 'fix', 'fixes')} waiting for review` : states.execute === 'off' ? 'the fix worker is off on this agent' : reasonOf(res.execute) },
    { key: 'sorting', label: 'Waiting to sort', n: waiting === null ? (states.triageSummary === 'off' ? 'off' : 'Can’t tell') : waiting, tone: waiting === null ? (states.triageSummary === 'off' ? 'off' : 'unknown') : null, reason: waiting === null ? (states.triageSummary === 'off' ? 'triage is off on this agent' : reasonOf(res.triageSummary)) : null },
    { key: 'progress', label: 'Progress', n: progress.n, tone: progress.tone === 'ok' ? null : progress.tone, reason: progress.text },
  ];

  let state = 'ok', headline, sub = '', tone = 'ok';
  if (allOff && (drainOff || states.drain === 'failed')) {
    state = 'off'; headline = 'The feedback factory doesn’t run on this machine.'; tone = 'muted';
    sub = states.drain === 'failed' ? `The drain status could not be read either (${reasonOf(res.drain)}).` : 'Its routes are switched off here; it runs on one operated host.';
  } else if (failed.some((k) => todoFeeds.includes(k))) {
    state = 'cant-tell';
    const k = failed.find((x) => todoFeeds.includes(x));
    headline = `I can’t tell whether feedback needs you: ${names[k]} didn’t answer (${reasonOf(res[k])}).`; tone = 'muted';
    if (todos.length) sub = `${plural(todos.length, 'thing')} that ${todos.length === 1 ? 'does' : 'do'} need you ${todos.length === 1 ? 'is' : 'are'} listed below from the reads that answered.`;
  } else if (todos.length) {
    headline = todos[0].sentence; tone = 'attn';
    const more = todos.length - 1;
    sub = `${todos[0].detail}${more > 0 ? ` After that, ${plural(more, 'more thing')} here need${more === 1 ? 's' : ''} you.` : ''}`;
  } else {
    headline = 'Nothing needs you.';
    const bits = [];
    if (counts) bits.push(`${plural(counts.work || 0, 'item')} picked to work on`, `${waiting} waiting to be sorted`);
    if (exec) bits.push(`${plural(Number(exec.openPrs) || 0, 'fix', 'fixes')} waiting for GitHub approval`);
    sub = bits.length ? `Feedback is being sorted and fixed on its own: ${bits.join(', ')}.` : states.readiness === 'ok' && res.readiness.data && res.readiness.data.status === 'none' && (res.readiness.data.blockers || []).length ? `Feedback sorting can’t be set up on this machine yet: ${res.readiness.data.blockers[0]}` : 'Incoming feedback is being sorted on its own.';
  }

  const notes = [];
  if (summary && summary.quotaPause && summary.quotaPause.at) notes.push('Triage is paused for now: the account serving it is near its usage limit.');
  if (summary && summary.ignoreBrake && summary.ignoreBrake.engaged) notes.push('Ignores are braked: the ignore rate rose sharply, so new ignores are being held.');
  if (states.drain === 'ok' && res.drain.data && res.drain.data.restorePending) notes.push('A failover restore is pending; writes are refused until it is finalized.');
  for (const k of failed) if (!todoFeeds.includes(k)) notes.push(`Couldn’t read ${names[k]}: ${reasonOf(res[k])}.`);

  const rd = states.readiness === 'ok' ? res.readiness.data : null;
  const td = states.triageProposal === 'ok' ? res.triageProposal.data : null;
  const settings = {
    readiness: { state: states.readiness, line: rd ? authorityStatusLine('readiness', rd) : states.readiness === 'off' ? 'The feedback drain is off on this agent.' : `Can’t tell: ${reasonOf(res.readiness)}`, card: rd ? authorityCard('readiness', rd) : null },
    triage: { state: states.triageProposal, line: td ? authorityStatusLine('triage', td) : states.triageProposal === 'off' ? 'Triage is off on this agent.' : `Can’t tell: ${reasonOf(res.triageProposal)}`, card: td ? authorityCard('triage', td) : null,
      authorityWords: summary ? `Triage is ${AUTHORITY_WORDS[summary.authority] || summary.authority || 'in an unknown state'}.` : null,
      calls: summary ? `${summary.callsUsedToday || 0} of ${summary.maxCallsPerDay || 0} model calls used today.` : null },
    ignoreLive: summary ? Boolean(summary.ignoreLive) : null, ignoreLiveRecommended: Boolean(summary && summary.ignoreLiveRecommended && !summary.ignoreLive),
    executor: exec ? `The fix worker is ${EXECUTOR_WORDS[exec.reason] || exec.reason || 'in an unknown state'}.` : states.execute === 'off' ? 'The fix worker is off on this agent.' : `Can’t tell: ${reasonOf(res.execute)}`,
  };
  const dd = states.drain === 'ok' ? (res.drain.data || {}) : null;
  const technical = dd ? {
    posture: dd.posture ? `${dd.posture.state}: ${dd.posture.reason}` : null,
    backlog: dd.drain ? `collecting ${(dd.drain.readiness || {}).collecting || 0}; ready ${(dd.drain.readiness || {}).ready || 0}; queued ${(dd.drain.work || {}).queued || 0}; retryable ${(dd.drain.work || {}).retryable || 0}; held ${((dd.drain.readiness || {}).held || 0) + ((dd.drain.work || {}).held || 0)}; dead-lettered ${(dd.drain.work || {})['dead-lettered'] || 0}` : null,
    lastRun: dd.lastRun ? `${dd.lastRun.state}${dd.drain && dd.drain.oldestQueuedAgeMs != null ? ` · oldest queued ${Math.round(dd.drain.oldestQueuedAgeMs / 1000)} s` : ''}` : 'none admitted yet',
    source: dd.drain ? `byte lag ${dd.drain.sourceProjectionLagBytes || 0}; generation lag ${dd.drain.sourceGenerationLag || 0}; checksum conflicts ${dd.drain.sourceChecksumConflicts || 0}` : null,
    authority: dd.authority ? `${dd.authority.authorityId} generation ${dd.authority.generation} · ${dd.authority.mode}${dd.authority.revoked ? ' · revoked' : ''}` : 'none',
    lastReadinessFailure: dd.lastReadinessFailure ? `${dd.lastReadinessFailure.outcome} at ${at(dd.lastReadinessFailure.at)}${dd.lastReadinessFailure.diagnosis ? ` · ${dd.lastReadinessFailure.diagnosis.check}: ${dd.lastReadinessFailure.diagnosis.message}` : dd.lastReadinessFailure.raw ? ` · ${dd.lastReadinessFailure.raw}` : ''}` : 'none recorded',
    raw: dd,
  } : null;

  return {
    state, headline, sub, tone, todos, tiles, progress, notes, settings, queueRows, technical, failed, states,
    line: state === 'off' ? 'Feedback: not on this machine' : state === 'cant-tell' ? 'Feedback: can’t tell' : `Feedback: ${todos.length ? `${plural(todos.length, 'thing')} need${todos.length === 1 ? 's' : ''} you` : 'nothing needs you'}${waiting !== null ? `, ${waiting} to sort` : ''}`,
  };
}

// ── request bodies and result words (verified against src/server/routes.ts) ──
/** A unique, bounded reference recorded in the authority's audit chain. */
export function newDecisionRef(prefix = 'console', now = new Date(), rand = Math.random) {
  const suffix = Math.floor(rand() * 0xffffffff).toString(16).padStart(8, '0');
  return `${prefix}:${now.toISOString().replace(/[^0-9A-Za-z]/g, '')}:${suffix}`;
}

/** POST /feedback-factory/readiness-authorities body (create/replace/restore/revoke). An emptied limit means "use the default", never 0. */
export function readinessAuthorityRequest(action, envelope, pin, operatorDecisionRef) {
  const body = { action, pin, operatorDecisionRef };
  if (action === 'create' || action === 'replace') {
    body.useProposal = true;
    for (const k of ['maxBatch', 'maxTokens', 'maxDailySpendUsd']) {
      const v = String((envelope || {})[k] ?? '').trim();
      if (v !== '') body[k] = Number(v);
    }
  }
  return body;
}
/** POST /feedback-factory/triage/authority body: the server fills every binding field from its proposal. */
export function triageAuthorityRequest(action, envelope, pin, operatorDecisionRef) {
  const body = { action, pin, operatorDecisionRef };
  if (action === 'create' || action === 'replace') {
    body.useProposal = true;
    for (const k of ['maxBatch', 'maxTokens', 'maxDailySpendUsd']) {
      const v = String((envelope || {})[k] ?? '').trim();
      if (v !== '') body[k] = Number(v);
    }
  }
  return body;
}
/** POST /feedback-factory/triage/commit body: the server's planId and nonce bound with the PIN. */
export function commitRequest(plan, pin) { return { pin, planId: plan.planId, nonce: plan.nonce }; }

/** What to show after an authority mutation. */
export function authorityResultWords(kind, status, data) {
  const d = data || {};
  if (status >= 200 && status < 300) {
    const what = kind === 'readiness' ? 'sorting' : 'deciding what gets fixed';
    return d.revoked ? { ok: true, text: `Revoked. It stops ${what} from its next run (generation ${d.generation}).` } : { ok: true, text: `Approved (generation ${d.generation ?? '?'}). The next run starts ${what}.` };
  }
  const m = String(d.error || '');
  if (status === 403 && /pin/i.test(m)) return { ok: false, text: 'That PIN was not accepted. Nothing has changed.' };
  if (status === 429 || /too many/i.test(m)) return { ok: false, text: 'Too many PIN attempts; wait a few minutes. Nothing has changed.' };
  if (status === 503 && /PIN authentication not available/.test(m)) return { ok: false, text: 'No dashboard PIN is configured on this agent, so this cannot be approved from here.' };
  return { ok: false, text: `Not applied: ${m || `the server answered ${status}`}. Nothing has changed.` };
}

/** What to show after a plan commit. */
export function commitResultWords(status, data) {
  const d = data || {};
  if (!(status >= 200 && status < 300)) return authorityResultWords('triage', status, d);
  if (d.action === 'accept-approver-dependence') return { ok: true, text: 'Done: the fix worker may run. Every fix still needs your GitHub approval to merge.' };
  if (d.action === 'publish-secret-shape') return { ok: true, text: `Done: published as pull request #${d.prNumber}.` };
  return { ok: true, text: d.ignoreLive ? 'Done: ignores are live.' : 'Done: ignores are back in practice mode.' };
}

// ── The combined page ────────────────────────────────────────────────────────
/** The page headline: the worst state first, coverage stated. */
export function developmentHeadline({ shipping, feedback, pace } = {}) {
  if (feedback && feedback.todos && feedback.todos.length) {
    const n = feedback.todos.length + (shipping && shipping.rows ? shipping.rows.filter((r) => r.group === 'needs').length : 0);
    return { text: n === 1 ? 'One thing needs you.' : `${n} things need you.`, tone: 'attn', sub: feedback.todos[0].sentence };
  }
  const needs = shipping && shipping.rows ? shipping.rows.filter((r) => r.group === 'needs') : [];
  if (needs.length) return { text: needs.length === 1 ? 'One pull request needs your approval on GitHub.' : `${needs.length} pull requests need your approval on GitHub.`, tone: 'attn', sub: shipping.line };
  if (feedback && feedback.state === 'cant-tell') return { text: 'Can’t tell whether anything needs you.', tone: 'muted', sub: feedback.headline };
  const stuck = shipping && shipping.rows ? shipping.rows.filter((r) => r.group === 'stuck').length : 0;
  if (stuck) {
    // The sub says WHY, not the count again (the Shipping line already carries the count).
    const moving = shipping.counts ? shipping.counts.moving : stuck;
    return { text: `${plural(stuck, 'pull request')} ${stuck === 1 ? 'is' : 'are'} stuck.`, tone: 'bad', sub: `Of ${plural(moving, 'pull request')} on the way: ${shipping.stuckWhy || 'the reason was not read'}.` };
  }
  const lines = [shipping && shipping.line, feedback && feedback.line, pace && pace.line].filter(Boolean);
  const allOff = (!shipping || shipping.state === 'off') && (!feedback || feedback.state === 'off');
  if (allOff) return { text: 'Development tools aren’t set up on this machine.', tone: 'muted', sub: 'Shipping and the feedback factory run on a machine with the Instar source checkout.' };
  return { text: 'Nothing here needs you.', tone: 'ok', sub: lines.join(' · ') };
}

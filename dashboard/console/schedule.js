// Schedule page (docs/specs/console-features/work.md, "Jobs → Schedule").
// "Did everything that should have run actually run?" Needs a look (late, failing,
// running long) first, then Coming up, then Everything else with search, origin
// chips and the legacy sort orders. Every write is bearer-only (no PIN on any /jobs
// route): Run now (followed to its end, however long), the On/Off switch (asks only
// when switching OFF a high/critical job, as today), Edit / Make my own copy / Go
// back to the default under "More", and the setup issues at the bottom (the legacy
// migration banner + file-issues card, each explained in a sentence).

import {
  buildSchedulePage, buildHistory, markText, storySentence, storyLines, jobActions, toggleConfirm, runStartWords, runFollowWords, saveRefusalWords, originWords, scheduleWords, ago, HISTORY_LIMIT, STRIP_LIMIT,
} from './schedule-model.js';
import { el, setKids, pageHead, section, sheet, closeSheet, sheetIsOpen, story, details, note, cantTell } from './ui.js';
import { legacyHref } from './nav-model.js';

const EYEBROW = 'Work · Schedule';
const JOB_KEYS = ['slug', 'schedule', 'model', 'priority', 'supervision', 'tags', 'machines', 'origin', 'manifestVersion', 'lockTrust', 'expectedDurationMinutes', 'gate', 'topicId'];
const FOLLOW_MS = 5000;

const filter = { origin: null, sort: 'status', q: '' };   // kept across refreshes
const dismissed = new Set();                               // setup issues dismissed until reload
let last = null;                                           // the last data read, repainted on a chip tap
const live = { source: null, state: 'off', since: null };  // the SSE stream

function token() { try { return localStorage.getItem('instar_token') || ''; } catch { return ''; } }
/** A write with the bearer token; returns { status, data } so the model can read the server's answer. */
async function send(method, path, body) {
  try {
    const r = await fetch(path, { method, headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    return { status: r.status, data };
  } catch { return { status: 0, data: {} }; }
}

export async function renderSchedule(main, ctx) {
  const { get } = ctx;
  if (!main.querySelector('.schedule-page')) setKids(main, el('section', { class: 'hero page-hero' }, el('div', { class: 'eyebrow', text: EYEBROW }), el('h1', { class: 'page-title skeleton', text: 'Loading the schedule' })));
  const [local, pool, machines, history, migration, reconcile] = await Promise.all([
    get('/jobs'), get('/jobs?scope=pool', 8000), get('/pool'), get('/jobs/history?limit=500'), get('/jobs/migration-status'), get('/jobs/reconcile'),
  ]);
  const ms = machines.ok && Array.isArray(machines.data && machines.data.machines) ? machines.data.machines : [];
  const names = Object.fromEntries(ms.map((m) => [m.machineId, m.nickname && m.nickname !== m.machineId ? m.nickname : 'another machine']));
  const selfMachineId = machines.ok && machines.data ? machines.data.selfMachineId : null;
  last = { res: { local, pool, history, migration, reconcile }, names, selfMachineId, main, ctx };
  connectLive();
  paint();
}

function paint() {
  const { res, names, selfMachineId, main, ctx } = last;
  const page = buildSchedulePage(res, Date.now(), { names, selfMachineId, filter, dismissed });
  const refresh = () => renderSchedule(main, ctx);
  if (!page.ok) { setKids(main, el('div', { class: 'schedule-page' }, pageHead({ eyebrow: EYEBROW, headline: 'Schedule', tone: 'muted' }), cantTell(page.reason), setupSection(page.setup || { items: [], notes: [], count: 0 }, refresh), legacyLink())); return; }
  const { sections: s, counts: n } = page;
  const open = (r) => openJob(r, { get: ctx.get, refresh });

  const needs = section({ id: 'needs', title: 'Needs a look', tone: n.failing ? 'bad' : 'attn', rows: s.needs, empty: 'Nothing is late, failing or running long.', onRow: open });
  const coming = section({ id: 'coming', title: 'Coming up', rows: s.coming, empty: n.total ? 'No job has a recorded next run.' : 'Nothing is scheduled.', onRow: open });

  // Everything else: collapsed, with a search field, the origin chips and the legacy sort orders inside.
  const every = section({ id: 'everything', title: 'Everything else', rows: s.everything, collapsed: !(filter.q || filter.origin), limit: 20, empty: filter.q || filter.origin ? 'No job matches.' : 'Every job is listed above.', onRow: open });
  every.querySelector('.list-count').textContent = String(n.everything);
  const q = el('input', { class: 'reason-input search-input', type: 'search', value: filter.q, placeholder: 'Search jobs', 'aria-label': 'Search jobs', 'data-focus-key': 'sched:search' });
  q.addEventListener('input', () => { filter.q = q.value; const sel = q.selectionStart; paint(); const nq = main.querySelector('.search-input'); if (nq) { nq.focus(); try { nq.setSelectionRange(sel, sel); } catch { /* not supported */ } } });
  const chipRow = (chips, key, label) => chips.length ? el('div', { class: 'filter-chips', role: 'group', 'aria-label': label }, chips.map((c) => el('button', {
    class: 'fchip', type: 'button', 'aria-pressed': c.on ? 'true' : 'false', 'data-focus-key': `chip:${key}:${c.key}`,
    onclick: () => { filter[key] = key === 'sort' ? c.key : (filter[key] === c.key ? null : c.key); paint(); },
  }, el('span', { text: c.label }), c.n !== undefined ? el('span', { class: 'fchip-n', text: String(c.n) }) : null))) : null;
  const controls = el('div', { class: 'list-controls' }, q, chipRow(page.chips, 'origin', 'Filter by origin'), el('div', { class: 'sort-row' }, el('span', { class: 'sort-label', text: 'Sort:' }), chipRow(page.sorts, 'sort', 'Sort order')));
  every.querySelector('.list-rows').prepend(controls);

  setKids(main, el('div', { class: 'schedule-page' },
    pageHead({ eyebrow: EYEBROW, headline: page.headline, sub: page.sub, tone: page.tone, facts: page.facts }),
    liveNote(),
    page.notes.map((t) => note(t)),
    el('div', { class: 'page-sections' }, needs, coming, every, setupSection(page.setup, refresh)),
    legacyLink(),
  ));
  // A fact or an old link lands on its section; ?job= opens a sheet.
  const path = location.hash.replace(/^#\/?/, '').split('?');
  const params = new URLSearchParams(path[1] || '');
  const want = params.get('s');
  if (want) {
    const sec = main.querySelector(`#sec-${want}`);
    const head = sec && sec.querySelector('button.list-head[aria-expanded="false"]');
    if (head) head.click();
    if (sec) sec.scrollIntoView({ block: 'start' });
  }
  const slug = params.get('job');
  if (slug && !sheetIsOpen()) {
    const row = [...s.needs, ...s.coming, ...s.everything].find((x) => x.slug === slug);
    if (row) open(row);
  }
}

function liveNote() {
  if (live.state === 'paused') return note(`Live updates paused${live.since ? ` · as of ${ago(live.since)}` : ''}; the page still refreshes every 30 s.`);
  return null;
}

function legacyLink() {
  return el('p', { class: 'foot-note' }, el('a', { href: legacyHref('jobs'), text: 'Open jobs in the legacy dashboard' }));
}

// ── live updates (GET /jobs/events, SSE) ──────────────────────────────────
function connectLive() {
  if (live.source || typeof EventSource === 'undefined') return;
  // Repaint only while this page is the one on screen (its current main is attached, no sheet is open).
  const onScreen = () => Boolean(last && last.main && last.main.isConnected && !sheetIsOpen() && location.hash.includes('work/schedule'));
  try {
    const src = new EventSource(`/jobs/events?token=${encodeURIComponent(token())}`);
    live.source = src; live.state = 'live';
    src.addEventListener('open', () => { if (live.state === 'paused') { live.state = 'live'; live.since = null; if (onScreen()) paint(); } });
    src.addEventListener('error', () => { if (live.state !== 'paused') { live.state = 'paused'; live.since = Date.now(); if (onScreen()) paint(); } });
    src.addEventListener('job-state', (e) => {
      if (!last) return;
      let d; try { d = JSON.parse(e.data); } catch { return; }
      if (!d || typeof d.slug !== 'string') return;
      for (const key of ['local', 'pool']) {
        const r = last.res[key];
        const jobs = r && r.ok && Array.isArray(r.data && r.data.jobs) ? r.data.jobs : [];
        for (const j of jobs) if (j && j.slug === d.slug && !j.remote) j.state = d.state;
      }
      if (onScreen()) paint();
    });
  } catch { live.source = null; live.state = 'off'; }
}

// ── the setup issues line ─────────────────────────────────────────────────
function setupSection(setup, refresh) {
  if (!setup.count && !setup.notes.length) return null;
  const wrap = el('section', { class: 'list-section setup-issues', id: 'sec-setup' });
  const head = el('button', { class: 'list-head', type: 'button', 'aria-expanded': 'false' },
    el('h2', { class: 'eyebrow', text: 'Setup issues' }), el('span', { class: 'list-count', text: String(setup.count) }), el('span', { class: 'chev', 'aria-hidden': 'true', text: '›' }));
  const body = el('div', { class: 'list-rows setup-rows', hidden: true });
  head.addEventListener('click', () => { body.hidden = !body.hidden; head.setAttribute('aria-expanded', body.hidden ? 'false' : 'true'); });
  for (const it of setup.items) {
    const row = el('div', { class: 'setup-item', 'data-severity': it.severity },
      el('span', { class: it.severity === 'error' ? 'dot bad' : it.severity === 'warning' ? 'dot attn' : 'dot unknown' }),
      el('div', { class: 'setup-main' }, el('span', { class: 'row-title', text: it.title }), it.text ? el('span', { class: 'row-sub', text: it.text }) : null));
    if (it.migration) {
      const acts = el('div', { class: 'sheet-actions' });
      if (it.migration.confirm) acts.append(actionBox({ label: 'Confirm the move is complete', kind: 'primary', run: async () => { const r = await send('POST', '/jobs/migration-confirm', {}); return r.status >= 200 && r.status < 300 ? { ok: true, message: 'Confirmed. The old list can now be removed on the next release.' } : { ok: false, message: r.data.error || `The server answered ${r.status}.` }; }, done: () => setTimeout(refresh, 600) }));
      if (it.migration.abandon) acts.append(actionBox({ label: 'Roll back', kind: 'danger', confirm: 'Roll the move back? The per-job layout is removed and the old list is used again; jobs you created in the new layout are not carried back.', run: async () => { const r = await send('POST', '/jobs/migration-abandon', {}); return r.status >= 200 && r.status < 300 ? { ok: true, message: 'Rolled back to the old list.' } : { ok: false, message: r.data.error || `The server answered ${r.status}.` }; }, done: () => setTimeout(refresh, 600) }));
      row.querySelector('.setup-main').append(acts);
    } else {
      row.querySelector('.setup-main').append(details(it.record, ['kind', 'slug', 'filePath', 'conflictingPaths', 'severity']));
      row.append(el('button', { class: 'chip icon-btn', type: 'button', 'aria-label': 'Dismiss until reload', text: '×', onclick: () => { dismissed.add(it.key); paint(); } }));
    }
    body.append(row);
  }
  for (const t of setup.notes) body.append(note(t));
  wrap.append(head, body);
  return wrap;
}

// ── the job sheet ─────────────────────────────────────────────────────────
function block(title, ...kids) { return el('section', { class: 'sheet-block' }, el('h3', { class: 'eyebrow', text: title }), ...kids); }

async function openJob(row, { get, refresh }) {
  const now = Date.now();
  const timers = new Set();
  const stop = () => { for (const t of timers) clearInterval(t); timers.clear(); };
  const job = row.job;
  const title = row.main.length > 70 ? row.main.slice(0, 68) + '…' : row.main;
  const summary = el('p', { class: 'card-line sheet-summary', text: storySentence(row.worst.entry, row.worst.status, now) });
  const body = [summary];
  if (job.description) body.push(el('p', { class: 'job-desc', text: job.description }));

  // One block per machine the job was read from; the worst first. Run now and the
  // switch act on the machine serving this page; another machine's block names it.
  const blocks = row.statuses.slice().sort((a, b) => (a === row.worst ? -1 : b === row.worst ? 1 : 0));
  for (const x of blocks) {
    const { entry, status } = x;
    const kids = [story(storyLines(entry, status, now))];
    if (!entry.remote) {
      const acts = el('div', { class: 'sheet-actions' }, runBox(entry, { get, timers, refresh }), switchRow(entry, { refresh }));
      kids.push(acts);
    } else kids.push(note(`Run now and the On/Off switch act on ${entry.machine}; open its own console for those.`));
    body.push(row.grouped ? block(entry.machine, ...kids) : el('section', { class: 'sheet-block' }, ...kids));
  }

  // Secondary actions under "More".
  const acts = jobActions(job);
  const more = [];
  if (acts.edit) more.push(el('button', { class: 'btn-quiet', type: 'button', text: 'Edit', onclick: () => openEditor(job, { refresh }) }));
  if (acts.copy) more.push(actionBox({ label: 'Make my own copy', kind: 'quiet', confirm: 'Make your own copy of this job? From then on you control it and instar stops updating it. You can go back to the default later.', run: async () => { const r = await send('POST', `/jobs/${encodeURIComponent(job.slug)}/override`, {}); return r.status >= 200 && r.status < 300 ? { ok: true, message: 'Your copy is made; Edit now works on it.' } : { ok: false, message: r.data.error || `The server answered ${r.status}.` }; }, done: () => setTimeout(() => { closeSheet(); refresh(); }, 700) }));
  if (acts.revert) more.push(actionBox({ label: 'Go back to the default', kind: 'danger', confirm: 'Go back to the instar default? Your version is kept for 30 days in case you change your mind, then removed.', run: async () => { const r = await send('POST', `/jobs/${encodeURIComponent(job.slug)}/unfork`, {}); return r.status >= 200 && r.status < 300 ? { ok: true, message: 'Back on the default. Your version is kept for 30 days.' } : { ok: false, message: r.data.error || `The server answered ${r.status}.` }; }, done: () => setTimeout(() => { closeSheet(); refresh(); }, 700) }));
  if (more.length) body.push(el('details', { class: 'raw more' }, el('summary', { text: '⋯ More' }), el('div', { class: 'more-actions' }, more)));

  const histBlock = block(`Last ${STRIP_LIMIT} runs`, el('p', { class: 'card-line', text: 'Loading…' }));
  body.push(histBlock);
  body.push(details({ ...job, origin: originWords(job), scheduleWords: scheduleWords(job.schedule) }, [...JOB_KEYS, 'scheduleWords']));
  const panel = sheet({ title, onClose: stop }, ...body);

  const [hist, skips] = await Promise.all([get(`/jobs/${encodeURIComponent(job.slug)}/history?limit=${HISTORY_LIMIT}`), get(`/skip-ledger?slug=${encodeURIComponent(job.slug)}&sinceHours=720`)]);
  if (!panel.isConnected) return;
  const h = buildHistory(hist, skips, Date.now());
  setKids(histBlock, el('h3', { class: 'eyebrow', text: `Last ${Math.min(STRIP_LIMIT, h.marks.length) || STRIP_LIMIT} runs` }), historyView(h));
  // The sheet's summary gains the last run's duration once history is read.
  const lastRun = h.ok ? h.marks.find((m) => m.kind !== 'skipped' && m.kind !== 'pending') : null;
  if (lastRun && lastRun.record) summary.textContent = storySentence(row.worst.entry, row.worst.status, Date.now(), lastRun.record);
}

function historyView(h) {
  if (!h.ok) return note(h.reason);
  if (!h.marks.length) return el('p', { class: 'card-line', text: 'No runs recorded yet.' });
  const detail = el('p', { class: 'mark-detail', role: 'status' });
  const strip = el('div', { class: 'run-strip', role: 'list' });
  let lastDay = null;
  for (const m of h.strip) {
    if (m.day !== lastDay) { strip.append(el('span', { class: 'run-day', text: m.day })); lastDay = m.day; }
    const b = el('button', { class: `run-mark ${m.kind}`, type: 'button', role: 'listitem', 'aria-label': markText(m), onclick: () => { detail.textContent = markText(m); } });
    strip.append(b);
  }
  const wrap = el('div', { class: 'history' }, strip, detail);
  for (const t of h.notes) wrap.append(note(t));
  {
    const list = el('ol', { class: 'run-list', hidden: true });
    let day = null;
    for (const m of h.marks) {
      if (m.day !== day) { list.append(el('li', { class: 'run-list-day', text: m.day })); day = m.day; }
      list.append(el('li', { class: `run-row ${m.kind}` },
        el('span', { class: `run-mark ${m.kind}`, 'aria-hidden': 'true' }),
        el('span', { class: 'run-row-main' }, el('span', { class: 'run-row-title', text: `${m.day === 'Today' || m.day === 'Yesterday' ? '' : m.day + ' · '}${new Date(m.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · ${m.word}${m.duration ? ` · ${m.duration}` : ''}` }), m.error ? el('span', { class: 'run-row-err', text: m.error }) : null)));
    }
    const show = el('button', { class: 'link-btn show-more', type: 'button', text: `Show all ${h.marks.length}`, 'aria-expanded': 'false' });
    show.addEventListener('click', () => { const open = list.hidden; list.hidden = !open; show.setAttribute('aria-expanded', open ? 'true' : 'false'); show.textContent = open ? 'Show fewer' : `Show all ${h.marks.length}`; });
    wrap.append(show, list);
  }
  return wrap;
}

/** Run now: one tap; then a live line that follows the run until it ends, however long. */
function runBox(entry, { get, timers, refresh }) {
  const status = el('p', { class: 'action-status', role: 'status' });
  const btn = el('button', { class: 'btn-primary btn-inline', type: 'button', text: 'Run now', 'data-focus-key': `run:${entry.job.slug}` });
  const box = el('div', { class: 'action run-action' }, btn, status);
  const running = entry.state && entry.state.lastResult === 'pending';
  if (running) { btn.disabled = true; status.textContent = 'Already running.'; }
  btn.addEventListener('click', async () => {
    btn.disabled = true; status.textContent = 'Starting…';
    const r = await send('POST', `/jobs/${encodeURIComponent(entry.job.slug)}/run`, {});
    const w = runStartWords(r.status, r.data);
    if (!w.ok) { status.textContent = w.text; btn.disabled = false; return; }
    const startedAt = Date.now();
    let seenPending = false;
    const line = el('span', { class: 'run-live', role: 'status', text: w.text });
    box.replaceChildren(line, status);
    status.textContent = '';
    const tick = setInterval(async () => {
      const res = await get('/jobs');
      if (!res.ok) { line.textContent = `Running ${Math.round((Date.now() - startedAt) / 1000)} s · can't read its state: ${res.reason}`; return; }
      const j = (Array.isArray(res.data && res.data.jobs) ? res.data.jobs : []).find((x) => x && x.slug === entry.job.slug);
      const v = runFollowWords(j ? j.state : null, startedAt, Date.now(), seenPending);
      if (v.pending) seenPending = true;
      if (!v.done) { line.textContent = v.text; return; }
      clearInterval(tick); timers.delete(tick);
      line.remove();
      status.textContent = v.text;
      btn.disabled = false; box.prepend(btn);
      refresh();
    }, FOLLOW_MS);
    timers.add(tick);
  });
  return box;
}

/** The On/Off switch: one tap, asking only when switching OFF a high or critical job. */
function switchRow(entry, { refresh }) {
  const status = el('p', { class: 'action-status', role: 'status' });
  const sw = el('button', { class: `switch${entry.enabled ? ' on' : ''}`, type: 'button', role: 'switch', 'aria-checked': entry.enabled ? 'true' : 'false', 'aria-label': `${entry.job.name || entry.job.slug} on or off`, 'data-focus-key': `sw:${entry.job.slug}` });
  const label = el('span', { class: 'switch-word', text: entry.enabled ? 'On' : 'Off' });
  const wrap = el('div', { class: 'action switch-action' }, el('div', { class: 'switch-row' }, sw, label), status);
  let on = entry.enabled;
  const apply = async (next) => {
    sw.disabled = true; status.textContent = 'Saving…';
    const r = await send('PATCH', `/jobs/${encodeURIComponent(entry.job.slug)}`, { enabled: next });
    sw.disabled = false;
    if (r.status >= 200 && r.status < 300 && typeof r.data.enabled === 'boolean') {
      on = r.data.enabled; sw.classList.toggle('on', on); sw.setAttribute('aria-checked', on ? 'true' : 'false'); label.textContent = on ? 'On' : 'Off';
      status.textContent = on ? 'On. It runs on its schedule again.' : 'Off. Nothing runs it until it is switched back on.';
      refresh();
    } else status.textContent = r.data.error || (r.status === 0 ? 'The server could not be reached.' : `The server answered ${r.status}.`);
  };
  sw.addEventListener('click', () => {
    const next = !on;
    const ask = toggleConfirm(entry.job, next);
    if (!ask) return apply(next);
    const go = el('button', { class: 'btn-danger', type: 'button', text: 'Switch off' });
    const cancel = el('button', { class: 'btn-quiet', type: 'button', text: 'Cancel' });
    const confirmBox = el('div', { class: 'confirm' }, el('p', { class: 'confirm-text', text: ask }), el('div', { class: 'confirm-row' }, cancel, go));
    wrap.append(confirmBox);
    cancel.addEventListener('click', () => confirmBox.remove());
    go.addEventListener('click', () => { confirmBox.remove(); apply(next); });
  });
  return wrap;
}

/** Edit (your jobs): name, description, schedule, priority, body; the conflict message stays. */
function openEditor(job, { refresh }) {
  const field = (label, input) => el('label', { class: 'field' }, el('span', { class: 'field-label', text: label }), input);
  const name = el('input', { class: 'reason-input', value: job.name || '', 'aria-label': 'Name' });
  const desc = el('input', { class: 'reason-input', value: job.description || '', 'aria-label': 'Description' });
  const sched = el('input', { class: 'reason-input mono', value: job.schedule || '', 'aria-label': 'Schedule (cron)', placeholder: '0 */4 * * *' });
  const schedWords = el('span', { class: 'field-hint', text: scheduleWords(job.schedule) });
  sched.addEventListener('input', () => { schedWords.textContent = scheduleWords(sched.value); });
  const prio = el('select', { class: 'reason-input', 'aria-label': 'Priority' }, ['critical', 'high', 'medium', 'low'].map((p) => el('option', { value: p, selected: (job.priority || 'low') === p ? true : null, text: p })));
  const bodyTa = el('textarea', { class: 'reason-input mono', rows: '12', 'aria-label': 'What the job does' });
  bodyTa.value = job.body || '';
  const status = el('p', { class: 'action-status', role: 'status' });
  const save = el('button', { class: 'btn-primary btn-inline', type: 'button', text: 'Save' });
  save.addEventListener('click', async () => {
    save.disabled = true; status.textContent = 'Saving…';
    const manifestVersion = Number(job.manifestVersion) || 0;
    const manifest = { slug: job.slug, origin: 'user', name: name.value, description: desc.value, schedule: sched.value, priority: prio.value, execute: { type: 'agentmd' }, manifestVersion };
    const r = await send('POST', `/jobs/${encodeURIComponent(job.slug)}/save`, { mdBody: bodyTa.value, manifest, manifestVersion });
    if (r.status >= 200 && r.status < 300) { status.textContent = 'Saved.'; setTimeout(() => { closeSheet(); refresh(); }, 700); return; }
    status.textContent = saveRefusalWords(r.status, r.data); save.disabled = false;
  });
  sheet({ title: `Edit ${job.name || job.slug}` },
    el('form', { class: 'edit-form', onsubmit: (e) => e.preventDefault() },
      field('Name', name), field('Description', desc), field('Schedule', el('div', { class: 'field-stack' }, sched, schedWords)), field('Priority', prio), field('What it does', bodyTa),
      el('div', { class: 'sheet-actions' }, save, el('button', { class: 'btn-quiet', type: 'button', text: 'Cancel', onclick: () => closeSheet() })), status));
}

/** An action with an honest result (the ui.js actionButton shape, kept local to allow a danger primary). */
function actionBox({ label, kind = 'primary', confirm, run, done }) {
  const status = el('p', { class: 'action-status', role: 'status' });
  const btn = el('button', { class: kind === 'primary' ? 'btn-primary btn-inline' : 'btn-quiet', type: 'button', text: label });
  const box = el('div', { class: 'action' }, btn, status);
  const settle = async (go) => {
    go.disabled = true; status.textContent = 'Working…';
    const r = await run();
    status.textContent = r.message || (r.ok ? 'Done.' : 'That did not work.');
    if (r.ok) { box.replaceChildren(status); if (done) done(); } else go.disabled = false;
  };
  btn.addEventListener('click', () => {
    if (!confirm) return settle(btn);
    const go = el('button', { class: kind === 'danger' ? 'btn-danger' : 'btn-primary btn-inline', type: 'button', text: label });
    const cancel = el('button', { class: 'btn-quiet', type: 'button', text: 'Cancel' });
    const confirmBox = el('div', { class: 'confirm' }, el('p', { class: 'confirm-text', text: confirm }), el('div', { class: 'confirm-row' }, cancel, go));
    box.replaceChildren(confirmBox, status);
    cancel.addEventListener('click', () => box.replaceChildren(btn, status));
    go.addEventListener('click', () => settle(go));
  });
  return box;
}

export { sheetIsOpen };

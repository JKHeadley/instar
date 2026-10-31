// Plans page (docs/specs/console-features/work.md: Projects + Initiatives + Blockers).
// Projects and initiatives are one list; blockers are the "In the way" section,
// placed ABOVE "In flight" so stuck work is never below healthy work. Every write
// here is bearer-only (no PIN on any /projects route); the destructive one, Stop
// this round, confirms in a sheet that says what really happens.

import {
  buildPlansPage, roundsTrack, projectActions, resultWords, refusalWords, driftSentence, linkChips, stepList, blockerStory, reasonWord, statusWord, PROJECT_DETAIL_CAP, OPEN_STATUSES,
} from './plans-model.js';
import { el, setKids, pageHead, section, sheet, closeSheet, sheetIsOpen, story, details, note, cantTell } from './ui.js';
import { legacyHref } from './nav-model.js';
import { topicNameMap } from './topic-names.js';
import { topicLink } from './promises.js';

const EYEBROW = 'Work · Plans';
const PROJECT_KEYS = ['id', 'kind', 'status', 'version', 'ownerMachineId', 'targetRepoPath', 'unacknowledgedAdvanceCount', 'firstLaunchAckAt', 'lastAckedRoundIndex', 'telegramTopicId', 'createdAt', 'updatedAt', 'lastTouchedAt'];
const INITIATIVE_KEYS = ['id', 'kind', 'status', 'version', 'parentProjectId', 'pipelineStage', 'specPath', 'prNumber', 'feedbackWorkKey', 'nextCheckAt', 'createdAt', 'updatedAt', 'lastTouchedAt'];
const BLOCKER_KEYS = ['id', 'state', 'origin', 'version', 'createdAt', 'updatedAt', 'lastReopenedAt'];

const filter = { status: null, done: null };   // the status chips; kept across refreshes
let last = null;                                // the last data read, repainted on a chip tap

export async function renderPlans(main, ctx) {
  const { get, post } = ctx;
  if (!main.querySelector('.plans-page')) setKids(main, el('section', { class: 'hero page-hero' }, el('div', { class: 'eyebrow', text: EYEBROW }), el('h1', { class: 'page-title skeleton', text: 'Loading plans' })));
  const [initiatives, digest, projects, blockers, floor, pool, topics] = await Promise.all([
    get('/initiatives'), get('/initiatives/digest'), get('/projects'), get('/blockers'), get('/autonomous/throughput-floor'), get('/pool'), get('/telegram/topics?scope=pool'),
  ]);
  // Rounds and pieces come from one read per open project, capped like the legacy tab.
  const open = projects.ok && Array.isArray(projects.data && projects.data.items) ? projects.data.items.filter((p) => p && OPEN_STATUSES.has(p.status)).slice(0, PROJECT_DETAIL_CAP) : [];
  const reads = await Promise.all(open.map((p) => get(`/projects/${encodeURIComponent(p.id)}?reconcile=false`)));
  const detailsById = Object.fromEntries(open.map((p, i) => [p.id, reads[i]]));
  const machines = pool.ok && Array.isArray(pool.data && pool.data.machines) ? pool.data.machines : [];
  const selfId = pool.ok && pool.data ? pool.data.selfMachineId : null;
  const self = machines.find((m) => m.isSelf || (selfId && m.machineId === selfId)) || {};
  const chatId = self.servesChannels && self.servesChannels.telegram && (self.servesChannels.telegram.chatIds || [])[0];
  last = { res: { initiatives, digest, projects, details: detailsById, blockers, floor }, chatId, post, main, ctx, topicNames: topicNameMap(topics) };
  paint();
}

function paint() {
  const { res, chatId, post, main, ctx, topicNames } = last;
  const page = buildPlansPage(res, Date.now(), { filter, topicNames });
  const refresh = () => renderPlans(main, ctx);
  if (!page.ok) { setKids(main, el('div', { class: 'plans-page' }, pageHead({ eyebrow: EYEBROW, headline: 'Plans', tone: 'muted' }), cantTell(page.reason), legacyLink())); return; }
  const { sections: s, counts: n, inTheWay: w, runs } = page;
  const topicHref = (id) => topicLink(chatId, id);
  const open = (r) => openRow(r, { post, topicHref, refresh, digestReasons: page.digestReasons });

  // Needs you: fresh items as rows; older ones waiting on you are a counted line, never dropped.
  const needs = section({ id: 'needsYou', title: 'Needs you', tone: 'attn', rows: s.needsYou, empty: 'Nothing is waiting on you.', onRow: open });
  if (n.olderNeedsYou) needs.querySelector('.list-rows').append(el('a', { class: 'link-btn older-line', href: '#/work/plans?s=older', text: `+${n.olderNeedsYou} older, still waiting on you ›` }));

  // In the way, above In flight. Off and failed are one dashed line each, not a page.
  let way;
  if (w.state !== 'ok') way = el('section', { class: 'list-section', id: 'sec-in-the-way' }, el('div', { class: 'list-head' }, el('h2', { class: 'eyebrow', text: 'In the way' })), note(w.reason));
  else if (w.stuck.length + w.working.length + w.clearedWeek.length + w.clearedOlder.length === 0) way = null;
  else way = el('div', { class: 'way-group', id: 'sec-in-the-way' },
    section({ id: 'stuck', title: 'In the way', tone: w.stuck.length ? 'bad' : null, rows: [...w.stuck, ...w.working], empty: 'Nothing in the way.', onRow: open }),
    w.clearedWeek.length ? section({ id: 'clearedWeek', title: 'Cleared this week', rows: w.clearedWeek, collapsed: true, onRow: open }) : null,
    w.clearedOlder.length ? section({ id: 'clearedOlder', title: 'Older cleared blockers', rows: w.clearedOlder, collapsed: true, onRow: open }) : null,
  );

  const chipRow = (chips, key) => chips.length ? el('div', { class: 'filter-chips', role: 'group', 'aria-label': 'Filter by state' }, chips.map((c) => el('button', {
    class: 'fchip', type: 'button', 'aria-pressed': c.on ? 'true' : 'false', 'data-focus-key': `chip:${key}:${c.key}`,
    onclick: () => { filter[key] = filter[key] === c.key ? null : c.key; paint(); },
  }, el('span', { text: c.label }), el('span', { class: 'fchip-n', text: String(c.n) })))) : null;

  const flight = section({ id: 'inFlight', title: 'In flight', rows: s.inFlight, empty: filter.status ? `No plan in flight is ${statusWord(filter.status)}.` : 'No multi-round plans or longer efforts are moving right now.', onRow: open });
  const runsSec = runs.state === 'ok'
    ? section({ id: 'runs', title: 'Autonomous runs', rows: runs.rows, collapsed: !runs.openOnArrival, empty: 'No autonomous runs are being observed.', onRow: (r) => sheet({ title: r.main }, story([{ label: 'Watching', text: r.sub }, r.record.reason ? { label: 'Reason', text: String(r.record.reason).replace(/[-_]/g, ' ') } : null].filter(Boolean)), details(r.record, ['topicId', 'signalRunId', 'decision', 'reason', 'outputFlatForMs', 'managerSilentForMs', 'at'])) })
    : el('section', { class: 'list-section', id: 'sec-runs' }, el('div', { class: 'list-head' }, el('h2', { class: 'eyebrow', text: 'Autonomous runs' })), note(runs.reason));
  const finished = section({ id: 'finished', title: 'Finished', rows: s.finished, collapsed: true, empty: filter.done ? `Nothing ${filter.done}.` : 'Nothing finished yet.', onRow: open });
  const doneChips = chipRow(page.doneChips, 'done');
  if (doneChips) finished.querySelector('.list-rows').prepend(doneChips);

  setKids(main, el('div', { class: 'plans-page' },
    pageHead({ eyebrow: EYEBROW, headline: page.headline, sub: page.sub, tone: page.tone, facts: page.facts }),
    page.notes.map((t) => note(t)),
    el('div', { class: 'page-sections' },
      needs,
      way,
      chipRow(page.chips, 'status'),
      flight,
      runsSec,
      section({ id: 'idle', title: 'Idle', rows: s.idle, collapsed: true, empty: 'Nothing idle.', onRow: open }),
      section({ id: 'older', title: 'Older, still open', rows: s.older.map((r) => ({ ...r, tone: r.needs ? 'attn' : 'unknown' })), collapsed: true, empty: 'Nothing untouched for two weeks.', onRow: open }),
      finished,
    ),
    legacyLink(),
  ));
  // A fact or an old link lands on its section: open it and scroll there.
  const path = location.hash.replace(/^#\/?/, '').split('?');
  let want = new URLSearchParams(path[1] || '').get('s');
  if (!want && /^work\/plans\/in-the-way/.test(path[0])) want = 'in-the-way';
  if (want) {
    const sec = main.querySelector(`#sec-${want}`);
    const head = sec && sec.querySelector('button.list-head[aria-expanded="false"]');
    if (head) head.click();
    if (sec) sec.scrollIntoView({ block: 'start' });
  }
}

function legacyLink() {
  return el('p', { class: 'foot-note' }, el('a', { href: legacyHref('initiatives'), text: 'Open initiatives in the legacy dashboard' }), document.createTextNode(' · '), el('a', { href: legacyHref('projects'), text: 'projects' }), document.createTextNode(' · '), el('a', { href: legacyHref('blockers'), text: 'blockers' }));
}

function openRow(r, deps) {
  if (r.type === 'blocker') return openBlocker(r, deps);
  if (r.type === 'project') return openProject(r, deps);
  return openInitiative(r, deps);
}

function block(title, ...kids) { return el('section', { class: 'sheet-block' }, el('h3', { class: 'eyebrow', text: title }), ...kids); }

function chipsOf(rec, topicHref) {
  const chips = linkChips(rec, topicHref);
  if (!chips.length) return null;
  return el('div', { class: 'link-chips' }, chips.map((c) => c.href ? el('a', { class: 'lchip', href: c.href, target: '_blank', rel: 'noopener', text: c.label }) : el('span', { class: 'lchip', text: c.label })));
}

function openBlocker(r) {
  const e = r.record;
  const body = [story(blockerStory(e, Date.now()))];
  if (e.state === 'access-requested') body.push(note('I asked you for access in the conversation where this came up; the request itself carries no link back to it.'));
  body.push(details({ ...e, playbookPath: e.terminal && e.terminal.playbookPath }, [...BLOCKER_KEYS, 'playbookPath']));
  sheet({ title: r.main.length > 70 ? r.main.slice(0, 68) + '…' : r.main }, ...body);
}

function openInitiative(r, { topicHref, digestReasons }) {
  const i = r.record;
  const lines = [
    i.description ? { label: 'What it is', text: i.description } : null,
    { label: 'Status', text: statusWord(i.status) },
    r.needs ? { label: 'Waiting on', text: r.needs.replace(/^Waiting on you:?\s*/i, '') || 'you' } : null,
    Array.isArray(i.blockers) && i.blockers.length ? { label: 'In its way', text: i.blockers.join('\n') } : null,
    i.feedbackWorkKey ? { label: 'From', text: 'user feedback' } : null,
  ].filter(Boolean);
  const reasons = (digestReasons[i.id] || []).map((s) => el('p', { class: 'card-line', text: `${reasonWord(s.reason)}${s.detail ? ` — ${s.detail}` : ''}` }));
  const steps = stepList(i, Date.now());
  const list = steps.length ? el('ol', { class: 'steps' }, steps.map((st) => el('li', { class: `step${st.done ? ' done' : st.current ? ' current' : ''}${st.blocked ? ' blocked' : ''}` },
    el('span', { class: 'step-mark', 'aria-hidden': 'true', text: st.done ? '✓' : st.current ? '●' : '○' }), el('span', { class: 'step-name', text: st.name }), st.when ? el('span', { class: 'step-when', text: st.when }) : null))) : null;
  const body = [story(lines)];
  if (reasons.length) body.push(block('From the check-in digest', ...reasons));
  if (list) body.push(block('Steps', list));
  const chips = chipsOf(i, topicHref);
  if (chips) body.push(block('Links', chips));
  if (i.feedbackWorkKey) body.push(el('p', { class: 'foot-note' }, el('a', { href: legacyHref('feedback-drain'), text: 'See it in the Feedback drain' })));
  body.push(details(i, INITIATIVE_KEYS));
  sheet({ title: r.main }, ...body);
}

function openProject(r, { post, topicHref, refresh }) {
  const p = r.record;
  const id = encodeURIComponent(p.id);
  const track = roundsTrack(p, r.children);
  const acts = projectActions(p);
  const cur = track.find((t) => t.state === 'current');
  const drift = driftSentence(cur ? cur.round : track[track.length - 1] && track[track.length - 1].round);
  const title = r.main.length > 70 ? r.main.slice(0, 68) + '…' : r.main;
  const summary = el('p', { class: 'card-line', text: r.detailFailed ? `Couldn't load its rounds: ${r.detailFailed}.` : r.sub });

  const done = () => setTimeout(() => { closeSheet(); refresh(); }, 700);
  const write = async (kind, path, body) => {
    const x = await post(`/projects/${id}/${path}`, body);
    if (x.ok) return { ok: true, message: resultWords(kind, x.data) };
    const w = refusalWords(x.reason);
    if (w.refresh) setTimeout(() => { closeSheet(); refresh(); }, 900);
    return { ok: false, message: w.text };
  };

  const rounds = el('ol', { class: 'rounds' }, track.map((t) => {
    const li = el('li', { class: 'round', 'data-state': t.state },
      el('span', { class: 'round-mark', 'aria-hidden': 'true', text: t.state === 'done' ? '✓' : t.state === 'current' ? '●' : t.state === 'halted' ? '✕' : '○' }),
      el('span', { class: 'round-main' },
        el('span', { class: 'round-name', text: `Round ${t.index + 1} · ${t.name}` }),
        el('span', { class: 'round-word', text: t.pieces.total ? `${t.word} · ${t.pieces.merged} of ${t.pieces.total} merged` : t.word })));
    if (t.state === 'current' || t.state === 'halted') {
      if (t.pieces.chips.length) li.querySelector('.round-main').append(el('span', { class: 'stage-chips' }, t.pieces.chips.map((c) => el('span', { class: `schip ${c.stage}`, text: `${c.n} ${c.word}` }))));
      if (t.items.length) li.querySelector('.round-main').append(el('ul', { class: 'pieces' }, t.items.map((it) => el('li', { text: `${it.title} — ${it.stage}${it.pr ? ` (PR #${it.pr})` : ''}` }))));
      if (acts.resume.includes(t.index)) {
        li.querySelector('.round-main').append(actionBox({
          label: 'Resume this round', kind: 'quiet', run: () => write('resume', 'resume', { roundIndex: t.index }), done,
        }));
      }
    }
    if (t.round.haltReason) li.querySelector('.round-main').append(el('span', { class: 'round-why', text: `Stopped: ${t.round.haltReason}` }));
    return li;
  }));

  const body = [summary];
  if (acts.ack !== null) {
    body.push(el('div', { class: 'need-card' },
      el('span', { class: 'need-title', text: `Waiting for your OK on round ${acts.ack + 1}` }),
      el('span', { class: 'need-sub', text: 'Your OK records permission for this round. It does not start work by itself.' }),
      actionBox({ label: `OK, continue round ${acts.ack + 1}`, kind: 'primary', run: () => write('ack', 'ack', { forRoundIndex: acts.ack }), done })));
  }
  body.push(block('Rounds', track.length ? rounds : el('p', { class: 'card-line', text: 'No rounds on this plan yet.' })));
  body.push(el('p', { class: 'drift', 'data-tone': drift.tone, text: drift.text }));
  const chips = chipsOf(p, topicHref);
  if (chips) body.push(block('Links', chips));
  if (acts.stop !== null) {
    const why = el('textarea', { class: 'reason-input', rows: '2', placeholder: 'Why you are stopping it (optional)', 'aria-label': 'Why you are stopping it (optional)' });
    body.push(el('div', { class: 'sheet-danger' }, actionBox({
      label: 'Stop this round', kind: 'danger',
      confirm: `Stop round ${acts.stop + 1} now? The work it is running is interrupted, not paused at a checkpoint; anything it had not saved is lost. You can resume the round later.`,
      extra: why,
      run: () => write('stop', 'halt', { reason: why.value.trim() || 'stopped from the console' }), done,
    })));
  }
  body.push(details(p, PROJECT_KEYS));
  sheet({ title }, ...body);
}

/**
 * An action with an honest result (ui.js's actionButton, plus an optional free-text
 * control inside the confirm box). run() resolves to { ok, message }.
 */
function actionBox({ label, kind = 'primary', confirm, extra, run, done }) {
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
    const confirmBox = el('div', { class: 'confirm' }, el('p', { class: 'confirm-text', text: confirm }), extra || null, el('div', { class: 'confirm-row' }, cancel, go));
    box.replaceChildren(confirmBox, status);
    cancel.addEventListener('click', () => box.replaceChildren(btn, status));
    go.addEventListener('click', () => settle(go));
  });
  return box;
}

export { sheetIsOpen };

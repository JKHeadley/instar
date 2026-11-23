// Projects on the Work door (docs/specs/work-front-doors.md stage 2a): every project the Chief of Staff
// tracks, where it stands, its done list and its cards. One row per project; a row opens in place.
// Project apps (docs/specs/project-apps.md §3.5): an attached app is one tap from the row's collapsed
// line with its summary as a second line; the row's details hold the agent's suggestions (Attach /
// No thanks), Add app, Remove, the recent answers and the pinned-link state. Attach, No thanks and
// Remove need the owner's dashboard unlock (an operator session); the agent's Bearer alone is refused.
// SAFETY: every server value goes through textContent via el(); links are console hash routes only.

import { el, askPin, operatorSession, forgetOperatorSession } from './ui.js';
import { projectsView, appPath, appNavigation, checkAnswerWords } from './projects-model.js';
import { requestId } from './conversation-write-continuity.js';

const DONE_MARK = { pass: '✓', fail: '✗', unknown: '·', waiting: '○' };
/** The console's own dot classes (console.css .dot.attn / .bad / .unknown; plain .dot is ok; quiet is a muted ok). */
const DOT = { attn: 'dot attn', bad: 'dot bad', unknown: 'dot unknown', ok: 'dot', quiet: 'dot quiet' };
/** Rows the person opened stay open across the page's refresh and after a tap re-reads the projects. */
const openRows = new Set();
/** The Finished fold stays as the person left it across a refresh. */
let finishedOpen = false;
/** Ask for an update's answer per project, kept for a minute so a refresh does not wipe what the server said. */
const asked = new Map();
const ASK_KEEP_MS = 60_000;

function bearer() { try { return localStorage.getItem('instar_token') || ''; } catch { return ''; } }

async function post(path, body, session) {
  const headers = { Authorization: `Bearer ${bearer()}`, 'Content-Type': 'application/json', 'X-Instar-Request': '1', ...(session ? { 'X-Instar-Operator-Session': session } : {}) };
  try {
    const r = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body), cache: 'no-store' });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  } catch { return { status: 0, data: {} }; }
}

const UNLOCK = { title: 'Your PIN', explain: 'Changing project priority or attaching or removing a project app needs a recent PIN unlock. It is kept in this page only until it expires.', adapter: 'session' };

/** An owner tap: unlock first when there is no live operator session; a refused proof unlocks once more. */
async function ownerPost(path, body) {
  let session = operatorSession();
  if (!session) { const a = await askPin(UNLOCK); if (!a || !a.session) return { cancelled: true }; session = a.session; }
  let r = await post(path, body, session);
  if (r.status === 401 || (r.status === 403 && r.data && r.data.error === 'owner-proof-required')) {
    forgetOperatorSession();
    const a = await askPin(UNLOCK);
    if (!a || !a.session) return { cancelled: true };
    r = await post(path, body, a.session);
  }
  return r;
}

function refusal(r) {
  if (!r.status) return 'The server could not be reached. Nothing changed.';
  const d = r.data || {};
  if (d.error === 'owner-proof-required') return 'This needs your PIN unlock. Nothing changed.';
  if (d.error === 'project-apps-off') return 'Project apps are switched off on this agent.';
  return d.detail ? String(d.detail) : `That did not go through (${d.error || `answer ${r.status}`}). Nothing changed.`;
}

/** Open an app: report the tap (fire and forget, app ref only), then go to its page. */
function openApp(ev, projectKey, app) {
  ev.preventDefault(); ev.stopPropagation(); // a tap on the collapsed line must not also fold the row
  void post(appPath(projectKey, app.appRef, 'opened'), {}).catch(() => {});
  const nav = appNavigation(app.href);
  if (!nav) return;
  if (nav.kind === 'hash') location.hash = nav.href; else location.assign(nav.href);
}

function openLink(projectKey, app, cls = 'btn-quiet btn-inline project-open') {
  return el('a', { class: cls, href: app.href, text: app.label, onclick: (ev) => openApp(ev, projectKey, app) });
}

/** A summary line ("headline · as of 14:05", "Reading the board…", or the reason with its action). */
function summaryEl(line, cls) {
  return el('span', { class: `${cls} app-${line.state}` },
    el('span', { text: line.text }),
    line.action ? el('a', { class: 'link-btn project-app-action', href: line.action.href, text: line.action.label,
      onclick: (ev) => { ev.preventDefault(); ev.stopPropagation(); location.hash = line.action.href; } }) : null);
}

function cardLine(c) {
  return el('li', { class: 'project-card' },
    el('a', { href: c.href, text: c.title }),
    c.sub ? el('span', { class: 'need-sub', text: ` · ${c.sub}` }) : null,
    c.chatHref ? el('a', { class: 'link-btn project-chat', href: c.chatHref, text: 'Conversation' }) : null);
}

/** One button that sends a write; while it runs the row's buttons are off, and the outcome is said in the row. */
function actButton(label, cls, run, ctx) {
  const b = el('button', { type: 'button', class: cls, text: label });
  b.addEventListener('click', async () => {
    const row = b.closest('.project-apps-detail');
    const buttons = row ? [...row.querySelectorAll('button')] : [b];
    buttons.forEach((x) => { x.disabled = true; });
    ctx.say('Sending…');
    const r = await run();
    buttons.forEach((x) => { x.disabled = false; });
    if (r.cancelled) { ctx.say(''); return; }
    if (r.status >= 200 && r.status < 300) { ctx.say('Done.'); ctx.reload(); return; }
    ctx.say(refusal(r));
  });
  return b;
}

function appsDetail(p, ctx) {
  const v = p.apps;
  const answer = (ref, ans) => ownerPost(appPath(p.key, ref, 'answer'), { answer: ans, requestId: requestId() });
  const pinAct = (ref, act) => post(appPath(p.key, ref, 'pin-retry'), { action: act }, operatorSession());
  const status = el('p', { class: 'need-sub project-apps-status', role: 'status' });
  const c = { ...ctx, say: (t) => { status.textContent = t; } };
  const parts = [];

  for (const o of v.offers) {
    parts.push(el('div', { class: 'project-offer' },
      el('p', { class: 'project-offer-title', text: o.label }),
      o.whyFirst ? el('p', { class: 'need-sub project-offer-why', text: `Your agent's reason: ${o.whyFirst}` }) : null,
      o.whyRest ? el('details', { class: 'project-offer-more' }, el('summary', { class: 'link-btn', text: 'More of the reason' }), el('p', { class: 'need-sub', text: o.whyRest })) : null,
      el('div', { class: 'project-app-buttons' },
        actButton('Attach', 'btn-primary btn-inline', () => answer(o.appRef, 'attach'), c),
        actButton('No thanks', 'btn-quiet btn-inline', () => answer(o.appRef, 'decline'), c))));
  }

  if (v.apps.length) {
    parts.push(el('ul', { class: 'project-apps-list', 'aria-label': 'Apps' }, v.apps.map((a) => el('li', { class: 'project-app' },
      el('span', { class: 'project-app-name', text: a.title }),
      summaryEl(a.line, 'need-sub project-app-summary'),
      el('div', { class: 'project-app-buttons' },
        a.href ? openLink(p.key, a) : null,
        actButton('Remove', 'btn-quiet btn-inline', () => answer(a.appRef, 'detach'), c))))));
  }

  for (const pin of v.pins) {
    parts.push(el('div', { class: `project-app-pin tone-${pin.tone}` },
      el('span', { text: v.apps.length > 1 ? `${pin.title}: ${pin.text}` : pin.text }),
      pin.action ? actButton(pin.action.label, 'btn-quiet btn-inline', () => pinAct(pin.appRef, pin.action.act), c) : null));
  }

  if (v.addable.length) {
    parts.push(el('details', { class: 'project-add-app' },
      el('summary', { class: 'link-btn', text: 'Add app' }),
      el('ul', { class: 'project-apps-list' }, v.addable.map((x) => el('li', { class: 'project-app' },
        el('span', { class: 'project-app-name', text: x.title }),
        x.note ? el('span', { class: 'need-sub', text: x.note }) : null,
        el('div', { class: 'project-app-buttons' }, actButton('Add', 'btn-quiet btn-inline', () => answer(x.appRef, 'attach'), c)))))));
  }

  if (v.answers.length) {
    parts.push(el('details', { class: 'project-app-answers' },
      el('summary', { class: 'link-btn', text: 'Recent answers' }),
      el('ul', { class: 'project-apps-list' }, v.answers.map((a) => el('li', { class: 'need-sub', text: a.text })))));
  }

  if (!parts.length) return null;
  return el('div', { class: 'project-apps-detail', tabindex: '-1', id: `apps-${p.key.replace(/[^A-Za-z0-9_-]/g, '-')}` }, parts, status);
}

function projectRow(p, ctx) {
  const v = p.apps;
  let details;
  const more = v.more ? el('button', { type: 'button', class: 'btn-quiet btn-inline project-open', text: 'More apps', onclick: (ev) => {
    ev.preventDefault(); ev.stopPropagation();
    details.open = true;
    const box = details.querySelector('.project-apps-detail');
    // An operator's tap, never a refresh: focus brings the apps box into view and moves keyboard focus
    // there (F12: pages never call scrollIntoView themselves).
    if (box && box.focus) box.focus();
  } }) : null;
  const summary = el('summary', { class: 'project-summary' },
    el('span', { class: DOT[p.tone] || 'dot', 'aria-hidden': 'true' }),
    el('span', { class: 'project-text' },
      el('span', { class: 'project-title', text: p.title }),
      el('span', { class: 'project-state', text: [p.stateWords, `${p.priority === 'high' ? 'High' : p.priority === 'low' ? 'Low' : 'Normal'} priority`, p.doneLine, p.cardsLine].filter(Boolean).join(' · ') }),
      // The row says where it stands, folded: why it waits on you, why it stopped, or the latest report.
      (p.waitingLine || p.stoppedLine || p.reportLine) ? el('span', { class: 'project-report', text: p.waitingLine || p.stoppedLine || p.reportLine }) : null,
      v.headline ? summaryEl(v.headline, 'project-app-line') : null,
      v.hint ? el('span', { class: 'project-app-hint', text: v.hint }) : null,
      v.buttons.length ? el('span', { class: 'project-app-buttons' }, v.buttons.map((a) => openLink(p.key, a)), more) : null));
  details = el('details', { class: `project-row tone-${p.tone}`, 'data-project': p.key, open: openRows.has(p.key) },
    summary,
    el('div', { class: 'project-body' },
      p.pausedLine ? el('p', { class: 'need-sub', text: p.pausedLine }) : null,
      p.whyLine ? el('p', { class: 'need-sub', text: p.whyLine }) : null,
      // The folded line shows the first of: why it waits on you, why it stopped, the latest report (in full once open).
      // The opened row adds the report whenever it is not that line, so nothing the server said is lost or said twice.
      p.reportLine && p.reportLine !== (p.waitingLine || p.stoppedLine || p.reportLine) ? el('p', { class: 'card-line project-latest', text: `Latest report: ${p.reportLine}` }) : null,
      p.goal ? el('p', { class: 'project-goal', text: p.goal }) : null,
      priorityControls(p),
      p.checksLine || p.checkNow ? checkNowRow(p) : null,
      p.phoneLine || p.finishWhy ? el('p', { class: 'need-sub project-phone', text: [p.phoneLine, p.finishWhy ? `Finish: ${p.finishWhy}` : null].filter(Boolean).join(' ') }) : null,
      v.has ? appsDetail(p, ctx) : null,
      p.doneItems.length ? el('ul', { class: 'project-done', 'aria-label': 'Done when' },
        p.doneItems.map((i) => el('li', { class: `done-${i.mark}` }, el('span', { class: 'done-mark', 'aria-hidden': 'true', text: DONE_MARK[i.mark] }), el('span', { text: ` ${i.text}` }),
          i.words ? el('span', { class: 'need-sub', text: ` · ${i.words}` }) : null))) : null,
      p.cards.length ? el('ul', { class: 'project-cards', 'aria-label': 'Cards' }, p.cards.map(cardLine)) : el('p', { class: 'need-sub', text: 'No cards yet.' }),
      p.moreCards ? el('p', { class: 'need-sub', text: `${p.moreCards} more cards` }) : null,
      p.chatHref ? el('p', {}, el('a', { class: 'link-btn', href: p.chatHref, text: 'Open the project conversation' })) : null));
  details.addEventListener('toggle', () => { if (details.open) openRows.add(p.key); else openRows.delete(p.key); });
  return details;
}

/** Explicit owner input; independent of the project's goal, checks and pause. */
function priorityControls(p) {
  const status = el('span', { class: 'need-sub', role: 'status' });
  const buttons = ['high', 'normal', 'low'].map((value) => el('button', {
    type: 'button', class: 'btn-quiet btn-inline', 'aria-pressed': String(value === p.priority),
    text: value[0].toUpperCase() + value.slice(1),
    onclick: async () => {
      for (const button of buttons) button.disabled = true;
      const result = await ownerPost(`/work/projects/${encodeURIComponent(p.key)}/priority`, { priority: value });
      if (result.cancelled) status.textContent = 'Priority was not changed.';
      else if (result.status === 200 && result.data?.ok) {
        p.priority = value;
        for (let i = 0; i < buttons.length; i++) buttons[i].setAttribute('aria-pressed', String(['high', 'normal', 'low'][i] === value));
        status.textContent = `${value[0].toUpperCase() + value.slice(1)} priority saved. This records your preference; it does not interrupt work.`;
        const wrap = status.closest('.projects-section'); if (wrap) void reloadSection(wrap);
      } else status.textContent = 'The save could not be confirmed. Refresh before trying again.';
      for (const button of buttons) button.disabled = false;
    },
  }));
  return el('div', { class: 'sheet-block project-priority' }, el('p', { class: 'need-sub', text: 'Project priority' }),
    el('div', { role: 'group', 'aria-label': 'Project priority' }, buttons), status);
}

/** When it was checked, when it is next checked, and Ask for an update (no PIN: it approves nothing, spec §3.2). */
function checkNowRow(p) {
  const kept = asked.get(p.key);
  const status = el('span', { class: 'need-sub project-check-status', role: 'status', text: kept && Date.now() - kept.at < ASK_KEEP_MS ? kept.words : '' });
  const kids = [p.checksLine ? el('span', { class: 'need-sub', text: p.checksLine }) : null];
  if (p.checkNow && p.checkNow.allowed) {
    const b = el('button', { type: 'button', class: 'btn-quiet btn-inline project-check-now', text: 'Ask for an update' });
    b.addEventListener('click', async (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      b.disabled = true; status.textContent = 'Asking…';
      const r = await post('/work/projects/check', { key: p.key });
      const w = checkAnswerWords(r.status, r.data);
      status.textContent = w.words;
      b.disabled = false;
      if (w.ok) { asked.set(p.key, { words: w.words, at: Date.now() }); const wrap = b.closest('.projects-section'); if (wrap) setTimeout(() => reloadSection(wrap), 1500); }
    });
    kids.push(b);
  } else if (p.checkNow && p.checkNow.why) kids.push(el('span', { class: 'need-sub', text: p.checkNow.why }));
  kids.push(status);
  return el('p', { class: 'project-checks' }, kids);
}

/** After a tap: read the projects again and redraw this section in place (the row stays open). */
async function reloadSection(wrap) {
  try {
    const r = await fetch('/work/projects', { headers: { Authorization: `Bearer ${bearer()}` }, cache: 'no-store' });
    if (!r.ok) return;
    const data = await r.json();
    if (wrap.isConnected) wrap.replaceWith(projectsSection(data));
  } catch { /* the page's own refresh reads it again */ }
}

/** The project a link asked to open (`?project=<key>`, from the conversation list's "Open project"), focused once per link. */
let focusedFor = '';
/** The Projects section, or null when the answer cannot be read and the board is the only thing to show. */
export function projectsSection(data, { openKey = null } = {}) {
  const v = projectsView(data);
  if (!openKey) focusedFor = '';
  if (openKey && v.ok && [...v.active, ...v.finished].some((p) => p.key === openKey)) openRows.add(openKey);
  const wrap = el('section', { class: 'list-section projects-section', id: 'sec-projects' },
    el('div', { class: 'list-head' }, el('h2', { class: 'eyebrow', text: 'Projects' }), v.ok ? el('span', { class: 'list-count', text: String(v.count) }) : null));
  if (!v.ok) { wrap.append(el('p', { class: 'need-sub', text: 'The projects could not be read, so this may not be everything.' })); return wrap; }
  const ctx = { reload: () => reloadSection(wrap) };
  const row = (p) => projectRow(p, ctx);
  if (v.line) wrap.append(el('p', { class: 'need-sub', role: 'status', text: v.line }));
  if (v.off) wrap.append(el('p', { class: 'empty-line', text: 'Project tracking (the Chief of Staff) is not switched on for this agent.' }));
  if (v.empty) wrap.append(el('p', { class: 'empty-line', text: 'No projects are being tracked yet.' }));
  for (const p of v.active) wrap.append(row(p));
  if (v.finished.length) {
    const fold = el('details', { class: 'projects-finished', open: finishedOpen });
    fold.addEventListener('toggle', () => { finishedOpen = fold.open; });
    wrap.append(fold);
    fold.append(
      el('summary', { class: 'eyebrow', text: `Finished (${v.finished.length})` }),
      ...v.finished.map(row));
  }
  if (openKey && v.ok && focusedFor !== openKey) {
    // The operator tapped "Open project": open that row and move focus to it, once (a refresh never moves the page).
    const target = [...wrap.querySelectorAll('details.project-row')].find((d) => d.getAttribute('data-project') === openKey);
    if (target) {
      focusedFor = openKey;
      const fin = target.closest('details.projects-finished');
      if (fin) fin.open = true;
      setTimeout(() => { const s = target.querySelector('summary'); if (s && s.isConnected && s.focus) s.focus(); }, 0);
    }
  }
  if (v.loose.length) {
    wrap.append(el('details', { class: 'projects-loose' },
      el('summary', { class: 'eyebrow', text: `Cards in no project (${v.loose.length})` }),
      el('ul', { class: 'project-cards' }, v.loose.map(cardLine))));
  }
  return wrap;
}

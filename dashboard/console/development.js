// Development page (docs/specs/console-features/under-the-hood.md: Shipping ←
// pr-pipeline, Feedback ← feedback-drain, Pace ← throughput, and "The two combined
// pages"). Maintainer-only by VISIBILITY (the Work tile shows only in maintainer
// mode); every write here keeps its server gate. The one thing that needs the
// operator — a pending Feedback approval or a Shipping needs-you row — sits directly
// under the headline, before any chart or healthy list. Feedback approvals and plan
// commits take the PIN in that one request's body (adapter c: typed in the shared PIN
// sheet, sent once, cleared); hold / test now / stop auto-merging are bearer-only
// with a confirmation sheet; turning auto-merge back on asks for the PIN because the
// server requires it. Every value reaches the DOM through textContent.

import {
  buildShipping, buildPace, buildFeedback, developmentHeadline, maintainerMode, authorityCard, holdWords, verifyWords, rollbackWords,
  readinessAuthorityRequest, triageAuthorityRequest, commitRequest, authorityResultWords, commitResultWords, newDecisionRef, PACE_METRICS, DEV_TOOLS_KEY,
} from './development-model.js';
import { el, setKids, pageHead, section, sheet, closeSheet, story, details, note, cantTell, askPin } from './ui.js';
import { legacyHref } from './nav-model.js';

const EYEBROW = 'Work · Development';
const TIMEOUT_MS = 5000;
const PROBE_FRESH_MS = 5 * 60000;
// The open fold, the Pace controls and any limits the operator typed, kept across refreshes (F9: a poll never rebuilds typed input).
const view = { open: null, days: 14, person: 'team', metric: 'merges', day: null, envelope: { readiness: null, triage: null } };
let last = null;
let probe = null; // { at, promise } — the maintainer-mode reads, once per page load

function bearer() { try { return localStorage.getItem('instar_token') || ''; } catch { return ''; } }

/** A read that keeps the status and the server's error code: a 503 body says WHY (github-auth-unavailable vs not-configured). */
async function read(path, timeoutMs = TIMEOUT_MS) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(path, { headers: { Authorization: `Bearer ${bearer()}` }, signal: ctl.signal, cache: 'no-store' });
    const data = await r.json().catch(() => null);
    const code = data && typeof data.error === 'string' ? data.error : null;
    if (r.ok) return data === null ? { ok: false, status: r.status, reason: 'the answer was not readable', data: null, code } : { ok: true, status: r.status, data, code };
    return { ok: false, status: r.status, data, code, reason: r.status === 503 ? 'switched off on this agent' : r.status === 401 || r.status === 403 ? 'not signed in' : `the server answered ${r.status}` };
  } catch (e) {
    return { ok: false, status: 0, data: null, code: null, reason: e && e.name === 'AbortError' ? `no answer within ${Math.round(timeoutMs / 1000)} seconds` : 'the server could not be reached' };
  } finally { clearTimeout(t); }
}
/** A write with the bearer token and the feedback routes' intent header; keeps the status and body. */
async function send(path, body) {
  try {
    const r = await fetch(path, { method: 'POST', headers: { Authorization: `Bearer ${bearer()}`, 'Content-Type': 'application/json', 'X-Instar-Request': '1' }, body: JSON.stringify(body || {}), cache: 'no-store' });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  } catch { return { ok: false, status: 0, data: { error: 'The server could not be reached.' } }; }
}

// ── maintainer mode: the Work tile and the Settings switch (visibility only) ──
function devToolsOverride() { try { return localStorage.getItem(DEV_TOOLS_KEY) === '1' ? 'on' : null; } catch { return null; } }
function probeMaintainer(get) {
  if (probe && Date.now() - probe.at < PROBE_FRESH_MS) return probe.promise;
  probe = { at: Date.now(), promise: Promise.all([get('/local-verify'), get('/green-pr-automerge')]).then(([localVerify, greenPr]) => ({ localVerify, greenPr })) };
  return probe.promise;
}

/** Nodes a group page adds: the Development tile (Work, maintainer mode only) and the developer-tools switch (Settings). */
export function groupExtras(g, { get }) {
  if (g.id === 'work') {
    const a = el('a', { class: 'tile', href: '#/work/development' },
      el('span', { class: 't-icon', icon: 'wrench' }),
      el('span', {}, el('span', { class: 't-name', text: 'Development' }), el('span', { class: 't-desc', text: 'Shipping, feedback and pace: pull requests on their way, the feedback factory’s approvals, and how fast work merges.' })));
    const host = el('div', { class: 'tiles tiles-dev', hidden: true }, a);
    if (devToolsOverride() === 'on') host.hidden = false;
    else probeMaintainer(get).then((r) => { host.hidden = !maintainerMode(r, devToolsOverride()).visible; });
    return [host];
  }
  if (g.id === 'settings') {
    const detected = el('p', { class: 'card-line', text: 'Checking whether this is a development agent…' });
    const box = el('input', { type: 'checkbox', 'aria-label': 'Show developer tools' });
    box.checked = devToolsOverride() === 'on';
    box.addEventListener('change', () => { try { if (box.checked) localStorage.setItem(DEV_TOOLS_KEY, '1'); else localStorage.removeItem(DEV_TOOLS_KEY); } catch { /* storage blocked */ } });
    probeMaintainer(get).then((r) => {
      const m = maintainerMode(r, null);
      detected.textContent = m.detected === 'yes' ? `This looks like a development agent: ${m.basis}. The Development tile is shown in Work.`
        : m.detected === 'no' ? `Not a development agent: ${m.basis}. The Development tile is hidden unless you switch it on here.`
          : `Couldn’t tell whether this is a development agent (${m.basis}). Show developer tools?`;
    });
    return [el('h2', { class: 'eyebrow section-label', text: 'Developer tools' }),
      el('section', { class: 'list-section', id: 'sec-dev-tools' },
        el('label', { class: 'switch-row' }, box, el('span', { text: 'Show developer tools (the Development page) in this browser' })),
        detected,
        note('This only decides what this browser shows. Every action on that page is still checked by the server.'))];
  }
  return [];
}

// ── the page ─────────────────────────────────────────────────────────────────
export async function renderDevelopment(main, ctx) {
  if (!main.querySelector('.dev-page')) setKids(main, el('section', { class: 'hero page-hero' }, el('div', { class: 'eyebrow', text: EYEBROW }), el('h1', { class: 'page-title skeleton', text: 'Loading development' })));
  const want = new URLSearchParams((location.hash.split('?')[1] || '')).get('s');
  if (want && !view.open) view.open = want;
  const [watcher, verify, release, readiness, triageSummary, triageProposal, execute, queue, drain, pace] = await Promise.all([
    read('/green-pr-automerge'), read('/local-verify'), read('/release-readiness'),
    read('/feedback-factory/readiness-authorities/proposal'), read('/feedback-factory/triage/summary'), read('/feedback-factory/triage/authority/proposal'),
    read('/feedback-factory/execute/status'), read('/feedback-factory/triage/queue'), read('/feedback-factory/drain/status'),
    read(`/throughput/series?days=${view.days}`, 15000),
  ]);
  last = { res: { watcher, verify, release, readiness, triageSummary, triageProposal, execute, queue, drain, pace }, main, ctx };
  paint();
}

function paint() {
  const { res, main, ctx } = last;
  const now = Date.now();
  const pace = buildPace(res.pace, { days: view.days, person: view.person }, now);
  const shipping = buildShipping({ watcher: res.watcher, verify: res.verify, release: res.release }, now, { repo: pace.repo || null });
  const feedback = buildFeedback({ readiness: res.readiness, triageSummary: res.triageSummary, triageProposal: res.triageProposal, execute: res.execute, queue: res.queue, drain: res.drain }, now);
  const h = developmentHeadline({ shipping, feedback, pace });
  const refresh = () => renderDevelopment(main, ctx);
  const deps = { refresh, shipping, feedback, pace };

  // The one thing that needs the operator comes first; the rest wait as a counted line.
  const todos = feedback.todos;
  const first = todos[0] || null;
  const lead = first ? todoCard(first, deps, true) : null;
  const moreLine = todos.length > 1 ? el('button', { class: 'link-btn older-line', type: 'button', text: `${todos.length - 1} more ${todos.length === 2 ? 'thing needs' : 'things need'} you ›`, onclick: () => openMore(todos.slice(1), deps) }) : null;

  // First arrival opens the section with the worst news (Shipping otherwise); 'none' is the operator's own collapse.
  if (!view.open) view.open = feedback.tone === 'attn' || feedback.state === 'cant-tell' ? 'feedback' : 'shipping';
  setKids(main, el('div', { class: 'dev-page' },
    pageHead({ eyebrow: EYEBROW, headline: h.text, sub: h.sub, tone: h.tone }),
    lead, moreLine,
    el('div', { class: 'page-sections' },
      fold({ id: 'shipping', title: 'Shipping', line: shipping.line, tone: shipping.tone, body: () => shippingBody(shipping, deps) }),
      fold({ id: 'feedback', title: 'Feedback', line: feedback.line, tone: feedback.tone, body: () => feedbackBody(feedback, deps) }),
      fold({ id: 'pace', title: 'Pace', line: pace.line, tone: pace.state === 'ok' ? 'ok' : 'muted', body: () => paceBody(pace, deps) }),
    ),
    el('p', { class: 'foot-note' }, el('a', { href: legacyHref('pr-pipeline'), text: 'Legacy PR pipeline' }), document.createTextNode(' · '), el('a', { href: legacyHref('feedback-drain'), text: 'feedback drain' }), document.createTextNode(' · '), el('a', { href: legacyHref('throughput'), text: 'throughput' })),
  ));
  const sec = main.querySelector(`#sec-${view.open}`);
  if (sec && new URLSearchParams((location.hash.split('?')[1] || '')).get('s') === view.open) sec.scrollIntoView({ block: 'start' });
}

/** One of the three sections: a one-line summary that opens in place; one open at a time. */
function fold({ id, title, line, tone, body }) {
  const open = view.open === id;
  const wrap = el('section', { class: `list-section dev-fold${tone === 'attn' || tone === 'bad' ? ' ' + tone : ''}`, id: `sec-${id}`, 'data-tone': tone || 'ok' });
  const head = el('button', { class: 'list-head', type: 'button', 'aria-expanded': open ? 'true' : 'false', 'aria-controls': `fold-${id}`, 'data-focus-key': `fold:${id}` },
    el('span', { class: 'dot' }), el('h2', { class: 'eyebrow', text: title }), el('span', { class: 'fold-line', text: line }), el('span', { class: 'chev', 'aria-hidden': 'true', text: '›' }));
  head.addEventListener('click', () => { view.open = open ? 'none' : id; paint(); });
  const b = el('div', { class: 'fold-body', id: `fold-${id}`, hidden: !open });
  if (open) setKids(b, body());
  wrap.append(head, b);
  return wrap;
}

function tiles(list) {
  return el('div', { class: 'dev-tiles' }, list.map((t) => el('div', { class: `dev-tile${t.tone ? ' ' + t.tone : ''}` },
    el('span', { class: 'dev-tile-n', text: String(t.n) }), el('span', { class: 'dev-tile-label', text: t.label }), t.reason ? el('span', { class: 'dev-tile-reason', text: t.reason }) : null)));
}
function toneLine(l, extra) {
  if (!l) return null;
  return el('p', { class: 'tone-line', 'data-tone': l.tone || 'ok' }, document.createTextNode(l.text), extra || null);
}
function block(title, ...kids) { return el('section', { class: 'sheet-block' }, el('h3', { class: 'eyebrow', text: title }), ...kids); }
function sub(title, ...kids) { return el('div', { class: 'dev-sub' }, el('h3', { class: 'eyebrow sub-label', text: title }), ...kids); }

// ── to-dos (Feedback approvals and links) ────────────────────────────────────
function todoCard(todo, deps, lead = false) {
  if (todo.kind === 'link') {
    return el('div', { class: 'need-card' }, el('span', { class: 'need-title', text: todo.sentence }), el('span', { class: 'need-sub', text: todo.detail }),
      el('a', { class: 'btn-primary btn-inline', href: todo.href, target: '_blank', rel: 'noopener', text: `${todo.button} ↗` }));
  }
  if (todo.kind === 'plan') {
    const status = el('p', { class: 'action-status', role: 'status' });
    const go = el('button', { class: 'btn-primary btn-inline', type: 'button', text: todo.button });
    go.addEventListener('click', () => planFlow({ action: todo.action, ...(todo.attemptId ? { attemptId: todo.attemptId } : {}) }, todo.sentence, status, deps));
    return el('div', { class: 'need-card' }, el('span', { class: 'need-title', text: todo.sentence }), el('span', { class: 'need-sub', text: todo.detail }), go, status);
  }
  const kind = todo.kind === 'readiness-authority' ? 'readiness' : 'triage';
  return authorityForm(kind, authorityCard(kind, todo.proposal), todo.action, deps, { lead, detail: todo.detail });
}

function openMore(rest, deps) {
  sheet({ title: `${rest.length} more ${rest.length === 1 ? 'thing needs' : 'things need'} you` }, el('ol', { class: 'todo-list' }, rest.map((t) => el('li', {}, todoCard(t, deps)))));
}

/**
 * The authority card: the server's own summary sentence, limits under "Adjust limits"
 * (re-previewed through the proposal route as they change), the binding, and Approve.
 * The PIN is collected in the shared sheet and sent in this one request only.
 */
function authorityForm(kind, card, action, deps, { lead = false, detail = '', title = null, label = null } = {}) {
  const route = kind === 'readiness' ? '/feedback-factory/readiness-authorities' : '/feedback-factory/triage/authority';
  const proposalRoute = kind === 'readiness' ? '/feedback-factory/readiness-authorities/proposal' : '/feedback-factory/triage/authority/proposal';
  const env = view.envelope[kind] || { ...card.envelope };
  const summary = el('p', { class: 'confirm-text plan-text', text: card.summary });
  const status = el('p', { class: 'action-status', role: 'status' });
  const field = (k, text, hint) => {
    const input = el('input', { class: 'reason-input', type: 'number', inputmode: 'decimal', 'aria-label': text });
    input.value = String(env[k] ?? '');
    input.addEventListener('change', async () => {
      env[k] = input.value; view.envelope[kind] = env;
      const q = new URLSearchParams(Object.entries(env).filter(([, v]) => String(v).trim() !== ''));
      const r = await read(`${proposalRoute}?${q}`);
      if (r.ok && r.data) { summary.textContent = r.data.summary || ''; blockers.replaceChildren(...(r.data.blockers || []).map((b) => note(b))); }
    });
    return el('label', { class: 'limit-field' }, el('span', { text: text }), input, hint ? el('span', { class: 'card-note', text: hint }) : null);
  };
  const blockers = el('div', { class: 'blockers' }, card.blockers.map((b) => note(b)));
  const limits = el('details', { class: 'raw limits' }, el('summary', { text: 'Adjust limits' }),
    field('maxBatch', kind === 'readiness' ? 'Reports per batch' : 'Items per batch', '1 to 50'),
    field('maxDailySpendUsd', 'Daily spend cap (USD)', 'It stops for the day at this amount.'),
    field('maxTokens', 'Answer length limit (tokens)', 'Leave as is unless asked.'),
    card.boundTo ? el('p', { class: 'card-note', text: `Bound to: ${card.boundTo}` }) : null);
  const go = el('button', { class: 'btn-primary btn-inline', type: 'button', text: label || card.approveLabel, 'data-authority-action': action });
  go.addEventListener('click', async () => {
    const what = action === 'revoke' ? `Revoke the ${kind === 'readiness' ? 'sorting' : 'triage'} model: it stops from its next run.` : `Approve: “${summary.textContent}”`;
    const pin = await askPin({ title: title || card.title, explain: `${what} Your PIN goes in this one request and is not kept.`, adapter: 'body' });
    if (!pin) return;
    go.disabled = true; status.textContent = 'Working…';
    const body = (kind === 'readiness' ? readinessAuthorityRequest : triageAuthorityRequest)(action, env, pin.pin, newDecisionRef(`console-${kind}`));
    pin.pin = '';
    const r = await send(route, body);
    body.pin = '';
    const w = authorityResultWords(kind, r.status, r.data);
    status.textContent = w.text;
    if (w.ok) { view.envelope[kind] = null; setTimeout(() => { closeSheet(); deps.refresh(); }, 900); } else go.disabled = false;
  });
  return el('div', { class: `need-card authority-card${lead ? ' lead' : ''}` },
    el('span', { class: 'need-title', text: title || card.title }),
    detail ? el('span', { class: 'need-sub', text: detail }) : null,
    summary, blockers,
    card.restoreNote ? note(card.restoreNote) : null,
    action === 'revoke' ? null : limits,
    el('div', { class: 'sheet-actions' }, go), status);
}

/** Plan → the server's exact wording → PIN → commit (planId + nonce bound). */
async function planFlow(request, title, status, deps) {
  status.textContent = 'Preparing the exact wording…';
  const p = await send('/feedback-factory/triage/plan', request);
  if (!p.ok || !p.data || !p.data.planId) { status.textContent = `Could not prepare that change: ${(p.data && p.data.error) || `the server answered ${p.status}`}. Nothing has changed.`; return; }
  const plan = p.data;
  status.textContent = '';
  const go = el('button', { class: 'btn-primary btn-inline', type: 'button', text: 'Confirm with PIN' });
  const result = el('p', { class: 'action-status', role: 'status' });
  go.addEventListener('click', async () => {
    const pin = await askPin({ title: 'Confirm with your PIN', explain: `You are approving exactly this: “${plan.renderedText}” Your PIN goes in this one request and is not kept.`, adapter: 'body' });
    if (!pin) return;
    const panel = sheet({ title }, el('p', { class: 'action-status', role: 'status', text: 'Working…' }));
    const body = commitRequest(plan, pin.pin);
    pin.pin = '';
    const r = await send('/feedback-factory/triage/commit', body);
    body.pin = '';
    const w = commitResultWords(r.status, r.data);
    panel.querySelector('.action-status').textContent = w.text;
    if (w.ok) setTimeout(() => { closeSheet(); deps.refresh(); }, 1000);
  });
  sheet({ title },
    block('Exact wording you are approving', el('p', { class: 'plan-text', text: plan.renderedText })),
    note('The console shows the server’s own text; your PIN approves exactly this wording.'),
    el('div', { class: 'sheet-actions' }, go), result);
}

// ── Shipping ─────────────────────────────────────────────────────────────────
function shippingBody(s, deps) {
  if (s.state === 'off') return [note(s.reason), toneLine(s.release)];
  const rows = s.rows.map((r) => ({ ...r, sub: r.sub, end: r.end }));
  const list = section({ id: 'prs', title: 'Pull requests', rows, empty: s.headline, onRow: (r) => openPr(r, s, deps) });
  const foot = el('div', { class: 'sheet-actions dev-foot' });
  if (s.stopped) {
    const back = el('button', { class: 'btn-quiet', type: 'button', text: 'Turn auto-merge back on' });
    back.addEventListener('click', () => enableAutoMerge(s, deps));
    foot.append(back);
  } else {
    const stop = el('button', { class: 'btn-quiet btn-danger-outline', type: 'button', text: 'Stop auto-merging' });
    stop.addEventListener('click', () => stopAutoMerge(s, deps));
    foot.append(stop);
  }
  const release = toneLine(s.release, s.release.attentionId ? el('a', { class: 'inline-link', href: '#/home', text: ' Open the item' }) : null);
  return [
    el('p', { class: 'card-line', text: s.headline }),
    tiles(s.tiles),
    release, toneLine(s.watcher),
    s.partial ? note('Partial: one of Shipping’s sources did not answer; its tile says why. The others are real.') : null,
    s.repoKnown ? null : note('GitHub links are off: the repository name comes from the Pace read, which did not answer.'),
    list, foot,
  ];
}

function openPr(r, s, deps) {
  const strip = el('ol', { class: 'stages' }, r.stages.map((st) => el('li', { class: `stage${st === r.stage ? ' current' : ''}`, 'data-tone': st === r.stage ? (r.tone || 'ok') : null, text: st })));
  const rec = r.record || {};
  const lines = [
    { label: 'State', text: r.sub },
    r.group === 'needs' ? { label: 'Why it waits', text: 'GitHub requires a reviewer other than the pusher; the watcher merges the moment the approval lands.' } : null,
    r.group === 'held' ? { label: 'Why it waits', text: 'A [HOLD] title or a hold / do-not-merge label excludes it from arming.' } : null,
    rec.lastOutcome ? { label: 'Last outcome', text: String(rec.lastOutcome).replace(/[:-]/g, ' ') } : null,
    rec.lastAttemptAt ? { label: 'Last attempt', text: new Date(rec.lastAttemptAt).toLocaleString() } : null,
  ].filter(Boolean);
  const body = [strip, story(lines)];
  if (rec.headRefOid || rec.headSha || rec.armedHead) body.push(el('p', { class: 'mono card-line', text: `commit ${String(rec.headRefOid || rec.headSha || rec.armedHead).slice(0, 12)}` }));
  const acts = el('div', { class: 'sheet-actions' });
  if (r.href) acts.append(el('a', { class: 'btn-primary btn-inline', href: r.href, target: '_blank', rel: 'noopener', text: 'Open on GitHub ↗' }));
  const status = el('p', { class: 'action-status', role: 'status' });
  if (r.group !== 'held') {
    const hold = el('button', { class: 'btn-quiet', type: 'button', text: 'Hold this pull request' });
    hold.addEventListener('click', () => {
      const why = el('textarea', { class: 'reason-input', rows: '2', placeholder: 'Why (kept in the [HOLD] marker)', 'aria-label': 'Why' });
      const go = el('button', { class: 'btn-danger', type: 'button', text: 'Hold it' });
      const cancel = el('button', { class: 'btn-quiet', type: 'button', text: 'Cancel' });
      const box = el('div', { class: 'confirm' }, el('p', { class: 'confirm-text', text: `Mark #${r.pr} [HOLD]. The watcher stops arming it; if GitHub auto-merge is already armed the server tries to disable it and tells you whether that worked.` }), why, el('div', { class: 'confirm-row' }, cancel, go));
      hold.replaceWith(box);
      cancel.addEventListener('click', () => box.replaceWith(hold));
      go.addEventListener('click', async () => {
        if (!why.value.trim()) { status.textContent = 'A reason is needed.'; why.focus(); return; }
        go.disabled = true; status.textContent = 'Working…';
        const x = await send('/green-pr-automerge/hold', { pr: r.pr, reason: why.value.trim() });
        const w = holdWords(x.status, x.data);
        status.textContent = w.text;
        if (w.ok) setTimeout(() => { closeSheet(); deps.refresh(); }, 1200); else go.disabled = false;
      });
    });
    acts.append(hold);
  }
  const test = el('button', { class: 'btn-quiet', type: 'button', text: 'Test it now' });
  test.addEventListener('click', async () => {
    test.disabled = true; status.textContent = 'Working…';
    const x = await send('/local-verify', { pr: r.pr });
    const w = verifyWords(x.status, x.data);
    status.textContent = w.text;
    if (w.ok) setTimeout(() => { closeSheet(); deps.refresh(); }, 1200); else test.disabled = false;
  });
  acts.append(test);
  body.push(acts, status, details(rec, ['pr', 'headRefOid', 'headSha', 'baseRefName', 'state', 'attempts', 'lastOutcome', 'armedAt', 'armedHead', 'overdue', 'firstQueuedAt', 'kind', 'redForMs', 'failingChecks']));
  sheet({ title: `Pull request #${r.pr}` }, ...body);
}

function stopAutoMerge(s, deps) {
  const status = el('p', { class: 'action-status', role: 'status' });
  const go = el('button', { class: 'btn-danger', type: 'button', text: 'Stop auto-merging' });
  go.addEventListener('click', async () => {
    go.disabled = true; status.textContent = 'Working…';
    const x = await send('/green-pr-automerge/rollback', { reason: 'stopped from the console' });
    const w = rollbackWords(x.status, x.data);
    status.textContent = w.text;
    if (w.ok) setTimeout(() => { closeSheet(); deps.refresh(); }, w.failed && w.failed.length ? 4000 : 1200); else go.disabled = false;
  });
  sheet({ title: 'Stop auto-merging?' },
    el('p', { class: 'confirm-text', text: `Nothing new will be armed until auto-merge is turned back on (that needs your PIN). ${s.armedPrs.length ? `It also disarms ${s.armedPrs.length === 1 ? 'the armed pull request' : `the ${s.armedPrs.length} armed pull requests`}: ${s.armedPrs.map((p) => `#${p}`).join(', ')}. Any it cannot disarm is named afterwards.` : 'No pull request is armed right now.'}` }),
    el('div', { class: 'confirm-row' }, el('button', { class: 'btn-quiet', type: 'button', text: 'Cancel', onclick: () => closeSheet() }), go), status);
}

async function enableAutoMerge(s, deps) {
  const pin = await askPin({ title: 'Turn auto-merge back on', explain: 'This re-arms merge authority; the server asks for your PIN. It goes in this one request and is not kept.', adapter: 'body' });
  if (!pin) return;
  const panel = sheet({ title: 'Turn auto-merge back on' }, el('p', { class: 'action-status', role: 'status', text: 'Working…' }));
  const body = { pin: pin.pin, latchIds: s.rollbackLatches };
  pin.pin = '';
  const x = await send('/green-pr-automerge/enable', body);
  body.pin = '';
  panel.querySelector('.action-status').textContent = x.ok ? 'Auto-merging is back on.' : authorityResultWords('triage', x.status, x.data).text.replace(/^Not applied: /, '');
  if (x.ok) setTimeout(() => { closeSheet(); deps.refresh(); }, 1000);
}

// ── Feedback ─────────────────────────────────────────────────────────────────
function feedbackBody(f, deps) {
  if (f.state === 'off') return [note(f.headline), f.sub ? el('p', { class: 'card-line', text: f.sub }) : null];
  const queue = section({ id: 'queue', title: 'Work queue', rows: f.queueRows, empty: f.states.queue === 'ok' ? 'No feedback items are queued to work on yet.' : f.states.queue === 'off' ? 'Triage is off on this agent.' : `Can’t tell: ${f.failed.includes('queue') ? 'the work queue didn’t answer' : 'no queue'}.`,
    onRow: (r) => sheet({ title: r.main }, story([{ label: 'Rank', text: String(r.record.rank) }, { label: 'Severity', text: String(r.record.severity || 'unrated') }, r.record.summary ? { label: 'Summary', text: String(r.record.summary) } : null, { label: 'State', text: r.sub }].filter(Boolean)),
      r.href ? el('div', { class: 'sheet-actions' }, el('a', { class: 'btn-primary btn-inline', href: r.href, target: '_blank', rel: 'noopener', text: 'Open the fix ↗' })) : null,
      details(r.record, ['initiativeId', 'clusterId', 'executionState', 'priority', 'prLink'])) });
  return [
    f.state === 'cant-tell' ? note(f.headline) : el('p', { class: 'card-line', text: `${f.headline} ${f.sub || ''}`.trim() }),
    tiles(f.tiles),
    toneLine(f.progress),
    f.notes.map((n) => note(n)),
    queue,
    settingsFold(f, deps),
    technicalFold(f),
  ];
}

function settingsFold(f, deps) {
  const s = f.settings;
  const body = el('div', { class: 'fold-body' });
  const actions = (kind, st) => {
    const row = el('div', { class: 'sheet-actions' });
    if (st.card && st.card.canSaveLimits) row.append(el('button', { class: 'btn-quiet', type: 'button', text: 'Change limits', onclick: () => sheet({ title: 'Change limits' }, authorityForm(kind, st.card, 'replace', deps, { title: 'Save new limits', label: 'Save new limits' })) }));
    if (st.card && st.card.canRevoke) row.append(el('button', { class: 'btn-quiet btn-danger-outline', type: 'button', text: 'Revoke', onclick: () => sheet({ title: `Revoke the ${kind === 'readiness' ? 'sorting' : 'triage'} model?` }, el('p', { class: 'confirm-text', text: `It stops ${kind === 'readiness' ? 'sorting incoming reports' : 'deciding which reports get fixed'} from its next run. Approving again later restores it.` }), authorityForm(kind, st.card, 'revoke', deps, { title: 'Revoke', label: 'Revoke' })) }));
    return row.childElementCount ? row : null;
  };
  body.append(
    sub('Sorting model', el('p', { class: 'card-line', text: s.readiness.line }), actions('readiness', s.readiness)),
    sub('Triage model', el('p', { class: 'card-line', text: s.triage.line }), s.triage.authorityWords ? el('p', { class: 'card-note', text: `${s.triage.authorityWords} ${s.triage.calls || ''}` }) : null, actions('triage', s.triage)),
  );
  if (s.ignoreLive !== null) {
    const status = el('p', { class: 'action-status', role: 'status' });
    const flip = el('button', { class: 'btn-quiet', type: 'button', text: s.ignoreLive ? 'Turn ignores back to practice mode…' : 'Turn ignores live…' });
    flip.addEventListener('click', () => planFlow({ action: 'ignore-live', enabled: !s.ignoreLive }, s.ignoreLive ? 'Turn ignores back to practice mode' : 'Turn ignores live', status, deps));
    body.append(sub('Ignores', el('p', { class: 'card-line', text: s.ignoreLive ? 'Ignores are live: items the triage model judges not worth work are set aside (paused, never deleted).' : 'Ignores are in practice mode: they are parked as holds, not set aside.' }),
      s.ignoreLiveRecommended ? note('The evidence says ignores are ready to go live.') : null, el('div', { class: 'sheet-actions' }, flip), status));
  }
  body.append(sub('Fix worker', el('p', { class: 'card-line', text: s.executor })));
  return collapsible('settings', 'Settings', body);
}

function technicalFold(f) {
  const t = f.technical;
  const body = t ? story([
    { label: 'Posture', text: t.posture || '—' }, { label: 'Backlog', text: t.backlog || '—' }, { label: 'Last run', text: t.lastRun }, { label: 'Source', text: t.source || '—' },
    { label: 'Authority', text: t.authority }, { label: 'Last sorting failure', text: t.lastReadinessFailure },
  ]) : note(f.states.drain === 'off' ? 'The drain status is off on this agent.' : `Can’t tell: the drain status didn’t answer.`);
  return collapsible('technical', 'Technical', el('div', { class: 'fold-body' }, body, t ? details(t.raw, ['restorePending', 'consumerPromotion', 'readinessProgress']) : null));
}

function collapsible(id, title, body) {
  const wrap = el('section', { class: 'list-section dev-inner', id: `sec-${id}` });
  const head = el('button', { class: 'list-head', type: 'button', 'aria-expanded': 'false' }, el('h2', { class: 'eyebrow', text: title }), el('span', { class: 'chev', 'aria-hidden': 'true', text: '›' }));
  body.hidden = true;
  head.addEventListener('click', () => { body.hidden = !body.hidden; head.setAttribute('aria-expanded', body.hidden ? 'false' : 'true'); });
  wrap.append(head, body);
  return wrap;
}

// ── Pace ─────────────────────────────────────────────────────────────────────
async function changePace(patch) {
  Object.assign(view, patch);
  if (patch.days !== undefined) { last.res.pace = await read(`/throughput/series?days=${view.days}`, 15000); view.day = null; }
  paint();
}

function paceBody(p) {
  const chips = (items, current, key, label) => el('div', { class: 'filter-chips', role: 'group', 'aria-label': label }, items.map((c) => el('button', {
    class: 'fchip', type: 'button', 'aria-pressed': c.key === current ? 'true' : 'false', 'data-focus-key': `${key}:${c.key}`, onclick: () => { if (c.key !== current) changePace({ [key]: c.key }); },
  }, el('span', { text: c.label }))));
  const controls = el('div', { class: 'page-controls' },
    chips(p.windows.map((d) => ({ key: d, label: `${d} days` })), p.window, 'days', 'Window'),
    chips(p.people, p.person, 'person', 'Person'));
  if (p.state !== 'ok') return [controls, cantTell(p.reason), p.fix ? note(p.fix) : null];
  const main = p.numbers.filter((n) => !n.more);
  const more = p.numbers.filter((n) => n.more);
  const numbers = el('div', { class: 'dev-tiles' }, main.map((n) => el('div', { class: 'dev-tile' }, el('span', { class: 'dev-tile-n', text: n.value }), el('span', { class: 'dev-tile-label', text: n.label }), el('span', { class: 'dev-tile-reason', text: n.note }))));
  const moreBox = el('details', { class: 'raw more-detail' }, el('summary', { text: 'More' }),
    more.map((n) => el('p', { class: 'card-line', text: `${n.label}: ${n.value} (${n.note}).` })),
    p.weightLines.length ? el('div', {}, el('p', { class: 'card-line', text: 'The index blends four weights, for everyone together:' }), el('ul', { class: 'change-list' }, p.weightLines.map((w) => el('li', { text: w })))) : null);
  const metrics = PACE_METRICS.filter((m) => !m.teamOnly || p.person === 'team');
  const cur = metrics.find((m) => m.key === view.metric) || metrics[0];
  const metricChips = chips(metrics.map((m) => ({ key: m.key, label: m.label })), cur.key, 'metric', 'Chart');
  return [
    controls,
    el('p', { class: 'card-line', text: p.headline }),
    numbers, moreBox,
    metricChips, chart(p, cur),
    el('p', { class: 'card-note', text: `${p.source}${p.asOfLabel ? ` · ${p.asOfLabel}` : ''} · GitHub is the source, so every machine shows the same numbers.` }),
  ];
}

function chart(p, metric) {
  const vals = p.days.map((d) => Number(d.values[metric.key]) || 0);
  const max = Math.max(1, ...vals);
  const bars = el('div', { class: 'pace-bars', role: 'group', 'aria-label': `${metric.label} by day` });
  p.days.forEach((d, i) => {
    const v = vals[i];
    const b = el('button', { class: `pace-bar${d.isToday ? ' today' : ''}${view.day === d.day ? ' picked' : ''}`, type: 'button', 'aria-label': `${d.day}: ${v}${metric.unit ? ' ' + metric.unit : ''}${d.isToday ? ' so far today' : ''}`, title: `${d.day}: ${v}`, onclick: () => { view.day = view.day === d.day ? null : d.day; paint(); } });
    b.style.height = `${Math.max(3, Math.round((v / max) * 100))}%`;
    bars.append(b);
  });
  const axis = el('div', { class: 'pace-axis', 'aria-hidden': 'true' }, el('span', { text: String(max) }), el('span', { text: String(Math.round(max / 2 * 10) / 10) }), el('span', { text: '0' }));
  const picked = p.days.find((d) => d.day === view.day);
  const dayLine = picked ? el('p', { class: 'card-line', text: `${picked.day}${picked.isToday ? ' (so far today)' : ''}: ${PACE_METRICS.filter((m) => !m.teamOnly || p.person === 'team').map((m) => `${m.label.toLowerCase()} ${picked.values[m.key]}${m.unit ? ' ' + m.unit : ''}`).join(', ')}.` }) : el('p', { class: 'card-note', text: `${metric.explain}${p.hasToday ? ' Today is drawn hollow: it is not over yet.' : ''} Tap a bar for that day’s numbers.` });
  return el('div', { class: 'pace-chart' }, el('div', { class: 'pace-plot' }, axis, p.days.length ? bars : el('p', { class: 'empty-line', text: 'No merges in this window.' })), dayLine);
}

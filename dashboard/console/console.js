// Instar console — shell, auth, routing, Home rendering.
// Spec: docs/specs/console-makeover.md. Home is read-only; the Promises page
// can close or resume a promise through its existing bearer-protected routes.
//
// SAFETY CONTRACT: every dynamic value reaches the DOM through textContent.
// The only innerHTML writes are the static SVG icon strings from nav-model.js.

import {
  failure, buildNeeds, buildDoing, buildPromised, buildRunning, buildAllowed, headline, ago, combineNeeds, machineNames,
} from './home-model.js';
import { GROUPS, legacyHref, icon, tabHref } from './nav-model.js';
import { renderPromises, topicLink } from './promises.js';
import { renderMachines } from './machines.js';
import { renderAccounts } from './accounts.js';
import { renderMessages } from './messages.js';
import { renderAllowed } from './allowed.js';
import { renderPlans } from './plans.js';
import { renderCosts } from './costs.js';
import { renderSchedule } from './schedule.js';
import { renderDevelopment, groupExtras } from './development.js';
import { renderAgents } from './agents.js';
import { renderMandates } from './mandates.js';
import { renderSecrets } from './secrets.js';
import { renderLearned } from './learned.js';
import { topicNameMap } from './topic-names.js';
import { renderInside } from './inside.js';
import { renderFiles } from './files.js';
import { renderSessions } from './sessions.js';
import { renderMaturation, maturationTile } from './maturation-board.js';
import { paceCard } from './pace.js';
import { sheetIsOpen, closeSheet, unlockCheck } from './ui.js';

const TOKEN_KEY = 'instar_token';      // shared with the legacy dashboard
const THEME_KEY = 'instar_console_theme';
const TIMEOUT_MS = 20000;
// Cross-machine reads can outlive a local read. A missed browser deadline is
// retried while Home is open; it is never treated as a final check result.
const POOL_TIMEOUT_MS = 25000;
const COMMITMENTS_TIMEOUT_MS = 25000;
const REFRESH_MS = 30000;

let token = '';
let refreshTimer = null;
let lastGood = {};                      // card id → last model that was not unknown
const expanded = new Set();             // cards the operator expanded; kept across refreshes
const openRows = new Set();             // rows the operator opened; kept across refreshes
let rowSeq = 0;
let homeChatId = null;
let homeRun = null;

// ── tiny DOM helpers ──────────────────────────────────────────────────────
function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'icon') n.insertAdjacentHTML('afterbegin', icon(v));
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid);
  return n;
}
const $ = (sel) => document.querySelector(sel);

// ── theme ─────────────────────────────────────────────────────────────────
function readTheme() {
  try { const t = localStorage.getItem(THEME_KEY); if (t === 'light' || t === 'dark') return t; } catch { /* storage blocked */ }
  return 'dark'; // the site's own default
}
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  const b = $('#themeToggle');
  if (b) { b.replaceChildren(); b.insertAdjacentHTML('afterbegin', icon(t === 'dark' ? 'sun' : 'moon')); b.setAttribute('aria-label', t === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'); }
}
function toggleTheme() {
  const t = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  try { localStorage.setItem(THEME_KEY, t); } catch { /* storage blocked */ }
  applyTheme(t);
}

// ── fetch with an honest failure reason ───────────────────────────────────
// Every page reads through this one function, so robustness lives here once:
// no read gives up sooner than MIN_TIMEOUT_MS (a page's own shorter deadline is
// raised to it), and a timeout, a dropped connection or a server error (5xx,
// except 503 "switched off") is retried once on its own before any page is
// told "can't tell". Cross-machine reads in particular can be slow for a moment.
const MIN_TIMEOUT_MS = 20000;
const RETRY_DELAY_MS = 0; // retry at once: a timeout already waited MIN_TIMEOUT_MS
async function getOnce(path, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(path, { headers: { Authorization: `Bearer ${token}` }, signal: ctl.signal, cache: 'no-store' });
    if (r.status === 401 || r.status === 403) { signOut(); return failure('not signed in'); }
    if (r.status === 503) return failure('switched off on this agent');
    if (!r.ok) return { ...failure(`the server answered ${r.status}`), retryable: r.status >= 500 };
    try { return { ok: true, data: await r.json() }; } catch { return failure('the answer was not readable'); }
  } catch (e) {
    return { ...failure(e && e.name === 'AbortError' ? `no answer within ${Math.round(timeoutMs / 1000)} seconds` : 'the server could not be reached'), retryable: true };
  } finally { clearTimeout(t); }
}
async function get(path, timeoutMs = TIMEOUT_MS) {
  const ms = Math.max(Number(timeoutMs) || 0, MIN_TIMEOUT_MS);
  const first = await getOnce(path, ms);
  if (first.ok || !first.retryable) return first;
  await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  const second = await getOnce(path, ms);
  if (second.ok) return second;
  const { retryable: _r, ...out } = second;
  return { ...out, reason: `${out.reason}, twice` };
}

async function getCommitments() {
  const path = '/commitments?scope=mesh';
  const first = await get(path, COMMITMENTS_TIMEOUT_MS);
  if (first.ok || first.reason === 'not signed in') return first;
  // A single missed read should not erase the operator's action queue.
  await new Promise((resolve) => setTimeout(resolve, 300));
  return get(path, COMMITMENTS_TIMEOUT_MS);
}

/** POST with the bearer token; returns { ok, data } or { ok:false, reason } with the server's own words. */
async function post(path, body) {
  try {
    const r = await fetch(path, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    const data = await r.json().catch(() => ({}));
    if (r.ok) return { ok: true, data };
    return { ok: false, reason: (data && (data.error || data.message)) ? String(data.error || data.message) : `The server answered ${r.status}.` };
  } catch { return { ok: false, reason: 'The server could not be reached.' }; }
}

// ── auth ──────────────────────────────────────────────────────────────────
async function validToken(t) {
  if (!t) return false;
  try {
    const r = await fetch('/sessions', { headers: { Authorization: `Bearer ${t}` }, cache: 'no-store' });
    return r.ok;
  } catch { return false; }
}

function signOut() {
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* storage blocked */ }
  token = '';
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  renderUnlock();
}

async function renderUnlock(message) {
  document.body.replaceChildren();
  // Never show a PIN box this connection will refuse; point to the secure address.
  const check = await unlockCheck();
  if (!check.accepted) {
    document.body.append(el('main', { class: 'unlock' }, el('div', { class: 'unlock-card' },
      el('img', { src: '/dashboard/logo.png', alt: '' }),
      el('h1', { text: 'Instar console' }),
      el('p', { text: check.reason }),
      check.secureUrl
        ? el('a', { class: 'btn-primary', href: check.secureUrl, text: 'Open the secure address' })
        : el('p', { text: 'Open this dashboard from your usual dashboard link, or on the machine itself.' }),
    )));
    return;
  }
  const input = el('input', { class: 'pin-input', type: 'password', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '12', 'aria-label': 'Dashboard PIN', placeholder: '••••••' });
  const err = el('div', { class: 'unlock-error', role: 'alert', text: message || '' });
  const btn = el('button', { class: 'btn-primary', type: 'submit', text: 'Unlock' });
  const form = el('form', { class: 'unlock-card' },
    el('img', { src: '/dashboard/logo.png', alt: '' }),
    el('h1', { text: 'Instar console' }),
    el('p', { text: 'Enter your dashboard PIN to continue.' }),
    input, btn, err,
  );
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    btn.disabled = true; err.textContent = '';
    try {
      const r = await fetch('/dashboard/unlock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: input.value }) });
      const data = await r.json().catch(() => ({}));
      if ((r.status === 404 || r.status === 503) && await validToken(input.value)) {
        // No PIN configured here: the legacy dashboard accepts the raw token too.
        try { localStorage.setItem(TOKEN_KEY, input.value); } catch { /* storage blocked */ }
        token = input.value; start(); return;
      }
      if (!r.ok || typeof data.token !== 'string') {
        err.textContent = data.error ? `${data.error}${typeof data.attemptsRemaining === 'number' ? ` · ${data.attemptsRemaining} tries left` : ''}` : 'That did not work. Try again.';
        btn.disabled = false; input.select(); return;
      }
      // Only the bearer token is stored, exactly as the legacy dashboard does.
      // The operator proof is deliberately not kept: the console is read-only.
      try { localStorage.setItem(TOKEN_KEY, data.token); } catch { /* storage blocked */ }
      token = data.token;
      start();
    } catch { err.textContent = 'The server could not be reached.'; btn.disabled = false; }
  });
  document.body.append(el('main', { class: 'unlock' }, form));
  input.focus();
}

// ── shell ─────────────────────────────────────────────────────────────────
function navItems(active) {
  const items = [{ id: 'home', label: 'Home', icon: 'home' }, ...GROUPS];
  const nav = el('nav', { class: 'nav', 'aria-label': 'Console sections' });
  for (const g of items) {
    const a = el('a', { href: `#/${g.id}`, icon: g.icon, 'aria-current': g.id === active ? 'page' : null });
    a.append(el('span', { text: g.label }));
    nav.append(a);
  }
  nav.append(el('div', { class: 'nav-group-label', text: 'Elsewhere' }));
  const legacy = el('a', { href: '/dashboard', icon: 'external' });
  legacy.append(el('span', { text: 'Legacy dashboard' }));
  legacy.classList.add('nav-sub-legacy');
  nav.append(legacy);
  return nav;
}

function renderShell(active) {
  const legacyChip = el('a', { class: 'chip chip-legacy', href: '/dashboard', text: 'Legacy' });
  const brand = el('a', { class: 'brand', href: '#/home' },
    el('img', { src: '/dashboard/logo.png', alt: '' }),
    el('span', { text: 'instar' }),
    el('span', { class: 'agent', id: 'agentName' }),
  );
  const top = el('header', { class: 'topbar' }, brand, el('div', { class: 'spacer' }), legacyChip);
  const main = el('main', { class: 'main', id: 'main' });
  const app = el('div', { class: 'app' }, previewBanner(), top, navItems(active), main);
  document.body.replaceChildren(app);
  applyTheme(document.documentElement.getAttribute('data-theme') || readTheme());
  fillAgentName();
  return main;
}

async function fillAgentName() {
  const r = await get('/health');
  const name = r.ok && r.data && r.data.project && (r.data.project.name || r.data.project);
  const n = $('#agentName');
  if (n && typeof name === 'string') n.textContent = `· ${name}`;
}

// ── Home ──────────────────────────────────────────────────────────────────
// col: which desktop column the card sits in. On a phone both columns stack.
const CARDS = [
  { id: 'needs', title: 'What needs you', feature: true, col: 'main' },
  { id: 'promised', title: 'What I’ve promised', href: '#/work/promises', col: 'main' },
  { id: 'doing', title: 'What I’m doing', href: '#/work/sessions', col: 'main' },
  { id: 'running', title: 'Where I’m running', href: '#/capacity/machines', col: 'side' },
  { id: 'allowed', title: 'What I’m allowed to do', href: '#/settings/allowed', col: 'side' },
];

const STATE_WORD = { ok: null, attn: null, bad: 'failing', unknown: 'can’t tell', partial: 'partial', stale: 'out of date' };

function actionHref(action) {
  if (!action) return null;
  if (action.kind === 'promise') {
    const params = new URLSearchParams({ id: String(action.id) });
    if (action.origin) params.set('origin', String(action.origin));
    return `#/work/promises?${params}`;
  }
  if (action.kind === 'topic') return topicLink(homeChatId, action.topicId);
  return null;
}

function cardShell(def) {
  const card = el('section', { class: `card${def.feature ? ' feature' : ''}`, id: `card-${def.id}`, 'data-state': 'loading', 'aria-busy': 'true' },
    el('div', { class: 'card-head' },
      el('span', { class: 'dot', 'aria-hidden': 'true' }),
      el('h2', { class: 'card-title', text: def.title }),
      el('span', { class: 'spacer' }),
      el('span', { class: 'card-age' }),
    ),
    el('div', { class: 'card-value' }, el('span', { class: 'skeleton', text: 'Loading value' })),
    el('p', { class: 'card-line' }, el('span', { class: 'skeleton', text: 'Loading the line under the value' })),
    el('div', { class: 'card-body' }),
    el('div', { class: 'card-foot' }),
  );
  return card;
}

function dotClass(state) {
  return state === 'attn' ? 'dot attn' : state === 'bad' ? 'dot bad' : (state === 'unknown' || state === 'partial' || state === 'stale') ? 'dot unknown' : 'dot live';
}

function paintCard(def, model, repaint = false) {
  const card = $(`#card-${def.id}`);
  if (!card) return;
  // Keep the last good data, labelled, when a refresh fails (spec §1). A repaint
  // (See all toggled) re-renders the model it was given without touching this.
  if (!repaint && model.state === 'unknown' && lastGood[def.id]) {
    const prev = lastGood[def.id];
    model = { ...prev.model, state: 'stale', retrying: model.retrying, line: `${model.line} Showing what I saw ${ago(prev.at)}.`, age: ago(prev.at) };
  } else if (!repaint && model.state !== 'unknown') {
    lastGood[def.id] = { model, at: Date.now() };
  }
  // Keep keyboard focus across a repaint (refresh or See all): remember which
  // control inside this card had it, and give it back to its replacement.
  const focused = card.contains(document.activeElement) ? document.activeElement.getAttribute('data-focus-key') : null;
  queueMicrotask(() => {
    if (!focused) return;
    const esc = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(focused) : focused.replace(/["\\]/g, '\\$&');
    const next = card.querySelector(`[data-focus-key="${esc}"]`);
    if (next) next.focus({ preventScroll: true });
  });
  const visual = model.state === 'partial' || model.state === 'stale' ? 'unknown' : model.state;
  card.setAttribute('data-state', visual);
  if (def.id === 'needs') card.hidden = (model.count === 1 && Boolean(actionHref(model.rows?.[0]?.action))) || (model.count === 0 && model.state !== 'unknown' && !model.retrying);
  card.removeAttribute('aria-busy');
  card.classList.add('resolved');
  card.querySelector('.dot').className = dotClass(model.state);
  const age = card.querySelector('.card-age');
  const word = STATE_WORD[model.state];
  age.textContent = [model.coverage && !word ? model.coverage : word, model.age && model.state !== 'stale' ? model.age : null].filter(Boolean).join(' · ');
  card.toggleAttribute('data-partial', Boolean(model.coverage));

  const value = card.querySelector('.card-value');
  value.replaceChildren();
  const m = /^(\d+)(.*)$/.exec(model.value || '');
  if (m && (model.state === 'attn' || model.state === 'bad' || model.valueTone)) value.append(el('span', { class: `n${model.valueTone ? ' ' + model.valueTone : ''}`, text: m[1] }), document.createTextNode(m[2]));
  else value.textContent = model.value || '';
  card.querySelector('.card-line').textContent = model.line || '';

  const body = card.querySelector('.card-body');
  body.replaceChildren();
  if (model.machines && model.machines.length) {
    const strip = el('div', { class: 'machines' });
    for (const mc of model.machines) {
      strip.append(el('div', { class: 'machine', 'data-state': mc.state === 'stale' ? 'unknown' : mc.state },
        el('span', { class: dotClass(mc.state === 'ok' ? 'ok' : mc.state) }),
        el('span', { class: 'm-name', text: mc.name }),
        el('span', { class: 'm-state' },
          el('span', { class: 'm-label' }, document.createTextNode(mc.label),
            typeof mc.perCore === 'number' ? el('span', { class: 'm-load mono', text: ` · ${mc.perCore.toFixed(1)}/core` }) : null),
          el('span', { class: 'm-age', text: mc.age || 'no reading' })),
      ));
    }
    body.append(strip);
  }
  if (model.meter) {
    const t = Object.values(model.meter).reduce((a, b) => a + b, 0) || 1;
    const meter = el('div', { class: 'meter', role: 'img', 'aria-label': `${model.meter.ok} on, ${model.meter.dry} watching only, ${model.meter.warn} off that should be on, ${model.meter.off} off by design` });
    for (const [k, cls] of [['ok', 'm-ok'], ['dry', 'm-dry'], ['warn', 'm-attn'], ['off', 'm-off']]) {
      if (model.meter[k] > 0) { const s = el('span', { class: cls }); s.style.width = `${(model.meter[k] / t) * 100}%`; meter.append(s); }
    }
    body.append(meter);
  }
  const expandedNow = expanded.has(def.id);
  const list = expandedNow && model.all ? model.all : model.rows;
  if (list && list.length) {
    const rows = el('div', { class: 'rows' });
    for (const r of list) {
      const href = actionHref(r.action);
      const expandable = !href && (r.expandable || r.detail);
      const row = el(href ? 'a' : expandable ? 'button' : 'div', { class: 'row', href, type: expandable ? 'button' : null,
        target: href && href.startsWith('https://') ? '_blank' : null, rel: href && href.startsWith('https://') ? 'noopener' : null },
        el('span', { class: r.tone === 'bad' ? 'dot bad' : r.tone === 'attn' ? 'dot attn' : r.tone === 'unknown' ? 'dot unknown' : 'dot' }),
        el('span', { class: 'row-main' }, el('span', { class: 'row-title', text: r.main || '' }), r.sub ? el('span', { class: r.mono ? 'row-sub mono' : 'row-sub', text: r.sub }) : null),
        el('span', { class: 'row-end', text: r.end || '' }),
      );
      if (href) {
        row.querySelector('.row-end').append(el('span', { class: 'chev', 'aria-hidden': 'true', text: '›' }));
        rows.append(row);
      } else if (expandable) {
        const id = `row-${++rowSeq}`;
        const key = `${def.id}:${r.key || r.main}`;
        row.setAttribute('data-focus-key', key);
        const isOpen = openRows.has(key);
        const d = el('p', { class: 'row-detail', id, text: r.detail || '', hidden: !isOpen });
        row.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        row.setAttribute('aria-controls', id);
        row.classList.toggle('open', isOpen);
        row.querySelector('.row-end').append(el('span', { class: 'chev', 'aria-hidden': 'true', text: '›' }));
        row.addEventListener('click', () => {
          const now = d.hidden; d.hidden = !now; row.classList.toggle('open', now);
          row.setAttribute('aria-expanded', now ? 'true' : 'false');
          if (now) openRows.add(key); else openRows.delete(key);
        });
        rows.append(row, d);
      } else rows.append(row);
    }
    body.append(rows);
  }
  if (model.note) body.append(el('p', { class: 'card-note', text: model.note }));
  const foot = card.querySelector('.card-foot');
  foot.replaceChildren();
  const extra = model.all ? model.all.length - model.rows.length : (model.more || 0);
  if (model.all && extra > 0) {
    const b = el('button', { class: 'link-btn', type: 'button', 'data-focus-key': `${def.id}:see-all`, 'aria-expanded': expandedNow ? 'true' : 'false', text: expandedNow ? 'Show fewer' : `See all ${model.all.length}` });
    b.addEventListener('click', () => { if (expanded.has(def.id)) expanded.delete(def.id); else expanded.add(def.id); paintCard(def, model, true); });
    foot.append(b);
  } else foot.append(el('span', { class: 'card-age', text: extra > 0 ? `and ${extra} more` : '' }));
  if (def.href) foot.append(el('a', { href: def.href, text: 'Open', 'aria-label': `Open ${def.title} in the dashboard` }));
  return model;
}

function paintHeadline(models) {
  const h = headline(models);
  const h1 = $('#heroTitle');
  const sub = $('#heroSub');
  if (!h1) return;
  h1.closest('.hero').setAttribute('data-tone', h.tone);
  h1.replaceChildren();
  const href = h.href || actionHref(h.action);
  if ((h.tone === 'attn' || h.tone === 'bad') && href) {
    h1.append(el('a', { class: 'hero-action', href, target: href.startsWith('https://') ? '_blank' : null,
      rel: href.startsWith('https://') ? 'noopener' : null, text: h.text }));
  } else if (h.tone === 'ok') {
    const words = h.text.split(' ');
    h1.append(document.createTextNode(words.slice(0, -1).join(' ') + (words.length > 1 ? ' ' : '')), el('span', { class: 'accent', text: words[words.length - 1] }));
  } else h1.textContent = h.text;
  // The count itself is explained by the "What needs you" card underneath; the sub-line only qualifies it.
  sub.textContent = h.sub || '';
  const statusSummary = $('.home-details summary');
  if (statusSummary) {
    const incomplete = Object.values(models).some((m) => m && ['unknown', 'partial', 'stale'].includes(m.state));
    statusSummary.textContent = incomplete ? 'See agent status · some checks incomplete' : 'See agent status';
  }
  const statusNote = $('#homeStatusNote');
  if (statusNote) {
    statusNote.textContent = models.needs?.statusNote || '';
    statusNote.hidden = !statusNote.textContent;
  }
  const issueLink = $('#heroIssueLink');
  if (issueLink) {
    issueLink.hidden = !((h.tone === 'bad' || h.tone === 'attn') && h.linkLabel && href);
    if (!issueLink.hidden) { issueLink.href = href; issueLink.textContent = `${h.linkLabel || 'Inspect the issue'} →`; }
  }
  $('#heroTime').textContent = `${h.tone === 'attn' ? 'What needs you' : 'Updated'} · ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

function loadHome() {
  const run = homeRun;
  if (!run || !run.active || run.document !== document) return;
  const { models, raw, results } = run;
  const paint = (id) => {
    // "What needs you" is the one answer: queue items plus promises waiting on the operator.
    const model = id === 'needs' ? combineNeeds(raw.needs, raw.promised) : raw[id];
    const shown = paintCard(CARDS.find((c) => c.id === id), model) || model;
    models[id] = shown;
    // The action queue must use the same last-known promise reading as its
    // companion card. Otherwise a transient refresh failure hides known work.
    if (id === 'promised') raw.promised = shown;
  };
  const set = (id, model) => {
    raw[id] = model;
    paint(id);
    if (id === 'promised' && raw.needs) paint('needs');
    paintHeadline(models);
  };
  const annotate = (model, ...reads) => reads.some((r) => r && (r.retrying || (!r.ok && r.reason !== 'not signed in' && r.reason !== 'switched off on this agent')))
    ? { ...model, retrying: true, line: [model.line, 'Checking again automatically.'].filter(Boolean).join(' ') } : model;
  const refresh = (key) => {
    const names = results.pool ? machineNames(results.pool) : {};
    if ((key === 'attention' || key === 'pool') && results.attention) set('needs', annotate(buildNeeds(results.attention, Date.now(), names), results.attention));
    if ((key === 'sessions' || key === 'pool' || key === 'topics') && results.sessions) set('doing', annotate(buildDoing(results.sessions, Date.now(), names, topicNameMap(results.topics)), results.sessions));
    if (key === 'pool' && results.pool) set('running', annotate(buildRunning(results.pool), results.pool));
    if ((key === 'commitments' || key === 'pool') && results.commitments) {
      const pool = results.pool;
      const peers = pool?.ok && Array.isArray(pool.data?.machines) ? pool.data.machines.filter((m) => m && !m.isSelf && m.machineId !== pool.data.selfMachineId).length : null;
      set('promised', annotate(buildPromised(results.commitments, Date.now(), peers), results.commitments));
    }
    if ((key === 'guards' || key === 'mandate') && results.guards && results.mandate) set('allowed', annotate(buildAllowed(results.guards, results.mandate), results.guards, results.mandate));
  };
  const read = (key, path, timeoutMs) => {
    if (run.pending[key]) return;
    const attempt = async () => {
      if (!run.active || run.document !== document) return;
      run.pending[key] = true;
      const result = await get(path, timeoutMs);
      if (!run.active || run.document !== document) return;
      // A 200 that omitted a peer is a partial answer, so keep it visible and
      // retry for coverage just as we do after a transport timeout.
      const partial = result.ok && (['attention', 'sessions'].includes(key) && Array.isArray(result.data?.pool?.failed) && result.data.pool.failed.length > 0
        || key === 'topics' && ((result.data?.pool?.failed?.length || 0) > 0 || (result.data?.pool?.unresolved?.length || 0) > 0));
      const retryable = partial || (!result.ok && !['not signed in', 'switched off on this agent'].includes(result.reason));
      results[key] = partial ? { ...result, retrying: true } : result;
      if (key === 'pool' && result.ok) {
        const self = (result.data?.machines || []).find((m) => m.isSelf || m.machineId === result.data.selfMachineId);
        homeChatId = self?.servesChannels?.telegram?.chatIds?.[0] || null;
      }
      refresh(key);
      if (retryable) {
        run.failures[key] = (run.failures[key] || 0) + 1;
        const delay = Math.min(15000, 300 * (2 ** Math.min(run.failures[key] - 1, 6)));
        run.pending[key] = setTimeout(attempt, delay);
      } else { run.failures[key] = 0; run.pending[key] = null; }
    };
    attempt();
  };
  // Every source has one in-flight request and its own bounded retry timer.
  // A slow source cannot block another card or start overlapping refreshes.
  read('pool', '/pool', POOL_TIMEOUT_MS);
  read('attention', '/attention?scope=pool', POOL_TIMEOUT_MS);
  read('sessions', '/sessions?scope=pool', POOL_TIMEOUT_MS);
  read('topics', '/telegram/topics?scope=pool', POOL_TIMEOUT_MS);
  read('commitments', '/commitments?scope=mesh', COMMITMENTS_TIMEOUT_MS);
  read('guards', '/guards', TIMEOUT_MS);
  read('mandate', '/mandate', TIMEOUT_MS);
}

function renderHome(main) {
  homeRun = { active: true, document, models: Object.fromEntries(CARDS.map((c) => [c.id, { state: 'loading' }])), raw: {}, results: {}, pending: {}, failures: {} };
  main.replaceChildren(
    el('section', { class: 'hero' },
      el('div', { class: 'eyebrow', id: 'heroTime', text: 'Checking in' }),
      el('h1', { id: 'heroTitle', text: 'Checking in…' }),
      el('p', { id: 'heroSub' }),
      el('a', { id: 'heroIssueLink', class: 'hero-issue-link', hidden: true }),
    ),
    cardShell(CARDS[0]),
    el('details', { class: 'home-details' },
      el('summary', { text: 'See agent status' }),
      el('p', { id: 'homeStatusNote', class: 'home-status-note', hidden: true }),
      el('div', { class: 'home-cols' },
        el('div', { class: 'col col-main' }, CARDS.filter((c) => c.col === 'main' && c.id !== 'needs').map(cardShell)),
        el('div', { class: 'col col-side' }, CARDS.filter((c) => c.col === 'side').map(cardShell)),
      ),
    ),
  );
  loadHome();
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => { if (document.visibilityState === 'visible' && location.hash.startsWith('#/home')) loadHome(); }, REFRESH_MS);
}

// ── Group pages (static directories) ──────────────────────────────────────
function tile(t, withIcon = true) {
  const a = el('a', { class: 'tile', href: tabHref(t.id) });
  if (withIcon) a.append(el('span', { class: 't-icon', icon: t.icon || 'arrow' }));
  a.append(el('span', {}, el('span', { class: 't-name', text: t.label }), el('span', { class: 't-desc', text: t.desc })));
  return a;
}

function renderGroup(main, g) {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  const parts = [
    el('section', { class: 'group-head' },
      el('div', { class: 'eyebrow', text: g.label }),
      el('h1', { text: g.question }),
      el('p', { text: 'Each of these opens in the dashboard, where everything works exactly as before.' }),
    ),
    el('div', { class: 'tiles' }, g.tabs.map((t) => tile(t))),
    ...groupExtras(g, { get }), // the Development tile (Work, maintainer mode only) and the developer-tools switch (Settings)
    ...(g.id === 'work' ? [maturationTile(get)] : []), // shown only when /maturation/board answers
    ...(g.id === 'work' ? [paceCard(get)] : []), // the Pace card: shown only when /queue-pace answers
  ];
  if (g.hood && g.hood.length) {
    parts.push(
      el('h2', { class: 'eyebrow section-label', text: 'Under the hood' }),
      el('div', { class: 'tiles tiles-hood' }, g.hood.map((t) => tile({ ...t, icon: 'wrench' }))),
    );
  }
  parts.push(footNote());
  main.replaceChildren(...parts);
}

function footNote() {
  return el('p', { class: 'foot-note' },
    document.createTextNode('This is the new Instar console. Everything is still in the '),
    el('a', { href: '/dashboard', text: 'legacy dashboard' }),
    document.createTextNode('.'),
  );
}

// ── routing ───────────────────────────────────────────────────────────────
// Native feature pages, by hash path. A feature not listed here still opens its legacy tab.
const NATIVE = {
  'work/promises': renderPromises,
  'work/plans': renderPlans,
  'work/plans/in-the-way': renderPlans,
  'work/schedule': renderSchedule,
  'work/development': renderDevelopment,
  'work/maturation': renderMaturation,
  'work/sessions': renderSessions,
  'capacity/machines': renderMachines,
  'capacity/accounts': renderAccounts,
  'capacity/costs': renderCosts,
  'people/messages': renderMessages,
  'people/agents': renderAgents,
  'people/mandates': renderMandates,
  'people/secrets': renderSecrets,
  'settings/allowed': renderAllowed,
  'settings/learned': renderLearned,
  'settings/inside': renderInside,
  'settings/files': renderFiles,
};

function route() {
  if (homeRun) { homeRun.active = false; for (const p of Object.values(homeRun.pending)) if (p && p !== true) clearTimeout(p); homeRun = null; }
  closeSheet();
  const path = (location.hash.replace(/^#\/?/, '') || 'home').split('?')[0];
  const id = path.split('/')[0];
  const group = GROUPS.find((g) => g.id === id);
  const active = group ? group.id : 'home';
  const main = renderShell(active);
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  if (NATIVE[path]) {
    NATIVE[path](main, { get, post, getCommitments });
    // Pages refresh in place every 30 s while visible, never over an open sheet.
    refreshTimer = setInterval(() => {
      if (document.visibilityState === 'visible' && !sheetIsOpen() && (location.hash.replace(/^#\/?/, '').split('?')[0]) === path) NATIVE[path](main, { get, post, getCommitments });
    }, REFRESH_MS);
  } else if (group) renderGroup(main, group); else renderHome(main);
  window.scrollTo(0, 0);
}

async function start() {
  if (!location.hash) history.replaceState(null, '', '#/home');
  window.removeEventListener('hashchange', route);
  window.addEventListener('hashchange', route);
  route();
}

// ── Preview banner ────────────────────────────────────────────────────────
// The preview address serves work in progress; every screen says which work it
// is and when it was published, so it is never mistaken for the live dashboard.
const IS_PREVIEW = /\/dashboard\/preview\//.test(location.pathname);
let previewInfo = null;

async function loadPreviewInfo() {
  if (!IS_PREVIEW) return;
  try {
    const r = await fetch('preview.json', { cache: 'no-store' });
    previewInfo = r.ok ? await r.json() : {};
  } catch { previewInfo = {}; }
}

function previewBanner() {
  if (!IS_PREVIEW) return null;
  const p = previewInfo || {};
  const at = p.publishedAt ? ago(Date.parse(p.publishedAt)) : null;
  const what = [p.branch ? `work on ${p.branch}` : 'work in progress', at ? `updated ${at}` : null].filter(Boolean).join(' · ');
  return el('div', { class: 'preview-banner', role: 'note' },
    el('strong', { text: 'Preview' }),
    el('span', { text: ` ${what}. Not merged yet.` }),
    el('a', { href: '/dashboard/console/', text: 'Live dashboard' }));
}

(async function boot() {
  applyTheme(readTheme());
  await loadPreviewInfo();
  try { token = localStorage.getItem(TOKEN_KEY) || ''; } catch { token = ''; }
  if (await validToken(token)) start(); else renderUnlock();
})();

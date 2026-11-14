import { renderNotifications } from './notifications.js';
// Instar console — shell, auth, routing, Home rendering.
// Spec: docs/specs/console-makeover.md. Home is read-only; the Promises page
// can close or resume a promise through its existing bearer-protected routes.
//
// SAFETY CONTRACT: every dynamic value reaches the DOM through textContent.
// The only innerHTML writes are the static SVG icon strings from nav-model.js.

import {
  failure, buildNeeds, buildDoing, buildPromised, buildRunning, buildAllowed, headline, ago, combineNeeds, machineNames,
} from './home-model.js';
import { GROUPS, legacyHref, icon, tabHref, LEGACY_DASHBOARD, isPhoneMode, pagePath } from './nav-model.js';
import { fillPartial } from './home-model.js';
import { NEED_SOURCES, surfacedNeeds } from './needs-model.js';
import { renderPromises, topicLink } from './promises.js';
import { renderMachines } from './machines.js';
import { renderHealth } from './health.js';
import { renderAccounts } from './accounts.js';
import { renderMessages } from './messages.js';
import { renderAllowed } from './allowed.js';
import { renderPlans } from './plans.js';
import { renderCosts } from './costs.js';
import { renderSchedule } from './schedule.js';
import { renderDevelopment, groupExtras } from './development.js';
import { renderAgents } from './agents.js';
import { renderReach } from './reach.js';
import { renderMandates } from './mandates.js';
import { renderSecrets } from './secrets.js';
import { renderLearned } from './learned.js';
import { topicNameMap } from './topic-names.js';
import { renderInside } from './inside.js';
import { renderFiles } from './files.js';
import { renderSessions } from './sessions.js';
import { renderMaturation, maturationTile } from './maturation-board.js';
import { renderIdeas, ideasTile } from './ideas.js';
import { renderWork } from './work.js';
import { renderConversations, conversationsTile } from './conversations.js';
import { paceCard } from './pace.js';
import { takeTicket, signInAtBoot } from './ticket-model.js';
import { createLifecycle, splitHash } from './page-lifecycle.js';
import { renderChats } from './chats.js';
import { sheetIsOpen, closeSheet, unlockCheck, machineIssue, MACHINES_PAGE, newArrival, refreshHeld, setKids, rememberOperatorSession, forgetOperatorSession } from './ui.js';

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
// The agent-wide Attention topic, where every attention item is posted.
let attentionTopicId = null;
let homeRun = null;
// One visit per page render (page-lifecycle.js): disposers, query-only changes, self-refreshing pages.
const lifecycle = createLifecycle({ report: (e) => { try { console.warn('console: a page clean-up failed', e); } catch { /* no console */ } } });
// Phone mode (?phone=1, or phone=1 in the hash's query): the Instar app shows one
// page in its own frame, so the console draws no top bar, nav or Legacy link.
// Sticky for this page load: once on, every hash change stays in phone mode.
let phone = false;

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
async function getOnce(path, timeoutMs, soft403 = false) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(path, { headers: { Authorization: `Bearer ${token}` }, signal: ctl.signal, cache: 'no-store' });
    if (r.status === 403 && soft403) return failure('the server answered 403');
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
  forgetOperatorSession();
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* storage blocked */ }
  token = '';
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  lifecycle.dispose();
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
      // The bearer follows the existing dashboard storage policy. Human proof
      // stays only in page memory for owner-only pages, until server expiry.
      try { localStorage.setItem(TOKEN_KEY, data.token); } catch { /* storage blocked */ }
      rememberOperatorSession(data);
      input.value = '';
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
    const onChats = g.id === 'work' && /^#\/work\/chats(\?|$)/.test(location.hash);
    const a = el('a', { href: `#/${g.id}`, icon: g.icon, 'aria-current': g.id === active && !onChats ? 'page' : null });
    a.append(el('span', { text: g.label }));
    nav.append(a);
    if (g.id === 'home') nav.append(conversationsNavItem());
  }
  nav.append(el('div', { class: 'nav-group-label', text: 'Elsewhere' }));
  const legacy = el('a', { href: LEGACY_DASHBOARD, icon: 'external' });
  legacy.append(el('span', { text: 'Legacy dashboard' }));
  legacy.classList.add('nav-sub-legacy');
  nav.append(legacy);
  return nav;
}

/**
 * Conversations at the top level of the sidebar, right under Home (Justin, 2026-11-08: "It should
 * show directly in the sidebar menu on the top level"). It stays a Work tile too. Shown only while
 * the same probe as that tile answers 200, so an agent with the switch off shows nothing new.
 */
function conversationsNavItem() {
  const t = GROUPS.flatMap((g) => g.tabs).find((x) => x.id === 'chats');
  const a = el('a', { href: tabHref('chats'), icon: t?.icon || 'chat', hidden: true, class: 'nav-conversations',
    'aria-current': /^#\/work\/chats(\?|$)/.test(location.hash) ? 'page' : null });
  a.append(el('span', { text: t?.label || 'Conversations' }));
  if (t?.probe) {
    fetch(t.probe, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
      .then((r) => { a.hidden = !r.ok; })
      .catch(() => { /* @silent-fallback-ok: an unreachable probe leaves the entry hidden, as the Work tile does */ });
  }
  return a;
}

function renderShell(active) {
  if (phone) {
    // Only the page: the app's own frame holds the title bar and navigation.
    const main = el('main', { class: 'main', id: 'main' });
    document.body.replaceChildren(el('div', { class: 'app app-phone' }, previewBanner(), main));
    applyTheme(document.documentElement.getAttribute('data-theme') || readTheme());
    return main;
  }
  const legacyChip = el('a', { class: 'chip chip-legacy', href: LEGACY_DASHBOARD, text: 'Legacy' });
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
  if (action.kind === 'href') return action.href || null;
  if (action.kind === 'attention') return attentionTopicId ? topicLink(homeChatId, attentionTopicId) : null;
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
  // An empty footer would leave a blank band (and its divider) under the rows.
  foot.hidden = !foot.textContent.trim() && !foot.querySelector('a, button');
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
    const noteText = models.needs?.statusNote || '';
    statusNote.replaceChildren(document.createTextNode(noteText));
    // A machine that did not answer: link to where its state is shown.
    if (noteText && machineIssue(noteText)) statusNote.append(' ', el('a', { href: MACHINES_PAGE, text: 'See machines' }));
    statusNote.hidden = !noteText;
  }
  const issueLink = $('#heroIssueLink');
  if (issueLink) {
    issueLink.hidden = !((h.tone === 'bad' || h.tone === 'attn') && h.linkLabel && href);
    if (!issueLink.hidden) { issueLink.href = href; issueLink.textContent = `${h.linkLabel || 'Inspect the issue'} →`; }
  }
  $('#heroTime').textContent = `${h.tone === 'attn' ? 'What needs you' : 'Updated'} · ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

// A machine that misses one pooled read (slow for a moment, or restarting)
// should not turn Home into "part could not be checked". While it is retried,
// its rows from the last complete answer stand in, for up to two minutes; the
// machines that did answer always show their fresh rows.
// Kept in session storage too, so reopening the app or reloading the page while a
// machine is slow still has it (page memory alone is lost on reload). Storage can be
// absent or full; then it is page memory only, as before.
const lastComplete = {};
const ROW_LISTS = { attention: 'items', sessions: 'sessions' };
const LAST_COMPLETE_STORE = 'console.lastComplete.';
function rememberComplete(key, result) {
  if (!ROW_LISTS[key]) return;
  lastComplete[key] = { result, at: Date.now() };
  try { sessionStorage.setItem(LAST_COMPLETE_STORE + key, JSON.stringify(lastComplete[key])); } catch { /* @silent-fallback-ok: storage unavailable or full; page memory only, as before */ }
}
function storedComplete(key) {
  try {
    const v = JSON.parse(sessionStorage.getItem(LAST_COMPLETE_STORE + key) || 'null');
    return v && typeof v.at === 'number' && v.result ? v : null;
  } catch { return null; } // @silent-fallback-ok: unreadable storage means no stored answer
}
function fillFromLastComplete(key, fresh) {
  const prev = lastComplete[key] || (lastComplete[key] = storedComplete(key) || undefined);
  return ROW_LISTS[key] && prev ? fillPartial(fresh, prev.result, ROW_LISTS[key], Date.now(), prev.at) : null;
}

function loadHome() {
  const run = homeRun;
  if (!run || !run.active || run.document !== document) return;
  const { models, raw, results } = run;
  const paint = (id) => {
    // "What needs you" is the one answer: queue items plus promises waiting on the operator.
    const model = id === 'needs' ? combineNeeds(raw.needs, raw.promised, surfacedNeeds(run.sources)) : raw[id];
    if (!model) return; // nothing read yet for this card
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
    if ((key === 'attention' || key === 'pool' || key === 'systemTopics') && results.attention) set('needs', annotate(buildNeeds(results.attention, Date.now(), names), results.attention));
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
      const filled = partial ? fillFromLastComplete(key, result) : null;
      if (result.ok && !partial) rememberComplete(key, result);
      results[key] = filled || (partial ? { ...result, retrying: true } : result);
      if (key === 'systemTopics' && result.ok) {
        const t = Number(result.data?.topics?.attention);
        attentionTopicId = Number.isFinite(t) && t > 1 ? t : null;
      }
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
  // What needs the operator on other pages (needs-model.js): one in-flight read per source, no
  // retry timer of its own (the next tick is the retry), and a 403 here never signs anyone out.
  run.tick = (run.tick || 0) + 1;
  for (const source of NEED_SOURCES) {
    if (run.sourceBusy[source.id]) continue;
    if (source.when && !source.when(run.sources)) continue;
    if (source.everyTicks && run.sourceAt[source.id] && run.tick - run.sourceAt[source.id] < source.everyTicks) continue;
    run.sourceAt[source.id] = run.tick;
    run.sourceBusy[source.id] = true;
    const keys = Object.keys(source.reads);
    Promise.all(keys.map((k) => getOnce(source.reads[k], Math.max(TIMEOUT_MS, MIN_TIMEOUT_MS), true))).then((reads) => {
      run.sourceBusy[source.id] = false;
      if (!run.active || run.document !== document) return;
      run.sources[source.id] = { ...(run.sources[source.id] || {}), results: Object.fromEntries(keys.map((k, i) => [k, reads[i]])) };
      paint('needs');
      paintHeadline(models);
    });
  }
  // Every source has one in-flight request and its own bounded retry timer.
  // A slow source cannot block another card or start overlapping refreshes.
  read('pool', '/pool', POOL_TIMEOUT_MS);
  // Open items only: a machine's full history (closed items included) can be
  // over a megabyte, enough to miss the per-machine time limit.
  read('attention', '/attention?scope=pool&status=OPEN', POOL_TIMEOUT_MS);
  read('systemTopics', '/telegram/system-topics');
  read('sessions', '/sessions?scope=pool', POOL_TIMEOUT_MS);
  read('topics', '/telegram/topics?scope=pool', POOL_TIMEOUT_MS);
  read('commitments', '/commitments?scope=mesh', COMMITMENTS_TIMEOUT_MS);
  read('guards', '/guards', TIMEOUT_MS);
  read('mandate', '/mandate', TIMEOUT_MS);
}

function renderHome(main, ctx) {
  const run = { active: true, document, models: Object.fromEntries(CARDS.map((c) => [c.id, { state: 'loading' }])), raw: {}, results: {}, pending: {}, failures: {}, sources: {}, sourceBusy: {}, sourceAt: {} };
  homeRun = run;
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
  const timer = setInterval(() => { if (document.visibilityState === 'visible' && location.hash.startsWith('#/home')) loadHome(); }, REFRESH_MS);
  refreshTimer = timer;
  // Home's teardown is its own disposer, closing over this run: its retry timers and its refresh timer.
  if (ctx) ctx.onDispose(() => {
    run.active = false;
    for (const p of Object.values(run.pending)) if (p && p !== true) clearTimeout(p);
    clearInterval(timer);
    if (refreshTimer === timer) refreshTimer = null;
    if (homeRun === run) homeRun = null;
  });
}

// ── Group pages (static directories) ──────────────────────────────────────
function tile(t, withIcon = true) {
  const a = el('a', { class: 'tile', href: tabHref(t.id) });
  if (withIcon) a.append(el('span', { class: 't-icon', icon: t.icon || 'arrow' }));
  a.append(el('span', {}, el('span', { class: 't-name', text: t.label }), el('span', { class: 't-desc', text: t.desc })));
  return a;
}

/**
 * A tile shown only when its probe answers 200 (e.g. Conversations, while its switch is on).
 * A plain fetch: a refusal here must never sign the operator out.
 */
function probedTile(t) {
  const host = el('div', { class: 'tiles tiles-inline', hidden: true }, tile(t));
  fetch(t.probe, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
    .then((r) => { host.hidden = !r.ok; })
    .catch(() => { /* @silent-fallback-ok: an unreachable probe leaves the tile hidden */ });
  return host;
}

function renderGroup(main, g) {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  const extras = [
    ...(g.id === 'work' ? [conversationsTile()] : []),
    ...groupExtras(g, { get }), // the Development tile (Work, maintainer mode only) and the developer-tools switch (Settings)
    ...(g.id === 'work' ? [maturationTile(get)] : []), // shown only when /maturation/board answers
    ...(g.id === 'work' ? [ideasTile(get)] : []), // shown only when /ecosystem-ideas answers
  ];
  // A conditional tile arrives in its own `.tiles` wrapper (shown or hidden after its
  // probe). Put the wrappers inside the one grid and let a shown wrapper's tile take a
  // cell there, so every tile lines up (2026-11-02: each sat alone in its own row).
  const tileHosts = extras.filter((n) => n && n.classList && n.classList.contains('tiles'));
  for (const h of tileHosts) h.classList.add('tiles-inline');
  const parts = [
    el('section', { class: 'group-head' },
      el('div', { class: 'eyebrow', text: g.label }),
      el('h1', { text: g.question }),
    ),
    el('div', { class: 'tiles' }, [...g.tabs.map((t) => (t.probe ? probedTile(t) : tile(t))), ...tileHosts]),
    ...extras.filter((n) => !tileHosts.includes(n)),
    ...(g.id === 'work' ? [paceCard(get)] : []), // the Pace card: shown only when /queue-pace answers
  ];
  if (g.hood && g.hood.length) {
    parts.push(
      el('h2', { class: 'eyebrow section-label', text: 'Under the hood' }),
      el('div', { class: 'tiles tiles-hood' }, g.hood.map((t) => tile({ ...t, icon: 'wrench' }))),
    );
  }
  if (!phone) parts.push(footNote());
  main.replaceChildren(...parts);
}

function footNote() {
  return el('p', { class: 'foot-note' },
    document.createTextNode('The older dashboard is still available: '),
    el('a', { href: LEGACY_DASHBOARD, text: 'open the legacy dashboard' }),
    document.createTextNode('.'),
  );
}

// ── routing ───────────────────────────────────────────────────────────────
// Native feature pages, by hash path. A feature not listed here still opens its legacy tab.
const NATIVE = {
  'work/conversations': renderConversations,
  'work/promises': renderPromises,
  'work/plans': renderPlans,
  'work/plans/in-the-way': renderPlans,
  'work/schedule': renderSchedule,
  'work/development': renderDevelopment,
  'work/maturation': renderMaturation,
  'work/ideas': renderIdeas,
  'work/board': renderWork,
  'work/sessions': renderSessions,
  'work/chats': renderChats,
  'capacity/machines': renderMachines,
  'capacity/health': renderHealth,
  'capacity/accounts': renderAccounts,
  'capacity/costs': renderCosts,
  'people/messages': renderMessages,
  'people/notifications': renderNotifications,
  'people/agents': renderAgents,
  'people/reach': renderReach,
  'people/mandates': renderMandates,
  'people/secrets': renderSecrets,
  'settings/allowed': renderAllowed,
  'settings/learned': renderLearned,
  'settings/inside': renderInside,
  'settings/files': renderFiles,
};

// Pages that exist only in phone mode: the Work page's Pace card, on its own.
const PHONE_ONLY = {
  'work/pace': (main, { get: read }) => {
    const old = main.querySelector('.pace-card');
    const note = main.querySelector('.pace-missing') || el('p', { class: 'card-line pace-missing', hidden: true, text: 'Pace is not available on this agent right now.' });
    // A refresh keeps the card on screen and swaps in the new one once it has loaded.
    const card = paceCard(read, {
      onMissing: () => { if (!old) note.hidden = false; },
      onShown: () => { note.hidden = true; if (old && old.isConnected) old.replaceWith(card); },
    });
    if (!old) setKids(main, el('section', { class: 'group-head' }, el('h1', { text: 'Pace' })), card, note);
  },
};

function route() {
  if (!phone && isPhoneMode('', location.hash)) phone = true;
  const { path: hashPath, query } = splitHash(location.hash);
  const path = pagePath(hashPath, phone);
  // Only the query changed on a page that handles that itself: no rebuild, no sheet close, no scroll.
  if (lifecycle.tryQuery(path, query)) return;
  // The previous visit's disposers run before anything new is drawn.
  lifecycle.dispose();
  if (homeRun) { homeRun.active = false; for (const p of Object.values(homeRun.pending)) if (p && p !== true) clearTimeout(p); homeRun = null; }
  closeSheet();
  newArrival();
  document.documentElement.toggleAttribute('data-phone', phone);
  const pages = phone ? { ...NATIVE, ...PHONE_ONLY } : NATIVE;
  const id = path.split('/')[0];
  const group = GROUPS.find((g) => g.id === id);
  const active = group ? group.id : 'home';
  const main = renderShell(active);
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  const ctx = lifecycle.begin(path, query);
  const pageCtx = (c) => ({ get, post, getCommitments, onDispose: c.onDispose, onQuery: c.onQuery, selfRefreshing: c.selfRefreshing, isCurrent: c.isCurrent });
  if (pages[path]) {
    pages[path](main, pageCtx(ctx));
    // Pages refresh in place every 30 s while visible, never over an open sheet or an
    // interaction in progress, and one at a time: a slow read cannot paint over a newer one.
    // A self-refreshing page (it registered ctx.selfRefreshing()) is never re-run by this cycle.
    if (!lifecycle.isSelfRefreshing()) {
      let refreshing = false;
      const timer = setInterval(() => {
        if (refreshing || lifecycle.isSelfRefreshing() || document.visibilityState !== 'visible' || sheetIsOpen() || refreshHeld(main) || splitHash(location.hash).path !== hashPath) return;
        refreshing = true;
        // Each re-run is a new visit: the previous run's disposers are called first.
        const next = lifecycle.begin(path, splitHash(location.hash).query);
        Promise.resolve().then(() => pages[path](main, pageCtx(next))).catch(() => { /* @silent-fallback-ok: a failed refresh keeps the page on screen; the next tick tries again */ }).finally(() => { refreshing = false; });
      }, REFRESH_MS);
      // Cleared by the next route() (and signOut), never by a re-run's own visit change.
      refreshTimer = timer;
    }
  } else if (group) renderGroup(main, group); else renderHome(main, ctx);
  window.scrollTo(0, 0);
}

async function start() {
  phone = phone || isPhoneMode(location.search, location.hash);
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
  // An owner's paired phone opens signed in without the PIN (mobile-console-device-signin §3.5).
  let ticket = '';
  try { ticket = takeTicket(sessionStorage); } catch { ticket = ''; }
  const signIn = await signInAtBoot({ storedToken: token, validToken, ticket, fetchFn: (p, o) => fetch(p, o) });
  if (signIn.via === 'ticket') {
    // Stored exactly as the PIN unlock stores it.
    try { localStorage.setItem(TOKEN_KEY, signIn.token); } catch { /* storage blocked */ }
  }
  token = signIn.token;
  if (signIn.via === 'pin') renderUnlock(); else start();
})();

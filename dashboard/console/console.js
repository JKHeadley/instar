// Instar console — shell, auth, routing, Home rendering.
// Spec: docs/specs/console-makeover.md. Read-only in MVP: every write action
// lives in the legacy dashboard, reached by an ordinary link.
//
// SAFETY CONTRACT: every dynamic value reaches the DOM through textContent.
// The only innerHTML writes are the static SVG icon strings from nav-model.js.

import {
  failure, buildReach, buildNeeds, buildDoing, buildPromised, buildRunning, buildAllowed, headline, ago,
} from './home-model.js';
import { GROUPS, legacyHref, icon, tabHref } from './nav-model.js';
import { renderPromises } from './promises.js';
import { renderMachines } from './machines.js';
import { renderAccounts } from './accounts.js';
import { renderMessages } from './messages.js';
import { renderPlans } from './plans.js';
import { sheetIsOpen, closeSheet } from './ui.js';

const TOKEN_KEY = 'instar_token';      // shared with the legacy dashboard
const THEME_KEY = 'instar_console_theme';
const TIMEOUT_MS = 5000;
// Pool reads wait on peers for up to 5 s server-side, so the browser waits longer
// and says it is still checking rather than discarding a partial answer.
const POOL_TIMEOUT_MS = 8000;
const REFRESH_MS = 30000;

let token = '';
let refreshTimer = null;
let lastGood = {};                      // card id → last model that was not unknown
const expanded = new Set();             // cards the operator expanded; kept across refreshes
const openRows = new Set();             // rows the operator opened; kept across refreshes
let rowSeq = 0;

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
async function get(path, timeoutMs = TIMEOUT_MS) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(path, { headers: { Authorization: `Bearer ${token}` }, signal: ctl.signal, cache: 'no-store' });
    if (r.status === 401 || r.status === 403) { signOut(); return failure('not signed in'); }
    if (r.status === 503) return failure('switched off on this agent');
    if (!r.ok) return failure(`the server answered ${r.status}`);
    try { return { ok: true, data: await r.json() }; } catch { return failure('the answer was not readable'); }
  } catch (e) {
    return failure(e && e.name === 'AbortError' ? `no answer within ${Math.round(timeoutMs / 1000)} seconds` : 'the server could not be reached');
  } finally { clearTimeout(t); }
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

function renderUnlock(message) {
  document.body.replaceChildren();
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
  const app = el('div', { class: 'app' }, top, navItems(active), main);
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
  { id: 'doing', title: 'What I’m doing', href: legacyHref('sessions'), col: 'main' },
  { id: 'reach', title: 'Can I reach you', href: '#/people/messages', col: 'side' },
  { id: 'running', title: 'Where I’m running', href: '#/capacity/machines', col: 'side' },
  { id: 'allowed', title: 'What I’m allowed to do', href: legacyHref('machines'), col: 'side' },
];

const STATE_WORD = { ok: null, attn: null, bad: 'failing', unknown: 'can’t tell', partial: 'partial', stale: 'out of date' };

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
    model = { ...prev.model, state: 'stale', line: `${model.line} Showing what I saw ${ago(prev.at)}.`, age: ago(prev.at) };
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
      const row = el(r.expandable || r.detail ? 'button' : 'div', { class: 'row', type: r.expandable || r.detail ? 'button' : null },
        el('span', { class: r.tone === 'bad' ? 'dot bad' : r.tone === 'attn' ? 'dot attn' : r.tone === 'unknown' ? 'dot unknown' : 'dot' }),
        el('span', { class: 'row-main' }, el('span', { class: 'row-title', text: r.main || '' }), r.sub ? el('span', { class: r.mono ? 'row-sub mono' : 'row-sub', text: r.sub }) : null),
        el('span', { class: 'row-end', text: r.end || '' }),
      );
      if (r.expandable || r.detail) {
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
  if (h.tone === 'attn') {
    const m = /^(\d+|One)(.*)$/.exec(h.text);
    if (m) h1.append(el('span', { class: 'attn', text: m[1] }), document.createTextNode(m[2]));
    else h1.textContent = h.text;
  } else if (h.tone === 'ok') {
    const words = h.text.split(' ');
    h1.append(document.createTextNode(words.slice(0, -1).join(' ') + (words.length > 1 ? ' ' : '')), el('span', { class: 'accent', text: words[words.length - 1] }));
  } else h1.textContent = h.text;
  const parts = [];
  if (models.needs && models.needs.count > 0) parts.push(`${models.needs.value} in the queue`);
  if (models.promised && models.promised.count > 0) parts.push(`${models.promised.count} ${models.promised.count === 1 ? 'promise' : 'promises'} waiting on you`);
  sub.textContent = h.tone === 'attn' && parts.length ? `${parts.join(' and ')}.${h.sub ? ' ' + h.sub : ''}` : (h.sub || '');
  $('#heroTime').textContent = `Updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

function pooled(id, path, build, set) {
  const slow = setTimeout(() => {
    const card = $(`#card-${id}`);
    if (card && card.getAttribute('data-state') === 'loading') {
      const line = card.querySelector('.card-line');
      line.textContent = 'Still checking the other machines…';
    }
  }, TIMEOUT_MS);
  get(path, POOL_TIMEOUT_MS).then((r) => { clearTimeout(slow); set(id, build(r)); });
}

async function loadHome() {
  const models = Object.fromEntries(CARDS.map((c) => [c.id, { state: 'loading' }]));
  const set = (id, model) => { models[id] = paintCard(CARDS.find((c) => c.id === id), model) || model; paintHeadline(models); };
  // Each card fetches and renders on its own (spec §1): one slow source never blocks the rest.
  pooled('needs', '/attention?scope=pool', buildNeeds, set);
  get('/health').then((r) => set('reach', buildReach(r)));
  const poolP = get('/pool');
  Promise.all([get('/commitments?scope=mesh'), poolP]).then(([r, pool]) => {
    const peers = pool.ok && Array.isArray(pool.data && pool.data.machines) ? pool.data.machines.filter((m) => m && !m.isSelf && m.machineId !== pool.data.selfMachineId).length : null;
    set('promised', buildPromised(r, Date.now(), peers));
  });
  pooled('doing', '/sessions?scope=pool', buildDoing, set);
  poolP.then((r) => set('running', buildRunning(r)));
  Promise.all([get('/guards'), get('/mandate')]).then(([g, m]) => set('allowed', buildAllowed(g, m)));
}

function renderHome(main) {
  main.replaceChildren(
    el('section', { class: 'hero' },
      el('div', { class: 'eyebrow', id: 'heroTime', text: 'Checking in' }),
      el('h1', { id: 'heroTitle', text: 'Checking in…' }),
      el('p', { id: 'heroSub' }),
    ),
    el('div', { class: 'home-cols' },
      el('div', { class: 'col col-main' }, CARDS.filter((c) => c.col === 'main').map(cardShell)),
      el('div', { class: 'col col-side' }, CARDS.filter((c) => c.col === 'side').map(cardShell)),
    ),
    footNote(),
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
  'capacity/machines': renderMachines,
  'capacity/accounts': renderAccounts,
  'people/messages': renderMessages,
};

function route() {
  closeSheet();
  const path = (location.hash.replace(/^#\/?/, '') || 'home').split('?')[0];
  const id = path.split('/')[0];
  const group = GROUPS.find((g) => g.id === id);
  const active = group ? group.id : 'home';
  const main = renderShell(active);
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  if (NATIVE[path]) {
    NATIVE[path](main, { get, post });
    // Pages refresh in place every 30 s while visible, never over an open sheet.
    refreshTimer = setInterval(() => {
      if (document.visibilityState === 'visible' && !sheetIsOpen() && (location.hash.replace(/^#\/?/, '').split('?')[0]) === path) NATIVE[path](main, { get, post });
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

(async function boot() {
  applyTheme(readTheme());
  try { token = localStorage.getItem(TOKEN_KEY) || ''; } catch { token = ''; }
  if (await validToken(token)) start(); else renderUnlock();
})();

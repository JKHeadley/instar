// Standalone maturation board (docs/specs/maturation-board.md §7). Shares the
// console's token (one PIN unlock covers both) and renders the same module.
import { el } from '../console/ui.js';
import { renderMaturation } from '../console/maturation-board.js';

const TOKEN_KEY = 'instar_token'; // shared with the console and the legacy dashboard
const THEME_KEY = 'instar_console_theme';
let token = '';

function applyTheme() {
  let t = 'dark';
  try { const v = localStorage.getItem(THEME_KEY); if (v === 'light' || v === 'dark') t = v; } catch { /* storage blocked */ }
  document.documentElement.setAttribute('data-theme', t);
}

async function get(path, timeoutMs = 5000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(path, { headers: { Authorization: `Bearer ${token}` }, signal: ctl.signal, cache: 'no-store' });
    if (r.status === 401 || r.status === 403) { signOut(); return { ok: false, reason: 'not signed in' }; }
    if (r.status === 503) return { ok: false, reason: 'switched off on this agent' };
    if (!r.ok) return { ok: false, reason: `the server answered ${r.status}` };
    try { return { ok: true, data: await r.json() }; } catch { return { ok: false, reason: 'the answer was not readable' }; }
  } catch (e) {
    return { ok: false, reason: e && e.name === 'AbortError' ? `no answer within ${Math.round(timeoutMs / 1000)} seconds` : 'the server could not be reached' };
  } finally { clearTimeout(t); }
}

const nav = {
  read() { return location.search; },
  write(q) { history.replaceState(null, '', location.pathname + q); },
};

async function validToken(t) {
  if (!t) return false;
  try { return (await fetch('/sessions', { headers: { Authorization: `Bearer ${t}` }, cache: 'no-store' })).ok; } catch { return false; }
}

function signOut() {
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* storage blocked */ }
  token = '';
  renderUnlock();
}

function renderUnlock(message) {
  const input = el('input', { class: 'pin-input', type: 'password', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '12', 'aria-label': 'Dashboard PIN', placeholder: '••••••' });
  const err = el('div', { class: 'unlock-error', role: 'alert', text: message || '' });
  const btn = el('button', { class: 'btn-primary', type: 'submit', text: 'Unlock' });
  const form = el('form', { class: 'unlock-card' },
    el('img', { src: '/dashboard/logo.png', alt: '' }),
    el('h1', { text: 'Feature maturation' }),
    el('p', { text: 'Enter your dashboard PIN to continue.' }),
    input, btn, err);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    btn.disabled = true; err.textContent = '';
    try {
      const r = await fetch('/dashboard/unlock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: input.value }) });
      const data = await r.json().catch(() => ({}));
      if ((r.status === 404 || r.status === 503) && await validToken(input.value)) {
        try { localStorage.setItem(TOKEN_KEY, input.value); } catch { /* storage blocked */ }
        token = input.value; start(); return;
      }
      if (!r.ok || typeof data.token !== 'string') {
        err.textContent = data.error ? `${data.error}${typeof data.attemptsRemaining === 'number' ? ` · ${data.attemptsRemaining} tries left` : ''}` : 'That did not work. Try again.';
        btn.disabled = false; input.select(); return;
      }
      try { localStorage.setItem(TOKEN_KEY, data.token); } catch { /* storage blocked */ }
      token = data.token;
      start();
    } catch { err.textContent = 'The server could not be reached.'; btn.disabled = false; }
  });
  document.body.replaceChildren(el('main', { class: 'unlock' }, form));
  input.focus();
}

function start() {
  const main = el('main', { class: 'main mb-standalone' });
  const top = el('header', { class: 'mb-top' },
    el('a', { href: '/dashboard/console/', text: '← Console' }),
    el('span', { class: 'mb-sub', text: 'Refreshes every minute' }));
  document.body.replaceChildren(top, main);
  const draw = () => renderMaturation(main, { get }, nav);
  draw();
  setInterval(() => { if (document.visibilityState === 'visible') draw(); }, 60_000);
}

(async function boot() {
  applyTheme();
  try { token = localStorage.getItem(TOKEN_KEY) || ''; } catch { token = ''; }
  if (await validToken(token)) start(); else renderUnlock();
})();

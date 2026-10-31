// Accounts page (docs/specs/console-features/capacity.md, "Accounts").
// Needs-you sign-ins first, then allowance, with each account's machines as chips.
// Actions per the PIN adapters (00-patterns.md §4):
//   start a cell's sign-in    POST /subscription-pool/matrix/start-cell   body PIN, once
//   submit the sign-in code   POST /subscription-pool/follow-me/submit-code  bearer
//   cancel a sign-in          POST /subscription-pool/follow-me/cancel     bearer
//   repair / retry / cancel   POST /subscription-relogin/repair-cell       operator session

import { buildAccountsPage, frameworkName } from './accounts-model.js';
import { el, setKids, pageHead, sheet, closeSheet, story, details, note, cantTell, askPin, forgetOperatorSession } from './ui.js';
import { legacyHref } from './nav-model.js';
import { verifiedDisplayName } from './display-identity.js';

async function postJson(path, body, headers = {}) {
  const token = (() => { try { return localStorage.getItem('instar_token') || ''; } catch { return ''; } })();
  try {
    const r = await fetch(path, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body || {}) });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  } catch { return { ok: false, status: 0, data: { error: 'The server could not be reached.' } }; }
}

export async function renderAccounts(main, ctx) {
  const { get } = ctx;
  if (!main.querySelector('.acct-list')) setKids(main, el('section', { class: 'hero page-hero' }, el('div', { class: 'eyebrow', text: 'Capacity · Accounts' }), el('h1', { class: 'page-title skeleton', text: 'Loading accounts' })));
  const [pool, relogin, inUse, machines] = await Promise.all([get('/subscription-pool?scope=pool', 8000), get('/subscription-relogin?scope=pool', 8000), get('/subscription-pool/in-use'), get('/pool')]);
  const names = machines.ok && Array.isArray(machines.data && machines.data.machines) ? Object.fromEntries(machines.data.machines.map((m) => [m.machineId, m.nickname])) : {};
  const episodes = relogin.ok && Array.isArray(relogin.data && relogin.data.episodes) ? relogin.data.episodes : [];
  const page = buildAccountsPage(pool, Date.now(), { episodes, inUse: inUse.ok ? inUse.data : null, names });
  if (!page.ok) { setKids(main, pageHead({ eyebrow: 'Capacity · Accounts', headline: 'Accounts', tone: 'muted' }), cantTell(page.reason), legacyLink()); return; }
  const refresh = () => renderAccounts(main, ctx);

  // One card per machine: "Mac Mini — 5 accounts need signing in", one row and button each.
  const byMachine = new Map();
  for (const n of page.needs) { if (!byMachine.has(n.machineId)) byMachine.set(n.machineId, []); byMachine.get(n.machineId).push(n); }
  const needs = page.needs.length ? el('section', { class: 'page-sections', id: 'sec-needs' },
    el('h2', { class: 'eyebrow', text: 'Needs you' }),
    [...byMachine.entries()].map(([, items]) => el('div', { class: 'need-card' },
      el('span', { class: 'need-title', text: items.length === 1 ? `${items[0].machine}: 1 account needs signing in` : `${items[0].machine}: ${items.length} accounts need signing in` }),
      el('div', { class: 'rows' }, items.map((n) => el('div', { class: 'row' },
        el('span', { class: 'dot attn' }),
        el('span', { class: 'row-main' }, el('span', { class: 'row-title', text: n.label }), el('span', { class: 'row-sub', text: n.sub })),
        el('span', { class: 'row-end' }, n.actionable ? el('button', { class: 'btn-quiet btn-small', type: 'button', text: n.action === 'start' ? 'Sign in' : n.action === 'retry' ? 'Try again' : 'Repair', onclick: () => startNeed(n, refresh) }) : null))))))) : null;

  const groups = new Map();
  for (const a of page.accounts) { const k = frameworkName(a.framework); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(a); }
  const list = el('div', { class: 'page-sections acct-list' }, [...groups.entries()].map(([name, accts]) => el('section', { class: 'list-section' },
    el('div', { class: 'list-head' }, el('h2', { class: 'eyebrow', text: name }), el('span', { class: 'list-count', text: String(accts.length) })),
    el('div', { class: 'list-rows' }, accts.map((a) => {
      const pct = a.tight ? Math.round(a.tight.pct) : null;
      const bar = el('span', { class: `acct-bar${a.tone ? ' ' + a.tone : ''}` }, el('span'));
      if (pct !== null) bar.firstChild.style.width = `${Math.min(100, Math.max(2, pct))}%`;
      const row = el('button', { class: 'acct-row', type: 'button', 'data-focus-key': `a:${a.id}` },
        el('span', { class: 'acct-name' }, document.createTextNode(a.name), a.inUse ? el('span', { class: 'acct-tag', text: 'in use here' }) : null),
        el('span', { class: `acct-pct${a.tone ? ' ' + a.tone : ''}`, text: pct === null ? '—' : `${pct}%` }),
        bar,
        el('span', { class: 'acct-line', text: [a.line, a.second, a.stale ? `reading from ${a.readingAge}` : null].filter(Boolean).join(' · ') }),
        el('span', { class: 'chips' }, a.cells.map((c) => el('span', { class: `mchip ${c.state}`, text: c.machine }))));
      row.addEventListener('click', () => openAccount(a, refresh));
      return row;
    })))));

  setKids(main,
    pageHead({ eyebrow: 'Capacity · Accounts', headline: page.headline, sub: page.sub, tone: page.tone, facts: page.facts }),
    page.partial ? note(page.partial) : null,
    !relogin.ok ? note(`Couldn't read sign-in repairs: ${relogin.reason}.`) : null,
    needs, list, legacyLink());
  const want = new URLSearchParams((location.hash.split('?')[1] || '')).get('s');
  if (want === 'needs' && needs) needs.scrollIntoView({ block: 'start' });
}

function legacyLink() {
  return el('p', { class: 'foot-note' }, el('a', { href: legacyHref('subscriptions'), text: 'Letting another machine use an account, and identity repair, are in the legacy Subscriptions tab' }));
}

function openAccount(a, refresh) {
  const lines = [
    { label: 'Kind', text: frameworkName(a.framework) },
    a.email ? { label: 'Email', text: a.email } : null,
    { label: 'Usage', text: a.tight ? [a.line, a.second].filter(Boolean).join('; ') : a.line },
    { label: 'Reading', text: a.readingAge ? `from ${a.readingAge}` : 'none yet' },
  ].filter(Boolean);
  const machines = el('div', { class: 'rows' }, a.cells.map((c) => {
    const r = el('div', { class: 'row' },
      el('span', { class: c.state === 'attn' ? 'dot attn' : c.state === 'ok' ? 'dot live' : 'dot unknown' }),
      el('span', { class: 'row-main' }, el('span', { class: 'row-title', text: c.machine }), el('span', { class: 'row-sub', text: c.state === 'attn' && !c.actionable ? 'Needs sign-in; a unique account and machine name are needed first.' : c.label })),
      el('span', { class: 'row-end' }));
    if (c.state === 'attn' && c.actionable) r.querySelector('.row-end').append(el('button', { class: 'btn-quiet', type: 'button', text: 'Sign in', onclick: () => startNeed({ accountId: a.id, machineId: c.machineId, machine: c.machine, title: `Sign in ${a.email || a.name} on ${c.machine}`, action: c.episode && (c.episode.state === 'failed' || c.episode.state === 'suggested') ? (c.episode.state === 'failed' ? 'retry' : 'approve') : 'start', episodeId: c.episode ? c.episode.id : null }, refresh) }));
    return r;
  }));
  sheet({ title: a.name }, story(lines), el('section', { class: 'sheet-block' }, el('h3', { class: 'eyebrow', text: 'On each machine' }), machines),
    details(a.cells[0] ? a.cells[0].row : {}, ['id', 'nickname', 'email', 'provider', 'framework', 'status', 'loginCheck', 'enrolledAt', 'lastRefreshAt', 'identityDrifted']));
}

/** One sign-in, start to finish, in sheets. */
async function startNeed(n, refresh) {
  if (n.action !== 'start') return repairNeed(n, refresh);
  const pin = await askPin({ title: n.title, explain: `This starts a fresh sign-in for this account on ${n.machine}. Your PIN is used for this one request and not kept.`, adapter: 'body' });
  if (!pin) return;
  const status = el('p', { class: 'action-status', role: 'status', text: 'Starting the sign-in…' });
  sheet({ title: n.title }, status);
  const r = await postJson('/subscription-pool/matrix/start-cell', { accountId: n.accountId, machineId: n.machineId, pin: pin.pin });
  pin.pin = '';
  if (!r.ok || !r.data || !r.data.verificationUrl) {
    status.textContent = r.status === 403 ? 'That PIN was not accepted.' : (r.data && (r.data.error || r.data.message)) || `The server answered ${r.status}.`;
    return;
  }
  signInSteps(n, r.data, refresh);
}

function signInSteps(n, d, refresh) {
  const loginId = d.loginId || n.accountId;
  const code = el('input', { class: 'reason-input', inputmode: 'text', autocomplete: 'one-time-code', placeholder: 'Code from the sign-in page, if it shows one', 'aria-label': 'Sign-in code' });
  const status = el('p', { class: 'action-status', role: 'status' });
  const submit = el('button', { class: 'btn-primary btn-inline', type: 'button', text: 'Send the code' });
  submit.addEventListener('click', async () => {
    const value = code.value.trim();
    if (!value) { status.textContent = 'Paste the code first.'; return; }
    submit.disabled = true; status.textContent = 'Checking…';
    const r = await postJson('/subscription-pool/follow-me/submit-code', { machineId: n.machineId, id: loginId, code: value });
    code.value = '';
    if (r.ok && r.data && r.data.outcome === 'validated') { status.textContent = `Signed in on ${n.machine}.`; submit.remove(); setTimeout(() => { closeSheet(); refresh(); }, 1200); }
    else { status.textContent = (r.data && (r.data.error || r.data.message || r.data.outcome)) || 'That code did not work.'; submit.disabled = false; }
  });
  const cancel = el('button', { class: 'btn-quiet', type: 'button', text: 'Cancel this sign-in' });
  cancel.addEventListener('click', async () => {
    cancel.disabled = true;
    const r = await postJson('/subscription-pool/follow-me/cancel', { machineId: n.machineId, id: n.accountId });
    status.textContent = r.ok ? 'Cancelled.' : (r.data && r.data.error) || 'Could not cancel.';
    if (r.ok) setTimeout(() => { closeSheet(); refresh(); }, 800); else cancel.disabled = false;
  });
  const expires = d.ttlExpiresAt ? new Date(d.ttlExpiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : null;
  sheet({ title: n.title },
    el('div', { class: 'signin-steps' },
      el('p', { class: 'confirm-text', text: `1. Open the sign-in page${verifiedDisplayName(d.expectedEmail, n.accountId) ? ` and sign in as ${d.expectedEmail}` : ''}.` }),
      el('a', { class: 'btn-primary btn-inline signin-link', href: d.verificationUrl, target: '_blank', rel: 'noopener', text: 'Open the sign-in page' }),
      el('p', { class: 'confirm-text', text: '2. If the page gives you a code, paste it here.' }),
      code, submit,
      expires ? el('p', { class: 'action-status', text: `This sign-in link works until ${expires}.` }) : null,
      d.notice ? note(String(d.notice)) : null,
      status),
    el('div', { class: 'sheet-danger' }, cancel));
}

async function repairNeed(n, refresh) {
  const auth = await askPin({ title: n.title, explain: 'Automatic sign-in repair needs a recent PIN unlock. It is kept in this page only until it expires.', adapter: 'session' });
  if (!auth) return;
  const status = el('p', { class: 'action-status', role: 'status', text: 'Asking the repair to start…' });
  sheet({ title: n.title }, status);
  const r = await postJson('/subscription-relogin/repair-cell', { accountId: n.accountId, machineId: n.machineId, episodeId: n.episodeId, action: n.action }, { 'X-Instar-Operator-Session': auth.session });
  if (r.status === 401) { forgetOperatorSession(); status.textContent = 'The unlock expired. Tap the button again and enter your PIN.'; return; }
  status.textContent = r.ok ? `The repair is running on ${n.machine}. It usually takes a few minutes; this page updates on its own.` : (r.data && r.data.error) || `The server answered ${r.status}.`;
  if (r.ok) setTimeout(() => { closeSheet(); refresh(); }, 2000);
}

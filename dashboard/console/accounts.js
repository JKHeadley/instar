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
import { actionControl, consumeItem, landOn } from './actions.js';

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
  const [pool, relogin, inUse, machines, promises] = await Promise.all([get('/subscription-pool?scope=pool', 8000), get('/subscription-relogin?scope=pool', 8000), get('/subscription-pool/in-use'), get('/pool'), get('/commitments?scope=mesh', 8000)]);
  const ms = machines.ok && Array.isArray(machines.data && machines.data.machines) ? machines.data.machines : [];
  const names = Object.fromEntries(ms.map((m) => [m.machineId, m.nickname]));
  const selfId = machines.ok && machines.data ? machines.data.selfMachineId : null;
  const selfRow = ms.find((m) => m.isSelf || (selfId && m.machineId === selfId)) || null;
  const self = selfRow || selfId ? { machineId: (selfRow && selfRow.machineId) || selfId, nickname: selfRow ? selfRow.nickname : null } : null;
  const episodes = relogin.ok && Array.isArray(relogin.data && relogin.data.episodes) ? relogin.data.episodes : [];
  // Machines where automatic repair is off (their expired sign-ins are still the agent's chore), and
  // the promises of mine about a sign-in that wait on you (the same list Home counts).
  const unavailable = relogin.ok && relogin.data && relogin.data.pool && Array.isArray(relogin.data.pool.unavailable) ? relogin.data.pool.unavailable.map((u) => u.machineId) : [];
  const promiseList = promises.ok && Array.isArray(promises.data && promises.data.commitments) ? promises.data.commitments : null;
  const page = buildAccountsPage(pool, Date.now(), { episodes, inUse: inUse.ok ? inUse.data : null, names, self, unavailable, promises: promiseList });
  if (!page.ok) { setKids(main, pageHead({ eyebrow: 'Capacity · Accounts', headline: 'Accounts', tone: 'muted' }), cantTell(page.reason), legacyLink()); return; }
  const refresh = () => renderAccounts(main, ctx);

  // One row per account, naming the machines it waits on. One machine → its button; several → the account sheet lists them.
  const byId = new Map(page.accounts.map((a) => [a.id, a]));
  // A needs-you row's button is the same one tap Home shows (shared-counts action); an expired
  // row (the agent's chore) keeps its own Sign in / Try again.
  const tapOf = (g) => (g.single && g.single.tap ? actionControl(g.single.tap, { onDone: () => setTimeout(refresh, 2000) }) : null);
  const accountRows = (rows, dot) => el('div', { class: 'rows' }, rows.map((g) => el('div', { class: 'row', 'data-item': g.single && g.single.accountId ? `${g.single.accountId}:${g.single.machineId}` : null, 'data-account': g.accountId || null },
    el('span', { class: `dot ${dot}` }),
    el('span', { class: 'row-main' }, el('span', { class: 'row-title', text: g.label }), el('span', { class: 'row-sub', text: g.sub })),
    el('span', { class: 'row-end' }, tapOf(g) || (g.single && g.single.action === 'promise'
      ? el('a', { class: 'btn-quiet btn-small', href: '#/work/promises?s=waiting', text: 'Open' })
      : g.single
      ? el('button', { class: 'btn-quiet btn-small', type: 'button', text: g.single.action === 'start' ? 'Sign in' : g.single.action === 'retry' ? 'Try again' : 'Repair', onclick: () => startNeed(g.single, refresh) })
      : el('button', { class: 'btn-quiet btn-small', type: 'button', text: `${g.machines.length} machines ›`, onclick: () => { const a = byId.get(g.accountId); if (a) openAccount(a, refresh); } }))))));
  const needs = page.needsRows.length ? el('section', { class: 'page-sections', id: 'sec-needs' },
    el('h2', { class: 'eyebrow', text: 'Needs you' }),
    el('div', { class: 'need-card' }, el('span', { class: 'need-title', text: page.needsRows.length === 1 ? 'One sign-in is waiting for you' : `${page.needsRows.length} sign-ins are waiting for you` }), accountRows(page.needsRows, 'attn'))) : null;
  // Expired sign-ins nothing is repairing: listed behind a tap (the headline already says how many).
  const expiredCells = page.expired.length;
  let expired = null;
  if (page.expiredRows.length) {
    expired = el('section', { class: 'list-section', id: 'sec-expired' });
    const head = el('button', { class: 'list-head', type: 'button', 'aria-expanded': 'false' }, el('h2', { class: 'eyebrow', text: 'Expired sign-ins' }), el('span', { class: 'list-count', text: String(expiredCells) }), el('span', { class: 'chev', 'aria-hidden': 'true', text: '›' }));
    const body = el('div', { class: 'list-rows', hidden: true }, el('p', { class: 'card-note', text: 'These are mine to repair; nothing here needs your tap. You can still sign in yourself if you want an account back sooner.' }), accountRows(page.expiredRows, 'unknown'));
    head.addEventListener('click', () => { body.hidden = !body.hidden; head.setAttribute('aria-expanded', body.hidden ? 'false' : 'true'); });
    expired.append(head, body);
  }

  const groups = new Map();
  for (const a of page.accounts) { const k = frameworkName(a.framework); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(a); }
  const list = el('div', { class: 'page-sections acct-list' }, [...groups.entries()].map(([name, accts]) => el('section', { class: 'list-section' },
    el('div', { class: 'list-head' }, el('h2', { class: 'eyebrow', text: name }), el('span', { class: 'list-count', text: String(accts.length) })),
    el('div', { class: 'list-rows' }, accts.map((a) => {
      const pct = a.tight ? Math.round(a.tight.pct) : null;
      const bar = el('span', { class: `acct-bar${a.tone ? ' ' + a.tone : ''}` }, el('span'));
      if (pct !== null) bar.firstChild.style.width = `${Math.min(100, Math.max(2, pct))}%`;
      // The machines live in the sheet ("On each machine"); the row only says how many sign-ins lapsed.
      const lapsed = a.cells.filter((c) => c.state === 'attn' || c.state === 'expired').length;
      const row = el('button', { class: 'acct-row', type: 'button', 'data-focus-key': `a:${a.id}` },
        el('span', { class: 'acct-name' }, document.createTextNode(a.name), a.inUse ? el('span', { class: 'acct-tag', text: ' · in use here' }) : null),
        el('span', { class: `acct-pct${a.tone ? ' ' + a.tone : ''}`, text: pct === null ? '—' : `${pct}%` }),
        bar,
        el('span', { class: 'acct-line', text: [a.line, a.second, a.stale ? `reading from ${a.readingAge}` : null, lapsed ? `expired on ${lapsed} ${lapsed === 1 ? 'machine' : 'machines'}` : null].filter(Boolean).join(' · ') }));
      row.addEventListener('click', () => openAccount(a, refresh));
      return row;
    })))));

  setKids(main,
    pageHead({ eyebrow: 'Capacity · Accounts', headline: page.headline, sub: page.sub, tone: page.tone, facts: page.facts }),
    page.partial ? note(page.partial) : null,
    !relogin.ok ? note(`Couldn't read sign-in repairs: ${relogin.reason}.`) : null,
    needs, expired, list, legacyLink());
  const want = new URLSearchParams((location.hash.split('?')[1] || '')).get('s');
  if (want === 'needs' && needs) needs.scrollIntoView({ block: 'start' });
  // A needs-you tap lands on the exact sign-in: its row (one machine) or its account sheet (several).
  const item = consumeItem();
  if (item && !landOn(main, item)) {
    const acct = String(item).split(':')[0];
    const a = byId.get(acct);
    if (a) openAccount(a, refresh);
  }
  if (want === 'expired' && expired) { expired.querySelector('.list-head').click(); expired.scrollIntoView({ block: 'start' }); }
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
      el('span', { class: 'row-main' }, el('span', { class: 'row-title', text: c.machine }), el('span', { class: 'row-sub', text: c.label })),
      el('span', { class: 'row-end' }));
    if (c.state === 'attn' || c.state === 'expired') {
      const action = c.state === 'attn' ? (c.episode.state === 'failed' ? 'retry' : 'approve') : 'start';
      r.querySelector('.row-end').append(el('button', { class: 'btn-quiet', type: 'button', text: action === 'start' ? 'Sign in' : action === 'retry' ? 'Try again' : 'Repair', onclick: () => startNeed({ accountId: a.id, machineId: c.machineId, machine: c.machine, title: `Sign in ${a.email || a.name} on ${c.machine}`, action, episodeId: c.episode ? c.episode.id : null }, refresh) }));
    }
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
      el('p', { class: 'confirm-text', text: `1. Open the sign-in page${d.expectedEmail ? ` and sign in as ${d.expectedEmail}` : ''}.` }),
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

// Accounts page (docs/specs/console-features/capacity.md, "Accounts").
// Usage by account and a separate sign-in repair status by machine.
// Actions per the PIN adapters (00-patterns.md §4):
//   start a cell's sign-in    POST /subscription-pool/matrix/start-cell   body PIN, once
//   submit the sign-in code   POST /subscription-pool/follow-me/submit-code  bearer
//   follow it to the end      GET  /subscription-pool/follow-me/completion   bearer
//   cancel a sign-in          POST /subscription-pool/follow-me/cancel     bearer
//   repair / retry / cancel   POST /subscription-relogin/repair-cell       operator session

import { quotaForecastCard } from './quota-forecast.js';
import { ACCOUNT_GROUPS, ACCOUNT_SORTS, accountLayoutPreferences, buildAccountsPage, frameworkName, layoutAccounts, resetWords } from './accounts-model.js';
import { el, setKids, pageHead, askLink, sheet, closeSheet, story, details, note, cantTell, askPin, forgetOperatorSession, firstPaint, arrivalScroll, markNeed } from './ui.js';
import { legacyHref } from './nav-model.js';
import { verifiedDisplayName } from './display-identity.js';
import { buildAutoRepair, configurePayload, resultWords, resultLines, confirmation } from './auto-repair-model.js';
import { submitView, completionView, workingView, COMPLETION_POLL_MS, COMPLETION_GIVE_UP_MS, GIVE_UP_VIEW } from './signin-progress-model.js';

// Tick state survives the page's 30-second re-render (spec one-tap-unattended-repair §6).
const autoRepairTicks = new Map(); // machineId → boolean, only where the operator changed the default
let autoRepairResults = null;      // { at, mode, results: [{ machineId, ... }] } from the last tap
const latestRender = new WeakMap();
const repairDisclosureState = new WeakMap();

const ACCOUNT_LAYOUT_KEY = 'instar.accounts.layout';
let accountLayout = accountLayoutPreferences();

function readAccountLayout() {
  try {
    const saved = localStorage.getItem(ACCOUNT_LAYOUT_KEY);
    if (saved !== null) accountLayout = accountLayoutPreferences(JSON.parse(saved));
  } catch { /* Storage is optional; controls work for the current browser visit. */ }
  return accountLayout;
}

function layoutSelect(label, options, selected, onChange) {
  const select = el('select', { class: 'reason-select', 'data-focus-key': `accounts:${label}` },
    options.map(([value, text]) => el('option', { value, text })));
  select.value = selected;
  select.addEventListener('change', () => onChange(select.value));
  return el('label', { class: 'acct-layout-field' }, el('span', { text: label }), select);
}

async function postJson(path, body, headers = {}) {
  const token = (() => { try { return localStorage.getItem('instar_token') || ''; } catch { return ''; } })();
  try {
    const r = await fetch(path, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body || {}) });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  } catch { return { ok: false, status: 0, data: { error: 'The server could not be reached.' } }; }
}

async function getJson(path) {
  const token = (() => { try { return localStorage.getItem('instar_token') || ''; } catch { return ''; } })();
  try {
    const r = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  } catch { return { ok: false, status: 0, data: {} }; }
}

export async function renderAccounts(main, ctx) {
  const query = new URLSearchParams(location.hash.split('?')[1] || '');
  const want = query.get('s');
  const repairView = query.get('view') === 'sign-in' || want === 'needs' || want === 'auto-repair';
  const { get } = ctx;
  const isCurrent = () => main.isConnected && (ctx.isCurrent?.() ?? true);
  if (!isCurrent()) return;
  const visit = {
    isCurrent,
    refresh: () => renderAccounts(main, ctx),
    later(callback, ms) {
      const timer = setTimeout(() => { if (isCurrent()) callback(); }, ms);
      ctx.onDispose?.(() => clearTimeout(timer));
    },
  };
  // The console keeps these rows visible during its same-page refresh. A new click uses the
  // current visit, while an action that already opened a dialog keeps its original visit.
  const currentVisit = () => latestRender.get(main);
  latestRender.set(main, visit);
  main.classList.add('accounts-page');
  firstPaint(main, el('section', { class: 'hero page-hero' }, el('div', { class: 'eyebrow', text: 'Capacity · Accounts' }), el('h1', { class: 'page-title skeleton', text: repairView ? 'Loading sign-in repair' : 'Loading accounts' })));
  const [pool, relogin, inUse, machines] = await Promise.all([get('/subscription-pool?scope=pool', 8000), get('/subscription-relogin?scope=pool&retryTimeout=1', 16000), get('/subscription-pool/in-use'), get('/pool')]);
  if (!isCurrent() || currentVisit() !== visit) return;
  const names = machines.ok && Array.isArray(machines.data && machines.data.machines) ? Object.fromEntries(machines.data.machines.map((m) => [m.machineId, m.nickname])) : {};
  const episodes = relogin.ok && Array.isArray(relogin.data && relogin.data.episodes) ? relogin.data.episodes : [];
  const blockers = relogin.ok && Array.isArray(relogin.data && relogin.data.blockers) ? relogin.data.blockers : [];
  const autoRepair = buildAutoRepair(relogin, { names, blockers, poolMachines: machines });
  const page = buildAccountsPage(pool, Date.now(), { episodes, blockers, inUse: inUse.ok ? inUse.data : null, names, poolMachines: machines });
  const switchView = el('nav', { class: 'conversation-tabs', 'aria-label': 'Accounts views' },
    el('a', { class: repairView ? 'chip' : 'chip active', href: '#/capacity/accounts',
      'aria-current': repairView ? null : 'page', text: 'Account usage' }),
    el('a', { class: repairView ? 'chip active' : 'chip', href: '#/capacity/accounts?view=sign-in',
      'aria-current': repairView ? 'page' : null, text: 'Sign-in repair' }));
  if (!page.ok) {
    setKids(main, pageHead({ eyebrow: 'Capacity · Accounts', headline: repairView ? 'Sign-in repair' : 'Accounts', tone: 'muted' }),
      switchView, cantTell(page.reason), repairView ? autoRepairSection(autoRepair, currentVisit) : null, legacyLink());
    return;
  }
  if (repairView) {
    const repairs = repairStatusSection(page, main, currentVisit);
    const settings = autoRepairSection(autoRepair, currentVisit);
    if (page.needs.length) markNeed(repairs, 'accounts');
    setKids(main, pageHead({ eyebrow: 'Capacity · Accounts', headline: 'Sign-in repair' }), switchView,
      page.partial ? note(page.partial) : null,
      !relogin.ok ? note(`Couldn't read sign-in repairs: ${relogin.reason}.`) : null,
      repairs, settings, legacyLink());
    if (want === 'needs') arrivalScroll(repairs);
    if (want === 'auto-repair') arrivalScroll(settings);
    return;
  }

  const rows = el('div', { class: 'acct-groups' });
  let preferences = readAccountLayout();
  const repaint = () => rows.replaceChildren(...layoutAccounts(page.accounts, preferences).map(group =>
    el('section', { class: 'list-section', 'aria-label': group.name || 'All accounts' },
      group.name ? el('div', { class: 'list-head' }, el('h3', { class: 'eyebrow', text: group.name }),
        el('span', { class: 'list-count', text: String(group.accounts.length) })) : null,
      el('div', { class: 'list-rows' }, group.accounts.map(a => renderAccountRow(a, preferences.group === 'machine' ? group.key : null))))));
  const changeLayout = (field, value) => {
    preferences = accountLayout = accountLayoutPreferences({ ...preferences, [field]: value });
    try { localStorage.setItem(ACCOUNT_LAYOUT_KEY, JSON.stringify(preferences)); } catch { /* Keep the in-memory choice. */ }
    repaint();
  };
  const list = page.accounts.length ? el('section', { class: 'page-sections acct-list', 'aria-label': 'Account usage readings' },
    el('div', { class: 'acct-layout' },
      layoutSelect('Group by', ACCOUNT_GROUPS, preferences.group, value => changeLayout('group', value)),
      layoutSelect('Sort by', ACCOUNT_SORTS, preferences.sort, value => changeLayout('sort', value))),
    rows) : null;
  if (list) repaint();

  function renderAccountRow(a, machineGroup) {
    const pct = a.tight ? Math.round(a.tight.pct) : null;
    // One labelled line per limit that applies (5-hour only when the account has one), each with
    // its own bar and its own reset, so a full 5-hour window never reads as the weekly one.
    const wins = a.windows && a.windows.length ? el('span', { class: 'acct-wins' }, a.windows.map((w) => {
      const bar = el('span', { class: `acct-bar${w.tone ? ' ' + w.tone : ''}` }, el('span'));
      bar.firstChild.style.width = w.rolledOver ? '0%' : `${Math.min(100, Math.max(2, Math.round(w.pct)))}%`;
      return el('span', { class: `acct-win${w.rolledOver ? ' rolled' : ''}`, 'data-window': w.key },
        el('span', { class: 'acct-win-label', text: w.name }),
        bar,
        el('span', { class: `acct-win-pct${w.tone ? ' ' + w.tone : ''}`, text: w.pctText }),
        el('span', { class: 'acct-win-reset', text: w.reset || '' }));
    })) : null;
    const repairs = a.cells.filter(c => (!machineGroup || c.machineId === machineGroup) &&
      ['attn', 'working', 'waiting'].includes(c.state));
    const repairNote = repairs.length === 1 ? `${repairs[0].machine}: ${repairs[0].label}`
      : repairs.length > 1 ? `Sign-in needs checking on ${repairs.length} machines` : null;
    const row = el('button', { class: 'acct-row', type: 'button', 'data-focus-key': machineGroup ? `a:${encodeURIComponent(machineGroup)}:${a.id}` : `a:${a.id}` },
      el('span', { class: 'acct-name' }, document.createTextNode(a.name), el('span', { class: 'acct-kind', text: frameworkName(a.framework) }), a.inUse && !machineGroup ? el('span', { class: 'acct-tag', text: 'in use here' }) : null),
      el('span', { class: `acct-pct${a.tone ? ' ' + a.tone : ''}`, text: pct === null ? '—' : `${pct}%` }),
      wins ?? el('span', { class: 'acct-bar', 'aria-hidden': 'true' }),
      !wins ? el('span', { class: 'acct-line', text: a.line }) : null,
      !wins && a.lastCheckAge ? el('span', { class: 'acct-line', text: `Last checked ${a.lastCheckAge}` }) : null,
      a.stale ? el('span', { class: 'acct-line', text: `Some usage data is from ${a.readingAge}` }) : null,
      repairNote ? el('span', { class: 'acct-line', text: repairNote }) : null);
    row.addEventListener('click', () => openAccount(a, currentVisit(), page.needs));
    return row;
  }

  // The notice spot: nothing unless something needs the person; each notice carries its action.
  const notices = page.notices.length ? el('section', { class: 'page-sections', id: 'sec-notices' },
    page.notices.map((n) => el('div', { class: 'need-card', 'data-tone': n.tone },
      el('span', { class: 'need-title', text: n.title }),
      n.returnsAt && resetWords(n.returnsAt) ? el('span', { class: 'row-sub', text: `Room returns: ${resetWords(n.returnsAt).replace(/^resets /, '')}` }) : null,
      el('p', { class: 'hero-ask' }, askLink(n.action.about))))) : null;

  setKids(main,
    pageHead({ eyebrow: 'Capacity · Accounts', headline: page.headline, sub: page.sub, tone: page.tone, facts: page.facts }),
    switchView, page.partial ? note(page.partial) : null, notices, list, quotaForecastCard(get, page.accounts), legacyLink());
}

function repairStatusSection(page, main, currentVisit) {
  const expandedRepairs = repairDisclosureState.get(main) || new Set();
  repairDisclosureState.set(main, expandedRepairs);
  const machineRepairs = page.repairs.map(group => {
    const ownerCount = group.rows.filter(row => row.ownerAction).length;
    const agentCount = group.rows.length - ownerCount;
    const status = [
      `${group.signedIn} of ${group.total} signed in`,
      agentCount ? `${agentCount} for the agent to check or repair` : '',
      ownerCount ? `${ownerCount} ${ownerCount === 1 ? 'needs' : 'need'} your action` : '',
    ].filter(Boolean).join(', ');
    const disclosure = el('details', { class: 'acct-repair-machine', open: ownerCount > 0 || expandedRepairs.has(group.key) },
      el('summary', { class: 'acct-repair-summary' }, el('strong', { text: group.machine }), el('span', { text: status })),
      el('ul', { class: 'acct-repair-rows' }, group.rows.map(row => el('li', { class: 'acct-repair-row' },
        el('div', {}, el('span', { class: 'row-title', text: row.label }), el('span', { class: 'row-sub', text: row.status })),
        row.ownerAction ? el('button', { class: 'btn-quiet', type: 'button', text: row.ownerAction.buttonLabel, onclick: () => startNeed(row.ownerAction, currentVisit()) }) : null))));
    disclosure.addEventListener('toggle', () => {
      if (disclosure.open) expandedRepairs.add(group.key);
      else expandedRepairs.delete(group.key);
    });
    return disclosure;
  });
  const readyCount = page.signedInMachines.length;
  const allSignedIn = readyCount ? el('details', { class: 'acct-repair-machine acct-repair-ready' },
    el('summary', { class: 'acct-repair-summary' }, el('strong', { text: 'All signed in' }),
      el('span', { text: `On ${readyCount} ${readyCount === 1 ? 'machine' : 'machines'}` })),
    el('ul', { class: 'acct-repair-rows' }, page.signedInMachines.map(machine => el('li', { class: 'acct-repair-row', text: machine })))) : null;
  return machineRepairs.length || allSignedIn
    ? el('section', { class: 'page-sections acct-repairs', id: 'sec-needs', 'aria-labelledby': 'account-repair-title' },
      el('h2', { class: 'section-heading', id: 'account-repair-title', text: 'Sign-ins by machine' }),
      machineRepairs.length ? el('p', { class: 'row-sub', text: 'Open a machine to see its accounts and any sign-in steps that need you.' }) : null,
      machineRepairs, allSignedIn) : null;

}

function legacyLink() {
  return el('p', { class: 'foot-note' }, el('a', { href: legacyHref('subscriptions'), text: 'Letting another machine use an account, and identity repair, are in the legacy Subscriptions tab' }));
}

function openAccount(a, visit, ownerNeeds) {
  if (!visit.isCurrent()) return;
  const hosts = [...new Set(a.cells.filter(c => !c.missing).map(c => c.machine))];
  const lines = [
    { label: 'Kind', text: frameworkName(a.framework) },
    hosts.length ? { label: hosts.length === 1 ? 'Machine' : 'Machines', text: hosts.join(', ') } : null,
    a.email ? { label: 'Email', text: a.email } : null,
    { label: 'Usage', text: a.windowsText && a.windowsText.length ? a.windowsText.join('; ') : a.line },
    { label: 'Reading', text: a.readingAge ? `from ${a.readingAge}` : 'none yet' },
  ].filter(Boolean);
  // This is deliberate account management. The page's repair area owns the status copy.
  const machineActions = a.cells.flatMap((c) => {
    if (!c.actionable) return [];
    const ownerAction = ownerNeeds.find(n => n.accountId === a.id && n.machineId === c.machineId);
    let label, action;
    if (ownerAction) { label = ownerAction.buttonLabel; action = ownerAction.action; }
    else if (c.state === 'missing') { label = 'Set up'; action = 'start'; }
    else if (c.state === 'attn' && !c.wrongLogin && ['failed', 'suggested'].includes(c.episode?.state)) {
      action = c.episode.state === 'failed' ? 'retry' : 'approve';
      label = action === 'retry' ? 'Try again' : 'Repair';
    } else return [];
    const request = ownerAction || {
      accountId: a.id, machineId: c.machineId, machine: c.machine,
      title: `${label} ${a.email || a.name} on ${c.machine}`, action, episodeId: c.episode?.id ?? null,
    };
    return [el('div', { class: 'row' },
      el('span', { class: 'row-main' }, el('span', { class: 'row-title', text: c.machine })),
      el('button', { class: 'btn-quiet', type: 'button', text: label, onclick: () => startNeed(request, visit) }))];
  });
  sheet({ title: a.name }, story(lines), machineActions.length ? el('section', { class: 'sheet-block' },
    el('h3', { class: 'eyebrow', text: 'Manage sign-in' }), el('div', { class: 'rows' }, machineActions)) : null,
    details(a.cells[0] ? a.cells[0].row : {}, ['id', 'nickname', 'email', 'provider', 'framework', 'status', 'loginCheck', 'enrolledAt', 'lastRefreshAt', 'identityDrifted']));
}

/** One sign-in, start to finish, in sheets. */
async function startNeed(n, visit) {
  if (n.action !== 'start') return repairNeed(n, visit);
  const pin = await askPin({ title: n.title, explain: `This starts a fresh sign-in for this account on ${n.machine}. Your PIN is used for this one request and not kept.`, adapter: 'body', isCurrent: visit.isCurrent });
  if (!pin) return;
  const status = el('p', { class: 'action-status', role: 'status', text: 'Starting the sign-in…' });
  const panel = visit.isCurrent() ? sheet({ title: n.title }, status) : null;
  const r = await postJson('/subscription-pool/matrix/start-cell', { accountId: n.accountId, machineId: n.machineId, pin: pin.pin });
  pin.pin = '';
  if (!visit.isCurrent() || !panel?.isConnected) return;
  if (!r.ok || !r.data || !r.data.verificationUrl) {
    status.textContent = r.status === 403 ? 'That PIN was not accepted.' : (r.data && (r.data.error || r.data.message)) || `The server answered ${r.status}.`;
    return;
  }
  signInSteps(n, r.data, visit);
}

function signInSteps(n, d, visit, firstError) {
  const loginId = d.loginId || d.id || n.accountId;
  const code = el('input', { class: 'reason-input', inputmode: 'text', autocomplete: 'one-time-code', placeholder: 'Code from the sign-in page, if it shows one', 'aria-label': 'Sign-in code' });
  const status = el('p', { class: 'action-status', role: 'status', text: firstError || '' });
  const submit = el('button', { class: 'btn-primary btn-inline', type: 'button', text: 'Send the code' });
  const cancel = el('button', { class: 'btn-quiet', type: 'button', text: 'Cancel this sign-in' });
  const expires = d.ttlExpiresAt ? new Date(d.ttlExpiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : null;
  const steps = el('div', { class: 'signin-steps' },
    el('p', { class: 'confirm-text', text: `1. Open the sign-in page${verifiedDisplayName(d.expectedEmail, n.accountId) ? ` and sign in as ${d.expectedEmail}` : ''}.` }),
    el('a', { class: 'btn-primary btn-inline signin-link', href: d.verificationUrl, target: '_blank', rel: 'noopener', text: 'Open the sign-in page' }),
    el('p', { class: 'confirm-text', text: '2. If the page gives you a code, paste it here.' }),
    code, submit,
    expires ? el('p', { class: 'action-status', text: `This sign-in link works until ${expires}.` }) : null,
    d.notice ? note(String(d.notice)) : null,
    status);
  const danger = el('div', { class: 'sheet-danger' }, cancel);
  const panel = sheet({ title: n.title }, steps, danger);
  const stillOpen = () => visit.isCurrent() && panel.isConnected;

  // Once the code is sent the form goes away: a spinner while it works, then one clear result.
  const show = (view) => {
    danger.remove();
    const title = el('p', { class: 'signin-progress-title', text: view.title });
    if (view.kind === 'working') {
      steps.className = 'signin-progress';
      steps.setAttribute('aria-busy', 'true');
      setKids(steps, el('span', { class: 'signin-spinner', 'aria-hidden': 'true' }), title, el('p', { class: 'row-sub', text: view.sub }));
      return;
    }
    steps.className = `signin-progress ${view.kind}`;
    steps.removeAttribute('aria-busy');
    if (view.kind === 'done') {
      const done = el('button', { class: 'btn-primary btn-inline', type: 'button', text: 'Done', onclick: () => {
        if (stillOpen()) { closeSheet(); visit.refresh(); }
      } });
      setKids(steps, el('span', { class: 'signin-mark', 'aria-hidden': 'true', text: '✓' }), title, done);
      visit.later(visit.refresh, 0);
      return;
    }
    const again = el('button', { class: 'btn-primary btn-inline', type: 'button', text: 'Start the sign-in again', onclick: () => {
      if (stillOpen()) { closeSheet(); startNeed({ ...n, action: 'start' }, visit); }
    } });
    setKids(steps, el('span', { class: 'signin-mark', 'aria-hidden': 'true', text: '!' }), title, view.sub ? el('p', { class: 'row-sub', text: view.sub }) : null, again);
    visit.later(visit.refresh, 0);
  };
  const followCompletion = async () => {
    const giveUpAt = Date.now() + COMPLETION_GIVE_UP_MS;
    const q = `machineId=${encodeURIComponent(n.machineId || '')}&id=${encodeURIComponent(loginId)}`;
    while (stillOpen()) {
      await new Promise((r) => setTimeout(r, COMPLETION_POLL_MS));
      if (!stillOpen()) return;
      const view = completionView(await getJson(`/subscription-pool/follow-me/completion?${q}`), n.machine);
      if (!stillOpen()) return;
      if (view) { show(view); return; }
      if (Date.now() > giveUpAt) { show(GIVE_UP_VIEW); return; }
    }
  };

  submit.addEventListener('click', async () => {
    if (!stillOpen()) return;
    const value = code.value.trim();
    if (!value) { status.textContent = 'Paste the code first.'; return; }
    code.value = '';
    show(workingView(n.machine, 'sending'));
    const view = submitView(await postJson('/subscription-pool/follow-me/submit-code', { machineId: n.machineId, id: loginId, code: value }), n.machine);
    if (!stillOpen()) return;
    if (view.kind === 'form') {
      // The code did not go through: the same form returns, with what to do next.
      const fresh = view.freshLogin;
      signInSteps(n, fresh ? { ...d, ...fresh, loginId: fresh.id || loginId } : d, visit, view.error);
      return;
    }
    show(view);
    if (view.kind === 'working') followCompletion();
  });
  cancel.addEventListener('click', async () => {
    if (!stillOpen()) return;
    cancel.disabled = true;
    const r = await postJson('/subscription-pool/follow-me/cancel', { machineId: n.machineId, id: n.accountId });
    if (!stillOpen()) return;
    status.textContent = r.ok ? 'Cancelled.' : (r.data && r.data.error) || 'Could not cancel.';
    if (r.ok) closeAndRefresh(visit, panel, 800); else cancel.disabled = false;
  });
}

function closeAndRefresh(visit, panel, delay) {
  visit.later(() => {
    if (panel.isConnected) closeSheet();
    visit.refresh();
  }, delay);
}

async function repairNeed(n, visit) {
  const auth = await askPin({ title: n.title, explain: 'Automatic sign-in repair needs a recent PIN unlock. It is kept in this page only until it expires.', adapter: 'session', isCurrent: visit.isCurrent });
  if (!auth) return;
  const status = el('p', { class: 'action-status', role: 'status', text: 'Asking the repair to start…' });
  const panel = visit.isCurrent() ? sheet({ title: n.title }, status) : null;
  const r = await postJson('/subscription-relogin/repair-cell', { accountId: n.accountId, machineId: n.machineId, episodeId: n.episodeId, action: n.action }, { 'X-Instar-Operator-Session': auth.session });
  if (!visit.isCurrent() || !panel?.isConnected) return;
  if (r.status === 401) { forgetOperatorSession(); status.textContent = 'The unlock expired. Tap the button again and enter your PIN.'; return; }
  status.textContent = r.ok ? `The repair is running on ${n.machine}. It usually takes a few minutes; this page updates on its own.` : (r.data && r.data.error) || `The server answered ${r.status}.`;
  if (r.ok) closeAndRefresh(visit, panel, 2000);
}

// ── Automatic sign-in repair (docs/specs/one-tap-unattended-repair.md §6) ──────────────────
function autoRepairTicked(row) {
  if (!row.canTurnOn && !row.canSwitchBack) return false;
  return autoRepairTicks.has(row.machineId) ? autoRepairTicks.get(row.machineId) : row.defaultTick;
}

function autoRepairSection(model, currentVisit) {
  if (model.rows.length === 0 && !model.unresolved) return null;
  const section = el('section', { class: 'page-sections', id: 'sec-auto-repair' },
    el('h2', { class: 'eyebrow', text: 'Sign-in repair settings' }),
    el('p', { class: 'row-sub', text: 'When an account gets signed out, the agent signs it back in by itself on the machines ticked here. You can switch any of this agent’s machines on or back to asking first from this page, whichever machine is showing it.' }));
  const held = () => { const changed = [...autoRepairTicks.keys()].length > 0; if (changed) section.setAttribute('data-interaction-open', '1'); else section.removeAttribute('data-interaction-open'); };
  const lastResult = (id) => autoRepairResults && autoRepairResults.results.find((r) => r.machineId === id);
  const retry = (label) => el('button', { class: 'btn-quiet', type: 'button', text: 'Retry', 'aria-label': label,
    onclick: async event => {
      const button = event.currentTarget;
      for (const control of section.querySelectorAll('button[data-repair-retry]')) control.disabled = true;
      button.textContent = 'Checking…';
      try { await currentVisit()?.refresh(); }
      finally {
        for (const control of section.querySelectorAll('button[data-repair-retry]')) control.disabled = false;
        button.textContent = 'Retry';
      }
    }, 'data-repair-retry': '1' });
  const rows = el('div', { class: 'rows' }, model.rows.map((row) => {
    if (row.unreadable) return el('div', { class: 'row' }, el('span', { class: 'dot unknown' }),
      el('span', { class: 'row-main' }, el('span', { class: 'row-title', text: row.name }), el('span', { class: 'row-sub', text: row.unreadable })),
      row.retryable ? retry(`Retry checking ${row.name}`) : null);
    // A row this page cannot change shows no tick box at all: a greyed-out box looks offered here
    // (operator 2026-11-09). Its reason line says why and where it can be changed.
    const box = row.canTurnOn || row.canSwitchBack ? el('input', { type: 'checkbox', 'aria-label': `Include ${row.name}` }) : null;
    if (box) {
      box.checked = autoRepairTicked(row);
      box.addEventListener('change', () => {
        if (box.checked === row.defaultTick) autoRepairTicks.delete(row.machineId); else autoRepairTicks.set(row.machineId, box.checked);
        held();
      });
    }
    const lines = [];
    if (row.finalList) lines.push(`Accounts: ${row.finalList.join(', ')}`);
    if (row.removals.length) lines.push(`Stops: ${row.removals.join(', ')}`);
    if (row.uncovered.length && row.mode === 'unattended') lines.push(`${row.uncovered.length} account${row.uncovered.length === 1 ? '' : 's'} on this machine ${row.uncovered.length === 1 ? 'isn’t' : 'aren’t'} covered yet`);
    if (row.stillAsk.length) lines.push(`${row.stillAsk.length} of ${row.stillAskTotal} will still ask: ${[...new Set(row.stillAsk)].join('; ')}`);
    if (row.waitsLine) lines.push(row.waitsLine);
    if (row.mode !== 'unattended' && row.canTurnOn) lines.push((row.mode === 'off' || row.mode === 'observe' ? 'Turning this on switches repair on here (it is ' + (row.mode === 'off' ? 'off' : 'only watching') + ' now). ' : '') + 'Repairs run without asking, including accounts never repaired on this machine.' + (row.minimums[0] || row.minimums[1] ? ` It also removes the wait of ${row.minimums[0]} repairs / ${row.minimums[1]} days.` : ''));
    if (row.blockedWhy) lines.push(row.blockedWhy);
    const prior = lastResult(row.machineId);
    if (prior) {
      const c = confirmation(row, prior);
      lines.push(prior.ok ? (c === 'confirmed' ? 'Confirmed.' : c === 'superseded' ? 'Changed again since.' : resultWords(prior)) : resultWords(prior));
    }
    const end = el('span', { class: 'row-end' });
    if (row.activationPending) end.append(el('button', { class: 'btn-quiet btn-small', type: 'button', text: 'Finish restarting',
      onclick: () => autoRepairTap('finish-restart', [row], currentVisit()) }));
    return el('div', { class: 'row' },
      box ? el('label', { class: 'row-check' }, box) : el('span', { class: 'row-check', 'aria-hidden': 'true' }),
      el('span', { class: 'row-main' },
        el('span', { class: 'row-title', text: `${row.name}${row.self ? ' (this machine)' : ''}: ${row.stateWords}${row.activationPending ? ' — restarting' : ''}` }),
        ...lines.map((t) => el('span', { class: 'row-sub', text: t }))),
      end);
  }));
  const turnOn = el('button', { class: 'btn-primary btn-inline', type: 'button', text: 'Turn on for ticked machines' });
  const back = el('button', { class: 'btn-quiet', type: 'button', text: 'Switch ticked machines back to asking first' });
  const ticked = () => model.rows.filter((r) => !r.unreadable && autoRepairTicked(r));
  const sync = () => { const t = ticked(); turnOn.disabled = model.unresolved || !t.some((r) => r.canTurnOn); back.disabled = t.length === 0 || !t.every((r) => r.canSwitchBack); };
  section.addEventListener('change', sync);
  turnOn.addEventListener('click', () => {
    if (!model.unresolved) void autoRepairTap('unattended', model.rows, currentVisit(), () => section.isConnected);
  });
  back.addEventListener('click', () => autoRepairTap('approval', model.rows, currentVisit()));
  sync(); held();
  section.append(rows);
  if (model.unresolved) section.append(el('div', { class: 'row' },
    el('p', { class: 'row-sub', role: 'status', text: 'Check every machine before turning on.' }),
    model.rows.some(row => row.retryable) ? null : retry('Retry checking machines')));
  section.append(el('div', { class: 'sheet-actions' }, turnOn, back));
  return section;
}

async function autoRepairTap(mode, rows, visit, current = () => true) {
  const finish = mode === 'finish-restart';
  const tickedIds = new Set(finish ? rows.map((r) => r.machineId) : rows.filter((r) => !r.unreadable && autoRepairTicked(r)).map((r) => r.machineId));
  const body = finish
    ? { action: 'finish-restart', targets: rows.filter((r) => r.revision).map((r) => ({ machineId: r.machineId, expectedRevision: r.revision })) }
    : configurePayload(rows, tickedIds, mode);
  if (body.targets.length === 0) return;
  const title = finish ? 'Finish restarting' : mode === 'unattended' ? 'Turn on automatic sign-in repair' : 'Switch back to asking first';
  const auth = await askPin({ title, explain: 'This needs a recent PIN unlock. It is kept in this page only until it expires.', adapter: 'session', isCurrent: visit.isCurrent });
  if (!auth || !current()) return;
  const status = el('p', { class: 'action-status', role: 'status', text: 'Working…' });
  const panel = visit.isCurrent() ? sheet({ title }, status) : null;
  const r = await postJson('/subscription-relogin/configure-pool', body, { 'X-Instar-Operator-Session': auth.session });
  if (!visit.isCurrent() || !panel?.isConnected) return;
  if (r.status === 401) { forgetOperatorSession(); status.textContent = 'The unlock expired. Tap the button again and enter your PIN.'; return; }
  if (!r.ok || !r.data || !Array.isArray(r.data.results)) { status.textContent = (r.data && r.data.error) || `The server answered ${r.status}.`; return; }
  autoRepairResults = { at: Date.now(), mode, results: r.data.results };
  autoRepairTicks.clear();
  const lines = resultLines(r.data.results, rows);
  status.textContent = lines.every((x) => x.ok) ? 'Done.' : lines.some((x) => x.ok) ? 'Done on some machines.' : 'Not done.';
  status.after(el('ul', { class: 'result-list' }, lines.map((x) => el('li', { class: x.ok ? 'result-ok' : 'result-fail' },
    el('span', { class: 'result-mark', 'aria-hidden': 'true', text: x.ok ? '✓' : '✗' }),
    el('span', { class: 'result-words' }, el('strong', { text: `${x.name}:` }), ` ${x.words}`)))));
  // Re-read after about 30 s (a restart takes ~15 s and the supervisor polls every 10 s), then once more.
  closeAndRefresh(visit, panel, 30_000);
  visit.later(visit.refresh, 60_000);
}

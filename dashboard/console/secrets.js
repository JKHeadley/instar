// Passwords & keys (docs/specs/console-features/people-settings.md, "Passwords & keys",
// legacy tab id `secrets`). The requests the agent is waiting on as cards with a live
// countdown, "Ask someone for one", the key NAMES the agent already holds (never a value,
// never a length), and expired requests collapsed. Every write here is adapter (a): the
// bearer token is enough, so no PIN is asked. Every value goes through textContent.

import {
  buildRequests, buildKeys, buildSync, vaultBroken, VAULT_BROKEN_WORDS, secretsHeadline, secretsFacts,
  topicNameMap, conversationChoices, requestCard, requestBody, testRequestBody, resultWords, shareWords,
  leftWords, TTL_CHOICES,
} from './secrets-model.js';
import { el, setKids, pageHead, section, sheet, closeSheet, story, details, note, cantTell, fold } from './ui.js';
import { legacyHref } from './nav-model.js';
import { promisesAbout } from './shared-counts.js';

const RECORD_KEYS = ['token', 'topicId', 'createdAt', 'expiresAt'];

function bearer() { try { return localStorage.getItem('instar_token') || ''; } catch { return ''; } }

/** A write that keeps the status and the server's body. */
async function send(method, path, body) {
  try {
    const r = await fetch(path, { method, headers: { Authorization: `Bearer ${bearer()}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  } catch { return { ok: false, status: 0, data: {} }; }
}

// One ticker for the live "11 min left" lines; it stops itself when the page is gone.
let ticker = null;
function startTicker() {
  if (ticker) clearInterval(ticker);
  ticker = setInterval(() => {
    const nodes = document.querySelectorAll('[data-expires]');
    if (!nodes.length) { clearInterval(ticker); ticker = null; return; }
    const now = Date.now();
    for (const n of nodes) {
      const left = Number(n.getAttribute('data-expires')) - now;
      n.textContent = leftWords(left);
      if (left <= 5 * 60_000) n.classList.add('soon');
    }
  }, 1000);
}

/** Share a link: Web Share API, else the clipboard (visibly), else leave it to copy by hand. */
async function share(url, title, status) {
  let outcome = 'failed';
  if (navigator.share) {
    try { await navigator.share({ title, url }); outcome = 'shared'; } catch (e) { outcome = e && e.name === 'AbortError' ? 'cancelled' : 'failed'; }
  }
  if (outcome === 'failed' && navigator.clipboard && navigator.clipboard.writeText) {
    try { await navigator.clipboard.writeText(url); outcome = 'copied'; } catch { outcome = 'failed'; }
  }
  status.textContent = shareWords(outcome);
}

export async function renderSecrets(main, ctx) {
  const { get } = ctx;
  if (!main.querySelector('.secrets-page')) setKids(main, el('section', { class: 'hero page-hero' }, el('div', { class: 'eyebrow', text: 'People · Passwords & keys' }), el('h1', { class: 'page-title skeleton', text: 'Loading' })));
  const [pendingRes, ctxRes, syncRes, topicsRes, poolRes, promisesRes] = await Promise.all([
    get('/secrets/pending'), get('/self-knowledge/session-context?full=1'), get('/secrets/sync-status'), get('/telegram/topics'), get('/pool'),
    get('/commitments?scope=mesh', 8000),   // a promise about a password that waits on the operator shows here too
  ]);
  const now = Date.now();
  const promised = promisesRes.ok && Array.isArray(promisesRes.data && promisesRes.data.commitments) ? promisesAbout(promisesRes.data.commitments, 'password', now) : [];
  const names = topicNameMap(topicsRes);
  const origin = location.origin;
  const requests = buildRequests(pendingRes, { names, now, origin });
  const keys = buildKeys(ctxRes, syncRes);
  const sync = buildSync(syncRes, poolRes);
  const multi = poolRes.ok && poolRes.data && Array.isArray(poolRes.data.machines) && poolRes.data.machines.length > 1;
  const refresh = () => renderSecrets(main, ctx);
  const deps = { refresh, names, origin };
  const h = secretsHeadline({ requests, keys, sync, promised });

  const parts = [pageHead({ eyebrow: 'People · Passwords & keys', headline: h.text, tone: h.tone, facts: secretsFacts({ requests, keys, sync, promised }) })];
  // A vault that can't be opened leads the page: hands off, tell the agent (never repair or rotate).
  if (vaultBroken(keys, sync)) parts.push(el('section', { class: 'incident', role: 'alert' }, el('span', { class: 'incident-title', text: 'Saved keys can’t be opened' }), el('p', { class: 'incident-text', text: VAULT_BROKEN_WORDS })));
  const sections = [];
  sections.push(waitingBlock(requests, deps, multi));
  if (promised.length) sections.push(section({ id: 'promised', title: 'Promised, waiting on you', tone: 'attn', rows: promised.map((p) => ({ key: p.key, main: p.main, sub: p.sub, end: p.end, tone: 'attn' })), onRow: () => { location.hash = '#/work/promises?s=waiting'; } }));
  sections.push(el('div', { class: 'page-primary' }, el('button', { class: 'btn-primary btn-inline', type: 'button', text: '+ Ask someone for one', 'data-ask': '1', onclick: () => askSheet(deps) })));
  sections.push(keysBlock(keys));
  if (requests.ok) sections.push(section({ id: 'expired', title: 'Expired', rows: requests.expired.map((c) => ({ key: c.key, main: c.label, sub: c.sub, tone: 'unknown', card: c })), collapsed: true, empty: 'No request has expired.', onRow: (r) => openRequest(r.card, deps) }));
  if (sync.on) sections.push(fold('Other machines', el('p', { class: 'sync-line', text: sync.words }), sync.unreachableWords ? note(sync.unreachableWords) : null));
  else if (!sync.hidden) sections.push(fold('Other machines', note(sync.reason)));
  parts.push(el('div', { class: 'page-sections' }, sections), el('p', { class: 'foot-note' }, el('a', { href: legacyHref('secrets'), text: 'Open secrets in the legacy dashboard' })));
  setKids(main, el('div', { class: 'secrets-page' }, parts));
  startTicker();
}

// ── Waiting ───────────────────────────────────────────────────────────────
function waitingBlock(requests, deps, multi) {
  const wrap = el('section', { class: 'list-section', id: 'sec-waiting' }, el('div', { class: 'list-head' }, el('h2', { class: 'eyebrow', text: 'Waiting' }), requests.ok ? el('span', { class: 'list-count', text: String(requests.waiting.length) }) : null));
  if (!requests.ok) { wrap.append(cantTell(requests.reason)); return wrap; }
  if (!requests.waiting.length) wrap.append(el('p', { class: 'empty-line', text: 'Nothing is waiting.' }));
  else wrap.append(el('div', { class: 'secret-cards' }, requests.waiting.map((c) => waitingCard(c, deps))));
  // How a request works, and which machine's requests these are, one tap deeper.
  wrap.append(fold('How this works', note('When the agent needs a password or key, it asks here with a one-time link. Once someone submits, it moves to the agent and no longer stays listed.'), multi ? note('These are this machine’s requests. Each machine keeps its own.') : null));
  return wrap;
}

function linkActions(c, status) {
  if (!c.link) return [note('No link to open — the server didn’t give one.')];
  const open = el('a', { class: 'btn-primary btn-inline', href: c.link.url, target: '_blank', rel: 'noopener noreferrer', text: 'Open', 'data-open': c.token });
  const shareBtn = el('button', { class: 'btn-quiet', type: 'button', text: 'Share link', 'data-share': c.token });
  shareBtn.addEventListener('click', () => share(c.link.url, c.label, status));
  return [open, shareBtn];
}

function waitingCard(c, deps) {
  const status = el('p', { class: 'action-status', role: 'status' });
  const left = el('span', { class: `secret-left${c.soon ? ' soon' : ''}`, 'data-expires': String(c.expiresAt), text: c.leftWords });
  const more = el('button', { class: 'btn-quiet secret-more', type: 'button', 'aria-label': 'More', text: '…', 'data-more': c.token });
  const card = el('div', { class: 'need-card secret-card', 'data-focus-key': c.key },
    el('span', { class: 'secret-label', text: c.label }),
    el('span', { class: 'need-sub' }, document.createTextNode(c.conversation ? `for “${c.conversation}” · ` : 'no conversation named · '), left),
    el('div', { class: 'sheet-actions' }, ...linkActions(c, status), more),
    status);
  more.addEventListener('click', () => openRequest(c, deps));
  return card;
}

/** The request's sheet: summary, its actions, Cancel (quiet, confirmed), then the record. */
function openRequest(c, deps) {
  const status = el('p', { class: 'action-status', role: 'status' });
  const lines = [{ label: 'Asked for', text: c.label }, { label: 'Conversation', text: c.conversation || 'none named' }, { label: 'Asked', text: c.asked || 'unknown' }, { label: c.expired ? 'Expired' : 'Time left', text: c.expired ? c.sub.split(' · ').pop() : c.leftWords }];
  const blocks = [story(lines)];
  if (!c.expired) blocks.push(el('div', { class: 'sheet-actions' }, ...linkActions(c, status)), status, cancelBlock(c, deps));
  const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
  blocks.push(details({ token: c.token, topicId: c.topicId, createdAt: iso(c.createdAt), expiresAt: iso(c.expiresAt) }, RECORD_KEYS));
  sheet({ title: c.label }, ...blocks);
}

function cancelBlock(c, deps) {
  const box = el('div', { class: 'sheet-danger' });
  const open = el('button', { class: 'btn-quiet', type: 'button', text: 'Cancel request', 'data-cancel': c.token });
  open.addEventListener('click', () => {
    const status = el('p', { class: 'action-status', role: 'status' });
    const go = el('button', { class: 'btn-danger', type: 'button', text: 'Cancel it', 'data-cancel-confirm': c.token });
    const back = el('button', { class: 'btn-quiet', type: 'button', text: 'Keep it', onclick: () => setKids(box, open) });
    go.addEventListener('click', async () => {
      go.disabled = true; status.textContent = 'Working…';
      const x = await send('DELETE', `/secrets/pending/${encodeURIComponent(c.token)}`);
      const w = resultWords('cancel', x.status, x.data);
      status.textContent = w.text;
      if (w.ok || w.gone) setTimeout(() => { closeSheet(); deps.refresh(); }, 900); else go.disabled = false;
    });
    setKids(box, el('div', { class: 'confirm' }, el('p', { class: 'confirm-text', text: 'The link stops working.' }), el('div', { class: 'confirm-row' }, back, go), status));
  });
  box.append(open);
  return box;
}

// ── Ask someone for one ───────────────────────────────────────────────────
function askSheet(deps) {
  const label = el('input', { class: 'reason-input', type: 'text', maxlength: '255', placeholder: 'OpenAI API key', 'aria-label': 'What is it?' });
  const noteIn = el('textarea', { class: 'reason-input', rows: '2', maxlength: '1023', placeholder: 'Shown on the drop page (optional)', 'aria-label': 'A note (optional)' });
  const convs = conversationChoices(deps.names);
  const conv = el('select', { class: 'reason-input', 'aria-label': 'Which conversation hears when it arrives' }, el('option', { value: '', text: 'No conversation' }), convs.map((o) => el('option', { value: o.value, text: o.label })));
  const ttl = el('select', { class: 'reason-input', 'aria-label': 'Valid for' }, TTL_CHOICES.map((t, i) => el('option', { value: String(t.ms), text: t.label, selected: i === 0 || null })));
  const status = el('p', { class: 'action-status', role: 'status' });
  const go = el('button', { class: 'btn-primary btn-inline', type: 'button', text: 'Create link', 'data-create': '1' });
  const test = el('button', { class: 'link-btn', type: 'button', text: 'Try it with a test link', 'data-test': '1' });
  const create = async (body, btn) => {
    btn.disabled = true; status.textContent = 'Working…';
    const x = await send('POST', '/secrets/request', body);
    const w = resultWords('create', x.status, x.data);
    if (!w.ok) { status.textContent = w.text; btn.disabled = false; return; }
    const c = requestCard({ ...x.data, label: body.label, topicId: body.topicId, createdAt: Date.now(), expiresAt: Date.now() + (x.data.expiresIn || body.ttlMs) }, { names: deps.names, origin: deps.origin });
    shareCard(c, w.text);
    deps.refresh();
  };
  go.addEventListener('click', () => {
    const req = requestBody({ label: label.value, note: noteIn.value, topicId: conv.value, ttlMs: ttl.value });
    if (!req.ok) { status.textContent = req.problems.join(' '); label.focus(); return; }
    create(req.body, go);
  });
  test.addEventListener('click', () => create(testRequestBody(), test));
  const field = (text, input, hint) => el('label', { class: 'limit-field' }, el('span', { text }), input, hint ? el('span', { class: 'card-note', text: hint }) : null);
  sheet({ title: 'Ask someone for one' },
    note('This makes a one-time link. Whoever opens it can type the password or key; it goes straight to the agent and never through chat.'),
    field('What is it?', label),
    field('A note', noteIn),
    field('Which conversation hears when it arrives', conv, convs.length ? null : 'No named conversations to pick from.'),
    field('Valid for', ttl),
    go, status, test);
  setTimeout(() => label.focus(), 50);
}

/** After a create: the link, ready to open or share. Nothing is copied without a tap. */
function shareCard(c, text) {
  const status = el('p', { class: 'action-status', role: 'status' });
  sheet({ title: 'Link ready' },
    el('div', { class: 'need-card secret-card' },
      el('span', { class: 'secret-label', text: c.label }),
      el('span', { class: 'need-sub' }, document.createTextNode(c.conversation ? `for “${c.conversation}” · ` : ''), el('span', { class: 'secret-left', 'data-expires': String(c.expiresAt), text: c.leftWords })),
      el('div', { class: 'sheet-actions' }, ...linkActions(c, status)),
      status),
    note(text),
    c.link && !c.link.remote ? note('This link only works on this machine’s network — there is no tunnel running.') : null);
  startTicker();
}

// ── Keys I already hold ───────────────────────────────────────────────────
function keysBlock(keys) {
  if (!keys.ok) {
    return el('section', { class: 'list-section', id: 'sec-keys' }, el('div', { class: 'list-head' }, el('h2', { class: 'eyebrow', text: 'Keys I already hold' })),
      keys.decryptFailed ? el('p', { class: 'vault-bad', text: VAULT_BROKEN_WORDS }) : cantTell(keys.reason));
  }
  const d = el('details', { class: 'raw keys-fold', id: 'sec-keys' },
    el('summary', { text: `Keys I already hold (${keys.names.length})` }),
    el('p', { class: 'card-note', text: 'I fetch these myself; you never need to resend one listed here.' }),
    keys.names.length ? el('ul', { class: 'key-names' }, keys.names.map((n) => el('li', { class: 'mono', text: n }))) : el('p', { class: 'empty-line', text: keys.empty ? 'No saved keys on this machine yet.' : 'No keys listed.' }),
    keys.source === 'sync' ? note('Listed from the machine-sync record; the full key list is switched off here.') : null);
  return d;
}

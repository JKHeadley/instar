// Permission slips (docs/specs/console-features/people-settings.md, "Permission slips",
// legacy tab id `mandates`). Approvals waiting, the active slips as cards, ended slips
// collapsed, the decision history in plain words, and the hand-authoring fold.
// Every write here is adapter (c): the PIN goes in that one request's body through
// the shared PIN sheet and is cleared the moment the request settles.

import {
  buildSlips, buildAudit, buildApprovals, mandatesHeadline, mandatesFacts, nameMap, personName,
  issueRequest, revokeRequest, grantRequest, approveRequest, denyRequest, resultWords,
  FLOOR_ACTIONS, GRANT_DURATIONS, AUTHORITIES_TEMPLATE, humanAction, defaultExpiryLocal,
} from './mandates-model.js';
import { el, setKids, pageHead, section, sheet, closeSheet, story, details, note, cantTell, askPin } from './ui.js';
import { legacyHref } from './nav-model.js';
import { verifiedDisplayName } from './display-identity.js';

const AUDIT_LIMIT = 200;
const SLIP_KEYS = ['id', 'scope', 'agents', 'author', 'createdAt', 'expiresAt', 'revoked', 'authorshipValid'];

function bearer() { try { return localStorage.getItem('instar_token') || ''; } catch { return ''; } }

/** A POST that keeps the status and the server's body (the PIN routes answer 403/429/503 with their reason). */
async function send(path, body) {
  try {
    const r = await fetch(path, { method: 'POST', headers: { Authorization: `Bearer ${bearer()}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), cache: 'no-store' });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  } catch { return { ok: false, status: 0, data: {} }; }
}

export async function renderMandates(main, ctx) {
  const { get } = ctx;
  if (!main.querySelector('.slips-page')) setKids(main, el('section', { class: 'hero page-hero' }, el('div', { class: 'eyebrow', text: 'People · Permission slips' }), el('h1', { class: 'page-title skeleton', text: 'Loading' })));
  const [slipsRes, auditRes, approvalsRes, usersRes, healthRes, tlHealth, pairing] = await Promise.all([
    get('/mandate'), get(`/mandate/audit?limit=${AUDIT_LIMIT}`), get('/authorization-requests?status=pending'),
    get('/permissions/users'), get('/health'), get('/threadline/health'), get('/threadline/pairing/invites'),
  ]);
  const now = Date.now();
  const selfName = healthRes.ok && healthRes.data && healthRes.data.project ? (healthRes.data.project.name || healthRes.data.project) : null;
  const selfFp = tlHealth.ok && tlHealth.data && typeof tlHealth.data.fingerprint === 'string' ? tlHealth.data.fingerprint : null;
  const peers = pairing.ok && pairing.data && Array.isArray(pairing.data.knownPeers) ? pairing.data.knownPeers : [];
  const names = nameMap({ selfFp, selfName: typeof selfName === 'string' ? selfName : null, peers });
  const users = usersRes.ok && usersRes.data && Array.isArray(usersRes.data.users) ? usersRes.data.users : [];
  const usersKnown = usersRes.ok && usersRes.data && Array.isArray(usersRes.data.users);
  const slips = buildSlips(slipsRes, { names, users, now });
  const audit = buildAudit(auditRes, { names, users, now, limit: AUDIT_LIMIT });
  const approvals = buildApprovals(approvalsRes);
  const refresh = () => renderMandates(main, ctx);
  const deps = { refresh, users, usersKnown, names, selfFp, peers };
  const h = mandatesHeadline({ slips, approvals, audit });

  const parts = [pageHead({ eyebrow: 'People · Permission slips', headline: h.text, tone: h.tone, facts: mandatesFacts({ slips, approvals, audit }) })];
  // A broken chain is an incident: it leads the page, above everything else.
  if (audit.ok && audit.chain.state === 'broken') parts.push(el('section', { class: 'incident', role: 'alert' }, el('span', { class: 'incident-title', text: 'Treat as an incident' }), el('p', { class: 'incident-text', text: `${audit.chain.words} Every decision below is suspect until the record is checked.` })));
  const sections = [];
  if (!approvals.hidden) sections.push(approvalsBlock(approvals, deps));
  if (!slips.ok) sections.push(el('section', { class: 'list-section', id: 'sec-active' }, el('div', { class: 'list-head' }, el('h2', { class: 'eyebrow', text: 'Active slips' })), cantTell(slips.reason)));
  else {
    sections.push(activeBlock(slips, deps));
    sections.push(section({ id: 'ended', title: 'Ended', rows: slips.ended.map((c) => ({ key: c.key, main: c.summary, sub: `${c.title} · ${c.stateWords}`, tone: c.invalid ? 'bad' : 'unknown', card: c })), collapsed: true, empty: 'No slip has ended yet.', onRow: (r) => openSlip(r.card, deps) }));
  }
  sections.push(historyBlock(audit, deps));
  sections.push(authorFold(slips, deps));
  parts.push(el('div', { class: 'page-sections' }, sections), el('p', { class: 'foot-note' }, el('a', { href: legacyHref('mandates'), text: 'Open mandates in the legacy dashboard' })));
  setKids(main, el('div', { class: 'slips-page' }, parts));
}

// ── Waiting for you ───────────────────────────────────────────────────────
function approvalsBlock(approvals, deps) {
  const wrap = el('section', { class: 'list-section', id: 'sec-waiting' }, el('div', { class: 'list-head' }, el('h2', { class: 'eyebrow', text: 'Waiting for you' }), approvals.ok ? el('span', { class: 'list-count', text: String(approvals.rows.length) }) : null));
  if (!approvals.ok) { wrap.append(el('p', { class: 'card-note', text: approvals.reason })); return wrap; }
  if (!approvals.rows.length) { wrap.append(el('p', { class: 'empty-line', text: 'Nothing is waiting for your approval.' })); return wrap; }
  for (const r of approvals.rows) wrap.append(approvalCard(r, deps));
  return wrap;
}

function approvalCard(r, deps) {
  const status = el('p', { class: 'action-status', role: 'status' });
  const card = el('div', { class: 'need-card approval-card', 'data-focus-key': r.key },
    el('span', { class: 'need-title', text: r.headline }),
    r.reason ? el('span', { class: 'need-sub', text: `${r.agent}’s reason: ${r.reason}` }) : null);
  if (!r.here) {
    card.append(note(`Asked on ${r.machine || 'another machine'} — open that machine’s console to approve it.`), status);
    return card;
  }
  const approve = el('button', { class: 'btn-primary btn-inline', type: 'button', text: 'Approve', 'data-approve': r.id });
  approve.addEventListener('click', async () => {
    const pin = await askPin({ title: 'Approve this?', explain: `“${r.headline}” Approvals need your PIN so an agent can never approve for you. It goes in this one request and is not kept.`, adapter: 'body' });
    if (!pin) return;
    approve.disabled = true; status.textContent = 'Working…';
    const body = approveRequest(pin.pin); pin.pin = '';
    const x = await send(`/authorization-requests/${encodeURIComponent(r.id)}/approve`, body);
    body.pin = '';
    const w = resultWords('approve', x.status, x.data);
    status.textContent = w.text;
    if (w.ok) setTimeout(deps.refresh, 900); else approve.disabled = false;
  });
  const decline = el('button', { class: 'btn-quiet', type: 'button', text: 'Decline', 'data-deny': r.id });
  decline.addEventListener('click', () => declineSheet(r, status, deps));
  card.append(el('div', { class: 'sheet-actions' }, approve, decline), status);
  return card;
}

function declineSheet(r, cardStatus, deps) {
  const why = el('textarea', { class: 'reason-input', rows: '2', placeholder: 'Why you are declining (needed)', 'aria-label': 'Why you are declining' });
  const status = el('p', { class: 'action-status', role: 'status' });
  const go = el('button', { class: 'btn-primary btn-inline', type: 'button', text: 'Decline with PIN' });
  go.addEventListener('click', async () => {
    const req = denyRequest('', why.value);
    if (!req.ok) { status.textContent = req.problems.join(' '); why.focus(); return; }
    const pin = await askPin({ title: 'Decline this request', explain: 'Declining needs your PIN too — that is the server’s rule, so an agent can never answer for you. It goes in this one request and is not kept.', adapter: 'body' });
    if (!pin) return;
    const body = denyRequest(pin.pin, why.value).body; pin.pin = '';
    const panel = sheet({ title: 'Declining…' }, el('p', { class: 'action-status', role: 'status', text: 'Working…' }));
    const x = await send(`/authorization-requests/${encodeURIComponent(r.id)}/deny`, body);
    body.pin = '';
    const w = resultWords('deny', x.status, x.data);
    panel.querySelector('.action-status').textContent = w.text;
    cardStatus.textContent = w.text;
    if (w.ok) setTimeout(() => { closeSheet(); deps.refresh(); }, 900);
  });
  sheet({ title: 'Decline this request?' }, el('p', { class: 'confirm-text', text: r.headline }), why, el('div', { class: 'confirm-row' }, el('button', { class: 'btn-quiet', type: 'button', text: 'Cancel', onclick: () => closeSheet() }), go), status);
  setTimeout(() => why.focus(), 50);
}

// ── Active slips ──────────────────────────────────────────────────────────
function activeBlock(slips, deps) {
  const wrap = el('section', { class: 'list-section', id: 'sec-active' }, el('div', { class: 'list-head' }, el('h2', { class: 'eyebrow', text: 'Active slips' }), el('span', { class: 'list-count', text: String(slips.active.length) })));
  if (!slips.active.length) { wrap.append(el('p', { class: 'empty-line', text: 'No slip is active. With none, every agent-to-agent action is refused.' })); return wrap; }
  wrap.append(el('div', { class: 'slip-cards' }, slips.active.map((c) => slipCardEl(c, deps))));
  return wrap;
}

function slipCardEl(c, deps) {
  const b = el('button', { class: `slip-card${c.invalid ? ' invalid' : ''}`, type: 'button', 'data-focus-key': c.key, 'data-slip': c.id },
    el('span', { class: 'slip-title', text: c.title }),
    el('span', { class: 'slip-summary', text: c.summary }),
    c.invalidLine ? el('span', { class: 'slip-invalid', text: c.invalidLine }) : null,
    el('span', { class: 'slip-foot' }, el('span', { class: 'row-sub', text: c.peopleLine || c.stateWords }), el('span', { class: 'chev', 'aria-hidden': 'true', text: '›' })));
  b.addEventListener('click', () => openSlip(c, deps));
  return b;
}

function openSlip(c, deps) {
  const m = c.record;
  const lines = [{ label: 'Allows', text: c.summary }, { label: 'State', text: c.stateWords }, { label: 'Signed by', text: m.author || 'unknown' }];
  if (c.invalid) lines.push({ label: 'Signature', text: 'Does not check out — treat this slip as unusable.' });
  const blocks = [story(lines)];
  if (c.grants.length) blocks.push(el('h3', { class: 'eyebrow sub-label', text: 'Who else it lets act' }), el('ul', { class: 'change-list' }, c.grants.map((g) => el('li', { class: g.live ? null : 'muted', text: g.text }))));
  if (c.state === 'active') blocks.push(grantForm(c, deps));
  blocks.push(details({ ...m, agents: Array.isArray(m.agents) ? m.agents.join(' + ') : m.agents, actions: (m.authorities || []).map((a) => a && a.action).filter(Boolean).join(', ') || null, authorities: m.authorities }, [...SLIP_KEYS, 'actions', 'authorities']));
  if (c.state === 'active') blocks.push(revokeBlock(c, deps));
  sheet({ title: c.title }, ...blocks);
}

function grantForm(c, deps) {
  const people = deps.users.filter((u) => u && u.slackUserId);
  const who = people.length
    ? el('select', { class: 'reason-input', 'aria-label': 'Who' }, people.map((u) => el('option', { value: u.slackUserId, text: u.orgRole ? `${u.name} — ${u.orgRole}` : u.name })))
    : el('input', { class: 'reason-input', type: 'text', placeholder: 'Slack user id (U…)', 'aria-label': 'Who (Slack user id)' });
  const what = el('select', { class: 'reason-input', 'aria-label': 'What they may do' }, FLOOR_ACTIONS.map((a) => el('option', { value: a, text: humanAction(a), selected: a === 'prod-deploy' || null })));
  const how = el('select', { class: 'reason-input', 'aria-label': 'For how long' }, GRANT_DURATIONS.map((d) => el('option', { value: String(d.minutes), text: d.label, selected: d.minutes === 60 || null })));
  const status = el('p', { class: 'action-status', role: 'status' });
  const go = el('button', { class: 'btn-primary btn-inline', type: 'button', text: 'Grant with PIN', 'data-grant': c.id });
  go.addEventListener('click', async () => {
    const dry = grantRequest(c.record, { grantedTo: who.value, floorAction: what.value, minutes: how.value }, 'x');
    if (!dry.ok) { status.textContent = dry.problems.join(' '); return; }
    const name = personName(who.value.trim(), deps.users);
    const pin = await askPin({ title: 'Let a person act', explain: `${name} may ${humanAction(what.value)} for ${how.selectedOptions[0].textContent}${dry.clamped ? ' (shortened to this slip’s own end)' : ''}. Your PIN goes in this one request and is not kept.`, adapter: 'body' });
    if (!pin) return;
    const req = grantRequest(c.record, { grantedTo: who.value, floorAction: what.value, minutes: how.value }, pin.pin); pin.pin = '';
    const panel = sheet({ title: 'Granting…' }, el('p', { class: 'action-status', role: 'status', text: 'Working…' }));
    const x = await send(`/mandate/${encodeURIComponent(c.id)}/grants`, req.body);
    req.body.pin = '';
    const w = resultWords('grant', x.status, x.data);
    panel.querySelector('.action-status').textContent = w.ok && req.clamped ? `${w.text} It ends with the slip, not after.` : w.text;
    if (w.ok) setTimeout(() => { closeSheet(); deps.refresh(); }, 1000);
  });
  return el('div', { class: 'sheet-block grant-form' },
    el('h3', { class: 'eyebrow sub-label', text: 'Let a person act' }),
    deps.usersKnown && !people.length ? note('No registered people to pick from; a Slack user id works.') : null,
    !deps.usersKnown ? note('Couldn’t read the registered people, so a Slack user id is needed.') : null,
    el('div', { class: 'grant-fields' }, el('label', { class: 'limit-field' }, el('span', { text: 'Who' }), who), el('label', { class: 'limit-field' }, el('span', { text: 'May' }), what), el('label', { class: 'limit-field' }, el('span', { text: 'For' }), how)),
    note('The person you pick may take that one action for that window. A grant can never outlive the slip; revoking the slip ends it.'),
    go, status);
}

function revokeBlock(c, deps) {
  const box = el('div', { class: 'sheet-danger' });
  const open = el('button', { class: 'btn-quiet', type: 'button', text: 'Revoke this slip', 'data-revoke': c.id });
  open.addEventListener('click', () => {
    const why = el('textarea', { class: 'reason-input', rows: '2', placeholder: 'Why (optional)', 'aria-label': 'Why (optional)' });
    const status = el('p', { class: 'action-status', role: 'status' });
    const go = el('button', { class: 'btn-danger', type: 'button', text: 'Revoke with PIN', 'data-revoke-confirm': c.id });
    const cancel = el('button', { class: 'btn-quiet', type: 'button', text: 'Cancel', onclick: () => setKids(box, open) });
    const n = c.grants.filter((g) => g.live).length;
    go.addEventListener('click', async () => {
      const pin = await askPin({ title: 'Revoke this slip', explain: `Ends “${c.title}”${n ? ` and the ${n === 1 ? '1 grant' : `${n} grants`} it carries` : ''}, now. Can’t be undone. Your PIN goes in this one request and is not kept.`, adapter: 'body' });
      if (!pin) return;
      const body = revokeRequest(pin.pin, why.value); pin.pin = '';
      const panel = sheet({ title: 'Revoking…' }, el('p', { class: 'action-status', role: 'status', text: 'Working…' }));
      const x = await send(`/mandate/${encodeURIComponent(c.id)}/revoke`, body);
      body.pin = '';
      const w = resultWords('revoke', x.status, x.data);
      panel.querySelector('.action-status').textContent = w.text;
      if (w.ok) setTimeout(() => { closeSheet(); deps.refresh(); }, 1000);
    });
    setKids(box, el('div', { class: 'confirm' }, el('p', { class: 'confirm-text', text: `Ends this slip${n ? ` and the ${n === 1 ? '1 grant' : `${n} grants`} it carries` : ''}, now. Can’t be undone.` }), why, el('div', { class: 'confirm-row' }, cancel, go), status));
    why.focus();
  });
  box.append(open);
  return box;
}

// ── Decision history ──────────────────────────────────────────────────────
function historyBlock(audit, deps) {
  if (!audit.ok) return el('section', { class: 'list-section', id: 'sec-history' }, el('div', { class: 'list-head' }, el('h2', { class: 'eyebrow', text: 'Decision history' })), cantTell(audit.reason));
  const sec = section({ id: 'history', title: 'Decision history', rows: audit.rows, collapsed: audit.chain.state !== 'broken' && audit.rows.length > 0, empty: 'No decisions recorded yet. Every allow and refusal lands here.', onRow: (r) => openDecision(r, deps) });
  const head = sec.querySelector('.list-head');
  head.after(el('p', { class: `history-line${audit.chain.state === 'broken' ? ' bad' : ''}` }, el('span', { text: audit.countLabel }), el('span', { class: 'history-chain', text: audit.chain.words })));
  return sec;
}

function openDecision(r, deps) {
  const e = r.record;
  const lines = [{ label: 'Decision', text: r.allowed ? 'Allowed' : 'Refused' }, { label: 'What', text: r.main.replace(/^(Allowed|Refused) · /, '') }, { label: 'Because', text: e.reason || 'no reason recorded' }, { label: 'When', text: e.ts ? new Date(e.ts).toLocaleString() : 'unknown' }];
  if (e.conditionResult !== null && e.conditionResult !== undefined) lines.push({ label: 'Condition', text: e.conditionResult ? 'met' : 'not met' });
  sheet({ title: r.allowed ? 'Allowed' : 'Refused' }, story(lines), details(e, ['action', 'agentFp', 'mandateId', 'ts', 'hash', 'prevHash']));
  void deps;
}

// ── Advanced: write a slip by hand ────────────────────────────────────────
function authorFold(slips, deps) {
  const d = el('details', { class: 'raw author-fold', id: 'sec-author', open: slips.ok && slips.counts.active === 0 && slips.counts.ended === 0 ? '' : null },
    el('summary', { text: 'Advanced: write a slip by hand' }),
    el('p', { class: 'card-note', text: 'Most slips are made when an agent asks and you approve. Writing one by hand names the two agents and exactly what they may do.' }),
    el('button', { class: 'btn-quiet', type: 'button', text: 'Write a slip', onclick: () => issueSheet(deps) }));
  return d;
}

function issueSheet(deps) {
  const scope = el('input', { class: 'reason-input', type: 'text', value: 'feedback-migration', 'aria-label': 'What is this slip for?' });
  const agentA = el('input', { class: 'reason-input mono', type: 'text', value: deps.selfFp || '', placeholder: deps.selfFp ? null : 'this agent’s fingerprint (could not read it)', 'aria-label': 'This agent' });
  const peers = deps.peers.filter((p) => p && p.fp);
  const pick = el('select', { class: 'reason-input', 'aria-label': 'The other agent' }, [...peers.map((p) => el('option', { value: p.fp, text: verifiedDisplayName(p.name, p.fp) || 'Agent name unavailable' })), el('option', { value: '', text: 'Enter an agent identifier…' })]);
  const paste = el('input', { class: 'reason-input mono', type: 'text', placeholder: 'the other agent’s routing fingerprint', 'aria-label': 'The other agent’s fingerprint', hidden: peers.length > 0 });
  pick.addEventListener('change', () => { paste.hidden = pick.value !== ''; if (!paste.hidden) paste.focus(); });
  const authorities = el('textarea', { class: 'reason-input mono', rows: '8', spellcheck: 'false', 'aria-label': 'What exactly may they do? (JSON)' });
  authorities.value = AUTHORITIES_TEMPLATE;
  const expires = el('input', { class: 'reason-input', type: 'datetime-local', 'aria-label': 'When does it expire?' });
  expires.value = defaultExpiryLocal();
  const status = el('p', { class: 'action-status', role: 'status' });
  const go = el('button', { class: 'btn-primary btn-inline', type: 'button', text: 'Issue with PIN', 'data-issue': '1' });
  const form = () => ({ scope: scope.value, agentA: agentA.value, agentB: peers.length && pick.value ? pick.value : paste.value, authorities: authorities.value, expiresAt: expires.value });
  go.addEventListener('click', async () => {
    const dry = issueRequest(form(), 'x');
    if (!dry.ok) { status.textContent = dry.problems.join(' '); return; }
    const pin = await askPin({ title: 'Issue this slip', explain: 'Issuing a slip is a human action: your PIN signs it. It goes in this one request and is not kept.', adapter: 'body' });
    if (!pin) return;
    const req = issueRequest(form(), pin.pin); pin.pin = '';
    const panel = sheet({ title: 'Issuing…' }, el('p', { class: 'action-status', role: 'status', text: 'Working…' }));
    const x = await send(req.path, req.body);
    req.body.pin = '';
    const w = resultWords('issue', x.status, x.data);
    panel.querySelector('.action-status').textContent = w.text;
    if (w.ok || w.issued) setTimeout(() => { closeSheet(); deps.refresh(); }, 1200);
  });
  const field = (label, hint, input) => el('label', { class: 'limit-field' }, el('span', { text: label }), input, hint ? el('span', { class: 'card-note', text: hint }) : null);
  sheet({ title: 'Write a slip by hand' },
    field('What is it for?', 'A short name for what the two agents may work on together.', scope),
    field('This agent', deps.selfFp ? 'Pre-filled with this agent’s own fingerprint.' : 'Could not read this agent’s fingerprint; paste it.', agentA),
    field('The other agent', peers.length ? 'An agent you already know, or paste a fingerprint.' : 'No known agents to pick from; paste the other agent’s routing fingerprint.', el('div', { class: 'grant-fields' }, peers.length ? pick : null, paste)),
    field('What exactly may they do?', 'One entry per action with its bounds. The template is the usual credential-handoff + code-review pair.', authorities),
    field('When does it expire?', 'Every slip expires; expired means refused.', expires),
    go, status);
}

// Other agents (docs/specs/console-features/people-settings.md, "Other agents";
// legacy tab id `threadline`). The question on arrival: "is anyone waiting on me, and
// is each agent I work with actually there?" Pairing, delivery health and conversations
// merge into one row per agent. Reads: /threadline/health (my own relay first),
// /threadline/pairing + /invites, /threadline/peers/health, /threadline/conversations
// ?scope=mesh (+ the observability thread list for names), /pool (machine names).
// Writes keep their server gates: invites, decline, cancel, dismiss, check-an-invite and
// hub binding are bearer; Approve / Finish / Not them / It's one of my agents take the
// PIN in that one request's body (adapter c) and clear it. Peer-authored message bodies
// are UNTRUSTED: they reach the DOM through textContent only, inside a labelled quote.
// There is no console route for changing a peer's trust level (the MCP tool does that
// in-process), so that control is left out and said so.

import {
  buildAgentsPage, threadModel, inviteResultWords, pinResultWords, bearerResultWords, enableWords, bindRequest, bindResultWords, localTime,
} from './agents-model.js';
import { el, setKids, pageHead, section, sheet, closeSheet, story, details, note, cantTell, askPin } from './ui.js';
import { legacyHref } from './nav-model.js';
import { topicNameMap } from './topic-names.js';
import { verifiedDisplayName } from './display-identity.js';

const EYEBROW = 'People · Other agents';
const TIMEOUT_MS = 5000;
const POOL_TIMEOUT_MS = 8000;

function bearer() { try { return localStorage.getItem('instar_token') || ''; } catch { return ''; } }

/** A read that keeps the status and the server's error text: a 503 body says WHY (pairing off vs relay elsewhere). */
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
async function send(path, body, method = 'POST') {
  try {
    const r = await fetch(path, { method, headers: { Authorization: `Bearer ${bearer()}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), cache: 'no-store' });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  } catch { return { ok: false, status: 0, data: { error: 'The server could not be reached.' } }; }
}

export async function renderAgents(main, ctx) {
  if (!main.querySelector('.agents-page')) setKids(main, el('section', { class: 'hero page-hero' }, el('div', { class: 'eyebrow', text: EYEBROW }), el('h1', { class: 'page-title skeleton', text: 'Loading other agents' })));
  const [health, pairingRes, invitesRes, peersRes, convRes, threadsRes, poolRes, topicsRes] = await Promise.all([
    read('/threadline/health'), read('/threadline/pairing'), read('/threadline/pairing/invites'),
    read('/threadline/peers/health?scope=pool', POOL_TIMEOUT_MS), read('/threadline/conversations?scope=mesh'), read('/threadline/observability/threads'), read('/pool'), read('/telegram/topics?scope=pool', POOL_TIMEOUT_MS),
  ]);
  const page = buildAgentsPage({ health, pairingRes, invitesRes, peersRes, convRes, threadsRes, poolRes, topicNames: topicNameMap(topicsRes) }, Date.now());
  const refresh = () => renderAgents(main, ctx);
  const deps = { refresh, page };

  if (page.mode === 'off') {
    setKids(main, el('div', { class: 'agents-page' },
      pageHead({ eyebrow: EYEBROW, headline: page.headline, sub: page.sub, tone: 'muted' }),
      turnOnCard(deps),
      footLink()));
    return;
  }

  const agentRows = page.agents.filter((a) => !a.historyOnly).map((a) => ({ key: a.key, main: a.main, sub: a.sub, end: a.end, tone: a.tone === 'ok' ? null : a.tone, agent: a }));
  const pastRows = page.agents.filter((a) => a.historyOnly).map((a) => ({ key: a.key, main: a.main, sub: a.sub, end: a.end, agent: a }));
  const connect = el('button', { class: 'btn-primary btn-inline connect-btn', type: 'button', text: '+ Connect another agent', onclick: () => openConnect(deps) });
  setKids(main, el('div', { class: 'agents-page' },
    pageHead({ eyebrow: EYEBROW, headline: page.headline, sub: page.sub, tone: page.tone, facts: page.facts }),
    page.waiting.map((w) => waitingCard(w, deps)),
    page.relay.connected || page.relay.state === 'cant-tell' ? null : relayLine(page.relay),
    page.relay.state === 'cant-tell' ? note(page.relay.word + '.') : null,
    page.notes.map((n) => note(n)),
    el('div', { class: 'page-sections' },
      agentRows.length || page.pairing.state === 'ok' ? section({ id: 'agents', title: 'Agents', rows: agentRows, empty: 'No other agents yet. Connect one below.', onRow: (r) => openAgent(r.agent, deps) }) : null,
      pastRows.length ? section({ id: 'past-agents', title: 'Past conversations', collapsed: true, rows: pastRows, onRow: (r) => openAgent(r.agent, deps) }) : null,
      page.pairing.openInvites.length ? section({ id: 'open-invites', title: 'Invites not used yet', collapsed: true, rows: page.pairing.openInvites.map((i) => ({ key: `inv:${i.iid}`, main: 'Unused invitation', sub: `works once · expires at ${localTime(i.exp)}`, invite: i })), onRow: (r) => openInvite(r.invite, deps) }) : null,
    ),
    page.pairing.state === 'off' ? turnOnCard(deps) : page.pairing.state === 'elsewhere' ? note(page.pairing.holder ? `Pairing runs on ${page.pairing.holder.name}; open the console there to connect another agent.` : 'Pairing runs on another of my machines; connect another agent from there.') : el('div', { class: 'page-primary' }, connect),
    footLink(),
  ));
}

function footLink() {
  return el('p', { class: 'foot-note' }, el('a', { href: legacyHref('threadline'), text: 'Telegram mirroring rules and message search are in the legacy Threadline tab' }));
}
function block(title, ...kids) { return el('section', { class: 'sheet-block' }, el('h3', { class: 'eyebrow', text: title }), ...kids); }

function relayLine(relay) {
  return el('p', { class: 'tone-line', 'data-tone': relay.tone === 'bad' ? 'bad' : 'attn', text: `${relay.word}${relay.since ? ` (since ${relay.since})` : ''}.` });
}

// ── Turn on pairing (bearer; the server restarts itself and this page reconnects) ──
function turnOnCard(deps) {
  const status = el('p', { class: 'action-status', role: 'status' });
  const go = el('button', { class: 'btn-primary btn-inline', type: 'button', text: 'Turn on pairing' });
  let poll = null;
  go.addEventListener('click', async () => {
    go.disabled = true; status.textContent = 'Switching it on…';
    const r = await send('/threadline/pairing/enable', {});
    const w = enableWords(r.status, r.data);
    status.textContent = w.text;
    if (!w.ok) { go.disabled = false; return; }
    if (w.done) { setTimeout(deps.refresh, 800); return; }
    // The server restarts for it; poll the read-only state until it says ready (up to five minutes).
    let tries = 0;
    poll = setInterval(async () => {
      tries += 1;
      const s = await read('/threadline/pairing/enable');
      if (s.ok && s.data && s.data.ready) { clearInterval(poll); status.textContent = 'Pairing is on.'; deps.refresh(); }
      else if (tries >= 30) { clearInterval(poll); status.textContent = `${w.text} It has not come back yet; this page keeps refreshing on its own.`; }
    }, 10000);
  });
  return el('div', { class: 'need-card muted-card' },
    el('span', { class: 'need-title', text: 'Pairing is turned off on this agent' }),
    el('span', { class: 'need-sub', text: 'Turning it on switches the agent network on and restarts my server; this page reconnects by itself.' }),
    go, status);
}

// ── Waiting on you ───────────────────────────────────────────────────────────
function waitingCard(w, deps) {
  const status = el('p', { class: 'action-status', role: 'status' });
  const acts = el('div', { class: 'sheet-actions' });
  const pinned = async (label, route, explain, okText, button) => {
    const pin = await askPin({ title: label, explain: `${explain} Your PIN goes in this one request and is not kept.`, adapter: 'body' });
    if (!pin) return;
    button.disabled = true; status.textContent = 'Working…';
    const body = { pin: pin.pin };
    pin.pin = '';
    const r = await send(route, body);
    body.pin = '';
    const words = pinResultWords(r.status, r.data, okText);
    status.textContent = words.text;
    if (words.ok) setTimeout(() => { closeSheet(); deps.refresh(); }, 900); else button.disabled = false;
  };
  const plain = async (route, method, okText, button) => {
    button.disabled = true; status.textContent = 'Working…';
    const r = await send(route, {}, method);
    const words = bearerResultWords(r.status, r.data, okText);
    status.textContent = words.text;
    if (words.ok || r.status === 404) setTimeout(deps.refresh, 700); else button.disabled = false;
  };
  if (w.actions.includes('approve')) {
    const b = el('button', { class: 'btn-primary btn-inline', type: 'button', text: 'Approve', 'data-pair-action': 'approve' });
    b.addEventListener('click', () => pinned('Approve this pairing', `/threadline/pairing/invites/${encodeURIComponent(w.iid)}/approve`, `Approve pairing with ${w.name}.`, 'Approved. Finishing the connection and checking we can talk…', b));
    acts.append(b);
  }
  if (w.actions.includes('decline')) {
    const b = el('button', { class: 'btn-quiet', type: 'button', text: 'Decline' });
    b.addEventListener('click', () => plain(`/threadline/pairing/invites/${encodeURIComponent(w.iid)}/decline`, 'POST', 'Declined. Nothing was paired.', b));
    acts.append(b);
  }
  if (w.actions.includes('finish')) {
    const b = el('button', { class: 'btn-primary btn-inline', type: 'button', text: 'Finish pairing', 'data-pair-action': 'finish' });
    b.addEventListener('click', () => pinned('Finish pairing', `/threadline/pairing/invites/${encodeURIComponent(w.iid)}/finish`, `Finish pairing with ${w.name}: I pin it as verified.`, 'Finishing. Checking we can talk…', b));
    acts.append(b);
  }
  if (w.actions.includes('not-them')) {
    const b = el('button', { class: 'btn-quiet btn-danger-outline', type: 'button', text: 'Not them' });
    b.addEventListener('click', () => {
      const go = el('button', { class: 'btn-danger', type: 'button', text: 'Not them' });
      go.addEventListener('click', () => pinned('Not them', `/threadline/pairing/invites/${encodeURIComponent(w.iid)}/not-them`, 'Refuse this acceptor: nothing is pinned and that invite is used up.', 'Not paired. That invite is used up.', go));
      sheet({ title: 'Not them?' }, el('p', { class: 'confirm-text', text: 'That invite is used up: nothing is paired, and you will need a new invite for the agent you meant.' }),
        el('div', { class: 'confirm-row' }, el('button', { class: 'btn-quiet', type: 'button', text: 'Cancel', onclick: () => closeSheet() }), go));
    });
    acts.append(b);
  }
  if (w.actions.includes('dismiss')) {
    const b = el('button', { class: 'btn-quiet', type: 'button', text: 'Dismiss' });
    b.addEventListener('click', () => plain(`/threadline/pairing/restart-notices/${encodeURIComponent(w.id)}`, 'DELETE', 'Dismissed.', b));
    acts.append(b);
  }
  return el('div', { class: `need-card waiting-card${w.kind === 'alarm' ? ' bad' : ''}`, 'data-waiting': w.kind },
    el('span', { class: 'need-title', text: w.title }), el('span', { class: 'need-sub', text: w.body }), acts.childElementCount ? acts : null, status);
}

// ── Connect another agent (make an invite / I was sent one) ──────────────────
function openConnect(deps) {
  const known = deps.page.pairing.knownPeers;
  const who = el('select', { class: 'reason-input select-input', 'aria-label': 'Who is it for?' }, el('option', { value: '', text: 'Someone new' }), known.map((p) => el('option', { value: p.fp, text: verifiedDisplayName(p.name, p.fp) || 'Agent name unavailable' })));
  let ttl = 60;
  const chips = el('div', { class: 'filter-chips', role: 'group', 'aria-label': 'Valid for' }, [[60, '1 hour'], [1440, '24 hours']].map(([m, label]) => el('button', { class: 'fchip', type: 'button', 'aria-pressed': m === ttl ? 'true' : 'false', onclick: (ev) => { ttl = m; for (const c of chips.children) c.setAttribute('aria-pressed', c === ev.currentTarget ? 'true' : 'false'); } }, el('span', { text: label }))));
  const status = el('p', { class: 'action-status', role: 'status' });
  const out = el('div', { class: 'invite-out' });
  const make = el('button', { class: 'btn-primary btn-inline', type: 'button', text: 'Make invite' });
  make.addEventListener('click', async () => {
    make.disabled = true; status.textContent = 'Making the invite…';
    const r = await send('/threadline/pairing/invites', who.value ? { ttlMinutes: ttl, bindFp: who.value } : { ttlMinutes: ttl });
    const w = inviteResultWords(r.status, r.data);
    if (!w.ok) { status.textContent = w.text; make.disabled = false; return; }
    status.textContent = '';
    const text = el('textarea', { class: 'reason-input invite-text', readonly: true, rows: '4', 'aria-label': 'The invite' });
    text.value = w.message;
    const copy = el('button', { class: 'btn-primary btn-inline', type: 'button', text: 'Copy' });
    copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(w.message); status.textContent = 'Copied. Paste it to the other person.'; } catch { text.select(); status.textContent = 'Select the text and copy it yourself (your browser blocked copying).'; } });
    const share = typeof navigator !== 'undefined' && navigator.share ? el('button', { class: 'btn-quiet', type: 'button', text: 'Share', onclick: () => navigator.share({ text: w.message }).catch(() => {}) }) : null;
    setKids(out, el('p', { class: 'confirm-text', text: w.sentence }), text, el('div', { class: 'sheet-actions' }, copy, share), note('When they accept, it appears at the top of this page as “waiting for you to finish”.'));
    make.remove();
  });
  const paste = el('textarea', { class: 'reason-input', rows: '3', placeholder: 'Paste the whole invite you were sent (it contains tlinv1:…)', 'aria-label': 'The invite you were sent' });
  const checkStatus = el('p', { class: 'action-status', role: 'status' });
  const check = el('button', { class: 'btn-quiet', type: 'button', text: 'Check it' });
  check.addEventListener('click', async () => {
    const t = paste.value;
    if (!t.includes('tlinv1:')) { checkStatus.textContent = 'Paste the whole invite you were sent.'; return; }
    check.disabled = true; checkStatus.textContent = 'Checking…';
    const r = await send('/threadline/pairing/invites/inspect', { invite: t });
    if (r.status === 200) { paste.value = ''; checkStatus.textContent = 'Got it. Approve or decline it at the top of this page.'; setTimeout(() => { closeSheet(); deps.refresh(); }, 900); }
    else { checkStatus.textContent = `I can’t use that invite: ${(r.data && r.data.error) || `the server answered ${r.status}`}.`; check.disabled = false; }
  });
  sheet({ title: 'Connect another agent' },
    block('Make an invite', el('label', { class: 'limit-field' }, el('span', { text: 'Who is it for?' }), who), el('label', { class: 'limit-field' }, el('span', { text: 'Valid for' }), chips), make, status, out),
    block('I was sent one', paste, el('div', { class: 'sheet-actions' }, check), checkStatus),
    note('A person carries the invite, outside the agent network. It is never posted anywhere public and never turned into a link.'));
}

function openInvite(i, deps) {
  const status = el('p', { class: 'action-status', role: 'status' });
  const own = el('button', { class: 'btn-quiet', type: 'button', text: 'It’s one of my agents' });
  own.addEventListener('click', async () => {
    const pin = await askPin({ title: 'It’s one of my agents', explain: 'When your own agent accepts this invite, I finish the pairing by myself. Your PIN goes in this one request and is not kept.', adapter: 'body' });
    if (!pin) return;
    own.disabled = true; status.textContent = 'Working…';
    const body = { pin: pin.pin }; pin.pin = '';
    const r = await send(`/threadline/pairing/invites/${encodeURIComponent(i.iid)}/own-agent`, body); body.pin = '';
    const w = pinResultWords(r.status, r.data, 'Got it: when your other agent accepts this invite, I finish the pairing by myself.');
    status.textContent = w.text; if (w.ok) setTimeout(() => { closeSheet(); deps.refresh(); }, 900); else own.disabled = false;
  });
  const cancel = el('button', { class: 'btn-quiet btn-danger-outline', type: 'button', text: 'Cancel this invite' });
  cancel.addEventListener('click', async () => {
    cancel.disabled = true; status.textContent = 'Working…';
    const r = await send(`/threadline/pairing/invites/${encodeURIComponent(i.iid)}`, {}, 'DELETE');
    const w = bearerResultWords(r.status, r.data, 'Cancelled. That invite no longer works.');
    status.textContent = w.text; if (w.ok) setTimeout(() => { closeSheet(); deps.refresh(); }, 900); else cancel.disabled = false;
  });
  sheet({ title: 'Unused invitation' }, story([{ label: 'State', text: 'not used yet' }, { label: 'Expires', text: localTime(i.exp) }]), el('div', { class: 'sheet-actions' }, own, cancel), status, details(i, ['iid', 'state', 'exp', 'createdAt']));
}

// ── One agent ────────────────────────────────────────────────────────────────
function openAgent(a, deps) {
  const h = a.health;
  const lines = [
    { label: 'Pairing', text: a.pairingWord },
    { label: 'Reachable', text: h ? `${h.word}${h.sub ? ` — ${h.sub}` : ''}` : a.peersState === 'ok' ? 'No delivery record yet.' : 'Can’t tell: delivery records did not answer.' },
    h && h.counts ? { label: 'Delivery', text: h.counts } : null,
    a.pairingRow && a.pairingRow.verifiedAt ? { label: 'Verified', text: new Date(a.pairingRow.verifiedAt).toLocaleString() } : null,
    a.pairingRow && a.pairingRow.machineNickname ? { label: 'Paired on', text: a.pairingRow.machineNickname } : null,
  ].filter(Boolean);
  const convRows = a.conversations.map((c) => ({ ...c, tone: c.heldElsewhere ? 'unknown' : c.tone }));
  const body = [
    block('How it’s doing', story(lines)),
    section({ id: `conv-${a.fp.slice(0, 8)}`, title: 'Conversations', rows: convRows, empty: deps.page.conversations.state === 'ok' ? 'No conversations with this agent on record.' : deps.page.conversations.reason, onRow: (c) => openConversation(c, a, deps) }),
    block('For support', el('p', { class: 'card-line mono', text: a.fp }), note('Trust levels are changed by asking me in chat; there is no console route for it yet, so nothing here changes trust.')),
    details(a.healthRow || a.pairingRow || {}, ['peerFp', 'state', 'trustSource', 'lastSentAt', 'lastAckedAt', 'lastInboundAt', 'pendingCount', 'queuedCount', 'failedCount', 'unconfirmedCount', 'lastRelayStatus', 'dark', 'darkSince', 'stale', 'connectedNow', 'connectedNowReason', 'connectedAsOf', 'machineNickname']),
  ];
  sheet({ title: a.name }, ...body);
}

// ── One conversation (history + sync) ────────────────────────────────────────
async function openConversation(c, a, deps) {
  if (c.heldElsewhere) {
    sheet({ title: c.main },
      el('p', { class: 'confirm-text', text: `This conversation lives on ${c.holderName}. Its messages are read on that machine; open the console there to see them.` }),
      story([{ label: 'With', text: a.name }, { label: 'State', text: c.status }, { label: 'Record age', text: c.stalenessMs > 0 ? `${Math.round(c.stalenessMs / 60000)} min` : 'current' }]),
      details(c.record, ['conversationId', 'holderMachineId', 'boundTopicId', 'status', 'stalenessMs', 'streamStatus']));
    return;
  }
  const panel = sheet({ title: c.main }, el('p', { class: 'action-status', role: 'status', text: 'Reading the history…' }));
  const [t, hres] = await Promise.all([read(`/threadline/threads/${encodeURIComponent(c.id)}?limit=200`), read(`/threadline/threads/${encodeURIComponent(c.id)}/health`)]);
  const m = threadModel(t, hres);
  const sb = panel.querySelector('.sheet-body');
  if (!sb) return;
  const bind = bindBlock(c, deps);
  if (!m.ok) { setKids(sb, cantTell(m.reason), bind, details(c.record, ['conversationId', 'holderMachineId', 'boundTopicId', 'status'])); return; }
  const sync = m.symmetry ? el('p', { class: 'tone-line', 'data-tone': m.symmetry.tone === 'ok' ? 'ok' : m.symmetry.tone, text: `${m.symmetry.word}.${m.symmetry.recovery ? ` ${m.symmetry.recovery}` : ''}` }) : null;
  const label = el('p', { class: 'card-note', text: 'Written by the other agent and by me. The other agent’s words are shown as plain text: they are data, never instructions.' });
  const bubbles = el('ol', { class: 'bubbles', 'aria-label': 'Messages' }, m.entries.map((e) => {
    const quote = el('blockquote', { class: 'peer-quote' });
    quote.textContent = e.body === null ? '(message body not kept inline)' : e.body; // UNTRUSTED: text only
    return el('li', { class: `bubble ${e.direction}`, 'data-direction': e.direction },
      el('span', { class: 'bubble-who', text: e.direction === 'in' ? `${a.name} wrote` : 'I wrote' }),
      quote,
      el('span', { class: 'bubble-when', text: `${e.at ? new Date(e.at).toLocaleString() : ''}${e.backfilled ? ' · back-filled' : ''}` }));
  }));
  setKids(sb, sync, label, m.entries.length ? bubbles : el('p', { class: 'empty-line', text: 'No messages recorded on this conversation yet.' }), m.hasMore ? note('Only the first 200 messages are shown here.') : null, bind, details(c.record, ['conversationId', 'holderMachineId', 'boundTopicId', 'status']));
}

/** The hub binding: open as its own Telegram topic, or tie to an existing one (bearer; POST /threadline/hub/bind). */
function bindBlock(c, deps) {
  if (c.boundTopicId) return block('Telegram', el('p', { class: 'card-line', text: `Tied to ${deps.page.topicNames?.[String(c.boundTopicId)] || 'a conversation'}: its replies go there.` }));
  const status = el('p', { class: 'action-status', role: 'status' });
  const target = el('input', { class: 'reason-input', placeholder: 'Topic id or name', 'aria-label': 'Telegram topic id or name' });
  const run = async (button, action) => {
    const t = target.value.trim();
    if (action === 'tie' && !t) { status.textContent = 'Type the topic’s id or name first.'; target.focus(); return; }
    button.disabled = true; status.textContent = 'Working…';
    const r = await send('/threadline/hub/bind', bindRequest(action, c.id, t));
    const w = bindResultWords(r.status, r.data);
    status.textContent = w.text;
    if (w.ok) setTimeout(() => { closeSheet(); deps.refresh(); }, 1200); else button.disabled = false;
  };
  const open = el('button', { class: 'btn-quiet', type: 'button', text: 'Open as its own topic' });
  open.addEventListener('click', () => run(open, 'open'));
  const tie = el('button', { class: 'btn-quiet', type: 'button', text: 'Tie to this topic' });
  tie.addEventListener('click', () => run(tie, 'tie'));
  return block('Telegram', el('p', { class: 'card-line', text: 'Not tied to a Telegram topic: its replies stay in the quiet Threadline hub.' }), el('div', { class: 'sheet-actions' }, open), el('div', { class: 'bind-row' }, target, tie), status);
}

export { closeSheet };

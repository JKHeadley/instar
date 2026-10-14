/**
 * pairing.js — "Pair with another agent" on the dashboard's Threadline tab
 * (docs/specs/a2a-pairing-invite-link.md §8; replaces the 12-word panel of
 * secure-a2a-verified-pairing §3.6, which Justin rejected on 2026-10-13).
 *
 * What the operator does: make an invite and send it however they like; or paste one
 * they were sent and approve it; and, when someone accepts their invite, Finish (or say
 * "Not them"). Nobody reads, compares or types words.
 *
 * The rules from Justin's test (spec §8):
 *  1. Nothing the operator is looking at or typing into is re-rendered by a timer. Only the
 *     list sections (waiting decisions, open invites, paired agents) refresh, and only when
 *     their content actually changed; none of them holds an input.
 *  2. The PIN is asked once per page: after one accepted use it is held in this module's
 *     memory (never storage) until the page is reloaded. A refused PIN is forgotten.
 *  3. Decisions waiting for the operator come first, with a count on the Threadline tab AND on
 *     the header menu button (the tabs sit behind it, so a count only on the tab is invisible).
 *
 * Same shape as mandates.js: pure renderers + createController({ doc, els, fetchImpl }).
 */

const POLL_MS = 10_000;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const STATE_LABEL = {
  'mutual-verified': 'Paired',
  'identity-verified': 'Paired (on another of my machines)',
  'invite-accepted': 'Waiting for the other side to finish',
  'pending-verification': 'Started with the old word check. Pair by invite instead.',
  'verification-failed': 'Blocked (the old word check did not match)',
};

const claimed = (agent, owner) =>
  `the agent that calls itself <strong>${esc(agent || 'unknown')}</strong>${owner ? `, which says it belongs to <strong>${esc(owner)}</strong>` : ''}`;

const cap = (h) => h.charAt(0).toUpperCase() + h.slice(1);

const timeLeft = (exp, now = Date.now()) => {
  const ms = Date.parse(exp) - now;
  if (!(ms > 0)) return 'expired';
  const min = Math.round(ms / 60_000);
  return min >= 90 ? `${Math.round(min / 60)} h left` : `${Math.max(1, min)} min left`;
};

/** Invites waiting for this operator's Finish: used, with an acceptor, undecided, not leaked. */
export function finishPrompts(invites) {
  return (invites || []).filter((i) => i.state === 'used' && i.acceptor && !i.decision && !i.secondAccept);
}

/** Leak alarms from the last 24 h. */
export function alarms(invites, now = Date.now()) {
  return (invites || []).filter((i) => i.secondAccept && now - Date.parse(i.secondAccept.at) < 24 * 60 * 60_000);
}

/** How many decisions wait for the operator (the tab badge). */
export function pendingCount(data) {
  return finishPrompts(data?.invites).length + (data?.pendingAccepts || []).length;
}

export function renderPending(data, now = Date.now()) {
  const parts = [];
  for (const a of alarms(data?.invites, now)) {
    parts.push(`<div class="pair-card pair-alarm" data-alarm="${esc(a.iid)}">
      <div><strong>Warning: your invite got out.</strong> Two agents used it, so I paused the first one: it cannot receive anything secret.
      The second calls itself <strong>${esc(a.secondAccept.agent || 'unknown')}</strong>. Make a new invite and send it privately.</div></div>`);
  }
  for (const p of data?.pendingAccepts || []) {
    parts.push(`<div class="pair-card pair-waiting" data-pending-accept="${esc(p.iid)}">
      <div>Pair with ${claimed(p.claimedAgent, p.claimedOwner)}? Only approve if you know who sent you this invite.</div>
      <div class="pair-meta">Check code (optional, to read to them): ${esc(p.checkCode)} · ${esc(timeLeft(p.exp, now))}</div>
      <div class="pair-row"><button class="mnd-btn mnd-btn-primary" data-approve="${esc(p.iid)}">Approve</button>
      <button class="mnd-btn mnd-btn-quiet" data-decline="${esc(p.iid)}">Decline</button></div></div>`);
  }
  for (const i of finishPrompts(data?.invites)) {
    parts.push(`<div class="pair-card pair-waiting" data-finish-prompt="${esc(i.iid)}">
      <div>${cap(claimed(i.acceptor.agent, i.acceptor.owner))} accepted your invite. Finish only if that is who you sent it to.</div>
      <div class="pair-row"><button class="mnd-btn mnd-btn-primary" data-finish="${esc(i.iid)}">Finish</button>
      <button class="mnd-btn mnd-btn-quiet mnd-btn-danger" data-not-them="${esc(i.iid)}">Not them</button></div></div>`);
  }
  return parts.join('');
}

export function renderOpenInvites(invites, now = Date.now()) {
  const open = (invites || []).filter((i) => i.state === 'open' && Date.parse(i.exp) > now);
  if (open.length === 0) return '';
  return '<div class="pair-step-title">Invites not used yet</div>' + open.map((i) => `<div class="pair-row" data-open-invite="${esc(i.iid)}">
    <span>Invite ${esc(i.iid.slice(0, 6))} · ${esc(timeLeft(i.exp, now))}</span>
    <button class="mnd-btn mnd-btn-quiet" data-revoke="${esc(i.iid)}">Cancel it</button></div>`).join('');
}

/** One paired (or pairing) agent. No actions: invites replace the 12-word flow. */
export function renderPairing(p) {
  const fp = esc(p.peerFp);
  const label = esc(STATE_LABEL[p.state] || p.state || 'Unknown');
  return `<div class="pair-card" data-pairing="${fp}">
    <div class="pair-head"><strong>${esc(p.peerName || 'Unknown agent')}</strong> <span class="pair-state pair-state-${esc(p.state)}">${label}</span></div>
    <div class="pair-meta">Agent ${fp.slice(0, 12)}…</div>
  </div>`;
}

export function renderPairings(list) {
  if (!Array.isArray(list) || list.length === 0) return '<div class="mnd-hint">No paired agents yet.</div>';
  return '<div class="pair-step-title">Agents</div>' + list.map(renderPairing).join('');
}

export function createController({ doc, els, fetchImpl, now = () => Date.now() }) {
  let timer = null;
  let heldPin = '';           // §8.2: asked once per page, memory only
  let data = { invites: [], pendingAccepts: [], pairings: [] };
  const lastHtml = new Map();  // section → last rendered HTML (§8.1: re-render only on change)

  async function fetchJson(url, opts) {
    const res = await fetchImpl(url, opts);
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return { status: res.status, body };
  }
  const post = (url, payload, method = 'POST') => fetchJson(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload ?? {}) });

  function note(msg, kind) {
    if (!els.notice) return;
    els.notice.textContent = msg;
    els.notice.className = kind === 'error' ? 'mnd-notice mnd-notice-err' : kind === 'success' ? 'mnd-notice mnd-notice-ok' : 'mnd-notice';
  }

  function setSection(el, key, html) {
    if (!el || lastHtml.get(key) === html) return;
    lastHtml.set(key, html);
    el.innerHTML = html;
  }

  // The PIN field sits right above the decisions and shows only while one waits and no PIN is
  // held: a person meets it before the button that needs it, and never otherwise.
  function showPinRow() {
    if (els.pinRow) els.pinRow.style.display = !heldPin && pendingCount(data) > 0 ? '' : 'none';
  }

  function render() {
    setSection(els.pending, 'pending', renderPending(data, now()));
    setSection(els.open, 'open', renderOpenInvites(data.invites, now()));
    setSection(els.list, 'list', renderPairings(data.pairings));
    const n = pendingCount(data);
    if (els.tabButton) {
      const base = els.tabButton.dataset.baseLabel || (els.tabButton.dataset.baseLabel = els.tabButton.textContent);
      els.tabButton.textContent = n > 0 ? `${base} (${n})` : base;
    }
    // The tabs sit behind the header menu button, so the count must also show THERE or nobody
    // sees it (found walking the flow as a person, 2026-10-14).
    if (els.navToggle) {
      let badge = els.navToggle.querySelector('[data-pair-badge]');
      if (!badge && n > 0) {
        badge = doc.createElement('span');
        badge.setAttribute('data-pair-badge', '');
        badge.className = 'pair-nav-badge';
        els.navToggle.appendChild(badge);
      }
      if (badge) {
        // On a phone only the number shows (the word would push the header past the screen).
        badge.innerHTML = n > 0 ? `${n}<span class="pair-nav-badge-word"> waiting</span>` : '';
        badge.setAttribute('aria-label', n > 0 ? `${n} pairing decision${n === 1 ? '' : 's'} waiting` : '');
        badge.style.display = n > 0 ? '' : 'none';
      }
    }
    showPinRow();
  }

  async function load() {
    try {
      const [inv, pr] = await Promise.all([fetchJson('/threadline/pairing/invites'), fetchJson('/threadline/pairing')]);
      if (inv.status === 503 || pr.status === 503) {
        const off = /not enabled/.test(String(inv.body?.error ?? pr.body?.error ?? ''));
        setSection(els.list, 'list', off
          ? '<div class="mnd-hint">Pairing is turned off on this agent.</div>'
          : '<div class="mnd-hint">Pairing runs on the machine that holds this agent\'s Threadline identity. Open the dashboard on that machine.</div>');
        return;
      }
      if (inv.status !== 200) { note(`Could not load invites: ${inv.body?.error ?? `HTTP ${inv.status}`}`, 'error'); return; }
      data = { invites: inv.body?.invites ?? [], pendingAccepts: inv.body?.pendingAccepts ?? [], pairings: pr.status === 200 ? (pr.body?.pairings ?? []) : data.pairings };
      renderForChoices(inv.body?.knownPeers ?? []);
      render();
    } catch (e) {
      note(`Could not reach the agent: ${e?.message ?? e}`, 'error');
    }
  }

  /** The PIN for one action: the held one, or the field's (asked once). */
  function pinForAction() {
    if (heldPin) return heldPin;
    const v = els.pin ? String(els.pin.value || '') : '';
    return v;
  }
  /** After a PIN-gated call: keep an accepted PIN, forget a refused one. */
  function settlePin(pin, status) {
    if (status === 403 || status === 429) { heldPin = ''; if (els.pin) els.pin.value = ''; showPinRow(); return; }
    if (status < 500 && status !== 401) { heldPin = pin; if (els.pin) els.pin.value = ''; showPinRow(); }
  }

  async function pinned(url, okMsg) {
    const pin = pinForAction();
    if (!pin) { note('Enter your PIN first (you will only be asked once).', 'error'); if (els.pin) els.pin.focus?.(); return; }
    const { status, body } = await post(url, { pin });
    settlePin(pin, status);
    if (status === 403) { note('That PIN was not accepted.', 'error'); return; }
    if (status !== 200) { note(`That didn't work: ${body?.error ?? `HTTP ${status}`}`, 'error'); return; }
    note(okMsg, 'success');
    await load();
  }

  // "Who is it for?": a known agent binds the invite to it (spec §4.1: the default whenever the
  // inviter starts from a peer it already knows). Rebuilt only when the list changes, and the
  // operator's current choice is kept.
  function renderForChoices(peers) {
    if (!els.forPeer) return;
    const key = JSON.stringify(peers.map((p) => [p.fp, p.name]));
    if (lastHtml.get('for') === key) return;
    const keep = els.forPeer.value;
    lastHtml.set('for', key);
    const opt = (fpValue, label) => { const o = doc.createElement('option'); o.value = fpValue; o.textContent = label; return o; };
    els.forPeer.replaceChildren(opt('', 'Someone new'), ...peers.map((p) => opt(p.fp, `${p.name || 'Unknown agent'} (${p.fp.slice(0, 6)}…)`)));
    if (peers.some((p) => p.fp === keep)) els.forPeer.value = keep;
  }

  async function makeInvite() {
    const ttlMinutes = els.ttl ? Number(els.ttl.value) || 60 : 60;
    const bindFp = els.forPeer ? String(els.forPeer.value || '') : '';
    const { status, body } = await post('/threadline/pairing/invites', bindFp ? { ttlMinutes, bindFp } : { ttlMinutes });
    if (status !== 200 || !body?.message) { note(`Could not make an invite: ${body?.error ?? `HTTP ${status}`}`, 'error'); return; }
    // Shown until the operator closes it; no timer touches this box.
    els.inviteOut.innerHTML = `<div class="pair-step-title">Send this to the other person, privately, in any app. It works once.</div>
      <textarea class="pair-invite-text" readonly rows="4" data-invite-text>${esc(body.message)}</textarea>
      <div class="pair-row"><button class="mnd-btn mnd-btn-primary" data-copy-invite>Copy</button>
      <button class="mnd-btn mnd-btn-quiet" data-close-invite>Done</button></div>
      <div class="mnd-hint">Expires in ${esc(timeLeft(body.exp, now()))}. When they accept, you will see it at the top of this card.</div>`;
    await load();
  }

  async function copyInvite() {
    const ta = els.inviteOut.querySelector('[data-invite-text]');
    if (!ta) return;
    try {
      await doc.defaultView.navigator.clipboard.writeText(ta.value);
      note('Copied. Paste it to the other person.', 'success');
    } catch {
      ta.select?.();
      note('Select the text and copy it yourself (your browser blocked copying).', 'info');
    }
  }

  async function inspect() {
    const text = els.inviteIn ? String(els.inviteIn.value || '') : '';
    if (!text.includes('tlinv1:')) { note('Paste the whole invite you were sent.', 'error'); return; }
    const { status, body } = await post('/threadline/pairing/invites/inspect', { invite: text });
    if (status !== 200) { note(`I can't use that invite: ${body?.error ?? `HTTP ${status}`}`, 'error'); return; }
    els.inviteIn.value = ''; // the secret leaves the page; the decision now waits at the top
    note('Got it. Approve or decline it at the top of this card.', 'info');
    await load();
  }

  async function onClick(ev) {
    const t = ev.target;
    if (!t || !t.dataset) return;
    const d = t.dataset;
    try {
      if (d.makeInvite !== undefined) await makeInvite();
      else if (d.copyInvite !== undefined) await copyInvite();
      else if (d.closeInvite !== undefined) els.inviteOut.innerHTML = '';
      else if (d.inspectInvite !== undefined) await inspect();
      else if (d.approve) await pinned(`/threadline/pairing/invites/${d.approve}/approve`, 'Approved. Waiting for the other side to finish.');
      else if (d.finish) await pinned(`/threadline/pairing/invites/${d.finish}/finish`, 'Finished. You are paired.');
      else if (d.notThem) await pinned(`/threadline/pairing/invites/${d.notThem}/not-them`, 'Not paired. That invite is used up.');
      else if (d.decline) {
        const { status, body } = await post(`/threadline/pairing/invites/${d.decline}/decline`, {});
        note(status === 200 ? 'Declined. Nothing was paired.' : `That didn't work: ${body?.error ?? `HTTP ${status}`}`, status === 200 ? 'success' : 'error');
        await load();
      } else if (d.revoke) {
        const { status, body } = await post(`/threadline/pairing/invites/${d.revoke}`, {}, 'DELETE');
        note(status === 200 ? 'Cancelled. That invite no longer works.' : `That didn't work: ${body?.error ?? `HTTP ${status}`}`, status === 200 ? 'success' : 'error');
        await load();
      }
    } catch (e) {
      note(`Could not reach the agent: ${e?.message ?? e}`, 'error');
    }
  }

  return {
    start() {
      if (els.root && !els.root.__pairWired) { els.root.addEventListener('click', onClick); els.root.__pairWired = true; }
      load();
      if (!timer) timer = setInterval(load, POLL_MS);
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
    load,
    onClick,
    hasPin: () => Boolean(heldPin),
  };
}

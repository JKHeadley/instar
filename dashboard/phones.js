/**
 * phones.js — the dashboard's Phones card (docs/specs/mobile-native-conversations.md §4.4).
 *
 * On an agent with no Telegram owner, a phone that opens a pairing link waits here, shown only
 * after a PIN unlock (the server refuses it to anything but a dashboard operator session). The
 * operator taps Approve (docs/specs/mobile-pairing-approve.md §3.3), or types the code shown into
 * the Instar app, or taps "Not my phone" to decline. Below that, the paired phones on this
 * machine, each revocable.
 *
 * Every dynamic value reaches the DOM through textContent; nothing is rendered as HTML. The code
 * lives only in the server's memory and in this page while it is open; nothing is stored.
 */

import { renderGlance } from './glance.js';

/** Whose phone (people and roles): " — Justin (MSP)", " — Ann (owner)", or a removed person. */
function personText(d) {
  if (d.unassigned) return ' — no longer assigned to anyone';
  if (!d.personName) return '';
  return ` — ${d.personName}${d.role === 'msp' ? ' (MSP)' : ' (owner)'}`;
}

/**
 * The glance (F10/F11): one plain headline and two tiles. Fixed prose plus counts only — no
 * phone name or code reaches the front layer; those live behind the tiles.
 */
export function phonesGlanceSpec({ waiting = null, paired = null, locked = false } = {}, activate = {}) {
  const headline = locked ? 'Unlock with your PIN to see a phone that is waiting to pair.'
    : waiting > 0 ? `${waiting === 1 ? 'A phone is' : `${waiting} phones are`} waiting to pair. Open Waiting to approve or decline.`
    : 'No phone is waiting to pair.';
  return { headline, tiles: [
    { key: 'waiting', label: 'Waiting to pair', value: waiting === null ? 'Unknown' : String(waiting), tone: waiting > 0 ? 'warn' : undefined, onActivate: activate.waiting },
    { key: 'paired', label: 'Paired devices', value: paired === null ? 'Unknown' : String(paired), onActivate: activate.paired },
  ] };
}

/**
 * The paired devices, split for display (a copy of dashboard-pair/pair-model.js pairedGroups;
 * this folder is served separately) (docs/specs/dashboard-ui-quality-standard.md): phones and
 * browsers are separate groups, so neither heading lists the other kind and no row repeats its kind.
 * Each row is a name line and one short detail line. Only active and pending devices are shown.
 * `personText` (optional) adds whose device it is to the name.
 */
export function pairedGroups(devices, { browserOff = false, personText = () => '' } = {}) {
  const phones = [], browsers = [];
  for (const d of Array.isArray(devices) ? devices : []) {
    if (!d || (d.status !== 'active' && d.status !== 'pending')) continue;
    const isBrowser = d.client === 'browser';
    const name = `${d.deviceName || (isBrowser ? 'Unnamed browser' : 'Unnamed phone')}${personText(d)}`;
    let detail;
    if (d.status === 'pending') detail = 'Waiting to confirm';
    else if (isBrowser) {
      const t = Date.parse(d.lastSeenAt || '');
      detail = browserOff ? 'Switched off on this agent' : Number.isFinite(t) ? `Last used on this machine ${new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}` : 'Not used yet';
    } else {
      const t = Date.parse(d.approvedAt || '');
      detail = Number.isFinite(t) ? `Paired since ${new Date(t).toLocaleDateString(undefined, { dateStyle: 'medium' })}` : 'Paired';
    }
    (isBrowser ? browsers : phones).push({ id: d.id, name, detail, removable: d.status === 'active', what: isBrowser ? 'browser' : 'phone' });
  }
  return { phones, browsers };
}

/** "123 456" — easier to read off a screen. A word code ("KITE-4172") is shown as the server sent it. */
export function prettyCode(code) {
  const raw = String(code ?? '');
  if (/[A-Za-z]/.test(raw)) return raw;
  const c = raw.replace(/\D/g, '');
  return c.length === 6 ? `${c.slice(0, 3)} ${c.slice(3)}` : c;
}

/** Minutes left, in words. */
export function minutesLeft(iso, now = Date.now()) {
  const ms = Date.parse(iso) - now;
  if (!(ms > 0)) return 'expired';
  return `${Math.max(1, Math.round(ms / 60_000))} min left`;
}

export function mountPhonesPanel(root, { request, unlock, now = () => Date.now() }) {
  const doc = root.ownerDocument;
  const make = (tag, text, parent = root) => {
    const el = doc.createElement(tag);
    if (tag === 'button') { el.className = 'action-btn'; el.type = 'button'; }
    if (text !== undefined) el.textContent = String(text);
    parent.append(el);
    return el;
  };
  root.replaceChildren();
  make('h2', 'Phones');
  make('p', 'Pair the Instar iPhone app with this agent, and see the phones already paired.').className = 'tab-purpose';
  const notice = make('p'); notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
  const unlockButton = make('button', 'Unlock with PIN to see pairing codes'); unlockButton.hidden = true; unlockButton.onclick = unlock;
  const glance = make('section'); glance.className = 'glance-root';
  const approvals = make('section'); approvals.setAttribute('aria-label', 'Phones waiting to pair');
  const devices = make('section'); devices.setAttribute('aria-label', 'Paired devices');
  // Detail sections live behind the glance tiles; they are refreshed in place.
  approvals.remove(); devices.remove();
  let timer = null, stopped = false, busy = false;
  const counts = { waiting: null, paired: null, locked: false };
  const renderSummary = () => renderGlance(doc, glance, phonesGlanceSpec(counts, {
    waiting: ({ drilldown }) => drilldown.append(approvals),
    paired: ({ drilldown }) => drilldown.append(devices),
  }));
  renderSummary();

  const renderApprovals = (list) => {
    approvals.replaceChildren();
    make('h3', 'Waiting to pair', approvals);
    counts.waiting = list.length; counts.locked = false;
    if (!list.length) { make('p', 'No phone is waiting. Ask me for a pairing link, open it on the phone, and its code appears here.', approvals); return; }
    for (const a of list) {
      const card = make('div', undefined, approvals); card.className = 'phone-approval';
      make('p', `${a.deviceName || 'A phone'}${a.label ? ` (${a.label})` : ''}${personText(a)} is waiting · ${minutesLeft(a.expiresAt, now())}`, card);
      const canApprove = a.canApprove === true;
      if (canApprove) {
        make('p', a.fingerprint ? `Phone key: ${a.fingerprint}. Approve only if you are pairing this phone right now and the key matches the one the app shows.` : 'Approve only if you are pairing this phone right now.', card);
        const approve = make('button', 'Approve this phone', card);
        approve.onclick = async () => {
          approve.disabled = true;
          try {
            const r = await request(`/mobile/pairing-approvals/${encodeURIComponent(a.deviceId)}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            const answer = await r.json().catch(() => ({}));
            notice.textContent = r.ok ? `Approved. That phone is paired. If the app still shows a code box, type ${prettyCode(a.code)} to finish.` : (typeof answer.detail === 'string' ? answer.detail : 'Could not approve. Refresh and try again.');
          } catch { notice.textContent = 'Could not reach the agent.'; }
          await refresh();
        };
      } else if (a.fingerprint) make('p', `Phone key: ${a.fingerprint}. The app shows the same key; check they match.`, card);
      const code = make('p', prettyCode(a.code), card); code.className = 'phone-code'; code.setAttribute('aria-label', 'Confirmation code');
      make('p', canApprove ? 'If the app asks for a code instead, type this one. Never send it to anyone, including me.' : 'Type this code into the Instar app on that phone. Never send it to anyone, including me.', card);
      const decline = make('button', 'Not my phone — decline', card);
      decline.onclick = async () => {
        decline.disabled = true;
        try {
          const r = await request(`/mobile/pairing-approvals/${encodeURIComponent(a.deviceId)}/decline`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          notice.textContent = r.ok ? 'Declined. That phone cannot pair with this code.' : 'Could not decline. Refresh and try again.';
        } catch { notice.textContent = 'Could not reach the agent.'; }
        await refresh();
      };
    }
  };

  const renderDevices = (list, opts = {}) => {
    devices.replaceChildren();
    make('h3', 'Paired phones', devices);
    const { phones, browsers } = pairedGroups(list, { ...opts, personText });
    counts.paired = list.filter((d) => d && d.status === 'active').length;
    if (!phones.length) make('p', 'No phones are paired with this machine.', devices);
    for (const r of phones) deviceRow(r);
    if (!browsers.length) return;
    make('h3', 'Paired browsers', devices);
    for (const r of browsers) deviceRow(r);
  };

  /** One device: its name, one short detail line, and a Remove button that never wraps. */
  const deviceRow = (r) => {
    const row = make('div', undefined, devices); row.className = 'phone-row';
    const words = make('div', undefined, row); words.className = 'phone-row-words';
    make('span', r.name, words).className = 'phone-row-name';
    make('span', r.detail, words).className = 'phone-row-detail';
    if (!r.removable) return;
    const revoke = make('button', 'Remove', row);
    revoke.setAttribute('aria-label', `Remove ${r.name}`);
    revoke.onclick = async () => {
      if (!doc.defaultView?.confirm?.(`Remove this ${r.what}? It will stop reaching this agent at once.`)) return;
      revoke.disabled = true;
      try {
        const res = await request(`/mobile/devices/${encodeURIComponent(r.id)}/revoke`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        notice.textContent = res.ok ? 'Removed.' : `Could not remove that ${r.what}. Try again.`;
      } catch { notice.textContent = 'Could not reach the agent.'; }
      await refresh();
    };
  };

  async function refresh() {
    if (busy || stopped) return;
    busy = true;
    try {
      const a = await request('/mobile/pairing-approvals');
      if (a.status === 403) {
        unlockButton.hidden = false;
        counts.waiting = null; counts.locked = true;
        approvals.replaceChildren(); make('h3', 'Waiting to pair', approvals);
        make('p', 'Unlock with your PIN to see a waiting phone\'s code.', approvals);
      } else if (a.status === 503) {
        unlockButton.hidden = true; approvals.replaceChildren(); notice.textContent = 'Phone pairing is turned off on this agent.';
      } else if (a.ok) {
        unlockButton.hidden = true;
        const body = await a.json();
        renderApprovals(Array.isArray(body.approvals) ? body.approvals : []);
      } else { notice.textContent = 'Pairing codes are unavailable right now.'; }
      const d = await request('/mobile/devices');
      if (d.ok) {
        const body = await d.json();
        const list = Array.isArray(body.devices) ? body.devices : [];
        // Browser rows say when browsers are switched off on this agent (§4.9).
        let browserOff = false;
        if (list.some((x) => x && x.client === 'browser')) {
          try { const s = await request('/mobile/browser-devices/status'); browserOff = s.status === 503; } catch { browserOff = false; }
        }
        renderDevices(list, { browserOff });
      }
    } catch { notice.textContent = 'Could not reach the agent.'; }
    finally { busy = false; renderSummary(); }
  }

  return {
    start() { stopped = false; void refresh(); clearInterval(timer); timer = setInterval(() => { void refresh(); }, 10_000); },
    stop() { stopped = true; clearInterval(timer); timer = null; },
    refresh,
  };
}

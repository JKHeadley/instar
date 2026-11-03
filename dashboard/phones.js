/**
 * phones.js — the dashboard's Phones card (docs/specs/mobile-native-conversations.md §4.4).
 *
 * On an agent with no Telegram owner, a phone that opens a pairing link waits for a 6-digit
 * code that is shown HERE, only after a PIN unlock (the server refuses the code to anything but a
 * dashboard operator session). The operator types the code into the Instar app, or taps
 * "Not my phone" to decline. Below that, the paired phones on this machine, each revocable.
 *
 * Every dynamic value reaches the DOM through textContent; nothing is rendered as HTML. The code
 * lives only in the server's memory and in this page while it is open; nothing is stored.
 */

import { renderGlance } from './glance.js';

/**
 * The glance (F10/F11): one plain headline and two tiles. Fixed prose plus counts only — no
 * phone name or code reaches the front layer; those live behind the tiles.
 */
export function phonesGlanceSpec({ waiting = null, paired = null, locked = false } = {}, activate = {}) {
  const headline = locked ? 'Unlock with your PIN to see a phone that is waiting to pair.'
    : waiting > 0 ? `${waiting === 1 ? 'A phone is' : `${waiting} phones are`} waiting to pair. Open Waiting to see the code.`
    : 'No phone is waiting to pair.';
  return { headline, tiles: [
    { key: 'waiting', label: 'Waiting to pair', value: waiting === null ? 'Unknown' : String(waiting), tone: waiting > 0 ? 'warn' : undefined, onActivate: activate.waiting },
    { key: 'paired', label: 'Paired phones', value: paired === null ? 'Unknown' : String(paired), onActivate: activate.paired },
  ] };
}

const STATUS = { pending: 'Waiting to confirm', active: 'Paired', revoked: 'Removed', declined: 'Declined', expired: 'Expired' };

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
  const devices = make('section'); devices.setAttribute('aria-label', 'Paired phones');
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
      make('p', `${a.deviceName || 'A phone'}${a.label ? ` (${a.label})` : ''} is waiting · ${minutesLeft(a.expiresAt, now())}`, card);
      if (a.fingerprint) make('p', `Phone key: ${a.fingerprint}. The app shows the same key; check they match.`, card);
      const code = make('p', prettyCode(a.code), card); code.className = 'phone-code'; code.setAttribute('aria-label', 'Confirmation code');
      make('p', 'Type this code into the Instar app on that phone. Never send it to anyone, including me.', card);
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

  const renderDevices = (list) => {
    devices.replaceChildren();
    make('h3', 'Paired phones', devices);
    const shown = list.filter((d) => d.status === 'active' || d.status === 'pending');
    counts.paired = list.filter((d) => d.status === 'active').length;
    if (!shown.length) { make('p', 'No phones are paired with this machine.', devices); return; }
    for (const d of shown) {
      const row = make('div', undefined, devices); row.className = 'phone-row';
      make('p', `${d.deviceName || 'Unnamed phone'} · ${STATUS[d.status] || d.status}${d.approvedAt ? ` since ${new Date(d.approvedAt).toLocaleDateString()}` : ''}`, row);
      if (d.status === 'active') {
        const revoke = make('button', 'Remove this phone', row);
        revoke.onclick = async () => {
          if (!doc.defaultView?.confirm?.('Remove this phone? It will stop reaching this agent at once.')) return;
          revoke.disabled = true;
          try {
            const r = await request(`/mobile/devices/${encodeURIComponent(d.id)}/revoke`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            notice.textContent = r.ok ? 'Removed.' : 'Could not remove that phone. Try again.';
          } catch { notice.textContent = 'Could not reach the agent.'; }
          await refresh();
        };
      }
    }
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
      if (d.ok) { const body = await d.json(); renderDevices(Array.isArray(body.devices) ? body.devices : []); }
    } catch { notice.textContent = 'Could not reach the agent.'; }
    finally { busy = false; renderSummary(); }
  }

  return {
    start() { stopped = false; void refresh(); clearInterval(timer); timer = setInterval(() => { void refresh(); }, 10_000); },
    stop() { stopped = true; clearInterval(timer); timer = null; },
    refresh,
  };
}

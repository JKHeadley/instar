// The pairing code page (docs/specs/dashboard-console-default-and-pair-page.md §3.2).
//
// SAFETY CONTRACT
// - A code is shown only after a PIN unlock made on THIS page load. The Bearer token and the
//   operator session live in page memory only; nothing is written to localStorage or
//   sessionStorage, and a refused PIN, a 403 or session expiry wipes every code from the page.
// - Every dynamic value reaches the DOM through textContent. No innerHTML anywhere.
// - The page is served with a strict Content-Security-Policy (no inline script, nothing
//   third-party); keep it that way: no inline handlers, no style attributes, no external URLs.

import { deviceFromHash, shownApprovals, prettyCode, copyText, waitingLine, waitingHeadline, approveHint, browserWords } from './pair-model.js';

const POLL_MS = 10_000;
const MAX_FAILURES = 5;
const REQUEST_MS = 15_000;   // one authenticated call never holds the page longer than this
const CLOCK_MARGIN_MS = 5_000; // network transit and the Date header's one-second precision
const STATUS_WORDS = { pending: 'Waiting to confirm', active: 'Paired' };

export function mountPairPage(doc, {
  fetchFn = (...a) => fetch(...a),
  location: loc = doc.defaultView.location,
  // Monotonic where available, so a clock change on the phone moves no deadline.
  now = () => { const p = doc.defaultView.performance; return p && typeof p.now === 'function' && p.timeOrigin ? p.timeOrigin + p.now() : Date.now(); },
  clipboard = doc.defaultView.navigator && doc.defaultView.navigator.clipboard,
  confirmFn = (q) => doc.defaultView.confirm(q),
  setTimer = (fn, ms) => doc.defaultView.setInterval(fn, ms),
  clearTimer = (t) => doc.defaultView.clearInterval(t),
  setDeadline = (fn, ms) => doc.defaultView.setTimeout(fn, ms),
  clearDeadline = (t) => doc.defaultView.clearTimeout(t),
  setRequestTimer = (fn, ms) => doc.defaultView.setTimeout(fn, ms),
  clearRequestTimer = (t) => doc.defaultView.clearTimeout(t),
} = {}) {
  const root = doc.getElementById('pair-root') || doc.body;
  const make = (tag, opts = {}, parent) => {
    const el = doc.createElement(tag);
    if (opts.text !== undefined) el.textContent = String(opts.text);
    if (opts.cls) el.className = opts.cls;
    if (opts.type) el.type = opts.type;
    for (const [k, v] of Object.entries(opts.attrs || {})) el.setAttribute(k, v);
    if (parent) parent.append(el);
    return el;
  };

  let auth = null;           // { token, session, expiresAt } — page memory only
  let timer = null;
  let deadline = null;       // one-shot: wipes the page when the operator session runs out
  let failures = 0;
  let busy = false;
  let again = false;
  let gen = 0;              // bumped by every reset         // a refresh asked for while one was running: run once more after it
  let wanted = deviceFromHash(loc.hash);
  const SESSION_MS = 15 * 60_000;

  root.replaceChildren();
  const head = make('header', { cls: 'pair-head' }, root);
  make('h1', { text: 'Pair a phone with this agent' }, head);
  make('p', { cls: 'pair-host', text: loc.host, attrs: { 'aria-label': 'This page’s address' } }, head);
  make('p', { cls: 'pair-hint', text: 'Only type your PIN here if this is your agent’s usual address.' }, head);
  const body = make('main', { cls: 'pair-body' }, root);
  const status = make('p', { cls: 'pair-status', attrs: { role: 'status', 'aria-live': 'polite' } }, root);
  const foot = make('p', { cls: 'pair-foot' }, root);
  const back = make('a', { text: 'Back to the dashboard', attrs: { href: '/dashboard' } }, foot);
  void back;

  // The two calls made before there is a session (unlock-check, unlock): same time limit, body included.
  async function plain(url, options = {}) {
    let fail = () => {};
    const timedOut = new Promise((_, reject) => { fail = () => reject(new Error('timeout')); });
    const t = setRequestTimer(() => fail(), REQUEST_MS);
    try {
      return await Promise.race([(async () => {
        const r = await fetchFn(url, { cache: 'no-store', ...options });
        return { ok: r.ok, status: r.status, headers: r.headers, data: await r.json().catch(() => ({})) };
      })(), timedOut]);
    } finally { clearRequestTimer(t); }
  }

  function stopPolling() { if (timer !== null) { clearTimer(timer); timer = null; } }

  // The one reset: credentials, every rendered code and copy button, timers. Runs on a refused
  // session (403), at the session deadline (even while hidden or not polling), and on return to a
  // page whose session ran out meanwhile.
  function forget(message) {
    auth = null; stopPolling(); failures = 0; again = false;
    gen++; busy = false; pairedBusy = false; // a refresh still unwinding from the old session can no longer hold the page
    for (const e of [...inflight]) e.abort();
    inflight.clear();
    if (deadline !== null) { clearDeadline(deadline); deadline = null; }
    body.replaceChildren(); status.textContent = '';
    showPin(message);
  }
  const EXPIRED = 'Your unlock ran out. Type your PIN again.';
  doc.addEventListener('visibilitychange', () => {
    if (auth && now() >= auth.expiresAt) forget(EXPIRED);
  });

  async function showPin(message) {
    body.replaceChildren();
    let check = { accepted: true };
    try {
      const r = await plain('/dashboard/unlock-check');
      if (r.ok && r.data && r.data.accepted === false) check = r.data;
    } catch { /* unreadable or slow check: offer the box; the server still decides */ }
    if (auth) return; // unlocked meanwhile
    body.replaceChildren();
    if (check.accepted === false) {
      make('p', { text: typeof check.reason === 'string' ? check.reason : 'Your PIN cannot be accepted on this address.' }, body);
      if (typeof check.secureUrl === 'string' && /^https:\/\//i.test(check.secureUrl)) {
        try {
          const u = new URL(check.secureUrl);
          make('a', { cls: 'pair-button', text: 'Open the secure address', attrs: { href: `${u.origin}/dashboard/pair${loc.hash || ''}` } }, body);
        } catch { /* malformed: no link */ }
      }
      return;
    }
    const form = make('form', { cls: 'pair-pin' }, body);
    make('label', { text: 'Dashboard PIN', attrs: { for: 'pair-pin-input' } }, form);
    const input = make('input', { attrs: { id: 'pair-pin-input', type: 'password', inputmode: 'numeric', autocomplete: 'off', maxlength: '12' } }, form);
    const go = make('button', { cls: 'pair-button', text: 'Show the code', type: 'submit' }, form);
    const err = make('p', { cls: 'pair-error', text: message || '', attrs: { role: 'alert' } }, form);
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const pin = input.value;
      if (!pin) { err.textContent = 'Type your PIN.'; return; }
      go.disabled = true; err.textContent = '';
      try {
        const r = await plain('/dashboard/unlock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }) });
        input.value = '';
        const d = r.data || {};
        if (!r.ok || typeof d.token !== 'string' || typeof d.operatorSessionToken !== 'string') {
          err.textContent = d && d.error ? `${d.error}${typeof d.attemptsRemaining === 'number' ? ` · ${d.attemptsRemaining} tries left` : ''}` : 'That did not work. Try again.';
          go.disabled = false; return;
        }
        // The session's remaining life, measured on the server's clock (its Date header), so a
        // phone clock that runs fast or slow neither locks the page nor keeps a code too long.
        const serverExp = Date.parse(d.operatorSessionExpiresAt);
        const serverNow = Date.parse(r.headers && typeof r.headers.get === 'function' ? r.headers.get('Date') : '');
        const life = Number.isFinite(serverExp) && Number.isFinite(serverNow) ? serverExp - serverNow : SESSION_MS;
        auth = { token: d.token, session: d.operatorSessionToken, expiresAt: now() + Math.min(SESSION_MS, Math.max(0, life - CLOCK_MARGIN_MS)) };
        if (deadline !== null) clearDeadline(deadline);
        deadline = setDeadline(() => { deadline = null; if (auth) forget(EXPIRED); }, Math.max(0, auth.expiresAt - now()));
        await refresh();
        stopPolling();
        if (auth) timer = setTimer(() => { if (doc.visibilityState !== 'hidden') void refresh(); }, POLL_MS);
      } catch { input.value = ''; err.textContent = 'The agent did not answer. Try again.'; go.disabled = false; }
    });
    try { input.focus(); } catch { /* not focusable in this environment */ }
  }

  // ── Authenticated calls ──────────────────────────────────────────────────────────────────
  // One rule for every call made with the session: bound to the session it was made under,
  // bounded in time, cancelled by the reset, and any 403 runs the reset.
  const inflight = new Set();
  class SessionGone extends Error {}
  async function request(url, options = {}) {
    const mine = auth;
    if (!mine) throw new SessionGone();
    let abort = () => {};
    const aborted = new Promise((_, reject) => { abort = () => reject(new Error('aborted')); });
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const entry = { abort: () => { if (ctl) ctl.abort(); abort(); } };
    inflight.add(entry);
    const t = setRequestTimer(entry.abort, REQUEST_MS);
    try {
      // Headers AND body inside the same time limit and cancellation; the caller gets parsed data.
      const out = await Promise.race([(async () => {
        const r = await fetchFn(url, {
          ...options, cache: 'no-store', ...(ctl ? { signal: ctl.signal } : {}),
          headers: { Authorization: `Bearer ${mine.token}`, 'X-Instar-Operator-Session': mine.session, ...(options.headers || {}) },
        });
        const data = r.status === 403 ? null : await r.json().catch(() => null);
        return { status: r.status, ok: r.ok, data };
      })(), aborted]);
      // Only the live session that made the call, before its deadline, may use the answer.
      if (auth !== mine || now() >= mine.expiresAt) throw new SessionGone();
      if (out.status === 403) { forget(EXPIRED); throw new SessionGone(); }
      return out;
    } finally { clearRequestTimer(t); inflight.delete(entry); }
  }
  const gone = (e) => e instanceof SessionGone || !auth;

  // ── Layout: the waiting phones first, the paired phones below, filled independently ────────
  const waitingBox = doc.createElement('section'); waitingBox.setAttribute('aria-label', 'Phones waiting to pair');
  const pairedBox = doc.createElement('section'); pairedBox.className = 'pair-paired'; pairedBox.setAttribute('aria-label', 'Paired phones');
  let lastData = null;
  function ensureLayout() {
    if (body.contains(waitingBox)) return;
    waitingBox.replaceChildren(); pairedBox.replaceChildren();
    make('h2', { text: 'Paired phones' }, pairedBox);
    make('p', { text: 'Reading the paired phones…' }, pairedBox);
    body.replaceChildren(waitingBox, pairedBox);
  }

  async function refresh() {
    if (!auth) return;
    if (busy) { again = true; return; }
    if (now() >= auth.expiresAt) { forget(EXPIRED); return; }
    busy = true;
    const myGen = gen; // a refresh belongs to the unlock that started it
    try {
      const a = await request('/mobile/pairing-approvals');
      if (a.status === 503) { body.replaceChildren(); make('p', { text: 'Phone pairing is turned off on this agent.' }, body); failures = 0; return; }
      if (!a.ok || !a.data) throw new Error(`approvals ${a.status}`);
      const data = a.data;
      failures = 0; status.textContent = '';
      lastData = data;
      renderWaiting(data); // the code shows now; the paired-phones read runs on its own
      void refreshPaired();
    } catch (e) {
      if (gone(e)) return;
      failures++;
      if (failures >= MAX_FAILURES) {
        stopPolling();
        status.replaceChildren();
        make('span', { text: 'Lost contact with the agent. ' }, status);
        const retry = make('button', { cls: 'pair-link-button', text: 'Retry', type: 'button' }, status);
        retry.addEventListener('click', () => {
          failures = 0; status.textContent = '';
          void refresh();
          stopPolling();
          timer = setTimer(() => { if (doc.visibilityState !== 'hidden') void refresh(); }, POLL_MS);
        });
      } else status.textContent = 'Could not reach the agent; trying again.';
    } finally {
      if (gen === myGen) {
        busy = false;
        if (again) { again = false; if (auth) void refresh(); }
      }
    }
  }

  // The paired-phones list: its own read, never holding up the codes above it.
  let pairedBusy = false;
  async function refreshPaired() {
    if (!auth || pairedBusy) return;
    pairedBusy = true;
    const myGen = gen;
    try {
      const d = await request('/mobile/devices');
      const list = d.ok && d.data && Array.isArray(d.data.devices) ? d.data.devices : null;
      // Browser rows say when browsers are switched off on this agent (§4.9).
      let browserOff = false;
      if (list && list.some((x) => x && x.client === 'browser')) {
        try { const s = await request('/mobile/browser-devices/status'); browserOff = s.status === 503; } catch { browserOff = false; }
      }
      renderPaired(list, { browserOff });
    } catch (e) { if (!gone(e)) renderPaired(null); }
    finally { if (gen === myGen) pairedBusy = false; }
  }

  // Taps on the page's buttons: a reset deadline first, then the call; the result is shown only
  // while the session that made it is still the live one.
  async function act(path, done, failed, onDone) {
    if (!auth || now() >= auth.expiresAt) { forget(EXPIRED); return; }
    let message;
    try {
      const r = await request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      // A refusal's own plain reason (mobile-pairing-approve §3.3) beats a general sentence.
      message = r.ok ? done : (r.data && typeof r.data.detail === 'string' ? r.data.detail : failed);
      if (r.ok && onDone) onDone();
    } catch (e) { if (gone(e)) return; message = 'Could not reach the agent.'; }
    await refresh();
    // After the refresh, which clears the status line on a good read: the answer must stay readable.
    if (auth) status.textContent = message;
  }
  // Phones approved or declined on this page: never drawn again, even by a read that started before the decline.
  const declined = new Set();

  function renderWaiting(data) {
    ensureLayout();
    const approvals = Array.isArray(data && data.approvals) ? data.approvals : [];
    const { list, missing } = shownApprovals(approvals.filter((x) => x && !declined.has(x.deviceId)), wanted);
    waitingBox.replaceChildren();
    make('h2', { text: waitingHeadline({ approval: data && data.approval, shown: list, missing }) }, waitingBox);
    if (missing && approvals.length) {
      // Same page, same unlock: drop the fragment in place instead of reloading (a reload would ask for the PIN again).
      const all = make('button', { cls: 'pair-link-button', text: 'Show every waiting phone', type: 'button' }, waitingBox);
      all.addEventListener('click', () => {
        wanted = null;
        try { doc.defaultView.history.replaceState(null, '', loc.pathname); } catch { /* history unavailable */ }
        if (lastData && auth) renderWaiting(lastData);
      });
    }
    for (const a of list) {
      const card = make('div', { cls: 'pair-card' }, waitingBox);
      make('p', { cls: 'pair-device', text: waitingLine(a, now()) }, card);
      // Approve instead of a code (mobile-pairing-approve §3.3): the same unlock, no new PIN question.
      if (a.canApprove) {
        make('p', { cls: 'pair-fp', text: approveHint(a.fingerprint) }, card);
        const approve = make('button', { cls: 'pair-button', text: 'Approve this phone', type: 'button' }, card);
        approve.addEventListener('click', () => {
          approve.disabled = true;
          void act(`/mobile/pairing-approvals/${encodeURIComponent(a.deviceId)}/approve`, `Approved. That phone is paired. If the app still shows a code box, type ${prettyCode(a.code)} to finish.`, 'Could not approve. Try again.',
            () => { declined.add(a.deviceId); if (lastData && auth) renderWaiting(lastData); });
        });
        make('p', { text: 'If the app asks for a code instead:' }, card);
      }
      const code = make('p', { cls: 'pair-code', text: prettyCode(a.code), attrs: { 'aria-label': 'Confirmation code' } }, card);
      const copy = make('button', { cls: 'pair-button', text: 'Copy', type: 'button' }, card);
      const copied = make('span', { cls: 'pair-copied', attrs: { role: 'status' } }, card);
      copy.addEventListener('click', async () => {
        if (!auth || now() >= auth.expiresAt) { forget(EXPIRED); return; }
        try {
          if (!clipboard || typeof clipboard.writeText !== 'function') throw new Error('no clipboard');
          await clipboard.writeText(copyText(a.code));
          copied.textContent = 'Copied';
        } catch {
          try {
            const range = doc.createRange(); range.selectNodeContents(code);
            const sel = doc.defaultView.getSelection(); sel.removeAllRanges(); sel.addRange(range);
          } catch { /* selection unavailable */ }
          copied.textContent = 'Press and hold the code to copy it.';
        }
      });
      make('p', { text: 'Paste it into the Instar app on that phone. Never send it to anyone, including me.' }, card);
      if (a.fingerprint && !a.canApprove) make('p', { cls: 'pair-fp', text: `Phone key: ${a.fingerprint}. The app shows the same key; check they match.` }, card);
      const decline = make('button', { cls: 'pair-link-button', text: 'Not my phone — decline', type: 'button' }, card);
      decline.addEventListener('click', () => {
        decline.disabled = true;
        void act(`/mobile/pairing-approvals/${encodeURIComponent(a.deviceId)}/decline`, 'Declined. That phone cannot pair with this code.', 'Could not decline. Try again.',
          () => { declined.add(a.deviceId); if (lastData && auth) renderWaiting(lastData); });
      });
    }
  }

  function renderPaired(devices, opts = {}) {
    ensureLayout();
    pairedBox.replaceChildren();
    make('h2', { text: 'Paired phones' }, pairedBox);
    if (devices === null) { make('p', { text: 'Could not read the paired phones.' }, pairedBox); return; }
    const shown = devices.filter((d) => d && (d.status === 'active' || d.status === 'pending'));
    if (!shown.length) { make('p', { text: 'No phones are paired with this machine.' }, pairedBox); return; }
    for (const d of shown) {
      const row = make('div', { cls: 'pair-row' }, pairedBox);
      const isBrowser = d.client === 'browser';
      const extra = browserWords(d, opts);
      make('span', { text: `${d.deviceName || (isBrowser ? 'Unnamed browser' : 'Unnamed phone')} · ${STATUS_WORDS[d.status] || d.status}${extra ? ` · ${extra}` : ''}` }, row);
      if (d.status !== 'active') continue;
      const what = isBrowser ? 'browser' : 'phone';
      const remove = make('button', { cls: 'pair-link-button', text: `Remove this ${what}`, type: 'button' }, row);
      remove.addEventListener('click', () => {
        if (!confirmFn(`Remove this ${what}? It will stop reaching this agent at once.`)) return;
        remove.disabled = true;
        void act(`/mobile/devices/${encodeURIComponent(d.id)}/revoke`, 'Removed.', `Could not remove that ${what}. Try again.`, () => { void refreshPaired(); });
      });
    }
  }

  void showPin();
  return { refresh, forget, stop: stopPolling, isUnlocked: () => Boolean(auth) };
}

// Boot in a browser; tests import mountPairPage and drive it themselves.
if (typeof document !== 'undefined' && document.getElementById && document.getElementById('pair-root')) {
  mountPairPage(document);
}

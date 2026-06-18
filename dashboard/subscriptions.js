// Subscriptions tab — a read surface for the multi-account Subscription & Auth
// pool: per-account live quota bars (5h / weekly + reset countdown), status, and
// the Pending Logins panel (device codes / verification URLs awaiting approval,
// with TTL). Spec: docs/specs/_drafts/subscription-auth-standard-master-spec.md.
//
// Browser-native ESM (no build step; served at /dashboard/subscriptions.js and
// loaded by index.html via <script type="module">). The pure functions are
// exported so the 3-tier jsdom tests exercise the SHIPPED code, not a copy; the
// controller is attached to window.Subscriptions so index.html drives start/stop
// on tab activation.
//
// Load-bearing safety contract (mirrors the Process Health tab §4.6): every
// dynamic value flows through sanitizeForDisplay before the DOM; all DOM writes
// are textContent only (never innerHTML); the only dynamic ATTRIBUTE written is a
// quota-bar width, set from a clamped NUMBER (0–100) — never a string from data.
// No verification URL is ever rendered as a live href (defense-in-depth): it is
// shown as sanitized TEXT for the operator to copy.

const CAPS = { label: 64, code: 48, url: 320, summary: 240 };

// Structural presentation-glyph class (NFKC-fold THEN strip), identical to the
// Process Health tab: \p{So} + arrows + geometric + box-drawing + dingbats +
// variation-selectors + bullet/middot — so a confusable can't impersonate chrome.
const CHROME_GLYPH_RE = new RegExp(
  '[\\p{So}\\u2190-\\u21FF\\u25A0-\\u25FF\\u2500-\\u257F\\u2700-\\u27BF\\uFE00-\\uFE0F\\u2022\\u00B7\\u2027\\u2043]',
  'gu',
);
const CONTROL_RE = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F]', 'g');
const BIDI_RE = new RegExp('[\\u202A-\\u202E\\u2066-\\u2069]', 'g');

/** Sanitize a dynamic value before it touches the DOM (see contract above). */
export function sanitizeForDisplay(value, fieldKind = 'summary') {
  let s = value == null ? '' : String(value);
  s = s.normalize('NFKC');
  s = s.replace(CONTROL_RE, '');
  s = s.replace(BIDI_RE, '');
  s = s.replace(/\n{2,}/g, '\n').replace(/[ \t]{5,}/g, '    ');
  s = s.replace(CHROME_GLYPH_RE, '');
  s = capGraphemes(s, CAPS[fieldKind] ?? CAPS.summary);
  return s;
}

function capGraphemes(s, max) {
  if (s.length <= max) return s;
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    const arr = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s), (x) => x.segment);
    if (arr.length <= max) return s;
    return arr.slice(0, max - 1).join('') + '…';
  }
  let cut = max - 1;
  const c = s.charCodeAt(cut - 1);
  if (c >= 0xd800 && c <= 0xdbff) cut -= 1;
  return s.slice(0, cut) + '…';
}

/** Clamp a utilization value to an integer 0–100 (the only dynamic attribute). */
export function clampPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

const STATUS_WORDS = {
  active: 'Active',
  warming: 'Warming up',
  'rate-limited': 'At its limit',
  'needs-reauth': 'Needs sign-in',
  disabled: 'Disabled',
};
export function friendlyStatus(status) {
  return STATUS_WORDS[typeof status === 'string' ? status : ''] || 'Unknown';
}

const PROVIDER_WORDS = { anthropic: 'Claude', openai: 'Codex', 'github-copilot': 'Copilot', google: 'Gemini' };
export function friendlyProvider(provider) {
  return PROVIDER_WORDS[typeof provider === 'string' ? provider : ''] || sanitizeForDisplay(provider, 'label');
}

/** Human countdown to a reset/expiry instant: "resets in 2h 15m" / "expired". */
export function countdown(iso, now = Date.now(), { expiredWord = 'expired' } = {}) {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return '';
  const sec = Math.floor((t - now) / 1000);
  if (sec <= 0) return expiredWord;
  const hr = Math.floor(sec / 3600);
  const min = Math.floor((sec % 3600) / 60);
  if (hr >= 24) { const d = Math.floor(hr / 24); return `${d}d ${hr % 24}h`; }
  if (hr >= 1) return `${hr}h ${min}m`;
  if (min >= 1) return `${min}m`;
  return `${sec}s`;
}

/** A coarse "N ago" for a PAST ISO timestamp (token-refresh recency). '' if invalid. */
export function relativeAge(iso, now = Date.now()) {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return '';
  const sec = Math.floor((now - t) / 1000);
  if (sec < 0) return 'just now';
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

// ── DOM helpers (textContent ONLY — never innerHTML) ────────────────────────
function el(doc, tag, cls, text) {
  const node = doc.createElement(tag);
  if (cls) node.setAttribute('class', cls); // static literal
  if (text != null) node.textContent = text; // dynamic text → textContent ONLY
  return node;
}

/** A labelled quota bar. `pct` is clamped to a 0–100 NUMBER before it reaches the
 *  only dynamic attribute (style width); the percent text is also from that number. */
export function quotaBar(doc, label, pct, resetIso, now = Date.now()) {
  const wrap = el(doc, 'div', 'sub-quota');
  const used = clampPct(pct);
  const head = el(doc, 'div', 'sub-quota-head');
  head.appendChild(el(doc, 'span', 'sub-quota-label', sanitizeForDisplay(label, 'label')));
  const resetTxt = resetIso ? countdown(resetIso, now, { expiredWord: 'resetting' }) : '';
  head.appendChild(el(doc, 'span', 'sub-quota-pct', `${used}% used${resetTxt ? ` · resets in ${resetTxt}` : ''}`));
  wrap.appendChild(head);
  const track = el(doc, 'div', 'sub-quota-track');
  const fill = el(doc, 'div', 'sub-quota-fill');
  fill.style.width = `${used}%`; // safe: `used` is a clamped integer
  track.appendChild(fill);
  wrap.appendChild(track);
  return wrap;
}

/** Per-account rows: nickname, status, provider·framework, 5h + weekly quota bars.
 *  `inUseAccountId` (optional) is the account the agent is CURRENTLY running on —
 *  that card gets an "In use" marker so "active" (healthy) reads distinct from
 *  "actually running right now". */
export function renderAccounts(doc, target, accounts, now = Date.now(), inUseAccountId = null) {
  if (!target) return;
  target.replaceChildren();
  if (!Array.isArray(accounts) || accounts.length === 0) {
    target.appendChild(el(doc, 'div', 'sub-empty', 'No subscription accounts enrolled yet.'));
    return;
  }
  for (const a of accounts) {
    const inUse = !!(inUseAccountId && a && a.id === inUseAccountId);
    const card = el(doc, 'div', inUse ? 'sub-account sub-account-inuse' : 'sub-account');
    const head = el(doc, 'div', 'sub-account-head');
    head.appendChild(el(doc, 'span', 'sub-account-nick', sanitizeForDisplay(a && a.nickname, 'label')));
    if (inUse) head.appendChild(el(doc, 'span', 'sub-account-inuse-badge', '● In use now'));
    head.appendChild(el(doc, 'span', 'sub-account-status', friendlyStatus(a && a.status)));
    card.appendChild(head);
    card.appendChild(el(doc, 'div', 'sub-account-meta',
      `${friendlyProvider(a && a.provider)} · ${sanitizeForDisplay(a && a.framework, 'label')}`));
    if (a && a.email) {
      card.appendChild(el(doc, 'div', 'sub-account-email', sanitizeForDisplay(a.email, 'label')));
    }
    const q = (a && a.lastQuota) || null;
    if (q && (q.fiveHour || q.sevenDay)) {
      if (q.fiveHour) card.appendChild(quotaBar(doc, '5-hour', q.fiveHour.utilizationPct, q.fiveHour.resetsAt, now));
      if (q.sevenDay) card.appendChild(quotaBar(doc, 'Weekly', q.sevenDay.utilizationPct, q.sevenDay.resetsAt, now));
    } else {
      card.appendChild(el(doc, 'div', 'sub-account-noquota', 'No quota reading yet.'));
    }
    // Token health: when the poller silently refreshed the access token from the
    // refresh token, show it — so a routine access-token expiry reads as healthy
    // (auto-handled) rather than looking like a re-auth event.
    const refAge = a && a.lastRefreshAt ? relativeAge(a.lastRefreshAt, now) : null;
    if (refAge) {
      card.appendChild(el(doc, 'div', 'sub-account-refresh', `Token auto-refreshed ${refAge}`));
    }
    target.appendChild(card);
  }
}

/**
 * Account Follow-Me — the ONE-TAP Approve card (ws52-operator-tap-not-text Part A).
 * Renders a scan consent-offer as a plain-language card the operator APPROVES with a
 * single PIN tap — never a JSON/fingerprint paste (the 2026-06-17 operator feedback:
 * "operators act in taps, not text"). All operator-facing values are sanitized TEXT;
 * the only machine-readable data on the card are the NON-SENSITIVE account/target ids
 * as data-* attributes (used to find the offer on Approve). The agent fingerprints
 * (FD2) are NEVER placed in the DOM — they live in the controller's offer state and
 * are sent server-side at POST time. By construction this card carries zero raw
 * technical text, so it PASSES the arm-1 operator-surface gate.
 */
export function renderFollowMeApproveCard(doc, offer) {
  const card = el(doc, 'div', 'sub-followme-offer');
  // Non-sensitive identifiers, for the Approve handler to resolve the offer. NOT
  // operator-facing text; never a fingerprint/JSON.
  card.setAttribute('data-account-id', sanitizeForDisplay(offer && offer.accountId, 'label'));
  card.setAttribute('data-target-machine-id', sanitizeForDisplay(offer && offer.targetMachineId, 'label'));

  const machine = sanitizeForDisplay(offer && offer.machineNickname, 'label');
  const account = sanitizeForDisplay(offer && offer.accountLabel, 'label');
  card.appendChild(el(doc, 'div', 'sub-followme-headline',
    `Let ${machine} use your ${account} subscription`));
  card.appendChild(el(doc, 'div', 'sub-followme-sub',
    sanitizeForDisplay(offer && offer.expiryText, 'summary') || 'Authorizes this one setup, then expires.'));

  const pin = doc.createElement('input');
  pin.setAttribute('type', 'password');
  pin.setAttribute('class', 'sub-followme-pin');
  pin.setAttribute('placeholder', 'Your PIN'); // a PIN box, not a technical value
  pin.setAttribute('autocomplete', 'off');
  card.appendChild(pin);

  const approve = el(doc, 'button', 'sub-followme-approve', 'Approve');
  approve.setAttribute('data-followme-approve', '1');
  card.appendChild(approve);
  return card;
}

/** Render the list of follow-me consent offers as one-tap Approve cards (or nothing if none). */
export function renderFollowMeOffers(doc, target, offers) {
  if (!target) return;
  target.replaceChildren();
  if (!Array.isArray(offers) || offers.length === 0) return; // silent when nothing to offer
  target.appendChild(el(doc, 'div', 'sub-followme-title', 'Let another machine use a subscription'));
  for (const offer of offers) target.appendChild(renderFollowMeApproveCard(doc, offer));
}

/**
 * Build the /mandate/issue-for-machine payload from a tapped Approve card + the
 * held offers + the operator's PIN (ws52-operator-tap-not-text Part A). Pure: the
 * card carries only the non-sensitive account/target ids; the agent fingerprints
 * (FD2) come from the matched offer in controller state — the operator never typed
 * them. Returns the payload, or `{ error }` for a missing PIN, or null when the
 * card has no matching offer / the offer lacks its FD2 agent pair (fail-closed —
 * never POST an under-specified mandate request).
 */
export function buildFollowMeIssuePayload(card, offers, pinValue) {
  if (!card || typeof card.getAttribute !== 'function') return null;
  const accountId = card.getAttribute('data-account-id');
  const targetMachineId = card.getAttribute('data-target-machine-id');
  if (!accountId || !targetMachineId) return null;
  const offer = (Array.isArray(offers) ? offers : []).find(
    (o) => o && o.accountId === accountId && o.targetMachineId === targetMachineId,
  );
  if (!offer) return null; // unknown/stale card — never POST
  if (!Array.isArray(offer.agents) || offer.agents.length !== 2
      || offer.agents.some((a) => typeof a !== 'string' || !a)) {
    return null; // FD2 agent pair missing — fail-closed
  }
  const pin = typeof pinValue === 'string' ? pinValue.trim() : '';
  if (!pin) return { error: 'pin-required' };
  return { pin, accountId, targetMachineId, agents: [offer.agents[0], offer.agents[1]] };
}

/** Pending Logins panel: device code / verification URL (as TEXT) + TTL + reissues. */
export function renderPendingLogins(doc, target, logins, now = Date.now()) {
  if (!target) return;
  target.replaceChildren();
  if (!Array.isArray(logins) || logins.length === 0) {
    target.appendChild(el(doc, 'div', 'sub-empty', 'No logins waiting for approval.'));
    return;
  }
  for (const l of logins) {
    const row = el(doc, 'div', 'sub-pending');
    const head = el(doc, 'div', 'sub-pending-head');
    head.appendChild(el(doc, 'span', 'sub-pending-label', sanitizeForDisplay(l && l.label, 'label')));
    const ttl = l && l.ttlExpiresAt ? countdown(l.ttlExpiresAt, now) : '';
    head.appendChild(el(doc, 'span', 'sub-pending-ttl', ttl ? `expires in ${ttl}` : 'expired'));
    row.appendChild(head);
    // Flow heads-up (e.g. the Claude two-code sequence) — shown before the code so
    // the operator knows what to expect. Plain text, sanitized; never a live href.
    if (l && l.notice) {
      row.appendChild(el(doc, 'div', 'sub-pending-notice', sanitizeForDisplay(l.notice, 'summary')));
    }
    if (l && l.userCode) {
      row.appendChild(el(doc, 'div', 'sub-pending-code', `Code: ${sanitizeForDisplay(l.userCode, 'code')}`));
    }
    // Verification URL shown as TEXT for the operator to copy — never a live href.
    row.appendChild(el(doc, 'div', 'sub-pending-url', sanitizeForDisplay(l && l.verificationUrl, 'url')));
    const rc = l && Number(l.reissueCount);
    if (Number.isFinite(rc) && rc > 0) {
      row.appendChild(el(doc, 'div', 'sub-pending-reissue', `Re-issued ${rc} time${rc === 1 ? '' : 's'}`));
    }
    target.appendChild(row);
  }
}

export function renderDisabled(doc, els) {
  if (els && els.accounts) {
    els.accounts.replaceChildren(
      el(doc, 'div', 'sub-disabled', 'The subscription pool isn’t set up yet. Enroll an account to get started.'),
    );
  }
  if (els && els.pending) els.pending.replaceChildren();
}

// ── Controller (fetch /subscription-pool + /pending-logins, render) ─────────
const URLS = {
  accounts: '/subscription-pool',
  // scope=pool so a follow-me login created on ANOTHER machine (e.g. the Mac Mini) surfaces on the
  // operator's single dashboard (WS5.2 seam #3) — without it the device-code link never appears here.
  pending: '/subscription-pool/pending-logins?scope=pool',
  inUse: '/subscription-pool/in-use',
  scan: '/subscription-pool/follow-me/scan', // POST — follow-me consent offers (one-tap card)
  issue: '/mandate/issue-for-machine',       // POST (PIN-gated) — Approve issues the mandate
};

export function createController(opts) {
  const {
    doc,
    els = {},
    fetchImpl,
    now = () => Date.now(),
    cadenceMs = 30_000,
    schedule = (fn, ms) => setTimeout(fn, ms),
    cancel = (id) => clearTimeout(id),
  } = opts;

  const state = { timerId: null, active: false, inFlight: null, offers: [], approveWired: false };

  async function fetchJson(url, controller) {
    const resp = await fetchImpl(url, { signal: controller.signal });
    if (!resp.ok) throw new Error(`${url} ${resp.status}`);
    return resp.json();
  }

  // POST helper (follow-me scan + the PIN-gated issue both POST). Best-effort callers
  // catch their own failures so a follow-me hiccup never blanks the accounts list.
  async function postJson(url, body, controller) {
    const resp = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body == null ? undefined : JSON.stringify(body),
      signal: controller && controller.signal,
    });
    let json = null;
    try { json = await resp.json(); } catch { /* may be empty */ }
    return { ok: resp.ok, status: resp.status, json };
  }

  async function tick() {
    if (!state.active) return;
    if (state.inFlight) { try { state.inFlight.abort(); } catch { /* superseded */ } }
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : { signal: undefined, abort() {} };
    state.inFlight = controller;
    let accountsBody, pendingBody, inUseBody, scanBody;
    try {
      // in-use AND the follow-me scan are best-effort — their failure must not blank the
      // accounts list, so each is caught independently (in-use → "unknown"; scan → no card).
      [accountsBody, pendingBody, inUseBody, scanBody] = await Promise.all([
        fetchJson(URLS.accounts, controller),
        fetchJson(URLS.pending, controller),
        fetchJson(URLS.inUse, controller).catch(() => null),
        postJson(URLS.scan, {}, controller).then((r) => (r.ok ? r.json : null)).catch(() => null),
      ]);
    } catch {
      if (controller.signal && controller.signal.aborted) return;
      state.inFlight = null;
      reschedule();
      return;
    }
    if (controller.signal && controller.signal.aborted) return;
    state.inFlight = null;
    // Feature dark → both routes answer { enabled:false }. Show the friendly copy.
    if (accountsBody && accountsBody.enabled === false && pendingBody && pendingBody.enabled === false) {
      renderDisabled(doc, els);
      reschedule();
      return;
    }
    state.offers = scanBody && Array.isArray(scanBody.offered) ? scanBody.offered : [];
    render(accountsBody, pendingBody, inUseBody);
    reschedule();
  }

  function render(accountsBody, pendingBody, inUseBody) {
    const accounts = accountsBody && Array.isArray(accountsBody.accounts) ? accountsBody.accounts : [];
    const logins = pendingBody && Array.isArray(pendingBody.logins) ? pendingBody.logins : [];
    const inUseAccountId = inUseBody && inUseBody.activeAccountId ? inUseBody.activeAccountId : null;
    renderAccounts(doc, els.accounts, accounts, now(), inUseAccountId);
    renderPendingLogins(doc, els.pending, logins, now());
    // The one-tap follow-me Approve card(s) — rendered into els.followMe from the scan offers
    // (ws52-operator-tap-not-text Part A). Silent when there are none. The Approve click is wired
    // once (delegated) so re-renders never stack listeners.
    if (els.followMe) {
      renderFollowMeOffers(doc, els.followMe, state.offers);
      wireApprove();
    }
  }

  // Delegated, wired ONCE: an Approve tap reads the card's PIN, builds the issue-for-machine
  // payload from the held offers (FD2 agents resolved server-side — never typed), and POSTs the
  // PIN-gated mandate. The card carries only non-sensitive ids; the PIN is sent once, never stored.
  function wireApprove() {
    if (state.approveWired || !els.followMe) return;
    state.approveWired = true;
    els.followMe.addEventListener('click', (ev) => {
      const btn = ev.target && ev.target.closest ? ev.target.closest('[data-followme-approve]') : null;
      if (!btn || !els.followMe.contains(btn)) return;
      const card = btn.closest('.sub-followme-offer');
      if (!card) return;
      const pinInput = card.querySelector('.sub-followme-pin');
      const pinVal = pinInput ? pinInput.value : '';
      const payload = buildFollowMeIssuePayload(card, state.offers, pinVal);
      if (payload === null) { setCardStatus(card, 'Couldn’t prepare this request — please refresh.'); return; }
      if (payload.error === 'pin-required') { setCardStatus(card, 'Enter your PIN to approve.'); return; }
      setCardStatus(card, 'Approving…');
      btn.setAttribute('disabled', '1');
      void (async () => {
        try {
          const r = await postJson(URLS.issue, payload);
          if (r.ok) {
            setCardStatus(card, 'Approved — the machine is logging in now. Watch the “Logins waiting” panel below for the link to tap.');
            if (pinInput) pinInput.value = '';
          } else {
            const msg = r.json && (r.json.error || r.json.reason) ? (r.json.error || r.json.reason) : `failed (${r.status})`;
            setCardStatus(card, `Couldn’t approve: ${msg}`);
            btn.removeAttribute('disabled');
          }
        } catch (e) {
          setCardStatus(card, 'Couldn’t reach the server — try again.');
          btn.removeAttribute('disabled');
        }
      })();
    });
  }

  function setCardStatus(card, text) {
    let s = card.querySelector('.sub-followme-status');
    if (!s) { s = el(doc, 'div', 'sub-followme-status', ''); card.appendChild(s); }
    s.textContent = text;
  }

  function reschedule() {
    if (!state.active) return;
    if (state.timerId != null) cancel(state.timerId);
    state.timerId = schedule(() => { void tick(); }, cadenceMs);
  }

  function start() { if (state.active) return; state.active = true; void tick(); }
  function stop() {
    state.active = false;
    if (state.timerId != null) { cancel(state.timerId); state.timerId = null; }
    if (state.inFlight) { try { state.inFlight.abort(); } catch { /* ignore */ } state.inFlight = null; }
  }
  function onVisible() { if (!state.active) start(); }
  function onHidden() { stop(); }

  return { start, stop, onVisible, onHidden, tick, render, _state: state };
}

if (typeof window !== 'undefined') {
  window.Subscriptions = {
    createController, sanitizeForDisplay, renderAccounts, renderPendingLogins,
    renderFollowMeOffers, renderFollowMeApproveCard, buildFollowMeIssuePayload,
  };
}

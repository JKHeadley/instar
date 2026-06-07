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

/** Per-account rows: nickname, status, provider·framework, 5h + weekly quota bars. */
export function renderAccounts(doc, target, accounts, now = Date.now()) {
  if (!target) return;
  target.replaceChildren();
  if (!Array.isArray(accounts) || accounts.length === 0) {
    target.appendChild(el(doc, 'div', 'sub-empty', 'No subscription accounts enrolled yet.'));
    return;
  }
  for (const a of accounts) {
    const card = el(doc, 'div', 'sub-account');
    const head = el(doc, 'div', 'sub-account-head');
    head.appendChild(el(doc, 'span', 'sub-account-nick', sanitizeForDisplay(a && a.nickname, 'label')));
    head.appendChild(el(doc, 'span', 'sub-account-status', friendlyStatus(a && a.status)));
    card.appendChild(head);
    card.appendChild(el(doc, 'div', 'sub-account-meta',
      `${friendlyProvider(a && a.provider)} · ${sanitizeForDisplay(a && a.framework, 'label')}`));
    const q = (a && a.lastQuota) || null;
    if (q && (q.fiveHour || q.sevenDay)) {
      if (q.fiveHour) card.appendChild(quotaBar(doc, '5-hour', q.fiveHour.utilizationPct, q.fiveHour.resetsAt, now));
      if (q.sevenDay) card.appendChild(quotaBar(doc, 'Weekly', q.sevenDay.utilizationPct, q.sevenDay.resetsAt, now));
    } else {
      card.appendChild(el(doc, 'div', 'sub-account-noquota', 'No quota reading yet.'));
    }
    target.appendChild(card);
  }
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
  pending: '/subscription-pool/pending-logins',
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

  const state = { timerId: null, active: false, inFlight: null };

  async function fetchJson(url, controller) {
    const resp = await fetchImpl(url, { signal: controller.signal });
    if (!resp.ok) throw new Error(`${url} ${resp.status}`);
    return resp.json();
  }

  async function tick() {
    if (!state.active) return;
    if (state.inFlight) { try { state.inFlight.abort(); } catch { /* superseded */ } }
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : { signal: undefined, abort() {} };
    state.inFlight = controller;
    let accountsBody, pendingBody;
    try {
      [accountsBody, pendingBody] = await Promise.all([
        fetchJson(URLS.accounts, controller),
        fetchJson(URLS.pending, controller),
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
    render(accountsBody, pendingBody);
    reschedule();
  }

  function render(accountsBody, pendingBody) {
    const accounts = accountsBody && Array.isArray(accountsBody.accounts) ? accountsBody.accounts : [];
    const logins = pendingBody && Array.isArray(pendingBody.logins) ? pendingBody.logins : [];
    renderAccounts(doc, els.accounts, accounts, now());
    renderPendingLogins(doc, els.pending, logins, now());
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
  window.Subscriptions = { createController, sanitizeForDisplay, renderAccounts, renderPendingLogins };
}

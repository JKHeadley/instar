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
// Only render a verification URL as a TAPPABLE link when it is https AND points at a
// known provider sign-in host. Anything else falls back to plain text (preserves the
// "never make an arbitrary href clickable" intent while giving a real one-tap sign-in
// for the legitimate provider OAuth URLs).
const PROVIDER_LOGIN_HOSTS = ['claude.com', 'claude.ai', 'anthropic.com', 'openai.com', 'auth.openai.com', 'accounts.google.com', 'google.com'];
function trustedLoginUrl(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return null;
    const host = u.hostname.toLowerCase();
    return PROVIDER_LOGIN_HOSTS.some((h) => host === h || host.endsWith('.' + h)) ? u.href : null;
  } catch { return null; }
}

export function renderPendingLogins(doc, target, logins, now = Date.now()) {
  if (!target) return;
  target.replaceChildren();
  if (!Array.isArray(logins) || logins.length === 0) {
    target.appendChild(el(doc, 'div', 'sub-empty', 'No logins waiting for approval.'));
    return;
  }
  for (const l of logins) {
    const row = el(doc, 'div', 'sub-pending');
    // Non-sensitive identifiers for the code-submit handler (never a credential).
    row.setAttribute('data-login-id', sanitizeForDisplay(l && l.id, 'label'));
    if (l && (l.machineId || l.machineNickname)) row.setAttribute('data-machine-id', sanitizeForDisplay(l.machineId, 'label'));

    // Lead with a plain-language headline naming what to do + where (machine).
    const machine = sanitizeForDisplay(l && (l.machineNickname || l.machineId), 'label');
    const who = sanitizeForDisplay(l && l.label, 'label');
    const headline = machine
      ? `Sign in to finish setting up ${who} on ${machine}`
      : `Sign in to finish setting up ${who}`;
    row.appendChild(el(doc, 'div', 'sub-pending-headline', headline));

    // The PRIMARY action: one tappable "Sign in" link to the provider's own OAuth URL.
    // Falls back to copy-text only if the URL isn't a trusted provider sign-in host.
    const href = trustedLoginUrl(l && l.verificationUrl);
    if (href) {
      const a = doc.createElement('a');
      a.setAttribute('href', href);
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
      a.setAttribute('class', 'sub-pending-signin');
      a.textContent = 'Sign in';
      row.appendChild(a);
    } else if (l && l.verificationUrl) {
      row.appendChild(el(doc, 'div', 'sub-pending-url', sanitizeForDisplay(l.verificationUrl, 'url')));
    }

    // A device code (only some flows) — shown compactly under the button.
    if (l && l.userCode) {
      row.appendChild(el(doc, 'div', 'sub-pending-code', `Code: ${sanitizeForDisplay(l.userCode, 'code')}`));
    }

    // url-code-paste flow (Claude): after signing in, the provider hands the operator a
    // CODE to paste back. Give them a field for it right here — so it goes straight to the
    // machine doing the login (off-chat), not relayed by hand. (ws52-code-paste-back)
    if (l && l.kind === 'url-code-paste') {
      row.appendChild(el(doc, 'div', 'sub-pending-codehint', 'After you sign in, paste the code the page gives you here:'));
      const input = doc.createElement('input');
      input.setAttribute('type', 'text');
      input.setAttribute('class', 'sub-pending-code-input');
      input.setAttribute('placeholder', 'Paste your sign-in code');
      input.setAttribute('autocomplete', 'off');
      row.appendChild(input);
      const submit = el(doc, 'button', 'sub-pending-code-submit', 'Submit code');
      submit.setAttribute('data-submit-code', '1');
      row.appendChild(submit);
    }

    // One short secondary line: the TTL, and the flow notice only if present (trimmed).
    const ttl = l && l.ttlExpiresAt ? countdown(l.ttlExpiresAt, now) : '';
    if (ttl) row.appendChild(el(doc, 'div', 'sub-pending-ttl', `Link expires in ${ttl}`));
    if (l && l.notice) {
      row.appendChild(el(doc, 'div', 'sub-pending-notice', sanitizeForDisplay(l.notice, 'summary')));
    }
    // (No "re-issued N times" noise — it confused more than it informed.)
    target.appendChild(row);
  }
}

// ── Account × Machine matrix (account-machine-matrix spec) ─────────────────
// At-a-glance "which account is set up on which machine," with a one-tap "Set up"
// per empty cell that runs the whole sign-in IN the dashboard (PIN → mandate →
// enroll-start → paste the code). Pure renderer so the jsdom tests exercise the
// SHIPPED grid. Built ENTIRELY from already-shipped pool-scope reads (FD1): the
// matrix invents no account key — it pivots `(accountId, machineId)` rows.
//
// Inputs:
//   poolScope    = GET /subscription-pool?scope=pool body
//                  { accounts:[{id,email,status,machineId,machineNickname,remote}],
//                    pool:{ selfMachineId, failed:[{machineId,error}] } }
//   pendingScope = GET /subscription-pool/pending-logins?scope=pool body
//                  { logins:[{id,machineId,...}] }  (id === accountId for matrix enrollments)
//   transient    = optional client-side last-attempt map keyed `${accountId}::${machineId}`
//                  → { state:'held'|'cant-resolve' } (FD6 — known only to the client)

/** Pivot the pool-scope + pending-scope bodies into a grid model. Pure + testable. */
export function buildMatrixModel(poolScope, pendingScope, transient = {}) {
  const accountRows = (poolScope && Array.isArray(poolScope.accounts)) ? poolScope.accounts : [];
  const pendingRows = (pendingScope && Array.isArray(pendingScope.logins)) ? pendingScope.logins : [];
  const failed = (poolScope && poolScope.pool && Array.isArray(poolScope.pool.failed)) ? poolScope.pool.failed : [];
  const selfMachineId = (poolScope && poolScope.pool && poolScope.pool.selfMachineId) || null;
  const offlineMachineIds = new Set(failed.map((f) => f && f.machineId).filter(Boolean));

  // Columns = union of machines from account rows + failed (offline) machines. A failed
  // machine has NO account rows (pool-scope queries live, codex r3 #1) — so its column is
  // discovered from the failed list and rendered offline (never a fabricated per-account ✓).
  const machines = new Map(); // machineId → { machineId, nickname, offline }
  for (const a of accountRows) {
    const mid = a && a.machineId;
    if (!mid || offlineMachineIds.has(mid)) continue;
    if (!machines.has(mid)) machines.set(mid, { machineId: mid, nickname: (a.machineNickname || mid), offline: false });
  }
  for (const f of failed) {
    const mid = f && f.machineId;
    if (!mid) continue;
    if (!machines.has(mid)) machines.set(mid, { machineId: mid, nickname: mid, offline: true });
    else machines.get(mid).offline = true;
  }

  // Rows = union of account ids, displayed by email (FD8 — keyed by pool id, shown by email).
  const accounts = new Map(); // accountId → { accountId, email }
  for (const a of accountRows) {
    const id = a && a.id;
    if (!id) continue;
    if (!accounts.has(id)) accounts.set(id, { accountId: id, email: a.email || id });
    else if (!accounts.get(id).email && a.email) accounts.get(id).email = a.email;
  }
  // A pending matrix login can reference an account not yet in any pool row — surface its row too.
  for (const l of pendingRows) {
    const id = l && l.id;
    if (id && !accounts.has(id)) accounts.set(id, { accountId: id, email: id });
  }

  // (accountId, machineId) → active|needs-reauth, from a CURRENTLY-REACHABLE machine only.
  const cellStatus = new Map();
  for (const a of accountRows) {
    const mid = a && a.machineId;
    if (!a || !a.id || !mid || offlineMachineIds.has(mid)) continue;
    cellStatus.set(`${a.id}::${mid}`, a.status === 'needs-reauth' ? 'needs-reauth' : (a.status === 'active' ? 'active' : 'other'));
  }
  // (accountId, machineId) in-progress, correlated on (login.id === accountId, machineId) (FD6 r3 #2).
  const inProgress = new Set();
  for (const l of pendingRows) {
    if (l && l.id && l.machineId) inProgress.add(`${l.id}::${l.machineId}`);
  }

  const machineList = Array.from(machines.values());
  const accountList = Array.from(accounts.values());
  const cells = [];
  for (const acct of accountList) {
    const rowCells = [];
    for (const m of machineList) {
      const key = `${acct.accountId}::${m.machineId}`;
      let state;
      if (m.offline) state = 'offline';                              // whole column offline (FD6)
      else if (transient[key] && transient[key].state === 'held') state = 'held';
      else if (transient[key] && transient[key].state === 'cant-resolve') state = 'cant-resolve';
      else if (inProgress.has(key)) state = 'in-progress';
      else if (cellStatus.get(key) === 'active') state = 'active';
      else if (cellStatus.get(key) === 'needs-reauth') state = 'needs-reauth';
      else state = 'empty';                                          // → "Set up" button
      rowCells.push({ accountId: acct.accountId, machineId: m.machineId, state });
    }
    cells.push({ account: acct, cells: rowCells });
  }
  return { machines: machineList, accounts: accountList, rows: cells, selfMachineId };
}

const MATRIX_CELL_GLYPH = {
  active: '✓', 'needs-reauth': '⟳', 'in-progress': '◷', offline: '—', held: '⚠', 'cant-resolve': '✗',
};
const MATRIX_CELL_WORD = {
  active: 'Active', 'needs-reauth': 'Needs sign-in', 'in-progress': 'Signing in…',
  offline: 'Machine offline', held: 'Didn’t match — re-try', 'cant-resolve': 'Can’t set up', other: 'Set up',
};

/** Render the account × machine grid. `target` is replaced. Each empty (reachable) cell
 *  gets a "Set up" button carrying its (accountId, machineId) as data-* attributes for the
 *  controller's delegated tap handler. Offline columns are disabled; no state is fabricated. */
export function renderAccountMatrix(doc, target, poolScope, pendingScope, transient = {}) {
  if (!target) return;
  target.replaceChildren();
  const model = buildMatrixModel(poolScope, pendingScope, transient);
  if (model.accounts.length === 0 || model.machines.length === 0) {
    target.appendChild(el(doc, 'div', 'sub-empty', 'No accounts or machines to show yet.'));
    return;
  }
  const table = el(doc, 'table', 'sub-matrix');
  // Header row: blank corner + one column per machine.
  const thead = doc.createElement('thead');
  const hr = doc.createElement('tr');
  hr.appendChild(el(doc, 'th', 'sub-matrix-corner', ''));
  for (const m of model.machines) {
    const th = el(doc, 'th', m.offline ? 'sub-matrix-mach sub-matrix-off' : 'sub-matrix-mach',
      sanitizeForDisplay(m.nickname, 'label') + (m.offline ? ' (offline)' : ''));
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = doc.createElement('tbody');
  for (const row of model.rows) {
    const tr = doc.createElement('tr');
    tr.appendChild(el(doc, 'th', 'sub-matrix-acct', sanitizeForDisplay(row.account.email, 'label')));
    for (const c of row.cells) {
      const td = el(doc, 'td', `sub-matrix-cell sub-matrix-${c.state}`);
      if (c.state === 'empty' || c.state === 'held' || c.state === 'cant-resolve') {
        // An actionable cell → a "Set up" button (held/cant-resolve let the operator retry).
        const btn = el(doc, 'button', 'sub-matrix-setup', c.state === 'empty' ? 'Set up' : 'Retry');
        btn.setAttribute('data-matrix-setup', '1');
        btn.setAttribute('data-account-id', sanitizeForDisplay(c.accountId, 'label'));
        btn.setAttribute('data-machine-id', sanitizeForDisplay(c.machineId, 'label'));
        if (c.state !== 'empty') {
          td.appendChild(el(doc, 'div', 'sub-matrix-glyph', `${MATRIX_CELL_GLYPH[c.state]} ${MATRIX_CELL_WORD[c.state]}`));
        }
        td.appendChild(btn);
      } else {
        const word = c.state === 'offline' ? 'unknown' : MATRIX_CELL_WORD[c.state];
        const glyph = MATRIX_CELL_GLYPH[c.state] || '';
        td.appendChild(el(doc, 'span', 'sub-matrix-glyph', `${glyph} ${word}`.trim()));
        // An in-progress (◷) cell gets a tappable Cancel so a mis-tapped setup can be
        // reversed (abandon the login + tear down its pane). Emitted on the DURABLE
        // re-rendered cell (not just the live sign-in DOM) so it survives the poll loop.
        // The login id === accountId for a matrix login; the relay routes to self/peer.
        if (c.state === 'in-progress') {
          const cancelBtn = el(doc, 'button', 'sub-matrix-cancel', 'Cancel');
          cancelBtn.setAttribute('data-matrix-cancel', '1');
          cancelBtn.setAttribute('data-account-id', sanitizeForDisplay(c.accountId, 'label'));
          cancelBtn.setAttribute('data-machine-id', sanitizeForDisplay(c.machineId, 'label'));
          td.appendChild(cancelBtn);
        }
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  target.appendChild(table);
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
  submitCode: '/subscription-pool/follow-me/submit-code', // POST — paste-back the sign-in code (ws52-code-paste-back)
  scan: '/subscription-pool/follow-me/scan', // POST — follow-me consent offers (one-tap card)
  issue: '/mandate/issue-for-machine',       // POST (PIN-gated) — Approve issues the mandate
  // account-machine-matrix: pool-scope accounts feed the grid (the SAME read the accounts list
  // uses, with peers merged); start-cell is the PIN-gated "Set up" orchestrator over the chain.
  accountsPool: '/subscription-pool?scope=pool',
  startCell: '/subscription-pool/matrix/start-cell', // POST (PIN-gated) — start a cell's sign-in
  cancel: '/subscription-pool/follow-me/cancel', // POST (Bearer, no PIN) — cancel an in-flight cell (relay → self/peer)
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

  // matrixTransient: client-side last-attempt state per `${accountId}::${machineId}` cell (FD6 —
  // held / cant-resolve are known only to the client from the response it just got).
  const state = { timerId: null, active: false, inFlight: null, offers: [], approveWired: false,
    matrixWired: false, matrixTransient: {}, lastPoolBody: null, lastPendingBody: null };

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
    let accountsBody, pendingBody, inUseBody, scanBody, poolBody;
    try {
      // in-use AND the follow-me scan are best-effort — their failure must not blank the
      // accounts list, so each is caught independently (in-use → "unknown"; scan → no card).
      // poolBody (scope=pool) feeds the account×machine matrix; best-effort (matrix is hidden if absent).
      [accountsBody, pendingBody, inUseBody, scanBody, poolBody] = await Promise.all([
        fetchJson(URLS.accounts, controller),
        fetchJson(URLS.pending, controller),
        fetchJson(URLS.inUse, controller).catch(() => null),
        postJson(URLS.scan, {}, controller).then((r) => (r.ok ? r.json : null)).catch(() => null),
        fetchJson(URLS.accountsPool, controller).catch(() => null),
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
    render(accountsBody, pendingBody, inUseBody, poolBody);
    reschedule();
  }

  function render(accountsBody, pendingBody, inUseBody, poolBody) {
    const accounts = accountsBody && Array.isArray(accountsBody.accounts) ? accountsBody.accounts : [];
    const logins = pendingBody && Array.isArray(pendingBody.logins) ? pendingBody.logins : [];
    const inUseAccountId = inUseBody && inUseBody.activeAccountId ? inUseBody.activeAccountId : null;
    renderAccounts(doc, els.accounts, accounts, now(), inUseAccountId);
    renderPendingLogins(doc, els.pending, logins, now());
    wireCodeSubmit();
    // The account × machine matrix (account-machine-matrix) — built from the pool-scope read +
    // the (already pool-scope) pending logins. Hidden when the pool-scope read is unavailable.
    if (els.matrix) {
      state.lastPoolBody = poolBody || null;
      state.lastPendingBody = pendingBody || null;
      renderAccountMatrix(doc, els.matrix, poolBody, pendingBody, state.matrixTransient);
      wireMatrixSetup();
    }
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

  // Delegated, wired ONCE: a "Submit code" tap on a pending-login row reads the pasted
  // sign-in code and POSTs it (with the login's id + machineId) to the fronting relay,
  // which carries it to the machine doing the login (off-chat). The code is never stored
  // client-side beyond the input; it's cleared on success. (ws52-code-paste-back)
  function wireCodeSubmit() {
    if (state.codeSubmitWired || !els.pending) return;
    state.codeSubmitWired = true;
    els.pending.addEventListener('click', (ev) => {
      const btn = ev.target && ev.target.closest ? ev.target.closest('[data-submit-code]') : null;
      if (!btn || !els.pending.contains(btn)) return;
      const row = btn.closest('.sub-pending');
      if (!row) return;
      const input = row.querySelector('.sub-pending-code-input');
      const code = input ? input.value.trim() : '';
      const id = row.getAttribute('data-login-id');
      const machineId = row.getAttribute('data-machine-id') || undefined;
      if (!code) { setRowStatus(row, 'Paste the code the sign-in page gave you, then tap Submit.'); return; }
      if (!id) { setRowStatus(row, 'Couldn’t identify this login — please refresh.'); return; }
      setRowStatus(row, 'Sending your code…');
      btn.setAttribute('disabled', '1');
      void (async () => {
        try {
          const r = await postJson(URLS.submitCode, { machineId, id, code });
          if (r.ok && r.json && r.json.outcome === 'validated') {
            setRowStatus(row, 'Done — this machine is set up with the account.');
            if (input) input.value = '';
          } else if (r.ok && r.json && r.json.outcome === 'submitted') {
            setRowStatus(row, 'Code sent — finishing sign-in…');
            if (input) input.value = '';
          } else if (r.ok && r.json && r.json.outcome === 'held') {
            setRowStatus(row, 'Signed in, but the account didn’t match what was approved — check with the operator.');
            btn.removeAttribute('disabled');
          } else {
            const msg = (r.json && (r.json.error || r.json.reason)) ? (r.json.error || r.json.reason) : `failed (${r.status})`;
            setRowStatus(row, `Couldn’t submit the code: ${msg}`);
            btn.removeAttribute('disabled');
          }
        } catch (e) {
          setRowStatus(row, 'Couldn’t reach the server — try again.');
          btn.removeAttribute('disabled');
        }
      })();
    });
  }

  function setRowStatus(row, text) {
    let s = row.querySelector('.sub-pending-status');
    if (!s) { s = el(doc, 'div', 'sub-pending-status', ''); row.appendChild(s); }
    s.textContent = text;
  }

  // Delegated, wired ONCE: a "Set up" tap on a matrix cell expands an inline PIN input +
  // Confirm. Confirm POSTs the PIN-gated start-cell; on success the cell shows the auth link
  // (operator opens it) + a code input + Submit, which POSTs the SHIPPED submit-code relay.
  // The PIN + code are memory-only (read from the input on tap, cleared after use; never cached).
  function wireMatrixSetup() {
    if (state.matrixWired || !els.matrix) return;
    state.matrixWired = true;
    els.matrix.addEventListener('click', (ev) => {
      const t = ev.target;
      if (!t || typeof t.closest !== 'function') return;
      const setupBtn = t.closest('[data-matrix-setup]');
      if (setupBtn && els.matrix.contains(setupBtn)) { onSetupTap(setupBtn); return; }
      const confirmBtn = t.closest('[data-matrix-confirm]');
      if (confirmBtn && els.matrix.contains(confirmBtn)) { onConfirmTap(confirmBtn); return; }
      const codeBtn = t.closest('[data-matrix-code-submit]');
      if (codeBtn && els.matrix.contains(codeBtn)) { onCodeTap(codeBtn); return; }
      const cancelBtn = t.closest('[data-matrix-cancel]');
      if (cancelBtn && els.matrix.contains(cancelBtn)) { onCancelTap(cancelBtn); return; }
    });
  }

  function matrixCellOf(node) {
    return node && typeof node.closest === 'function' ? node.closest('.sub-matrix-cell') : null;
  }
  function setCellStatus(cell, text) {
    let s = cell.querySelector('.sub-matrix-status');
    if (!s) { s = el(doc, 'div', 'sub-matrix-status', ''); cell.appendChild(s); }
    s.textContent = text;
  }

  // Expand the cell into a PIN input + Confirm (replacing the "Set up"/"Retry" button).
  function onSetupTap(btn) {
    const cell = matrixCellOf(btn);
    if (!cell) return;
    const accountId = btn.getAttribute('data-account-id');
    const machineId = btn.getAttribute('data-machine-id');
    if (!accountId || !machineId) return;
    btn.remove();
    const pin = doc.createElement('input');
    pin.setAttribute('type', 'password');
    pin.setAttribute('class', 'sub-matrix-pin');
    pin.setAttribute('placeholder', 'Your PIN');
    pin.setAttribute('autocomplete', 'off');
    cell.appendChild(pin);
    const confirm = el(doc, 'button', 'sub-matrix-confirm', 'Confirm');
    confirm.setAttribute('data-matrix-confirm', '1');
    confirm.setAttribute('data-account-id', accountId);
    confirm.setAttribute('data-machine-id', machineId);
    cell.appendChild(confirm);
  }

  // Confirm → POST the PIN-gated start-cell; render the auth link + code input on success.
  function onConfirmTap(btn) {
    const cell = matrixCellOf(btn);
    if (!cell) return;
    const accountId = btn.getAttribute('data-account-id');
    const machineId = btn.getAttribute('data-machine-id');
    const pinInput = cell.querySelector('.sub-matrix-pin');
    const pin = pinInput ? pinInput.value.trim() : '';
    if (!accountId || !machineId) { setCellStatus(cell, 'Couldn’t prepare this — please refresh.'); return; }
    if (!pin) { setCellStatus(cell, 'Enter your PIN to set this up.'); return; }
    setCellStatus(cell, 'Starting sign-in…');
    btn.setAttribute('disabled', '1');
    void (async () => {
      try {
        const r = await postJson(URLS.startCell, { accountId, machineId, pin });
        if (pinInput) pinInput.value = ''; // PIN is memory-only — clear it immediately
        if (r.ok && r.json && r.json.verificationUrl) {
          renderCellSignIn(cell, accountId, machineId, r.json.verificationUrl, r.json.loginId || accountId);
        } else if (r.status === 409) {
          state.matrixTransient[`${accountId}::${machineId}`] = { state: 'cant-resolve' };
          setCellStatus(cell, 'Can’t set this account up here — its details couldn’t be resolved.');
          btn.removeAttribute('disabled');
        } else {
          const msg = (r.json && (r.json.error || r.json.reason)) ? (r.json.error || r.json.reason) : `failed (${r.status})`;
          setCellStatus(cell, `Couldn’t start: ${msg}`);
          btn.removeAttribute('disabled');
        }
      } catch (e) {
        setCellStatus(cell, 'Couldn’t reach the server — try again.');
        btn.removeAttribute('disabled');
      }
    })();
  }

  // After start-cell: show the sign-in link (operator opens it) + a code input + Submit.
  function renderCellSignIn(cell, accountId, machineId, verificationUrl, loginId) {
    // Clear the PIN/Confirm UI, keep the status line.
    const pin = cell.querySelector('.sub-matrix-pin'); if (pin) pin.remove();
    const confirm = cell.querySelector('[data-matrix-confirm]'); if (confirm) confirm.remove();
    setCellStatus(cell, 'Open the sign-in link, then paste the code below.');
    const href = trustedLoginUrl(verificationUrl);
    if (href) {
      const a = doc.createElement('a');
      a.setAttribute('href', href);
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
      a.setAttribute('class', 'sub-matrix-signin');
      a.textContent = 'Sign in';
      cell.appendChild(a);
    } else {
      cell.appendChild(el(doc, 'div', 'sub-matrix-url', sanitizeForDisplay(verificationUrl, 'url')));
    }
    const code = doc.createElement('input');
    code.setAttribute('type', 'text');
    code.setAttribute('class', 'sub-matrix-code-input');
    code.setAttribute('placeholder', 'Paste your sign-in code');
    code.setAttribute('autocomplete', 'off');
    cell.appendChild(code);
    const submit = el(doc, 'button', 'sub-matrix-code-submit', 'Submit');
    submit.setAttribute('data-matrix-code-submit', '1');
    submit.setAttribute('data-account-id', accountId);
    submit.setAttribute('data-machine-id', machineId);
    submit.setAttribute('data-login-id', loginId);
    cell.appendChild(submit);
  }

  // Submit the pasted code via the SHIPPED submit-code relay (unchanged contract).
  function onCodeTap(btn) {
    const cell = matrixCellOf(btn);
    if (!cell) return;
    const accountId = btn.getAttribute('data-account-id');
    const machineId = btn.getAttribute('data-machine-id');
    const loginId = btn.getAttribute('data-login-id') || accountId;
    const input = cell.querySelector('.sub-matrix-code-input');
    const code = input ? input.value.trim() : '';
    if (!code) { setCellStatus(cell, 'Paste the code the sign-in page gave you, then tap Submit.'); return; }
    setCellStatus(cell, 'Sending your code…');
    btn.setAttribute('disabled', '1');
    void (async () => {
      try {
        const r = await postJson(URLS.submitCode, { machineId, id: loginId, code });
        if (input) input.value = ''; // code is memory-only — cleared after use
        const key = `${accountId}::${machineId}`;
        if (r.ok && r.json && r.json.outcome === 'validated') {
          delete state.matrixTransient[key];
          setCellStatus(cell, 'Done — this machine is set up with the account.');
        } else if (r.ok && r.json && r.json.outcome === 'submitted') {
          setCellStatus(cell, 'Code sent — finishing sign-in…');
        } else if (r.ok && r.json && r.json.outcome === 'held') {
          state.matrixTransient[key] = { state: 'held' };
          setCellStatus(cell, 'Signed in, but the account didn’t match what was approved — re-try with the right account.');
          btn.removeAttribute('disabled');
        } else {
          const msg = (r.json && (r.json.error || r.json.reason)) ? (r.json.error || r.json.reason) : `failed (${r.status})`;
          setCellStatus(cell, `Couldn’t submit the code: ${msg}`);
          btn.removeAttribute('disabled');
        }
      } catch (e) {
        setCellStatus(cell, 'Couldn’t reach the server — try again.');
        btn.removeAttribute('disabled');
      }
    })();
  }

  // Cancel an in-flight cell: POST the Bearer-only cancel relay (self/peer), abandoning
  // the login + tearing down its pane. No PIN (mirrors the code-submit step — a PIN can't
  // cross the mesh). Reversible: the cell frees up to re-tap "Set up". Guarded by a native
  // confirm where available (degrades to proceed under jsdom/headless).
  function onCancelTap(btn) {
    const cell = matrixCellOf(btn);
    if (!cell) return;
    const accountId = btn.getAttribute('data-account-id');
    const machineId = btn.getAttribute('data-machine-id');
    if (!accountId || !machineId) { setCellStatus(cell, 'Couldn’t prepare this — please refresh.'); return; }
    const view = doc.defaultView;
    if (view && typeof view.confirm === 'function') {
      let ok = true;
      try { ok = view.confirm('Cancel this in-progress setup?'); } catch (e) { ok = true; }
      if (!ok) return;
    }
    setCellStatus(cell, 'Cancelling…');
    btn.setAttribute('disabled', '1');
    void (async () => {
      try {
        const r = await postJson(URLS.cancel, { machineId, id: accountId });
        if (r.ok && r.json && (r.json.cancelled || r.json.alreadyTerminal)) {
          delete state.matrixTransient[`${accountId}::${machineId}`];
          setCellStatus(cell, 'Cancelled — you can set this up again.');
        } else {
          const msg = (r.json && (r.json.error || r.json.reason)) ? (r.json.error || r.json.reason) : `failed (${r.status})`;
          setCellStatus(cell, `Couldn’t cancel: ${msg}`);
          btn.removeAttribute('disabled');
        }
      } catch (e) {
        setCellStatus(cell, 'Couldn’t reach the server — try again.');
        btn.removeAttribute('disabled');
      }
    })();
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
    renderAccountMatrix, buildMatrixModel,
  };
}

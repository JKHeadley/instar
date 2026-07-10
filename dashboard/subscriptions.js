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

// ── Interaction-hold (Dashboard UX Standard F9) ─────────────────────────────
// THE RULE (topic 29836 case study D1): a background refresh must NEVER replace a
// surface with an open interaction. An open interaction is (a) an element marked
// data-interaction-open (an enrollment episode the controller is driving), (b) a
// focused text-entry element, or (c) a dirty (partially-typed) field. While one is
// open, the periodic poll MERGES server state into the view (countdowns, status
// lines) instead of rebuilding the DOM out from under the operator's fingers. The
// hold releases when the flow reaches a terminal state (verified / failed /
// cancelled / expired) or the operator backs out.
export function hasOpenInteraction(doc, root) {
  if (!root || typeof root.querySelector !== 'function') return false;
  if (root.querySelector('[data-interaction-open]')) return true;
  const active = doc && doc.activeElement;
  if (active && root.contains(active) && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName || '')) return true;
  for (const field of root.querySelectorAll('input, textarea')) {
    if (typeof field.value === 'string' && field.value !== '') return true;
  }
  return false;
}

/** The F9 merge arm: patch every countdown element ([data-ttl-expires]) under `root`
 *  from the live clock WITHOUT rebuilding anything. Safe on held and unheld DOM.
 *  Returns the number of elements patched. */
export function updateCountdowns(doc, root, now = Date.now()) {
  if (!root || typeof root.querySelectorAll !== 'function') return 0;
  let patched = 0;
  for (const node of root.querySelectorAll('[data-ttl-expires]')) {
    const left = countdown(node.getAttribute('data-ttl-expires'), now);
    node.textContent = left === 'expired'
      ? 'Sign-in link expired — start again'
      : (left ? `Link expires in ${left}` : '');
    patched++;
  }
  return patched;
}

/** Plain-language explanation for a HELD (identity-refused) enrollment, naming BOTH
 *  accounts when the gate verdict carries them (topic 29836 D3). Fail-closed reasons
 *  (oracle unavailable / no expected email) get honest "couldn't confirm" copy. */
export function heldExplanation(expected, got, reason, { short = false } = {}) {
  const exp = sanitizeForDisplay(expected, 'label');
  const g = sanitizeForDisplay(got, 'label');
  if (exp && g) {
    return short
      ? `That sign-in was ${g} — this slot needs ${exp}.`
      : `That code signed in ${g} — this slot needs ${exp}. The account was NOT enrolled; sign in again with the right account.`;
  }
  if (reason === 'missing-completed-email') {
    return short
      ? 'Couldn’t confirm which account that was — not enrolled.'
      : 'Signed in, but I couldn’t confirm which account that sign-in belongs to — so it was NOT enrolled (fail-closed). Try again, or check the attention queue.';
  }
  return short
    ? 'The account didn’t verify — not enrolled.'
    : 'Signed in, but the account couldn’t be verified against what you approved — so it was NOT enrolled.';
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

/** Explicit terminal-outcome card for the pending panel (topic 29836 D4 — completion
 *  must never be a vanishing line). `o` is a client-recorded outcome:
 *  { kind:'validated'|'held'|'expired', accountId, machineId, machineNickname?, email?,
 *    expected?, got?, reason? }. Static glyphs are literals (never dynamic data). */
export function renderOutcomeCard(doc, o) {
  const isDone = o && o.kind === 'validated';
  const row = el(doc, 'div', isDone ? 'sub-pending sub-pending-done' : 'sub-pending sub-pending-failed');
  const who = sanitizeForDisplay((o && (o.email || o.accountId)) || 'The account', 'label');
  const machine = sanitizeForDisplay((o && (o.machineNickname || o.machineId)) || 'the machine', 'label');
  if (isDone) {
    row.appendChild(el(doc, 'div', 'sub-pending-done-head', '✓ Done'));
    row.appendChild(el(doc, 'div', 'sub-pending-outcome-body', `${who} is now set up on ${machine}.`));
  } else if (o && o.kind === 'held') {
    row.appendChild(el(doc, 'div', 'sub-pending-failed-head', '✗ Not enrolled — the account didn’t match'));
    row.appendChild(el(doc, 'div', 'sub-pending-outcome-body', heldExplanation(o.expected, o.got, o.reason)));
  } else {
    row.appendChild(el(doc, 'div', 'sub-pending-failed-head', '✗ Sign-in link expired'));
    row.appendChild(el(doc, 'div', 'sub-pending-outcome-body',
      `The sign-in for ${who} on ${machine} expired before it finished — start it again from the grid above.`));
  }
  return row;
}

export function renderPendingLogins(doc, target, logins, now = Date.now(), outcomes = []) {
  if (!target) return;
  target.replaceChildren();
  // Client-observed terminal outcomes lead the panel (explicit completed/failed cards —
  // never a vanishing line; topic 29836 D4). Newest first, capped by the controller.
  const cards = Array.isArray(outcomes) ? outcomes : [];
  for (const o of cards) target.appendChild(renderOutcomeCard(doc, o));
  if (!Array.isArray(logins) || logins.length === 0) {
    if (cards.length === 0) target.appendChild(el(doc, 'div', 'sub-empty', 'No logins waiting for approval.'));
    return;
  }
  for (const l of logins) {
    const row = el(doc, 'div', 'sub-pending');
    // Non-sensitive identifiers for the code-submit handler (never a credential).
    row.setAttribute('data-login-id', sanitizeForDisplay(l && l.id, 'label'));
    if (l && (l.machineId || l.machineNickname)) row.setAttribute('data-machine-id', sanitizeForDisplay(l.machineId, 'label'));

    // Lead with a plain-language headline naming what to do + where. Wording floors (D5):
    // the ACCOUNT is shown by its email when known (the label can be an internal nickname
    // like "Justin"); the MACHINE by nickname, NEVER a raw m_<hex> machine id.
    const machine = friendlyMachine(l && l.machineNickname, l && l.machineId);
    const who = sanitizeForDisplay(l && (l.expectedEmail || l.email || l.label), 'label');

    // D5 record ⟂ pane liveness: a login whose sign-in window is GONE (paneAlive === false)
    // must not present as submittable — no link, no code input; an explicit needs-restart
    // card pointing at the working restart affordance (the grid's Retry) instead.
    if (l && l.paneAlive === false) {
      row.setAttribute('class', 'sub-pending sub-pending-failed');
      row.appendChild(el(doc, 'div', 'sub-pending-failed-head',
        machine ? `✗ This sign-in can’t finish — its window on ${machine} closed` : '✗ This sign-in can’t finish — its window closed'));
      row.appendChild(el(doc, 'div', 'sub-pending-outcome-body',
        `Start ${who || 'it'} again from the “Accounts on each machine” grid above — tapping Retry starts a fresh sign-in.`));
      target.appendChild(row);
      continue;
    }

    const headline = machine
      ? `Sign in to finish setting up ${who} on ${machine}`
      : `Sign in to finish setting up ${who}`;
    row.appendChild(el(doc, 'div', 'sub-pending-headline', headline));

    // Wrong-account hazard (topic 29836 D3): state prominently, BEFORE the link, which
    // account the provider's OAuth page MUST show — the page opens in whatever login
    // state the browser already has, and nothing else warns.
    if (l && l.expectedEmail) {
      row.appendChild(el(doc, 'div', 'sub-pending-expected',
        `The sign-in page must show ${sanitizeForDisplay(l.expectedEmail, 'label')} — if it shows a different account, tap “Switch account” first.`));
    }

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

    // One short secondary line: the TTL (patched live by updateCountdowns between
    // rebuilds — the F9 merge arm), and the flow notice only if present (trimmed).
    const ttl = l && l.ttlExpiresAt ? countdown(l.ttlExpiresAt, now) : '';
    if (ttl) {
      const ttlEl = el(doc, 'div', 'sub-pending-ttl', ttl === 'expired' ? 'Sign-in link expired — start again' : `Link expires in ${ttl}`);
      ttlEl.setAttribute('data-ttl-expires', sanitizeForDisplay(l.ttlExpiresAt, 'label'));
      row.appendChild(ttlEl);
    }
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
  // The MAP carries the pending-login RECORD so the in-progress cell can render the COMPLETE
  // sign-in flow (link, expected email, code input, TTL, notice) from SERVER state — the flow
  // must never exist only in the bottom panel (topic 29836 D2), and a rebuild mid-flow renders
  // the same step back instead of losing it (D1 defense-in-depth).
  const inProgress = new Map();
  for (const l of pendingRows) {
    if (l && l.id && l.machineId) inProgress.set(`${l.id}::${l.machineId}`, l);
  }

  const machineList = Array.from(machines.values());
  const accountList = Array.from(accounts.values());
  const cells = [];
  for (const acct of accountList) {
    const rowCells = [];
    for (const m of machineList) {
      const key = `${acct.accountId}::${m.machineId}`;
      const t = transient[key] || null;
      const pendingLogin = inProgress.get(key) || null;
      let state;
      if (m.offline) state = 'offline';                              // whole column offline (FD6)
      else if (t && t.state === 'held') state = 'held';
      else if (t && t.state === 'cant-resolve') state = 'cant-resolve';
      else if (cellStatus.get(key) === 'active') state = 'active';
      // just-verified BRIDGES the gap between a client-observed successful enrollment and the
      // next pool read that shows the account active — the cell must flip to an unmistakable
      // verified presentation the moment the enrollment verifies (topic 29836 D4), never blink
      // back to a "Set up" button while the server catches up.
      else if (t && t.state === 'just-verified') state = 'just-verified';
      // broken (D5): the server says this attempt's sign-in pane is DEAD (record ⟂ pane
      // reconciliation) — or the client just watched a code-submit refuse with pane-dead.
      // Presenting it as submittable would be a lie; it gets an explicit needs-restart
      // presentation with a working Retry (start-cell supersedes the zombie atomically).
      else if ((pendingLogin && pendingLogin.paneAlive === false) || (t && t.state === 'broken')) state = 'broken';
      else if (pendingLogin) state = 'in-progress';
      else if (t && t.state === 'expired') state = 'expired';
      else if (cellStatus.get(key) === 'needs-reauth') state = 'needs-reauth';
      else state = 'empty';                                          // → "Set up" button
      rowCells.push({
        accountId: acct.accountId, machineId: m.machineId, state,
        login: state === 'in-progress' ? pendingLogin : null,
        detail: t,
      });
    }
    cells.push({ account: acct, cells: rowCells });
  }
  return { machines: machineList, accounts: accountList, rows: cells, selfMachineId };
}

const MATRIX_CELL_GLYPH = {
  active: '✓', 'needs-reauth': '⟳', 'in-progress': '◷', offline: '—', held: '⚠', 'cant-resolve': '✗',
  expired: '✗', 'just-verified': '✓', broken: '✗',
};
const MATRIX_CELL_WORD = {
  active: 'Active', 'needs-reauth': 'Needs sign-in', 'in-progress': 'Signing in…',
  offline: 'Machine offline', held: 'Didn’t match — re-try', 'cant-resolve': 'Can’t set up', other: 'Set up',
  expired: 'Sign-in link expired', 'just-verified': 'Set up complete', broken: 'Sign-in needs a restart',
};

/** D5 wording floor: never show a raw internal machine id (m_<hex>) to the operator —
 *  a nickname, or nothing. Exported for the floor test. */
export function friendlyMachine(nickname, machineId) {
  const nick = sanitizeForDisplay(nickname, 'label');
  if (nick) return nick;
  const id = typeof machineId === 'string' ? machineId : '';
  if (/^m_[0-9a-f]{8,}$/i.test(id)) return '';
  return sanitizeForDisplay(id, 'label');
}

/**
 * Append the COMPLETE in-cell sign-in flow (topic 29836 D2): the sign-in link, the
 * expected-account warning (D3 UI layer), the paste-back code input, the live TTL
 * countdown, the flow notice (two-codes heads-up), and a Cancel. Shared by the
 * in-progress matrix cell (rendered from SERVER pending-login state, so the step
 * survives reloads and rebuilds) and the controller's immediate post-start render.
 * `flow` = { accountId, machineId, loginId, verificationUrl, expectedEmail,
 *            ttlExpiresAt, notice, kind, userCode }.
 */
export function appendCellSignInFlow(doc, cell, flow, now = Date.now()) {
  cell.appendChild(el(doc, 'div', 'sub-matrix-flow-step', 'Open the sign-in link, then paste the code it gives you below.'));
  if (flow && flow.expectedEmail) {
    cell.appendChild(el(doc, 'div', 'sub-matrix-expected',
      `The sign-in page must show ${sanitizeForDisplay(flow.expectedEmail, 'label')} — if it shows a different account, tap “Switch account” first.`));
  }
  const href = trustedLoginUrl(flow && flow.verificationUrl);
  if (href) {
    const a = doc.createElement('a');
    a.setAttribute('href', href);
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
    a.setAttribute('class', 'sub-matrix-signin');
    a.textContent = 'Sign in';
    cell.appendChild(a);
  } else if (flow && flow.verificationUrl) {
    cell.appendChild(el(doc, 'div', 'sub-matrix-url', sanitizeForDisplay(flow.verificationUrl, 'url')));
  }
  if (flow && flow.userCode) {
    cell.appendChild(el(doc, 'div', 'sub-pending-code', `Code: ${sanitizeForDisplay(flow.userCode, 'code')}`));
  }
  if (!flow || flow.kind !== 'device-code') {
    const code = doc.createElement('input');
    code.setAttribute('type', 'text');
    code.setAttribute('class', 'sub-matrix-code-input');
    code.setAttribute('placeholder', 'Paste your sign-in code');
    code.setAttribute('autocomplete', 'off');
    cell.appendChild(code);
    const submit = el(doc, 'button', 'sub-matrix-code-submit', 'Submit');
    submit.setAttribute('data-matrix-code-submit', '1');
    submit.setAttribute('data-account-id', sanitizeForDisplay(flow && flow.accountId, 'label'));
    submit.setAttribute('data-machine-id', sanitizeForDisplay(flow && flow.machineId, 'label'));
    submit.setAttribute('data-login-id', sanitizeForDisplay((flow && (flow.loginId || flow.accountId)) || '', 'label'));
    cell.appendChild(submit);
  }
  if (flow && flow.notice) {
    cell.appendChild(el(doc, 'div', 'sub-matrix-notice', sanitizeForDisplay(flow.notice, 'summary')));
  }
  if (flow && flow.ttlExpiresAt) {
    const left = countdown(flow.ttlExpiresAt, now);
    const ttl = el(doc, 'div', 'sub-matrix-ttl',
      left === 'expired' ? 'Sign-in link expired — start again' : (left ? `Link expires in ${left}` : ''));
    ttl.setAttribute('data-ttl-expires', sanitizeForDisplay(flow.ttlExpiresAt, 'label'));
    cell.appendChild(ttl);
  }
  const cancelBtn = el(doc, 'button', 'sub-matrix-cancel', 'Cancel');
  cancelBtn.setAttribute('data-matrix-cancel', '1');
  cancelBtn.setAttribute('data-account-id', sanitizeForDisplay(flow && flow.accountId, 'label'));
  cancelBtn.setAttribute('data-machine-id', sanitizeForDisplay(flow && flow.machineId, 'label'));
  cell.appendChild(cancelBtn);
}

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
  const now = Date.now();
  for (const row of model.rows) {
    const tr = doc.createElement('tr');
    tr.appendChild(el(doc, 'th', 'sub-matrix-acct', sanitizeForDisplay(row.account.email, 'label')));
    for (const c of row.cells) {
      // just-verified rides a transient highlight on an otherwise-active cell (D4 ceremony).
      const justVerified = c.state === 'just-verified' || (c.state === 'active' && c.detail && c.detail.state === 'just-verified');
      const td = el(doc, 'td', `sub-matrix-cell sub-matrix-${c.state}${justVerified && c.state !== 'just-verified' ? ' sub-matrix-just-verified' : ''}`);
      // Stable cell identity for the interaction-hold rule + targeted merge updates (F9).
      td.setAttribute('data-cell-key', sanitizeForDisplay(`${c.accountId}::${c.machineId}`, 'url'));
      if (c.state === 'empty' || c.state === 'needs-reauth' || c.state === 'held' || c.state === 'cant-resolve' || c.state === 'expired' || c.state === 'broken') {
        // An actionable cell → a button that runs the SAME in-dashboard sign-in flow (PIN → link →
        // paste code). empty → "Set up"; needs-reauth (an existing account whose login expired) →
        // "Sign in"; held/cant-resolve/expired/broken → "Retry". A needs-reauth account already
        // resolves to its email, so the start-cell orchestrator drives a real re-auth — never a
        // cosmetic button, and a broken (dead-pane) attempt is superseded server-side on Retry.
        const label = c.state === 'empty' ? 'Set up' : (c.state === 'needs-reauth' ? 'Sign in' : 'Retry');
        const btn = el(doc, 'button', 'sub-matrix-setup', label);
        btn.setAttribute('data-matrix-setup', '1');
        btn.setAttribute('data-account-id', sanitizeForDisplay(c.accountId, 'label'));
        btn.setAttribute('data-machine-id', sanitizeForDisplay(c.machineId, 'label'));
        if (c.state !== 'empty') {
          // Show the status word ("⟳ Needs sign-in" / "⚠ Didn't match…") ABOVE the button.
          td.appendChild(el(doc, 'div', 'sub-matrix-glyph', `${MATRIX_CELL_GLYPH[c.state]} ${MATRIX_CELL_WORD[c.state]}`));
        }
        // A held cell with the gate verdict's both-account detail names BOTH accounts in
        // plain language (topic 29836 D3) — never just a bare "didn't match".
        if (c.state === 'held' && c.detail) {
          td.appendChild(el(doc, 'div', 'sub-matrix-held-detail',
            heldExplanation(c.detail.expected, c.detail.got, c.detail.reason, { short: true })));
        }
        // A broken cell says WHY in plain words (D5): the attempt's sign-in window is gone.
        if (c.state === 'broken') {
          td.appendChild(el(doc, 'div', 'sub-matrix-held-detail',
            'Its sign-in window closed before finishing — tap Retry to start a fresh sign-in.'));
        }
        td.appendChild(btn);
      } else if (c.state === 'in-progress' && c.login && c.login.verificationUrl) {
        // The cell carries the COMPLETE flow, rebuilt from SERVER pending-login state
        // (topic 29836 D2): a poll rebuild mid-flow renders the same step back — the
        // "flips to ◷ before the code can be pasted" defect is structurally impossible.
        td.appendChild(el(doc, 'div', 'sub-matrix-glyph', '◷ Signing in'));
        appendCellSignInFlow(doc, td, {
          accountId: c.accountId, machineId: c.machineId, loginId: c.login.id,
          verificationUrl: c.login.verificationUrl, expectedEmail: c.login.expectedEmail,
          ttlExpiresAt: c.login.ttlExpiresAt, notice: c.login.notice, kind: c.login.kind,
          userCode: c.login.userCode,
        }, now);
      } else {
        const word = c.state === 'offline' ? 'unknown'
          : (justVerified && c.state === 'active' ? 'Active — just set up' : MATRIX_CELL_WORD[c.state]);
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
  // held / cant-resolve / expired / just-verified are known only to the client from the
  // response it just got or from an episode it drove).
  // matrixEpisodes: enrollment episodes THIS client started (start-cell succeeded) — used to
  // detect a server-side expiry (pending login vanished without a terminal outcome) and to
  // add the D4 ceremony when the episode lands. recentOutcomes: client-observed terminal
  // outcomes rendered as explicit cards in the pending panel (D4 — never a vanishing line).
  const state = { timerId: null, active: false, inFlight: null, offers: [], approveWired: false,
    matrixWired: false, matrixTransient: {}, lastPoolBody: null, lastPendingBody: null,
    matrixEpisodes: {}, recentOutcomes: [] };

  const JUST_VERIFIED_TTL_MS = 5 * 60_000;   // highlight ceremony window
  const EXPIRED_TTL_MS = 60 * 60_000;        // explicit expired presentation window
  const OUTCOME_TTL_MS = 15 * 60_000;        // pending-panel outcome cards window
  const MAX_OUTCOME_CARDS = 5;

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

  // ── Episode + outcome bookkeeping (D1/D4/D5) ───────────────────────────────
  function purgeTransients() {
    const t = now();
    for (const key of Object.keys(state.matrixTransient)) {
      const entry = state.matrixTransient[key];
      if (!entry || typeof entry.at !== 'number') continue;
      if (entry.state === 'just-verified' && t - entry.at > JUST_VERIFIED_TTL_MS) delete state.matrixTransient[key];
      if ((entry.state === 'expired' || entry.state === 'broken') && t - entry.at > EXPIRED_TTL_MS) delete state.matrixTransient[key];
    }
    state.recentOutcomes = state.recentOutcomes
      .filter((o) => o && typeof o.at === 'number' && now() - o.at <= OUTCOME_TTL_MS)
      .slice(0, MAX_OUTCOME_CARDS);
  }

  /** Resolve a machine's operator-facing name from the cached bodies ('' if unknown —
   *  never a raw m_<hex> id; D5 wording floor). */
  function machineNick(machineId) {
    const accounts = state.lastPoolBody && Array.isArray(state.lastPoolBody.accounts) ? state.lastPoolBody.accounts : [];
    const hit = accounts.find((a) => a && a.machineId === machineId && a.machineNickname);
    if (hit) return hit.machineNickname;
    const logins = state.lastPendingBody && Array.isArray(state.lastPendingBody.logins) ? state.lastPendingBody.logins : [];
    const l = logins.find((x) => x && x.machineId === machineId && x.machineNickname);
    return l ? l.machineNickname : '';
  }

  /** One chokepoint for a client-observed terminal submit outcome — records the panel
   *  card (D4), the matrix transient (so BOTH surfaces flip together), and ends the
   *  episode. Used by the in-cell submit AND the pending-panel submit. */
  function recordSubmitOutcome(kind, ids, body) {
    const { accountId, machineId } = ids;
    const key = accountId && machineId ? `${accountId}::${machineId}` : null;
    if (key) delete state.matrixEpisodes[key];
    const base = { accountId, machineId, machineNickname: machineNick(machineId), at: now() };
    if (kind === 'validated') {
      if (key) state.matrixTransient[key] = { state: 'just-verified', at: now() };
      state.recentOutcomes.unshift({ ...base, kind, email: (body && body.email) || null });
    } else if (kind === 'held') {
      if (key) {
        state.matrixTransient[key] = {
          state: 'held', at: now(),
          expected: (body && body.expected) || null, got: (body && body.got) || null, reason: (body && body.reason) || null,
        };
      }
      state.recentOutcomes.unshift({ ...base, kind, expected: (body && body.expected) || null, got: (body && body.got) || null, reason: (body && body.reason) || null });
    } else if (kind === 'broken') {
      if (key) state.matrixTransient[key] = { state: 'broken', at: now() };
    }
    state.recentOutcomes = state.recentOutcomes.slice(0, MAX_OUTCOME_CARDS);
  }

  /** Episode reconciliation (D5/D4): an episode this client started whose pending login
   *  VANISHED server-side resolves to a terminal state — active pool row → just-verified
   *  ceremony; gone without any outcome → explicit expired (never a silent revert to a
   *  bare "Set up" button). Runs on every tick with the fresh bodies. */
  function reconcileEpisodes(poolBody, pendingBody) {
    const accounts = poolBody && Array.isArray(poolBody.accounts) ? poolBody.accounts : [];
    const logins = pendingBody && Array.isArray(pendingBody.logins) ? pendingBody.logins : [];
    for (const key of Object.keys(state.matrixEpisodes)) {
      const sep = key.indexOf('::');
      const accountId = key.slice(0, sep);
      const machineId = key.slice(sep + 2);
      const active = accounts.some((a) => a && a.id === accountId && a.machineId === machineId && a.status === 'active');
      const stillPending = logins.some((l) => l && l.id === accountId && l.machineId === machineId);
      if (active) {
        delete state.matrixEpisodes[key];
        const t = state.matrixTransient[key];
        if (!t || (t.state !== 'held' && t.state !== 'just-verified')) {
          state.matrixTransient[key] = { state: 'just-verified', at: now() };
        }
        releaseCellHold(key);
      } else if (!stillPending) {
        delete state.matrixEpisodes[key];
        const t = state.matrixTransient[key];
        if (!t || (t.state !== 'held' && t.state !== 'cant-resolve' && t.state !== 'just-verified' && t.state !== 'broken')) {
          state.matrixTransient[key] = { state: 'expired', at: now() };
          state.recentOutcomes.unshift({ kind: 'expired', accountId, machineId, machineNickname: machineNick(machineId), at: now() });
        }
        releaseCellHold(key);
      }
    }
  }

  /** The episode is over server-side — release the cell's open-interaction marker so
   *  the guarded rebuild may replace it with the terminal presentation. */
  function releaseCellHold(key) {
    if (!els.matrix || typeof els.matrix.querySelectorAll !== 'function') return;
    for (const cell of els.matrix.querySelectorAll('[data-interaction-open]')) {
      if (cell.getAttribute && cell.getAttribute('data-cell-key') === key) cell.removeAttribute('data-interaction-open');
    }
  }

  /** Guarded matrix rebuild from the cached bodies — used by handlers that just flipped a
   *  cell terminal so the explicit presentation shows immediately (not 30s later). Respects
   *  the F9 hold: skipped while any OTHER interaction is open (the next tick catches up). */
  function rerenderMatrixFromCache() {
    if (!els.matrix || !state.lastPoolBody) return;
    if (hasOpenInteraction(doc, els.matrix)) return;
    renderAccountMatrix(doc, els.matrix, state.lastPoolBody, state.lastPendingBody, state.matrixTransient);
  }

  function render(accountsBody, pendingBody, inUseBody, poolBody) {
    const accounts = accountsBody && Array.isArray(accountsBody.accounts) ? accountsBody.accounts : [];
    const logins = pendingBody && Array.isArray(pendingBody.logins) ? pendingBody.logins : [];
    const inUseAccountId = inUseBody && inUseBody.activeAccountId ? inUseBody.activeAccountId : null;
    renderAccounts(doc, els.accounts, accounts, now(), inUseAccountId);
    purgeTransients();
    // Episode reconciliation runs FIRST so a terminal transition it derives (expired /
    // landed) is visible to BOTH surfaces on this same tick (the panel card + the cell).
    state.lastPoolBody = poolBody || null;
    state.lastPendingBody = pendingBody || null;
    if (els.matrix) reconcileEpisodes(poolBody, pendingBody);
    // F9 (Dashboard UX Standard): every surface that can hold an operator interaction is
    // rebuilt ONLY while no interaction is open; a held surface gets targeted merge updates
    // (live countdowns) instead. This is the structural fix for the topic 29836 D1 defect
    // (the poll reverting a PIN input / swapping the code step out mid-paste).
    if (els.pending) {
      if (!hasOpenInteraction(doc, els.pending)) {
        renderPendingLogins(doc, els.pending, logins, now(), state.recentOutcomes);
      } else {
        updateCountdowns(doc, els.pending, now());
      }
      wireCodeSubmit();
    }
    // The account × machine matrix (account-machine-matrix) — built from the pool-scope read +
    // the (already pool-scope) pending logins. Hidden when the pool-scope read is unavailable.
    if (els.matrix) {
      if (!hasOpenInteraction(doc, els.matrix)) {
        renderAccountMatrix(doc, els.matrix, poolBody, pendingBody, state.matrixTransient);
      } else {
        updateCountdowns(doc, els.matrix, now());
      }
      wireMatrixSetup();
    }
    // The one-tap follow-me Approve card(s) — rendered into els.followMe from the scan offers
    // (ws52-operator-tap-not-text Part A). Silent when there are none. The Approve click is wired
    // once (delegated) so re-renders never stack listeners. Same F9 hold: a half-typed PIN on an
    // Approve card is an open interaction the poll must not clobber.
    if (els.followMe) {
      if (!hasOpenInteraction(doc, els.followMe)) {
        renderFollowMeOffers(doc, els.followMe, state.offers);
      }
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
      // F9: the row is an open interaction while the submit is in flight — a poll rebuild
      // would detach the very node the outcome is about to be written into.
      row.setAttribute('data-interaction-open', 'submitting');
      void (async () => {
        try {
          const r = await postJson(URLS.submitCode, { machineId, id, code });
          if (r.ok && r.json && r.json.outcome === 'validated') {
            if (input) input.value = '';
            row.removeAttribute('data-interaction-open');
            recordSubmitOutcome('validated', { accountId: id, machineId }, r.json);
            // Explicit terminal presentation in place (D4) — the next rebuild shows the
            // durable ✓ Done card from recentOutcomes.
            row.setAttribute('class', 'sub-pending sub-pending-done');
            setRowStatus(row, `✓ Done — ${r.json.email ? r.json.email + ' is' : 'this account is'} set up on this machine.`);
            rerenderMatrixFromCache();
          } else if (r.ok && r.json && r.json.outcome === 'submitted') {
            setRowStatus(row, 'Code sent — finishing sign-in…');
            if (input) input.value = '';
            row.removeAttribute('data-interaction-open');
          } else if (r.ok && r.json && r.json.outcome === 'held') {
            if (input) input.value = '';
            row.removeAttribute('data-interaction-open');
            recordSubmitOutcome('held', { accountId: id, machineId }, r.json);
            row.setAttribute('class', 'sub-pending sub-pending-failed');
            // Plain language naming BOTH accounts (D3) — never a bare "didn't match".
            setRowStatus(row, `✗ ${heldExplanation(r.json.expected, r.json.got, r.json.reason)}`);
            rerenderMatrixFromCache();
            btn.removeAttribute('disabled');
          } else if (r.json && r.json.code === 'pane-dead') {
            // D5: the attempt's window is gone — flip to the explicit needs-restart state.
            row.removeAttribute('data-interaction-open');
            recordSubmitOutcome('broken', { accountId: id, machineId }, r.json);
            row.setAttribute('class', 'sub-pending sub-pending-failed');
            setRowStatus(row, `✗ ${r.json.error || 'This sign-in’s window is gone — start it again from the grid above.'}`);
            rerenderMatrixFromCache();
          } else {
            const msg = (r.json && (r.json.error || r.json.reason)) ? (r.json.error || r.json.reason) : `failed (${r.status})`;
            setRowStatus(row, `Couldn’t submit the code: ${msg}`);
            row.removeAttribute('data-interaction-open');
            btn.removeAttribute('disabled');
          }
        } catch (e) {
          setRowStatus(row, 'Couldn’t reach the server — try again.');
          row.removeAttribute('data-interaction-open');
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
      const collapseBtn = t.closest('[data-matrix-collapse]');
      if (collapseBtn && els.matrix.contains(collapseBtn)) { onCollapseTap(collapseBtn); return; }
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
  // The cell becomes an OPEN INTERACTION the moment it expands (F9): the marker holds it
  // through the poll until the flow reaches a terminal state or the operator backs out.
  function onSetupTap(btn) {
    const cell = matrixCellOf(btn);
    if (!cell) return;
    const accountId = btn.getAttribute('data-account-id');
    const machineId = btn.getAttribute('data-machine-id');
    if (!accountId || !machineId) return;
    // A retry clears the previous attempt's terminal presentation for this cell.
    delete state.matrixTransient[`${accountId}::${machineId}`];
    cell.setAttribute('data-interaction-open', 'pin-entry');
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
    // An explicit way OUT of the interaction (the hold would otherwise pin the cell
    // forever if the operator changes their mind) — client-side only, nothing started yet.
    const back = el(doc, 'button', 'sub-matrix-collapse', 'Back');
    back.setAttribute('data-matrix-collapse', '1');
    cell.appendChild(back);
  }

  // Back out of an un-started PIN entry: release the hold and restore the cell from cache.
  function onCollapseTap(btn) {
    const cell = matrixCellOf(btn);
    if (!cell) return;
    cell.removeAttribute('data-interaction-open');
    const pin = cell.querySelector('.sub-matrix-pin');
    if (pin) pin.value = '';
    rerenderMatrixFromCache();
  }

  // Confirm → POST the PIN-gated start-cell; render the COMPLETE in-cell sign-in flow on
  // success (link + expected-account warning + code input + TTL + notice + Cancel — D2).
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
          // Episode opens: the enrollment is live server-side; the reconciler now owns
          // detecting its expiry / landing when the client misses the terminal response.
          state.matrixEpisodes[`${accountId}::${machineId}`] = { loginId: r.json.loginId || accountId, at: now() };
          renderCellSignIn(cell, {
            accountId, machineId, loginId: r.json.loginId || accountId,
            verificationUrl: r.json.verificationUrl, expectedEmail: r.json.expectedEmail,
            ttlExpiresAt: r.json.ttlExpiresAt, notice: r.json.notice, kind: r.json.kind,
          });
        } else if (r.status === 409) {
          state.matrixTransient[`${accountId}::${machineId}`] = { state: 'cant-resolve', at: now() };
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

  // After start-cell: the immediate in-cell render of the complete flow (the SAME structure
  // the poll rebuilds from server state, via the shared appendCellSignInFlow — D2 coherence:
  // one live attempt, one URL, on every surface).
  function renderCellSignIn(cell, flow) {
    const pin = cell.querySelector('.sub-matrix-pin'); if (pin) pin.remove();
    const confirm = cell.querySelector('[data-matrix-confirm]'); if (confirm) confirm.remove();
    const back = cell.querySelector('[data-matrix-collapse]'); if (back) back.remove();
    const status = cell.querySelector('.sub-matrix-status'); if (status) status.remove();
    cell.setAttribute('data-interaction-open', 'signing-in');
    appendCellSignInFlow(doc, cell, flow, now());
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
    cell.setAttribute('data-interaction-open', 'submitting');
    void (async () => {
      try {
        const r = await postJson(URLS.submitCode, { machineId, id: loginId, code });
        if (input) input.value = ''; // code is memory-only — cleared after use
        if (r.ok && r.json && r.json.outcome === 'validated') {
          // TERMINAL SUCCESS (D4): unmistakable in-cell presentation the moment the
          // enrollment verifies; the transient keeps the ceremony on the next rebuilds.
          cell.removeAttribute('data-interaction-open');
          recordSubmitOutcome('validated', { accountId, machineId }, r.json);
          renderCellDone(cell, r.json.email || null);
        } else if (r.ok && r.json && r.json.outcome === 'submitted') {
          setCellStatus(cell, 'Code sent — finishing sign-in…');
          cell.removeAttribute('data-interaction-open');
        } else if (r.ok && r.json && r.json.outcome === 'held') {
          // TERMINAL REFUSAL (D3): the identity gate held the enrollment — name BOTH
          // accounts in plain language; the wrong account was NOT enrolled.
          cell.removeAttribute('data-interaction-open');
          recordSubmitOutcome('held', { accountId, machineId }, r.json);
          renderCellHeld(cell, accountId, machineId, r.json);
        } else if (r.json && r.json.code === 'pane-dead') {
          // TERMINAL (D5): the sign-in window is gone — explicit needs-restart state.
          cell.removeAttribute('data-interaction-open');
          recordSubmitOutcome('broken', { accountId, machineId }, r.json);
          rerenderMatrixFromCache();
        } else {
          const msg = (r.json && (r.json.error || r.json.reason)) ? (r.json.error || r.json.reason) : `failed (${r.status})`;
          setCellStatus(cell, `Couldn’t submit the code: ${msg}`);
          cell.setAttribute('data-interaction-open', 'signing-in');
          btn.removeAttribute('disabled');
        }
      } catch (e) {
        setCellStatus(cell, 'Couldn’t reach the server — try again.');
        cell.setAttribute('data-interaction-open', 'signing-in');
        btn.removeAttribute('disabled');
      }
    })();
  }

  // The in-cell terminal SUCCESS presentation (D4): unmistakable, named, highlighted.
  function renderCellDone(cell, email) {
    cell.replaceChildren();
    cell.setAttribute('class', 'sub-matrix-cell sub-matrix-just-verified sub-matrix-done');
    cell.appendChild(el(doc, 'div', 'sub-matrix-glyph', '✓ All set'));
    cell.appendChild(el(doc, 'div', 'sub-matrix-done-detail',
      email ? `${sanitizeForDisplay(email, 'label')} is signed in on this machine.` : 'The account is signed in on this machine.'));
  }

  // The in-cell terminal HELD presentation (D3): both accounts named + a working Retry.
  function renderCellHeld(cell, accountId, machineId, body) {
    cell.replaceChildren();
    cell.setAttribute('class', 'sub-matrix-cell sub-matrix-held');
    cell.appendChild(el(doc, 'div', 'sub-matrix-glyph', `${MATRIX_CELL_GLYPH.held} ${MATRIX_CELL_WORD.held}`));
    cell.appendChild(el(doc, 'div', 'sub-matrix-held-detail',
      heldExplanation(body && body.expected, body && body.got, body && body.reason, { short: true })));
    const btn = el(doc, 'button', 'sub-matrix-setup', 'Retry');
    btn.setAttribute('data-matrix-setup', '1');
    btn.setAttribute('data-account-id', sanitizeForDisplay(accountId, 'label'));
    btn.setAttribute('data-machine-id', sanitizeForDisplay(machineId, 'label'));
    cell.appendChild(btn);
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
          // TERMINAL (cancelled): the episode is over — release the hold so the next
          // rebuild replaces the flow with a fresh "Set up" from server state.
          const key = `${accountId}::${machineId}`;
          delete state.matrixTransient[key];
          delete state.matrixEpisodes[key];
          cell.removeAttribute('data-interaction-open');
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
    hasOpenInteraction, updateCountdowns, heldExplanation, appendCellSignInFlow,
    renderOutcomeCard, friendlyMachine,
  };
}

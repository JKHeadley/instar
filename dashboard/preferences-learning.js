// Preferences tab — a calm, human-readable read surface for the Correction &
// Preference Learning Sentinel (Slice 2).
// Spec: docs/specs/CORRECTION-PREFERENCE-LEARNING-SENTINEL-SPEC.md §10 Slice-2.
//
// Browser-native ESM (no build step; served at /dashboard/preferences-learning.js
// and loaded by index.html via a lazy dynamic import). The pure functions are
// exported so the jsdom tests exercise the SHIPPED code, not a copy; the
// controller is driven by the (classic) index.html script on tab activation.
//
// Mirrors the Process Health tab precedent (dashboard/process-health.js):
//  - one self-contained module for the tab (NOT a modularization of the SPA);
//  - every dynamic value flows through sanitizeForDisplay before the DOM;
//  - all DOM writes are textContent only — never innerHTML;
//  - a friendly "not turned on yet" disabled (503) state;
//  - a visibility-gated, abort-safe polling controller.
//
// Two endpoints back this tab, BOTH already shipping (Slice 1a/1b):
//  - GET /preferences/session-context → { present, block, count } — the active
//    learned preferences as a single plain-language block (the SAME text the
//    session-start hook injects). Raw learning text is never served; the block
//    is the formatted, scrubbed summary.
//  - GET /corrections?limit=N → { records, count, totalRecords, nextBefore } —
//    the deduped, scrubbed correction/preference ledger records (toApiView strips
//    the raw `learning`; only scrubbed_summary + metadata cross the boundary).
// Either returning 503 means the feature is off → the disabled state renders.

// ── Safety: structural sanitize (mirrors process-health §4.6) ──────────────────
// Strip, after the NFKC fold, control + bidi-control characters and cap visible
// length. Presentation chrome here is renderer-OWNED static literals only.
const CAPS = { summary: 240, block: 6000, label: 64, detail: 320 };

const CONTROL_RE = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F]', 'g');
const BIDI_RE = new RegExp('[\\u202A-\\u202E\\u2066-\\u2069]', 'g');

export function sanitizeForDisplay(value, fieldKind = 'summary') {
  let s = value == null ? '' : String(value);
  s = s.normalize('NFKC');
  s = s.replace(CONTROL_RE, ''); // keep \n=0A, \t=09
  s = s.replace(BIDI_RE, '');
  s = s.replace(/\n{3,}/g, '\n\n').replace(/[ \t]{5,}/g, '    ');
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

// ── Friendly wording ───────────────────────────────────────────────────────
const KIND_WORDS = {
  'user-preference': 'How you like things',
  'infra-gap': 'Something the tool itself should handle better',
  noise: 'No clear lesson',
};
export function friendlyKind(kind) {
  return KIND_WORDS[kind] || 'A pattern';
}

// Correction-record lifecycle wording — informational only, no action language.
const STATUS_WORDS = {
  open: 'Just noticed',
  'acted-on': 'Saved and being watched',
  verified: 'Confirmed and sticking',
  inconclusive: 'Watched, but nothing conclusive',
  reopened: 'Came back after I tried adapting',
};
export function friendlyCorrectionStatus(status) {
  return STATUS_WORDS[status] || 'Not set';
}

export function statusDotClass(status) {
  switch (status) {
    case 'open': case 'reopened': return 'status-open';
    case 'acted-on': return 'status-attributed';
    case 'verified': return 'status-verified';
    case 'inconclusive': case 'closed': default: return 'status-closed';
  }
}

export function relativeTime(iso, now = Date.now()) {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return 'recently';
  const sec = Math.max(0, Math.floor((now - t) / 1000));
  if (sec < 90) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `about ${min} minute${min === 1 ? '' : 's'} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `about ${hr} hour${hr === 1 ? '' : 's'} ago`;
  const day = Math.floor(hr / 24);
  if (day < 14) return `about ${day} day${day === 1 ? '' : 's'} ago`;
  const wk = Math.floor(day / 7);
  if (wk < 8) return `about ${wk} week${wk === 1 ? '' : 's'} ago`;
  const mo = Math.floor(day / 30);
  return `about ${mo} month${mo === 1 ? '' : 's'} ago`;
}

// ── DOM helpers (textContent ONLY — never innerHTML) ─────────────────────────
function el(doc, tag, cls, text) {
  const node = doc.createElement(tag);
  if (cls) node.setAttribute('class', cls);
  if (text != null) node.textContent = text;
  return node;
}

function labeledRow(doc, label, value) {
  const row = el(doc, 'div', 'ph-item-row');
  row.appendChild(el(doc, 'span', 'ph-label', `${label}:`));
  row.appendChild(doc.createTextNode(' '));
  row.appendChild(el(doc, 'span', 'ph-value', value));
  return row;
}

function statusDot(doc, status) {
  const dot = doc.createElement('span');
  dot.setAttribute('class', `ph-status-dot ${statusDotClass(status)}`);
  dot.setAttribute('aria-hidden', 'true');
  return dot;
}

// ── Renderers (pure data→DOM) ────────────────────────────────────────────────

/**
 * Headline (informational, not a verdict): how many preferences I've learned.
 * `stale` shows the calm "can't refresh" line, mirroring process-health.
 */
export function renderHeadline(doc, target, { prefCount, stale }) {
  if (!target) return;
  target.replaceChildren();
  if (stale) {
    target.appendChild(el(doc, 'div', 'ph-headline', "Can't refresh right now — showing the last update"));
    target.appendChild(el(doc, 'div', 'ph-subline', "We'll keep trying — nothing is lost."));
    return;
  }
  const n = Number.isFinite(prefCount) ? prefCount : 0;
  const headline = n === 0
    ? "I haven't picked up any preferences yet"
    : `${n} preference${n === 1 ? '' : 's'} I've picked up about you`;
  target.appendChild(el(doc, 'div', 'ph-headline', headline));
  const subline = n === 0
    ? 'When you correct me the same way a few times, I save it here so I stop making you repeat yourself.'
    : 'These get loaded at the start of every conversation, so I follow them without you having to remind me.';
  target.appendChild(el(doc, 'div', 'ph-subline', subline));
}

/**
 * The active preferences block (§10 — "Preferences I've picked up about you").
 * `/preferences/session-context` serves the preferences as ONE formatted,
 * already-scrubbed plain-language block (the same text the session-start hook
 * injects). We render its lines as plain text, dropping the envelope wrapper
 * tags so the user reads the preferences, not the machinery.
 */
export function renderPreferences(doc, target, sessionContext) {
  if (!target) return;
  target.replaceChildren();
  const present = sessionContext && sessionContext.present === true;
  const block = sessionContext && typeof sessionContext.block === 'string' ? sessionContext.block : '';
  if (!present || !block.trim()) {
    target.appendChild(el(doc, 'p', 'ph-empty', "Nothing saved yet — that's normal. Correct me the same way a couple of times and it'll show up here."));
    return;
  }
  const safe = sanitizeForDisplay(block, 'block');
  // Strip the <auto-learned-preference …> envelope tags + the intro line; show
  // the actual preference lines (each begins with a "- " bullet in the block).
  const lines = safe.split('\n');
  const prefLines = lines
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
    .map((l) => l.replace(/^- /, '').trim());
  if (prefLines.length === 0) {
    // Fall back to showing the block as a paragraph (minus the envelope tags).
    const body = lines.filter((l) => !/^<\/?auto-learned-preference/.test(l.trim())).join('\n').trim();
    target.appendChild(el(doc, 'p', 'ph-card-summary', body || safe));
    return;
  }
  for (const line of prefLines) {
    const item = el(doc, 'div', 'ph-item');
    const sum = el(doc, 'div', 'ph-item-summary');
    sum.appendChild(statusDot(doc, 'verified'));
    sum.appendChild(el(doc, 'div', 'ph-card-summary', sanitizeForDisplay(line, 'summary')));
    item.appendChild(sum);
    target.appendChild(item);
  }
}

/**
 * The recent corrections ledger (§10 — scrubbed summaries + metadata + status).
 * Each item is an expandable fact sheet: collapsed shows the plain-language
 * summary; expanded shows kind · status · times seen · first noticed. The raw
 * `learning` is NEVER present in the API view, so it can never reach the DOM.
 */
export function renderCorrections(doc, target, body, now = Date.now()) {
  if (!target) return;
  target.replaceChildren();
  const list = body && Array.isArray(body.records) ? body.records.slice(0, 20) : [];
  if (list.length === 0) {
    target.appendChild(el(doc, 'p', 'ph-empty', "Nothing recorded yet — I only save a pattern after it shows up across a few different days."));
    return;
  }
  for (const r of list) {
    if (!r) continue;
    const kind = friendlyKind(r.kind);
    const summary = sanitizeForDisplay(r.scrubbedSummary, 'summary');
    const item = doc.createElement('details');
    item.setAttribute('class', 'ph-item');
    const sum = doc.createElement('summary');
    sum.setAttribute('class', 'ph-item-summary');
    sum.appendChild(statusDot(doc, r.status));
    sum.appendChild(el(doc, 'div', 'ph-item-text', summary || kind));
    item.appendChild(sum);
    const detail = el(doc, 'div', 'ph-item-body');
    detail.appendChild(labeledRow(doc, 'Kind', kind));
    detail.appendChild(labeledRow(doc, 'Status', friendlyCorrectionStatus(r.status)));
    const occ = Number.isFinite(r.occurrenceCount) ? r.occurrenceCount : 1;
    detail.appendChild(labeledRow(doc, 'Times seen', occ > 1 ? `${occ} times so far` : 'Just once'));
    if (r.detectedAt) detail.appendChild(labeledRow(doc, 'First noticed', relativeTime(r.detectedAt, now)));
    item.appendChild(detail);
    target.appendChild(item);
  }
}

/**
 * Disabled (503) state. Pinned copy + operator hint as PLAIN PROSE — no
 * `<code>`, no monospace, no config-key string (Dashboard Standard).
 */
export function renderDisabled(doc, els) {
  if (els.headline) {
    els.headline.replaceChildren();
    els.headline.appendChild(el(doc, 'div', 'ph-headline', "Learning your preferences isn't turned on for this agent yet."));
    els.headline.appendChild(el(doc, 'div', 'ph-subline', 'Once it is, this page will show the preferences I pick up about how you like to work.'));
    const det = doc.createElement('details');
    det.setAttribute('class', 'ph-operator');
    const s = doc.createElement('summary');
    s.setAttribute('class', 'ph-operator-summary');
    s.textContent = 'For whoever set this up';
    det.appendChild(s);
    det.appendChild(el(doc, 'p', 'ph-operator-hint', 'You can switch it on in this agent’s settings.'));
    els.headline.appendChild(det);
  }
  for (const k of ['preferences', 'corrections']) {
    if (els[k]) els[k].replaceChildren();
  }
  if (els.stamp) els.stamp.textContent = '';
}

// ── Polling controller (visibility-gated, abort-safe, diff-aware) ─────────────
const URLS = {
  prefs: '/preferences/session-context',
  corrections: '/corrections?limit=20',
};

/**
 * Factory so tests can inject fetch + clock + DOM. opts:
 *  - doc: Document; els: { headline, preferences, corrections, stamp }
 *  - fetchImpl: (url, {signal}) => Promise<Response-like>
 *  - now: () => ms; cadenceMs (default 60_000); staleMs (default 180_000)
 *  - schedule/cancel: timer hooks (default setTimeout/clearTimeout)
 */
export function createController(opts) {
  const {
    doc,
    els = {},
    fetchImpl,
    now = () => Date.now(),
    cadenceMs = 60_000,
    staleMs = 180_000,
    schedule = (fn, ms) => setTimeout(fn, ms),
    cancel = (id) => clearTimeout(id),
  } = opts;

  const state = {
    timerId: null,
    inFlight: null,
    active: false,
    snapshot: { prefs: null, corrections: null },
    last200At: 0,
    consecutiveFailedTicks: 0,
    renderedSig: { headline: null, preferences: null, corrections: null, disabled: false },
  };

  async function fetchOne(key, controller) {
    const resp = await fetchImpl(URLS[key], { signal: controller.signal });
    if (resp.status === 503) return { key, status: 503 };
    if (!resp.ok) throw new Error(`${key} ${resp.status}`);
    const body = await resp.json();
    return { key, status: 200, body };
  }

  async function tick() {
    if (!state.active) return;
    if (state.inFlight) {
      try { state.inFlight.abort(); } catch { /* ignore */ }
    }
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : { signal: undefined, abort() {} };
    state.inFlight = controller;
    let results;
    try {
      results = await Promise.all(['prefs', 'corrections'].map((k) => fetchOne(k, controller)));
    } catch {
      if (controller.signal && controller.signal.aborted) return;
      state.inFlight = null;
      state.consecutiveFailedTicks += 1;
      render();
      reschedule();
      return;
    }
    if (controller.signal && controller.signal.aborted) return;
    state.inFlight = null;
    // Feature OFF (503 on EITHER endpoint) → pinned disabled copy.
    if (results.some((r) => r.status === 503)) {
      state.consecutiveFailedTicks = 0;
      if (state.renderedSig.disabled !== true) {
        renderDisabled(doc, els);
        state.renderedSig = { headline: null, preferences: null, corrections: null, disabled: true };
      }
      reschedule();
      return;
    }
    state.renderedSig.disabled = false;
    for (const r of results) {
      if (r.status === 200) { state.snapshot[r.key] = r.body; }
    }
    state.consecutiveFailedTicks = 0;
    state.last200At = now();
    render();
    reschedule();
  }

  function reschedule() {
    if (!state.active) return;
    if (state.timerId != null) cancel(state.timerId);
    state.timerId = schedule(() => { void tick(); }, cadenceMs);
  }

  function headlineStale() {
    if (state.consecutiveFailedTicks >= 2) return true;
    if (state.last200At === 0) return false;
    return now() - state.last200At > staleMs;
  }

  function render() {
    const stale = headlineStale();
    const prefs = state.snapshot.prefs;
    const corrections = state.snapshot.corrections;
    const prefCount = prefs && Number.isFinite(prefs.count) ? prefs.count : 0;

    sectionRender('headline', sig(stale, prefCount), () => renderHeadline(doc, els.headline, { prefCount, stale }));
    sectionRender('preferences', sig(prefs), () => renderPreferences(doc, els.preferences, prefs));
    sectionRender('corrections', sig(corrections), () => renderCorrections(doc, els.corrections, corrections, now()));

    if (els.stamp) {
      const ageS = state.last200At ? Math.max(0, Math.round((now() - state.last200At) / 1000)) : null;
      const stampText = ageS == null ? '' : ageS < 60 ? `updated ${ageS}s ago` : `updated ${Math.round(ageS / 60)}m ago`;
      if (els.stamp.textContent !== stampText) els.stamp.textContent = stampText;
    }
  }

  function sectionRender(key, signature, fn) {
    if (state.renderedSig[key] === signature) return;
    state.renderedSig[key] = signature;
    fn();
  }

  function start() {
    if (state.active) return;
    state.active = true;
    void tick();
  }
  function stop() {
    state.active = false;
    if (state.timerId != null) { cancel(state.timerId); state.timerId = null; }
    if (state.inFlight) { try { state.inFlight.abort(); } catch { /* ignore */ } state.inFlight = null; }
  }

  return { start, stop, tick, render, _state: state };
}

function sig(...parts) {
  try { return JSON.stringify(parts); } catch { return String(Math.random()); }
}

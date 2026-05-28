// Process Health tab — a calm, human-readable read surface for the Failure-Learning Loop.
// Spec: docs/specs/PROCESS-HEALTH-DASHBOARD-TAB-SPEC.md (v4, converged).
//
// Browser-native ESM (no build step; served at /dashboard/process-health.js and
// loaded by index.html via <script type="module">). The pure functions are
// exported so the 3-tier jsdom tests exercise the SHIPPED code, not a copy; the
// controller is also attached to window.ProcessHealth so the (classic) index.html
// script can drive start/stop on tab activation. This is one self-contained
// module for the new tab — NOT a modularization of the SPA (that is §10-deferred).
//
// Load-bearing safety contract (§4.6): every dynamic value flows through
// sanitizeForDisplay before the DOM; all DOM writes are textContent only; all
// presentation chrome is renderer-OWNED static literals (CHROME below) so no
// attacker codepoint can ever sit where chrome is read.

// ── Renderer-owned static chrome (§4.6 r8 belt-and-suspenders, adversarial NEW-1) ──
// These glyphs are the tab's presentation alphabet. They live HERE as static
// literals and are NEVER sourced from data — and sanitizeForDisplay strips this
// exact class from every dynamic value — so a record field can never impersonate
// a marker/separator/caret.
export const CHROME = Object.freeze({
  hereMarker: '← you’re here', // "← you're here"
  sep: ' · ', // " · " record-sentence separator
  caret: '▾', // "▾" drawer caret
  stageDone: '●', // "●" completed stage
  stageHere: '●', // "●" current stage (paired with hereMarker)
  stageFuture: '○', // "○" future stage
});

const CAPS = { summary: 240, recommendation: 320, label: 64, detail: 2048 };

// Structural presentation-glyph class (NOT an enumerated denylist). Strips, after
// the NFKC fold, every codepoint in the symbol classes the chrome draws from, so
// confusable variants (✔ vs ✓, ⇒ vs →, ●︎ with a variation selector) cannot slip
// past: \p{So} (other-symbol) + arrows + geometric + box-drawing + dingbats +
// variation-selectors + the bullet/middot set.
// \p{So} (other-symbol: ★ ● ✓ ✔ ℹ 🔒 …) + arrows U+2190–21FF + geometric
// U+25A0–25FF + box-drawing U+2500–257F + dingbats U+2700–27BF + variation
// selectors U+FE00–FE0F + bullet/middot set (U+2022, U+00B7, U+2027, U+2043).
// Built via RegExp(...) with explicit code points — no invisible source chars.
const CHROME_GLYPH_RE = new RegExp(
  '[\\p{So}\\u2190-\\u21FF\\u25A0-\\u25FF\\u2500-\\u257F\\u2700-\\u27BF\\uFE00-\\uFE0F\\u2022\\u00B7\\u2027\\u2043]',
  'gu',
);
// Invisible-character classes (also explicit code points, no literal controls):
//  C0/C1 controls except \t (U+0009) and \n (U+000A); Unicode bidi-control marks.
const CONTROL_RE = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F]', 'g');
const BIDI_RE = new RegExp('[\\u202A-\\u202E\\u2066-\\u2069]', 'g');

/**
 * §4.6 sanitize contract. Rules: 1 null-coerce; 2 NFKC-fold (collapses full-width/
 * variant confusables BEFORE stripping); 3 strip C0/C1 controls (keep \n,\t);
 * 4 strip bidi-control; 5 collapse newlines + cap whitespace runs; 8 structural
 * chrome-glyph strip; 6 grapheme-safe length cap. (Strip precedes the cap so the
 * cap reflects final visible length — closes the cosmetic under-cap the reviewer
 * flagged; safety is unaffected by the 6/8 order.)
 */
export function sanitizeForDisplay(value, fieldKind = 'summary') {
  let s = value == null ? '' : String(value); // 1
  s = s.normalize('NFKC'); // 2
  s = s.replace(CONTROL_RE, ''); // 3 (keep \n=0A, \t=09)
  s = s.replace(BIDI_RE, ''); // 4 bidi-control
  s = s.replace(/\n{2,}/g, '\n').replace(/[ \t]{5,}/g, '    '); // 5
  s = s.replace(CHROME_GLYPH_RE, ''); // 8 structural chrome-glyph strip
  s = capGraphemes(s, CAPS[fieldKind] ?? CAPS.summary); // 6 grapheme-safe cap
  return s;
}

function capGraphemes(s, max) {
  if (s.length <= max) return s; // UTF-16 length ≥ grapheme count → safe fast path
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    const arr = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s), (x) => x.segment);
    if (arr.length <= max) return s;
    return arr.slice(0, max - 1).join('') + '…';
  }
  // Fallback: never cut between surrogate halves.
  let cut = max - 1;
  const c = s.charCodeAt(cut - 1);
  if (c >= 0xd800 && c <= 0xdbff) cut -= 1;
  return s.slice(0, cut) + '…';
}

/**
 * Heuristic mixed-script flag (§4.6 r7): Latin letters co-occurring with confusable
 * Cyrillic/Greek. The caller renders such a row inertly (no special glyph) — we
 * never add chrome; this only signals.
 */
export function isMixedScript(value) {
  const s = value == null ? '' : String(value);
  const latin = /[A-Za-z]/.test(s);
  const confusable = /[Ѐ-ӿͰ-Ͽ]/.test(s);
  return latin && confusable;
}

/**
 * §4.6 safeUrl. v1 renders NO dynamic URL-bearing attributes (defense-in-depth):
 * allow relative (`/`,`#`) and same-origin http(s) only; reject javascript:/data:/
 * vbscript:/file: and all off-origin hosts → empty string.
 */
export function safeUrl(value) {
  const s = (value == null ? '' : String(value)).trim();
  if (s === '') return '';
  if (s.startsWith('/') || s.startsWith('#')) return s;
  let u;
  try {
    const base = typeof location !== 'undefined' && location.href ? location.href : 'http://localhost/';
    u = new URL(s, base);
  } catch {
    return '';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  const origin = typeof location !== 'undefined' && location.origin ? location.origin : 'http://localhost';
  if (u.origin !== origin) return '';
  return u.href;
}

// ── Friendly wording (§4.2c) ───────────────────────────────────────────────
const CATEGORY_WORDS = {
  concurrency: 'A concurrency issue',
  'config-parse': 'A config problem',
  'type-error': 'A type error',
  'logic-error': 'A logic bug',
  'test-failure': 'A failing test',
  'build-failure': 'A build break',
  'integration-gap': 'An integration gap',
  regression: 'A regression',
  'wiring-gap': 'A wiring gap',
  unknown: 'An issue',
};

export function friendlyCategory(category) {
  const key = typeof category === 'string' ? category : 'unknown';
  return CATEGORY_WORDS[key] || 'An issue';
}

// initiativeId → human label. NEVER expose the raw initiativeId (§4.2c). Seeded
// with the known instar initiatives; unmapped IDs fall back to a generic phrase.
export const ATTRIBUTION_LABELS = {
  'failure-learning-loop': 'the failure-learning loop',
  'process-health-dashboard-tab': 'the process-health tab',
  'ledger-spine': 'the ledger spine',
  'threadline-keystone': 'the agent-network keystone',
};

export function attributionLabel(initiativeId, labelMap = ATTRIBUTION_LABELS) {
  if (typeof initiativeId === 'string' && labelMap[initiativeId]) return labelMap[initiativeId];
  return 'a tracked feature';
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
  if (day < 14) return `about ${spellSmall(day)} day${day === 1 ? '' : 's'} ago`;
  const wk = Math.floor(day / 7);
  if (wk < 8) return `about ${spellSmall(wk)} week${wk === 1 ? '' : 's'} ago`;
  const mo = Math.floor(day / 30);
  return `about ${spellSmall(mo)} month${mo === 1 ? '' : 's'} ago`;
}

const SMALL = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
function spellSmall(n) {
  return n >= 0 && n <= 10 ? SMALL[n] : String(n);
}

// ── DOM helpers (textContent ONLY — never innerHTML; §4.6) ──────────────────
function el(doc, tag, cls, text) {
  const node = doc.createElement(tag);
  if (cls) node.setAttribute('class', cls); // class is a static literal
  if (text != null) node.textContent = text; // dynamic text → textContent ONLY
  return node;
}

// ── Renderers (pure data→DOM; one section per function) ─────────────────────

/**
 * Headline (§4.2a, informational — NOT a verdict) + staleness escalation (§4.1).
 * staleness keyed on the headline endpoint's OWN freshness (adversarial NEW-3).
 */
export function renderHeadline(doc, target, { failures, stale, staleAgeMin }) {
  if (!target) return;
  target.replaceChildren();
  if (stale) {
    target.appendChild(
      el(doc, 'div', 'ph-headline', `Connection paused — showing the last view${staleAgeMin != null ? ` from ${staleAgeMin}m ago` : ''}`),
    );
    target.appendChild(el(doc, 'div', 'ph-subline', "Couldn't refresh just now — showing the last good view. Will retry."));
    return;
  }
  const list = Array.isArray(failures) ? failures : [];
  const n = list.length;
  const open = list.filter((f) => f && f.status !== 'resolved' && f.status !== 'closed').length;
  target.appendChild(el(doc, 'div', 'ph-headline', `Watching — ${n} issue${n === 1 ? '' : 's'} recorded so far`));
  const subline = n === 0 ? 'Nothing recorded yet — capture-only mode' : open === 0 ? 'all linked to a known cause · capture-only mode' : `${open} still being traced · capture-only mode`;
  target.appendChild(el(doc, 'div', 'ph-subline', subline));
}

/**
 * Disabled (503) state (§4.5). Pinned copy + operator hint as PLAIN PROSE — no
 * `<code>`, no monospace, no config-key string (reconciles §2/§4.5/§6.3).
 */
export function renderDisabled(doc, els) {
  if (els.headline) {
    els.headline.replaceChildren();
    els.headline.appendChild(el(doc, 'div', 'ph-headline', 'Process Health isn’t turned on for this agent yet.'));
    els.headline.appendChild(el(doc, 'div', 'ph-subline', 'Once it is, this page will show what it’s noticing.'));
    const det = doc.createElement('details');
    det.setAttribute('class', 'ph-operator');
    const sum = doc.createElement('summary');
    sum.setAttribute('class', 'ph-operator-summary');
    sum.textContent = 'for operators';
    det.appendChild(sum);
    det.appendChild(el(doc, 'p', 'ph-operator-hint', 'An operator can enable it by turning the failure-learning monitor on in the agent settings.'));
    els.headline.appendChild(det);
  }
  for (const k of ['patterns', 'captured', 'maturation', 'detail']) {
    if (els[k]) els[k].replaceChildren();
  }
  if (els.stamp) els.stamp.textContent = '';
}

/** Patterns cards (§4.2b — awareness-only, NO action authority). */
export function renderPatterns(doc, target, insights) {
  if (!target) return;
  target.replaceChildren();
  const list = Array.isArray(insights) ? insights : [];
  if (list.length === 0) {
    target.appendChild(
      el(doc, 'p', 'ph-empty', 'Nothing flagged yet. The monitor needs to see a wider variety of issues before it surfaces a pattern — that’s expected this early.'),
    );
    return;
  }
  for (const ins of list) {
    const card = el(doc, 'div', 'ph-card');
    card.appendChild(el(doc, 'div', 'ph-card-summary', sanitizeForDisplay(ins && ins.summary, 'summary')));
    // Renderer-owned framing line (static literal — NOT a data-restateable prefix).
    card.appendChild(el(doc, 'div', 'ph-card-frame', 'A pattern the monitor noticed — verify before acting.'));
    if (ins && ins.recommendation) {
      card.appendChild(el(doc, 'div', 'ph-card-rec', sanitizeForDisplay(ins.recommendation, 'recommendation')));
    }
    const ds = ins && Number.isFinite(ins.distinctSessions) ? ins.distinctSessions : 0;
    card.appendChild(el(doc, 'div', 'ph-card-evidence', `Seen across ${ds} change${ds === 1 ? '' : 's'}.`));
    target.appendChild(card);
  }
}

/** What's been captured (§4.2c — operator-safe subset only, sentences not rows). */
export function renderCaptured(doc, target, failures, labelMap = ATTRIBUTION_LABELS, now = Date.now()) {
  if (!target) return;
  target.replaceChildren();
  const list = Array.isArray(failures) ? failures.slice(0, 10) : [];
  if (list.length === 0) {
    target.appendChild(el(doc, 'p', 'ph-empty', 'No issues recorded yet — that just means nothing has come through since this was turned on.'));
    return;
  }
  for (const f of list) {
    if (!f) continue;
    const cat = friendlyCategory(f.category);
    const summary = sanitizeForDisplay(f.summary, 'summary');
    const label = attributionLabel(f.initiativeId, labelMap); // NEVER raw initiativeId
    const when = relativeTime(f.detectedAt, now);
    // ONE plain-English sentence. Separator + wording are renderer-owned literals.
    const text = `${cat}: ${summary}${CHROME.sep}attributed to ${label}${CHROME.sep}${when}.`;
    const row = el(doc, 'p', 'ph-record', text);
    if (isMixedScript(f.summary)) row.setAttribute('class', 'ph-record ph-record-inert');
    target.appendChild(row);
  }
}

/** Maturation track (§4.2d). 4th stage is permanently-future (no per-agent flag). */
const STAGES = [
  { key: 'dark', label: 'Dark' },
  { key: 'capture-only', label: 'Capture-only' },
  { key: 'insight-push', label: 'Insight push' },
  { key: 'default-on', label: 'Default for all agents' },
];

export function renderMaturation(doc, target, rollout) {
  if (!target) return;
  target.replaceChildren();
  const stage = rollout && typeof rollout.stage === 'string' ? rollout.stage : 'dark';
  const currentIdx = STAGES.findIndex((s) => s.key === stage);
  for (let i = 0; i < STAGES.length; i++) {
    const s = STAGES[i];
    const isHere = i === currentIdx;
    const done = currentIdx >= 0 && i < currentIdx;
    const row = el(doc, 'div', isHere ? 'ph-stage ph-stage-here' : 'ph-stage');
    // glyph + label + marker are ALL renderer-owned static literals
    row.appendChild(el(doc, 'span', 'ph-stage-glyph', done || isHere ? CHROME.stageDone : CHROME.stageFuture));
    row.appendChild(el(doc, 'span', 'ph-stage-label', s.label));
    if (isHere) row.appendChild(el(doc, 'span', 'ph-stage-marker', CHROME.hereMarker));
    else if (done) row.appendChild(el(doc, 'span', 'ph-stage-note', 'done'));
    target.appendChild(row);
  }
}

/** Detail drawer body (§4.2e — labeled list items, no tables/JSON/monospace). */
export function renderDetail(doc, target, analysis) {
  if (!target) return;
  target.replaceChildren();
  if (!analysis) {
    target.appendChild(el(doc, 'p', 'ph-empty', 'No detail yet.'));
    return;
  }
  const add = (label, val) => target.appendChild(el(doc, 'div', 'ph-detail-row', `${label}: ${val}`));
  add('Total recorded', String(analysis.total ?? 0));
  add('Linked to a known cause', String(analysis.attributed ?? 0));
  add('Not yet linked to a feature', String(analysis.noFeatureLink ?? 0));
  const byCat = analysis.byCategory && typeof analysis.byCategory === 'object' ? analysis.byCategory : {};
  for (const [k, v] of Object.entries(byCat)) {
    add(`Category — ${sanitizeForDisplay(k, 'label')}`, String(v));
  }
  const unknown = analysis.unknownToolchainByAuthor && typeof analysis.unknownToolchainByAuthor === 'object' ? analysis.unknownToolchainByAuthor : {};
  const unknownTotal = Object.values(unknown).reduce((a, b) => a + (Number(b) || 0), 0);
  add('Records with an unknown toolchain', String(unknownTotal));
}

// ── Polling controller (§4.3 — visibility-gated, abort-safe, coordinated, diff-aware) ──

const ENDPOINTS = ['analysis', 'insights', 'failures'];
const URLS = {
  analysis: '/failures/analysis',
  insights: '/failures/insights?limit=50',
  failures: '/failures?limit=10',
};

/**
 * Factory so tests can inject fetch + clock + DOM. opts:
 *  - doc: Document; els: { headline, patterns, captured, maturation, detail, stamp }
 *  - fetchImpl: (url, {headers, signal}) => Promise<Response-like>
 *  - now: () => ms; cadenceMs (default 60_000); staleMs (default 180_000 = 3×cadence)
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
    labelMap = ATTRIBUTION_LABELS,
  } = opts;

  const state = {
    timerId: null,
    inFlight: null,
    active: false,
    snapshot: { analysis: null, insights: null, failures: null },
    etags: { analysis: null, insights: null, failures: null },
    last200At: { analysis: 0, insights: 0, failures: 0 },
    consecutiveFailedTicks: 0,
    consecutive304Ticks: 0,
    renderedSig: { headline: null, patterns: null, captured: null, maturation: null, detail: null, disabled: false },
    nextDelayMs: cadenceMs,
  };

  async function fetchOne(key, controller) {
    const headers = {};
    if (state.etags[key]) headers['If-None-Match'] = state.etags[key];
    const resp = await fetchImpl(URLS[key], { headers, signal: controller.signal });
    if (resp.status === 304) return { key, status: 304 };
    if (resp.status === 503) return { key, status: 503 }; // feature OFF — distinct from a transient failure
    if (!resp.ok) throw new Error(`${key} ${resp.status}`);
    const etag = resp.headers && typeof resp.headers.get === 'function' ? resp.headers.get('ETag') : null;
    const body = await resp.json();
    return { key, status: 200, etag, body };
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
      results = await Promise.all(ENDPOINTS.map((k) => fetchOne(k, controller)));
    } catch (err) {
      // Any endpoint hard-failed → drop the whole tick, keep prior render.
      if (controller.signal && controller.signal.aborted) return; // superseded; let the new tick own state
      state.inFlight = null;
      state.consecutiveFailedTicks += 1;
      render();
      reschedule();
      return;
    }
    if (controller.signal && controller.signal.aborted) return;
    state.inFlight = null;
    // Feature OFF (503) → pinned disabled copy, not the "connection paused" path.
    if (results.some((r) => r.status === 503)) {
      state.consecutiveFailedTicks = 0;
      state.consecutive304Ticks = 0;
      if (state.renderedSig.disabled !== true) {
        renderDisabled(doc, els);
        state.renderedSig = { headline: null, patterns: null, captured: null, maturation: null, detail: null, disabled: true };
      }
      reschedule();
      return;
    }
    state.renderedSig.disabled = false;
    let any200 = false;
    let all304 = true;
    for (const r of results) {
      if (r.status === 200) {
        any200 = true;
        all304 = false;
        state.snapshot[r.key] = r.body;
        if (r.etag) state.etags[r.key] = r.etag;
        state.last200At[r.key] = now();
      }
    }
    if (any200) {
      state.consecutiveFailedTicks = 0;
      state.consecutive304Ticks = 0;
    } else if (all304) {
      state.consecutive304Ticks += 1;
    }
    render();
    reschedule();
  }

  function reschedule() {
    if (!state.active) return;
    state.nextDelayMs = state.consecutive304Ticks >= 5 ? 300_000 : cadenceMs;
    if (state.timerId != null) cancel(state.timerId);
    state.timerId = schedule(() => { void tick(); }, state.nextDelayMs);
  }

  // Headline staleness keyed on the headline endpoint's OWN last-200 (NEW-3):
  // either 2 hard-fail ticks, OR /failures hasn't produced a fresh 200 within the
  // ceiling — even if siblings keep returning 200/304.
  function headlineStale() {
    if (state.consecutiveFailedTicks >= 2) return true;
    const last = state.last200At.failures;
    if (last === 0) return false; // never loaded yet → not "stale", just initial
    return now() - last > staleMs;
  }

  function render() {
    const stale = headlineStale();
    const staleAgeMin = state.last200At.failures ? Math.max(0, Math.round((now() - state.last200At.failures) / 60_000)) : null;
    const failuresBody = state.snapshot.failures;
    const failures = failuresBody && Array.isArray(failuresBody.failures) ? failuresBody.failures : [];
    const insightsBody = state.snapshot.insights;
    const insights = insightsBody && Array.isArray(insightsBody.insights) ? insightsBody.insights : [];
    const analysis = state.snapshot.analysis;
    const rollout = analysis && analysis.rollout ? analysis.rollout : null;

    // Diff-aware: skip a section's DOM writes when its inputs are unchanged
    // (guarantees 0 mutations on identical ticks; no flicker). Sections rebuild
    // via replaceChildren (NOT innerHTML) only when their signature changes.
    sectionRender('headline', sig(stale, staleAgeMin, failures.length, countOpen(failures)), () =>
      renderHeadline(doc, els.headline, { failures, stale, staleAgeMin }),
    );
    sectionRender('patterns', sig(insights), () => renderPatterns(doc, els.patterns, insights));
    sectionRender('captured', sig(failures), () => renderCaptured(doc, els.captured, failures, labelMap, now()));
    sectionRender('maturation', sig(rollout), () => renderMaturation(doc, els.maturation, rollout));
    sectionRender('detail', sig(analysis), () => renderDetail(doc, els.detail, analysis));

    if (els.stamp) {
      const ageS = state.last200At.failures ? Math.max(0, Math.round((now() - state.last200At.failures) / 1000)) : null;
      const stampText = ageS == null ? '' : ageS < 60 ? `updated ${ageS}s ago` : `updated ${Math.round(ageS / 60)}m ago`;
      if (els.stamp.textContent !== stampText) els.stamp.textContent = stampText;
    }
  }

  function sectionRender(key, signature, fn) {
    if (state.renderedSig[key] === signature) return; // unchanged → 0 mutations
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
  function onVisible() { if (!state.active) { start(); } }
  function onHidden() { stop(); }

  return { start, stop, onVisible, onHidden, tick, render, _state: state };
}

function countOpen(failures) {
  return failures.filter((f) => f && f.status !== 'resolved' && f.status !== 'closed').length;
}
function sig(...parts) {
  try { return JSON.stringify(parts); } catch { return String(Math.random()); }
}

// Shared glance component — the three-layer template for the Dashboard UX Standard
// glance floors F10 (glance) + F11 (universal drill-down). Spec:
// docs/specs/dashboard-ux-standard.md ("The glance floors", topic 29836).
//
// Browser-native ESM (no build step; served at /dashboard/glance.js and imported by
// index.html on tab activation). The pure functions are exported so the three-tier
// jsdom tests exercise the SHIPPED code, not a copy.
//
// THE THREE LAYERS
//   Layer 1 (glance)  — one plain-English headline + ≤5 labeled tiles. 100%
//                       COMPONENT-AUTHORED: no agent/user free text ever reaches it.
//   Layer 2 (list)    — click a tile → the rows behind that number, in plain words.
//   Layer 3 (record)  — click a row → the full record (IDs, timestamps, raw detail).
//
// LOAD-BEARING SAFETY CONTRACT (mirrors dashboard/subscriptions.js): every dynamic
// value flows through sanitizeForDisplay before the DOM; ALL DOM writes are
// textContent only (never innerHTML); the only dynamic attributes are a fixed
// state→literal token and a numeric count. Agent/user free text lives at Layer 2/3
// where it is *displayed* through the sanitizer — it is never vocab-gated (F10's
// jargon check runs only over the component-authored Layer-1 strings).
//
// F9 COMPOSITION: while a drill interaction is open (the drill container carries
// data-interaction-open, or a field is focused/dirty) a background refresh MERGES
// live counts via patchGlanceCounts instead of rebuilding over the interaction —
// reusing the shipped hasOpenInteraction primitive.

import { sanitizeForDisplay, hasOpenInteraction } from './subscriptions.js';

export const GLANCE_MAX_TILES = 5;
export const GLANCE_WORD_BUDGET = 150; // words on the front page before interaction
export const GLANCE_MAX_TOKEN_LEN = 40; // a longer token is a glued-word budget dodge

// ── The glance-adopted / grandfathered registries (the ratchet) ──────────────
// A tab is ON the glance floor (F10/F11 apply) once it builds its glance through
// this component. GLANCE_ADOPTED_TABS grows as tabs migrate; GLANCE_GRANDFATHERED
// is every registered tab NOT yet on the floor, grandfathered against the survey
// scorecard (topic 29836). THE RATCHET: the grandfather list only shrinks — a tab
// leaves it only by adopting the floor (and passing F10/F11). Adding a tab here (or
// shipping a NEW tab grandfathered) requires raising GLANCE_GRANDFATHERED_CEILING,
// a visible committed change that needs a written justification + operator sign-off
// (same discipline as the F3 purpose-line exempt list). The completeness test
// asserts adopted ∪ grandfathered == every TAB_REGISTRY id, so a NEW tab in NEITHER
// set fails the build; the monotonicity test asserts the grandfather size ≤ ceiling.
export const GLANCE_ADOPTED_TABS = ['commitments'];

export const GLANCE_GRANDFATHERED = [
  'insights', 'sessions', 'files', 'dropzone', 'jobs', 'features', 'systems',
  'integrated-being', 'pr-pipeline', 'projects', 'initiatives', 'tokens',
  'resources', 'llm-activity', 'routing-map', 'spend', 'threadline', 'evidence',
  'process-health', 'subscriptions', 'preferences-learning', 'machines', 'mandates',
  'blockers', 'secrets',
];

// The committed ceiling on grandfathered-tab count. Only ever LOWER this (each
// lowering marks a tab retrofitted onto the floor). Never raise it without an
// operator-signed justification — raising it is how a NEW tab would silently ship
// below the floor, the exact regression the ratchet exists to prevent.
export const GLANCE_GRANDFATHERED_CEILING = 25;

// ── F10 — insider-vocab detection ────────────────────────────────────────────
// A readability floor, NOT a secret-redaction boundary (secret handling stays at
// the API/data layer). It scans ONLY component-authored Layer-1 strings (headline +
// tile labels + tile values), so it can never blank the glance on user free text.

// Concept-jargon the form heuristics can't catch (curated; extend as jargon is
// found). Matched case-insensitively as whole words/phrases over normalized text.
const INSIDER_TERM_DENYLIST = [
  'atrisk', 'at risk', 'at-risk', 'suppressed', 'beacon', 'beacons',
  'beaconenabled', 'beaconsuppressed', 'cadence', 'heartbeat', 'heartbeats',
  'lane', 'reflow', 'ttl', 'slo', 'sla', 'mrr', 'paid door', 'money-gated',
  'quiet-hours', 'quiet hours',
];

// Internal IDs: a letter-run glued or hyphen/underscore-joined to 3+ digits
// (CMT-953, CMT_953, cmt953) — separator-agnostic, case-insensitive, NOT
// space-separated (so a quantity like "664 open promises" is never flagged).
const ID_RE = /[a-z]{2,}[-_]?\d{3,}/i;
// An all-caps prefix + optional space/sep + 3+ digits (CMT 953 / CMT-953) — safe
// because component-authored plain copy never writes an ALLCAPS token beside a number.
const ALLCAPS_ID_RE = /\b[A-Z]{2,6}[-_ ]?\d{3,}\b/;
// Machine/agent hex ids: m_<hex>, agent_<hex>, machine-<hex-with-digit>.
const HEX_ID_RE = /\b(?:[a-z]{1,}_[0-9a-f]{4,}|m_[0-9a-f]{4,}|[a-z]{2,}-[0-9a-f]*\d[0-9a-f]*)\b/i;
// Config keys: a camelCase transition (softDeadlineAt) or a snake_case token.
const CAMEL_RE = /\b[a-z][a-z0-9]*[A-Z][a-zA-Z0-9]*\b/;
const SNAKE_RE = /\b[a-z0-9]+_[a-z0-9]+\b/i;
// Machine-duration cadences: a bare number glued/spaced to a time unit — 1800s,
// 1800 s, 1800sec, 1800000ms, PT30M — EXCLUDING 4-digit year/decade prose ("1800s"
// meaning the 1800s decade is excluded via the decade guard below).
const CADENCE_RE = /\b\d{1,9}\s?(?:ms|milliseconds?|secs?|seconds?|s)\b|\bPT\d+[HMSD]\b/i;
const DECADE_RE = /^(?:1[5-9]\d0|20[0-4]\d)s$/i; // 1500s..1990s, 2000s..2049s

/**
 * Return the insider-vocabulary hits in a component-authored string. Empty array =
 * clean. Each hit is { type, match }. NFKC-normalized + case-insensitive so
 * look-alike glyphs and case tricks can't dodge the check.
 */
export function findInsiderVocab(text) {
  const norm = String(text == null ? '' : text).normalize('NFKC');
  const lower = norm.toLowerCase();
  const hits = [];

  const id = norm.match(ID_RE) || norm.match(ALLCAPS_ID_RE);
  if (id) hits.push({ type: 'internal-id', match: id[0] });
  const hex = norm.match(HEX_ID_RE);
  if (hex) hits.push({ type: 'machine-id', match: hex[0] });
  const camel = norm.match(CAMEL_RE);
  if (camel) hits.push({ type: 'config-key', match: camel[0] });
  const snake = norm.match(SNAKE_RE);
  if (snake) hits.push({ type: 'config-key', match: snake[0] });

  for (const m of lower.matchAll(new RegExp(CADENCE_RE, 'gi'))) {
    const tok = m[0].replace(/\s+/g, '');
    // "1800s" is ambiguous (1800 seconds vs the 1800s decade). Only treat it as a
    // decade — and skip — when it reads as decade PROSE (preceded by "the"/"in").
    if (DECADE_RE.test(tok)) {
      const before = lower.slice(Math.max(0, m.index - 8), m.index);
      if (/\b(?:the|in|early|late|mid)\s+$/.test(before)) continue;
    }
    hits.push({ type: 'cadence', match: m[0].trim() });
  }

  for (const term of INSIDER_TERM_DENYLIST) {
    // Word/phrase boundary so "beacon" matches but "beaconing-signal-lantern" as a
    // whole is still caught by the substring intent; keep it simple + robust.
    const re = new RegExp(`(?:^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^a-z0-9])`, 'i');
    if (re.test(lower)) hits.push({ type: 'insider-term', match: term });
  }
  return hits;
}

/**
 * Tokenize Layer-1 copy for the word budget: split on whitespace and structural
 * punctuation (hyphen / underscore / slash / common separators) so a glued
 * "carrying-664-open-cmt953" cannot pose as one word. A token longer than
 * GLANCE_MAX_TOKEN_LEN is itself a budget dodge and is reported separately.
 */
export function tokenizeGlance(text) {
  return String(text == null ? '' : text)
    .normalize('NFKC')
    .split(/[\s\-_/.,;:·|()[\]{}]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

export function countGlanceWords(text) {
  return tokenizeGlance(text).length;
}

/** The full component-authored Layer-1 text: headline + every tile label + value. */
export function glanceText(spec) {
  const parts = [String(spec?.headline ?? '')];
  for (const t of spec?.tiles ?? []) {
    parts.push(String(t?.label ?? ''));
    parts.push(String(t?.value ?? ''));
  }
  return parts.join(' ');
}

/**
 * F10 validator — the shared component refuses to build a glance that breaks the
 * budget or carries jargon. Returns { ok, violations: [{code, detail}] }. Scans the
 * concatenation of headline + every tile label + every tile value (all
 * component-authored) — there is no free-text hole to hide jargon in.
 */
export function validateGlanceSpec(spec) {
  const violations = [];
  const tiles = Array.isArray(spec?.tiles) ? spec.tiles : [];

  if (!spec || typeof spec.headline !== 'string' || spec.headline.trim() === '') {
    violations.push({ code: 'no-headline', detail: 'a glance needs one plain-English headline sentence' });
  }
  if (tiles.length > GLANCE_MAX_TILES) {
    violations.push({ code: 'too-many-tiles', detail: `${tiles.length} tiles > max ${GLANCE_MAX_TILES}` });
  }

  const text = glanceText(spec);
  const words = countGlanceWords(text);
  if (words > GLANCE_WORD_BUDGET) {
    violations.push({ code: 'over-budget', detail: `${words} words > budget ${GLANCE_WORD_BUDGET}` });
  }
  for (const tok of tokenizeGlance(text)) {
    if (tok.length > GLANCE_MAX_TOKEN_LEN) {
      violations.push({ code: 'glued-token', detail: `"${tok.slice(0, 24)}…" (${tok.length} chars) evades the word count` });
      break;
    }
  }

  const jargon = findInsiderVocab(text);
  for (const hit of jargon) {
    violations.push({ code: 'insider-vocab', detail: `${hit.type}: "${hit.match}"` });
  }

  return { ok: violations.length === 0, violations };
}

// ── Rendering ────────────────────────────────────────────────────────────────

function el(doc, tag, cls, text) {
  const node = doc.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = sanitizeForDisplay(text, 'label');
  return node;
}

/**
 * Render the three-layer glance into `root` from `spec`:
 *   spec = { headline, tiles: [{ key, label, value, tone?, onActivate?(ctx) }] }
 * Honors F9: if an interaction is open under `root`, MERGE live counts instead of
 * rebuilding (patchGlanceCounts). On a spec that fails validation renders an HONEST
 * DEGRADED glance (truncated headline + a "See details" drill) — NEVER a raw-record
 * fallback. Returns a handle { root, headline, tiles, drilldown, spec }.
 */
export function renderGlance(doc, root, spec, opts = {}) {
  if (!doc || !root) return null;

  // F9 merge arm: an open drill / focused / dirty interaction holds the DOM.
  if (root.querySelector('[data-glance-layer]') && hasOpenInteraction(doc, root)) {
    patchGlanceCounts(doc, root, spec);
    return { root, held: true, spec };
  }

  const { ok, violations } = validateGlanceSpec(spec);
  if (!ok && typeof console !== 'undefined' && console.warn) {
    console.warn('[glance] spec failed F10 validation — rendering honest degraded glance:', violations);
  }

  // Replace, don't append — repeated renders never leak detached DOM/listeners.
  root.replaceChildren();

  const layer = el(doc, 'div', 'glance-layer');
  layer.setAttribute('data-glance-layer', '');

  const headline = el(doc, 'div', 'glance-headline');
  headline.setAttribute('data-glance-headline', '');
  // Degraded mode: truncate to budget, never dump raw records.
  const headlineText = ok
    ? String(spec?.headline ?? '')
    : truncateToWords(String(spec?.headline ?? 'Details available'), GLANCE_WORD_BUDGET);
  headline.textContent = sanitizeForDisplay(headlineText, 'summary');
  layer.appendChild(headline);

  const drilldown = doc.createElement('section');
  drilldown.className = 'glance-drilldown';
  drilldown.setAttribute('data-glance-drilldown', '');
  drilldown.hidden = true;

  const tilesWrap = el(doc, 'div', 'glance-tiles');
  tilesWrap.setAttribute('data-glance-tiles', '');
  const tiles = Array.isArray(spec?.tiles) ? spec.tiles : [];
  const tileNodes = [];
  const usableTiles = ok ? tiles.slice(0, GLANCE_MAX_TILES) : [];
  for (const tile of usableTiles) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'glance-tile';
    btn.setAttribute('data-glance-tile', String(tile.key ?? tile.label ?? ''));
    if (tile.tone) btn.setAttribute('data-tone', String(tile.tone));
    btn.setAttribute('aria-expanded', 'false');

    const valEl = el(doc, 'span', 'glance-tile-value');
    valEl.setAttribute('data-glance-count', '');
    valEl.textContent = sanitizeForDisplay(String(tile.value ?? ''), 'label');
    const labelEl = el(doc, 'span', 'glance-tile-label', String(tile.label ?? ''));

    // Accessible label (F5) — never an icon-only/bare control.
    btn.setAttribute('aria-label', `${sanitizeForDisplay(String(tile.label ?? ''), 'label')}: ${sanitizeForDisplay(String(tile.value ?? ''), 'label')}`);
    btn.appendChild(valEl);
    btn.appendChild(labelEl);

    btn.addEventListener('click', () => openDrill(doc, root, drilldown, btn, tile, tileNodes));
    tilesWrap.appendChild(btn);
    tileNodes.push(btn);
  }

  // Degraded fallback: one honest "See details" affordance, never the raw dump.
  if (!ok) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'glance-tile glance-tile-degraded';
    btn.setAttribute('data-glance-tile', '__details__');
    btn.setAttribute('aria-expanded', 'false');
    btn.appendChild(el(doc, 'span', 'glance-tile-label', 'See details'));
    btn.addEventListener('click', () => openDrill(doc, root, drilldown, btn, {
      key: '__details__',
      onActivate: (ctx) => { ctx.drilldown.appendChild(el(doc, 'div', 'glance-empty', 'Details are being prepared.')); },
    }, tileNodes));
    tilesWrap.appendChild(btn);
    tileNodes.push(btn);
  }

  layer.appendChild(tilesWrap);
  root.appendChild(layer);
  root.appendChild(drilldown);

  return { root, headline, tiles: tileNodes, drilldown, spec };
}

function truncateToWords(text, max) {
  const toks = tokenizeGlance(text);
  if (toks.length <= max) return text;
  return toks.slice(0, max).join(' ') + '…';
}

/**
 * Open a tile's drill (Layer 2). Replaces the drill container (never appends),
 * calls the tile's onActivate to populate it, reveals it, and marks it
 * data-interaction-open so a background refresh HOLDS it (F9). Clicking the same
 * tile again (or the Back control) releases the hold. onActivate receives:
 *   { doc, drilldown, tile, openRecord } — openRecord(node) swaps in a Layer-3 record.
 */
function openDrill(doc, root, drilldown, btn, tile, allTiles) {
  const alreadyOpen = drilldown.getAttribute('data-open-tile') === btn.getAttribute('data-glance-tile') && !drilldown.hidden;
  // Collapse any open tile first.
  for (const t of allTiles) t.setAttribute('aria-expanded', 'false');
  drilldown.replaceChildren();
  drilldown.removeAttribute('data-interaction-open');

  if (alreadyOpen) {
    drilldown.hidden = true;
    drilldown.removeAttribute('data-open-tile');
    return;
  }

  const header = el(doc, 'div', 'glance-drill-header');
  const back = doc.createElement('button');
  back.type = 'button';
  back.className = 'glance-drill-back';
  back.setAttribute('aria-label', 'Back to the glance');
  back.textContent = '← Back';
  back.addEventListener('click', () => {
    drilldown.replaceChildren();
    drilldown.hidden = true;
    drilldown.removeAttribute('data-interaction-open');
    drilldown.removeAttribute('data-open-tile');
    btn.setAttribute('aria-expanded', 'false');
  });
  header.appendChild(back);
  const title = el(doc, 'span', 'glance-drill-title', tile.label != null ? String(tile.label) : 'Details');
  header.appendChild(title);
  drilldown.appendChild(header);

  const body = el(doc, 'div', 'glance-drill-body');
  body.setAttribute('data-glance-drill-body', '');
  drilldown.appendChild(body);

  const openRecord = (node) => {
    // Layer 3: swap the list for the full record, with a Back-to-list control.
    const recWrap = el(doc, 'div', 'glance-record');
    recWrap.setAttribute('data-glance-record', '');
    const toList = doc.createElement('button');
    toList.type = 'button';
    toList.className = 'glance-drill-back';
    toList.setAttribute('aria-label', 'Back to the list');
    toList.textContent = '← Back to list';
    const priorList = Array.from(body.childNodes);
    toList.addEventListener('click', () => {
      body.replaceChildren(...priorList);
    });
    recWrap.appendChild(toList);
    if (node) recWrap.appendChild(node);
    body.replaceChildren(recWrap);
  };

  try {
    if (typeof tile.onActivate === 'function') {
      tile.onActivate({ doc, drilldown: body, tile, openRecord });
    }
  } catch (err) {
    // A drill builder that throws must not white-screen the tab: show an honest
    // error state, never a raw dump. @silent-fallback-ok — degraded drill, logged.
    body.replaceChildren(el(doc, 'div', 'glance-empty', 'Could not load these details right now.'));
    if (typeof console !== 'undefined' && console.warn) console.warn('[glance] drill onActivate failed:', err);
  }

  // An honest F6 empty-state if the drill produced nothing (e.g. a zero-count tile).
  if (body.childNodes.length === 0) {
    body.appendChild(el(doc, 'div', 'glance-empty', 'Nothing here right now.'));
  }

  drilldown.setAttribute('data-open-tile', btn.getAttribute('data-glance-tile') || '');
  drilldown.setAttribute('data-interaction-open', 'glance-drill');
  drilldown.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
}

/**
 * F9 merge arm — patch the live tile counts (and headline) from a fresh spec
 * WITHOUT rebuilding the DOM, so an open drill interaction is never clobbered.
 * Returns the number of tiles patched.
 */
export function patchGlanceCounts(doc, root, spec) {
  if (!root || !spec) return 0;
  let patched = 0;
  const headline = root.querySelector('[data-glance-headline]');
  if (headline && typeof spec.headline === 'string') {
    headline.textContent = sanitizeForDisplay(spec.headline, 'summary');
  }
  for (const tile of spec.tiles ?? []) {
    const key = String(tile.key ?? tile.label ?? '');
    const btn = root.querySelector(`[data-glance-tile="${cssEscape(key)}"]`);
    if (!btn) continue;
    const val = btn.querySelector('[data-glance-count]');
    if (val) { val.textContent = sanitizeForDisplay(String(tile.value ?? ''), 'label'); patched++; }
  }
  return patched;
}

function cssEscape(s) {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
  return String(s).replace(/["\\\]]/g, '\\$&');
}

// ── Commitments reference builder (the Phase-1 living example) ────────────────
// Pure: turns the /commitments open-promises list into a glance spec. Derives every
// tile + the headline from ONE population — the beacon-watched open promises
// (beaconEnabled && status==='pending'), the identical set the drill-down shows — so
// the headline count EQUALS the Layer-2 list length by construction, and each tile
// maps to an EXISTING server field (no client-side state re-derivation).

/** The single population: beacon-watched open promises. */
export function commitmentsOpenPopulation(commitments) {
  return (Array.isArray(commitments) ? commitments : [])
    .filter((c) => c && c.beaconEnabled && c.status === 'pending');
}

export function buildCommitmentsGlance(commitments, now = Date.now()) {
  const open = commitmentsOpenPopulation(commitments);
  const dueSoon = open.filter((c) => c.atRisk === true);
  const waiting = open.filter((c) => c.blockedOn === 'user-input' || c.blockedOn === 'user-authorization');
  const quiet = open.filter((c) => c.beaconSuppressed === true);
  const overdue = open.filter((c) => c.hardDeadlineAt && Date.parse(c.hardDeadlineAt) < now);

  // Component-authored, jargon-free headline — honest to the one population.
  let headline;
  if (open.length === 0) {
    headline = "You have no open promises right now.";
  } else {
    const soonClause = dueSoon.length > 0 ? `${dueSoon.length} need attention soon` : 'none need attention soon';
    const overdueClause = overdue.length > 0 ? `${overdue.length} overdue` : 'none overdue';
    const noun = open.length === 1 ? 'open promise' : 'open promises';
    headline = `I'm carrying ${open.length} ${noun}; ${soonClause}, ${overdueClause}.`;
  }

  const tiles = [
    { key: 'open', label: 'Open', value: String(open.length), tone: 'neutral', rows: open },
    { key: 'due-soon', label: 'Due soon', value: String(dueSoon.length), tone: dueSoon.length ? 'warn' : 'neutral', rows: dueSoon },
    { key: 'waiting', label: 'Waiting on you', value: String(waiting.length), tone: waiting.length ? 'warn' : 'neutral', rows: waiting },
    { key: 'quiet', label: 'Quiet', value: String(quiet.length), tone: 'muted', rows: quiet },
  ];

  return { headline, tiles, population: open };
}

/** One plain-word Layer-2 row for a commitment (no IDs/cadences — those are Layer 3). */
export function commitmentRowText(c) {
  const summary = sanitizeForDisplay(c.agentResponse || c.userRequest || 'A promise', 'summary');
  return summary;
}

function defaultFmtTs(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString(); } catch { return String(iso); }
}

/**
 * Layer-3 full record for a commitment — the raw detail (IDs, cadence, deadlines)
 * lives HERE, one click below the plain Layer-2 row. All values via textContent
 * (XSS-safe); this is where insider fields legitimately appear. Optional onDeliver
 * wires the existing "Mark delivered" action onto the record.
 */
export function commitmentRecordNode(doc, c, opts = {}) {
  const fmtTs = opts.fmtTs || defaultFmtTs;
  const wrap = el(doc, 'div', 'glance-record-fields');
  const rows = [
    ['Promise', c.agentResponse || c.userRequest || '—'],
    ['id', c.id || '—'],
    ['topic', c.topicId != null ? String(c.topicId) : '—'],
    ['cadence', c.cadenceMs ? `${Math.round(c.cadenceMs / 1000)}s` : '—'],
    ['heartbeats', String(c.heartbeatCount ?? 0)],
    ['last heartbeat', fmtTs(c.lastHeartbeatAt)],
    ['soft deadline', fmtTs(c.softDeadlineAt)],
    ['hard deadline', fmtTs(c.hardDeadlineAt)],
  ];
  for (const [k, v] of rows) {
    const row = el(doc, 'div', 'glance-record-row');
    row.appendChild(el(doc, 'span', 'glance-record-key', String(k)));
    row.appendChild(el(doc, 'span', 'glance-record-val', String(v)));
    wrap.appendChild(row);
  }
  if (typeof opts.onDeliver === 'function' && c.id) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'glance-record-action';
    btn.textContent = 'Mark delivered';
    btn.addEventListener('click', () => { btn.disabled = true; opts.onDeliver(c.id); });
    wrap.appendChild(btn);
  }
  return wrap;
}

/**
 * Build the FULL Commitments glance spec with drill wiring — the reference
 * implementation, importable by index.html AND the three test tiers. Each tile's
 * onActivate renders the filtered open-promises as plain Layer-2 rows; each row
 * opens the Layer-3 record. Population + counts come from buildCommitmentsGlance
 * (one denominator, honest counts).
 */
export function commitmentsGlanceSpec(doc, commitments, opts = {}) {
  const now = opts.now ?? Date.now();
  const base = buildCommitmentsGlance(commitments, now);
  const tiles = base.tiles.map((t) => ({
    key: t.key,
    label: t.label,
    value: t.value,
    tone: t.tone,
    onActivate: ({ doc: d, drilldown, openRecord }) => {
      const rows = t.rows || [];
      if (rows.length === 0) return; // component renders the honest F6 empty-state
      const list = el(d, 'div', 'glance-list');
      for (const c of rows) {
        const row = d.createElement('button');
        row.type = 'button';
        row.className = 'glance-list-row';
        row.setAttribute('aria-label', 'Open the full record');
        row.appendChild(el(d, 'span', 'glance-list-summary', commitmentRowText(c)));
        row.addEventListener('click', () => openRecord(commitmentRecordNode(d, c, { onDeliver: opts.onDeliver })));
        list.appendChild(row);
      }
      drilldown.appendChild(list);
    },
  }));
  return { headline: base.headline, tiles, population: base.population };
}

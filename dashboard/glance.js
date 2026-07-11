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
export const GLANCE_ADOPTED_TABS = [
  'commitments', 'blockers', // Phases 1–2
  'machines', 'systems', 'spend', 'routing-map', // Phase 3 (the jargon belt); 'systems' is the Health tab
  // Phase 4 — the sweep: every remaining data-summary view on the floor.
  'pr-pipeline', 'tokens', 'llm-activity', 'secrets', 'resources', 'initiatives',
];

export const GLANCE_GRANDFATHERED = [
  'insights', 'sessions', 'files', 'dropzone', 'jobs', 'features',
  'integrated-being', 'projects', 'threadline', 'evidence',
  'process-health', 'subscriptions', 'preferences-learning', 'mandates',
]; // Phase 3 removed machines / systems (Health) / spend / routing-map.
   // Phase 4 removed pr-pipeline / tokens / llm-activity / secrets / resources /
   // initiatives. The remainder are interactive/console/module surfaces where the
   // read-only glance model does not fit — enumerated as ratified exceptions (PR body).

// The committed ceiling on grandfathered-tab count. Only ever LOWER this (each
// lowering marks a tab retrofitted onto the floor). Never raise it without an
// operator-signed justification — raising it is how a NEW tab would silently ship
// below the floor, the exact regression the ratchet exists to prevent.
// Lowered 25 → 24 (Phase 2): Blockers retrofitted.
// Lowered 24 → 20 (Phase 3): Machines, Health (systems), Spend, Routing Map retrofitted.
// Lowered 20 → 14 (Phase 4 — the sweep): pr-pipeline, tokens, llm-activity, secrets,
//   resources, initiatives retrofitted. The 14 remaining are interactive/console/
//   module surfaces enumerated for operator ratification (see the Phase-4 PR body).
export const GLANCE_GRANDFATHERED_CEILING = 14;

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
  // OVERDUE TAKES PRECEDENCE over due-soon (issue #1435 §3): a promise whose HARD
  // deadline is already in the past is OVERDUE, never merely "due soon". The old
  // build classified due-soon purely from atRisk, so a stale beacon record a month
  // past its hard deadline showed as "due soon" — the reported defect. Classify
  // overdue FIRST, then take due-soon over the REMAINDER (atRisk but not overdue).
  const overdue = open.filter((c) => c.hardDeadlineAt && Date.parse(c.hardDeadlineAt) < now);
  const overdueSet = new Set(overdue);
  const dueSoon = open.filter((c) => c.atRisk === true && !overdueSet.has(c));
  const waiting = open.filter((c) => c.blockedOn === 'user-input' || c.blockedOn === 'user-authorization');
  const quiet = open.filter((c) => c.beaconSuppressed === true);

  // Component-authored, jargon-free headline — honest to the one population.
  // Count-aware verb agreement (#1435 §2): "1 needs" / "2 need", "1 is" / "2 are".
  let headline;
  if (open.length === 0) {
    headline = "You have no open promises right now.";
  } else {
    const soonClause = dueSoon.length === 0 ? 'none need attention soon'
      : dueSoon.length === 1 ? '1 needs attention soon'
      : `${dueSoon.length} need attention soon`;
    const overdueClause = overdue.length === 0 ? 'none are overdue'
      : overdue.length === 1 ? '1 is overdue'
      : `${overdue.length} are overdue`;
    const noun = open.length === 1 ? 'open promise' : 'open promises';
    headline = `I'm carrying ${open.length} ${noun}; ${soonClause}, ${overdueClause}.`;
  }

  // Every number the headline states now has a tile to drill into (#1435 §1): the
  // "overdue" count gets its own OVERDUE tile — the most actionable state, so we add
  // the tile rather than dropping the clause. Five tiles = the F10 max.
  const tiles = [
    { key: 'open', label: 'Open', value: String(open.length), tone: 'neutral', rows: open },
    { key: 'due-soon', label: 'Due soon', value: String(dueSoon.length), tone: dueSoon.length ? 'warn' : 'neutral', rows: dueSoon },
    { key: 'overdue', label: 'Overdue', value: String(overdue.length), tone: overdue.length ? 'warn' : 'neutral', rows: overdue },
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

// ── Blockers reference builder (the Phase-2 rebuild) ──────────────────────────
// Turns the /blockers ledger entries into a glance spec. A blocker is a DECAYING
// HYPOTHESIS, not a settled wall (docs/specs/dashboard-ux-standard.md): each entry
// moves through a pipeline (candidate → authority-checked → access-requested →
// dry-run → live-run) and terminates as either RESOLVED (it turned out not to be a
// wall) or a TRUE-BLOCKER (the best current understanding, with a recheck date —
// never "stop trying"). Every tile maps to a state predicate over ONE population
// (the non-archived ledger entries GET /blockers returns), so the counts are honest
// and each headline number has exactly one tile to drill into. The full record
// (id, state, timestamps, terminal detail) lives at Layer 3, one click below the
// plain-language row — the ~7,000-word raw table is gone from the front page but
// nothing is lost, only moved down a layer.

const BLOCKER_NON_TERMINAL = new Set([
  'candidate', 'authority-checked', 'access-requested', 'dry-run', 'live-run',
]);

// Plain-word state names for the Layer-3 record (the raw state token stays honest to
// the ledger but reads as everyday language, never insider jargon at the glance).
const BLOCKER_STATE_WORD = {
  'candidate': 'Just spotted',
  'authority-checked': 'Checked who can clear it',
  'access-requested': 'Asked you for access',
  'dry-run': 'Trying it safely first',
  'live-run': 'Attempting it for real',
  'resolved': 'Resolved — not a wall after all',
  'true-blocker': 'Truly stuck for now (recheck scheduled)',
};

/** The single population: the non-archived ledger entries GET /blockers returns. */
export function blockersPopulation(entries) {
  return (Array.isArray(entries) ? entries : []).filter((e) => e && typeof e.state === 'string');
}

export function buildBlockersGlance(entries) {
  const all = blockersPopulation(entries);
  const working = all.filter((e) => BLOCKER_NON_TERMINAL.has(e.state));
  const stuck = all.filter((e) => e.state === 'true-blocker');
  const resolved = all.filter((e) => e.state === 'resolved');

  // Component-authored, jargon-free headline — honest to the one population, with
  // count-aware verb agreement.
  let headline;
  if (all.length === 0) {
    headline = 'No blockers are being tracked right now.';
  } else {
    const stuckClause = stuck.length === 0 ? 'Nothing is truly stuck right now'
      : stuck.length === 1 ? '1 thing is truly stuck right now'
      : `${stuck.length} things are truly stuck right now`;
    const workClause = working.length === 0 ? 'none are being worked'
      : working.length === 1 ? '1 is being worked'
      : `${working.length} are being worked`;
    headline = `${stuckClause}; ${workClause}.`;
  }

  const tiles = [
    { key: 'stuck', label: 'Truly stuck', value: String(stuck.length), tone: stuck.length ? 'warn' : 'neutral', rows: stuck },
    { key: 'working', label: 'Being worked', value: String(working.length), tone: 'neutral', rows: working },
    { key: 'resolved', label: 'Resolved', value: String(resolved.length), tone: 'muted', rows: resolved },
  ];

  return { headline, tiles, population: all };
}

/** One plain-word Layer-2 row for a blocker — the plain-language framing that opened
 *  it (its detectedText). IDs/timestamps/state machinery are Layer 3, not here. */
export function blockerRowText(e) {
  return sanitizeForDisplay(e.detectedText || e.origin || 'A blocker', 'summary');
}

/**
 * Layer-3 full record for a blocker — every existing column plus terminal detail,
 * one click below the plain Layer-2 row. All values via textContent (XSS-safe):
 * detectedText / origin / terminal free text are UNTRUSTED and are displayed, never
 * interpreted. This is where the raw state token, id, and timestamps legitimately
 * live (they used to be dumped on the front page).
 */
export function blockerRecordNode(doc, e, opts = {}) {
  const fmtTs = opts.fmtTs || defaultFmtTs;
  const wrap = el(doc, 'div', 'glance-record-fields');
  const rows = [
    ['What looked stuck', e.detectedText || '—'],
    ['state', BLOCKER_STATE_WORD[e.state] || e.state || '—'],
    ['id', e.id || '—'],
    ['opened by', e.origin || '—'],
    ['first seen', fmtTs(e.createdAt)],
    ['last update', fmtTs(e.updatedAt)],
  ];
  const t = e.terminal;
  if (t && t.kind === 'resolved') {
    rows.push(['outcome', 'Resolved — it turned out not to be a wall']);
    if (t.playbookPath) rows.push(['playbook', t.playbookPath]);
  } else if (t && t.kind === 'true-blocker') {
    rows.push(['outcome', `Best current understanding (${t.reasonKind || 'reason unknown'}) — not "give up"`]);
    if (t.recheckAfter) rows.push(['recheck after', fmtTs(t.recheckAfter)]);
  }
  for (const [k, v] of rows) {
    const row = el(doc, 'div', 'glance-record-row');
    row.appendChild(el(doc, 'span', 'glance-record-key', String(k)));
    row.appendChild(el(doc, 'span', 'glance-record-val', String(v)));
    wrap.appendChild(row);
  }
  return wrap;
}

/**
 * Build the FULL Blockers glance spec with drill wiring — importable by index.html
 * AND the three test tiers. Each tile's onActivate renders the filtered ledger
 * entries as plain Layer-2 rows; each row opens the Layer-3 record. Population +
 * counts come from buildBlockersGlance (one denominator, honest counts).
 */
export function blockersGlanceSpec(doc, entries, opts = {}) {
  const base = buildBlockersGlance(entries);
  const tiles = base.tiles.map((t) => ({
    key: t.key,
    label: t.label,
    value: t.value,
    tone: t.tone,
    onActivate: ({ doc: d, drilldown, openRecord }) => {
      const rows = t.rows || [];
      if (rows.length === 0) return; // component renders the honest F6 empty-state
      const list = el(d, 'div', 'glance-list');
      for (const e of rows) {
        const row = d.createElement('button');
        row.type = 'button';
        row.className = 'glance-list-row';
        row.setAttribute('aria-label', 'Open the full record');
        row.appendChild(el(d, 'span', 'glance-list-summary', blockerRowText(e)));
        row.addEventListener('click', () => openRecord(blockerRecordNode(d, e, { fmtTs: opts.fmtTs })));
        list.appendChild(row);
      }
      drilldown.appendChild(list);
    },
  }));
  return { headline: base.headline, tiles, population: base.population };
}

// ═════════════════════════════════════════════════════════════════════════════
// PHASE 3 — the jargon belt: Machines, Health, Spend, Routing Map (topic 29836).
// Each of the four tabs was ≥200 words of insider vocabulary on its front page
// (guards lines, "paid door / metered", "lane / nature / door"). Rebuilt on the
// SAME three-layer template: a component-authored, jargon-free headline + ≤5 tiles
// (Layer 1); each tile drills into the rows behind that number in plain words
// (Layer 2); each row opens the full record where the IDs/config/raw detail live
// (Layer 3). Nothing is lost — the insider fields move one or two clicks down.
// Every builder maps its counts to ONE population so the headline stays honest, and
// every dynamic value is displayed through the shared sanitizer + textContent.
// ═════════════════════════════════════════════════════════════════════════════

// ── Shared plain-language helpers ────────────────────────────────────────────
// Acronyms that should stay upper-cased when a token is humanized for display.
const KNOWN_ACRONYMS = {
  gpt: 'GPT', llm: 'LLM', cli: 'CLI', ai: 'AI', cpu: 'CPU', ram: 'RAM',
  api: 'API', url: 'URL', id: 'ID', ok: 'OK',
};
function titleCaseWord(w) {
  const lw = String(w).toLowerCase();
  if (KNOWN_ACRONYMS[lw]) return KNOWN_ACRONYMS[lw];
  return lw.charAt(0).toUpperCase() + lw.slice(1);
}

/**
 * Turn an identifier-ish token into a plain, sentence-cased phrase: split
 * camelCase + separators, drop empties, cap only the first word.
 * 'zombieCleanup' → 'Zombie cleanup'; 'session_watchdog' → 'Session watchdog'.
 */
export function humanizeToken(token) {
  const words = String(token == null ? '' : token)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s\-_/.]+/)
    .filter(Boolean);
  if (words.length === 0) return '';
  return words
    .map((w, i) => (i === 0 ? titleCaseWord(w) : (KNOWN_ACRONYMS[w.toLowerCase()] || w.toLowerCase())))
    .join(' ');
}

/**
 * A plain, jargon-safe display name for a model id — drops every version/date
 * segment (any part containing a digit) and title-cases the words that remain.
 * 'claude-opus-4-8-20260115' → 'Claude Opus'; 'gpt-5.5' → 'GPT'. Returns '' when
 * nothing plain survives OR the result would still trip the F10 jargon check — the
 * caller substitutes a plain phrase, so a raw model id can NEVER leak to Layer 1.
 */
export function friendlyModel(modelId) {
  // Drop any version/date segment (a part with a digit) AND single-letter fragments
  // (a lone 'm' from 'm_<hex>' is meaningless as a name) — so a hex/opaque id yields
  // '' and the caller substitutes a plain phrase.
  const words = String(modelId == null ? '' : modelId)
    .split(/[\s\-_./]+/)
    .filter((w) => w && w.length >= 2 && !/\d/.test(w));
  const name = words.map(titleCaseWord).join(' ').trim();
  if (!name) return '';
  return findInsiderVocab(name).length === 0 ? name : '';
}

/** The plain model phrase for a routing/spend position, with a door-class fallback. */
function modelPhrase(pos) {
  if (!pos) return '';
  return friendlyModel(pos.modelId) || (pos.doorClass === 'metered' ? 'a paid model' : 'the built-in model');
}

/** Plain words for a routing/spend door class. */
function doorClassWord(doorClass) {
  return doorClass === 'metered' ? 'pay-per-use' : 'built-in (no per-use charge)';
}

function fmtUsd(n, dp = 2) {
  const v = Number(n);
  return '$' + (Number.isFinite(v) ? v : 0).toFixed(dp);
}
function fmtCount(n) {
  const v = Number(n);
  return (Number.isFinite(v) ? v : 0).toLocaleString('en-US');
}
function fmtPct(n) {
  const v = Number(n);
  return (Number.isFinite(v) ? Math.round(v) : 0) + '%';
}
function fmtBytes(n) {
  let v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '0 MB';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)) + ' ' + units[i];
}

/** Build a Layer-3 record node from an ordered [key, value] list (all XSS-safe). */
function recordFields(doc, rows) {
  const wrap = el(doc, 'div', 'glance-record-fields');
  for (const [k, v] of rows) {
    if (v == null || v === '') continue;
    const row = el(doc, 'div', 'glance-record-row');
    row.appendChild(el(doc, 'span', 'glance-record-key', String(k)));
    row.appendChild(el(doc, 'span', 'glance-record-val', String(v)));
    wrap.appendChild(row);
  }
  return wrap;
}

/**
 * Shared tile→list→record wiring: map buildX's { rows, ... } tiles into glance
 * tiles whose onActivate renders each row as a plain Layer-2 line that opens a
 * Layer-3 record. `rowText(item)` → the plain summary; `recordNode(doc, item)` →
 * the full record. Mirrors commitmentsGlanceSpec/blockersGlanceSpec exactly.
 */
function wireTiles(doc, baseTiles, rowText, recordNode) {
  return baseTiles.map((t) => ({
    key: t.key,
    label: t.label,
    value: t.value,
    tone: t.tone,
    onActivate: ({ doc: d, drilldown, openRecord }) => {
      const rows = t.rows || [];
      if (rows.length === 0) return; // component renders the honest F6 empty-state
      const list = el(d, 'div', 'glance-list');
      for (const item of rows) {
        const row = d.createElement('button');
        row.type = 'button';
        row.className = 'glance-list-row';
        row.setAttribute('aria-label', 'Open the full record');
        row.appendChild(el(d, 'span', 'glance-list-summary', rowText(item)));
        row.addEventListener('click', () => openRecord(recordNode(d, item)));
        list.appendChild(row);
      }
      drilldown.appendChild(list);
    },
  }));
}

// ── Machines glance (F10/F11) + issue #1429 nickname edit ────────────────────
// The old front page showed a per-machine insider "guards" line ("67 on (16
// confirmed) · ⚠ 6 off that should be on… as of 3m ago"). On the floor: a plain
// headline over Online / Attention needed / Dispatcher / Safety-checks tiles. The
// named safety checks (from GET /guards) drill down with a one-line plain-English
// explanation each (Layer 2), full posture at Layer 3. Machine NICKNAMES are
// user-authored, so they NEVER appear at Layer 1 — they live at Layer 2/3, shown
// through the sanitizer. #1429: the editable nickname lives in the Layer-2 machine
// row and commits only on Enter/blur; the drill holds it across the 15s poll (F9).

function guardPostureProblems(p) {
  if (!p) return 0;
  return (p.offDeviant || 0) + (p.offRuntimeDivergent || 0) + (p.onStale || 0)
    + (p.missing || 0) + (p.errored || 0) + (p.divergedPendingRestart || 0);
}
function machineNeedsAttention(m) {
  if (!m) return false;
  return !m.online
    || m.clockSkewStatus === 'suspect-clock-removed'
    || guardPostureProblems(m.guardPosture) > 0;
}

/** The single population: the machines GET /pool returns. */
export function machinesPopulation(pool) {
  const machines = pool && Array.isArray(pool.machines) ? pool.machines : [];
  return machines.filter((m) => m && typeof m.machineId === 'string');
}

export function buildMachinesGlance(pool, guards = null) {
  const machines = machinesPopulation(pool);
  const online = machines.filter((m) => m.online);
  const attention = machines.filter(machineNeedsAttention);
  const holder = pool && pool.router && pool.router.holder;
  const dispatcher = holder ? machines.find((m) => m.machineId === holder) : null;

  let headline;
  if (machines.length === 0) {
    headline = 'No machines are paired yet.';
  } else if (online.length === machines.length && attention.length === 0) {
    headline = machines.length === 1 ? 'This machine is online and healthy.'
      : machines.length === 2 ? 'Both machines are online and healthy.'
      : `All ${machines.length} machines are online and healthy.`;
  } else {
    const lookClause = attention.length === 1 ? '1 needs a look' : `${attention.length} need a look`;
    headline = `${online.length} of ${machines.length} machines online; ${lookClause}.`;
  }

  const tiles = [
    { key: 'online', label: 'Online', value: String(online.length), tone: online.length === machines.length ? 'neutral' : 'warn', rows: online },
    { key: 'attention', label: 'Attention needed', value: String(attention.length), tone: attention.length ? 'warn' : 'neutral', rows: attention },
    { key: 'dispatcher', label: 'Dispatcher', value: dispatcher ? 'Assigned' : 'None', tone: 'muted', rows: dispatcher ? [dispatcher] : [] },
  ];

  // The named safety checks come from the LOCAL /guards view (the only place guard
  // NAMES exist without the rate-limited pool-scoped call). Omit the tile when the
  // guards view is unavailable rather than invent an empty one.
  const guardRows = guards && Array.isArray(guards.guards) ? guards.guards : null;
  if (guardRows) {
    const problems = guards.summary ? (
      (guards.summary.offDeviant || 0) + (guards.summary.offRuntimeDivergent || 0)
      + (guards.summary.onStale || 0) + (guards.summary.missing || 0)
      + (guards.summary.errored || 0) + (guards.summary.divergedPendingRestart || 0)
    ) : 0;
    tiles.push({ key: 'guards', label: 'Safety checks', value: String(guardRows.length), tone: problems ? 'warn' : 'neutral', rows: guardRows });
  }

  return { headline, tiles, population: machines };
}

const MACHINE_STATUS_WORD = {
  offline: 'Offline',
  'suspect-clock-removed': 'Clock out of sync — paused for new conversations',
};
function machineStatusWord(m) {
  if (!m.online) return 'Offline';
  if (m.clockSkewStatus === 'suspect-clock-removed') return MACHINE_STATUS_WORD['suspect-clock-removed'];
  if (machineNeedsAttention(m)) return 'Online — needs a look';
  return 'Online and healthy';
}
function machineSpecLine(hw) {
  if (!hw) return 'specs not reported yet';
  const chip = (hw.cpuModel && hw.cpuModel !== 'unknown') ? hw.cpuModel
    : ((hw.platform || '') + (hw.arch ? ' ' + hw.arch : '')).trim();
  const cores = hw.cpuCores ? hw.cpuCores + ' cores' : '';
  const ram = hw.totalMemBytes ? Math.round(hw.totalMemBytes / 1073741824) + ' GB' : '';
  return [chip, cores, ram].filter(Boolean).join(' · ') || 'specs not reported yet';
}

/** Plain one-line explanation of a guard's effective state — no per-key dictionary. */
const GUARD_EFFECTIVE_WORD = {
  'on-confirmed': 'On and verified working',
  'on-unverified': 'On (not yet verified this run)',
  'on-stale': 'On, but its last check is stale — worth a look',
  'on-dry-run': 'On in practice-only mode (not acting for real yet)',
  'off-runtime-divergent': 'Off even though the settings say on — needs a look',
  'diverged-pending-restart': 'Changed; waiting for a restart to take effect',
  'errored': 'Hit an error — needs a look',
  'missing': 'Expected but not found — needs a look',
};
function guardExplanation(g) {
  if (g.effective === 'off') {
    return g.offClass === 'diverged-from-default'
      ? 'Off, though the default is on — worth a look'
      : 'Off by default — intentionally quiet';
  }
  return GUARD_EFFECTIVE_WORD[g.effective] || String(g.effective || 'unknown');
}
function guardNeedsLook(g) {
  return ['on-stale', 'off-runtime-divergent', 'diverged-pending-restart', 'errored', 'missing'].includes(g.effective)
    || (g.effective === 'off' && g.offClass === 'diverged-from-default');
}

export function machineRowText(m) {
  const nick = sanitizeForDisplay(m.nickname || m.machineId || 'A machine', 'label');
  return `${nick} — ${machineStatusWord(m)}`;
}

/** Layer-3 machine record — specs, sessions, and this machine's guard posture in
 *  plain words. The raw counts that used to sit on the front page live here. */
export function machineRecordNode(doc, m, opts = {}) {
  const online = !!m.online;
  const sessions = (m.activeSessionCount != null)
    ? `${m.activeSessionCount}${m.maxSessions ? ' / ' + m.maxSessions : ''} conversation${m.activeSessionCount === 1 ? '' : 's'}`
    : '—';
  const rows = [
    ['Name', m.nickname || m.machineId || '—'],
    ['Status', machineStatusWord(m)],
    ['Specs', machineSpecLine(m.hardware)],
    ['Conversations', online ? sessions : '—'],
  ];
  const p = m.guardPosture;
  if (p) {
    const on = (p.onConfirmed || 0) + (p.onUnverified || 0) + (p.onDryRun || 0);
    rows.push(['Safety checks on', String(on)]);
    const problems = guardPostureProblems(p);
    if (problems > 0) rows.push(['Safety checks needing a look', String(problems)]);
  } else {
    rows.push(['Safety checks', 'not reported yet']);
  }
  const wrap = recordFields(doc, rows);
  // #1429: the editable nickname commits ONLY on Enter/blur, with optimistic local
  // echo; the poll stays authority for external renames. The drill holds it (F9).
  if (typeof opts.onRename === 'function' && m.machineId) {
    const editRow = el(doc, 'div', 'glance-record-row');
    editRow.appendChild(el(doc, 'span', 'glance-record-key', 'Rename'));
    const input = doc.createElement('input');
    input.type = 'text';
    input.className = 'glance-record-input machine-nick';
    input.value = m.nickname || m.machineId;
    input.setAttribute('data-mid', m.machineId);
    input.setAttribute('aria-label', 'Machine nickname — press Enter or click away to save');
    let last = input.value;
    const commit = () => {
      const next = input.value.trim();
      if (next === '' || next === last) { input.value = last; return; }
      const prev = last;
      last = next; // optimistic local echo — keep the typed value
      // prev lets the caller revert this optimistic echo if the save fails.
      opts.onRename(m.machineId, next, input, prev);
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
    input.addEventListener('blur', commit);
    editRow.appendChild(input);
    wrap.appendChild(editRow);
  }
  return wrap;
}

export function guardRowText(g) {
  return `${humanizeToken(g.key)} — ${guardExplanation(g)}`;
}
export function guardRecordNode(doc, g) {
  const rt = g.runtime;
  const rows = [
    ['Check', humanizeToken(g.key)],
    ['In plain words', guardExplanation(g)],
    ['Turned on in settings', g.configEnabled == null ? 'not set' : (g.configEnabled ? 'yes' : 'no')],
    ['On by default', g.defaultEnabled == null ? '—' : (g.defaultEnabled ? 'yes' : 'no')],
    ['Runs in', g.process === 'lifeline' ? 'the always-on lifeline' : 'the main server'],
  ];
  if (g.loadBearing) rows.push(['Load-bearing', 'yes — a safety-critical check']);
  if (rt && typeof rt === 'object') {
    if (rt.dryRun) rows.push(['Mode', 'practice-only (not acting for real yet)']);
    if (typeof rt.jobCount === 'number') rows.push(['Watched items', String(rt.jobCount)]);
  }
  if (g.error) rows.push(['Error', g.error]);
  return recordFields(doc, rows);
}

/**
 * Build the Machines glance spec with drill wiring. `guards` is the LOCAL /guards
 * view ({ guards, summary }) or null. `opts.onRename(machineId, nickname, input)`
 * wires the #1429 nickname edit onto each machine's Layer-3 record.
 */
export function machinesGlanceSpec(doc, pool, guards = null, opts = {}) {
  const base = buildMachinesGlance(pool, guards);
  const tiles = base.tiles.map((t) => {
    if (t.key === 'guards') {
      return {
        key: t.key, label: t.label, value: t.value, tone: t.tone,
        onActivate: ({ doc: d, drilldown, openRecord }) => {
          const rows = (t.rows || []).slice().sort((a, b) => (guardNeedsLook(b) ? 1 : 0) - (guardNeedsLook(a) ? 1 : 0));
          if (rows.length === 0) return;
          const list = el(d, 'div', 'glance-list');
          for (const g of rows) {
            const row = d.createElement('button');
            row.type = 'button';
            row.className = 'glance-list-row';
            if (guardNeedsLook(g)) row.setAttribute('data-tone', 'warn');
            row.setAttribute('aria-label', 'Open the full record');
            row.appendChild(el(d, 'span', 'glance-list-summary', guardRowText(g)));
            row.addEventListener('click', () => openRecord(guardRecordNode(d, g)));
            list.appendChild(row);
          }
          drilldown.appendChild(list);
        },
      };
    }
    return {
      key: t.key, label: t.label, value: t.value, tone: t.tone,
      onActivate: ({ doc: d, drilldown, openRecord }) => {
        const rows = t.rows || [];
        if (rows.length === 0) return;
        const list = el(d, 'div', 'glance-list');
        for (const m of rows) {
          const row = d.createElement('button');
          row.type = 'button';
          row.className = 'glance-list-row';
          if (machineNeedsAttention(m)) row.setAttribute('data-tone', 'warn');
          row.setAttribute('aria-label', 'Open the full record');
          row.appendChild(el(d, 'span', 'glance-list-summary', machineRowText(m)));
          row.addEventListener('click', () => openRecord(machineRecordNode(d, m, { onRename: opts.onRename })));
          list.appendChild(row);
        }
        drilldown.appendChild(list);
      },
    };
  });
  return { headline: base.headline, tiles, population: base.population };
}

// ── Health glance (F10/F11) ──────────────────────────────────────────────────
// The old front page dumped ~390 words of subsystem prose. On the floor: a plain
// headline ("All systems are operational." / "N subsystems need attention.") over
// Subsystems / Need attention / Recent events tiles. Each subsystem's full prose
// description, processes, and metrics move to its Layer-3 record — nothing lost.

/** The single population: the subsystems GET /systems/status reports as active. */
export function healthPopulation(systems) {
  const caps = systems && Array.isArray(systems.activeCapabilities) ? systems.activeCapabilities : [];
  return caps.filter((c) => c && typeof c.id === 'string');
}

export function buildHealthGlance(systems) {
  const caps = healthPopulation(systems);
  const errored = caps.filter((c) => c.status === 'error');
  const events = systems && Array.isArray(systems.recentEvents) ? systems.recentEvents : [];
  const healthy = (systems && systems.health === 'healthy') && errored.length === 0;

  let headline;
  if (caps.length === 0) {
    headline = 'No subsystems are reporting yet.';
  } else if (healthy) {
    headline = 'All systems are operational.';
  } else {
    headline = errored.length === 1
      ? '1 subsystem needs attention.'
      : `${errored.length} subsystems need attention.`;
  }

  const tiles = [
    { key: 'subsystems', label: 'Subsystems', value: String(caps.length), tone: 'neutral', rows: caps },
    { key: 'attention', label: 'Need attention', value: String(errored.length), tone: errored.length ? 'warn' : 'neutral', rows: errored },
    { key: 'events', label: 'Recent events', value: String(events.length), tone: 'muted', rows: events },
  ];

  return { headline, tiles, population: caps };
}

const CAP_STAT_LABEL = {
  recoveries: 'Recovered', interventions: 'Auto-fixed', activeCases: 'Active',
  coherencePassed: 'Checks OK', coherenceFailed: 'Issues', memoryPercent: 'Memory %',
  enabledJobs: 'Jobs', activeJobSessions: 'Running', queueLength: 'Queued',
  weeklyUsage: 'Weekly %', fiveHourRate: '5h rate %', topicMappings: 'Topics',
  totalMessages: 'Messages', proposals: 'Proposals', gaps: 'Gaps', learningsApplied: 'Applied',
};

export function healthCapRowText(c) {
  const word = c.status === 'error' ? 'needs attention' : 'working';
  return `${sanitizeForDisplay(c.label || c.id || 'A subsystem', 'label')} — ${word}`;
}
export function healthCapRecordNode(doc, c) {
  const rows = [
    ['Subsystem', c.label || c.id || '—'],
    ['Status', c.status === 'error' ? 'Needs attention' : 'Working'],
    ['What it does', c.description || '—'],
    ['Right now', c.metric || '—'],
  ];
  for (const p of (c.processes || [])) {
    rows.push([p.name, p.status === 'running' ? 'Running' : 'Error']);
  }
  for (const [key, label] of Object.entries(CAP_STAT_LABEL)) {
    const v = c.stats ? c.stats[key] : undefined;
    if (v != null && v !== 0 && v !== false) rows.push([label, String(v)]);
  }
  return recordFields(doc, rows);
}
export function healthEventRowText(e) {
  return sanitizeForDisplay(e.narrative || e.subsystem || 'An event', 'summary');
}
export function healthEventRecordNode(doc, e) {
  const when = e.timestamp ? defaultFmtTs(e.timestamp) : '—';
  return recordFields(doc, [
    ['What happened', e.narrative || '—'],
    ['Part', e.subsystem || '—'],
    ['When', when],
  ]);
}

export function healthGlanceSpec(doc, systems) {
  const base = buildHealthGlance(systems);
  const tiles = base.tiles.map((t) => {
    const rowText = t.key === 'events' ? healthEventRowText : healthCapRowText;
    const recordNode = t.key === 'events' ? healthEventRecordNode : healthCapRecordNode;
    return {
      key: t.key, label: t.label, value: t.value, tone: t.tone,
      onActivate: ({ doc: d, drilldown, openRecord }) => {
        const rows = t.rows || [];
        if (rows.length === 0) return;
        const list = el(d, 'div', 'glance-list');
        for (const item of rows) {
          const row = d.createElement('button');
          row.type = 'button';
          row.className = 'glance-list-row';
          if (t.key !== 'events' && item.status === 'error') row.setAttribute('data-tone', 'warn');
          row.setAttribute('aria-label', 'Open the full record');
          row.appendChild(el(d, 'span', 'glance-list-summary', rowText(item)));
          row.addEventListener('click', () => openRecord(recordNode(d, item)));
          list.appendChild(row);
        }
        drilldown.appendChild(list);
      },
    };
  });
  return { headline: base.headline, tiles, population: base.population };
}

// ── Spend glance (F10/F11) ───────────────────────────────────────────────────
// The old front page leaned on "paid door / metered / reflows". On the floor: a
// plain headline ("Nothing is being billed per-call right now.") over Estimated
// cost / Text processed / Pay-per-use access tiles. "Metered / paid door" reads as
// "pay-per-use"; the price-reflow detail and per-model math move to Layer 3.

export function buildSpendGlance(summary, caps = null) {
  const totals = (summary && summary.totals) || {};
  const rows = (summary && Array.isArray(summary.rows)) ? summary.rows : [];
  const keys = (caps && Array.isArray(caps.keys)) ? caps.keys : [];
  const meteredLiveYet = !!(summary && summary.meteredLiveYet) || !!(caps && caps.meteredLiveYet);

  const netUsd = Number(totals.netUsd) || 0;
  const headline = meteredLiveYet
    ? `About ${fmtUsd(netUsd)} of pay-per-use AI so far.`
    : 'Nothing is being billed per-call right now.';

  const tokensTotal = (Number(totals.tokensIn) || 0) + (Number(totals.tokensOut) || 0);
  const tiles = [
    { key: 'cost', label: 'Estimated cost', value: fmtUsd(netUsd), tone: 'neutral', rows, mode: 'cost' },
    { key: 'usage', label: 'Text processed', value: fmtCount(tokensTotal), tone: 'muted', rows, mode: 'usage' },
    { key: 'access', label: 'Pay-per-use access', value: String(keys.length), tone: 'muted', rows: keys, mode: 'access' },
  ];

  return { headline, tiles, population: rows };
}

function plainPriceBasis(r) {
  if (r.priceBasis === 'subscription-zero') return 'Subscription — not billed per use';
  if (r.priceBasis === 'no-matching-point') return 'No price on file yet';
  return String(r.priceBasis || '—') + (r.priceStale ? ' (out of date)' : '');
}
function plainGoLive(state) {
  if (state === 'live') return 'Live';
  if (state === 'disarmed') return 'Turned off';
  return 'Not switched on yet';
}

export function spendRowCostText(r) {
  return `${modelPhrase(r)} — ${fmtUsd(Number(r.netUsd) || 0)}`;
}
export function spendRowUsageText(r) {
  const total = (Number(r.tokensIn) || 0) + (Number(r.tokensOut) || 0);
  return `${modelPhrase(r)} — ${fmtCount(total)} pieces of text`;
}
export function spendKeyRowText(k) {
  return `${humanizeToken(k.provider || k.door || 'A provider')} — pay-per-use · ${plainGoLive(k.goLiveState)}`;
}
export function spendRowRecordNode(doc, r) {
  return recordFields(doc, [
    ['Model', friendlyModel(r.modelId) || r.modelId || '—'],
    ['How it is reached', humanizeToken(r.door)],
    ['Access type', doorClassWord(r.doorClass)],
    ['Text in', fmtCount(r.tokensIn)],
    ['Text out', fmtCount(r.tokensOut)],
    ['Gross cost', fmtUsd(r.grossUsd, 4)],
    ['Net cost', fmtUsd(r.netUsd, 4)],
    ['How it is priced', plainPriceBasis(r)],
  ]);
}
export function spendKeyRecordNode(doc, k) {
  return recordFields(doc, [
    ['Provider', k.provider || '—'],
    ['How it is reached', humanizeToken(k.door)],
    ['Daily limit', fmtUsd(k.dailyCapUsd)],
    ['Lifetime limit', fmtUsd(k.lifetimeCapUsd)],
    ['Used today', fmtUsd(k.committedDayUsd)],
    ['Used in total', fmtUsd(k.committedLifetimeUsd)],
    ['Status', plainGoLive(k.goLiveState) + (k.frozen ? ' · paused' : '')],
  ]);
}

export function spendGlanceSpec(doc, summary, caps = null) {
  const base = buildSpendGlance(summary, caps);
  const tiles = base.tiles.map((t) => ({
    key: t.key, label: t.label, value: t.value, tone: t.tone,
    onActivate: ({ doc: d, drilldown, openRecord }) => {
      const rows = t.rows || [];
      if (rows.length === 0) return;
      const list = el(d, 'div', 'glance-list');
      for (const item of rows) {
        const row = d.createElement('button');
        row.type = 'button';
        row.className = 'glance-list-row';
        row.setAttribute('aria-label', 'Open the full record');
        const text = t.mode === 'access' ? spendKeyRowText(item)
          : t.mode === 'usage' ? spendRowUsageText(item)
          : spendRowCostText(item);
        row.appendChild(el(d, 'span', 'glance-list-summary', text));
        const recNode = t.mode === 'access' ? spendKeyRecordNode(d, item) : spendRowRecordNode(d, item);
        row.addEventListener('click', () => openRecord(recNode));
        list.appendChild(row);
      }
      drilldown.appendChild(list);
    },
  }));
  return { headline: base.headline, tiles, population: base.population };
}

// ── Routing Map glance (F10/F11) ─────────────────────────────────────────────
// The old front page used "lane / nature / door". On the floor: a plain headline
// ("Background AI work runs on X, with Y as backup.") over one tile per lane
// (plain-named) + a Job-types tile. Each lane drills into its ordered fallback
// list of plain model names (Layer 2); each opens the full door/model config
// (Layer 3). The insider door flags live at Layer 3, not the front page.

const CHAIN_ORDER = ['FAST', 'SORT', 'JUDGE', 'WRITE'];
const CHAIN_LABEL = { FAST: 'Quick tasks', SORT: 'Sorting', JUDGE: 'Judging', WRITE: 'Writing' };

/** The primary lane's first two positions drive the headline (X + backup Y). */
function primaryLane(map) {
  const chains = map && Array.isArray(map.chains) ? map.chains : [];
  return chains.find((c) => c.chain === 'FAST') || chains[0] || null;
}

export function buildRoutingMapGlance(map) {
  const chains = map && Array.isArray(map.chains) ? map.chains : [];
  const components = map && Array.isArray(map.components) ? map.components : [];

  const lead = primaryLane(map);
  const positions = (lead && Array.isArray(lead.positions)) ? lead.positions : [];
  let headline;
  if (chains.length === 0) {
    headline = 'No background AI routing is set up yet.';
  } else {
    const x = modelPhrase(positions[0]) || 'the built-in model';
    const y = modelPhrase(positions[1]);
    headline = y
      ? `Background AI work runs on ${x}, with ${y} as backup.`
      : `Background AI work runs on ${x}.`;
  }

  const tiles = [];
  const ordered = chains.slice().sort((a, b) => CHAIN_ORDER.indexOf(a.chain) - CHAIN_ORDER.indexOf(b.chain));
  for (const c of ordered) {
    if (tiles.length >= GLANCE_MAX_TILES - 1) break; // leave room for the Job-types tile
    const pos = Array.isArray(c.positions) ? c.positions : [];
    tiles.push({
      key: 'lane-' + String(c.chain || '').toLowerCase(),
      label: CHAIN_LABEL[c.chain] || humanizeToken(c.chain),
      value: String(pos.length),
      tone: 'neutral',
      rows: pos,
      mode: 'lane',
    });
  }
  tiles.push({ key: 'jobs', label: 'Job types', value: String(components.length), tone: 'muted', rows: components, mode: 'jobs' });

  return { headline, tiles, population: components };
}

export function laneRowText(p, i) {
  const rank = typeof i === 'number' ? `${i + 1}. ` : '';
  return `${rank}${modelPhrase(p)}${p.doorClass === 'metered' ? ' (pay-per-use)' : ''}`;
}
export function laneRecordNode(doc, p) {
  return recordFields(doc, [
    ['Model', friendlyModel(p.modelId) || p.modelId || '—'],
    ['How it is reached', humanizeToken(p.door)],
    ['Access type', doorClassWord(p.doorClass)],
    ['Safe for untrusted input', p.injectionSafe ? 'yes' : 'no'],
    ['Pay-per-use', p.moneyGated ? 'yes' : 'no'],
    ['Skipped for now', p.skippedInIncrementA ? 'yes' : 'no'],
  ]);
}
export function jobRowText(c) {
  const lane = CHAIN_LABEL[c.chain] || 'default routing';
  return `${humanizeToken(c.component)} — ${lane}`;
}
export function jobRecordNode(doc, c) {
  const exposure = c.injectionExposure
    ? (c.injectionExposure.exposed ? 'yes' : 'no')
    : (c.untrustedInput === true ? 'yes' : c.untrustedInput === false ? 'no' : '—');
  return recordFields(doc, [
    ['Job kind', humanizeToken(c.component)],
    ['Type', humanizeToken(c.category)],
    ['Lane', CHAIN_LABEL[c.chain] || 'default routing'],
    ['Safety-critical', c.criticalGate ? 'yes' : 'no'],
    ['Can see untrusted input', exposure],
  ]);
}

export function routingMapGlanceSpec(doc, map) {
  const base = buildRoutingMapGlance(map);
  const tiles = base.tiles.map((t) => ({
    key: t.key, label: t.label, value: t.value, tone: t.tone,
    onActivate: ({ doc: d, drilldown, openRecord }) => {
      const rows = t.rows || [];
      if (rows.length === 0) return;
      const list = el(d, 'div', 'glance-list');
      rows.forEach((item, i) => {
        const row = d.createElement('button');
        row.type = 'button';
        row.className = 'glance-list-row';
        row.setAttribute('aria-label', 'Open the full record');
        const text = t.mode === 'jobs' ? jobRowText(item) : laneRowText(item, i);
        row.appendChild(el(d, 'span', 'glance-list-summary', text));
        const recNode = t.mode === 'jobs' ? jobRecordNode(d, item) : laneRecordNode(d, item);
        row.addEventListener('click', () => openRecord(recNode));
        list.appendChild(row);
      });
      drilldown.appendChild(list);
    },
  }));
  return { headline: base.headline, tiles, population: base.population };
}

// ═════════════════════════════════════════════════════════════════════════════
// PHASE 4 — the sweep: every remaining grandfathered data-summary view brought to
// the glance floor (topic 29836). Each builder maps its ONE population to a
// jargon-free headline + ≤5 tiles (Layer 1), each tile drills into the rows behind
// that number in plain words (Layer 2), each row opens the full record where the
// IDs/config/raw detail live (Layer 3). Single-population tabs reuse wireTiles;
// mixed-population tabs (tokens, initiatives) wire per-tile modes like spend/routing.
// ═════════════════════════════════════════════════════════════════════════════

// ── PR Pipeline glance (F10/F11) — GET /pr-gate/metrics ──────────────────────
// The old front page listed raw PR cards (`PR #n @ <sha>` · eligible/not). On the
// floor: a plain headline over Ready-to-merge / Not-ready tiles; the commit sha +
// gate reason move to the Layer-3 record.

/** The single population: the PR-gate metric entries. */
export function prPipelinePopulation(metrics) {
  const entries = metrics && Array.isArray(metrics.entries) ? metrics.entries : [];
  return entries.filter((e) => e && typeof e === 'object');
}

export function buildPrPipelineGlance(metrics) {
  const entries = prPipelinePopulation(metrics);
  const ready = entries.filter((e) => e.eligible === true);
  const notReady = entries.filter((e) => e.eligible !== true);
  let headline;
  if (entries.length === 0) {
    headline = 'No pull requests are waiting in the merge gate right now.';
  } else {
    const noun = entries.length === 1 ? 'open pull request' : 'open pull requests';
    const verb = ready.length === 1 ? 'is' : 'are';
    headline = `${ready.length} of ${entries.length} ${noun} ${verb} ready to merge.`;
  }
  const tiles = [
    { key: 'ready', label: 'Ready to merge', value: String(ready.length), tone: ready.length ? 'neutral' : 'muted', rows: ready },
    { key: 'not-ready', label: 'Not ready yet', value: String(notReady.length), tone: notReady.length ? 'warn' : 'neutral', rows: notReady },
  ];
  return { headline, tiles, population: entries };
}

export function prRowText(e) {
  const n = e.pr_number != null ? `#${e.pr_number}` : '#—';
  return `Pull request ${n} — ${e.eligible === true ? 'ready to merge' : 'not ready yet'}`;
}
export function prRecordNode(doc, e, opts = {}) {
  const fmtTs = opts.fmtTs || defaultFmtTs;
  return recordFields(doc, [
    ['Pull request', e.pr_number != null ? `#${e.pr_number}` : '—'],
    ['Ready to merge', e.eligible === true ? 'yes' : 'no'],
    ['Why', e.reason || '—'],
    ['Commit', typeof e.head_sha === 'string' ? e.head_sha.slice(0, 8) : '—'],
    ['First seen', fmtTs(e.created_at)],
  ]);
}
export function prPipelineGlanceSpec(doc, metrics, opts = {}) {
  const base = buildPrPipelineGlance(metrics);
  const tiles = wireTiles(doc, base.tiles, prRowText, (d, e) => prRecordNode(d, e, opts));
  return { headline: base.headline, tiles, population: base.population };
}

// ── LLM Activity glance (F10/F11) — GET /metrics/features ────────────────────
// The old front page was an 8-metric row + a wide 11-column per-component table.
// On the floor: a plain headline over Components / Calls / Acted / Errors tiles;
// the per-component providers, models, fire rate, and latencies move to Layer 3.

/** The single population: the per-component metrics GET /metrics/features returns. */
export function llmActivityPopulation(data) {
  const features = data && Array.isArray(data.features) ? data.features : [];
  return features.filter((f) => f && typeof f.feature === 'string');
}

export function buildLlmActivityGlance(data) {
  const features = llmActivityPopulation(data);
  const totals = (data && data.totals) || {};
  const calls = Number(totals.calls) || 0;
  const fired = Number(totals.fired) || 0;
  const errors = Number(totals.errors) || 0;
  const withErrors = features.filter((f) => (Number(f.errors) || 0) > 0);
  const acted = features.filter((f) => (Number(f.fired) || 0) > 0);

  let headline;
  if (features.length === 0) {
    headline = 'No background AI activity has been recorded in this window.';
  } else {
    const comp = features.length === 1 ? '1 component' : `${features.length} components`;
    const errClause = errors === 0 ? 'none hit an error'
      : errors === 1 ? '1 call hit an error' : `${fmtCount(errors)} calls hit an error`;
    headline = `${comp} made ${fmtCount(calls)} background AI calls; ${errClause}.`;
  }

  const tiles = [
    { key: 'components', label: 'Components', value: String(features.length), tone: 'neutral', rows: features },
    { key: 'calls', label: 'AI calls', value: fmtCount(calls), tone: 'muted', rows: features.slice().sort((a, b) => (Number(b.calls) || 0) - (Number(a.calls) || 0)) },
    { key: 'acted', label: 'Acted', value: String(acted.length), tone: 'neutral', rows: acted },
    { key: 'errors', label: 'Errors', value: fmtCount(errors), tone: errors ? 'warn' : 'neutral', rows: withErrors },
  ];
  return { headline, tiles, population: features };
}

function llmProviderPhrase(f) {
  const fw = Array.isArray(f.frameworks) ? f.frameworks.filter(Boolean) : [];
  if (fw.length) return fw.map(humanizeToken).join(', ');
  const models = Array.isArray(f.models) ? f.models.filter(Boolean) : [];
  const friendly = models.map(friendlyModel).filter(Boolean);
  return friendly.length ? friendly.join(', ') : 'the built-in model';
}
export function llmActivityRowText(f) {
  return `${humanizeToken(f.feature)} — ${fmtCount(Number(f.calls) || 0)} AI calls`;
}
export function llmActivityRecordNode(doc, f) {
  const rows = [
    ['Component', humanizeToken(f.feature)],
    ['Runs on', llmProviderPhrase(f)],
    ['AI calls', fmtCount(Number(f.calls) || 0)],
    ['Acted', fmtCount(Number(f.fired) || 0)],
    ['Skipped', fmtCount(Number(f.shed) || 0)],
    ['Errors', fmtCount(Number(f.errors) || 0)],
    ['Text in', fmtCount(Number(f.tokensIn) || 0)],
    ['Text out', fmtCount(Number(f.tokensOut) || 0)],
  ];
  if (f.p50LatencyMs != null) rows.push(['Typical speed', `${Math.round(Number(f.p50LatencyMs))} ms`]);
  if (f.p95LatencyMs != null) rows.push(['Slowest 1 in 20', `${Math.round(Number(f.p95LatencyMs))} ms`]);
  return recordFields(doc, rows);
}
export function llmActivityGlanceSpec(doc, data) {
  const base = buildLlmActivityGlance(data);
  const tiles = wireTiles(doc, base.tiles, llmActivityRowText, llmActivityRecordNode);
  return { headline: base.headline, tiles, population: base.population };
}

// ── Secrets glance (F10/F11) — GET /secrets/pending ──────────────────────────
// The old front page listed pending secret-drop cards with a live countdown. On
// the floor: a plain headline over Waiting / Expired tiles; the drop link, topic,
// and exact expiry time move to the Layer-3 record. (The token is a request
// reference the drop UI already exposes — it lives at Layer 3, not the glance.)

/** The single population: the pending secret requests GET /secrets/pending returns. */
export function secretsPopulation(data) {
  const pending = data && Array.isArray(data.pending) ? data.pending : [];
  return pending.filter((p) => p && typeof p === 'object');
}

function secretExpired(p, now) {
  if (p.expired === true) return true;
  if (p.expiresAt == null) return false;
  const t = typeof p.expiresAt === 'number' ? p.expiresAt : Date.parse(p.expiresAt);
  return Number.isFinite(t) ? t <= now : false;
}

export function buildSecretsGlance(data, now = Date.now()) {
  const pending = secretsPopulation(data);
  const expired = pending.filter((p) => secretExpired(p, now));
  const waiting = pending.filter((p) => !secretExpired(p, now));

  let headline;
  if (pending.length === 0) {
    headline = 'No secret requests are waiting right now.';
  } else if (waiting.length === 0) {
    headline = 'All secret requests have expired.';
  } else {
    const noun = waiting.length === 1 ? 'secret request is' : 'secret requests are';
    headline = `${waiting.length} ${noun} waiting for you.`;
  }
  const tiles = [
    { key: 'waiting', label: 'Waiting for you', value: String(waiting.length), tone: waiting.length ? 'warn' : 'neutral', rows: waiting },
    { key: 'expired', label: 'Expired', value: String(expired.length), tone: 'muted', rows: expired },
  ];
  return { headline, tiles, population: pending };
}

export function secretRowText(p, now = Date.now()) {
  const label = sanitizeForDisplay(p.label || 'A secret request', 'label');
  return `${label} — ${secretExpired(p, now) ? 'expired' : 'waiting for you'}`;
}
export function secretRecordNode(doc, p, opts = {}) {
  const fmtTs = opts.fmtTs || defaultFmtTs;
  const rows = [
    ['Requested', p.label || '—'],
    ['In conversation', p.topicId != null ? String(p.topicId) : '—'],
    ['Asked', fmtTs(p.createdAt)],
    ['Expires', fmtTs(p.expiresAt)],
  ];
  const wrap = recordFields(doc, rows);
  // Preserve the tab's actions (open / copy / cancel) at Layer 3 — behavior is
  // untouched, only its placement moved one click down.
  const actions = el(doc, 'div', 'glance-record-actions');
  const link = p.tunnelUrl || p.localUrl;
  if (typeof link === 'string' && /^https?:\/\//.test(link)) {
    const a = doc.createElement('a');
    a.className = 'glance-record-action';
    a.href = link; // a fixed http(s) literal from the server; textContent stays plain
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = 'Open the secure drop';
    actions.appendChild(a);

    const copy = doc.createElement('button');
    copy.type = 'button';
    copy.className = 'glance-record-action';
    copy.textContent = 'Copy link';
    copy.addEventListener('click', () => {
      try {
        if (doc.defaultView && doc.defaultView.navigator && doc.defaultView.navigator.clipboard) {
          doc.defaultView.navigator.clipboard.writeText(link);
          copy.textContent = 'Copied';
        }
      } catch { /* @silent-fallback-ok — clipboard denied, leave the label */ }
    });
    actions.appendChild(copy);
  }
  if (typeof opts.onCancel === 'function' && p.token) {
    const cancel = doc.createElement('button');
    cancel.type = 'button';
    cancel.className = 'glance-record-action';
    cancel.textContent = 'Cancel request';
    cancel.addEventListener('click', () => { cancel.disabled = true; opts.onCancel(p.token); });
    actions.appendChild(cancel);
  }
  if (actions.childNodes.length) wrap.appendChild(actions);
  return wrap;
}
export function secretsGlanceSpec(doc, data, opts = {}) {
  const now = opts.now ?? Date.now();
  const base = buildSecretsGlance(data, now);
  const tiles = wireTiles(doc, base.tiles, (p) => secretRowText(p, now), (d, p) => secretRecordNode(d, p, opts));
  return { headline: base.headline, tiles, population: base.population };
}

// ── Tokens glance (F10/F11) — GET /tokens/summary + /sessions + /orphans ─────
// The old front page was a 7-metric grid + a per-session table + an idle list. On
// the floor: a plain headline over Text-processed / Recent-conversations / Idle
// tiles; the session ids, event counts, and full paths move to the Layer-3 record.
// "Tokens" reads as "pieces of text" (matching the Spend tab's plain vocabulary).

/** A plain, short conversation name from a project path (its last segment). */
function projectName(p) {
  const parts = String(p == null ? '' : p).split('/').filter(Boolean);
  return sanitizeForDisplay(parts.length ? parts[parts.length - 1] : (p || 'a conversation'), 'label');
}

export function buildTokensGlance(summary, sessions, orphans) {
  const s = (summary && summary.summary) || summary || {};
  const active = (Array.isArray(sessions) ? sessions : []).filter((r) => r && typeof r === 'object');
  const idle = (Array.isArray(orphans) ? orphans : []).filter((o) => o && typeof o === 'object');
  const total = Number(s.totalTokens) || 0;
  const byTokens = active.slice().sort((a, b) => (Number(b.totalTokens) || 0) - (Number(a.totalTokens) || 0));

  let headline;
  if (active.length === 0 && total === 0) {
    headline = 'No conversation activity has been recorded in this window.';
  } else {
    const noun = active.length === 1 ? 'conversation' : 'conversations';
    const idleClause = idle.length === 0 ? '' : `; ${idle.length} idle`;
    headline = `I've processed ${fmtCount(total)} pieces of text across ${active.length} ${noun}${idleClause}.`;
  }

  const tiles = [
    { key: 'processed', label: 'Text processed', value: fmtCount(total), tone: 'muted', rows: byTokens, mode: 'session' },
    { key: 'conversations', label: 'Recent conversations', value: String(active.length), tone: 'neutral', rows: active, mode: 'session' },
    { key: 'idle', label: 'Idle conversations', value: String(idle.length), tone: idle.length ? 'warn' : 'neutral', rows: idle, mode: 'orphan' },
  ];
  return { headline, tiles, population: active };
}

export function tokenSessionRowText(r) {
  return `${projectName(r.projectPath)} — ${fmtCount(Number(r.totalTokens) || 0)} pieces of text`;
}
export function tokenOrphanRowText(o, opts = {}) {
  const fmtTs = opts.fmtTs || defaultFmtTs;
  return `${projectName(o.projectPath)} — idle since ${fmtTs(o.lastTs)}`;
}
export function tokenSessionRecordNode(doc, r, opts = {}) {
  const fmtTs = opts.fmtTs || defaultFmtTs;
  return recordFields(doc, [
    ['Conversation', projectName(r.projectPath)],
    ['Full path', r.projectPath || '—'],
    ['Session', r.sessionId || '—'],
    ['Pieces of text', fmtCount(Number(r.totalTokens) || 0)],
    ['Messages', fmtCount(Number(r.eventCount) || 0)],
    ['Last seen', fmtTs(r.lastTs)],
  ]);
}
export function tokenOrphanRecordNode(doc, o, opts = {}) {
  const fmtTs = opts.fmtTs || defaultFmtTs;
  return recordFields(doc, [
    ['Conversation', projectName(o.projectPath)],
    ['Full path', o.projectPath || '—'],
    ['Session', o.sessionId || '—'],
    ['Idle since', fmtTs(o.lastTs)],
  ]);
}

export function tokensGlanceSpec(doc, summary, sessions, orphans, opts = {}) {
  const base = buildTokensGlance(summary, sessions, orphans);
  const tiles = base.tiles.map((t) => ({
    key: t.key, label: t.label, value: t.value, tone: t.tone,
    onActivate: ({ doc: d, drilldown, openRecord }) => {
      const rows = t.rows || [];
      if (rows.length === 0) return;
      const list = el(d, 'div', 'glance-list');
      for (const item of rows) {
        const row = d.createElement('button');
        row.type = 'button';
        row.className = 'glance-list-row';
        row.setAttribute('aria-label', 'Open the full record');
        const text = t.mode === 'orphan' ? tokenOrphanRowText(item, opts) : tokenSessionRowText(item);
        row.appendChild(el(d, 'span', 'glance-list-summary', text));
        const recNode = t.mode === 'orphan' ? tokenOrphanRecordNode(d, item, opts) : tokenSessionRecordNode(d, item, opts);
        row.addEventListener('click', () => openRecord(recNode));
        list.appendChild(row);
      }
      drilldown.appendChild(list);
    },
  }));
  return { headline: base.headline, tiles, population: base.population };
}

// ── Resource Usage glance (F10/F11) — GET /resources/summary ─────────────────
// The old front page was a 6-gauge headline + a per-process table + a trend list.
// On the floor: a plain headline over CPU-now / Memory-now / Processes tiles; the
// per-process averages and peaks move to the Layer-3 record.

/** Plain, jargon-free name for a resource source id. */
function resourceSourceName(source) {
  const s = String(source == null ? '' : source);
  if (s === 'agent-server') return 'The server';
  if (s === 'aggregate') return 'Everything together';
  if (s.startsWith('session:')) return 'Conversation ' + sanitizeForDisplay(s.slice('session:'.length).slice(0, 8), 'label');
  return humanizeToken(s) || 'A process';
}

/** The single population: the non-aggregate per-process sources. */
export function resourcesPopulation(summary) {
  const sources = summary && Array.isArray(summary.sources) ? summary.sources : [];
  return sources.filter((s) => s && typeof s.source === 'string' && s.source !== 'aggregate');
}

export function buildResourcesGlance(summary) {
  const sources = summary && Array.isArray(summary.sources) ? summary.sources : [];
  const agg = sources.find((s) => s && s.source === 'aggregate');
  const processes = resourcesPopulation(summary);

  let headline;
  if (!agg && processes.length === 0) {
    headline = 'No resource samples have been collected yet.';
  } else if (agg) {
    headline = `Using ${fmtPct(agg.currentCpuPercent)} CPU and ${fmtBytes(agg.currentRssBytes)} of memory right now.`;
  } else {
    headline = `Watching ${processes.length} process${processes.length === 1 ? '' : 'es'} right now.`;
  }

  const byCpu = processes.slice().sort((a, b) => (Number(b.currentCpuPercent) || 0) - (Number(a.currentCpuPercent) || 0));
  const byMem = processes.slice().sort((a, b) => (Number(b.currentRssBytes) || 0) - (Number(a.currentRssBytes) || 0));
  const tiles = [
    { key: 'cpu', label: 'CPU right now', value: agg ? fmtPct(agg.currentCpuPercent) : '—', tone: 'muted', rows: byCpu },
    { key: 'memory', label: 'Memory right now', value: agg ? fmtBytes(agg.currentRssBytes) : '—', tone: 'muted', rows: byMem },
    { key: 'processes', label: 'Processes', value: String(processes.length), tone: 'neutral', rows: processes },
  ];
  return { headline, tiles, population: processes };
}

export function resourceRowText(s) {
  return `${resourceSourceName(s.source)} — ${fmtPct(s.currentCpuPercent)} CPU, ${fmtBytes(s.currentRssBytes)}`;
}
export function resourceRecordNode(doc, s) {
  return recordFields(doc, [
    ['Process', resourceSourceName(s.source)],
    ['CPU right now', fmtPct(s.currentCpuPercent)],
    ['Average CPU (last hour)', fmtPct(s.avgCpuPercent)],
    ['Highest CPU (last hour)', fmtPct(s.peakCpuPercent)],
    ['Memory right now', fmtBytes(s.currentRssBytes)],
    ['Highest memory (last hour)', fmtBytes(s.peakRssBytes)],
  ]);
}
export function resourcesGlanceSpec(doc, summary) {
  const base = buildResourcesGlance(summary);
  const tiles = wireTiles(doc, base.tiles, resourceRowText, resourceRecordNode);
  return { headline: base.headline, tiles, population: base.population };
}

// ── Initiatives glance (F10/F11) — GET /initiatives + /initiatives/digest ────
// The old front page was a signal digest + a list of initiative cards. On the
// floor: a plain headline over In-progress / Needs-you / Ready / Check-in / Idle
// tiles; the phases, descriptions, and timestamps move to the Layer-3 record. The
// In-progress tile drills into the (filtered) initiatives; the attention tiles
// drill into the matching digest signals.

const INITIATIVE_STATUS_WORD = {
  active: 'in progress', completed: 'done', archived: 'archived', abandoned: 'stopped',
};
const SIGNAL_REASON_WORD = {
  'needs-user': 'Waiting on you', 'next-check-due': 'Time for a check-in',
  'ready-to-advance': 'Ready to move forward', 'stale': "Hasn't moved in a while",
};

/** The single population for the list tile: the (already server-filtered) items. */
export function initiativesPopulation(itemsRes) {
  const items = itemsRes && Array.isArray(itemsRes.items) ? itemsRes.items : [];
  return items.filter((i) => i && typeof i === 'object');
}

export function buildInitiativesGlance(itemsRes, digestRes) {
  const items = initiativesPopulation(itemsRes);
  const signals = (digestRes && Array.isArray(digestRes.items)) ? digestRes.items.filter(Boolean) : [];
  const byReason = (r) => signals.filter((s) => s.reason === r);
  const needsYou = byReason('needs-user');
  const ready = byReason('ready-to-advance');
  const checkDue = byReason('next-check-due');
  const idle = byReason('stale');

  let headline;
  if (items.length === 0) {
    headline = 'No initiatives are in flight right now.';
  } else {
    const noun = items.length === 1 ? 'initiative' : 'initiatives';
    const needClause = needsYou.length === 0 ? ''
      : `; ${needsYou.length} need${needsYou.length === 1 ? 's' : ''} you`;
    headline = `${items.length} ${noun} in flight${needClause}.`;
  }

  const tiles = [
    { key: 'in-progress', label: 'In progress', value: String(items.length), tone: 'neutral', rows: items, mode: 'item' },
    { key: 'needs-you', label: 'Needs you', value: String(needsYou.length), tone: needsYou.length ? 'warn' : 'neutral', rows: needsYou, mode: 'signal' },
    { key: 'ready', label: 'Ready to move on', value: String(ready.length), tone: ready.length ? 'neutral' : 'muted', rows: ready, mode: 'signal' },
    { key: 'check-due', label: 'Check-in due', value: String(checkDue.length), tone: checkDue.length ? 'warn' : 'muted', rows: checkDue, mode: 'signal' },
    { key: 'idle', label: 'Idle', value: String(idle.length), tone: 'muted', rows: idle, mode: 'signal' },
  ];
  return { headline, tiles, population: items };
}

export function initiativeRowText(i) {
  const title = sanitizeForDisplay(i.title || i.id || 'An initiative', 'summary');
  return `${title} — ${INITIATIVE_STATUS_WORD[i.status] || (i.status || 'unknown')}`;
}
export function initiativeRecordNode(doc, i, opts = {}) {
  const fmtTs = opts.fmtTs || defaultFmtTs;
  const phases = Array.isArray(i.phases) ? i.phases : [];
  const done = phases.filter((p) => p && p.status === 'done').length;
  const rows = [
    ['Initiative', i.title || i.id || '—'],
    ['Status', INITIATIVE_STATUS_WORD[i.status] || (i.status || '—')],
    ['What it is', i.description || '—'],
  ];
  if (phases.length) rows.push(['Steps done', `${done} of ${phases.length}`]);
  if (i.lastTouchedAt) rows.push(['Last worked on', fmtTs(i.lastTouchedAt)]);
  return recordFields(doc, rows);
}
export function initiativeSignalRowText(s) {
  return sanitizeForDisplay(s.title || SIGNAL_REASON_WORD[s.reason] || 'A signal', 'summary');
}
export function initiativeSignalRecordNode(doc, s) {
  return recordFields(doc, [
    ['Initiative', s.title || '—'],
    ['Why it needs a look', SIGNAL_REASON_WORD[s.reason] || (s.reason || '—')],
    ['Detail', s.detail || '—'],
  ]);
}
export function initiativesGlanceSpec(doc, itemsRes, digestRes, opts = {}) {
  const base = buildInitiativesGlance(itemsRes, digestRes);
  const tiles = base.tiles.map((t) => ({
    key: t.key, label: t.label, value: t.value, tone: t.tone,
    onActivate: ({ doc: d, drilldown, openRecord }) => {
      const rows = t.rows || [];
      if (rows.length === 0) return;
      const list = el(d, 'div', 'glance-list');
      for (const item of rows) {
        const row = d.createElement('button');
        row.type = 'button';
        row.className = 'glance-list-row';
        row.setAttribute('aria-label', 'Open the full record');
        const text = t.mode === 'signal' ? initiativeSignalRowText(item) : initiativeRowText(item);
        row.appendChild(el(d, 'span', 'glance-list-summary', text));
        const recNode = t.mode === 'signal' ? initiativeSignalRecordNode(d, item) : initiativeRecordNode(d, item, opts);
        row.addEventListener('click', () => openRecord(recNode));
        list.appendChild(row);
      }
      drilldown.appendChild(list);
    },
  }));
  return { headline: base.headline, tiles, population: base.population };
}

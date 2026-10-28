// How I'm doing inside (docs/specs/console-features/under-the-hood.md, "The two combined
// pages, in one view"; Settings › Under the hood). Subtitle: conversation history,
// recurring problems, checks on my claims. Four sections, each deep-linkable (?s=…):
//   activity  ← Integrated-Being  (What my other conversations have been doing)
//   problems  ← Process health    (Problems I caught in my own work; omitted when off)
//   claims    ← Preferences' class reviews + claim verification (Checks on my own claims)
//   lookup    ← Evidence          (Look up a memory's sources; collapsed)
// Maintainer detail folds under each section's "Technical". Renders only; every value
// through textContent. The one write is revoking a session binding: the bearer token plus
// the route's intent header, confirmed in a sheet. No PIN anywhere — the server asks none.

import {
  buildActivity, buildStats, buildBindings, buildChain, buildProblems, buildClaims, buildReviews, buildLookup,
  insideHeadline, insideFacts, machineNote, recentUrl, failuresUrl, claimsUrl, chainUrl, lookupUrl, validEntryId,
  entryStory, failureStory, patternStory, reviewStory, revokeRequest, revokeConfirmWords, revokeResultWords, inferLookup,
  CHIPS, KINDS, KIND_WORDS, COUNTERPARTIES, COUNTERPARTY_WORDS, STAGE_INFO, LOOKUP_KINDS, SCOPES, ADVISORY, CLAIM_KEYS, REVIEW_KEYS, CLAIMS_PAGE, WINDOW_STEP,
  setPeerNames,
} from './inside-model.js';
import { el, setKids, pageHead, sheet, closeSheet, story, details, note, cantTell } from './ui.js';

const EYEBROW = 'Settings · Under the hood';
const SUBTITLE = 'Conversation history, recurring problems, checks on my claims.';
// Kept across the page's own 30 s refreshes: filters, windows, open folds, the lookup form.
const view = { chip: 'all', kind: null, counterparty: null, limit: WINDOW_STEP, older: [], claimsLimit: CLAIMS_PAGE, open: new Set() };
let lastProblems = null;
let lookupNode = null;
let scrolledFor = null;

function bearer() { try { return localStorage.getItem('instar_token') || ''; } catch { return ''; } }
/** A write that keeps the status and body (the revoke route needs the intent header). */
async function send(req) {
  try {
    const r = await fetch(req.path, { method: req.method, headers: { Authorization: `Bearer ${bearer()}`, ...req.headers }, cache: 'no-store' });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  } catch { return { ok: false, status: 0, data: { error: 'the server could not be reached' } }; }
}

export async function renderInside(main, ctx) {
  const { get } = ctx;
  if (!main.querySelector('.inside-page')) setKids(main, el('section', { class: 'hero page-hero' }, el('div', { class: 'eyebrow', text: EYEBROW }), el('h1', { class: 'page-title skeleton', text: 'Loading' })));
  const [recent, stats, sessions, pool, insights, week, all, claimsRes, reviewsRes, pairingRes, ...pages] = await Promise.all([
    get(recentUrl({ limit: view.limit, counterparty: view.counterparty })), get('/shared-state/stats'), get('/shared-state/sessions'), get('/pool'),
    get('/failures/insights?limit=50'), get('/failures/analysis?sinceDays=7'), get('/failures/analysis'),
    get(claimsUrl(view.claimsLimit)), get('/class-reviews?limit=20'), get('/threadline/pairing'),
    get(failuresUrl()), ...view.older.map((b) => get(failuresUrl(b))),
  ]);
  const now = Date.now();
  setPeerNames(pairingRes);
  const activity = buildActivity(recent, { chip: view.chip, kind: view.kind, counterparty: view.counterparty, limit: view.limit, now });
  const problems = buildProblems({ insights, pages, week, all }, { lastGood: lastProblems, now });
  if (problems.ok && !problems.stale) lastProblems = { model: problems, at: now };
  const claims = buildClaims(claimsRes, { limit: view.claimsLimit, now });
  const reviews = buildReviews(reviewsRes, { now });
  const refresh = () => renderInside(main, ctx);
  const h = insideHeadline({ activity, problems, claims, reviews });

  const sections = [
    activityBlock(activity, { stats: buildStats(stats), bindings: buildBindings(sessions, { now }), machine: machineNote(pool), get, refresh }),
    problems.off ? null : problemsBlock(problems, refresh),
    claimsBlock(claims, reviews, refresh),
    lookupBlock(get),
  ];
  setKids(main, el('div', { class: 'inside-page' },
    pageHead({ eyebrow: `${EYEBROW} · How I’m doing inside`, headline: h.text, tone: h.tone, sub: h.sub || SUBTITLE, facts: insideFacts({ activity, problems, claims, reviews }) }),
    el('div', { class: 'page-sections' }, sections)));
  const want = new URLSearchParams(location.hash.split('?')[1] || '').get('s');
  if (want && scrolledFor !== want) { scrolledFor = want; const sec = main.querySelector(`#sec-${want}`); if (sec) { openFold(sec); sec.scrollIntoView({ block: 'start' }); } }
}

// ── shared bits ───────────────────────────────────────────────────────────
function openFold(sec) {
  const head = sec.querySelector(':scope > button.list-head');
  if (head && head.getAttribute('aria-expanded') === 'false') head.click();
}
/** A collapsible block whose open state survives refreshes. */
function fold(id, title, count, body, { tone } = {}) {
  const isOpen = view.open.has(id);
  const head = el('button', { class: 'list-head', type: 'button', 'aria-expanded': isOpen ? 'true' : 'false' },
    el('h2', { class: 'eyebrow', text: title }), count != null ? el('span', { class: 'list-count', text: String(count) }) : null, el('span', { class: 'chev', 'aria-hidden': 'true', text: '›' }));
  const wrap = el('div', { class: 'rows list-rows', hidden: !isOpen }, body);
  head.addEventListener('click', () => { wrap.hidden = !wrap.hidden; head.setAttribute('aria-expanded', wrap.hidden ? 'false' : 'true'); if (wrap.hidden) view.open.delete(id); else view.open.add(id); });
  return el('section', { class: `list-section inside-fold${tone ? ' ' + tone : ''}`, id: `sec-${id}` }, head, wrap);
}
/** "Technical": a <details> whose open state survives refreshes. */
function technical(id, ...kids) {
  const d = el('details', { class: 'raw inside-tech', open: view.open.has(id) || null }, el('summary', { text: 'Technical' }), kids.flat(Infinity));
  d.addEventListener('toggle', () => { if (d.open) view.open.add(id); else view.open.delete(id); });
  return d;
}
function tech(obj, keys) { const d = details(obj, keys); d.querySelector('summary').textContent = 'Technical'; return d; }
function rowButton(r, onClick, icon) {
  const b = el('button', { class: 'row', type: 'button', 'data-focus-key': r.key },
    icon ? el('span', { class: `kind-icon${r.tone ? ' ' + r.tone : ''}`, 'aria-hidden': 'true', text: icon }) : el('span', { class: r.tone === 'bad' ? 'dot bad' : r.tone === 'attn' ? 'dot attn' : r.tone === 'unknown' ? 'dot unknown' : 'dot' }),
    el('span', { class: 'row-main' }, el('span', { class: 'row-title', text: r.main }), r.sub ? el('span', { class: 'row-sub', text: r.sub }) : null),
    el('span', { class: 'row-end' }, document.createTextNode(r.end || ''), el('span', { class: 'chev', 'aria-hidden': 'true', text: '›' })));
  if (onClick) b.addEventListener('click', () => onClick(r));
  return b;
}
const rows = (list, onClick, empty) => el('div', { class: 'rows' }, list.length ? list.map((r) => rowButton(r, onClick)) : el('p', { class: 'empty-line', text: empty }));
const tiles = (items, sub) => el('div', { class: 'facts inside-tiles' }, items.map((t) => el('span', { class: `fact${t.tone ? ' ' + t.tone : ''}` }, el('span', { class: 'fact-n', text: String(t.n) }), el('span', { class: 'fact-label', text: t.label }))), sub ? el('span', { class: 'inside-tiles-note', text: sub }) : null);
const head = (title, ...extra) => el('div', { class: 'list-head' }, el('h2', { class: 'eyebrow', text: title }), ...extra);
const lineP = (text) => el('p', { class: 'inside-line', text });

// ── 1. What my other conversations have been doing ────────────────────────
function activityBlock(a, deps) {
  const wrap = el('section', { class: 'list-section', id: 'sec-activity' }, head('What my other conversations have been doing'));
  if (deps.machine) wrap.append(note(deps.machine));
  if (!a.ok) {
    wrap.append(a.off ? el('p', { class: 'empty-line', text: a.reason }) : cantTell(a.reason));
  } else {
    wrap.append(el('h3', { class: 'inside-sub', text: 'Recent recorded activity' }), lineP(a.line), tiles(a.tiles, a.tilesNote));
    wrap.append(el('div', { class: 'filter-chips', role: 'group', 'aria-label': 'Show' }, CHIPS.map((c) => el('button', {
      class: 'fchip', type: 'button', 'aria-pressed': c.key === view.chip ? 'true' : 'false', 'data-chip': c.key,
      onclick: () => { if (view.chip !== c.key) { view.chip = c.key; deps.refresh(); } },
    }, el('span', { text: c.label }), el('span', { class: 'fchip-n', text: String(a.chipCounts[c.key] || 0) })))));
    const filters = el('button', { class: 'link-btn', type: 'button', 'data-more-filters': '1', text: a.filtersWords ? `More filters: ${a.filtersWords} ›` : 'More filters ›', onclick: () => filtersSheet(deps.refresh) });
    wrap.append(el('p', { class: 'inside-filters' }, filters));
    if (!a.rows.length) wrap.append(el('p', { class: 'empty-line', text: a.n ? 'Nothing among these records matches that filter.' : 'Nothing recorded recently.' }));
    for (const g of a.groups) {
      wrap.append(el('div', { class: 'inside-day' }, el('h3', { class: 'eyebrow inside-day-label', text: g.label }),
        el('div', { class: 'rows' }, g.rows.map((r) => rowButton(r, (x) => openEntry(x, deps.get), r.icon)))));
    }
    if (a.canShowMore) wrap.append(el('button', { class: 'link-btn show-more', type: 'button', 'data-show-more': 'activity', text: 'Show more', onclick: () => { view.limit = a.nextLimit; deps.refresh(); } }));
  }
  wrap.append(activityTechnical(deps));
  return wrap;
}

function filtersSheet(refresh) {
  const kind = el('select', { class: 'reason-input', 'aria-label': 'Kind' }, el('option', { value: '', text: 'Every kind' }), KINDS.map((k) => el('option', { value: k, text: KIND_WORDS[k] })));
  const cp = el('select', { class: 'reason-input', 'aria-label': 'Who with' }, el('option', { value: '', text: 'Anyone' }), COUNTERPARTIES.map((k) => el('option', { value: k, text: COUNTERPARTY_WORDS[k] })));
  kind.value = view.kind || ''; cp.value = view.counterparty || '';
  const apply = el('button', { class: 'btn-primary btn-inline', type: 'button', text: 'Show these', 'data-apply-filters': '1', onclick: () => {
    view.kind = kind.value || null; view.counterparty = cp.value || null; view.chip = 'all'; closeSheet(); refresh();
  } });
  const clear = el('button', { class: 'btn-quiet', type: 'button', text: 'Clear', onclick: () => { view.kind = null; view.counterparty = null; closeSheet(); refresh(); } });
  sheet({ title: 'More filters' },
    el('label', { class: 'limit-field' }, el('span', { text: 'Kind' }), kind),
    el('label', { class: 'limit-field' }, el('span', { text: 'Who with' }), cp),
    note('“Who with” asks the record itself, so “Show more” reaches further back for that person or agent.'),
    el('div', { class: 'confirm-row' }, clear, apply));
}

function openEntry(r, get) {
  const e = r.record;
  const hist = el('div', { class: 'inside-history' });
  sheet({ title: e.kind === 'commitment' ? 'A commitment' : 'A record' }, story(entryStory(r)), hist,
    tech({ ...e, emittedBy: e.emittedBy }, ['id', 't', 'kind', 'provenance', 'emittedBy', 'counterparty', 'supersedes', 'disputes', 'source', 'dedupKey', 'commitment']));
  if (e.supersedes || e.disputes) {
    hist.append(el('h3', { class: 'eyebrow', text: 'History' }), el('p', { class: 'empty-line', text: 'Reading what it replaced…' }));
    get(chainUrl(e.id)).then((res) => {
      const c = buildChain(res);
      setKids(hist, el('h3', { class: 'eyebrow', text: 'History' }), c.ok ? [lineP(c.words), rows(c.rows, null, '')] : cantTell(c.reason),
        e.disputes ? note('This record disputes an earlier one; the history above follows only what it replaced.') : null);
    });
  }
}

function activityTechnical(deps) {
  const kids = [];
  const s = deps.stats;
  kids.push(el('h3', { class: 'eyebrow', text: 'Counters' }), s.ok ? [story(s.lines.map((l) => ({ label: l.label, text: l.text }))), note(s.ttlNote)] : note(s.reason));
  // Look up an entry by its id (the legacy chain explorer).
  const input = el('input', { class: 'reason-input mono', type: 'text', placeholder: '12-character id', 'aria-label': 'Entry id', maxlength: '12', 'data-chain-input': '1' });
  const out = el('div', { class: 'inside-chain-out' });
  const go = el('button', { class: 'btn-quiet', type: 'button', text: 'Look up', 'data-chain-go': '1', onclick: async () => {
    const id = input.value.trim();
    if (!validEntryId(id)) { setKids(out, note('That is not an entry id: it is 12 characters, 0–9 and a–f.')); return; }
    setKids(out, el('p', { class: 'empty-line', text: 'Looking…' }));
    const c = buildChain(await deps.get(chainUrl(id)));
    setKids(out, c.ok ? (c.rows.length ? [lineP(c.words), rows(c.rows, null, '')] : el('p', { class: 'empty-line', text: 'No entry with that id in the recent record.' })) : cantTell(c.reason));
  } });
  kids.push(el('h3', { class: 'eyebrow', text: 'Look up an entry by its id' }), el('div', { class: 'inside-form' }, input, go), out);
  const b = deps.bindings;
  if (!b.hidden) {
    kids.push(el('h3', { class: 'eyebrow', text: 'Session bindings' }), note('Sessions allowed to write to this record. Revoking one refuses its future writes.'));
    if (!b.ok) kids.push(cantTell(b.reason));
    else kids.push(rows(b.rows, (r) => bindingSheet(r, deps.refresh), 'No sessions are registered.'));
  }
  return technical('activity-tech', kids);
}

function bindingSheet(r, refresh) {
  const status = el('p', { class: 'action-status', role: 'status' });
  const kids = [story([{ label: 'Session', text: r.main }, { label: 'Status', text: r.status.words }, { label: 'Registered', text: r.record.registeredAt || 'unknown' }, { label: 'Expires', text: r.record.absoluteExpiresAt || 'unknown' }])];
  if (r.canRevoke) {
    const box = el('div', { class: 'confirm' });
    const ask = el('button', { class: 'btn-quiet', type: 'button', text: 'Revoke', 'data-revoke': r.id, onclick: () => {
      const go = el('button', { class: 'btn-danger', type: 'button', text: 'Revoke', 'data-revoke-confirm': r.id, onclick: async () => {
        go.disabled = true; status.textContent = 'Working…';
        const w = revokeResultWords(await send(revokeRequest(r.id)));
        status.textContent = w.message;
        if (w.ok) { box.replaceChildren(); refresh(); } else go.disabled = false;
      } });
      setKids(box, el('p', { class: 'confirm-text', text: revokeConfirmWords(r) }), el('div', { class: 'confirm-row' }, el('button', { class: 'btn-quiet', type: 'button', text: 'Keep it', onclick: () => setKids(box, ask) }), go));
    } });
    box.append(ask);
    kids.push(box, status);
  }
  kids.push(tech(r.record, ['sessionId', 'label', 'registeredAt', 'lastActiveAt', 'idleExpiresAt', 'absoluteExpiresAt', 'hasWritten', 'revoked']));
  sheet({ title: 'A session binding' }, ...kids);
}

// ── 2. Problems I caught in my own work ───────────────────────────────────
function problemsBlock(p, refresh) {
  const wrap = el('section', { class: 'list-section', id: 'sec-problems' }, head('Problems I caught in my own work'));
  if (!p.ok) { wrap.append(cantTell(p.reason)); return wrap; }
  const info = el('button', { class: 'link-btn', type: 'button', 'aria-label': 'What the stages mean', text: 'ⓘ', onclick: () => sheet({ title: 'How far failure watching is on' },
    story(STAGE_INFO.map((s) => ({ label: s.key === p.stage ? 'Now' : ' ', text: s.text })))) });
  wrap.append(el('p', { class: 'row-sub inside-stage' }, document.createTextNode(`${p.stageWords} · this machine `), info));
  if (p.stale) wrap.append(note(p.staleWords));
  wrap.append(lineP(p.line), tiles(p.tiles));
  wrap.append(el('h3', { class: 'eyebrow inside-sub', text: 'Repeating patterns' }));
  wrap.append(p.patterns.ok ? rows(p.patterns.rows, (r) => openPattern(r, p), 'Nothing repeating.') : cantTell(p.patterns.reason));
  wrap.append(el('h3', { class: 'eyebrow inside-sub', text: 'Problems lately' }), rows(p.rows, openFailure, 'Nothing has come up yet.'));
  if (p.moreFailed) wrap.append(note(p.moreFailed));
  if (p.canShowOlder) wrap.append(el('button', { class: 'link-btn show-more', type: 'button', 'data-show-older': '1', text: 'Show older', onclick: (ev) => {
    ev.currentTarget.disabled = true; view.older = [...view.older, p.oldest]; refresh();
  } }));
  wrap.append(technical('problems-tech', el('h3', { class: 'eyebrow', text: 'All-time counts' }), p.analysis ? story(p.analysis) : note(p.analysisReason)));
  return wrap;
}
function openFailure(r) { sheet({ title: 'A problem I caught' }, story(failureStory(r.record)), note('Awareness only: nothing acts on this automatically.'), tech(r.record, ['id', 'category', 'status', 'source', 'severity', 'occurrenceCount', 'detectedAt', 'attribution', 'initiativeId', 'causeCommitOid', 'prNumber', 'dedupeKey'])); }
function openPattern(r, p) {
  const s = patternStory(r.record, p.rows.map((x) => x.record));
  sheet({ title: 'A repeating problem' }, story(s.lines), el('h3', { class: 'eyebrow', text: 'The problems behind it' }),
    rows(s.behind, openFailure, 'None of them are among the records shown.'), s.behindWords ? note(s.behindWords) : null,
    tech(r.record, ['id', 'identityKey', 'status', 'distinctSessions', 'distinctCauseCommits', 'reopenCount', 'targetCategory', 'supportingFailureIds', 'discoveredAt', 'updatedAt']));
}

// ── 3. Checks on my own claims ────────────────────────────────────────────
function claimsBlock(c, reviews, refresh) {
  const wrap = el('section', { class: 'list-section', id: 'sec-claims' }, head('Checks on my own claims'));
  if (!c.ok) wrap.append(c.off ? el('p', { class: 'empty-line', text: c.reason }) : cantTell(c.reason));
  else {
    wrap.append(el('h3', { class: 'inside-sub', text: 'Recent claim observations' }), lineP(c.line));
    const contra = c.observations.filter((o) => o.bucket === 'contradicts');
    if (contra.length) wrap.append(rows(contra, openClaim, ''));
    const all = rows(c.observations, openClaim, 'No claims checked yet.');
    if (c.canShowMore) all.append(el('button', { class: 'link-btn show-more', type: 'button', 'data-show-more': 'claims', text: 'Show more', onclick: () => { view.claimsLimit = c.nextLimit; view.open.add('claims-all'); refresh(); } }));
    wrap.append(fold('claims-all', 'Recent claim observations', c.observations.length, all));
    if (c.coverage.length) wrap.append(fold('claims-coverage', 'Coverage notes', c.coverage.length, rows(c.coverage, openClaim, '')));
  }
  if (!reviews.ok) wrap.append(reviews.off ? el('p', { class: 'empty-line', text: reviews.reason }) : cantTell(reviews.reason));
  else wrap.append(fold('claims-reviews', 'Class reviews', reviews.rows.length, rows(reviews.rows, openReview, 'No corrections reviewed yet.')));
  return wrap;
}
function openClaim(r) { sheet({ title: r.bucket ? 'A claim observation' : 'A coverage note' }, story([{ label: 'What', text: r.main }, { label: 'Result', text: r.sub }, { label: 'When', text: r.end || 'unknown' }]), note(ADVISORY), tech(r.record, CLAIM_KEYS)); }
function openReview(r) { sheet({ title: 'A class review' }, story(reviewStory(r.record)), tech(r.record, REVIEW_KEYS)); }

// ── 4. Look up a memory's sources (persistent: typed input survives refreshes) ──
function lookupBlock(get) {
  if (lookupNode) return lookupNode;
  const input = el('input', { class: 'reason-input mono', type: 'text', placeholder: 'A memory id or a source id', 'aria-label': 'Memory or source id', 'data-lookup-input': '1' });
  const kind = el('select', { class: 'reason-input', 'aria-label': 'What it is', 'data-lookup-kind': '1' }, LOOKUP_KINDS.map((k) => el('option', { value: k.key, text: k.label })));
  const kindField = el('label', { class: 'limit-field', hidden: true }, el('span', { text: 'What it is' }), kind);
  const scope = el('select', { class: 'reason-input', 'aria-label': 'See it as', 'data-lookup-scope': '1' }, SCOPES.map((s) => el('option', { value: s.key, text: s.label })));
  const out = el('div', { class: 'inside-lookup-out' });
  const sync = () => {
    const inf = inferLookup(input.value);
    kindField.hidden = !(inf.ambiguous && !inf.empty);
    if (inf.kind) kind.value = inf.kind; else if (inf.candidates.length) kind.value = inf.candidates[0];
  };
  input.addEventListener('input', sync);
  const run = async (id, k) => {
    setKids(out, el('p', { class: 'empty-line', text: 'Looking…' }));
    const res = await get(lookupUrl({ id, kind: k, scope: scope.value }));
    const m = buildLookup(res, { kind: k, scope: scope.value });
    if (!m.ok) { setKids(out, m.off ? el('p', { class: 'empty-line', text: m.reason }) : cantTell(m.reason)); return; }
    setKids(out, el('p', { class: `inside-line${m.tone ? ' ' + m.tone : ''}`, text: m.words }),
      el('div', { class: 'rows' }, m.rows.map((r) => {
        if (m.mode === 'citers') return rowButton({ ...r, sub: `${r.sub}${r.sub ? ' · ' : ''}tap for its sources` }, () => { input.value = r.id; sync(); run(r.id, 'entity'); });
        return rowButton({ ...r, sub: `${r.sub} · what else relies on this?` }, () => { input.value = r.sourceId; sync(); kind.value = r.kind; run(r.sourceId, r.kind); });
      })));
  };
  const go = el('button', { class: 'btn-primary btn-inline', type: 'button', text: 'Look up', 'data-lookup-go': '1', onclick: () => {
    const id = input.value.trim();
    if (!id) { setKids(out, note('Type a memory id or a source id first.')); return; }
    run(id, kind.value);
  } });
  lookupNode = fold('lookup', 'Look up a memory’s sources', null, [
    note('For maintainers: why I believe something, and what else relies on the same source. From this machine’s memory.'),
    el('div', { class: 'inside-form' }, input), kindField,
    el('label', { class: 'limit-field' }, el('span', { text: 'See it as' }), scope),
    go, out,
  ]);
  return lookupNode;
}

/** Test seam: forget the remembered view between tests. */
export function _resetInsideState() {
  view.chip = 'all'; view.kind = null; view.counterparty = null; view.limit = WINDOW_STEP; view.older = []; view.claimsLimit = CLAIMS_PAGE; view.open = new Set();
  lastProblems = null; lookupNode = null; scrolledFor = null;
}

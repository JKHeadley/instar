// What I've learned about you (docs/specs/console-features/people-settings.md,
// "What I've learned about you", legacy tab id `preferences-learning`).
// How you like things (the learned preferences), Two machines disagree (only when
// any), Things I'm still watching (corrections not yet a preference), Earlier
// corrections (collapsed, paged with the ledger's own cursor), and the quiet line
// "To change one, tell me in chat." Read only: no write route is called from here.

import {
  buildPreferences, buildCorrections, buildConflicts, machineNames, learnedHeadline, learnedFacts,
  correctionsUrl, kindWords, confidenceWords, correctionStatusWords, ADVISORY_LINE,
} from './learned-model.js';
import { el, setKids, pageHead, section, sheet, story, details, note, cantTell } from './ui.js';

const PAGE = 20;
// The last good preferences build, so a failed refresh shows it with its age (stale) instead of nothing.
let lastGood = null;
// Older ledger pages the operator has asked for, kept across the page's own refreshes.
let olderPages = [];

const CORRECTION_KEYS = ['id', 'kind', 'status', 'occurrenceCount', 'detectedAt', 'updatedAt', 'dayBucket', 'topicId', 'routedVia', 'verifyWindowStart', 'verifyWindowEnd', 'reopenCount', 'dedupeKey'];

export async function renderLearned(main, ctx) {
  const { get } = ctx;
  if (!main.querySelector('.learned-page')) setKids(main, el('section', { class: 'hero page-hero' }, el('div', { class: 'eyebrow', text: 'Settings · What I’ve learned about you' }), el('h1', { class: 'page-title skeleton', text: 'Loading' })));
  const [prefsRes, firstPage, conflictsRes, poolRes] = await Promise.all([
    get('/preferences/session-context'), get(correctionsUrl(null, PAGE)), get('/state/conflicts'), get('/pool'),
  ]);
  const now = Date.now();
  const prefs = buildPreferences(prefsRes, { lastGood, now });
  if (prefs.ok && !prefs.stale) lastGood = { prefs, at: now };
  const corrections = buildCorrections([firstPage, ...olderPages], { now });
  const conflicts = buildConflicts(conflictsRes, { machines: machineNames(poolRes), now });
  const refresh = () => renderLearned(main, ctx);
  const h = learnedHeadline({ prefs, corrections });

  const parts = [pageHead({ eyebrow: 'Settings · What I’ve learned about you', headline: h.text, tone: h.tone, facts: learnedFacts({ prefs, corrections, conflicts }) })];
  const sections = [prefsBlock(prefs)];
  if (!conflicts.hidden) sections.push(conflictsBlock(conflicts));
  sections.push(...correctionsBlocks(corrections, { get, refresh }));
  sections.push(el('p', { class: 'card-note learned-change', text: 'To change one, tell me in chat.' }));
  parts.push(el('div', { class: 'page-sections' }, sections),
    el('p', { class: 'foot-note' },
      document.createTextNode('Checks on my own claims (class reviews and claim observations) are in '),
      el('a', { href: '#/settings/inside?s=claims', text: 'How I’m doing inside' }),
      document.createTextNode('.')));
  setKids(main, el('div', { class: 'learned-page' }, parts));
}

// ── How you like things ───────────────────────────────────────────────────
function prefsBlock(prefs) {
  const head = el('div', { class: 'list-head' }, el('h2', { class: 'eyebrow', text: 'How you like things' }), prefs.ok ? el('span', { class: 'list-count', text: String(prefs.total) }) : null);
  const wrap = el('section', { class: 'list-section', id: 'sec-prefs' }, head);
  if (!prefs.ok) {
    wrap.append(prefs.off ? el('p', { class: 'empty-line', text: `${prefs.reason} Once it is on, the preferences I pick up from your corrections show here.` }) : cantTell(prefs.reason));
    return wrap;
  }
  if (prefs.stale) wrap.append(note(prefs.staleWords));
  if (!prefs.rows.length) {
    wrap.append(el('p', { class: 'empty-line', text: prefs.total ? 'I keep some preferences, but none fit in what loads at the start of a conversation.' : 'Nothing saved yet. Correct me the same way on a couple of different days and it shows up here.' }));
  } else {
    wrap.append(el('div', { class: 'pref-cards' }, prefs.rows.map((p) => prefCard(p, prefs))));
  }
  if (prefs.notLoadedWords) wrap.append(note(prefs.notLoadedWords));
  if (prefs.meshWords) wrap.append(note(prefs.meshWords));
  wrap.append(el('p', { class: 'card-note', text: ADVISORY_LINE }));
  return wrap;
}

function prefCard(p, prefs) {
  const b = el('button', { class: 'pref-card', type: 'button', 'data-focus-key': p.key },
    el('span', { class: 'pref-quote', text: `“${p.text}”` }),
    el('span', { class: 'slip-foot' }, el('span', { class: 'row-sub', text: p.sub }), el('span', { class: 'chev', 'aria-hidden': 'true', text: '›' })));
  b.addEventListener('click', () => {
    const lines = [{ label: 'What I picked up', text: p.text }, { label: 'How often', text: p.seen ? (p.seen > 1 ? `Seen ${p.seen} times` : 'Seen once') : 'Not recorded' }];
    if (p.confidence != null) lines.push({ label: 'How sure', text: `${confidenceWords(p.confidence)} (${p.confidence.toFixed(2)})` });
    lines.push({ label: 'Loaded', text: 'At the start of every conversation' });
    if (prefs.mesh) lines.push({ label: 'Where', text: 'This machine’s list, including what my other machines learned' });
    sheet({ title: 'A preference I picked up' }, story(lines), note(ADVISORY_LINE), note('To change or drop it, tell me in chat.'), details({ line: p.raw }, ['line']));
  });
  return b;
}

// ── Two machines disagree ─────────────────────────────────────────────────
function conflictsBlock(conflicts) {
  if (!conflicts.ok) return el('section', { class: 'list-section', id: 'sec-conflicts' }, el('div', { class: 'list-head' }, el('h2', { class: 'eyebrow', text: 'Two machines disagree' })), el('p', { class: 'card-note', text: conflicts.reason }));
  return section({ id: 'conflicts', title: 'Two machines disagree', rows: conflicts.rows, onRow: (r) => sheet({ title: 'Machines disagree' },
    story([{ label: 'What happened', text: r.main }, { label: 'When', text: r.sub }, { label: 'What I do meanwhile', text: 'I use both versions as hints. Settling it from here comes later; for now, tell me in chat which one you mean.' }]),
    details({ ...r.record, versions: r.record.versions }, ['conflictId', 'recordKey', 'versions', 'firstSeenAt', 'lastSeenAt', 'recurrenceCount', 'forcedResolution'])) });
}

// ── Corrections: still watching + earlier ─────────────────────────────────
function correctionsBlocks(corrections, deps) {
  if (!corrections.ok) {
    const head = el('div', { class: 'list-head' }, el('h2', { class: 'eyebrow', text: 'Things I’m still watching' }));
    return [el('section', { class: 'list-section', id: 'sec-watching' }, head, corrections.off ? el('p', { class: 'empty-line', text: corrections.reason }) : cantTell(corrections.reason))];
  }
  const out = [];
  out.push(section({ id: 'watching', title: 'Things I’m still watching', rows: corrections.watching, empty: 'Nothing being watched. When you correct me, I note it here until I see it again on other days.', onRow: openCorrection }));
  const earlier = section({ id: 'earlier', title: 'Earlier corrections', rows: corrections.earlier, collapsed: true, empty: 'No earlier corrections.', onRow: openCorrection });
  const body = earlier.querySelector('.list-rows');
  if (corrections.countWords) body.append(note(corrections.countWords));
  if (corrections.moreFailed) body.append(note(corrections.moreFailed));
  if (corrections.nextBefore) {
    const status = el('p', { class: 'action-status', role: 'status' });
    const older = el('button', { class: 'link-btn', type: 'button', text: 'Show older corrections', 'data-older': '1' });
    older.addEventListener('click', async () => {
      older.disabled = true; status.textContent = 'Loading…';
      olderPages = [...olderPages, await deps.get(correctionsUrl(corrections.nextBefore, PAGE))];
      deps.refresh();
    });
    body.append(older, status);
  }
  out.push(earlier);
  return out;
}

function openCorrection(r) {
  const c = r.record;
  sheet({ title: 'A correction I noted' },
    story([
      { label: 'What I noticed', text: r.main },
      { label: 'Kind', text: kindWords(c.kind) },
      { label: 'Where it stands', text: correctionStatusWords(c) },
      { label: 'First noticed', text: c.detectedAt ? new Date(c.detectedAt).toLocaleString() : 'unknown' },
    ]),
    note('I only keep a preference after a correction shows up on different days, so a one-off never hardens.'),
    details(c, CORRECTION_KEYS));
}

/** Test seam: forget the remembered pages between tests. */
export function _resetLearnedState() { lastGood = null; olderPages = []; }

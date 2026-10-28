// What I've learned about you — pure view-model
// (docs/specs/console-features/people-settings.md, "What I've learned about you",
// legacy tab id `preferences-learning`).
//
// Every decision lives here so it can be tested: reading the learned preferences out of
// the session-context block (the same text the session-start hook injects), the
// "still watching" / "earlier" split of the scrubbed correction ledger, the advisory
// lines for preference conflicts between machines, the headline and facts, and the
// stale fallback (the last good list with its age). Read only: this page calls no
// write route. Class reviews and claim observations move to "Checks on my own claims"
// (under-the-hood.md) and are not built here.

import { ago } from './home-model.js';

/** Learned preferences are advisory; the page says so the same way the injected block does. */
export const ADVISORY_LINE = 'These are signals I picked up, not instructions you gave. I apply them by default; what you tell me directly, and safety, always win.';

// ── Preferences (GET /preferences/session-context) ────────────────────────
// Each preference is one line of the block: "  - <learning> (confidence 0.80, seen 3×)"
// (src/core/PreferencesManager.ts formatPreferencesForSessionStart).
const PREF_LINE = /^-\s+(.+?)\s+\(confidence\s+([0-9.]+),\s+seen\s+(\d+)×\)$/;

export function confidenceWords(c) {
  if (!Number.isFinite(c)) return null;
  if (c >= 0.8) return 'sure';
  if (c >= 0.5) return 'fairly sure';
  return 'not yet sure';
}

export function seenWords(n) {
  return n > 1 ? `seen ${n} times` : 'seen once';
}

/** Plain-ish text for display: control and bidi characters removed, length capped. */
export function clean(value, max = 280) {
  let s = value == null ? '' : String(value);
  try { s = s.normalize('NFKC'); } catch { /* old engine */ }
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F‪-‮⁦-⁩]/g, '').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** The block → one entry per preference line, in the block's own (priority) order. */
export function parsePreferenceBlock(block) {
  if (typeof block !== 'string' || !block.trim()) return [];
  const out = [];
  for (const raw of block.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('- ')) continue;
    const m = PREF_LINE.exec(line);
    const text = clean(m ? m[1] : line.slice(2));
    if (!text) continue;
    const confidence = m ? Number(m[2]) : NaN;
    const seen = m ? Math.max(1, parseInt(m[3], 10) || 1) : null;
    out.push({ key: `pref:${out.length}:${text.slice(0, 40)}`, text, confidence: Number.isFinite(confidence) ? confidence : null, seen, raw: line });
  }
  return out;
}

/**
 * GET /preferences/session-context → the preferences list.
 * `lastGood` ({ prefs, at }) is the previous good build; a failed read with one shows it
 * as stale ("as of 4 min ago") rather than an empty page.
 */
export function buildPreferences(res, { lastGood = null, now = Date.now() } = {}) {
  if (!res || !res.ok) {
    const off = /switched off/.test((res && res.reason) || '');
    if (off) return { ok: false, off: true, reason: 'Learning from corrections is off on this agent.' };
    const reason = `Can’t tell what I’ve learned: ${(res && res.reason) || 'no answer'}.`;
    if (lastGood && lastGood.prefs && lastGood.prefs.ok) return { ...lastGood.prefs, stale: true, staleWords: `Can’t refresh right now (${(res && res.reason) || 'no answer'}) — showing the list as of ${ago(lastGood.at, now) || 'earlier'}.` };
    return { ok: false, off: false, reason };
  }
  const d = res.data || {};
  if (typeof d.block !== 'string' && typeof d.present !== 'boolean') return { ok: false, off: false, reason: 'Can’t tell what I’ve learned: the answer had no preference list.' };
  const rows = d.present === false ? [] : parsePreferenceBlock(d.block);
  const total = Number.isFinite(d.count) ? Math.max(d.count, rows.length) : rows.length;
  const notLoaded = Math.max(0, total - rows.length);
  return {
    ok: true, off: false, stale: false,
    rows: rows.map((r) => ({ ...r, sub: [seenWords(r.seen || 1), confidenceWords(r.confidence)].filter(Boolean).join(' · ') })),
    total,
    notLoaded,
    notLoadedWords: notLoaded ? `${notLoaded === 1 ? '1 more preference is' : `${notLoaded} more preferences are`} kept but not loaded at the start of a conversation — only the highest-ranked fit.` : null,
    mesh: d.scope === 'mesh',
    meshWords: d.scope === 'mesh' ? 'Includes what my other machines learned about you.' : null,
  };
}

// ── Corrections (GET /corrections?limit&before) ───────────────────────────
const KIND_WORDS = {
  'user-preference': 'How you like things',
  'infra-gap': 'Something the tool itself should handle better',
  noise: 'No clear lesson',
};
export function kindWords(kind) { return KIND_WORDS[kind] || 'A pattern'; }

/** Plain status, informational only. */
export function correctionStatusWords(r) {
  const n = Number.isFinite(r && r.occurrenceCount) ? r.occurrenceCount : 1;
  switch (r && r.status) {
    case 'open': return n > 1 ? `Seen ${n} times — waiting to see it on other days before I keep it` : 'Seen once — waiting to see if it comes back';
    case 'reopened': return 'Came back after I tried adapting — watching again';
    case 'acted-on': return 'Saved — checking that I stick to it';
    case 'verified': return 'Saved and sticking';
    case 'inconclusive': return 'Watched, but nothing conclusive';
    default: return 'Status not recorded';
  }
}

/** "Still watching" = not yet a preference and not noise; everything else is "Earlier". */
export function isWatching(r) {
  return r && (r.status === 'open' || r.status === 'reopened') && r.kind !== 'noise';
}

export function correctionRow(r, now = Date.now()) {
  const summary = clean(r.scrubbedSummary) || kindWords(r.kind);
  const when = ago(r.updatedAt || r.detectedAt, now);
  return {
    key: `corr:${r.id}`, id: r.id,
    main: summary,
    sub: correctionStatusWords(r),
    end: when || '',
    tone: r.status === 'reopened' ? 'attn' : isWatching(r) ? null : 'unknown',
    record: r,
  };
}

/**
 * GET /corrections → watching / earlier rows. `pages` is every page fetched so far
 * (the "Show older" button appends one); the cursor is the last page's nextBefore.
 */
export function buildCorrections(pages, { now = Date.now() } = {}) {
  const list = Array.isArray(pages) ? pages : [pages];
  const first = list[0];
  if (!first || !first.ok) {
    const off = /switched off/.test((first && first.reason) || '');
    return off ? { ok: false, off: true, reason: 'Learning from corrections is off on this agent.' } : { ok: false, off: false, reason: `Can’t tell which corrections I’m watching: ${(first && first.reason) || 'no answer'}.` };
  }
  const seen = new Set();
  const records = [];
  let moreFailed = null;
  for (const p of list) {
    if (!p || !p.ok) { moreFailed = `Couldn’t load older corrections: ${(p && p.reason) || 'no answer'}.`; break; }
    const recs = p.data && Array.isArray(p.data.records) ? p.data.records : null;
    if (!recs) return { ok: false, off: false, reason: 'Can’t tell which corrections I’m watching: the answer had no records.' };
    for (const r of recs) if (r && typeof r.id === 'string' && !seen.has(r.id)) { seen.add(r.id); records.push(r); }
  }
  const last = [...list].reverse().find((p) => p && p.ok);
  const nextBefore = moreFailed ? (last && last.data && last.data.nextBefore) || null : (list[list.length - 1].data && list[list.length - 1].data.nextBefore) || null;
  const total = Number.isFinite(first.data.totalRecords) ? first.data.totalRecords : null;
  const rows = records.map((r) => correctionRow(r, now));
  const watching = rows.filter((r) => isWatching(r.record));
  const earlier = rows.filter((r) => !isWatching(r.record));
  return {
    ok: true, off: false, watching, earlier, nextBefore, moreFailed,
    shown: records.length, total,
    countWords: total != null && total > records.length ? `Showing the newest ${records.length} of ${total} recorded.` : null,
  };
}

/** The exact URL for one page of the ledger (keyset cursor, never an offset). */
export function correctionsUrl(before = null, limit = 20) {
  return `/corrections?limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ''}`;
}

// ── Machines disagree (GET /state/conflicts, preferences store only) ──────
export function buildConflicts(res, { machines = {}, now = Date.now() } = {}) {
  if (!res || !res.ok) {
    const off = /switched off/.test((res && res.reason) || '');
    return off ? { ok: false, hidden: true, rows: [] } : { ok: false, hidden: false, rows: [], reason: `Can’t tell whether my machines disagree about a preference: ${(res && res.reason) || 'no answer'}.` };
  }
  const open = res.data && Array.isArray(res.data.open) ? res.data.open : [];
  const rows = open.filter((c) => c && c.store === 'preferences' && !c.resolved).map((c) => {
    const names = [...new Set((Array.isArray(c.versions) ? c.versions : []).map((v) => machines[v && v.origin] || (v && v.origin) || 'a machine'))];
    const who = names.length >= 2 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0] || 'Two machines';
    return {
      key: `conflict:${c.conflictId}`, id: c.conflictId,
      main: `${who} learned different versions of one preference. I use both as hints until it is settled.`,
      sub: `first seen ${ago(c.firstSeenAt, now) || 'at an unknown time'}${c.recurrenceCount > 1 ? ` · seen again ${c.recurrenceCount} times` : ''}`,
      tone: 'attn',
      record: c,
    };
  });
  return { ok: true, hidden: rows.length === 0, rows };
}

/** machineId → nickname from GET /pool (best effort; an unreadable pool leaves ids). */
export function machineNames(poolRes) {
  const map = {};
  const ms = poolRes && poolRes.ok && poolRes.data && Array.isArray(poolRes.data.machines) ? poolRes.data.machines : [];
  for (const m of ms) if (m && m.machineId) map[m.machineId] = m.nickname || m.machineId;
  return map;
}

// ── Headline + facts ──────────────────────────────────────────────────────
export function learnedHeadline({ prefs, corrections }) {
  if (prefs && prefs.off && (!corrections || corrections.off)) return { text: 'Learning from corrections is off on this agent.', tone: 'muted' };
  if (!prefs || !prefs.ok) return { text: 'Can’t tell what I’ve learned about you.', tone: 'muted' };
  const n = prefs.total;
  if (n === 0) return { text: 'Nothing yet — correct me the same way twice and it shows up here.', tone: 'ok' };
  return { text: `I’ve picked up ${n === 1 ? '1 thing' : `${n} things`} about how you like to work.`, tone: prefs.stale ? 'muted' : 'ok' };
}

export function learnedFacts({ prefs, corrections, conflicts }) {
  const facts = [];
  facts.push(prefs && prefs.ok ? { n: prefs.total, label: prefs.total === 1 ? 'preference kept' : 'preferences kept' } : { n: '?', label: 'preferences kept' });
  if (corrections && corrections.ok) facts.push({ n: corrections.watching.length, label: corrections.watching.length === 1 ? 'correction being watched' : 'corrections being watched' });
  else if (!corrections || !corrections.off) facts.push({ n: '?', label: 'corrections being watched' });
  if (conflicts && conflicts.ok && conflicts.rows.length) facts.push({ n: conflicts.rows.length, label: conflicts.rows.length === 1 ? 'disagreement between machines' : 'disagreements between machines', tone: 'attn' });
  return facts.slice(0, 4);
}

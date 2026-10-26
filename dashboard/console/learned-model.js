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

/**
 * The ledger writes about "The user"; this page is written to you. "The user wants X"
 * → "You want X": the subject is swapped and the verb right after it is put back in the
 * second person. Anything that does not start that way is left alone.
 */
const THIRD_TO_SECOND = { is: 'are', was: 'were', has: 'have', does: 'do', 'doesn’t': 'don’t', "doesn't": "don't", "isn't": "aren't", 'isn’t': 'aren’t', "wasn't": "weren't", "hasn't": "haven't" };
export function youify(text) {
  const s = String(text || '');
  const m = /^(The|This) user(’s|'s)?\s+(\S+)([\s\S]*)$/i.exec(s);
  if (!m) return s;
  if (m[2]) return `Your ${m[3]}${m[4]}`;
  const verb = m[3];
  const lower = verb.toLowerCase();
  let v = THIRD_TO_SECOND[lower];
  if (!v) {
    if (/ies$/.test(lower) && lower.length > 4) v = lower.replace(/ies$/, 'y');
    else if (/(ss|sh|ch|x|z|o)es$/.test(lower)) v = lower.replace(/es$/, '');
    else if (/[^s]s$/.test(lower) && !/ss$/.test(lower)) v = lower.replace(/s$/, '');
    else v = verb; // "asked", "corrected", "will": already fine in the second person
  }
  // A second clause about the same subject ("… and prefers clarity") follows suit.
  const rest = m[4].replace(/\b(and|but|or) (wants|prefers|expects|needs|asks|likes|dislikes|requires|reports|indicates|is|has)\b/, (_, c, w) => `${c} ${THIRD_TO_SECOND[w] || w.replace(/s$/, '')}`);
  return `You ${v}${rest}`;
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
    const text = youify(clean(m ? m[1] : line.slice(2)));
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

// ── Preferences, structured (GET /preferences) ────────────────────────────
// The newer read: one entry per preference with when it was last seen, how often, how
// sure, and which machine learned it. An older server has no such route (404); the page
// then falls back to the session-context block above.

export const WEEK_MS = 7 * 24 * 3600_000;

/** Did the server answer that it has no /preferences route (an older server)? */
export function isMissingRoute(res) {
  return Boolean(res && !res.ok && /answered 404/.test(res.reason || ''));
}

export function dateWords(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t) || t <= 0) return null;
  return new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** "New this week" (first seen in the last 7 days) vs "seen again this week" (an older one that came back). */
export function recencyWords(recordedAt, seen, now = Date.now()) {
  const t = Date.parse(recordedAt);
  if (!Number.isFinite(t) || t <= 0 || now - t > WEEK_MS || t - now > WEEK_MS) return null;
  return seen > 1 ? 'seen again this week' : 'new this week';
}

/**
 * GET /preferences → the same list shape buildPreferences gives, plus when, which machine
 * and the "this week" mark. `machines` (machineId → nickname) names the origin; the
 * machine is shown only when there is more than one machine to tell apart.
 */
export function buildPreferenceEntries(res, { lastGood = null, now = Date.now(), machines = {} } = {}) {
  if (!res || !res.ok) return buildPreferences(res, { lastGood, now });
  const d = res.data || {};
  if (!Array.isArray(d.entries)) return { ok: false, off: false, reason: 'Can’t tell what I’ve learned: the answer had no preference list.' };
  const many = Object.keys(machines).length > 1;
  const rows = [];
  for (const e of d.entries) {
    if (!e || typeof e.learning !== 'string') continue;
    const text = youify(clean(e.learning));
    if (!text) continue;
    const confidence = Number.isFinite(e.confidence) ? e.confidence : null;
    const seen = Number.isFinite(e.dedupeCount) && e.dedupeCount >= 1 ? Math.floor(e.dedupeCount) : 1;
    const origin = typeof e.origin === 'string' && e.origin ? e.origin : null;
    const machine = origin ? clean(machines[origin] || origin, 60) : null;
    const when = dateWords(e.recordedAt);
    const fresh = recencyWords(e.recordedAt, seen, now);
    rows.push({
      key: `pref:${typeof e.dedupeKey === 'string' ? e.dedupeKey : rows.length}`,
      text, confidence, seen, recordedAt: typeof e.recordedAt === 'string' ? e.recordedAt : null, origin, machine, fresh,
      redacted: e.textRedacted === true,
      sub: [fresh, when, seenWords(seen), confidenceWords(confidence), many && machine ? machine : null].filter(Boolean).join(' · '),
      raw: JSON.stringify({ dedupeKey: e.dedupeKey, recordedAt: e.recordedAt, confidence: e.confidence, dedupeCount: e.dedupeCount, origin: e.origin }),
    });
  }
  const total = Number.isFinite(d.total) ? Math.max(d.total, rows.length) : rows.length;
  const freshCount = rows.filter((r) => r.fresh === 'new this week').length;
  return {
    ok: true, off: false, stale: false, structured: true,
    rows, total,
    notLoaded: 0, notLoadedWords: d.truncated === true ? `Showing the newest ${rows.length} of ${total}.` : null,
    newThisWeek: freshCount,
    mesh: d.scope === 'mesh',
    meshWords: d.scope === 'mesh' ? 'Includes what my other machines learned about you.' : null,
    showMachine: many,
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
  const summary = youify(clean(r.scrubbedSummary)) || kindWords(r.kind);
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
  // The same rule the body states: a correction has to come back on different days.
  if (n === 0) return { text: 'Nothing yet — correct me the same way on a couple of different days and it shows up here.', tone: 'ok' };
  return { text: `I’ve picked up ${n === 1 ? '1 thing' : `${n} things`} about how you like to work.`, tone: prefs.stale ? 'muted' : 'ok' };
}

export function learnedFacts({ prefs, corrections, conflicts }) {
  const facts = [];
  facts.push(prefs && prefs.ok ? { n: prefs.total, label: prefs.total === 1 ? 'preference kept' : 'preferences kept' } : { n: '?', label: 'preferences kept' });
  if (prefs && prefs.ok && prefs.newThisWeek) facts.push({ n: prefs.newThisWeek, label: 'new this week' });
  if (corrections && corrections.ok) facts.push({ n: corrections.watching.length, label: corrections.watching.length === 1 ? 'correction being watched' : 'corrections being watched' });
  else if (!corrections || !corrections.off) facts.push({ n: '?', label: 'corrections being watched' });
  if (conflicts && conflicts.ok && conflicts.rows.length) facts.push({ n: conflicts.rows.length, label: conflicts.rows.length === 1 ? 'disagreement between machines' : 'disagreements between machines', tone: 'attn' });
  return facts.slice(0, 4);
}

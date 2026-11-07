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
import { verifiedDisplayName } from './display-identity.js';

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
  // warning-path: row
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
    // warning-path: row
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
      // warning-path: row
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
  for (const m of ms) if (m && m.machineId) map[m.machineId] = verifiedDisplayName(m.nickname, m.machineId) || 'another machine';
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
  // warning-path: pageHead
  if (conflicts && conflicts.ok && conflicts.rows.length) facts.push({ n: conflicts.rows.length, label: conflicts.rows.length === 1 ? 'disagreement between machines' : 'disagreements between machines', tone: 'attn' });
  return facts.slice(0, 4);
}

// ── What I've learned to do (GET /skills/learned) ─────────────────────────
// The Skill Learning Sentinel's status for this machine (docs/specs/skill-learning-sentinel.md
// §3.10). Proposals come first (each wants a verdict: Agree / Disagree with a reason), then
// one plain line per learned skill with its numbers in words, then the measured cost. Every
// string the drafter wrote (description, paraphrases) is shown as TEXT by the page; nothing
// here produces markup.

/** The reasons the Disagree control offers; the tag goes in the request as `reason`. */
export const DISAGREE_REASONS = [
  { value: 'not something I do', label: 'Not something I do' },
  { value: 'wrong steps', label: 'Wrong steps' },
  { value: 'already have a skill for this', label: 'I already have a skill for this' },
  { value: 'other', label: 'Other' },
];
export const LEARNED_SKILLS_OFF = 'Not switched on here.';
export const LEARNED_SKILLS_EMPTY = 'Nothing learned yet.';
const MAX_PARAPHRASES = 6;

const count = (n, one, many) => `${n} ${n === 1 ? one : (many || `${one}s`)}`;
const num = (v) => (Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);

/** A proposal with no operator verdict yet wants one; a decided one is shown with its verdict. */
export function proposalPending(p) {
  return Boolean(p) && typeof p.name === 'string' && !(p.verdict && typeof p.verdict === 'object' && p.verdict.verdict);
}

/** What a proposal card shows: the plain description, its triggering paraphrases, and the decided line when any. */
export function proposalCardText(p) {
  const name = clean(p && p.name, 80) || 'unnamed';
  const description = clean(p && p.description, 600) || `A skill I think I have learned (${name}).`;
  const paraphrases = (Array.isArray(p && p.paraphrases) ? p.paraphrases : []).map((t) => clean(t, 200)).filter(Boolean).slice(0, MAX_PARAPHRASES);
  const v = p && p.verdict && typeof p.verdict === 'object' ? p.verdict : null;
  const decided = v && v.verdict ? `You ${v.verdict === 'agree' ? 'agreed' : 'disagreed'}${v.reason ? ` (${clean(v.reason, 80)})` : ''}${v.at ? ` · ${ago(v.at) || 'earlier'}` : ''}.` : null;
  const waiting = p && p.pendingReason === 'one-family' ? 'Only one reviewer family has looked at this; a second one, or your verdict, settles it.' : null;
  // Spec §3.3: a proposal on the disagreement set is LABELLED so the operator's tap grades the dissenting rung.
  const d = p && p.disagreement;
  const dissent = d === 'arbiter-only' ? 'My judgment drafted this; the fixed rule would have waited.' : d === 'default-only' ? 'The fixed rule drafted this; my judgment would have waited.' : (p && p.arbiterOnly === true ? 'My judgment drafted this; the fixed rule would have waited.' : null);
  return { name, description, paraphrases, decided, waiting, dissent, pending: proposalPending(p), createdWords: p && p.createdAt ? `Drafted ${ago(p.createdAt) || 'earlier'}` : '' };
}

/** "weekly-ci-health — 4 runs accepted, 1 corrected, 2 unknown" (plus the state when not plainly learned). */
export function skillLine(s) {
  const name = clean(s && s.name, 80) || 'unnamed';
  const accepted = num(s && s.accepted) + num(s && s.acceptedInferred);
  const parts = [`${count(accepted, 'run')} accepted`, `${num(s && s.corrected)} corrected`, `${num(s && s.unknown)} unknown`];
  const state = s && s.state === 'locked' ? ' · locked' : s && s.state === 'retired' ? ' · retired' : '';
  const misfires = num(s && s.misfires) ? ` · ${count(num(s.misfires), 'misfire')}` : '';
  return { key: `skill:${name}`, name, text: `${name} — ${parts.join(', ')}${misfires}${state}`, state: (s && s.state) || 'learned', locked: Boolean(s && s.locked) };
}

/** The measured cost line, from the sentinel's own number; never estimated here. */
export function costLine(status) {
  const c = status && status.llmSpendCentsToday;
  if (!Number.isFinite(c)) return 'Cost today: not measured yet.';
  const dollars = (c / 100).toFixed(2);
  return c === 0 ? 'Cost today: nothing spent.' : `Cost today: $${dollars} measured.`;
}

/**
 * GET /skills/learned → the section's view. 503 = not switched on here (no fake empty list);
 * any other failure = can't tell; a 200 without the expected shape is unreadable, never "nothing".
 */
export function buildLearnedSkillsView(res) {
  if (!res || !res.ok) {
    const off = (res && res.status === 503) || /switched off/.test((res && res.reason) || '');
    if (off) return { ok: false, off: true, reason: LEARNED_SKILLS_OFF, proposals: [], skills: [], pendingCount: 0 };
    return { ok: false, off: false, reason: `Can’t tell what I’ve learned to do: ${(res && res.reason) || 'no answer'}.`, proposals: [], skills: [], pendingCount: 0 };
  }
  const d = res.data;
  if (!d || typeof d !== 'object' || !Array.isArray(d.proposals) || !Array.isArray(d.skills)) {
    return { ok: false, off: false, reason: 'Can’t tell what I’ve learned to do: the answer had no list.', proposals: [], skills: [], pendingCount: 0 };
  }
  const proposals = d.proposals.filter((p) => p && typeof p.name === 'string').map(proposalCardText);
  const pending = proposals.filter((p) => p.pending);
  const skills = d.skills.filter((s) => s && typeof s.name === 'string' && s.state !== 'proposal').map(skillLine);
  const mode = d.mode === 'live' ? 'live' : 'shadow';
  return {
    ok: true, off: false, reason: null,
    proposals: [...pending, ...proposals.filter((p) => !p.pending)],
    pendingCount: pending.length,
    skills,
    mode,
    modeWords: mode === 'shadow' ? 'Watching only: I draft proposals here and write nothing until you agree.' : null,
    costWords: costLine(d),
    machine: clean(d.machine, 60) || null,
    empty: !proposals.length && !skills.length ? LEARNED_SKILLS_EMPTY : null,
  };
}

/** For Home: the proposals still without a verdict, or null when the answer cannot be read. */
export function proposalsNeedingVerdict(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.proposals)) return null;
  return data.proposals.filter(proposalPending).map(proposalCardText);
}

// ── Waiting for your OK (GET /skills/learned → pending) ───────────────────
// A skill the sentinel wrote in live mode but has NOT rendered (spec §3.5: `instar-learned-state:
// pending`): during rung 2 every new skill waits for one tap, and a draft only one reviewer family
// could look at waits at any rung. The card shows what the skill does, the requests that led to
// it, and the reason it is waiting — all as text — with Confirm (primary) and Reject. The PIN goes
// in that one request's body and is zeroed after (as the proposal taps do).

export const PENDING_OK_EMPTY = 'Nothing is waiting for your OK.';
/** Why a skill is waiting, in plain words; unknown reasons still say it waits for the tap. */
export function pendingReasonWords(reason) {
  if (reason === 'one-family') return 'Only one reviewer family could look at this; your OK stands in for the second.';
  if (reason === 'rung-unproven') return 'Until my automatic gate has proven itself, each new skill waits for your OK.';
  return 'Waiting for your OK before I use it.';
}

/** What a pending card shows. Every string the drafter wrote is cleaned and shown as text by the page. */
export function pendingCardText(p) {
  const name = clean(p && p.name, 80) || 'unnamed';
  const body = clean(p && p.description, 600) || `A skill I have written but not switched on yet (${name}).`;
  const paraphrases = (Array.isArray(p && p.paraphrases) ? p.paraphrases : []).map((t) => clean(t, 200)).filter(Boolean).slice(0, MAX_PARAPHRASES);
  const reviewerFamily = clean(p && p.reviewerFamily, 40) || null;
  const pendingReason = p && (p.pendingReason === 'one-family' || p.pendingReason === 'rung-unproven') ? p.pendingReason : null;
  const version = Number.isFinite(p && p.version) ? p.version : null;
  return {
    name, body, paraphrases, reviewerFamily, pendingReason, version,
    reasonWords: pendingReasonWords(pendingReason),
    reviewedWords: reviewerFamily ? `reviewed by ${reviewerFamily}` : null,
    createdWords: p && p.createdAt ? `Written ${ago(p.createdAt) || 'earlier'}` : '',
  };
}

/**
 * GET /skills/learned → the pending rows. 503 = not switched on here; a failure = can't tell; a 200
 * without a `pending` list is unreadable — never "nothing waiting". Rows without a name are dropped.
 */
export function buildPending(res) {
  if (!res || !res.ok) {
    const off = (res && res.status === 503) || /switched off/.test((res && res.reason) || '');
    if (off) return { ok: false, off: true, reason: LEARNED_SKILLS_OFF, rows: [] };
    return { ok: false, off: false, reason: `Can’t tell what is waiting for your OK: ${(res && res.reason) || 'no answer'}.`, rows: [] };
  }
  const d = res.data;
  if (!d || typeof d !== 'object' || !Array.isArray(d.pending)) {
    return { ok: false, off: false, reason: 'Can’t tell what is waiting for your OK: the answer had no list.', rows: [] };
  }
  const rows = d.pending.filter((p) => p && typeof p.name === 'string').map(pendingCardText);
  return { ok: true, off: false, reason: null, rows, empty: rows.length ? null : PENDING_OK_EMPTY };
}

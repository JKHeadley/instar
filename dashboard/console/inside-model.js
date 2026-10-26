// How I'm doing inside — pure view-model
// (docs/specs/console-features/under-the-hood.md: "Integrated-Being", "Process health",
// "Checks on my own claims", "Evidence", and "The two combined pages, in one view";
// legacy tab ids `integrated-being`, `process-health`, `evidence`, and the Preferences
// tab's class reviews and claim checks).
//
// Every decision lives here so it can be tested: the recent-activity timeline (counted
// only within the records on screen, newest first, day-grouped), each commitment's status
// (never "open" when its later history is not loaded), the backwards chain as a short
// history, session bindings and the exact revoke request; the problems section (patterns,
// the week's whole-ledger total, "N still open among the records shown", paging by the
// route's own `before` timestamp, stale with its time); the claim observations (four
// verdict words, coverage notes apart, "advisory only"), class reviews; the memory-source
// lookup (one field, the kind inferred, the picker only when ambiguous); and the page
// headline built from the sections, worst first, coverage stated.
// The page calls exactly one write route: revoking a session binding (bearer + intent header).

import { ago } from './home-model.js';
import { groupFailures } from './shared-counts.js';
import { sanitizeForDisplay } from '../process-health.js';

const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || `${one}s`)}`;
const reasonOf = (res) => (res && res.reason) || 'no answer';
/** 503 (or the console's own "switched off" reason) vs any other failure. */
export function sourceState(res) {
  if (!res) return 'failed';
  if (res.ok) return 'ok';
  return res.status === 503 || /switched off/.test(res.reason || '') ? 'off' : 'failed';
}
/** The legacy Process health sanitizer, kept as the safety contract for every dynamic value. */
export function clean(value, kind = 'summary') { return sanitizeForDisplay(value, kind).replace(/\s+/g, ' ').trim(); }
const dt = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? new Date(t) : null; };
export function exactTime(iso) { const d = dt(iso); return d ? d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'unknown'; }

// ═══ 1. What my other conversations have been doing (GET /shared-state/*) ═══════════
export const KINDS = ['commitment', 'agreement', 'thread-opened', 'thread-closed', 'thread-abandoned', 'decision', 'note'];
export const COUNTERPARTIES = ['user', 'agent', 'self', 'system'];
export const KIND_WORDS = {
  commitment: 'Commitment', agreement: 'Agreement', 'thread-opened': 'Thread opened', 'thread-closed': 'Thread closed',
  'thread-abandoned': 'Thread marked abandoned', decision: 'Decision', note: 'Note',
};
export const COUNTERPARTY_WORDS = { user: 'People', agent: 'Agents', self: 'Myself', system: 'The system' };
export const KIND_ICON = { commitment: '✓', agreement: '⇄', 'thread-opened': '○', 'thread-closed': '●', 'thread-abandoned': '○', decision: '◆', note: '·' };
/** Filter chips (≤ the legacy filters' meaning; More filters keeps every legacy value). */
export const CHIPS = [
  { key: 'all', label: 'All' },
  { key: 'decision', label: 'Decisions' },
  { key: 'agreement', label: 'Agreements' },
  { key: 'threads', label: 'Threads' },
  { key: 'commitment', label: 'Commitments' },
  { key: 'people', label: 'With people' },
  { key: 'agents', label: 'With agents' },
];
export const WINDOW_STEP = 40;
export const WINDOW_MAX = 200; // the route's own cap

export function chipMatches(chip, e) {
  switch (chip) {
    case 'all': return true;
    case 'threads': return /^thread-/.test(e.kind);
    case 'people': return e.counterparty && e.counterparty.type === 'user';
    case 'agents': return e.counterparty && e.counterparty.type === 'agent';
    default: return e.kind === chip;
  }
}

/** The exact recent-activity URL: the counterparty filter is the route's own (server side); kind is filtered here, as the legacy tab did. */
export function recentUrl({ limit = WINDOW_STEP, counterparty = null } = {}) {
  const n = Math.max(1, Math.min(WINDOW_MAX, limit));
  return `/shared-state/recent?limit=${n}${counterparty && COUNTERPARTIES.includes(counterparty) ? `&counterpartyType=${counterparty}` : ''}`;
}

/** Agent names known from pairing, keyed by lowercased fingerprint. The records name an agent by fingerprint only. */
let peerNames = {};

/** Read the names out of GET /threadline/pairing; a failed read leaves no names (rows fall back to a short id). */
export function setPeerNames(res) {
  const map = {};
  const list = res && res.ok && res.data && Array.isArray(res.data.pairings) ? res.data.pairings : [];
  for (const p of list) {
    const fp = typeof p.peerFp === 'string' ? p.peerFp.toLowerCase() : '';
    const name = clean(p.peerName, 'label');
    if (fp && name && name.toLowerCase() !== fp) map[fp] = name;
  }
  peerNames = map;
}

/** A bare 32-hex fingerprint becomes the paired name, else a short id; any other name is shown as recorded. */
export function agentLabel(name) {
  if (!/^[0-9a-f]{32}$/i.test(name)) return name;
  return peerNames[name.toLowerCase()] || `agent ${name.slice(0, 8)}…`;
}

export function counterpartyWords(cp) {
  if (!cp || typeof cp !== 'object') return 'with someone not recorded';
  const name = clean(cp.name, 'label');
  switch (cp.type) {
    case 'user': return name && name !== 'user' ? `with ${name}` : 'with you';
    case 'agent': return name ? `with ${agentLabel(name)}` : 'with an agent';
    case 'self': return 'on my own';
    case 'system': return 'by the system';
    default: return 'with someone not recorded';
  }
}

export function provenanceWords(e) {
  const who = clean(e && e.emittedBy && e.emittedBy.subsystem, 'label') || 'an unnamed part';
  const inst = clean(e && e.emittedBy && e.emittedBy.instance, 'label');
  switch (e && e.provenance) {
    case 'session-asserted': return `Written by a session${inst ? ` (${inst})` : ''}`;
    case 'subsystem-asserted': return `Asserted by the system (${who})`;
    case 'subsystem-inferred': return `Inferred by the system (${who})${e.source === 'heuristic-classifier' ? ', from a heuristic classifier' : ''}`;
    default: return 'Who wrote this is not recorded';
  }
}

export const MECHANISM_WORDS = {
  'scheduled-job': 'A scheduled job will do it',
  'polling-sentinel': 'A watcher checks for it',
  'external-callback': 'Waiting on something outside to report back',
  'passive-wait': 'Waiting, with nothing actively checking',
  'user-driven': 'You will drive it',
};
const LIFECYCLE_PREFIX = /^(expired|stranded|cancelled|resolved):/;

/**
 * A commitment's status. Stored non-open status wins; else the most recent entry in the
 * loaded window that supersedes it decides (by its subject prefix, as the legacy tab did);
 * else the status is UNKNOWN — the window cannot show later history, and the backwards
 * chain cannot find it, so it is never called open.
 */
export function commitmentStatus(e, entries) {
  const c = (e && e.commitment) || {};
  if (c.status && c.status !== 'open') return { key: c.status, words: STATUS_WORDS[c.status] || 'Status not recorded', known: true };
  if (c.resolution) return { key: 'resolved', words: STATUS_WORDS.resolved, known: true };
  let sup = null;
  for (const x of entries || []) if (x && x.supersedes === e.id && (!sup || Date.parse(x.t) > Date.parse(sup.t))) sup = x;
  if (sup) {
    const m = typeof sup.subject === 'string' ? LIFECYCLE_PREFIX.exec(sup.subject) : null;
    const key = m ? m[1] : 'resolved';
    return { key, words: STATUS_WORDS[key], known: true, by: sup };
  }
  return { key: 'unknown', words: 'Status unknown: later history isn’t loaded', known: false };
}
const STATUS_WORDS = { open: 'Open', resolved: 'Resolved', cancelled: 'Cancelled', expired: 'Expired', stranded: 'Stranded', disputed: 'Disputed' };

export function disputeCount(id, entries) { return (entries || []).filter((x) => x && x.disputes === id).length; }
const timesWords = (n) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);

function dayLabel(iso, now) {
  const d = dt(iso);
  if (!d) return 'Date not recorded';
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const that = new Date(d); that.setHours(0, 0, 0, 0);
  const diff = Math.round((today - that) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
}

export function entryRow(e, entries, now = Date.now()) {
  const subject = clean(e.subject) || 'No subject recorded';
  const kindW = KIND_WORDS[e.kind] || 'Record';
  const subParts = [kindW, counterpartyWords(e.counterparty)];
  let tone = null;
  let status = null;
  let overdue = false;
  let disputes = 0;
  if (e.kind === 'commitment') {
    status = commitmentStatus(e, entries);
    disputes = disputeCount(e.id, entries);
    const dl = e.commitment && Date.parse(e.commitment.deadline);
    overdue = Number.isFinite(dl) && dl < now && (!status.known || status.key === 'open');
    subParts.push(status.words);
    if (overdue) subParts.push('overdue');
    if (disputes) subParts.push(`disputed ${timesWords(disputes)}`);
    tone = overdue || disputes || status.key === 'expired' || status.key === 'stranded' ? 'attn' : status.known ? null : 'unknown';
  } else if (e.kind === 'thread-abandoned') tone = 'attn';
  else if (e.kind === 'note' && e.disputes) { subParts.push('disputes an earlier record'); tone = 'attn'; }
  return {
    key: `ib:${e.id}`, id: e.id, kind: e.kind, icon: KIND_ICON[e.kind] || '·',
    main: subject, sub: subParts.join(' · '), end: ago(e.t, now) || '', tone, status, overdue, disputes, record: e,
  };
}

/**
 * GET /shared-state/recent → the timeline. Counts are WITHIN the loaded records only
 * ("Among the 40 most recent records"); there is no live open-thread total.
 */
export function buildActivity(res, { chip = 'all', kind = null, counterparty = null, limit = WINDOW_STEP, now = Date.now() } = {}) {
  const st = sourceState(res);
  if (st === 'off') return { ok: false, off: true, reason: 'This record is off on this agent.' };
  if (st === 'failed') return { ok: false, off: false, reason: `Can’t tell what my other conversations have been doing: ${reasonOf(res)}.` };
  const raw = res.data && Array.isArray(res.data.entries) ? res.data.entries : null;
  if (!raw) return { ok: false, off: false, reason: 'Can’t tell what my other conversations have been doing: the answer had no records.' };
  const entries = raw.filter((e) => e && typeof e.id === 'string').slice().sort((a, b) => (Date.parse(b.t) || 0) - (Date.parse(a.t) || 0));
  const n = entries.length;
  const count = (k) => entries.filter((e) => e.kind === k).length;
  const counts = { decision: count('decision'), agreement: count('agreement'), opened: count('thread-opened'), closed: count('thread-closed'), abandoned: count('thread-abandoned') };
  const chipCounts = Object.fromEntries(CHIPS.map((c) => [c.key, entries.filter((e) => chipMatches(c.key, e)).length]));
  const shown = entries.filter((e) => chipMatches(chip, e) && (!kind || e.kind === kind));
  // Identical thread events (same kind, subject and counterparty) fold into one line: "12 times", newest first.
  const folded = new Map();
  const rows = [];
  for (const e of shown) {
    const r = entryRow(e, entries, now);
    const fk = /^thread-/.test(e.kind) ? `${e.kind}|${r.main.toLowerCase()}|${counterpartyWords(e.counterparty)}` : null;
    if (fk && folded.has(fk)) { const f = folded.get(fk); f.times++; f.records.push(e); f.sub = `${f.baseSub} · ${f.times} times`; continue; }
    if (fk) { r.times = 1; r.records = [e]; r.baseSub = r.sub; folded.set(fk, r); }
    rows.push(r);
  }
  const groups = [];
  for (const r of rows) {
    const label = dayLabel(r.record.t, now);
    const g = groups[groups.length - 1];
    if (g && g.label === label) g.rows.push(r); else groups.push({ label, rows: [r] });
  }
  const scope = counterparty ? ` ${COUNTERPARTY_WORDS[counterparty] ? `with ${counterparty === 'user' ? 'people' : counterparty === 'agent' ? 'agents' : counterparty === 'self' ? 'myself' : 'the system'}` : ''}` : '';
  const parts = [];
  if (counts.decision) parts.push(plural(counts.decision, 'decision'));
  if (counts.agreement) parts.push(plural(counts.agreement, 'agreement'));
  if (counts.opened) parts.push(`${plural(counts.opened, 'thread')} opened`);
  if (counts.closed) parts.push(`${counts.closed} closed`);
  if (counts.abandoned) parts.push(`${counts.abandoned} marked abandoned`);
  const line = n === 0 ? `Nothing recorded recently${scope}.`
    : `Among the ${n} most recent records${scope}: ${parts.length ? parts.join(', ') : 'only notes and commitments'}.`;
  return {
    ok: true, off: false, entries, rows, groups, counts, chipCounts, n, line,
    tiles: [
      { n: counts.decision, label: counts.decision === 1 ? 'decision' : 'decisions' },
      { n: counts.agreement, label: counts.agreement === 1 ? 'agreement' : 'agreements' },
      { n: counts.opened + counts.closed + counts.abandoned, label: 'thread events', tone: counts.abandoned ? 'attn' : null },
    ],
    tilesNote: n ? `of the last ${n}` : null,
    canShowMore: n >= limit && limit < WINDOW_MAX,
    nextLimit: Math.min(WINDOW_MAX, limit + WINDOW_STEP),
    filtersWords: [kind ? KIND_WORDS[kind] : null, counterparty ? COUNTERPARTY_WORDS[counterparty] : null].filter(Boolean).join(' · ') || null,
  };
}

/** The record sheet's story lines (commitments keep their full status). */
export function entryStory(r, now = Date.now()) {
  const e = r.record;
  const lines = [{ label: 'What', text: clean(e.subject) || 'No subject recorded' }];
  if (e.summary) lines.push({ label: 'More', text: clean(e.summary) });
  lines.push({ label: 'Kind', text: KIND_WORDS[e.kind] || 'Record' }, { label: 'Who with', text: counterpartyWords(e.counterparty) }, { label: 'When', text: `${ago(e.t, now) || 'unknown'} (${exactTime(e.t)})` });
  if (e.kind === 'commitment') {
    const c = e.commitment || {};
    const m = c.mechanism || {};
    lines.push({ label: 'How it gets done', text: MECHANISM_WORDS[m.type] || 'Not recorded' });
    if (m.refStatus && m.refStatus !== 'valid') lines.push({ label: 'Its reference', text: m.refStatus === 'invalid' ? 'Could not be found when it was written' : 'Not checked when it was written' });
    if (c.deadline) lines.push({ label: 'Deadline', text: `${exactTime(c.deadline)}${r.overdue ? ' (overdue)' : ''}` });
    lines.push({ label: 'Status', text: r.status ? r.status.words : 'Status not recorded' });
    if (r.disputes) lines.push({ label: 'Disputes', text: `Disputed ${timesWords(r.disputes)}` });
    if (c.resolution) lines.push({ label: 'Resolution', text: `${RESOLUTION_WORDS[c.resolution.by] || 'Resolved'} · ${exactTime(c.resolution.at)}${c.resolution.note ? ` · ${clean(c.resolution.note)}` : ''}` });
    else if (r.status && r.status.by) lines.push({ label: 'Resolution', text: `${clean(r.status.by.subject)} · ${exactTime(r.status.by.t)}` });
  }
  lines.push({ label: 'Written by', text: provenanceWords(e) });
  return lines;
}
const RESOLUTION_WORDS = { 'self-asserted': 'I said it was done', 'subsystem-verified': 'The system verified it', 'user-resolved': 'You resolved it' };

/** GET /shared-state/chain/:id → the history list (newest first: this entry, then what it replaced). */
export function buildChain(res, { now = Date.now() } = {}) {
  const st = sourceState(res);
  if (st === 'off') return { ok: false, reason: 'This record is off on this agent.' };
  if (st === 'failed') return { ok: false, reason: `Can’t tell what it replaced: ${reasonOf(res)}.` };
  const chain = res.data && Array.isArray(res.data.chain) ? res.data.chain : null;
  if (!chain) return { ok: false, reason: 'Can’t tell what it replaced: the answer had no history.' };
  return {
    ok: true,
    rows: chain.map((e, i) => ({ key: `chain:${e.id}`, id: e.id, main: clean(e.subject) || 'No subject recorded', sub: `${i === 0 ? 'This record' : 'Replaced by the one above'} · ${KIND_WORDS[e.kind] || 'Record'}`, end: ago(e.t, now) || '', record: e })),
    words: chain.length <= 1 ? 'It did not replace anything I can find.' : `It replaced ${plural(chain.length - 1, 'earlier record')}.`,
  };
}
/** The legacy chain explorer's id check: 12 hex characters. */
export function validEntryId(s) { return /^[0-9a-f]{12}$/.test(String(s || '').trim()); }
export function chainUrl(id) { return `/shared-state/chain/${encodeURIComponent(String(id).trim())}`; }

/** GET /shared-state/stats → the raw counters for Technical (never a health signal). */
export function buildStats(res) {
  const st = sourceState(res);
  if (st !== 'ok') return { ok: false, off: st === 'off', reason: st === 'off' ? 'This record is off on this agent.' : `Can’t tell the record’s counters: ${reasonOf(res)}.` };
  const d = res.data || {};
  const counts = d.counts && typeof d.counts === 'object' ? d.counts : {};
  const total = Object.values(counts).reduce((a, b) => a + (Number(b) || 0), 0);
  return {
    ok: true,
    lines: [
      { label: 'Records kept (all kinds)', text: String(total) },
      ...KINDS.map((k) => ({ label: KIND_WORDS[k], text: String(Number(counts[k]) || 0) })),
      { label: 'Classifier fires since start', text: String(d.classifierFired ?? 0) },
      { label: 'Rotations', text: String(d.rotationCount ?? 0) },
      { label: 'Unclosed threads past their time (raw counter)', text: String(d.unclosedThreadsOverTtl ?? 0) },
    ],
    ttlNote: 'The last counter has no caller that raises it, so zero here proves nothing about quiet threads; abandoned threads show as their own records instead.',
  };
}

// ── Session bindings (GET /shared-state/sessions; 503 = the session-write surface is off) ──
export function bindingStatus(s, now = Date.now()) {
  if (s.revoked) return { key: 'revoked', words: 'Revoked' };
  const exp = Date.parse(s.absoluteExpiresAt);
  if (Number.isFinite(exp) && exp < now) return { key: 'expired', words: 'Expired' };
  return s.hasWritten ? { key: 'active', words: 'Active (has written)' } : { key: 'bound', words: 'Bound (has not written yet)' };
}
export function buildBindings(res, { now = Date.now() } = {}) {
  const st = sourceState(res);
  if (st === 'off') return { ok: false, hidden: true };
  if (st === 'failed') return { ok: false, hidden: false, reason: `Can’t tell which sessions can write here: ${reasonOf(res)}.` };
  const list = res.data && Array.isArray(res.data.sessions) ? res.data.sessions : null;
  if (!list) return { ok: false, hidden: false, reason: 'Can’t tell which sessions can write here: the answer had no list.' };
  const rows = list.filter((s) => s && typeof s.sessionId === 'string').map((s) => {
    const status = bindingStatus(s, now);
    const label = clean(s.label, 'label');
    return {
      key: `bind:${s.sessionId}`, id: s.sessionId, main: label || `Session ${s.sessionId.slice(0, 8)}`,
      sub: `${status.words} · active ${ago(s.lastActiveAt, now) || 'at an unknown time'}`,
      end: '', tone: status.key === 'revoked' || status.key === 'expired' ? 'unknown' : null, status, canRevoke: status.key !== 'revoked', record: s,
    };
  });
  return { ok: true, hidden: false, rows };
}
/** The exact revoke request (bearer + the route's intent header; no PIN — the server asks none). */
export function revokeRequest(sessionId) {
  return { method: 'POST', path: `/shared-state/sessions/${encodeURIComponent(sessionId)}/revoke`, headers: { 'X-Instar-Request': '1' } };
}
export function revokeConfirmWords(row) { return `Revoke ${row.main}? Its future writes to this record will be refused.`; }
export function revokeResultWords(x) {
  if (x && x.ok && x.data && x.data.revoked) return { ok: true, message: 'Revoked. Its future writes will be refused.' };
  if (x && x.status === 404) return { ok: true, message: 'Already gone: that binding is no longer registered.' };
  if (x && x.status === 503) return { ok: false, message: 'Session bindings are switched off on this agent.' };
  const why = x && x.data && (x.data.error || x.data.message);
  return { ok: false, message: why ? `Not revoked: ${String(why)}.` : `Not revoked: the server answered ${(x && x.status) || 'nothing'}.` };
}

// ═══ 2. Problems I caught in my own work (GET /failures*) ══════════════════════════
export const CATEGORY_WORDS = {
  concurrency: 'A timing clash (two things ran at once)', 'config-parse': 'A settings problem', wiring: 'Something that wasn’t hooked up',
  logic: 'A logic mistake', migration: 'An update step that went wrong', 'test-gap': 'Something no test covered',
  'build-failure': 'The build broke', 'test-failure': 'A test that failed', regression: 'Something that used to work broke', unknown: 'A problem',
};
export function categoryWords(c) { return CATEGORY_WORDS[c] || 'A problem'; }
export const FAILURE_STATUS_WORDS = { open: 'Still looking into it', reopened: 'Came back', attributed: 'Cause known', analyzed: 'Looked into', resolved: 'Worked out' };
export function failureOpen(f) { return f && (f.status === 'open' || f.status === 'reopened'); }
export const INSIGHT_STATUS_WORDS = {
  discovered: 'Just noticed', 'acted-on': 'Being looked into', 'verified-effective': 'Fixed, and it stayed fixed',
  'verified-ineffective': 'The fix didn’t hold', inconclusive: 'Watched, nothing conclusive', dismissed: 'Set aside',
};
/** A pattern still repeating: not confirmed fixed and not set aside. */
export function insightActive(i) { return i && i.status !== 'verified-effective' && i.status !== 'dismissed'; }
export function insightCameBack(i) { return i && (i.status === 'verified-ineffective' || (Number(i.reopenCount) || 0) > 0); }
export const STAGE_WORDS = {
  dark: 'Not switched on', 'capture-only': 'Watching quietly (no alerts)', 'insight-push': 'Watching, and flagging repeats to you', 'default-on': 'On for everyone',
};
export const STAGE_INFO = [
  { key: 'dark', text: 'Not switched on: nothing is recorded.' },
  { key: 'capture-only', text: 'Watching quietly: problems are recorded, no alerts go anywhere.' },
  { key: 'insight-push', text: 'Watching and flagging: the same, plus a heads-up when one kind of problem keeps coming back.' },
  { key: 'default-on', text: 'On for everyone: the end state, switched on for every agent.' },
];
export const PROBLEMS_PAGE = 10;
export function failuresUrl(before = null, limit = PROBLEMS_PAGE) {
  return `/failures?limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ''}`;
}

export function failureRow(f, now = Date.now()) {
  const times = Number.isFinite(f.occurrenceCount) && f.occurrenceCount > 1 ? `seen ${f.occurrenceCount} times` : 'seen once';
  return {
    key: `fail:${f.id}`, id: f.id, main: `${categoryWords(f.category)}: ${clean(f.summary) || 'no summary recorded'}`,
    sub: `${FAILURE_STATUS_WORDS[f.status] || 'Status not recorded'} · ${times}`, end: ago(f.detectedAt, now) || '',
    tone: f.status === 'reopened' ? 'attn' : failureOpen(f) ? null : 'unknown', record: f,
  };
}
/** One line for a group of identical problems: "seen N times across M records", open first. */
export function groupedFailureRow(g, now = Date.now()) {
  const f = g.top;
  const r = failureRow(f, now);
  const times = g.times === 1 ? 'seen once' : `seen ${g.times} times${g.records.length > 1 ? ` across ${plural(g.records.length, 'record')}` : ''}`;
  const status = g.open && f.status !== 'open' && f.status !== 'reopened' ? 'Still looking into it' : (FAILURE_STATUS_WORDS[f.status] || 'Status not recorded');
  return { ...r, key: `fail:${f.id}`, sub: `${status} · ${times}`, end: ago(g.newest, now) || '', tone: g.repeating && g.open ? 'attn' : r.tone, group: g, records: g.records };
}
export function patternRow(i, now = Date.now()) {
  const ds = Number(i.distinctSessions) || 0;
  const since = dt(i.discoveredAt);
  return {
    key: `pat:${i.id}`, id: i.id, main: clean(i.summary) || 'A repeating problem',
    sub: `${INSIGHT_STATUS_WORDS[i.status] || 'Status not recorded'} · seen in ${plural(ds, 'change')}${since ? ` since ${since.toLocaleDateString([], { day: 'numeric', month: 'short' })}` : ''}`,
    end: ago(i.discoveredAt, now) || '', tone: insightCameBack(i) ? 'attn' : insightActive(i) ? null : 'unknown', record: i,
  };
}

/**
 * The problems section from its four reads: insights, the failure pages (first + older,
 * each asked with `before` = the oldest shown), the week's analysis and the all-time one.
 * `lastGood` ({ model, at }) shows a failed refresh as stale with its time, never empty.
 */
export function buildProblems({ insights, pages, week, all }, { lastGood = null, now = Date.now() } = {}) {
  const first = (pages || [])[0];
  const states = [insights, first, week].map(sourceState);
  if (states.includes('off') || sourceState(all) === 'off') return { ok: false, off: true, reason: 'Failure watching is off on this agent.' };
  if (sourceState(first) === 'failed') {
    if (lastGood && lastGood.model && lastGood.model.ok) {
      const at = new Date(lastGood.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      return { ...lastGood.model, stale: true, staleWords: `Showing what I knew at ${at}; couldn’t refresh since (${reasonOf(first)}).` };
    }
    return { ok: false, off: false, reason: `Can’t tell which problems I caught: ${reasonOf(first)}.` };
  }
  const seen = new Set();
  const failures = [];
  let moreFailed = null;
  let lastPageSize = 0;
  for (const p of pages) {
    if (!p || !p.ok) { moreFailed = `Couldn’t load older problems: ${reasonOf(p)}.`; break; }
    const list = p.data && Array.isArray(p.data.failures) ? p.data.failures : null;
    if (!list) return { ok: false, off: false, reason: 'Can’t tell which problems I caught: the answer had no list.' };
    lastPageSize = list.length;
    for (const f of list) if (f && typeof f.id === 'string' && !seen.has(f.id)) { seen.add(f.id); failures.push(f); }
  }
  // Identical problems fold into one line each; "repeating" is the operator's ordinary
  // meaning — seen more than once — from shared-counts.groupFailures. Open ones first.
  const grouped = groupFailures(failures);
  const rows = grouped.groups.map((g) => groupedFailureRow(g, now));
  const oldest = failures.length ? failures.reduce((a, f) => (Date.parse(f.detectedAt) < Date.parse(a.detectedAt) ? f : a), failures[0]).detectedAt : null;
  const openShown = failures.filter(failureOpen).length;

  let patterns;
  if (sourceState(insights) === 'ok' && insights.data && Array.isArray(insights.data.insights)) {
    const list = insights.data.insights.filter((i) => i && typeof i.id === 'string');
    patterns = { ok: true, rows: list.map((i) => patternRow(i, now)), active: list.filter(insightActive), cameBack: list.filter(insightCameBack) };
  } else patterns = { ok: false, reason: `Can’t tell whether anything is repeating: ${sourceState(insights) === 'ok' ? 'the answer had no list' : reasonOf(insights)}.` };

  // One count of what repeats: the folded problems seen more than once, plus any confirmed
  // pattern whose problems are not already among them (never the same thing twice).
  const repeatingIds = new Set(grouped.repeating.flatMap((g) => g.records.map((f) => f.id)));
  const extraPatterns = patterns.ok ? patterns.active.filter((i) => !(Array.isArray(i.supportingFailureIds) && i.supportingFailureIds.some((id) => repeatingIds.has(id)))) : [];
  const repeatingCount = grouped.repeating.length + extraPatterns.length;

  const weekTotal = sourceState(week) === 'ok' && Number.isFinite(week.data && week.data.total) ? week.data.total : null;
  const rollout = (sourceState(week) === 'ok' && week.data && week.data.rollout) || (sourceState(all) === 'ok' && all.data && all.data.rollout) || null;
  const stage = rollout && rollout.stage;

  let line;
  if (!patterns.ok && grouped.repeating.length === 0) line = `Can’t tell whether anything is repeating. ${weekTotal != null ? `${plural(weekTotal, 'problem')} recorded this week.` : ''}`.trim();
  else if (grouped.repeating.length) {
    const top = grouped.repeating[0];
    const first = `${clean(top.top.summary) || categoryWords(top.top.category)} (seen ${top.times} times)`;
    line = repeatingCount === 1
      ? `One problem keeps repeating: ${first}.`
      : `${repeatingCount} problems keep repeating; the first: ${first}.`;
  } else if (patterns.ok && patterns.active.length) {
    const top = patterns.cameBack[0] || patterns.active[0];
    const ds = Number(top.distinctSessions) || 0;
    line = patterns.active.length === 1
      ? `One kind of problem keeps coming back: ${clean(top.summary) || 'a repeating problem'}, across ${plural(ds, 'change')}.`
      : `${patterns.active.length} kinds of problem keep coming back; the first: ${clean(top.summary) || 'a repeating problem'}.`;
  } else if (weekTotal != null) {
    line = weekTotal === 0 ? 'Nothing repeating, and nothing new this week.'
      : `Nothing repeating. ${weekTotal === 1 ? '1 one-off problem' : `${weekTotal} one-off problems`} this week${openShown === 0 && rows.length ? ', none still open among those shown' : ''}.`;
  } else line = 'Nothing repeating.';

  return {
    ok: true, off: false, stale: false, line, rows, patterns, openShown, weekTotal, oldest, moreFailed, repeatingCount, repeatingGroups: grouped.repeating,
    stageWords: stage ? STAGE_WORDS[stage] || 'Stage not recorded' : 'Stage not recorded', stage: stage || null,
    tiles: [
      patterns.ok || grouped.repeating.length ? { n: repeatingCount, label: 'repeating', tone: (patterns.ok && patterns.cameBack.length) || grouped.repeating.some((g) => g.open) ? 'attn' : null } : { n: '?', label: 'repeating', tone: 'unknown' },
      weekTotal != null ? { n: weekTotal, label: 'this week' } : { n: '?', label: 'this week', tone: 'unknown' },
      { n: openShown, label: 'still open among those shown' },
    ],
    canShowOlder: !moreFailed && lastPageSize >= PROBLEMS_PAGE && !!oldest,
    analysis: sourceState(all) === 'ok' ? analysisLines(all.data) : null,
    analysisReason: sourceState(all) === 'ok' ? null : `Can’t tell the all-time counts: ${reasonOf(all)}.`,
  };
}

export function analysisLines(a) {
  const d = a || {};
  const lines = [
    { label: 'All problems recorded', text: String(d.total ?? 0) },
    { label: 'Cause known automatically', text: String(d.attributed ?? 0) },
    { label: 'Not yet tied to a feature', text: String(d.noFeatureLink ?? 0) },
  ];
  for (const [k, v] of Object.entries(d.byCategory && typeof d.byCategory === 'object' ? d.byCategory : {})) lines.push({ label: categoryWords(k), text: String(v) });
  for (const [k, v] of Object.entries(d.unknownToolchainByAuthor && typeof d.unknownToolchainByAuthor === 'object' ? d.unknownToolchainByAuthor : {})) lines.push({ label: `Tool not recorded (${clean(k, 'label')})`, text: String(v) });
  return lines;
}

export const CAUSE_WORDS = { automatic: 'Spotted from the fix commit', 'one-tap': 'Tagged by hand', inferred: 'Best guess from context' };
export function failureStory(f, now = Date.now()) {
  const lines = [
    { label: 'What', text: `${categoryWords(f.category)}: ${clean(f.summary) || 'no summary recorded'}` },
    { label: 'Status', text: FAILURE_STATUS_WORDS[f.status] || 'Status not recorded' },
  ];
  if (f.detail && typeof f.detail.redacted === 'string' && f.detail.redacted.trim()) lines.push({ label: 'Where', text: clean(f.detail.redacted, 'detail') });
  lines.push({ label: 'Times seen', text: Number(f.occurrenceCount) > 1 ? `${f.occurrenceCount} times` : 'Once' },
    { label: 'First noticed', text: `${ago(f.detectedAt, now) || 'unknown'} (${exactTime(f.detectedAt)})` },
    { label: 'Cause', text: CAUSE_WORDS[f.attribution] || 'Not recorded' });
  return lines;
}
export function patternStory(i, failures, now = Date.now()) {
  const ds = Number(i.distinctSessions) || 0;
  const dc = Number(i.distinctCauseCommits) || 0;
  const behind = (failures || []).filter((f) => Array.isArray(i.supportingFailureIds) && i.supportingFailureIds.includes(f.id));
  return {
    lines: [
      { label: 'What keeps happening', text: clean(i.summary) || 'A repeating problem' },
      { label: 'Status', text: INSIGHT_STATUS_WORDS[i.status] || 'Status not recorded' },
      { label: 'Seen', text: `Across ${plural(ds, 'change')}${dc ? ` (from ${plural(dc, 'separate fix', 'separate fixes')})` : ''}` },
      { label: 'First noticed', text: `${ago(i.discoveredAt, now) || 'unknown'} (${exactTime(i.discoveredAt)})` },
    ],
    behind: behind.map((f) => failureRow(f, now)),
    behindWords: Array.isArray(i.supportingFailureIds) && i.supportingFailureIds.length > behind.length
      ? `${plural(i.supportingFailureIds.length - behind.length, 'more problem')} behind it ${i.supportingFailureIds.length - behind.length === 1 ? 'is' : 'are'} older than the records shown.` : null,
  };
}

// ═══ 3. Checks on my own claims (GET /completion-claim/audit, GET /class-reviews) ═══
export const CLAIMS_PAGE = 20;
export const VERDICT = {
  supported: 'supports', corroborated: 'supports',
  refuted: 'contradicts', 'uncorroborated-contradicted': 'contradicts',
  unverifiable: 'unverified', 'uncorroborated-unknown': 'unverified',
  'not-eligible': 'not-evaluated',
};
export const VERDICT_WORDS = { supports: 'Evidence supports it', contradicts: 'Evidence contradicts it', unverified: 'Couldn’t verify', 'not-evaluated': 'Not evaluated' };
export const ADVISORY = 'Advisory only — nothing was blocked.';
const PREDICATE_WORDS = {
  'session.elapsed-ms': 'how long a session had run', 'session.state': 'what state a session was in', 'commitment.state': 'where a promise stood',
  'guard.state': 'whether a safety check was on', 'pull-request.merged': 'that a pull request was merged', 'pull-request.checks-pass': 'that a pull request’s checks passed',
  'tool-action.completed': 'that something was done', 'capacity.limit': 'a usage limit', 'operator.attributed': 'who asked for something', 'external.fact': 'a fact about the outside world',
};
const ACTION_WORDS = { sent: 'a message was sent', deployed: 'something was deployed', 'handed-off': 'work was handed off', committed: 'a change was committed', pushed: 'a change was pushed', merged: 'a change was merged', restarted: 'something was restarted', fixed: 'something was fixed', other: 'something was done' };
const EVENT_WORDS = {
  'coverage-incomplete': 'Part of a message could not be checked (privacy boundary)',
  'protected-cue-unextracted': 'A claim-like phrase was seen but not extracted',
  't0-settlement': 'A later outcome settled an earlier observation',
};

/** Which bucket an audit record belongs to: a verdict, or a coverage note (events, settlements). */
export function classifyAudit(r) {
  if (!r || typeof r !== 'object') return null;
  if (typeof r.event === 'string') return 'coverage';
  if (r.evaluated === false && !r.verdict) return 'coverage';
  const v = VERDICT[r.verdict];
  if (v) return r.evaluated === false ? 'not-evaluated' : v;
  if (r.evaluated === false) return 'not-evaluated';
  return null;
}
export function claimSentence(r) {
  if (r.predicate && PREDICATE_WORDS[r.predicate]) return `Said ${PREDICATE_WORDS[r.predicate]}`;
  if (r.actionKind && ACTION_WORDS[r.actionKind]) return `Said ${ACTION_WORDS[r.actionKind]}`;
  return 'A claim in one of my messages';
}
const auditTime = (r) => r.observedAt || r.ts || null;

export function buildClaims(res, { limit = CLAIMS_PAGE, now = Date.now() } = {}) {
  const st = sourceState(res);
  if (st === 'off') return { ok: false, off: true, reason: 'Checking my own claims is off on this agent.' };
  if (st === 'failed') return { ok: false, off: false, reason: `Can’t tell how my recent claims held up: ${reasonOf(res)}.` };
  const records = res.data && Array.isArray(res.data.records) ? res.data.records : null;
  if (!records) return { ok: false, off: false, reason: 'Can’t tell how my recent claims held up: the answer had no records.' };
  // The audit file is oldest-first; newest first here, by time when recorded.
  const ordered = records.map((r, i) => ({ r, i })).sort((a, b) => ((Date.parse(auditTime(b.r)) || 0) - (Date.parse(auditTime(a.r)) || 0)) || (b.i - a.i)).map((x) => x.r);
  const observations = [];
  const coverage = [];
  for (const [i, r] of ordered.entries()) {
    const b = classifyAudit(r);
    if (!b) continue;
    const when = ago(auditTime(r), now) || '';
    if (b === 'coverage') coverage.push({ key: `cov:${r.eventUuid || i}`, main: EVENT_WORDS[r.event] || (r.reason ? `Not checked: ${clean(r.reason, 'label')}` : 'A coverage note'), sub: ADVISORY, end: when, tone: 'unknown', record: r });
    else observations.push({ key: `claim:${r.eventUuid || r.claimId || i}`, bucket: b, main: claimSentence(r), sub: `${VERDICT_WORDS[b]} · ${ADVISORY}`, end: when, tone: b === 'contradicts' ? 'bad' : b === 'supports' ? null : 'unknown', record: r });
  }
  const contradicted = observations.filter((o) => o.bucket === 'contradicts').length;
  const n = observations.length;
  const line = n === 0 ? 'No claims checked yet.'
    : contradicted ? `Of the last ${n} observations, ${contradicted} ${contradicted === 1 ? 'contradicts' : 'contradict'} what I said.`
      : 'Recent claim observations: none contradict what I said.';
  return { ok: true, off: false, observations, coverage, contradicted, n, line, canShowMore: records.length >= limit && limit < 500, nextLimit: Math.min(500, limit + CLAIMS_PAGE) };
}
export function claimsUrl(limit = CLAIMS_PAGE) { return `/completion-claim/audit?limit=${limit}`; }
export const CLAIM_KEYS = ['verdict', 'evaluated', 'kind', 'predicate', 'actionKind', 'target', 'reasonCode', 'reason', 'event', 'finalCriticality', 'sourceKind', 'observedAt', 'ts', 'dryRun', 'claimId', 'eventUuid'];

const REVIEW_WORDS = {
  covered: 'Covered by an existing standard', 'needs-upgrade': 'A standard needs an upgrade', 'new-standard-needed': 'A new standard is needed',
  'not-applicable': 'No standard change needed', 'process-gap': 'A gap in how I work', pending: 'Review pending', filled: 'Reviewed', 'dead-lettered': 'Review failed; needs a retry',
};
const LIFECYCLE_WORDS = { open: 'Open', parked: 'Parked for later', resolved: 'Resolved', superseded: 'Combined into another review', reopened: 'Reopened' };
const OUTCOME_WORDS = { proposed: 'Proposed', ratified: 'Approved', shipped: 'Shipped', rejected: 'Declined', deferred: 'Parked', 'expired-unreviewed': 'Went unreviewed', 'no-action': 'Nothing to do' };
export function reviewVerdictWords(r) {
  const s = r.standardReview && r.standardReview.verdict;
  const p = r.processReview && r.processReview.verdict;
  if (!s && !p) return REVIEW_WORDS[r.fillState] || 'Review pending';
  return [s ? REVIEW_WORDS[s] : null, p && p !== 'covered' && p !== 'not-applicable' ? REVIEW_WORDS[p] : null].filter(Boolean).join('; ') || 'Reviewed';
}
export function buildReviews(res, { now = Date.now() } = {}) {
  const st = sourceState(res);
  if (st === 'off') return { ok: false, off: true, reason: 'Reviewing my corrections is off on this agent.' };
  if (st === 'failed') return { ok: false, off: false, reason: `Can’t tell what my correction reviews found: ${reasonOf(res)}.` };
  const records = res.data && Array.isArray(res.data.records) ? res.data.records : null;
  if (!records) return { ok: false, off: false, reason: 'Can’t tell what my correction reviews found: the answer had no records.' };
  const rows = records.filter((r) => r && typeof r.dedupeKey === 'string').sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0)).map((r) => ({
    key: `rev:${r.dedupeKey}`, main: reviewVerdictWords(r),
    sub: `${LIFECYCLE_WORDS[r.reviewLifecycle] || 'Open'}${Number(r.recurrenceCount) > 1 ? ` · seen ${r.recurrenceCount} times` : ''}`,
    end: ago(r.updatedAt, now) || '', tone: r.fillState === 'dead-lettered' ? 'attn' : null, record: r,
  }));
  return { ok: true, off: false, rows, open: Number.isFinite(res.data.open) ? res.data.open : null, last: rows[0] ? rows[0].main : null };
}
export function reviewStory(r) {
  const lines = [
    { label: 'What it found', text: reviewVerdictWords(r) },
    { label: 'Where it stands', text: LIFECYCLE_WORDS[r.reviewLifecycle] || 'Open' },
    { label: 'Standard change', text: OUTCOME_WORDS[r.standardOutcome] || 'Not recorded' },
    { label: 'Process change', text: OUTCOME_WORDS[r.processOutcome] || 'Not recorded' },
  ];
  if (r.rationale) lines.push({ label: 'Why', text: clean(r.rationale, 'recommendation') });
  lines.push({ label: 'Whose correction', text: r.effectiveOrigin === 'operator-attributed' ? 'One you made' : 'One I made of myself' });
  return lines;
}
export const REVIEW_KEYS = ['dedupeKey', 'semanticClassId', 'fillState', 'standardReview', 'processReview', 'confidence', 'reviewLifecycle', 'lifecycleAuthority', 'recurrenceCount', 'attemptCount', 'createdAt', 'updatedAt'];

// ═══ 4. Look up a memory's sources (GET /memory/evidence/by-entity/:id, /memory/entities/by-evidence) ══
export const SOURCE_KINDS = ['feedback', 'commit', 'session', 'document', 'message', 'job-run', 'ledger-entry', 'pattern-entity', 'external-url', 'supersedes-evidence'];
export const LOOKUP_KINDS = [{ key: 'entity', label: 'A memory (what I believe)' }, ...SOURCE_KINDS.map((k) => ({ key: k, label: sourceKindWords(k) }))];
function sourceKindWords(k) {
  return { feedback: 'Feedback', commit: 'A commit', session: 'A session', document: 'A document', message: 'A message', 'job-run': 'A job run', 'ledger-entry': 'A record entry', 'pattern-entity': 'A pattern', 'external-url': 'A web address', 'supersedes-evidence': 'A replaced source' }[k] || k;
}
export const SCOPES = [{ key: 'private', label: 'me' }, { key: 'shared-topic', label: 'people in this topic' }, { key: 'shared-project', label: 'people in this project' }];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the typed id could be. One candidate → no picker; several or none → the picker. */
export function inferLookup(input) {
  const s = String(input || '').trim();
  if (!s) return { candidates: [], ambiguous: false, empty: true };
  let c;
  if (/^fb_[0-9a-z]+$/i.test(s)) c = ['feedback'];
  else if (/^https?:\/\//i.test(s)) c = ['external-url'];
  else if (UUID.test(s)) c = ['entity', 'session'];
  else if (/^[0-9a-f]{12}$/.test(s)) c = ['ledger-entry', 'commit'];
  else if (/^[0-9a-f]{7,40}$/i.test(s)) c = ['commit'];
  else c = [];
  return { candidates: c, ambiguous: c.length !== 1, empty: false, kind: c.length === 1 ? c[0] : null };
}
export function lookupUrl({ id, kind, scope = 'private' }) {
  const sc = SCOPES.some((x) => x.key === scope) ? scope : 'private';
  const s = String(id || '').trim();
  if (kind === 'entity') return `/memory/evidence/by-entity/${encodeURIComponent(s)}?viewerScope=${sc}`;
  return `/memory/entities/by-evidence?kind=${encodeURIComponent(kind)}&sourceId=${encodeURIComponent(s)}&viewerScope=${sc}`;
}
const scopeWords = (scope) => (SCOPES.find((x) => x.key === scope) || SCOPES[0]).label;

export function evidenceRow(ev, now = Date.now()) {
  const what = ev.kind === 'commit' ? `Commit ${clean(ev.sourceId, 'label').slice(0, 12)}` : ev.kind === 'external-url' ? clean(ev.path || ev.sourceId, 'label') : sourceKindWords(ev.kind);
  const lines = ev.path && ev.kind !== 'external-url' ? `${clean(ev.path, 'label')}${Number.isFinite(ev.lineStart) ? `:${ev.lineStart}${Number.isFinite(ev.lineEnd) && ev.lineEnd !== ev.lineStart ? `-${ev.lineEnd}` : ''}` : ''}` : null;
  return {
    key: `ev:${ev.kind}:${ev.sourceId}`, kind: ev.kind, sourceId: ev.sourceId, main: what,
    sub: [ev.note ? clean(ev.note) : null, lines].filter(Boolean).join(' · ') || sourceKindWords(ev.kind),
    end: ago(ev.updatedAt, now) || '', record: ev,
  };
}
/** A lookup answer → rows. 404 on the entity route is "nothing visible" (it never says whether it exists). */
export function buildLookup(res, { kind, scope = 'private', now = Date.now() } = {}) {
  const narrowed = scope !== 'private';
  if (res && res.status === 404 && kind === 'entity') return { ok: true, rows: [], words: narrowed ? `Nothing is visible to ${scopeWords(scope)}.` : 'No memory with that id on this machine.', tone: 'unknown' };
  const st = sourceState(res);
  if (st === 'off') return { ok: false, off: true, reason: 'Memory is off on this agent, so there is nothing to look up.' };
  if (st === 'failed') return { ok: false, off: false, reason: `Can’t tell: ${reasonOf(res)}.` };
  const d = res.data || {};
  if (kind === 'entity') {
    const ev = Array.isArray(d.evidence) ? d.evidence : null;
    if (!ev) return { ok: false, off: false, reason: 'Can’t tell: the answer had no sources.' };
    const rows = ev.map((e) => evidenceRow(e, now));
    return { ok: true, mode: 'sources', rows, tone: rows.length ? null : 'attn',
      words: rows.length ? `Based on ${plural(rows.length, 'source')}, from this machine’s memory.` : narrowed ? `Nothing is visible to ${scopeWords(scope)}.` : 'No sources recorded for this, so I can’t show why.' };
  }
  const ents = Array.isArray(d.entities) ? d.entities : null;
  if (!ents) return { ok: false, off: false, reason: 'Can’t tell: the answer had no memories.' };
  const rows = ents.filter((e) => e && typeof e.id === 'string').map((e) => ({
    key: `ent:${e.id}`, id: e.id, main: clean(e.name) || 'A memory', sub: [clean(e.type, 'label'), clean(e.content).slice(0, 120)].filter(Boolean).join(' · '),
    end: ago(e.lastVerified || e.createdAt, now) || '', record: e,
  }));
  return { ok: true, mode: 'citers', rows, tone: rows.length ? null : 'unknown',
    words: rows.length ? `${plural(rows.length, 'memory', 'memories')} rel${rows.length === 1 ? 'ies' : 'y'} on this source, from this machine’s memory.` : narrowed ? `Nothing is visible to ${scopeWords(scope)}.` : 'Nothing I remember relies on this source.' };
}

// ═══ The page: headline (worst first, coverage stated) and facts ════════════════════
export function insideHeadline({ activity, problems, claims, reviews }) {
  const unread = [];
  if (!activity || (!activity.ok && !activity.off)) unread.push('conversation history');
  if (!problems || (!problems.ok && !problems.off)) unread.push('recurring problems');
  if (!claims || (!claims.ok && !claims.off)) unread.push('claim checks');
  const coverage = unread.length ? `Couldn’t read: ${unread.join(', ')}.` : null;
  const allDown = [activity, problems, claims].every((s) => !s || !s.ok);
  if (allDown && unread.length) return { text: 'Can’t tell how I’m doing inside.', tone: 'muted', sub: coverage };
  if (claims && claims.ok && claims.contradicted) return { text: `${claims.contradicted === 1 ? 'One of my recent claims was' : `${claims.contradicted} of my recent claims were`} contradicted by the evidence.`, tone: 'attn', sub: coverage };
  if (problems && problems.ok && problems.patterns.ok && problems.patterns.cameBack.length) return { text: 'A problem I thought was fixed came back.', tone: 'attn', sub: coverage };
  // "Repeating" is the one count the problems section shows (folded problems seen more than once + confirmed patterns).
  if (problems && problems.ok && (problems.repeatingCount || 0) > 0) return { text: problems.line, tone: 'attn', sub: coverage };
  const offs = [problems && problems.off ? 'Failure watching is off on this agent.' : null].filter(Boolean);
  const bits = [];
  if (problems && problems.ok && problems.patterns.ok && !(problems.repeatingCount || 0)) bits.push('nothing repeating');
  if (claims && claims.ok) bits.push(claims.n ? 'no recent claim contradicted' : null);
  const said = bits.filter(Boolean);
  const text = said.length ? `${said.join(', ').replace(/^./, (c) => c.toUpperCase())}.` : activity && activity.ok ? activity.line : 'Nothing to flag.';
  return { text, tone: unread.length ? 'muted' : 'ok', sub: [coverage, ...offs].filter(Boolean).join(' ') || null };
}

export function insideFacts({ activity, problems, claims, reviews }) {
  const facts = [];
  if (activity && activity.ok) facts.push({ n: activity.n, label: 'recent records', href: '#/settings/inside?s=activity' });
  else if (!activity || !activity.off) facts.push({ n: '?', label: 'recent records', tone: 'unknown' });
  if (problems && problems.ok && (problems.patterns.ok || (problems.repeatingCount || 0) > 0)) facts.push({ n: problems.repeatingCount || 0, label: 'repeating', tone: problems.repeatingCount ? 'attn' : null, href: '#/settings/inside?s=problems' });
  else if (!problems || !problems.off) facts.push({ n: '?', label: 'repeating', tone: 'unknown' });
  if (claims && claims.ok) facts.push({ n: claims.contradicted, label: 'contradicted', tone: claims.contradicted ? 'bad' : null, href: '#/settings/inside?s=claims' });
  else if (!claims || !claims.off) facts.push({ n: '?', label: 'contradicted', tone: 'unknown' });
  if (reviews && reviews.ok) facts.push({ n: reviews.rows.length, label: reviews.rows.length === 1 ? 'class review' : 'class reviews', href: '#/settings/inside?s=claims' });
  return facts.slice(0, 4);
}

/** "This machine only" when the pool has more than one machine (partial, not fine). */
export function machineNote(poolRes) {
  const ms = poolRes && poolRes.ok && poolRes.data && Array.isArray(poolRes.data.machines) ? poolRes.data.machines : [];
  return ms.length > 1 ? 'This machine only: other machines keep their own record.' : null;
}

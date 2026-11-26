/**
 * Native "Proposals" and "How I'm doing inside" reads for the Instar iPhone app
 * (docs/specs/mobile-native-proposals-inside.md).
 *
 *   GET /mobile/proposals — fixes the agent's failure reviewer proposes: what it saw, how often, on which
 *                           machine; how many were dismissed or promoted. Read-only: dismissing stays in the
 *                           console, behind its own trust check.
 *   GET /mobile/inside    — this machine's recent records, repeating problems, checks on its own claims and
 *                           correction reviews, and each online peer's same summary.
 *
 * Read-only. A paired OWNER phone (device-signed; DEVICE_ALLOWLIST lists exactly these two paths, each
 * `ownerOnly`) or the agent's bearer token may read them; anything else gets 403 `owner-phone-required`.
 * Each answer is built from an explicit field allowlist: no proposal, record, session, claim or machine
 * ids, no fingerprints, no signatures, no sample events, no prompts or raw model answers. Free text is
 * cleaned, scrubbed, stripped of file paths and length-capped. It is display-only data, never instructions.
 *
 * The summarizers are pure (unit-tested on both sides of every rule).
 */
import type { Request, Response, Router } from 'express';
import { ownerOrBearer, rowKey, singleFlight, POOL_READ_CACHE_MS } from './mobileCapacityRoutes.js';
import { cleanText } from './mobilePlansPeopleRoutes.js';
import { verifiedEntityName } from '../messaging/shared/channelIdentity.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';

export const MOBILE_PROPOSALS_INSIDE_SCHEMA_VERSION = 1;
export const MAX_PROPOSAL_ROWS = 30;
/** One-way keys a machine lists so a merged count has no duplicates, past the row cap too. */
export const MAX_PROPOSAL_KEYS = 500;
/** How many outstanding proposals a machine shows before the rest queue (the console's "visible 3"). */
export const VISIBLE_PROPOSALS = 3;
export const ACTIVITY_WINDOW = 40;
export const MAX_ACTIVITY_ROWS = 30;
export const MAX_PROBLEM_ROWS = 10;
export const CLAIMS_WINDOW = 20;
export const MAX_REVIEW_ROWS = 10;

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});
const arr = (v: unknown): Rec[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object' && !Array.isArray(x)) as Rec[] : []);
const ts = (v: unknown): number => { const t = typeof v === 'number' ? v : Date.parse(String(v ?? '')); return Number.isFinite(t) && t > 0 ? t : 0; };
const iso = (t: number): string | null => (t > 0 ? new Date(t).toISOString() : null);
const count = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0; };
const plural = (n: number, one: string, many?: string): string => `${n} ${n === 1 ? one : (many ?? `${one}s`)}`;
const fixed = (v: unknown, known: Set<string>, fallback: string): string => (typeof v === 'string' && known.has(v) ? v : fallback);

const PATH_RE = /(^|[\s("'`=:,;[{<])(file:\/\/\S+|~\/\S+|\/(?:Users|home|private|var|tmp|opt|etc|Volumes|root|srv|mnt|media|Applications|Library|System|usr|bin|sbin|lib|dev|proc|sys|run)\/\S+|[A-Za-z]:\\\S+)/g;
/** Free text for the phone: cleaned, scrubbed, capped, with absolute and home file paths replaced by words (best effort; repo-relative names stay). */
export function freeText(v: unknown, max: number): string | null {
  const s = cleanText(v, max * 2);
  if (!s) return null;
  return cleanText(s.replace(PATH_RE, '$1[a file]'), max);
}

export interface Unread { count: number; names: string[] }
function machineName(id: string, nicknameOf: (id: string) => string | null): string | null {
  return cleanText(verifiedEntityName(id, nicknameOf(id)), 60);
}
function namesOf(ids: string[], nicknameOf: (id: string) => string | null): Unread {
  return { count: ids.length, names: ids.map((id) => machineName(id, nicknameOf)).filter((n): n is string => !!n) };
}

/** One read: its data, the feature absent on this machine, or a failed read. */
export type Source = { state: 'ok'; data: unknown } | { state: 'off' | 'unavailable' };
/** One online peer's `?scope=local` answer, or not answering. */
export type PeerAnswer = { machineId: string; state: 'ok'; data: unknown } | { machineId: string; state: 'unreached' };
/** `peersRead: false` = the machine list or the fan-out itself failed, so which machines exist is unknown. */
export interface MergeOpts { nicknameOf: (id: string) => string | null; offlineMachineIds?: string[]; peersRead?: boolean }

// ── proposals ───────────────────────────────────────────────────────────────

export interface MobileProposal {
  key: string; summary: string; hypothesis: string | null; code: string | null;
  occurrences: number; restarts: number; generatedAt: string | null; queued: boolean; machine: string | null;
}

function proposalRow(p: Rec, queued: boolean): MobileProposal {
  return {
    key: rowKey('proposal', String(p.proposalId ?? '')),
    summary: freeText(p.llmSummary, 400) ?? 'No summary was written for this proposal.',
    hypothesis: freeText(p.hypothesis, 400),
    code: freeText(p.suggestedErrorCode, 80),
    occurrences: count(p.occurrencesObserved), restarts: count(p.processLifetimes),
    generatedAt: iso(ts(p.generatedAt)), queued, machine: null,
  };
}

/** This machine's summary (also the `?scope=local` answer a peer reads). */
export function summarizeLocalProposals(self: Source): Rec {
  if (self.state !== 'ok' || !Array.isArray(self.data)) return { selfState: 'unavailable', outstanding: null, rows: [], truncated: false, dismissed: null, promoted: null };
  const all = arr(self.data).filter((p) => typeof p.proposalId === 'string');
  if (self.data.length > 0 && all.length === 0) return { selfState: 'unavailable', outstanding: null, rows: [], truncated: false, dismissed: null, promoted: null };
  // Newest first, once each: the same id can sit in two proposal directories on one machine.
  const ids = new Set<unknown>();
  const outstanding = all.filter((p) => p.status === 'outstanding').sort((a, b) => ts(b.generatedAt) - ts(a.generatedAt)).filter((p) => !ids.has(p.proposalId) && !!ids.add(p.proposalId));
  const rows = outstanding.map((p, i) => proposalRow(p, i >= VISIBLE_PROPOSALS));
  return {
    selfState: 'ok', outstanding: rows.length, allKeys: rows.map((r) => r.key).slice(0, MAX_PROPOSAL_KEYS), rows: rows.slice(0, MAX_PROPOSAL_ROWS), truncated: rows.length > MAX_PROPOSAL_ROWS,
    dismissed: all.filter((p) => p.status === 'dismissed').length,
    promoted: all.filter((p) => p.status === 'promoted').length,
  };
}

/** A peer's answer counts only with its own counts in place. */
export function isProposalsAnswer(d: Rec): boolean {
  if (d.schemaVersion !== MOBILE_PROPOSALS_INSIDE_SCHEMA_VERSION || d.selfState !== 'ok' || !Array.isArray(d.rows) || !Array.isArray(d.allKeys)) return false;
  if (![d.outstanding, d.dismissed, d.promoted].every((n) => Number.isInteger(n) && (n as number) >= 0)) return false;
  // The key list must account for the count, up to its cap: a count with no keys proves nothing.
  return d.allKeys.every((k) => typeof k === 'string') && new Set(d.allKeys).size === Math.min(d.outstanding as number, MAX_PROPOSAL_KEYS);
}

function peerProposal(p: Rec, machineId: string, machine: string, i: number): MobileProposal | null {
  const summary = freeText(p.summary, 400);
  if (!summary) return null;
  return {
    key: rowKey('proposal-peer', `${machineId}:${typeof p.key === 'string' ? p.key : i}`), summary,
    hypothesis: freeText(p.hypothesis, 400), code: freeText(p.code, 80),
    occurrences: count(p.occurrences), restarts: count(p.restarts), generatedAt: iso(ts(p.generatedAt)),
    queued: p.queued === true, machine,
  };
}

export function summarizeProposals(self: Source, peers: PeerAnswer[], opts: MergeOpts): Rec {
  const local = summarizeLocalProposals(self);
  const rows = [...(local.rows as MobileProposal[])];
  // The same proposal file can sit on two machines (a proposal's key is stable across them): count it once.
  const seen = new Set(rows.map((r) => r.key));
  const keys = new Set(Array.isArray(local.allKeys) ? local.allKeys as string[] : []);
  let dismissed = count(local.dismissed);
  let promoted = count(local.promoted);
  let extra = Math.max(0, count(local.outstanding) - keys.size);
  let truncated = local.truncated === true;
  let peerOk = false;
  const unreadIds: string[] = [];
  for (const p of peers) {
    const d = p.state === 'ok' ? rec(p.data) : null;
    if (!d || !isProposalsAnswer(d)) { unreadIds.push(p.machineId); continue; }
    peerOk = true;
    const name = machineName(p.machineId, opts.nicknameOf) ?? 'another machine';
    const theirKeys = (d.allKeys as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, MAX_PROPOSAL_KEYS);
    extra += Math.max(0, count(d.outstanding) - theirKeys.length);
    for (const key of theirKeys) keys.add(key);
    arr(d.rows).forEach((x, i) => {
      if (typeof x.key === 'string' && seen.has(x.key)) return;
      if (typeof x.key === 'string') seen.add(x.key);
      const one = peerProposal(x, p.machineId, name, i);
      if (one) rows.push(one);
    });
    dismissed += count(d.dismissed);
    promoted += count(d.promoted);
    if (d.truncated === true) truncated = true;
  }
  rows.sort((a, b) => ts(b.generatedAt) - ts(a.generatedAt));
  const total = keys.size;
  // Past MAX_PROPOSAL_KEYS on a machine the union is a floor, and the answer says so.
  const atLeast = extra > 0;
  const unread = namesOf(unreadIds, opts.nicknameOf);
  const offline = namesOf(opts.offlineMachineIds ?? [], opts.nicknameOf);
  const selfOk = local.selfState === 'ok';
  const peersUnknown = opts.peersRead === false;
  const state = selfOk || peerOk ? 'ok' : 'unavailable';
  const partial = !selfOk || unread.count > 0 || offline.count > 0 || peersUnknown;
  const scope = partial ? ' on the machines that answered' : '';
  const headline = state === 'unavailable' ? "Can't read proposals right now."
    : total ? `${atLeast ? 'At least ' : ''}${plural(total, 'proposed fix', 'proposed fixes')} ${total === 1 ? 'is' : 'are'} waiting${scope}.`
    : `No proposed fixes are waiting${scope}.`;
  return {
    state, selfState: local.selfState, headline, outstanding: state === 'ok' ? total : null, atLeast, rows: rows.slice(0, MAX_PROPOSAL_ROWS),
    truncated: truncated || rows.length > MAX_PROPOSAL_ROWS,
    dismissed: state === 'ok' ? dismissed : null, promoted: state === 'ok' ? promoted : null, unread, offline, peersUnknown,
  };
}

// ── inside ──────────────────────────────────────────────────────────────────

export const KIND_WORDS: Record<string, string> = {
  commitment: 'Commitment', agreement: 'Agreement', 'thread-opened': 'Thread opened', 'thread-closed': 'Thread closed',
  'thread-abandoned': 'Thread marked abandoned', decision: 'Decision', note: 'Note',
};
const WITH_WORDS: Record<string, string> = { user: 'with a person', agent: 'with another agent', self: 'with myself', system: 'with the system' };
const STATUS_WORDS: Record<string, string> = { open: 'Open', resolved: 'Resolved', cancelled: 'Cancelled', expired: 'Expired', stranded: 'Stranded', disputed: 'Disputed' };
const STATUS_UNKNOWN = "Status unknown: later history isn't loaded";
const STATUS_NOT_RECORDED = 'Status not recorded';
const LIFECYCLE_PREFIX = /^(expired|stranded|cancelled|resolved):/;
export const INSIGHT_STATUS_WORDS: Record<string, string> = {
  discovered: 'Just noticed', 'acted-on': 'Being looked into', 'verified-effective': 'Fixed, and it stayed fixed',
  'verified-ineffective': "The fix didn't hold", inconclusive: 'Watched, nothing conclusive', dismissed: 'Set aside',
};
export const VERDICT: Record<string, string> = {
  supported: 'supports', corroborated: 'supports', refuted: 'contradicts', 'uncorroborated-contradicted': 'contradicts',
  unverifiable: 'unverified', 'uncorroborated-unknown': 'unverified', 'not-eligible': 'not-evaluated',
};
export const VERDICT_WORDS: Record<string, string> = { supports: 'Evidence supports it', contradicts: 'Evidence contradicts it', unverified: "Couldn't verify", 'not-evaluated': 'Not evaluated' };
export const PREDICATE_WORDS: Record<string, string> = {
  'session.elapsed-ms': 'how long a session had run', 'session.state': 'what state a session was in', 'commitment.state': 'where a promise stood',
  'guard.state': 'whether a safety check was on', 'pull-request.merged': 'that a pull request was merged', 'pull-request.checks-pass': "that a pull request's checks passed",
  'tool-action.completed': 'that something was done', 'capacity.limit': 'a usage limit', 'operator.attributed': 'who asked for something', 'external.fact': 'a fact about the outside world',
};
export const ACTION_WORDS: Record<string, string> = {
  sent: 'a message was sent', deployed: 'something was deployed', 'handed-off': 'work was handed off', committed: 'a change was committed', pushed: 'a change was pushed', merged: 'a change was merged',
};
const CLAIM_DEFAULT = 'A claim in one of my messages';
export const REVIEW_WORDS: Record<string, string> = {
  covered: 'Covered by an existing standard', 'needs-upgrade': 'A standard needs an upgrade', 'new-standard-needed': 'A new standard is needed',
  'not-applicable': 'No standard change needed', 'process-gap': 'A gap in how I work', pending: 'Review pending', filled: 'Reviewed', 'dead-lettered': 'Review failed; needs a retry',
};
export const REVIEW_LIFECYCLE_WORDS: Record<string, string> = { open: 'Open', parked: 'Parked for later', resolved: 'Resolved', superseded: 'Combined into another review', reopened: 'Reopened' };

const LIFECYCLE_UNKNOWN = 'Status not recorded';

const KNOWN_KIND = new Set(Object.values(KIND_WORDS));
const KNOWN_WITH = new Set(Object.values(WITH_WORDS));
const KNOWN_STATUS = new Set([...Object.values(STATUS_WORDS), STATUS_UNKNOWN, STATUS_NOT_RECORDED]);
const KNOWN_REVIEW = new Set(Object.values(REVIEW_WORDS));
const KNOWN_INSIGHT = new Set(Object.values(INSIGHT_STATUS_WORDS));
const KNOWN_VERDICT = new Set(Object.values(VERDICT_WORDS));
const KNOWN_CLAIM = new Set([CLAIM_DEFAULT, ...Object.values(PREDICATE_WORDS).map((w) => `Said ${w}`), ...Object.values(ACTION_WORDS).map((w) => `Said ${w}`)]);
const KNOWN_REVIEW_LIFECYCLE = new Set([...Object.values(REVIEW_LIFECYCLE_WORDS), LIFECYCLE_UNKNOWN]);
const SECTION_STATES = new Set(['ok', 'off', 'unavailable']);
const TONES = new Set(['bad', 'attn', 'ok', 'unknown']);

/** A commitment's status: a stored non-open status wins; else a later record in the window; else unknown, never "open". */
export function commitmentWords(e: Rec, entries: Rec[]): { words: string; known: boolean; settled: boolean } {
  const c = rec(e.commitment);
  if (typeof c.status === 'string' && c.status !== 'open') {
    const words = STATUS_WORDS[c.status];
    return words ? { words, known: true, settled: true } : { words: STATUS_NOT_RECORDED, known: false, settled: false };
  }
  if (c.resolution) return { words: STATUS_WORDS.resolved, known: true, settled: true };
  let sup: Rec | null = null;
  for (const x of entries) if (x.supersedes === e.id && (!sup || ts(x.t) > ts(sup.t))) sup = x;
  if (sup) {
    const m = typeof sup.subject === 'string' ? LIFECYCLE_PREFIX.exec(sup.subject) : null;
    return { words: STATUS_WORDS[m ? m[1] : 'resolved'], known: true, settled: true };
  }
  return { words: STATUS_UNKNOWN, known: false, settled: false };
}

export interface ActivityRow { key: string; kindWords: string; subject: string; withWords: string | null; statusWords: string | null; overdue: boolean; at: string | null; tone: string | null }

function activityRow(e: Rec, entries: Rec[], now: number): ActivityRow {
  let statusWords: string | null = null;
  let overdue = false;
  let tone: string | null = null;
  if (e.kind === 'commitment') {
    const s = commitmentWords(e, entries);
    const deadline = ts(rec(e.commitment).deadline);
    statusWords = s.words;
    overdue = deadline > 0 && deadline < now && !s.settled;
    tone = overdue || s.words === STATUS_WORDS.expired || s.words === STATUS_WORDS.stranded ? 'attn' : s.known ? null : 'unknown';
  } else if (e.kind === 'thread-abandoned' || (e.kind === 'note' && e.disputes)) tone = 'attn';
  const type = rec(e.counterparty).type;
  return {
    key: rowKey('inside-record', `self:${String(e.id)}`),
    kindWords: KIND_WORDS[String(e.kind)] ?? 'Record',
    subject: freeText(e.subject, 240) ?? 'No subject recorded',
    withWords: typeof type === 'string' ? WITH_WORDS[type] ?? null : null,
    statusWords, overdue, at: iso(ts(e.t)), tone,
  };
}

export function summarizeActivity(self: Source, now: number): Rec {
  if (self.state === 'off') return { state: 'off', line: 'This record is off on this agent.', rows: [], truncated: false };
  const raw = self.state === 'ok' ? rec(self.data).entries : null;
  if (!Array.isArray(raw)) return { state: 'unavailable', line: "Can't tell what my other conversations have been doing.", rows: [], truncated: false };
  const entries = arr(raw).filter((e) => typeof e.id === 'string').sort((a, b) => ts(b.t) - ts(a.t));
  if (raw.length > 0 && entries.length === 0) return { state: 'unavailable', line: "Can't tell what my other conversations have been doing.", rows: [], truncated: false };
  const n = entries.length;
  const kindCount = (k: string) => entries.filter((e) => e.kind === k).length;
  const parts: string[] = [];
  if (kindCount('decision')) parts.push(plural(kindCount('decision'), 'decision'));
  if (kindCount('agreement')) parts.push(plural(kindCount('agreement'), 'agreement'));
  if (kindCount('thread-opened')) parts.push(`${plural(kindCount('thread-opened'), 'thread')} opened`);
  if (kindCount('thread-closed')) parts.push(`${kindCount('thread-closed')} closed`);
  if (kindCount('thread-abandoned')) parts.push(`${kindCount('thread-abandoned')} marked abandoned`);
  const line = n === 0 ? 'Nothing recorded recently.' : `Among the ${n} most recent records: ${parts.length ? parts.join(', ') : 'only notes and commitments'}.`;
  return { state: 'ok', line, rows: entries.slice(0, MAX_ACTIVITY_ROWS).map((e) => activityRow(e, entries, now)), truncated: n > MAX_ACTIVITY_ROWS };
}

/** A non-empty list none of whose elements has `field` is a bad read, not an empty one. */
const allMalformed = (list: unknown[], ...fields: string[]): boolean => list.length > 0 && !arr(list).some((x) => fields.some((f) => typeof x[f] === 'string' || typeof x[f] === 'boolean'));

/** The line for a count of repeating problems; `top` is the first one's cleaned summary. */
export function repeatLine(n: number, top: string | null): string {
  const words = top ?? 'a repeating problem';
  return n === 1 ? `One kind of problem keeps coming back: ${words.replace(/\.$/, '')}.` : `${n} kinds of problem keep coming back; the first: ${words.replace(/\.$/, '')}.`;
}
export function claimLine(shown: number, contradicted: number, checked: number): string {
  return shown === 0 ? 'No claims checked yet.'
    : contradicted ? `Of the last ${shown} observations, ${contradicted} ${contradicted === 1 ? 'contradicts' : 'contradict'} what I said.`
    : checked ? 'Recent claim observations: none contradict what I said.'
    : "Recent claims couldn't be verified either way.";
}

const insightActive = (i: Rec): boolean => i.status !== 'verified-effective' && i.status !== 'dismissed';
const insightCameBack = (i: Rec): boolean => i.status === 'verified-ineffective' || count(i.reopenCount) > 0;

export function summarizeProblems(insights: Source, week: Source): Rec {
  if (insights.state === 'off' || week.state === 'off') return { state: 'off', line: 'Failure watching is off on this agent.', weekTotal: null, repeating: 0, cameBack: 0, rows: [] };
  const rawList = insights.state === 'ok' ? rec(insights.data).insights : null;
  const list = Array.isArray(rawList) && !allMalformed(rawList, 'status') ? arr(rawList).filter((i) => typeof i.status === 'string') : null;
  const total = week.state === 'ok' ? rec(week.data).total : undefined;
  const weekTotal = Number.isInteger(total) && (total as number) >= 0 ? (total as number) : null;
  if (!list) {
    const line = `Can't tell whether anything is repeating.${weekTotal != null ? ` ${plural(weekTotal, 'problem')} recorded this week.` : ''}`;
    return { state: 'unavailable', line, weekTotal, repeating: null, cameBack: null, rows: [] };
  }
  const active = list.filter(insightActive);
  // Settled problems never count: the phone says "came back" only about one still active.
  const cameBack = active.filter(insightCameBack);
  const first = cameBack[0] ?? active[0];
  const line = active.length ? repeatLine(active.length, first ? freeText(first.summary, 200) : null)
    : weekTotal == null ? "Nothing repeating. Can't tell this week's total."
    : weekTotal === 0 ? 'Nothing repeating, and nothing new this week.'
    : `Nothing repeating. ${weekTotal === 1 ? '1 one-off problem' : `${weekTotal} one-off problems`} this week.`;
  const ordered = [...active.filter(insightCameBack), ...active.filter((i) => !insightCameBack(i)), ...list.filter((i) => !insightActive(i))];
  const rows = ordered.slice(0, MAX_PROBLEM_ROWS).map((i) => ({
    key: rowKey('inside-problem', `self:${String(i.id ?? i.summary)}`),
    summary: freeText(i.summary, 280) ?? 'A repeating problem',
    statusWords: INSIGHT_STATUS_WORDS[String(i.status)] ?? 'Status not recorded',
    changes: count(i.distinctSessions), since: iso(ts(i.discoveredAt)),
    tone: !insightActive(i) ? 'unknown' : insightCameBack(i) ? 'attn' : null,
  }));
  return { state: 'ok', line, weekTotal, weekUnread: weekTotal == null, repeating: active.length, cameBack: cameBack.length, rows };
}

function claimBucket(r: Rec): string | null {
  if (typeof r.event === 'string') return null;
  if (r.evaluated === false && !r.verdict) return null;
  if (r.evaluated === false) return 'not-evaluated';
  // A verdict word this version doesn't know is not a pass: it reads as unverified.
  return typeof r.verdict === 'string' ? VERDICT[r.verdict] ?? 'unverified' : null;
}
function claimSentence(r: Rec): string {
  const p = typeof r.predicate === 'string' ? PREDICATE_WORDS[r.predicate] : undefined;
  if (p) return `Said ${p}`;
  const a = typeof r.actionKind === 'string' ? ACTION_WORDS[r.actionKind] : undefined;
  return a ? `Said ${a}` : CLAIM_DEFAULT;
}

export function summarizeClaims(self: Source): Rec {
  if (self.state === 'off') return { state: 'off', line: 'Checking my own claims is off on this agent.', contradicted: 0, checked: 0, rows: [] };
  if (self.state !== 'ok' || !Array.isArray(self.data) || allMalformed(self.data, 'verdict', 'event', 'evaluated')) return { state: 'unavailable', line: "Can't tell how my recent claims held up.", contradicted: null, checked: null, rows: [] };
  const when = (r: Rec) => ts(r.observedAt ?? r.ts);
  const ordered = arr(self.data).map((r, i) => ({ r, i })).sort((a, b) => (when(b.r) - when(a.r)) || (b.i - a.i)).map((x) => x.r);
  const rows = ordered.flatMap((r, i) => {
    const b = claimBucket(r);
    if (!b) return [];
    return [{ key: rowKey('inside-claim', `self:${String(r.eventUuid ?? r.claimId ?? i)}`), sentence: claimSentence(r), verdictWords: VERDICT_WORDS[b], at: iso(when(r)), tone: b === 'contradicts' ? 'bad' : b === 'supports' ? null : 'unknown' }];
  });
  const contradicted = rows.filter((r) => r.tone === 'bad').length;
  const n = rows.length;
  // `checked` counts only observations the evidence settled; "couldn't verify" is never a pass.
  const checked = rows.filter((r) => r.tone !== 'unknown').length;
  return { state: 'ok', line: claimLine(n, contradicted, checked), contradicted, checked, rows };
}

function reviewWords(r: Rec): string {
  const s = rec(r.standardReview).verdict;
  const p = rec(r.processReview).verdict;
  if (!s && !p) return REVIEW_WORDS[String(r.fillState)] ?? 'Review pending';
  const parts = [typeof s === 'string' ? REVIEW_WORDS[s] : null, typeof p === 'string' && p !== 'covered' && p !== 'not-applicable' ? REVIEW_WORDS[p] : null].filter(Boolean);
  return parts.join('; ') || 'Reviewed';
}

export function summarizeReviews(self: Source): Rec {
  if (self.state === 'off') return { state: 'off', open: 0, rows: [] };
  const d = self.state === 'ok' ? rec(self.data) : null;
  if (!d || !Array.isArray(d.records) || nullableCount(d.open) === null || allMalformed(d.records, 'dedupeKey')) return { state: 'unavailable', open: null, rows: [] };
  const rows = arr(d.records).filter((r) => typeof r.dedupeKey === 'string').sort((a, b) => ts(b.updatedAt) - ts(a.updatedAt)).slice(0, MAX_REVIEW_ROWS).map((r) => ({
    key: rowKey('inside-review', `self:${String(r.dedupeKey)}`), words: reviewWords(r),
    lifecycleWords: REVIEW_LIFECYCLE_WORDS[String(r.reviewLifecycle)] ?? LIFECYCLE_UNKNOWN, seen: count(r.recurrenceCount),
    why: freeText(r.rationale, 280), at: iso(ts(r.updatedAt)), tone: r.fillState === 'dead-lettered' ? 'attn' : null,
  }));
  return { state: 'ok', open: d.open, rows };
}

/** The console's page headline, worst first, with what could not be read stated. All clear needs something measured. */
export function insideHeadline(activity: Rec, problems: Rec, claims: Rec, reviews: Rec, machine: string | null = null): { headline: string; tone: string; sub: string | null } {
  // Named ("for Mac Studio"), never "this machine": the phone talks to the agent, not one machine.
  const on = machine ? ` for ${machine}` : '';
  const unread = [
    activity.state === 'unavailable' ? 'conversation history' : null,
    problems.state === 'unavailable' ? 'recurring problems' : null,
    problems.weekUnread === true ? "this week's total" : null,
    claims.state === 'unavailable' ? 'claim checks' : null,
    reviews.state === 'unavailable' ? 'correction reviews' : null,
  ].filter((x): x is string => !!x);
  const sub = unread.length ? `Couldn't read: ${unread.join(', ')}.` : null;
  if ([activity, problems, claims].every((s) => s.state !== 'ok')) {
    if (unread.length) return { headline: "Can't tell how I'm doing inside.", tone: 'unknown', sub };
    if (reviews.state !== 'ok') return { headline: `None of these checks are on${on}.`, tone: 'unknown', sub };
    return { headline: `Only correction reviews are on${on}.`, tone: 'unknown', sub };
  }
  const contradicted = count(claims.contradicted);
  if (claims.state === 'ok' && contradicted) {
    return { headline: `${contradicted === 1 ? 'One of my recent claims was' : `${contradicted} of my recent claims were`} contradicted by the evidence.`, tone: 'bad', sub };
  }
  if (problems.state === 'ok' && count(problems.cameBack)) return { headline: 'A problem I thought was fixed came back.', tone: 'attn', sub };
  if (problems.state === 'ok' && count(problems.repeating)) return { headline: String(problems.line), tone: 'attn', sub };
  const said = [problems.state === 'ok' ? 'nothing repeating' : null, claims.state === 'ok' && count(claims.checked) ? 'no recent claim contradicted' : null].filter(Boolean);
  const text = said.length ? `${said.join(', ').replace(/^./, (c) => c.toUpperCase())}.` : String(activity.line);
  return { headline: text, tone: said.length && !unread.length ? 'ok' : 'unknown', sub };
}

export interface InsideSources { activity: Source; insights: Source; week: Source; claims: Source; reviews: Source }

/** This machine's summary (also the `?scope=local` answer a peer reads). */
export function summarizeLocalInside(src: InsideSources, now: number, selfName: string | null = null): Rec {
  const activity = summarizeActivity(src.activity, now);
  const problems = summarizeProblems(src.insights, src.week);
  const claims = summarizeClaims(src.claims);
  const reviews = summarizeReviews(src.reviews);
  // `machine` names the answering machine for the phone's section title (never "This machine").
  return { ...(selfName ? { machine: selfName } : {}), ...insideHeadline(activity, problems, claims, reviews, selfName), activity, problems, claims, reviews };
}

const SECTION_NAMES = ['activity', 'problems', 'claims', 'reviews'];
const nullableCount = (v: unknown): number | null => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : null);
const sectionState = (v: unknown): string => fixed(v, SECTION_STATES, 'unavailable');
const tone = (v: unknown): string | null => (typeof v === 'string' && TONES.has(v) ? v : null);

const cleanReviewWords = (v: unknown): string => {
  if (typeof v !== 'string') return LIFECYCLE_UNKNOWN;
  if (KNOWN_REVIEW.has(v)) return v;
  return v.split('; ').filter((w) => KNOWN_REVIEW.has(w)).join('; ') || LIFECYCLE_UNKNOWN;
};

/**
 * A peer's already-summarized sections, rebuilt field by field (peer text is untrusted), named by its
 * machine. A section that says `ok` without its counts reads `unavailable`. Every line and the headline
 * are rebuilt here from validated counts and rows: the peer's own sentences are not shown.
 */
export function peerInside(d: Rec, machineId: string, machine: string): Rec {
  const k = (kind: string, r: Rec, i: number) => rowKey(`inside-peer-${kind}`, `${machineId}:${typeof r.key === 'string' ? r.key : i}`);
  const a = rec(d.activity); const p = rec(d.problems); const c = rec(d.claims); const v = rec(d.reviews);
  const activityRows = arr(a.rows).slice(0, MAX_ACTIVITY_ROWS).map((r, i) => ({
    key: k('record', r, i), kindWords: fixed(r.kindWords, KNOWN_KIND, 'Record'), subject: freeText(r.subject, 240) ?? 'No subject recorded',
    withWords: typeof r.withWords === 'string' && KNOWN_WITH.has(r.withWords) ? r.withWords : null,
    statusWords: typeof r.statusWords === 'string' && KNOWN_STATUS.has(r.statusWords) ? r.statusWords : null,
    overdue: r.overdue === true, at: iso(ts(r.at)), tone: tone(r.tone),
  }));
  const problemRows = arr(p.rows).slice(0, MAX_PROBLEM_ROWS).map((r, i) => ({
    key: k('problem', r, i), summary: freeText(r.summary, 280) ?? 'A repeating problem', statusWords: fixed(r.statusWords, KNOWN_INSIGHT, 'Status not recorded'),
    changes: count(r.changes), since: iso(ts(r.since)), tone: tone(r.tone),
  }));
  // Tone and the counts come from the validated verdict words (all rows are sent), never from the peer's numbers.
  const claimRows = arr(c.rows).slice(0, CLAIMS_WINDOW).map((r, i) => {
    const verdictWords = fixed(r.verdictWords, KNOWN_VERDICT, VERDICT_WORDS.unverified);
    return {
      key: k('claim', r, i), sentence: fixed(r.sentence, KNOWN_CLAIM, CLAIM_DEFAULT), verdictWords, at: iso(ts(r.at)),
      tone: verdictWords === VERDICT_WORDS.contradicts ? 'bad' : verdictWords === VERDICT_WORDS.supports ? null : 'unknown',
    };
  });
  const repeating = nullableCount(p.repeating); const cameBack = nullableCount(p.cameBack);
  const claimCounts = nullableCount(c.contradicted) !== null && nullableCount(c.checked) !== null;
  const contradicted = claimCounts ? claimRows.filter((r) => r.tone === 'bad').length : null;
  const checked = claimCounts ? claimRows.filter((r) => r.tone !== 'unknown').length : null;
  const weekTotal = nullableCount(p.weekTotal);
  const aState = sectionState(a.state);
  const pState = sectionState(p.state) === 'ok' && (repeating === null || cameBack === null) ? 'unavailable' : sectionState(p.state);
  // Numbers that disagree with the rows mean the two machines don't read each other's words: can't tell.
  const claimsAgree = contradicted === nullableCount(c.contradicted) && checked === nullableCount(c.checked);
  const cState = sectionState(c.state) === 'ok' && (contradicted === null || checked === null || !claimsAgree) ? 'unavailable' : sectionState(c.state);
  const sections = {
    activity: {
      state: aState, truncated: a.truncated === true, rows: activityRows,
      line: aState === 'off' ? 'This record is off on this agent.' : aState !== 'ok' ? `Can't tell what ${machine}'s conversations have been doing.`
        : activityRows.length ? `${plural(activityRows.length, 'recent record')} shown.` : 'Nothing recorded recently.',
    },
    problems: {
      state: pState, weekTotal, weekUnread: pState === 'ok' && weekTotal === null, repeating, cameBack, rows: problemRows,
      line: pState === 'off' ? 'Failure watching is off on this agent.' : pState !== 'ok' ? "Can't tell whether anything is repeating."
        : repeating ? repeatLine(repeating, problemRows[0]?.summary ?? null) : 'Nothing repeating.',
    },
    claims: {
      state: cState, contradicted, checked, rows: claimRows,
      line: cState === 'off' ? 'Checking my own claims is off on this agent.' : cState !== 'ok' ? "Can't tell how recent claims held up."
        : claimLine(claimRows.length, contradicted ?? 0, checked ?? 0),
    },
    reviews: {
      state: sectionState(v.state) === 'ok' && nullableCount(v.open) === null ? 'unavailable' : sectionState(v.state), open: nullableCount(v.open),
      rows: arr(v.rows).slice(0, MAX_REVIEW_ROWS).map((r, i) => ({
        key: k('review', r, i), words: cleanReviewWords(r.words), lifecycleWords: fixed(r.lifecycleWords, KNOWN_REVIEW_LIFECYCLE, LIFECYCLE_UNKNOWN),
        seen: count(r.seen), why: freeText(r.why, 280), at: iso(ts(r.at)), tone: tone(r.tone),
      })),
    },
  };
  return { machine, ...insideHeadline(sections.activity, sections.problems, sections.claims, sections.reviews, machine), ...sections };
}

/** Every `ok` section also has its counts (an answer that fails this still shows, those sections unavailable, and is reported). */
export function isCompleteInsideAnswer(d: Rec): boolean {
  if (!isInsideAnswer(d)) return false;
  const need = (name: string, fields: string[]) => rec(d[name]).state !== 'ok' || fields.every((f) => nullableCount(rec(d[name])[f]) !== null);
  return need('problems', ['repeating', 'cameBack']) && need('claims', ['contradicted', 'checked']) && need('reviews', ['open']);
}

const hasSection = (d: Rec, name: string): boolean => {
  const s = rec(d[name]);
  return SECTION_STATES.has(String(s.state)) && Array.isArray(s.rows);
};
/** A peer answer counts only when all four sections are there in the expected shape. */
export function isInsideAnswer(d: Rec): boolean {
  return d.schemaVersion === MOBILE_PROPOSALS_INSIDE_SCHEMA_VERSION && SECTION_NAMES.every((n) => hasSection(d, n));
}

const TONE_RANK: Record<string, number> = { bad: 3, attn: 2, unknown: 1, ok: 0 };
export function summarizeInside(self: Rec, peers: PeerAnswer[], opts: MergeOpts): Rec {
  const machines: Rec[] = [];
  const unreadIds: string[] = [];
  for (const p of peers) {
    const d = p.state === 'ok' ? rec(p.data) : null;
    if (!d || !isInsideAnswer(d)) { unreadIds.push(p.machineId); continue; }
    machines.push(peerInside(d, p.machineId, machineName(p.machineId, opts.nicknameOf) ?? 'another machine'));
  }
  const unread = namesOf(unreadIds, opts.nicknameOf);
  const offline = namesOf(opts.offlineMachineIds ?? [], opts.nicknameOf);
  const peersUnknown = opts.peersRead === false;
  const peerGap = machines.some((m) => rec(m.problems).weekUnread === true || SECTION_NAMES.some((n) => rec(m[n]).state === 'unavailable'));
  const partial = unread.count > 0 || offline.count > 0 || peersUnknown || peerGap;
  // The worst machine leads; a peer's headline says which machine it is about.
  const rank = (m: Rec) => TONE_RANK[String(m.tone)] ?? 1;
  let lead: Rec = self;
  for (const m of machines) if (rank(m) > rank(lead) && rank(m) >= 2) lead = m;
  const words = lead === self ? String(self.headline) : `${String(lead.machine)}: ${String(lead.headline)}`;
  // A machine nobody could read keeps an all-clear from being all clear.
  const worst = Math.max(rank(self), ...machines.map(rank), partial ? 1 : 0);
  const tone = worst >= 2 ? String(lead.tone) : worst === 1 ? 'unknown' : 'ok';
  return { headline: partial ? `${words.replace(/\.$/, '')} (on the machines that answered).` : words, tone, self, peers: machines, unread, offline, peersUnknown };
}

// ── routes ──────────────────────────────────────────────────────────────────

export interface MobileProposalsInsideDeps {
  /** This machine's persisted proposals, every status. */
  proposals: () => Promise<Source> | Source;
  peerProposals: () => Promise<PeerAnswer[]>;
  /** `sharedStateLedger.recent({ limit })` as `{ entries }`, or off. */
  activity: () => Promise<Source> | Source;
  /** `failureLedger.listInsights` as `{ insights }`, or off. */
  insights: () => Promise<Source> | Source;
  /** `failureLedger.analyze({ sinceMs: 7 days })`, or off. */
  week: () => Promise<Source> | Source;
  /** `completionClaimVerifier.readAudit(limit)` (the array), or off. */
  claims: () => Promise<Source> | Source;
  /** `classReviewStore` as `{ records, open }`, or off. */
  reviews: () => Promise<Source> | Source;
  peerInside: () => Promise<PeerAnswer[]>;
  offlineMachineIds?: () => string[];
  nicknameOf: (machineId: string) => string | null;
  /** The answering machine's verified name, or null. */
  selfName?: () => string | null;
  bearerOk: (req: Request) => boolean;
  now?: () => number;
}

function reportReadFailure(route: string, err: unknown): void {
  try {
    DegradationReporter.getInstance().report({
      feature: 'MobileProposalsInside.read',
      primary: `${route} answers the phone's native screen`,
      fallback: 'the phone shows "can\'t tell" for that part and the owner can retry or open the console',
      reason: err instanceof Error ? err.name : 'unknown error',
      impact: 'The owner\'s phone cannot show this part until the read succeeds.',
    });
  } catch { /* @silent-fallback-ok — reporting must never turn a 500 into a crash */ }
}

/** One source of an answer; a throw is reported and becomes `fallback` (never a 500 for the whole answer). */
async function safe<T>(route: string, f: () => Promise<T> | T, fallback: T): Promise<T> {
  try { return await f(); } catch (err) { reportReadFailure(route, err); return fallback; } // @silent-fallback-ok — not silent: recorded through reportReadFailure (DegradationReporter); the answer says the part could not be read
}

export function mountMobileProposalsInsideRoutes(router: Router, deps: MobileProposalsInsideDeps): void {
  const now = () => (deps.now ? deps.now() : Date.now());
  const cached = singleFlight<Rec>(POOL_READ_CACHE_MS, now);
  const guard = (req: Request, res: Response): boolean => {
    res.set('Cache-Control', 'no-store');
    if (ownerOrBearer(req, deps.bearerOk)) return true;
    res.status(403).json({ error: 'owner-phone-required', detail: 'Only the owner\'s phone can see proposals and how the agent is doing inside.' });
    return false;
  };
  const head = () => ({ schemaVersion: MOBILE_PROPOSALS_INSIDE_SCHEMA_VERSION, generatedAt: new Date(now()).toISOString() });
  // `?scope=local`: this machine's summary only (how one machine reads another's; never fans out again).
  const isLocal = (req: Request) => req.query.scope === 'local';
  const down: Source = { state: 'unavailable' };
  /** A read that answered but in the wrong shape: as much a failed read as a throw. */
  const wrongShape = (route: string): void => reportReadFailure(route, Object.assign(new Error('wrong shape'), { name: 'WrongShape' }));
  const checkPeers = (route: string, peers: PeerAnswer[], valid: (d: Rec) => boolean): void => {
    for (const p of peers) if (p.state === 'ok' && !valid(rec(p.data))) wrongShape(route);
  };
  /** Peers and offline machines, with whether that read itself worked (a failed read is not "no peers"). */
  const peerRead = async (route: string, f: () => Promise<PeerAnswer[]>): Promise<{ peers: PeerAnswer[]; peersRead: boolean }> => {
    const peers = await safe<PeerAnswer[] | null>(route, f, null);
    return { peers: peers ?? [], peersRead: peers !== null };
  };
  const offlineRead = (): { ids: string[]; ok: boolean } => {
    try { return { ids: deps.offlineMachineIds?.() ?? [], ok: true }; } catch (err) { reportReadFailure('offline machine list', err); return { ids: [], ok: false }; } // @silent-fallback-ok — reported; the answer then says it could not tell which machines exist
  };

  router.get('/mobile/proposals', async (req: Request, res: Response) => {
    if (!guard(req, res)) return;
    const local = isLocal(req);
    try {
      const body = await cached(local ? 'proposals:local' : 'proposals', async () => {
        const [self, read] = await Promise.all([
          safe<Source>('GET /mobile/proposals (this machine)', () => deps.proposals(), down),
          local ? Promise.resolve({ peers: [] as PeerAnswer[], peersRead: true }) : peerRead('GET /mobile/proposals (peers)', deps.peerProposals),
        ]);
        const mine = summarizeLocalProposals(self);
        if (self.state === 'ok' && mine.selfState !== 'ok') wrongShape('GET /mobile/proposals (this machine)');
        if (local) return { ...head(), ...mine };
        checkPeers('GET /mobile/proposals (peers)', read.peers, isProposalsAnswer);
        const off = offlineRead();
        return { ...head(), ...summarizeProposals(self, read.peers, { nicknameOf: deps.nicknameOf, offlineMachineIds: off.ids, peersRead: read.peersRead && off.ok }) };
      });
      res.json(body);
    } catch (err) {
      reportReadFailure('GET /mobile/proposals', err);
      res.status(500).json({ error: 'proposals-unavailable' });
    }
  });

  router.get('/mobile/inside', async (req: Request, res: Response) => {
    if (!guard(req, res)) return;
    const local = isLocal(req);
    try {
      const body = await cached(local ? 'inside:local' : 'inside', async () => {
        const part = (name: string, f: () => Promise<Source> | Source) => safe<Source>(`GET /mobile/inside (${name})`, f, down);
        const [activity, insights, week, claims, reviews, read] = await Promise.all([
          part('records', deps.activity), part('patterns', deps.insights), part('week', deps.week), part('claims', deps.claims), part('reviews', deps.reviews),
          local ? Promise.resolve({ peers: [] as PeerAnswer[], peersRead: true }) : peerRead('GET /mobile/inside (peers)', deps.peerInside),
        ]);
        const self = summarizeLocalInside({ activity, insights, week, claims, reviews }, now(), cleanText(deps.selfName?.() ?? null, 60));
        const sources: Record<string, Source> = { activity, problems: insights, claims, reviews };
        for (const n of SECTION_NAMES) if (sources[n].state === 'ok' && rec(self[n]).state === 'unavailable') wrongShape(`GET /mobile/inside (${n})`);
        if (week.state === 'ok' && rec(self.problems).weekUnread === true) wrongShape('GET /mobile/inside (week)');
        if (local) return { ...head(), ...self };
        checkPeers('GET /mobile/inside (peers)', read.peers, isCompleteInsideAnswer);
        const off = offlineRead();
        return { ...head(), ...summarizeInside(self, read.peers, { nicknameOf: deps.nicknameOf, offlineMachineIds: off.ids, peersRead: read.peersRead && off.ok }) };
      });
      res.json(body);
    } catch (err) {
      reportReadFailure('GET /mobile/inside', err);
      res.status(500).json({ error: 'inside-unavailable' });
    }
  });
}

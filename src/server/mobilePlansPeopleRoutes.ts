/**
 * Native "plans and people" reads for the Instar iPhone app (docs/specs/mobile-native-plans-people.md).
 *
 *   GET /mobile/plans    — projects and initiatives: what needs the owner, what is moving, what is
 *                          idle or finished (this machine's tracker plus each online peer's).
 *   GET /mobile/learned  — what the agent learned about the owner: the learned preferences (the
 *                          session-start block) and the scrubbed corrections it is still watching.
 *   GET /mobile/agents   — other agents (claimed name, pairing state, delivery health) and the
 *                          channel registry's verdicts for this machine.
 *
 * Read-only. A paired OWNER phone (device-signed; DEVICE_ALLOWLIST lists exactly these three paths,
 * each `ownerOnly`) or the agent's bearer token may read them; anything else gets 403
 * `owner-phone-required`. Each answer is a purpose-built trimmed summary of what the web console
 * shows the owner (Plans, What I've learned about you, Other agents), built from an explicit field
 * allowlist: no record ids, paths, links, topic ids, fingerprints, keys, invite material, message
 * bodies, channel evidence text, raw errors or machine ids. Free text is passed through the shared
 * secret scrubber, cleaned of control characters and length-capped.
 *
 * The summarizers are pure (unit-tested on both sides of every rule); the router takes its data from
 * the same server-side reads the console's own routes use.
 */
import type { Request, Response, Router } from 'express';
import { ownerOrBearer, phoneText, rowKey, singleFlight, POOL_READ_CACHE_MS } from './mobileCapacityRoutes.js';
import { verifiedEntityName } from '../messaging/shared/channelIdentity.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';

export const MOBILE_PLANS_PEOPLE_SCHEMA_VERSION = 1;
const DAY = 86_400_000;
/** Touched within this window = moving (the console's MOVING_MS). */
export const MOVING_MS = 7 * DAY;
/** Untouched this long = "older, still open" (the console's STALE_DAYS). */
export const OLDER_MS = 14 * DAY;
export const MAX_PLANS = 200;
export const MAX_FINISHED = 20;
export const MAX_CORRECTIONS = 40;
export const MAX_PREFERENCES = 50;
export const MAX_AGENTS = 100;

type Rec = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});
const arr = (v: unknown): Rec[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object' && !Array.isArray(x)) as Rec[] : []);
const ts = (v: unknown): number => { const t = typeof v === 'number' ? v : Date.parse(String(v ?? '')); return Number.isFinite(t) ? t : 0; };
const iso = (t: number): string | null => (t > 0 ? new Date(t).toISOString() : null);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Display text: control and bidi characters removed (the console's `clean`), then scrubbed and capped. */
export function cleanText(v: unknown, max: number): string | null {
  let s = typeof v === 'string' ? v : '';
  try { s = s.normalize('NFKC'); } catch { /* @silent-fallback-ok — an odd string keeps its original form; it is still scrubbed and capped below */ }
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F‪-‮⁦-⁩]/g, '');
  return phoneText(s, max);
}

/** A machine named by its verified nickname only, or null. */
function machineWord(id: string, nicknameOf: (id: string) => string | null): string | null {
  return cleanText(verifiedEntityName(id, nicknameOf(id)), 60);
}

/** A copy's time for "newest wins": a time further ahead than FUTURE_SKEW_MS is no evidence (0). */
export const FUTURE_SKEW_MS = 5 * 60_000;
const notFuture = (t: number, now: number) => (t > now + FUTURE_SKEW_MS ? 0 : t);

/**
 * Keep one copy per identity (`identityOf`; a record without one is skipped). A peer copy replaces
 * the held one only when it is strictly newer; this machine's copy is offered first, so a tie keeps
 * it, and a time more than FUTURE_SKEW_MS ahead (or a missing one) counts as 0.
 */
function mergeByIdentity(sources: Array<{ items: unknown[]; machineId: string | null }>, identityOf: (r: Rec) => string | null, timeOf: (r: Rec) => number, now: number): Map<string, { r: Rec; machineId: string | null }> {
  const kept = new Map<string, { r: Rec; machineId: string | null }>();
  for (const s of sources) {
    for (const r of arr(s.items)) {
      const k = identityOf(r);
      if (!k) continue;
      const prev = kept.get(k);
      if (!prev || notFuture(timeOf(r), now) > notFuture(timeOf(prev.r), now)) kept.set(k, { r, machineId: s.machineId });
    }
  }
  return kept;
}

/** Machines that did not answer: counted, named only when a verified name exists. */
export interface Unread { count: number; names: string[] }
/** Registered machines the pool does not count as online (not asked): ids, never returned. */
export interface Coverage { now: number; nicknameOf: (id: string) => string | null; offlineMachineIds?: string[]; selfName?: string | null }
function unreadOf(ids: string[], nicknameOf: (id: string) => string | null): Unread {
  const uniq = [...new Set(ids)];
  return { count: uniq.length, names: uniq.map((id) => machineWord(id, nicknameOf)).filter((n): n is string => !!n) };
}

/** This machine's own list read: rows, switched off here, or not readable. */
export type SelfList = { state: 'ok'; items: unknown[] } | { state: 'off' | 'unavailable' };
/** One machine's answer for a list read: rows, switched off there, or did not answer. */
export type PeerList = { machineId: string; state: 'ok'; items: unknown[] } | { machineId: string; state: 'off' | 'unreached' };

// ── plans ─────────────────────────────────────────────────────────────────────

export const OPEN_STATUSES = new Set(['active', 'paused', 'halted', 'awaiting-user']);
export const FINISHED_STATUSES = new Set(['completed', 'archived', 'abandoned']);
const STATUS_WORD: Record<string, string> = { active: 'in progress', paused: 'paused', halted: 'halted', 'awaiting-user': 'waiting on you', completed: 'completed', archived: 'archived', abandoned: 'abandoned' };
export function statusWords(s: unknown): string {
  const k = str(s);
  if (k && STATUS_WORD[k]) return STATUS_WORD[k];
  return k && /^[a-z-]{1,30}$/.test(k) ? k.replace(/-/g, ' ') : 'unknown';
}
const ROUND_WORD: Record<string, string> = { pending: 'not started', ready: 'ready to start', 'in-progress': 'running', 'partially-complete': 'partly done', complete: 'done', 'complete-with-skips': 'done, some skipped', failed: 'failed', regressed: 'slipped back' };
function roundWord(r: Rec): string {
  if (r.haltedAt) return 'stopped';
  const s = str(r.status) ?? 'pending';
  return ROUND_WORD[s] ?? (/^[a-z-]{1,30}$/.test(s) ? s.replace(/-/g, ' ') : 'unknown');
}
const roundDone = (r: Rec) => r.status === 'complete' || r.status === 'complete-with-skips';
function currentRound(p: Rec): number { return arr(p.rounds).findIndex((r) => !roundDone(r)); }

/** The console's projectNeedsOk: an unacknowledged advance, or a first round never launched. */
export function projectNeedsOk(p: Rec): boolean {
  if (FINISHED_STATUSES.has(String(p.status))) return false;
  if ((Number(p.unacknowledgedAdvanceCount) || 0) > 0) return true;
  return currentRound(p) === 0 && !p.firstLaunchAckAt;
}

/** What a plan waits for from the owner (the console's needsYouWords), or null. */
export function needsWords(r: Rec): string | null {
  if (FINISHED_STATUSES.has(String(r.status))) return null;
  if ((str(r.kind) ?? 'task') === 'project' && projectNeedsOk(r)) {
    const cur = currentRound(r);
    return cur === -1 ? 'Waiting for your OK' : `Waiting for your OK on round ${cur + 1}`;
  }
  if (r.needsUser) {
    const why = cleanText(r.needsUserReason, 200);
    return why ? `Waiting on you: ${why}` : 'Waiting on you';
  }
  if (r.status === 'awaiting-user') return 'Waiting on you';
  return null;
}

/** "round 2 of 4 · 3 of 5 pieces merged · running" (the console's projectLine, without its age). */
export function projectLine(p: Rec, children: Rec[]): string {
  const rounds = arr(p.rounds);
  const cur = currentRound(p);
  const bits: string[] = [];
  if (!rounds.length) bits.push('no rounds yet');
  else if (cur === -1) bits.push(`all ${rounds.length} rounds done`);
  else {
    bits.push(`round ${cur + 1} of ${rounds.length}`);
    const ids = Array.isArray(rounds[cur].itemIds) ? (rounds[cur].itemIds as unknown[]) : [];
    const byId = new Map(children.map((c) => [String(c.id), c]));
    const merged = ids.filter((id) => byId.get(String(id))?.pipelineStage === 'merged').length;
    if (ids.length) bits.push(`${merged} of ${ids.length} ${ids.length === 1 ? 'piece' : 'pieces'} merged`);
    const w = roundWord(rounds[cur]);
    if (w !== 'not started') bits.push(w);
  }
  if (projectNeedsOk(p)) bits.push('waiting for your OK');
  else if (p.status === 'paused' || p.status === 'halted') bits.push(statusWords(p.status));
  return bits.join(' · ');
}

/** "step 3 of 5 · from user feedback" (the console's initiativeLine, without its age). */
export function initiativeLine(i: Rec): string {
  const phases = arr(i.phases);
  const bits: string[] = [];
  if (phases.length) {
    const done = phases.filter((ph) => ph.status === 'done').length;
    const step = Math.min(phases.length, (Number(i.currentPhaseIndex) || 0) + 1);
    bits.push(done === phases.length ? `all ${phases.length} steps done` : `step ${step} of ${phases.length}`);
  }
  const need = needsWords(i);
  if (need) bits.push(need.charAt(0).toLowerCase() + need.slice(1));
  else if (i.status === 'paused' || i.status === 'halted') bits.push(statusWords(i.status));
  if (i.feedbackWorkKey) bits.push('from user feedback');
  return bits.join(' · ');
}

export interface MobilePlan {
  key: string; title: string; kind: 'project' | 'initiative'; status: string; statusWords: string;
  line: string; needs: string | null; touchedAt: string | null; fromFeedback: boolean; machine: string | null;
}
type PlanSection = 'needsYou' | 'inFlight' | 'idle' | 'older' | 'finished';

/**
 * Plans across the machines that answered. `self` is this machine's tracker list (null: tracking is
 * off here). The same record id on several machines appears once: the newest-touched copy wins.
 */
export function summarizePlans(self: SelfList, peers: PeerList[], opts: Coverage): Rec {
  const unread = unreadOf(peers.filter((p) => p.state === 'unreached').map((p) => p.machineId), opts.nicknameOf);
  const offline = unreadOf(opts.offlineMachineIds ?? [], opts.nicknameOf);
  const anyPeerOk = peers.some((p) => p.state === 'ok');
  const empty = { counts: { needsYou: 0, inFlight: 0, idle: 0, older: 0, finished: 0 }, sections: { needsYou: [], inFlight: [], idle: [], older: [], finished: [] }, unread, offline, truncated: false };
  if (self.state !== 'ok' && !anyPeerOk) {
    return self.state === 'off' && !peers.some((p) => p.state === 'unreached')
      ? { enabled: false, selfState: 'off', headline: 'Plan tracking is off on this agent.', ...empty }
      : { enabled: true, selfState: self.state, headline: 'Can’t read plans right now.', ...empty };
  }
  // Every record with its source machine (null = this machine); one copy per id within each machine (plans are never merged across machines).
  const sources: Array<{ items: unknown[]; machineId: string | null }> = [{ items: self.state === 'ok' ? self.items : [], machineId: null }, ...peers.filter((p): p is Extract<PeerList, { state: 'ok' }> => p.state === 'ok').map((p) => ({ items: p.items, machineId: p.machineId }))];
  // A plan's time: the newer of lastTouchedAt and updatedAt, with a time far in the future as 0.
  // Used for the merge, the grouping and the shown date alike.
  const touched = (r: Rec) => notFuture(Math.max(ts(r.lastTouchedAt), ts(r.updatedAt)), opts.now);
  // Plan ids are names chosen when a plan is made and nothing replicates plans between machines, so a
  // plan is identified by its machine and id: two machines' plans are never merged or hidden.
  const all = sources.flatMap((s) => [...mergeByIdentity([s], (r) => str(r.id), touched, opts.now).values()]);
  const identity = (r: Rec, machineId: string | null) => `${machineId ?? 'self'}\u0000${String(r.id)}`;
  // Parents and children are resolved inside the machine a record came from.
  const itemsOf = new Map(sources.map((s) => [s.machineId, arr(s.items)]));
  const hasParent = (r: Rec, machineId: string | null) => (itemsOf.get(machineId) ?? []).some((x) => x.id === r.parentProjectId && (str(x.kind) ?? 'task') === 'project');
  const childrenOf = (id: string, machineId: string | null) => (itemsOf.get(machineId) ?? []).filter((x) => x.parentProjectId === id);
  const sections: Record<PlanSection, Array<MobilePlan & { _t: number }>> = { needsYou: [], inFlight: [], idle: [], older: [], finished: [] };
  for (const { r, machineId } of all) {
    // A child of a project on its own machine folds under it (it counts in the project's line).
    if (str(r.parentProjectId) && hasParent(r, machineId)) continue;
    const id = String(r.id);
    const isProject = (str(r.kind) ?? 'task') === 'project';
    const children = isProject ? childrenOf(id, machineId) : [];
    const t = Math.max(touched(r), ...children.map(touched));
    const needs = needsWords(r);
    const row: MobilePlan & { _t: number } = {
      key: rowKey('plan', identity(r, machineId)),
      title: cleanText(verifiedEntityName(id, r.title), 120) ?? (isProject ? 'Project name unavailable' : 'Initiative name unavailable'),
      kind: isProject ? 'project' : 'initiative',
      status: statusWords(r.status) === 'unknown' ? 'unknown' : String(r.status),
      statusWords: statusWords(r.status),
      line: isProject ? projectLine(r, children) : initiativeLine(r),
      needs,
      touchedAt: iso(t),
      fromFeedback: !!r.feedbackWorkKey,
      machine: machineId ? machineWord(machineId, opts.nicknameOf) ?? 'another machine' : null,
      _t: t,
    };
    const status = String(r.status);
    if (FINISHED_STATUSES.has(status)) { sections.finished.push(row); continue; }
    // An open status, or one this server does not know (a newer peer's): grouped as open, never dropped.
    const age = t ? opts.now - t : 0;
    if (age >= OLDER_MS) sections.older.push(row);
    else if (needs) sections.needsYou.push(row);
    else if (age <= MOVING_MS) sections.inFlight.push(row);
    else sections.idle.push(row);
  }
  for (const k of Object.keys(sections) as PlanSection[]) sections[k].sort((a, b) => b._t - a._t || a.title.localeCompare(b.title));
  const counts = { needsYou: sections.needsYou.length, inFlight: sections.inFlight.length, idle: sections.idle.length, older: sections.older.length, finished: sections.finished.length };
  const open = counts.needsYou + counts.inFlight + counts.idle;
  const scope = unread.count || offline.count || self.state !== 'ok' ? ' (on the machines that answered)' : '';
  let headline: string;
  if (open === 0 && counts.older === 0) headline = `No longer plans are running${scope}.`;
  else headline = `${plural(open, 'plan')} in flight${scope}.${counts.needsYou ? ` ${counts.needsYou} ${counts.needsYou === 1 ? 'needs' : 'need'} you.` : ''}`;
  // Caps: finished keeps its newest; the rest share the overall cap in reading order.
  let budget = MAX_PLANS;
  let truncated = counts.finished > MAX_FINISHED;
  const out: Record<PlanSection, MobilePlan[]> = { needsYou: [], inFlight: [], idle: [], older: [], finished: [] };
  for (const k of ['needsYou', 'inFlight', 'idle', 'older', 'finished'] as PlanSection[]) {
    const list = k === 'finished' ? sections[k].slice(0, MAX_FINISHED) : sections[k];
    const take = list.slice(0, Math.max(0, budget));
    if (take.length < list.length) truncated = true;
    budget -= take.length;
    out[k] = take.map(({ _t, ...p }) => p);
  }
  return { enabled: true, selfState: self.state, headline, counts, sections: out, unread, offline, truncated };
}

// ── learned ───────────────────────────────────────────────────────────────────

export const ADVISORY_LINE = 'These are signals I picked up, not instructions you gave. I apply them by default; what you tell me directly, and safety, always win.';
const PREF_LINE = /^-\s+(.+?)\s+\(confidence\s+([0-9.]+),\s+seen\s+(\d+)×\)$/;
export function sureWords(c: number | null): string | null {
  if (c === null || !Number.isFinite(c)) return null;
  if (c >= 0.8) return 'sure';
  if (c >= 0.5) return 'fairly sure';
  return 'not yet sure';
}

/** A part of an answer: read, switched off on this agent, or not readable. */
export type Part = { ok: true; data: unknown } | { ok: false; off: boolean };

/** The session-context block → one item per preference line, in the block's own order. */
export function summarizePreferences(part: Part): Rec {
  if (!part.ok) return part.off
    ? { state: 'off', reason: 'Learning from corrections is off on this agent.', items: [], total: 0, notLoaded: 0, truncated: false }
    : { state: 'unavailable', reason: 'Can’t tell what I’ve learned right now.', items: [], total: 0, notLoaded: 0, truncated: false };
  const d = rec(part.data);
  if (typeof d.block !== 'string' && typeof d.present !== 'boolean') return { state: 'unavailable', reason: 'Can’t tell what I’ve learned: the answer had no preference list.', items: [], total: 0, notLoaded: 0, truncated: false };
  const items: Array<{ key: string; text: string; sureWords: string | null; seenWords: string }> = [];
  if (d.present !== false && typeof d.block === 'string') {
    for (const raw of d.block.split('\n')) {
      const line = raw.trim();
      if (!line.startsWith('- ')) continue;
      const m = PREF_LINE.exec(line);
      const text = cleanText(m ? m[1] : line.slice(2), 280);
      if (!text) continue;
      const c = m ? Number(m[2]) : NaN;
      const seen = m ? Math.max(1, parseInt(m[3], 10) || 1) : 1;
      items.push({ key: rowKey('pref', `${items.length}:${text}`), text, sureWords: sureWords(Number.isFinite(c) ? c : null), seenWords: seen > 1 ? `seen ${seen} times` : 'seen once' });
    }
  }
  const total = typeof d.count === 'number' && Number.isFinite(d.count) ? Math.max(d.count, items.length) : items.length;
  return { state: 'ok', reason: null, items: items.slice(0, MAX_PREFERENCES), total, notLoaded: Math.max(0, total - items.length), truncated: items.length > MAX_PREFERENCES };
}

const KIND_WORDS: Record<string, string> = { 'user-preference': 'How you like things', 'infra-gap': 'Something the tool itself should handle better', noise: 'No clear lesson' };
export function kindWords(kind: unknown): string { return KIND_WORDS[String(kind)] ?? 'A pattern'; }
/** The console's correctionStatusWords. */
export function correctionStatusWords(r: Rec): string {
  const n = typeof r.occurrenceCount === 'number' && Number.isFinite(r.occurrenceCount) ? r.occurrenceCount : 1;
  switch (r.status) {
    case 'open': return n > 1 ? `Seen ${n} times — waiting to see it on other days before I keep it` : 'Seen once — waiting to see if it comes back';
    case 'reopened': return 'Came back after I tried adapting — watching again';
    case 'acted-on': return 'Saved — checking that I stick to it';
    case 'verified': return 'Saved and sticking';
    case 'inconclusive': return 'Watched, but nothing conclusive';
    default: return 'Status not recorded';
  }
}
export const isWatching = (r: Rec) => (r.status === 'open' || r.status === 'reopened') && r.kind !== 'noise';

export interface MobileCorrection { key: string; summary: string; kindWords: string; statusWords: string; at: string | null; reopened: boolean; machine: string | null }

/** Corrections across the machines that answered; merged by record id (newest update wins), newest first. */
export function summarizeCorrections(self: Part, peers: PeerList[], opts: Coverage): Rec {
  const nicknameOf = opts.nicknameOf;
  const unread = unreadOf(peers.filter((p) => p.state === 'unreached').map((p) => p.machineId), nicknameOf);
  const offline = unreadOf(opts.offlineMachineIds ?? [], nicknameOf);
  const okPeers = peers.filter((p): p is Extract<PeerList, { state: 'ok' }> => p.state === 'ok');
  const selfRecords = self.ok ? (Array.isArray(rec(self.data).records) ? (rec(self.data).records as unknown[]) : null) : null;
  if (selfRecords === null && !okPeers.length) {
    const off = !self.ok && self.off;
    // "Off" only when every machine is known to be off: an unanswering or offline machine is unknown.
    const allOff = off && !peers.some((p) => p.state === 'unreached') && offline.count === 0;
    return { state: allOff ? 'off' : 'unavailable', selfState: off ? 'off' : 'unavailable', reason: allOff ? 'Learning from corrections is off on this agent.' : 'Can’t tell which corrections I’m watching right now.', watching: [], earlier: [], shown: 0, unread, offline, truncated: false };
  }
  const when = (r: Rec) => notFuture(Math.max(ts(r.updatedAt), ts(r.detectedAt)), opts.now);
  // Correction ids are `CORR-<machineId>-<seq>` (CorrectionLedger.nextId): unique across machines, so
  // equal ids are copies of one record and merge by id.
  const all = [...mergeByIdentity([{ items: selfRecords ?? [], machineId: null }, ...okPeers.map((p) => ({ items: p.items, machineId: p.machineId }))], (r) => str(r.id), when, opts.now).values()]
    .sort((a, b) => when(b.r) - when(a.r));
  // A source that returned a full page may hold older records not read here.
  const fullPage = (selfRecords?.length ?? 0) >= MAX_CORRECTIONS || okPeers.some((p) => p.items.length >= MAX_CORRECTIONS);
  const rows = all.slice(0, MAX_CORRECTIONS).map(({ r, machineId }) => ({
    watching: isWatching(r),
    row: {
      key: rowKey('correction', String(r.id)),
      summary: cleanText(r.scrubbedSummary, 280) ?? kindWords(r.kind),
      kindWords: kindWords(r.kind),
      statusWords: correctionStatusWords(r),
      at: iso(when(r)),
      reopened: r.status === 'reopened',
      machine: machineId ? machineWord(machineId, nicknameOf) ?? 'another machine' : null,
    } as MobileCorrection,
  }));
  const selfState = selfRecords !== null ? 'ok' : !self.ok && self.off ? 'off' : 'unavailable';
  return {
    state: 'ok', selfState, reason: selfState === 'unavailable' ? `${opts.selfName ? `${opts.selfName}’s` : 'Some'} corrections couldn’t be read; the other machines’ are shown.` : null,
    watching: rows.filter((x) => x.watching).map((x) => x.row),
    earlier: rows.filter((x) => !x.watching).map((x) => x.row),
    shown: rows.length, unread, offline, truncated: all.length > MAX_CORRECTIONS || fullPage,
  };
}

export function summarizeLearned(prefs: Part, corrections: Part, peerCorrections: PeerList[], opts: Coverage): Rec {
  const p = summarizePreferences(prefs);
  const c = summarizeCorrections(corrections, peerCorrections, opts);
  let headline: string;
  if (p.state === 'off' && c.state === 'off') headline = 'Learning from corrections is off on this agent.';
  else if (p.state !== 'ok') headline = 'Can’t tell what I’ve learned about you.';
  else if (p.total === 0) headline = 'Nothing yet — correct me the same way twice and it shows up here.';
  else headline = `I’ve picked up ${p.total === 1 ? '1 thing' : `${p.total} things`} about how you like to work.`;
  return { headline, advisory: ADVISORY_LINE, preferences: p, corrections: c, changeLine: 'To change one, tell me in chat.' };
}

// ── agents ────────────────────────────────────────────────────────────────────

const FP_RE = /^[0-9a-f]{6,64}$/i;
const PAIRING: Record<string, { trust: string; words: string }> = {
  'mutual-verified': { trust: 'paired', words: 'Paired' },
  'identity-verified': { trust: 'paired-elsewhere', words: 'Paired (on another of my machines)' },
  'invite-accepted': { trust: 'unfinished', words: 'Pairing not finished — waiting for the other side to finish' },
  'pending-verification': { trust: 'old-check', words: 'Started with the old word check — pair by invite instead' },
  'verification-failed': { trust: 'blocked', words: 'Blocked (the old word check did not match)' },
};

function agoWords(t: number, now: number): string {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60); if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60); if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}
const forWords = (t: number, now: number) => { const a = agoWords(t, now); return a === 'just now' ? 'since just now' : `for ${a.replace(' ago', '')}`; };

/** One delivery row in words (the console's peerWords, from timestamps, counts and flags only). */
export function healthWords(p: Rec, now: number): { kind: string; words: string; detail: string; tone: 'ok' | 'attn' | 'bad' | 'unknown'; lastHeardAt: string | null } {
  const lastHeard = Math.max(ts(p.lastAckedAt), ts(p.lastInboundAt));
  const queued = Number(p.queuedCount) || 0;
  const pending = Number(p.pendingCount) || 0;
  const asOf = ts(p.connectedAsOf);
  let conn = '';
  if (p.connectedNow === true) conn = `the relay saw it connected${asOf ? ` as of ${agoWords(asOf, now)}` : ''}`;
  else if (p.connectedNow === false) conn = `the relay saw it not connected${asOf ? ` as of ${agoWords(asOf, now)}` : ''}`;
  else if (p.connectedNowReason === 'relay-down') conn = 'I can’t see whether it is connected: my own relay connection is down';
  else if (p.connectedNowReason === 'stale') conn = 'I can’t see whether it is connected: my record is too old to trust';
  else if (p.connectedNowReason === 'no-row') conn = 'I can’t see whether it is connected: the relay has no record of it';
  let kind: string; let words: string; let sub = ''; let tone: 'ok' | 'attn' | 'bad' | 'unknown';
  if (p.dark === true) {
    kind = 'dark'; tone = 'bad';
    words = `Nothing back ${ts(p.darkSince) ? forWords(ts(p.darkSince), now) : 'for a long while'}`;
    sub = `${queued ? `${plural(queued, 'message')} waiting unanswered; ` : ''}it may be offline, or listening at another address — my ledger can’t tell which`;
  } else if (p.stale === true) {
    kind = 'stale'; tone = 'attn'; words = 'Waiting for an acknowledgement';
    sub = `${plural(pending, 'message')} of mine ${pending === 1 ? 'has' : 'have'} gone unacknowledged`;
  } else if (p.lastRelayStatus === 'queued') {
    kind = 'queued'; tone = 'attn'; words = 'Messages waiting at the relay'; sub = 'it looks offline; the relay holds my message for it until it returns';
  } else if (p.lastRelayStatus === 'unconfirmed') {
    kind = 'unconfirmed'; tone = 'unknown'; words = 'Last message unconfirmed'; sub = 'the relay gave no verdict: not known lost, not known delivered';
  } else if (p.lastRelayStatus === 'rejected') {
    kind = 'rejected'; tone = 'attn'; words = 'The relay refused my last message'; sub = 'a later resend may work; the message is tracked as failed';
  } else if (lastHeard) {
    kind = 'answered'; tone = 'ok'; words = `Answered ${agoWords(lastHeard, now)}`;
    sub = pending ? `${plural(pending, 'message')} still awaiting its acknowledgement` : '';
  } else if (ts(p.lastSentAt)) {
    kind = 'sent'; tone = pending ? 'attn' : 'ok'; words = `Sent ${agoWords(ts(p.lastSentAt), now)}, nothing back yet`;
  } else {
    kind = 'quiet'; tone = 'ok'; words = 'No messages exchanged yet';
  }
  return { kind, words, detail: [sub, conn].filter(Boolean).join('; '), tone, lastHeardAt: iso(lastHeard) };
}

const CHANNEL_NAMES: Record<string, string> = {
  'threadline-relay': 'Agent network relay', 'a2a-telegram': 'Agent messages through Telegram', 'mutual-ssh': 'Machine-to-machine SSH', 'peer-http': 'Direct peer HTTP',
  'user-telegram': 'Telegram', 'user-slack': 'Slack', 'user-whatsapp': 'WhatsApp', 'user-imessage': 'iMessage',
};
const CHANNEL_STATE: Record<string, { words: string; tone: 'ok' | 'attn' | 'bad' | 'unknown' | 'off' }> = {
  working: { words: 'Working', tone: 'ok' },
  broken: { words: 'Broken', tone: 'bad' },
  'half-built': { words: 'Only partly built', tone: 'attn' },
  'reachable-no-credential': { words: 'Reachable, but I hold no key for it', tone: 'attn' },
  'not-configured': { words: 'Not set up here', tone: 'off' },
  unknown: { words: 'Can’t tell', tone: 'unknown' },
};
const DIRECTION_WORDS: Record<string, string> = { bidirectional: 'sends and receives', 'send-only': 'sends only', 'receive-only': 'receives only', none: 'carries nothing' };

/** The channel registry's verdicts as fixed words. The registry's free text (detail, purpose, cost) is never returned. */
export function summarizeChannels(report: unknown): Rec {
  const r = rec(report);
  if (!Array.isArray(r.channels) || (r.channels.length === 0 && typeof r.error === 'string')) {
    return { channelsState: 'unavailable', channels: [], channelSummary: { total: 0, working: 0, unusable: 0, unknown: 0 } };
  }
  const channels = arr(r.channels).map((c) => {
    const id = str(c.id) ?? '';
    const known = Object.prototype.hasOwnProperty.call(CHANNEL_NAMES, id);
    const st = CHANNEL_STATE[String(c.state)] ?? CHANNEL_STATE.unknown;
    return {
      key: known ? id : rowKey('channel', id),
      name: known ? CHANNEL_NAMES[id] : 'Another channel',
      audience: c.audience === 'user' ? 'you' : 'agents',
      state: CHANNEL_STATE[String(c.state)] ? String(c.state) : 'unknown',
      stateWords: st.words,
      directionWords: DIRECTION_WORDS[String(c.direction)] ?? null,
      tone: st.tone,
    };
  });
  const s = rec(r.summary);
  const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return {
    channelsState: 'ok', channels,
    channelSummary: { total: n(s.total, channels.length), working: n(s.working, channels.filter((c) => c.state === 'working').length), unusable: n(s.unusable, 0), unknown: n(s.unknown, channels.filter((c) => c.state === 'unknown').length) },
  };
}

/** A list read with machines that did not answer (ids; never returned). */
export type PoolRows = { state: 'ok'; rows: unknown[]; failedMachineIds: string[] } | { state: 'off' | 'unavailable'; failedMachineIds?: string[] };

export interface MobileAgent { key: string; name: string; trust: string; trustWords: string; health: string; healthWords: string; healthDetail: string; tone: 'ok' | 'attn' | 'bad' | 'unknown'; lastHeardAt: string | null }

/** One row per peer fingerprint from pairings and delivery health (the console's buildAgents, without conversations). */
export function summarizeAgents(pairings: PoolRows, delivery: PoolRows, channelReport: unknown, opts: { now: number; nicknameOf: (id: string) => string | null }): Rec {
  type Acc = { fp: string; names: string[]; pairing: Rec | null; health: Rec | null };
  const byFp = new Map<string, Acc>();
  const touch = (fpRaw: unknown, name: unknown): Acc | null => {
    const fp = typeof fpRaw === 'string' ? fpRaw.toLowerCase() : '';
    if (!FP_RE.test(fp)) return null;
    const a = byFp.get(fp) ?? { fp, names: [], pairing: null, health: null };
    const n = cleanText(verifiedEntityName(fp, name), 80);
    if (n && !a.names.includes(n)) a.names.push(n);
    byFp.set(fp, a);
    return a;
  };
  // Across machines: blocked anywhere shows as blocked (a problem is never hidden behind another
  // machine's pairing); then paired here, paired on another machine, unfinished, the old word check.
  // A mutual pairing read from another machine (`remote`) is that machine's: "paired elsewhere" here.
  const located = (p: Rec): Rec => (p.state === 'mutual-verified' && p.remote === true ? { ...p, state: 'identity-verified' } : p);
  const pairRank = (s: unknown) => (s === 'verification-failed' ? 5 : s === 'mutual-verified' ? 4 : s === 'identity-verified' ? 3 : s === 'invite-accepted' ? 2 : s === 'pending-verification' ? 1 : 0);
  if (pairings.state === 'ok') for (const raw of arr(pairings.rows)) {
    const p = located(raw);
    const a = touch(p.peerFp, p.peerName);
    // The highest-ranked pairing state (pairRank) stands for the agent.
    if (a && (!a.pairing || pairRank(p.state) > pairRank(a.pairing.state))) a.pairing = p;
  }
  const heard = (h: Rec) => Math.max(ts(h.lastAckedAt), ts(h.lastInboundAt), ts(h.lastSentAt));
  if (delivery.state === 'ok') for (const h of arr(delivery.rows)) {
    const a = touch(h.peerFp, h.peerName);
    // Across machines the row with the freshest evidence stands for the agent.
    if (a && (!a.health || heard(h) > heard(a.health))) a.health = h;
  }
  const order: Record<string, number> = { bad: 0, attn: 1, unknown: 2, ok: 3 };
  const agents: MobileAgent[] = [...byFp.values()].map((a) => {
    const pw = a.pairing ? PAIRING[String(a.pairing.state)] ?? { trust: 'other', words: 'Pairing state unknown' } : { trust: 'not-paired', words: 'Not paired' };
    const h = a.health ? healthWords(a.health, opts.now) : null;
    const paired = pw.trust === 'paired' || pw.trust === 'paired-elsewhere';
    const noRecord = delivery.state === 'ok';
    const tone: MobileAgent['tone'] = h ? h.tone : noRecord && paired ? 'ok' : 'unknown';
    return {
      key: rowKey('agent', a.fp), name: a.names[0] ?? 'Unnamed agent',
      trust: pw.trust, trustWords: pw.words,
      health: h ? h.kind : 'unknown',
      healthWords: h ? h.words : noRecord ? 'No delivery record yet' : 'Can’t tell if it’s reachable',
      healthDetail: h ? h.detail : '',
      tone: pw.trust === 'unfinished' && tone === 'ok' ? 'attn' : tone,
      lastHeardAt: h ? h.lastHeardAt : null,
    };
  }).sort((x, y) => (order[x.tone] ?? 2) - (order[y.tone] ?? 2)
    || Number(y.trust === 'paired' || y.trust === 'paired-elsewhere') - Number(x.trust === 'paired' || x.trust === 'paired-elsewhere')
    || x.name.localeCompare(y.name));
  const unread = unreadOf([...(pairings.failedMachineIds ?? []), ...(delivery.failedMachineIds ?? [])], opts.nicknameOf);
  const ch = summarizeChannels(channelReport);
  const relay = (ch.channels as Array<{ key: string; state: string }>).find((c) => c.key === 'threadline-relay');
  const dark = agents.filter((a) => a.health === 'dark' && a.name !== 'Unnamed agent');
  let headline: string;
  if (relay && relay.state === 'broken') headline = 'I’m not connected to the agent network right now.';
  else if (dark.length) headline = dark.length === 1 ? `${dark[0].name} hasn’t answered ${dark[0].healthWords.replace(/^Nothing back /, '')}.` : `${dark.length} agents haven’t answered in a while.`;
  else if (agents.length === 0) headline = pairings.state === 'ok' || delivery.state === 'ok' ? 'No other agents yet.' : 'Can’t tell which agents I work with.';
  else if (delivery.state !== 'ok') headline = `${plural(agents.length, 'agent')}; can’t tell whether ${agents.length === 1 ? 'it is' : 'they are'} reachable.`;
  else {
    const reachable = agents.filter((a) => a.tone === 'ok').length;
    headline = reachable === agents.length ? (agents.length === 1 ? `${agents[0].name} is reachable.` : `${agents.length} agents, all reachable.`) : `${plural(agents.length, 'agent')}, ${reachable} answered recently.`;
  }
  const reason = (s: PoolRows['state'], what: string) => (s === 'ok' ? null : s === 'off' ? `${what} is switched off on this agent.` : `Couldn’t read ${what.toLowerCase()} just now.`);
  return {
    headline,
    agents: agents.slice(0, MAX_AGENTS), truncated: agents.length > MAX_AGENTS,
    pairing: { state: pairings.state, reason: reason(pairings.state, 'Pairing') },
    delivery: { state: delivery.state, reason: reason(delivery.state, 'Delivery tracking') },
    ...ch,
    unread,
  };
}

// ── routes ────────────────────────────────────────────────────────────────────

export interface MobilePlansPeopleDeps {
  /** This machine's initiative tracker list (projects included), or null when tracking is off here. */
  initiatives: () => unknown[] | null;
  /** Registered machines the pool does not count as online (not asked): ids, never returned. */
  offlineMachineIds?: () => string[];
  /** Each online peer's `GET /initiatives` (proxied-on-read). */
  peerInitiatives: () => Promise<PeerList[]>;
  /** The `/preferences/session-context` answer. */
  preferences: () => Promise<Part>;
  /** This machine's `GET /corrections?limit=N` answer. */
  corrections: (limit: number) => Part;
  /** Each online peer's `GET /corrections?limit=N`. */
  peerCorrections: (limit: number) => Promise<PeerList[]>;
  /** Pairings across machines (`/threadline/pairing?scope=pool`). */
  pairings: () => Promise<PoolRows>;
  /** Delivery health across machines (`/threadline/peers/health?scope=pool`). */
  delivery: () => Promise<PoolRows>;
  /** The `/channels` report for this machine. */
  channels: () => Promise<unknown>;
  /** Machine id → registry nickname (unverified; the summarizers verify it). */
  /** The answering machine's verified name, or null. */
  selfName?: () => string | null;
  nicknameOf: (machineId: string) => string | null;
  bearerOk: (req: Request) => boolean;
  now?: () => number;
}

function reportReadFailure(route: string, err: unknown): void {
  try {
    DegradationReporter.getInstance().report({
      feature: 'MobilePlansPeople.read',
      primary: `${route} answers the phone's native screen`,
      fallback: 'the phone shows "couldn\'t read" for that part and the owner can retry or open the console',
      reason: err instanceof Error ? err.name : 'unknown error',
      impact: 'The owner\'s phone cannot show this part until the read succeeds.',
    });
  } catch { /* @silent-fallback-ok — reporting must never turn a 500 into a crash */ }
}

/** One source of an answer; a throw is reported and becomes `fallback` (never a 500 for the whole answer). */
async function safe<T>(route: string, f: () => Promise<T> | T, fallback: T): Promise<T> {
  try { return await f(); } catch (err) { reportReadFailure(route, err); return fallback; } // @silent-fallback-ok — not silent: recorded through reportReadFailure (DegradationReporter); the part reads as unavailable
}

export function mountMobilePlansPeopleRoutes(router: Router, deps: MobilePlansPeopleDeps): void {
  const now = () => (deps.now ? deps.now() : Date.now());
  const cached = singleFlight<Rec>(POOL_READ_CACHE_MS, now);
  const guard = (req: Request, res: Response): boolean => {
    res.set('Cache-Control', 'no-store');
    if (ownerOrBearer(req, deps.bearerOk)) return true;
    res.status(403).json({ error: 'owner-phone-required', detail: 'Only the owner\'s phone can see plans, what I learned about you, and other agents.' });
    return false;
  };
  const coverage = (): Coverage => {
    let offlineMachineIds: string[] = [];
    try { offlineMachineIds = deps.offlineMachineIds?.() ?? []; } catch (err) { reportReadFailure('offline machine list', err); }
    return { now: now(), nicknameOf: deps.nicknameOf, offlineMachineIds, selfName: cleanText(deps.selfName?.() ?? null, 60) };
  };
  const head = () => ({ schemaVersion: MOBILE_PLANS_PEOPLE_SCHEMA_VERSION, generatedAt: new Date(now()).toISOString() });

  router.get('/mobile/plans', async (req: Request, res: Response) => {
    if (!guard(req, res)) return;
    try {
      const body = await cached('plans', async () => {
        const self = await safe<SelfList>('GET /mobile/plans (this machine)', () => { const items = deps.initiatives(); return items === null ? { state: 'off' } : { state: 'ok', items }; }, { state: 'unavailable' });
        const peers = await safe('GET /mobile/plans (peers)', () => deps.peerInitiatives(), [] as PeerList[]);
        return { ...head(), ...summarizePlans(self, peers, coverage()) };
      });
      res.json(body);
    } catch (err) {
      reportReadFailure('GET /mobile/plans', err);
      res.status(500).json({ error: 'plans-unavailable' });
    }
  });

  router.get('/mobile/learned', async (req: Request, res: Response) => {
    if (!guard(req, res)) return;
    try {
      const body = await cached('learned', async () => {
        const [prefs, peers] = await Promise.all([
          safe<Part>('GET /mobile/learned (preferences)', () => deps.preferences(), { ok: false, off: false }),
          safe('GET /mobile/learned (peers)', () => deps.peerCorrections(MAX_CORRECTIONS), [] as PeerList[]),
        ]);
        const own = await safe<Part>('GET /mobile/learned (corrections)', () => deps.corrections(MAX_CORRECTIONS), { ok: false, off: false });
        return { ...head(), ...summarizeLearned(prefs, own, peers, coverage()) };
      });
      res.json(body);
    } catch (err) {
      reportReadFailure('GET /mobile/learned', err);
      res.status(500).json({ error: 'learned-unavailable' });
    }
  });

  router.get('/mobile/agents', async (req: Request, res: Response) => {
    if (!guard(req, res)) return;
    try {
      const body = await cached('agents', async () => {
        const [pairings, delivery, channels] = await Promise.all([
          safe<PoolRows>('GET /mobile/agents (pairings)', () => deps.pairings(), { state: 'unavailable' }),
          safe<PoolRows>('GET /mobile/agents (delivery)', () => deps.delivery(), { state: 'unavailable' }),
          safe<unknown>('GET /mobile/agents (channels)', () => deps.channels(), { channels: [], error: 'unavailable' }),
        ]);
        return { ...head(), ...summarizeAgents(pairings, delivery, channels, { now: now(), nicknameOf: deps.nicknameOf }) };
      });
      res.json(body);
    } catch (err) {
      reportReadFailure('GET /mobile/agents', err);
      res.status(500).json({ error: 'agents-unavailable' });
    }
  });
}

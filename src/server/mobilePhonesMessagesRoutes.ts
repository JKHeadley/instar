/**
 * Native "phones and messages" reads for the Instar iPhone app (docs/specs/mobile-native-phones-messages.md).
 *
 *   GET /mobile/messages — whether the agent's replies to the owner are held, grouped by conversation with
 *                          the reason in words; expired and unconfirmed sends; recording readiness; how
 *                          many are held on each other machine that answers.
 *   GET /mobile/insights — each insight page's headline, lines and numbers, from this machine and each
 *                          online peer.
 *
 * Read-only. A paired OWNER phone (device-signed; DEVICE_ALLOWLIST lists exactly these two paths, each
 * `ownerOnly`) or the agent's bearer token may read them; anything else gets 403 `owner-phone-required`.
 * Each answer is a purpose-built trimmed summary of what the console shows the owner, built from an
 * explicit field allowlist: no operation, origin, topic, chat, message, account or machine ids, no
 * payloads, message text, deep links or raw errors. Free text is cleaned, scrubbed and length-capped.
 *
 * The summarizers are pure (unit-tested on both sides of every rule).
 */
import type { Request, Response, Router } from 'express';
import { ownerOrBearer, rowKey, singleFlight, POOL_READ_CACHE_MS } from './mobileCapacityRoutes.js';
import { cleanText } from './mobilePlansPeopleRoutes.js';
import { verifiedEntityName } from '../messaging/shared/channelIdentity.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';
import { ORIGIN_ACTIVATION_OBLIGATIONS } from '../messaging/telegram-origin/OriginActivation.js';

/** The fixed readiness reasons assessOriginActivation itself writes, in words; any other reason is not shown. */
const READINESS_REASON_WORDS: Record<string, string> = {
  'enrollment-observation-missing': 'not checked yet',
  'enrollment-observation-expired': 'last check is out of date',
};

export const MOBILE_PHONES_MESSAGES_SCHEMA_VERSION = 1;
export const MAX_HELD_GROUPS = 50;
export const MAX_NOT_READY = 30;
export const MAX_INSIGHT_PAGES = 40;
export const MAX_INSIGHT_LINES = 5;
export const MAX_INSIGHT_METRICS = 8;
/** Peers read per answer (the same ceiling forwardRevoke uses); any beyond are counted as not answering. */
export const MAX_PEERS = 16;

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});
const arr = (v: unknown): Rec[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object' && !Array.isArray(x)) as Rec[] : []);
const ts = (v: unknown): number => { const t = typeof v === 'number' ? v : Date.parse(String(v ?? '')); return Number.isFinite(t) && t > 0 ? t : 0; };
const iso = (t: number): string | null => (t > 0 ? new Date(t).toISOString() : null);
const count = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0; };
const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

export interface Unread { count: number; names: string[] }
function machineName(id: string, nicknameOf: (id: string) => string | null): string | null {
  return cleanText(verifiedEntityName(id, nicknameOf(id)), 60);
}
function namesOf(ids: string[], nicknameOf: (id: string) => string | null): Unread {
  return { count: ids.length, names: ids.map((id) => machineName(id, nicknameOf)).filter((n): n is string => !!n) };
}

function agoWords(t: number, now: number): string {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60); if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60); if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

// ── messages ──────────────────────────────────────────────────────────────────

/** The console's hold-reason words (dashboard/console/messages-model.js HOLD_WORDS). */
const HOLD_WORDS: Record<string, string> = {
  'lease-not-held': 'waiting to be routed through the machine that holds the conversation',
  'destination-not-authorized': 'addressed outside the chats this agent may write to',
  'origin-display-authority-unavailable': 'waiting for the message-recording service',
  'transport-acceptance-unknown': 'Telegram did not confirm it arrived',
  'capacity-unavailable': 'waiting for room to send',
};
/** Every reason phrase a summary can carry; a peer's group reason outside this set is replaced. */
const KNOWN_REASON_WORDS = new Set([...Object.values(HOLD_WORDS), 'held for another reason', 'held for an unstated reason']);

export function holdWords(reason: unknown): string {
  if (typeof reason !== 'string' || !reason) return 'held for an unstated reason';
  return HOLD_WORDS[reason] ?? 'held for another reason';
}

/** The console's held headline (heldHeadline). */
export function heldHeadline(n: unknown, replies?: unknown, automatic?: unknown, other?: unknown, selfName: string | null = null): string {
  // Named ("held on Mac Studio"), never "on this machine": the phone talks to the agent, not one machine.
  const on = selfName ? ` on ${selfName}` : '';
  if (!isCount(n)) return "Can't tell how many messages are held.";
  if (!n) return 'No messages are held.';
  if (isCount(replies) && isCount(automatic) && isCount(other) && replies + automatic + other === n && (replies || automatic)) {
    const parts = [
      replies ? `${replies} ${replies === 1 ? 'reply' : 'replies'}` : null,
      automatic ? `${automatic} automatic ${automatic === 1 ? 'message' : 'messages'}` : null,
      other ? `${other} other ${other === 1 ? 'message' : 'messages'}` : null,
    ].filter(Boolean);
    return `${parts.join(' and ')} ${n === 1 ? 'is' : 'are'} held${on}.`;
  }
  return `${n} ${n === 1 ? 'message is' : 'messages are'} held${on}.`;
}

/** The no-detail headline from /health heldForward: held FORWARDS only, worded as such. */
export function forwardsHeadline(n: unknown): string {
  if (!isCount(n)) return "Can't tell how many messages are held.";
  if (!n) return "No replies are waiting to be passed on; other held messages can't be read right now.";
  return `${n} ${n === 1 ? 'reply is' : 'replies are'} waiting to be passed to the machine that holds the conversation.`;
}

export interface MobileHeldGroup { key: string; title: string; reasonWords: string; count: number; oldestAt: string | null; machine: string | null }
export interface MobileNotReady { key: string; title: string; detail: string; tone: 'attn' | 'unknown' }

/** This machine's delivery read (`telegramOrigin.deliverySummaryInputs()`), no runtime here, or a failed read. */
export type OriginStatus = { state: 'ok'; data: unknown } | { state: 'off' | 'unavailable' };
/** One online peer's `GET /mobile/messages?scope=local`, or not answering. */
export type PeerMessages = { machineId: string; state: 'ok'; data: unknown } | { machineId: string; state: 'unreached' };

export interface MessagesOpts {
  now: number;
  /** A conversation's name, verified (never a placeholder or an id), or null. */
  topicName: (topicId: string) => string | null;
  nicknameOf: (machineId: string) => string | null;
  /** This machine's /health telegramOrigin.heldForward, used when the detailed read fails. */
  heldForward?: unknown;
  /** The answering machine's verified name, so its lines name it instead of saying "this machine". */
  selfName?: string | null;
  offlineMachineIds?: string[];
}

export const FOOTER_LINE = 'The who-wrote-this footer on messages is changed in the console.';

/** This machine's own summary (also the `?scope=local` answer a peer reads). */
export function summarizeLocalMessages(status: OriginStatus, opts: MessagesOpts): Rec {
  const now = opts.now;
  const s = status.state === 'ok' ? rec(status.data) : null;
  const held = s && Array.isArray(s.held) ? arr(s.held) : null;
  if (!s || !held) {
    const hf = rec(opts.heldForward);
    return {
      state: status.state === 'off' ? 'off' : 'unavailable', heldCount: null,
      headline: forwardsHeadline(hf.count),
      sub: status.state === 'off' ? `Message recording is not running${opts.selfName ? ` on ${opts.selfName}` : ''}.` : "Couldn't read the message records just now.",
      tone: isCount(hf.count) && hf.count > 0 ? 'attn' : 'unknown',
      groups: [], truncated: false, expired: 0, unconfirmedLine: null, recording: null, notReady: [],
    };
  }

  const items = held.map((h) => {
    const destination = rec(h.destination);
    const topic = h.topicId ?? destination.topicId;
    const topicKey = typeof topic === 'string' || typeof topic === 'number' ? String(topic) : null;
    const since = ts(h.heldSince ?? h.since ?? h.createdAt ?? h.updatedAt);
    const name = topicKey ? opts.topicName(topicKey) : null;
    return { topicKey, name: name ? cleanText(name, 80) : null, reasonWords: holdWords(h.hold_reason ?? h.holdReason ?? h.reason), since, producerKind: h.producerKind };
  });
  const byKey = new Map<string, typeof items>();
  for (const it of items) {
    const k = it.topicKey ? `topic:${it.topicKey}` : `cause:${it.reasonWords}`;
    const g = byKey.get(k);
    if (g) g.push(it); else byKey.set(k, [it]);
  }
  const groups: MobileHeldGroup[] = [...byKey.entries()].map(([k, list]) => {
    const oldest = list.reduce((min, x) => (x.since && (!min || x.since < min) ? x.since : min), 0);
    const first = list[0]!;
    const title = first.topicKey ? (first.name ?? 'Conversation name unavailable') : list.length === 1 ? '1 delayed message' : `${list.length} delayed messages`;
    return { key: rowKey('held-group', k), title, reasonWords: first.reasonWords, count: list.length, oldestAt: iso(oldest), machine: null };
  });
  sortGroups(groups);

  const hf = rec(s.heldForward);
  const expired = count(hf.expiredUnreported) + count(rec(s.expiredHolds).totalSinceBoot);
  let headline: string;
  if (held.length) {
    const replies = items.filter((x) => x.producerKind === 'session').length;
    const automatic = items.filter((x) => x.producerKind === 'server-automation').length;
    headline = heldHeadline(held.length, replies, automatic, held.length - replies - automatic, opts.selfName ?? null);
    if (s.heldComplete === false) headline = `At least ${held.length} ${held.length === 1 ? 'message is' : 'messages are'} held${opts.selfName ? ` on ${opts.selfName}` : ''} (more may not be listed).`;
  } else if (s.heldComplete === false) headline = "Some held messages may not be listed: the record couldn't be read in full.";
  else if (expired) headline = `${expired} ${expired === 1 ? 'message' : 'messages'} expired before delivery.`;
  else headline = 'Messages to you';

  const oldestAll = items.reduce((min, x) => (x.since && (!min || x.since < min) ? x.since : min), 0);
  const sub = [
    held.length ? 'I need to restore delivery. This is not a task for you.' : null,
    held.length && oldestAll ? `The oldest has waited ${agoWords(oldestAll, now).replace(' ago', '')}.` : null,
  ].filter(Boolean).join(' ');

  const counts = rec(rec(s.metrics).counts);
  const unknown = count(counts['attempt:outcome-unknown']);
  const accepted = count(counts['attempt:accepted']);
  const unconfirmedLine = unknown && accepted ? `Of ${accepted.toLocaleString('en-US')} sends Telegram confirmed, ${unknown.toLocaleString('en-US')} more ended without a confirmation either way.` : null;

  const act = rec(s.activation);
  const notReadyAll = arr(act.observations).filter((o) => o.state !== 'ready' && o.state !== 'not-applicable');
  // Readiness rows carry only fixed vocabulary: the obligation from ORIGIN_ACTIVATION_OBLIGATIONS, the
  // state, and a reason only when it is one of the known fixed reasons. Subjects and other reason text
  // are free strings and are never returned (the raw route keeps its operator-session gate).
  const notReady: MobileNotReady[] = notReadyAll.slice(0, MAX_NOT_READY).map((o, i) => {
    const state = o.state === 'held' ? 'held' : 'unknown';
    const obligation = typeof o.obligation === 'string' && (ORIGIN_ACTIVATION_OBLIGATIONS as readonly string[]).includes(o.obligation) ? o.obligation : null;
    const reason = typeof o.reason === 'string' ? READINESS_REASON_WORDS[o.reason] ?? null : null;
    return {
      key: rowKey('not-ready', `${i}:${obligation ?? 'other'}`),
      title: obligation ? obligation.replace(/-/g, ' ') : 'Another recording check',
      detail: [state === 'held' ? 'held' : "can't tell yet", reason].filter(Boolean).join(' · '),
      tone: state === 'held' ? 'attn' : 'unknown',
    };
  });

  return {
    state: 'ok', heldCount: held.length, heldComplete: s.heldComplete !== false, headline, sub,
    tone: held.length ? 'attn' : expired ? 'bad' : 'ok',
    groups: groups.slice(0, MAX_HELD_GROUPS), truncated: s.heldComplete === false || notReadyAll.length > MAX_NOT_READY || groups.length > MAX_HELD_GROUPS,
    expired, unconfirmedLine,
    recording: act.complete === true ? 'on' : 'not fully set up',
    notReady,
  };
}

/** Largest first, then the newest oldest-wait first (the console's order). Sorts in place. */
function sortGroups(groups: MobileHeldGroup[]): MobileHeldGroup[] {
  return groups.sort((a, b) => b.count - a.count || ts(b.oldestAt) - ts(a.oldestAt));
}

const MSG_STATES = new Set(['ok', 'off', 'unavailable']);
/** A peer's `?scope=local` summary, re-cleaned (peer text is untrusted), or null when it is not one. */
function peerSummary(data: unknown, machineId: string, machine: string): { state: string; heldCount: number | null; heldComplete: boolean; groups: MobileHeldGroup[]; truncated: boolean } | null {
  const d = rec(data);
  if (!MSG_STATES.has(String(d.state)) || !Array.isArray(d.groups)) return null;
  const groups = arr(d.groups).flatMap((g, i) => {
    const title = cleanText(g.title, 80);
    if (!title || !isCount(g.count) || g.count < 1) return [];
    return [{ key: rowKey('held-group-peer', `${machineId}:${typeof g.key === 'string' ? g.key : i}`), title, reasonWords: typeof g.reasonWords === 'string' && KNOWN_REASON_WORDS.has(g.reasonWords) ? g.reasonWords : 'held for another reason',
      count: g.count, oldestAt: iso(ts(g.oldestAt)), machine }];
  });
  return { state: String(d.state), heldCount: isCount(d.heldCount) ? d.heldCount : null, heldComplete: d.heldComplete !== false, groups, truncated: d.truncated === true };
}

/** The merged answer: this machine's summary plus each online peer's. */
export function summarizeMessages(status: OriginStatus, peers: PeerMessages[], opts: MessagesOpts): Rec {
  const local = summarizeLocalMessages(status, opts);
  const unreadIds: string[] = [];
  const machines: Array<{ name: string; count: number | null; complete: boolean; state: string }> = [{ name: opts.selfName ?? 'Your machine', count: local.heldCount as number | null, complete: local.heldComplete !== false, state: String(local.state) }];
  const groups: MobileHeldGroup[] = [...(local.groups as MobileHeldGroup[])];
  let peerHeld = 0;
  let peerTruncated = false;
  let peerLowerBound = false;
  for (const p of peers) {
    const name = machineName(p.machineId, opts.nicknameOf) ?? 'another machine';
    const sum = p.state === 'ok' ? peerSummary(p.data, p.machineId, name) : null;
    if (!sum) { unreadIds.push(p.machineId); continue; }
    machines.push({ name, count: sum.heldCount, complete: sum.heldComplete, state: sum.state });
    if (sum.heldCount !== null && !sum.heldComplete) peerLowerBound = true;
    groups.push(...sum.groups);
    peerHeld += sum.heldCount ?? 0;
    if (sum.truncated) peerTruncated = true;
  }
  const unread = namesOf(unreadIds, opts.nicknameOf);
  const offline = namesOf(opts.offlineMachineIds ?? [], opts.nicknameOf);
  const sorted = sortGroups(groups);
  let headline = String(local.headline);
  if (peerHeld > 0) {
    // A peer whose held read filled its page reports a lower bound; the subtotal then says "at least".
    const n = `${peerLowerBound ? 'at least ' : ''}${peerHeld}`;
    const more = `${peerLowerBound ? 'At least ' : ''}${peerHeld} ${peerHeld === 1 ? 'message is' : 'messages are'} held on other machines.`;
    // The local sentence and the peer sentence are built apart and joined, so neither fact is lost.
    headline = local.state !== 'ok' ? `${headline.replace(/\.$/, '')}; ${n} ${peerHeld === 1 ? 'is' : 'are'} held on other machines.`
      : headline !== 'Messages to you' ? `${headline.replace(/\.$/, '')}; ${n} more on other machines.` : more;
  }
  // Any machine whose held total is unknown (did not answer, offline, or answered "can't tell") qualifies the counts.
  if (unread.count > 0 || offline.count > 0 || machines.some((m) => m.count === null || (m.state === 'ok' && !m.complete && m.count === 0))) headline = `${headline.replace(/\.$/, '')}. Machines that did not answer or can't tell are not counted.`;
  return {
    ...local,
    headline,
    tone: local.tone === 'ok' && peerHeld > 0 ? 'attn' : local.tone,
    groups: sorted.slice(0, MAX_HELD_GROUPS),
    truncated: local.truncated === true || peerTruncated || sorted.length > MAX_HELD_GROUPS,
    machines, unread, offline, footerLine: FOOTER_LINE,
  };
}

// ── insights ──────────────────────────────────────────────────────────────────

export interface MobileInsightPage {
  key: string; title: string; headline: string; sourceWords: string; asOf: string | null; stale: boolean;
  lines: Array<{ text: string; severity: 'info' | 'watch' | 'alert'; action: string | null }>;
  metrics: Array<{ label: string; value: string; trend: 'up' | 'down' | 'flat' | null }>;
  machine: string | null;
}

export function sourceWords(source: unknown, cacheHit: unknown): string {
  switch (source) {
    case 'llm': return cacheHit === true ? 'AI summary, saved' : 'AI summary';
    case 'deterministic': return 'Plain summary';
    case 'paused': return "Paused: this page's data couldn't be read";
    case 'empty': return 'No data yet';
    default: return 'Summary';
  }
}

/** This machine's engine answer (`getAll({ cachedOnly: true })`), the engine absent here, or a failed read. */
export type InsightsSelf = { state: 'ok'; data: unknown } | { state: 'off' | 'unavailable' };
/** One online peer's `GET /mobile/insights?scope=local`, or not answering. */
export type PeerInsights = { machineId: string; state: 'ok'; data: unknown } | { machineId: string; state: 'unreached' };

function lineRows(v: unknown): MobileInsightPage['lines'] {
  return arr(v).slice(0, MAX_INSIGHT_LINES).flatMap((l) => {
    const text = cleanText(l.text, 280);
    if (!text) return [];
    const severity: 'info' | 'watch' | 'alert' = l.severity === 'alert' || l.severity === 'watch' ? l.severity : 'info';
    return [{ text, severity, action: cleanText(l.action, 200) }];
  });
}
function metricRows(v: unknown): MobileInsightPage['metrics'] {
  return arr(v).slice(0, MAX_INSIGHT_METRICS).flatMap((m) => {
    const label = cleanText(m.label, 80);
    const value = cleanText(typeof m.value === 'number' ? String(m.value) : m.value, 40);
    if (!label || !value) return [];
    const trend: 'up' | 'down' | 'flat' | null = m.trend === 'up' || m.trend === 'down' || m.trend === 'flat' ? m.trend : null;
    return [{ label, value, trend }];
  });
}

/** One engine page (PageInsight) as the phone's row. */
function enginePage(p: Rec): MobileInsightPage | null {
  const title = cleanText(p.title, 80);
  const headline = cleanText(p.headline, 280);
  if (!title || !headline) return null;
  return {
    key: rowKey('insight', `self:${typeof p.page === 'string' ? p.page : title}`), title, headline,
    sourceWords: sourceWords(p.source, p.cacheHit), asOf: iso(ts(p.asOf)), stale: p.stale === true,
    lines: lineRows(p.lines), metrics: metricRows(p.metrics), machine: null,
  };
}

/** A peer's already-summarized page, re-cleaned (peer text is untrusted) and named by its machine. */
function peerPage(p: Rec, machineId: string, machine: string, i: number): MobileInsightPage | null {
  const title = cleanText(p.title, 80);
  const headline = cleanText(p.headline, 280);
  if (!title || !headline) return null;
  return {
    key: rowKey('insight-peer', `${machineId}:${typeof p.key === 'string' ? p.key : i}`), title, headline,
    sourceWords: cleanText(p.sourceWords, 60) ?? 'Summary', asOf: iso(ts(p.asOf)), stale: p.stale === true,
    lines: lineRows(p.lines), metrics: metricRows(p.metrics), machine,
  };
}

const INSIGHT_STATES = new Set(['ok', 'off', 'unavailable']);
export function summarizeInsights(self: InsightsSelf, peers: PeerInsights[], opts: { nicknameOf: (id: string) => string | null; offlineMachineIds?: string[] }): Rec {
  const pages: MobileInsightPage[] = [];
  if (self.state === 'ok') for (const p of arr(rec(self.data).pages)) { const one = enginePage(p); if (one) pages.push(one); }
  const unreadIds: string[] = [];
  let peerOk = false;
  let peerOffAll = true;
  let peerTruncated = false;
  for (const p of peers) {
    const d = p.state === 'ok' ? rec(p.data) : null;
    const st = d ? String(d.selfState) : '';
    if (!d || !INSIGHT_STATES.has(st) || st === 'unavailable' || !Array.isArray(d.pages)) { unreadIds.push(p.machineId); peerOffAll = false; continue; }
    if (st === 'off') continue;
    peerOk = true; peerOffAll = false;
    const name = machineName(p.machineId, opts.nicknameOf) ?? 'another machine';
    arr(d.pages).forEach((x, i) => { const one = peerPage(x, p.machineId, name, i); if (one) pages.push(one); });
    if (d.truncated === true) peerTruncated = true;
  }
  const unread = namesOf(unreadIds, opts.nicknameOf);
  const offline = namesOf(opts.offlineMachineIds ?? [], opts.nicknameOf);
  const state = self.state === 'ok' || peerOk ? 'ok' : self.state === 'off' && peerOffAll && unread.count === 0 && offline.count === 0 ? 'off' : 'unavailable';
  const partial = unread.count > 0 || offline.count > 0 || self.state === 'unavailable';
  const scope = partial ? ' (on the machines that answered)' : '';
  const headline = state === 'off' ? 'Insights are not turned on for this agent.'
    : state === 'unavailable' ? "Can't read insights right now."
    : pages.length ? `${pages.length} ${pages.length === 1 ? 'page has' : 'pages have'} something to say${scope}.`
    : `No pages have insights to show yet${scope}.`;
  return { state, selfState: self.state, headline, pages: pages.slice(0, MAX_INSIGHT_PAGES), truncated: peerTruncated || pages.length > MAX_INSIGHT_PAGES, unread, offline };
}

// ── routes ────────────────────────────────────────────────────────────────────

export interface MobilePhonesMessagesDeps {
  /** This machine's delivery read (`telegramOrigin.deliverySummaryInputs()`), or off when there is no origin runtime here. */
  originStatus: () => Promise<OriginStatus>;
  /** This machine's /health `telegramOrigin.heldForward` (synchronous, last refresh), or null. */
  heldForward: () => unknown;
  /** Each online peer's `GET /mobile/messages?scope=local` (at most MAX_PEERS read). */
  peerMessages: () => Promise<PeerMessages[]>;
  /** A conversation's verified name on this machine, or null. */
  topicName: (topicId: string) => string | null;
  /** This machine's insight engine `getAll({ cachedOnly: true })`, or off when the engine is dark here. */
  insights: () => Promise<InsightsSelf>;
  /** Each online peer's `GET /mobile/insights?scope=local` (at most MAX_PEERS read). */
  peerInsights: () => Promise<PeerInsights[]>;
  /** Registered machines the pool does not count as online (not asked): ids, never returned. */
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
      feature: 'MobilePhonesMessages.read',
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

export function mountMobilePhonesMessagesRoutes(router: Router, deps: MobilePhonesMessagesDeps): void {
  const now = () => (deps.now ? deps.now() : Date.now());
  const cached = singleFlight<Rec>(POOL_READ_CACHE_MS, now);
  const guard = (req: Request, res: Response): boolean => {
    res.set('Cache-Control', 'no-store');
    if (ownerOrBearer(req, deps.bearerOk)) return true;
    res.status(403).json({ error: 'owner-phone-required', detail: 'Only the owner\'s phone can see messages to you and insights.' });
    return false;
  };
  const offline = (): string[] => {
    try { return deps.offlineMachineIds?.() ?? []; } catch (err) { reportReadFailure('offline machine list', err); return []; } // @silent-fallback-ok — reported; offline machines are then simply not named
  };
  const head = () => ({ schemaVersion: MOBILE_PHONES_MESSAGES_SCHEMA_VERSION, generatedAt: new Date(now()).toISOString() });
  // `?scope=local`: this machine's summary only (how one machine reads another's; never fans out again).
  const isLocal = (req: Request) => req.query.scope === 'local';

  router.get('/mobile/messages', async (req: Request, res: Response) => {
    if (!guard(req, res)) return;
    const local = isLocal(req);
    try {
      const body = await cached(local ? 'messages:local' : 'messages', async () => {
        const [status, peers] = await Promise.all([
          safe<OriginStatus>('GET /mobile/messages (this machine)', () => deps.originStatus(), { state: 'unavailable' }),
          local ? Promise.resolve([] as PeerMessages[]) : safe('GET /mobile/messages (peers)', () => deps.peerMessages(), [] as PeerMessages[]),
        ]);
        const heldForward = await safe<unknown>('GET /mobile/messages (held forwards)', () => deps.heldForward(), null);
        const opts = { now: now(), topicName: deps.topicName, nicknameOf: deps.nicknameOf, heldForward, offlineMachineIds: local ? [] : offline(), selfName: cleanText(deps.selfName?.() ?? null, 60) };
        return { ...head(), ...(local ? summarizeLocalMessages(status, opts) : summarizeMessages(status, peers, opts)) };
      });
      res.json(body);
    } catch (err) {
      reportReadFailure('GET /mobile/messages', err);
      res.status(500).json({ error: 'messages-unavailable' });
    }
  });

  router.get('/mobile/insights', async (req: Request, res: Response) => {
    if (!guard(req, res)) return;
    const local = isLocal(req);
    try {
      const body = await cached(local ? 'insights:local' : 'insights', async () => {
        const [self, peers] = await Promise.all([
          safe<InsightsSelf>('GET /mobile/insights (this machine)', () => deps.insights(), { state: 'unavailable' }),
          local ? Promise.resolve([] as PeerInsights[]) : safe('GET /mobile/insights (peers)', () => deps.peerInsights(), [] as PeerInsights[]),
        ]);
        return { ...head(), ...summarizeInsights(self, peers, { nicknameOf: deps.nicknameOf, offlineMachineIds: local ? [] : offline() }) };
      });
      res.json(body);
    } catch (err) {
      reportReadFailure('GET /mobile/insights', err);
      res.status(500).json({ error: 'insights-unavailable' });
    }
  });
}

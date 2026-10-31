// Console Home — pure view-models (docs/specs/console-makeover.md §1).
//
// Each builder turns one route's JSON (or a fetch failure) into a card model:
//   { state, value, line, rows: [{main, sub, end, href}], foot, age }
// state is one of: 'ok' | 'attn' | 'bad' | 'unknown' | 'partial' | 'stale'.
//
// THE RULE: a value that could not be read says so; it never renders as fine.
// A zero is only "nothing" when the source proves it observed. These functions
// are browser-native ESM with no DOM access so the unit tests exercise the
// shipped code directly.

import { verifiedDisplayName } from './display-identity.js';
import { sessionTopicName } from './topic-names.js';

export const FRESH_MS = 5 * 60 * 1000;
export const MAX_ROWS = 3;

/** A fetch outcome: { ok:true, data } | { ok:false, reason }. */
export function failure(reason) { return { ok: false, reason: String(reason || 'no answer') }; }

export function unknownCard(reason, extra = {}) {
  return { state: 'unknown', value: "Can't tell", line: reason, rows: [], ...extra };
}

/** "3 min ago", "2 h ago", "4 d ago". Returns null for unusable input. */
export function ago(ts, now = Date.now()) {
  const t = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(t)) return null;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60); if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60); if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/** "for 12 min", "for 3 h". */
export function duration(ts, now = Date.now()) {
  const a = ago(ts, now);
  if (!a || a === 'just now') return a === 'just now' ? 'just started' : null;
  return 'for ' + a.replace(' ago', '');
}

function plural(n, one, many) { return `${n} ${n === 1 ? one : (many || one + 's')}`; }

/**
 * A machine's name for the operator. Never its internal id: a machine with no
 * name on file is described, not identified by a code nobody can read.
 */
export function machineLabel(f, names = {}) {
  if (!f) return 'a machine with no name on file';
  return verifiedDisplayName(f.nickname, f.machineId) || verifiedDisplayName(f.machineNickname, f.machineId) || verifiedDisplayName(names[f.machineId], f.machineId) || 'a machine with no name on file';
}

/** "Couldn't reach Mac Mini, so its items may be missing." Empty when every machine answered. */
export function unreachedLine(failed, names, what) {
  if (!failed || failed.length === 0) return '';
  const labels = [...new Set(failed.map((f) => machineLabel(f, names)))];
  const list = labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
  return `Couldn't reach ${list}, so ${failed.length === 1 ? 'its' : 'their'} ${what} may be missing.`;
}

/** Name map from a /pool answer: machineId → nickname. */
export function machineNames(poolRes) {
  const out = {};
  const ms = poolRes && poolRes.ok && poolRes.data && Array.isArray(poolRes.data.machines) ? poolRes.data.machines : [];
  for (const m of ms) if (m && m.machineId) {
    const name = verifiedDisplayName(m.nickname, m.machineId) || verifiedDisplayName(m.name, m.machineId);
    if (name) out[m.machineId] = name;
  }
  return out;
}

// ── 1. Can I reach you ────────────────────────────────────────────────────
export function buildReach(res, now = Date.now()) {
  if (!res.ok) return unknownCard(`Couldn't read delivery status: ${res.reason}.`);
  const hf = res.data && res.data.telegramOrigin && res.data.telegramOrigin.heldForward;
  if (!hf || typeof hf !== 'object') return unknownCard('This agent does not report held messages.');
  const observedAt = typeof hf.observedAt === 'number' ? hf.observedAt : Date.parse(hf.observedAt);
  if (!Number.isFinite(observedAt)) return unknownCard('Held messages have not been checked since the server started.');
  const count = Number(hf.count);
  const expired = Number(hf.expiredUnreported) || 0;
  if (!Number.isFinite(count)) return unknownCard('The held-message count is missing.');
  const age = ago(observedAt, now);
  const rows = [];
  if (count > 0) {
    const known = [hf.sessionReplies, hf.automaticMessages, hf.otherMessages].every(Number.isInteger)
      && hf.sessionReplies + hf.automaticMessages + hf.otherMessages === count;
    const parts = known ? [
      hf.sessionReplies ? plural(hf.sessionReplies, 'reply', 'replies') : null,
      hf.automaticMessages ? `${hf.automaticMessages} automatic ${hf.automaticMessages === 1 ? 'message' : 'messages'}` : null,
      hf.otherMessages ? plural(hf.otherMessages, 'other message', 'other messages') : null,
    ].filter(Boolean) : [];
    rows.push({ main: `${parts.length ? parts.join(' and ') : plural(count, 'message', 'messages')} held on this machine`, end: hf.oldestSince ? `oldest ${ago(hf.oldestSince, now)}` : '' });
  }
  if (expired > 0) rows.push({ main: `${plural(expired, 'message', 'messages')} expired without confirmed delivery`, end: 'not yet reported' });
  if (now - observedAt > FRESH_MS) {
    return { state: 'stale', value: count === 0 && expired === 0 ? 'Nothing held' : plural(count + expired, 'message', 'messages'), line: `Last checked ${age}; this may be out of date.`, rows, age };
  }
  if (expired > 0) return { state: 'bad', value: `${expired} expired`, line: 'Some messages expired without confirmed delivery.', rows, age };
  if (count > 0) return { state: 'attn', value: `${count} held`, line: 'I need to restore or verify delivery.', rows, age };
  return { state: 'ok', value: 'No messages held', line: 'No messages are held on this machine.', rows, age };
}

// ── 2. What needs you ─────────────────────────────────────────────────────
const PRIORITY = { URGENT: 0, HIGH: 1, MEDIUM: 2, NORMAL: 3, LOW: 4 };

/** Items the operator must act on, per the attention hub filter's own rule. */
export function needsOperator(item) {
  if (!item) return false;
  if (item.priority === 'URGENT') return true;
  if (item.source === 'agent') return true;
  const cat = String(item.category || '');
  // A security notice is not automatically a request for the operator. For
  // example, a refused Telegram request is evidence of a working guard.
  return /decision|approval|review|sign-?in|relogin/i.test(cat);
}

export const STALE_DAYS = 14;
const DAY = 86400000;

/** Items that never age out of "needs you": security. Everything else, URGENT included, is marked stale after 14 untouched days. */
function neverStale(i) { return /security/i.test(String(i.category || '')); }

/** The same notice raised again (or on several machines) is one thing to do. */
export function groupKey(i) {
  return `${String(i.category || '')}|${String(i.title || i.summary || '').trim().toLowerCase().replace(/\s+/g, ' ')}`;
}

export function buildNeeds(res, now = Date.now(), names = {}) {
  if (!res.ok) return unknownCard(`Couldn't read the attention queue: ${res.reason}.`);
  const items = Array.isArray(res.data && res.data.items) ? res.data.items : null;
  if (!items) return unknownCard('The attention queue answered without a list.');
  const open = items.filter((i) => i && i.status === 'OPEN');
  const mineRaw = open.filter(needsOperator);
  const routine = open.length - mineRaw.length;
  // Group repeats into one entry each.
  const groups = new Map();
  for (const i of mineRaw) {
    const k = groupKey(i);
    const g = groups.get(k) || { items: [], last: 0, machines: new Set() };
    g.items.push(i);
    g.last = Math.max(g.last, Date.parse(i.updatedAt || i.createdAt) || 0);
    if (i.machineNickname) g.machines.add(i.machineNickname);
    groups.set(k, g);
  }
  const all = [...groups.values()].map((g) => {
    const top = g.items.slice().sort((a, b) => (PRIORITY[a.priority] ?? 9) - (PRIORITY[b.priority] ?? 9))[0];
    const stale = !g.items.some(neverStale) && now - g.last > STALE_DAYS * DAY;
    return {
      key: groupKey(top), stale, last: g.last, prio: PRIORITY[top.priority] ?? 9,
      main: top.title || top.summary || 'Untitled item',
      sub: [g.items.length > 1 ? `${g.items.length} copies` : null, [...g.machines].join(', ') || null, String(top.priority || '').toLowerCase()].filter(Boolean).join(' · '),
      end: (ago(g.last, now) || '').replace(' ago', '') ? `${ago(g.last, now)}` : '',
      tone: stale ? 'unknown' : (top.priority === 'URGENT' ? 'bad' : 'attn'),
      detail: top.description || top.body || '',
      expandable: true,
      action: Number.isFinite(Number(top.topicId)) ? { kind: 'topic', topicId: Number(top.topicId) } : null,
    };
  }).sort((a, b) => Number(a.stale) - Number(b.stale) || a.prio - b.prio || b.last - a.last);
  const current = all.filter((g) => !g.stale);
  const stale = all.length - current.length;
  const rows = current.slice(0, MAX_ROWS);
  const failed = (res.data.pool && Array.isArray(res.data.pool.failed)) ? res.data.pool.failed : [];
  const partial = failed.length > 0;
  // Counts that ask nothing of the operator (routine notices, items untouched
  // for weeks) stay off the front page; the older items remain under See all.
  void routine;
  const tail = '';
  const partialLine = unreachedLine(failed, names, 'items');
  if (current.length === 0) {
    return { state: partial ? 'partial' : 'ok', count: 0, coverage: partial ? 'partial view' : null, value: partial ? 'Nothing here' : 'Nothing needs you', line: [partialLine, tail].filter(Boolean).join(' ') || 'The queue is clear.', rows, all };
  }
  return {
    state: partial ? 'partial' : 'attn', count: current.length,
    coverage: partial ? 'partial view' : null,
    value: plural(current.length, 'thing', 'things'), valueTone: 'attn',
    // Machine coverage belongs under agent status, away from the request.
    line: '', note: null, statusNote: partialLine || null, rows, all,
  };
}

// ── 3. What I'm doing ─────────────────────────────────────────────────────
/** Strip machine prefixes and bracketed bootstrap noise from a session name. */
export function sessionLabel(s, topicNames = {}) {
  const name = String(sessionTopicName(s, topicNames) || (s && (s.name || s.tmuxSession)) || 'A session').replace(/^\[.*?\]\s*/, '').trim();
  return name.length > 80 ? name.slice(0, 77) + '…' : name;
}

export function buildDoing(res, now = Date.now(), names = {}, topicNames = {}) {
  if (!res.ok) return unknownCard(`Couldn't list sessions: ${res.reason}.`);
  const sessions = Array.isArray(res.data && res.data.sessions) ? res.data.sessions : null;
  if (!sessions) return unknownCard('The session list answered without sessions.');
  const live = sessions.filter((s) => s && (s.status === 'running' || s.status === 'starting'));
  const pool = res.data.pool || {};
  const failed = Array.isArray(pool.failed) ? pool.failed : [];
  const machines = new Set(live.map((s) => s.machineNickname).filter(Boolean));
  live.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  const rows = live.slice(0, MAX_ROWS).map((s) => {
    const last = s.telemetry && s.telemetry.lastActivity ? `active ${ago(s.telemetry.lastActivity, now)}` : null;
    return {
      main: sessionLabel(s, topicNames),
      sub: [s.machineNickname, duration(s.startedAt, now)].filter(Boolean).join(' · '),
      end: last || '',
    };
  });
  const partialLine = unreachedLine(failed, names, 'sessions');
  if (live.length === 0) {
    return { state: failed.length ? 'partial' : 'ok', value: 'Idle', line: partialLine || 'No sessions are running.', rows };
  }
  return {
    state: failed.length ? 'partial' : 'ok',
    value: plural(live.length, 'session'),
    line: [`Running on ${plural(machines.size || 1, 'machine')}.`, partialLine].filter(Boolean).join(' '),
    rows,
    more: live.length > MAX_ROWS ? live.length - MAX_ROWS : 0,
  };
}

// ── 4. What I've promised ─────────────────────────────────────────────────
export function waitsOnOperator(c) {
  return c && (c.owner === 'user' || c.blockedOn === 'user-input' || c.blockedOn === 'user-authorization');
}

/** A pipeline wake is an agent-owned operational follow-up, not a user request. */
export function isInternalFollowUp(c) {
  return !!c && !waitsOnOperator(c) && typeof c.source === 'string' && /^pipeline-wake(?:-|$)/.test(c.source);
}

/** The tracker's own active rule (CommitmentTracker.getActive), applied to every row. */
export function isActiveCommitment(c, now = Date.now()) {
  if (!c) return false;
  if (c.expiresAt && Date.parse(c.expiresAt) < now) return false;
  return c.status === 'pending' || c.status === 'verified' || c.status === 'violated';
}

export const REPLICA_FRESH_MS = 15 * 60 * 1000;

/** When a promise was last touched (heartbeat, update or creation). */
export function lastTouched(c) {
  return Date.parse(c.lastHeartbeatAt || c.updatedAt || c.createdAt) || 0;
}

/** Missed means a recorded hard deadline actually passed. */
export function isMissed(c, now = Date.now()) {
  if (!c) return false;
  const hard = Date.parse(c.hardDeadlineAt);
  return Number.isFinite(hard) && hard < now && isActiveCommitment(c, now);
}

/** A failed verification without a passed deadline needs review, not an invented due date. */
export function needsPromiseReview(c, now = Date.now()) {
  return !!c && c.status === 'violated' && !isMissed(c, now);
}

export function buildPromised(res, now = Date.now(), expectedPeers = null) {
  if (!res.ok) return unknownCard(`Couldn't read commitments: ${res.reason}.`);
  if (res.data && res.data.enabled === false) return unknownCard('Commitment tracking is switched off on this agent.');
  const list = Array.isArray(res.data && res.data.commitments) ? res.data.commitments
    : (Array.isArray(res.data) ? res.data : null);
  if (!list) return unknownCard('Commitments answered without a list.');
  const open = list.filter((c) => isActiveCommitment(c, now));
  const fresh = (c) => now - lastTouched(c) <= STALE_DAYS * DAY;
  const yoursAll = open.filter(waitsOnOperator).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const yours = yoursAll;
  // Echo-owned missed dates and failed checks are Echo's follow-up queue. A
  // deadline alone never makes the operator responsible for chasing the work.
  const violated = [];
  const review = [];
  const rest = open.filter((c) => fresh(c) && !waitsOnOperator(c)).length;
  const toRow = (c, tone) => ({
    key: `${c.originMachineId || 'own'}:${c.id}`,
    detail: c.userRequest && c.agentResponse ? `You asked: ${c.userRequest}` : '',
    expandable: true,
    main: (tone === 'attn'
      ? verifiedDisplayName(c.userRequest, c.id) || verifiedDisplayName(c.agentResponse, c.id)
      : verifiedDisplayName(c.agentResponse, c.id) || verifiedDisplayName(c.userRequest, c.id)) || 'Promise details unavailable',
    sub: [c.blockedOn && c.blockedOn !== 'none' ? `waiting on ${String(c.blockedOn).replace('user-', 'your ')}` : '',
      isMissed(c, now) ? `due ${new Date(Date.parse(c.hardDeadlineAt)).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}` : '',
      c.viewSource === 'replica' && c.originMachineId ? `from another machine, ${Number.isFinite(Number(c.stalenessMs)) && c.stalenessMs !== null ? `as of ${ago(now - c.stalenessMs, now)}` : 'age unknown'}` : ''].filter(Boolean).join(' · '),
    end: ago(c.createdAt, now) || '',
    tone,
    action: tone === 'attn' || tone === 'bad' ? { kind: 'promise', id: c.id, origin: c.originMachineId || null } : null,
  });
  const all = yours.map((c) => toRow(c, 'attn'));
  // Coverage honesty: a mesh read that carries no replica rows has not shown other machines.
  const replicas = list.filter((c) => c && c.viewSource === 'replica');
  const origins = new Set(replicas.map((c) => c.originMachineId));
  // A replica with no usable age is of unknown freshness, never assumed fresh.
  const staleReplica = replicas.some((c) => !Number.isFinite(Number(c.stalenessMs)) || c.stalenessMs === null || Number(c.stalenessMs) > REPLICA_FRESH_MS);
  // Coverage is only verified when every other machine in the pool is represented.
  const missingPeers = Number.isFinite(expectedPeers) ? Math.max(0, expectedPeers - origins.size) : null;
  const coverage = res.data && res.data.scope === 'mesh'
    ? (origins.size === 0 ? "Only this machine's promises are visible."
      : staleReplica ? `Includes ${plural(origins.size, 'other machine')}; some of it is out of date.`
      : missingPeers === null ? `Includes ${plural(origins.size, 'other machine')}; other-machine coverage unverified.`
      : missingPeers > 0 ? `Includes ${plural(origins.size, 'other machine')}; ${plural(missingPeers, 'machine')} not represented.`
      : `Includes all ${plural(origins.size, 'other machine')}.`)
    : "Only this machine's promises are visible.";
  const line = [
    yours.length ? `${plural(yours.length, 'promise')} waiting on you.` : null,
    !yours.length ? (rest > 0 ? 'I’m handling the open work.' : 'Nothing open.') : null,
  ].filter(Boolean).join(' ');
  const incomplete = origins.size === 0 || staleReplica || missingPeers === null || missingPeers > 0;
  const state = yours.length ? 'attn' : (incomplete ? 'partial' : 'ok');
  return {
    state, count: yours.length, missedCount: violated.length, reviewCount: review.length, coverage: incomplete ? 'partial view' : null, value: yours.length ? `${yours.length} waiting on you` : plural(open.length, 'open promise'),
    // Promises waiting on the operator are listed in "What needs you"; this
    // card's rows show the rest so the same item never appears twice.
    line, note: coverage, rows: all.filter((r) => r.tone !== 'attn').slice(0, MAX_ROWS), all,
  };
}

// ── 5. Where I'm running ──────────────────────────────────────────────────
export const LIVE_MS = 2 * 60 * 1000;
export const STALE_MS = 15 * 60 * 1000;

/**
 * Deterministic machine state from the evidence /pool exposes today
 * (online, routerReceivedAt/selfReportedLastSeen, loadAvg/cores, ropeCondition).
 * Precedence, first match wins: an explicit peer-offline rope signal; no
 * timestamp at all; silent over 15 min; silent over 2 min (stale evidence never
 * supports a present-tense load diagnosis); adverse live evidence (degraded or
 * urgent rope, load over 2 per core); otherwise live.
 */
export function machineState(m, now = Date.now()) {
  if (!m) return { state: 'unknown', label: 'unknown', age: null };
  const heard = Date.parse(m.routerReceivedAt || m.selfReportedLastSeen || m.lastSeen);
  const age = Number.isFinite(heard) ? ago(heard, now) : null;
  const rope = m.ropeCondition;
  if (rope === 'peer-offline') return { state: 'bad', label: 'unreachable', age };
  if (!Number.isFinite(heard)) return { state: 'unknown', label: 'no reading', age: null };
  const since = now - heard;
  if (since > STALE_MS) return { state: 'bad', label: 'not answering', age };
  if (since > LIVE_MS) return { state: 'stale', label: 'quiet', age };
  const cores = m.hardware && Number(m.hardware.cpuCores);
  const perCore = cores > 0 && Number.isFinite(Number(m.loadAvg)) ? Number(m.loadAvg) / cores : null;
  if (rope === 'degraded' || rope === 'urgent' || (perCore !== null && perCore > 2)) return { state: 'attn', label: 'struggling', age, perCore };
  if (m.online === false) return { state: 'unknown', label: 'no reading', age };
  return { state: 'ok', label: 'live', age, perCore };
}

export function buildRunning(res, now = Date.now()) {
  if (!res.ok) return unknownCard(`Couldn't read the machine pool: ${res.reason}.`);
  const machines = Array.isArray(res.data && res.data.machines) ? res.data.machines : null;
  if (!machines) {
    if (res.data && res.data.enabled === false) return { state: 'ok', value: 'One machine', line: 'This agent runs on a single machine.', machines: [] };
    return unknownCard('The pool answered without a machine list.');
  }
  const ms = machines.map((m) => ({ name: verifiedDisplayName(m.nickname, m.machineId) || 'another machine', ...machineState(m, now) }));
  const counts = { ok: 0, attn: 0, stale: 0, bad: 0, unknown: 0 };
  for (const m of ms) counts[m.state] = (counts[m.state] || 0) + 1;
  const worst = counts.bad ? 'bad' : counts.attn ? 'attn' : (counts.stale || counts.unknown) ? 'partial' : 'ok';
  const parts = [];
  if (counts.ok) parts.push(`${counts.ok} live`);
  if (counts.attn) parts.push(`${counts.attn} struggling`);
  if (counts.stale) parts.push(`${counts.stale} quiet`);
  if (counts.bad) parts.push(`${counts.bad} not answering`);
  if (counts.unknown) parts.push(`${counts.unknown} with no reading`);
  return {
    state: worst,
    value: `${counts.ok} of ${ms.length} live`,
    line: counts.ok === ms.length ? 'Every machine is answering.' : parts.join(' · ') + '.',
    // When every machine is fine the list says nothing new; show it only when one isn't.
    machines: counts.ok === ms.length ? [] : ms,
  };
}

// ── 6. What I'm allowed to do ─────────────────────────────────────────────
const GUARD_WORD = { off: 'off', 'on-dry-run': 'watching only', errored: 'errored', missing: 'missing', 'off-runtime-divergent': 'off while running' };

export function buildAllowed(guardsRes, mandateRes, now = Date.now()) {
  const mandateRow = () => {
    if (!(mandateRes && mandateRes.ok && Array.isArray(mandateRes.data && mandateRes.data.mandates))) return null;
    const n = mandateRes.data.mandates.filter((m) => m && !m.revoked && (!m.expiresAt || Date.parse(m.expiresAt) > now)).length;
    return { main: `${plural(n, 'permission slip')} active` };
  };
  if (!guardsRes.ok) { const r = mandateRow(); return unknownCard(`Couldn't read the safety checks: ${guardsRes.reason}.`, { rows: r ? [r] : [] }); }
  const s = guardsRes.data && guardsRes.data.summary;
  if (!s || typeof s !== 'object') return unknownCard('The safety checks answered without a summary.');
  const KEYS = ['onConfirmed', 'onUnverified', 'onStale', 'onBlind', 'onDryRun', 'offDeviant', 'offDarkDefault', 'offRuntimeDivergent', 'errored', 'missing'];
  if (!KEYS.every((k) => Number.isFinite(Number(s[k])) && s[k] !== null && s[k] !== '')) return unknownCard('The safety-check summary is missing its counts.');
  const n = (k) => (Number.isFinite(Number(s[k])) ? Number(s[k]) : 0);
  const on = n('onConfirmed') + n('onUnverified') + n('onStale') + n('onBlind');
  const dry = n('onDryRun');
  const offWrong = n('offDeviant') + n('offRuntimeDivergent') + n('errored') + n('missing');
  const offDark = n('offDarkDefault');
  const gaps = Array.isArray(s.loadBearingGapKeys) ? s.loadBearingGapKeys.length : 0;
  const total = on + dry + offWrong + offDark;
  let mandates = null;
  if (mandateRes && mandateRes.ok && Array.isArray(mandateRes.data && mandateRes.data.mandates)) {
    const list = mandateRes.data.mandates;
    mandates = list.filter((m) => m && !m.revoked && (!m.expiresAt || Date.parse(m.expiresAt) > now)).length;
  }
  const rows = [];
  if (offWrong) rows.push({ main: `${plural(offWrong, 'safety check')} off that should be on`, tone: 'attn' });
  if (gaps) rows.push({ main: `${plural(gaps, 'critical path')} without its guard`, tone: 'attn' });
  rows.push({ main: mandates === null ? "Can't tell which permission slips are active" : `${plural(mandates, 'permission slip')} active`, tone: mandates === null ? 'unknown' : undefined });
  const guards = Array.isArray(guardsRes.data.guards) ? guardsRes.data.guards : [];
  const isOn = (e) => e === 'on-confirmed' || e === 'on-unverified' || e === 'on-stale' || e === 'on-blind';
  const byDesign = (g) => g.effective === 'off' && g.offClass === 'dark-default';
  const notOn = guards.filter((g) => g && typeof g.effective === 'string' && !isOn(g.effective))
    .sort((a, b) => Number(byDesign(a)) - Number(byDesign(b)) || Number(a.effective === 'on-dry-run') - Number(b.effective === 'on-dry-run'));
  const all = notOn.map((g) => ({
    main: g.criticalPath || g.key || 'A safety check',
    sub: g.criticalPath ? g.key : '',
    end: byDesign(g) ? 'off by design' : (GUARD_WORD[g.effective] || String(g.effective).replace(/-/g, ' ')),
    tone: byDesign(g) || g.effective === 'on-dry-run' ? undefined : 'attn',
    mono: true,
  }));
  return {
    state: offWrong || gaps ? 'attn' : (mandates === null ? 'partial' : 'ok'),
    coverage: mandates === null ? 'partial view' : null,
    value: `${on} of ${total} on`, all,
    line: `${dry} watching only, ${offDark} off by design.`,
    rows: rows.slice(0, MAX_ROWS),
    meter: { ok: on, dry, warn: offWrong, off: offDark },
  };
}

// ── One answer to "what needs you" ────────────────────────────────────────
/**
 * The "What needs you" card is the single answer on the screen: queue items
 * that need the operator AND promises waiting on the operator. The headline
 * counts this card alone, so the two can never disagree.
 */
/** Pull request numbers a row names ("PR 2380", "PR #2380", ".../pull/2380"; a bare "#2380" may be a topic, so it is not read). */
export function pullRequestRefs(row) {
  const text = [row && row.main, row && row.sub, row && row.detail, row && row.href].filter((v) => typeof v === 'string').join(' ');
  const out = new Set();
  for (const m of text.matchAll(/(?:\bPR\s*#?|\bpull request\s*#?|\/pull\/)(\d{2,6})\b/gi)) out.add(m[1]);
  return [...out];
}

export function combineNeeds(needs, promised) {
  if (!needs || !Number.isFinite(needs.count)) return needs; // loading or can't tell: say so as-is
  if (!promised || promised.state === 'loading') return needs;
  const pCount = Number.isFinite(promised.count) ? promised.count : 0;
  const queue = needs.all || needs.rows || [];
  // A promise that waits on the same pull request as a queue item is the same
  // ask twice (the approval itself, and my promise to merge after it): show the
  // queue item, which carries the action, and drop the promise row.
  const queueRefs = new Set(queue.flatMap(pullRequestRefs));
  const waitingAll = (promised.all || []).filter((r) => r.tone === 'attn').slice(0, pCount);
  const waiting = waitingAll.filter((r) => !pullRequestRefs(r).some((ref) => queueRefs.has(ref)))
    .map((r) => ({ ...r, sub: ['a promise', r.sub].filter(Boolean).join(' · ') }));
  const promisesKnown = Number.isFinite(promised.count);
  const count = needs.count + waiting.length;
  // Urgent queue items lead (the headline names the first row), then promises, then the rest.
  const all = [...queue.filter((r) => r.tone === 'bad'), ...waiting, ...queue.filter((r) => r.tone !== 'bad')];
  const notes = !promisesKnown ? "Couldn't check for promises waiting on you."
    : promised.state === 'stale' ? 'Promise information is from the last successful check.' : '';
  const queueLine = needs.line === 'The queue is clear.' || needs.line === 'Waiting on you.' ? null : needs.line;
  const line = count ? '' : [notes, queueLine].filter(Boolean).join(' ') || 'Nothing is waiting on you.';
  const partial = needs.state === 'partial' || !promisesKnown || promised.state === 'stale' || !!promised.coverage;
  return {
    ...needs, combined: true, count, all, rows: all.slice(0, MAX_ROWS), line,
    note: count ? null : needs.note,
    statusNote: count ? [needs.statusNote, notes, queueLine].filter(Boolean).join(' ') : needs.statusNote,
    coverage: partial ? 'partial view' : needs.coverage,
    state: count > 0 ? (partial ? 'partial' : 'attn') : (partial ? 'partial' : 'ok'),
    value: count > 0 ? plural(count, 'thing', 'things') : (partial ? 'Nothing here' : 'Nothing needs you'),
    valueTone: count > 0 ? 'attn' : needs.valueTone,
  };
}

const AREA_NAME = { reach: 'message delivery', needs: 'what needs you', doing: 'sessions', promised: 'promises', running: 'machines', allowed: 'permissions' };
const BAD_HEADLINE = { promised: 'A promise missed its deadline.', running: 'A machine is not answering.' };
const BAD_DESTINATION = { promised: '#/work/promises?s=missed', running: '#/capacity/machines' };
const ATTENTION_HEADLINE = { running: 'A machine is struggling.', allowed: 'Safety checks need a look.' };
const ATTENTION_DESTINATION = { running: '#/capacity/machines', allowed: '#/settings/allowed', doing: '#/work/sessions' };
const CHECK_DESTINATION = { needs: '#/home?retry=1', doing: '#/work/sessions', promised: '#/work/promises', running: '#/capacity/machines', allowed: '#/settings/allowed' };

// ── The headline ──────────────────────────────────────────────────────────
/** One sentence over all six cards. Never says "all quiet" while a card can't tell. */
export function headline(allCards) {
  // Held replies are the agent's to retry, never something the operator is
  // asked to look at, so delivery status never shapes the headline.
  const cards = Object.fromEntries(Object.entries(allCards || {}).filter(([k]) => k !== 'reach'));
  const list = Object.values(cards).filter(Boolean);
  const known = (c) => (c && Number.isFinite(c.count) ? c.count : 0);
  const bad = list.filter((c) => c.state === 'bad').length;
  const blindIds = Object.entries(cards).filter(([, c]) => c && (c.state === 'unknown' || c.state === 'partial' || c.state === 'stale' || c.coverage)).map(([k]) => k);
  const blind = blindIds.length;
  const attention = Object.entries(cards).filter(([k, c]) => c && c.state === 'attn' && k !== 'needs' && k !== 'promised');
  const otherAttn = attention.length;
  const loading = list.filter((c) => c.state === 'loading').length;
  // Never announce a count, or "all quiet", before both counting cards answered.
  if (loading === list.length || (cards.needs && cards.needs.state === 'loading') || (cards.promised && cards.promised.state === 'loading')) return { text: 'Checking in…', tone: 'muted' };
  // A known action survives incomplete coverage. Coverage belongs under agent
  // status, not in the sentence describing the action.
  const count = cards.needs && cards.needs.combined ? known(cards.needs) : known(cards.needs) + known(cards.promised);
  const quals = [];
  if (bad) quals.push(`${plural(bad, 'area')} failing`);
  if (otherAttn) quals.push(`${plural(otherAttn, 'other area')} to look at`);
  if (blind) quals.push(`can't fully see ${blindIds.map((k) => AREA_NAME[k] || k).join(' and ')}`);
  const qual = quals.length ? quals.join(', ').replace(/^./, (c) => c.toUpperCase()) + '.' : null;
  if (count > 0) {
    const first = cards.needs?.rows?.[0];
    const action = first?.main && String(first.main).trim().replace(/[.\s]+$/, '');
    const withContext = action && /^(.*?)\s*\(([^)]+)\)$/.exec(action);
    const title = withContext ? withContext[1] : action;
    const context = withContext ? `${withContext[2].replace(/,\s*/g, ' · ')}.` : null;
    return { text: title || 'Open what needs your attention', tone: 'attn',
      sub: [context, first?.action ? 'Tap to review and respond.' : null,
        count > 1 ? `${count - 1 === 1 ? 'One more thing needs' : `${count - 1} more things need`} you, listed below.` : null].filter(Boolean).join(' '),
      action: first?.action || null };
  }
  // Only what the operator can act on takes the headline. My own areas
  // (promises I owe, machines, safety settings, failed reads of those) are
  // mine to handle and live under "See agent status", never in the headline.
  const operatorBad = cards.needs && cards.needs.state === 'bad';
  if (operatorBad) {
    const [id, model] = ['needs', cards.needs];
    const missed = id === 'promised' ? model.missedCount : 0;
    const review = id === 'promised' ? model.reviewCount : 0;
    const firstMiss = missed === 1 ? model.rows?.find((r) => r.tone === 'bad' && r.action)?.main : null;
    const firstClause = firstMiss ? String(firstMiss).split(/[,;.!?]/)[0].trim()
      .replace(/^(?:Echo desk|Echo|I|We)\s+will\s+/i, '')
      .replace(/\bthe held\s+/i, 'the ')
      .split(/\s+after\s+/i)[0].trim() : '';
    const shortClause = firstClause.length > 92 ? `${firstClause.slice(0, 89).replace(/\s+\S*$/, '')}…` : firstClause;
    const text = missed && shortClause ? `Overdue: ${shortClause}.`
      : missed ? `${missed} ${missed === 1 ? 'promise missed its deadline' : 'promises missed their deadlines'}.`
      : review ? `${review} ${review === 1 ? 'promise needs an update' : 'promises need an update'}.`
      : BAD_HEADLINE[id] || `${AREA_NAME[id] || 'An area'} is failing.`;
    const action = id === 'promised' ? model.rows?.find((r) => r.tone === 'bad' && r.action)?.action : null;
    const due = missed && firstMiss ? model.rows?.find((r) => r.tone === 'bad' && r.action)?.sub?.match(/\bdue ([^·]+)/)?.[1]?.trim() : null;
    return { text, tone: 'bad', sub: due ? `Due ${due}.` : '',
    action, href: action ? null : BAD_DESTINATION[id] || null,
    linkLabel: id === 'promised' ? missed ? 'Open a missed promise' : 'Open a promise needing an update' : id === 'running' ? 'Inspect the machine' : 'Inspect the issue' };
  }

  // A failed read gets its own named destination, even when there is no known
  // action. The operator can inspect the failed area directly from Home.
  const failedCheck = Object.entries(cards).find(([k, c]) => k === 'needs' && c && (c.state === 'unknown' || c.state === 'stale'));
  if (failedCheck) {
    const [id, model] = failedCheck;
    const area = AREA_NAME[id] || id;
    if (model.retrying) return { text: `Still checking ${area}.`, tone: 'muted',
      sub: 'The answer is delayed. Checking again automatically.', href: CHECK_DESTINATION[id] || null, linkLabel: `Open ${area}` };
    return { text: model.state === 'stale' ? `Couldn't refresh ${area}.` : `Couldn't check ${area}.`, tone: 'attn',
      sub: model.state === 'stale' ? 'Showing the last successful result.' : 'The result is unknown.',
      href: CHECK_DESTINATION[id] || null, linkLabel: `Open ${area}` };
  }
  // "Quiet" is only claimed, and only painted teal, when every card is observed and settled.
  // Never a confident all-clear while part of "what needs you" could not be read
  // (another machine's queue, or the promises waiting on the operator).
  if (cards.needs && (cards.needs.state === 'partial' || cards.needs.coverage)) {
    return { text: 'Nothing needs you that I can see.', tone: 'muted',
      sub: 'Part of the list could not be checked. Checking again automatically.', href: CHECK_DESTINATION.needs, linkLabel: 'Check again' };
  }
  if (bad || otherAttn || blind) return { text: 'Nothing needs you.', tone: 'ok', sub: 'I’m handling the rest. It’s under “See agent status”.' };
  return { text: 'All quiet.', tone: 'ok', sub: 'Nothing needs you right now.' };
}

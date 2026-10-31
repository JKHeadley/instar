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
  for (const m of ms) if (m && m.machineId && (m.nickname || m.name)) out[m.machineId] = verifiedDisplayName(m.nickname, m.machineId) || verifiedDisplayName(m.name, m.machineId);
  return out;
}

// ── What needs you ─────────────────────────────────────────────────────────
const PRIORITY = { URGENT: 0, HIGH: 1, MEDIUM: 2, NORMAL: 3, LOW: 4 };

/** Items the operator must act on, per the attention hub filter's own rule. */
export function needsOperator(item) {
  if (!item) return false;
  if (item.priority === 'URGENT') return true;
  if (item.source === 'agent') return true;
  const cat = String(item.category || '');
  return /decision|approval|review|security|sign-?in|relogin/i.test(cat);
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
    line: [partialLine, tail].filter(Boolean).join(' ') || 'Waiting on you.',
    rows, all,
  };
}

// ── 3. What I'm doing ─────────────────────────────────────────────────────
/** Strip machine prefixes and bracketed bootstrap noise from a session name. */
export function sessionLabel(s) {
  const name = String((s && (s.name || s.tmuxSession)) || 'A session').replace(/^\[.*?\]\s*/, '').trim();
  return name.length > 80 ? name.slice(0, 77) + '…' : name;
}

export function buildDoing(res, now = Date.now(), names = {}) {
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
      main: sessionLabel(s),
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

/** Missed: the tracker says violated, or a hard deadline passed while it was still open. */
export function isMissed(c, now = Date.now()) {
  if (!c) return false;
  if (c.status === 'violated') return true;
  const hard = Date.parse(c.hardDeadlineAt);
  return Number.isFinite(hard) && hard < now && isActiveCommitment(c, now);
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
  const yours = yoursAll.filter(fresh);
  const yoursStale = yoursAll.length - yours.length;
  // A miss nobody has touched for 14+ days is history, not a live problem.
  const violated = list.filter((c) => isMissed(c, now) && !waitsOnOperator(c) && now - lastTouched(c) <= STALE_DAYS * DAY);
  const rest = open.filter((c) => fresh(c) && !waitsOnOperator(c) && !isMissed(c, now)).length;
  const olderCarried = open.filter((c) => !fresh(c) && !waitsOnOperator(c) && !isMissed(c, now)).length;
  const toRow = (c, tone) => ({
    key: `${c.originMachineId || 'own'}:${c.id}`,
    detail: c.userRequest && c.agentResponse ? `You asked: ${c.userRequest}` : '',
    expandable: true,
    main: verifiedDisplayName(c.agentResponse, c.id) || verifiedDisplayName(c.userRequest, c.id) || 'Promise details unavailable',
    sub: [c.blockedOn && c.blockedOn !== 'none' ? `waiting on ${String(c.blockedOn).replace('user-', 'your ')}` : (c.status === 'violated' ? 'missed' : ''),
      c.viewSource === 'replica' && c.originMachineId ? `from another machine, ${Number.isFinite(Number(c.stalenessMs)) && c.stalenessMs !== null ? `as of ${ago(now - c.stalenessMs, now)}` : 'age unknown'}` : ''].filter(Boolean).join(' · '),
    end: ago(c.createdAt, now) || '',
    tone,
  });
  const all = [...yours.map((c) => toRow(c, 'attn')), ...violated.map((c) => toRow(c, 'bad')), ...yoursAll.filter((c) => !fresh(c)).map((c) => ({ ...toRow(c, 'unknown'), sub: `${toRow(c).sub ? toRow(c).sub + ' · ' : ''}untouched ${STALE_DAYS}+ days` }))];
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
  void olderCarried;
  const line = [
    yours.length ? `${plural(yours.length, 'promise')} waiting on you.` : null,
    violated.length ? `${violated.length} recently missed ${violated.length === 1 ? 'its' : 'their'} deadline.` : null,
    !yours.length && !violated.length ? (yoursStale > 0 ? 'Nothing recent waiting on you.' : rest > 0 ? `${rest} in progress, nothing waiting on you.` : 'Nothing open.') : null,
  ].filter(Boolean).join(' ');
  const incomplete = origins.size === 0 || staleReplica || missingPeers === null || missingPeers > 0;
  const state = yours.length ? 'attn' : violated.length ? 'bad' : (incomplete ? 'partial' : 'ok');
  return {
    state, count: yours.length, coverage: incomplete ? 'partial view' : null, value: yours.length ? `${yours.length} waiting on you` : plural(open.length, 'open promise'),
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
export function combineNeeds(needs, promised) {
  if (!needs || !Number.isFinite(needs.count)) return needs; // loading or can't tell: say so as-is
  if (!promised || promised.state === 'loading') return needs;
  const pCount = Number.isFinite(promised.count) ? promised.count : 0;
  const waiting = (promised.all || []).filter((r) => r.tone === 'attn').slice(0, pCount)
    .map((r) => ({ ...r, sub: ['a promise', r.sub].filter(Boolean).join(' · ') }));
  const promisesKnown = Number.isFinite(promised.count);
  const count = needs.count + pCount;
  const all = [...waiting, ...(needs.all || needs.rows || [])];
  const notes = [
    pCount ? `Includes ${plural(pCount, 'promise')} waiting on you.` : null,
    promisesKnown ? null : "Couldn't check for promises waiting on you.",
  ].filter(Boolean).join(' ');
  const queueLine = needs.line === 'The queue is clear.' || needs.line === 'Waiting on you.' ? null : needs.line;
  const line = [notes, queueLine].filter(Boolean).join(' ') || (count === 0 ? 'Nothing is waiting on you.' : 'Waiting on you.');
  const partial = needs.state === 'partial' || !promisesKnown;
  return {
    ...needs, combined: true, count, all, rows: all.slice(0, MAX_ROWS), line,
    coverage: partial ? 'partial view' : needs.coverage,
    state: count > 0 ? (partial ? 'partial' : 'attn') : (partial ? 'partial' : 'ok'),
    value: count > 0 ? plural(count, 'thing', 'things') : (partial ? 'Nothing here' : 'Nothing needs you'),
    valueTone: count > 0 ? 'attn' : needs.valueTone,
  };
}

const AREA_NAME = { needs: 'what needs you', doing: 'sessions', promised: 'promises', running: 'machines', allowed: 'permissions' };

// ── The headline ──────────────────────────────────────────────────────────
/** One sentence over the Home cards. Never says "all quiet" while a card can't tell. */
export function headline(cards) {
  const list = Object.values(cards).filter(Boolean);
  const known = (c) => (c && Number.isFinite(c.count) ? c.count : 0);
  const bad = list.filter((c) => c.state === 'bad').length;
  const blindIds = Object.entries(cards).filter(([, c]) => c && (c.state === 'unknown' || c.state === 'partial' || c.state === 'stale' || c.coverage)).map(([k]) => k);
  const blind = blindIds.length;
  const otherAttn = Object.entries(cards).filter(([k, c]) => c && c.state === 'attn' && k !== 'needs' && k !== 'promised').length;
  const loading = list.filter((c) => c.state === 'loading').length;
  // Never announce a count, or "all quiet", before both counting cards answered.
  if (loading === list.length || (cards.needs && cards.needs.state === 'loading') || (cards.promised && cards.promised.state === 'loading')) return { text: 'Checking in…', tone: 'muted' };
  // A known action count survives incomplete coverage; the coverage qualification rides beside it.
  const count = cards.needs && cards.needs.combined ? known(cards.needs) : known(cards.needs) + known(cards.promised);
  const quals = [];
  if (bad) quals.push(`${plural(bad, 'area')} failing`);
  if (otherAttn) quals.push(`${plural(otherAttn, 'other area')} to look at`);
  if (blind) quals.push(`can't fully see ${blindIds.map((k) => AREA_NAME[k] || k).join(' and ')}`);
  const qual = quals.length ? quals.join(', ').replace(/^./, (c) => c.toUpperCase()) + '.' : null;
  if (count > 0) return { text: count === 1 ? 'One thing needs you.' : `${count} things need you.`, tone: 'attn', sub: qual };
  if (bad) return { text: bad === 1 ? 'Something is failing.' : `${bad} areas are failing.`, tone: 'bad', sub: qual };
  if (otherAttn) return { text: otherAttn === 1 ? 'One area needs a look.' : `${otherAttn} areas need a look.`, tone: 'attn', sub: qual };
  // "Quiet" is only claimed, and only painted teal, when every card is observed and settled.
  if (blind) return { text: 'Nothing urgent that I can see.', tone: 'muted', sub: qual };
  return { text: 'All quiet.', tone: 'ok', sub: 'Nothing needs you right now.' };
}

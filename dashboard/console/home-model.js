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

// ── Row wording: one plain sentence on the face, the original text behind the tap ──
/** Thread ids, attention-item ids, fingerprints and embedded timestamps out of a sentence. */
export function stripIds(text) {
  return String(text || '')
    .replace(/\s*\((?:thread[- ][\w-]+|\d{1,2}:\d{2}Z? ?\d{4}-\d{2}-\d{2}[^)]*|as of [^)]*)\)/gi, '')
    .replace(/\s*\bon thread\s+[0-9a-f]{6,}\b/gi, '')
    .replace(/\bthread[- ](?:id[- ])?[0-9a-z][\w-]{5,}\b/gi, 'that thread')
    .replace(/\battention item\s+agent:[\w.:-]+/gi, 'the attention item')
    .replace(/\bagent:[\w.:-]+/g, 'it')
    .replace(/\b[0-9a-f]{32,}\b/gi, '')
    .replace(/\s{2,}/g, ' ').replace(/\s+([,.;:)])/g, '$1').replace(/\(\s*\)/g, '').trim();
}

export const BRIEF_MAX = 110;
/** The first sentence, ids stripped, capped at a word boundary; "" in → "" out. */
export function briefOf(text, max = BRIEF_MAX) {
  const clean = stripIds(text);
  if (!clean) return '';
  const m = /^(.{20,}?[.!?])(?:\s|$)/.exec(clean);
  let s = m ? m[1] : clean;
  if (s.length > max) {
    const cut = s.slice(0, max - 1);
    const at = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf(','), cut.lastIndexOf(';'));
    s = `${cut.slice(0, at > 40 ? at : max - 1).replace(/[,;:\s]+$/, '')}…`;
  }
  return s;
}

// ── 1. Can I reach you ────────────────────────────────────────────────────
export function buildReach(res, now = Date.now()) {
  if (!res.ok) return unknownCard(`Couldn't read delivery status: ${res.reason}.`);
  const hf = res.data && res.data.telegramOrigin && res.data.telegramOrigin.heldForward;
  if (!hf || typeof hf !== 'object') return unknownCard('This agent does not report held replies.');
  const observedAt = typeof hf.observedAt === 'number' ? hf.observedAt : Date.parse(hf.observedAt);
  if (!Number.isFinite(observedAt)) return unknownCard('Held replies have not been checked since the server started.');
  const count = Number(hf.count);
  const expired = Number(hf.expiredUnreported) || 0;
  if (!Number.isFinite(count)) return unknownCard('The held-reply count is missing.');
  const age = ago(observedAt, now);
  const rows = [];
  if (count > 0) rows.push({ main: `${plural(count, 'reply', 'replies')} waiting to reach you`, end: hf.oldestSince ? `oldest ${ago(hf.oldestSince, now)}` : '' });
  if (expired > 0) rows.push({ main: `${plural(expired, 'reply', 'replies')} expired before reaching you`, end: 'not yet reported' });
  if (now - observedAt > FRESH_MS) {
    return { state: 'stale', value: count === 0 && expired === 0 ? 'Nothing held' : plural(count + expired, 'reply', 'replies'), line: `Last checked ${age}; this may be out of date.`, rows, age };
  }
  if (expired > 0) return { state: 'bad', value: `${expired} lost`, line: 'Some replies expired before they reached you.', rows, age };
  if (count > 0) return { state: 'attn', value: `${count} held`, line: 'Replies are written but not delivered yet.', rows, age };
  return { state: 'ok', value: 'No replies held', line: '', rows, age, details: ['Checked on this machine only; each machine holds its own replies.'] };
}

// ── 2. What needs you ─────────────────────────────────────────────────────
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

export function buildNeeds(res, now = Date.now()) {
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
      main: briefOf(top.title || top.summary) || 'Untitled item',
      sub: [g.items.length > 1 ? `${g.items.length} copies` : null, [...g.machines].join(', ') || null, String(top.priority || '').toLowerCase()].filter(Boolean).join(' · '),
      end: (ago(g.last, now) || '').replace(' ago', '') ? `${ago(g.last, now)}` : '',
      tone: stale ? 'unknown' : (top.priority === 'URGENT' ? 'bad' : 'attn'),
      detail: [briefOf(top.title || top.summary) !== String(top.title || top.summary || '').trim() ? String(top.title || top.summary || '') : null, top.description || top.body || '', top.id ? `Item ${top.id}` : null].filter(Boolean).join('\n\n'),
      expandable: true,
    };
  }).sort((a, b) => Number(a.stale) - Number(b.stale) || a.prio - b.prio || b.last - a.last);
  const current = all.filter((g) => !g.stale);
  const stale = all.length - current.length;
  const rows = current.slice(0, MAX_ROWS);
  const failed = (res.data.pool && Array.isArray(res.data.pool.failed)) ? res.data.pool.failed : [];
  const partial = failed.length > 0;
  const missing = failed.map((f) => f.nickname || f.machineNickname || f.machineId || 'a machine').join(', ');
  // Housekeeping lives one tap deeper (Details), never on the card face.
  const details = [
    stale ? `${plural(stale, 'older item')} untouched for ${STALE_DAYS}+ days (under See all).` : null,
    routine > 0 ? `${plural(routine, 'routine notice')} kept in the log.` : null,
  ].filter(Boolean);
  const partialLine = partial ? `No answer from ${missing}, so there may be more.` : '';
  if (current.length === 0) {
    return { state: partial ? 'partial' : 'ok', count: 0, coverage: partial ? 'partial view' : null, missing: partial ? missing : null, value: partial ? 'Nothing I can see' : 'Nothing needs you', line: partialLine, rows, all, details };
  }
  return {
    state: partial ? 'partial' : 'attn', count: current.length,
    coverage: partial ? 'partial view' : null, missing: partial ? missing : null,
    value: plural(current.length, 'thing', 'things'), valueTone: 'attn',
    line: partialLine,
    rows, all, details,
  };
}

/**
 * The "What needs you" card: ONE list of everything the headline counts as
 * needing the operator — the attention items AND the promises waiting on the
 * operator. The headline reads its count from this card, so the two can never
 * disagree. `attn` is buildNeeds' model, `prom` is buildPromised's; either may
 * be { state: 'loading' } while its source has not answered.
 */
export function combineNeeds(attn, prom) {
  attn = attn || { state: 'loading' };
  prom = prom || { state: 'loading' };
  const loading = (m) => m.state === 'loading';
  const readable = (m) => !loading(m) && m.state !== 'unknown' && Number.isFinite(m.count ?? m.waitingCount);
  const attnOk = readable(attn) && Array.isArray(attn.all);
  const promOk = !loading(prom) && prom.state !== 'unknown' && Array.isArray(prom.waiting);
  const attnCurrent = attnOk ? attn.all.filter((r) => !r.stale) : [];
  const attnStale = attnOk ? attn.all.filter((r) => r.stale) : [];
  const waiting = promOk ? prom.waiting : [];
  const waitingStale = promOk ? (prom.waitingStale || []) : [];
  const current = [...attnCurrent, ...waiting];
  const count = current.length;
  const pending = loading(attn) || loading(prom);
  const failedSources = [
    !loading(attn) && !attnOk ? { what: 'the attention queue', why: attn.line } : null,
    !loading(prom) && !promOk ? { what: 'your promises', why: prom.line } : null,
  ].filter(Boolean);
  // A source that answered from old data (kept last-good) or with partial coverage.
  const dated = (attnOk && attn.state === 'stale') || (promOk && prom.state === 'stale');
  const partialCoverage = (attnOk && attn.coverage) || (promOk && prom.coverage);
  const incomplete = pending || failedSources.length > 0 || dated || Boolean(partialCoverage);
  const details = [
    ...(attnOk && attn.details ? attn.details : []),
    waitingStale.length ? `${plural(waitingStale.length, 'older promise')} waiting on you untouched for ${STALE_DAYS}+ days (under See all).` : null,
    ...failedSources.map((f) => `Couldn't read ${f.what}: ${String(f.why || '').replace(/^Couldn't read [^:]*: /, '')}`),
    attnOk && attn.missing ? `The attention queue had no answer from ${attn.missing}.` : null,
    promOk && prom.coverage && prom.note ? `Promises: ${prom.note}` : null,
    dated ? 'Some of this is from an earlier reading.' : null,
  ].filter(Boolean);
  const all = [...current, ...attnStale, ...waitingStale];
  const base = { count, pending, rows: current.slice(0, MAX_ROWS), all, details, fromQueue: attnCurrent.length, fromPromises: waiting.length };
  // Face line: only what changes what the operator should conclude. The headline already
  // says "There may be more." for partial coverage, so the card does not repeat it.
  if (!pending && !failedSources.length && !(attnOk && attn.line) && (dated || partialCoverage)) details.push('Some machines may not be shown, so there may be more.');
  const faceLine = pending ? (loading(attn) ? 'Still checking the attention queue…' : 'Still checking your promises…')
    : failedSources.length ? `Couldn't read ${failedSources.map((f) => f.what).join(' or ')}, so there may be more.`
    : (attnOk && attn.line) ? attn.line : '';
  if (count > 0) {
    return { ...base, state: incomplete ? 'partial' : 'attn', coverage: incomplete ? 'partial view' : null,
      value: plural(count, 'thing', 'things'), valueTone: 'attn', line: faceLine };
  }
  if (pending) return { ...base, state: 'loading', value: 'Still checking', line: faceLine };
  if (failedSources.length === 2) return { ...base, state: 'unknown', value: "Can't tell", line: "Couldn't read the attention queue or your promises." };
  if (incomplete) return { ...base, state: failedSources.length ? 'unknown' : 'partial', coverage: 'partial view', value: failedSources.length ? "Can't tell" : 'Nothing I can see', line: faceLine };
  return { ...base, state: 'ok', coverage: null, value: 'Nothing needs you', line: '' };
}

// ── 3. What I'm doing ─────────────────────────────────────────────────────
/**
 * A generated session name, shortened for a list: a run id made of hex chunks
 * ("feedback-feedback-b26e90ab-3a37-4-828b1f71-a2") becomes "feedback b26e90ab";
 * a name a person wrote is left alone. The full name stays in the session's Details.
 */
export function shortName(name) {
  const n = String(name || '').trim();
  const parts = n.split('-');
  const hexish = (w) => /^[0-9a-f]{4,}$/i.test(w) || /^\d+$/.test(w) || (/^[0-9a-f]{1,3}$/i.test(w) && parts.length > 4);
  const firstHex = parts.findIndex((w) => /^[0-9a-f]{6,}$/i.test(w));
  if (firstHex < 1 || parts.slice(firstHex).filter(hexish).length < 2) return n;
  const words = [...new Set(parts.slice(0, firstHex).filter((w) => !hexish(w)))];
  return `${words.join(' ')} ${parts[firstHex].slice(0, 8)}`.trim();
}

/** Strip machine prefixes and bracketed bootstrap noise from a session name. */
export function sessionLabel(s) {
  const name = shortName(String((s && (s.name || s.tmuxSession)) || 'A session').replace(/^\[.*?\]\s*/, '').trim());
  return name.length > 80 ? name.slice(0, 77) + '…' : name;
}

export function buildDoing(res, now = Date.now()) {
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
  const partialLine = failed.length ? `No answer from ${failed.map((f) => f.nickname || f.machineNickname || f.machineId).join(', ')}.` : '';
  if (live.length === 0) {
    // "Idle" is only claimed when every machine answered.
    return { state: failed.length ? 'partial' : 'ok', coverage: failed.length ? 'partial view' : null, value: failed.length ? 'Nothing running that I can see' : 'Idle', line: partialLine, rows };
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
  const violated = list.filter((c) => isMissed(c, now) && !waitsOnOperator(c));
  const rest = open.filter((c) => fresh(c) && !waitsOnOperator(c) && !isMissed(c, now)).length;
  const olderCarried = open.filter((c) => !fresh(c) && !waitsOnOperator(c) && !isMissed(c, now)).length;
  // The face is one plain sentence; the full promise text, what you asked and the id sit behind the tap.
  const fullOf = (c) => [c.agentResponse ? `I said: ${c.agentResponse}` : null, c.userRequest ? `You asked: ${c.userRequest}` : null, c.id ? `Promise ${c.id}` : null].filter(Boolean).join('\n\n');
  const toRow = (c, tone) => ({
    key: `${c.originMachineId || 'own'}:${c.id}`,
    detail: fullOf(c),
    expandable: true,
    main: briefOf(c.agentResponse || c.userRequest) || 'A promise',
    sub: [c.blockedOn && c.blockedOn !== 'none' ? `waiting on ${String(c.blockedOn).replace('user-', 'your ')}` : (c.status === 'violated' ? 'missed' : ''),
      c.viewSource === 'replica' && c.originMachineId ? `from another machine, ${Number.isFinite(Number(c.stalenessMs)) && c.stalenessMs !== null ? `as of ${ago(now - c.stalenessMs, now)}` : 'age unknown'}` : ''].filter(Boolean).join(' · '),
    end: ago(c.createdAt, now) || '',
    tone,
  });
  // Promises waiting on the operator are listed under "What needs you" (combineNeeds),
  // never counted a second time here.
  const waitLabel = (c) => (c.blockedOn === 'user-authorization' ? 'Needs your approval' : 'Needs your answer');
  const replicaNote = (c) => (c.viewSource === 'replica' && c.originMachineId ? `from another machine, ${Number.isFinite(Number(c.stalenessMs)) && c.stalenessMs !== null ? `as of ${ago(now - c.stalenessMs, now)}` : 'age unknown'}` : '');
  const waitRow = (c, stale) => ({
    key: `promise:${c.originMachineId || 'own'}:${c.id}`, stale,
    main: briefOf(c.agentResponse || c.userRequest) || 'A promise',
    sub: [waitLabel(c), replicaNote(c), stale ? `untouched ${STALE_DAYS}+ days` : ''].filter(Boolean).join(' · '),
    end: ago(c.createdAt, now) || '',
    tone: stale ? 'unknown' : 'attn',
    detail: fullOf(c),
    expandable: true,
  });
  const waiting = yours.map((c) => waitRow(c, false));
  const waitingStale = yoursAll.filter((c) => !fresh(c)).map((c) => waitRow(c, true));
  const carried = open.filter((c) => !waitsOnOperator(c) && !isMissed(c, now))
    .sort((a, b) => Number(!fresh(a)) - Number(!fresh(b)) || Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .map((c) => ({ ...toRow(c, fresh(c) ? undefined : 'unknown'), ...(fresh(c) ? {} : { sub: [toRow(c).sub, `untouched ${STALE_DAYS}+ days`].filter(Boolean).join(' · ') }) }));
  const all = [...violated.map((c) => toRow(c, 'bad')), ...carried];
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
  // The face points at "What needs you" for the waiting ones; it never competes with its count.
  const line = [
    yours.length ? `${yours.length === 1 ? 'One is' : `${yours.length} of them are`} waiting on you, listed under What needs you.` : null,
    violated.length ? `${violated.length} missed.` : null,
  ].filter(Boolean).join(' ');
  const details = [
    rest > 0 ? `${plural(rest, 'other')} I'm carrying.` : null,
    olderCarried + yoursStale > 0 ? `${olderCarried + yoursStale} older ones untouched for ${STALE_DAYS}+ days.` : null,
    coverage,
  ].filter(Boolean);
  const incomplete = origins.size === 0 || staleReplica || missingPeers === null || missingPeers > 0;
  const state = violated.length ? 'bad' : (incomplete ? 'partial' : 'ok');
  return {
    state, waitingCount: yours.length, waiting, waitingStale,
    coverage: incomplete ? 'partial view' : null,
    value: open.length ? plural(open.length, 'open promise') : (incomplete ? 'None I can see' : 'Nothing open'),
    line, note: coverage, details, rows: all.slice(0, MAX_ROWS), all,
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
  if (machines.length === 0) return unknownCard('The pool lists no machines.');
  const ms = machines.map((m) => ({ name: m.nickname || m.machineId, ...machineState(m, now) }));
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
    line: counts.ok === ms.length ? '' : parts.join(' · ') + '.',
    machines: ms,
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
  // Permission slips are reference, not action: one tap deeper unless unreadable.
  if (mandates === null) rows.push({ main: "Can't tell which permission slips are active", tone: 'unknown' });
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
    line: '',
    details: [`${dry} watching only, ${offDark} off by design.`, mandates === null ? null : `${plural(mandates, 'permission slip')} active.`].filter(Boolean),
    rows: rows.slice(0, MAX_ROWS),
    meter: { ok: on, dry, warn: offWrong, off: offDark },
  };
}

// ── The headline ──────────────────────────────────────────────────────────
/**
 * One sentence over all six cards. The count is read from the "What needs you"
 * card (combineNeeds) and nowhere else, so the two always agree. Never says
 * "all quiet" while a card can't tell. The sub-line carries only what the
 * operator should act on, never coverage housekeeping.
 */
export function headline(cards) {
  const list = Object.values(cards).filter(Boolean);
  const needs = cards.needs;
  const bad = list.filter((c) => c.state === 'bad').length;
  const blind = list.filter((c) => c.state === 'unknown' || c.state === 'partial' || c.state === 'stale' || c.coverage).length;
  const otherAttn = Object.entries(cards).filter(([k, c]) => c && c.state === 'attn' && k !== 'needs').length;
  const loading = list.filter((c) => c.state === 'loading').length;
  // Never announce a count, or "all quiet", before the counting card has heard from every source.
  if (!needs || loading === list.length || needs.state === 'loading' || needs.pending) return { text: 'Checking in…', tone: 'muted' };
  const count = Number.isFinite(needs.count) ? needs.count : 0;
  const quals = [];
  if (bad) quals.push(`${plural(bad, 'area')} failing`);
  if (otherAttn) quals.push(`${plural(otherAttn, 'other area')} to look at`);
  const qual = quals.length ? quals.join(', ').replace(/^./, (c) => c.toUpperCase()) + '.' : null;
  if (count > 0) {
    // A known count may be an undercount when its own card is incomplete: say so in four words.
    const maybeMore = needs.state === 'partial' || needs.coverage ? 'There may be more.' : null;
    return { text: count === 1 ? 'One thing needs you.' : `${count} things need you.`, tone: 'attn', sub: [qual, maybeMore].filter(Boolean).join(' ') || null };
  }
  if (bad) return { text: bad === 1 ? 'Something is failing.' : `${bad} areas are failing.`, tone: 'bad', sub: qual };
  if (otherAttn) return { text: otherAttn === 1 ? 'One area needs a look.' : `${otherAttn} areas need a look.`, tone: 'attn', sub: qual };
  // "Quiet" is only claimed, and only painted teal, when every card is observed and settled.
  if (blind) return { text: 'Nothing urgent that I can see.', tone: 'muted', sub: null };
  return { text: 'All quiet.', tone: 'ok', sub: null };
}

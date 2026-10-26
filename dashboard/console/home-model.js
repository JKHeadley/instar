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

// The counting rules live in shared-counts.js (one source for every page); this
// file re-exports the ones other pages import from here so nothing breaks.
import {
  ago, plural, STALE_DAYS, readState,
  needsOperator, groupKey, attentionNeeds,
  waitsOnOperator, isActiveCommitment, lastTouched, isMissed, sortPromises, promiseNeed,
  guardsNeedingLook, needsYou, accountNeeds as accountNeedsOf, prsNeedingYou,
  machineState, liveState, machineLabel, LIVE_MS, STALE_MS,
} from './shared-counts.js';
export { ago, STALE_DAYS, needsOperator, groupKey, waitsOnOperator, isActiveCommitment, lastTouched, isMissed, machineState, LIVE_MS, STALE_MS };

export const FRESH_MS = 5 * 60 * 1000;
export const MAX_ROWS = 3;

/** A fetch outcome: { ok:true, data } | { ok:false, reason }. */
export function failure(reason) { return { ok: false, reason: String(reason || 'no answer') }; }

export function unknownCard(reason, extra = {}) {
  return { state: 'unknown', value: "Can't tell", line: reason, rows: [], ...extra };
}

/** "for 12 min", "for 3 h". */
export function duration(ts, now = Date.now()) {
  const a = ago(ts, now);
  if (!a || a === 'just now') return a === 'just now' ? 'just started' : null;
  return 'for ' + a.replace(' ago', '');
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
  return { state: 'ok', value: 'No replies held', line: '', rows, age, details: ['Checked on this machine.'] };
}

// ── 2. What needs you ─────────────────────────────────────────────────────
export function buildNeeds(res, now = Date.now(), names = null) {
  if (!res.ok) return unknownCard(`Couldn't read the attention queue: ${res.reason}.`);
  const items = Array.isArray(res.data && res.data.items) ? res.data.items : null;
  if (!items) return unknownCard('The attention queue answered without a list.');
  // One rule for who needs the operator and how repeats fold (shared-counts.attentionNeeds).
  const { all, current, routine } = attentionNeeds(items, now);
  const stale = all.length - current.length;
  const rows = current.slice(0, MAX_ROWS);
  const failed = (res.data.pool && Array.isArray(res.data.pool.failed)) ? res.data.pool.failed : [];
  const partial = failed.length > 0;
  const missing = failed.map((f) => machineLabel(f, names)).join(', ');
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
 * Sign-in repairs waiting on the operator's TAP, as a needs-you source for Home.
 * poolRes: /subscription-pool?scope=pool; reloginRes: /subscription-relogin?scope=pool.
 * An expired login the agent is repairing is NOT counted (rule c); it is reported
 * in `expired` for the card's details.
 */
export function buildAccountNeeds(poolRes, reloginRes, now = Date.now()) {
  const ps = readState(poolRes);
  if (ps === 'loading') return { state: 'loading', items: [] };
  if (ps === 'off' || (ps === 'ok' && poolRes.data && poolRes.data.enabled === false)) return { state: 'off', items: [], reason: 'the account pool is not set up on this agent' };
  if (ps === 'failed') return { state: 'failed', items: [], reason: poolRes.reason };
  const rows = Array.isArray(poolRes.data && poolRes.data.accounts) ? poolRes.data.accounts : null;
  if (!rows) return { state: 'failed', items: [], reason: 'the account pool answered without accounts' };
  const rs = readState(reloginRes);
  if (rs === 'loading') return { state: 'loading', items: [] };
  const episodes = rs === 'ok' && Array.isArray(reloginRes.data && reloginRes.data.episodes) ? reloginRes.data.episodes : [];
  const unavailable = rs === 'ok' && reloginRes.data && reloginRes.data.pool && Array.isArray(reloginRes.data.pool.unavailable) ? reloginRes.data.pool.unavailable.map((u) => u.machineId) : [];
  const needs = accountNeedsOf(rows, episodes, { unavailable, now });
  // A failed relogin read means a tap could be waiting unseen: the count stands, the source is marked.
  return { state: rs === 'failed' ? 'failed' : 'ok', items: needs.tap, expired: needs.expired, repairing: needs.repairing, machines: needs.machines, reason: rs === 'failed' ? `sign-in repairs: ${reloginRes.reason}` : undefined, partial: rs === 'failed' };
}

/** PRs waiting for the operator's review on GitHub, as a needs-you source for Home (/green-pr-automerge; 503 = not a maintainer agent). */
export function buildPrNeeds(res, now = Date.now()) {
  const st = readState(res);
  if (st === 'loading') return { state: 'loading', items: [] };
  if (st === 'off') return { state: 'off', items: [], reason: 'the merge watcher is off on this agent' };
  if (st === 'failed') return { state: 'failed', items: [], reason: res.reason };
  return { state: 'ok', items: prsNeedingYou(res.data || {}, now) };
}

/**
 * The "What needs you" card: ONE list of everything the headline counts as
 * needing the operator — attention items, promises waiting on the operator,
 * sign-in repairs waiting on a tap, and PRs waiting for the operator's review —
 * deduplicated by shared-counts.needsYou. The headline reads its count from this
 * card, so the two can never disagree. `attn` is buildNeeds' model, `prom` is
 * buildPromised's, `extra.accounts` / `extra.prs` are buildAccountNeeds' /
 * buildPrNeeds'; any may be { state: 'loading' } while its source has not answered.
 */
export function combineNeeds(attn, prom, extra = {}) {
  attn = attn || { state: 'loading' };
  prom = prom || { state: 'loading' };
  const accounts = extra.accounts || { state: 'off', items: [] };
  const prs = extra.prs || { state: 'off', items: [] };
  const loading = (m) => m.state === 'loading';
  const readable = (m) => !loading(m) && m.state !== 'unknown' && Number.isFinite(m.count ?? m.waitingCount);
  const attnOk = readable(attn) && Array.isArray(attn.all);
  const promOk = !loading(prom) && prom.state !== 'unknown' && Array.isArray(prom.waiting);
  const list = needsYou({
    attention: loading(attn) ? { state: 'loading' } : attnOk ? { state: 'ok', items: attn.all } : { state: 'failed', reason: attn.line },
    promises: loading(prom) ? { state: 'loading' } : promOk ? { state: 'ok', items: [...prom.waiting, ...(prom.waitingStale || [])] } : { state: 'failed', reason: prom.line },
    accounts, prs,
  });
  const count = list.count;
  const pending = list.pending.length > 0;
  const failedSources = list.failed.map((f) => ({ what: f.what, why: f.why }));
  // A source that answered from old data (kept last-good) or with partial coverage.
  const dated = (attnOk && attn.state === 'stale') || (promOk && prom.state === 'stale');
  const partialCoverage = (attnOk && attn.coverage) || (promOk && prom.coverage) || accounts.partial;
  const incomplete = pending || failedSources.length > 0 || dated || Boolean(partialCoverage);
  const waitingStale = list.stale.filter((r) => r.kind === 'promise');
  const expired = Array.isArray(accounts.expired) ? accounts.expired : [];
  const details = [
    ...(attnOk && attn.details ? attn.details : []),
    waitingStale.length ? `${plural(waitingStale.length, 'older promise')} waiting on you untouched for ${STALE_DAYS}+ days (under See all).` : null,
    expired.length ? `${plural(expired.length, 'sign-in')} expired on ${accounts.machines.join(' and ')} — mine to repair, not yours${accounts.repairing ? ` (${accounts.repairing} repairing)` : ''}.` : null,
    ...failedSources.map((f) => `Couldn't read ${f.what}: ${String(f.why || '').replace(/^Couldn't read [^:]*: /, '')}`),
    attnOk && attn.missing ? `The attention queue had no answer from ${attn.missing}.` : null,
    promOk && prom.coverage && prom.note ? `Promises: ${prom.note}` : null,
    dated ? 'Some of this is from an earlier reading.' : null,
  ].filter(Boolean);
  const all = [...list.items, ...list.stale];
  const byKind = list.byKind;
  const base = { count, pending, rows: list.items.slice(0, MAX_ROWS), all, details, byKind, label: list.label,
    fromQueue: list.items.filter((r) => r.kind === 'attention').length, fromPromises: list.items.filter((r) => r.kind === 'promise').length,
    fromAccounts: list.items.filter((r) => r.kind === 'account').length, fromPrs: list.items.filter((r) => r.kind === 'pr').length };
  // Face line: only what changes what the operator should conclude. A mixed list says what kinds.
  const kinds = Object.keys(byKind).length > 1 ? list.label.replace(/^[^:]*: /, '').replace(/^./, (c) => c.toUpperCase()) + '.' : '';
  const faceLine = pending ? (list.pending[0] === 'attention' ? 'Still checking the attention queue…' : list.pending[0] === 'promises' ? 'Still checking your promises…' : 'Still checking…')
    : failedSources.length ? `Couldn't read ${failedSources.map((f) => f.what).join(' or ')}, so there may be more.`
    : (attnOk && attn.line) ? attn.line
    : (dated || partialCoverage) ? [kinds, 'Some machines may not be shown, so there may be more.'].filter(Boolean).join(' ') : kinds;
  if (count > 0) {
    return { ...base, state: incomplete ? 'partial' : 'attn', coverage: incomplete ? 'partial view' : null,
      value: plural(count, 'thing', 'things'), valueTone: 'attn', line: faceLine };
  }
  if (pending) return { ...base, state: 'loading', value: 'Still checking', line: faceLine };
  if (failedSources.length >= 2 && !attnOk && !promOk) return { ...base, state: 'unknown', value: "Can't tell", line: "Couldn't read the attention queue or your promises." };
  if (incomplete) return { ...base, state: failedSources.length ? 'unknown' : 'partial', coverage: 'partial view', value: failedSources.length ? "Can't tell" : 'Nothing I can see', line: faceLine };
  return { ...base, state: 'ok', coverage: null, value: 'Nothing needs you', line: '' };
}

// ── 3. What I'm doing ─────────────────────────────────────────────────────
/** Strip machine prefixes and bracketed bootstrap noise from a session name. */
export function sessionLabel(s) {
  const name = String((s && (s.name || s.tmuxSession)) || 'A session').replace(/^\[.*?\]\s*/, '').trim();
  return name.length > 80 ? name.slice(0, 77) + '…' : name;
}

export function buildDoing(res, now = Date.now(), names = null) {
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
  const partialLine = failed.length ? `No answer from ${failed.map((f) => machineLabel(f, names)).join(', ')}.` : '';
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
export const REPLICA_FRESH_MS = 15 * 60 * 1000;

/**
 * The card reads shared-counts.sortPromises: the SAME partition the Promises page
 * renders, so "N open promises" here equals that page's headline total, and
 * "See all N" lists exactly its missed + due-soon + carrying rows (newest first).
 * Promises untouched for 14+ days are "older": counted in Details only.
 */
export function buildPromised(res, now = Date.now(), expectedPeers = null) {
  if (!res.ok) return unknownCard(`Couldn't read commitments: ${res.reason}.`);
  if (res.data && res.data.enabled === false) return unknownCard('Commitment tracking is switched off on this agent.');
  const list = Array.isArray(res.data && res.data.commitments) ? res.data.commitments
    : (Array.isArray(res.data) ? res.data : null);
  if (!list) return unknownCard('Commitments answered without a list.');
  const s = sortPromises(list, now);
  const n = s.counts;
  const toRow = (c, tone) => ({
    key: `${c.originMachineId || 'own'}:${c.id}`,
    detail: c.userRequest && c.agentResponse ? `You asked: ${c.userRequest}` : '',
    expandable: true,
    main: c.agentResponse || c.userRequest || c.id,
    sub: [c.blockedOn && c.blockedOn !== 'none' ? `waiting on ${String(c.blockedOn).replace('user-', 'your ')}` : (isMissed(c, now) ? 'missed' : ''),
      c.viewSource === 'replica' && c.originMachineId ? `from another machine, ${Number.isFinite(Number(c.stalenessMs)) && c.stalenessMs !== null ? `as of ${ago(now - c.stalenessMs, now)}` : 'age unknown'}` : ''].filter(Boolean).join(' · '),
    end: ago(c.createdAt, now) || '',
    tone,
  });
  // Promises waiting on the operator are listed under "What needs you" (combineNeeds),
  // never counted a second time here.
  const waiting = s.waiting.map((c) => promiseNeed(c, now));
  const waitingStale = s.olderWaiting.map((c) => promiseNeed(c, now, { stale: true }));
  const olderCarried = n.older - n.olderWaiting;
  const all = [...s.missed.map((c) => toRow(c, 'bad')), ...s.dueSoon.map((c) => toRow(c)), ...s.carrying.map((c) => toRow(c))];
  const open = all.length + waiting.length;   // = n.open: waiting + missed + dueSoon + carrying
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
    n.waiting ? `${n.waiting === 1 ? 'One is' : `${n.waiting} of them are`} waiting on you, listed under What needs you.` : null,
    n.missed ? `${n.missed} missed.` : null,
  ].filter(Boolean).join(' ');
  const details = [
    n.carrying + n.dueSoon > 0 ? `${plural(n.carrying + n.dueSoon, 'other')} I'm carrying${n.dueSoon ? `, ${n.dueSoon} due within a day` : ''}.` : null,
    n.older > 0 ? `${n.older} older ones untouched for ${STALE_DAYS}+ days${n.olderWaiting ? ` (${n.olderWaiting} waiting on you)` : ''}, under Older, still open on the Promises page.` : null,
    coverage,
  ].filter(Boolean);
  void olderCarried;
  const incomplete = origins.size === 0 || staleReplica || missingPeers === null || missingPeers > 0;
  const state = n.missed ? 'bad' : (incomplete ? 'partial' : 'ok');
  return {
    state, waitingCount: n.waiting, waiting, waitingStale, counts: n,
    coverage: incomplete ? 'partial view' : null,
    value: open ? plural(open, 'open promise') : (incomplete ? 'None I can see' : 'Nothing open'),
    line, note: coverage, details, rows: all.slice(0, MAX_ROWS), all,
  };
}

// ── 5. Where I'm running ──────────────────────────────────────────────────
// machineState / liveState / the load reading live in shared-counts.js: the Machines
// page reads the same functions, so the two can never disagree on a machine's state.
export function buildRunning(res, now = Date.now()) {
  if (!res.ok) return unknownCard(`Couldn't read the machine pool: ${res.reason}.`);
  const machines = Array.isArray(res.data && res.data.machines) ? res.data.machines : null;
  if (!machines) {
    if (res.data && res.data.enabled === false) return { state: 'ok', value: 'One machine', line: 'This agent runs on a single machine.', machines: [] };
    return unknownCard('The pool answered without a machine list.');
  }
  if (machines.length === 0) return unknownCard('The pool lists no machines.');
  const ms = machines.map((m) => ({ name: m.nickname || m.machineId, ...liveState(m, now) }));
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
  // THE count of checks needing a look (shared-counts.guardsNeedingLook): the same
  // rule and the same rows the Machines and Allowed pages show, scope stated.
  const look = guardsNeedingLook(guardsRes, { scope: 'local' });
  const rows = [];
  if (look.ok && look.count) rows.push({ main: `${plural(look.count, 'safety check')} need${look.count === 1 ? 's' : ''} a look ${look.scopeWords}`, sub: look.breakdownWords, tone: 'attn' });
  // Permission slips are reference, not action: one tap deeper unless unreadable.
  if (mandates === null) rows.push({ main: "Can't tell which permission slips are active", tone: 'unknown' });
  const all = look.ok ? look.rows.map((r) => ({ main: r.main, sub: r.record.criticalPath ? r.guardKey : '', end: r.word, tone: 'attn', mono: true })) : [];
  return {
    state: look.ok && look.count ? 'attn' : (mandates === null ? 'partial' : 'ok'),
    coverage: mandates === null ? 'partial view' : null,
    value: `${on} of ${total} on`, all, needLook: look.ok ? look.count : null, scopeWords: look.ok ? look.scopeWords : null,
    line: '',
    details: [`${dry} watching only, ${offDark} off by design.`, mandates === null ? null : `${plural(mandates, 'permission slip')} active.`].filter(Boolean),
    rows: rows.slice(0, MAX_ROWS),
    meter: { ok: on, dry, warn: look.ok ? look.count : offWrong + gaps, off: offDark },
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

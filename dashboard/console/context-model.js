// Settings → Context: pure view model (docs/specs/context-budget-layered-summaries.md §11, Phase 1 S14).
// What each conversation's running summary holds, how fresh it is, what it costs, and whether
// recovery after a long conversation is compressed actually works on this machine. Reads four
// routes; any of them may be switched off (503) or not on this version (404), and the page then
// says so in plain words, never as an error or a blank. No DOM here; every string is plain text.

import { fmtTokens } from './costs-model.js';

/** How the console's reader answered: ok, switched off here, not on this version, or failed. */
export function readState(res) {
  if (!res) return 'failed';
  if (res.ok) return 'ok';
  if (res.status === 503 || /switched off/i.test(String(res.reason || ''))) return 'off';
  if (res.status === 404 || /answered 404/.test(String(res.reason || ''))) return 'absent';
  return 'failed';
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || `${one}s`)}`;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const pct = (share) => `${Math.round(share * 100)}%`;

export function fmtBytes(n) {
  const v = num(n);
  if (v === null) return null;
  if (v < 1024) return `${v} bytes`;
  if (v < 1024 * 1024) return `${Math.round(v / 1024)} KB`;
  if (v < 1024 ** 3) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  return `${(v / 1024 ** 3).toFixed(1)} GB`;
}

export function agoWords(ms, now) {
  const t = num(ms);
  if (t === null) return null;
  const m = Math.floor(Math.max(0, now - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} days ago`;
}

const ENGINE_WORDS = { 'claude-code': 'Claude Code', codex: 'Codex', 'gemini-cli': 'Gemini', 'grok-build': 'Grok' };
export const engineWord = (e) => ENGINE_WORDS[e] || 'Another AI app';

/** A topic's display name, never its routing id. */
export function topicWord(key, names, fallback = 'a conversation') {
  const n = names && names[String(key)];
  return n || fallback;
}

/** First-use definitions, shown at the top of their sections. */
export const RECOVERY_INTRO = 'A compression is when a long conversation is squeezed to fit what the AI can hold at once. Afterwards I put the important context back; this checks that it really arrives.';
export const WATCHER_INTRO = 'The watcher looks at every conversation on this machine every few minutes: whether its summary is current, and whether a memory refresh (replacing a long session with a fresh one that starts from the summary) got stuck.';

/**
 * Past this a stuck refresh is no longer the watcher's own short wait (§9.3 reconciliation bound).
 * A copy of QUARANTINE_RECONCILE_BOUND_MS in src/monitoring/ContextBudgetSentinel.ts: the watcher's
 * status does not report the bound it runs with (its `reconcileBoundMs` option, not overridden in
 * production), and the console cannot import server code. Keep the two equal.
 */
export const STUCK_AFTER_MS = 15 * 60_000;

/** "Claude Code 2.1.321", or just the app when its version is unknown. */
export function appWord(g) {
  return `${engineWord(g.engine)}${g.version && g.version !== 'unknown' ? ` ${g.version}` : ''}`;
}

/** One compression-recovery check group, in words. */
export function canaryLine(g) {
  const who = appWord(g);
  const failed = Math.max(0, (Number(g.detected) || 0) - (Number(g.complete) || 0) - (Number(g.pending) || 0));
  switch (g.state) {
    case 'healthy': return { tone: 'ok', text: `${who}: recovery works. Checked on ${plural(g.complete, 'compression')}.` };
    case 'accruing': return { tone: 'unknown', text: `${who}: looks right so far (${g.complete} checked); not enough compressions yet to call it proven.` };
    // warning-path: pageHead
    case 'diverged': return { tone: 'attn', text: `${who}: ${plural(failed || 1, 'compression')} came back without the context I put back. Recovery is not working here.` };
    case 'uninitialized': return { tone: 'unknown', text: `${who}: no compression seen yet, so recovery is not checked yet.` };
    case 'n/a': return { tone: 'muted', text: `${who}: putting context back after a compression is switched off here.` };
    default: return { tone: 'unknown', text: `${who}: can’t tell.` };
  }
}

/** Is this the watcher's status shape at all? */
export function sentinelShapeOk(d) {
  return Boolean(d && typeof d === 'object' && Array.isArray(d.quarantined) && Array.isArray(d.torn));
}

/** The watcher has ticked before but its heartbeat is stale: what it last reported may be out of date. */
export function watcherStale(d) {
  return sentinelShapeOk(d) && d.lastTickAt !== null && d.lastTickAt !== undefined && d.heartbeatFresh === false;
}

/**
 * What needs the operator, from the watcher's status alone (the Home count reads only this).
 * Returns null when the answer is not the expected shape, or when the watcher has stopped
 * checking in: both are "can't tell", never "nothing". Each row carries `ref`, the fold id the
 * watcher's own Attention notice names, so Home counts one incident once.
 */
export function contextNeeds(sentinelData, names = {}, now = Date.now()) {
  if (!sentinelShapeOk(sentinelData) || watcherStale(sentinelData)) return null;
  return listNeeds(sentinelData, names, now);
}

/** The needs in a status of the right shape, whatever its heartbeat (the page shows them as last known). */
export function listNeeds(d, names = {}, now = Date.now()) {
  const out = [];
  for (const q of d.quarantined) {
    if (!q || typeof q !== 'object' || !(num(q.ageMs) > STUCK_AFTER_MS)) continue;
    const gaveUp = typeof q.lastOutcome === 'string' && q.lastOutcome.startsWith('exhausted');
    out.push({
      key: `stuck:${q.topicKey}:${q.foldId}`,
      ref: q.foldId,
      title: `A memory refresh is stuck in ${topicWord(q.topicKey, names)}`,
      detail: `A memory refresh swaps a long session for a fresh one that starts from its summary. This one started ${agoWords(now - q.ageMs, now) || 'a while ago'}. New messages to that conversation are held until it settles. ${gaveUp ? 'I could not confirm the old session stopped, so it stays paused.' : 'It has not settled within its time limit.'}`,
      ask: 'A conversation memory refresh is stuck and its messages are held',
    });
  }
  for (const t of d.torn) {
    if (!t || typeof t !== 'object') continue;
    out.push({
      key: `torn:${t.topicKey}:${t.foldId}`,
      ref: t.foldId,
      title: `A memory refresh record in ${topicWord(t.topicKey, names)} cannot be read`,
      detail: 'A memory refresh swaps a long session for a fresh one that starts from its summary. I keep that conversation paused safely rather than guess how far this one got.',
      ask: 'A conversation memory refresh record cannot be read',
    });
  }
  // One row per machine, however many app versions diverged: it is one condition for the operator.
  const groups = d.canary && Array.isArray(d.canary.groups) ? d.canary.groups : [];
  const byMachine = new Map();
  for (const g of groups) {
    if (!g || g.state !== 'diverged') continue;
    const k = String(g.machine || 'this-machine');
    byMachine.set(k, [...(byMachine.get(k) || []), appWord(g)]);
  }
  for (const [machine, apps] of byMachine) {
    out.push({
      key: `canary:${machine}`,
      title: 'Recovery after a long conversation is compressed is not working on this machine',
      detail: `Affected: ${[...new Set(apps)].join(', ')}. A conversation that gets compressed may lose what we were working on. I will not shorten any context on this machine until it works again.`,
      ask: 'Recovery after a conversation is compressed is not working',
    });
  }
  return out;
}

function freshnessWords(row) {
  if (!row) return null;
  const s = row.h1 && row.h1.stale;
  if (s === false) return { tone: 'ok', text: 'summary up to date' };
  if (s === true) return { tone: 'unknown', text: num(row.h1.userTurnsBehind) ? `summary behind by ${plural(row.h1.userTurnsBehind, 'of your messages', 'of your messages')}` : 'summary behind' };
  return { tone: 'unknown', text: 'can’t tell if the summary is current' };
}

/** One conversation's row: main = its name; sub = the plain facts. */
export function topicRow(t, fresh, names) {
  const bits = [];
  const f = freshnessWords(fresh);
  if (f) bits.push(f.text);
  // The row keeps three facts; sizes and counts are in the detail.
  if (t.cost && !t.cost.unavailable && num(t.cost.perRequest && t.cost.perRequest.allInWeighted)) bits.push(`about ${fmtTokens(t.cost.perRequest.allInWeighted)} tokens a turn`);
  const share = t.operatorVerbatimShare && num(t.operatorVerbatimShare.share);
  if (share !== null) bits.push(`${pct(share)} of your messages still word for word`);
  return {
    key: `topic:${t.topicId}`,
    main: topicWord(t.topicId, names, 'Conversation name unavailable'),
    sub: bits.join(' · '),
    tone: f ? f.tone : 'ok',
    detail: topicDetail(t, fresh),
  };
}

function topicDetail(t, fresh) {
  const lines = [];
  const f = freshnessWords(fresh);
  lines.push({ label: 'Running summary', text: f ? f.text : 'not checked on this machine (no live session here)' });
  lines.push({ label: 'Stored here', text: `summary ${fmtBytes(t.layerBytes) || 'none'}; saved transcript ${fmtBytes(t.archiveBytes) || 'none'}` });
  if (t.cost && !t.cost.unavailable) {
    const per = num(t.cost.perRequest && t.cost.perRequest.allInWeighted);
    lines.push({ label: 'Cost', text: `${plural(t.cost.requests, 'turn')} across ${plural(t.cost.sessions, 'session')}: about ${fmtTokens(t.cost.allInWeighted)} tokens in all${per !== null ? `, ${fmtTokens(per)} a turn` : ''}` });
  } else lines.push({ label: 'Cost', text: 'no session of it ran here in this window' });
  if (t.rework && !t.rework.unavailable) {
    lines.push({ label: 'Repeated work', text: t.rework.status === 'pending' ? 'still counting: the usage reader is catching up'
      : num(t.rework.rate) !== null ? `${pct(t.rework.rate)} of tool steps repeated work already done in the 30 turns before` : 'no tool steps yet' });
  }
  if (t.u && !t.u.unavailable) lines.push({ label: 'Your words', text: `${plural(t.u.messages, 'message')} (about ${fmtTokens(t.u.estimatedTokens)} tokens); none of them is ever summarised away` });
  const share = t.operatorVerbatimShare && num(t.operatorVerbatimShare.share);
  if (share !== null) lines.push({ label: 'Still in view', text: `${pct(share)} of your messages are word for word in the newest session${t.operatorVerbatimShare.compactions ? `, after ${plural(t.operatorVerbatimShare.compactions, 'compression')}` : ''}` });
  return lines;
}

/** The trial of sending only what changed with each message (delta shadow). */
export function trialLines(res) {
  const st = readState(res);
  if (st === 'off') return { state: 'off', lines: ['The trial is switched off on this machine.'] };
  if (st === 'absent') return { state: 'absent', lines: ['This version does not run the trial yet.'] };
  if (st === 'failed') return { state: 'failed', lines: [`Couldn’t read the trial: ${res && res.reason ? res.reason : 'no answer'}.`] };
  const d = res.data || {};
  const r = d.reduction || {};
  const live = Boolean(r.allowed && r.switchOn);
  const lines = [];
  const prompts = Number(d.prompts) || 0;
  if (!prompts) lines.push('No messages measured yet.');
  else {
    const full = d.fullChars && num(d.fullChars.median);
    const delta = d.deltaChars && num(d.deltaChars.median);
    const smaller = full && delta !== null && full > 0 ? Math.round((1 - delta / full) * 100) : null;
    const size = smaller === null ? '' : smaller > 0 ? `Sending only what changed would be about ${smaller}% smaller on a typical message.` : 'Sending only what changed would be no smaller on a typical message.';
    lines.push(`${plural(prompts, 'message')} measured. ${size}`.trim());
    if (d.omittedItems) lines.push(`${plural(d.omittedItems, 'item')} ${live ? 'were' : 'would have been'} left out; whether a session went back for one can’t be told yet.`);
  }
  lines.push(live ? 'It is on: sessions here get only what changed.'
    : !r.switchOn ? 'Measuring only: every message still carries the full briefing (the conversation summary and recent messages each session gets with your message).'
      : 'Held back: sessions keep the full briefing until recovery after a compression is proven here.');
  return { state: 'ok', lines };
}

/** Why a section has nothing to show: failed, unreadable, not on this version, or switched off. */
function missingWords(state, res, couldnt, off, absent = 'This version of the agent does not report it yet.') {
  if (state === 'unreadable') return `${couldnt}: it answered in a form this page does not understand.`;
  if (state === 'failed') return `${couldnt}: ${(res && res.reason) || 'no answer'}.`;
  if (state === 'absent') return absent;
  return off;
}

/**
 * The whole page. reads: { layers, metrics, sentinel, delta, topics? } (console reader results),
 * names: topic id → name.
 */
export function buildContextPage(reads, now = Date.now(), names = {}) {
  const st = { layers: readState(reads.layers), metrics: readState(reads.metrics), sentinel: readState(reads.sentinel), delta: readState(reads.delta) };
  const quiet = (s) => s === 'off' || s === 'absent';
  if (quiet(st.layers) && quiet(st.metrics) && quiet(st.sentinel) && quiet(st.delta)) {
    return {
      ok: true, off: true, tone: 'muted',
      headline: 'Conversation summaries are switched off on this machine.',
      sub: 'When on, each conversation keeps a running summary so a long session can be refreshed without losing what we were doing, and this page shows what each summary holds and what it costs.',
      needs: [], facts: [], conversations: [], recovery: null, cost: null, trial: null, upkeep: null,
    };
  }
  const raw = st.sentinel === 'ok' ? reads.sentinel.data : null;
  const needsUnreadable = Boolean(raw) && !sentinelShapeOk(raw);
  // A stale watcher's last report is still shown (a torn record it saw is likely still there), as last known.
  const stale = Boolean(raw) && watcherStale(raw);
  const needs = raw && !needsUnreadable ? listNeeds(raw, names, now) : [];
  // A watcher answer of the wrong shape is read as nothing at all: every section says it can't tell.
  const sentinel = needsUnreadable ? null : raw;
  if (needsUnreadable) st.sentinel = 'unreadable';

  // ── Conversations ──
  const freshByTopic = new Map();
  const lf = sentinel && sentinel.layerFreshness;
  if (lf && lf.state === 'ok' && Array.isArray(lf.topics)) for (const r of lf.topics) freshByTopic.set(String(r.topicKey), r);
  const m = st.metrics === 'ok' ? reads.metrics.data : null;
  const topics = m && Array.isArray(m.topics) ? m.topics : [];
  const conversations = topics.map((t) => topicRow(t, freshByTopic.get(String(t.topicId)), names));
  const conversationsNote = st.metrics === 'ok' ? (m && m.topicsTruncated ? 'Only the 50 most recently active conversations are listed.' : null)
    : missingWords(st.metrics, reads.metrics, 'Couldn’t read the conversations', 'Conversation summaries are switched off on this machine.');

  // ── Recovery after compression ──
  let recovery;
  if (sentinel) {
    const groups = sentinel.canary && Array.isArray(sentinel.canary.groups) ? sentinel.canary.groups : null;
    recovery = { state: 'ok', lines: groups ? groups.map(canaryLine) : [{ tone: 'unknown', text: 'The recovery check is not running on this machine.' }] };
    const notes = [];
    if (sentinel.canary && sentinel.canary.ledgerResetAt) notes.push('The check’s earlier history could not be read and was started again, so older results are gone.');
    if (sentinel.canary && sentinel.canary.unreadableTranscripts) notes.push(`${plural(sentinel.canary.unreadableTranscripts, 'session record')} could not be read on the last check.`);
    if (notes.length) recovery.note = notes.join(' ');
  } else recovery = { state: st.sentinel, lines: [{ tone: 'muted', text: missingWords(st.sentinel, reads.sentinel, 'Couldn’t read the recovery check', 'The watcher that checks recovery is switched off on this machine.') }] };

  // ── Cost ──
  let cost;
  if (m) {
    const lines = [];
    const o = m.overall;
    const oPer = o && !o.unavailable ? num(o.perRequest && o.perRequest.allInWeighted) : null;
    if (o && !o.unavailable) lines.push(o.requests ? `${plural(o.requests, 'turn')} across ${plural(o.sessions, 'session')} in the last ${m.window && m.window.sinceHours ? `${m.window.sinceHours} hours` : 'day'}${oPer !== null ? `: about ${fmtTokens(oPer)} tokens a turn` : ''}.` : 'No turns recorded in the last day.');
    else lines.push('Usage is not being read on this machine, so cost per turn can’t be told.');
    const lu = m.layerUpdate;
    if (lu && num(lu.componentShare) !== null) lines.push(`Keeping the summaries current used ${pct(lu.componentShare)} of its daily allowance (an estimate since the server last started).`);
    const days = Array.isArray(m.extractorByDay) ? m.extractorByDay : [];
    const calls = days.reduce((n, d) => n + (Number(d.turn && d.turn.calls) || 0) + (Number(d.tick && d.tick.calls) || 0), 0);
    const tokensIn = days.reduce((n, d) => n + (Number(d.turn && d.turn.tokensIn) || 0) + (Number(d.tick && d.tick.tokensIn) || 0), 0);
    if (calls) lines.push(`${plural(calls, 'summary update')} recently, reading about ${fmtTokens(tokensIn)} tokens.`);
    cost = { state: 'ok', lines };
  } else cost = { state: st.metrics, lines: [missingWords(st.metrics, reads.metrics, 'Couldn’t read what it costs', 'Cost is not measured while summaries are off.')] };

  // ── Upkeep (the watcher's own work) ──
  let upkeep;
  if (sentinel) {
    const lines = [];
    const last = agoWords(sentinel.lastTickAt, now);
    lines.push(last ? `The watcher last checked ${last}${sentinel.heartbeatFresh ? '' : ', later than it should; no conversation is refreshed until it checks in again'}.` : 'The watcher has not checked yet since the server started.');
    const settling = sentinel.quarantined.filter((q) => q && num(q.ageMs) !== null && q.ageMs <= STUCK_AFTER_MS).length;
    if (settling) lines.push(`${plural(settling, 'memory refresh', 'memory refreshes')} settling now; messages to ${settling === 1 ? 'that conversation' : 'those conversations'} wait a few minutes.`);
    const ageless = sentinel.quarantined.filter((q) => !q || num(q.ageMs) === null).length;
    if (ageless) lines.push(`${plural(ageless, 'memory refresh', 'memory refreshes')} paused with no readable start time, so I can’t tell how long ${ageless === 1 ? 'it has' : 'they have'} been waiting.`);
    const hh = sentinel.holdHealth;
    if (hh && hh.state === 'ok' && hh.counts) lines.push(hh.counts.clearedTotal ? `${plural(hh.counts.clearedTotal, 'leftover pause')} cleared since the server started.` : 'No leftover pauses found.');
    if (lf && lf.state === 'ok' && lf.counts && lf.counts.topics) lines.push(`${plural(lf.counts.topics, 'live conversation')}: ${lf.counts.fresh} with an up-to-date summary, ${lf.counts.stale} behind, ${lf.counts.unknown} can’t tell.`);
    const ew = sentinel.eligibleWithoutFold;
    if (ew && ew.state === 'ok' && ew.counts && ew.counts.unknown) lines.push(`Whether refreshing ${ew.counts.unknown === 1 ? 'a conversation' : `${ew.counts.unknown} conversations`} would have saved anything can’t be told yet: the estimate is not built.`);
    if (sentinel.lastError) lines.push('The watcher’s last check ran into a problem; it tries again on its next check.');
    upkeep = { state: 'ok', lines };
  } else upkeep = { state: st.sentinel, lines: [missingWords(st.sentinel, reads.sentinel, 'Couldn’t read the watcher', 'The watcher is switched off on this machine, so nothing is refreshed and nothing is checked.')] };

  const trial = trialLines(reads.delta);
  const layerBytes = st.layers === 'ok' ? num(reads.layers.data && reads.layers.data.layerBytes) : null;
  const archiveBytes = st.layers === 'ok' ? num(reads.layers.data && reads.layers.data.archiveBytes) : null;
  const facts = [];
  if (st.layers === 'ok') facts.push({ n: Number(reads.layers.data.topics) || 0, label: 'conversations with a summary' });
  if (layerBytes !== null) facts.push({ n: fmtBytes(layerBytes), label: 'of summaries' });
  if (archiveBytes !== null) facts.push({ n: fmtBytes(archiveBytes), label: 'of saved transcripts' });
  // warning-path: pageHead
  if (needs.length) facts.unshift({ n: needs.length, label: needs.length === 1 ? 'needs a look' : 'need a look', tone: 'attn' });

  const failed = Object.entries(st).filter(([, s]) => s === 'failed' || s === 'unreadable').map(([k]) => k);
  // The watcher is the only source of "something is stuck": with summaries on and the watcher off,
  // missing, stale or not yet run, the page cannot say all is well.
  const watcherUnknown = st.layers === 'ok' && (!sentinel || stale || sentinel.lastTickAt === null || sentinel.lastTickAt === undefined);
  const headline = stale ? 'The watcher has stopped checking, so I can’t tell whether anything is stuck.'
    : needs.length ? needs[0].title
    : needsUnreadable ? 'Can’t tell whether anything is stuck.'
      : st.layers === 'ok' ? `Running summaries are on for ${plural(Number(reads.layers.data.topics) || 0, 'conversation')} on this machine.`
        : st.layers === 'failed' ? 'Can’t read the conversation summaries right now.'
          : 'Conversation summaries are switched off on this machine.';
  return {
    ok: true, off: false,
    // warning-path: pageHead
    tone: needs.length ? 'attn' : failed.length || needsUnreadable || watcherUnknown ? 'unknown' : 'ok',
    headline,
    sub: 'Each conversation keeps a running summary, so a long session can be refreshed without losing what we were doing. This page reads this machine only.',
    needs, needsUnreadable, needsStale: stale, facts,
    conversations, conversationsNote, recovery, cost, trial, upkeep,
    partial: failed.length > 0 || stale,
    lastCheck: raw && !needsUnreadable ? agoWords(raw.lastTickAt, now) : null,
  };
}

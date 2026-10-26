// Promises page — pure view-model (docs/specs/console-features/work.md, "Promises").
//
// One model with Home: the waiting-on-you, active, missed and 14-day rules — and
// the partition into sections — come from shared-counts.js (sortPromises), so
// Home's card and this page can never disagree on what is open.

import { sortPromises, waitsOnOperator, isMissed, lastTouched, nextDue, DUE_SOON_MS, CLOSED_WINDOW_MS } from './shared-counts.js';
import { REPLICA_FRESH_MS, ago, failure } from './home-model.js';

export { failure, isMissed, lastTouched, nextDue, DUE_SOON_MS, CLOSED_WINDOW_MS };

/** "in 3 h", "in 2 d", "now". */
export function until(ts, now = Date.now()) {
  const m = Math.round((ts - now) / 60000);
  if (m <= 0) return 'now';
  if (m < 60) return `in ${m} min`;
  const h = Math.round(m / 60); if (h < 48) return `in ${h} h`;
  return `in ${Math.round(h / 24)} d`;
}

const BLOCKED_WORDS = {
  'user-input': 'your answer',
  'user-authorization': 'your approval',
  external: 'something outside',
};

export function waitingOnWords(c) {
  if (c.owner === 'user' && (!c.blockedOn || c.blockedOn === 'none')) return 'you';
  return BLOCKED_WORDS[c.blockedOn] || null;
}

function machineName(id, names) {
  return (names && names[id]) || 'another machine';
}

/** A row in plain words. */
export function toRow(c, now = Date.now(), names = {}) {
  const due = nextDue(c);
  const waiting = waitingOnWords(c);
  const bits = [];
  if (waiting && waitsOnOperator(c)) bits.push(`waiting on ${waiting}`);
  else if (waiting === 'something outside') bits.push('waiting on something outside');
  if (isMissed(c, now)) bits.push('missed');
  else if (due && due > now) bits.push(`due ${until(due, now)}`);
  if (c.beaconPaused) bits.push('reminders paused');
  if (c.viewSource === 'replica') {
    const fresh = Number.isFinite(Number(c.stalenessMs)) && c.stalenessMs !== null;
    bits.push(`from ${machineName(c.originMachineId, names)}${fresh ? `, ${ago(now - c.stalenessMs, now).replace(' ago', '')} old` : ', age unknown'}`);
  }
  return {
    key: `${c.originMachineId || 'own'}:${c.id}`,
    id: c.id,
    origin: c.originMachineId || null,
    replica: c.viewSource === 'replica',
    main: c.agentResponse || c.userRequest || c.id,
    sub: bits.join(' · '),
    end: ago(c.createdAt, now) || '',
    record: c,
  };
}

/**
 * Sort every promise into the page's sections (shared-counts.sortPromises).
 * Returns { ok, sections:{waiting,missed,dueSoon,carrying,handled,closed}, counts, coverage, headline }.
 * `counts.open` is THE open total (waiting + missed + dueSoon + carrying); `handled` is
 * the "Older, still open" section (untouched 14+ days), out of every headline count.
 */
export function buildPromisesPage(res, now = Date.now(), { expectedPeers = null, names = {} } = {}) {
  if (!res.ok) return { ok: false, reason: `Couldn't read promises: ${res.reason}.` };
  if (res.data && res.data.enabled === false) return { ok: false, reason: 'Promise tracking is switched off on this agent.' };
  const list = Array.isArray(res.data && res.data.commitments) ? res.data.commitments : null;
  if (!list) return { ok: false, reason: 'The promise list answered without records.' };

  const p = sortPromises(list, now);
  const s = { waiting: p.waiting, missed: p.missed, dueSoon: p.dueSoon, carrying: p.carrying, handled: p.older, closed: p.closed };
  const sections = Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v.map((c) => toRow(c, now, names))]));
  const counts = { ...Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v.length])), open: p.counts.open, older: p.counts.older, olderWaiting: p.counts.olderWaiting };

  const replicas = list.filter((c) => c && c.viewSource === 'replica');
  const origins = new Set(replicas.map((c) => c.originMachineId));
  const staleReplica = replicas.some((c) => !Number.isFinite(Number(c.stalenessMs)) || c.stalenessMs === null || Number(c.stalenessMs) > REPLICA_FRESH_MS);
  const missingPeers = Number.isFinite(expectedPeers) ? Math.max(0, expectedPeers - origins.size) : null;
  const coverage = res.data.scope !== 'mesh' || origins.size === 0 ? "Only this machine's promises are visible."
    : staleReplica ? `Includes ${origins.size} other ${origins.size === 1 ? 'machine' : 'machines'}; some of it is out of date.`
    : missingPeers === null ? `Includes ${origins.size} other ${origins.size === 1 ? 'machine' : 'machines'}; not every machine is confirmed.`
    : missingPeers > 0 ? `${missingPeers} ${missingPeers === 1 ? 'machine is' : 'machines are'} not represented.`
    : null;

  const n = counts;
  const plural = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  let headline;
  if (n.waiting) headline = `${plural(n.waiting, 'promise is', 'promises are')} waiting on you.`;
  else if (n.missed) headline = `${plural(n.missed, 'promise was', 'promises were')} missed.`;
  else if (n.dueSoon + n.carrying) headline = 'Nothing is waiting on you.';
  else headline = 'No open promises.';
  const carryingTotal = n.dueSoon + n.carrying;
  // The same total Home's card shows ("N open promises"), spelled out once.
  const sub = [
    `${n.open} open in all: ` + [
      n.waiting ? `${n.waiting} waiting on you` : null,
      n.missed ? `${n.missed} missed` : null,
      carryingTotal ? `${carryingTotal} I'm carrying${n.dueSoon ? ` (${n.dueSoon} due within a day)` : ''}` : null,
    ].filter(Boolean).join(', ') + '.',
  ].filter(Boolean).join(' ');
  return { ok: true, sections, counts, coverage, headline, sub: n.open ? sub : '', tone: n.waiting ? 'attn' : n.missed ? 'bad' : coverage ? 'muted' : 'ok' };
}

/** The detail sheet's story, in plain sentences. */
export function storyOf(c, now = Date.now(), names = {}) {
  const lines = [];
  if (c.userRequest) lines.push({ label: 'You asked', text: c.userRequest });
  if (c.agentResponse) lines.push({ label: 'I said', text: c.agentResponse });
  const w = waitingOnWords(c);
  if (w && w !== 'you') lines.push({ label: 'Waiting on', text: w + (c.actionClass ? ` (${String(c.actionClass).replace(/[-_]/g, ' ')})` : '') });
  else if (w === 'you') lines.push({ label: 'Waiting on', text: 'you' });
  const due = nextDue(c);
  if (due) lines.push({ label: due > now ? 'Next check' : 'Was due', text: new Date(due).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) });
  if (c.status === 'delivered' || c.status === 'withdrawn' || c.status === 'expired') {
    lines.push({ label: c.status === 'delivered' ? 'Done' : c.status === 'withdrawn' ? 'Dropped' : 'Expired', text: `${ago(c.resolvedAt, now) || ''}${c.resolution ? ` — ${c.resolution}` : ''}` });
  }
  if (c.viewSource === 'replica') lines.push({ label: 'Machine', text: machineName(c.originMachineId, names) });
  return lines;
}

/**
 * Which actions a promise offers — exactly what the server accepts
 * (src/monitoring/CommitmentTracker.ts: deliver refuses every status but pending;
 * withdraw refuses only withdrawn and expired; resume needs a paused beacon).
 */
export function actionsFor(c) {
  if (!c) return [];
  const a = [];
  if (c.status === 'pending') a.push('deliver');
  if (c.status === 'pending' || c.status === 'verified' || c.status === 'violated') a.push('withdraw');
  if (c.beaconPaused && c.status === 'pending') a.push('resume');
  return a;
}

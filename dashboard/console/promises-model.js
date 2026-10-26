// Promises page — pure view-model (docs/specs/console-features/work.md, "Promises").
//
// One model with Home: the waiting-on-you, active and 14-day rules come from
// home-model.js, so Home's card and this page can never disagree.

import { isActiveCommitment, waitsOnOperator, isMissed, lastTouched, STALE_DAYS, REPLICA_FRESH_MS, ago, failure } from './home-model.js';

export { failure };

const DAY = 86400000;
export const DUE_SOON_MS = DAY;
export const CLOSED_WINDOW_MS = 7 * DAY;

/** When this promise next expects something (the soonest real date it carries). */
export function nextDue(c) {
  const ts = [c.hardDeadlineAt, c.checkInAt, c.nextUpdateDueAt, c.softDeadlineAt]
    .map((t) => Date.parse(t)).filter(Number.isFinite);
  return ts.length ? Math.min(...ts) : null;
}

/** "in 3 h", "in 2 d", "now". */
export function until(ts, now = Date.now()) {
  const m = Math.round((ts - now) / 60000);
  if (m <= 0) return 'now';
  if (m < 60) return `in ${m} min`;
  const h = Math.round(m / 60); if (h < 48) return `in ${h} h`;
  return `in ${Math.round(h / 24)} d`;
}

export { isMissed, lastTouched };

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
 * Sort every promise into the page's sections.
 * Returns { ok, sections:{waiting,missed,dueSoon,carrying,handled,closed}, counts, coverage, headline }.
 */
export function buildPromisesPage(res, now = Date.now(), { expectedPeers = null, names = {} } = {}) {
  if (!res.ok) return { ok: false, reason: `Couldn't read promises: ${res.reason}.` };
  if (res.data && res.data.enabled === false) return { ok: false, reason: 'Promise tracking is switched off on this agent.' };
  const list = Array.isArray(res.data && res.data.commitments) ? res.data.commitments : null;
  if (!list) return { ok: false, reason: 'The promise list answered without records.' };

  const fresh = (c) => now - lastTouched(c) <= STALE_DAYS * DAY;
  const s = { waiting: [], missed: [], dueSoon: [], carrying: [], handled: [], closed: [] };
  for (const c of list) {
    if (!c) continue;
    if (isActiveCommitment(c, now) || c.status === 'violated') {
      // A missed promise stays in Missed at any age: age is not evidence it was handled.
      // Anything else untouched for 14 days is listed as "Older, still open" and not
      // counted in the headline (Home's rule, the operator's noise requirement).
      if (isMissed(c, now) && !waitsOnOperator(c)) s.missed.push(c);
      else if (!fresh(c)) s.handled.push(c);
      else if (waitsOnOperator(c)) s.waiting.push(c);
      else {
        const due = nextDue(c);
        if (due && due > now && due - now <= DUE_SOON_MS) s.dueSoon.push(c);
        else s.carrying.push(c);
      }
    } else if (c.status === 'delivered' || c.status === 'withdrawn' || c.status === 'expired') {
      const r = Date.parse(c.resolvedAt);
      if (Number.isFinite(r) && now - r <= CLOSED_WINDOW_MS) s.closed.push(c);
    }
  }
  const byNewest = (a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0);
  for (const k of Object.keys(s)) s[k].sort(k === 'dueSoon' ? (a, b) => nextDue(a) - nextDue(b) : k === 'closed' ? (a, b) => Date.parse(b.resolvedAt) - Date.parse(a.resolvedAt) : byNewest);
  const sections = Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v.map((c) => toRow(c, now, names))]));
  const counts = Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v.length]));

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
  const sub = [
    carryingTotal ? `${carryingTotal} more I'm carrying${n.dueSoon ? `, ${n.dueSoon} due within a day` : ''}.` : null,
    n.waiting && n.missed ? `${n.missed} missed.` : null,
  ].filter(Boolean).join(' ');
  return { ok: true, sections, counts, coverage, headline, sub, tone: n.waiting ? 'attn' : n.missed ? 'bad' : coverage ? 'muted' : 'ok' };
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

/** Which actions a promise offers, per the plan. */
export function actionsFor(c, now = Date.now()) {
  const open = isActiveCommitment(c, now) || c.status === 'violated';
  const a = [];
  if (open && c.status !== 'violated') a.push('deliver');
  if (open && c.status !== 'violated') a.push('withdraw');
  if (c.beaconPaused) a.push('resume');
  return a;
}

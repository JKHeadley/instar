// Promises page — pure view-model (docs/specs/console-features/work.md, "Promises").
//
// One model with Home: the waiting-on-you, active and 14-day rules come from
// home-model.js, so Home's card and this page can never disagree.

import { isActiveCommitment, waitsOnOperator, isInternalFollowUp, isMissed, needsPromiseReview, lastTouched, STALE_DAYS, REPLICA_FRESH_MS, ago, failure } from './home-model.js';
import { verifiedDisplayName } from './display-identity.js';

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
  if (!waitsOnOperator(c) && isMissed(c, now)) bits.push('due date passed · outcome unverified');
  else if (isMissed(c, now)) bits.push(`due ${new Date(Date.parse(c.hardDeadlineAt)).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}`);
  else if (needsPromiseReview(c, now)) bits.push('needs an update · no due date recorded');
  else if (due && due > now) bits.push(`due ${until(due, now)}`);
  if (c.beaconPaused) bits.push('reminders paused');
  if (c.viewSource === 'replica') {
    const fresh = Number.isFinite(Number(c.stalenessMs)) && c.stalenessMs !== null;
    bits.push(`from ${machineName(c.originMachineId, names)}${fresh ? ` · updated ${ago(now - c.stalenessMs, now)}` : ' · update time unknown'}`);
  }
  return {
    key: `${c.originMachineId || 'own'}:${c.id}`,
    id: c.id,
    origin: c.originMachineId || null,
    replica: c.viewSource === 'replica',
    main: (waitsOnOperator(c)
      ? verifiedDisplayName(c.userRequest, c.id) || verifiedDisplayName(c.agentResponse, c.id)
      : verifiedDisplayName(c.agentResponse, c.id) || verifiedDisplayName(c.userRequest, c.id)) || 'Promise details unavailable',
    sub: bits.join(' · '),
    end: ago(c.createdAt, now) || '',
    record: c,
  };
}

/**
 * Sort every promise into the page's sections.
 * Returns { ok, sections:{waiting,missed,dueSoon,carrying,handled,closed}, counts, coverage, headline }.
 */
export function buildPromisesPage(res, now = Date.now(), { expectedPeers = null, peerIds = null, names = {} } = {}) {
  if (!res.ok) return { ok: false, reason: `Couldn't read promises: ${res.reason}.` };
  if (res.data && res.data.enabled === false) return { ok: false, reason: 'Promise tracking is switched off on this agent.' };
  const list = Array.isArray(res.data && res.data.commitments) ? res.data.commitments : null;
  if (!list) return { ok: false, reason: 'The promise list answered without records.' };

  const fresh = (c) => now - lastTouched(c) <= STALE_DAYS * DAY;
  const s = { waiting: [], missed: [], review: [], dueSoon: [], carrying: [], handled: [], closed: [] };
  for (const c of list) {
    if (!c) continue;
    if (isActiveCommitment(c, now) || c.status === 'violated') {
      // Echo-owned work stays in collapsed audit sections even when its due
      // date passed or a check failed. Only a named operator dependency appears
      // by default. Age never means a promise was handled or completed.
      if (waitsOnOperator(c)) s.waiting.push(c);
      else if (!fresh(c)) s.handled.push(c);
      else {
        s.carrying.push(c);
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
    : missingPeers > 0 ? missingPeersLine(peerIds, origins, names, missingPeers)
    : null;

  const n = counts;
  const plural = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  let headline;
  if (n.waiting) headline = `${plural(n.waiting, 'promise is', 'promises are')} waiting on you.`;
  else headline = 'Nothing is waiting on you.';
  return { ok: true, sections, counts, coverage, headline, sub: '', tone: n.waiting ? 'attn' : coverage ? 'muted' : 'ok' };
}

/** The detail sheet's story, in plain sentences. */
export function storyOf(c, now = Date.now(), names = {}) {
  const lines = [];
  if (c.userRequest) lines.push({ label: isInternalFollowUp(c) ? 'Internal follow-up' : 'You asked', text: c.userRequest });
  if (c.agentResponse) lines.push({ label: 'I promised', text: c.agentResponse });
  const w = waitingOnWords(c);
  if (w && w !== 'you') lines.push({ label: 'Waiting on', text: w === 'something outside' ? 'another task or person' : w });
  else if (w === 'you') lines.push({ label: 'Waiting on', text: 'you' });
  const dateWords = (at) => new Date(at).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  const deadline = Date.parse(c.hardDeadlineAt);
  if (Number.isFinite(deadline)) lines.push({ label: deadline < now ? (waitsOnOperator(c) ? 'Due date missed' : 'Due date passed') : 'Due date', text: dateWords(deadline) });
  else if (isActiveCommitment(c, now)) lines.push({ label: 'Due date', text: 'No due date was recorded.' });
  const update = [c.checkInAt, c.nextUpdateDueAt].map(Date.parse).filter(Number.isFinite).sort((a, b) => a - b)[0];
  if (update) lines.push({ label: update < now ? 'Update expected' : 'Next update', text: dateWords(update) });
  if (!waitsOnOperator(c) && isActiveCommitment(c, now)) lines.push({ label: 'Current status', text: 'No completion is recorded. This does not confirm the original problem still exists.' });
  else if (needsPromiseReview(c, now)) lines.push({ label: 'Progress', text: 'The agent has not confirmed this is done.' });
  if (c.status === 'delivered' || c.status === 'withdrawn' || c.status === 'expired') {
    lines.push({ label: c.status === 'delivered' ? 'Done' : c.status === 'withdrawn' ? 'Dropped' : 'Expired', text: `${ago(c.resolvedAt, now) || ''}${c.resolution ? ` — ${c.resolution}` : ''}` });
  }
  if (c.viewSource === 'replica') lines.push({ label: 'Agent machine', text: machineName(c.originMachineId, names) });
  return lines;
}

/** The record's known history. A source conversation may contain more context. */
export function backstoryOf(c, now = Date.now()) {
  const date = (value) => {
    const at = Date.parse(value);
    return Number.isFinite(at) ? new Date(at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : null;
  };
  const lines = [];
  if (date(c.createdAt)) lines.push({ label: 'Recorded', text: date(c.createdAt) });
  if (isActiveCommitment(c, now)) lines.push({ label: 'Since then', text: isMissed(c, now)
    ? 'The due date passed, and no completed outcome is recorded. That alone does not show whether the work is still needed.'
    : 'The promise remains open; no completed outcome is recorded.' });
  if (c.lastProbe?.at) lines.push({ label: `Last check · ${date(c.lastProbe.at) || 'date unknown'}`, text: [c.lastProbe.checked, c.lastProbe.readinessSignal].filter(Boolean).join(' — ') });
  if (date(c.lastVerifiedAt)) lines.push({ label: 'Last verified', text: date(c.lastVerifiedAt) });
  if (c.resolution && date(c.resolvedAt)) lines.push({ label: `Outcome · ${date(c.resolvedAt)}`, text: c.resolution });
  if (c.beaconEnabled && c.lastHeartbeatAt) lines.push({ label: 'Latest reminder', text: `${date(c.lastHeartbeatAt) || 'date unknown'} · A reminder is not proof that the work was done.` });
  return lines;
}

export function updateQuestionOf(c, now = Date.now()) {
  const subject = String(c.userRequest || c.agentResponse || 'this promise').trim().replace(/\s+/g, ' ').slice(0, 150);
  return isMissed(c, now)
    ? `What is the current status of “${subject}”? Please tell me what is done, what remains, and a realistic new date.`
    : `What is the current status of “${subject}”? Please tell me what is done, what remains, and when I should expect the next update.`;
}

/** A promise that waits only on the operator's yes or no: the page offers Approve and Decline. */
export function canDecide(c) {
  return Boolean(c) && c.status === 'pending' && c.blockedOn === 'user-authorization';
}

/** The words after an Approve / Decline answer, from the server's reply. */
export function decideResultWords(decision, res) {
  if (res && res.ok) {
    const posted = res.data && res.data.postedInConversation === false ? ' I could not post it in the conversation, so mention it there if it matters.' : '';
    return { ok: true, text: (decision === 'approve' ? 'Approved. I will go ahead.' : 'Declined. The promise is closed.') + posted };
  }
  const why = (res && res.reason) || 'the server could not be reached';
  return { ok: false, text: `That did not go through: ${String(why).replace(/\.$/, '').replace(/^The /, 'the ')}.` };
}

/** A concrete next step without assigning the agent's work to the operator. */
export function nextStepOf(c, now = Date.now()) {
  if (canDecide(c)) return 'Your approval is needed. Approve or decline it here, or reply in the conversation to talk it through first.';
  if (waitsOnOperator(c)) return 'Your answer or approval is needed. Open the conversation to respond.';
  if (isMissed(c, now) || needsPromiseReview(c, now)) return 'This follow-up is mine: I need to verify the current outcome. No action is needed from you.';
  return 'The next step is mine. No action is needed from you.';
}

/** Which actions a promise offers, per the plan. */
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

/** Names the machines that sent no promises: they may have none, or may not have answered. */
function missingPeersLine(peerIds, origins, names, count) {
  const missing = Array.isArray(peerIds) ? peerIds.filter((id) => !origins.has(id)).map((id) => names[id] || 'another machine') : [];
  if (!missing.length) return `No promises came from ${count === 1 ? 'one other machine' : `${count} other machines`}. ${count === 1 ? 'It' : 'They'} may have none, or may not have answered.`;
  const list = missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}`;
  return `No promises came from ${list}. ${missing.length === 1 ? 'It' : 'They'} may have none, or may not have answered.`;
}

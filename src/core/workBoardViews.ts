/**
 * The Work Board's read shapes (docs/specs/work-board-asks.md §4 Visibility, §5, §7, Multi-machine
 * "Reads"). One serializer for every surface (agent routes, console, phone), so a viewer that may
 * not see a field never receives it, whichever surface asked.
 */

import type { WorkBoardService, CardView } from './WorkBoardService.js';
import { plainParkReason } from './WorkBoardService.js';
import type { Lane } from './WorkCardStore.js';
import { sha256Hex } from './WorkCardStore.js';

export interface Viewer { personKey: string | null; isOwner: boolean; isAgent: boolean }

export interface BehindInfo { machineId: string; since: string }

/** Plain words for each status, for the row's "what is needed" line. */
export function needLine(v: CardView): string {
  const c = v.card;
  switch (v.status) {
    case 'removed': return 'Removed';
    case 'unknown': return 'Part of this card could not be read';
    case 'archived': return 'Archived';
    case 'held': return 'On hold. Release it when the agent may carry on';
    case 'needs-approval': return c.withdrawn ? 'Approval withdrawn. Approve again to let the agent start' : 'Needs your approval before the agent starts';
    case 'claims-done': return 'The agent says this is done. Confirm or reopen';
    case 'done': return c.doneByAgentOwnEvidence ? 'Finished by the agent on its own evidence' : 'Done';
    case 'parked': {
      const p = v.pickups.find((x) => x.status === 'parked');
      return `This could not be handed to the agent: ${plainParkReason(p?.closedReason ?? '')}`;
    }
    case 'waiting-on-person': return c.openQuestion?.text ?? 'The agent has a question';
    case 'with-person': return 'Yours to do';
    case 'quiet': return 'The agent has gone quiet on this';
    case 'with-agent': {
      const waiting = v.pickups.find((p) => p.status === 'pending');
      return waiting ? 'Approved; waiting for the agent to pick it up' : 'The agent is working on this';
    }
  }
}

function principalJson(p: unknown, name: (k: string) => string): unknown {
  if (p && typeof p === 'object' && 'personKey' in (p as Record<string, unknown>)) {
    const k = (p as { personKey: string }).personKey; return { personKey: k, name: name(k) };
  }
  return p;
}

function byJson(b: unknown, name: (k: string) => string): unknown {
  const x = b as { kind?: string; personKey?: string; proof?: string } | null;
  if (!x) return null;
  if (x.kind === 'person' && x.personKey) return { kind: 'person', personKey: x.personKey, name: name(x.personKey), proof: x.proof === 'presence' ? 'phone' : 'console PIN' };
  return { kind: x.kind };
}

export function cardJson(svc: WorkBoardService, v: CardView, viewer: Viewer, name: (k: string) => string, extra?: { behind?: BehindInfo | null; lastWrittenOn?: string | null; repliedAfterQuestion?: boolean; capacity?: { reason: string; nextCheckAt: number; since: number } | null; brokenAttachments?: string[] }): Record<string, unknown> {
  const c = v.card;
  const lane: Lane = svc.lane(v, { isOwner: viewer.isOwner || viewer.isAgent, personKey: viewer.personKey });
  const base = { id: c.cardId, conversationKey: c.conversationKey, status: v.status, lane, needLine: needLine(v), newestAt: new Date(c.newestRecordAt).toISOString() };
  if (c.redacted) {
    return { ...base, title: `Removed by ${byName(c.redacted.by, name)}`, removed: { by: byJson(c.redacted.by, name), at: c.redacted.at, note: 'The text is hidden from every read. Its bytes stay in the journal until compaction, and a backup taken earlier still holds it.' } };
  }
  const ownerish = viewer.isOwner || viewer.isAgent;
  const pending = v.pickups.filter((p) => p.status === 'pending' || p.status === 'parked');
  const out: Record<string, unknown> = {
    ...base,
    title: c.title, titleHash: sha256Hex(c.title), need: c.need, recommendation: c.recommendation, doneWhen: c.doneWhen,
    carrier: principalJson(c.carrier, name), outward: c.outward,
    outwardWords: c.outward ? 'This sends something outside your team or spends money' : null,
    links: c.links.map((l) => ('url' in l ? { ...l, host: safeHost(l.url), note: 'Approval covers this address, not what it serves later' } : { ...l, removed: extra?.brokenAttachments?.includes(l.attachmentId) ?? false })),
    waitingOn: principalJson(c.waitingOn, name), due: c.due,
    materialHash: c.materialHash, approvalRequired: c.approvalRequired, approved: c.approvalValid, approvedBy: c.approvedBy ? { ...c.approvedBy, by: byJson(c.approvedBy.by, name) } : null,
    withdrawn: c.withdrawn, policy: c.policy,
    question: c.openQuestion ? { id: c.openQuestion.id, text: c.openQuestion.text, options: c.openQuestion.options ?? null } : null,
    questions: c.questions.map((q) => ({ id: q.id, text: q.text, options: q.options ?? null, state: q.state, reason: q.reason ?? null, answer: q.answer ?? null, replacedBy: q.replacedBy ?? null, at: q.at })),
    evidence: c.evidence.map((e) => ({ id: e.id, itemId: e.itemId, text: e.text, attachmentIds: e.attachmentIds ?? [], counts: e.counts, at: e.at, by: byJson(e.by, name) })),
    claim: c.currentClaim ? { id: c.currentClaim.id, evidenceIds: c.currentClaim.evidenceIds, needsConfirm: c.needsConfirm, confirmedBy: c.currentClaim.confirmedBy ?? null, at: c.currentClaim.at } : null,
    done: c.done, doneByAgentOwnEvidence: c.doneByAgentOwnEvidence, reopens: c.reopens, holds: c.holds, archives: c.archives,
    carrierTrail: c.carrierTrail.map((t) => ({ carrier: principalJson(t.carrier, name), by: byJson(t.by, name), at: t.at })),
    taps: c.taps.map((t) => ({ id: t.id, action: t.action, at: t.at, by: byJson(t.by, name) })),
    unreadable: c.unknown.length ? c.unknown : null,
    workable: c.workable,
    mayHaveBeenHandedOver: v.mayHaveBeenHandedOver,
    pickups: pending.map((p) => ({ causeId: p.cause.id, kind: p.cause.kind, status: p.status, attempts: p.attempts, parkId: p.parkId, parkReason: p.status === 'parked' ? plainParkReason(p.closedReason ?? '') : null })),
    capacity: extra?.capacity ? { reason: extra.capacity.reason, nextCheckAt: new Date(extra.capacity.nextCheckAt).toISOString(), since: new Date(extra.capacity.since).toISOString(), words: `Approved; waiting for a free session (${extra.capacity.reason})` } : null,
    retryOf: retryTargetFor(svc, v),
    lineIds: svc.lineIds(c.cardId),
    repliedAfterQuestion: !!extra?.repliedAfterQuestion,
    ...(extra?.behind ? { behind: extra.behind } : {}),
    ...(extra?.behind && extra.lastWrittenOn && extra.behind.machineId === extra.lastWrittenOn ? { mayHaveChangedOn: extra.lastWrittenOn } : {}),
  };
  if (ownerish) { out.source = c.source; out.projectKey = c.projectKey; }
  return out;
}

/** What a Try again on this card would bind to: a park, a waiting pickup, or a quiet card's newest record. */
function retryTargetFor(svc: WorkBoardService, v: CardView): string | null {
  const park = v.pickups.find((p) => p.status === 'parked');
  if (park?.parkId) return park.parkId;
  if (v.status === 'quiet') { const r = svc.recordsOf(v.card.cardId); return r.length ? r[r.length - 1].id : null; }
  const waiting = v.pickups.find((p) => p.status === 'pending' && svc.capacityWait.has(p.cause.id));
  return waiting ? waiting.cause.id : null;
}

function byName(b: unknown, name: (k: string) => string): string {
  const x = b as { kind?: string; personKey?: string } | null;
  return x?.kind === 'person' && x.personKey ? name(x.personKey) : 'the agent';
}

function safeHost(u: string): string { try { return new URL(u).host; } catch { return ''; /* @silent-fallback-ok: display only; the schema already refused a non-URL link */ } }

export interface LaneListing { lane: Lane; cards: Record<string, unknown>[]; more?: number }

/**
 * The board for one viewer: "Waiting on you" (oldest first, aggregated past the soft budget),
 * "With the agent", "Waiting on others", "Done" (20 newest; `donePage` pages 50), "Archived".
 */
export function boardJson(svc: WorkBoardService, viewer: Viewer, mayRead: (conversationKey: string) => boolean, name: (k: string) => string, opts: { softOpenCards: number; donePage?: number; extraFor?: (v: CardView) => Parameters<typeof cardJson>[4] }): Record<string, unknown> {
  const lanes: Record<Lane, Array<{ v: CardView; json: Record<string, unknown> }>> = { 'waiting-on-you': [], 'with-agent': [], 'waiting-on-others': [], done: [], archived: [] };
  for (const id of svc.cardIds()) {
    const v = svc.view(id); if (!v || !v.card.created) continue;
    if (!viewer.isAgent && !viewer.isOwner && !mayRead(v.card.conversationKey)) continue; // not visible: the card does not exist for them
    const json = cardJson(svc, v, viewer, name, opts.extraFor?.(v));
    lanes[json.lane as Lane].push({ v, json });
  }
  lanes['waiting-on-you'].sort((a, b) => a.v.card.newestRecordAt - b.v.card.newestRecordAt);
  for (const l of ['with-agent', 'waiting-on-others', 'archived'] as const) lanes[l].sort((a, b) => b.v.card.newestRecordAt - a.v.card.newestRecordAt);
  lanes.done.sort((a, b) => b.v.card.newestRecordAt - a.v.card.newestRecordAt);
  const waiting = lanes['waiting-on-you'];
  const shownWaiting = waiting.slice(0, opts.softOpenCards);
  const page = Math.max(0, opts.donePage ?? 0);
  const doneShown = page === 0 ? lanes.done.slice(0, 20) : lanes.done.slice(20 + (page - 1) * 50, 20 + page * 50);
  return {
    lanes: [
      { lane: 'waiting-on-you', cards: shownWaiting.map((x) => x.json), ...(waiting.length > shownWaiting.length ? { more: waiting.length - shownWaiting.length } : {}) },
      { lane: 'with-agent', cards: lanes['with-agent'].map((x) => x.json) },
      { lane: 'waiting-on-others', cards: lanes['waiting-on-others'].map((x) => x.json) },
      { lane: 'done', cards: doneShown.map((x) => x.json), total: lanes.done.length },
      { lane: 'archived', cards: lanes.archived.map((x) => x.json) },
    ],
    waitingOnYou: waiting.length,
    policy: svc.policy(),
    newestHlc: svc.newestHlc(),
  };
}

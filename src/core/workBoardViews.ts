/**
 * The Work Board's read shapes (docs/specs/work-board-asks.md §4 Visibility, §5, §7, Multi-machine
 * "Reads"). One serializer for every surface (agent routes, console, phone), so a viewer that may
 * not see a field never receives it, whichever surface asked.
 */

import type { WorkBoardService, CardView } from './WorkBoardService.js';
import { plainParkReason, isServerOwnedCard } from './WorkBoardService.js';
import type { Lane } from './WorkCardStore.js';
import { sha256Hex } from './WorkCardStore.js';

export interface Viewer { personKey: string | null; isOwner: boolean; isAgent: boolean }

export interface BehindInfo { machineId: string; since: string }

/** Plain words for each status, for the row's "what is needed" line. */
/** A stopped project app's serve card: turning the app back on comes with stage 2 (CMT-1882). */
export const APP_STOPPED_LINE = 'Stopped by you. Turning it back on comes in a later update.';

export function needLine(v: CardView, opts: { phoneOnly?: boolean; appStopped?: boolean; /** §9: the blocker words for THIS viewer ("Blocked by: …" or "Blocked by a card you cannot see"). */ blockedWords?: string; /** §8: the carrier's name and whether the viewer is that carrier. */ carrierName?: string; viewerIsCarrier?: boolean } = {}): string {
  const c = v.card;
  // A stopped app's serve card: no tap on it runs the app again in this build, so it says only that.
  if (opts.phoneOnly && opts.appStopped && v.status !== 'removed' && v.status !== 'archived') return APP_STOPPED_LINE;
  // A phone-only card (a project app's version card, project-apps-sandbox §3.4) is approved only on
  // the owner's phone and no agent starts anything from it, so it never says "before the agent starts".
  if (opts.phoneOnly) {
    switch (v.status) {
      case 'needs-approval': return c.withdrawn ? 'Stopped by you.' : 'Approve this version on your phone to run it';
      case 'with-person': return c.approvalValid ? 'Approved on your phone; starting this version' : 'Approve this version on your phone to run it';
      case 'done': return 'Approved on your phone; this version is running';
      default: break;
    }
  }
  switch (v.status) {
    case 'removed': return 'Removed';
    case 'unknown': return 'Part of this card could not be read';
    case 'archived':
      if (c.closeout?.as === 'done') return `Done: ${c.closeout.note}`;
      if (c.closeout?.as === 'not-important') return `Not important: ${c.closeout.note}`;
      return 'Archived';
    case 'held': return 'On hold. Release it when the agent may carry on';
    case 'needs-approval': return c.withdrawn ? 'Approval withdrawn. Approve again to let the agent start' : 'Needs your approval before the agent starts';
    // agent-work-cards-default §1: never a per-card ask; the team's unstarted cards are one aggregated row.
    case 'not-started': return 'Not started: waiting for your approval or board setting';
    case 'claims-done': return 'The agent says this is done. Confirm or reopen';
    case 'done': return c.doneByAgentOwnEvidence ? 'Finished by the agent on its own evidence' : 'Done';
    case 'parked': {
      const p = v.pickups.find((x) => x.status === 'parked');
      return `This could not be handed to the agent: ${plainParkReason(p?.closedReason ?? '')}`;
    }
    case 'waiting-on-person': return c.openQuestion?.text ?? 'The agent has a question';
    case 'with-person': return opts.viewerIsCarrier === false && opts.carrierName ? `${opts.carrierName}'s to do` : 'Yours to do';
    // agent-work-cards-default §8/§9: the words are resolved per viewer by the caller; these are the floors.
    case 'carrier-departed': return `${opts.carrierName ?? 'The carrier'} is no longer on the team; this card needs a new owner`;
    case 'blocked': return opts.blockedWords ?? 'Blocked by another card';
    case 'quiet': return 'The agent has gone quiet on this';
    case 'with-agent': {
      if (c.pickupHeld) return 'The agent is working on this in the conversation that asked for it';
      const waiting = v.pickups.find((p) => p.status === 'pending');
      return waiting ? 'Approved; waiting for the agent to pick it up' : 'The agent is working on this';
    }
  }
}

/** "asked <n> days ago" from the request's time (agent-work-cards-default §1: a label, never a cap). */
export function askedAgoWords(askedAtIso: string | null, nowMs: number): string | null {
  if (!askedAtIso) return null;
  const t = Date.parse(askedAtIso); if (!Number.isFinite(t)) return null;
  const days = Math.floor(Math.max(0, nowMs - t) / 86_400_000);
  return days === 0 ? 'asked today' : days === 1 ? 'asked 1 day ago' : `asked ${days} days ago`;
}

/** The close-out label (§2): what an agent-attested finish rests on. */
export function closeoutLabel(c: { done: boolean; doneByAgentOwnEvidence: boolean; evidence: Array<{ counts: boolean; text: string; attachmentIds?: string[] }> }): string | null {
  if (!c.done || !c.doneByAgentOwnEvidence) return null;
  const linked = c.evidence.some((e) => e.counts && ((e.attachmentIds?.length ?? 0) > 0 || /https:\/\/\S+/.test(e.text)));
  return linked ? 'closed by the agent, with a link or attachment' : 'closed by the agent on its own word';
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
  if (x.kind === 'person' && x.personKey) return { kind: 'person', personKey: x.personKey, name: name(x.personKey), proof: x.proof === 'presence' ? 'phone' : x.proof === 'message' ? 'their own request' : 'console PIN' };
  return { kind: x.kind };
}

/**
 * Whose turn it is, for the card's colour (Luna's board: light red while it waits on you, light blue while it
 * moves): `you` (the viewer's lane is "Waiting on you"), `agent` (in progress with the agent), `others` (waiting
 * on someone else), `nobody` (done or archived).
 */
export type Turn = 'you' | 'agent' | 'others' | 'nobody';
export function turnFor(lane: Lane): Turn {
  switch (lane) {
    case 'waiting-on-you': return 'you';
    case 'with-agent': return 'agent';
    case 'waiting-on-others': return 'others';
    default: return 'nobody';
  }
}

/**
 * The card's own conversation (work-front-doors decision 3: card and chat on one page). Clients read and reply
 * through the existing app-conversation routes, which already decide per reader what may be shown; the card
 * only names them.
 */
export function conversationRef(conversationKey: string): Record<string, string> {
  const k = encodeURIComponent(conversationKey);
  return { kind: 'app', key: conversationKey, ref: `app:${conversationKey}`, messagesPath: `/mobile/chat/app/${k}/messages`, sendPath: `/mobile/chat/app/${k}` };
}

/**
 * Does this viewer see this card (agent-work-cards-default §8 "Who sees a card")? The owner and the agent see every card;
 * a person sees a card when they may read its conversation under the owner's grant (`mayRead`), or they are its current
 * carrier or its row-named requester while they stand on the team (the service's rule). The one function every surface
 * uses, so blocker words and `refs` are resolved under the SAME access as the card itself.
 */
export function cardVisible(svc: WorkBoardService, v: CardView, viewer: Viewer, mayRead: ((conversationKey: string) => boolean) | null): boolean {
  if (viewer.isAgent || viewer.isOwner) return true;
  if (!v.card.created) return false;
  if (mayRead?.(v.card.conversationKey)) return true;
  return svc.roleVisible(viewer.personKey, v.card);
}

/** The words a viewer gets for one other card they may or may not read (§9): its title, or that there is a card they cannot see. */
function otherCardFor(svc: WorkBoardService, viewer: Viewer, mayRead: ((conversationKey: string) => boolean) | null, cardId: string): { cardId: string | null; title: string | null; visible: boolean } {
  const o = svc.view(cardId);
  if (!o || !o.card.created || o.card.redacted || !cardVisible(svc, o, viewer, mayRead)) return { cardId: null, title: null, visible: false };
  return { cardId, title: o.card.title, visible: true };
}

export function cardJson(svc: WorkBoardService, v: CardView, viewer: Viewer, name: (k: string) => string, extra?: { behind?: BehindInfo | null; lastWrittenOn?: string | null; repliedAfterQuestion?: boolean; capacity?: { reason: string; nextCheckAt: number; since: number } | null; brokenAttachments?: string[]; /** A server-owned card the server refuses console taps on (project-apps-sandbox §3.4), except withdraw-approval. */ phoneOnly?: boolean; /** agent-work-cards-default §2: the card's last progress note, or `pending` when its event has not replicated here. */ lastNote?: { text: string; at: string; eventId: string } | { pending: true; eventId: string } | null; /** The request's own time (the durable row's), for "asked <n> days ago"; falls back to the card's creation. */ askedAt?: string | null; now?: number; /** §8/§9: the viewer's conversation grant (a device), so the words of OTHER cards resolve under the viewer's own access. Absent ⇒ no grant. */ mayRead?: ((conversationKey: string) => boolean) | null }): Record<string, unknown> {
  const c = v.card;
  const lane: Lane = svc.lane(v, { isOwner: viewer.isOwner || viewer.isAgent, personKey: viewer.personKey });
  const phoneOnly = extra?.phoneOnly === true;
  const appStopped = phoneOnly && svc.isStoppedAppCard(c.cardId);
  const startedAt = svc.startedAt(c.cardId);
  const mayRead = extra?.mayRead ?? null;
  // §9: blocker words under the viewer's own access, never the other card's title or existence when they may not read it.
  const openLinks = c.blockedBy.filter((b) => !b.unblocked);
  const blockedBy = openLinks.map((b) => { const o = otherCardFor(svc, viewer, mayRead, b.blockerCardId); return { linkId: b.id, cardId: o.cardId, title: o.title, at: b.at, ...(o.visible && b.note ? { note: b.note } : {}) }; });
  const blockedTitles = blockedBy.filter((b) => b.title !== null).map((b) => b.title as string);
  const hiddenBlockers = blockedBy.length - blockedTitles.length;
  const blockedWords = !openLinks.length ? null : blockedTitles.length ? `Blocked by: ${blockedTitles.join('; ')}${hiddenBlockers ? ` and ${hiddenBlockers === 1 ? 'a card' : `${hiddenBlockers} cards`} you cannot see` : ''}` : hiddenBlockers === 1 ? 'Blocked by a card you cannot see' : `Blocked by ${hiddenBlockers} cards you cannot see`;
  const carrierName = c.carrier === 'agent' ? 'the agent' : name(c.carrier.personKey);
  const viewerIsCarrier = typeof c.carrier === 'object' && (viewer.isOwner ? c.carrier.personKey === viewer.personKey : viewer.personKey === c.carrier.personKey);
  const base = { id: c.cardId, conversationKey: c.conversationKey, status: v.status, lane, turn: turnFor(lane), started: startedAt !== null, startedAt, needLine: needLine(v, { phoneOnly, appStopped, ...(blockedWords ? { blockedWords } : {}), carrierName, viewerIsCarrier }), newestAt: new Date(c.newestRecordAt).toISOString(), ...(appStopped ? { appStopped: true } : {}) };
  if (c.redacted) {
    return { ...base, title: `Removed by ${byName(c.redacted.by, name)}`, removed: { by: byJson(c.redacted.by, name), at: c.redacted.at, note: 'The text is hidden from every read. Its bytes stay in the journal until compaction, and a backup taken earlier still holds it.' } };
  }
  const ownerish = viewer.isOwner || viewer.isAgent;
  const pending = v.pickups.filter((p) => p.status === 'pending' || p.status === 'parked');
  // §9 "The blocker shows what it blocks": the open dependents, each under the viewer's access.
  const blocks = svc.blocks(c.cardId).map((id) => otherCardFor(svc, viewer, mayRead, id));
  const blocksTitles = blocks.filter((b) => b.visible).map((b) => b.title as string);
  const hiddenBlocks = blocks.length - blocksTitles.length;
  const blocksLine = !blocks.length ? null : blocksTitles.length ? `Blocks: ${blocksTitles.join('; ')}${hiddenBlocks ? ` and ${hiddenBlocks === 1 ? 'a card' : `${hiddenBlocks} cards`} you cannot see` : ''}` : `Blocks ${hiddenBlocks === 1 ? 'a card' : `${hiddenBlocks} cards`} you cannot see`;
  // Ended links, with the blocker's close-out resolved at read (the agent gets a member's done note or the owner's "Not important" verbatim).
  const blockerHistory = c.blockedBy.filter((b) => b.unblocked).map((b) => {
    const o = otherCardFor(svc, viewer, mayRead, b.blockerCardId);
    const bc = o.visible ? svc.view(b.blockerCardId)?.card ?? null : null;
    return { linkId: b.id, cardId: o.cardId, title: o.title, at: b.at, endedAt: b.unblocked!.at, reason: b.unblocked!.reason, closeAs: bc?.closeout?.as ?? (bc?.done ? 'done' : null), closeNote: bc?.closeout?.note ?? null };
  });
  const out: Record<string, unknown> = {
    ...base,
    title: c.title, titleHash: sha256Hex(c.title), need: c.need, recommendation: c.recommendation, whyYou: c.whyYou, doneWhen: c.doneWhen,
    // A server-owned card's structured summary (display only; older clients keep reading `need`). Absent when none.
    ...(c.brief ? { brief: c.brief } : {}),
    // The Needs-you items this card is about (work-board-cards-appear §3); a server-owned card is written by the Chief of Staff itself.
    covers: c.covers, createdAt: c.createdAt, ...(isServerOwnedCard(c) ? { serverOwned: true } : {}),
    // A phone-only card keeps `outward` in its record so it needs its own approve under every board
    // policy, but approving an app version sends nothing outside the team and spends nothing.
    carrier: principalJson(c.carrier, name), outward: c.outward && !extra?.phoneOnly,
    outwardWords: c.outward && !extra?.phoneOnly ? 'This sends something outside your team or spends money' : null,
    links: c.links.map((l) => ('url' in l ? { ...l, host: safeHost(l.url), note: 'Approval covers this address, not what it serves later' } : { ...l, removed: extra?.brokenAttachments?.includes(l.attachmentId) ?? false })),
    waitingOn: principalJson(c.waitingOn, name), due: c.due,
    materialHash: c.materialHash, approvalRequired: c.approvalRequired, approved: c.approvalValid, approvedBy: c.approvedBy ? { ...c.approvedBy, by: byJson(c.approvedBy.by, name) } : null,
    withdrawn: c.withdrawn, policy: c.policy,
    question: c.openQuestion ? { id: c.openQuestion.id, text: c.openQuestion.text, options: c.openQuestion.options ?? null } : null,
    questions: c.questions.map((q) => ({ id: q.id, text: q.text, options: q.options ?? null, state: q.state, reason: q.reason ?? null, answer: q.answer ?? null, replacedBy: q.replacedBy ?? null, at: q.at })),
    evidence: c.evidence.map((e) => ({ id: e.id, itemId: e.itemId, text: e.text, attachmentIds: e.attachmentIds ?? [], counts: e.counts, at: e.at, by: byJson(e.by, name) })),
    claim: c.currentClaim ? { id: c.currentClaim.id, evidenceIds: c.currentClaim.evidenceIds, needsConfirm: c.needsConfirm, confirmedBy: c.currentClaim.confirmedBy ?? null, at: c.currentClaim.at } : null,
    done: c.done, doneByAgentOwnEvidence: c.doneByAgentOwnEvidence, reopens: c.reopens, holds: c.holds, archives: c.archives,
    // A person's Done / Not important close in force; `unarchive` naming `tapId` reopens the card.
    closeout: c.closeout ? { as: c.closeout.as, note: c.closeout.note, by: byJson(c.closeout.by, name), at: c.closeout.at, tapId: c.closeout.tapId, title: c.closeout.title } : null,
    conversation: conversationRef(c.conversationKey),
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
    ...(extra?.phoneOnly ? { phoneOnly: true } : {}),
    ...(extra?.behind ? { behind: extra.behind } : {}),
    ...(extra?.behind && extra.lastWrittenOn && extra.behind.machineId === extra.lastWrittenOn ? { mayHaveChangedOn: extra.lastWrittenOn } : {}),
    // ── agent-work-cards-default ──
    agentWork: c.agentWork,
    pickupHeld: c.pickupHeld,
    requester: c.requester ? { personKey: c.requester.personKey, name: name(c.requester.personKey), isOwner: c.requester.isOwner } : null,
    // "Asked: <need>" and its labels on a request-approved card (§1): deterministic, never a judgment of meaning.
    asked: c.requestApproved ? { need: c.need, agoWords: askedAgoWords(extra?.askedAt ?? c.createdAt, extra?.now ?? Date.now()), recordedInAgentWords: c.recordedInAgentWords, changedSinceAsked: c.changedSinceAsked, needLocked: true } : null,
    lastNote: extra?.lastNote ?? null,
    lastEvidenceAt: c.evidence.length ? c.evidence[c.evidence.length - 1].at : null,
    closeoutLabel: closeoutLabel(c),
    possibleDuplicateOf: svc.possibleDuplicateOf(c.cardId),
    // ── §8 owners, §9 blockers ──
    carrierName,
    blocked: c.blocked,
    blockedBy, blockedWords, blocks: blocks.map((b) => ({ cardId: b.cardId, title: b.title })), blocksLine, blockerHistory,
    blockerReopened: c.blockerReopened.map((r) => { const o = otherCardFor(svc, viewer, mayRead, r.blockerCardId); return { id: r.id, cardId: o.cardId, title: o.title, at: r.at, words: o.visible ? `"${o.title}", a card this one was blocked by, was reopened; nothing is blocked again` : 'a card this one was blocked by was reopened; nothing is blocked again' }; }),
    carrierDeparted: c.carrierDeparted ? { at: c.carrierDeparted.at, words: `${carrierName} is no longer on the team; this card needs a new owner`, control: 'pass' } : null,
    memberPassed: c.memberPassed,
  };
  // Internal references (§3): the agent and the owner read them; a member's view omits ids of cards they cannot read.
  if (ownerish) { out.source = c.source; out.projectKey = c.projectKey; out.refs = c.refs; }
  else out.refs = c.refs.filter((r) => r.kind !== 'parent-card' || otherCardFor(svc, viewer, mayRead, r.id).visible);
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
export function boardJson(svc: WorkBoardService, viewer: Viewer, mayRead: (conversationKey: string) => boolean, name: (k: string) => string, opts: { softOpenCards: number; donePage?: number; extraFor?: (v: CardView) => Parameters<typeof cardJson>[4]; /** Every card in every lane, no cut (the Projects read joins cards to projects and must not drop any). */ full?: boolean }): Record<string, unknown> {
  const lanes: Record<Lane, Array<{ v: CardView; json: Record<string, unknown> }>> = { 'waiting-on-you': [], 'with-agent': [], 'waiting-on-others': [], done: [], archived: [] };
  for (const id of svc.cardIds()) {
    const v = svc.view(id); if (!v || !v.card.created) continue;
    // Not visible (§8 "Who sees a card"): the card does not exist for them.
    if (!cardVisible(svc, v, viewer, mayRead)) continue;
    const json = cardJson(svc, v, viewer, name, { mayRead, ...(opts.extraFor?.(v) ?? {}) });
    lanes[json.lane as Lane].push({ v, json });
  }
  // The lanes keep their own order; within what is shown, untouched cards come first (Luna's board, a display
  // order only: which waiting cards survive the soft cut is still decided oldest first, as before).
  lanes['waiting-on-you'].sort((a, b) => a.v.card.newestRecordAt - b.v.card.newestRecordAt || (a.v.card.cardId < b.v.card.cardId ? -1 : a.v.card.cardId > b.v.card.cardId ? 1 : 0)); // card id breaks ties, so every machine cuts the same cards
  for (const l of ['with-agent', 'waiting-on-others', 'archived'] as const) lanes[l].sort((a, b) => b.v.card.newestRecordAt - a.v.card.newestRecordAt);
  lanes.done.sort((a, b) => b.v.card.newestRecordAt - a.v.card.newestRecordAt);
  const waiting = lanes['waiting-on-you'];
  const untouchedFirst = <T extends { json: Record<string, unknown> }>(xs: T[]): T[] => [...xs.filter((x) => x.json.started !== true), ...xs.filter((x) => x.json.started === true)];
  const shownWaiting = untouchedFirst(opts.full ? waiting : waiting.slice(0, opts.softOpenCards));
  const page = Math.max(0, opts.donePage ?? 0);
  const doneShown = opts.full ? lanes.done : page === 0 ? lanes.done.slice(0, 20) : lanes.done.slice(20 + (page - 1) * 50, 20 + page * 50);
  const shownIds = new Set<string>([...shownWaiting, ...lanes['with-agent'], ...lanes['waiting-on-others']].map((x) => x.v.card.cardId));
  const open = [...waiting, ...lanes['with-agent'], ...lanes['waiting-on-others']];
  return {
    myBoard: myBoardJson(viewer, open, shownIds),
    lanes: [
      { lane: 'waiting-on-you', cards: shownWaiting.map((x) => x.json), ...(waiting.length > shownWaiting.length ? { more: waiting.length - shownWaiting.length } : {}) },
      { lane: 'with-agent', cards: untouchedFirst(lanes['with-agent']).map((x) => x.json) },
      { lane: 'waiting-on-others', cards: untouchedFirst(lanes['waiting-on-others']).map((x) => x.json) },
      { lane: 'done', cards: doneShown.map((x) => x.json), total: lanes.done.length },
      { lane: 'archived', cards: lanes.archived.map((x) => x.json) },
    ],
    waitingOnYou: waiting.length,
    policy: svc.policy(),
    newestHlc: svc.newestHlc(),
    // agent-work-cards-default §1 "One aggregated row, not zero": the team's `not-started` cards, oldest first, for the
    // one Needs-you row (named so it does not collide with the myBoard sections' `notStarted` number). Owner and agent only.
    ...(viewer.isOwner || viewer.isAgent ? { notStartedCards: notStartedCardsJson(svc) } : {}),
  };
}

/** The aggregated row's data (§1): count, ids oldest first, and the approval-screen fields of the first ten. */
export function notStartedCardsJson(svc: WorkBoardService): { count: number; cardIds: string[]; shown: Array<Record<string, unknown>>; more: number } {
  const ids = svc.notStartedCardIds();
  const shown = ids.slice(0, 10).map((id) => {
    const v = svc.view(id)!; const c = v.card;
    return { id, title: c.title, titleHash: sha256Hex(c.title), materialHash: c.materialHash, need: c.need, requester: c.requester, doneWhen: c.doneWhen, links: c.links, outward: c.outward, createdAt: c.createdAt, projectKey: c.projectKey };
  });
  return { count: ids.length, cardIds: ids, shown, more: Math.max(0, ids.length - shown.length) };
}

// ── My board (docs/specs/work-board-my-board.md) ───────────────────────────

/**
 * Why a card is on the viewer's board, from Luna's `attention(card, person)`: each card once, under its most
 * pressing reason. Sections are listed in this order; a held card is shown last, as on Luna's board.
 */
export type MyBoardReason = 'approval' | 'reply' | 'own' | 'added' | 'held';
export const MY_BOARD_ORDER: readonly MyBoardReason[] = ['approval', 'reply', 'own', 'added', 'held'];
export const MY_BOARD_WORDS: Readonly<Record<MyBoardReason, string>> = {
  approval: 'Waiting for your approval',
  reply: 'Waiting for your reply',
  own: 'Your cards',
  added: 'Cards you were added to',
  held: 'Held for later',
};

/**
 * The one reason a card is on this viewer's board, or null when it does not need them. Read-only: it derives
 * from the card's status, its open question, its carrier and the viewer's lane, and decides nothing.
 * Precedence: held (the card's own status wins, as Luna's), then approval > reply > own > added.
 * The team owner (and the agent reading on the owner's behalf) is answerable for every card in their "Waiting on
 * you" lane; only the owner approves in this phase. A member sees only cards whose conversation was shared with
 * them (the board's existing viewer filter): such a card is one they were added to.
 */
export function myBoardReason(v: CardView, viewer: Viewer, lane: Lane): MyBoardReason | null {
  if (lane === 'done' || lane === 'archived') return null;
  const c = v.card;
  const me = viewer.personKey;
  const ownerish = viewer.isOwner || viewer.isAgent;
  const q = c.openQuestion?.principal;
  const qPerson = q && typeof q === 'object' ? q.personKey : null;
  const carrierPerson = typeof c.carrier === 'object' ? (c.carrier as { personKey?: string }).personKey ?? null : null;
  if (v.status === 'held') return 'held';
  if (ownerish) {
    if (v.status === 'needs-approval' || v.status === 'claims-done') return 'approval';
    // A solo agent with no team record has no owner personKey: the owner is then the only person a question can be put to.
    if (v.status === 'waiting-on-person' && qPerson && (me === null || qPerson === me)) return 'reply';
    // Every other card in the owner's "Waiting on you" lane, including the cards he carries himself (always in that lane while open).
    return lane === 'waiting-on-you' ? 'own' : null;
  }
  if (me !== null && qPerson === me && v.status === 'waiting-on-person') return 'reply';
  if (me !== null && carrierPerson === me) return 'own';
  return 'added';
}

/** The viewer's board: every section in order (clients hide empty ones); within one, untouched first, then newest activity first. */
export function myBoardJson(viewer: Viewer, open: Array<{ v: CardView; json: Record<string, unknown> }>, shownIds: Set<string>): { sections: Array<{ reason: MyBoardReason; words: string; cardIds: string[]; notStarted: number; more?: number }> } {
  const by: Record<MyBoardReason, Array<{ v: CardView; json: Record<string, unknown> }>> = { approval: [], reply: [], own: [], added: [], held: [] };
  for (const x of open) {
    const r = myBoardReason(x.v, viewer, x.json.lane as Lane);
    if (r) by[r].push(x);
  }
  return {
    sections: MY_BOARD_ORDER.map((reason) => {
      const xs = [...by[reason]].sort((a, b) => {
        const sa = a.json.started === true ? 1 : 0; const sb = b.json.started === true ? 1 : 0;
        if (sa !== sb) return sa - sb;
        if (b.v.card.newestRecordAt !== a.v.card.newestRecordAt) return b.v.card.newestRecordAt - a.v.card.newestRecordAt;
        return a.v.card.cardId < b.v.card.cardId ? -1 : 1;
      });
      const shown = xs.filter((x) => shownIds.has(x.v.card.cardId));
      return { reason, words: MY_BOARD_WORDS[reason], cardIds: shown.map((x) => x.v.card.cardId), notStarted: shown.filter((x) => x.json.started !== true).length, ...(xs.length > shown.length ? { more: xs.length - shown.length } : {}) };
    }),
  };
}

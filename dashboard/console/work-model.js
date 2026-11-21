import { parseConversationRef, hashFor, messageTarget } from './chats-model.js';

// Work board page: pure view-model (docs/specs/work-board-asks.md §4, §5, §7).
// No DOM, no fetch, no timers. work.js renders these; tests/unit/console-work-model.test.ts
// checks them. The server's card JSON (src/core/workBoardViews.ts cardJson/boardJson) is the
// contract: every tap is built from the fields of the card the person was shown, and always
// carries that card's titleHash so a tap made on an old copy of the card is refused.

import { whenWords } from './mandates-model.js';

export { whenWords };

/** The lanes, first screen first. */
export const LANES = [
  { id: 'waiting-on-you', label: 'Waiting on you', empty: 'No cards right now.' },
  { id: 'with-agent', label: 'With the agent', empty: 'The agent is not working on any card right now.' },
  { id: 'waiting-on-others', label: 'Waiting on others', empty: 'No card is waiting on someone else.' },
  { id: 'done', label: 'Done', empty: 'Nothing finished yet.' },
  { id: 'archived', label: 'Archived', empty: 'Nothing archived.' },
];

export const DONE_FIRST = 20;   // the newest finished cards the board shows by default
export const DONE_PAGE = 50;    // "Show all" pages this many at a time

const LANE_IDS = new Set(LANES.map((l) => l.id));
const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || `${one}s`)}`;

/** True when the read is the feature being switched off (503), not a failure. */
export function isOff(res) {
  return Boolean(res) && !res.ok && (res.status === 503 || /switched off|work-board-disabled/i.test(String(res.reason || '')));
}

/**
 * GET /work-board → { ok, lanes: {id: {cards, more, total}}, waitingOnYou, policy, pickups, behind, settings }.
 * A 200 that lacks the shape is { ok: false, unreadable: true }: it told us nothing.
 */
export function readBoard(body) {
  if (!isObj(body) || !Array.isArray(body.lanes)) return { ok: false, unreadable: true };
  const lanes = {};
  for (const l of body.lanes) {
    if (!isObj(l) || !LANE_IDS.has(l.lane) || !Array.isArray(l.cards)) return { ok: false, unreadable: true };
    if (l.cards.some((c) => !isObj(c) || typeof c.id !== 'string')) return { ok: false, unreadable: true };
    lanes[l.lane] = { cards: l.cards, more: typeof l.more === 'number' && l.more > 0 ? l.more : 0, total: typeof l.total === 'number' ? l.total : l.cards.length };
  }
  if (!lanes['waiting-on-you']) return { ok: false, unreadable: true };
  for (const l of LANES) if (!lanes[l.id]) lanes[l.id] = { cards: [], more: 0, total: 0 };
  const waitingOnYou = typeof body.waitingOnYou === 'number' ? body.waitingOnYou : lanes['waiting-on-you'].cards.length + lanes['waiting-on-you'].more;
  return {
    ok: true, lanes, waitingOnYou,
    policy: body.policy === 'outward-only' ? 'outward-only' : 'every-agent-card',
    pickups: isObj(body.pickups) ? body.pickups : null,
    behind: isObj(body.behind) ? body.behind : null,
    settings: isObj(body.settings) ? body.settings : null,
  };
}

// ── My board (docs/specs/work-board-my-board.md): the cards that need the reader, each once under its most pressing reason ──
export const MY_BOARD_WORDS = {
  approval: 'Waiting for your approval',
  reply: 'Waiting for your reply',
  own: 'Your cards',
  added: 'Cards you were added to',
  held: 'Held for later',
};
/** The sections that ask something of the reader lead the page; added and held cards are shown quieter. */
export const MY_BOARD_LEAD = new Set(['approval', 'reply', 'own']);
export const NOT_STARTED_WORDS = 'Not started';

/**
 * The read's `myBoard`, with each section's cards drawn from the same read's lanes (a card id the read does not
 * carry is skipped, a card named twice is shown once). Empty sections are left out. Null when the agent sends no
 * `myBoard` (an older agent) or one this page cannot read: the page then draws the lanes as before.
 * `ids` names every card shown on My board, so the lanes below can leave them out.
 */
export function readMyBoard(body, lanes) {
  if (!isObj(body) || !isObj(body.myBoard) || !Array.isArray(body.myBoard.sections) || !isObj(lanes)) return null;
  const byId = new Map();
  for (const l of LANES) for (const c of (lanes[l.id]?.cards || [])) byId.set(c.id, c);
  const ids = new Set();
  const sections = [];
  for (const s of body.myBoard.sections) {
    if (!isObj(s) || !Object.hasOwn(MY_BOARD_WORDS, s.reason) || !Array.isArray(s.cardIds)) return null;
    const cards = [];
    for (const id of s.cardIds) {
      const c = typeof id === 'string' ? byId.get(id) : undefined;
      if (c && !ids.has(id)) { ids.add(id); cards.push(c); }
    }
    const more = Number.isInteger(s.more) && s.more > 0 ? s.more : 0;
    if (!cards.length && !more) continue;
    const words = typeof s.words === 'string' && s.words.trim() ? s.words.trim() : MY_BOARD_WORDS[s.reason];
    sections.push({ reason: s.reason, words, cards, more, lead: MY_BOARD_LEAD.has(s.reason) });
  }
  return { sections, ids };
}

/** "Not started" beside a card nobody has touched yet; nothing when the agent does not say. */
export function notStartedTag(card) { return isObj(card) && card.started === false ? NOT_STARTED_WORDS : null; }

export function headline(board) {
  const n = board.waitingOnYou;
  // With no card waiting, a neutral title: the Needs-you strip above may still list things that need the
  // person, and "nothing is waiting" under it read as the page contradicting itself (2026-11-16).
  if (!n) return 'The work board';
  return n === 1 ? '1 card is waiting on you.' : `${n} cards are waiting on you.`;
}

/** One line under the head about pickups, or null. */
export function pickupLine(p) {
  if (!p) return null;
  const bits = [];
  if (p.waiting) bits.push(`${plural(p.waiting, 'card')} approved and waiting for a free session`);
  if (p.parked) bits.push(`${plural(p.parked, 'card')} could not be handed to the agent`);
  return bits.length ? `${bits.join('; ')}.` : null;
}

export function behindLine(b) {
  if (!b || !b.machineId) return null;
  return `This machine may not have the newest changes from ${b.machineId} yet, so a card here can be out of date.`;
}

// ── who ───────────────────────────────────────────────────────────────────
export function principalWords(p) {
  if (p === 'agent') return 'The agent';
  if (p === 'none') return 'Nobody';
  if (isObj(p)) return p.name || 'A person';
  return 'Unknown';
}

/** `by` from cardJson: { kind: 'person', name, proof } or { kind: 'agent' | 'session' }. */
export function byWords(by) {
  if (!isObj(by)) return 'someone unknown';
  if (by.kind === 'person') return `${by.name || 'a person'}${by.proof ? `, proved by ${by.proof === 'phone' ? 'their phone' : 'the console PIN'}` : ''}`;
  if (by.kind === 'session') return 'the agent (in the card’s conversation)';
  return 'the agent';
}

const TAP_WORDS = {
  approve: 'Approved', answer: 'Answered the question', 'confirm-done': 'Confirmed it is done', unhold: 'Released a hold',
  retry: 'Asked the agent to try again', unarchive: 'Restored it from the archive', hold: 'Put it on hold',
  'withdraw-approval': 'Withdrew approval', reopen: 'Reopened it', archive: 'Archived it', redact: 'Removed it',
};
export function tapWords(action) { return TAP_WORDS[action] || 'Did something the console cannot name'; }

// ── rows ──────────────────────────────────────────────────────────────────
/** The one-line row: title, what is needed, and a note when the person replied after the question. */
export function cardRow(card) {
  const notes = [];
  if (card.repliedAfterQuestion) notes.push('You replied; the agent has not updated the card');
  if (card.mayHaveBeenHandedOver) notes.push('This may already have been handed over');
  if (card.mayHaveChangedOn) notes.push(`This card may have changed on ${card.mayHaveChangedOn}`);
  if (card.capacity) notes.push(capacityWords(card.capacity));
  return { key: `card:${card.id}`, main: String(card.title || 'Untitled card'), sub: String(card.needLine || ''), notes, outward: Boolean(card.outward) };
}

/** capacity.words carries a raw time; say the same thing with the time in words. */
export function capacityWords(cap, now = Date.now()) {
  if (!cap) return null;
  if (cap.reason && cap.nextCheckAt) return `Approved; waiting for a free session (${cap.reason}), next check ${whenWords(cap.nextCheckAt, now)}`;
  return String(cap.words || 'Approved; waiting for a free session');
}

// ── what each card can do ─────────────────────────────────────────────────
// kind: 'permit' taps are checked against the current card; 'restrict' taps always land.
const ACTION_LABEL = {
  approve: 'Approve', answer: 'Answer', 'confirm-done': 'Confirm done', reopen: 'Reopen', unhold: 'Release hold',
  retry: 'Try again', 'withdraw-approval': 'Withdraw approval', archive: 'Archive', unarchive: 'Restore',
  hold: 'Put on hold', redact: 'Remove for good', 'close-done': 'Done', 'close-not-important': 'Not important',
};
export function actionLabel(a) { return ACTION_LABEL[a] || a; }

// ── closing a card (work-front-doors §6): Done with a note, Not important with a reason ──
/** A server that can record a close names whose turn it is on every card; an older one cannot keep the note. */
export function canClose(card) { return Boolean(card) && typeof card.turn === 'string'; }
export const CLOSE_NOTE_MAX = 2000;
export const CLOSE_WORDS = {
  'close-done': { as: 'done', label: 'What was done', hint: 'A line on what was done. It stays on the card.', missing: 'Say in a line what was done before closing this card.' },
  'close-not-important': { as: 'not-important', label: 'Why this is not important', hint: 'The agent reads these reasons before it raises a new card.', missing: 'Say why this is not important. The agent reads these reasons before it raises a new card.' },
};
/** The person's close in force, in words, or null. */
export function closeoutLine(card) {
  const c = card && card.closeout;
  if (!c || typeof c.note !== 'string') return null;
  return `${c.as === 'done' ? 'Closed as done' : 'Closed as not important'} by ${byWords(c.by)}${c.at ? `, ${whenWords(c.at)}` : ''}: ${c.note}`;
}
// ── slice 2 (docs/specs/work-board-cards-appear.md §2–3): why you, what a card is about, server-owned cards ──
/** What a card is about, in words: pull requests by number and plans by kind; never an internal id, never the Chief of Staff's own key. */
export function coversWords(card) {
  const keys = Array.isArray(card && card.covers) ? card.covers.filter((k) => typeof k === 'string') : [];
  // One line per pull request and per plan, however the key was written (pr:3404, pr:#3404, pr:03404).
  const prs = [...new Set(keys.map((k) => /^pr:#?(\d{1,7})$/.exec(k)).filter(Boolean).map((m) => Number(m[1])))].map((n) => `pull request #${n}`);
  const plans = new Set(keys.filter((k) => k.startsWith('plan:'))).size;
  const parts = [...prs, ...(plans ? [plans === 1 ? 'a plan in Needs you' : `${plans} plans in Needs you`] : [])];
  return parts.length ? parts.join(', ') : null;
}
/** A card the Chief of Staff writes and updates itself (a server-owned wait card). */
export function chiefOfStaffCard(card) { return !!card && card.serverOwned === true; }
export const CHIEF_OF_STAFF_WORDS = 'From the Chief of Staff';

/** Whose turn it is, for the card's colour: you (light red), agent or others (light blue), nobody. */
export function turnOf(card) { return card && ['you', 'agent', 'others', 'nobody'].includes(card.turn) ? card.turn : null; }

/**
 * The buttons that apply to a card, in order. `inSheet` adds the ones kept for the opened card
 * (Put on hold, Remove for good) so a row stays short.
 */
export function cardActions(card, { inSheet = false } = {}) {
  if (!card || card.removed || card.status === 'removed') return [];
  // A phone-only card (a project app's version card, project-apps-sandbox §3.4): the server refuses
  // every console tap on it except withdraw-approval, which only stops the app. So no Approve here
  // (phoneOnlyLine says where to approve) and, once approved, one "Stop this app".
  if (card.phoneOnly) return card.approved && !card.appStopped && card.status !== 'archived' ? [{ action: 'withdraw-approval', label: 'Stop this app', tone: 'quiet' }] : [];
  const out = [];
  const add = (action, tone = 'quiet') => { if (!out.some((x) => x.action === action)) out.push({ action, label: actionLabel(action), tone }); };
  const approved = Boolean(card.approved);
  switch (card.status) {
    case 'needs-approval': add('approve', 'primary'); break;
    case 'waiting-on-person': if (card.question) add('answer', 'primary'); break;
    case 'claims-done': if (card.claim) { add('confirm-done', 'primary'); add('reopen'); } break;
    case 'done': if (card.claim) add('reopen'); break;
    case 'held': if ((card.holds || []).length) add('unhold', 'primary'); break;
    case 'parked': if (card.retryOf) add('retry', 'primary'); if (approved) add('withdraw-approval'); break;
    case 'quiet': if (card.retryOf) add('retry', 'primary'); if (approved) add('withdraw-approval'); break;
    case 'with-agent': if (card.retryOf) add('retry'); if (approved) add('withdraw-approval'); break;
    case 'archived': if ((card.closeout && card.closeout.tapId) || (card.archives || []).length) add('unarchive', 'primary'); break;
    default: break;
  }
  // A close in force is closed whatever the status reads (an unreadable record makes it 'unknown'): reopening it names the close itself.
  const closed = card.status === 'archived' || Boolean(card.closeout);
  if (card.closeout && card.closeout.tapId) add('unarchive', 'primary');
  // An answer can be given while the card is in another state too (a question on a held card).
  if (card.question && card.status !== 'waiting-on-person' && !closed) add('answer');
  if (!closed) {
    // A card still waiting for approval has nothing done yet: it can only be dismissed as Not important.
    if (canClose(card)) { if (card.status !== 'needs-approval') add('close-done'); add('close-not-important'); } else add('archive');
  }
  if (inSheet) {
    if (card.status !== 'held' && !closed && card.status !== 'done') add('hold');
    add('redact', 'danger');
  }
  if (card.closeout) {
    // One way back from a close: reopening the close itself (the claim's own Reopen would leave it closed).
    for (const x of out) if (x.action === 'unarchive') x.label = 'Reopen';
    return out.filter((x) => x.action !== 'reopen');
  }
  return out;
}

/** What a phone-only card says in place of an Approve button, or null for any other card. */
export function phoneOnlyLine(card) {
  if (!card || !card.phoneOnly || card.removed || card.status === 'removed') return null;
  // A stopped app's card has nothing to approve (its need line says it was stopped).
  if (card.appStopped) return null;
  return card.approved ? null : 'Approve this on your phone';
}

/**
 * The tap body (without the PIN) for one action on the card as shown. Returns { ok, body } or
 * { ok: false, reason } when the card lacks what the tap must bind to.
 */
export function tapBody(card, action, extra = {}) {
  if (!card) return { ok: false, reason: 'No card.' };
  const body = { action };
  if (typeof card.titleHash === 'string') body.titleHash = card.titleHash;
  const need = (v, reason) => (v ? null : { ok: false, reason });
  let miss = null;
  switch (action) {
    case 'approve': miss = need(card.materialHash, 'This card cannot be approved as it stands.'); body.materialHash = card.materialHash; break;
    case 'answer': {
      const q = card.question;
      const answer = typeof extra.answer === 'string' ? extra.answer.trim() : '';
      miss = need(q && q.id, 'There is no open question to answer.') || need(answer, 'Type or choose an answer.');
      if (q) body.questionId = q.id;
      body.answer = answer;
      break;
    }
    case 'confirm-done':
      miss = need(card.claim && card.claim.id, 'The agent has not said this is done.') || need(card.materialHash, 'This card cannot be confirmed as it stands.');
      if (card.claim) body.claimId = card.claim.id;
      body.materialHash = card.materialHash;
      break;
    case 'reopen': miss = need(card.claim && card.claim.id, 'There is nothing to reopen.'); if (card.claim) body.claimId = card.claim.id; break;
    case 'unhold': {
      const names = extra.names || (card.holds || [])[0];
      miss = need(names, 'There is no hold to release.'); body.names = names; break;
    }
    case 'unarchive': {
      const names = extra.names || (card.closeout && card.closeout.tapId) || (card.archives || [])[0];
      miss = need(names, 'This card is not archived.'); body.names = names; break;
    }
    case 'retry': miss = need(card.retryOf, 'There is nothing to try again.'); body.retryOf = card.retryOf; break;
    case 'hold': case 'withdraw-approval': case 'archive': case 'redact': break;
    case 'close-done': case 'close-not-important': {
      const words = CLOSE_WORDS[action];
      const note = typeof extra.note === 'string' ? extra.note.trim() : '';
      miss = need(note, words.missing) || (note.length > CLOSE_NOTE_MAX ? { ok: false, reason: `Keep it under ${CLOSE_NOTE_MAX} characters.` } : null);
      body.action = 'archive'; body.closeAs = words.as; body.note = note;
      break;
    }
    default: return { ok: false, reason: 'That is not something a card can do.' };
  }
  return miss || { ok: true, body };
}

// ── what a tap covers (§4 "What the person is shown before any tap") ─────
export function doneItemLines(card) {
  return (card.doneWhen || []).map((it) => ({
    id: it.id, text: String(it.text || ''),
    agentMay: it.certify === 'agent-may-certify',
    mark: it.certify === 'agent-may-certify' ? 'The agent may finish this on its own evidence' : 'You confirm this one',
  }));
}

/** The evidence a claim rests on, per done item. */
export function claimEvidence(card) {
  const ids = new Set((card.claim && card.claim.evidenceIds) || []);
  const ev = (card.evidence || []).filter((e) => ids.has(e.id));
  return doneItemLines(card).map((it) => ({ ...it, evidence: ev.filter((e) => e.itemId === it.id).map((e) => String(e.text || '')) }));
}

export function evidenceByItem(card) {
  return doneItemLines(card).map((it) => ({ ...it, evidence: (card.evidence || []).filter((e) => e.itemId === it.id) }));
}

export const OUTWARD_WORDS = 'This sends something outside your team or spends money';
export const LINK_NOTE = 'Approval covers this address, not what it serves later';

export function linkLines(card) {
  return (card.links || []).map((l) => (l.url
    ? { label: String(l.label || l.host || 'Link'), url: /^https:\/\//i.test(l.url) ? l.url : null, host: l.host || '', note: l.note || LINK_NOTE }
    : { label: String(l.label || 'A file'), file: true, removed: Boolean(l.removed), note: l.removed ? 'This file was removed from the conversation' : 'A file in this card’s conversation' }));
}

/**
 * The lines the confirm step shows: exactly what the tap covers. Each is { label, text } or
 * { label, items: [...] }. Restricting taps say plainly what they do and that they always land.
 */
export function tapCovers(card, action, extra = {}) {
  const lines = [{ label: 'Card', text: String(card.title || '') }];
  const full = () => {
    if (card.need) lines.push({ label: 'What is needed', text: String(card.need) });
    if (card.recommendation) lines.push({ label: 'The agent recommends', text: String(card.recommendation) });
    lines.push({ label: 'Done when', items: doneItemLines(card).map((it) => `${it.text} (${it.mark})`) });
    lines.push({ label: 'Carried by', text: principalWords(card.carrier) });
    lines.push({ label: 'Outside your team', text: card.outward ? (card.outwardWords || OUTWARD_WORDS) : 'Nothing is sent outside your team and nothing is spent' });
    const links = linkLines(card);
    if (links.length) lines.push({ label: 'Links', items: links.map((l) => (l.file ? `${l.label}: ${l.note}` : `${l.label} (${l.host || 'unknown site'}): ${l.note}`)) });
    if (card.question) lines.push({ label: 'Open question', text: String(card.question.text || '') });
    if (card.mayHaveBeenHandedOver) lines.push({ label: 'Warning', text: 'This may already have been handed over. Check its conversation first.' });
  };
  switch (action) {
    case 'approve': full(); lines.push({ label: 'Your approval', text: 'Lets the agent start on exactly this card. Any later change to it needs your approval again.' }); break;
    case 'answer': lines.push({ label: 'Question', text: String((card.question && card.question.text) || '') }); if (card.recommendation) lines.push({ label: 'The agent recommends', text: String(card.recommendation) }); lines.push({ label: 'Your answer', text: String(extra.answer || '') }); break;
    case 'confirm-done':
      lines.push({ label: 'Each done item and its evidence', items: claimEvidence(card).map((it) => `${it.text}: ${it.evidence.length ? it.evidence.join(' / ') : 'no evidence listed'}`) });
      lines.push({ label: 'Your confirmation', text: 'Finishes the card on this evidence.' });
      break;
    case 'retry': full(); lines.push({ label: 'Trying again', text: 'The agent gets one more try at this card.' }); break;
    case 'unhold': full(); lines.push({ label: 'Releasing the hold', text: (card.holds || []).length > 1 ? `Releases one of ${card.holds.length} holds; the card stays held until every hold is released.` : 'The agent may carry on.' }); break;
    case 'unarchive': {
      full();
      // Reopening releases one archive; an older one keeps the card archived until it is restored too.
      const more = (card.archives || []).length > 1;
      lines.push(card.closeout
        ? { label: 'Reopening', text: `${more ? 'This undoes the close. The card was also archived earlier, so it stays archived until you restore it too.' : 'The card comes back to the board.'} Your close note stays in its history: ${card.closeout.note}` }
        : { label: 'Restoring', text: more ? 'This releases one of its archives. The card stays archived until every archive is released.' : 'The card comes back to the board.' });
      break;
    }
    case 'reopen': lines.push({ label: 'Reopening', text: 'The card is not finished. From now on every finish of this card needs your sign-off.' }); break;
    case 'hold': lines.push({ label: 'Putting on hold', text: 'The agent stops work on this card until you release it. This always goes through.' }); break;
    case 'withdraw-approval': lines.push(card.phoneOnly
      ? { label: 'Stopping this app', text: 'The app stops running. Turning it back on comes in a later update. This always goes through.' }
      : { label: 'Withdrawing approval', text: 'The agent stops and waits for your approval again. This always goes through.' }); break;
    case 'archive': lines.push({ label: 'Archiving', text: 'The card leaves the board. You can restore it later.' }); break;
    case 'close-done': lines.push({ label: 'Your note', text: String(extra.note || '').trim() }, { label: 'Closing as done', text: 'The card moves to Done with your note. You can reopen it later.' }); break;
    case 'close-not-important': lines.push({ label: 'Your reason', text: String(extra.note || '').trim() }, { label: 'Closing as not important', text: 'The card is archived. The agent reads your reason before it raises a new card. You can reopen it later.' }); break;
    case 'redact': lines.push({ label: 'Removing for good', text: 'The card’s text is hidden from every read and its conversation is deleted. This cannot be undone.' }); break;
    default: break;
  }
  return lines;
}

export const CLOSE_TITLES = { 'close-done': 'Close as done', 'close-not-important': 'Close as not important' };
/** The one line the PIN prompt says. */
export function pinExplain(card, action) {
  return `${card && card.phoneOnly && action === 'withdraw-approval' ? 'Stop this app' : CLOSE_TITLES[action] || actionLabel(action)}: “${String(card.title || '').slice(0, 80)}”. Your PIN confirms exactly what you were just shown.`;
}

// ── refusals, in words ────────────────────────────────────────────────────
const REFUSAL_WORDS = {
  'stale-card': 'The card changed since you opened it. Look at it again before deciding.',
  'question-replaced': 'The agent replaced that question with a new one. Look at the new question.',
  'card-removed': 'This card was removed.',
  'answer-required': 'Type or choose an answer.',
  'retry-of-required': 'There is nothing to try again.',
  'claim-required': 'There is nothing to reopen.',
  'owner-required': 'Only the team owner can do this.',
  'person-required': 'This needs you, signed in with your PIN.',
  'no-team-owner': 'This agent has no team owner yet, so nobody can decide on cards.',
  'not-found': 'That card is not on the board any more.',
  'work-board-disabled': 'The work board is switched off on this agent.',
  'work-board-starting': 'The work board is still starting. Try again in a moment.',
  'invalid-setting': 'A setting was not a whole number above zero, or the free check was set more often than once a minute.',
  'settings-not-saved': 'The settings could not be saved.',
  'unknown-policy': 'That approval choice is not one the board knows.',
  'over-limit': 'That is longer than a card allows.',
  'phone-only-card': 'Approve this on your phone.',
  'server-owned-card': 'Instar writes this card itself; it cannot be changed here.',
  'note-required': CLOSE_WORDS['close-done'].missing,
  'reason-required': CLOSE_WORDS['close-not-important'].missing,
  'unknown-close': 'That is not a way to close a card.',
};
export function refusalWords(status, data) {
  const code = data && typeof data.error === 'string' ? data.error : '';
  if (REFUSAL_WORDS[code]) return REFUSAL_WORDS[code];
  if (status === 401 || status === 403) return /pin/i.test(code) ? 'That PIN did not work.' : 'This needs your PIN.';
  if (status === 429) return 'Too many PIN tries. Wait a little and try again.';
  if (status === 0) return 'The server could not be reached.';
  if (code === 'credential-refused' && data && typeof data.message === 'string') return data.message;
  if (code && !/^[a-z0-9-]+$/.test(code)) return code; // already a sentence (the PIN check writes one)
  return 'That did not go through.';
}

// ── Done paging ───────────────────────────────────────────────────────────
export function donePageFrom(query) {
  try {
    const n = Number.parseInt(new URLSearchParams(String(query || '').replace(/^\?/, '')).get('donePage') || '0', 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch { return 0; }
}
export function cardFromQuery(query) {
  try { const c = new URLSearchParams(String(query || '').replace(/^\?/, '')).get('card'); return c && /^wc_[0-9a-f]{16}$/.test(c) ? c : null; } catch { return null; }
}
/** { shownFrom, shownTo, next, prev } hrefs for the Done lane. */
export function donePaging(total, page) {
  const from = page === 0 ? 0 : DONE_FIRST + (page - 1) * DONE_PAGE;
  const to = page === 0 ? Math.min(total, DONE_FIRST) : Math.min(total, DONE_FIRST + page * DONE_PAGE);
  return {
    line: total > 0 ? `Showing ${from + 1}–${to} of ${total}` : null,
    next: to < total ? { href: `#/work/board?donePage=${page + 1}`, text: page === 0 ? 'Show all' : `Show the next ${Math.min(DONE_PAGE, total - to)}` } : null,
    prev: page > 0 ? { href: page === 1 ? '#/work/board' : `#/work/board?donePage=${page - 1}`, text: page === 1 ? 'Back to the newest' : 'Show the previous ones' } : null,
  };
}

// ── settings ──────────────────────────────────────────────────────────────
export const POLICIES = [
  { id: 'every-agent-card', label: 'Wait for my OK on every card', words: 'The agent waits for your OK on every card it writes.' },
  { id: 'outward-only', label: 'Only outward cards wait', words: 'The agent starts internal cards at once; only cards that send something outside your team or spend money wait for you. Under this choice the agent’s own outward mark on a card is the only thing that asks for your approval.' },
];

/** The numeric limits, by path in the settings object, with plain labels. */
export const SETTING_FIELDS = [
  { path: 'softOpenCards', label: 'Cards shown waiting on you before the rest are counted in one line' },
  { path: 'quietAfterHours', label: 'Hours without news before a card counts as gone quiet' },
  { path: 'maxAgentCardsPerDay', label: 'Cards the agent may write in a day' },
  { path: 'pickup.maxSpendingAttempts', label: 'Tries at handing a card over before it stops and asks you' },
  { path: 'pickup.surfaceAfterHours', label: 'Hours an approved card waits for a free session before it also waits on you' },
  { path: 'pickup.freeCheckMinSeconds', label: 'Seconds before the first check for a free session (at least 60)', min: 60 },
  { path: 'pickup.freeCheckMaxSeconds', label: 'Longest wait, in seconds, between checks for a free session' },
  { path: 'pickup.tickSeconds', label: 'Seconds between the board’s own rounds' },
  { path: 'pickup.ownerCatchUpSeconds', label: 'Seconds to wait for another machine to catch up after a hand-over' },
  { path: 'limits.title', label: 'Longest title, in characters' },
  { path: 'limits.need', label: 'Longest description of what is needed, in characters' },
  { path: 'limits.recommendation', label: 'Longest recommendation, in characters' },
  { path: 'limits.doneItemText', label: 'Longest done item, in characters' },
  { path: 'limits.optionText', label: 'Longest answer option, in characters' },
  { path: 'limits.recordBytes', label: 'Largest single change to a card, in bytes' },
];

export function settingValue(settings, path) {
  let v = settings;
  for (const k of path.split('.')) v = isObj(v) ? v[k] : undefined;
  return typeof v === 'number' ? v : null;
}

/**
 * values: path → string as typed. Returns { ok, patch } (nested, changed fields only) or
 * { ok: false, path, message }.
 */
export function settingsPatch(settings, values) {
  const patch = {};
  for (const f of SETTING_FIELDS) {
    if (!(f.path in values)) continue;
    const raw = String(values[f.path]).trim();
    if (raw === '') continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) return { ok: false, path: f.path, message: `“${f.label}” must be a whole number above zero.` };
    if (f.min && n < f.min) return { ok: false, path: f.path, message: `“${f.label}” must be at least ${f.min}.` };
    if (n === settingValue(settings, f.path)) continue;
    const keys = f.path.split('.');
    let at = patch;
    for (const k of keys.slice(0, -1)) at = at[k] = at[k] || {};
    at[keys[keys.length - 1]] = n;
  }
  return { ok: true, patch };
}

export function policyPinExplain(policy, wouldStart) {
  const p = POLICIES.find((x) => x.id === policy) || POLICIES[0];
  const n = typeof wouldStart === 'number' ? wouldStart : null;
  const start = n === null ? 'The console could not count how many waiting cards would start.' : n === 0 ? 'No waiting card would start at once.' : `${plural(n, 'waiting card')} would start at once.`;
  return `Change how approval works: ${p.words} ${start}`;
}

// ── Home (needs-model.js) ─────────────────────────────────────────────────
/**
 * The Home rows for the work board: one per card waiting on the person, plus one line for the
 * cards past the soft budget. Off (503) ⇒ []; a failed read or a 200 without the shape ⇒ null
 * (unreadable, never "nothing waiting"). Rows are { key, main, sub, href }.
 */
export function workBoardNeedRows(wb) {
  if (!wb || !wb.ok) return isOff(wb) ? [] : null;
  const b = readBoard(wb.data);
  if (!b.ok) return null;
  const lane = b.lanes['waiting-on-you'];
  const soft = b.settings && typeof b.settings.softOpenCards === 'number' && b.settings.softOpenCards > 0 ? b.settings.softOpenCards : Infinity;
  const shown = lane.cards.slice(0, soft);
  const rest = lane.more + (lane.cards.length - shown.length);
  const rows = shown.map((c) => ({
    key: `work:${c.id}`,
    main: String(c.title || 'A work card').slice(0, 80),
    sub: String(c.needLine || ''),
    href: `#/work/board?card=${encodeURIComponent(c.id)}`,
    // The Needs-you items this card is about (work-board-cards-appear §3). Only a card that just waits on the
    // person to act (no Approve, no Confirm done, no open question, nothing outward) may stand in for its rows.
    covers: Array.isArray(c.covers) ? c.covers.filter((k) => typeof k === 'string') : [],
    linkable: c.status === 'with-person' && !c.outward && !c.question,
    // Only the Chief of Staff's own wait card stands in for its row; an agent session's card keeps its own row too.
    serverOwned: c.serverOwned === true,
    createdAt: typeof c.createdAt === 'string' ? c.createdAt : '',
    cardId: c.id,
  }));
  if (rest > 0) rows.push({ key: 'work:more', main: rest === 1 ? '1 more card is waiting on you' : `${rest} more cards are waiting on you`, sub: 'On the work board, oldest first.', href: '#/work/board' });
  return rows;
}

/** Source is already viewer-filtered by the board read. Never infer it from placement. */
export function cardSourceLink(card) {
  if (!card || card.removed || !card.source) return null;
  const ref = parseConversationRef(card.source.conversationKey);
  const target = messageTarget(card.source.messageId);
  if (!ref) return { href: null, label: 'The original message cannot be opened here.' };
  if (!target) return { href: hashFor(ref), label: 'Original conversation', note: 'The exact message is unavailable.' };
  return { href: `${hashFor(ref)}&m=${encodeURIComponent(target)}`, label: 'Original message' };
}

// A work board card, read for people (Justin, 2026-11-18: "make the content extremely pleasant and easy to digest").
// Pure: no DOM, no fetch, no timers. work.js draws what these return; tests/unit/console-work-brief.test.ts checks them.
//
// A card may carry `brief = { ask, goal?, checks?: [{ text, status }], chiefSaid?, waitingSince? }`. A card without
// one (every card written before the brief existed, and every card a session writes) is read from its `need` prose:
// the Chief of Staff's wait card has a fixed shape (src/core/ChiefOfStaffWaitCards.ts composeWaitCard), so its
// goal, checklist, quoted check note and wait start are split out; any other need stays one Markdown body.

export const CHECK_STATUSES = ['passes', 'needs-you', 'unknown', 'fails'];
/** What each check status shows: an icon, its words for a screen reader, and its colour class. */
export const CHECK_LOOK = {
  passes: { icon: '✓', words: 'Passes' },
  'needs-you': { icon: '●', words: 'Needs you' },
  unknown: { icon: '○', words: 'Not known yet' },
  fails: { icon: '✕', words: 'Fails' },
};

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Undo the Markdown escapes inertText adds ("\(" → "("), so the words read as typed. */
export function unescapeMd(text) {
  return String(text ?? '').replace(/\\([\\`*_[\]()<>!#|~])/g, '$1');
}

/** The wait's internal id "(wait c5c23e80)" means nothing to a person. */
export function dropWaitId(text) {
  return String(text ?? '').replace(/\s*\(wait [0-9a-f]{4,}\)/gi, '');
}

/** A checklist state in the need's words, as one of CHECK_STATUSES; null when the words are not a state. */
export function checkStatusOf(words) {
  const w = String(words ?? '').trim().toLowerCase();
  if (w === 'passes' || w === 'pass' || w === 'passed') return 'passes';
  if (w === 'fails' || w === 'fail' || w === 'failed') return 'fails';
  if (w === 'needs your judgment' || w === 'needs your judgement' || w === 'needs you') return 'needs-you';
  if (w === 'not known' || w === 'unknown' || w === 'not known yet') return 'unknown';
  return null;
}

const GOAL = /^Goal:\s*/;
const CHECKLIST = /^Done when \(from the project\):\s*/;
const SAID = /check said \(its own words\):\s*"([\s\S]*)"/;
const SINCE = /^Waiting on you since (\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)(?:\s*UTC|Z)?/;
const ITEM = /^-\s+([\s\S]*?)(?::\s*(passes|fails|not known|needs your judgment))?\s*$/i;

/**
 * Split a need into its parts. `structured` is true only when the need has the Chief of Staff's shape (a goal, a
 * checklist, a quoted check note or a wait start); then `intro` holds the other paragraphs, plain. Otherwise the
 * caller shows the need as it is.
 */
export function parseNeed(text) {
  const out = { intro: [], goal: null, checks: [], chiefSaid: null, waitingSince: null, structured: false };
  const paras = String(text ?? '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  for (const p of paras) {
    if (GOAL.test(p)) { out.goal = unescapeMd(p.replace(GOAL, '')).trim() || null; continue; }
    if (CHECKLIST.test(p)) {
      const lines = p.replace(CHECKLIST, '').split('\n').map((l) => l.trim()).filter(Boolean);
      for (const l of lines) {
        const m = ITEM.exec(l);
        if (!m) continue;
        const status = checkStatusOf(m[2]);
        const t = unescapeMd(m[1]).trim();
        if (t) out.checks.push({ text: t, status });
      }
      continue;
    }
    const said = SAID.exec(p);
    if (said) { out.chiefSaid = unescapeMd(said[1]).trim() || null; continue; }
    const since = SINCE.exec(p);
    if (since) {
      const iso = `${since[1]}T${since[2].length === 5 ? `${since[2]}:00` : since[2]}Z`;
      out.waitingSince = Number.isFinite(Date.parse(iso)) ? iso : null;
      continue;
    }
    out.intro.push(unescapeMd(dropWaitId(p)).trim());
  }
  out.structured = Boolean(out.goal || out.checks.length || out.chiefSaid || out.waitingSince);
  return out;
}

/** The Chief of Staff's opening line that says nothing the title does not. */
const GENERIC_INTRO = /^The Chief of Staff marks this project waiting on you\.?$/i;

/** The first sentence of a plain-text body, at most `max` characters. */
export function firstSentence(text, max = 220) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  const m = /^(.+?[.!?])(\s|$)/.exec(flat);
  const s = m ? m[1] : flat;
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

function briefChecks(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const c of list) {
    if (!isObj(c) || !str(c.text)) continue;
    out.push({ text: str(c.text), status: CHECK_STATUSES.includes(c.status) ? c.status : 'unknown' });
  }
  return out;
}

/**
 * Everything the redesigned card shows, from `card.brief` when it is there and from the need otherwise:
 * { ask, goal, checks, chiefSaid, waitingSince, intro, body, fromBrief }.
 * `body` is the need to show as Markdown when it has no structure (a session's card), else null.
 */
export function cardBrief(card) {
  const c = isObj(card) ? card : {};
  const b = isObj(c.brief) ? c.brief : null;
  const parsed = parseNeed(c.need);
  const intro = parsed.intro.filter((p) => !GENERIC_INTRO.test(p));
  let ask = str(b && b.ask);
  if (!ask) {
    if (parsed.structured) ask = intro[0] || parsed.chiefSaid || null;
    else ask = firstSentence(c.need ? unescapeMd(c.need) : '');
  }
  if (!ask) ask = str(c.needLine);
  const chiefSaidRaw = str(b && b.chiefSaid) || parsed.chiefSaid;
  const waitingSince = (b && str(b.waitingSince) && Number.isFinite(Date.parse(b.waitingSince)) ? b.waitingSince : null) || parsed.waitingSince;
  const body = parsed.structured || !str(c.need) ? null : String(c.need);
  return {
    ask,
    goal: str(b && b.goal) || parsed.goal,
    checks: briefChecks(b && b.checks) || parsed.checks,
    // Said once: when the check note is the ask, Details does not repeat it.
    chiefSaid: chiefSaidRaw && chiefSaidRaw !== ask ? chiefSaidRaw : null,
    waitingSince,
    intro: intro.filter((p) => p !== ask),
    body: body && firstSentence(unescapeMd(body)) === ask && unescapeMd(body).replace(/\s+/g, ' ').trim() === ask ? null : body,
    fromBrief: Boolean(b && str(b.ask)),
  };
}

/** The status chip's words for a card: short, in the person's terms. */
const STATUS_WORDS = {
  'needs-approval': 'Needs your approval', 'with-person': 'Waiting on you', 'waiting-on-person': 'Waiting for your answer',
  'claims-done': 'Says it is done', held: 'On hold', 'with-agent': 'With the agent', parked: 'Parked', quiet: 'Quiet',
  done: 'Done', archived: 'Closed', removed: 'Removed', unknown: 'Partly unreadable',
};
export function statusChip(card) {
  const c = isObj(card) ? card : {};
  const words = STATUS_WORDS[c.status] || (c.turn === 'you' ? 'Waiting on you' : 'On the board');
  // An older server sends no turn: its lane says the same thing.
  const turn = typeof c.turn === 'string' ? c.turn : c.lane === 'waiting-on-you' ? 'you' : c.lane === 'with-agent' ? 'agent' : null;
  const kind = turn === 'you' ? 'you' : turn === 'agent' || turn === 'others' ? 'moving' : 'still';
  return { words, kind };
}

/** "Waiting on you · since yesterday 2:15 PM" when the card waits on the reader and its start is known. */
export function waitingWords(card, since, now = Date.now(), { short = false } = {}) {
  if (!since || !isObj(card)) return null;
  const t = Date.parse(since);
  if (!Number.isFinite(t)) return null;
  // A tile already says "Waiting on you" in its chip, so its footer says only since when.
  if (short) return `Since ${whenWords(since, now)}`;
  const lead = card.turn === 'you' ? 'Waiting on you' : 'Waiting';
  return `${lead} · since ${whenWords(since, now)}`;
}

/** The tile's one line under the title: a closed card says how it closed; an open one says its ask. */
export function tileAsk(card, brief) {
  const c = isObj(card) ? card : {};
  if (c.closeout || c.status === 'archived' || c.status === 'done' || c.status === 'removed') return str(c.needLine);
  return (brief && brief.ask) || str(c.needLine);
}

const QUIET_ACTIONS = new Set(['hold', 'redact']);
/**
 * The card's buttons in three ranks: one primary (filled), the other real choices (outlined), and the quiet
 * ones (Put on hold, Remove for good) shown as plain text. The tile shows only the primary.
 */
export function rankActions(actions) {
  const list = Array.isArray(actions) ? actions : [];
  const main = list.filter((a) => !QUIET_ACTIONS.has(a.action));
  const primary = main.find((a) => a.tone === 'primary') || main.find((a) => a.action === 'close-done') || main[0] || null;
  return {
    primary,
    secondary: main.filter((a) => a !== primary),
    quiet: list.filter((a) => QUIET_ACTIONS.has(a.action)),
  };
}

/**
 * A conversation read (GET /mobile/chat/app/:key/messages) as chat lines, oldest first:
 * [{ id, who: 'you' | 'agent' | 'board', name, text, at }]. Null when the read is not that shape.
 */
export function chatLines(data, max = 30) {
  if (!isObj(data) || !Array.isArray(data.messages)) return null;
  const rows = data.messages.filter((m) => isObj(m) && typeof m.text === 'string' && m.text.trim());
  const lines = rows.map((m, i) => {
    const who = m.systemSource ? 'board' : m.role === 'operator' ? 'you' : 'agent';
    const name = who === 'board' ? 'Work board' : who === 'you' ? (str(m.senderName) || 'You') : 'Agent';
    return { id: String(m.messageId || m.eventId || i), who, name, text: m.text, at: typeof m.at === 'string' ? m.at : null };
  });
  lines.sort((a, b) => (Date.parse(a.at || '') || 0) - (Date.parse(b.at || '') || 0));
  return lines.slice(-max);
}

/** Where a card's conversation is read, only ever an app conversation path on this server. */
export function messagesPathOf(card) {
  const c = isObj(card) ? card : {};
  const p = isObj(c.conversation) ? c.conversation.messagesPath : null;
  if (typeof p === 'string' && /^\/mobile\/chat\/app\/[A-Za-z0-9-]+\/messages$/.test(p)) return `${p}?limit=30&scope=pool`;
  if (typeof c.conversationKey === 'string' && /^[A-Za-z0-9-]+$/.test(c.conversationKey)) return `/mobile/chat/app/${c.conversationKey}/messages?limit=30&scope=pool`;
  return null;
}

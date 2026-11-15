// Work board page: pure view-model (docs/specs/work-board-asks.md §4, §5, §7).
// No DOM, no fetch, no timers. work.js renders these; tests/unit/console-work-model.test.ts
// checks them. The server's card JSON (src/core/workBoardViews.ts cardJson/boardJson) is the
// contract: every tap is built from the fields of the card the person was shown, and always
// carries that card's titleHash so a tap made on an old copy of the card is refused.

import { whenWords } from './mandates-model.js';

export { whenWords };

/** The lanes, first screen first. */
export const LANES = [
  { id: 'waiting-on-you', label: 'Waiting on you', empty: 'Nothing is waiting on you.' },
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

export function headline(board) {
  const n = board.waitingOnYou;
  if (!n) return 'Nothing on the board is waiting on you.';
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
  hold: 'Put on hold', redact: 'Remove for good',
};
export function actionLabel(a) { return ACTION_LABEL[a] || a; }

/**
 * The buttons that apply to a card, in order. `inSheet` adds the ones kept for the opened card
 * (Put on hold, Remove for good) so a row stays short.
 */
export function cardActions(card, { inSheet = false } = {}) {
  if (!card || card.removed || card.status === 'removed') return [];
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
    case 'archived': if ((card.archives || []).length) add('unarchive', 'primary'); break;
    default: break;
  }
  // An answer can be given while the card is in another state too (a question on a held card).
  if (card.question && card.status !== 'waiting-on-person' && card.status !== 'archived') add('answer');
  if (card.status !== 'archived') add('archive');
  if (inSheet) {
    if (card.status !== 'held' && card.status !== 'archived' && card.status !== 'done') add('hold');
    add('redact', 'danger');
  }
  return out;
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
      const names = extra.names || (card.archives || [])[0];
      miss = need(names, 'This card is not archived.'); body.names = names; break;
    }
    case 'retry': miss = need(card.retryOf, 'There is nothing to try again.'); body.retryOf = card.retryOf; break;
    case 'hold': case 'withdraw-approval': case 'archive': case 'redact': break;
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
    case 'unarchive': full(); lines.push({ label: 'Restoring', text: 'The card comes back to the board.' }); break;
    case 'reopen': lines.push({ label: 'Reopening', text: 'The card is not finished. From now on every finish of this card needs your sign-off.' }); break;
    case 'hold': lines.push({ label: 'Putting on hold', text: 'The agent stops work on this card until you release it. This always goes through.' }); break;
    case 'withdraw-approval': lines.push({ label: 'Withdrawing approval', text: 'The agent stops and waits for your approval again. This always goes through.' }); break;
    case 'archive': lines.push({ label: 'Archiving', text: 'The card leaves the board. You can restore it later.' }); break;
    case 'redact': lines.push({ label: 'Removing for good', text: 'The card’s text is hidden from every read and its conversation is deleted. This cannot be undone.' }); break;
    default: break;
  }
  return lines;
}

/** The one line the PIN prompt says. */
export function pinExplain(card, action) {
  return `${actionLabel(action)}: “${String(card.title || '').slice(0, 80)}”. Your PIN confirms exactly what you were just shown.`;
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
};
export function refusalWords(status, data) {
  const code = data && typeof data.error === 'string' ? data.error : '';
  if (REFUSAL_WORDS[code]) return REFUSAL_WORDS[code];
  if (status === 401 || status === 403) return /pin/i.test(code) ? 'That PIN did not work.' : 'This needs your PIN.';
  if (status === 429) return 'Too many PIN tries. Wait a little and try again.';
  if (status === 0) return 'The server could not be reached.';
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
  }));
  if (rest > 0) rows.push({ key: 'work:more', main: rest === 1 ? '1 more card is waiting on you' : `${rest} more cards are waiting on you`, sub: 'On the work board, oldest first.', href: '#/work/board' });
  return rows;
}

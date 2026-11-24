// Work board page (docs/specs/work-board-asks.md §7 "Console page Work").
// The first screen is the lane Waiting on you: one row per card with what is needed and its
// buttons. Then With the agent, Waiting on others, Done (paged) and Archived, then the owner's
// settings. Opening a card shows everything a tap covers. Every tap first shows exactly what it
// covers (§4), then asks for the dashboard PIN, then sends the card's own binding fields.
//
// SAFETY: every value from the server goes through textContent via el(), except a card's need,
// which is light Markdown: it only reaches the page as a DOM fragment DOMPurify produced from a
// short allow-list (no images, no raw HTML). Without the formatter it is shown as plain text.

import { el, setKids, pageHead, sheet, closeSheet, note, cantTell, firstPaint, markNeed, askPin } from './ui.js';
import { hashFor } from './chats-model.js';
import { projectsSection } from './projects.js';
import { workDiscoveryPanel } from './work-discovery.js';
import {
  LANES, readBoard, readMyBoard, notStartedTag, headline, pickupLine, behindLine, machineWords, isOff, cardRow, cardActions, phoneOnlyLine, tapBody, tapCovers, pinExplain,
  cardSourceLink, refusalWords, donePageFrom, cardFromQuery, donePaging, evidenceByItem, linkLines, principalWords,
  byWords, tapWords, capacityWords, whenWords, POLICIES, SETTING_FIELDS, settingValue, settingsPatch, policyPinExplain,
  cardBrief, CHECK_LOOK, statusChip, waitingWords, tileAsk, rankActions, chatLines, messagesPathOf,
  OUTWARD_WORDS, CLOSE_WORDS, CLOSE_TITLES, CLOSE_NOTE_MAX, closeoutLine, turnOf, coversWords, chiefOfStaffCard, CHIEF_OF_STAFF_WORDS,
} from './work-model.js';

const EYEBROW = 'Work · Work board';
let readFn = null;          // the page's own authenticated GET, for an opened card's conversation
const workLinkVisits = new WeakMap(); // once per navigation, not on every periodic refresh
const workRenders = new WeakMap();

function bearer() { try { return localStorage.getItem('instar_token') || ''; } catch { return ''; } }

/** POST with the bearer token; the full refusal body comes back so a stale card can say why. */
async function send(path, body, signal) {
  const headers = { Authorization: `Bearer ${bearer()}`, 'Content-Type': 'application/json', 'X-Instar-Request': '1' };
  try {
    const r = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body), signal });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  } catch { return { status: 0, data: {} }; }
}

function clearCardFromHash(visit) {
  const h = location.hash || '';
  const i = h.indexOf('?');
  if (i < 0) return;
  const params = new URLSearchParams(h.slice(i + 1));
  if (!params.has('card')) return;
  params.delete('card');
  const rest = params.toString();
  try {
    history.replaceState(history.state, '', `${location.pathname}${location.search}${h.slice(0, i)}${rest ? `?${rest}` : ''}`);
    // replaceState fires no hashchange, so the once-per-navigation guard is reset here: a later tap on the same
    // link is a new navigation and opens the card again.
    if (visit) visit.opened = null;
  } catch { /* the address stays; the once-only guard still holds */ }
}

function queryOf() { const h = location.hash || ''; const i = h.indexOf('?'); return i >= 0 ? h.slice(i + 1) : ''; }

export async function renderWork(main, ctx) {
  let visit = workLinkVisits.get(window);
  if (!visit) {
    visit = { opened: null };
    workLinkVisits.set(window, visit);
    window.addEventListener('hashchange', () => { visit.opened = null; });
  }
  const run = {};
  workRenders.set(main, run);
  const { get } = ctx;
  readFn = get;
  const refresh = () => renderWork(main, ctx);
  firstPaint(main, el('section', { class: 'hero page-hero' }, el('div', { class: 'eyebrow', text: EYEBROW }), el('h1', { class: 'page-title skeleton', text: 'Loading the work board' })));
  const query = queryOf();
  const page = donePageFrom(query);
  const agentView = new URLSearchParams(query).get('view') === 'agent';
  const boardParams = new URLSearchParams();
  if (page) boardParams.set('donePage', String(page));
  if (agentView) boardParams.set('view', 'agent');
  const boardPath = '/work-board' + (boardParams.size ? '?' + boardParams : '');
  // Projects (work-front-doors stage 2a) are read alongside the board; a failed read is named, never empty.
  const [r, pr] = await Promise.all([get(boardPath), page || agentView ? Promise.resolve(null) : get('/work/projects')]);
  if (workRenders.get(main) !== run || ctx.isCurrent?.() === false) return;
  const discovery = agentView ? null : workDiscoveryPanel({
    send, sessionToken: bearer, isCurrent: ctx.isCurrent, onDispose: ctx.onDispose,
  });
  // "Open project" from the conversation list arrives as ?project=<key>: that project's row opens.
  const openKey = (() => { try { return new URLSearchParams(query).get('project'); } catch { return null; } })();
  const projects = pr ? projectsSection(pr.ok ? pr.data : null, { openKey }) : null;
  if (!r.ok) {
    setKids(main, isOff(r)
      ? el('section', {}, el('div', { class: 'eyebrow', text: EYEBROW }), el('h1', { text: 'The work board is not switched on for this agent.' }), discovery, projects)
      : el('div', {}, cantTell(`The work board could not be read: ${r.reason || 'no answer'}.`), discovery, projects));
    return;
  }
  const board = readBoard(r.data);
  if (!board.ok) { setKids(main, cantTell('The work board answered, but not in a shape this page can read, so it cannot say what is waiting on you.'), discovery); return; }

  const waiting = board.lanes['waiting-on-you'];
  // My board (work-board-my-board): the cards that need the reader, each once under its most pressing reason, then
  // the lanes for every other card. An agent that sends no My board gets the lanes as before.
  const mine = readMyBoard(r.data, board.lanes);
  const notMine = (cards) => (mine ? cards.filter((c) => !mine.ids.has(c.id)) : cards);
  let lead;
  if (mine && mine.sections.length) {
    lead = mine.sections.map((s) => myBoardSection(s, refresh));
    markNeed(lead[0], 'workBoard');
    // Every card waiting on the reader has a reason, so this lane is normally empty here; a card the agent left
    // off My board is still shown rather than lost.
    const rest = notMine(waiting.cards);
    if (rest.length) lead.push(laneSection(LANES[0], rest, refresh, { lead: true }));
  } else {
    lead = laneSection(LANES[0], waiting.cards, refresh, { lead: true, count: waiting.cards.length + waiting.more });
    if (waiting.cards.length) markNeed(lead, 'workBoard');
    if (waiting.more) lead.append(el('p', { class: 'need-sub', text: `${waiting.more} more waiting` }));
  }

  // Each waiting card opens on a click and carries its own buttons.
  // warning-path: row
  const head = pageHead({ eyebrow: EYEBROW, headline: agentView ? 'The agent’s internal cards' : headline(board), sub: agentView ? 'Work the agent manages, with its current status.' : 'Cards the agent and you agreed on. A card moves only when one of you acts.', tone: board.waitingOnYou ? 'attn' : 'ok', noAsk: true });
  const notes = [behindLine(board.behind), pickupLine(board.pickups)].filter(Boolean).map((t) => note(t));

  const done = board.lanes.done;
  const paging = donePaging(done.total, page);
  const doneSec = laneSection(LANES[3], done.cards, refresh, { count: done.total, folded: true, open: page > 0 });
  const doneBody = doneSec.querySelector('.work-lane-body');
  if (paging.line) doneBody.append(el('p', { class: 'need-sub', text: paging.line }));
  const pager = [paging.prev, paging.next].filter(Boolean).map((p) => el('a', { class: 'link-btn', href: agentView ? p.href + (p.href.includes('?') ? '&' : '?') + 'view=agent' : p.href, text: p.text }));
  if (pager.length) doneBody.append(el('p', { class: 'confirm-row' }, pager));

  setKids(main, el('div', { class: 'work-page' },
    head,
    el('p', { class: 'confirm-row' }, el('a', { class: 'btn-quiet btn-inline', href: agentView ? '#/work/board' : '#/work/board?view=agent', text: agentView ? 'Back to your work' : 'View the agent’s internal cards' })),
    agentView ? note('Internal work stays here. It does not add to your requests or conversations.') : null,
    lead,
    notes,
    discovery,
    // Projects come right after what is waiting on you (a page leads with the need), before the other lanes.
    projects,
    laneSection(LANES[1], notMine(board.lanes['with-agent'].cards), refresh),
    laneSection(LANES[2], notMine(board.lanes['waiting-on-others'].cards), refresh),
    doneSec,
    laneSection(LANES[4], board.lanes.archived.cards, refresh, { count: board.lanes.archived.total, folded: true }),
    board.settings ? settingsPanel(board, refresh) : null,
  ));

  // A link to one card (Home's row) opens it once.
  const want = cardFromQuery(query);
  if (want && visit.opened !== want) {
    const all = LANES.flatMap((l) => board.lanes[l.id].cards);
    let c = all.find((x) => x.id === want);
    if (!c) {
      const result = await get(`/work-board/cards/${encodeURIComponent(want)}`);
      if (workRenders.get(main) !== run || queryOf() !== query || !main.isConnected) return;
      if (result.ok && result.data?.card?.id === want && typeof result.data.card.title === 'string') c = result.data.card;
      else {
        // The card stays in the address here, so "Try again" can read it again.
        main.prepend(note(result.status === 404 ? 'This card is no longer available here.' : 'This card could not be loaded. Try again.'));
        main.prepend(el('button', { type: 'button', class: 'btn-quiet btn-inline', text: 'Try again', onclick: refresh }));
        return;
      }
    }
    visit.opened = want;
    openCard(c, refresh);
    // Take the card out of the address once it is open, so the same link (a Needs-you row's card link) opens it
    // again on a later tap; the page's own refresh still never reopens a card the person closed.
    clearCardFromHash(visit);
  }
}

function laneSection(lane, cards, refresh, { lead = false, count, folded = false, open = false } = {}) {
  const bodyId = `work-lane-${lane.id}`;
  const head = el(folded ? 'button' : 'div', {
    class: 'list-head', type: folded ? 'button' : null,
    'aria-expanded': folded ? String(open) : null, 'aria-controls': folded ? bodyId : null,
  }, el('h2', { class: 'eyebrow', text: lane.label }), el('span', { class: 'list-count', text: String(count ?? cards.length) }),
  folded ? el('span', { class: 'chev', 'aria-hidden': 'true', text: '›' }) : null);
  const body = el('div', { class: 'work-lane-body', id: bodyId, hidden: folded && !open });
  if (!cards.length) body.append(el('p', { class: 'empty-line', text: lane.empty }));
  for (const c of cards) body.append(cardRowNode(c, refresh, lead));
  if (folded) head.addEventListener('click', () => {
    body.hidden = !body.hidden;
    head.setAttribute('aria-expanded', String(!body.hidden));
  });
  const wrap = el('section', { class: 'list-section work-lane', id: `sec-${lane.id}` }, head, body);
  return wrap;
}

/** One My board section: its words and count, its cards (untouched first, as the agent ordered them), and "And N more". */
function myBoardSection(s, refresh) {
  const body = el('div', { class: 'work-lane-body', id: `work-mine-${s.reason}` });
  for (const c of s.cards) body.append(cardRowNode(c, refresh, s.lead, { tagNotStarted: true }));
  if (s.more) body.append(el('p', { class: 'need-sub work-more', text: `And ${s.more} more` }));
  const head = el('div', { class: 'list-head' }, el('h2', { class: 'eyebrow', text: s.words }), el('span', { class: 'list-count', text: String(s.cards.length + s.more) }));
  return el('section', { class: 'list-section work-lane work-mine', id: `sec-mine-${s.reason}`, 'data-reason': s.reason }, head, body);
}

// A tile: its status, the title, one line saying what it asks, how long it has waited, and one main button.
// Everything else (the other buttons, the details) is one tap away in the opened card.
function cardRowNode(card, refresh, lead, { tagNotStarted = false } = {}) {
  const r = cardRow(card);
  const brief = cardBrief(card);
  const status = el('p', { class: 'need-sub', role: 'status' });
  const title = el('button', { class: 'link-btn need-title work-open', type: 'button', text: r.main, 'aria-label': `Open the card: ${r.main}` });
  title.addEventListener('click', () => openCard(card, refresh));
  const turn = turnOf(card);
  const chip = statusChip(card);
  const ask = tileAsk(card, brief);
  const since = waitingWords(card, brief.waitingSince, Date.now(), { short: true });
  const ranked = rankActions(cardActions(card));
  return el('div', { class: `${lead ? 'need-card work-card' : 'need-card muted-card work-card'}${turn ? ` turn-${turn}` : ''}`, 'data-card': card.id, ...(turn ? { 'data-turn': turn } : {}) },
    el('div', { class: 'wc-chips' },
      el('span', { class: `wc-chip wc-chip-${chip.kind}`, text: chip.words }),
      chiefOfStaffCard(card) ? el('span', { class: 'wc-chip wc-chip-source', text: CHIEF_OF_STAFF_WORDS }) : null,
      tagNotStarted && notStartedTag(card) ? el('span', { class: 'wc-chip wc-chip-still work-not-started', text: notStartedTag(card) }) : null),
    title,
    ask && ask !== r.main ? el('p', { class: 'wc-tile-ask', text: ask }) : null,
    r.outward ? el('p', { class: 'need-sub', text: card.outwardWords || OUTWARD_WORDS }) : null,
    r.notes.map((t) => el('p', { class: 'need-sub work-note', text: t })),
    phoneOnlyLine(card) ? el('p', { class: 'need-sub work-phone-only', text: phoneOnlyLine(card) }) : null,
    el('div', { class: 'wc-tile-foot' },
      since ? el('span', { class: 'wc-since', text: since }) : el('span', { class: 'wc-since' }),
      ranked.primary ? actionsNode(card, [ranked.primary], status, refresh, { primaryFilled: true }) : null),
    status);
}

/** The card's buttons; Answer becomes the options as buttons, or a text box with Send. */
function actionsNode(card, actions, status, refresh, { primaryFilled = false, quiet = false } = {}) {
  if (!actions.length) return null;
  const kids = [];
  for (const a of actions) {
    if (a.action === 'answer') { kids.push(answerControl(card, status, refresh)); continue; }
    // The one main button of a tile or card is filled; the rest are outlined; Put on hold and Remove are plain text.
    const look = quiet ? `wc-text-btn${a.tone === 'danger' ? ' wc-text-danger' : ''}` : (primaryFilled || a.tone === 'primary') ? 'btn-primary btn-inline' : a.tone === 'danger' ? 'btn-danger btn-inline' : 'btn-quiet btn-inline';
    const b = el('button', { class: look, type: 'button', text: a.label });
    b.addEventListener('click', () => (CLOSE_WORDS[a.action] ? closeStep(card, a.action, status, refresh) : confirmTap(card, a.action, {}, status, refresh)));
    kids.push(b);
  }
  return el('div', { class: `confirm-row work-actions${quiet ? ' wc-quiet-actions' : ''}` }, kids);
}

function answerControl(card, status, refresh) {
  const q = card.question;
  if (!q) return null;
  if (Array.isArray(q.options) && q.options.length) {
    return el('div', { class: 'confirm-row work-answer', role: 'group', 'aria-label': `Answer: ${q.text}` }, q.options.map((opt) => {
      const b = el('button', { class: 'btn-primary btn-inline', type: 'button', text: String(opt) });
      b.addEventListener('click', () => confirmTap(card, 'answer', { answer: String(opt) }, status, refresh));
      return b;
    }));
  }
  const input = el('input', { class: 'reason-input', type: 'text', placeholder: 'Your answer', 'aria-label': `Your answer to: ${q.text}` });
  const go = el('button', { class: 'btn-primary btn-inline', type: 'button', text: 'Send answer' });
  go.addEventListener('click', () => confirmTap(card, 'answer', { answer: input.value }, status, refresh));
  return el('div', { class: 'confirm-row work-answer' }, input, go);
}

/** Done or Not important: the note comes first (the server refuses a close without one), then the usual confirm step. */
function closeStep(card, action, status, refresh, { note = '', refused = '' } = {}) {
  const words = CLOSE_WORDS[action];
  const id = `close-note-${action}`;
  const input = el('textarea', { class: 'reason-input work-close-note', id, rows: '3', maxlength: String(CLOSE_NOTE_MAX), 'aria-describedby': `${id}-hint` });
  input.value = note;
  // A refused close comes back here with the note kept, so the person can reword it (a credential, a stale card).
  const problem = el('p', { class: 'need-sub', role: 'status', text: refused });
  const cancel = el('button', { class: 'btn-quiet', type: 'button', text: 'Cancel', onclick: () => closeSheet() });
  const next = el('button', { class: 'btn-primary btn-inline', type: 'button', text: 'Continue' });
  input.addEventListener('input', () => { if (input.value.trim()) problem.textContent = ''; });
  next.addEventListener('click', () => {
    const built = tapBody(card, action, { note: input.value });
    if (!built.ok) { problem.textContent = built.reason; input.focus(); return; }
    const note = input.value;
    confirmTap(card, action, { note }, status, refresh, (words) => closeStep(card, action, status, refresh, { note, refused: words }));
  });
  sheet({ title: `${CLOSE_TITLES[action]}: ${String(card.title || 'Card')}` },
    el('label', { class: 'need-title', for: id, text: words.label }),
    el('p', { class: 'need-sub', id: `${id}-hint`, text: words.hint }),
    input, problem,
    el('div', { class: 'confirm-row' }, cancel, next));
  setTimeout(() => input.focus(), 0);
}

function coversNode(lines) {
  return el('dl', { class: 'story' }, lines.flatMap((l) => [
    el('dt', { text: l.label }),
    l.items ? el('dd', {}, l.items.length ? el('ul', {}, l.items.map((t) => el('li', { text: t }))) : document.createTextNode('None')) : el('dd', { text: l.text }),
  ]));
}

/** Show exactly what the tap covers, then the PIN, then send it. */
function confirmTap(card, action, extra, status, refresh, onRefused = null) {
  const built = tapBody(card, action, extra);
  if (!built.ok) { status.textContent = built.reason; return; }
  const cancel = el('button', { class: 'btn-quiet', type: 'button', text: 'Cancel', onclick: () => closeSheet() });
  const go = el('button', { class: action === 'redact' ? 'btn-danger' : 'btn-primary btn-inline', type: 'button', text: 'Continue' });
  go.addEventListener('click', async () => {
    const pin = await askPin({ title: tapWordsTitle(action, card), explain: pinExplain(card, action) });
    if (!pin || !pin.pin) { status.textContent = ''; return; }
    status.textContent = 'Working…';
    const res = await send(`/work-board/cards/${encodeURIComponent(card.id)}/tap`, { ...built.body, pin: pin.pin });
    pin.pin = '';
    if (res.status === 200) { status.textContent = 'Done.'; setTimeout(refresh, 600); return; }
    status.textContent = refusalWords(res.status, res.data);
    if (onRefused) onRefused(status.textContent);
    if (res.data && (res.data.error === 'stale-card' || res.data.error === 'question-replaced')) setTimeout(refresh, 1500);
  });
  sheet({ title: `${tapWordsTitle(action, card)}: what this covers` },
    coversNode(tapCovers(card, action, extra)),
    el('div', { class: 'confirm-row' }, cancel, go));
}

function tapWordsTitle(action, card) {
  if (card && card.phoneOnly && action === 'withdraw-approval') return 'Stop this app';
  if (CLOSE_TITLES[action]) return CLOSE_TITLES[action];
  if (action === 'unarchive' && card && card.closeout) return 'Reopen';
  return { approve: 'Approve', answer: 'Answer', 'confirm-done': 'Confirm done', reopen: 'Reopen', unhold: 'Release hold', retry: 'Try again', 'withdraw-approval': 'Withdraw approval', archive: 'Archive', unarchive: 'Restore', hold: 'Put on hold', redact: 'Remove for good' }[action] || 'Confirm';
}

// ── the opened card ───────────────────────────────────────────────────────
function block(title, ...kids) { return el('section', { class: 'sheet-block' }, el('h3', { class: 'eyebrow', text: title }), ...kids); }
const when = (iso) => (iso ? whenWords(iso) : 'an unknown time');

function openCard(card, refresh) {
  const status = el('p', { class: 'need-sub', role: 'status' });
  if (card.removed) {
    sheet({ title: String(card.title || 'Removed') },
      note(card.removed.note || 'The text is hidden from every read.'),
      el('p', { class: 'card-line', text: `Removed by ${byWords(card.removed.by)}, ${when(card.removed.at)}.` }));
    return;
  }
  const brief = cardBrief(card);
  const warn = [];
  if (card.mayHaveBeenHandedOver) warn.push(note('This may already have been handed over. Read its conversation before asking the agent to carry on.'));
  if (card.mayHaveChangedOn) warn.push(note(`This card may have changed on ${machineWords(card.mayHaveChangedOnName, card.mayHaveChangedOn)}, and this machine has not caught up yet.`));
  if (card.unreadable) warn.push(note('Part of this card could not be read, so what is shown may be incomplete.'));
  if (card.repliedAfterQuestion) warn.push(note('You replied; the agent has not updated the card.'));
  if (card.capacity) warn.push(note(capacityWords(card.capacity)));

  // ── hero: who it is from, how long it has waited, the title and the one-sentence ask, why you ──
  const chip = statusChip(card);
  const since = waitingWords(card, brief.waitingSince);
  const hero = el('header', { class: 'wc-hero' },
    el('div', { class: 'wc-chips' },
      chiefOfStaffCard(card) ? el('span', { class: 'wc-chip wc-chip-source', text: CHIEF_OF_STAFF_WORDS }) : null,
      el('span', { class: `wc-chip wc-chip-${chip.kind}`, text: since || chip.words })),
    el('h2', { class: 'wc-title', text: String(card.title || 'Card') }),
    brief.ask && brief.ask !== card.title ? el('p', { class: 'wc-ask', text: brief.ask }) : null,
    card.whyYou ? el('p', { class: 'wc-why' }, el('span', { class: 'wc-why-label', text: 'Why you · ' }), document.createTextNode(String(card.whyYou))) : null);

  // ── the recommendation, with the main button right under it ──
  const ranked = rankActions(cardActions(card, { inSheet: true }));
  const decide = el('section', { class: `wc-decide${card.recommendation ? ' wc-callout' : ''}` },
    card.recommendation ? el('h3', { class: 'wc-label', text: 'Recommended' }) : null,
    card.recommendation ? el('p', { class: 'wc-reco', text: String(card.recommendation) }) : null,
    phoneOnlyLine(card) ? el('p', { class: 'need-sub work-phone-only', text: phoneOnlyLine(card) }) : null,
    ranked.primary || ranked.secondary.length ? actionsNode(card, [ranked.primary && { ...ranked.primary, tone: 'primary' }, ...ranked.secondary].filter(Boolean), status, refresh) : null,
    ranked.quiet.length ? actionsNode(card, ranked.quiet, status, refresh, { quiet: true }) : null,
    status);

  // A person's close in force: who closed it, when, and the note (work-front-doors §6).
  const closed = closeoutLine(card);
  const closedNode = closed ? el('section', { class: 'wc-section' }, el('h3', { class: 'wc-label', text: 'Closed' }), el('p', { class: 'wc-body work-pre', text: closed })) : null;

  // ── the checklist: the project's own items, then the card's done items with their evidence ──
  const checks = brief.checks.length ? el('section', { class: 'wc-section' },
    el('h3', { class: 'wc-label', text: 'Checklist' }),
    el('ul', { class: 'wc-checks' }, brief.checks.map((c) => checkRow(c.text, c.status)))) : null;
  const items = evidenceByItem(card);
  const doneWhen = el('section', { class: 'wc-section' },
    el('h3', { class: 'wc-label', text: 'Done when' }),
    items.length ? el('ul', { class: 'wc-checks work-items' }, items.map((it) => {
      const counted = it.evidence.some((e) => e.counts !== false);
      return checkRow(it.text, card.done || counted ? 'passes' : 'unknown', [
        el('span', { class: 'wc-check-sub', text: it.mark }),
        it.evidence.length ? el('ul', { class: 'wc-evidence' }, it.evidence.map((e) => el('li', { text: `${e.text} (${byWords(e.by)}, ${when(e.at)}${e.counts === false ? '; written before the card last changed, so it does not count' : ''})` }))) : null,
      ]);
    })) : el('p', { class: 'wc-body', text: 'No done items.' }),
    card.claim ? el('p', { class: 'wc-body', text: `The agent said this is done ${when(card.claim.at)}${card.claim.needsConfirm ? '; it needs your confirmation' : ''}.` }) : null,
    card.doneByAgentOwnEvidence ? note('Finished by the agent on its own evidence.') : null);

  // A session's card: its need is one Markdown body, shown in full when it says more than the ask.
  const needBody = brief.body ? el('section', { class: 'wc-section' }, el('h3', { class: 'wc-label', text: 'What is needed' }), needNode(brief.body)) : null;

  // ── Details, folded: the goal, the Chief of Staff's own words, and the record ──
  const facts = [
    { label: 'Now', text: String(card.needLine || '') },
    { label: 'Carried by', text: principalWords(card.carrier) },
    chiefOfStaffCard(card) ? { label: 'Written by', text: 'The Chief of Staff, which keeps this card up to date itself' } : null,
    coversWords(card) ? { label: 'About', text: coversWords(card) } : null,
    card.waitingOn ? { label: 'Waiting on', text: principalWords(card.waitingOn) } : null,
    { label: 'Outside your team', text: card.outward ? (card.outwardWords || OUTWARD_WORDS) : 'Nothing is sent outside your team and nothing is spent' },
    card.due ? { label: 'Due', text: when(card.due) } : null,
    { label: 'Approval', text: card.approved ? `Approved${card.approvedBy && card.approvedBy.by ? ` by ${byWords(card.approvedBy.by)}` : ''}` : card.approvalRequired ? (card.withdrawn ? 'Withdrawn; needs your approval again' : 'Needs your approval') : 'Not needed: you wrote this card' },
  ].filter(Boolean);
  const detail = [];
  if (brief.goal) detail.push(el('div', { class: 'wc-detail-block' }, el('h4', { class: 'wc-label', text: 'Goal' }), el('p', { class: 'wc-body', text: brief.goal })));
  if (brief.chiefSaid) detail.push(el('div', { class: 'wc-detail-block' }, el('h4', { class: 'wc-label', text: 'The Chief of Staff said' }), el('blockquote', { class: 'wc-quote', text: brief.chiefSaid })));
  for (const p of brief.intro) detail.push(el('p', { class: 'wc-body', text: p }));
  const source = cardSourceLink(card);
  if (source) detail.push(el('p', { class: 'card-line work-source' },
    el('span', { text: 'From: ' }), source.href
      ? el('a', { href: source.href, text: source.label, onclick: () => closeSheet() })
      : el('span', { text: source.label }), source.note ? el('span', { text: ` · ${source.note}` }) : null));
  detail.push(el('dl', { class: 'story wc-facts' }, facts.flatMap((l) => [el('dt', { text: l.label }), el('dd', { text: l.text })])));
  const links = linkLines(card);
  if (links.length) detail.push(block('Links', el('ul', {}, links.map((l) => el('li', {},
    l.file ? el('span', { text: l.label }) : (l.url ? el('a', { href: l.url, target: '_blank', rel: 'noopener noreferrer', text: l.label }) : el('span', { text: l.label })),
    l.file ? null : el('span', { class: 'need-sub', text: ` · ${l.host || 'unknown site'}` }),
    el('p', { class: 'need-sub', text: l.note }))))));
  const qs = Array.isArray(card.questions) ? card.questions : [];
  if (card.question || qs.length) {
    detail.push(block('Questions', el('ul', {}, qs.map((q) => el('li', {},
      el('span', { text: String(q.text || '') }),
      el('p', { class: 'need-sub', text: q.state === 'replaced' ? `Replaced${q.reason ? `: ${q.reason}` : ''}` : q.state === 'answered' ? `Answered: ${q.answer || ''}` : 'Open' }))))));
  }
  const trail = Array.isArray(card.carrierTrail) ? card.carrierTrail : [];
  if (trail.length) detail.push(block('Who carried it', el('ul', {}, trail.map((t) => el('li', { text: `${principalWords(t.carrier)}, set by ${byWords(t.by)}, ${when(t.at)}` })))));
  const taps = Array.isArray(card.taps) ? card.taps : [];
  if (taps.length) detail.push(block('What people decided', el('ul', {}, taps.map((t) => el('li', { text: `${tapWords(t.action)}: ${byWords(t.by)}, ${when(t.at)}` })))));
  const details = el('details', { class: 'wc-details' }, el('summary', { class: 'wc-details-head' }, el('span', { text: 'Details' }), el('span', { class: 'chev', 'aria-hidden': 'true', text: '›' })), el('div', { class: 'wc-details-body' }, detail));

  const mainCol = el('div', { class: 'wc-main' }, hero, warn, closedNode, decide, checks, needBody, doneWhen, details);
  const panel = sheet({ title: String(card.title || 'Card') }, el('div', { class: 'wc-detail' }, mainCol, conversationPanel(card)));
  panel.classList.add('sheet-wide', 'wc-sheet');
  // The hero carries the title in large type; the sheet's own bar names the place (the dialog keeps the title as its label).
  const bar = panel.querySelector('.sheet-title');
  if (bar) { bar.textContent = 'Work board card'; bar.setAttribute('aria-hidden', 'true'); }
}

/** One checklist row: a status icon (with its words for a screen reader), the text, and anything under it. */
function checkRow(text, status, extra = []) {
  const look = CHECK_LOOK[status] || null;
  return el('li', { class: `wc-check wc-check-${look ? status : 'none'}` },
    el('span', { class: 'wc-check-icon', 'aria-hidden': 'true', text: look ? look.icon : '–' }),
    el('span', { class: 'wc-check-text' },
      el('span', { text }),
      look ? el('span', { class: 'sr-only', text: ` (${look.words})` }) : null,
      extra));
}

/** The card's conversation as a chat: read here with the page's own sign-in; replies go through the full conversation. */
function conversationPanel(card) {
  if (!card.conversationKey || card.conversationAvailable === false) return null;
  const href = hashFor({ kind: 'app', id: card.conversationKey });
  const list = el('ol', { class: 'wc-chat-list', 'aria-live': 'polite' }, el('li', { class: 'wc-chat-empty', text: 'Loading the conversation…' }));
  const panel = el('aside', { class: 'wc-chat', 'aria-label': 'Conversation' },
    el('div', { class: 'wc-chat-head' },
      el('h3', { class: 'wc-label', text: 'Conversation' }),
      el('a', { class: 'wc-chat-open', href, text: 'Open full conversation', onclick: () => closeSheet() })),
    list,
    el('a', { class: 'btn-quiet btn-inline wc-chat-reply', href, text: 'Reply in the conversation', onclick: () => closeSheet() }));
  const path = messagesPathOf(card);
  if (!path || !readFn) { setKids(list, el('li', { class: 'wc-chat-empty', text: 'Open the full conversation to read and reply.' })); return panel; }
  Promise.resolve(readFn(path)).then((r) => {
    const lines = r && r.ok ? chatLines(r.data) : null;
    if (!lines) { setKids(list, el('li', { class: 'wc-chat-empty', text: 'The conversation could not be read here. Open the full conversation to see it.' })); return; }
    if (!lines.length) { setKids(list, el('li', { class: 'wc-chat-empty', text: 'No messages yet. Ask the agent about this card in its conversation.' })); return; }
    setKids(list, lines.map((m) => el('li', { class: `wc-msg wc-msg-${m.who}`, 'data-message': m.id },
      el('div', { class: 'wc-msg-meta' }, el('span', { class: 'wc-msg-name', text: m.name }), m.at ? el('span', { class: 'wc-msg-at', text: whenWords(m.at) }) : null),
      el('p', { class: 'wc-msg-text', text: m.text }))));
    list.scrollTop = list.scrollHeight;
  }).catch(() => setKids(list, el('li', { class: 'wc-chat-empty', text: 'The conversation could not be read here. Open the full conversation to see it.' })));
  return panel;
}

// ── the need: light Markdown through the sanitizer ────────────────────────
// The same pinned builds files.js loads, with integrity.
const LIBS = {
  marked: { global: 'marked', src: 'https://cdn.jsdelivr.net/npm/marked@15.0.7/marked.min.js', integrity: 'sha384-H+hy9ULve6xfxRkWIh/YOtvDdpXgV2fmAGQkIDTxIgZwNoaoBal14Di2YTMR6MzR' },
  purify: { global: 'DOMPurify', src: 'https://cdn.jsdelivr.net/npm/dompurify@3.2.4/dist/purify.min.js', integrity: 'sha384-eEu5CTj3qGvu9PdJuS+YlkNi7d2XxQROAFYOr59zgObtlcux1ae1Il3u7jvdCSWu' },
};
const loading = {};
function lib(name) {
  const def = LIBS[name];
  if (window[def.global]) return Promise.resolve(window[def.global]);
  if (!loading[name]) {
    loading[name] = new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = def.src; s.integrity = def.integrity; s.crossOrigin = 'anonymous';
      const t = setTimeout(() => resolve(window[def.global] || null), 4000);
      s.onload = () => { clearTimeout(t); resolve(window[def.global] || null); };
      s.onerror = () => { clearTimeout(t); delete loading[name]; resolve(null); };
      document.head.append(s);
    });
  }
  return loading[name];
}
const MD_TAGS = ['p', 'br', 'ul', 'ol', 'li', 'strong', 'b', 'em', 'i', 'a', 'code', 'blockquote'];

function needNode(text) {
  const md = el('div', { class: 'markdown-content' }, el('p', { class: 'card-line work-pre', text: String(text) }));
  Promise.all([lib('marked'), lib('purify')]).then(([marked, purify]) => {
    if (!marked || !purify || typeof purify.sanitize !== 'function') return; // the plain text stays
    // Raw HTML is shown as text: escape it before Markdown sees it, then keep only the allow-list.
    const src = String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const frag = purify.sanitize(marked.parse(src), { RETURN_DOM_FRAGMENT: true, ALLOWED_TAGS: MD_TAGS, ALLOWED_ATTR: ['href'], ALLOWED_URI_REGEXP: /^(?:https:|mailto:)/i });
    for (const a of frag.querySelectorAll('a[href]')) { a.setAttribute('rel', 'noopener noreferrer'); a.setAttribute('target', '_blank'); }
    setKids(md, frag);
  });
  return md;
}

// ── settings (owner) ──────────────────────────────────────────────────────
function settingsPanel(board, refresh) {
  const status = el('p', { class: 'need-sub', role: 'status' });
  const radios = POLICIES.map((p) => {
    const input = el('input', { type: 'radio', name: 'wb-policy', value: p.id, checked: board.policy === p.id });
    return el('label', { class: 'work-policy' }, input, el('span', {}, el('span', { class: 'need-title', text: ` ${p.label}` }), el('p', { class: 'need-sub', text: p.words })));
  });
  const inputs = {};
  const fields = SETTING_FIELDS.map((f) => {
    const v = settingValue(board.settings, f.path);
    const input = el('input', { class: 'reason-input', type: 'number', min: String(f.min || 1), step: '1', inputmode: 'numeric', value: v === null ? '' : String(v), 'aria-label': f.label });
    inputs[f.path] = input;
    return el('label', { class: 'work-setting' }, el('span', { class: 'need-sub', text: f.label }), input);
  });
  const save = el('button', { class: 'btn-primary btn-inline', type: 'button', text: 'Save settings' });
  save.addEventListener('click', async () => {
    const chosen = radios.map((l) => l.querySelector('input')).find((i) => i.checked);
    const policy = chosen && chosen.value !== board.policy ? chosen.value : null;
    const values = Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value]));
    const p = settingsPatch(board.settings, values);
    if (!p.ok) { status.textContent = p.message; return; }
    if (!policy && !Object.keys(p.patch).length) { status.textContent = 'Nothing changed.'; return; }
    let explain = 'Save the work board settings.';
    if (policy) {
      const preview = await send('/work-board/settings', { preview: true, policy });
      explain = policyPinExplain(policy, preview.status === 200 ? preview.data.wouldStart : null);
    }
    const pin = await askPin({ title: 'Work board settings', explain });
    if (!pin || !pin.pin) return;
    status.textContent = 'Working…';
    const res = await send('/work-board/settings', { pin: pin.pin, ...(policy ? { policy } : {}), ...p.patch });
    pin.pin = '';
    if (res.status === 200) { status.textContent = 'Saved.'; setTimeout(refresh, 600); return; }
    status.textContent = refusalWords(res.status, res.data);
  });
  return el('details', { class: 'list-section work-settings', id: 'sec-settings' },
    el('summary', { class: 'list-head' }, el('h2', { class: 'eyebrow', text: 'Settings' })),
    el('fieldset', { class: 'work-policies' }, el('legend', { class: 'need-title', text: 'When the agent waits for your OK' }), radios),
    el('div', { class: 'work-settings-grid' }, fields),
    el('div', { class: 'confirm-row' }, save), status);
}


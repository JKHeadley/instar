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
import {
  LANES, readBoard, headline, pickupLine, behindLine, isOff, cardRow, cardActions, tapBody, tapCovers, pinExplain,
  refusalWords, donePageFrom, cardFromQuery, donePaging, evidenceByItem, linkLines, principalWords,
  byWords, tapWords, capacityWords, whenWords, POLICIES, SETTING_FIELDS, settingValue, settingsPatch, policyPinExplain,
  OUTWARD_WORDS,
} from './work-model.js';

const EYEBROW = 'Work · Work board';
let openedFromLink = null; // a ?card= link opens its card once, not on every refresh

function bearer() { try { return localStorage.getItem('instar_token') || ''; } catch { return ''; } }

/** POST with the bearer token; the full refusal body comes back so a stale card can say why. */
async function send(path, body) {
  const headers = { Authorization: `Bearer ${bearer()}`, 'Content-Type': 'application/json', 'X-Instar-Request': '1' };
  try {
    const r = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  } catch { return { status: 0, data: {} }; }
}

function queryOf() { const h = location.hash || ''; const i = h.indexOf('?'); return i >= 0 ? h.slice(i + 1) : ''; }

export async function renderWork(main, ctx) {
  const { get } = ctx;
  const refresh = () => renderWork(main, ctx);
  firstPaint(main, el('section', { class: 'hero page-hero' }, el('div', { class: 'eyebrow', text: EYEBROW }), el('h1', { class: 'page-title skeleton', text: 'Loading the work board' })));
  const query = queryOf();
  const page = donePageFrom(query);
  const r = await get(page ? `/work-board?donePage=${page}` : '/work-board');
  if (!r.ok) {
    setKids(main, isOff(r)
      ? el('section', {}, el('div', { class: 'eyebrow', text: EYEBROW }), el('h1', { text: 'The work board is not switched on for this agent.' }))
      : cantTell(`The work board could not be read: ${r.reason || 'no answer'}.`));
    return;
  }
  const board = readBoard(r.data);
  if (!board.ok) { setKids(main, cantTell('The work board answered, but not in a shape this page can read, so it cannot say what is waiting on you.')); return; }

  const waiting = board.lanes['waiting-on-you'];
  const lead = laneSection(LANES[0], waiting.cards, refresh, { lead: true, count: waiting.cards.length + waiting.more });
  if (waiting.cards.length) markNeed(lead, 'workBoard');
  if (waiting.more) lead.append(el('p', { class: 'need-sub', text: `${waiting.more} more waiting` }));

  // Each waiting card opens on a click and carries its own buttons.
  // warning-path: row
  const head = pageHead({ eyebrow: EYEBROW, headline: headline(board), sub: 'Cards the agent and you agreed on. A card moves only when one of you acts.', tone: board.waitingOnYou ? 'attn' : 'ok', noAsk: true });
  const notes = [behindLine(board.behind), pickupLine(board.pickups)].filter(Boolean).map((t) => note(t));

  const done = board.lanes.done;
  const paging = donePaging(done.total, page);
  const doneSec = laneSection(LANES[3], done.cards, refresh, { count: done.total });
  if (paging.line) doneSec.append(el('p', { class: 'need-sub', text: paging.line }));
  const pager = [paging.prev, paging.next].filter(Boolean).map((p) => el('a', { class: 'link-btn', href: p.href, text: p.text }));
  if (pager.length) doneSec.append(el('p', { class: 'confirm-row' }, pager));

  setKids(main, el('div', { class: 'work-page' },
    head,
    lead,
    notes,
    laneSection(LANES[1], board.lanes['with-agent'].cards, refresh),
    laneSection(LANES[2], board.lanes['waiting-on-others'].cards, refresh),
    doneSec,
    laneSection(LANES[4], board.lanes.archived.cards, refresh),
    board.settings ? settingsPanel(board, refresh) : null,
  ));

  // A link to one card (Home's row) opens it once.
  const want = cardFromQuery(query);
  if (want && openedFromLink !== want) {
    openedFromLink = want;
    const all = LANES.flatMap((l) => board.lanes[l.id].cards);
    const c = all.find((x) => x.id === want);
    if (c) openCard(c, refresh);
  }
}

function laneSection(lane, cards, refresh, { lead = false, count } = {}) {
  const wrap = el('section', { class: 'list-section work-lane', id: `sec-${lane.id}` },
    el('div', { class: 'list-head' }, el('h2', { class: 'eyebrow', text: lane.label }), el('span', { class: 'list-count', text: String(count ?? cards.length) })));
  if (!cards.length) wrap.append(el('p', { class: 'empty-line', text: lane.empty }));
  for (const c of cards) wrap.append(cardRowNode(c, refresh, lead));
  return wrap;
}

function cardRowNode(card, refresh, lead) {
  const r = cardRow(card);
  const status = el('p', { class: 'need-sub', role: 'status' });
  const title = el('button', { class: 'link-btn need-title work-open', type: 'button', text: r.main, 'aria-label': `Open the card: ${r.main}` });
  title.addEventListener('click', () => openCard(card, refresh));
  return el('div', { class: lead ? 'need-card work-card' : 'need-card muted-card work-card', 'data-card': card.id },
    title,
    r.sub ? el('p', { class: 'need-sub', text: r.sub }) : null,
    r.outward ? el('p', { class: 'need-sub', text: card.outwardWords || OUTWARD_WORDS }) : null,
    r.notes.map((t) => el('p', { class: 'need-sub work-note', text: t })),
    actionsNode(card, cardActions(card), status, refresh),
    status);
}

/** The card's buttons; Answer becomes the options as buttons, or a text box with Send. */
function actionsNode(card, actions, status, refresh) {
  if (!actions.length) return null;
  const kids = [];
  for (const a of actions) {
    if (a.action === 'answer') { kids.push(answerControl(card, status, refresh)); continue; }
    const b = el('button', { class: `${a.tone === 'primary' ? 'btn-primary' : a.tone === 'danger' ? 'btn-danger' : 'btn-quiet'} btn-inline`, type: 'button', text: a.label });
    b.addEventListener('click', () => confirmTap(card, a.action, {}, status, refresh));
    kids.push(b);
  }
  return el('div', { class: 'confirm-row work-actions' }, kids);
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

function coversNode(lines) {
  return el('dl', { class: 'story' }, lines.flatMap((l) => [
    el('dt', { text: l.label }),
    l.items ? el('dd', {}, l.items.length ? el('ul', {}, l.items.map((t) => el('li', { text: t }))) : document.createTextNode('None')) : el('dd', { text: l.text }),
  ]));
}

/** Show exactly what the tap covers, then the PIN, then send it. */
function confirmTap(card, action, extra, status, refresh) {
  const built = tapBody(card, action, extra);
  if (!built.ok) { status.textContent = built.reason; return; }
  const cancel = el('button', { class: 'btn-quiet', type: 'button', text: 'Cancel', onclick: () => closeSheet() });
  const go = el('button', { class: action === 'redact' ? 'btn-danger' : 'btn-primary btn-inline', type: 'button', text: 'Continue' });
  go.addEventListener('click', async () => {
    const pin = await askPin({ title: tapWordsTitle(action), explain: pinExplain(card, action) });
    if (!pin || !pin.pin) { status.textContent = ''; return; }
    status.textContent = 'Working…';
    const res = await send(`/work-board/cards/${encodeURIComponent(card.id)}/tap`, { ...built.body, pin: pin.pin });
    pin.pin = '';
    if (res.status === 200) { status.textContent = 'Done.'; setTimeout(refresh, 600); return; }
    status.textContent = refusalWords(res.status, res.data);
    if (res.data && (res.data.error === 'stale-card' || res.data.error === 'question-replaced')) setTimeout(refresh, 1500);
  });
  sheet({ title: `${tapWordsTitle(action)}: what this covers` },
    coversNode(tapCovers(card, action, extra)),
    el('div', { class: 'confirm-row' }, cancel, go));
}

function tapWordsTitle(action) {
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
  const warn = [];
  if (card.mayHaveBeenHandedOver) warn.push(note('This may already have been handed over. Read its conversation before asking the agent to carry on.'));
  if (card.mayHaveChangedOn) warn.push(note(`This card may have changed on ${card.mayHaveChangedOn}, and this machine has not caught up yet.`));
  if (card.unreadable) warn.push(note('Part of this card could not be read, so what is shown may be incomplete.'));
  if (card.repliedAfterQuestion) warn.push(note('You replied; the agent has not updated the card.'));
  if (card.capacity) warn.push(note(capacityWords(card.capacity)));

  const facts = [
    { label: 'Now', text: String(card.needLine || '') },
    { label: 'Carried by', text: principalWords(card.carrier) },
    card.waitingOn ? { label: 'Waiting on', text: principalWords(card.waitingOn) } : null,
    { label: 'Outside your team', text: card.outward ? (card.outwardWords || OUTWARD_WORDS) : 'Nothing is sent outside your team and nothing is spent' },
    card.due ? { label: 'Due', text: when(card.due) } : null,
    { label: 'Approval', text: card.approved ? `Approved${card.approvedBy && card.approvedBy.by ? ` by ${byWords(card.approvedBy.by)}` : ''}` : card.approvalRequired ? (card.withdrawn ? 'Withdrawn; needs your approval again' : 'Needs your approval') : 'Not needed: you wrote this card' },
  ].filter(Boolean);

  const body = [...warn, el('dl', { class: 'story' }, facts.flatMap((l) => [el('dt', { text: l.label }), el('dd', { text: l.text })]))];
  if (card.need) body.push(block('What is needed', needNode(card.need)));
  if (card.recommendation) body.push(block('The agent recommends', el('p', { class: 'card-line work-pre', text: String(card.recommendation) })));

  const items = evidenceByItem(card);
  body.push(block('Done when', items.length ? el('ul', { class: 'work-items' }, items.map((it) => el('li', {},
    el('span', { class: 'need-title', text: it.text }),
    el('span', { class: 'need-sub', text: ` · ${it.mark}` }),
    it.evidence.length ? el('ul', {}, it.evidence.map((e) => el('li', { class: 'need-sub', text: `${e.text} (${byWords(e.by)}, ${when(e.at)}${e.counts === false ? '; written before the card last changed, so it does not count' : ''})` }))) : el('p', { class: 'need-sub', text: 'No evidence yet.' })))) : el('p', { class: 'card-line', text: 'No done items.' })));
  if (card.claim) body.push(el('p', { class: 'card-line', text: `The agent said this is done ${when(card.claim.at)}${card.claim.needsConfirm ? '; it needs your confirmation' : ''}.` }));
  if (card.doneByAgentOwnEvidence) body.push(note('Finished by the agent on its own evidence.'));

  const links = linkLines(card);
  if (links.length) body.push(block('Links', el('ul', {}, links.map((l) => el('li', {},
    l.file ? el('span', { text: l.label }) : (l.url ? el('a', { href: l.url, target: '_blank', rel: 'noopener noreferrer', text: l.label }) : el('span', { text: l.label })),
    l.file ? null : el('span', { class: 'need-sub', text: ` · ${l.host || 'unknown site'}` }),
    el('p', { class: 'need-sub', text: l.note }))))));

  const qs = Array.isArray(card.questions) ? card.questions : [];
  if (card.question || qs.length) {
    body.push(block('Questions', el('ul', {}, qs.map((q) => el('li', {},
      el('span', { text: String(q.text || '') }),
      el('p', { class: 'need-sub', text: q.state === 'replaced' ? `Replaced${q.reason ? `: ${q.reason}` : ''}` : q.state === 'answered' ? `Answered: ${q.answer || ''}` : 'Open' }))))));
  }

  const trail = Array.isArray(card.carrierTrail) ? card.carrierTrail : [];
  if (trail.length) body.push(block('Who carried it', el('ul', {}, trail.map((t) => el('li', { text: `${principalWords(t.carrier)}, set by ${byWords(t.by)}, ${when(t.at)}` })))));
  const taps = Array.isArray(card.taps) ? card.taps : [];
  if (taps.length) body.push(block('What people decided', el('ul', {}, taps.map((t) => el('li', { text: `${tapWords(t.action)}: ${byWords(t.by)}, ${when(t.at)}` })))));

  if (card.conversationKey) body.push(el('p', { class: 'confirm-row' }, el('a', { class: 'btn-quiet btn-inline', href: hashFor({ kind: 'app', id: card.conversationKey }), text: 'Open its conversation', onclick: () => closeSheet() })));
  body.push(actionsNode(card, cardActions(card, { inSheet: true }), status, refresh), status);
  sheet({ title: String(card.title || 'Card') }, ...body);
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


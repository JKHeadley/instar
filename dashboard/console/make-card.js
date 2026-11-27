// "Make a card" from a message (docs/specs/work-front-doors.md §7 stage 2, bullet 2): the owner turns one
// message in a conversation into a work card that records where it came from (`source`). The same owner
// write as any card made on the console: the dashboard PIN proves it; nothing is approved by making it.
// SAFETY: every value goes through textContent via el().

import { el, sheet, closeSheet, askPin } from './ui.js';

/** The conversation key a card's `source` uses, matching the Chief of Staff's keys ("telegram:<topic>", "app:<key>"). */
export function sourceKeyFor(ref) {
  if (!ref || ref.kind !== 'conversation') return null;
  if (ref.platform === 'telegram' && Number.isSafeInteger(ref.topicId) && ref.topicId > 0) return `telegram:${ref.topicId}`;
  if (ref.platform === 'app' && typeof ref.conversationKey === 'string' && ref.conversationKey) return `app:${ref.conversationKey}`;
  return null; // Slack and others: not offered yet
}

/** The message's own id for `source.messageId`: a Telegram message id, else the history row's stable key. */
export function messageIdFor(message) {
  if (Number.isSafeInteger(message?.messageId)) return String(message.messageId);
  return typeof message?.key === 'string' && message.key ? message.key.slice(0, 200) : null;
}

const firstLine = (text, max) => {
  const line = String(text || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};

/** The prefilled form: a title from the message's first line, what is needed from the whole message. */
export function makeCardDraft(message) {
  return { title: firstLine(message?.text, 80), need: String(message?.text || '').trim().slice(0, 4000), doneWhen: '' };
}

/**
 * The POST /work-board/cards body (without the PIN), or { ok:false, reason } in plain words.
 * `done when` is required by the board; the card is not outward and has no approval of its own.
 */
export function makeCardBody(draft, ref, message) {
  const conversationKey = sourceKeyFor(ref);
  const messageId = messageIdFor(message);
  if (!conversationKey || !messageId) return { ok: false, reason: 'This message cannot be turned into a card here.' };
  const title = String(draft.title || '').trim();
  const need = String(draft.need || '').trim();
  const done = String(draft.doneWhen || '').trim();
  if (!title) return { ok: false, reason: 'Give the card a title.' };
  if (!need) return { ok: false, reason: 'Say what is needed.' };
  if (!done) return { ok: false, reason: 'Say when it is done.' };
  return { ok: true, body: { title: title.slice(0, 300), need: need.slice(0, 4000), doneWhen: [{ id: 'd1', text: done.slice(0, 500) }], outward: false, source: { conversationKey, messageId } } };
}

function bearer() { try { return localStorage.getItem('instar_token') || ''; } catch { return ''; } }

/** Open the "Make a card" sheet for one message. `onMade(cardId)` runs after the card is saved. */
export function openMakeCard(message, ref, { onMade } = {}) {
  const draft = makeCardDraft(message);
  const title = el('input', { class: 'reason-input', type: 'text', maxlength: '300', 'aria-label': 'Card title', value: draft.title });
  const need = el('textarea', { class: 'paste-text', maxlength: '4000', 'aria-label': 'What is needed' });
  need.value = draft.need;
  const done = el('input', { class: 'reason-input', type: 'text', maxlength: '500', 'aria-label': 'Done when', placeholder: 'For example: the date is chosen' });
  const status = el('p', { class: 'need-sub', role: 'status', 'aria-live': 'polite' });
  const cancel = el('button', { class: 'btn-quiet', type: 'button', text: 'Cancel', onclick: () => closeSheet() });
  const go = el('button', { class: 'btn-primary btn-inline', type: 'button', text: 'Make the card' });
  go.addEventListener('click', async () => {
    const built = makeCardBody({ title: title.value, need: need.value, doneWhen: done.value }, ref, message);
    if (!built.ok) { status.textContent = built.reason; return; }
    const pin = await askPin({ title: 'Make a card', explain: 'Making a card needs your dashboard PIN. It goes to the work board; nothing is approved by making it.' });
    if (!pin || !pin.pin) { status.textContent = ''; return; }
    status.textContent = 'Making the card…';
    let res;
    try {
      const r = await fetch('/work-board/cards', { method: 'POST', headers: { Authorization: `Bearer ${bearer()}`, 'Content-Type': 'application/json', 'X-Instar-Request': '1' }, body: JSON.stringify({ ...built.body, pin: pin.pin }) });
      res = { status: r.status, data: await r.json().catch(() => ({})) };
    } catch { res = { status: 0, data: {} }; }
    pin.pin = '';
    if (res.status === 201 && typeof res.data.cardId === 'string') {
      closeSheet();
      if (onMade) onMade(res.data.cardId);
      return;
    }
    status.textContent = res.status === 0 ? 'The server could not be reached.'
      : res.status === 503 ? 'The work board is not switched on for this agent.'
        : res.data && typeof res.data.message === 'string' ? res.data.message : 'The card could not be made. Try again.';
  });
  sheet({ title: 'Make a card' },
    el('p', { class: 'need-sub', text: 'The card links back to this message.' }),
    el('label', { class: 'need-sub', text: 'Title' }), title,
    el('label', { class: 'need-sub', text: 'What is needed' }), need,
    el('label', { class: 'need-sub', text: 'Done when' }), done,
    status, el('div', { class: 'confirm-row' }, cancel, go));
}

// The session composer's drafts (docs/specs/native-conversation-any-machine-access.md §3e,
// "The dashboard never loses a reply quietly"). Pure: the socket, the clock and the timers
// are passed in, so every state is tested without a browser.
//
// One proof exists that a draft was typed: an `input_ack` with `success: true` that carries
// the draft's own `clientInputId`. Nothing else clears a draft: not an acknowledgement with
// no id or another id, not text that looks the same in the session's record. A second send
// is offered only when the serving machine said it recognises a repeat (`inputAck: 2`).
// When a draft stays unresolved the session itself is asked, once, in one fixed line; the
// person is never asked to check anything.

export const INPUT_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
/** After this long with no answer the label changes ("Not confirmed yet"); nothing else does. */
export const UNRESOLVED_AFTER_MS = 8000;

/** The sentences the person reads (FD-15: changing one is a spec change). */
export const WORDS = {
  connecting: 'Connecting to that machine…',
  refused: 'Not sent: typing into sessions on another machine is switched off on that machine. Your text is still here.',
  lost: 'Not sent: the connection to that machine dropped. Your text is still here.',
  failed: 'Not sent: that machine could not type into the session. Your text is still here.',
  askedAcked: 'Not confirmed yet. I have asked the session whether your text arrived, and it will answer in the conversation. Your text is still here.',
  askedNot: 'Not confirmed yet. I tried to ask the session whether your text arrived and could not confirm that either. Your text is still here.',
  retryUnknown: 'Not sent again: that machine has no record of your first try, so it cannot tell whether a second would repeat it.',
  sending: 'Sending…',
};
/** Key presses only report (§3e item 7). */
const KEY_WORDS = {
  refused: 'Not sent: typing into sessions on another machine is switched off on that machine.',
  lost: 'Not sent: the connection to that machine dropped.',
  failed: 'Not sent: that machine could not type into the session.',
};

/** A random id made in the browser: 24 characters of [A-Za-z0-9_-]. */
export function newInputId() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  const bytes = new Uint8Array(24);
  try { globalThis.crypto.getRandomValues(bytes); } catch { for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256); }
  let out = '';
  for (const b of bytes) out += alphabet[b & 63];
  return out;
}

const two = (n) => String(n).padStart(2, '0');
/** HH:MM in the browser's local time. */
export function clockWords(ms) { const d = new Date(ms); return `${two(d.getHours())}:${two(d.getMinutes())}`; }

/** The one line sent to the session about an unresolved draft (§3e item 5). Fixed. */
export function sessionLine(sentAtMs, clientInputId) {
  return `[dashboard] A message typed in the dashboard at ${clockWords(sentAtMs)} (input \`${clientInputId}\`) could not be confirmed as delivered to this session. This line is from the dashboard, not from the user. In your next reply to the user, say whether a dashboard message reached you around that time and what it said. If you do not recall one, say only that you cannot confirm it. Do not say it was lost and do not ask for it again.`;
}

/**
 * One session's composer drafts.
 * deps: { send(extra) → boolean  (writes { type, ...extra } for this session; false = socket not open),
 *         now() → ms, newId() → id, setTimer(ms, fn) → handle, clearTimer(handle), onChange() }
 */
export function createInputTracker(deps) {
  const d = { now: () => Date.now(), newId: newInputId, setTimer: (ms, fn) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h), onChange: () => {}, ...deps };
  let caps = null; // { inputAck: 1 | 2, remoteInput: true | false | null }
  let boxDraft = null; // the draft in the box while it is first sent
  let boxResult = null; // { text, words } after a first send ended: definitely not sent
  let notice = '';
  const drafts = []; // unresolved, above the composer
  const keyIds = new Set();
  const asks = new Map(); // ask id → draft

  const changed = () => { try { d.onChange(); } catch { /* the view repaints on the next event */ } };
  const findDraft = (id) => (boxDraft && boxDraft.id === id ? boxDraft : drafts.find((x) => x.id === id) || null);
  const removeDraft = (draft) => {
    if (draft.timer) d.clearTimer(draft.timer);
    if (draft.askTimer) d.clearTimer(draft.askTimer);
    if (boxDraft === draft) boxDraft = null;
    const i = drafts.indexOf(draft); if (i >= 0) drafts.splice(i, 1);
    if (draft.askId) asks.delete(draft.askId);
  };

  function ask(draft) {
    // Once per draft. If the session cannot be typed into now, the line waits for the next `input_caps`.
    if (draft.ask === 'sent' || draft.ask === 'acked' || draft.ask === 'failed') return;
    if (!caps) { draft.ask = 'waiting'; return; }
    const extra = { text: sessionLine(draft.sentAt, draft.id) };
    if (caps.inputAck === 2) { draft.askId = d.newId(); extra.clientInputId = draft.askId; asks.set(draft.askId, draft); }
    if (!d.send(extra)) { if (draft.askId) asks.delete(draft.askId); draft.askId = null; draft.ask = 'waiting'; return; }
    draft.ask = 'sent';
    // An older machine cannot answer the line by id; a newer one answers in a moment.
    draft.askTimer = d.setTimer(UNRESOLVED_AFTER_MS, () => { draft.askTimer = null; if (draft.ask === 'sent') { draft.ask = 'failed'; changed(); } });
  }

  function makeUnresolved(draft, reason) {
    if (draft.timer) { d.clearTimer(draft.timer); draft.timer = null; }
    draft.reason = reason; draft.retrying = false;
    if (boxDraft === draft) { boxDraft = null; drafts.push(draft); }
    else if (!drafts.includes(draft)) drafts.push(draft);
    ask(draft);
  }

  function boxFailed(draft, words) {
    // A first send that certainly typed nothing: the text goes back into the box.
    removeDraft(draft);
    boxResult = { text: draft.text, words };
    notice = words;
  }

  function onIdError(draft, code) {
    if (code === 'input-retry-unknown') { makeUnresolved(draft, 'retry-unknown'); return; }
    const words = code === 'input-not-allowed' ? WORDS.refused : code === 'peer-stream-lost' ? WORDS.lost : WORDS.failed;
    if (draft === boxDraft && code === 'write-failed') {
      // The machine tried to type and its write failed: part of the text may have reached the
      // pane, so this is not "certainly nothing typed". Keep it unresolved and ask the session.
      draft.refusal = words;
      makeUnresolved(draft, 'write-failed');
      notice = '';
      return;
    }
    // Refused before any write (gate, unknown session, bad id) or never relayed: nothing was typed.
    if (draft === boxDraft) { boxFailed(draft, words); return; }
    // A retry that was not sent: the first try is still unknown, so the draft stays unresolved.
    if (draft.timer) { d.clearTimer(draft.timer); draft.timer = null; }
    draft.retrying = false; draft.refusal = words;
  }

  /** Feed every frame for this session. Returns true when it was about input. */
  function onFrame(msg) {
    if (!msg || typeof msg !== 'object') return false;
    if (msg.type === 'input_caps') {
      caps = { inputAck: msg.inputAck === 2 ? 2 : 1, remoteInput: msg.remoteInput === true ? true : msg.remoteInput === false ? false : null };
      for (const x of drafts) if (x.ask === 'waiting') ask(x);
      changed();
      return true;
    }
    const id = typeof msg.clientInputId === 'string' ? msg.clientInputId : null;
    if (msg.type === 'input_ack') {
      if (!id) return true; // proves only that some input was written, never this draft
      if (asks.has(id)) { const draft = asks.get(id); asks.delete(id); if (draft.askTimer) { d.clearTimer(draft.askTimer); draft.askTimer = null; } draft.ask = msg.success === true ? 'acked' : 'failed'; changed(); return true; }
      if (keyIds.has(id)) { keyIds.delete(id); if (msg.success !== true) { notice = KEY_WORDS.failed; changed(); } return true; }
      const draft = findDraft(id);
      if (!draft) return true;
      if (msg.success === true) { removeDraft(draft); if (notice === WORDS.sending) notice = ''; }
      else onIdError(draft, 'write-failed');
      changed();
      return true;
    }
    if (msg.type === 'error') {
      const code = msg.code;
      if (id) {
        if (asks.has(id)) { const draft = asks.get(id); asks.delete(id); draft.ask = 'failed'; changed(); return true; }
        if (keyIds.has(id)) { keyIds.delete(id); notice = KEY_WORDS[code === 'input-not-allowed' ? 'refused' : code === 'peer-stream-lost' ? 'lost' : 'failed']; changed(); return true; }
        const draft = findDraft(id);
        if (draft) { onIdError(draft, code); changed(); }
        return Boolean(draft);
      }
      if (code === 'peer-stream-lost' || code === 'machine-unreachable') { linkDown(); return false; }
      if ((code === 'input-not-allowed' || code === 'session-not-found') && caps && caps.inputAck === 1) {
        // An older machine's refusal carries no id: show it on the newest draft, keep the draft.
        const last = [...drafts].reverse().find((x) => x.reason === 'no-dedupe');
        if (last) { last.refusal = code === 'input-not-allowed' ? WORDS.refused : WORDS.failed; changed(); }
        return Boolean(last);
      }
    }
    return false;
  }

  /** The link to the serving machine (or this page's socket) went away: wait for `input_caps` again. */
  function linkDown() { if (caps) { caps = null; changed(); } }

  /** Send the composer's text. Returns { ok } or { ok: false, words } (nothing sent, text stays). */
  function sendText(text) {
    if (!caps) return { ok: false, words: WORDS.connecting };
    if (caps.remoteInput === false) return { ok: false, words: WORDS.refused };
    if (boxDraft) return { ok: false, words: WORDS.sending };
    const draft = { id: d.newId(), text, sentAt: d.now(), reason: null, ask: 'none', askId: null, timer: null, askTimer: null, retrying: false, refusal: null };
    boxResult = null;
    if (caps.inputAck !== 2) {
      // That machine cannot recognise a repeat or answer by id: frames go without an id, and the
      // draft is unresolved from the start, with no send control.
      if (!d.send({ text })) return { ok: false, words: WORDS.lost };
      drafts.push(draft);
      makeUnresolved(draft, 'no-dedupe');
      notice = '';
      changed();
      return { ok: true, id: draft.id, unresolved: true };
    }
    if (!d.send({ text, clientInputId: draft.id })) return { ok: false, words: WORDS.lost };
    boxDraft = draft;
    notice = WORDS.sending;
    draft.timer = d.setTimer(UNRESOLVED_AFTER_MS, () => { draft.timer = null; if (boxDraft === draft) { makeUnresolved(draft, 'no-answer'); notice = ''; changed(); } });
    changed();
    return { ok: true, id: draft.id };
  }

  /** "Send again": the same id, flagged, only where the machine recognises a repeat. */
  function retry(id) {
    const draft = drafts.find((x) => x.id === id);
    if (!draft || !canRetry(draft)) return false;
    if (!d.send({ text: draft.text, clientInputId: draft.id, retry: true })) { draft.refusal = WORDS.lost; changed(); return false; }
    draft.retrying = true; draft.refusal = null;
    draft.timer = d.setTimer(UNRESOLVED_AFTER_MS, () => { draft.timer = null; draft.retrying = false; changed(); });
    changed();
    return true;
  }

  function discard(id) { const draft = drafts.find((x) => x.id === id); if (draft) { removeDraft(draft); changed(); } }

  /** A key press: an id and an answer where the machine gives one; never kept, never retried. */
  function sendKey(key) {
    if (!caps) return { ok: false, words: WORDS.connecting };
    if (caps.remoteInput === false) return { ok: false, words: KEY_WORDS.refused };
    const extra = { key };
    if (caps.inputAck === 2) { extra.clientInputId = d.newId(); keyIds.add(extra.clientInputId); if (keyIds.size > 64) keyIds.delete(keyIds.values().next().value); }
    if (!d.send(extra)) { if (extra.clientInputId) keyIds.delete(extra.clientInputId); return { ok: false, words: KEY_WORDS.lost }; }
    return { ok: true };
  }

  const canRetry = (draft) => Boolean(caps && caps.inputAck === 2 && draft.reason === 'no-answer' && !draft.retrying);

  function draftWords(draft) {
    if (draft.retrying) return WORDS.sending;
    // Only the spec's fixed sentences (FD-15): until the line is acknowledged by its id, the
    // honest one is "could not confirm that either".
    const base = draft.ask === 'acked' ? WORDS.askedAcked : WORDS.askedNot;
    if (draft.refusal) return draft.refusal;
    if (draft.reason === 'retry-unknown') return `${WORDS.retryUnknown} ${base}`;
    return base;
  }

  /** What the view shows. `boxResult` is handed over once. */
  function view() {
    const composer = !caps ? { disabled: true, readOnly: false, words: WORDS.connecting }
      : caps.remoteInput === false ? { disabled: true, readOnly: true, words: WORDS.refused }
        : { disabled: Boolean(boxDraft), readOnly: Boolean(boxDraft), words: '' };
    const out = {
      caps: caps ? { ...caps } : null,
      composer,
      sending: boxDraft ? { id: boxDraft.id, text: boxDraft.text } : null,
      returned: boxResult,
      notice,
      drafts: drafts.map((x) => ({
        id: x.id, text: x.text, words: draftWords(x),
        controls: canRetry(x) ? ['send-again', 'copy', 'discard'] : ['copy', 'discard'],
      })),
    };
    boxResult = null;
    return out;
  }

  function takeNotice() { const n = notice; notice = ''; return n; }

  return { onFrame, linkDown, sendText, retry, discard, sendKey, view, takeNotice, get caps() { return caps ? { ...caps } : null; } };
}

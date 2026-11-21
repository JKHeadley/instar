// Conversations suggestions (docs/specs/conversation-graph-suggestions.md §4, conversation-groups-phone.md §2).
// A suggestion is advice from the server. Accept is ONE server step (POST …/suggestions/:id/accept) that the
// dashboard and the owner's phone both call: the server creates the group, names it and moves each
// conversation in (preview first), exactly as a manual Create group + Move would, waiting for each change to be
// saved on every machine. A call that runs out of time answers `working`; calling again resumes the SAME
// requests on the server, so a reload, another tab or the phone never makes a second group.
import { el, setKids, note, operatorSession, operatorSessionRemainingMs, askPin } from './ui.js';
import { suggestionsModel } from './conversations-model.js';

const SUGGESTIONS = '/conversation-graph/suggestions';

/** The agent did not answer (timed out, or answered with a server error): nothing was decided. */
const noAnswer = (r) => r.status === 0 || r.status === 408 || r.status >= 500;

/**
 * Accept one suggestion. `onStep(text)` reports progress in plain words, including what a slow step is
 * waiting for. Resolves to { done:true, moved, skipped, effort } or { done:false, text, kind } where kind is
 * 'locked', 'waiting' (still saving or the agent did not answer), 'refused' or 'retry'.
 */
/** How long one Accept waits for the other machines to confirm before its project counts as still waiting.
 *  60 s was too short when a busy machine took 1-2 minutes to confirm (accept-all round 4 part 5). */
export const ACCEPT_CHANGE_CONFIRM_WAIT_MS = 150000;
/** Accept all stops only after this many projects in a row are still waiting (recorded, not yet confirmed). */
export const ACCEPT_ALL_STOP_AFTER_WAITING = 3;
/** Accept all's stop rule: given the consecutive still-waiting count before this project and this project's
 *  outcome, the new count and whether to stop. A finished or refused project resets the count. */
export function acceptAllStep(waits, out) {
  if (out && out.ok) return { waits: 0, stop: false };
  const next = out && out.kind === 'waiting' ? waits + 1 : 0;
  return { waits: next, stop: next >= ACCEPT_ALL_STOP_AFTER_WAITING };
}
export async function acceptSuggestion(s, { send, onStep, wait = ACCEPT_CHANGE_CONFIRM_WAIT_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now }) {
  const path = `${SUGGESTIONS}/${encodeURIComponent(s.id)}/accept`;
  onStep('Starting…');
  // The wait is counted by the clock (each call can itself take up to the server's budget), never only by the gaps.
  const startedAt = now();
  for (let gaps = 0; ;) {
    const waited = Math.max(gaps, now() - startedAt);
    const r = await send(path, {});
    if (r.needsUnlock || r.status === 403) return { done: false, kind: 'locked', text: 'Unlock again to continue.' };
    if (noAnswer(r)) return { done: false, kind: 'waiting', unreachable: true, text: 'The agent did not answer. Tap Continue to try again; nothing is lost.' };
    const d = r.data || {};
    if (r.ok && d.state === 'accepted') {
      return d.placedElsewhere
        ? { done: true, placedElsewhere: true, moved: 0, skipped: Number(d.skipped) || 0, effort: null }
        : { done: true, moved: Number(d.moved) || 0, skipped: Number(d.skipped) || 0, effort: d.group || null };
    }
    if (r.status === 409 && d.state === 'refused') return { done: false, kind: 'refused', code: typeof d.code === 'string' ? d.code : '', step: typeof d.step === 'string' ? d.step : '', next: typeof d.next === 'string' ? d.next : '', text: typeof d.text === 'string' && d.text ? d.text : 'This step could not be done. Nothing after it was changed.' };
    if (r.status === 404) return { done: false, kind: 'retry', text: 'This suggestion is no longer available. Refresh the list.' };
    if (r.status !== 202 || d.state !== 'working') return { done: false, kind: 'retry', text: 'Something went wrong. Tap Continue to try again; nothing is lost.' };
    const words = typeof d.text === 'string' && d.text ? d.text : 'Still working…';
    if (waited >= wait) {
      return { done: false, kind: 'waiting', unreachable: Boolean(d.agentNotAnswering),
        text: d.agentNotAnswering ? 'The agent did not answer. Tap Continue to try again; nothing is lost.' : `${words} Tap Continue later; nothing is lost.` };
    }
    onStep(waited >= 5000 ? `${words} (${Math.round(waited / 1000)} s)` : words);
    const gap = Number.isSafeInteger(d.retryAfterMs) && d.retryAfterMs > 0 && d.retryAfterMs <= 10000 ? d.retryAfterMs : 3000;
    await sleep(gap);
    gaps += gap;
  }
}

// The PIN unlock lasts 15 minutes and the page is cleared the moment it runs out, which took a long
// Accept all (and its progress) with it. Before starting, and before each project, Accept asks for the
// PIN again in a sheet when the unlock would not last: the page and its progress stay.
const START_NEEDS_MS = 10 * 60000;
const STEP_NEEDS_MS = 5 * 60000;

/**
 * True when the unlock has at least `needMs` left, asking for the PIN again (in a sheet, the page stays)
 * when it has not. False when the owner closed the sheet.
 */
export async function keepUnlocked(needMs, { remaining = operatorSessionRemainingMs, ask = askPin } = {}) {
  if (remaining() >= needMs) return true;
  const answer = await ask({ title: 'Keep going', explain: 'Your unlock is about to run out. Type your PIN so this can finish; nothing is lost.', adapter: 'session', fresh: true });
  return Boolean(answer) && remaining() > 0;
}

const SUGGESTIONS_RETRY_MS = 15000;
const SUGGESTIONS_AUTO_RETRY_FOR_MS = 5 * 60000; // tries again by itself for 5 minutes (by the clock, not a count)

/**
 * What the page says when suggestions could not be read, and when it tries again by itself.
 * `r` is the send() result; `tryingForMs` is how long the page has already been trying by itself.
 */
export function suggestionsUnavailable(r, tryingForMs) {
  const auto = tryingForMs < SUGGESTIONS_AUTO_RETRY_FOR_MS;
  if (r.status === 503 && r.data && r.data.awaitingJoin) {
    return { text: 'Suggestions are not available until your machines finish joining.', retryInMs: 0 };
  }
  if (r.status === 0 || r.status === 503) {
    return auto
      ? { text: 'Your agent is still getting your conversations ready. This can take a few minutes after it restarts. Trying again by itself in 15 seconds.', retryInMs: SUGGESTIONS_RETRY_MS }
      : { text: 'Your agent is still getting your conversations ready after 5 minutes of trying. Nothing is lost. Tap Try again, or come back in a few minutes.', retryInMs: 0 };
  }
  return { text: 'Suggestions could not be loaded. Nothing is lost. Tap Try again.', retryInMs: 0 };
}

/** The "Review suggestions" page. */
export async function renderSuggestions({ main, send, current, unlock, header, back, openEffort }) {
  const status = el('p', { class: 'need-sub', role: 'status', 'aria-live': 'polite' });
  const list = el('div', { class: 'rows conversation-suggestions' });
  const body = el('div', { class: 'conversations-page' }, header, back, status, list);
  setKids(main, body);
  let tryingSince = null; // when the page started trying by itself; null while suggestions load fine
  const load = async () => {
    status.textContent = 'Loading suggestions…';
    // A slow answer says so, instead of looking frozen.
    const slow = setTimeout(() => { if (current() && status.textContent === 'Loading suggestions…') status.textContent = 'Still loading suggestions. Your agent is busy; this can take up to 20 seconds.'; }, 5000);
    const r = await send(SUGGESTIONS).finally(() => clearTimeout(slow));
    if (!current()) return;
    if (r.needsUnlock) { unlock(); return; }
    const model = r.ok ? suggestionsModel(r.data) : { ok: false };
    if (!model.ok) {
      // Never a dead end: plain words, what happens next, and a way to act. A slow or not-yet-open graph
      // (for a while after a restart) is retried by the page itself, so nobody has to keep tapping.
      tryingSince ??= Date.now();
      const words = suggestionsUnavailable(r, Date.now() - tryingSince);
      status.textContent = words.text;
      const again = el('button', { type: 'button', class: 'btn-quiet btn-inline', text: 'Try again' });
      const go = () => { clearTimeout(timer); again.remove(); load(); };
      again.addEventListener('click', () => { tryingSince = null; go(); });
      list.replaceChildren(again);
      const timer = words.retryInMs ? setTimeout(() => { if (current() && again.isConnected) go(); }, words.retryInMs) : null;
      return;
    }
    tryingSince = null;
    const cards = model.items.map((s) => ({ s, ...card(s) }));
    list.replaceChildren(...cards.map((c) => c.box));
    // "Accept all projects": the same owner path, one project at a time; a stop leaves Continue on the rest.
    const projects = cards.filter((c) => c.s.frontDoor);
    if (projects.length > 1) {
      // One already part-way (another tab, an earlier tap, or a lapsed unlock): the button says it continues.
      const started = projects.some((c) => c.s.accepting || c.started());
      const all = el('button', { type: 'button', class: 'btn-primary btn-inline', text: started ? 'Continue accepting projects' : `Accept all ${projects.length} projects` });
      // What "Accept all" is doing right now, next to the button: the cards it works on are further down the page.
      const progress = el('p', { class: 'need-sub conversation-suggestion-progress', role: 'status', 'aria-live': 'polite' });
      all.addEventListener('click', async () => {
        if (!current() || !operatorSession()) { unlock(); return; }
        all.disabled = true;
        const total = projects.length;
        const accepted = () => projects.filter((c) => c.finished()).length;
        const again = (text) => { progress.textContent = text; all.textContent = 'Continue accepting projects'; all.disabled = false; };
        try {
          if (!await keepUnlocked(START_NEEDS_MS)) { if (current()) again('Accept all did not start: it needs your PIN.'); return; }
          if (!current()) return;
          let waits = 0;
          for (const [i, c] of projects.entries()) {
            if (c.finished()) continue;
            if (!await keepUnlocked(STEP_NEEDS_MS)) { if (current()) again(`Stopped at ${i + 1} of ${total}: it needs your PIN. ${accepted()} of ${total} accepted. Tap Continue; nothing is lost.`); return; }
            if (!current()) return;
            const label = `Accepting ${i + 1} of ${total}: ${c.s.title}.`;
            progress.textContent = label;
            const out = await c.run((t) => { progress.textContent = `${label} ${t}`; });
            if (!current()) return;
            if (out.ok) { waits = 0; continue; }
            if (out.kind === 'locked') { again(`Stopped at ${i + 1} of ${total}. Unlock again, then tap Continue.`); unlock(); return; }
            // One project that cannot finish does not hold up the rest; several in a row that are still
            // waiting means the machines are not confirming, so going on would only wait again.
            const step = acceptAllStep(waits, out); waits = step.waits;
            if (step.stop) {
              const why = out.unreachable ? 'your agent is not answering right now' : 'changes are not being confirmed right now';
              again(`Stopped at ${i + 1} of ${total}: ${why}. ${accepted()} of ${total} accepted. Tap Continue to try again; nothing is lost.`);
              return;
            }
          }
          const left = total - accepted();
          if (left) again(`${accepted()} of ${total} projects accepted. ${left} did not finish; ${left === 1 ? 'its card says' : 'their cards say'} why. Tap Continue to try again.`);
          else { progress.textContent = `All ${total} projects accepted.`; all.textContent = 'All projects accepted'; }
        } catch {
          if (current()) again('Something went wrong on this page. Tap Continue to try again; nothing is lost.');
        }
      });
      list.prepend(el('div', { class: 'conversation-suggestion-actions' }, all), progress);
    }
    status.textContent = model.state === 'building' ? 'Looking through your conversations. This takes a minute or two.'
      : model.failure === 'model-unavailable' ? 'Suggestions need a model this agent can use, and none is set up here.'
        : model.failure === 'build-failed' ? 'The last look-through did not finish. Tap Refresh to try again.'
          : model.items.length ? '' : 'No suggestions right now. Your conversations are in All.';
    const refresh = el('button', { type: 'button', class: 'btn-quiet btn-inline', text: model.state === 'building' ? 'Check again' : 'Refresh suggestions' });
    refresh.addEventListener('click', async () => {
      refresh.disabled = true;
      if (model.state !== 'building') {
        const asked = await send(`${SUGGESTIONS}/refresh`, {});
        if (!current()) return;
        if (asked.needsUnlock) { unlock(); return; }
        if (asked.status === 429 && asked.data?.reason === 'too-soon') { status.textContent = 'Suggestions were just refreshed. Try again in a few minutes.'; refresh.disabled = false; return; }
      }
      await load();
    });
    list.append(refresh);
  };
  const card = (s) => {
    const words = el('p', { class: 'need-sub', role: 'status', 'aria-live': 'polite' });
    const accept = el('button', { type: 'button', class: 'btn-primary btn-inline', text: s.accepting ? 'Continue' : 'Accept' });
    const reject = el('button', { type: 'button', class: 'btn-quiet btn-inline', text: 'Reject' });
    let finished = false;
    let started = Boolean(s.accepting);
    const actions = el('div', { class: 'conversation-suggestion-actions' }, accept, reject);
    const box = el('div', { class: 'need-card conversation-suggestion' },
      el('p', { class: 'row-title', text: s.title }),
      s.reason ? el('p', { class: 'need-sub', text: s.reason }) : null,
      el('ul', { class: 'conversation-suggestion-members' }, s.members.map((m) => el('li', { text: m.title }))),
      actions, words);
    // One Accept (or Continue); true when this suggestion is finished. "Accept all projects" calls it too.
    // Resolves to { ok:true } or { ok:false, kind, text }; never throws, and never leaves the buttons disabled
    // without words. `mirror(text)` receives the same progress words ("Accept all" shows them by its button).
    const run = async (mirror) => {
      accept.disabled = true; reject.disabled = true;
      words.textContent = 'Starting…';
      // While it runs, no page refresh may redraw over it (ui.js refreshHeld).
      box.setAttribute('data-interaction-open', '');
      const out = await acceptSuggestion(s, { send, onStep: (t) => { words.textContent = t; mirror?.(t); } })
        .catch(() => ({ done: false, kind: 'retry', text: 'Something went wrong on this page. Tap Continue to try again; nothing is lost.' }))
        .finally(() => box.removeAttribute('data-interaction-open'));
      if (!current()) return { ok: false, kind: 'gone', text: '' };
      // A finished card keeps its words and its link, never its Accept/Reject buttons: after "All 4 projects
      // accepted." a card still showing Accept read as not done (accept-all round 3, real two-machine run).
      if (out.done) actions.remove();
      if (out.done && out.placedElsewhere) {
        finished = true;
        words.textContent = 'Its conversation is already inside another project, so nothing was created.';
        return { ok: true };
      }
      if (out.done) {
        finished = true;
        words.textContent = out.skipped ? `Done. ${out.moved} moved; ${out.skipped} could not be moved and stayed where they were.` : `Done. ${out.moved} conversations are in this group.`;
        box.append(el('a', { class: 'btn-quiet btn-inline', href: openEffort(out.effort), text: s.frontDoor ? 'Open project' : 'Open group' }));
        return { ok: true };
      }
      // The suggestion was closed (its group was removed): nothing more to do on this card.
      // The server says what comes next (`next`); an older server without it is read from the code.
      if (out.next === 'finished' || (!out.next && out.code === 'group-gone')) { finished = true; box.replaceChildren(note(out.text)); return { ok: true }; }
      // The server handed the decision back (nothing made, or the group cannot be found): Accept again or Reject.
      if (out.kind === 'refused' && (out.next === 'accept-or-reject' || (!out.next && (out.code === 'group-not-found' || out.code === 'unexpected-answer')))) {
        words.textContent = out.text; accept.textContent = 'Accept again'; accept.disabled = false; reject.disabled = false;
        return { ok: false, kind: 'refused', text: out.text };
      }
      // Otherwise the server keeps its progress and refuses Reject while its group may exist: Continue finishes it.
      started = true;
      words.textContent = out.text; accept.textContent = 'Continue'; accept.disabled = false; reject.disabled = true;
      return { ok: false, kind: out.kind || 'retry', unreachable: Boolean(out.unreachable), text: out.text };
    };
    accept.addEventListener('click', async () => {
      if (!current() || !operatorSession()) { unlock(); return; }
      if (!await keepUnlocked(STEP_NEEDS_MS)) { if (current()) words.textContent = 'This needs your PIN. Tap Accept again; nothing is lost.'; return; }
      if (!current()) return;
      await run();
    });
    reject.addEventListener('click', async () => {
      if (!current() || !operatorSession()) { unlock(); return; }
      reject.disabled = true; accept.disabled = true;
      const r = await send(`${SUGGESTIONS}/${encodeURIComponent(s.id)}/reject`, {});
      if (!current()) return;
      if (r.needsUnlock) { unlock(); return; }
      if (r.ok) { finished = true; box.replaceChildren(note('Rejected. This suggestion will not come back.')); return; }
      if (r.status === 409 && r.data?.code === 'accept-started') { words.textContent = 'This group is already being made. Tap Continue to finish it.'; accept.disabled = false; return; }
      words.textContent = 'Could not record that. Try again.'; reject.disabled = false; accept.disabled = false;
    });
    return { box, run, finished: () => finished, started: () => started };
  };
  await load();
}

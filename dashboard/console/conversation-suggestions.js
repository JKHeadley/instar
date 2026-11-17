// Conversations suggestions (docs/specs/conversation-graph-suggestions.md §4).
// A suggestion is advice from the server. Accept runs the ORDINARY owner changes, one at a time,
// exactly as a manual Create effort + Move would: create the effort, name it, move each
// conversation in (preview first). Each step waits for its change to be saved on every machine
// before the next, because the next step names what the last one made. The create request id
// comes from the server (one per suggestion), so a reload, another tab or another machine's
// dashboard reuses the SAME request and the owner pipeline's idempotency yields one effort.
// sessionStorage keeps only opaque ids and refs, as a shortcut for this tab.
import { el, setKids, note, operatorSession } from './ui.js';
import { suggestionsModel, nodeModel, encodeNodeRef } from './conversations-model.js';
import { requestId } from './conversation-write-continuity.js';

const SUGGESTIONS = '/conversation-graph/suggestions';
const FINAL_FAIL = ['canceled', 'canceled-local', 'refused-local', 'erased'];
const progressKey = (id) => `instar-conversation-accept:${location.origin}:${id}`;

function readProgress(id) {
  try {
    const v = JSON.parse(sessionStorage.getItem(progressKey(id)) || 'null');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}
function writeProgress(id, value) {
  try { sessionStorage.setItem(progressKey(id), JSON.stringify(value)); return true; } catch { return false; }
}
function clearProgress(id) { try { sessionStorage.removeItem(progressKey(id)); } catch { /* nothing kept */ } }

/** Plain words for a step that is still saving. */
function waitingWords(data) {
  if (data?.code === 'subject-change-pending') return 'An earlier change to this conversation is still being saved on your machines.';
  const names = Array.isArray(data?.waitingMachines) ? data.waitingMachines.map((m) => m?.name).filter(Boolean) : [];
  return names.length ? `Saved here. Waiting for ${names.join(', ')} to confirm.` : 'Saved here. Waiting for your other machines to confirm.';
}

/**
 * One owner change, sent once and then checked until it is committed. Returns
 * { ok:true, data } when committed, { ok:false, waiting:true, data } when it is still saving after
 * the wait, { ok:false, code } when it was refused. The same requestId is reused on resume.
 * `onWait(data, waitedMs, unreachable)` is called before every re-check, so the page can say what it is waiting for.
 */
async function runChange({ send, change, id, wait, sleep, onWait }) {
  let result = await send('/conversation-graph/changes', { requestId: id, change });
  for (let waited = 0; ; waited += 2500) {
    if (result.needsUnlock) return { ok: false, code: 'locked' };
    const data = result.data || {};
    if (data.state === 'committed') return { ok: true, data };
    if (FINAL_FAIL.includes(data.state)) return { ok: false, code: data.reason || data.state };
    if (!result.ok && result.status >= 400 && result.status !== 409 && data.requestState === 'not-recorded') return { ok: false, code: data.code || 'refused' };
    if (result.status === 409 && data.code && data.code !== 'subject-change-pending') return { ok: false, code: data.code };
    const unreachable = result.status === 0;
    if (waited >= wait) return { ok: false, waiting: true, unreachable, data };
    onWait?.(data, waited, unreachable);
    await sleep(2500);
    result = await send(`/conversation-graph/changes/${encodeURIComponent(id)}`);
  }
}

async function node(send, ref) {
  const r = await send(`/conversation-graph/nodes/${encodeURIComponent(encodeNodeRef(ref))}`);
  if (r.needsUnlock) return { locked: true };
  const model = r.ok ? nodeModel(r.data) : null;
  return model?.ok ? model : null;
}

/**
 * Accept one suggestion. `onStep(text)` reports progress in plain words, including what a slow step is
 * waiting for. Resolves to { done:true, moved, skipped } or { done:false, text, kind } where kind is
 * 'locked', 'waiting' (still saving or the agent did not answer), 'refused' or 'retry'.
 */
export async function acceptSuggestion(s, { send, onStep, wait = 60000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const p = readProgress(s.id);
  const save = () => writeProgress(s.id, p);
  const locked = () => ({ done: false, kind: 'locked', text: 'Unlock again to continue.' });
  const retry = (text) => ({ done: false, kind: 'retry', text });
  const stop = (r) => r.code === 'locked' ? locked()
    : r.waiting ? { done: false, kind: 'waiting', text: r.unreachable ? 'The agent did not answer. Tap Continue to try again; nothing is lost.'
      : `${waitingWords(r.data)} Tap Continue later; nothing is lost.` }
      : { done: false, kind: 'refused', text: `This step was refused (${r.code}). Nothing after it was changed.` };
  // The step now running, and the same words with what it is waiting for once a change takes more than a moment.
  let step = '';
  const say = (text) => { step = text; onStep(text); };
  const onWait = (data, waited, unreachable) => {
    if (waited < 5000) return;
    onStep(`${step} ${unreachable ? 'The agent is not answering yet.' : waitingWords(data)} (${Math.round(waited / 1000)} s)`);
  };

  // 0. A project whose own conversation is already inside something (another project's Accept moved it, or the
  //    owner did): create nothing, so "Accept all" never leaves an empty project behind.
  //    Not when an Accept is already in progress on the server (another tab, browser or the phone started it):
  //    then the conversation may sit in THIS suggestion's effort, and step 1 resumes the same request.
  if (s.frontDoor && !p.effort && !s.accepting) {
    say('Checking where its conversation is…');
    const front = await node(send, s.frontDoor);
    if (front?.locked) return locked();
    if (front && front.path.length) return { done: true, placedElsewhere: true, moved: 0, skipped: s.members.length, effort: null };
  }
  // 1. The effort.
  if (!p.effort) {
    say('Creating the effort…');
    const started = await send(`${SUGGESTIONS}/${encodeURIComponent(s.id)}/start`, {});
    if (started.needsUnlock) return locked();
    const createId = started.data?.createRequestId;
    if (!started.ok || typeof createId !== 'string' || !/^[A-Za-z0-9_.:-]{8,160}$/.test(createId)) return retry('This suggestion is no longer available. Refresh the list.');
    p.createId = createId; save();
    const r = await runChange({ send, id: createId, change: { kind: 'create-effort', projectScope: [] }, wait, sleep, onWait });
    if (!r.ok) return stop(r);
    if (r.data.effort?.kind !== 'effort') return retry('The effort was created but could not be opened. Refresh and try again.');
    p.effort = r.data.effort; save();
  }
  // 2. Its name.
  if (!p.named) {
    say('Naming it…');
    const effort = await node(send, p.effort);
    if (effort?.locked) return locked();
    if (!effort || !Number.isSafeInteger(effort.correction?.headerVersion)) return retry('The new effort is not readable yet. Tap Continue in a moment.');
    // Named already (by another tab, or before a reload lost this tab's progress): keep that name.
    if (effort.correction.headerVersion === 0) {
      p.nameId = p.nameId || requestId(); save();
      const r = await runChange({ send, id: p.nameId, change: { kind: 'set-effort-title', effort: p.effort, baseVersion: 0, title: s.title }, wait, sleep, onWait });
      if (!r.ok) return stop(r);
    }
    p.named = true; save();
  }
  // 3. Each conversation, previewed first.
  p.moved = Array.isArray(p.moved) ? p.moved : [];
  p.skipped = Array.isArray(p.skipped) ? p.skipped : [];
  p.moveIds = p.moveIds && typeof p.moveIds === 'object' ? p.moveIds : {};
  for (const [i, m] of s.members.entries()) {
    if (p.moved.includes(m.key) || p.skipped.includes(m.key)) continue;
    say(`Moving conversation ${i + 1} of ${s.members.length}…`);
    const current = await node(send, m.ref);
    if (current?.locked) return locked();
    if (!current) { p.skipped.push(m.key); save(); continue; }
    const parentKey = current.path.length ? encodeNodeRef(current.path[current.path.length - 1].ref) : null;
    if (parentKey === encodeNodeRef(p.effort)) { p.moved.push(m.key); save(); continue; }
    // Placed somewhere else since the suggestion was made: the owner's own placement wins.
    if (parentKey !== null) { p.skipped.push(m.key); save(); continue; }
    if (!current.correction?.moveEligible) { p.skipped.push(m.key); save(); continue; }
    const change = { kind: 'set-primary-placement', subject: m.ref, parent: p.effort, replacesPlacementEventIds: current.correction.replacesPlacementEventIds };
    if (!p.moveIds[m.key]) {
      const preview = await send('/conversation-graph/preview', change);
      if (preview.needsUnlock) return locked();
      if (!preview.ok || preview.data?.eligible !== true) { p.skipped.push(m.key); save(); continue; }
      p.moveIds[m.key] = requestId(); save();
    }
    const r = await runChange({ send, id: p.moveIds[m.key], change, wait, sleep, onWait });
    if (!r.ok && !r.waiting && r.code !== 'locked') { p.skipped.push(m.key); save(); continue; }
    if (!r.ok) return stop(r);
    p.moved.push(m.key); save();
  }
  // 4. A project's own conversation becomes the effort's front door (work-front-doors stage 2b), once it
  //    sits in the effort. If the owner had already placed it elsewhere it was skipped above, and so is this.
  if (s.frontDoor && !p.frontDoorSet) {
    const frontKey = encodeNodeRef(s.frontDoor);
    if (p.moved.includes(frontKey)) {
      say('Making its conversation the front door…');
      const effort = await node(send, p.effort);
      const conv = await node(send, s.frontDoor);
      if (effort?.locked || conv?.locked) return locked();
      if (!effort || !conv?.correction) return retry('The new effort is not readable yet. Tap Continue in a moment.');
      const already = effort.node.frontDoor && encodeNodeRef(effort.node.frontDoor) === frontKey;
      if (!already) {
        p.frontDoorId = p.frontDoorId || requestId(); save();
        const change = { kind: 'set-front-door', effort: p.effort, conversation: s.frontDoor,
          replacesFrontDoorEventIds: effort.correction?.replacesFrontDoorEventIds || [], observedPlacementEventIds: conv.correction.replacesPlacementEventIds };
        const r = await runChange({ send, id: p.frontDoorId, change, wait, sleep, onWait });
        if (!r.ok) return stop(r);
      }
    }
    p.frontDoorSet = true; save();
  }
  // 5. Done: the server stops offering it.
  say('Finishing…');
  const finished = await send(`${SUGGESTIONS}/${encodeURIComponent(s.id)}/accepted`, {});
  if (finished.needsUnlock) return locked();
  if (!finished.ok) return retry('Everything moved, but finishing the suggestion could not be recorded. Tap Continue.');
  const result = { done: true, moved: p.moved.length, skipped: p.skipped.length, effort: p.effort };
  clearProgress(s.id);
  return result;
}

/** The "Review suggestions" page. */
export async function renderSuggestions({ main, send, current, unlock, header, back, openEffort }) {
  const status = el('p', { class: 'need-sub', role: 'status', 'aria-live': 'polite' });
  const list = el('div', { class: 'rows conversation-suggestions' });
  const body = el('div', { class: 'conversations-page' }, header, back, status, list);
  setKids(main, body);
  const load = async () => {
    status.textContent = 'Loading suggestions…';
    const r = await send(SUGGESTIONS);
    if (!current()) return;
    if (r.needsUnlock) { unlock(); return; }
    const model = r.ok ? suggestionsModel(r.data) : { ok: false };
    if (!model.ok) { status.textContent = r.status === 503 ? 'Suggestions are not available until your machines finish joining.' : 'Suggestions could not be loaded. Try again.'; return; }
    const cards = model.items.map((s) => ({ s, ...card(s) }));
    list.replaceChildren(...cards.map((c) => c.box));
    // "Accept all projects": the same owner path, one project at a time; a stop leaves Continue on the rest.
    const projects = cards.filter((c) => c.s.frontDoor);
    if (projects.length > 1) {
      const all = el('button', { type: 'button', class: 'btn-primary btn-inline', text: `Accept all ${projects.length} projects` });
      // What "Accept all" is doing right now, next to the button: the cards it works on are further down the page.
      const progress = el('p', { class: 'need-sub conversation-suggestion-progress', role: 'status', 'aria-live': 'polite' });
      all.addEventListener('click', async () => {
        if (!current() || !operatorSession()) { unlock(); return; }
        all.disabled = true;
        const total = projects.length;
        const accepted = () => projects.filter((c) => c.finished()).length;
        const again = (text) => { progress.textContent = text; all.textContent = 'Continue accepting projects'; all.disabled = false; };
        try {
          let waits = 0;
          for (const [i, c] of projects.entries()) {
            if (c.finished()) continue;
            const label = `Accepting ${i + 1} of ${total}: ${c.s.title}.`;
            progress.textContent = label;
            const out = await c.run((t) => { progress.textContent = `${label} ${t}`; });
            if (!current()) return;
            if (out.ok) { waits = 0; continue; }
            if (out.kind === 'locked') { again(`Stopped at ${i + 1} of ${total}. Unlock again, then tap Continue.`); unlock(); return; }
            // One project that cannot finish does not hold up the rest; two in a row that are still
            // waiting means the machines are not confirming, so going on would only wait again.
            waits = out.kind === 'waiting' ? waits + 1 : 0;
            if (waits >= 2) {
              again(`Stopped at ${i + 1} of ${total}: changes are not being confirmed right now. ${accepted()} of ${total} accepted. Tap Continue to try again; nothing is lost.`);
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
    const accept = el('button', { type: 'button', class: 'btn-primary btn-inline', text: s.accepting || readProgress(s.id).effort ? 'Continue' : 'Accept' });
    const reject = el('button', { type: 'button', class: 'btn-quiet btn-inline', text: 'Reject' });
    let finished = false;
    const box = el('div', { class: 'need-card conversation-suggestion' },
      el('p', { class: 'row-title', text: s.title }),
      s.reason ? el('p', { class: 'need-sub', text: s.reason }) : null,
      el('ul', { class: 'conversation-suggestion-members' }, s.members.map((m) => el('li', { text: m.title }))),
      el('div', { class: 'conversation-suggestion-actions' }, accept, reject), words);
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
      if (out.done && out.placedElsewhere) {
        finished = true;
        words.textContent = 'Its conversation is already inside another project, so nothing was created.';
        return { ok: true };
      }
      if (out.done) {
        finished = true;
        words.textContent = out.skipped ? `Done. ${out.moved} moved; ${out.skipped} could not be moved and stayed where they were.` : `Done. ${out.moved} conversations are in this effort.`;
        box.append(el('a', { class: 'btn-quiet btn-inline', href: openEffort(out.effort), text: s.frontDoor ? 'Open project' : 'Open effort' }));
        return { ok: true };
      }
      words.textContent = out.text; accept.textContent = 'Continue'; accept.disabled = false; reject.disabled = Boolean(readProgress(s.id).effort);
      return { ok: false, kind: out.kind || 'retry', text: out.text };
    };
    accept.addEventListener('click', async () => {
      if (!current() || !operatorSession()) { unlock(); return; }
      await run();
    });
    reject.addEventListener('click', async () => {
      if (!current() || !operatorSession()) { unlock(); return; }
      reject.disabled = true; accept.disabled = true;
      const r = await send(`${SUGGESTIONS}/${encodeURIComponent(s.id)}/reject`, {});
      if (!current()) return;
      if (r.needsUnlock) { unlock(); return; }
      if (r.ok) { finished = true; box.replaceChildren(note('Rejected. This suggestion will not come back.')); return; }
      words.textContent = 'Could not record that. Try again.'; reject.disabled = false; accept.disabled = false;
    });
    return { box, run, finished: () => finished };
  };
  await load();
}

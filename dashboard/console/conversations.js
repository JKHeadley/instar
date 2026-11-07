// Native console Conversations. Owner-only reads use the existing PIN proof.
// UI is a projection consumer: no inferred grouping, routing, or decision state.
import { el, pageHead, setKids, note, askPin, operatorSession, forgetOperatorSession, arrivalScrollPosition } from './ui.js';
import { listModel, nodeModel, pageQuery, graphHistoryRoute, historyModel, encodeNodeRef, localOnlyEnvelope, localOnlyWords } from './conversations-model.js';
import { mountPending } from './conversation-pending.js';
import { correctionControls } from './conversation-corrections.js';
import { effortActionControls } from './conversation-effort-actions.js';
import { erasureControls } from './conversation-erasure.js';

const PAGE = '#/work/conversations';
const ROOTS = '/conversation-graph/roots';
const visits = new Map(); // Navigation only (scroll/cursors), never transcript content.
const runs = new WeakMap();

function routeState() {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  return { view: params.get('view') === 'all' ? 'all' : 'overview', q: params.get('q') || '', ref: params.get('node') || '' };
}

function href({ view = 'overview', q = '', ref = '' } = {}) {
  const p = new URLSearchParams();
  if (view === 'all') p.set('view', 'all');
  if (q) p.set('q', q);
  if (ref) p.set('node', ref);
  return PAGE + (p.size ? `?${p}` : '');
}

function remember() {
  const key = location.hash;
  const prior = visits.get(key) || {};
  visits.delete(key);
  visits.set(key, { ...prior, scroll: window.scrollY });
  while (visits.size > 40) visits.delete(visits.keys().next().value);
}

function nav(label, target, className = 'btn-quiet btn-inline', nodeNavigation = false) {
  return el('a', { class: className, href: target, text: label, onclick: nodeNavigation ? openNode : remember });
}

function openNode(event) {
  remember();
  const target = new URL(event.currentTarget.href).hash;
  visits.set(target, { ...(visits.get(target) || {}), origin: location.hash });
}

function bearer() { try { return localStorage.getItem('instar_token') || ''; } catch { return ''; } }

async function read(path, signal, body) {
  const proof = operatorSession();
  if (!proof) return { ok: false, status: 403, needsUnlock: true };
  const deadline = new AbortController();
  const timeout = setTimeout(() => deadline.abort(), 20000);
  const onAbort = () => deadline.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const r = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${bearer()}`, 'X-Instar-Operator-Session': proof,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: 'no-store', signal: deadline.signal,
    });
    const data = await r.json().catch(() => ({}));
    if (r.status === 401 || r.status === 403) {
      forgetOperatorSession();
      return { ok: false, status: r.status, needsUnlock: true };
    }
    return { ok: r.ok, status: r.status, data };
  } catch (error) {
    return { ok: false, aborted: error?.name === 'AbortError', status: 0 };
  } finally { clearTimeout(timeout); signal?.removeEventListener('abort', onAbort); }
}

function unlock(main, retry) {
  setKids(main, el('div', { class: 'conversations-page' },
    pageHead({ eyebrow: 'Conversations', headline: 'Your conversations' }),
    el('div', { class: 'need-card' },
      el('p', { class: 'need-sub', text: 'Unlock to see your efforts and conversation history.' }),
      el('button', { type: 'button', class: 'btn-primary btn-inline', text: 'Unlock', onclick: async () => {
        const result = await askPin({ title: 'Your conversations', explain: 'Unlock your private conversations.', adapter: 'session' });
        if (result) retry();
      } }))));
}

function failure(main, result, retry) {
  if (result.needsUnlock) { unlock(main, retry); return; }
  const text = result.status === 503 ? 'Conversations is not switched on here yet.'
    : result.status === 404 ? 'This conversation is unavailable.'
      : 'Conversations could not be loaded. Try again.';
  setKids(main, el('div', { class: 'conversations-page' },
    pageHead({ eyebrow: 'Conversations', headline: 'Your conversations' }),
    note(text), el('button', { type: 'button', class: 'btn-quiet btn-inline', text: 'Try again', onclick: retry })));
}

function itemRow(item, state) {
  return el('a', { class: 'row conversation-row', href: href({ ...state, ref: item.key }), onclick: openNode },
    el('span', { class: 'row-main' }, el('span', { class: 'row-title', text: item.title })),
    el('span', { class: 'chev', 'aria-hidden': 'true', text: '›' }));
}

function messageRow(message) {
  const time = Date.parse(message.at);
  return el('article', { class: `conversation-message${message.fromUser ? ' from-user' : ''}` },
    el('div', { class: 'need-sub' },
      el('span', { text: message.fromUser ? (message.senderName || 'You') : 'Agent' }),
      Number.isFinite(time) ? el('time', { datetime: message.at, text: new Date(time).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }) }) : null),
    el('p', { class: 'conversation-message-text', text: message.text }),
    message.attachmentCount ? el('p', { class: 'need-sub', text: `${message.attachmentCount} attachment${message.attachmentCount === 1 ? '' : 's'} · Open the original conversation to view.` }) : null);
}

async function transcript(node, controller, current, main, retry) {
  const region = el('section', { class: 'conversation-transcript', 'aria-label': 'Conversation history' },
    el('p', { role: 'status', class: 'need-sub', text: 'Loading history…' }));
  const path = graphHistoryRoute(node);
  if (!path) { region.replaceChildren(note('The original history is not available on this machine.')); return region; }
  const result = await read(path, controller.signal);
  if (!current()) return region;
  if (result.needsUnlock) { unlock(main, retry); return null; }
  const model = result.ok ? historyModel(result.data, node.source) : { ok: false };
  if (!model.ok) { region.replaceChildren(note('The original history could not be loaded.')); return region; }
  const messages = el('div', { class: 'conversation-messages' }, model.messages.map(messageRow));
  const status = el('p', { class: 'need-sub', role: 'status' });
  const seen = new Set(model.messages.map((m) => m.key));
  region.replaceChildren(messages, status);
  if (!model.messages.length) messages.append(note('No recorded messages are available here.'));
  if (model.observedOnly) region.append(el('p', { class: 'need-sub', text: 'Recorded history · Earlier Telegram messages may be missing.' }));
  if (model.partial) region.append(note('Some machines did not answer. This history may be incomplete.'));
  if (model.before) {
    let before = model.before;
    const more = el('button', { type: 'button', class: 'btn-quiet btn-inline', text: 'Earlier messages' });
    more.addEventListener('click', async () => {
      more.disabled = true; status.textContent = 'Loading earlier messages…';
      const next = await read(graphHistoryRoute(node, before), controller.signal);
      if (!current()) return;
      if (next.needsUnlock) { unlock(main, retry); return; }
      const earlier = next.ok ? historyModel(next.data, node.source) : { ok: false };
      if (!earlier.ok) { status.textContent = 'Earlier messages could not be loaded.'; more.disabled = false; return; }
      const added = earlier.messages.filter((m) => !seen.has(m.key));
      added.forEach((m) => seen.add(m.key));
      messages.prepend(...added.map(messageRow));
      more.hidden = !earlier.before || earlier.before === before;
      before = earlier.before;
      more.disabled = false;
      status.textContent = earlier.partial ? 'Some machines did not answer.' : '';
    });
    region.prepend(more);
  }
  return region;
}

function restoreScroll(key) {
  const position = visits.get(key)?.scroll;
  if (typeof position === 'number') arrivalScrollPosition(position, { key: `conversations:${key}` });
}

export async function renderConversations(main) {
  runs.get(main)?.abort();
  const controller = new AbortController();
  runs.set(main, controller);
  const key = location.hash;
  const state = routeState();
  const current = () => !controller.signal.aborted && main.isConnected && location.hash === key;
  const retry = () => renderConversations(main);
  if (!operatorSession()) { unlock(main, retry); return; }
  // A local PIN-proof expiry must clear private DOM even while a sheet holds
  // the ordinary page refresh. Tie this observer to the current render only.
  const enforceLock = () => {
    if (!main.isConnected || location.hash !== key) { controller.abort(); return; }
    if (!operatorSession()) { controller.abort(); forgetOperatorSession(); unlock(main, retry); }
  };
  const pageDocument = main.ownerDocument;const pageWindow=pageDocument.defaultView;
  const lockWatch = setInterval(enforceLock, 250);
  pageDocument.addEventListener('visibilitychange', enforceLock);
  pageWindow?.addEventListener('instar-owner-locked',enforceLock);
  controller.signal.addEventListener('abort', () => {
    clearInterval(lockWatch); pageDocument.removeEventListener('visibilitychange', enforceLock);pageWindow?.removeEventListener('instar-owner-locked',enforceLock);
  }, { once: true });
  // Clear private content before any asynchronous owner-authorized read.
  setKids(main, el('div', { class: 'conversations-page', 'aria-busy': 'true' },
    pageHead({ eyebrow: 'Conversations', headline: 'Loading conversations…' })));
  if (state.ref) {
    const result = await read(`/conversation-graph/nodes/${encodeURIComponent(state.ref)}`, controller.signal);
    if (!current()) return;
    if (!result.ok) { failure(main, result, retry); return; }
    const model = nodeModel(result.data);
    if (!model.ok) { failure(main, { status: 0 }, retry); return; }
    const node = model.node;
    const origin = visits.get(key)?.origin || href({ view: state.view, q: state.q });
    const syncLine=el('p',{class:'need-sub conversation-sync',role:'status',text:model.sync});
    const body = el('div', { class: 'conversations-page' },
      nav(state.q && !origin.includes('node=') ? 'Back to results' : 'Back', origin),
      pageHead({ eyebrow: 'Conversations', headline: node.title }),
      syncLine);
    // Original history leads. No generated digest substitutes for the source.
    if (node.kind === 'conversation' && node.source) {
      setKids(main, body);
      const history = await transcript(node, controller, current, main, retry);
      if (!current() || !history) return;
      body.append(history);
    }
    if (node.kind === 'conversation' && !node.openUrl && !node.source) body.append(note('The original conversation is not available here yet.'));
    if (model.children.length || model.nextCursor) {
      const children = [...model.children];
      const seen = new Set(children.map((item) => item.key));
      let cursor = model.nextCursor;
      let childPagesLoaded = 1;
      const desired = Math.min(visits.get(key)?.childPagesLoaded || 1, 100);
      while (cursor && childPagesLoaded < desired) {
        const next = await read(`/conversation-graph/nodes/${encodeURIComponent(state.ref)}?${new URLSearchParams({ cursor })}`, controller.signal);
        if (!current()) return;
        if (next.needsUnlock) { unlock(main, retry); return; }
        const page = next.ok ? nodeModel(next.data) : { ok: false };
        if (!page.ok) { failure(main, next, retry); return; }
        for (const item of page.children) if (!seen.has(item.key)) { seen.add(item.key); children.push(item); }
        if (page.nextCursor === cursor) break;
        cursor = page.nextCursor; childPagesLoaded++;
      }
      const rows = el('div', { class: 'rows' }, children.map((item) => itemRow(item, state)));
      const status = el('p', { class: 'need-sub', role: 'status' });
      const section = el('section', { class: 'list-section' },
        el('h2', { class: 'eyebrow section-label', text: 'Conversations' }), rows, status);
      if (cursor) {
        const cursors = new Set();
        const more = el('button', { type: 'button', class: 'btn-quiet btn-inline', text: 'Show more conversations' });
        more.addEventListener('click', async () => {
          if (!cursor || cursors.has(cursor)) return;
          more.disabled = true; status.textContent = 'Loading…';
          const next = await read(`/conversation-graph/nodes/${encodeURIComponent(state.ref)}?${new URLSearchParams({ cursor })}`, controller.signal);
          if (!current()) return;
          if (next.needsUnlock) { unlock(main, retry); return; }
          if (next.status === 409 && next.data?.code === 'cursor-stale') {
            status.textContent = 'This list changed. Refresh to see it from the start.';
            more.textContent = 'Refresh'; more.disabled = false; cursor = null; more.onclick = retry; return;
          }
          const page = next.ok ? nodeModel(next.data) : { ok: false };
          if (!page.ok) { status.textContent = 'More conversations could not be loaded.'; more.disabled = false; return; }
          cursors.add(cursor);
          for (const item of page.children) if (!seen.has(item.key)) { seen.add(item.key); rows.append(itemRow(item, state)); }
          cursor = page.nextCursor; childPagesLoaded++;
          visits.set(key, { ...(visits.get(key) || {}), childPagesLoaded });
          more.hidden = !cursor; more.disabled = false;
          status.textContent = cursor && cursors.has(cursor) ? 'This list needs a refresh.' : '';
        });
        section.append(more);
      }
      body.append(section);
    }
    const details = el('details', { class: 'conversation-details' }, el('summary', { text: 'More' }));
    const role = new Map([['effort', 'Effort'], ['front-door', 'Front door'], ['worker', 'Worker conversation'], ['unassigned', 'Unassigned conversation']]).get(node.role);
    if (role) details.append(el('p', { class: 'need-sub', text: role }));
    if (node.openUrl) {
      const label = node.platform === 'telegram' ? 'Open in Telegram' : node.platform === 'slack' ? 'Open in Slack' : 'Open conversation';
      details.append(el('a', { class: 'btn-quiet btn-inline', href: node.openUrl, rel: 'noopener noreferrer', text: label }));
    }
    const why = { owner: 'The owner chose this placement.', delegation: 'Placed here by delegation.',
      import: 'This placement was imported.', inference: 'This placement was inferred.' }[node.placedBy];
    if (why) details.append(el('p', { class: 'need-sub', text: why }));
    const corrections = correctionControls({ node, correction: model.correction,
      send: (path, body) => read(path, controller.signal, body), current,
      unlock: () => unlock(main, retry), refresh: () => { remember(); retry(); } });
    if (corrections) details.append(corrections);
    const effortActions = effortActionControls({ canCorrect: Boolean(model.correction), node, correction: model.correction,
      send: (path, body) => read(path, controller.signal, body), current,
      unlock: () => unlock(main, retry), refresh: () => { remember(); retry(); } });
    if (effortActions) details.append(effortActions);
    const erasure = erasureControls({ node, canErase: model.canErase, headerForgotten: model.headerForgotten,
      send: (path, body) => read(path, controller.signal, body), current,
      unlock: () => unlock(main, retry), refresh: () => { remember(); retry(); } });
    if (erasure) details.append(erasure);
    if (node.frontDoor && encodeNodeRef(node.frontDoor) !== node.key) details.append(nav('Go to front door', href({ ...state, ref: encodeNodeRef(node.frontDoor) }), 'btn-quiet btn-inline', true));
    if (node.kind === 'conversation') {
      let checked = false;
      details.addEventListener('toggle', async () => {
        if (!details.open || checked || !current()) return;
        checked = true;
        // The authorized path identifies efforts to ask. Only the server's
        // effort metadata supplies the destination; the path is never a guess.
        for (const ancestor of [...model.path].reverse().filter(p => p.ref.kind === 'effort')) {
          const result = await read(`/conversation-graph/nodes/${encodeURIComponent(encodeNodeRef(ancestor.ref))}`, controller.signal);
          if (!current()) return;
          if (result.needsUnlock) { unlock(main, retry); return; }
          if (!result.ok) return;
          const effort = nodeModel(result.data);
          if (!effort.ok || effort.node.key !== encodeNodeRef(ancestor.ref) || effort.node.kind !== 'effort') return;
          const destination = effort.node.frontDoor;
          if (!destination) continue;
          if (encodeNodeRef(destination) !== node.key) details.append(nav('Go to front door',
            href({ ...state, ref: encodeNodeRef(destination) }), 'btn-quiet btn-inline', true));
          return;
        }
      });
    }
    if (model.path.length) details.append(el('nav', { 'aria-label': 'Conversation path', class: 'conversation-path' },
      model.path.map((p) => nav(p.title, href({ ...state, ref: encodeNodeRef(p.ref) }), 'btn-quiet btn-inline', true))));
    if (model.links.length) details.append(el('h2', { class: 'eyebrow section-label', text: 'Related' }),
      model.links.map((p) => nav(p.title, href({ ...state, ref: encodeNodeRef(p.ref) }), 'btn-quiet btn-inline', true)));
    if (!model.path.length && !model.links.length) details.append(el('p', { class: 'need-sub', text: 'No other connections are recorded.' }));
    body.append(details);
    setKids(main, body);
    await mountPending({body,syncLine,baseSync:model.sync,send:(path,payload)=>read(path,controller.signal,payload),current,unlock:()=>unlock(main,retry),refresh:retry,catalog:[node,...model.path,...model.children]});
    if(!current())return;restoreScroll(key);
    return;
  }
  const result = await read(`${ROOTS}?${pageQuery(state.view, state.q)}`, controller.signal);
  if (!current()) return;
  if(localOnlyEnvelope(result)){
    const localWords=localOnlyWords(result),syncLine=el('p',{class:'need-sub conversation-sync',role:'status',text:localWords});
    const body=el('div',{class:'conversations-page'},pageHead({eyebrow:'Conversations',headline:'Your conversations'}),syncLine,
      note('Create an effort here while shared conversations are unavailable. These changes stay separate from the agreed view.'));
    const controls=effortActionControls({canCorrect:true,send:(path,payload)=>read(path,controller.signal,payload),current,unlock:()=>unlock(main,retry),refresh:retry});if(controls)body.append(controls);
    setKids(main,body);await mountPending({body,syncLine,baseSync:localWords,send:(path,payload)=>read(path,controller.signal,payload),current,unlock:()=>unlock(main,retry),refresh:retry});return;
  }
  if (!result.ok) { failure(main, result, retry); return; }
  const model = listModel(result.data, state.view);
  if (!model.ok) { failure(main, { status: 0 }, retry); return; }
  const tabs = el('nav', { class: 'conversation-tabs', 'aria-label': 'Conversation views' },
    nav('Overview', href(), state.view === 'overview' ? 'chip active' : 'chip'),
    nav('All', href({ view: 'all' }), state.view === 'all' ? 'chip active' : 'chip'));
  const search = el('input', { type: 'search', class: 'reason-input', value: state.q, placeholder: 'Search conversations', 'aria-label': 'Search conversations' });
  const form = el('form', { class: 'conversation-search' }, search, el('button', { type: 'submit', class: 'btn-quiet btn-inline', text: 'Search' }));
  form.addEventListener('submit', (event) => { event.preventDefault(); remember(); location.hash = href({ view: 'all', q: search.value.trim() }); });
  let cursor = model.nextCursor;
  const loaded = [...model.items];
  const seen = new Set(model.items.map((item) => item.key));
  let pagesLoaded = 1;
  const desiredPages = state.view === 'all' ? Math.min(visits.get(key)?.pagesLoaded || 1, 100) : 1;
  // Rebuild the previously opened range from one NEW authorized snapshot. Do
  // not mix cached content or cursors from an older projection into this one.
  while (cursor && pagesLoaded < desiredPages) {
    const next = await read(`${ROOTS}?${pageQuery('all', state.q, cursor)}`, controller.signal);
    if (!current()) return;
    if (next.needsUnlock) { unlock(main, retry); return; }
    const page = next.ok ? listModel(next.data, 'all') : { ok: false };
    if (!page.ok) { failure(main, next, retry); return; }
    for (const item of page.items) if (!seen.has(item.key)) { seen.add(item.key); loaded.push(item); }
    if (page.nextCursor === cursor) break;
    cursor = page.nextCursor;
    pagesLoaded++;
  }
  const rows = el('div', { class: 'rows conversation-rows' }, loaded.map((item) => itemRow(item, state)));
  const status = el('p', { class: 'need-sub', role: 'status' });
  const syncLine=el('p',{class:'need-sub conversation-sync',role:'status',text:model.sync});
  const body = el('div', { class: 'conversations-page' },
    pageHead({ eyebrow: 'Conversations', headline: state.view === 'overview' ? 'Your efforts' : 'All conversations' }),
    tabs, form, syncLine, rows, status);
  const effortActions = effortActionControls({ canCorrect: model.canCorrect,
    send: (path, body) => read(path, controller.signal, body), current,
    unlock: () => unlock(main, retry), refresh: () => { remember(); retry(); } });
  if (effortActions) body.insertBefore(effortActions, rows);
  if (!model.items.length) rows.append(el('p', { class: 'empty-line', text: state.q ? 'No conversations match this search.'
    : state.view === 'overview' ? 'No efforts are organized yet. Your conversations are in All.' : 'No conversations are available.' }));
  if (state.view === 'overview' && (!model.items.length || model.hasMore)) body.append(nav('All conversations', href({ view: 'all' })));
  if (state.view === 'all' && cursor) {
    const cursors = new Set();
    const more = el('button', { class: 'btn-quiet btn-inline', type: 'button', text: 'Show more' });
    more.addEventListener('click', async () => {
      if (!cursor || cursors.has(cursor)) return;
      more.disabled = true; status.textContent = 'Loading…';
      const next = await read(`${ROOTS}?${pageQuery('all', state.q, cursor)}`, controller.signal);
      if (!current()) return;
      if (next.needsUnlock) { unlock(main, retry); return; }
      if (next.status === 409 && next.data?.code === 'cursor-stale') {
        status.textContent = 'This list changed. Refresh to see it from the start.';
        more.textContent = 'Refresh'; more.disabled = false; cursor = null;
        more.onclick = retry; return;
      }
      const page = next.ok ? listModel(next.data, 'all') : { ok: false };
      if (!page.ok) { status.textContent = 'More conversations could not be loaded.'; more.disabled = false; return; }
      cursors.add(cursor);
      for (const item of page.items) if (!seen.has(item.key)) { seen.add(item.key); rows.append(itemRow(item, state)); }
      cursor = page.nextCursor;
      pagesLoaded++;
      visits.set(key, { ...(visits.get(key) || {}), pagesLoaded });
      more.hidden = !cursor;
      more.disabled = false;
      status.textContent = cursor && cursors.has(cursor) ? 'This list needs a refresh.' : '';
    });
    body.append(more);
  }
  setKids(main, body);
  await mountPending({body,syncLine,baseSync:model.sync,send:(path,payload)=>read(path,controller.signal,payload),current,unlock:()=>unlock(main,retry),refresh:retry,catalog:loaded});
  if(!current())return;restoreScroll(key);
}

export function conversationsTile() {
  return el('div', { class: 'tiles' }, el('a', { class: 'tile', href: PAGE },
    el('span', { class: 't-icon', icon: 'chat' }),
    el('span', {}, el('span', { class: 't-name', text: 'Conversations' }),
      el('span', { class: 't-desc', text: 'Your efforts and the conversations behind them.' }))));
}

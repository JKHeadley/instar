// Owner effort actions consume typed refs and certified server heads. Names
// live only in the current authorized sheet; opaque request IDs survive reload.
import { el, note, setKids, sheet, closeSheet, operatorSession } from './ui.js';
import { listModel, nodeModel, encodeNodeRef, writeStatusWords, independentlySaved, cancellationKey } from './conversations-model.js';
import { pendingPages } from './conversation-pending.js';

import { frozenRequests, requestId, ledger, track, forget, dismiss } from './conversation-write-continuity.js';

export function effortActionControls({ canCorrect, node = null, correction = null, send, current, unlock, refresh }) {
  if (canCorrect !== true) return null;
  const controls = el('div', { class: 'conversation-corrections' });
  const authorized = () => current() && Boolean(operatorSession());
  const openAction = mode => {
    if (!authorized()) return;
    let open = true, busy = false, ready = false, effort = node?.ref || null, snapshot = correction;
    let scope = mode === 'create' ? 'effort:create' : `${node.key}:${mode}`, kind = mode === 'create' ? 'create-effort' : mode === 'rename' ? 'set-effort-title' : 'set-front-door';
    let frozen = null, generation = 0;const draftInputs = new Set();
    const wipeDraft = () => { for (const input of draftInputs) input.value = '';if (typeof frozen?.body?.change?.title === 'string') frozen.body.change.title = ''; };
    const status = el('p', { class: 'need-sub', role: 'status', 'aria-live': 'polite' });
    const content = el('div', { style: 'min-width:0;max-width:100%' }), actions = el('div');
    const close = () => { open = false; generation++; clearInterval(lockCheck); window.removeEventListener('instar-owner-locked', onLock); wipeDraft();draftInputs.clear();content.replaceChildren(); actions.replaceChildren(); status.textContent = '';frozen = null; effort = null; snapshot = null; };
    const panel = sheet({ title: mode === 'create' ? 'Create effort' : mode === 'rename' ? 'Rename effort' : 'Choose front door', onClose: close }, content, status, actions);
    panel.classList.add('conversation-correction-sheet');
    const active = () => open && authorized();
    const onLock = () => { if (open) { closeSheet(); unlock(); } };
    window.addEventListener('instar-owner-locked', onLock);
    const lockCheck = setInterval(() => { if (open && !authorized()) closeSheet(); }, 250);
    panel.addEventListener('keydown', event => {
      if (event.key !== 'Tab') return;
      const focusable = [...panel.querySelectorAll('*')].filter(n => n.matches('button,input,a[href]') && !n.disabled && !n.closest('[hidden]'));
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    });
    const call = async (path, body) => {
      try { const result = await send(path, body);if (result.needsUnlock && open) onLock();return result; } catch { return { ok: false, status: 0, data: {} }; }
    };
    const remember = () => {
      // Full bodies stay local to this sheet. The shared map and browser ledger
      // receive only opaque identity and monotonic witness knowledge.
      track(scope, { path: null, body: { requestId: frozen.body.requestId }, witnessed: frozen.witnessed === true,recorded:frozen.recorded===true });
    };
    const done = () => { closeSheet(); refresh(); };
    const showDone = label => setKids(actions, el('button', { type: 'button', class: 'btn-primary btn-inline', text: label || 'Done', onclick: done }));
    const showName = () => {
      if (!active() || snapshot?.headerForgotten || !Number.isSafeInteger(snapshot?.headerVersion)) { status.textContent = 'The name is unavailable. Refresh this effort.'; showDone('Refresh'); return; }
      const name = el('input', { type: 'text', class: 'reason-input', maxlength: '200', autocomplete: 'off', 'aria-label': 'Effort name', style: 'box-sizing:border-box;width:100%;min-width:0;max-width:100%' });
      draftInputs.add(name);
      const save = el('button', { type: 'submit', class: 'btn-primary btn-inline', text: 'Save name' });
      const form = el('form', {}, el('label', { text: 'Effort name' }), name, save);
      form.addEventListener('submit', async event => {
        event.preventDefault(); if (!active() || !ready || frozen || busy || !name.value.trim()) return;
        let title = name.value.normalize('NFC').trim();
        if (title.length > 200) { status.textContent = 'Use a name of 200 characters or fewer.'; return; }
        if (!freeze({ kind: 'set-effort-title', effort, baseVersion: snapshot.headerVersion, title })) return;title = '';
        name.disabled = true; save.disabled = true; await submit();
      });
      setKids(content, form); setKids(actions); status.textContent = mode === 'create' ? 'Effort created. Its name is saved separately.' : 'Choose a new name.';
      name.focus();
    };
    const committed = async data => {
      wipeDraft();forget(scope,frozen?.body.requestId); frozen = null; ready = false;
      if (kind === 'create-effort') {
        if (data.effort?.kind !== 'effort' || !encodeNodeRef(data.effort)) { status.textContent = 'The effort was created. Refresh to open it.'; showDone('Refresh'); return; }
        effort = data.effort; scope = `${encodeNodeRef(effort)}:rename`; kind = 'set-effort-title';
        // New header heads are read after committed creation. Never assume
        // version zero or infer title durability from the anchor certificate.
        const fresh = await call(`/conversation-graph/nodes/${encodeURIComponent(encodeNodeRef(effort))}`);
        if (!active()) return; if (fresh.needsUnlock) { onLock(); return; }
        const model = fresh.ok ? nodeModel(fresh.data) : null;
        if (!model?.ok || model.node.key !== encodeNodeRef(effort)) { status.textContent = 'Effort created. Open it again to add its name.'; showDone('Done'); return; }
        snapshot = model.correction;
        await restore(showName); return;
      }
      setKids(content); status.textContent = kind === 'set-effort-title' ? 'Name saved.' : 'Front door updated.'; showDone();
    };
    const handle = async (result,directPost=false) => {
      if (!active()) return;
      if (result.needsUnlock) { onLock(); return; }
      let data = result.data?.wireVersion===2&&result.data.requestId!==frozen?.body.requestId?{}:result.data||{};
      if(['committed','canceled','canceled-local','refused-local','erased'].includes(data.state)&&data.requestId!==frozen?.body.requestId&&!(directPost&&data.requestId===undefined))data={};
      if(data.state==='recorded-local'){frozen.recorded=true;try{remember();}catch{frozenRequests.set(scope,{path:null,body:{requestId:frozen.body.requestId},recorded:true,witnessed:frozen.witnessed===true});}}
      if (independentlySaved(data)) { frozen.witnessed = true; try { remember(); } catch { frozenRequests.set(scope,{path:null,body:{requestId:frozen.body.requestId},recorded:frozen.recorded===true,witnessed:true}); } }
      const absenceCertified=directPost&&result.status>=400&&data.requestState==='not-recorded'&&(data.requestId===frozen?.body.requestId||(directPost&&data.requestId===undefined));
      setKids(actions);
      if (data.state === 'committed') { await committed(data); return; }
      if (['canceled','canceled-local','refused-local','erased'].includes(data.state)) { wipeDraft();forget(scope,frozen?.body.requestId); frozen = null; setKids(content); status.textContent = data.state === 'erased' ? 'Content removed. The change’s record remains.' : data.state==='refused-local'?'Change refused. Refresh before choosing again.':'Canceled. The agreed effort stays as it was.'; showDone(); return; }
      if (absenceCertified && !frozen.witnessed && !frozen.recorded) { forget(scope,frozen?.body.requestId); frozen = null; status.textContent = 'This change was not accepted. Refresh before choosing again.'; showDone('Refresh'); return; }
      status.textContent = writeStatusWords(data,frozen);
      actions.append(el('button', { type: 'button', class: 'btn-quiet btn-inline', text: 'Check status', onclick: () => check() }));
      if(kind==='create-effort'&&(frozen.recorded||frozen.witnessed))actions.append(el('button',{type:'button',class:'btn-quiet btn-inline',text:'Create another effort',onclick:()=>{
       try{dismiss(scope,frozen.body.requestId);}catch{status.textContent='Request tracking is unavailable. The earlier identity was retained.';return;}done();
      }}));
      const operationKey=cancellationKey(data);
      if (data.cancelEligible===true && operationKey) actions.append(el('button', { type: 'button', class: 'btn-quiet btn-inline', text: 'Cancel change', onclick: async () => { if (busy || !active()) return; busy = true; try { await handle(await call(`/conversation-graph/changes/${encodeURIComponent(operationKey)}/cancel`, {})); } finally { busy = false; } } }));
      if ((result.status === 404 || result.status === 0) && frozen.path && !frozen.witnessed && !frozen.recorded) actions.append(el('button', { type: 'button', class: 'btn-quiet btn-inline', text: 'Retry same request', onclick: submit }));
      if(!frozen.witnessed&&!frozen.recorded&&(result.status===404||result.status===0))actions.append(el('button',{type:'button',class:'btn-quiet btn-inline',text:'Dismiss notice and refresh',onclick:()=>{
       try{dismiss(scope,frozen.body.requestId);}catch{status.textContent='Request tracking is unavailable. The earlier identity was retained.';return;}done();
      }}));
    };
    const check = async () => {
      if (!active() || busy || !frozen) return; busy = true; setKids(actions); status.textContent = frozen.witnessed ? 'Saved. Checking sync…' : 'Checking save…';
      try { await handle(await call(`/conversation-graph/changes/${encodeURIComponent(frozen.body.requestId)}`)); } finally { busy = false; }
    };
    const submit = async () => {
      if (!active() || busy || !frozen?.path) return; busy = true; setKids(actions); status.textContent = 'Checking save…';
      try { await handle(await call(frozen.path, frozen.body),true); } finally { busy = false; }
    };
    const freeze = change => {
      if (!active() || !ready || frozen || busy) return false;
      frozen = { path: '/conversation-graph/changes', body: { requestId: requestId(), change }, witnessed: false };
      try { remember(); ready = false; return true; } catch { frozen = null; status.textContent = 'Request tracking is unavailable. No change was sent.'; return false; }
    };
    const restore = async onReady => {
      ready = false;
      try {
        const tracked = ledger().find(entry => entry.subject === scope && !entry.dismissed), known = frozenRequests.get(scope);
        frozen = tracked ? { path: null, body: { requestId: tracked.requestId }, witnessed: tracked.witnessed === true || (known?.body?.requestId===tracked.requestId&&known.witnessed===true),recorded:tracked.recorded===true||(known?.body?.requestId===tracked.requestId&&known.recorded===true) } : null;
        if (frozen) { await handle(await call(`/conversation-graph/changes/${encodeURIComponent(frozen.body.requestId)}`)); return; }
        const pending = await pendingPages(call,active); if (!active()) return;
        if (pending.needsUnlock) { onLock(); return; }
        if (!pending.ok) throw new Error('pending-unavailable');
        const ignoredCreates=new Set(ledger().filter(entry=>entry.subject===scope&&entry.dismissed).map(entry=>entry.requestId));
        const prior = pending.items.find(item => mode === 'create' && kind === 'create-effort' ? !ignoredCreates.has(item.requestId)&&(item.localIntent?.change.kind === kind || item.raw.kind===kind) : encodeNodeRef(item.subject) === encodeNodeRef(effort));
        if (prior) {
          if ((prior.localIntent?.change.kind||prior.raw.kind) !== kind || typeof prior.requestId !== 'string') { status.textContent = 'An earlier change is still pending for this effort. Resolve it before making another.'; return; }
          frozen = { path: null, body: { requestId: prior.requestId }, witnessed: independentlySaved(prior.raw),recorded:prior.state==='recorded-local' }; remember(); await handle(await call(`/conversation-graph/changes/${encodeURIComponent(frozen.body.requestId)}`)); return;
        }
        const earlierUnknown=ledger().some(entry=>entry.subject===scope&&entry.dismissed);
        if(earlierUnknown&&effort){
          const fresh=await call(`/conversation-graph/nodes/${encodeURIComponent(encodeNodeRef(effort))}`);if(!active())return;const model=fresh.ok?nodeModel(fresh.data):null;
          if(!model?.ok||!model.correction||model.node.key!==encodeNodeRef(effort))throw new Error('fresh-node-unavailable');snapshot=model.correction;
        }
        ready = true; onReady();
        if(earlierUnknown)content.prepend(note('An earlier request is unresolved. This is a new edit and may still need conflict resolution.'));
      } catch { if (active()) status.textContent = 'Pending changes could not be checked. No new change was sent.'; }
    };
    const showFrontDoor = () => {
      if (!Array.isArray(snapshot?.replacesFrontDoorEventIds)) { status.textContent = 'The front door could not be checked. Refresh this effort.'; showDone('Refresh'); return; }
      const search = el('input', { type: 'search', class: 'reason-input', 'aria-label': 'Find a front door', placeholder: 'Find a conversation', style: 'box-sizing:border-box;width:100%;min-width:0;max-width:100%' });
      draftInputs.add(search);
      const choices = el('div'), preview = el('div'), more = el('button', { type: 'button', class: 'btn-quiet btn-inline', text: 'Show more conversations', hidden: true });
      let cursor = null; const cursors = new Set();
      const choose = async item => {
        if (!ready || frozen || !active()) return; const run = ++generation; let observed = [];
        if (item) {
          status.textContent = 'Checking this conversation…';const result = await call(`/conversation-graph/nodes/${encodeURIComponent(item.key)}`);if (!active() || run !== generation) return;if (result.needsUnlock) { onLock(); return; }
          const model = result.ok ? nodeModel(result.data) : null;
          if (!model?.ok || model.node.key !== item.key || !model.correction) { status.textContent = 'This conversation is unavailable. Refresh before choosing again.'; return; }
          observed = model.correction.replacesPlacementEventIds;
        }
        status.textContent = '';setKids(preview, note(item ? `Use ${item.title} as this effort’s front door?` : 'Clear this effort’s front door?'),el('button', { type: 'button', class: 'btn-primary btn-inline', text: item ? 'Confirm front door' : 'Clear front door', onclick: async () => {
          if (run !== generation || !freeze({ kind: 'set-front-door', effort, conversation: item?.ref || null, replacesFrontDoorEventIds: snapshot.replacesFrontDoorEventIds, observedPlacementEventIds: observed })) return;
          search.disabled = true;more.disabled = true;for (const button of choices.querySelectorAll('button')) button.disabled = true;setKids(preview);await submit();
        } }));
      };
      const load = async append => {
        if (!ready || frozen || !active()) return;const run = ++generation;setKids(preview);const query = new URLSearchParams({ view: 'all', q: search.value });if (append && cursor) query.set('cursor', cursor);
        status.textContent = 'Loading conversations…';const result = await call(`/conversation-graph/roots?${query}`);if (!active() || run !== generation) return;if (result.needsUnlock) { onLock(); return; }
        if (result.status === 409 && result.data?.code === 'cursor-stale') { status.textContent = 'This list changed. Search again to start from the beginning.';cursor = null;more.hidden = true;return; }
        const model = result.ok ? listModel(result.data, 'all') : null;if (!model?.ok) { status.textContent = 'Conversations could not be loaded.';return; }
        if (!append) { setKids(choices, el('button', { type: 'button', class: 'btn-quiet btn-inline', text: 'No front door', onclick: () => choose(null) }));cursors.clear(); }
        for (const item of model.items) if (item.kind === 'conversation') choices.append(el('button', { type: 'button', class: 'conversation-row', text: item.title, style: 'white-space:normal;overflow-wrap:anywhere;max-width:100%;min-width:0', onclick: () => choose(item) }));
        if (append) cursors.add(cursor);cursor = model.nextCursor;more.hidden = !cursor || cursors.has(cursor);status.textContent = model.sync || '';
      };
      search.addEventListener('change', () => load(false));more.addEventListener('click', () => load(true));setKids(content, note('Choose a conversation already in this effort.'), search, choices, more, preview);search.focus();load(false);
    };
    const begin = async () => {
      status.textContent = 'Checking earlier changes…';
      if (mode !== 'create') {
        const result = await call(`/conversation-graph/nodes/${encodeURIComponent(node.key)}`);if (!active()) return;if (result.needsUnlock) { onLock(); return; }
        const model = result.ok ? nodeModel(result.data) : null;
        if (!model?.ok || model.node.key !== node.key) { status.textContent = 'This effort is unavailable. Refresh before changing it.';return; }effort = model.node.ref;snapshot = model.correction;
      }
      await restore(mode === 'create' ? () => { setKids(content, note('Create an empty effort, then save its name separately.'));setKids(actions, el('button', { type: 'button', class: 'btn-primary btn-inline', text: 'Create effort', onclick: async () => { if (freeze({ kind: 'create-effort', projectScope: [] })) await submit(); } }));status.textContent = ''; } : mode === 'rename' ? showName : showFrontDoor);
    };
    begin();
  };
  if (!node) controls.append(el('button', { type: 'button', class: 'btn-quiet btn-inline', text: 'Create effort', onclick: () => openAction('create') }));
  else if (node.kind === 'effort' && correction) {
    if (!correction.headerForgotten && Number.isSafeInteger(correction.headerVersion)) controls.append(el('button', { type: 'button', class: 'btn-quiet btn-inline', text: 'Rename effort', onclick: () => openAction('rename') }));
    if (Array.isArray(correction.replacesFrontDoorEventIds)) controls.append(el('button', { type: 'button', class: 'btn-quiet btn-inline', text: 'Choose front door', onclick: () => openAction('front-door') }));
  }
  return controls.childElementCount ? controls : null;
}

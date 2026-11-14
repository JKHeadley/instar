// Increment C consumes server eligibility and frozen request identities. It
// never moves the displayed canonical tree optimistically.
import { el, note, setKids, sheet, closeSheet, operatorSession } from './ui.js';
import { listModel, nodeModel, encodeNodeRef, writeStatusWords, independentlySaved, cancellationKey } from './conversations-model.js';

import { pendingPages } from './conversation-pending.js';

import { frozenRequests, requestId, ledger, track, forget, dismiss } from './conversation-write-continuity.js';

export function correctionControls({ node, correction, send, current, unlock, refresh }) {
  if (!correction) return null;
  const controls = el('div', { class: 'conversation-corrections' });
  const startMove = () => {
    let open = true, cursor = null, selected = null, restoredForNewWrite = false, frozen = frozenRequests.get(node.key) || null;
    let observedCorrection=correction;
    const active = () => open && current() && Boolean(operatorSession());
    const status = el('p', { class: 'need-sub', role: 'status', 'aria-live': 'polite' });
    const choices = el('div', { class: 'conversation-list' });
    const search = el('input', { type: 'search', class: 'reason-input', placeholder: 'Find a destination', 'aria-label': 'Find a destination' });
    search.disabled = true;
    const preview = el('div');
    const actions = el('div');
    const more = el('button', { type: 'button', class: 'btn-quiet btn-inline', text: 'Show more destinations', hidden: true });
    let lockCheck;
    const onLock=()=>{if(open){closeSheet();unlock();}};
    const panel = sheet({ title: `Move ${node.title}`, onClose: () => { open = false;clearInterval(lockCheck);window.removeEventListener('instar-owner-locked',onLock);search.value='';choices.replaceChildren();preview.replaceChildren();actions.replaceChildren();status.textContent=''; } },
      note(node.visibleChildCount ? 'Its workers stay with it.' : 'Choose where this belongs.'), search, choices, more, preview, status, actions);
    panel.classList.add('conversation-correction-sheet');
    window.addEventListener('instar-owner-locked',onLock);lockCheck=setInterval(()=>{if(open&&!active())onLock();},250);
    const done = () => { closeSheet(); refresh(); };
    const handle = async (result,directPost=false) => {
      if (!active()) return;
      if (result.needsUnlock) { closeSheet(); unlock(); return; }
      let data = result.data?.wireVersion===2&&result.data.requestId!==frozen?.body.requestId?{}:result.data||{};
      if(['committed','canceled','canceled-local','refused-local','erased'].includes(data.state)&&data.requestId!==frozen?.body.requestId&&!(directPost&&data.requestId===undefined))data={};
      if(data.state==='recorded-local'){frozen.recorded=true;try{track(node.key,frozen);}catch{frozenRequests.set(node.key,frozen);}}
      if (independentlySaved(data)) {
        frozen.witnessed = true;
        try { track(node.key, frozen); } catch { frozenRequests.set(node.key, frozen); }
      }
      const absenceCertified=directPost&&result.status>=400&&data.requestState==='not-recorded'&&(data.requestId===frozen?.body.requestId||(directPost&&data.requestId===undefined));
      setKids(actions);
      if (data.state === 'committed') {
        forget(node.key,frozen?.body.requestId);
        status.textContent = 'Placement updated.';
        if (typeof data.undoToken === 'string') actions.append(el('button', { type: 'button', class: 'btn-quiet btn-inline', text: 'Undo', onclick: async () => {
          frozen = { path: '/conversation-graph/undo', body: { requestId: requestId(), undoToken: data.undoToken } };
          try { track(node.key, frozen); } catch { status.textContent = 'Request tracking is unavailable. Undo was not sent.'; return; }
          await submit();
        } }));
        actions.append(el('button', { type: 'button', class: 'btn-primary btn-inline', text: 'Done', onclick: done }));
        return;
      }
      if (['canceled','canceled-local','refused-local','erased'].includes(data.state)) {
        forget(node.key,frozen?.body.requestId);
        status.textContent = data.state === 'erased' ? 'Content removed. The change’s record remains.' : data.state==='refused-local'?'Change refused. Refresh before choosing again.':'Canceled. The agreed placement stays as it was.';
        actions.append(el('button', { type: 'button', class: 'btn-quiet btn-inline', text: 'Done', onclick: done }));
        return;
      }
      if (result.status === 409 || absenceCertified) {
        if (absenceCertified && !frozen.witnessed && !frozen.recorded) forget(node.key,frozen?.body.requestId);
        status.textContent = result.status === 409 ? 'The placement changed elsewhere. Refresh before choosing again.'
          : 'This change was not accepted. Refresh before choosing again.';
        actions.append(el('button', { type: 'button', class: 'btn-primary btn-inline', text: 'Refresh', onclick: done }));
        return;
      }
      status.textContent = data.state==='erase-pending'?'Content is hidden here. Erasure on the other machines is still being checked.':writeStatusWords(data,frozen);
      actions.append(el('button', { type: 'button', class: 'btn-quiet btn-inline', text: 'Check status', onclick: async () => {
        const result = await send(`/conversation-graph/changes/${encodeURIComponent(frozen.body.requestId)}`);
        await handle(result);
      } }));
      const operationKey=cancellationKey(data);
      if (data.cancelEligible===true && operationKey) actions.append(el('button', { type: 'button', class: 'btn-quiet btn-inline', text: 'Cancel change', onclick: async () => {
        await handle(await send(`/conversation-graph/changes/${encodeURIComponent(operationKey)}/cancel`, {}));
      } }));
      if ((result.status === 404 || result.status === 0) && frozen.path && !frozen.witnessed && !frozen.recorded) actions.append(el('button', { type: 'button', class: 'btn-quiet btn-inline', text: 'Retry same request', onclick: submit }));
      if(!frozen.witnessed&&!frozen.recorded&&(result.status===404||result.status===0))actions.append(el('button',{type:'button',class:'btn-quiet btn-inline',text:'Dismiss notice and refresh',onclick:()=>{
        try{dismiss(node.key,frozen.body.requestId);}catch{status.textContent='Request tracking is unavailable. The earlier identity was retained.';return;}
        done();
      }}));
    };
    const submit = async () => {
      if (!active() || !frozen?.path) return;
      setKids(actions); status.textContent = 'Checking save…';
      await handle(await send(frozen.path, frozen.body),true);
    };
    const choose = async item => {
      if (!restoredForNewWrite || frozen || !active()) return;
      selected = item; setKids(preview); status.textContent = 'Checking this placement…';
      const change = { kind: 'set-primary-placement', subject: node.ref, parent: item?.ref || null,
        replacesPlacementEventIds: observedCorrection.replacesPlacementEventIds };
      const result = await send('/conversation-graph/preview', change);
      if (!active() || selected !== item) return;
      if (result.needsUnlock) { closeSheet(); unlock(); return; }
      if (!result.ok || result.data?.eligible !== true) { status.textContent = 'This placement is unavailable. Refresh the conversation before trying again.'; return; }
      status.textContent = '';
      setKids(preview, el('p', { class: 'need-sub', text: `Move from ${node.primaryPath.map(part => part.title).join(' / ') || 'Unassigned'} to ${item?.title || 'Unassigned'}.` }),
        el('button', { type: 'button', class: 'btn-primary btn-inline', text: 'Confirm move', onclick: async () => {
          if (!restoredForNewWrite || frozen) return;
          frozen = { path: '/conversation-graph/changes', body: { requestId: requestId(), change } };
          try { track(node.key, frozen); } catch { frozen = null; status.textContent = 'Request tracking is unavailable. No change was sent.'; return; }
          search.disabled = true; more.disabled = true; for (const button of choices.querySelectorAll('button')) button.disabled = true;
          setKids(preview); await submit();
        } }));
    };
    let generation = 0;
    const load = async append => {
      if (!restoredForNewWrite || frozen || !active()) return;
      const run = ++generation, q = new URLSearchParams({ q: search.value });
      if (append && cursor) q.set('cursor', cursor);
      if (!append) setKids(choices, el('button', { type: 'button', class: 'btn-quiet btn-inline', text: 'Unassigned', onclick: () => choose(null) }));
      const result = await send(`/conversation-graph/nodes/${encodeURIComponent(node.key)}/destinations?${q}`);
      if (!active() || run !== generation) return;
      if (result.needsUnlock) { closeSheet(); unlock(); return; }
      const model = result.ok ? listModel(result.data, 'all') : null;
      if (!model?.ok) { status.textContent = 'Destinations could not be loaded. Close and try again.'; return; }
      for (const item of model.items) choices.append(el('button', { type: 'button', class: 'conversation-row', text: item.title, onclick: () => choose(item) }));
      cursor = model.nextCursor; more.hidden = !cursor;
    };
    search.addEventListener('change', () => { if (!frozen) load(false); });
    more.addEventListener('click', () => { if (!frozen) load(true); });
    const restore = async () => {
      try {
        const tracked = ledger().find(entry => entry.subject === node.key && !entry.dismissed);
        if (tracked && !frozen) frozen = { path: null, body: { requestId: tracked.requestId }, witnessed: tracked.witnessed === true,recorded:tracked.recorded===true };
        if (!frozen) {
          const pending = await pendingPages(send,active);
          if (!active()) return;
          if (pending.needsUnlock) { closeSheet(); unlock(); return; }
          if (!pending.ok) throw new Error('pending-unavailable');
          const prior = pending.items.find(item => encodeNodeRef(item.subject) === node.key);
          if (prior) {
            if (typeof prior.requestId !== 'string') { status.textContent = 'An earlier change is still pending for this conversation. Resolve it before making another.'; return; }
            frozen = { path: null, body: { requestId: prior.requestId }, witnessed: independentlySaved(prior.raw),recorded:prior.state==='recorded-local' }; track(node.key, frozen);
          }
        }
        if (frozen) {
          search.disabled = true; more.hidden = true;
          await handle(await send(`/conversation-graph/changes/${encodeURIComponent(frozen.body.requestId)}`));
        } else {
          const earlier=ledger().some(entry=>entry.subject===node.key&&entry.dismissed);
          if(earlier){const fresh=await send(`/conversation-graph/nodes/${encodeURIComponent(node.key)}`);if(!active())return;if(fresh.needsUnlock){closeSheet();unlock();return;}const model=fresh.ok?nodeModel(fresh.data):null;if(!model?.ok||model.node.key!==node.key||!model.correction?.moveEligible)throw new Error('fresh-node-unavailable');observedCorrection=model.correction;panel.insertBefore(note('An earlier request is unresolved. This is a new edit; it may still need conflict resolution.'),search);}
          restoredForNewWrite = true; search.disabled = false; await load(false);
        }
      } catch { if (active()) status.textContent = 'Pending changes could not be checked. No new change was sent.'; }
    };
    restore();
    panel.querySelector('input')?.focus();
  };
  if (correction.moveEligible) controls.append(el('button', { type: 'button', class: 'btn-quiet btn-inline', text: 'Move', onclick: startMove }));
  else if (correction.reason === 'front-door-held') controls.append(note('Choose another front door before moving this conversation.'));
  return controls;
}

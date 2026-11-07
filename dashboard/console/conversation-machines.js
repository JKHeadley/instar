// Removing a machine that is gone for good. The server decides everything; this only
// shows its answer and sends the owner's explicit choice.
import { el, note, setKids, sheet, closeSheet } from './ui.js';

const STATUS = '/conversation-graph/member-loss/status';
const words = {
  held: 'Removing a machine did not finish. New changes wait until it does.',
  running: 'Removing the machine…',
  done: 'Machine removed.',
  failed: 'Removal stopped before it finished. New changes wait until it does.',
};

// randomUUID exists only on secure pages, and the dashboard can also be opened over plain http on a LAN.
const newId = () => [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, '0')).join('');

export async function machineControls({ send, current, unlock, refresh }) {
  let result;
  try { result = await send(STATUS); } catch { return null; }
  if (!current()) return null;
  if (result?.needsUnlock) { unlock(); return null; }
  const data = result?.ok ? result.data : null;
  if (!data || !Array.isArray(data.members)) return null;

  const start = (machine, requestId, cancellable = false) => {
    let open = true;
    const status = el('p', { class: 'need-sub', role: 'status', 'aria-live': 'polite' });
    const actions = el('div');
    const close = () => { open = false; clearInterval(timer); };
    const panel = sheet({ title: `Remove ${machine.name}?`, onClose: close },
      note(`Only do this if ${machine.name} is gone for good. Changes that exist only on that machine may be lost. Changes still waiting will be refused. This cannot be undone.`),
      status, actions);
    panel.classList.add('conversation-correction-sheet');
    let timer = 0;
    const finish = () => { closeSheet(); refresh(); };
    const button = (text, onclick) => el('button', { type: 'button', class: 'btn-quiet btn-inline', text, onclick });
    const poll = async () => {
      if (!open || !current()) return;
      let reply;
      try { reply = await send(STATUS); } catch { return; }
      if (!open) return;
      if (reply?.needsUnlock) { closeSheet(); unlock(); return; }
      if (!reply?.ok) return;
      if (reply.data?.state === 'done' && reply.data.removed?.includes(machine.machineId)) { clearInterval(timer); status.textContent = words.done; setKids(actions, button('Done', finish)); }
else if (reply.data?.failure === 'member-loss-restart-needed') { clearInterval(timer); status.textContent = 'The machine was removed. Restart the agent to finish.'; setKids(actions, button('Done', finish)); }
            else if (reply.data?.state === 'failed' || reply.data?.state === 'interrupted') { clearInterval(timer); status.textContent = words.failed; setKids(actions, button('Try again', remove), ...(reply.data.cancellable ? [button(`Keep ${machine.name}`, keep)] : []), button('Close', finish)); }
      else if (reply.data?.state === 'none' || reply.data?.state === 'done') { clearInterval(timer); status.textContent = 'This machine was not removed.'; setKids(actions, button('Close', finish)); }
    };
    const remove = async () => {
      if (!open) return;
      setKids(actions); status.textContent = 'Checking…';
      const failed = () => { status.textContent = 'This machine could not be removed right now. Nothing was changed by this attempt.'; setKids(actions, button('Try again', remove), button('Close', finish)); };
      try {
        const prepared = await send('/conversation-graph/member-loss/prepare', { requestId, removedMachineIds: [machine.machineId] });
        if (!open) return;
        if (prepared.needsUnlock) { closeSheet(); unlock(); return; }
        if (!prepared.ok && prepared.data?.code === 'member-loss-running') { status.textContent = words.running; clearInterval(timer); timer = setInterval(poll, 2000); return poll(); }
        if (!prepared.ok) return failed();
        const confirmed = await send('/conversation-graph/member-loss/confirm', { requestId, draftHash: prepared.data.draftHash, challenge: prepared.data.challenge,
          confirmedMachineIds: [machine.machineId], lossAcknowledgement: 'removed-local-unshared-edits-may-be-lost', pendingDisposition: 'refuse-all-uncommitted' });
        if (!open) return;
        if (confirmed.needsUnlock) { closeSheet(); unlock(); return; }
        // No answer does not mean nothing happened, so ask rather than say so.
        if (!confirmed.ok && confirmed.status !== 0 && confirmed.data?.code !== 'member-loss-running') return failed();
        status.textContent = confirmed.ok || confirmed.data?.code === 'member-loss-running' ? words.running : 'No answer yet. Checking…';
        clearInterval(timer); timer = setInterval(poll, 2000); poll();
      } catch { if (open) failed(); }
    };
    const keep = async () => {
      setKids(actions); status.textContent = 'Checking…';
      let reply;
      try { reply = await send('/conversation-graph/member-loss/cancel', {}); } catch { reply = null; }
      if (!open) return;
      if (reply?.needsUnlock) { closeSheet(); unlock(); return; }
      status.textContent = reply?.ok ? `${machine.name} was kept.` : reply?.data?.code === 'member-loss-must-finish' ? 'This can no longer be cancelled. It has to be finished.' : 'That could not be cancelled just now.';
      setKids(actions, ...(reply?.ok ? [] : [button('Try again', remove)]), button('Close', finish));
    };
    setKids(actions, button(`Remove ${machine.name}`, remove), ...(cancellable ? [button(`Keep ${machine.name}`, keep)] : [button('Cancel', closeSheet)]));
  };

  if (data.held && data.resume && data.state !== 'running') {
    const id = data.resume.removedMachineIds[0];
    const machine = data.members.find(row => row.machineId === id) || { machineId: id, name: 'the machine' };
    return el('div', { class: 'conversation-machines' }, el('p', { class: 'need-sub', role: 'status', text: words.held }),
      el('button', { type: 'button', class: 'btn-quiet btn-inline', text: 'Finish removing', onclick: () => start(machine, data.resume.requestId, data.cancellable === true) }));
  }
  if (data.state === 'running') return el('div', { class: 'conversation-machines' }, el('p', { class: 'need-sub', role: 'status', text: words.running }));
  if (data.members.length < 2) return null;
  const details = el('details', { class: 'conversation-details conversation-machines' }, el('summary', { text: 'Machines' }));
  const removable = data.members.length === 2;
  for (const machine of data.members) {
    details.append(el('div', { class: 'row' }, el('span', { text: machine.self ? `${machine.name} (this machine)` : machine.name }),
      !machine.self && removable ? el('button', { type: 'button', class: 'btn-quiet btn-inline', text: 'Remove', onclick: () => start(machine, `remove-${machine.machineId}-${newId()}`) }) : null));
  }
  if (!removable) details.append(note('A machine can be removed only when two remain.'));
  return details;
}

// Opaque write continuity only. Never persist text, grants, or owner proof.
export const frozenRequests = new Map(); // Opaque intents only; no title or transcript.
export function requestId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // getRandomValues also works on an agent's ordinary LAN HTTP origin.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
const ledgerKey = () => `instar-conversation-write-ids:${location.origin}${location.pathname}`;
export function ledger() {
  const value = JSON.parse(sessionStorage.getItem(ledgerKey()) || '[]');
  if (!Array.isArray(value) || value.length > 32 || value.some(entry => !entry || typeof entry.subject !== 'string'
    || entry.subject.length > 2048 || Object.keys(entry).some(key => !['subject', 'requestId', 'witnessed','recorded','dismissed'].includes(key))
    || (entry.witnessed !== undefined && typeof entry.witnessed !== 'boolean')
    || (entry.recorded !== undefined && typeof entry.recorded !== 'boolean') || (entry.dismissed !== undefined && typeof entry.dismissed !== 'boolean')
    || typeof entry.requestId !== 'string' || !/^[A-Za-z0-9_.:-]{8,160}$/.test(entry.requestId))) throw new Error('write-tracking-unavailable');
  return value;
}
export function track(subject, frozen) {
  const previous = ledger();
  const prior = previous.find(entry => entry.subject === subject && entry.requestId === frozen.body.requestId);
  const remembered = frozenRequests.get(subject);
  frozen.witnessed = frozen.witnessed === true || prior?.witnessed === true || (remembered?.body.requestId === frozen.body.requestId && remembered.witnessed === true);
  frozen.recorded = frozen.recorded === true || prior?.recorded === true || (remembered?.body.requestId === frozen.body.requestId && remembered.recorded === true);
  const entries = previous.filter(entry => entry.subject !== subject || entry.requestId !== frozen.body.requestId);
  if (entries.length >= 32) throw new Error('write-tracking-full');
  sessionStorage.setItem(ledgerKey(), JSON.stringify([...entries, { subject, requestId: frozen.body.requestId,
    ...(frozen.witnessed ? { witnessed: true } : {}), ...(frozen.recorded ? {recorded:true} : {}) }]));
  frozenRequests.set(subject, frozen);
}
export function forget(subject, id) {
  try {
    sessionStorage.setItem(ledgerKey(), JSON.stringify(ledger().filter(entry => entry.subject !== subject || (id && entry.requestId !== id))));
    if(!id||frozenRequests.get(subject)?.body.requestId===id)frozenRequests.delete(subject);
  } catch { /* Retain the ID and recheck its terminal status on the next open. */ }
}


export function dismiss(subject,id){
 const entries=ledger().map(entry=>entry.subject===subject&&entry.requestId===id?{...entry,dismissed:true}:entry);
 sessionStorage.setItem(ledgerKey(),JSON.stringify(entries));
 if(frozenRequests.get(subject)?.body.requestId===id)frozenRequests.delete(subject);
}

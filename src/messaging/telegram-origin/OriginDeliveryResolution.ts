import type { OriginStore } from './OriginStore.js';
import type { OriginAuditRecord } from './StoreTypes.js';
import type { OriginMeshCommand } from './OriginMesh.js';
import type { TelegramOriginRecord } from './types.js';
import { wireDigest } from './CanonicalOrigin.js';

/** Positive confirmation requires every child and its platform receipt. */
export function originAuditDeliveryConfirmed(audit: OriginAuditRecord | null): boolean {
  return !!audit && audit.operation?.state === 'accepted' && audit.children.length > 0 &&
    audit.children.every(child => child.state === 'accepted' && audit.attempts.some(attempt =>
      attempt.childId === child.childId && attempt.outcome === 'accepted' && !!attempt.receiptJson));
}

export interface OriginReceiptPeer {
  selfMachineId: string;
  agentId: string;
  send: (machineId: string, command: OriginMeshCommand, timeoutMs: number) => Promise<{ ok: boolean; result?: unknown }>;
}

/** A lost response is resolved only at the original sealed execution owner.
 * This read never submits, redirects, or creates an operation. */
export async function originDeliveryConfirmed(store: OriginStore | undefined, operationId: string, peer?: OriginReceiptPeer): Promise<boolean> {
  if (!store) return false;
  const deadline = Date.now() + 2000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async (): Promise<boolean> => {
    try {
      const audit = await store.getOperation(operationId);
      if (originAuditDeliveryConfirmed(audit)) return true;
      if (!audit || audit.operation || !peer || Date.now() >= deadline || wireDigest(audit.record.envelopeJson) !== audit.record.envelopeDigest) return false;
      const record = JSON.parse(audit.record.envelopeJson) as TelegramOriginRecord;
      const owner = record.executionOwnerMachineId;
      if (record.operationId !== operationId || record.originId !== audit.record.originId || record.agentId !== peer.agentId ||
        record.originMachineId !== peer.selfMachineId || !owner || owner === peer.selfMachineId || owner.length > 128) return false;
      const reply = await peer.send(owner, { type: 'telegram-origin', protocol: 'instar-telegram-origin-v1', action: 'receipt', operationId }, Math.max(1, deadline - Date.now()));
      const result = reply.result as { ok?: boolean; operationId?: string; originId?: string; envelopeDigest?: string;
        executionOwnerMachineId?: string; state?: string; originReceiptConfirmed?: boolean } | undefined;
      return reply.ok && result?.ok === true && result.operationId === operationId && result.originId === record.originId &&
        result.envelopeDigest === audit.record.envelopeDigest && result.executionOwnerMachineId === owner &&
        result.state === 'accepted' && result.originReceiptConfirmed === true;
    } catch { return false; }
  };
  try { return await Promise.race([read(), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 2000); })]); }
  finally { if (timer) clearTimeout(timer); }
}

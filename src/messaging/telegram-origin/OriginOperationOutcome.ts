import type { OriginAuditRecord } from './StoreTypes.js';
import type { UnrecordedReceiptEntry, OriginUnrecordedReceipts } from './OriginUnrecordedReceipts.js';

/**
 * "Did my message arrive?" for one operation id (held-reply outcome lookup,
 * Echo Bugs topic 10000000967). A session that got a 409 telegram-origin-held
 * asks this instead of resending.
 *
 * Source of truth is Telegram's own acceptance receipt: the message id Telegram
 * returned, held either in the origin store or, when the store write failed, in
 * the fallback record. The Bot API has no read-a-message-by-id call, so a
 * receipt is the strongest evidence available; absence of a receipt after a
 * dispatched request stays `unknown`, never `not-delivered`.
 */
export type OperationOutcome = 'delivered' | 'partially-delivered' | 'not-delivered' | 'pending' | 'unknown';

export interface OperationOutcomeVerdict {
  operationId: string;
  outcome: OperationOutcome;
  /** True only for `not-delivered`: nothing reached Telegram and the server will not retry it. */
  safeToResend: boolean;
  source: 'origin-store' | 'unrecorded-receipt' | 'origin-store+unrecorded-receipt' | 'execution-owner' | 'none';
  messageIds: string[];
  state: string | null;
  detail: string;
}

const TERMINAL_UNDELIVERED = new Set(['known-failed', 'suppressed', 'expired']);

export function receiptMessageIds(receiptJson: string | null): string[] {
  if (!receiptJson) return [];
  try {
    const receipt = JSON.parse(receiptJson) as { messages?: unknown[] };
    const values = Array.isArray(receipt.messages) ? receipt.messages : [receipt];
    return values.flatMap(value => {
      const row = value as { messageId?: unknown; message_id?: unknown; result?: { message_id?: unknown } };
      const id = row?.messageId ?? row?.result?.message_id ?? row?.message_id;
      const text = typeof id === 'string' || typeof id === 'number' ? String(id) : '';
      return /^[1-9]\d*$/.test(text) && Number.isSafeInteger(Number(text)) ? [text] : [];
    });
  } catch { return []; }
}

export function classifyOperationOutcome(operationId: string, audit: OriginAuditRecord | null, captured: UnrecordedReceiptEntry[]): OperationOutcomeVerdict {
  const capturedByChild = new Map(captured.map(entry => [entry.childId, entry]));
  if (!audit || !audit.operation) {
    if (captured.length && captured.every(entry => typeof entry.messageId === 'string' && /^[1-9]\d*$/.test(entry.messageId) && Number.isSafeInteger(Number(entry.messageId)))) return { operationId, outcome: 'delivered', safeToResend: false, source: 'unrecorded-receipt',
      messageIds: captured.map(entry => entry.messageId).filter((id): id is string => typeof id === 'string'), state: audit?.operation?.state ?? null,
      detail: 'Telegram accepted it and returned a message id; the receipt is in the fallback record.' };
    return { operationId, outcome: 'unknown', safeToResend: false, source: 'none', messageIds: [], state: null,
      detail: audit ? 'This machine holds the evidence only; the send ran on another machine.' : 'No record of this operation on this machine.' };
  }
  const messageIds: string[] = [];
  let fromStore = 0, fromFallback = 0, unresolvedDispatch = 0;
  for (const child of audit.children) {
    const accepted = audit.attempts.find(a => a.childId === child.childId && a.outcome === 'accepted' && receiptMessageIds(a.receiptJson).length > 0);
    if (accepted) { fromStore++; messageIds.push(...receiptMessageIds(accepted.receiptJson)); continue; }
    const entry = capturedByChild.get(child.childId);
    if (entry && typeof entry.messageId === 'string' && /^[1-9]\d*$/.test(entry.messageId) && Number.isSafeInteger(Number(entry.messageId))) { fromFallback++; messageIds.push(entry.messageId); continue; }
    if (audit.attempts.some(a => a.childId === child.childId && a.phase === 'dispatched' &&
      (a.outcome === null || a.outcome === 'outcome-unknown' || a.outcome === 'expired-unresolved' ||
        (a.outcome === 'accepted' && receiptMessageIds(a.receiptJson).length === 0)))) unresolvedDispatch++;
  }
  const delivered = fromStore + fromFallback;
  const source = fromStore && fromFallback ? 'origin-store+unrecorded-receipt' : fromFallback ? 'unrecorded-receipt' : 'origin-store';
  const state = audit.operation.state;
  const total = audit.children.length;
  if (total > 0 && delivered === total) return { operationId, outcome: 'delivered', safeToResend: false, source, messageIds, state,
    detail: fromFallback ? 'Telegram accepted it and returned a message id; the receipt is in the fallback record and will be folded into the store.' : 'Telegram accepted it and the receipt is recorded.' };
  if (delivered > 0) return { operationId, outcome: 'partially-delivered', safeToResend: false, source, messageIds, state,
    detail: `${delivered} of ${total} parts reached Telegram. Check before sending the rest yourself.` };
  if (unresolvedDispatch > 0) return { operationId, outcome: 'unknown', safeToResend: false, source: 'origin-store', messageIds, state,
    detail: 'The request went to Telegram and no answer was recorded. It may have arrived; do not resend.' };
  if (TERMINAL_UNDELIVERED.has(state)) return { operationId, outcome: 'not-delivered', safeToResend: true, source: 'origin-store', messageIds, state,
    detail: state === 'suppressed' ? 'The server decided not to send it.' : 'It never reached Telegram and will not be retried.' };
  return { operationId, outcome: 'pending', safeToResend: false, source: 'origin-store', messageIds, state,
    detail: state === 'superseded' ? 'A newer copy of the same message carries it; the server delivers that one.'
      : 'Not delivered yet. The server keeps the original message and retries it; do not resend.' };
}

/** True when every part of the operation has a Telegram receipt, in the store or the fallback record. */
export function unrecordedAcceptanceCovers(runtime: { unrecordedReceipts?: Pick<OriginUnrecordedReceipts, 'forOperation'> }, audit: OriginAuditRecord): boolean {
  if (!runtime.unrecordedReceipts || !audit.operation) return false;
  let captured: UnrecordedReceiptEntry[];
  try { captured = runtime.unrecordedReceipts.forOperation(audit.operation.operationId); } catch { return false; }
  if (!captured.length) return false;
  return classifyOperationOutcome(audit.operation.operationId, audit, captured).outcome === 'delivered';
}

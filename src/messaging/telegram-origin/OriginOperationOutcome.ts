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
  /** native-conversation-base §3b — the stated suppression reason (closed set), when there is one. */
  reason?: SuppressionReason | null;
  /** §3b — why a definite non-delivery happened (closed set). */
  failure?: FailureCause | null;
  /** §3b — a superseded row names its successor; the reader follows it. */
  supersededBy?: string | null;
  /** §3b — set when the user already has this text (a duplicate ending). */
  duplicateOfMessageId?: string | null;
  /** §3b — `unknown` because a request went out and no answer was recorded. */
  unresolvedDispatch?: boolean;
}

/** native-conversation-base §3a item 9 — the closed set of suppression reasons. Anything else reads as no reason. */
export const SUPPRESSION_REASONS = ['quiet-notification-recorded', 'duplicate-content', 'historical-notice-retired', 'recorded-by-caller', 'suppressed-at-holder'] as const;
export type SuppressionReason = typeof SUPPRESSION_REASONS[number];
/** §3a item 8 — the closed set of definite-failure causes. */
export const FAILURE_CAUSES = ['refused', 'never-left', 'deadline'] as const;
export type FailureCause = typeof FAILURE_CAUSES[number];
export const OPERATION_OUTCOMES: readonly OperationOutcome[] = ['delivered', 'partially-delivered', 'not-delivered', 'pending', 'unknown'];
const ENDED_ON_PURPOSE = new Set<SuppressionReason>(['quiet-notification-recorded', 'historical-notice-retired', 'recorded-by-caller']);

export function suppressionReason(value: unknown): SuppressionReason | null {
  return typeof value === 'string' && (SUPPRESSION_REASONS as readonly string[]).includes(value) ? value as SuppressionReason : null;
}
export function failureCause(value: unknown): FailureCause | null {
  return typeof value === 'string' && (FAILURE_CAUSES as readonly string[]).includes(value) ? value as FailureCause : null;
}
const OPERATION_ID = /^[A-Za-z0-9-]{1,256}$/;
function successorOf(detail: Record<string, unknown> | null | undefined, self: string): string | null {
  const next = detail?.supersededBy;
  return typeof next === 'string' && OPERATION_ID.test(next) && next !== self ? next : null;
}
/** A `known-failed` row: Telegram refused it (a 4xx other than 429) or it never left. */
function knownFailedCause(audit: OriginAuditRecord): FailureCause {
  return audit.attempts.some(a => a.outcome === 'known-failed' && typeof a.reason === 'string' && /^telegram-4\d\d$/.test(a.reason) && a.reason !== 'telegram-429')
    ? 'refused' : 'never-left';
}

export function receiptMessageIds(receiptJson: string | null): string[] {
  if (!receiptJson) return [];
  try {
    const receipt = JSON.parse(receiptJson) as { messages?: unknown[] };
    const values = Array.isArray(receipt.messages) ? receipt.messages : [receipt];
    const ids = values.map(value => {
      const row = value as { messageId?: unknown; message_id?: unknown; result?: { message_id?: unknown } };
      const id = row?.messageId ?? row?.result?.message_id ?? row?.message_id;
      const text = typeof id === 'string' || typeof id === 'number' ? String(id) : '';
      return /^[1-9]\d*$/.test(text) && Number.isSafeInteger(Number(text)) ? text : null;
    });
    return ids.every((value): value is string => value !== null) ? ids : [];
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
    detail: 'The request went to Telegram and no answer was recorded. It may have arrived; do not resend.', unresolvedDispatch: true };
  const holdDetail = audit.operation.holdDetail ?? null;
  if (state === 'known-failed' || state === 'expired') {
    const failure: FailureCause = state === 'expired' ? 'deadline' : knownFailedCause(audit);
    return { operationId, outcome: 'not-delivered', safeToResend: true, source: 'origin-store', messageIds, state, failure, reason: null,
      detail: 'It never reached Telegram and will not be retried.' };
  }
  if (state === 'suppressed') {
    // §3b item 2 — a suppression is an ending only with a stated reason. A null
    // reason (a row written before reasons existed) is unknown, never "resend".
    const reason = suppressionReason(audit.operation.holdReason);
    const holderReason = suppressionReason(holdDetail?.holderReason);
    if (reason === 'duplicate-content' || (reason === 'suppressed-at-holder' && holderReason === 'duplicate-content')) {
      const dup = holdDetail?.duplicateOfMessageId;
      return { operationId, outcome: 'delivered', safeToResend: false, source: 'origin-store', messageIds, state, reason,
        duplicateOfMessageId: typeof dup === 'string' && /^[1-9]\d*$/.test(dup) ? dup : typeof dup === 'number' && Number.isSafeInteger(dup) && dup > 0 ? String(dup) : null,
        detail: 'The user already has this text.' };
    }
    if (reason && ENDED_ON_PURPOSE.has(reason)) return { operationId, outcome: 'not-delivered', safeToResend: false, source: 'origin-store', messageIds, state, reason,
      detail: 'It was ended on purpose; do not resend.' };
    if (reason === 'suppressed-at-holder' && holderReason && ENDED_ON_PURPOSE.has(holderReason)) return { operationId, outcome: 'not-delivered', safeToResend: false,
      source: 'origin-store', messageIds, state, reason, detail: 'The machine that sends to Telegram ended it on purpose; do not resend.' };
    return { operationId, outcome: 'unknown', safeToResend: false, source: 'origin-store', messageIds, state, reason: null,
      detail: 'It was ended with no stated reason; the user may already have this text. Do not resend.' };
  }
  if (state === 'superseded') {
    const supersededBy = successorOf(holdDetail, operationId);
    return { operationId, outcome: supersededBy ? 'pending' : 'unknown', safeToResend: false, source: 'origin-store', messageIds, state, supersededBy,
      detail: supersededBy ? 'A newer copy of the same message carries it; its outcome is the answer.' : 'A newer copy carries it, and that copy is not named here.' };
  }
  if (state === 'held' && holdDetail && typeof holdDetail.ownerUnstated === 'object' && holdDetail.ownerUnstated !== null) {
    return { operationId, outcome: 'unknown', safeToResend: false, source: 'origin-store', messageIds, state,
      detail: 'The machine that sends to Telegram ended it and gave no reason. The user may already have this text.' };
  }
  return { operationId, outcome: 'pending', safeToResend: false, source: 'origin-store', messageIds, state,
    detail: 'Not delivered yet. The server keeps the original message and retries it; do not resend.' };
}

/** True when every part of the operation has a Telegram receipt, in the store or the fallback record. */
export function unrecordedAcceptanceCovers(runtime: { unrecordedReceipts?: Pick<OriginUnrecordedReceipts, 'forOperation'> }, audit: OriginAuditRecord): boolean {
  if (!runtime.unrecordedReceipts || !audit.operation) return false;
  let captured: UnrecordedReceiptEntry[];
  try { captured = runtime.unrecordedReceipts.forOperation(audit.operation.operationId); } catch { return false; }
  if (!captured.length) return false;
  return classifyOperationOutcome(audit.operation.operationId, audit, captured).outcome === 'delivered';
}

// ── native-conversation-base §3b: the outcome route's resolution table ─────────

export type OwnerReadWhy = 'timeout' | 'refused' | 'old-version' | 'owner-read-off';
export type ResolvedWhy = OwnerReadWhy | 'owner-unresolved' | 'author-unanswered' | 'owner-no-record';
/** The execution owner's own verdict, as read from its `receipt` answer (or locally on the owner). */
export interface OwnerVerdictEvidence {
  kind: 'verdict'; machineId: string; outcome: OperationOutcome; safeToResend: boolean; messageIds: string[];
  reason: SuppressionReason | null; failure: FailureCause | null; supersededBy: string | null; duplicateOfMessageId: string | null; detail?: string;
}
export type OwnerEvidence = OwnerVerdictEvidence
  /** The owner answered: it holds no record of this id, or evidence only (never admitted). Definite from an owner of any version. */
  | { kind: 'no-record' | 'not-admitted'; machineId: string }
  /** No usable owner answer: silent, refused, an older owner with no `outcome`, or the read is switched off. */
  | { kind: 'missing'; why: OwnerReadWhy };
/** The author's statement about its own row. `delivered` carries the ids when the author delivered it itself (a local send after the lease returned). */
export type AuthorEvidence = { kind: 'answer'; holding: boolean; supersededBy: string | null; machineId: string; delivered?: { messageIds: string[] } } | { kind: 'missing' };
export interface LocalEvidence {
  /** This machine's own classification of its row, or null when it has none. */
  verdict: OperationOutcomeVerdict | null;
  /** This machine wrote the reply (row 9 is evaluated only here). */
  isAuthor: boolean;
  /** A local held row carrying `ownerUnstated` (§3a item 7). */
  ownerUnstated: boolean;
  /** Row 9's local half: the row is `expired` or `known-failed`, has no successor and no `local-sent` / `outcome-unknown` forward attempt. */
  terminalNoDispatch: boolean;
}
export interface ResolvedOutcome {
  outcome: OperationOutcome;
  safeToResend: boolean;
  source: OperationOutcomeVerdict['source'] | 'author+execution-owner';
  /** The machine whose record gave the answer (the authenticated mesh sender for a remote answer). */
  answeredBy: string | null;
  ownerAnswered: boolean;
  why: ResolvedWhy | null;
  reason: SuppressionReason | null;
  failure: FailureCause | null;
  supersededBy: string | null;
  duplicateOfMessageId: string | null;
  messageIds: string[];
  detail: string;
  /** The table row that matched (observability and tests). */
  row: number;
}
export type ResolutionStep = { kind: 'answer'; answer: ResolvedOutcome } | { kind: 'follow'; successor: string; via: 'local' | 'owner' | 'author' };

const isDelivered = (o: OperationOutcome) => o === 'delivered' || o === 'partially-delivered';

/**
 * native-conversation-base §3b item 4 — the first matching row of the table.
 * Pure: the caller gathers the evidence (local row, owner answer, author answer)
 * and follows a `follow` step itself. Absence is never non-delivery (rows 5, 8,
 * 10, 11); only row 6 (the owner's classified verdict plus an author that no
 * longer holds it) and row 9 (on the author's own machine) can permit a resend.
 */
export function resolveOutcome(local: LocalEvidence, owner: OwnerEvidence, author: AuthorEvidence, selfMachineId: string): ResolutionStep {
  const lv = local.verdict;
  const ov = owner.kind === 'verdict' ? owner : null;
  const ownerAnswered = owner.kind !== 'missing';
  const ownerId = owner.kind === 'missing' ? null : owner.machineId;
  const base = { ownerAnswered, why: null, reason: null, failure: null, supersededBy: null, duplicateOfMessageId: null, messageIds: [] as string[] };
  const done = (answer: ResolvedOutcome): ResolutionStep => ({ kind: 'answer', answer });
  // 1 — a definite receipt, local or the owner's.
  if (lv && isDelivered(lv.outcome)) return done({ ...base, outcome: lv.outcome, safeToResend: false, source: lv.source, answeredBy: selfMachineId,
    messageIds: lv.messageIds, reason: lv.reason ?? null, duplicateOfMessageId: lv.duplicateOfMessageId ?? null, detail: lv.detail, row: 1 });
  if (ov && isDelivered(ov.outcome)) return done({ ...base, outcome: ov.outcome, safeToResend: false, source: 'execution-owner', answeredBy: ov.machineId,
    messageIds: ov.messageIds, reason: ov.reason, duplicateOfMessageId: ov.duplicateOfMessageId, detail: ov.detail ?? 'The machine that sends to Telegram holds its receipt.', row: 1 });
  // 1, author half — the machine that wrote it delivered it itself; the owner's own failure does not undo that.
  if (author.kind === 'answer' && author.delivered) return done({ ...base, outcome: 'delivered', safeToResend: false, source: 'origin-store', answeredBy: author.machineId,
    messageIds: author.delivered.messageIds, detail: 'The machine that wrote it delivered it itself.', row: 1 });
  // 2 — the user already has this text.
  const dup = ov?.reason === 'duplicate-content' ? ov : lv?.reason === 'duplicate-content' ? lv : null;
  if (dup) return done({ ...base, outcome: 'delivered', safeToResend: false, source: dup === ov ? 'execution-owner' : lv!.source,
    answeredBy: dup === ov ? ov!.machineId : selfMachineId, reason: 'duplicate-content', duplicateOfMessageId: dup.duplicateOfMessageId ?? null,
    detail: 'The user already has this text.', row: 2 });
  // 3 — superseded anywhere: the answer is the successor's.
  if (lv?.supersededBy) return { kind: 'follow', successor: lv.supersededBy, via: 'local' };
  if (ov?.supersededBy) return { kind: 'follow', successor: ov.supersededBy, via: 'owner' };
  if (author.kind === 'answer' && author.supersededBy) return { kind: 'follow', successor: author.supersededBy, via: 'author' };
  // 4 — the owner still has it.
  if (ov?.outcome === 'pending') return done({ ...base, outcome: 'pending', safeToResend: false, source: 'execution-owner', answeredBy: ov.machineId,
    detail: ov.detail ?? 'The machine that sends to Telegram still has it and will deliver it.', row: 4 });
  // 5 — the owner's own send is unresolved.
  if (ov?.outcome === 'unknown' || lv?.unresolvedDispatch || local.ownerUnstated) return done({ ...base, outcome: 'unknown', safeToResend: false,
    source: ov ? 'execution-owner' : lv?.source ?? 'none', answeredBy: ov ? ov.machineId : selfMachineId, why: 'owner-unresolved',
    detail: 'The machine that sends to Telegram cannot confirm whether it arrived. It may have arrived; do not resend.', row: 5 });
  // 6 to 8 — the owner did not deliver it; the author decides whether anyone still holds it.
  if (ov?.outcome === 'not-delivered') {
    if (author.kind === 'answer' && author.holding) return done({ ...base, outcome: 'pending', safeToResend: false, source: 'execution-owner', answeredBy: ov.machineId,
      detail: 'The machine that wrote it still holds it and will deliver it.', row: 7 });
    if (author.kind === 'answer') return done({ ...base, outcome: 'not-delivered', safeToResend: ov.safeToResend, source: 'execution-owner', answeredBy: ov.machineId,
      reason: ov.reason, failure: ov.failure, detail: ov.detail ?? (ov.safeToResend ? 'It never reached Telegram and will not be retried.' : 'It was ended on purpose; do not resend.'), row: 6 });
    return done({ ...base, outcome: 'unknown', safeToResend: false, source: 'execution-owner', answeredBy: ov.machineId, why: 'author-unanswered',
      reason: ov.reason, failure: ov.failure, detail: 'The machine that wrote it did not answer, so it may still hold it. Do not resend.', row: 8 });
  }
  // 9 and 10 — the owner answered that it never admitted it.
  if (owner.kind === 'no-record' || owner.kind === 'not-admitted') {
    if (local.isAuthor && local.terminalNoDispatch && lv && lv.outcome === 'not-delivered') return done({ ...base, outcome: 'not-delivered', safeToResend: true,
      source: 'author+execution-owner', answeredBy: owner.machineId, failure: lv.failure ?? null,
      detail: 'Nobody holds it and nothing was dispatched: the machine that sends to Telegram never admitted it, and this machine gave up on it.', row: 9 });
    if (author.kind === 'answer' && author.holding) return done({ ...base, outcome: 'pending', safeToResend: false, source: 'origin-store', answeredBy: author.machineId,
      detail: 'The machine that wrote it still holds it and will deliver it.', row: 10 });
    return done({ ...base, outcome: 'unknown', safeToResend: false, source: 'execution-owner', answeredBy: owner.machineId, why: 'owner-no-record',
      detail: 'The machine that sends to Telegram has no record of it. Do not resend.', row: 10 });
  }
  // 11 — no usable owner answer. A local pending stands; everything else is unknown.
  const why: OwnerReadWhy = owner.kind === 'missing' ? owner.why : 'old-version';
  if (lv?.outcome === 'pending') return done({ ...base, outcome: 'pending', safeToResend: false, source: lv.source, answeredBy: selfMachineId, ownerAnswered: false, why,
    detail: lv.detail, row: 11 });
  return done({ ...base, outcome: 'unknown', safeToResend: false, source: lv?.source ?? 'none', answeredBy: ownerId, ownerAnswered: false, why,
    reason: lv?.reason ?? null, failure: lv?.failure ?? null,
    detail: why === 'owner-read-off' ? 'Asking the machine that sends to Telegram is switched off here, so this machine cannot confirm the outcome. Do not resend.'
      : why === 'old-version' ? 'The machine that sends to Telegram runs an older version and did not give its verdict. Do not resend.'
        : 'The machine that sends to Telegram did not answer. Do not resend; ask again in a minute.', row: 11 });
}

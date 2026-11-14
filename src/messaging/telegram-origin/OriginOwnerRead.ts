/**
 * native-conversation-base §3b — the outcome route asks the execution owner.
 *
 * "Did my held reply arrive?" is answered from the machine that ran the send,
 * over the existing signed `receipt` verb with `reader: true`. This module owns
 * the asks (bounded, coalesced, cached) and the orchestration around the pure
 * resolution table (`resolveOutcome`, OriginOperationOutcome.ts). It never
 * submits, redirects or creates an operation; the forward ladder never sends
 * `reader`, so nothing here can free a re-forward.
 */
// RULE 3: EXEMPT — reads a typed, signed same-agent mesh answer (closed-set fields), not provider/CLI output or terminal state.
import type { OriginAuditRecord } from './StoreTypes.js';
import type { OriginMeshCommand } from './OriginMesh.js';
import type { UnrecordedReceiptEntry } from './OriginUnrecordedReceipts.js';
import type { TelegramOriginRecord } from './types.js';
import { wireDigest } from './CanonicalOrigin.js';
import {
  classifyOperationOutcome, failureCause, suppressionReason, resolveOutcome, OPERATION_OUTCOMES,
  type AuthorEvidence, type LocalEvidence, type OperationOutcome, type OperationOutcomeVerdict, type OwnerEvidence,
  type OwnerReadWhy, type ResolvedOutcome,
} from './OriginOperationOutcome.js';

/** The route answers inside the reply script's own `curl --max-time 5`. */
export const OWNER_READ_ROUTE_DEADLINE_MS = 4000;
/** Inherited per-ask budget (OriginDeliveryResolution.ts). */
export const OWNER_READ_DEFAULT_BUDGET_MS = 2000;
export const OWNER_READ_DEFAULT_CACHE_ENTRIES = 1024;
/** A machine that just timed out is answered `timeout` at once for this long. */
export const OWNER_READ_TIMEOUT_MEMO_MS = 2000;
const MAX_FOLLOW = 8;
const ID = /^[A-Za-z0-9-]{1,256}$/;
const MACHINE = /^[A-Za-z0-9_.:-]{1,128}$/;

export type ReceiptAnswer =
  | ({ kind: 'owner'; holding: boolean | null; originMachineId: string | null } & Omit<Extract<OwnerEvidence, { kind: 'verdict' }>, 'kind'>)
  | { kind: 'author'; machineId: string; holding: boolean; supersededBy: string | null; delivered?: { messageIds: string[] } }
  | { kind: 'no-record' | 'not-admitted'; machineId: string }
  | { kind: 'missing'; machineId: string; why: Exclude<OwnerReadWhy, 'owner-read-off'> };

export interface OwnerReadTransport {
  send: (machineId: string, command: OriginMeshCommand, timeoutMs: number) => Promise<{ ok: boolean; result?: unknown }>;
}

export interface OwnerReaderOptions {
  selfMachineId: string;
  transport: OwnerReadTransport;
  /** The current serving-lease holder, for an id this machine has no row for. */
  leaseHolder: () => string | null;
  /** `messageOrigin.ownerRead.enabled` and `messageOrigin.forwardToHolder.enabled`, read live. */
  enabled: () => boolean;
  budgetMs?: () => number;
  cacheEntries?: () => number;
  now?: () => number;
}

/** Validate one `receipt` answer. The sender is the machine we asked (recipient-bound signed transport), never a body field. */
export function parseReceiptAnswer(machineId: string, operationId: string, reply: { ok: boolean; result?: unknown }, expected?: { originId: string; envelopeDigest: string }): ReceiptAnswer {
  const r = reply.result as Record<string, unknown> | undefined;
  if (!reply.ok || !r || r.ok !== true || r.operationId !== operationId) return { kind: 'missing', machineId, why: 'refused' };
  if (r.state === 'no-record') return { kind: 'no-record', machineId };
  // When the envelope is known locally, an answer about any other envelope (or one that does not say which) is not about this reply.
  if (expected && (r.originId !== expected.originId || r.envelopeDigest !== expected.envelopeDigest)) return { kind: 'missing', machineId, why: 'refused' };
  if (r.state === 'not-admitted') return { kind: 'not-admitted', machineId };
  const supersededBy = typeof r.supersededBy === 'string' && ID.test(r.supersededBy) && r.supersededBy !== operationId ? r.supersededBy : null;
  const ids = (value: unknown) => Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && /^[1-9]\d*$/.test(id)) : [];
  if (r.role === 'author') {
    if (r.delivered === true && ids(r.messageIds).length) return { kind: 'author', machineId, holding: false, supersededBy, delivered: { messageIds: ids(r.messageIds) } };
    // `holding: null` is the author saying it cannot tell (an unresolved forward or send of its own): no statement.
    if (typeof r.holding !== 'boolean') return { kind: 'missing', machineId, why: r.holding === null ? 'refused' : 'old-version' };
    return { kind: 'author', machineId, holding: r.holding, supersededBy };
  }
  // A record the owner holds with no `outcome` (an older version), or with a
  // value outside the closed sets, is an answer with no verdict. Never read the
  // raw `state` as one: a `suppressed` state may be a delivered duplicate.
  const outcome = typeof r.outcome === 'string' && (OPERATION_OUTCOMES as readonly string[]).includes(r.outcome) ? r.outcome as OperationOutcome : null;
  const failure = r.failure === undefined || r.failure === null ? null : failureCause(r.failure);
  if (r.role !== 'execution-owner' || !outcome || typeof r.safeToResend !== 'boolean' || (r.failure !== undefined && r.failure !== null && !failure)) {
    return { kind: 'missing', machineId, why: 'old-version' };
  }
  const messageIds = ids(r.messageIds);
  const dup = typeof r.duplicateOfMessageId === 'string' && /^[1-9]\d*$/.test(r.duplicateOfMessageId) ? r.duplicateOfMessageId : null;
  return { kind: 'owner', machineId, outcome, safeToResend: outcome === 'not-delivered' && r.safeToResend === true, messageIds,
    reason: suppressionReason(r.reason), failure, supersededBy, duplicateOfMessageId: dup,
    detail: typeof r.detail === 'string' ? r.detail.slice(0, 300) : undefined,
    holding: typeof r.holding === 'boolean' ? r.holding : null,
    originMachineId: typeof r.originMachineId === 'string' && MACHINE.test(r.originMachineId) ? r.originMachineId : null };
}

interface Stats { asks: number; cacheHits: number; coalesced: number; timeouts: number; refused: number; oldVersion: number; routeReads: number; routeOverBudget: number }

export class OriginOwnerReader {
  readonly #o: OwnerReaderOptions;
  readonly #inflight = new Map<string, Promise<ReceiptAnswer>>();
  readonly #cache = new Map<string, ReceiptAnswer>();
  readonly #timedOutUntil = new Map<string, number>();
  readonly #stats: Stats = { asks: 0, cacheHits: 0, coalesced: 0, timeouts: 0, refused: 0, oldVersion: 0, routeReads: 0, routeOverBudget: 0 };
  readonly #askMs: number[] = [];
  readonly #routeMs: number[] = [];

  constructor(options: OwnerReaderOptions) { this.#o = options; }

  get selfMachineId(): string { return this.#o.selfMachineId; }
  enabled(): boolean { try { return this.#o.enabled(); } catch { return false; } } // @silent-fallback-ok — an unreadable switch only makes answers more cautious (row 11)
  leaseHolder(): string | null { try { return this.#o.leaseHolder(); } catch { return null; } } // @silent-fallback-ok — no holder means no ask, and the answer stays unknown
  #now(): number { return this.#o.now?.() ?? Date.now(); }
  #budget(): number {
    const v = this.#o.budgetMs?.();
    return Number.isSafeInteger(v) && Number(v) > 0 ? Math.min(Number(v), OWNER_READ_ROUTE_DEADLINE_MS) : OWNER_READ_DEFAULT_BUDGET_MS;
  }
  #cacheLimit(): number {
    const v = this.#o.cacheEntries?.();
    return Number.isSafeInteger(v) && Number(v) >= 0 ? Math.min(Number(v), 100_000) : OWNER_READ_DEFAULT_CACHE_ENTRIES;
  }

  /** One `receipt` ask with `reader: true`, bounded by `min(budget, timeLeft)`. Shared by every concurrent caller for the same id. */
  ask(machineId: string, operationId: string, deadlineAt: number, expected?: { originId: string; envelopeDigest: string }): Promise<ReceiptAnswer> {
    const key = `${machineId}\u0000${operationId}\u0000${expected?.envelopeDigest ?? ''}`;
    const cached = this.#cache.get(key);
    if (cached) { this.#cache.delete(key); this.#cache.set(key, cached); this.#stats.cacheHits++; return Promise.resolve(cached); }
    const until = this.#timedOutUntil.get(machineId);
    if (until !== undefined && until > this.#now()) { this.#stats.timeouts++; return Promise.resolve({ kind: 'missing', machineId, why: 'timeout' }); }
    const running = this.#inflight.get(key);
    if (running) { this.#stats.coalesced++; return running; }
    const promise = this.#ask(key, machineId, operationId, deadlineAt, expected).finally(() => this.#inflight.delete(key));
    this.#inflight.set(key, promise);
    return promise;
  }

  async #ask(key: string, machineId: string, operationId: string, deadlineAt: number, expected?: { originId: string; envelopeDigest: string }): Promise<ReceiptAnswer> {
    const started = this.#now();
    const timeoutMs = Math.min(this.#budget(), deadlineAt - started);
    if (timeoutMs <= 0) { this.#stats.timeouts++; return { kind: 'missing', machineId, why: 'timeout' }; }
    this.#stats.asks++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const TIMED_OUT = Symbol('timeout');
    let reply: { ok: boolean; result?: unknown } | typeof TIMED_OUT;
    try {
      reply = await Promise.race([
        this.#o.transport.send(machineId, { type: 'telegram-origin', protocol: 'instar-telegram-origin-v1', action: 'receipt', operationId, reader: true }, timeoutMs),
        new Promise<typeof TIMED_OUT>(resolve => { timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs); }),
      ]);
    } catch { reply = { ok: false }; } // @silent-fallback-ok — a transport failure is an unanswered ask: row 11, never not-delivered
    finally { if (timer) clearTimeout(timer); }
    const elapsed = this.#now() - started;
    this.#sample(this.#askMs, elapsed);
    if (reply === TIMED_OUT || (!reply.ok && elapsed >= timeoutMs - 5)) {
      this.#stats.timeouts++;
      this.#timedOutUntil.set(machineId, this.#now() + OWNER_READ_TIMEOUT_MEMO_MS);
      return { kind: 'missing', machineId, why: 'timeout' };
    }
    this.#timedOutUntil.delete(machineId);
    const answer = parseReceiptAnswer(machineId, operationId, reply, expected);
    if (answer.kind === 'missing') { if (answer.why === 'old-version') this.#stats.oldVersion++; else this.#stats.refused++; }
    // Only a terminal owner verdict is kept: eviction costs one more ask and cannot cause a second write.
    if (answer.kind === 'owner' && (answer.outcome === 'delivered' || answer.outcome === 'not-delivered') && !answer.supersededBy) {
      const limit = this.#cacheLimit();
      if (limit > 0) {
        this.#cache.set(key, answer);
        while (this.#cache.size > limit) this.#cache.delete(this.#cache.keys().next().value as string);
      }
    }
    return answer;
  }

  recordRoute(ms: number): void {
    this.#stats.routeReads++;
    if (ms > OWNER_READ_ROUTE_DEADLINE_MS + 250) this.#stats.routeOverBudget++;
    this.#sample(this.#routeMs, ms);
  }
  #sample(into: number[], ms: number): void { into.push(ms); if (into.length > 200) into.shift(); }
  stats(): Record<string, unknown> {
    const p95 = (values: number[]) => values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * 0.95))] : 'unknown';
    return { enabled: this.enabled(), ...this.#stats, cached: this.#cache.size, askP95Ms: p95(this.#askMs), routeP95Ms: p95(this.#routeMs),
      routeMaxMs: this.#routeMs.length ? Math.max(...this.#routeMs) : 'unknown' };
  }
}

export interface OutcomeReadDeps {
  selfMachineId: string;
  getOperation: (operationId: string) => Promise<OriginAuditRecord | null>;
  unrecorded: (operationId: string) => UnrecordedReceiptEntry[];
  reader: OriginOwnerReader | null | undefined;
  now?: () => number;
}

export interface OutcomeAnswer {
  status: 200 | 404;
  body: Record<string, unknown>;
}

function envelopeOf(audit: OriginAuditRecord | null): TelegramOriginRecord | null {
  if (!audit) return null;
  try {
    if (wireDigest(audit.record.envelopeJson) !== audit.record.envelopeDigest) return null;
    return JSON.parse(audit.record.envelopeJson) as TelegramOriginRecord;
  } catch { return null; } // @silent-fallback-ok — an unreadable envelope loses only the owner/author hint; the local verdict still answers
}

/**
 * §3b item 3 — what this machine, as author, says about its own row:
 * `true` while it still holds the reply (admitted, or held with no owner
 * verdict), `false` once it no longer does, and `null` when it cannot tell (an
 * unresolved forward or send of its own, or a replacement it cannot name).
 * A reply it delivered itself is reported as delivered, never as "not holding".
 */
export interface AuthorStatement { holding: boolean | null; delivered: { messageIds: string[] } | null; supersededBy: string | null }
export function authorStatement(audit: OriginAuditRecord | null, verdict: OperationOutcomeVerdict | null): AuthorStatement {
  const op = audit?.operation;
  if (!op) return { holding: null, delivered: null, supersededBy: null };
  if (verdict && (verdict.outcome === 'delivered' || verdict.outcome === 'partially-delivered')) return { holding: false, delivered: { messageIds: verdict.messageIds }, supersededBy: null };
  // Accepted or partial with no readable receipt: it may be in the chat. No statement.
  if (op.state === 'accepted' || op.state === 'partial' || op.state === 'outcome-unknown') return { holding: null, delivered: null, supersededBy: null };
  // Ended here on purpose (e.g. its own send recorded quietly): never a licence for anyone else to resend it.
  if (op.state === 'suppressed') return { holding: null, delivered: null, supersededBy: null };
  if (op.state === 'superseded') return { holding: verdict?.supersededBy ? false : null, delivered: null, supersededBy: verdict?.supersededBy ?? null };
  const detail = op.holdDetail ?? null;
  if (op.state === 'admitted') return { holding: true, delivered: null, supersededBy: null };
  // native-conversation-forwarded-advisory item 3 — handed back to its session: not sent, and no machine will send it on its own.
  if (op.state === 'held' && op.policyVerdict && typeof op.policyVerdict === 'object') return { holding: false, delivered: null, supersededBy: null };
  if (op.state === 'held') return { holding: !(detail && typeof detail.ownerVerdict === 'object' && detail.ownerVerdict !== null), delivered: null, supersededBy: null };
  const lastAttempt = typeof detail?.lastAttempt === 'string' ? detail.lastAttempt : null;
  // A forward whose answer was lost is settled by the machine it went to. When
  // that is the envelope's execution owner, every asker also reads that
  // owner's own verdict, so the author can say it no longer holds the reply.
  // A forward that went elsewhere, or a send of its own (`local-sent`), it cannot speak for.
  const forwardedTo = typeof detail?.machineId === 'string' ? detail.machineId : null;
  const owner = envelopeOf(audit)?.executionOwnerMachineId ?? null;
  const forwardSettledByOwner = lastAttempt === 'outcome-unknown' && !!owner && forwardedTo === owner;
  if ((lastAttempt === 'outcome-unknown' && !forwardSettledByOwner) || lastAttempt === 'local-sent' || verdict?.unresolvedDispatch || verdict?.outcome === 'unknown') {
    return { holding: null, delivered: null, supersededBy: null };
  }
  return { holding: false, delivered: null, supersededBy: null };
}
/** True while the author still holds the reply (see `authorStatement`). */
export function authorHolding(audit: OriginAuditRecord | null): boolean {
  return authorStatement(audit, audit ? classifyOperationOutcome(audit.operation?.operationId ?? '', audit, []) : null).holding === true;
}
function localAuthorEvidence(audit: OriginAuditRecord | null, verdict: OperationOutcomeVerdict | null, self: string): AuthorEvidence {
  const s = authorStatement(audit, verdict);
  if (s.delivered) return { kind: 'answer', holding: false, supersededBy: null, machineId: self, delivered: s.delivered };
  return s.holding === null ? { kind: 'missing' } : { kind: 'answer', holding: s.holding, supersededBy: s.supersededBy, machineId: self };
}

function localEvidence(verdict: OperationOutcomeVerdict | null, audit: OriginAuditRecord | null, isAuthor: boolean): LocalEvidence {
  const op = audit?.operation;
  const detail = op?.holdDetail ?? null;
  const lastAttempt = typeof detail?.lastAttempt === 'string' ? detail.lastAttempt : null;
  return { verdict, isAuthor,
    ownerUnstated: op?.state === 'held' && !!detail && typeof detail.ownerUnstated === 'object' && detail.ownerUnstated !== null,
    terminalNoDispatch: !!op && (op.state === 'expired' || op.state === 'known-failed') && !verdict?.supersededBy &&
      lastAttempt !== 'local-sent' && lastAttempt !== 'outcome-unknown' && !verdict?.unresolvedDispatch };
}

function fromVerdict(v: OperationOutcomeVerdict, answeredBy: string, row: number): ResolvedOutcome {
  return { outcome: v.outcome, safeToResend: v.safeToResend, source: v.source, answeredBy, ownerAnswered: true, why: null,
    reason: v.reason ?? null, failure: v.failure ?? null, supersededBy: v.supersededBy ?? null, duplicateOfMessageId: v.duplicateOfMessageId ?? null,
    messageIds: v.messageIds, detail: v.detail, row };
}

/**
 * The outcome route's whole answer for one operation id (§3b items 4 and 5):
 * answer locally when the local row is enough, otherwise ask the execution
 * owner and (when this machine is not the author) the author, in parallel,
 * inside one 4 s deadline, then apply the table. A superseded row is followed
 * to its successor (visited set; a repeat answers `unknown`).
 */
export async function readOperationOutcome(deps: OutcomeReadDeps, operationId: string): Promise<OutcomeAnswer> {
  const now = deps.now ?? Date.now;
  const started = now();
  const deadlineAt = started + OWNER_READ_ROUTE_DEADLINE_MS;
  const visited = new Set<string>();
  let current = operationId;
  let viaRemoteAuthor = false;
  let firstSuccessor: string | null = null;
  try {
    for (let hop = 0; hop <= MAX_FOLLOW; hop++) {
      if (visited.has(current)) {
        return { status: 200, body: shape(operationId, { outcome: 'unknown', safeToResend: false, source: 'none', answeredBy: null, ownerAnswered: false, why: null,
          reason: null, failure: null, supersededBy: firstSuccessor, duplicateOfMessageId: null, messageIds: [], detail: 'The chain of newer copies loops; the outcome cannot be read.', row: 3 }, started, null) };
      }
      visited.add(current);
      const step = await readOne(deps, current, deadlineAt);
      if (step.kind === 'answer') {
        const answer = viaRemoteAuthor ? { ...step.answer, safeToResend: false } : step.answer;
        if (firstSuccessor) answer.supersededBy = firstSuccessor;
        return { status: step.notFound && hop === 0 ? 404 : 200, body: shape(operationId, answer, started, step.executionOwnerMachineId, hop > 0 ? current : null) };
      }
      if (step.via === 'author') viaRemoteAuthor = true;
      firstSuccessor ??= step.successor;
      current = step.successor;
    }
    return { status: 200, body: shape(operationId, { outcome: 'unknown', safeToResend: false, source: 'none', answeredBy: null, ownerAnswered: false, why: null,
      reason: null, failure: null, supersededBy: firstSuccessor, duplicateOfMessageId: null, messageIds: [], detail: 'Too many newer copies to follow; the outcome cannot be read.', row: 3 }, started, null) };
  } finally { deps.reader?.recordRoute(now() - started); }
}

function shape(operationId: string, a: ResolvedOutcome, started: number, executionOwnerMachineId: string | null, answeredFor: string | null = null): Record<string, unknown> {
  return { operationId, outcome: a.outcome, safeToResend: a.safeToResend, source: a.source, answeredBy: a.answeredBy, asOf: new Date(started).toISOString(),
    ownerAnswered: a.ownerAnswered, why: a.why, reason: a.reason, failure: a.failure, supersededBy: a.supersededBy, duplicateOfMessageId: a.duplicateOfMessageId,
    messageIds: a.messageIds, detail: a.detail, resolution: a.row, ...(answeredFor ? { answeredFor } : {}),
    ...(executionOwnerMachineId ? { executionOwnerMachineId } : {}) };
}

type OneStep = ({ kind: 'answer'; answer: ResolvedOutcome; notFound?: boolean } | { kind: 'follow'; successor: string; via: 'local' | 'owner' | 'author' }) & { executionOwnerMachineId: string | null };

async function readOne(deps: OutcomeReadDeps, operationId: string, deadlineAt: number): Promise<OneStep> {
  const self = deps.selfMachineId;
  let captured: UnrecordedReceiptEntry[] = [];
  try { captured = deps.unrecorded(operationId); } catch { /* @silent-fallback-ok — the fallback file is unreadable; the store answers alone and the verdict degrades to unknown, never to not-delivered */ }
  const audit = await deps.getOperation(operationId);
  const verdict = audit || captured.length ? classifyOperationOutcome(operationId, audit, captured) : null;
  const envelope = envelopeOf(audit);
  const owner = envelope?.executionOwnerMachineId && MACHINE.test(envelope.executionOwnerMachineId) ? envelope.executionOwnerMachineId : null;
  const author = envelope?.originMachineId && MACHINE.test(envelope.originMachineId) ? envelope.originMachineId : null;
  const remoteOwner = owner && owner !== self ? owner : null;
  const isOwner = owner === self && !!audit?.operation;
  const isAuthor = author === self;
  const answer = (a: ResolvedOutcome, notFound = false): OneStep => ({ kind: 'answer', answer: a, notFound, executionOwnerMachineId: remoteOwner });
  const reader = deps.reader;
  const readerOn = !!reader && reader.enabled();

  // ── Answered locally, no ask ─────────────────────────────────────────────
  if (verdict && (verdict.outcome === 'delivered' || verdict.outcome === 'partially-delivered')) return answer(fromVerdict(verdict, self, 1));
  if (verdict?.supersededBy) return { kind: 'follow', successor: verdict.supersededBy, via: 'local', executionOwnerMachineId: remoteOwner };
  if (verdict && isOwner && isAuthor) return answer(fromVerdict(verdict, self, 0));
  // native-conversation-forwarded-advisory item 3 — the verdict column is read first: this machine wrote it
  // and holds the only live copy, which waits for the session's answer. Not sent; nothing to ask.
  if (verdict && isAuthor && audit?.operation?.state === 'held' && verdict.reason === 'tone-advisory') return answer(fromVerdict(verdict, self, 0));
  if (verdict && isAuthor && audit?.operation && (
    (audit.operation.state === 'held' && ((audit.operation.holdDetail?.lastAttempt as string | undefined) ?? 'unsettled') === 'unsettled' && !audit.operation.holdDetail?.ownerVerdict && !audit.operation.holdDetail?.ownerUnstated) ||
    (audit.operation.state === 'admitted' && audit.attempts.length === 0))) {
    // Held or admitted here and never handed to any owner: nothing to ask.
    return answer({ ...fromVerdict(verdict, self, 0), detail: 'Not delivered yet. This machine holds it and will deliver it; do not resend.' });
  }

  // ── No local row: ask the lease holder once ──────────────────────────────
  if (!audit) {
    const notFound = (): OneStep => answer({ outcome: verdict?.outcome ?? 'unknown', safeToResend: false, source: verdict?.source ?? 'none', answeredBy: null,
      ownerAnswered: false, why: readerOn ? null : 'owner-read-off', reason: null, failure: null, supersededBy: null, duplicateOfMessageId: null,
      messageIds: verdict?.messageIds ?? [], detail: verdict?.detail ?? 'No record of this operation on this machine.', row: 0 }, true);
    const holder = readerOn ? reader!.leaseHolder() : null;
    if (!readerOn || !holder || holder === self || !MACHINE.test(holder)) return notFound();
    const fromHolder = await reader!.ask(holder, operationId, deadlineAt);
    if (fromHolder.kind !== 'owner') return notFound();
    const ownerEv: OwnerEvidence = { kind: 'verdict', ...stripOwner(fromHolder) };
    let authorEv: AuthorEvidence = { kind: 'missing' };
    const authorId = fromHolder.originMachineId;
    if (authorId === holder && fromHolder.holding !== null) authorEv = { kind: 'answer', holding: fromHolder.holding, supersededBy: null, machineId: holder };
    else if (authorId && authorId !== self) authorEv = toAuthor(await reader!.ask(authorId, operationId, deadlineAt));
    const step = resolveOutcome({ verdict: null, isAuthor: false, ownerUnstated: false, terminalNoDispatch: false }, ownerEv, authorEv, self);
    return step.kind === 'answer' ? { ...step, executionOwnerMachineId: holder } : { ...step, executionOwnerMachineId: holder };
  }

  // ── Ask the owner and the author ─────────────────────────────────────────
  const local = localEvidence(verdict, audit, isAuthor);
  const expected = { originId: audit.record.originId, envelopeDigest: audit.record.envelopeDigest };
  let ownerEv: OwnerEvidence;
  let authorEv: AuthorEvidence;
  const needAuthor = !isAuthor && !!author;
  if (!readerOn) {
    ownerEv = isOwner && verdict ? { kind: 'verdict', machineId: self, ...verdictFields(verdict) }
      : owner === self ? { kind: 'not-admitted', machineId: self } : { kind: 'missing', why: 'owner-read-off' };
    authorEv = isAuthor ? localAuthorEvidence(audit, verdict, self) : { kind: 'missing' };
    // With the read off, a remote author cannot be asked: rows 6 to 8 fall to row 8, and a missing owner to row 11.
  } else {
    const ownerAsk = !remoteOwner ? null : reader!.ask(remoteOwner, operationId, deadlineAt, expected);
    const authorAsk = needAuthor && author !== remoteOwner ? reader!.ask(author!, operationId, deadlineAt, expected) : null;
    const [ownerAnswer, authorAnswer] = await Promise.all([ownerAsk, authorAsk]);
    if (isOwner && verdict) ownerEv = { kind: 'verdict', machineId: self, ...verdictFields(verdict) };
    else if (owner === self) ownerEv = { kind: 'not-admitted', machineId: self };
    else if (!ownerAnswer) ownerEv = { kind: 'missing', why: 'refused' };
    else ownerEv = toOwner(ownerAnswer);
    if (isAuthor) authorEv = localAuthorEvidence(audit, verdict, self);
    else if (authorAnswer) authorEv = toAuthor(authorAnswer);
    else if (ownerAnswer?.kind === 'owner' && author === remoteOwner && ownerAnswer.holding !== null) authorEv = { kind: 'answer', holding: ownerAnswer.holding, supersededBy: null, machineId: remoteOwner! };
    else authorEv = { kind: 'missing' };
  }
  const step = resolveOutcome(local, ownerEv, authorEv, self);
  return step.kind === 'answer' ? { ...step, executionOwnerMachineId: remoteOwner } : { ...step, executionOwnerMachineId: remoteOwner };
}

function verdictFields(v: OperationOutcomeVerdict) {
  return { outcome: v.outcome, safeToResend: v.safeToResend, messageIds: v.messageIds, reason: v.reason ?? null, failure: v.failure ?? null,
    supersededBy: v.supersededBy ?? null, duplicateOfMessageId: v.duplicateOfMessageId ?? null, detail: v.detail };
}
function stripOwner(a: Extract<ReceiptAnswer, { kind: 'owner' }>) {
  const { kind: _kind, holding: _holding, originMachineId: _origin, ...rest } = a;
  return rest;
}
function toOwner(a: ReceiptAnswer): OwnerEvidence {
  if (a.kind === 'owner') return { kind: 'verdict', ...stripOwner(a) };
  if (a.kind === 'no-record' || a.kind === 'not-admitted') return a;
  if (a.kind === 'missing') return { kind: 'missing', why: a.why };
  // An `author` role from the machine the envelope names as owner is not an owner verdict.
  return { kind: 'missing', why: 'refused' };
}
function toAuthor(a: ReceiptAnswer): AuthorEvidence {
  return a.kind === 'author' ? { kind: 'answer', holding: a.holding, supersededBy: a.supersededBy, machineId: a.machineId, ...(a.delivered ? { delivered: a.delivered } : {}) } : { kind: 'missing' };
}

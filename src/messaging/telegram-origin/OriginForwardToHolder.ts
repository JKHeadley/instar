import { QuietRecordedError } from '../NotificationSelectivityGate.js';
/* @self-action-controller: telegram-origin-forward-ladder */
// a2a-single-agent-identity §4 (ACT-058) — a reply from a machine that does not
// hold the serving lease is FORWARDED to the lease holder; a forward that fails
// is HELD durably, with its reason, a notice through the holder and one item.
//
// Pure decision + orchestration. Every side effect is a dependency the caller
// injects (lease reads, prepare, submit, hold, notify, audit), so the ladder,
// the settling window and the hold are unit-testable with fake clocks. Nothing
// here grants authority: the holder's `submit` re-runs its own lease check and
// its full outbound gate on every forwarded operation.
import type { OriginPreparedBotOperation } from './TelegramOriginService.js';
import type { OriginMeshCommand } from './OriginMesh.js';
import { ORIGIN_MESH_PROTOCOL } from './OriginMesh.js';
import { OriginSendPolicyRefusal } from './OriginSendPolicy.js';
import type { OriginSendPolicyDecision } from './OriginSendPolicy.js';
export type OriginSendPolicyRefusalDecision = Extract<OriginSendPolicyDecision, { ok: false }>;
import type { HeldOperationRow } from './StoreTypes.js';
import { topicRef } from '../shared/topicRef.js';
import type { OriginAuditRecord } from './StoreTypes.js';
import { classifyOperationOutcome, failureCause, suppressionReason } from './OriginOperationOutcome.js';
import type { FailureCause, SuppressionReason } from './OriginOperationOutcome.js';
import type { OriginSendPolicyInput } from './OriginSendPolicy.js';
import type { TelegramOriginRecord } from './types.js';
import { LATE_REPLY_THRESHOLD_MS, lateRecoveredReplyNotice } from './SessionDeliveryNotice.js';
import { readPolicyVerdict } from './OriginPolicyVerdict.js';
import type { PolicyVerdict } from './OriginPolicyVerdict.js';
import { AdvisoryAnswerClosedError } from './types.js';
export { AdvisoryAnswerClosedError };

/** Only a durable Telegram receipt may turn a recovered hold into a topic
 * history row. Follow a lease-transfer supersession to the delivered copy. */
export async function confirmedRecoveredForward(row: HeldOperationRow, getOperation: (id: string) => Promise<OriginAuditRecord | null>): Promise<{ topicId: number; text: string; messageId: number } | null> {
  const detail = row.holdDetail as { text?: unknown } | null;
  const topicId = Number(row.destination.topicId);
  if (typeof detail?.text !== 'string' || !Number.isSafeInteger(topicId) || topicId < 1) return null;
  const original = await getOperation(row.operationId);
  const supersededBy = (original?.operation?.holdDetail as { supersededBy?: unknown } | null)?.supersededBy;
  const deliveredId = typeof supersededBy === 'string' && supersededBy !== row.operationId ? supersededBy : row.operationId;
  const audit = deliveredId === row.operationId ? original : await getOperation(deliveredId);
  const verdict = classifyOperationOutcome(deliveredId, audit, []);
  if (verdict.outcome !== 'delivered' || verdict.messageIds.length !== 1) return null;
  return { topicId, text: detail.text, messageId: Number(verdict.messageIds[0]) };
}

export const HOLD_REASON_LEASE_NOT_HELD = 'lease-not-held';
/** Execution owner recorded on a hold taken while NO holder could be named.
 * Never a real machine, so recovery always re-prepares for the holder it finds. */
export const UNRESOLVED_LEASE_HOLDER = 'lease-holder-unresolved';
export const FORWARD_SETTLE_TIMEOUT_MS = 15_000;
/** §4.2 — the reply request runs settle + ONE forward attempt inside this
 * budget (≥ the holder's 10 s execute + 5 s margin, both RPCs sharing it),
 * well under the route's 120 s so a caller never times out before the hold
 * is written and re-runs with a NEW operation id. */
export const FORWARD_ATTEMPT_BUDGET_MS = 30_000;
/** Per-RPC ceiling so `capabilities` + `submit` fit the attempt budget. */
export const FORWARD_RPC_TIMEOUT_MS = 15_000;
/** §4.2 — the remaining attempts run from the recovery tick: a typed refusal
 * that proves non-admission is retried 2× more at +10 s and +20 s, re-resolving
 * the holder each time, then the 15-minute schedule takes over. */
export const FORWARD_LADDER = Object.freeze({ delaysMs: Object.freeze([10_000, 20_000]) as readonly number[] });
export interface ForwardLadderState { attempts: number; nextAt: number | null }
export function nextLadderState(previous: ForwardLadderState | undefined, now: number, delays: readonly number[] = FORWARD_LADDER.delaysMs): ForwardLadderState {
  const attempts = previous ? previous.attempts + 1 : 0;
  return { attempts, nextAt: attempts < delays.length ? now + delays[attempts] : null };
}
/** The fixed user template, sent THROUGH the holder (§4.2). Never free text. */
export function heldForwardNoticeText(holderNickname: string): string {
  return `I have your message; my reply is delayed while it is routed through ${holderNickname}.`;
}

/** How long one delayed-reply notice covers a topic. Matches the 6 h held-reply
 * deadline: one notice per topic per hold episode, never one per held message. */
export const HELD_NOTICE_TOPIC_COOLDOWN_MS = 6 * 3_600_000;
export type HeldNoticeSuppression = 'automation' | 'already-noticed';
/**
 * Decides whether a held send may post the fixed "I have your message; my reply
 * is delayed" notice into its topic. The notice is only true when a session was
 * replying, so background output (`server-automation`: job results, status
 * lines, restart notices) never triggers it, and a topic is told at most once
 * per cooldown however many replies are held. The hold itself, its status row
 * and its expiry report are unchanged; this gates the user-facing line only.
 */
export class HeldNoticeGate {
  readonly #noticedAt = new Map<number, number>();
  constructor(private readonly deps: { now: () => number; cooldownMs?: number }) {}
  decide(input: { topicId: number; producerKind: string | null | undefined }): { send: true } | { send: false; reason: HeldNoticeSuppression } {
    if (input.producerKind !== 'session') return { send: false, reason: 'automation' };
    const now = this.deps.now(), cooldown = this.deps.cooldownMs ?? HELD_NOTICE_TOPIC_COOLDOWN_MS;
    for (const [topic, at] of this.#noticedAt) if (now - at >= cooldown) this.#noticedAt.delete(topic);
    if (this.#noticedAt.has(input.topicId)) return { send: false, reason: 'already-noticed' };
    return { send: true };
  }
  /** Record a DELIVERED notice; an undelivered one leaves the topic eligible. */
  recordSent(topicId: number): void { this.#noticedAt.set(topicId, this.deps.now()); }
}

export interface ForwardLeaseView {
  selfMachineId: string;
  leaseHolder(): string | null;
  holdsLease(): boolean;
  isHolderHealthy(machineId: string): boolean;
}
export type LeaseRoute =
  | { kind: 'self' }
  | { kind: 'peer'; holder: string }
  | { kind: 'settling'; reason: 'no-holder' | 'self-unconfirmed' | 'holder-unhealthy' };

/** §4.2 `lease-settling` — the three states in which a lease read is not yet
 * an answer: no holder named; self named but `holdsLease()` false (the seconds
 * after a respawn); a named holder whose lease has expired (`currentHolder()`
 * has no expiry check of its own). */
export function classifyLeaseRoute(view: ForwardLeaseView): LeaseRoute {
  let holder: string | null = null;
  try { holder = view.leaseHolder(); } catch { holder = null; }
  let held = false;
  try { held = view.holdsLease(); } catch { held = false; }
  if (held) return { kind: 'self' };
  if (!holder) return { kind: 'settling', reason: 'no-holder' };
  if (holder === view.selfMachineId) return { kind: 'settling', reason: 'self-unconfirmed' };
  let healthy = false;
  try { healthy = view.isHolderHealthy(holder); } catch { healthy = false; }
  if (!healthy) return { kind: 'settling', reason: 'holder-unhealthy' };
  return { kind: 'peer', holder };
}

/** The adapter's send route for a token-holding machine. A confirmed, healthy
 * holder on another machine is forwarded to at EVERY session-pool stage: a
 * direct send from a non-holder is always held (`authorize` requires the
 * lease), so answering `local` there muted the machine until the lease came
 * back. An UNSETTLED lease settles first whenever this machine has a paired
 * peer: a direct send would be refused by `authorize` and held on the direct
 * path, which only replays when the lease comes HERE — on a standby that is
 * never, so every boot-time notice expired unsent (the Mama PC backlog). Only
 * a dark pool with no known peer keeps the direct answer (no 15 s wait). */
export function decideHolderForward(input: { switchOn: boolean; poolStage: string; route: LeaseRoute; hasPeer?: boolean }): 'forward' | 'local' | 'settling' {
  if (!input.switchOn || input.route.kind === 'self') return 'local';
  if (input.route.kind === 'peer') return 'forward';
  return input.poolStage === 'dark' && input.hasPeer !== true ? 'local' : 'settling';
}

export type SettledRoute = { kind: 'self' } | { kind: 'peer'; holder: string } | { kind: 'unsettled'; reason: LeaseRoute extends { reason: infer R } ? R : never };

/** Re-read the lease with backoff for at most `timeoutMs` BEFORE writing
 * anything. A window that never settles is the ladder's problem, not a row. */
export async function settleLeaseRoute(view: ForwardLeaseView, deps: { sleep: (ms: number) => Promise<void>; now: () => number; timeoutMs?: number }): Promise<SettledRoute> {
  const timeoutMs = deps.timeoutMs ?? FORWARD_SETTLE_TIMEOUT_MS;
  const started = deps.now();
  let delay = 250;
  let last: LeaseRoute = classifyLeaseRoute(view);
  while (last.kind === 'settling') {
    const elapsed = deps.now() - started;
    if (elapsed >= timeoutMs) return { kind: 'unsettled', reason: last.reason as never };
    await deps.sleep(Math.min(delay, Math.max(1, timeoutMs - elapsed)));
    delay = Math.min(delay * 2, 2000);
    last = classifyLeaseRoute(view);
  }
  return last as SettledRoute;
}

export type HolderSubmitResult =
  | { ok: true; messageId: number; deliveryMachineId: string; receiptJson: string }
  | { ok: false; reason: string; outcome: 'held' | 'known-failed' | 'outcome-unknown'; retryable: boolean; policyRefusal?: OriginSendPolicyRefusalDecision;
      /** The holder took CUSTODY (admitted, memory-held or dispatched) before refusing: resolved at its `receipt`, never re-sent. */
      admittedAtHolder?: boolean;
      /** native-conversation-forwarded-advisory item 2 — the holder ended its own copy in the same step that
       * recorded the verdict (present only with `policyRefusal`), and the verdict it recorded. */
      copyEnded?: true; policyVerdict?: PolicyVerdict | null };

/** Refusals after which re-resolving the holder and trying again is sound:
 * the holder is not (or no longer) the lease holder, is booting, or could not
 * be reached BEFORE a submit was sent. An `outcome-unknown` is never in it. */
const RETRYABLE_REASONS = new Set(['not-lease-holder', 'origin-peer-unreachable', 'origin-runtime-unavailable', 'origin-peer-protocol-unavailable',
  'execution-owner-mismatch', 'origin-credential-owner-required', 'origin-peer-unavailable']);

/** The single holder transport: `capabilities` then `submit`, never throwing.
 * Shared by the request-time forward, the recovery re-forward and
 * `relayOriginBot`, so the three cannot drift on what a refusal means. */
export async function submitOriginToHolder(input: {
  operation: OriginPreparedBotOperation;
  send: (command: OriginMeshCommand) => Promise<{ ok: boolean; result?: unknown; reason?: string }>;
  /** When set, a holder answering a different execution owner is refused before submit. */
  expectedOwner?: string;
}): Promise<HolderSubmitResult> {
  const base = { type: 'telegram-origin', protocol: ORIGIN_MESH_PROTOCOL } as const;
  let capabilities: { ok: boolean; result?: unknown; reason?: string };
  try { capabilities = await input.send({ ...base, action: 'capabilities' }); }
  catch { return { ok: false, reason: 'origin-peer-unreachable', outcome: 'held', retryable: true }; }
  const cap = capabilities.result as { ok?: boolean; protocol?: string; credentialOwner?: boolean; accountId?: string; executionOwnerMachineId?: string } | undefined;
  if (!capabilities.ok && capabilities.reason === 'origin-runtime-unavailable') return { ok: false, reason: 'origin-runtime-unavailable', outcome: 'held', retryable: true };
  if (!capabilities.ok || !cap?.ok || cap.protocol !== ORIGIN_MESH_PROTOCOL || !cap.credentialOwner || typeof cap.accountId !== 'string' ||
    typeof cap.executionOwnerMachineId !== 'string' || !cap.executionOwnerMachineId || cap.executionOwnerMachineId.length > 128) {
    return { ok: false, reason: 'origin-peer-protocol-unavailable', outcome: 'held', retryable: true };
  }
  if (input.expectedOwner !== undefined && cap.executionOwnerMachineId !== input.expectedOwner) {
    return { ok: false, reason: 'execution-owner-mismatch', outcome: 'held', retryable: true };
  }
  let result: { ok: boolean; result?: unknown; reason?: string };
  try { result = await input.send({ ...base, action: 'submit', operation: input.operation }); }
  catch { return { ok: false, reason: 'origin-relay-acceptance-unknown', outcome: 'outcome-unknown', retryable: false }; }
  const response = result.result as { ok?: boolean; messageId?: number; originId?: string; originReceiptConfirmed?: boolean; reason?: string;
    outcome?: string; retryable?: boolean; deliveryMachineId?: string; operationId?: string; policyRefusal?: OriginSendPolicyDecision;
    copyEnded?: unknown; policyVerdict?: unknown } | undefined;
  if (result.ok && response?.ok && response.originId === input.operation.record.originId &&
    (response as unknown as { recorded?: boolean }).recorded === true && typeof (response as unknown as { quietId?: string }).quietId === 'string') {
    throw new QuietRecordedError({ delivered: false, recorded: true, quietId: (response as unknown as { quietId: string }).quietId });
  }
  const policyRefusal = response?.policyRefusal;
  // native-conversation-forwarded-advisory item 3 — a refusal is "not sent" only when the holder says it
  // ended its own copy. An older holder keeps its row `admitted` (and may still deliver it), so its
  // refusal is CUSTODY: resolved at its receipt, never answered "not sent" to a session.
  if (policyRefusal && policyRefusal.ok === false && response?.copyEnded === true) {
    return { ok: false, reason: response?.reason ?? 'send-policy-refused', outcome: 'held', retryable: false, policyRefusal,
      copyEnded: true, policyVerdict: readPolicyVerdict(response.policyVerdict) };
  }
  if (policyRefusal && policyRefusal.ok === false) {
    return { ok: false, reason: response?.reason ?? 'send-policy-refused', outcome: 'outcome-unknown', retryable: false, admittedAtHolder: true };
  }
  if (result.ok && response?.ok && response.originId === input.operation.record.originId &&
    Number.isSafeInteger(response.messageId) && Number(response.messageId) > 0 && response.originReceiptConfirmed === true) {
    return { ok: true, messageId: response.messageId!, deliveryMachineId: typeof response.deliveryMachineId === 'string' ? response.deliveryMachineId : cap.executionOwnerMachineId,
      receiptJson: JSON.stringify({ messageId: response.messageId, deliveryMachineId: response.deliveryMachineId ?? cap.executionOwnerMachineId,
        forwardedFromMachine: input.operation.record.originMachineId, originId: response.originId }) };
  }
  const reason = response?.reason ?? (result.ok ? 'origin-relay-acceptance-unknown' : result.reason ?? 'origin-relay-acceptance-unknown');
  // A refusal that names OUR operation id came from inside the holder's
  // execution (its `admit` ran, or its outbox/credential refused AFTER it):
  // the holder's own recovery owns that row now. Treat it exactly like an
  // unknown outcome — ask that holder's `receipt`, never forward again.
  if (response?.ok === false && response.operationId === input.operation.record.operationId) {
    return { ok: false, reason, outcome: 'outcome-unknown', retryable: false, admittedAtHolder: true };
  }
  // A dispatcher-level refusal (no handler, peer booting) never reached the
  // holder's outbox: it is a definite, retryable refusal, not an unknown.
  const dispatcherRefusal = !result.ok && response === undefined;
  const outcome: 'held' | 'known-failed' | 'outcome-unknown' = dispatcherRefusal ? 'held'
    : response?.outcome === 'held' || response?.outcome === 'known-failed' ? response.outcome
    : response?.ok === false && response.outcome === undefined && typeof response.reason === 'string' ? 'held' : 'outcome-unknown';
  return { ok: false, reason, outcome,
    retryable: outcome !== 'outcome-unknown' && (response?.retryable === true || RETRYABLE_REASONS.has(reason) || dispatcherRefusal) };
}

/** `local-sent`: this machine started a LOCAL send of the held text (the lease
 * came back here) — recorded BEFORE the send, so a crash or a failed resolve
 * can never cause a second local send. */
export type ForwardLastAttempt = 'refused' | 'unreachable' | 'outcome-unknown' | 'unsettled' | 'local-sent';
/** Stored in the held row's `holdDetail`: what the recovery tick needs to
 * re-forward the SAME operation (or re-prepare it for a new holder) without
 * the original request. Never key material, never a receipt it did not get. */
export interface HeldForwardDetail {
  kind: 'forward-to-holder';
  lastAttempt: ForwardLastAttempt;
  /** The machine the LAST submit went to (an `outcome-unknown` is resolved there, never re-sent). */
  machineId: string | null;
  topicId: number;
  chatId: string;
  text: string;
  /** Preserve the original author and draft time when a holder change creates
   * a replacement operation outside the original session context. */
  authoredProducerKind?: string;
  authoredPreparedAt?: number;
  silent?: boolean;
  formatMode?: string;
  kindMetadata?: Record<string, unknown>;
  reason: string;
  at: number;
  noticeDelivered: boolean;
  /** Quick-retry ladder bookkeeping (§4.2); `nextAt: null` = exhausted, the 15-min schedule owns it. */
  ladder: ForwardLadderState;
  /** Set on an operation prepared to REPLACE one whose holder changed (§4.2 supersede). */
  supersedes?: string;
  /** native-conversation-base §3a item 7 — the execution owner's classified verdict of
   * non-delivery. The row stays `held` only to keep its text; it is ended, never retried. */
  ownerVerdict?: { outcome: 'not-delivered'; failure: FailureCause; at: number; machineId: string;
    /** native-conversation-forwarded-advisory item 6 — the outbound check refused it (never Telegram). */
    refusedBy?: 'policy'; rule?: string };
  /** §3a item 7 — the owner suppressed it with no reason (an older owner, or a row from
   * before reasons). `settled`: a second reasonless ending; unresolved, not ended. */
  ownerUnstated?: { at: number; attempts: number; settled?: boolean; machineId: string };
  /** §3a item 7 — this row is the one replacement made after a reasonless ending of `<id>`. */
  unstatedReplacementOf?: string;
  /** §3a item 2 — a late first line could not be added (part limit, producer record, refused
   * replace): the reply goes out as it is, counted `lateUnmarked`, and is not tried again. */
  lateMarkUnavailable?: boolean;
}

/** native-conversation-base §3a item 8 — which session line a forward that expired
 * while still held gets. Never taken from the row's state alone. Agrees with
 * §3b row 5 for the same row (an `ownerUnstated` row is uncertain, settled or not). */
export function forwardExpiryArm(row: Pick<HeldOperationRow, 'holdDetail'> & { policyVerdict?: HeldOperationRow['policyVerdict'] }): { arm: 'uncertain' } | { arm: 'definite'; cause: FailureCause } {
  // native-conversation-forwarded-advisory item 3 — an advisory row was handed back, not sent: its holder ended
  // its copy before any dispatch, so its `outcome-unknown` marker is not an uncertainty.
  if (readPolicyVerdict(row.policyVerdict ?? null)?.class === 'advisory') return { arm: 'definite', cause: 'deadline' };
  const detail = row.holdDetail as Partial<HeldForwardDetail> | null;
  if (detail?.lastAttempt === 'outcome-unknown' || detail?.lastAttempt === 'local-sent' || (detail?.ownerUnstated && typeof detail.ownerUnstated === 'object')) return { arm: 'uncertain' };
  const verdictCause = detail?.ownerVerdict && typeof detail.ownerVerdict === 'object' ? failureCause(detail.ownerVerdict.failure) : null;
  return { arm: 'definite', cause: verdictCause ?? 'deadline' };
}

/** §3a item 7 — the holder's `receipt` answer, read from its RAW state together
 * with its `outcome`, `reason` and `failure` fields. It deliberately does not
 * fold `suppressed` into "not accepted": an ending that states no reason is
 * never read as "definitely not delivered", which would send a second copy. */
export type HolderReceiptAnswer =
  | { state: 'accepted'; receiptJson: string }
  /** Definitely never admitted there (`no-record`, `not-admitted`), or an older owner's
   * terminal row with no `outcome` (`older-terminal`), which the ladder re-forwards as before. */
  | { state: 'not-accepted'; kind?: 'no-record' | 'not-admitted' | 'older-terminal' }
  | { state: 'owned-by-holder' } | { state: 'outcome-unknown' } | { state: 'unreachable' }
  /** The owner ended it and stated why (the closed reason set). */
  | { state: 'owner-ended'; reason: SuppressionReason }
  /** The owner's classified verdict: not delivered, with its cause (`policyRule`: the outbound check refused it). */
  | { state: 'owner-verdict'; failure: FailureCause; policyRule?: string | null }
  /** native-conversation-forwarded-advisory item 3 — the owner handed it back with an advisory and ended its copy. */
  | { state: 'owner-advisory'; verdict: PolicyVerdict }
  /** The owner ended it with no reason; `olderOwner` when its answer has no `outcome` field. */
  | { state: 'owner-reasonless'; olderOwner: boolean };

export function classifyHolderReceipt(reply: { ok: boolean; result?: unknown }, operationId: string, machineId: string): HolderReceiptAnswer {
  const result = reply.result as { ok?: boolean; state?: string; originReceiptConfirmed?: boolean; operationId?: string; messageIds?: string[];
    outcome?: unknown; reason?: unknown; failure?: unknown } | undefined;
  // `origin-receipt-unavailable` / any refusal is an UNKNOWN (a store outage looks the same as absence to an old holder): keep waiting.
  if (!reply.ok || !result?.ok || result.operationId !== operationId) return { state: 'unreachable' };
  const state = String(result.state);
  if (state === 'accepted' && result.originReceiptConfirmed === true && result.messageIds?.length === 1 && /^[1-9]\d*$/.test(result.messageIds[0])) {
    return { state: 'accepted', receiptJson: JSON.stringify({ messageId: result.messageIds[0], confirmedVia: 'receipt', deliveryMachineId: machineId, operationId }) };
  }
  if (state === 'no-record' || state === 'not-admitted') return { state: 'not-accepted', kind: state };
  const hasOutcome = Object.prototype.hasOwnProperty.call(result, 'outcome');
  // A value outside the closed sets is treated as an answer with no `outcome`.
  const outcome = hasOutcome && typeof result.outcome === 'string' && ['delivered', 'partially-delivered', 'not-delivered', 'pending', 'unknown'].includes(result.outcome) ? result.outcome : null;
  const reason = suppressionReason(result.reason);
  const failure = failureCause(result.failure);
  // native-conversation-forwarded-advisory item 3 — the outbound check ended the owner's copy.
  if (state === 'suppressed' && (reason === 'tone-advisory' || reason === 'policy-refused')) {
    const verdict = readPolicyVerdict((result as { policyVerdict?: unknown }).policyVerdict);
    if (reason === 'tone-advisory' && verdict?.class === 'advisory') return { state: 'owner-advisory', verdict };
    return { state: 'owner-verdict', failure: 'refused', policyRule: verdict?.rule ?? null };
  }
  if (state === 'suppressed') {
    if (outcome !== null && reason) return { state: 'owner-ended', reason };
    return { state: 'owner-reasonless', olderOwner: outcome === null };
  }
  if (outcome === 'not-delivered' && failure && (state === 'known-failed' || state === 'expired')) return { state: 'owner-verdict', failure };
  // Older owner (no `outcome`): the ladder's reading is unchanged — a terminal row there frees a re-forward.
  if (['known-failed', 'expired', 'superseded'].includes(state)) return outcome === null ? { state: 'not-accepted', kind: 'older-terminal' } : { state: 'unreachable' };
  // The holder has custody (its own recovery delivers it): wait, never re-forward.
  if (['admitted', 'held', 'partial', 'accepted'].includes(state)) return { state: 'owned-by-holder' };
  // The holder's own send ended unknown; it never retries or resolves it.
  if (state === 'outcome-unknown') return { state: 'outcome-unknown' };
  return { state: 'unreachable' };
}

/** History must retain the original author after a holder replacement. */
export function recoveredForwardProvenance(detail: { authoredProducerKind?: unknown } | null, producerKind?: string | null): 'agent' | 'automation' {
  const kind = detail?.authoredProducerKind ?? producerKind;
  return kind === 'session' || kind === 'imported-legacy' ? 'agent' : 'automation';
}

export interface ForwardInput { topicId: number; chatId: string; text: string; silent?: boolean; formatMode?: string; kindMetadata?: Record<string, unknown>;
  /** native-conversation-base §3a item 2 — a replacement: prepared under the original's
   * stored producer record, keeping its sealed send-policy input (the content-check key)
   * and deadline, with the original draft time sealed as `firstPreparedAt`. */
  replacement?: { record: TelegramOriginRecord; policyInput: OriginSendPolicyInput | null; firstPreparedAt: number; deadlineAt: number; maxParts: number };
  /** native-conversation-forwarded-advisory item 5 — this reply answers the handed-back reply `<id>`:
   * it is made durable by superseding that row before it is forwarded. */
  advisoryReplacementOf?: string }
export interface ForwardDeps {
  lease: ForwardLeaseView;
  /** Prepare (and record intent for) an operation whose execution owner is `holder`. */
  prepare: (holder: string, input: ForwardInput, operationId?: string) => Promise<OriginPreparedBotOperation>;
  submit: (holder: string, operation: OriginPreparedBotOperation) => Promise<HolderSubmitResult>;
  /** Make the hold DURABLE: admit locally + `recordOperationState('held', lease-not-held)`.
   * Resolves false when the state writer refused (the row stays `admitted` and the
   * ordinary local replay carries it) — audited, never silently assumed. */
  hold: (operation: OriginPreparedBotOperation, detail: HeldForwardDetail) => Promise<boolean | void>;
  /** The fixed template through the holder; resolves true when the holder accepted it. */
  notify?: (holder: string, topicId: number) => Promise<boolean>;
  /** Gates `notify`: background output and already-told topics get no notice. */
  noticeGate?: HeldNoticeGate;
  audit?: (row: Record<string, unknown>) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  settleTimeoutMs?: number;
  ladder?: { delaysMs: readonly number[] };
  /** native-conversation-forwarded-advisory item 5 — the answer's local supersede and its settlement. */
  advisory?: AdvisoryAnswerDeps;
}
export interface AdvisoryAnswerDeps {
  /** ONE transaction: retire the held original and admit + hold the replacement (false = no longer held). */
  supersede: (originalId: string, next: OriginPreparedBotOperation, detail: HeldForwardDetail) => Promise<boolean>;
  resolve: (operationId: string, deliveryMachineId: string, receiptJson: string) => Promise<boolean>;
  rehold: (operationId: string, detail: HeldForwardDetail) => Promise<boolean>;
  /** The holder handed the replacement back too: record it on the replacement's row. */
  markAdvisory: (operationId: string, verdict: PolicyVerdict) => Promise<boolean>;
  /** The holder refused the replacement: its owner verdict, `refused` by policy. */
  markRefused: (operationId: string, verdict: NonNullable<HeldForwardDetail['ownerVerdict']>) => Promise<boolean>;
  /** The session reads this verdict synchronously (the script prints it): no line for it later. */
  noteAnsweredInline: (operationId: string) => Promise<void>;
}
export type ForwardOutcome =
  | { kind: 'sent'; messageId: number; holder: string; operationId: string }
  | { kind: 'local' }
  | { kind: 'held'; operationId: string; holder: string | null; lastAttempt: ForwardLastAttempt; reason: string; noticeDelivered: boolean; noticeSuppressed?: HeldNoticeSuppression };

/** §4.1 + §4.2 — settle, ONE forward attempt, then the durable hold. The
 * remaining ladder steps belong to the recovery tick (`recoverForwardedHold`). */
export async function forwardReplyToHolder(deps: ForwardDeps, input: ForwardInput): Promise<ForwardOutcome> {
  const delays = deps.ladder?.delaysMs ?? FORWARD_LADDER.delaysMs;
  const audit = (row: Record<string, unknown>) => { try { deps.audit?.({ ts: deps.now(), topicId: input.topicId, ...row }); } catch { /* audit is observability only */ } };
  const settled = await settleLeaseRoute(deps.lease, { sleep: deps.sleep, now: deps.now, timeoutMs: deps.settleTimeoutMs });
  if (settled.kind === 'self') return { kind: 'local' };
  if (input.advisoryReplacementOf) return forwardAdvisoryAnswer(deps, input, input.advisoryReplacementOf, settled, delays, audit);
  let operation: OriginPreparedBotOperation | null = null;
  let lastHolder: string | null = null;
  let lastAttempt: ForwardLastAttempt = 'unsettled';
  let lastReason = settled.kind === 'unsettled' ? `lease-settling-${settled.reason}` : 'not-attempted';
  if (settled.kind === 'unsettled') audit({ phase: 'settle-timeout', reason: settled.reason });
  else {
    const holder = settled.holder;
    operation = await deps.prepare(holder, input);
    lastHolder = holder;
    const result = await deps.submit(holder, operation);
    if (result.ok) {
      audit({ phase: 'sent', attempt: 0, holder, operationId: operation.record.operationId, messageId: result.messageId });
      return { kind: 'sent', messageId: result.messageId, holder, operationId: operation.record.operationId };
    }
    if (result.policyRefusal) throw new OriginSendPolicyRefusal(result.policyRefusal, operation.record.operationId);
    lastReason = result.reason;
    audit({ phase: 'refused', attempt: 0, holder, operationId: operation.record.operationId, reason: result.reason, outcome: result.outcome, retryable: result.retryable });
    lastAttempt = result.outcome === 'outcome-unknown' ? 'outcome-unknown' : result.reason === 'origin-peer-unreachable' ? 'unreachable' : 'refused';
  }
  // forward-to-holder-failed → the durable hold.
  if (!operation) operation = await deps.prepare(lastHolder ?? UNRESOLVED_LEASE_HOLDER, input);
  const now = deps.now();
  const detail: HeldForwardDetail = { kind: 'forward-to-holder', lastAttempt, machineId: lastHolder, topicId: input.topicId, chatId: input.chatId,
    text: input.text, authoredProducerKind: operation.record.producerKind, authoredPreparedAt: operation.admission.preparedAt,
    ...(input.silent === undefined ? {} : { silent: input.silent }), ...(input.formatMode === undefined ? {} : { formatMode: input.formatMode }),
    ...(input.kindMetadata === undefined ? {} : { kindMetadata: input.kindMetadata }), reason: lastReason, at: now, noticeDelivered: false,
    ladder: nextLadderState(undefined, now, delays) };
  const recorded = await deps.hold(operation, detail);
  audit({ phase: recorded === false ? 'hold-not-recorded' : 'held', holder: lastHolder, operationId: operation.record.operationId, lastAttempt, reason: lastReason, ladderNextAt: detail.ladder.nextAt });
  let noticeDelivered = false;
  const gate = deps.noticeGate?.decide({ topicId: input.topicId, producerKind: operation.record.producerKind });
  const noticeSuppressed = gate && !gate.send ? gate.reason : undefined;
  // The notice is never attempted at a holder whose last answer was unknown:
  // that machine may be mid-send of the very reply the notice would precede.
  if (!noticeSuppressed && deps.notify && lastHolder && lastAttempt !== 'outcome-unknown') {
    try { noticeDelivered = await deps.notify(lastHolder, input.topicId); } catch { noticeDelivered = false; }
    if (noticeDelivered) deps.noticeGate?.recordSent(input.topicId);
  }
  audit({ phase: noticeDelivered ? 'notice-sent' : noticeSuppressed ? 'notice-suppressed' : 'notice-not-sent', holder: lastHolder, operationId: operation.record.operationId,
    ...(noticeSuppressed ? { suppressed: noticeSuppressed } : {}) });
  return { kind: 'held', operationId: operation.record.operationId, holder: lastHolder, lastAttempt, reason: lastReason, noticeDelivered,
    ...(noticeSuppressed ? { noticeSuppressed } : {}) };
}

/** native-conversation-forwarded-advisory item 5 — the author's answer to a handed-back forward. The
 * original is withdrawn BEFORE anything is sent: the replacement is made durable by a local supersede
 * (`forwardSuccessor`'s order: supersede, mark `outcome-unknown`, submit), so at every instant one row
 * carries the reply. A refused supersede (expired, already replaced) sends nothing. The holder needs
 * nothing new: it receives an ordinary new operation and reviews it in full. */
async function forwardAdvisoryAnswer(deps: ForwardDeps, input: ForwardInput, originalId: string, settled: SettledRoute,
  delays: readonly number[], audit: (row: Record<string, unknown>) => void): Promise<ForwardOutcome> {
  if (!deps.advisory) throw new AdvisoryAnswerClosedError(originalId);
  const holder = settled.kind === 'peer' ? settled.holder : null;
  const operation = await deps.prepare(holder ?? UNRESOLVED_LEASE_HOLDER, input);
  const now = deps.now();
  const detail: HeldForwardDetail = { kind: 'forward-to-holder', lastAttempt: holder ? 'outcome-unknown' : 'unsettled', machineId: holder, topicId: input.topicId, chatId: input.chatId,
    text: input.text, authoredProducerKind: operation.record.producerKind, authoredPreparedAt: operation.record.firstPreparedAt ?? operation.admission.preparedAt,
    ...(input.silent === undefined ? {} : { silent: input.silent }), ...(input.formatMode === undefined ? {} : { formatMode: input.formatMode }),
    ...(input.kindMetadata === undefined ? {} : { kindMetadata: input.kindMetadata }),
    reason: settled.kind === 'unsettled' ? `lease-settling-${settled.reason}` : 'not-attempted', at: now, noticeDelivered: false,
    ladder: nextLadderState(undefined, now, delays), supersedes: originalId };
  if (!await deps.advisory.supersede(originalId, operation, detail)) {
    audit({ phase: 'advisory-answer-closed', operationId: originalId });
    throw new AdvisoryAnswerClosedError(originalId);
  }
  const operationId = operation.record.operationId;
  audit({ phase: 'advisory-answer-superseded', operationId: originalId, supersededBy: operationId, holder });
  if (!holder) return { kind: 'held', operationId, holder: null, lastAttempt: 'unsettled', reason: detail.reason, noticeDelivered: false };
  const result = await deps.submit(holder, operation);
  if (result.ok) {
    if (!await deps.advisory.resolve(operationId, result.deliveryMachineId, result.receiptJson)) audit({ phase: 'advisory-answer-resolve-refused', operationId, holder });
    audit({ phase: 'sent', attempt: 0, holder, operationId, messageId: result.messageId });
    return { kind: 'sent', messageId: result.messageId, holder, operationId };
  }
  if (result.policyRefusal && result.copyEnded) {
    // The replacement got its own verdict, under the original's deadline (items 2 and 3).
    const verdict = result.policyVerdict;
    if (verdict?.class === 'advisory') await deps.advisory.markAdvisory(operationId, verdict);
    else await deps.advisory.markRefused(operationId, { outcome: 'not-delivered', failure: 'refused', at: deps.now(), machineId: holder, refusedBy: 'policy', ...(verdict ? { rule: verdict.rule } : {}) });
    await deps.advisory.noteAnsweredInline(operationId);
    throw new OriginSendPolicyRefusal(result.policyRefusal, operationId);
  }
  const lastAttempt = attemptKind(result);
  await deps.advisory.rehold(operationId, { ...detail, lastAttempt, reason: result.reason, at: deps.now() });
  audit({ phase: 'refused', attempt: 0, holder, operationId, reason: result.reason, outcome: result.outcome });
  return { kind: 'held', operationId, holder, lastAttempt, reason: result.reason, noticeDelivered: false };
}

export interface ForwardRecoveryDeps {
  lease: ForwardLeaseView;
  prepare: ForwardDeps['prepare'];
  submit: ForwardDeps['submit'];
  /** The old holder's `receipt` for the operation id, read by `classifyHolderReceipt`:
   * `accepted` resolves the hold; `owned-by-holder` and `unreachable` keep it;
   * `not-accepted` (never admitted there, or an older owner's terminal row)
   * frees a re-forward; `outcome-unknown`: the holder's own send ended unknown.
   * native-conversation-base §3a item 7 adds the owner's stated endings:
   * `owner-ended` (a reason), `owner-verdict` (not delivered, with its cause) and
   * `owner-reasonless` (no reason, which is never read as "not delivered"). */
  receipt: (machineId: string, operationId: string) => Promise<HolderReceiptAnswer>;
  /** Settle a local held row as outcome-unknown at `deliveryMachineId` (never re-sent). */
  settleUnknown: (operationId: string, deliveryMachineId: string) => Promise<boolean>;
  /** Resolve a local held row (the holder delivered or confirmed it). */
  resolve: (operationId: string, deliveryMachineId: string, receiptJson: string) => Promise<boolean>;
  /** Re-record the hold with an updated detail (same reason). */
  rehold: (operationId: string, detail: HeldForwardDetail) => Promise<boolean>;
  /** ATOMICALLY admit + hold the NEW operation and mark the old one superseded
   * (terminal, linked by id) in ONE store transaction. False = the old row is no
   * longer plainly held (a child left `queued` or an entry is claimed — it may
   * be delivering), in which case the new operation is NOT admitted anywhere.
   * `carrier` (§3a item 2) sets the replacement's late-mark columns. */
  supersede: (operationId: string, next: OriginPreparedBotOperation, detail: HeldForwardDetail, carrier?: { firstPreparedAt: number; lateMarkedAt: number | null }) => Promise<boolean>;
  /** This machine now holds the lease: deliver the authored text locally. */
  sendLocal: (detail: HeldForwardDetail) => Promise<{ messageId: number }>;
  /** §3a item 7 — the owner ended it with a stated reason: record `suppressed-at-holder`. */
  endAtHolder?: (operationId: string, holderReason: SuppressionReason, machineId: string, detail: HeldForwardDetail) => Promise<boolean>;
  /** §3a item 7 — merge `ownerVerdict` / `ownerUnstated` without erasing the text. */
  mergeDetail?: (operationId: string, patch: Partial<HeldForwardDetail>) => Promise<boolean>;
  /** §3a item 7/8 — the definite line for an owner verdict, in the same forward pass. */
  onOwnerVerdict?: (row: HeldOperationRow, verdict: NonNullable<HeldForwardDetail['ownerVerdict']>) => Promise<void> | void;
  /** §3a item 7 — a second reasonless ending: one session line and the per-topic item. */
  onOwnerUnstatedSettled?: (row: HeldOperationRow) => Promise<void> | void;
  /** §3a item 2 — a late reply that could not be marked (counted `lateUnmarked`). */
  onLateUnmarked?: (operationId: string) => Promise<void> | void;
  /** native-conversation-forwarded-advisory item 3 — record the holder's advisory on this machine's row
   * (keeps the text, takes it out of both delivery selections). */
  markAdvisory?: (operationId: string, verdict: PolicyVerdict) => Promise<boolean>;
  /** Item 4 — the advisory line, in the same pass when the session is live. */
  onAdvisory?: (row: HeldOperationRow) => Promise<void> | void;
  audit?: (row: Record<string, unknown>) => void;
  now: () => number;
  ladder?: { delaysMs: readonly number[] };
}
export type ForwardRecoveryOutcome = 'resolved' | 'sent' | 'settled' | 'retained' | 'skipped';

function attemptKind(result: Extract<HolderSubmitResult, { ok: false }>): ForwardLastAttempt {
  return result.outcome === 'outcome-unknown' ? 'outcome-unknown' : result.reason === 'origin-peer-unreachable' ? 'unreachable' : 'refused';
}

/** native-conversation-base §3a item 2 — a session reply is late when it is dispatched
 * more than 300 s after it was first drafted, and is marked at most once. */
export function lateMarkDue(row: Pick<HeldOperationRow, 'firstPreparedAt' | 'lateMarkedAt' | 'preparedAt' | 'holdDetail'>, operation: OriginPreparedBotOperation, now: number): number | null {
  if (row.lateMarkedAt) return null;
  if (operation.record.producerKind !== 'session' || operation.record.operationKind !== 'sendMessage') return null;
  const detail = row.holdDetail as { authoredPreparedAt?: unknown } | null;
  const first = row.firstPreparedAt ?? (typeof detail?.authoredPreparedAt === 'number' ? detail.authoredPreparedAt : row.preparedAt);
  return Number.isFinite(first) && now - first > LATE_REPLY_THRESHOLD_MS ? first : null;
}

function sealedPolicyInput(operation: OriginPreparedBotOperation): OriginSendPolicyInput | null {
  try {
    const request = JSON.parse(operation.admission.children[0]?.materializations[0]?.requestJson ?? 'null') as { policy?: OriginSendPolicyInput } | null;
    return request?.policy && typeof request.policy.text === 'string' ? request.policy : null;
  } catch { return null; }
}

/** §4.2 — recovery re-forwards the SAME operation while the holder is
 * unchanged. An attempt the holder never confirmed is resolved at THAT
 * holder's receipt first, never re-sent blind. On a holder change the old
 * record is durably SUPERSEDED (linked by operation id) and a NEW record bound
 * to the new owner is prepared and forwarded — a holder-side `submit` refuses
 * a record owned by another machine before `authorize`, so the old record can
 * never be replayed at the new owner. Each failed step advances the ladder.
 *
 * native-conversation-base §3a: a row with `ownerVerdict` returns at once (no
 * local send, no submit, no holder-change supersede); a row with `ownerUnstated`
 * moves only on the previous owner's own record; a late session reply is
 * replaced once with its first line saying so. */
export async function recoverForwardedHold(deps: ForwardRecoveryDeps, row: HeldOperationRow, operation: OriginPreparedBotOperation): Promise<ForwardRecoveryOutcome> {
  const operationId = row.operationId;
  const delays = deps.ladder?.delaysMs ?? FORWARD_LADDER.delaysMs;
  const audit = (r: Record<string, unknown>) => { try { deps.audit?.({ ts: deps.now(), phase: 'recovery', operationId, topicId: row.destination.topicId, ...r }); } catch { /* observability only */ } };
  const raw = row.holdDetail as Partial<HeldForwardDetail> | null;
  // §3a item 7 — the owner's verdict ended this reply and its session was told
  // "will not be retried". Nothing here may deliver it, on any route.
  if (raw?.ownerVerdict && typeof raw.ownerVerdict === 'object') return 'skipped';
  // native-conversation-forwarded-advisory item 3 — handed back to its author: only the author's answer
  // (a replacement) sends it. No submit, no local send, no holder-change or late-mark replacement.
  if (readPolicyVerdict(row.policyVerdict ?? null)?.class === 'advisory') return 'skipped';
  const detail: HeldForwardDetail | null = raw && raw.kind === 'forward-to-holder' && typeof raw.text === 'string' && typeof raw.chatId === 'string' && Number.isSafeInteger(raw.topicId)
    ? { ...raw as HeldForwardDetail, ladder: raw.ladder && Number.isSafeInteger(raw.ladder.attempts) ? raw.ladder : { attempts: delays.length, nextAt: null } } : null;
  const retain = async (next: Partial<HeldForwardDetail>) => {
    if (!detail) return;
    await deps.rehold(operationId, { ...detail, ...next, at: deps.now(), ladder: nextLadderState(detail.ladder, deps.now(), delays) });
  };
  /** The owner's verdict, merged without erasing the text; the definite line goes in this same pass. */
  const recordVerdict = async (machineId: string, failure: FailureCause, policyRule?: string | null, target: { row: HeldOperationRow; detail: HeldForwardDetail | null } = { row, detail }): Promise<ForwardRecoveryOutcome> => {
    const verdict: NonNullable<HeldForwardDetail['ownerVerdict']> = { outcome: 'not-delivered' as const, failure, at: deps.now(), machineId,
      ...(policyRule !== undefined ? { refusedBy: 'policy' as const, ...(policyRule ? { rule: policyRule } : {}) } : {}) };
    if (!deps.mergeDetail || !await deps.mergeDetail(target.row.operationId, { ownerVerdict: verdict })) {
      if (target.row === row) await retain({});
      audit({ outcome: 'retained-verdict-store-refused', machineId }); return 'retained';
    }
    audit({ outcome: 'owner-verdict', machineId, failure, ...(policyRule !== undefined ? { refusedBy: 'policy' } : {}) });
    try { await deps.onOwnerVerdict?.({ ...target.row, holdDetail: { ...(target.detail ?? {}), ownerVerdict: verdict } }, verdict); } catch { /* the forward-expiry pass carries the line if this one could not */ }
    return 'settled';
  };
  /** 3g item 3 — the holder handed it back with an advisory and ended its copy. */
  const recordAdvisory = async (machineId: string, verdict: PolicyVerdict, target: { row: HeldOperationRow; detail: HeldForwardDetail | null } = { row, detail }): Promise<ForwardRecoveryOutcome> => {
    if (!deps.markAdvisory || !await deps.markAdvisory(target.row.operationId, verdict)) {
      if (target.row === row) await retain({});
      audit({ outcome: 'retained-advisory-store-refused', machineId }); return 'retained';
    }
    audit({ outcome: 'owner-advisory', machineId, rule: verdict.rule });
    try {
      await deps.onAdvisory?.({ ...target.row, holdDetail: { ...(target.detail ?? {}), lastAttempt: 'outcome-unknown', machineId, ladder: { ...(target.detail?.ladder ?? { attempts: 0 }), nextAt: null } },
        policyVerdict: verdict as unknown as Record<string, unknown> });
    } catch { /* the advisory scan carries the line */ }
    return 'settled';
  };
  /** A submit answered `policyRefusal` with `copyEnded`: read it as the receipt would, without waiting for a poll. */
  const recordEndedSubmit = (machineId: string, result: Extract<HolderSubmitResult, { ok: false }>, target: { row: HeldOperationRow; detail: HeldForwardDetail | null } = { row, detail }): Promise<ForwardRecoveryOutcome> =>
    result.policyVerdict?.class === 'advisory' ? recordAdvisory(machineId, result.policyVerdict, target)
      : recordVerdict(machineId, 'refused', result.policyVerdict?.rule ?? null, target);
  const recordEnded = async (machineId: string, reason: SuppressionReason): Promise<ForwardRecoveryOutcome> => {
    if (!detail || !deps.endAtHolder || !await deps.endAtHolder(operationId, reason, machineId, detail)) { await retain({}); audit({ outcome: 'retained-ended-store-refused', machineId }); return 'retained'; }
    audit({ outcome: 'suppressed-at-holder', machineId, holderReason: reason });
    return 'settled';
  };
  const settleUnstated = async (machineId: string, attempts: number): Promise<ForwardRecoveryOutcome> => {
    const ownerUnstated = { at: deps.now(), attempts, settled: true, machineId };
    if (!deps.mergeDetail || !await deps.mergeDetail(operationId, { ownerUnstated })) { audit({ outcome: 'retained-unstated-store-refused', machineId }); return 'retained'; }
    audit({ outcome: 'owner-unstated-settled', machineId, attempts });
    try { await deps.onOwnerUnstatedSettled?.({ ...row, holdDetail: { ...(detail ?? {}), ownerUnstated } }); } catch { /* the scan and the forward-expiry pass carry it */ }
    return 'retained';
  };
  // §3a item 2 — a successor for this row (holder change, late mark, or the one
  // replacement after a reasonless ending): prepared under the original's
  // producer record, policy input and deadline, with the late line when due.
  const prepareSuccessor = async (holder: string, wantMark: boolean, markedOnly = false): Promise<{ next: OriginPreparedBotOperation; carrier: { firstPreparedAt: number; lateMarkedAt: number | null } } | null> => {
    if (!detail) return null;
    const now = deps.now();
    const first = row.firstPreparedAt ?? (typeof detail.authoredPreparedAt === 'number' ? detail.authoredPreparedAt : row.preparedAt);
    const base: ForwardInput = { topicId: detail.topicId, chatId: detail.chatId, text: detail.text, silent: detail.silent, formatMode: detail.formatMode, kindMetadata: detail.kindMetadata };
    const policyInput = sealedPolicyInput(operation);
    const recorded = operation.record.producerKind === 'session' && operation.record.originMachineId === deps.lease.selfMachineId;
    const replacement = recorded && row.deadlineAt > now
      ? { record: operation.record, policyInput, firstPreparedAt: first, deadlineAt: row.deadlineAt, maxParts: Math.max(1, operation.admission.children.length) } : undefined;
    // A row already marked keeps its line on every successor (rebuilt at the time it
    // was sealed, so "more than N" is unchanged); a newly late one is marked now.
    const markAt = row.lateMarkedAt ?? (wantMark ? now : null);
    const line = markAt !== null && replacement ? lateRecoveredReplyNotice(first, markAt) : null;
    if (line) {
      try {
        const next = await deps.prepare(holder, { ...base, text: `${line}\n\n${detail.text}`, replacement });
        return { next, carrier: { firstPreparedAt: first, lateMarkedAt: markAt } };
      } catch (error) {
        audit({ outcome: 'late-mark-unavailable', holder, reason: error instanceof Error ? error.message : 'unknown' });
      }
    }
    // The successor goes out without the line: it is recorded unmarked and counted.
    if (markAt !== null) { try { await deps.onLateUnmarked?.(operationId); } catch { /* counter only */ } }
    if (markedOnly) return null;
    try {
      const next = await deps.prepare(holder, { ...base, ...(replacement ? { replacement } : {}) });
      return { next, carrier: { firstPreparedAt: first, lateMarkedAt: null } };
    } catch (error) {
      // The recorded producer could not be re-entered: the pre-3a replacement path.
      if (!replacement) throw error;
      const next = await deps.prepare(holder, base);
      return { next, carrier: { firstPreparedAt: first, lateMarkedAt: null } };
    }
  };
  /** Make the successor durable, retire this row, then forward the successor. A
   * successor that should have carried the late line and does not is marked so it
   * is never replaced again for that reason. */
  const forwardSuccessor = async (holder: string, successor: { next: OriginPreparedBotOperation; carrier: { firstPreparedAt: number; lateMarkedAt: number | null } }, extra: Partial<HeldForwardDetail>): Promise<ForwardRecoveryOutcome> => {
    if (!detail) return 'retained';
    const now = deps.now();
    const { next } = successor;
    const { ownerUnstated: _u, ...carried } = detail;
    const unmarkedLate = (lateMarkDue(row, operation, now) !== null || !!row.lateMarkedAt) && successor.carrier.lateMarkedAt === null;
    const nextDetail: HeldForwardDetail = { ...carried, ...extra, ...(unmarkedLate ? { lateMarkUnavailable: true } : {}), machineId: holder, lastAttempt: 'refused', reason: 'not-attempted', at: now, supersedes: operationId,
      authoredPreparedAt: successor.carrier.firstPreparedAt, ladder: nextLadderState(detail.ladder, now, delays) };
    // ONE store transaction admits + holds the new row and retires the old one. A
    // refused supersede means the old row is no longer plainly held (it may be
    // delivering): the new operation is then admitted NOWHERE and nothing is sent.
    const superseded = await deps.supersede(operationId, next, nextDetail, successor.carrier);
    audit({ outcome: superseded ? 'superseded' : 'supersede-refused', holder, previousOwner: operation.record.executionOwnerMachineId, supersededBy: next.record.operationId,
      lateMarked: successor.carrier.lateMarkedAt !== null && successor.carrier.lateMarkedAt !== row.lateMarkedAt });
    if (!superseded) return 'retained';
    if (!await deps.rehold(next.record.operationId, { ...nextDetail, lastAttempt: 'outcome-unknown', at: deps.now() })) {
      audit({ outcome: 'retained-superseding-marker-store-refused', holder, operationId: next.record.operationId }); return 'retained';
    }
    const result = await deps.submit(holder, next);
    if (result.ok) {
      if (!await deps.resolve(next.record.operationId, result.deliveryMachineId, result.receiptJson)) {
        audit({ outcome: 'retained-superseding-store-refused', holder, operationId: next.record.operationId }); return 'retained';
      }
      audit({ outcome: 'sent-superseding', holder, operationId: next.record.operationId, messageId: result.messageId });
      return 'sent';
    }
    if (result.policyRefusal && result.copyEnded) {
      const nextRow: HeldOperationRow = { ...row, operationId: next.record.operationId, originId: next.record.originId, holdDetail: nextDetail as unknown as Record<string, unknown>,
        preparedAt: next.admission.preparedAt, deadlineAt: next.admission.deadlineAt, executionOwnerMachineId: holder, firstPreparedAt: successor.carrier.firstPreparedAt,
        lateMarkedAt: successor.carrier.lateMarkedAt };
      return recordEndedSubmit(holder, result, { row: nextRow, detail: { ...nextDetail, lastAttempt: 'outcome-unknown' } });
    }
    await deps.rehold(next.record.operationId, { ...nextDetail, reason: result.reason, lastAttempt: attemptKind(result), at: deps.now() });
    audit({ outcome: 'retained-superseding', holder, operationId: next.record.operationId, reason: result.reason, resultOutcome: result.outcome });
    return 'retained';
  };

  // §3a item 7 — a reasonless ending keeps its uncertainty across a lease change:
  // before any local send and before any holder-change supersede, the previous
  // owner is asked for its own record. Only that record moves the row.
  if (detail?.ownerUnstated && typeof detail.ownerUnstated === 'object') {
    const previous = detail.ownerUnstated.machineId || detail.machineId;
    if (!previous) { audit({ outcome: 'retained-owner-unstated-no-owner' }); return 'retained'; }
    const answer = await deps.receipt(previous, operationId);
    if (answer.state === 'accepted') {
      if (!await deps.resolve(operationId, previous, answer.receiptJson)) { audit({ outcome: 'retained-receipt-store-refused', machineId: previous }); return 'retained'; }
      audit({ outcome: 'resolved-by-receipt', machineId: previous }); return 'resolved';
    }
    if (answer.state === 'owner-advisory') return recordAdvisory(previous, answer.verdict);
    if (answer.state === 'owner-verdict') return recordVerdict(previous, answer.failure, answer.policyRule);
    if (answer.state === 'owner-ended') return recordEnded(previous, answer.reason);
    if (answer.state === 'outcome-unknown') {
      if (await deps.settleUnknown(operationId, previous)) { audit({ outcome: 'settled-holder-outcome-unknown', machineId: previous }); return 'settled'; }
      audit({ outcome: 'retained-settle-refused', machineId: previous }); return 'retained';
    }
    if (answer.state === 'not-accepted' && (answer.kind === 'no-record' || answer.kind === 'not-admitted')) {
      // The owner's own record says it never had it: clear the uncertainty, the ordinary route runs next tick.
      const { ownerUnstated: _cleared, ...rest } = detail;
      await deps.rehold(operationId, { ...rest, lastAttempt: 'refused', at: deps.now(), ladder: nextLadderState(undefined, deps.now(), delays) });
      audit({ outcome: 'owner-unstated-cleared', machineId: previous }); return 'retained';
    }
    if (answer.state === 'owner-reasonless' && !detail.ownerUnstated.settled) return settleUnstated(previous, detail.ownerUnstated.attempts + 1);
    audit({ outcome: detail.ownerUnstated.settled ? 'retained-owner-unstated-settled' : 'retained-owner-unstated', machineId: previous, answer: answer.state });
    return 'retained';
  }

  if (detail?.lastAttempt === 'outcome-unknown' && detail.machineId) {
    const answer = await deps.receipt(detail.machineId, operationId);
    if (answer.state === 'accepted') {
      if (!await deps.resolve(operationId, detail.machineId, answer.receiptJson)) {
        await retain({ lastAttempt: 'outcome-unknown', machineId: detail.machineId });
        audit({ outcome: 'retained-receipt-store-refused', machineId: detail.machineId }); return 'retained';
      }
      audit({ outcome: 'resolved-by-receipt', machineId: detail.machineId });
      return 'resolved';
    }
    if (answer.state === 'outcome-unknown') {
      if (await deps.settleUnknown(operationId, detail.machineId)) {
        audit({ outcome: 'settled-holder-outcome-unknown', machineId: detail.machineId });
        return 'settled';
      }
      await retain({}); audit({ outcome: 'retained-settle-refused', machineId: detail.machineId }); return 'retained';
    }
    if (answer.state === 'unreachable' || answer.state === 'owned-by-holder') {
      await retain({}); audit({ outcome: answer.state === 'unreachable' ? 'retained-outcome-unknown' : 'retained-owned-by-holder', machineId: detail.machineId }); return 'retained';
    }
    // §3a item 7 — the owner stated a cause: the forwarder records it and stops.
    if (answer.state === 'owner-ended') return recordEnded(detail.machineId, answer.reason);
    if (answer.state === 'owner-advisory') return recordAdvisory(detail.machineId, answer.verdict);
    if (answer.state === 'owner-verdict') return recordVerdict(detail.machineId, answer.failure, answer.policyRule);
    if (answer.state === 'owner-reasonless') {
      const holder = detail.machineId;
      // A second reasonless ending (this row is already the one replacement), or a
      // newer owner's row from before reasons: settled, unresolved, nothing sent.
      if (!answer.olderOwner || detail.unstatedReplacementOf) return settleUnstated(holder, detail.unstatedReplacementOf ? 2 : 1);
      // Against an older owner the reply is replaced ONCE, with fresh sealed times
      // (the old owner's timestamp rule then sees a fresh reply) and the original's
      // deadline and content-check key. The old id is never re-submitted.
      if (!deps.mergeDetail || !await deps.mergeDetail(operationId, { ownerUnstated: { at: deps.now(), attempts: 1, machineId: holder } })) {
        audit({ outcome: 'retained-unstated-store-refused', machineId: holder }); return 'retained';
      }
      let successor: Awaited<ReturnType<typeof prepareSuccessor>>;
      try { successor = await prepareSuccessor(holder, lateMarkDue(row, operation, deps.now()) !== null); }
      catch { audit({ outcome: 'retained-unstated-replacement-unavailable', holder }); return 'retained'; }
      if (!successor) return 'retained';
      return forwardSuccessor(holder, successor, { unstatedReplacementOf: operationId });
    }
    // Definitely not accepted. Clear the uncertainty; the next tick dispatches.
    await retain({ lastAttempt: 'refused' });
    audit({ outcome: 'outcome-unknown-cleared', machineId: detail.machineId });
    return 'retained';
  }
  const route = classifyLeaseRoute(deps.lease);
  if (route.kind === 'settling') { await retain({ reason: `lease-settling-${route.reason}` }); audit({ outcome: 'retained-settling', reason: route.reason }); return 'retained'; }
  if (detail?.lastAttempt === 'local-sent') {
    // A local send was STARTED and its resolve did not land (crash, store
    // refusal). The user may already have it: never send again; the row rides to
    // its deadline and expires with the honest "may or may not" wording.
    audit({ outcome: 'retained-local-sent-unconfirmed' }); return 'retained';
  }
  if (route.kind === 'self') {
    if (!detail) { audit({ outcome: 'retained-no-detail' }); return 'retained'; }
    // Mark BEFORE sending: the marker, not the send, is what makes a second
    // local send structurally impossible.
    if (!await deps.rehold(operationId, { ...detail, lastAttempt: 'local-sent', machineId: deps.lease.selfMachineId, at: deps.now(), ladder: nextLadderState(detail.ladder, deps.now(), delays) })) {
      audit({ outcome: 'retained-marker-store-refused' }); return 'retained';
    }
    // Left behind 21: this local send is not late-marked; it is counted unmarked.
    if (lateMarkDue(row, operation, deps.now()) !== null) { try { await deps.onLateUnmarked?.(operationId); } catch { /* counter only */ } }
    const sent = await deps.sendLocal(detail);
    const resolved = await deps.resolve(operationId, deps.lease.selfMachineId, JSON.stringify({ messageId: sent.messageId, deliveryMachineId: deps.lease.selfMachineId, supersededLocally: true }));
    audit({ outcome: resolved ? 'sent-locally' : 'sent-locally-resolve-refused', messageId: sent.messageId });
    return resolved ? 'sent' : 'retained';
  }
  const holder = route.holder;
  const late = !!detail && !detail.lateMarkUnavailable && lateMarkDue(row, operation, deps.now()) !== null;
  if (operation.record.executionOwnerMachineId === holder && late) {
    // §3a item 2 — the same holder, a late reply: replace it once with the first line.
    // If the line cannot be added, it goes out as it is and is never tried again.
    let marked: Awaited<ReturnType<typeof prepareSuccessor>> = null;
    try { marked = await prepareSuccessor(holder, true, true); } catch { marked = null; }
    if (marked) return forwardSuccessor(holder, marked, {});
    await deps.rehold(operationId, { ...detail!, lateMarkUnavailable: true });
    detail!.lateMarkUnavailable = true;
  }
  if (operation.record.executionOwnerMachineId === holder) {
    if (!detail) return 'retained';
    // Mark custody uncertainty BEFORE the RPC. If the standby store refuses
    // the receipt afterward, the next tick asks this holder; it never submits
    // the same potentially delivered message again.
    if (!await deps.rehold(operationId, { ...detail, machineId: holder, lastAttempt: 'outcome-unknown', at: deps.now(), ladder: nextLadderState(detail.ladder, deps.now(), delays) })) {
      audit({ outcome: 'retained-marker-store-refused', holder }); return 'retained';
    }
    const result = await deps.submit(holder, operation);
    if (result.ok) {
      if (!await deps.resolve(operationId, result.deliveryMachineId, result.receiptJson)) {
        audit({ outcome: 'retained-store-refused', holder, messageId: result.messageId }); return 'retained';
      }
      audit({ outcome: 'sent', holder, messageId: result.messageId });
      return 'sent';
    }
    // 3g item 3 — the holder ended its copy with a verdict: never re-forwarded.
    if (result.policyRefusal && result.copyEnded) return recordEndedSubmit(holder, result);
    await retain({ machineId: holder, reason: result.reason, lastAttempt: attemptKind(result) });
    audit({ outcome: 'retained', holder, reason: result.reason, resultOutcome: result.outcome });
    return 'retained';
  }
  // Holder changed (or was never resolved), or a late reply is replaced with its
  // first line: supersede with a NEW operation bound to the holder. The new row
  // is made durable FIRST, then the old one is retired, then the forward runs —
  // at every instant exactly one durable row carries the reply.
  if (!detail) { audit({ outcome: 'retained-holder-changed-no-detail', holder }); return 'retained'; }
  const successor = await prepareSuccessor(holder, late && !detail.lateMarkUnavailable);
  if (!successor) return 'retained';
  return forwardSuccessor(holder, successor, {});
}

/** §4.2 — three topics held on one standby within 1 h collapse to one item.
 *
 * Item ids are EPISODE-scoped (`telegram-origin-held:<topic>:<episodeStart>`).
 * The attention store dedupes by id forever, so a per-topic id raised once made
 * every later hold on that topic silent: on 2026-10-19 a reply to topic 48154
 * was held for hours while the item from 2026-10-11 still stood open, and no
 * one was told. An episode is a topic's run of holds with gaps under the window;
 * a hold after a quiet window is a new episode and a new item. */
export class HeldForwardItemCollapser {
  readonly #held = new Map<number, number>();
  readonly #since = new Map<number, number>();
  #aggregateSince: number | null = null;
  constructor(private readonly deps: { now: () => number; windowMs?: number; threshold?: number }) {}
  /** Returns the item id to raise for this topic, or the aggregate id once the
   * threshold is crossed (and which per-topic ids the aggregate supersedes). */
  record(topicId: number): { itemId: string; aggregate: boolean; supersedes: string[] } {
    const now = this.deps.now(), windowMs = this.deps.windowMs ?? 3_600_000, threshold = this.deps.threshold ?? 3;
    for (const [topic, at] of this.#held) if (now - at > windowMs) { this.#held.delete(topic); this.#since.delete(topic); }
    // An aggregate episode lasts while the held set stays at or above the threshold. It
    // ends the moment the set drops below it (not only when it empties): one topic that
    // keeps refreshing would otherwise pin the old aggregate id, and a later burst of
    // three would be deduped silent under it.
    if (this.#held.size < threshold) this.#aggregateSince = null;
    this.#held.set(topicId, now);
    if (!this.#since.has(topicId)) this.#since.set(topicId, now);
    if (this.#held.size >= threshold) {
      this.#aggregateSince ??= now;
      return { itemId: `telegram-origin-held:aggregate:${this.#aggregateSince}`, aggregate: true,
        supersedes: [...this.#held.keys()].map(t => `telegram-origin-held:${t}:${this.#since.get(t)}`) };
    }
    return { itemId: `telegram-origin-held:${topicId}:${this.#since.get(topicId)}`, aggregate: false, supersedes: [] };
  }
  topics(): number[] { return [...this.#held.keys()]; }
  clear(topicId: number): void { this.#held.delete(topicId); this.#since.delete(topicId); }
}

/** One expiry item per expired operation: the store marks each expiry reported
 * once, so a per-operation id never repeats and never folds into an older one. */
export function heldExpiryItemId(row: Pick<HeldOperationRow, 'operationId' | 'destination'>): string {
  return `telegram-origin-held:${row.destination.topicId ?? 'unknown'}:expired:${row.operationId}`;
}

/** The attention item for an expired hold. The id stays per operation (each expiry is
 * reported once), but the conditionKey is per TOPIC, so further expiries for that topic
 * land on the same open row (its count goes up) instead of a new row each time
 * (2026-11-02: ~750 open rows, 109 for one topic, rode every pooled attention read). */
export function heldExpiryItem(row: HeldOperationRow): { id: string; conditionKey: string; category: string; priority: 'HIGH'; title: string; summary: string; sourceContext: string } {
  const topic = row.destination.topicId ?? 'unknown';
  return {
    id: heldExpiryItemId(row),
    conditionKey: `telegram-origin-held:${topic}:expired`,
    category: 'telegram-origin',
    priority: 'HIGH',
    title: `Held reply to ${topicRef(row.destination.topicId ?? '?')} expired`,
    summary: expiredForwardWording(row),
    sourceContext: 'telegram-origin-forward-to-holder',
  };
}

/** native-conversation-base §3a item 8 — the hub item for a reply handed back to its
 * author: the held-expiry item's id and per-topic condition, worded by its arm (an owner
 * verdict names its cause instead of claiming the deadline passed). */
export function handBackItem(row: HeldOperationRow): ReturnType<typeof heldExpiryItem> {
  const item = heldExpiryItem(row);
  const arm = forwardExpiryArm(row);
  const verdict = (row.holdDetail as Partial<HeldForwardDetail> | null)?.ownerVerdict;
  if (arm.arm === 'definite' && verdict && typeof verdict === 'object') {
    const topic = row.destination.topicId ?? 'the topic';
    const cause = arm.cause === 'refused' ? (verdict.refusedBy === 'policy' ? 'the outbound check refused it' : 'Telegram refused it') : arm.cause === 'never-left' ? 'it could not be sent before its attempts ran out' : 'it passed its delivery deadline';
    return { ...item, title: `Held reply to ${topicRef(topic)} not delivered`, summary: `My reply to ${topicRef(topic)} was not delivered (${cause}). The session that wrote it was told.` };
  }
  return item;
}

/** Honest expiry wording (§4.2): a definite non-delivery vs an unknown one. */
export function expiredForwardWording(row: HeldOperationRow): string {
  const topic = row.destination.topicId ?? 'the topic';
  const hours = Math.max(1, Math.round((row.deadlineAt - row.preparedAt) / 3_600_000));
  return forwardExpiryArm(row).arm === 'uncertain'
    ? `My reply to ${topicRef(topic)} may or may not have been delivered; the sending machine did not confirm within ${hours} h.`
    : `I could not deliver my reply to ${topicRef(topic)} within ${hours} h.`;
}

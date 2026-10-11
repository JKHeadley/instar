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
      admittedAtHolder?: boolean };

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
    outcome?: string; retryable?: boolean; deliveryMachineId?: string; operationId?: string; policyRefusal?: OriginSendPolicyDecision } | undefined;
  const policyRefusal = response?.policyRefusal;
  if (policyRefusal && policyRefusal.ok === false) {
    return { ok: false, reason: response?.reason ?? 'send-policy-refused', outcome: 'held', retryable: false, policyRefusal };
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
}

export interface ForwardInput { topicId: number; chatId: string; text: string; silent?: boolean; formatMode?: string; kindMetadata?: Record<string, unknown> }
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
  audit?: (row: Record<string, unknown>) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  settleTimeoutMs?: number;
  ladder?: { delaysMs: readonly number[] };
}
export type ForwardOutcome =
  | { kind: 'sent'; messageId: number; holder: string; operationId: string }
  | { kind: 'local' }
  | { kind: 'held'; operationId: string; holder: string | null; lastAttempt: ForwardLastAttempt; reason: string; noticeDelivered: boolean };

/** §4.1 + §4.2 — settle, ONE forward attempt, then the durable hold. The
 * remaining ladder steps belong to the recovery tick (`recoverForwardedHold`). */
export async function forwardReplyToHolder(deps: ForwardDeps, input: ForwardInput): Promise<ForwardOutcome> {
  const delays = deps.ladder?.delaysMs ?? FORWARD_LADDER.delaysMs;
  const audit = (row: Record<string, unknown>) => { try { deps.audit?.({ ts: deps.now(), topicId: input.topicId, ...row }); } catch { /* audit is observability only */ } };
  const settled = await settleLeaseRoute(deps.lease, { sleep: deps.sleep, now: deps.now, timeoutMs: deps.settleTimeoutMs });
  if (settled.kind === 'self') return { kind: 'local' };
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
    text: input.text, ...(input.silent === undefined ? {} : { silent: input.silent }), ...(input.formatMode === undefined ? {} : { formatMode: input.formatMode }),
    ...(input.kindMetadata === undefined ? {} : { kindMetadata: input.kindMetadata }), reason: lastReason, at: now, noticeDelivered: false,
    ladder: nextLadderState(undefined, now, delays) };
  const recorded = await deps.hold(operation, detail);
  audit({ phase: recorded === false ? 'hold-not-recorded' : 'held', holder: lastHolder, operationId: operation.record.operationId, lastAttempt, reason: lastReason, ladderNextAt: detail.ladder.nextAt });
  let noticeDelivered = false;
  // The notice is never attempted at a holder whose last answer was unknown:
  // that machine may be mid-send of the very reply the notice would precede.
  if (deps.notify && lastHolder && lastAttempt !== 'outcome-unknown') {
    try { noticeDelivered = await deps.notify(lastHolder, input.topicId); } catch { noticeDelivered = false; }
  }
  audit({ phase: noticeDelivered ? 'notice-sent' : 'notice-not-sent', holder: lastHolder, operationId: operation.record.operationId });
  return { kind: 'held', operationId: operation.record.operationId, holder: lastHolder, lastAttempt, reason: lastReason, noticeDelivered };
}

export interface ForwardRecoveryDeps {
  lease: ForwardLeaseView;
  prepare: ForwardDeps['prepare'];
  submit: ForwardDeps['submit'];
  /** The old holder's `receipt` for the operation id: `accepted` resolves the
   * hold; `owned-by-holder` (admitted/held there — its own recovery delivers)
   * and `unreachable` keep it; only a definite non-accepted state (no record,
   * never admitted, expired, failed) frees a re-forward. */
  receipt: (machineId: string, operationId: string) => Promise<{ state: 'accepted'; receiptJson: string } | { state: 'not-accepted' } | { state: 'owned-by-holder' } | { state: 'unreachable' }>;
  /** Resolve a local held row (the holder delivered or confirmed it). */
  resolve: (operationId: string, deliveryMachineId: string, receiptJson: string) => Promise<boolean>;
  /** Re-record the hold with an updated detail (same reason). */
  rehold: (operationId: string, detail: HeldForwardDetail) => Promise<void>;
  /** ATOMICALLY admit + hold the NEW operation and mark the old one superseded
   * (terminal, linked by id) in ONE store transaction. False = the old row is no
   * longer plainly held (a child left `queued` or an entry is claimed — it may
   * be delivering), in which case the new operation is NOT admitted anywhere. */
  supersede: (operationId: string, next: OriginPreparedBotOperation, detail: HeldForwardDetail) => Promise<boolean>;
  /** This machine now holds the lease: deliver the authored text locally. */
  sendLocal: (detail: HeldForwardDetail) => Promise<{ messageId: number }>;
  audit?: (row: Record<string, unknown>) => void;
  now: () => number;
  ladder?: { delaysMs: readonly number[] };
}
export type ForwardRecoveryOutcome = 'resolved' | 'sent' | 'retained' | 'skipped';

function attemptKind(result: Extract<HolderSubmitResult, { ok: false }>): ForwardLastAttempt {
  return result.outcome === 'outcome-unknown' ? 'outcome-unknown' : result.reason === 'origin-peer-unreachable' ? 'unreachable' : 'refused';
}

/** §4.2 — recovery re-forwards the SAME operation while the holder is
 * unchanged. An attempt the holder never confirmed is resolved at THAT
 * holder's receipt first, never re-sent blind. On a holder change the old
 * record is durably SUPERSEDED (linked by operation id) and a NEW record bound
 * to the new owner is prepared and forwarded — a holder-side `submit` refuses
 * a record owned by another machine before `authorize`, so the old record can
 * never be replayed at the new owner. Each failed step advances the ladder. */
export async function recoverForwardedHold(deps: ForwardRecoveryDeps, row: HeldOperationRow, operation: OriginPreparedBotOperation): Promise<ForwardRecoveryOutcome> {
  const operationId = row.operationId;
  const delays = deps.ladder?.delaysMs ?? FORWARD_LADDER.delaysMs;
  const audit = (r: Record<string, unknown>) => { try { deps.audit?.({ ts: deps.now(), phase: 'recovery', operationId, topicId: row.destination.topicId, ...r }); } catch { /* observability only */ } };
  const raw = row.holdDetail as Partial<HeldForwardDetail> | null;
  const detail: HeldForwardDetail | null = raw && raw.kind === 'forward-to-holder' && typeof raw.text === 'string' && typeof raw.chatId === 'string' && Number.isSafeInteger(raw.topicId)
    ? { ...raw as HeldForwardDetail, ladder: raw.ladder && Number.isSafeInteger(raw.ladder.attempts) ? raw.ladder : { attempts: delays.length, nextAt: null } } : null;
  const retain = async (next: Partial<HeldForwardDetail>) => {
    if (!detail) return;
    await deps.rehold(operationId, { ...detail, ...next, at: deps.now(), ladder: nextLadderState(detail.ladder, deps.now(), delays) });
  };
  if (detail?.lastAttempt === 'outcome-unknown' && detail.machineId) {
    const answer = await deps.receipt(detail.machineId, operationId);
    if (answer.state === 'accepted') {
      await deps.resolve(operationId, detail.machineId, answer.receiptJson);
      audit({ outcome: 'resolved-by-receipt', machineId: detail.machineId });
      return 'resolved';
    }
    if (answer.state === 'unreachable' || answer.state === 'owned-by-holder') {
      await retain({}); audit({ outcome: answer.state === 'unreachable' ? 'retained-outcome-unknown' : 'retained-owned-by-holder', machineId: detail.machineId }); return 'retained';
    }
    // Definitely not accepted there: safe to forward again.
    audit({ outcome: 'outcome-unknown-cleared', machineId: detail.machineId });
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
    await deps.rehold(operationId, { ...detail, lastAttempt: 'local-sent', machineId: deps.lease.selfMachineId, at: deps.now(), ladder: nextLadderState(detail.ladder, deps.now(), delays) });
    const sent = await deps.sendLocal(detail);
    const resolved = await deps.resolve(operationId, deps.lease.selfMachineId, JSON.stringify({ messageId: sent.messageId, deliveryMachineId: deps.lease.selfMachineId, supersededLocally: true }));
    audit({ outcome: resolved ? 'sent-locally' : 'sent-locally-resolve-refused', messageId: sent.messageId });
    return 'sent';
  }
  const holder = route.holder;
  if (operation.record.executionOwnerMachineId === holder) {
    const result = await deps.submit(holder, operation);
    if (result.ok) {
      await deps.resolve(operationId, result.deliveryMachineId, result.receiptJson);
      audit({ outcome: 'sent', holder, messageId: result.messageId });
      return 'sent';
    }
    await retain({ machineId: holder, reason: result.reason, lastAttempt: attemptKind(result) });
    audit({ outcome: 'retained', holder, reason: result.reason, resultOutcome: result.outcome });
    return 'retained';
  }
  // Holder changed (or was never resolved): supersede with a NEW operation
  // bound to the new owner. The new row is made durable FIRST, then the old
  // one is retired, then the forward runs — at every instant exactly one
  // durable row carries the reply, so a crash between steps loses nothing.
  if (!detail) { audit({ outcome: 'retained-holder-changed-no-detail', holder }); return 'retained'; }
  const now = deps.now();
  const next = await deps.prepare(holder, { topicId: detail.topicId, chatId: detail.chatId, text: detail.text, silent: detail.silent, formatMode: detail.formatMode, kindMetadata: detail.kindMetadata });
  const nextDetail: HeldForwardDetail = { ...detail, machineId: holder, lastAttempt: 'refused', reason: 'not-attempted', at: now, supersedes: operationId,
    ladder: nextLadderState(detail.ladder, now, delays) };
  // ONE store transaction admits + holds the new row and retires the old one. A
  // refused supersede means the old row is no longer plainly held (it may be
  // delivering): the new operation is then admitted NOWHERE and nothing is sent.
  const superseded = await deps.supersede(operationId, next, nextDetail);
  audit({ outcome: superseded ? 'superseded' : 'supersede-refused', holder, previousOwner: operation.record.executionOwnerMachineId, supersededBy: next.record.operationId });
  if (!superseded) return 'retained';
  const result = await deps.submit(holder, next);
  if (result.ok) {
    await deps.resolve(next.record.operationId, result.deliveryMachineId, result.receiptJson);
    audit({ outcome: 'sent-superseding', holder, operationId: next.record.operationId, messageId: result.messageId });
    return 'sent';
  }
  await deps.rehold(next.record.operationId, { ...nextDetail, reason: result.reason, lastAttempt: attemptKind(result), at: deps.now() });
  audit({ outcome: 'retained-superseding', holder, operationId: next.record.operationId, reason: result.reason, resultOutcome: result.outcome });
  return 'retained';
}

/** §4.2 — three topics held on one standby within 1 h collapse to one item. */
export class HeldForwardItemCollapser {
  readonly #held = new Map<number, number>();
  constructor(private readonly deps: { now: () => number; windowMs?: number; threshold?: number }) {}
  /** Returns the item id to raise for this topic, or the aggregate id once the
   * threshold is crossed (and which per-topic ids the aggregate supersedes). */
  record(topicId: number): { itemId: string; aggregate: boolean; supersedes: string[] } {
    const now = this.deps.now(), windowMs = this.deps.windowMs ?? 3_600_000, threshold = this.deps.threshold ?? 3;
    for (const [topic, at] of this.#held) if (now - at > windowMs) this.#held.delete(topic);
    this.#held.set(topicId, now);
    if (this.#held.size >= threshold) {
      return { itemId: 'telegram-origin-held:aggregate', aggregate: true, supersedes: [...this.#held.keys()].map(t => `telegram-origin-held:${t}`) };
    }
    return { itemId: `telegram-origin-held:${topicId}`, aggregate: false, supersedes: [] };
  }
  topics(): number[] { return [...this.#held.keys()]; }
  clear(topicId: number): void { this.#held.delete(topicId); }
}

/** Honest expiry wording (§4.2): a definite non-delivery vs an unknown one. */
export function expiredForwardWording(row: HeldOperationRow): string {
  const detail = row.holdDetail as Partial<HeldForwardDetail> | null;
  const topic = row.destination.topicId ?? 'the topic';
  const hours = Math.max(1, Math.round((row.deadlineAt - row.preparedAt) / 3_600_000));
  return detail?.lastAttempt === 'outcome-unknown' || detail?.lastAttempt === 'local-sent'
    ? `My reply to topic ${topic} may or may not have been delivered; the sending machine did not confirm within ${hours} h.`
    : `I could not deliver my reply to topic ${topic} within ${hours} h.`;
}

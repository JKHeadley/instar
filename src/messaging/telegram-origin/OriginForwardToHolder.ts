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
import { createHash } from 'node:crypto';
import type { OriginAuditRecord } from './StoreTypes.js';
import { classifyOperationOutcome } from './OriginOperationOutcome.js';

/** Only a durable Telegram receipt may turn a recovered hold into a topic
 * history row. Follow a lease-transfer supersession to the delivered copy. */
/** Follow `supersededBy` links from `operationId` to the row with no successor
 * (standby-durable-forward-without-token §2). Recovery only: chain-following
 * for the outcome route belongs to native-conversation-base slice 3b. A visited set stops a cycle; a
 * successor whose row is missing (pruned) is `missing`, never the last row seen.
 * A chain only grows by a supersede, which the ladder and deadline bound, so the
 * walk needs no numeric cap. */
export async function followSupersedeChain(operationId: string, getOperation: (id: string) => Promise<OriginAuditRecord | null>):
  Promise<{ kind: 'terminal'; operationId: string; audit: OriginAuditRecord | null } | { kind: 'missing'; operationId: string } | { kind: 'cycle'; operationId: string }> {
  const seen = new Set<string>();
  let id = operationId;
  let audit = await getOperation(id);
  for (;;) {
    seen.add(id);
    const next = (audit?.operation?.holdDetail as { supersededBy?: unknown } | null)?.supersededBy;
    if (typeof next !== 'string' || next === id) return { kind: 'terminal', operationId: id, audit };
    if (seen.has(next)) return { kind: 'cycle', operationId: next };
    const successor = await getOperation(next);
    if (!successor) return { kind: 'missing', operationId: next };
    id = next; audit = successor;
  }
}

export async function confirmedRecoveredForward(row: HeldOperationRow, getOperation: (id: string) => Promise<OriginAuditRecord | null>): Promise<{ topicId: number; text: string; messageId: number } | null> {
  const detail = row.holdDetail as { text?: unknown } | null;
  const topicId = Number(row.destination.topicId);
  if (typeof detail?.text !== 'string' || !Number.isSafeInteger(topicId) || topicId < 1) return null;
  const end = await followSupersedeChain(row.operationId, getOperation);
  if (end.kind !== 'terminal') return null;
  const deliveredId = end.operationId;
  const audit = end.audit;
  const verdict = classifyOperationOutcome(deliveredId, audit, []);
  if (verdict.outcome !== 'delivered' || verdict.messageIds.length !== 1) return null;
  return { topicId, text: detail.text, messageId: Number(verdict.messageIds[0]) };
}

export const HOLD_REASON_LEASE_NOT_HELD = 'lease-not-held';
/** Execution owner recorded on a hold taken while NO holder could be named.
 * Never a real machine, so recovery always re-prepares for the holder it finds. */
export const UNRESOLVED_LEASE_HOLDER = 'lease-holder-unresolved';
/** The bot account a token-less standby seals a hold with when the holder
 * could not be asked (standby-durable-forward-without-token §1). The same string a
 * token-less boot already uses for its runtime (TelegramOriginBoot). Never a real
 * account: the holder refuses it, and recovery re-seals it to the live account. */
export const UNRESOLVED_TOKENLESS_ACCOUNT = 'unresolved-tokenless-source';

/** Notice-class sends (§8): never turned into durable holds on a token-less
 * machine. A delay notice delivered after its reply is worse than none, and an
 * expiry report that is itself held could expire and raise another. */
export const NOTICE_CLASS_PRODUCERS: ReadonlySet<string> = new Set(['reply-delivery-notice', 'held-forward-notice', 'attention-hub-post', 'held-expiry-report']);
export function isNoticeClass(kindMetadata: Record<string, unknown> | undefined): boolean {
  const cls = kindMetadata?.noticeClass;
  return typeof cls === 'string' && NOTICE_CLASS_PRODUCERS.has(cls);
}

/** A validated holder `capabilities` answer: the live bot account and owner. */
export interface HolderCapabilities { accountId: string; executionOwnerMachineId: string }
export type HolderProbe = { ok: true; capabilities: HolderCapabilities } | { ok: false; reason: string };

/** Validate a raw `capabilities` reply. Anything but a credential owner with a
 * numeric account id and a bounded owner id is treated as unreachable (§1). */
export function validHolderCapabilities(reply: { ok: boolean; result?: unknown; reason?: string }): HolderProbe {
  const cap = reply.result as { ok?: boolean; protocol?: string; credentialOwner?: boolean; accountId?: unknown; executionOwnerMachineId?: unknown } | undefined;
  if (!reply.ok && reply.reason === 'origin-runtime-unavailable') return { ok: false, reason: 'origin-runtime-unavailable' };
  if (!reply.ok || !cap?.ok || cap.protocol !== ORIGIN_MESH_PROTOCOL || !cap.credentialOwner || typeof cap.accountId !== 'string' || !/^\d+$/.test(cap.accountId) ||
    typeof cap.executionOwnerMachineId !== 'string' || !cap.executionOwnerMachineId || cap.executionOwnerMachineId.length > 128) {
    return { ok: false, reason: 'origin-peer-protocol-unavailable' };
  }
  return { ok: true, capabilities: { accountId: cap.accountId, executionOwnerMachineId: cap.executionOwnerMachineId } };
}

/** Deterministic successor id for a supersede (§2): `<root>~r<hop>-<plan8>`. The
 * plan part digests only fields stable across prepares (content, sealed account,
 * owner, destination, child count): child and materialization ids are fresh
 * random values on every prepare, so they can never be part of it. */
export function supersedingOperationId(previousOperationId: string, plan: { contentDigest: string; accountId: string; owner: string; destination: unknown; children: number }): string {
  const m = /^(.*)~r(\d+)-[0-9a-f]{8}$/.exec(previousOperationId);
  const root = m ? m[1] : previousOperationId;
  const hop = m ? Number(m[2]) + 1 : 1;
  const plan8 = createHash('sha256').update(JSON.stringify([plan.contentDigest, plan.accountId, plan.owner, plan.destination, plan.children])).digest('hex').slice(0, 8);
  return `${root}~r${hop}-${plan8}`;
}
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
  /** A validated answer already read in this attempt: skips the second read (§1). */
  capabilities?: HolderCapabilities;
}): Promise<HolderSubmitResult> {
  const base = { type: 'telegram-origin', protocol: ORIGIN_MESH_PROTOCOL } as const;
  let cap: HolderCapabilities;
  if (input.capabilities) cap = input.capabilities;
  else {
    let capabilities: { ok: boolean; result?: unknown; reason?: string };
    try { capabilities = await input.send({ ...base, action: 'capabilities' }); }
    catch { return { ok: false, reason: 'origin-peer-unreachable', outcome: 'held', retryable: true }; }
    const raw = capabilities.result as { ok?: boolean; protocol?: string; credentialOwner?: boolean; accountId?: string; executionOwnerMachineId?: string } | undefined;
    if (!capabilities.ok && capabilities.reason === 'origin-runtime-unavailable') return { ok: false, reason: 'origin-runtime-unavailable', outcome: 'held', retryable: true };
    if (!capabilities.ok || !raw?.ok || raw.protocol !== ORIGIN_MESH_PROTOCOL || !raw.credentialOwner || typeof raw.accountId !== 'string' ||
      typeof raw.executionOwnerMachineId !== 'string' || !raw.executionOwnerMachineId || raw.executionOwnerMachineId.length > 128) {
      return { ok: false, reason: 'origin-peer-protocol-unavailable', outcome: 'held', retryable: true };
    }
    cap = { accountId: raw.accountId, executionOwnerMachineId: raw.executionOwnerMachineId };
  }
  if (input.expectedOwner !== undefined && cap.executionOwnerMachineId !== input.expectedOwner) {
    return { ok: false, reason: 'execution-owner-mismatch', outcome: 'held', retryable: true };
  }
  let result: { ok: boolean; result?: unknown; reason?: string };
  try { result = await input.send({ ...base, action: 'submit', operation: input.operation }); }
  catch { return { ok: false, reason: 'origin-relay-acceptance-unknown', outcome: 'outcome-unknown', retryable: false }; }
  const response = result.result as { ok?: boolean; messageId?: number; originId?: string; originReceiptConfirmed?: boolean; reason?: string;
    outcome?: string; retryable?: boolean; deliveryMachineId?: string; operationId?: string; policyRefusal?: OriginSendPolicyDecision } | undefined;
  if (result.ok && response?.ok && response.originId === input.operation.record.originId &&
    (response as unknown as { recorded?: boolean }).recorded === true && typeof (response as unknown as { quietId?: string }).quietId === 'string') {
    throw new QuietRecordedError({ delivered: false, recorded: true, quietId: (response as unknown as { quietId: string }).quietId });
  }
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
}

/** History must retain the original author after a holder replacement. */
export function recoveredForwardProvenance(detail: { authoredProducerKind?: unknown } | null, producerKind?: string | null): 'agent' | 'automation' {
  const kind = detail?.authoredProducerKind ?? producerKind;
  return kind === 'session' || kind === 'imported-legacy' ? 'agent' : 'automation';
}

export interface ForwardInput { topicId: number; chatId: string; text: string; silent?: boolean; formatMode?: string; kindMetadata?: Record<string, unknown> }
export interface ForwardDeps {
  lease: ForwardLeaseView;
  /** Prepare (and record intent for) an operation whose execution owner is `holder`. */
  prepare: (holder: string, input: ForwardInput, operationId?: string, accountId?: string) => Promise<OriginPreparedBotOperation>;
  submit: (holder: string, operation: OriginPreparedBotOperation, capabilities?: HolderCapabilities) => Promise<HolderSubmitResult>;
  /** Set on a machine with no bot token (§1, §4): every attempt reads the holder's
   * `capabilities` first, seals with that live account (or the placeholder when
   * the holder cannot be asked), and a `self` settle never becomes a local send. */
  tokenless?: boolean;
  /** One `capabilities` read to `holder` (required when `tokenless`). */
  probe?: (holder: string) => Promise<HolderProbe>;
  /** Fired (never awaited) after a successful probe: re-post hub notices that found the holder unreachable (§8). */
  onHolderReachable?: () => unknown;
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
  const tokenless = deps.tokenless === true;
  // A token-less machine has no transport of its own: a `self` settle is a hold,
  // never a local send (standby-durable-forward-without-token §4).
  if (settled.kind === 'self' && !tokenless) return { kind: 'local' };
  let operation: OriginPreparedBotOperation | null = null;
  let lastHolder: string | null = null;
  let lastAttempt: ForwardLastAttempt = 'unsettled';
  let lastReason = settled.kind === 'unsettled' ? `lease-settling-${settled.reason}` : settled.kind === 'self' ? 'self-no-transport' : 'not-attempted';
  if (settled.kind === 'unsettled') audit({ phase: 'settle-timeout', reason: settled.reason });
  else if (settled.kind === 'self') audit({ phase: 'self-no-transport' });
  else if (tokenless) {
    // §1: read the holder first, then seal with its live account. One read per attempt.
    const holder = settled.holder;
    lastHolder = holder;
    const probe = deps.probe ? await deps.probe(holder).catch((): HolderProbe => ({ ok: false, reason: 'origin-peer-unreachable' })) : { ok: false as const, reason: 'probe-unavailable' };
    if (!probe.ok) {
      lastReason = probe.reason; lastAttempt = 'unreachable';
      operation = await deps.prepare(holder, input, undefined, UNRESOLVED_TOKENLESS_ACCOUNT);
      audit({ phase: 'refused', attempt: 0, holder, operationId: operation.record.operationId, reason: probe.reason, tokenless: true });
    } else {
      try { void Promise.resolve(deps.onHolderReachable?.()).catch(() => undefined); } catch { /* @silent-fallback-ok — reporting only; never changes delivery */ }
      operation = await deps.prepare(holder, input, undefined, probe.capabilities.accountId);
      const result = await deps.submit(holder, operation, probe.capabilities);
      if (result.ok) {
        audit({ phase: 'sent', attempt: 0, holder, operationId: operation.record.operationId, messageId: result.messageId, tokenless: true });
        return { kind: 'sent', messageId: result.messageId, holder, operationId: operation.record.operationId };
      }
      if (result.policyRefusal) throw new OriginSendPolicyRefusal(result.policyRefusal, operation.record.operationId);
      lastReason = result.reason;
      audit({ phase: 'refused', attempt: 0, holder, operationId: operation.record.operationId, reason: result.reason, outcome: result.outcome, retryable: result.retryable, tokenless: true });
      lastAttempt = result.outcome === 'outcome-unknown' ? 'outcome-unknown' : result.reason === 'origin-peer-unreachable' ? 'unreachable' : 'refused';
    }
  } else {
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
  if (!operation) operation = tokenless ? await deps.prepare(lastHolder ?? UNRESOLVED_LEASE_HOLDER, input, undefined, UNRESOLVED_TOKENLESS_ACCOUNT)
    : await deps.prepare(lastHolder ?? UNRESOLVED_LEASE_HOLDER, input);
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

export interface ForwardRecoveryDeps {
  lease: ForwardLeaseView;
  prepare: ForwardDeps['prepare'];
  submit: ForwardDeps['submit'];
  /** See `ForwardDeps.tokenless` / `probe`. */
  tokenless?: boolean;
  probe?: ForwardDeps['probe'];
  onHolderReachable?: ForwardDeps['onHolderReachable'];
  /** A concrete seal no longer matches the holder's bot (§2): never re-sealed automatically. */
  onAccountChanged?: (input: { operationId: string; topicId: string | null; sealedAccountId: string; liveAccountId: string }) => Promise<void> | void;
  /** A placeholder seal was replaced by the live account (evidence only, §10). */
  onResealed?: (operationId: string) => void;
  /** The old holder's `receipt` for the operation id: `accepted` resolves the
   * hold; `owned-by-holder` (admitted/held there — its own recovery delivers)
   * and `unreachable` keep it; only a definite non-accepted state (no record,
   * never admitted, expired, failed) frees a re-forward. `outcome-unknown`: the
   * holder's own send ended unknown and it will never retry or resolve it, so
   * waiting for it is pointless and re-forwarding could duplicate it. */
  receipt: (machineId: string, operationId: string) => Promise<{ state: 'accepted'; receiptJson: string } | { state: 'not-accepted' } | { state: 'owned-by-holder' } | { state: 'outcome-unknown' } | { state: 'unreachable' }>;
  /** Settle a local held row as outcome-unknown at `deliveryMachineId` (never re-sent). */
  settleUnknown: (operationId: string, deliveryMachineId: string) => Promise<boolean>;
  /** Resolve a local held row (the holder delivered or confirmed it). */
  resolve: (operationId: string, deliveryMachineId: string, receiptJson: string) => Promise<boolean>;
  /** Re-record the hold with an updated detail (same reason). */
  rehold: (operationId: string, detail: HeldForwardDetail) => Promise<boolean>;
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
export type ForwardRecoveryOutcome = 'resolved' | 'sent' | 'settled' | 'retained' | 'skipped';

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
    // Definitely not accepted there. Clear the uncertainty and let the next
    // recovery tick review current conversation before another dispatch.
    await retain({ lastAttempt: 'refused' });
    audit({ outcome: 'outcome-unknown-cleared', machineId: detail.machineId });
    return 'retained';
  }
  const route = classifyLeaseRoute(deps.lease);
  if (route.kind === 'settling') { await retain({ reason: `lease-settling-${route.reason}` }); audit({ outcome: 'retained-settling', reason: route.reason }); return 'retained'; }
  const tokenless = deps.tokenless === true;
  if (route.kind === 'self' && tokenless) {
    // §4: no local transport. Retain WITHOUT the `local-sent` marker, exactly like settling,
    // so the row re-forwards once a credentialed machine holds the lease again.
    await retain({ reason: 'self-no-transport' }); audit({ outcome: 'retained-self-no-transport' }); return 'retained';
  }
  // §1–2: a token-less machine reads the holder once per pass, before anything is prepared.
  let live: HolderCapabilities | undefined;
  if (tokenless && route.kind !== 'self') {
    const probe = deps.probe ? await deps.probe(route.holder).catch((): HolderProbe => ({ ok: false, reason: 'origin-peer-unreachable' })) : { ok: false as const, reason: 'probe-unavailable' };
    if (!probe.ok) {
      // No attempt reached the holder: keep the ladder where it is (§2), so an outage never burns the row's tries.
      if (detail) await deps.rehold(operationId, { ...detail, machineId: route.holder, reason: probe.reason, lastAttempt: 'unreachable', at: deps.now() });
      audit({ outcome: 'retained-holder-unreachable', holder: route.holder, reason: probe.reason }); return 'retained';
    }
    live = probe.capabilities;
    try { void Promise.resolve(deps.onHolderReachable?.()).catch(() => undefined); } catch { /* @silent-fallback-ok — reporting only; never changes delivery */ }
    const sealed = operation.record.destination.accountId;
    if (sealed !== UNRESOLVED_TOKENLESS_ACCOUNT && sealed !== live.accountId) {
      // A concrete seal is never re-sealed automatically: a swapped holder must not
      // be able to re-send held content under another bot.
      await retain({ machineId: route.holder, reason: 'account-changed', lastAttempt: 'refused' });
      try { await deps.onAccountChanged?.({ operationId, topicId: row.destination.topicId, sealedAccountId: sealed, liveAccountId: live.accountId }); } catch { /* @silent-fallback-ok — reporting only; never changes delivery */ }
      audit({ outcome: 'account-changed', holder: route.holder, sealedAccountId: sealed, liveAccountId: live.accountId }); return 'retained';
    }
  }
  const resealNeeded = live !== undefined && operation.record.destination.accountId === UNRESOLVED_TOKENLESS_ACCOUNT;
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
    const sent = await deps.sendLocal(detail);
    const resolved = await deps.resolve(operationId, deps.lease.selfMachineId, JSON.stringify({ messageId: sent.messageId, deliveryMachineId: deps.lease.selfMachineId, supersededLocally: true }));
    audit({ outcome: resolved ? 'sent-locally' : 'sent-locally-resolve-refused', messageId: sent.messageId });
    return resolved ? 'sent' : 'retained';
  }
  const holder = route.holder;
  if (operation.record.executionOwnerMachineId === holder && !resealNeeded) {
    if (!detail) return 'retained';
    // Mark custody uncertainty BEFORE the RPC. If the standby store refuses
    // the receipt afterward, the next tick asks this holder; it never submits
    // the same potentially delivered message again.
    if (!await deps.rehold(operationId, { ...detail, machineId: holder, lastAttempt: 'outcome-unknown', at: deps.now(), ladder: nextLadderState(detail.ladder, deps.now(), delays) })) {
      audit({ outcome: 'retained-marker-store-refused', holder }); return 'retained';
    }
    const result = live ? await deps.submit(holder, operation, live) : await deps.submit(holder, operation);
    if (result.ok) {
      if (!await deps.resolve(operationId, result.deliveryMachineId, result.receiptJson)) {
        audit({ outcome: 'retained-store-refused', holder, messageId: result.messageId }); return 'retained';
      }
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
  const nextInput = { topicId: detail.topicId, chatId: detail.chatId, text: detail.text, silent: detail.silent, formatMode: detail.formatMode, kindMetadata: detail.kindMetadata };
  // Token-less: the placeholder is replaced by the live account, a concrete seal is
  // KEPT across a holder change (§2), and the successor id is deterministic.
  const nextAccount = tokenless ? (resealNeeded ? live!.accountId : operation.record.destination.accountId) : undefined;
  const nextId = tokenless ? supersedingOperationId(operationId, { contentDigest: operation.record.contentDigest, accountId: nextAccount!, owner: holder,
    destination: { chatId: operation.record.destination.chatId, topicId: operation.record.destination.topicId }, children: operation.admission.children.length }) : undefined;
  const next = tokenless ? await deps.prepare(holder, nextInput, nextId, nextAccount) : await deps.prepare(holder, nextInput);
  if (tokenless && next.record.destination.accountId === UNRESOLVED_TOKENLESS_ACCOUNT) { audit({ outcome: 'retained-reseal-placeholder-refused', holder }); return 'retained'; }
  if (resealNeeded) {
    audit({ outcome: 'account-reseal', holder, supersededBy: next.record.operationId });
    try { deps.onResealed?.(next.record.operationId); } catch { /* @silent-fallback-ok — evidence only; never changes delivery */ }
  }
  const nextDetail: HeldForwardDetail = { ...detail, machineId: holder, lastAttempt: 'refused', reason: 'not-attempted', at: now, supersedes: operationId,
    ladder: nextLadderState(detail.ladder, now, delays) };
  // ONE store transaction admits + holds the new row and retires the old one. A
  // refused supersede means the old row is no longer plainly held (it may be
  // delivering): the new operation is then admitted NOWHERE and nothing is sent.
  const superseded = await deps.supersede(operationId, next, nextDetail);
  audit({ outcome: superseded ? 'superseded' : 'supersede-refused', holder, previousOwner: operation.record.executionOwnerMachineId, supersededBy: next.record.operationId });
  if (!superseded) return 'retained';
  if (!await deps.rehold(next.record.operationId, { ...nextDetail, lastAttempt: 'outcome-unknown', at: deps.now() })) {
    audit({ outcome: 'retained-superseding-marker-store-refused', holder, operationId: next.record.operationId }); return 'retained';
  }
  const result = live ? await deps.submit(holder, next, live) : await deps.submit(holder, next);
  if (result.ok) {
    if (!await deps.resolve(next.record.operationId, result.deliveryMachineId, result.receiptJson)) {
      audit({ outcome: 'retained-superseding-store-refused', holder, operationId: next.record.operationId }); return 'retained';
    }
    audit({ outcome: 'sent-superseding', holder, operationId: next.record.operationId, messageId: result.messageId });
    return 'sent';
  }
  await deps.rehold(next.record.operationId, { ...nextDetail, reason: result.reason, lastAttempt: attemptKind(result), at: deps.now() });
  audit({ outcome: 'retained-superseding', holder, operationId: next.record.operationId, reason: result.reason, resultOutcome: result.outcome });
  return 'retained';
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

/** Honest expiry wording (§4.2): a definite non-delivery vs an unknown one. */
export function expiredForwardWording(row: HeldOperationRow): string {
  const detail = row.holdDetail as Partial<HeldForwardDetail> | null;
  const topic = row.destination.topicId ?? 'the topic';
  const hours = Math.max(1, Math.round((row.deadlineAt - row.preparedAt) / 3_600_000));
  return detail?.lastAttempt === 'outcome-unknown' || detail?.lastAttempt === 'local-sent'
    ? `My reply to ${topicRef(topic)} may or may not have been delivered; the sending machine did not confirm within ${hours} h.`
    : `I could not deliver my reply to ${topicRef(topic)} within ${hours} h.`;
}

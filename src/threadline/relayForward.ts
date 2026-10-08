/**
 * relayForward — the decision logic of docs/specs/a2a-cross-machine-route.md,
 * kept out of routes.ts / server.ts so the unit tests run the same code the
 * server runs.
 *
 * A relay STANDBY machine of mine has no relay client, so every send it makes
 * answers 503. This module lets it hand the send, once, over the signed mesh
 * RPC to my machine that HOLDS the relay connection:
 *
 *  - RelayHolderFinder — which of my machines holds the relay (parallel
 *    `/threadline/health` probes: own fingerprint + `relay.state: connected`).
 *  - RelayForwarder    — one `a2a-relay-forward` attempt and its classification.
 *  - handleRelayForwardCommand — the holder: a loopback POST to its own
 *    `/threadline/relay-send`, marked with a boot-time in-memory secret.
 *  - buildForwardAnswer — what the standby's caller is told and what is settled.
 *  - handleTopicReplyInjectCommand / askTopicOwner — a topic-bound reply typed
 *    into the topic's live session on whichever machine has it.
 *
 * Fail direction everywhere: a forward that did not execute is today's 503; an
 * answer is transcribed, never upgraded; unknown is `unconfirmed`; a reply that
 * cannot be injected is the existing visible Telegram post.
 */

import crypto from 'node:crypto';
import type { MeshCommand } from '../core/MeshRpc.js';
import type { MeshRpcClientResult } from '../core/MeshRpcClient.js';
import { resolveDevAgentGate } from '../core/devAgentGate.js';
import { checkFingerprintHealth, fetchErrorCode } from './backupRoutes.js';

export type RelayForwardCommand = Extract<MeshCommand, { type: 'a2a-relay-forward' }>;
export type TopicReplyInjectCommand = Extract<MeshCommand, { type: 'a2a-topic-reply-inject' }>;

/** The loopback header that carries the boot secret. Lower-case (Node header key). */
export const RELAY_FORWARD_HEADER = 'x-instar-a2a-forward';

export const FORWARD_TIMEOUT_MS = 15_000;
export const HOLDER_LOOPBACK_TIMEOUT_MS = 12_000;
export const HOLDER_PROBE_BUDGET_MS = 2_000;
export const HOLDER_CACHE_TTL_MS = 60_000;
export const HOLDER_PROBE_MAX_PEERS = 8;
/** ONE budget for every ask a topic-bound reply makes (spec §5). */
export const TOPIC_REPLY_BUDGET_MS = 12_000;
const MAX_INJECT_TEXT_BYTES = 64 * 1024;

// ── Gate ─────────────────────────────────────────────────────────────

/** The live gate: `enabled` omitted ⇒ the dev-agent gate decides. */
export function resolveRelayForwardEnabled(
  liveEnabled: boolean | undefined,
  config: { developmentAgent?: boolean; threadline?: { relayForward?: { enabled?: boolean } } },
): boolean {
  const explicit = liveEnabled ?? config.threadline?.relayForward?.enabled;
  return resolveDevAgentGate(explicit, config);
}

// ── Boot secret ──────────────────────────────────────────────────────

/** A fresh in-memory secret. Never written to env, config or logs. */
export function createForwardSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Constant-time comparison of the presented header against the boot secret.
 * Both sides are hashed first so `timingSafeEqual` always sees equal lengths
 * (a length mismatch must not be observable, and must not throw).
 */
export function forwardSecretMatches(expected: string | null | undefined, presented: unknown): boolean {
  if (typeof expected !== 'string' || expected.length < 32) return false;
  if (typeof presented !== 'string' || presented.length === 0) return false;
  const a = crypto.createHash('sha256').update(expected).digest();
  const b = crypto.createHash('sha256').update(presented).digest();
  return crypto.timingSafeEqual(a, b);
}

/** A message id the holder will honour from a forwarded request. */
export function isForwardableMessageId(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(v);
}

/** A routing fingerprint (the sender's own nickname resolution). */
export function isForwardedFingerprint(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{16,64}$/i.test(v);
}

// ── Counters + log line ──────────────────────────────────────────────

/** In-memory counters on the authed /health (graduation evidence). */
export interface RelayForwardCounters {
  /** Sender: the holder answered and the answer was transcribed. */
  forwarded: number;
  /** Sender: the forward did not execute (today's 503). */
  notExecuted: number;
  /** Sender: a timeout or a reasonless non-200 (`unconfirmed`). */
  unconfirmed: number;
  /** Holder: forwarded requests run through the route. */
  holderHandled: number;
  /** Holder: forwarded requests refused before the route (gate off, standby, bad payload). */
  holderRefused: number;
  /** Holder: asks sent to a topic's machine for a reply. */
  replyAsks: number;
  /** Holder: replies a topic's machine reported injected. */
  replyInjected: number;
  /** Holder: topic-bound replies that ended in the visible Telegram post. */
  replyFailureVisible: number;
  /** Receiver: reply injects this machine performed for a holder. */
  injectsReceived: number;
}

export function createRelayForwardCounters(): RelayForwardCounters {
  return {
    forwarded: 0, notExecuted: 0, unconfirmed: 0, holderHandled: 0, holderRefused: 0,
    replyAsks: 0, replyInjected: 0, replyFailureVisible: 0, injectsReceived: 0,
  };
}

/** The one server-log line the sender writes per forward attempt. */
export function forwardLogLine(messageId: string, machine: string, outcome: string): string {
  return `[a2a-forward] id=${messageId} to=${machine || 'none'} outcome=${outcome}`;
}

// ── Finding the holder ───────────────────────────────────────────────

export interface ForwardPeer {
  machineId: string;
  /** The URL the health probe is read from and the forward goes over. */
  url: string;
  nickname?: string;
}

export interface RelayHolderFinderDeps {
  /** My active peer machines (never this machine). */
  listPeers: () => ForwardPeer[];
  /** This machine's own routing fingerprint, or null when none resolves. */
  ownFingerprint: () => string | null;
  /** Injected for tests; defaults to global fetch. */
  fetchFn?: (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
  now?: () => number;
  ttlMs?: number;
  probeBudgetMs?: number;
  maxPeers?: number;
}

/**
 * Which of my machines holds the relay connection. A peer qualifies when its
 * unauthenticated `/threadline/health` shows `relay.state === 'connected'` AND
 * a `fingerprint` equal to this machine's own (same agent identity). The
 * answer is a HINT cached for 60 seconds; the holder's own 503 guard is the
 * authority, and any forward failure drops the cache.
 */
export class RelayHolderFinder {
  private readonly d: RelayHolderFinderDeps;
  private cached: { peer: ForwardPeer; at: number } | null = null;

  constructor(deps: RelayHolderFinderDeps) {
    this.d = deps;
  }

  private now(): number {
    return this.d.now ? this.d.now() : Date.now();
  }

  drop(): void {
    this.cached = null;
  }

  async find(): Promise<ForwardPeer | null> {
    const ttl = this.d.ttlMs ?? HOLDER_CACHE_TTL_MS;
    if (this.cached && this.now() - this.cached.at < ttl) return this.cached.peer;
    this.cached = null;

    let ownFp: string | null = null;
    let peers: ForwardPeer[] = [];
    try {
      ownFp = this.d.ownFingerprint();
      peers = this.d.listPeers().filter((p) => p && typeof p.url === 'string' && p.url).slice(0, this.d.maxPeers ?? HOLDER_PROBE_MAX_PEERS);
    } catch {
      // @silent-fallback-ok — an unreadable identity or peer list means no holder is found ⇒ today's 503.
      return null;
    }
    if (!ownFp || peers.length === 0) return null;

    const fetchFn = this.d.fetchFn
      ?? ((url, init) => fetch(url, init as RequestInit) as unknown as Promise<{ ok: boolean; json: () => Promise<unknown> }>);
    const controller = new AbortController();
    const budget = this.d.probeBudgetMs ?? HOLDER_PROBE_BUDGET_MS;
    const want = ownFp;

    const found = await new Promise<ForwardPeer | null>((resolve) => {
      let pending = peers.length;
      let done = false;
      const finish = (peer: ForwardPeer | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        controller.abort();
        resolve(peer);
      };
      const timer = setTimeout(() => finish(null), budget);
      for (const peer of peers) {
        void (async () => {
          try {
            const res = await fetchFn(peer.url.replace(/\/$/, '') + '/threadline/health', { signal: controller.signal });
            let body: unknown = null;
            try { body = await res.json(); } catch { /* @silent-fallback-ok — no body ⇒ fingerprint absent ⇒ not the holder */ }
            if (checkFingerprintHealth(res.ok, body, want).ok) { finish(peer); return; }
          } catch {
            // @silent-fallback-ok — an unreachable peer is simply not the holder.
          }
          if (--pending === 0) finish(null);
        })();
      }
    });

    if (found) this.cached = { peer: found, at: this.now() };
    return found;
  }
}

// ── The holder's verdict on the wire ─────────────────────────────────

/** What the holder's `a2a-relay-forward` handler returns (inside the mesh `result`). */
export type RelayForwardVerbResult =
  /** The holder's own route answered; status + body are transcribed unchanged. */
  | { outcome: 'answered'; status: number; body: Record<string, unknown> }
  /** The holder sent nothing (gate off, standby, bad payload, its own 503). */
  | { outcome: 'refused'; reason: string }
  /** The holder cannot say whether its route sent (loopback timeout, unreadable answer). */
  | { outcome: 'unknown'; reason: string };

export type ForwardOutcome =
  | { kind: 'no-holder' }
  /** The forward did not execute — proves only that the forward sent nothing. */
  | { kind: 'not-executed'; machine: ForwardPeer; reason: string }
  | { kind: 'answered'; machine: ForwardPeer; status: number; body: Record<string, unknown> }
  | { kind: 'unconfirmed'; machine: ForwardPeer; reason: string };

export interface RelayForwarderDeps {
  finder: Pick<RelayHolderFinder, 'find' | 'drop'>;
  /** One signed mesh send. Throws ONLY on a transport error / timeout. */
  send: (peer: ForwardPeer, command: RelayForwardCommand, timeoutMs: number) => Promise<MeshRpcClientResult>;
  timeoutMs?: number;
}

/** Classify one mesh answer to `a2a-relay-forward` (spec §4). */
export function classifyForwardResult(peer: ForwardPeer, res: MeshRpcClientResult): ForwardOutcome {
  if (res.ok) {
    const r = (res.result ?? null) as Partial<RelayForwardVerbResult> & { status?: unknown; body?: unknown; reason?: unknown } | null;
    if (r && r.outcome === 'refused') {
      return { kind: 'not-executed', machine: peer, reason: typeof r.reason === 'string' && r.reason ? r.reason : 'holder-refused' };
    }
    if (r && r.outcome === 'answered' && typeof r.status === 'number' && r.body && typeof r.body === 'object') {
      // The holder's own 503 guard: it sent nothing.
      if (r.status === 503) return { kind: 'not-executed', machine: peer, reason: 'holder-relay-not-connected' };
      return { kind: 'answered', machine: peer, status: r.status, body: r.body as Record<string, unknown> };
    }
    return { kind: 'unconfirmed', machine: peer, reason: r && r.outcome === 'unknown' && typeof r.reason === 'string' ? r.reason : 'unreadable-holder-answer' };
  }
  // A typed mesh rejection: the dispatcher refused before the handler ran.
  if (typeof res.reason === 'string' && res.reason) return { kind: 'not-executed', machine: peer, reason: res.reason };
  // "mesh-rpc not configured" (503 with no reason): no dispatcher, nothing ran.
  if (res.status === 503) return { kind: 'not-executed', machine: peer, reason: 'mesh-rpc-not-configured' };
  return { kind: 'unconfirmed', machine: peer, reason: `http-${res.status}` };
}

/** One attempt, no retry. Never throws. */
export class RelayForwarder {
  private readonly d: RelayForwarderDeps;
  constructor(deps: RelayForwarderDeps) {
    this.d = deps;
  }

  async forward(command: RelayForwardCommand): Promise<ForwardOutcome> {
    let peer: ForwardPeer | null = null;
    try {
      peer = await this.d.finder.find();
    } catch {
      // @silent-fallback-ok — no holder found ⇒ today's 503.
      peer = null;
    }
    if (!peer) return { kind: 'no-holder' };

    let outcome: ForwardOutcome;
    try {
      const res = await this.d.send(peer, command, this.d.timeoutMs ?? FORWARD_TIMEOUT_MS);
      outcome = classifyForwardResult(peer, res);
    } catch (err) {
      // A refused connection sent nothing; anything else (a timeout, a reset
      // mid-flight) may have reached the holder, so it is unknown.
      outcome = fetchErrorCode(err) === 'ECONNREFUSED'
        ? { kind: 'not-executed', machine: peer, reason: 'connection-refused' }
        : { kind: 'unconfirmed', machine: peer, reason: (err as { name?: string } | null)?.name === 'AbortError' ? 'timeout' : 'transport-error' };
    }
    if (outcome.kind !== 'answered') this.d.finder.drop();
    return outcome;
  }
}

// ── The holder ───────────────────────────────────────────────────────

export interface RelayForwardHandlerDeps {
  /** The live gate on THIS machine. */
  enabled: () => boolean;
  /** Boot-time: this machine's relay client is absent because it is a standby. */
  relaySuppressedByStandby: () => boolean;
  /** The boot secret the route recognises. */
  secret: string;
  /** This server's own loopback base URL. */
  loopbackUrl: string;
  authToken: string;
  fetchFn?: (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ status: number; json: () => Promise<unknown> }>;
  timeoutMs?: number;
  counters?: RelayForwardCounters;
}

/**
 * The holder side of `a2a-relay-forward`: run the complete ordinary relay-send
 * route by a loopback call marked with the boot secret. `sender` is the
 * AUTHENTICATED mesh sender; it becomes `forwardedFromMachine`.
 */
export async function handleRelayForwardCommand(
  command: RelayForwardCommand,
  sender: string,
  deps: RelayForwardHandlerDeps,
): Promise<RelayForwardVerbResult> {
  const refuse = (reason: string): RelayForwardVerbResult => {
    if (deps.counters) deps.counters.holderRefused++;
    return { outcome: 'refused', reason };
  };
  let enabled = false;
  try { enabled = deps.enabled(); } catch { enabled = false; /* @silent-fallback-ok — an unreadable gate is off ⇒ refuse ⇒ the sender's 503 */ }
  if (!enabled) return refuse('relay-forward-disabled');
  // Loop stop: a standby never runs a forwarded send (it would only forward again).
  if (deps.relaySuppressedByStandby()) return refuse('holder-is-standby');
  if (typeof command.targetAgent !== 'string' || !command.targetAgent
    || typeof command.body !== 'string' || !command.body
    || !isForwardableMessageId(command.messageId)) {
    return refuse('invalid-payload');
  }

  // inReplyTo and originSessionName are NEVER sent: checks keyed on the sending
  // session ran on the sender.
  const body: Record<string, unknown> = {
    targetAgent: command.targetAgent,
    message: command.body,
    waitForReply: false,
    messageId: command.messageId,
    resend: command.resend === true,
    forwardedFromMachine: sender,
  };
  if (isForwardedFingerprint(command.resolvedFp)) body.resolvedFp = command.resolvedFp;
  if (typeof command.threadId === 'string' && command.threadId) body.threadId = command.threadId;
  if (typeof command.originTopicId === 'number') body.originTopicId = command.originTopicId;
  if (typeof command.purpose === 'string' && command.purpose) body.purpose = command.purpose;

  const fetchFn = deps.fetchFn
    ?? ((url, init) => fetch(url, init as RequestInit) as unknown as Promise<{ status: number; json: () => Promise<unknown> }>);
  let res: { status: number; json: () => Promise<unknown> };
  try {
    res = await fetchFn(deps.loopbackUrl.replace(/\/$/, '') + '/threadline/relay-send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${deps.authToken}`,
        [RELAY_FORWARD_HEADER]: deps.secret,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(deps.timeoutMs ?? HOLDER_LOOPBACK_TIMEOUT_MS),
    });
  } catch (err) {
    if (fetchErrorCode(err) === 'ECONNREFUSED') return refuse('holder-loopback-refused');
    return { outcome: 'unknown', reason: 'holder-loopback-error' };
  }
  // The route's own 503 guard runs before the relay send: nothing was sent.
  if (res.status === 503) return refuse('holder-relay-not-connected');
  if (deps.counters) deps.counters.holderHandled++;
  let parsed: unknown = null;
  try { parsed = await res.json(); } catch { /* @silent-fallback-ok — an unreadable answer is unknown, never a success */ }
  if (!parsed || typeof parsed !== 'object') return { outcome: 'unknown', reason: 'holder-answer-unreadable' };
  return { outcome: 'answered', status: res.status, body: parsed as Record<string, unknown> };
}

// ── What the standby's caller is told (spec §4) ──────────────────────

export interface ForwardAnswer {
  status: number;
  body: Record<string, unknown>;
  /** Outbox outcome for the sender's settlement line, when one is written. */
  settlementOutcome?: 'relay-sent' | 'relay-queued' | 'relay-unconfirmed';
  /** A short, log-safe outcome label. */
  label: string;
}

/**
 * Transcribe a forward outcome. `null` means "the forward did not execute":
 * the caller answers today's 503 and settles nothing.
 */
export function buildForwardAnswer(
  outcome: ForwardOutcome,
  ctx: { messageId: string; threadId?: string; hadTopic: boolean },
): ForwardAnswer | null {
  if (outcome.kind === 'no-holder' || outcome.kind === 'not-executed') return null;
  const forwardedTo = outcome.machine.nickname || outcome.machine.machineId;
  const added = {
    deliveryPath: 'forwarded',
    forwardedTo,
    reply: null,
    replyArrivesIn: ctx.hadTopic ? 'topic-session' : 'holder-hub',
  };
  if (outcome.kind === 'answered') {
    const body = { ...outcome.body, ...added };
    const relayStatus = outcome.body.relayStatus;
    const ok = outcome.status >= 200 && outcome.status < 300;
    const settlementOutcome = !ok ? undefined
      : relayStatus === 'delivered' ? 'relay-sent' as const
        : relayStatus === 'queued' ? 'relay-queued' as const
          : relayStatus === 'unconfirmed' ? 'relay-unconfirmed' as const
            : undefined;
    return {
      status: outcome.status,
      body,
      settlementOutcome,
      label: `holder-${outcome.status}${typeof relayStatus === 'string' ? `:${relayStatus}` : ''}`,
    };
  }
  // A timeout or a non-200 with no reason: unknown, never a success and never lost.
  const note = `forwarded to ${forwardedTo}; no answer. Do not resend; check delivery on ${forwardedTo}.`;
  return {
    status: 200,
    body: {
      success: true,
      accepted: false,
      delivered: false,
      messageId: ctx.messageId,
      ...(ctx.threadId ? { threadId: ctx.threadId } : {}),
      relayStatus: 'unconfirmed',
      deliveryOutcome: note,
      ...added,
    },
    settlementOutcome: 'relay-unconfirmed',
    label: `unconfirmed:${outcome.reason}`,
  };
}

// ── A reply reaches the topic's session on whichever machine has it ──

export type TopicOwnerAskResult =
  | { injected: true }
  /** `definitive`: the receiver did not attempt an inject, so a second ask cannot duplicate. */
  | { injected: false; definitive: boolean; reason: string };

export interface TopicReplyInjectHandlerDeps {
  enabled: () => boolean;
  getSessionForTopic: (topicId: number) => string | null;
  isSessionAlive: (sessionName: string) => boolean;
  /** The confirmed paste (reports whether the session consumed the text). */
  inject: (sessionName: string, text: string) => Promise<boolean> | boolean;
  counters?: RelayForwardCounters;
}

/**
 * The receiver side of `a2a-topic-reply-inject`. Decides from ITS OWN live
 * session for the topic. Never spawns, never moves the topic.
 */
export async function handleTopicReplyInjectCommand(
  command: TopicReplyInjectCommand,
  deps: TopicReplyInjectHandlerDeps,
): Promise<TopicOwnerAskResult> {
  let enabled = false;
  try { enabled = deps.enabled(); } catch { enabled = false; /* @silent-fallback-ok — an unreadable gate is off ⇒ the holder's Telegram post */ }
  if (!enabled) return { injected: false, definitive: true, reason: 'relay-forward-disabled' };
  if (typeof command.topicId !== 'number' || !Number.isInteger(command.topicId) || command.topicId <= 0
    || typeof command.text !== 'string' || !command.text
    || Buffer.byteLength(command.text, 'utf-8') > MAX_INJECT_TEXT_BYTES) {
    return { injected: false, definitive: true, reason: 'invalid-payload' };
  }
  let sessionName: string | null = null;
  try {
    sessionName = deps.getSessionForTopic(command.topicId);
    if (!sessionName) return { injected: false, definitive: true, reason: 'no-session-for-topic' };
    if (!deps.isSessionAlive(sessionName)) return { injected: false, definitive: true, reason: 'session-not-alive' };
  } catch {
    // @silent-fallback-ok — an unreadable session table means no inject was attempted ⇒ the holder's Telegram post.
    return { injected: false, definitive: true, reason: 'session-lookup-failed' };
  }
  if (deps.counters) deps.counters.injectsReceived++;
  try {
    const ok = await deps.inject(sessionName, command.text);
    if (ok) return { injected: true };
  } catch {
    // @silent-fallback-ok — reported below as an attempted, unconfirmed inject.
  }
  // The paste was attempted and not confirmed: it may still land, so this is
  // NOT definitive — the holder must not ask another machine.
  return { injected: false, definitive: false, reason: 'inject-unconfirmed' };
}

/**
 * The holder's ask to one machine. Never throws. Only a `{ injected: false }`
 * the RECEIVER itself marked definitive is definitive; a typed mesh rejection
 * (an older peer answering `claim-unauthorized`), a timeout or a transport
 * error is not, so it ends in the Telegram post with no second ask.
 */
export async function askTopicOwner(
  send: (machineId: string, command: TopicReplyInjectCommand, timeoutMs: number) => Promise<MeshRpcClientResult | null>,
  machineId: string,
  payload: { topicId: number; text: string; messageId: string; threadId: string },
  timeoutMs: number,
): Promise<TopicOwnerAskResult> {
  try {
    const res = await send(machineId, { type: 'a2a-topic-reply-inject', ...payload }, timeoutMs);
    if (!res) return { injected: false, definitive: false, reason: 'no-peer-url' };
    if (!res.ok) return { injected: false, definitive: false, reason: res.reason ?? `http-${res.status}` };
    const r = (res.result ?? {}) as { injected?: unknown; definitive?: unknown; reason?: unknown };
    if (r.injected === true) return { injected: true };
    return {
      injected: false,
      definitive: r.injected === false && r.definitive === true,
      reason: typeof r.reason === 'string' && r.reason ? r.reason : 'not-injected',
    };
  } catch (err) {
    return { injected: false, definitive: false, reason: (err as { name?: string } | null)?.name === 'AbortError' ? 'timeout' : 'transport-error' };
  }
}

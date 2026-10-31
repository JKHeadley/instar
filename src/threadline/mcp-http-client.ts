/**
 * mcp-http-client — HTTP helpers used by the Threadline MCP stdio server.
 *
 * The MCP server runs as a stdio child process and cannot access the agent's
 * in-process relay client directly, so it talks to the running agent server
 * over localhost HTTP. These helpers are extracted from `mcp-stdio-entry.ts`
 * (which has a module-load side effect — it calls `main()`) so they can be
 * unit-tested in isolation.
 */

import type {
  SendMessageParams,
  SendMessageResult,
  ThreadHistoryResult,
  ThreadHistoryMessage,
  RequestSecretParams,
  RequestSecretResult,
  RelayDiscoverer,
} from './ThreadlineMCPServer.js';
import { Agent } from 'undici';
import { THREADLINE_MCP_DEADLINES } from '../core/threadlineMcpSpawn.js';

/**
 * The inner relay-send call holds its request open for up to the reply wait
 * (≤300 s) plus send time. Node's built-in fetch waits at most 300 s for
 * headers, so the inner call gets its own undici agent at 325 s (spec
 * threadline-mcp-local-http "Bounds", deadline 3) — after the route's own
 * 320 s answer and before the 340 s middleware override.
 */
let relaySendAgent: Agent | null = null;
function relaySendDispatcher(): Agent {
  if (!relaySendAgent) {
    relaySendAgent = new Agent({
      headersTimeout: THREADLINE_MCP_DEADLINES.innerFetchMs,
      bodyTimeout: THREADLINE_MCP_DEADLINES.innerFetchMs,
    });
  }
  return relaySendAgent;
}

/** The fixed text for a send whose outcome cannot be known (timeout, abort, 408). */
export const OUTCOME_UNKNOWN_ERROR =
  'Outcome unknown: the send did not answer in time, and the message may already have been sent. ' +
  'Check threadline_history for this thread before sending it again.';

const OUTCOME_UNKNOWN_CODES = new Set(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_ABORTED', 'ABORT_ERR']);

/**
 * True for a fetch failure after which the request MAY have reached the server
 * (an undici header/body timeout, an abort): such a send is reported as
 * outcome-unknown, never as "failed to reach the server".
 */
export function isOutcomeUnknownFetchError(err: unknown): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur);
    const e = cur as { name?: unknown; code?: unknown; cause?: unknown };
    if (e.name === 'AbortError' || e.name === 'TimeoutError' || e.name === 'HeadersTimeoutError' || e.name === 'BodyTimeoutError') return true;
    if (typeof e.code === 'string' && OUTCOME_UNKNOWN_CODES.has(e.code)) return true;
    cur = e.cause;
  }
  return false;
}

/**
 * Send a message via the agent server's `/threadline/relay-send` endpoint.
 *
 * `relay-send` is the single funnel for Threadline sends: it attempts local
 * same-machine delivery first (for co-located agents) and falls back to the
 * cloud relay. Whatever it returns — success, a 404 "agent not found", or the
 * honest 503 "Relay not connected and local delivery unavailable" — is the
 * real outcome and is surfaced verbatim to the caller.
 *
 * History: this function previously had a SECOND fallback that POSTed to
 * `/messages/send` whenever relay-send returned 503. But `/messages/send`
 * expects an inter-agent envelope `{from,to,type,priority,subject,body}`,
 * while this fallback handed it a threadline-shaped body `{targetAgent,
 * message,...}` — so it always 400'd with "Missing required fields: from, to,
 * type, priority, subject, body". That misleading 400 masked the real reason
 * (relay down / target unreachable). Since relay-send already does local-first
 * delivery, there was nothing legitimate left to fall back to — the path was
 * pure noise. It is gone.
 */
export async function sendMessageViaHttp(
  params: SendMessageParams,
  serverPort: number,
  agentToken: string,
  /**
   * The calling session's name. Explicit (spec D1): inside the server,
   * `process.env.INSTAR_SESSION_NAME` is the SERVER's own environment, so the
   * stdio helper passes its env value and the HTTP route passes the request's
   * session header.
   */
  originSessionName?: string,
): Promise<SendMessageResult> {
  try {
    const response = await fetch(`http://localhost:${serverPort}/threadline/relay-send`, {
      // Deadline 3 of the chain: 325 s for headers and body (Node's default is 300 s).
      ...({ dispatcher: relaySendDispatcher() } as Record<string, unknown>),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${agentToken}`,
      },
      body: JSON.stringify({
        targetAgent: params.targetAgent,
        threadId: params.threadId,
        message: params.message,
        inReplyTo: params.inReplyTo,
        waitForReply: params.waitForReply,
        timeoutSeconds: params.timeoutSeconds,
        // Forward the originating Telegram topic so the reply can be routed
        // back to that session (THREAD-TOPIC-LINKAGE-SPEC.md).
        originTopicId: params.originTopicId,
        // Threadline Phase 1 structural binding: forward the origin session
        // name (injected at the spawn boundary as INSTAR_SESSION_NAME). When
        // the caller did not stamp originTopicId by hand, relay-send resolves
        // this session name → owning topic so the binding is captured WITHOUT
        // any caller discipline (kills fragmentation structurally).
        originSessionName: originSessionName || undefined,
        // Forward the caller's intent string; relay-send stamps it onto the
        // local commitment record so context is available when the reply lands.
        purpose: params.purpose,
        // Explicit new-thread intent; relay-send refuses it rather than
        // silently continuing the existing thread.
        ...(params.newThread ? { newThread: true } : {}),
      }),
    });

    // Read the body exactly once. relay-send returns JSON on both the success
    // and error paths; tolerate an empty or non-JSON body defensively.
    const raw = await response.text();
    // A 408 from the generic request timeout: the send ran (or is running) — the
    // message may already have left. Never reported as "not sent".
    if (response.status === 408) {
      return { success: false, threadId: params.threadId ?? '', messageId: '', error: OUTCOME_UNKNOWN_ERROR, outcomeUnknown: true };
    }
    let parsed: {
      success?: boolean;
      messageId?: string;
      threadId?: string;
      reply?: string;
      replyFrom?: string;
      error?: string;
      deliveryOutcome?: string;
      deliveryPath?: string;
      accepted?: boolean;
      delivered?: boolean;
      relayStatus?: string;
      relayReasonCode?: string;
      retryLater?: boolean | null;
      banSuspected?: boolean;
      held?: boolean;
      note?: string;
      advisory?: string;
      forwardedTo?: string;
      replyArrivesIn?: string;
      peerDark?: { since: string | null; queuedCount: number; expiresAt: string | null; connectedNow: boolean | null; connectedNowReason?: 'no-row' | 'relay-down' | 'stale' | null; connectedAsOf?: string | null; handedUnackedCount?: number };
    } = {};
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Non-JSON body — fall through to the error branch with the raw text.
      }
    }

    if (response.ok && parsed.success) {
      return {
        success: true,
        threadId: parsed.threadId ?? params.threadId ?? '',
        messageId: parsed.messageId ?? '',
        reply: parsed.reply ?? undefined,
        replyFrom: parsed.replyFrom,
        deliveryOutcome: parsed.deliveryOutcome,
        deliveryPath: parsed.deliveryPath,
        accepted: parsed.accepted,
        // Negotiator lease (Robustness Phase 1): surface withheld/held + the
        // holding note + the commitment-class advisory back to the session.
        delivered: parsed.delivered,
        relayStatus: parsed.relayStatus,
        relayReasonCode: parsed.relayReasonCode,
        retryLater: parsed.retryLater,
        banSuspected: parsed.banSuspected,
        held: parsed.held,
        note: parsed.note,
        advisory: parsed.advisory,
        ...(parsed.forwardedTo !== undefined ? { forwardedTo: parsed.forwardedTo } : {}),
        ...(parsed.replyArrivesIn !== undefined ? { replyArrivesIn: parsed.replyArrivesIn } : {}),
        // §3.2: a send to a dark peer carries the evidence object, additively.
        ...(parsed.peerDark && typeof parsed.peerDark === 'object' ? { peerDark: parsed.peerDark } : {}),
      };
    }

    // Surface the real error from relay-send — no envelope fallback.
    const errMsg =
      parsed.error ||
      (raw ? raw.slice(0, 300) : `relay-send returned HTTP ${response.status}`);
    // A refused send (502 WITH a JSON body) keeps its ids + contract fields so
    // the caller can track it; a bodyless 502 (proxy/tunnel) carries none and
    // is therefore reported as unconfirmed by absence, never as rejected.
    return {
      success: false,
      threadId: parsed.threadId ?? params.threadId ?? '',
      messageId: parsed.messageId ?? '',
      error: errMsg,
      ...(parsed.relayStatus ? { relayStatus: parsed.relayStatus } : {}),
      ...(parsed.relayReasonCode ? { relayReasonCode: parsed.relayReasonCode } : {}),
      ...(parsed.retryLater !== undefined ? { retryLater: parsed.retryLater } : {}),
      // A forwarded refusal keeps the machine that carried it.
      ...(parsed.deliveryPath === 'forwarded' ? { deliveryPath: parsed.deliveryPath } : {}),
      ...(parsed.forwardedTo !== undefined ? { forwardedTo: parsed.forwardedTo } : {}),
    };
  } catch (err) {
    // A timeout or abort after the request went out: the outcome is unknown.
    if (isOutcomeUnknownFetchError(err)) {
      return { success: false, threadId: params.threadId ?? '', messageId: '', error: OUTCOME_UNKNOWN_ERROR, outcomeUnknown: true };
    }
    // The agent server itself is unreachable (not running / wrong port).
    return {
      success: false,
      threadId: params.threadId ?? '',
      messageId: '',
      error: `Failed to reach agent server on port ${serverPort}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Fetch thread history via the agent server's `/messages/thread/:threadId`
 * endpoint.
 *
 * Returns an empty history on any failure so the MCP tool degrades gracefully
 * (a stopped agent server or missing thread shouldn't surface as an MCP error).
 */
export async function getThreadHistoryViaHttp(
  threadId: string,
  limit: number,
  serverPort: number,
  agentToken: string,
  before?: string,
): Promise<ThreadHistoryResult> {
  const empty: ThreadHistoryResult = { threadId, messages: [], totalCount: 0, hasMore: false };
  try {
    const response = await fetch(
      `http://localhost:${serverPort}/messages/thread/${encodeURIComponent(threadId)}`,
      {
        headers: { 'Authorization': `Bearer ${agentToken}` },
      },
    );
    if (!response.ok) {
      return empty;
    }
    const data = (await response.json()) as {
      thread?: unknown;
      messages?: Array<{
        message?: {
          id?: string;
          from?: { agent?: string };
          body?: string;
          createdAt?: string;
          threadId?: string;
        };
      }>;
    };
    const envelopes = Array.isArray(data.messages) ? data.messages : [];

    // Ascending-by-createdAt so slice(-limit) returns the most recent window.
    const sorted = [...envelopes].sort((a, b) => {
      const at = a.message?.createdAt ?? '';
      const bt = b.message?.createdAt ?? '';
      return at < bt ? -1 : at > bt ? 1 : 0;
    });

    const filtered = before
      ? sorted.filter((e) => (e.message?.createdAt ?? '') < before)
      : sorted;

    const totalCount = filtered.length;
    const effectiveLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : totalCount;
    const sliced = filtered.slice(-effectiveLimit);
    const hasMore = filtered.length > sliced.length;

    const messages: ThreadHistoryMessage[] = sliced.map((e) => ({
      id: e.message?.id ?? '',
      from: e.message?.from?.agent ?? '',
      body: e.message?.body ?? '',
      timestamp: e.message?.createdAt ?? '',
      threadId: e.message?.threadId ?? threadId,
    }));

    return { threadId, messages, totalCount, hasMore };
  } catch {
    return empty;
  }
}

/**
 * Sealed-handoff keystone — self-mint a Secret Drop request via the agent
 * server's loopback `/threadline/secrets/request` route.
 *
 * Deliberately sends NO Authorization header: this route lives under the
 * `/threadline/*` auth-bypass umbrella and enforces localhost itself. The MCP
 * stdio process cannot present a valid bearer anyway — the on-disk authToken is
 * vault-externalized (`{secret:true}`), which is the exact gap this route closes.
 * The mint goes through the server's durable SecretDrop store, so the request
 * survives session churn.
 */
export async function requestSecretViaHttp(
  params: RequestSecretParams,
  serverPort: number,
): Promise<RequestSecretResult> {
  try {
    const response = await fetch(`http://localhost:${serverPort}/threadline/secrets/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label: params.label,
        description: params.description,
        fields: params.fields,
        topicId: params.topicId,
        ttlMs: params.ttlMs,
        senderVerification: params.senderVerification,
      }),
    });

    const raw = await response.text();
    let parsed: {
      token?: string;
      localUrl?: string;
      tunnelUrl?: string | null;
      expiresIn?: number;
      error?: string;
    } = {};
    try {
      parsed = raw ? JSON.parse(raw) : {};
    } catch {
      /* tolerate a non-JSON body */
    }

    if (!response.ok) {
      return { success: false, error: parsed.error || `HTTP ${response.status}` };
    }
    return {
      success: true,
      token: parsed.token,
      localUrl: parsed.localUrl,
      tunnelUrl: parsed.tunnelUrl ?? null,
      expiresIn: parsed.expiresIn,
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Start (or re-check) a v2 static-key verified pairing via the agent server's
 * `/threadline/pairing/:peerFp/start` route (spec §3.2, FD4 v2). Records a PENDING
 * pairing only; the words are shown to a PIN-authed operator and confirming needs the PIN.
 */
export async function startPairingViaHttp(
  peerFp: string,
  serverPort: number,
  agentToken: string,
): Promise<{ success: boolean; status?: number; body?: Record<string, unknown>; error?: string }> {
  try {
    const response = await fetch(
      `http://localhost:${serverPort}/threadline/pairing/${encodeURIComponent(peerFp)}/start`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${agentToken}` },
        body: JSON.stringify({}),
      },
    );
    const raw = await response.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = raw ? JSON.parse(raw) : {};
    } catch {
      /* tolerate a non-JSON body */
    }
    if (!response.ok) {
      return { success: false, status: response.status, error: (parsed.error as string) || `HTTP ${response.status}` };
    }
    return { success: true, status: response.status, body: parsed };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Make a pairing invite via the agent server's `POST /threadline/pairing/invites`
 * (docs/specs/a2a-pairing-invite-link.md). Grants nothing: the other side's operator approves,
 * then this side's operator finishes (PIN or a lifeline-verified Telegram tap).
 */
export async function createPairingInviteViaHttp(
  opts: { ttlMinutes?: number; bindFp?: string },
  serverPort: number,
  agentToken: string,
): Promise<{ success: boolean; status?: number; body?: Record<string, unknown>; error?: string }> {
  try {
    const response = await fetch(`http://localhost:${serverPort}/threadline/pairing/invites`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({ ...(opts.ttlMinutes !== undefined ? { ttlMinutes: opts.ttlMinutes } : {}), ...(opts.bindFp ? { bindFp: opts.bindFp } : {}) }),
    });
    const raw = await response.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = raw ? JSON.parse(raw) : {};
    } catch {
      /* tolerate a non-JSON body */
    }
    if (!response.ok) {
      return { success: false, status: response.status, error: (parsed.error as string) || `HTTP ${response.status}` };
    }
    return { success: true, status: response.status, body: parsed };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * RelayDiscoverer implementation that proxies through the agent server's
 * /threadline/relay-discover endpoint (shared by the stdio helper and the
 * in-server HTTP route, so the calls behind `threadline_discover` are the same
 * on both transports).
 *
 * connectionState is cached briefly from the last /threadline/status read.
 * On every discover() call we re-check status first so cache fallback in
 * the MCP server's discover handler reflects the live relay state.
 */
export function createHttpRelayDiscoverer(serverPort: number, agentToken: string | (() => string)): RelayDiscoverer {
  const token = (): string => (typeof agentToken === 'function' ? agentToken() : agentToken);
  let lastState = 'unknown';
  const refreshState = async (): Promise<string> => {
    try {
      const res = await fetch(`http://localhost:${serverPort}/threadline/status`);
      if (!res.ok) return (lastState = 'unavailable');
      const body = await res.json() as { relay?: { connected?: boolean } };
      lastState = body.relay?.connected ? 'connected' : 'disconnected';
      return lastState;
    } catch {
      return (lastState = 'unavailable');
    }
  };
  return {
    get connectionState(): string { return lastState; },
    async discover(filter) {
      const state = await refreshState();
      if (state !== 'connected') return [];
      try {
        const res = await fetch(`http://localhost:${serverPort}/threadline/relay-discover`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token()}`,
          },
          body: JSON.stringify({ filter }),
        });
        if (!res.ok) return [];
        const body = await res.json() as {
          success?: boolean;
          agents?: Array<{
            agentId: string; name: string; publicKey?: string;
            framework?: string; capabilities?: string[]; lastSeen?: string;
          }>;
        };
        return body.success && Array.isArray(body.agents) ? body.agents : [];
      } catch {
        return [];
      }
    },
  };
}

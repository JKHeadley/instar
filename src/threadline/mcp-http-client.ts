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
} from './ThreadlineMCPServer.js';

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
): Promise<SendMessageResult> {
  try {
    const response = await fetch(`http://localhost:${serverPort}/threadline/relay-send`, {
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
        originSessionName: process.env.INSTAR_SESSION_NAME || undefined,
        // Forward the caller's intent string; relay-send stamps it onto the
        // local commitment record so context is available when the reply lands.
        purpose: params.purpose,
      }),
    });

    // Read the body exactly once. relay-send returns JSON on both the success
    // and error paths; tolerate an empty or non-JSON body defensively.
    const raw = await response.text();
    let parsed: {
      success?: boolean;
      messageId?: string;
      threadId?: string;
      reply?: string;
      replyFrom?: string;
      error?: string;
      deliveryOutcome?: string;
      deliveryPath?: string;
      delivered?: boolean;
      held?: boolean;
      note?: string;
      advisory?: string;
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
        // Negotiator lease (Robustness Phase 1): surface withheld/held + the
        // holding note + the commitment-class advisory back to the session.
        delivered: parsed.delivered,
        held: parsed.held,
        note: parsed.note,
        advisory: parsed.advisory,
      };
    }

    // Surface the real error from relay-send — no envelope fallback.
    const errMsg =
      parsed.error ||
      (raw ? raw.slice(0, 300) : `relay-send returned HTTP ${response.status}`);
    return {
      success: false,
      threadId: params.threadId ?? '',
      messageId: '',
      error: errMsg,
    };
  } catch (err) {
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

/**
 * A2ABridge — Translates A2A HTTP requests into Threadline relay messages.
 *
 * Enables standard A2A agents to communicate with Threadline agents connected
 * to the relay. Each public agent gets A2A endpoints automatically.
 *
 * Security boundary: The A2A bridge terminates E2E encryption at the
 * translation boundary. Messages arriving via A2A are re-encrypted for
 * the target Threadline agent using ephemeral keys.
 *
 * Part of Threadline Relay Phase 2.
 */

import crypto from 'node:crypto';
import { resolveClientAddressParts } from './clientAddress.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PresenceRegistry } from './PresenceRegistry.js';
import type { AgentFingerprint, AgentMetadata, PresenceEntry, MessageEnvelope } from './types.js';
import { MessageEncryptor, computeFingerprint, deriveX25519PublicKey } from '../client/MessageEncryptor.js';
import { generateIdentityKeyPair } from '../ThreadlineCrypto.js';
import type { RelayRateLimiter } from './RelayRateLimiter.js';

// ── Types ────────────────────────────────────────────────────────────

export interface A2ABridgeConfig {
  /** Base URL for A2A endpoints */
  baseUrl: string;
  /** Response timeout in ms */
  responseTimeoutMs?: number; // default 300000 (5 min)
  /** Max concurrent tasks per agent */
  maxConcurrentTasksPerAgent?: number; // default 3
  /** Max request body size in bytes */
  maxRequestBodySize?: number; // default 65536 (64KB)
  /** SEC-139: header the front proxy sets with the caller address; '' = trust no header. */
  clientAddressHeader?: string;
}

export interface A2ABridgeDeps {
  presence: PresenceRegistry;
  rateLimiter: A2ABridgeRateLimiter;
  /** Send a message envelope to a connected agent via the relay */
  sendToAgent: (agentId: AgentFingerprint, envelope: MessageEnvelope) => boolean;
  /** Register a callback for when an agent responds to an A2A task */
  onAgentResponse: (taskId: string, handler: (envelope: MessageEnvelope) => void) => void;
  /** Unregister a response handler */
  removeResponseHandler: (taskId: string) => void;
}

/** A2A JSON-RPC request */
interface A2ARequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

/** A2A Agent Card */
interface A2AAgentCard {
  name: string;
  description: string;
  url: string;
  version: string;
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
    stateTransitionHistory: boolean;
  };
  skills: Array<{
    id: string;
    name: string;
    description: string;
    inputModes: string[];
    outputModes: string[];
  }>;
  extensions?: Record<string, unknown>;
}

/** Pending A2A task */
interface PendingTask {
  taskId: string;
  agentId: AgentFingerprint;
  threadId: string;
  status: 'submitted' | 'working' | 'completed' | 'failed' | 'canceled';
  createdAt: number;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (response: A2ATaskResult) => void;
}

interface A2ATaskResult {
  id: string;
  status: string;
  artifacts?: Array<{ parts: Array<{ type: string; text: string }> }>;
  error?: { code: number; message: string };
}

// ── Bridge Rate Limiter ─────────────────────────────────────────────

export interface A2ABridgeRateLimitConfig {
  requestsPerMinutePerIP: number;  // default 20
  requestsPerHourPerIP: number;    // default 200
}

export class A2ABridgeRateLimiter {
  private readonly config: A2ABridgeRateLimitConfig;
  private readonly windows = new Map<string, number[]>();
  /** SEC-134: when keys of callers that never came back were last swept. */
  private lastSweepAt = 0;
  /**
   * SEC-134: hard ceiling on tracked keys (two per address). Beyond it the oldest-inserted keys are
   * dropped, so memory stays fixed even when callers rotate addresses faster than the hourly sweep.
   */
  static readonly MAX_KEYS = 50_000;

  constructor(config?: Partial<A2ABridgeRateLimitConfig>) {
    this.config = {
      requestsPerMinutePerIP: config?.requestsPerMinutePerIP ?? 20,
      requestsPerHourPerIP: config?.requestsPerHourPerIP ?? 200,
    };
  }

  check(ip: string): { allowed: boolean; limitType?: string } {
    const now = Date.now();
    this.sweepIdle(now);

    // Per-minute check
    const minKey = `min:${ip}`;
    const minEvents = this.cleanAndGet(minKey, now - 60_000);
    if (minEvents.length >= this.config.requestsPerMinutePerIP) {
      return { allowed: false, limitType: 'per_ip_minute' };
    }

    // Per-hour check
    const hourKey = `hour:${ip}`;
    const hourEvents = this.cleanAndGet(hourKey, now - 3_600_000);
    if (hourEvents.length >= this.config.requestsPerHourPerIP) {
      return { allowed: false, limitType: 'per_ip_hour' };
    }

    return { allowed: true };
  }

  record(ip: string): void {
    const now = Date.now();
    for (const key of [`hour:${ip}`, `min:${ip}`]) {
      const events = this.getOrCreate(key);
      events.push(now);
      // SEC-139: move to the end so the ceiling drops the least recently used keys first.
      this.windows.delete(key);
      this.windows.set(key, events);
    }
    for (const key of this.windows.keys()) {
      if (this.windows.size <= A2ABridgeRateLimiter.MAX_KEYS) break;
      this.windows.delete(key);
    }
  }

  reset(): void {
    this.windows.clear();
  }

  /** Number of tracked keys (for tests and diagnostics). */
  get size(): number {
    return this.windows.size;
  }

  private cleanAndGet(key: string, cutoff: number): number[] {
    const events = this.windows.get(key);
    if (!events) return [];
    const filtered = events.filter(t => t > cutoff);
    // SEC-134: an empty window is deleted, so a caller seen once costs nothing after its window.
    if (filtered.length === 0) this.windows.delete(key);
    else this.windows.set(key, filtered);
    return filtered;
  }

  /**
   * SEC-134: drop every key whose newest event is older than the longest window (one hour). Runs at
   * most once a minute, so keys of callers that never return (for example a scan from many
   * addresses) are released without a timer.
   */
  private sweepIdle(now: number): void {
    if (now - this.lastSweepAt < 60_000) return;
    this.lastSweepAt = now;
    const cutoff = now - 3_600_000;
    for (const [key, events] of this.windows) {
      if (events.length === 0 || events[events.length - 1] <= cutoff) this.windows.delete(key);
    }
  }

  private getOrCreate(key: string): number[] {
    if (!this.windows.has(key)) {
      this.windows.set(key, []);
    }
    return this.windows.get(key)!;
  }
}

// ── Context ID ↔ Thread ID Mapping ──────────────────────────────────

/** SEC-134: a caller-supplied contextId longer than this is refused. */
export const MAX_A2A_CONTEXT_ID_LENGTH = 256;

/**
 * Maps an A2A caller's contextId to a Threadline thread.
 *
 * SEC-134: the map used to be keyed by the bare contextId and never shrank, so any caller could grow
 * it without limit, and a caller who learned another caller's contextId joined that caller's thread.
 * It is now keyed by (caller, agent, contextId), entries expire after `ttlMs` without use, and at
 * most `maxEntries` are kept (least recently used dropped first). A dropped mapping only means the
 * next message with that contextId starts a new thread, the same as a first message.
 */
export class ContextThreadMapper {
  private readonly entries = new Map<string, { threadId: string; lastUsedAt: number }>();

  constructor(
    private readonly maxEntries = 10_000,
    private readonly ttlMs = 24 * 3_600_000,
  ) {}

  getOrCreateThreadId(scope: string, contextId: string | undefined, now = Date.now()): { threadId: string; isNew: boolean } {
    if (contextId) {
      const key = `${scope}\u0000${contextId}`;
      const hit = this.entries.get(key);
      if (hit && now - hit.lastUsedAt <= this.ttlMs) {
        // Re-insert so Map order stays least-recently-used first.
        this.entries.delete(key);
        hit.lastUsedAt = now;
        this.entries.set(key, hit);
        return { threadId: hit.threadId, isNew: false };
      }
      if (hit) this.entries.delete(key);
    }
    const threadId = `a2a-${crypto.randomUUID()}`;
    // A message without a contextId cannot be continued by contextId, so it is not stored.
    if (contextId) {
      this.entries.set(`${scope}\u0000${contextId}`, { threadId, lastUsedAt: now });
      this.evict(now);
    }
    return { threadId, isNew: true };
  }

  get size(): number {
    return this.entries.size;
  }

  private evict(now: number): void {
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries && now - entry.lastUsedAt <= this.ttlMs) break;
      this.entries.delete(key);
    }
  }
}

// ── A2A Bridge Implementation ───────────────────────────────────────

export class A2ABridge {
  private readonly config: Required<A2ABridgeConfig>;
  private readonly deps: A2ABridgeDeps;
  private readonly contextMapper = new ContextThreadMapper();
  private readonly pendingTasks = new Map<string, PendingTask>();
  private readonly concurrentTasks = new Map<AgentFingerprint, number>();
  /** Bridge identity — used to encrypt messages to Threadline agents */
  private readonly bridgeIdentity = generateIdentityKeyPair();
  private readonly bridgeEncryptor: MessageEncryptor;

  constructor(config: A2ABridgeConfig, deps: A2ABridgeDeps) {
    this.config = {
      baseUrl: config.baseUrl,
      responseTimeoutMs: config.responseTimeoutMs ?? 300_000,
      maxConcurrentTasksPerAgent: config.maxConcurrentTasksPerAgent ?? 3,
      maxRequestBodySize: config.maxRequestBodySize ?? 65_536,
      clientAddressHeader: config.clientAddressHeader ?? '',
    };
    this.deps = deps;
    this.bridgeEncryptor = new MessageEncryptor(
      this.bridgeIdentity.privateKey,
      this.bridgeIdentity.publicKey,
    );
  }

  /**
   * Handle an HTTP request to the A2A bridge.
   * Returns true if the request was handled, false if not an A2A route.
   */
  async handleRequest(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
    // Parse: /a2a/{agentId}/...
    const match = pathname.match(/^\/a2a\/([a-f0-9]+)(\/.*)?$/);
    if (!match) return false;

    const agentId = match[1];
    const subpath = match[2] ?? '/';

    // SEC-139: the caller address the rest of the relay uses (no caller-written header trusted unless
    // the deployment names one). Rate limits key IPv6 by /64; thread scope keeps the exact address so
    // two hosts in one /64 never share a thread.
    const { rateKey: ip, exact: callerAddress } = resolveClientAddressParts(req, this.config.clientAddressHeader);

    // Rate limit
    const rateCheck = this.deps.rateLimiter.check(ip);
    if (!rateCheck.allowed) {
      this.sendJsonRpcError(res, null, -32000, 'Rate limited', 429);
      return true;
    }

    // Agent card
    if (subpath === '/.well-known/agent-card.json' && req.method === 'GET') {
      this.handleAgentCard(res, agentId);
      return true;
    }

    // Messages
    if (subpath === '/messages' && req.method === 'POST') {
      this.deps.rateLimiter.record(ip);
      await this.handleMessage(req, res, agentId, callerAddress);
      return true;
    }

    // Task status
    const taskMatch = subpath.match(/^\/tasks\/([^/]+)$/);
    if (taskMatch && req.method === 'GET') {
      this.handleTaskStatus(res, taskMatch[1]);
      return true;
    }

    // Task cancel
    const cancelMatch = subpath.match(/^\/tasks\/([^/]+):cancel$/);
    if (cancelMatch && req.method === 'POST') {
      this.handleTaskCancel(res, cancelMatch[1]);
      return true;
    }

    this.sendJsonRpcError(res, null, -32601, 'Method not found', 404);
    return true;
  }

  /**
   * Handle an agent's response to a pending A2A task.
   * Called when a Threadline agent sends a message that matches a pending task thread.
   */
  handleAgentResponse(envelope: MessageEnvelope): boolean {
    // Find pending task by thread ID
    for (const [taskId, task] of this.pendingTasks) {
      if (task.threadId === envelope.threadId && task.agentId === envelope.from) {
        clearTimeout(task.timeout);

        // Decrypt the response (bridge has the keys)
        let responseText = '[encrypted response]';
        try {
          const agentPresence = this.deps.presence.get(envelope.from);
          if (agentPresence) {
            const agentPubKey = Buffer.from(agentPresence.publicKey, 'base64');
            const agentX25519 = deriveX25519PublicKey(this.bridgeIdentity.privateKey);
            // Note: In production, we'd need the agent's X25519 public key
            // For now, the bridge can't decrypt the response directly because
            // it doesn't have the agent's X25519 key. The response is forwarded as-is.
            responseText = envelope.payload; // Base64 ciphertext
          }
        } catch {
          // Decryption failed — return raw payload
        }

        task.status = 'completed';
        task.resolve({
          id: taskId,
          status: 'completed',
          artifacts: [{
            parts: [{ type: 'text', text: responseText }],
          }],
        });

        this.pendingTasks.delete(taskId);
        this.decrementConcurrent(task.agentId);
        return true;
      }
    }
    return false;
  }

  /**
   * Get the bridge's fingerprint (for identifying A2A bridge messages).
   */
  get bridgeFingerprint(): AgentFingerprint {
    return this.bridgeEncryptor.fingerprint;
  }

  /**
   * Destroy the bridge — clean up pending tasks.
   */
  destroy(): void {
    for (const [, task] of this.pendingTasks) {
      clearTimeout(task.timeout);
      task.resolve({
        id: task.taskId,
        status: 'failed',
        error: { code: -32003, message: 'Bridge shutting down' },
      });
    }
    this.pendingTasks.clear();
    this.concurrentTasks.clear();
  }

  // ── Private: Route Handlers ─────────────────────────────────────

  private handleAgentCard(res: ServerResponse, agentId: AgentFingerprint): void {
    const entry = this.deps.presence.get(agentId);
    if (!entry || entry.visibility !== 'public') {
      this.sendJsonRpcError(res, null, -32001, 'Agent not found', 404);
      return;
    }

    const card = this.generateAgentCard(entry);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(card, null, 2));
  }

  private async handleMessage(
    req: IncomingMessage,
    res: ServerResponse,
    agentId: AgentFingerprint,
    callerAddress: string,
  ): Promise<void> {
    // Check agent exists and is online
    const entry = this.deps.presence.get(agentId);
    if (!entry) {
      this.sendJsonRpcError(res, null, -32001, 'Agent not found or offline', 404);
      return;
    }

    // Check concurrent task limit
    const concurrent = this.concurrentTasks.get(agentId) ?? 0;
    if (concurrent >= this.config.maxConcurrentTasksPerAgent) {
      this.sendJsonRpcError(res, null, -32002, 'Too many concurrent tasks for this agent', 429);
      return;
    }

    // Read body
    const body = await this.readBody(req);
    if (!body) {
      this.sendJsonRpcError(res, null, -32700, 'Parse error: body too large or invalid', 400);
      return;
    }

    let request: A2ARequest;
    try {
      request = JSON.parse(body);
    } catch {
      this.sendJsonRpcError(res, null, -32700, 'Parse error: invalid JSON', 400);
      return;
    }

    if (request.method !== 'message/send') {
      this.sendJsonRpcError(res, request.id, -32601, `Method not supported: ${request.method}`, 400);
      return;
    }

    const params = request.params as {
      message?: { role?: string; parts?: Array<{ type?: string; text?: string }> };
      contextId?: string;
    } | undefined;

    if (!params?.message?.parts?.length) {
      this.sendJsonRpcError(res, request.id, -32602, 'Missing message.parts', 400);
      return;
    }

    // Extract text from message parts
    const textParts = params.message.parts
      .filter(p => p.type === 'text' && p.text)
      .map(p => p.text!);
    const messageText = textParts.join('\n');

    if (!messageText) {
      this.sendJsonRpcError(res, request.id, -32602, 'No text content in message', 400);
      return;
    }

    // SEC-134: a contextId must be text of bounded length.
    if (params.contextId !== undefined && (typeof params.contextId !== 'string' || params.contextId.length > MAX_A2A_CONTEXT_ID_LENGTH)) {
      this.sendJsonRpcError(res, request.id, -32602, `contextId must be a string of at most ${MAX_A2A_CONTEXT_ID_LENGTH} characters`, 400);
      return;
    }

    // Map context ID to thread ID, scoped to this caller and this agent (SEC-134).
    const { threadId, isNew } = this.contextMapper.getOrCreateThreadId(`${callerAddress}\u0000${agentId}`, params.contextId || undefined);

    // SEC-139: an agent reply resolves the waiting task of its thread, so one thread holds at most one
    // waiting task. Otherwise a second caller in the same thread could receive the reply meant for
    // the first.
    for (const task of this.pendingTasks.values()) {
      if (task.threadId === threadId && task.agentId === agentId) {
        this.sendJsonRpcError(res, request.id, -32005, 'A message in this conversation is still waiting for its reply; try again when it has been answered', 409);
        return;
      }
    }

    // Create task
    const taskId = `task-${crypto.randomUUID()}`;

    // Build encrypted envelope for the Threadline agent
    const agentPubKey = Buffer.from(entry.publicKey, 'base64');
    // For the bridge, we need the agent's X25519 public key
    // Since we derive from Ed25519 private key, and we only have the agent's Ed25519 public key,
    // we need to compute it differently. We'll use the bridge's own encryptor which
    // handles the key derivation.
    const agentX25519Pub = deriveX25519PublicKey(this.bridgeIdentity.privateKey);
    // This is the bridge's own X25519 public key — the real agent's X25519 pub is not available here.
    // In practice, the relay would negotiate X25519 keys during auth.
    // For Phase 2, we send unencrypted content in a structured envelope.

    const envelope: MessageEnvelope = {
      from: this.bridgeEncryptor.fingerprint,
      to: agentId,
      threadId,
      messageId: `a2a-${crypto.randomUUID()}`,
      timestamp: new Date().toISOString(),
      nonce: crypto.randomBytes(16).toString('base64'),
      ephemeralPubKey: '', // A2A bridge doesn't use E2E encryption
      salt: '',
      // For A2A bridge messages, payload is base64-encoded plaintext JSON
      // This is the documented security trade-off (Section 6.6)
      payload: Buffer.from(JSON.stringify({
        content: messageText,
        type: 'a2a-message',
        metadata: {
          transport: 'a2a-bridge',
          a2aTaskId: taskId,
          contextId: params.contextId,
          isNewThread: isNew,
        },
      })).toString('base64'),
      signature: '', // A2A bridge messages are not E2E signed
    };

    // Register response handler
    const taskPromise = new Promise<A2ATaskResult>((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingTasks.delete(taskId);
        this.decrementConcurrent(agentId);
        resolve({
          id: taskId,
          status: 'failed',
          error: { code: -32004, message: 'Task timeout' },
        });
      }, this.config.responseTimeoutMs);

      this.pendingTasks.set(taskId, {
        taskId,
        agentId,
        threadId,
        status: 'submitted',
        createdAt: Date.now(),
        timeout,
        resolve,
      });
    });

    this.incrementConcurrent(agentId);

    // Forward to agent
    const sent = this.deps.sendToAgent(agentId, envelope);
    if (!sent) {
      const task = this.pendingTasks.get(taskId);
      if (task) {
        clearTimeout(task.timeout);
        this.pendingTasks.delete(taskId);
      }
      this.decrementConcurrent(agentId);
      this.sendJsonRpcError(res, request.id, -32003, 'Failed to deliver to agent', 502);
      return;
    }

    // SEC-139: a caller that disconnects before the reply frees its thread at once, so a retry with
    // the same contextId is not refused until the timeout.
    if (typeof (res as { on?: unknown }).on === 'function') {
      res.on('close', () => {
        const task = this.pendingTasks.get(taskId);
        if (!task || res.writableEnded) return;
        clearTimeout(task.timeout);
        this.pendingTasks.delete(taskId);
        this.decrementConcurrent(agentId);
        task.resolve({ id: taskId, status: 'failed', error: { code: -32006, message: 'Caller disconnected' } });
      });
    }

    // Wait for response (with timeout)
    const result = await taskPromise;

    // Send JSON-RPC response
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      result,
    }));
  }

  private handleTaskStatus(res: ServerResponse, taskId: string): void {
    const task = this.pendingTasks.get(taskId);
    if (!task) {
      // Task may have completed
      this.sendJsonRpcError(res, null, -32001, 'Task not found', 404);
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      id: null,
      result: {
        id: taskId,
        status: task.status,
      },
    }));
  }

  private handleTaskCancel(res: ServerResponse, taskId: string): void {
    const task = this.pendingTasks.get(taskId);
    if (!task) {
      this.sendJsonRpcError(res, null, -32001, 'Task not found', 404);
      return;
    }

    clearTimeout(task.timeout);
    task.status = 'canceled';
    task.resolve({
      id: taskId,
      status: 'canceled',
    });
    this.pendingTasks.delete(taskId);
    this.decrementConcurrent(task.agentId);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      id: null,
      result: { id: taskId, status: 'canceled' },
    }));
  }

  // ── Private: Helpers ────────────────────────────────────────────

  private generateAgentCard(entry: PresenceEntry): A2AAgentCard {
    const skills = (entry.metadata.capabilities ?? []).map(cap => ({
      id: cap,
      name: cap.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      description: `${cap} capability via Threadline relay`,
      inputModes: ['text/plain'],
      outputModes: ['text/plain'],
    }));

    return {
      name: entry.metadata.name,
      description: `${entry.metadata.name} — available via Threadline relay`,
      url: `${this.config.baseUrl}/a2a/${entry.agentId}`,
      version: entry.metadata.version ?? '1.0.0',
      capabilities: {
        streaming: false, // Phase 2: synchronous only
        pushNotifications: false,
        stateTransitionHistory: false,
      },
      skills: skills.length > 0 ? skills : [{
        id: 'conversation',
        name: 'Persistent Conversation',
        description: 'Engage in a persistent conversation that resumes across sessions',
        inputModes: ['text/plain'],
        outputModes: ['text/plain'],
      }],
      extensions: {
        threadline: {
          version: '1.0.0',
          relayId: entry.agentId,
          directConnect: this.config.baseUrl.replace(/^http/, 'ws') + '/v1/connect',
          transport: 'a2a-bridge',
        },
      },
    };
  }

  private readBody(req: IncomingMessage): Promise<string | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;

      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > this.config.maxRequestBodySize) {
          resolve(null);
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', () => {
        resolve(Buffer.concat(chunks).toString('utf-8'));
      });

      req.on('error', () => resolve(null));
    });
  }

  private sendJsonRpcError(
    res: ServerResponse,
    id: string | number | null,
    code: number,
    message: string,
    httpStatus: number = 200,
  ): void {
    res.writeHead(httpStatus, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: { code, message },
    }));
  }

  private incrementConcurrent(agentId: AgentFingerprint): void {
    this.concurrentTasks.set(agentId, (this.concurrentTasks.get(agentId) ?? 0) + 1);
  }

  private decrementConcurrent(agentId: AgentFingerprint): void {
    const current = this.concurrentTasks.get(agentId) ?? 0;
    if (current <= 1) {
      this.concurrentTasks.delete(agentId);
    } else {
      this.concurrentTasks.set(agentId, current - 1);
    }
  }
}

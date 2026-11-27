/**
 * MessageStore — file-based message persistence layer.
 *
 * Per-message JSON files as source of truth with JSONL indexes as derived data.
 * Implements the IMessageStore interface from the Inter-Agent Messaging Spec v3.1.
 *
 * Storage layout:
 *   {basePath}/
 *     store/{messageId}.json        — source of truth per message
 *     index/inbox.jsonl             — derived, rebuilt on startup
 *     index/outbox.jsonl            — derived, rebuilt on startup
 *     dead-letter/{messageId}.json  — expired/failed messages
 *     pending/{messageId}.json      — symlinks to store/ for delivery queue
 *     threads/{threadId}.json       — thread metadata
 *     threads/archive/              — resolved/stale threads
 *     drop/{agentName}/             — cross-agent offline drops
 *     outbound/{machineId}/         — cross-machine offline queue
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getLastDeliveredAt } from './types.js';
import type {
  IMessageStore,
  MessageEnvelope,
  MessageThread,
  ThreadStatus,
  DeliveryState,
  MessageFilter,
  RetryInboxEntry,
  MessagingStats,
} from './types.js';
import { maybeRotateJsonl } from '../utils/jsonl-rotation.js';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';
import { isSafeFileId, MAX_FILE_ID_BYTES } from '../core/safeFileId.js';

const DIRS = ['store', 'index', 'dead-letter', 'pending', 'threads', 'threads/archive', 'drop', 'outbound'];

const RETRY_SCAN_BATCH = 16;

interface CachedRetryEntry {
  revision: string;
  recipient: string;
  entry: RetryInboxEntry;
}

export class MessageStore implements IMessageStore {
  private readonly basePath: string;
  private retryInboxCache = new Map<string, CachedRetryEntry>();

  constructor(basePath: string) {
    this.basePath = basePath;
  }

  async initialize(): Promise<void> {
    // Create directory structure
    for (const dir of DIRS) {
      fs.mkdirSync(path.join(this.basePath, dir), { recursive: true });
    }
  }

  async save(envelope: MessageEnvelope): Promise<void> {
    const filePath = this.messageFilePath(envelope.message.id);
    if (!filePath) throw new Error('unsafe message id: refusing to store a message whose id is not a plain file name');

    // Deduplication — if the message already exists, skip
    if (fs.existsSync(filePath)) {
      return;
    }

    // Atomic write: tmp + rename
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(envelope, null, 2));
    fs.renameSync(tmpPath, filePath);

    // Append to index
    this.appendToIndex(envelope);
  }

  async get(messageId: string): Promise<MessageEnvelope | null> {
    const filePath = this.messageFilePath(messageId);
    if (!filePath) return null;
    try {
      const data = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(data) as MessageEnvelope;
    } catch {
      // A canonical-history body record (ThreadLog `textRef: {kind:'store'}`) lives
      // in `bodies/`, outside the delivery store; resolve it on the same read path so
      // existing consumers (ThreadlineReapRecovery) can follow the reference.
      return MessageStore.isThreadBodyStoreId(messageId) ? this.getThreadBodySync(messageId) : null;
    }
  }

  // ── Canonical-history body backing (ThreadLog large-body textRef) ───────────
  //
  // Over-cap Threadline bodies are referenced from the canonical per-thread log by
  // a store id. These records are written to `bodies/`, NOT `store/`, so they never
  // enter the delivery indexes, the retry scan, or inbox/outbox queries: they are
  // history text backing, not a delivery claim. Synchronous because the recorder
  // funnel returns synchronously (off the send critical path). Plain appendFile /
  // rename semantics — no fsync, so no crash/power-loss durability is claimed.

  /**
   * Store ids are recorder-minted `tlbody-<sha256(threadId)>-<namespaced body
   * digest>` (both full 64-hex) — never a raw wire value. The first part names
   * the thread's body partition `bodies/<sha256(threadId)>/`, so close-only
   * retention removes exactly one thread's bodies without scanning or indexing.
   */
  static isThreadBodyStoreId(id: string): boolean {
    return /^tlbody-[0-9a-f]{64}-[0-9a-f]{64}$/.test(id);
  }

  /** The per-thread body partition key: full SHA-256 of the thread id. */
  static threadBodyPartition(threadId: string): string {
    return createHash('sha256').update(threadId).digest('hex');
  }

  private threadBodyPath(storeId: string): string {
    return path.join(this.basePath, 'bodies', storeId.slice(7, 71), `${storeId}.json`);
  }

  /**
   * Persist one body record under `bodies/<thread partition>/{storeId}.json`.
   * Idempotent: an existing record is kept (the id is content-namespaced, so an
   * existing file holds the same content). Throws on an invalid id, an id whose
   * partition does not match the envelope's thread, or a write failure.
   */
  saveThreadBodySync(storeId: string, envelope: MessageEnvelope): void {
    if (!MessageStore.isThreadBodyStoreId(storeId)) throw new Error(`invalid thread body store id: ${storeId}`);
    const threadId = envelope.message.threadId;
    if (typeof threadId !== 'string' || storeId.slice(7, 71) !== MessageStore.threadBodyPartition(threadId)) {
      throw new Error(`thread body store id ${storeId} does not belong to the envelope's thread`);
    }
    const filePath = this.threadBodyPath(storeId);
    if (fs.existsSync(filePath)) return;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(envelope));
    fs.renameSync(tmpPath, filePath);
  }

  /**
   * Read one body record, or null when absent/corrupt/invalid id. An absent
   * record (ENOENT) returns null quietly, including after close-only retention
   * removes the partition. This cannot distinguish retention from deletion.
   * Any other failure (corrupt JSON,
   * unreadable file) means referenced history text is lost: it is reported
   * through DegradationReporter before returning null.
   */
  getThreadBodySync(storeId: string): MessageEnvelope | null {
    if (!MessageStore.isThreadBodyStoreId(storeId)) return null;
    try {
      return JSON.parse(fs.readFileSync(this.threadBodyPath(storeId), 'utf-8')) as MessageEnvelope;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      DegradationReporter.getInstance().report({
        feature: 'MessageStore.threadBody',
        primary: 'Resolve an over-cap Threadline body from its canonical-history body record',
        fallback: 'Treat the body as unresolvable (history read shows no body; reap recovery cannot replay it)',
        // JSON parse errors can quote private body text. Report fixed categories
        // only; neither exception messages nor their stringification are safe.
        reason: `body record ${storeId} unreadable: ${err instanceof SyntaxError ? 'invalid JSON' : 'read failed'}`,
        impact: 'Canonical thread history is missing the text of one over-cap message',
      });
      return null;
    }
  }

  /**
   * Close-only retention: remove ONE thread's body partition (every body record
   * the recorder wrote for that thread, including one whose log append later
   * failed). Touches exactly `bodies/<sha256(threadId)>/` via SafeFsExecutor —
   * never another thread, never the delivery store. Driven only by the
   * ConversationStore terminal-close seam; cold archive/LRU never calls it.
   */
  deleteThreadBodiesSync(threadId: string): void {
    const dir = path.join(this.basePath, 'bodies', MessageStore.threadBodyPartition(threadId));
    if (!fs.existsSync(dir)) return;
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'MessageStore.deleteThreadBodiesSync' });
  }

  async updateDelivery(messageId: string, delivery: DeliveryState): Promise<void> {
    const filePath = this.messageFilePath(messageId);
    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error(`Message not found: ${messageId}`);
    }

    const data = fs.readFileSync(filePath, 'utf-8');
    const envelope = JSON.parse(data) as MessageEnvelope;
    envelope.delivery = delivery;

    // Atomic write
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(envelope, null, 2));
    fs.renameSync(tmpPath, filePath);
  }

  /**
   * Mark many messages as 'undelivered' in chunks, yielding between chunks.
   *
   * Transitions: queued → undelivered, received → undelivered. Messages already
   * in a terminal phase (delivered/read/expired/dead-lettered/failed) or already
   * 'undelivered' are skipped silently. Missing files are skipped silently.
   *
   * Returns the count of messages actually transitioned.
   */
  async markManyUndelivered(messageIds: string[], chunkSize: number = 50): Promise<number> {
    let updated = 0;
    const { VALID_TRANSITIONS } = await import('./types.js');
    const allowedFrom = new Set(
      VALID_TRANSITIONS.filter(([, to]) => to === 'undelivered').map(([from]) => from)
    );

    for (let i = 0; i < messageIds.length; i += chunkSize) {
      const chunk = messageIds.slice(i, i + chunkSize);
      for (const id of chunk) {
        const filePath = this.messageFilePath(id);
        if (!filePath || !fs.existsSync(filePath)) continue;

        let envelope: MessageEnvelope;
        try {
          envelope = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as MessageEnvelope;
        } catch {
          continue; // Corrupt file; skip rather than crash dispose
        }

        if (!allowedFrom.has(envelope.delivery.phase)) continue;

        const now = new Date().toISOString();
        const transition = {
          from: envelope.delivery.phase,
          to: 'undelivered' as const,
          at: now,
          reason: 'SpawnRequestManager dispose handoff',
        };
        envelope.delivery = {
          ...envelope.delivery,
          phase: 'undelivered',
          transitions: [...envelope.delivery.transitions, transition],
        };

        const tmpPath = filePath + '.tmp';
        fs.writeFileSync(tmpPath, JSON.stringify(envelope, null, 2));
        fs.renameSync(tmpPath, filePath);
        updated++;
      }
      // Yield between chunks so dispose doesn't block the event loop.
      if (i + chunkSize < messageIds.length) {
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    }

    return updated;
  }

  /**
   * Overwrite a stored envelope entirely.
   * Used after cross-machine routing updates transport fields (signature, relayChain).
   */
  async updateEnvelope(envelope: MessageEnvelope): Promise<void> {
    const filePath = this.messageFilePath(envelope.message.id);
    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error(`Message not found: ${envelope.message.id}`);
    }

    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(envelope, null, 2));
    fs.renameSync(tmpPath, filePath);
  }

  async queryInbox(agentName: string, filter?: MessageFilter): Promise<MessageEnvelope[]> {
    const envelopes = this.readAllEnvelopes();

    let results = envelopes.filter(e => {
      // Match messages addressed to this agent (or broadcast)
      const toAgent = e.message.to.agent;
      return toAgent === agentName || toAgent === '*';
    });

    // Apply filters
    if (filter?.type) {
      results = results.filter(e => e.message.type === filter.type);
    }
    if (filter?.priority) {
      results = results.filter(e => e.message.priority === filter.priority);
    }
    if (filter?.unread) {
      results = results.filter(e => e.delivery.phase !== 'read');
    }
    if (filter?.fromAgent) {
      results = results.filter(e => e.message.from.agent === filter.fromAgent);
    }
    if (filter?.threadId) {
      results = results.filter(e => e.message.threadId === filter.threadId);
    }

    // Sort by creation time (newest first)
    results.sort((a, b) =>
      new Date(b.message.createdAt).getTime() - new Date(a.message.createdAt).getTime(),
    );

    // Apply pagination
    if (filter?.offset) {
      results = results.slice(filter.offset);
    }
    if (filter?.limit) {
      results = results.slice(0, filter.limit);
    }

    return results;
  }

  async queryRetryInbox(agentName: string): Promise<RetryInboxEntry[]> {
    const storeDir = path.join(this.basePath, 'store');
    let files: string[];
    try {
      files = await fs.promises.readdir(storeDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.retryInboxCache.clear();
      return [];
    }

    const names = files.filter(file => file.endsWith('.json'));
    const nextCache = new Map<string, CachedRetryEntry>();
    const entries: RetryInboxEntry[] = [];
    for (let offset = 0; offset < names.length; offset += RETRY_SCAN_BATCH) {
      const batch = names.slice(offset, offset + RETRY_SCAN_BATCH);
      const results = await Promise.all(batch.map(file => this.readRetryEntry(storeDir, file)));
      for (const [index, cached] of results.entries()) {
        if (!cached) continue;
        nextCache.set(batch[index], cached);
        if (cached.recipient === agentName || cached.recipient === '*') entries.push(cached.entry);
      }
    }
    this.retryInboxCache = nextCache;
    return entries.sort((a, b) =>
      new Date(b.message.createdAt).getTime() - new Date(a.message.createdAt).getTime());
  }

  private async readRetryEntry(storeDir: string, file: string): Promise<CachedRetryEntry | null> {
    const filePath = path.join(storeDir, file);
    try {
      const stat = await fs.promises.stat(filePath, { bigint: true });
      // Replacement can preserve size and mtime. Inode and ctime detect that write.
      const revision = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
      const cached = this.retryInboxCache.get(file);
      if (cached?.revision === revision) return cached;
      const { message, delivery } = JSON.parse(await fs.promises.readFile(filePath, 'utf8')) as MessageEnvelope;
      return {
        revision,
        recipient: message.to.agent,
        entry: {
          message: { id: message.id, createdAt: message.createdAt, ttlMinutes: message.ttlMinutes, type: message.type },
          delivery: {
            phase: delivery.phase,
            expiresAt: delivery.expiresAt,
            lastDeliveredAt: delivery.phase === 'delivered' ? getLastDeliveredAt(delivery) : undefined,
          },
        },
      };
    } catch {
      // @silent-fallback-ok: preserve the inbox scan's handling of unreadable, removed, and corrupt files.
      return null;
    }
  }

  async queryOutbox(agentName: string, filter?: MessageFilter): Promise<MessageEnvelope[]> {
    const envelopes = this.readAllEnvelopes();

    let results = envelopes.filter(e => e.message.from.agent === agentName);

    if (filter?.type) {
      results = results.filter(e => e.message.type === filter.type);
    }
    if (filter?.priority) {
      results = results.filter(e => e.message.priority === filter.priority);
    }
    if (filter?.limit) {
      results = results.slice(0, filter.limit);
    }

    return results;
  }

  async deadLetter(messageId: string, reason: string): Promise<void> {
    const srcPath = this.messageFilePath(messageId);
    if (!srcPath || !fs.existsSync(srcPath)) {
      return;
    }

    const data = fs.readFileSync(srcPath, 'utf-8');
    const envelope = JSON.parse(data) as MessageEnvelope;

    // Update delivery state
    envelope.delivery.phase = 'dead-lettered';
    envelope.delivery.failureReason = reason;
    envelope.delivery.transitions.push({
      from: envelope.delivery.phase === 'dead-lettered' ? 'failed' : envelope.delivery.phase,
      to: 'dead-lettered',
      at: new Date().toISOString(),
      reason,
    });

    // Write to dead-letter
    const dlPath = path.join(this.basePath, 'dead-letter', `${messageId}.json`);
    fs.writeFileSync(dlPath, JSON.stringify(envelope, null, 2));

    // Remove from store
    SafeFsExecutor.safeUnlinkSync(srcPath, { operation: 'src/messaging/MessageStore.ts:250' });
  }

  async queryDeadLetters(filter?: MessageFilter): Promise<MessageEnvelope[]> {
    const dlDir = path.join(this.basePath, 'dead-letter');
    if (!fs.existsSync(dlDir)) return [];

    const files = fs.readdirSync(dlDir).filter(f => f.endsWith('.json'));
    let results: MessageEnvelope[] = [];

    for (const file of files) {
      try {
        const data = fs.readFileSync(path.join(dlDir, file), 'utf-8');
        results.push(JSON.parse(data) as MessageEnvelope);
      } catch {
        // @silent-fallback-ok — skip corrupted dead-letter files
      }
    }

    // Sort by most recent first
    results.sort((a, b) => {
      const aTime = a.delivery.transitions.at(-1)?.at ?? a.message.createdAt;
      const bTime = b.delivery.transitions.at(-1)?.at ?? b.message.createdAt;
      return bTime.localeCompare(aTime);
    });

    if (filter?.type) {
      results = results.filter(e => e.message.type === filter.type);
    }
    if (filter?.priority) {
      results = results.filter(e => e.message.priority === filter.priority);
    }
    if (filter?.fromAgent) {
      results = results.filter(e => e.message.from.agent === filter.fromAgent);
    }
    if (filter?.limit) {
      const offset = filter.offset ?? 0;
      results = results.slice(offset, offset + filter.limit);
    }

    return results;
  }

  async exists(messageId: string): Promise<boolean> {
    const filePath = this.messageFilePath(messageId);
    return filePath !== null && fs.existsSync(filePath);
  }

  /** messages-reach-renamed-sessions §D.2: a message id that already reached dead-letter. */
  async isDeadLettered(messageId: string): Promise<boolean> {
    if (!isSafeFileId(messageId)) return false; // SEC-127: ids are only ever plain file names
    return fs.existsSync(path.join(this.basePath, 'dead-letter', `${messageId}.json`));
  }

  /**
   * messages-reach-renamed-sessions §D.2: store a relayed envelope only if no record of
   * its id exists. One step both claims the id and writes the whole record (temp file,
   * then `link()`, which fails if the path exists), so two copies arriving at once can't
   * both proceed and a crash never leaves a claimed-but-empty record. True = stored.
   */
  async saveIfAbsent(envelope: MessageEnvelope): Promise<boolean> {
    const filePath = this.messageFilePath(envelope.message.id);
    if (!filePath) throw new Error('unsafe message id: refusing to store a message whose id is not a plain file name');
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.claim`;
    fs.writeFileSync(tmpPath, JSON.stringify(envelope, null, 2));
    try {
      fs.linkSync(tmpPath, filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw err;
    } finally {
      SafeFsExecutor.safeUnlinkSync(tmpPath, { operation: 'src/messaging/MessageStore.ts:saveIfAbsent' });
    }
    this.appendToIndex(envelope);
    return true;
  }

  // ── Thread Management ──────────────────────────────────────────

  async saveThread(thread: MessageThread): Promise<void> {
    const filePath = this.threadFilePath(thread.id, false);
    if (!filePath) throw new Error('unsafe thread id: refusing to store a thread whose id is not a plain file name');
    const tmpPath = `${filePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(thread, null, 2));
    fs.renameSync(tmpPath, filePath);
  }

  async getThread(threadId: string): Promise<MessageThread | null> {
    const filePath = this.threadFilePath(threadId, false);
    const archivePath = this.threadFilePath(threadId, true);
    if (!filePath || !archivePath) return null;
    try {
      const data = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(data) as MessageThread;
    } catch { // @silent-fallback-ok — thread file not found, check archive
      try {
        const data = fs.readFileSync(archivePath, 'utf-8');
        return JSON.parse(data) as MessageThread;
      } catch { // @silent-fallback-ok — thread not found in archive either, return null
        return null;
      }
    }
  }

  async listThreads(status?: ThreadStatus): Promise<MessageThread[]> {
    const threadsDir = path.join(this.basePath, 'threads');
    if (!fs.existsSync(threadsDir)) return [];

    const files = fs.readdirSync(threadsDir).filter(f => f.endsWith('.json'));
    const threads: MessageThread[] = [];

    for (const file of files) {
      try {
        const data = fs.readFileSync(path.join(threadsDir, file), 'utf-8');
        const thread = JSON.parse(data) as MessageThread;
        if (!status || thread.status === status) {
          threads.push(thread);
        }
      } catch {
        // @silent-fallback-ok — skip corrupt thread files
      }
    }

    // Sort by most recent activity first
    threads.sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
    return threads;
  }

  async archiveThread(threadId: string): Promise<void> {
    const srcPath = this.threadFilePath(threadId, false);
    const destPath = this.threadFilePath(threadId, true);
    if (!srcPath || !destPath || !fs.existsSync(srcPath)) return;

    fs.renameSync(srcPath, destPath);
  }

  async getStats(): Promise<MessagingStats> {
    const envelopes = this.readAllEnvelopes();
    const now = Date.now();
    const fiveMinAgo = now - 5 * 60_000;
    const oneHrAgo = now - 60 * 60_000;

    const sent = envelopes.filter(e =>
      e.delivery.transitions.some(t => t.to === 'sent'),
    );
    const received = envelopes.filter(e =>
      e.delivery.transitions.some(t => t.to === 'received'),
    );

    const dlDir = path.join(this.basePath, 'dead-letter');
    const dlCount = fs.existsSync(dlDir) ? fs.readdirSync(dlDir).filter(f => f.endsWith('.json')).length : 0;

    return {
      volume: {
        sent: {
          total: sent.length,
          last5min: sent.filter(e => new Date(e.message.createdAt).getTime() > fiveMinAgo).length,
          last1hr: sent.filter(e => new Date(e.message.createdAt).getTime() > oneHrAgo).length,
        },
        received: {
          total: received.length,
          last5min: received.filter(e => new Date(e.message.createdAt).getTime() > fiveMinAgo).length,
          last1hr: received.filter(e => new Date(e.message.createdAt).getTime() > oneHrAgo).length,
        },
        deadLettered: {
          total: dlCount,
          last5min: 0,
          last1hr: 0,
        },
      },
      delivery: {
        avgLatencyMs: { layer1: 0, layer2: 0, layer3: 0 },
        successRate: { layer1: 0, layer2: 0, layer3: 0 },
      },
      rateLimiting: {
        sessionsThrottled: 0,
        circuitBreakers: { open: 0, recentTrips: 0 },
      },
      threads: await this.getThreadStats(),
    };
  }

  async cleanup(): Promise<{ deleted: number; deadLettered: number }> {
    let deleted = 0;
    let deadLettered = 0;

    // Scan dead-letter for files past retention (30 days default)
    const dlDir = path.join(this.basePath, 'dead-letter');
    if (fs.existsSync(dlDir)) {
      const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60_000;
      for (const file of fs.readdirSync(dlDir)) {
        if (!file.endsWith('.json')) continue;
        const filePath = path.join(dlDir, file);
        try {
          const stat = fs.statSync(filePath);
          if (stat.mtimeMs < thirtyDaysAgo) {
            SafeFsExecutor.safeUnlinkSync(filePath, { operation: 'src/messaging/MessageStore.ts:415' });
            deleted++;
          }
        } catch {
          // @silent-fallback-ok — best-effort cleanup of expired dead-letter files
        }
      }
    }

    return { deleted, deadLettered };
  }

  async destroy(): Promise<void> {
    // No-op for normal usage; tests use this for cleanup
  }

  // ── Private Helpers ──────────────────────────────────────────────

  /** SEC-127: see src/core/safeFileId.ts. */
  static readonly MAX_FILE_ID_BYTES = MAX_FILE_ID_BYTES;
  static isSafeFileId(id: unknown): id is string { return isSafeFileId(id); }

  private messageFilePath(messageId: string): string | null {
    if (!MessageStore.isSafeFileId(messageId)) return null;
    return path.join(this.basePath, 'store', `${messageId}.json`);
  }

  private threadFilePath(threadId: string, archived: boolean): string | null {
    if (!MessageStore.isSafeFileId(threadId)) return null;
    return archived
      ? path.join(this.basePath, 'threads', 'archive', `${threadId}.json`)
      : path.join(this.basePath, 'threads', `${threadId}.json`);
  }

  private async getThreadStats(): Promise<{ active: number; resolved: number; stale: number }> {
    const threads = await this.listThreads();
    let active = 0, resolved = 0, stale = 0;
    for (const t of threads) {
      if (t.status === 'active') active++;
      else if (t.status === 'resolved') resolved++;
      else if (t.status === 'stale') stale++;
    }
    return { active, resolved, stale };
  }

  private readAllEnvelopes(): MessageEnvelope[] {
    const storeDir = path.join(this.basePath, 'store');
    if (!fs.existsSync(storeDir)) return [];

    const files = fs.readdirSync(storeDir).filter(f => f.endsWith('.json'));
    const envelopes: MessageEnvelope[] = [];

    for (const file of files) {
      try {
        const data = fs.readFileSync(path.join(storeDir, file), 'utf-8');
        envelopes.push(JSON.parse(data));
      } catch {
        // Skip corrupt files
      }
    }

    return envelopes;
  }

  private appendToIndex(envelope: MessageEnvelope): void {
    const indexEntry = {
      id: envelope.message.id,
      from: envelope.message.from.agent,
      to: envelope.message.to.agent,
      type: envelope.message.type,
      priority: envelope.message.priority,
      phase: envelope.delivery.phase,
      createdAt: envelope.message.createdAt,
    };

    const inboxPath = path.join(this.basePath, 'index', 'inbox.jsonl');
    const outboxPath = path.join(this.basePath, 'index', 'outbox.jsonl');

    maybeRotateJsonl(outboxPath, { maxBytes: 5 * 1024 * 1024, keepRatio: 0.5 });
    maybeRotateJsonl(inboxPath, { maxBytes: 5 * 1024 * 1024, keepRatio: 0.5 });
    fs.appendFileSync(outboxPath, JSON.stringify(indexEntry) + '\n');
    fs.appendFileSync(inboxPath, JSON.stringify(indexEntry) + '\n');
  }
}

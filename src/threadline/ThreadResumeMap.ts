/**
 * ThreadResumeMap — persistent mapping from thread IDs to Claude/Codex session
 * UUIDs, for `--resume`.
 *
 * Phase 2a (THREADLINE-SINGLE-STORE-SPEC.md / CMT-497): this is now a **view over
 * `ConversationStore`** — the single source of truth. Every method maps the legacy
 * `ThreadResumeEntry` shape onto a `Conversation` record via the field bridge
 * below. `save` MERGES (it never clobbers the loop gate's `turnCount`/
 * `lastInboundHash`/`lastOutboundHash`). The on-disk `thread-resume-map.json` is no
 * longer written; a one-release dual-read window falls back to it on a miss and
 * writes through, so threads written by a pre-2a version are not lost.
 *
 * Field bridge (ThreadResumeEntry ↔ Conversation):
 *   uuid↔sessionUuid · sessionName↔boundSessionName · lastAccessedAt↔lastActivityAt
 *   originTopicId↔boundTopicId · originSessionName↔originSessionName · the rest 1:1.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { findRolloutFileSync } from '../providers/adapters/openai-codex/observability/sessionPaths.js';
import { findGeminiSessionFileSync } from '../providers/adapters/gemini-cli/observability/sessionPaths.js';
import { ConversationStore, type Conversation, type ConversationState } from './ConversationStore.js';

// ── Types ───────────────────────────────────────────────────────

/** Thread lifecycle state (legacy subset of ConversationState). */
export type ThreadState = 'active' | 'idle' | 'resolved' | 'failed' | 'archived';

/** A single thread resume mapping entry. */
export interface ThreadResumeEntry {
  uuid: string;
  sessionName: string;
  createdAt: string;
  savedAt: string;
  lastAccessedAt: string;
  remoteAgent: string;
  subject: string;
  state: ThreadState;
  resolvedAt?: string;
  pinned: boolean;
  messageCount: number;
  machineOrigin?: string;
  migratedTo?: string;
  spawnMode?: 'interactive' | 'pipe';
  originTopicId?: number;
  originSessionName?: string;
}

export interface ThreadResumeSessionMatch {
  threadId: string;
  entry: ThreadResumeEntry;
  conversationState: ConversationState;
}

// ── Field bridge ────────────────────────────────────────────────

/** Map a Conversation lifecycle state onto the legacy ThreadState subset. */
function toThreadState(s: Conversation['state']): ThreadState {
  if (s === 'open' || s === 'awaiting-reply') return 'active';
  return s;
}

/** Conversation → ThreadResumeEntry (read direction). */
function conversationToEntry(c: Conversation): ThreadResumeEntry {
  return {
    uuid: c.sessionUuid ?? '',
    sessionName: c.boundSessionName ?? '',
    createdAt: c.createdAt,
    savedAt: c.savedAt,
    lastAccessedAt: c.lastActivityAt,
    remoteAgent: c.remoteAgent ?? c.participants.peers[0] ?? '',
    subject: c.subject ?? '',
    state: toThreadState(c.state),
    resolvedAt: c.resolvedAt,
    pinned: c.pinned,
    messageCount: c.messageCount,
    machineOrigin: c.machineOrigin,
    migratedTo: c.migratedTo,
    spawnMode: c.spawnMode,
    originTopicId: c.boundTopicId,
    originSessionName: c.originSessionName,
  };
}

/**
 * Apply a ThreadResumeEntry onto a Conversation draft (write direction) —
 * MERGING: resume fields are set from the entry, but the loop gate's
 * `turnCount`/`lastInboundHash`/`lastOutboundHash` are LEFT INTACT (convergence
 * finding — a legacy save must not wipe turn state).
 */
function applyEntryToConversation(entry: ThreadResumeEntry, draft: Conversation): Conversation {
  if (entry.uuid) draft.sessionUuid = entry.uuid;
  if (entry.sessionName) draft.boundSessionName = entry.sessionName;
  if (entry.remoteAgent) {
    draft.remoteAgent = entry.remoteAgent;
    if (!draft.participants.peers.includes(entry.remoteAgent)) draft.participants.peers.push(entry.remoteAgent);
  }
  if (entry.subject) draft.subject = entry.subject;
  draft.state = entry.state; // legacy state is authoritative on an explicit save
  if (entry.resolvedAt !== undefined) draft.resolvedAt = entry.resolvedAt;
  draft.pinned = entry.pinned;
  // messageCount is shared with the gate — never go backwards.
  draft.messageCount = Math.max(draft.messageCount ?? 0, entry.messageCount ?? 0);
  if (entry.machineOrigin !== undefined) draft.machineOrigin = entry.machineOrigin;
  if (entry.migratedTo !== undefined) draft.migratedTo = entry.migratedTo;
  if (entry.spawnMode !== undefined) draft.spawnMode = entry.spawnMode;
  if (entry.originTopicId !== undefined) draft.boundTopicId = entry.originTopicId;
  if (entry.originSessionName !== undefined) draft.originSessionName = entry.originSessionName;
  if (entry.createdAt && draft.version === 0) draft.createdAt = entry.createdAt;
  draft.lastActivityAt = entry.lastAccessedAt || new Date().toISOString();
  // turnCount / lastInboundHash / lastOutboundHash: intentionally untouched.
  return draft;
}

// ── Constants ───────────────────────────────────────────────────

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const RESOLVED_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_INACTIVE_RETIRE_MS = 24 * 60 * 60 * 1000;

// ── Implementation ──────────────────────────────────────────────

export class ThreadResumeMap {
  private store: ConversationStore;
  private legacyPath: string;
  private projectDir: string;
  private tmuxPath: string;

  constructor(stateDir: string, projectDir: string, tmuxPath?: string, store?: ConversationStore) {
    this.store = store ?? new ConversationStore(stateDir);
    this.legacyPath = path.join(stateDir, 'threadline', 'thread-resume-map.json');
    this.projectDir = projectDir;
    this.tmuxPath = tmuxPath || 'tmux';
  }

  /**
   * Look up a thread resume entry. Returns null if not found, expired, or the
   * session JSONL no longer exists. Dual-read: on a ConversationStore miss, fall
   * back to the legacy file and write through (one-release transition window).
   */
  get(threadId: string): ThreadResumeEntry | null {
    let c = this.store.get(threadId);
    if (!c) {
      const legacy = this.readLegacyEntry(threadId);
      if (legacy) {
        this.save(threadId, legacy); // write-through to ConversationStore
        c = this.store.get(threadId);
      }
    }
    if (!c) return null;
    const entry = conversationToEntry(c);
    // Resume guard: the session JSONL must still exist (unless pinned). A
    // topic-linkage entry (originTopicId set) is exempt — its liveness is the
    // Telegram topic's, not a Claude-session transcript's. These entries are
    // stamped with an empty/non-JSONL uuid (see TopicLinkageHandler.captureOriginOnSend),
    // so the JSONL guard would wrongly null them — dropping inbound replies to
    // spawnNewThread (A1) and breaking threadline_history lookups (C). Dead
    // topic-linkage entries still expire via ConversationStore's TTL, and the
    // topic's real liveness is re-checked at route time (TopicLinkageHandler.topicActive).
    if (!entry.pinned && entry.originTopicId === undefined && !this.jsonlExists(entry.uuid)) {
      return null;
    }
    return entry;
  }

  /** Save or update a thread resume mapping (MERGES — preserves gate turn state). */
  save(threadId: string, entry: ThreadResumeEntry): void {
    this.store.mutateSync(threadId, draft => applyEntryToConversation({ ...entry, savedAt: new Date().toISOString() }, draft));
  }

  /** Remove a thread entry (cross-process safe via ConversationStore). */
  remove(threadId: string): void {
    this.store.mutateSync(threadId, () => null);
  }

  /** Mark a thread resolved (grace period before removal). */
  resolve(threadId: string): void {
    if (!this.store.get(threadId)) return;
    this.store.mutateSync(threadId, draft => {
      draft.state = 'resolved';
      draft.resolvedAt = new Date().toISOString();
      return draft;
    });
  }

  /** Pin — never evicted. */
  pin(threadId: string): void {
    if (!this.store.get(threadId)) return;
    this.store.mutateSync(threadId, draft => { draft.pinned = true; return draft; });
  }

  /** Unpin — allow normal TTL/LRU eviction. */
  unpin(threadId: string): void {
    if (!this.store.get(threadId)) return;
    this.store.mutateSync(threadId, draft => { draft.pinned = false; return draft; });
  }

  /** Find all (non-expired) threads with a specific remote agent. */
  getByRemoteAgent(agentName: string): Array<{ threadId: string; entry: ThreadResumeEntry }> {
    this.retireInactive();
    return this.store.getByParticipant(agentName)
      .map(c => ({ threadId: c.threadId, entry: conversationToEntry(c) }));
  }

  /** List all active or idle threads. */
  listActive(): Array<{ threadId: string; entry: ThreadResumeEntry }> {
    this.retireInactive();
    return this.store.listActive()
      .map(c => ({ threadId: c.threadId, entry: conversationToEntry(c) }))
      .filter(({ entry }) => entry.state === 'active' || entry.state === 'idle');
  }

  /** Reverse lookup live conversation entries by their bound tmux session name. */
  getBySessionName(sessionName: string): ThreadResumeSessionMatch[] {
    return this.store.listActive()
      .filter(c => c.boundSessionName === sessionName)
      .map(c => ({
        threadId: c.threadId,
        entry: conversationToEntry(c),
        conversationState: c.state,
      }));
  }

  /** Reverse lookup live conversation entries by their bound SessionManager UUID. */
  getBySessionUuid(uuid: string): ThreadResumeSessionMatch[] {
    return this.store.listActive()
      .filter(c => c.sessionUuid === uuid)
      .map(c => ({
        threadId: c.threadId,
        entry: conversationToEntry(c),
        conversationState: c.state,
      }));
  }

  /** Archive stale non-pinned active/idle/open conversations. */
  retireInactive(maxInactiveMs: number = DEFAULT_INACTIVE_RETIRE_MS, now: Date = new Date()): number {
    return this.store.retireInactive(maxInactiveMs, now);
  }

  /** Cross-machine failover: demote a source machine's active threads to idle. */
  migrateFrom(sourceMachine: string, targetMachine: string): { migrated: number; skipped: number } {
    let migrated = 0; let skipped = 0;
    // Iterate ALL conversations (not just active) so resolved/failed threads from
    // the source machine are counted as skipped, matching legacy semantics.
    for (const c of this.store.all()) {
      if (c.machineOrigin !== sourceMachine) continue;
      if (c.state === 'active') {
        this.store.mutateSync(c.threadId, draft => {
          draft.migratedTo = targetMachine;
          draft.state = 'idle';
          return draft;
        });
        migrated++;
      } else {
        skipped++;
      }
    }
    return { migrated, skipped };
  }

  /** Get entries migrated to this machine (for resume capability). */
  getMigratedEntries(targetMachine: string): Array<{ threadId: string; entry: ThreadResumeEntry }> {
    return this.store.all()
      .filter(c => c.migratedTo === targetMachine)
      .map(c => ({ threadId: c.threadId, entry: conversationToEntry(c) }));
  }

  /** Total stored entries (for monitoring). */
  size(): number {
    return this.store.size();
  }

  /** Prune expired / resolved-past-grace / LRU overflow. */
  prune(): void {
    this.store.prune();
  }

  /**
   * Proactive resume heartbeat: scan active thread-linked tmux sessions and
   * update the thread→UUID mapping so a crash leaves the UUID on file.
   */
  refreshResumeMappings(threadSessions: Map<string, string>): void {
    try {
      if (!threadSessions || threadSessions.size === 0) return;
      const projectHash = this.projectDir.replace(/\//g, '-');
      const projectJsonlDir = path.join(os.homedir(), '.claude', 'projects', projectHash);
      if (!fs.existsSync(projectJsonlDir)) return;

      const jsonlFiles = fs.readdirSync(projectJsonlDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => {
          try {
            const stat = fs.statSync(path.join(projectJsonlDir, f));
            return { mtimeMs: stat.mtimeMs, uuid: f.replace('.jsonl', '') };
          } catch { return null; }
        })
        .filter((f): f is { mtimeMs: number; uuid: string } => f !== null && f.uuid.length >= 30)
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      if (jsonlFiles.length === 0) return;

      const claimedUuids = new Set<string>();
      for (const [threadId, sessionName] of threadSessions) {
        const hasSession = spawnSync(this.tmuxPath, ['has-session', '-t', `=${sessionName}`]);
        if (hasSession.status !== 0) continue;
        const availableJsonl = jsonlFiles.find(f => !claimedUuids.has(f.uuid));
        if (!availableJsonl) continue;
        claimedUuids.add(availableJsonl.uuid);

        const existing = this.store.get(threadId);
        const entryAge = existing ? Date.now() - new Date(existing.savedAt).getTime() : Infinity;
        if (existing && (existing.sessionUuid !== availableJsonl.uuid || entryAge > 2 * 60 * 60 * 1000)) {
          this.store.mutateSync(threadId, draft => {
            draft.sessionUuid = availableJsonl.uuid;
            draft.boundSessionName = sessionName;
            draft.lastActivityAt = new Date().toISOString();
            return draft;
          });
        }
      }
    } catch (err) {
      console.error('[ThreadResumeMap] Resume heartbeat error:', err);
    }
  }

  // ── Private helpers ──────────────────────────────────────────

  /** Dual-read: read a single entry from the frozen legacy file, if present + fresh. */
  private readLegacyEntry(threadId: string): ThreadResumeEntry | null {
    try {
      if (!fs.existsSync(this.legacyPath)) return null;
      const map = JSON.parse(fs.readFileSync(this.legacyPath, 'utf-8')) as Record<string, ThreadResumeEntry>;
      const entry = map[threadId];
      if (!entry) return null;
      if (!entry.pinned && this.isExpired(entry)) return null;
      return entry;
    } catch {
      return null;
    }
  }

  private isExpired(entry: ThreadResumeEntry): boolean {
    const now = Date.now();
    if (entry.state === 'resolved' && entry.resolvedAt) {
      return now - new Date(entry.resolvedAt).getTime() > RESOLVED_GRACE_MS;
    }
    const ref = entry.lastAccessedAt || entry.savedAt;
    return now - new Date(ref).getTime() > MAX_AGE_MS;
  }

  /** Check if a JSONL file exists for the given session UUID. (protected so
   *  tests can bypass the filesystem check via a subclass.) */
  protected jsonlExists(uuid: string): boolean {
    if (!uuid) return false;
    // Claude: flat ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl.
    const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
    if (fs.existsSync(claudeProjectsDir)) {
      try {
        for (const dir of fs.readdirSync(claudeProjectsDir)) {
          if (fs.existsSync(path.join(claudeProjectsDir, dir, `${uuid}.jsonl`))) return true;
        }
      } catch {
        // Can't check the Claude layout — fall through to the codex layout.
      }
    }
    // Codex: date-partitioned $CODEX_HOME/sessions/.../rollout-<ts>-<uuid>.jsonl.
    // A codex thread has no Claude jsonl, so without this every codex session
    // looks expired/missing and resume breaks fleet-wide (codex-compat root).
    try {
      if (findRolloutFileSync(uuid) !== null) return true;
    } catch {
      // Can't check the codex layout — treat as not found.
    }
    // Gemini: ~/.gemini/tmp/<projectHash>/chats/session-<ts>-<short8>.json[l].
    // A gemini session has neither a Claude jsonl nor a codex rollout, so
    // without this every gemini session looks expired/missing and resume
    // breaks fleet-wide (the gemini analog of the codex-compat resume root —
    // apprenticeship Step 2 §4.0.1). Routed through the gemini adapter's
    // sessionPaths resolver, NOT a third hardcoded probe inline.
    try {
      if (findGeminiSessionFileSync(uuid) !== null) return true;
    } catch {
      // Can't check the gemini layout — treat as not found.
    }
    return false;
  }
}

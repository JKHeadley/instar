/**
 * SubagentTracker — Tracks Claude Code subagent lifecycle.
 *
 * Monitors SubagentStart and SubagentStop events to maintain awareness of:
 *   - Which subagents are active (spawned but not stopped)
 *   - What subagents produced (last_assistant_message, transcript path)
 *   - Subagent history per session
 *
 * Designed to consume events from HookEventReceiver (for HTTP-delivered events)
 * and directly from the SubagentStart command hook (which records to state).
 *
 * Part of the Claude Code Feature Integration Audit:
 * - Item 3 (New Hook Events): SubagentStart/Stop lifecycle tracking (H5)
 */

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

// ── Types ──────────────────────────────────────────────────────────

export interface SubagentRecord {
  /** Unique agent ID assigned by Claude Code */
  agentId: string;
  /** Agent type (e.g., "Explore", "Plan", custom agent names) */
  agentType: string;
  /** Session this subagent belongs to */
  sessionId: string;
  /** ISO timestamp when subagent started */
  startedAt: string;
  /** ISO timestamp when subagent stopped (null if still active) */
  stoppedAt: string | null;
  /** Last assistant message from the subagent (captured on stop) */
  lastMessage: string | null;
  /** Path to the subagent's transcript file (captured on stop) */
  transcriptPath: string | null;
}

export interface SubagentTrackerConfig {
  /** State directory for persisting subagent data */
  stateDir: string;
  /** Max completed subagents to retain per session (default: 100) */
  maxPerSession?: number;
}

// ── Implementation ─────────────────────────────────────────────────

const DEFAULT_MAX_PER_SESSION = 100;

export class SubagentTracker extends EventEmitter {
  private config: SubagentTrackerConfig;
  private dataDir: string;
  /** In-memory index: sessionId -> active agentIds */
  private activeAgents: Map<string, Set<string>> = new Map();

  constructor(config: SubagentTrackerConfig) {
    super();
    this.config = config;
    this.dataDir = path.join(config.stateDir, 'subagent-tracking');
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
    this.loadActiveIndex();
  }

  /**
   * Record a subagent start event.
   * Called from SubagentStart command hook or when processing HookEventReceiver events.
   */
  onStart(agentId: string, agentType: string, sessionId: string): void {
    const record: SubagentRecord = {
      agentId,
      agentType,
      sessionId,
      startedAt: new Date().toISOString(),
      stoppedAt: null,
      lastMessage: null,
      transcriptPath: null,
    };

    this.appendRecord(sessionId, record);

    // Track as active
    if (!this.activeAgents.has(sessionId)) {
      this.activeAgents.set(sessionId, new Set());
    }
    this.activeAgents.get(sessionId)!.add(agentId);

    this.emit('start', record);
  }

  /**
   * Record a subagent stop event.
   * Called when processing SubagentStop from HookEventReceiver.
   */
  onStop(
    agentId: string,
    sessionId: string,
    lastMessage?: string,
    transcriptPath?: string,
  ): void {
    const records = this.getSessionRecords(sessionId);
    const record = records.find(r => r.agentId === agentId && !r.stoppedAt);

    if (record) {
      record.stoppedAt = new Date().toISOString();
      record.lastMessage = lastMessage ?? null;
      record.transcriptPath = transcriptPath ?? null;
      this.rewriteSession(sessionId, records);
    } else {
      // SubagentStop without a matching start — record what we have
      const orphan: SubagentRecord = {
        agentId,
        agentType: 'unknown',
        sessionId,
        startedAt: new Date().toISOString(), // approximate
        stoppedAt: new Date().toISOString(),
        lastMessage: lastMessage ?? null,
        transcriptPath: transcriptPath ?? null,
      };
      this.appendRecord(sessionId, orphan);
    }

    // Remove from active
    this.activeAgents.get(sessionId)?.delete(agentId);

    this.emit('stop', { agentId, sessionId, lastMessage, transcriptPath });
  }

  /**
   * Get all subagent records for a session.
   */
  getSessionRecords(sessionId: string): SubagentRecord[] {
    const file = this.getSessionFile(sessionId);
    if (!fs.existsSync(file)) return [];

    return fs.readFileSync(file, 'utf-8')
      .trim()
      .split('\n')
      .filter(line => line)
      .map(line => {
        try { return JSON.parse(line); }
        catch { return null; }
      })
      .filter((r): r is SubagentRecord => r !== null);
  }

  /**
   * Get currently active (started but not stopped) subagents for a session.
   */
  getActiveSubagents(sessionId: string): SubagentRecord[] {
    return this.getSessionRecords(sessionId).filter(r => !r.stoppedAt);
  }

  /**
   * O(1) liveness check (HONEST-PROGRESS-MESSAGING A2/FD-4): does this session
   * have any started-but-not-stopped sub-agent? Backed by the in-memory
   * `activeAgents` index — no JSONL read — so the silence sentinel's per-tick
   * corroboration stays cheap. "Live" = any tracked sub-agent with no stoppedAt,
   * regardless of sleep/pause state (conservative: a dormant-but-not-stopped
   * sub-agent suppresses a false "stuck" escalation).
   */
  hasActiveSubagents(sessionId: string): boolean {
    return (this.activeAgents.get(sessionId)?.size ?? 0) > 0;
  }

  /**
   * Get completed subagents for a session.
   */
  getCompletedSubagents(sessionId: string): SubagentRecord[] {
    return this.getSessionRecords(sessionId).filter(r => r.stoppedAt !== null);
  }

  /**
   * Get a summary of subagent activity for a session.
   */
  getSessionSummary(sessionId: string): {
    total: number;
    active: number;
    completed: number;
    agentTypes: Record<string, number>;
    withOutput: number;
  } | null {
    const records = this.getSessionRecords(sessionId);
    if (records.length === 0) return null;

    const active = records.filter(r => !r.stoppedAt);
    const completed = records.filter(r => r.stoppedAt !== null);
    const agentTypes: Record<string, number> = {};
    for (const r of records) {
      agentTypes[r.agentType] = (agentTypes[r.agentType] ?? 0) + 1;
    }
    const withOutput = completed.filter(r => r.lastMessage).length;

    return {
      total: records.length,
      active: active.length,
      completed: completed.length,
      agentTypes,
      withOutput,
    };
  }

  /**
   * List all sessions with subagent tracking data.
   */
  listSessions(): string[] {
    try {
      return fs.readdirSync(this.dataDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => f.replace('.jsonl', ''))
        .sort();
    } catch {
      return [];
    }
  }

  // ── Internals ──────────────────────────────────────────────────

  private getSessionFile(sessionId: string): string {
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
    return path.join(this.dataDir, `${safe}.jsonl`);
  }

  private appendRecord(sessionId: string, record: SubagentRecord): void {
    const file = this.getSessionFile(sessionId);
    fs.appendFileSync(file, JSON.stringify(record) + '\n');
    this.enforceLimit(sessionId);
  }

  private rewriteSession(sessionId: string, records: SubagentRecord[]): void {
    const file = this.getSessionFile(sessionId);
    fs.writeFileSync(file, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  }

  private enforceLimit(sessionId: string): void {
    const max = this.config.maxPerSession ?? DEFAULT_MAX_PER_SESSION;
    const records = this.getSessionRecords(sessionId);
    if (records.length <= max) return;

    // Always preserve active (not-yet-stopped) agents.
    // Fill remaining slots with most recent completed (by file position = append order).
    const activeIndices = new Set<number>();
    const completedIndices: number[] = [];
    records.forEach((r, i) => {
      if (!r.stoppedAt) activeIndices.add(i);
      else completedIndices.push(i);
    });

    const completedSlots = Math.max(0, max - activeIndices.size);
    const keptCompletedIndices = new Set(
      completedIndices.slice(-completedSlots),
    );

    // Filter preserves original file order (chronological)
    const kept = records.filter((_, i) =>
      activeIndices.has(i) || keptCompletedIndices.has(i),
    );
    this.rewriteSession(sessionId, kept);
  }

  private loadActiveIndex(): void {
    for (const sessionId of this.listSessions()) {
      const active = this.getActiveSubagents(sessionId);
      if (active.length > 0) {
        this.activeAgents.set(sessionId, new Set(active.map(r => r.agentId)));
      }
    }
  }
}

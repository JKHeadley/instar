/**
 * HookEventReceiver — Receives and stores Claude Code hook events via HTTP.
 *
 * Provides a POST endpoint that HTTP hooks can deliver events to.
 * Stores events per-session for telemetry, and emits typed events
 * for other modules to react to (e.g., WorktreeMonitor, ExecutionJournal).
 *
 * Part of the Claude Code Feature Integration Audit:
 * - Item 2 (HTTP Hooks): Hook event receiver endpoint
 * - Item 3 (New Hook Events): Observability events processing
 */

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';

// ── Types ──────────────────────────────────────────────────────────

/**
 * Claude Code hook event payload — the JSON body sent by HTTP hooks.
 * Fields vary by event type; these are the common ones.
 */
export interface HookEventPayload {
  /** Hook event type (e.g., "PostToolUse", "SubagentStart", "Stop") */
  event: string;
  /** Session ID from Claude Code */
  session_id?: string;
  /** Current working directory */
  cwd?: string;
  /** Tool name (for tool-related events) */
  tool_name?: string;
  /** Tool input (for tool-related events) */
  tool_input?: Record<string, unknown>;
  /** Tool output (for PostToolUse) */
  tool_output?: string;
  /** Agent ID (present when event fires inside a subagent) */
  agent_id?: string;
  /** Agent type (present for subagent or --agent sessions) */
  agent_type?: string;
  /** Task ID (for TaskCompleted) */
  task_id?: string;
  /** Task subject (for TaskCompleted) */
  task_subject?: string;
  /** Task description (for TaskCompleted) */
  task_description?: string;
  /** Agent transcript path (for SubagentStop) */
  agent_transcript_path?: string;
  /** Last assistant message (for Stop, SubagentStop) */
  last_assistant_message?: string;
  /** Stop reason (for SessionEnd) */
  reason?: string;
  /** File path (for InstructionsLoaded, ConfigChange) */
  file_path?: string;
  /** Memory type (for InstructionsLoaded) */
  memory_type?: string;
  /** Compaction trigger (for PreCompact) */
  trigger?: string;
  /** Worktree name/path (for WorktreeCreate/Remove) */
  worktree_path?: string;
  /** Teammate name (for TaskCompleted, TeammateIdle) */
  teammate_name?: string;
  /** Additional fields */
  [key: string]: unknown;
}

/** Stored event with metadata */
export interface StoredHookEvent {
  /** ISO timestamp when received */
  receivedAt: string;
  /** The raw payload */
  payload: HookEventPayload;
}

/** Summary of events for a session */
export interface SessionEventSummary {
  sessionId: string;
  eventCount: number;
  eventTypes: Record<string, number>;
  firstEvent: string;
  lastEvent: string;
  toolsUsed: string[];
  subagentsSpawned: string[];
  lastAssistantMessage?: string;
}

export interface HookEventReceiverConfig {
  /** State directory for persisting events */
  stateDir: string;
  /** Max events to keep per session (default: 500). Reaching it trims to 80% (hysteresis). */
  maxEventsPerSession?: number;
  /** Max sessions to keep (default: 50). Live sessions are never evicted. */
  maxSessions?: number;
  /**
   * The tmux name's CURRENT incarnation id (its running session's
   * INSTAR_SESSION_ID), or null. Tmux-scoped lookups read only events stamped
   * with this id, so an earlier incarnation of a reused name never answers.
   */
  resolveCurrentInstarSessionId?: (tmuxSession: string) => string | null;
  /** Is this incarnation (INSTAR_SESSION_ID) live right now? Eviction never removes a live one. */
  isLiveInstarSession?: (instarSessionId: string) => boolean;
}

// ── Implementation ─────────────────────────────────────────────────

const DEFAULT_MAX_EVENTS = 500;
const DEFAULT_MAX_SESSIONS = 50;

/** Running summary of one (Claude session, incarnation) slice of retained events. */
interface SummaryAcc {
  eventCount: number;
  eventTypes: Record<string, number>;
  firstEvent: string;
  lastEvent: string;
  toolsUsed: Set<string>;
  subagentsSpawned: Set<string>;
  lastAssistantMessage?: string;
  lastAssistantAt?: string;
  taskCompleted: boolean;
  sawSessionEnd: boolean;
  exitReason: string | null;
}

interface SessionMeta {
  count: number;
  lastReceivedMs: number;
  /** keyed by instar_session_id ('' for events stored without one) */
  accs: Map<string, SummaryAcc>;
}

function newAcc(at: string): SummaryAcc {
  return {
    eventCount: 0, eventTypes: {}, firstEvent: at, lastEvent: at,
    toolsUsed: new Set(), subagentsSpawned: new Set(),
    taskCompleted: false, sawSessionEnd: false, exitReason: null,
  };
}

function applyToAcc(acc: SummaryAcc, ev: StoredHookEvent): void {
  const p = ev.payload;
  const type = p.event;
  acc.eventCount++;
  acc.eventTypes[type] = (acc.eventTypes[type] ?? 0) + 1;
  acc.lastEvent = ev.receivedAt;
  if (typeof p.tool_name === 'string' && p.tool_name) acc.toolsUsed.add(p.tool_name);
  if (type === 'SubagentStart' && typeof p.agent_type === 'string' && p.agent_type) acc.subagentsSpawned.add(p.agent_type);
  if (typeof p.last_assistant_message === 'string' && p.last_assistant_message) {
    acc.lastAssistantMessage = p.last_assistant_message;
    acc.lastAssistantAt = ev.receivedAt;
  }
  if (type === 'TaskCompleted') acc.taskCompleted = true;
  // A `/clear` ends one Claude conversation but the session keeps running in
  // the same process (its next conversation is the same incarnation), so it is
  // not an exit.
  if (type === 'SessionEnd' && !acc.sawSessionEnd && p.reason !== 'clear') {
    acc.sawSessionEnd = true;
    acc.exitReason = typeof p.reason === 'string' ? p.reason : null;
  }
}

function incarnationOf(p: HookEventPayload): string {
  return typeof p.instar_session_id === 'string' ? p.instar_session_id : '';
}

// RULE 3: EXEMPT — stores structured JSON events delivered by Claude Code's documented hook API
// (named fields, no terminal-output or prose pattern matching), so there is no screen-state
// detector here to canary.
export class HookEventReceiver extends EventEmitter {
  private config: HookEventReceiverConfig;
  private eventsDir: string;
  /** safe sessionId (file stem) -> event count. Kept for getIndex() compat. */
  private sessionIndex: Map<string, number> = new Map();
  /** safe sessionId -> in-memory summary state over the retained events. */
  private meta: Map<string, SessionMeta> = new Map();
  /** instar_session_id -> safe Claude session ids (one per incarnation; more after /clear). */
  private incarnationIndex: Map<string, Set<string>> = new Map();

  constructor(config: HookEventReceiverConfig) {
    super();
    this.config = config;
    this.eventsDir = path.join(config.stateDir, 'hook-events');
    if (!fs.existsSync(this.eventsDir)) {
      fs.mkdirSync(this.eventsDir, { recursive: true });
    }
    this.loadIndex();
  }

  /** Late-bind the session-manager lookups (server.ts builds the receiver first). */
  setSessionResolvers(resolvers: {
    resolveCurrentInstarSessionId?: (tmuxSession: string) => string | null;
    isLiveInstarSession?: (instarSessionId: string) => boolean;
  }): void {
    if (resolvers.resolveCurrentInstarSessionId) this.config.resolveCurrentInstarSessionId = resolvers.resolveCurrentInstarSessionId;
    if (resolvers.isLiveInstarSession) this.config.isLiveInstarSession = resolvers.isLiveInstarSession;
  }

  /**
   * Receive a hook event. Called from the HTTP endpoint.
   * Returns true if stored successfully.
   */
  receive(payload: HookEventPayload): boolean {
    const sessionId = payload.session_id ?? 'unknown';
    const key = this.safeId(sessionId);
    const stored: StoredHookEvent = {
      receivedAt: new Date().toISOString(),
      payload,
    };

    // Append to session event file (JSONL)
    const sessionFile = this.getSessionFile(sessionId);
    try {
      fs.appendFileSync(sessionFile, JSON.stringify(stored) + '\n');
    } catch {
      return false;
    }

    // Update index + in-memory summary
    const m = this.metaFor(key);
    this.applyEvent(key, m, stored);
    this.sessionIndex.set(key, m.count);

    // Enforce per-session limit, with hysteresis: reaching the cap trims to
    // 80%, so a long session is not rewritten on every event.
    const maxEvents = this.config.maxEventsPerSession ?? DEFAULT_MAX_EVENTS;
    if (m.count >= maxEvents) {
      this.trimSessionEvents(sessionId, Math.max(1, Math.floor(maxEvents * 0.8)));
    }

    // Enforce session count limit
    this.enforceSessionLimit();

    // Emit typed events for downstream consumers
    this.emit('event', payload);
    this.emit(payload.event, payload);

    return true;
  }

  /**
   * Get all events for a session.
   */
  getSessionEvents(sessionId: string): StoredHookEvent[] {
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
      .filter((e): e is StoredHookEvent => e !== null && typeof e === 'object' && !!e.payload);
  }

  /**
   * Get a summary of events for a session (keyed by Claude session id), from
   * the in-memory summaries over the retained events.
   */
  getSessionSummary(sessionId: string): SessionEventSummary | null {
    const m = this.meta.get(this.safeId(sessionId));
    if (!m || m.count === 0) return null;
    return this.mergeAccs(sessionId, [...m.accs.values()]);
  }

  /**
   * Summary for a tmux session name, scoped to its CURRENT incarnation:
   * only events stamped with that incarnation's INSTAR_SESSION_ID count.
   */
  getSessionSummaryForTmux(tmuxSession: string): SessionEventSummary | null {
    const accs = this.accsForTmux(tmuxSession);
    if (accs.length === 0) return null;
    return this.mergeAccs(tmuxSession, accs);
  }

  hasTaskCompletedForTmux(tmuxSession: string): boolean {
    return this.accsForTmux(tmuxSession).some(a => a.taskCompleted);
  }

  getExitReasonForTmux(tmuxSession: string): string | null {
    const ends = this.accsForTmux(tmuxSession).filter(a => a.sawSessionEnd);
    return ends.length > 0 ? ends[0].exitReason : null;
  }

  /** Claude session ids recorded for an incarnation (empty when unknown). */
  claudeSessionIdsForIncarnation(instarSessionId: string): string[] {
    return [...(this.incarnationIndex.get(instarSessionId) ?? [])];
  }

  /**
   * Check if a TaskCompleted event was received for a session.
   * Used as a quality gate: if Claude Code reported task completion,
   * we have higher confidence the session finished its work properly
   * (vs. just the process dying).
   */
  hasTaskCompleted(sessionId: string): boolean {
    const m = this.meta.get(this.safeId(sessionId));
    if (!m) return false;
    return [...m.accs.values()].some(a => a.taskCompleted);
  }

  /**
   * Get the last assistant message for a session (from Stop or SubagentStop events).
   * Captures what the session actually produced as its final output.
   */
  getLastAssistantMessage(sessionId: string): string | null {
    const events = this.getSessionEvents(sessionId);
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].payload.last_assistant_message) {
        return events[i].payload.last_assistant_message as string;
      }
    }
    return null;
  }

  /**
   * Get the session exit reason (from SessionEnd event).
   */
  getExitReason(sessionId: string): string | null {
    const events = this.getSessionEvents(sessionId);
    const sessionEnd = events.find(e => e.payload.event === 'SessionEnd');
    return (sessionEnd?.payload.reason as string) ?? null;
  }

  /**
   * List all session IDs with event data.
   */
  listSessions(): string[] {
    try {
      return fs.readdirSync(this.eventsDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => f.replace('.jsonl', ''))
        .sort();
    } catch {
      return [];
    }
  }

  /**
   * Get event counts for all sessions.
   */
  getIndex(): Map<string, number> {
    return new Map(this.sessionIndex);
  }

  // ── Internals ──────────────────────────────────────────────────

  private safeId(sessionId: string): string {
    // Sanitize session ID for filesystem safety
    return sessionId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
  }

  private getSessionFile(sessionId: string): string {
    return path.join(this.eventsDir, `${this.safeId(sessionId)}.jsonl`);
  }

  private metaFor(key: string): SessionMeta {
    let m = this.meta.get(key);
    if (!m) {
      m = { count: 0, lastReceivedMs: 0, accs: new Map() };
      this.meta.set(key, m);
    }
    return m;
  }

  private applyEvent(key: string, m: SessionMeta, ev: StoredHookEvent): void {
    const inc = incarnationOf(ev.payload);
    let acc = m.accs.get(inc);
    if (!acc) {
      acc = newAcc(ev.receivedAt);
      m.accs.set(inc, acc);
    }
    applyToAcc(acc, ev);
    m.count++;
    const t = Date.parse(ev.receivedAt);
    if (Number.isFinite(t) && t > m.lastReceivedMs) m.lastReceivedMs = t;
    if (inc) {
      let set = this.incarnationIndex.get(inc);
      if (!set) {
        set = new Set();
        this.incarnationIndex.set(inc, set);
      }
      set.add(key);
    }
  }

  /** Rebuild one session's in-memory state from its retained events. */
  private rebuildMeta(key: string, events: StoredHookEvent[]): void {
    this.forgetMeta(key);
    const m = this.metaFor(key);
    for (const ev of events) this.applyEvent(key, m, ev);
    this.sessionIndex.set(key, m.count);
  }

  private forgetMeta(key: string): void {
    const old = this.meta.get(key);
    if (old) {
      for (const inc of old.accs.keys()) {
        if (!inc) continue;
        const set = this.incarnationIndex.get(inc);
        set?.delete(key);
        if (set && set.size === 0) this.incarnationIndex.delete(inc);
      }
    }
    this.meta.delete(key);
    this.sessionIndex.delete(key);
  }

  private accsForTmux(tmuxSession: string): SummaryAcc[] {
    const inc = this.config.resolveCurrentInstarSessionId?.(tmuxSession) ?? null;
    if (!inc) return [];
    const out: SummaryAcc[] = [];
    for (const key of this.incarnationIndex.get(inc) ?? []) {
      const acc = this.meta.get(key)?.accs.get(inc);
      if (acc && acc.eventCount > 0) out.push(acc);
    }
    return out;
  }

  private mergeAccs(sessionId: string, accs: SummaryAcc[]): SessionEventSummary | null {
    const live = accs.filter(a => a.eventCount > 0);
    if (live.length === 0) return null;
    const eventTypes: Record<string, number> = {};
    const tools = new Set<string>();
    const subagents = new Set<string>();
    let eventCount = 0;
    let first = live[0].firstEvent;
    let last = live[0].lastEvent;
    let lastMsg: string | undefined;
    let lastMsgAt = '';
    for (const a of live) {
      eventCount += a.eventCount;
      for (const [t, n] of Object.entries(a.eventTypes)) eventTypes[t] = (eventTypes[t] ?? 0) + n;
      for (const t of a.toolsUsed) tools.add(t);
      for (const t of a.subagentsSpawned) subagents.add(t);
      if (a.firstEvent < first) first = a.firstEvent;
      if (a.lastEvent > last) last = a.lastEvent;
      if (a.lastAssistantMessage !== undefined && (a.lastAssistantAt ?? '') >= lastMsgAt) {
        lastMsg = a.lastAssistantMessage;
        lastMsgAt = a.lastAssistantAt ?? '';
      }
    }
    return {
      sessionId,
      eventCount,
      eventTypes,
      firstEvent: first,
      lastEvent: last,
      toolsUsed: [...tools],
      subagentsSpawned: [...subagents],
      lastAssistantMessage: lastMsg,
    };
  }

  private trimSessionEvents(sessionId: string, keepEvents: number): void {
    const events = this.getSessionEvents(sessionId);
    const key = this.safeId(sessionId);
    if (events.length <= keepEvents) {
      this.rebuildMeta(key, events);
      return;
    }

    const trimmed = events.slice(events.length - keepEvents);
    const file = this.getSessionFile(sessionId);
    fs.writeFileSync(file, trimmed.map(e => JSON.stringify(e)).join('\n') + '\n');
    this.rebuildMeta(key, trimmed);
  }

  private isLiveSession(m: SessionMeta): boolean {
    const isLive = this.config.isLiveInstarSession;
    if (!isLive) return false;
    for (const inc of m.accs.keys()) {
      if (inc && isLive(inc)) return true;
    }
    return false;
  }

  /**
   * Evict least-recently-received sessions whose incarnation is NOT live. A
   * live session's file is never evicted, so the count may exceed the limit
   * by at most the number of live sessions.
   */
  private enforceSessionLimit(): void {
    const maxSessions = this.config.maxSessions ?? DEFAULT_MAX_SESSIONS;
    if (this.meta.size <= maxSessions) return;
    const candidates = [...this.meta.entries()]
      .filter(([, m]) => !this.isLiveSession(m))
      .sort((a, b) => a[1].lastReceivedMs - b[1].lastReceivedMs);
    let excess = this.meta.size - maxSessions;
    for (const [key] of candidates) {
      if (excess <= 0) break;
      const file = path.join(this.eventsDir, `${key}.jsonl`);
      try {
        if (fs.existsSync(file)) {
          SafeFsExecutor.safeUnlinkSync(file, { operation: 'src/monitoring/HookEventReceiver.ts:enforceSessionLimit' });
        }
        this.forgetMeta(key);
        excess--;
      } catch { /* best effort */ }
    }
  }

  private loadIndex(): void {
    for (const key of this.listSessions()) {
      const events = this.getSessionEvents(key);
      this.rebuildMeta(key, events);
    }
  }
}

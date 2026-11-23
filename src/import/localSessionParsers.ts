/**
 * Pure, line-fed local conversation proposals (§A.3 of import-from-claude-chatgpt).
 * This module performs no discovery, file reads, import or authorization. Its caller
 * must supply only the selected project's bounded transcript lines. Metadata is
 * provenance from an untrusted file, never permission to read or write anything.
 */
import crypto from 'node:crypto';
import { CLAUDE_CODE_FRAMEWORK } from '../core/frameworkFacts.js';
import {
  appendImportedMessage, removeSecrets,
  type ImportedConversation, type ImportedMessage,
} from './exportParsers.js';

export type LocalSessionSource = typeof CLAUDE_CODE_FRAMEWORK | 'codex';
export type LocalSessionRepresentation = 'canonical' | 'event-fallback' | 'claude-records';
export interface LocalSessionOptions {
  expectedSessionId?: string;
  expectedProjectPath?: string;
  /** Persist this in the owner's import receipt; a changed transcript mode needs a new preview. */
  expectedRepresentation?: LocalSessionRepresentation;
}
export interface LocalSessionCounts {
  records: number;
  malformed: number;
  excluded: number;
  duplicateMessages: number;
  toolCalls: number;
}
export interface LocalSessionProposal {
  conversation: ImportedConversation;
  representation: LocalSessionRepresentation;
  /** Secret-scrubbed provenance, not a path that this parser has opened. */
  projectPath: string;
  counts: LocalSessionCounts;
}
export class LocalSessionRefused extends Error {
  constructor(readonly reason: 'identity-missing' | 'session-mismatch' | 'project-mismatch' | 'conflicting-message-id' | 'unsupported-source' | 'unsupported-fork' | 'unsupported-nonuser-session' | 'representation-mismatch' | 'finished') {
    super(`Local session refused: ${reason}`);
  }
}

type RecordValue = Record<string, unknown>;
type PendingMessage = {
  kind: 'canonical' | 'event' | 'tool'; role: ImportedMessage['role']; text: string;
  at: string | null; id: string | null;
};
const object = (v: unknown): RecordValue | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as RecordValue : null;
const str = (v: unknown): string | null => typeof v === 'string' && v.length > 0 ? v : null;
const hash = (v: string): string => crypto.createHash('sha256').update(v).digest('hex').slice(0, 32);
function iso(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
function safeId(value: string): string {
  // Keys must not introduce arbitrary imported text into references or logs.
  const clean = removeSecrets(value);
  if (clean.removed !== 0 || !/^[A-Za-z0-9_.:-]{1,160}$/.test(value)) return `h-${hash(value)}`;
  // Reserve h- for hashes and r: for escaped raw values. Escaping r: as well
  // keeps a literal hash-looking ID disjoint from both normalization domains.
  return value.startsWith('h-') || value.startsWith('r:') ? `r:${value}` : value;
}

/** The same normalization used in the parser result. This identifies a source
 * claim for read-only preparation; it never establishes owner authority. */
export function localSessionOriginalId(sessionId: string): string {
  if (typeof sessionId !== 'string' || !sessionId) throw new Error('local-source-session-invalid');
  return safeId(sessionId);
}

export interface LocalSessionParser {
  push(line: string): void;
  finish(): LocalSessionProposal;
}

export function createLocalSessionParser(source: LocalSessionSource, options: LocalSessionOptions = {}): LocalSessionParser {
  if (source !== CLAUDE_CODE_FRAMEWORK && source !== 'codex') throw new LocalSessionRefused('unsupported-source');
  let sessionId: string | null = null;
  let project: string | null = null;
  let createdAt: string | null = null;
  let pending: PendingMessage | null = null;
  let finished: LocalSessionProposal | null = null;
  let failure: LocalSessionRefused | null = null;
  let turnId: string | null = null;
  let canonicalMessages = false;
  let fallbackRecords = 0;
  const fallbackKeys = new Set<string>();
  const fallbackStats = { redactions: 0, splitMessages: 0 };
  const counts: LocalSessionCounts = { records: 0, malformed: 0, excluded: 0, duplicateMessages: 0, toolCalls: 0 };
  const messages: ImportedMessage[] = [];
  const conversation: ImportedConversation = {
    from: source, originalId: '', title: source === 'codex' ? 'Codex conversation' : 'Claude Code conversation',
    createdAt: null, messages, overflow: [], stats: { redactions: 0, splitMessages: 0, droppedBranches: 0 },
  };
  const emitted = new Map<string, string>();
  const occurrences = new Map<string, number>();
  function refuse(reason: LocalSessionRefused['reason']): never {
    failure = new LocalSessionRefused(reason);
    throw failure;
  }
  function bind(id: unknown, cwd: unknown, timestamp?: unknown): void {
    const nextId = str(id);
    const nextProject = str(cwd);
    if (nextId) {
      if ((sessionId && sessionId !== nextId) || (options.expectedSessionId && options.expectedSessionId !== nextId)) refuse('session-mismatch');
      sessionId = nextId;
    }
    if (nextProject) {
      if ((project && project !== nextProject) || (options.expectedProjectPath && options.expectedProjectPath !== nextProject)) refuse('project-mismatch');
      project = nextProject;
    }
    createdAt ??= iso(timestamp);
  }
  function emit(message: PendingMessage): void {
    // Binding is required before content, so a headerless file cannot borrow a
    // caller-supplied identity and masquerade as a different selected session.
    if (!sessionId || !project) refuse('identity-missing');
    const fingerprint = hash(`${message.role}\0${message.at}\0${message.text}`);
    let key: string;
    if (message.id) key = `m:${safeId(message.id)}`;
    else {
      // Occurrences are per message fingerprint, never per JSONL line: metadata,
      // malformed records and UI echoes cannot rename an already imported turn.
      const occurrenceKey = `${message.kind}\0${fingerprint}`;
      const occurrence = (occurrences.get(occurrenceKey) ?? 0) + 1;
      occurrences.set(occurrenceKey, occurrence);
      key = `h-${hash(`${sessionId}\0${message.kind === 'tool' ? 'tool' : 'message'}\0${fingerprint}\0${occurrence}`)}`;
    }
    const previous = emitted.get(key);
    if (previous) {
      if (previous !== fingerprint) refuse('conflicting-message-id');
      counts.duplicateMessages++; return;
    }
    emitted.set(key, fingerprint);
    const before = { ...conversation.stats };
    appendImportedMessage(conversation, key, message.role, message.at, message.text);
    if (message.kind === 'event') {
      fallbackKeys.add(key);
      fallbackStats.redactions += conversation.stats.redactions - before.redactions;
      fallbackStats.splitMessages += conversation.stats.splitMessages - before.splitMessages;
    }
  }
  function flush(): void { if (pending) { emit(pending); pending = null; } }
  function add(kind: PendingMessage['kind'], role: PendingMessage['role'], text: string, at: string | null, id: string | null): void {
    if (!text.trim()) { counts.excluded++; return; }
    flush();
    pending = { kind, role, text, at, id };
  }
  function tool(id: string | null, at: string | null): void {
    flush();
    emit({ kind: 'tool', role: 'agent', text: 'Used a tool.', at, id });
    counts.toolCalls++;
  }
  function selectCanonicalMessages(): void {
    if (canonicalMessages) return;
    canonicalMessages = true;
    // Codex response_item is the persisted message stream. event_msg is a UI
    // notification fallback for older/event-only transcripts, not a second chat.
    // Discard only its normalized proposals; fixed tool descriptions survive.
    if (pending?.kind === 'event') pending = null;
    conversation.messages = conversation.messages.filter(message => {
      const key = message.key.replace(/#\d+$/, '');
      return !fallbackKeys.has(key);
    });
    conversation.overflow = conversation.overflow.filter(message => !fallbackKeys.has(message.key));
    conversation.stats.redactions -= fallbackStats.redactions;
    conversation.stats.splitMessages -= fallbackStats.splitMessages;
    counts.excluded += fallbackRecords;
    for (const key of fallbackKeys) emitted.delete(key);
    fallbackKeys.clear();
  }
  function blocks(value: unknown): { text: string; tools: Array<string | null> } {
    if (typeof value === 'string') return { text: value, tools: [] };
    if (!Array.isArray(value)) return { text: '', tools: [] };
    const texts: string[] = [];
    const tools: Array<string | null> = [];
    for (const raw of value) {
      const block = object(raw);
      if (!block) { counts.excluded++; continue; }
      if ((block.type === 'text' || block.type === 'input_text' || block.type === 'output_text') && typeof block.text === 'string') texts.push(block.text);
      else if (block.type === 'tool_use') tools.push(str(block.id));
      else counts.excluded++; // Includes tool_result, thinking and non-text assets.
    }
    return { text: texts.join('\n\n'), tools };
  }
  function inherited(record: RecordValue): boolean {
    return record.isMeta === true || record.isCompactSummary === true || record.inherited === true || record.isInherited === true;
  }
  return {
    push(line: string): void {
      if (failure) throw failure;
      if (finished) refuse('finished');
      if (!line.trim()) return;
      counts.records++;
      let record: RecordValue | null;
      try { record = object(JSON.parse(line)); } catch { counts.malformed++; return; }
      if (!record) { counts.malformed++; return; }
      if (inherited(record)) { counts.excluded++; return; }
      if (source === CLAUDE_CODE_FRAMEWORK) {
        if (record.isSidechain === true || str(record.agentId)) { counts.excluded++; return; }
        if (record.type === 'attachment' && record.entrypoint === 'cli' && str(record.sessionId) && str(record.cwd)) {
          bind(record.sessionId, record.cwd, record.timestamp);
          counts.excluded++; return; // Header provenance only; attachment contents never enter a proposal.
        }
        if (record.type !== 'user' && record.type !== 'assistant') { counts.excluded++; return; }
        const message = object(record.message);
        if (!message || inherited(message) || message.isSidechain === true || str(message.agentId) || (message.role !== undefined && message.role !== record.type)) { counts.excluded++; return; }
        bind(record.sessionId, record.cwd, record.timestamp);
        if (message.channel === 'analysis' || record.channel === 'analysis') { counts.excluded++; return; }
        const parsed = blocks(message.content);
        const id = str(record.uuid) ?? str(message.id);
        if (parsed.text) add('canonical', record.type === 'user' ? 'operator' : 'agent', parsed.text, iso(record.timestamp), id ? `${id}:text` : null);
        if (record.type === 'assistant') {
          for (const [index, toolId] of parsed.tools.entries()) tool(toolId ? `tool:${toolId}` : id ? `${id}:tool:${index}` : null, iso(record.timestamp));
        } else counts.excluded += parsed.tools.length;
        if (!parsed.text && parsed.tools.length === 0) counts.excluded++;
        return;
      }
      const payload = object(record.payload);
      if (!payload || inherited(payload)) { counts.excluded++; return; }
      if (record.type === 'session_meta') {
        // A fork can prepend its parent's messages without per-message origin.
        // No exact own-message boundary is established by this foundation.
        if (payload.forked_from_id !== undefined && payload.forked_from_id !== null && payload.forked_from_id !== '') refuse('unsupported-fork');
        // Upstream SessionSource uses tagged objects for non-root sessions;
        // SessionMeta.thread_source carries exact ThreadSource strings. Neither
        // marker proves an own-message boundary, so this adapter cannot import it.
        // See the pinned upstream schema in architecture/local-history-parsers.md.
        const sessionSource = object(payload.source);
        if ((sessionSource && (Object.hasOwn(sessionSource, 'subagent') || Object.hasOwn(sessionSource, 'internal')))
          || payload.thread_source === 'subagent' || payload.thread_source === 'guardian_review'
          || payload.thread_source === 'memory_consolidation') refuse('unsupported-nonuser-session');
        bind(payload.id, payload.cwd, payload.timestamp ?? record.timestamp);
        counts.excluded++;
        return;
      }
      bind(record.sessionId ?? payload.session_id, undefined);
      if (record.type === 'turn_context') {
        bind(undefined, payload.cwd);
        const nextTurn = str(payload.turn_id);
        if (nextTurn && nextTurn !== turnId) { flush(); turnId = nextTurn; }
        counts.excluded++;
        return;
      }
      if (record.type === 'event_msg' && (payload.type === 'task_started' || payload.type === 'task_complete')) {
        flush(); turnId = str(payload.turn_id); counts.excluded++; return;
      }
      if (record.type === 'response_item' && payload.type === 'message') {
        if ((payload.role !== 'user' && payload.role !== 'assistant') || payload.channel === 'analysis') { counts.excluded++; return; }
        const parsed = blocks(payload.content);
        if (!parsed.text.trim()) { counts.excluded++; return; }
        selectCanonicalMessages();
        add('canonical', payload.role === 'user' ? 'operator' : 'agent', parsed.text, iso(record.timestamp), str(payload.id));
        return;
      }
      if (record.type === 'response_item' && (payload.type === 'function_call' || payload.type === 'custom_tool_call')) {
        tool(str(payload.call_id) ? `tool:${str(payload.call_id)}` : str(payload.id), iso(record.timestamp)); return;
      }
      if (record.type === 'event_msg' && (payload.type === 'user_message' || payload.type === 'agent_message') && payload.channel !== 'analysis' && payload.phase !== 'analysis') {
        if (canonicalMessages) { counts.excluded++; return; }
        const text = str(payload.message);
        fallbackRecords++;
        if (text) add('event', payload.type === 'user_message' ? 'operator' : 'agent', text, iso(record.timestamp), str(payload.id));
        else counts.excluded++;
        return;
      }
      counts.excluded++; // In particular: compacted replacement history and function_call_output.
    },
    finish(): LocalSessionProposal {
      if (failure) throw failure;
      if (finished) return finished;
      if (!sessionId || !project) refuse('identity-missing');
      const representation: LocalSessionRepresentation = source === CLAUDE_CODE_FRAMEWORK ? 'claude-records' : canonicalMessages ? 'canonical' : 'event-fallback';
      if (options.expectedRepresentation && options.expectedRepresentation !== representation) refuse('representation-mismatch');
      flush();
      conversation.originalId = localSessionOriginalId(sessionId);
      conversation.createdAt = createdAt;
      const cleanProject = removeSecrets(project);
      conversation.stats.redactions += cleanProject.removed;
      finished = { conversation, representation, projectPath: cleanProject.text, counts: { ...counts } };
      return finished;
    },
  };
}

export function parseLocalSessionLines(source: LocalSessionSource, lines: Iterable<string>, options: LocalSessionOptions = {}): LocalSessionProposal {
  const parser = createLocalSessionParser(source, options);
  for (const line of lines) parser.push(line);
  return parser.finish();
}

/**
 * `session-transcript-pull` — a session's conversation record over the signed mesh
 * (docs/specs/native-conversation-any-machine-access.md §3d).
 *
 * The console's History view and a session on another machine used to read a remote session's
 * record by sending this machine's own API token to the machine that ran it. Machines joined with
 * different tokens refused that ("token refused"), and the credential URL guard refused others
 * ("peer URL refused"). The signed verb needs no shared token.
 *
 * Serve side only. The machine answers for sessions recorded on itself, never a path. Each answer
 * names the conversations the session served (`conversations`), so the machine that answers a
 * person can decide the audience from its own copy of the team record (§3d item 2). The verb is
 * the agent's own read between its own machines; the audience rule is applied where a person is
 * answered, by the HTTP route.
 *
 * What it serves is the reader's digest (SessionTranscriptReader): message text, cut at 4,000
 * characters unless `full` is asked, with every cut marked `clipped`; a tool call as its name and a
 * short summary of its input; no tool results.
 */
import path from 'node:path';
import fs from 'node:fs';
import { readTranscriptPage, isRecordStart, type TranscriptEntry } from './SessionTranscriptReader.js';
import { cutUtf8, newestWithinCap, ROW_ENVELOPE_BYTES } from './oversizedRow.js';
import { conversationRefOf } from '../users/TeamConfinement.js';
import { resolveFrameworkTranscriptPath } from './FrameworkSessionStore.js';
import type { Session } from './types.js';

/** Whole-answer cap: the size at which the pool fan-out already rejects a peer's answer (§3d item 7). */
export const SESSION_TRANSCRIPT_PULL_MAX_BYTES = 512 * 1024;
export const SESSION_TRANSCRIPT_PULL_TIMEOUT_MS = 15_000;
/** The reader's own page bound and default. */
export const SESSION_TRANSCRIPT_PULL_MAX_ENTRIES = 500;
export const SESSION_TRANSCRIPT_PULL_DEFAULT_ENTRIES = 150;
const SESSION_NAME_RE = /^[a-zA-Z0-9_-]{1,200}$/;

export type SessionTranscriptPullCommand = {
  mode?: unknown;
  session?: unknown;
  before?: unknown;
  beforeIndex?: unknown;
  limit?: unknown;
  full?: unknown;
  /** Continuation of one cut entry: its record offset and index, and the byte to read from. */
  row?: unknown;
  byteFrom?: unknown;
  /** List mode: forwarded to this machine's own session list. */
  include?: unknown;
  status?: unknown;
};

export interface RowTruncated {
  row: { offset: number; index: number } | string | number;
  totalBytes: number;
  from: number;
  to: number;
}

export type SessionTranscriptPullResponse =
  | {
      ok: true;
      mode: 'transcript';
      entries: TranscriptEntry[];
      nextBefore: number | null;
      nextBeforeIndex?: number;
      size: number;
      conversations: string[];
      truncated?: true;
      rowTruncated?: RowTruncated;
    }
  | { ok: true; mode: 'list'; sessions: unknown[]; truncated?: true }
  | { ok: false; reason: string; conversations?: string[] };

export interface SessionTranscriptPullDeps {
  /** A session recorded on THIS machine by its tmux name: its transcript file (or null) and conversations. */
  findSession: (tmuxSession: string) => { filePath: string | null; conversations: string[] } | null;
  /** Removes this machine's own API token and dashboard PIN from a text. Runs before any clip or cut. */
  clean: (text: string) => string;
  /** This machine's own session list (what its plain GET /sessions answers). Null: list mode unavailable. */
  listSessions?: ((query: { include?: 'all'; status?: string }) => Promise<unknown[] | null>) | null;
  /** Answer cap; tests set a small one. */
  maxBytes?: number;
}

const isNonNegInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** The conversations a session served, as conversation keys (`telegram:<topic>`, an app key, `slack:<channel>`). */
export function sessionConversations(session: Pick<Session, 'telegramTopicId' | 'slackChannelId' | 'memoryPlaceInput'>, extra: ReadonlyArray<string | null | undefined> = []): string[] {
  const out = new Set<string>();
  if (typeof session.telegramTopicId === 'number' && Number.isSafeInteger(session.telegramTopicId)) out.add(`telegram:${session.telegramTopicId}`);
  if (session.memoryPlaceInput) {
    const ref = conversationRefOf(session.memoryPlaceInput);
    if (ref) out.add(ref);
    if (session.memoryPlaceInput.slackChannelId) out.add(`slack:${session.memoryPlaceInput.slackChannelId}`);
  }
  if (typeof session.slackChannelId === 'string' && session.slackChannelId) out.add(`slack:${session.slackChannelId}`);
  for (const e of extra) if (typeof e === 'string' && e) out.add(e.startsWith('app:') ? e.slice(4) : e);
  return [...out].sort();
}

/**
 * The transcript file for a session: its own account's config home first, then the confined home,
 * the default home, then every pool account's (a swap can move a session between homes).
 */
export function findSessionTranscriptFile(
  session: Pick<Session, 'claudeSessionId' | 'framework' | 'cwd' | 'subscriptionAccountId' | 'confinedConfigHome'>,
  env: { projectDir: string; accountHome?: (accountId: string) => string | undefined; accountHomes?: () => Array<string | undefined> },
): string | null {
  const sessionId = session.claudeSessionId;
  if (!sessionId) return null;
  const framework = session.framework ?? 'claude-code';
  const projectDir = session.cwd ?? env.projectDir;
  const homes: Array<string | undefined> = [];
  const own = session.subscriptionAccountId ? env.accountHome?.(session.subscriptionAccountId) : undefined;
  homes.push(own, session.confinedConfigHome, undefined);
  for (const h of env.accountHomes?.() ?? []) homes.push(h);
  const seen = new Set<string>();
  for (const home of homes) {
    const candidate = framework === 'codex-cli'
      ? resolveFrameworkTranscriptPath({ framework, sessionId, projectDir, ...(home ? { rootOverride: path.join(home, 'sessions') } : {}) })
      : resolveFrameworkTranscriptPath({ framework, sessionId, projectDir, ...(home ? { configHome: home } : {}) });
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* @silent-fallback-ok — try the next home */ }
  }
  return null;
}

/**
 * One page of a transcript within a byte cap. Shared by the verb and the local route, so the two
 * answer the same shape. Throws RangeError('bad-cursor') for a cursor that names no record start,
 * and RangeError('row-gone') / RangeError('bad-byte-range') for a continuation that does not line up.
 */
export function readTranscriptAnswer(filePath: string, q: {
  before?: number; beforeIndex?: number; limit?: number; full?: boolean;
  row?: { offset: number; index: number }; byteFrom?: number;
  clean?: (s: string) => string; maxBytes: number;
}): Omit<Extract<SessionTranscriptPullResponse, { mode: 'transcript' }>, 'ok' | 'mode' | 'conversations'> {
  const budget = Math.max(64, q.maxBytes - ROW_ENVELOPE_BYTES);
  if (q.row) {
    // A continuation: the next range of one entry, read whole (`full`) and redacted before the cut.
    if (!isRecordStart(filePath, q.row.offset)) throw new RangeError('row-gone');
    const page = readTranscriptPage(filePath, { before: q.row.offset, beforeIndex: q.row.index + 1, limit: 1, clean: q.clean, full: true });
    const entry = page.entries.find((e) => e.offset === q.row!.offset && e.index === q.row!.index);
    if (!entry) throw new RangeError('row-gone');
    const cut = cutUtf8(entry.text, q.byteFrom ?? 0, budget);
    if (!cut) throw new RangeError('bad-byte-range');
    return {
      entries: [{ ...entry, text: cut.piece }],
      // The page cursor always moves past the cut row.
      nextBefore: entry.offset,
      ...(entry.index > 0 ? { nextBeforeIndex: entry.index } : {}),
      size: page.size,
      rowTruncated: { row: { offset: entry.offset, index: entry.index }, totalBytes: cut.totalBytes, from: cut.from, to: cut.to },
    };
  }
  if (q.before !== undefined && (q.beforeIndex ?? 0) > 0 && !isRecordStart(filePath, q.before)) throw new RangeError('bad-cursor');
  const page = readTranscriptPage(filePath, { before: q.before, beforeIndex: q.beforeIndex, limit: q.limit, clean: q.clean, full: q.full });
  const base = Buffer.byteLength(JSON.stringify({ ok: true, mode: 'transcript', nextBefore: page.nextBefore, nextBeforeIndex: 0, size: page.size, truncated: true, conversations: [] })) + 1024;
  const { kept, dropped } = newestWithinCap(page.entries, q.maxBytes, base);
  if (kept.length === 0 && page.entries.length > 0) {
    // The newest remaining entry is alone larger than the cap: return it in pieces, never skip it.
    // The first piece is read exactly as a continuation is (whole text, redacted, then cut), so
    // `totalBytes` and every range describe the same text the continuation reads.
    const newest = page.entries[page.entries.length - 1];
    const first = readTranscriptAnswer(filePath, { ...q, row: { offset: newest.offset, index: newest.index }, byteFrom: 0 });
    return { ...first, ...(page.entries.length > 1 || page.nextBefore !== null ? { truncated: true as const } : {}) };
  }
  if (dropped > 0) {
    // Cut between entries, possibly inside one record: the cursor is offset plus index.
    const oldest = kept[0];
    return { entries: kept, nextBefore: oldest.offset, ...(oldest.index > 0 ? { nextBeforeIndex: oldest.index } : {}), size: page.size, truncated: true };
  }
  return { entries: page.entries, nextBefore: page.nextBefore, ...(page.nextBeforeIndex ? { nextBeforeIndex: page.nextBeforeIndex } : {}), size: page.size };
}

/** Parse the paging fields shared by the verb and the route. A string names what is wrong. */
export function parseTranscriptQuery(raw: { before?: unknown; beforeIndex?: unknown; limit?: unknown; full?: unknown; row?: unknown; byteFrom?: unknown }):
  { before?: number; beforeIndex?: number; limit: number; full: boolean; row?: { offset: number; index: number }; byteFrom?: number } | string {
  const out: { before?: number; beforeIndex?: number; limit: number; full: boolean; row?: { offset: number; index: number }; byteFrom?: number } = {
    limit: SESSION_TRANSCRIPT_PULL_DEFAULT_ENTRIES, full: raw.full === true,
  };
  if (raw.before !== undefined) { if (!isNonNegInt(raw.before)) return 'before'; out.before = raw.before; }
  if (raw.beforeIndex !== undefined) {
    if (!isNonNegInt(raw.beforeIndex) || out.before === undefined) return 'beforeIndex';
    out.beforeIndex = raw.beforeIndex;
  }
  if (raw.limit !== undefined) {
    if (typeof raw.limit !== 'number' || !Number.isSafeInteger(raw.limit)) return 'limit';
    out.limit = Math.max(1, Math.min(raw.limit, SESSION_TRANSCRIPT_PULL_MAX_ENTRIES));
  }
  if (raw.row !== undefined) {
    const r = raw.row as { offset?: unknown; index?: unknown } | null;
    if (!r || typeof r !== 'object' || !isNonNegInt(r.offset) || !isNonNegInt(r.index)) return 'row';
    out.row = { offset: r.offset, index: r.index };
    if (raw.byteFrom !== undefined && !isNonNegInt(raw.byteFrom)) return 'byteFrom';
    out.byteFrom = (raw.byteFrom as number | undefined) ?? 0;
  } else if (raw.byteFrom !== undefined) return 'byteFrom';
  return out;
}

/** Serve side of the verb. */
export function createSessionTranscriptPullHandler(deps: SessionTranscriptPullDeps): (cmd: SessionTranscriptPullCommand) => Promise<SessionTranscriptPullResponse> {
  const maxBytes = deps.maxBytes ?? SESSION_TRANSCRIPT_PULL_MAX_BYTES;
  return async (cmd) => {
    if (cmd.mode === 'list') {
      if (!deps.listSessions) return { ok: false, reason: 'list-unavailable' };
      const include = cmd.include === 'all' ? 'all' as const : undefined;
      const status = typeof cmd.status === 'string' && /^[a-z-]{1,40}$/.test(cmd.status) ? cmd.status : undefined;
      const sessions = await deps.listSessions({ ...(include ? { include } : {}), ...(status ? { status } : {}) });
      if (!sessions) return { ok: false, reason: 'list-unavailable' };
      const shown = sessions.slice();
      let truncated = false;
      while (shown.length > 0 && Buffer.byteLength(JSON.stringify({ ok: true, mode: 'list', sessions: shown, truncated: true })) > maxBytes) { shown.pop(); truncated = true; }
      return { ok: true, mode: 'list', sessions: shown, ...(truncated ? { truncated: true as const } : {}) };
    }
    if (cmd.mode !== 'transcript' || typeof cmd.session !== 'string' || !SESSION_NAME_RE.test(cmd.session)) return { ok: false, reason: 'malformed' };
    const q = parseTranscriptQuery(cmd);
    if (typeof q === 'string') return { ok: false, reason: 'malformed' };
    const found = deps.findSession(cmd.session);
    if (!found) return { ok: false, reason: 'unknown-session' };
    if (!found.filePath) return { ok: false, reason: 'no-transcript', conversations: found.conversations };
    try {
      return { ok: true, mode: 'transcript', ...readTranscriptAnswer(found.filePath, { ...q, clean: deps.clean, maxBytes }), conversations: found.conversations };
    } catch (err) {
      if (err instanceof RangeError) return { ok: false, reason: err.message, conversations: found.conversations };
      return { ok: false, reason: 'read-failed', conversations: found.conversations };
    }
  };
}

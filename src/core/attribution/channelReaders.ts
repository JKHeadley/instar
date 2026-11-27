/**
 * The per-channel table of spec section 2, as code: where each channel's existing log lives and
 * how a ref's key finds its row. No new log store and no new provenance writers.
 *
 * Logs are streamed, never read whole (measured on one agent: 143MB, 975ms warm). In-flight
 * lookups are shared, and a parsed result is reused until the file's size or mtime changes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { AspAuthorshipJoin, type MessageAuthorship } from '../AspAuthorshipJoin.js';
import type { AppConversationStore } from '../AppConversationStore.js';
import type { ThreadLog } from '../../threadline/ThreadLog.js';
import type { SourceChannel, SourceRef } from './marker.js';
import { scanJsonlLog, scanJsonlMany, type LocalLookup, type LocalReader } from './SourceResolver.js';

export interface ChannelReaderDeps {
  stateDir: string;
  appStore?: () => AppConversationStore | null | undefined;
  threadLog?: () => ThreadLog | null | undefined;
}

const LOG_FILES: Partial<Record<SourceChannel, { file: string; conversationField: string }>> = {
  telegram: { file: 'telegram-messages.jsonl', conversationField: 'topicId' },
  slack: { file: 'slack-messages.jsonl', conversationField: 'channelId' },
  imessage: { file: 'imessage-messages.jsonl', conversationField: 'channelId' },
  whatsapp: { file: path.join('whatsapp', 'messages.jsonl'), conversationField: 'channelId' },
};

export function channelLogPath(stateDir: string, channel: SourceChannel): string | null {
  const log = LOG_FILES[channel];
  return log ? path.join(stateDir, log.file) : null;
}

export function rowKey(channel: SourceChannel, row: Record<string, unknown>): string | null {
  const log = LOG_FILES[channel];
  if (!log || row.messageId === undefined) return null;
  return `${String(row[log.conversationField])}/${String(row.messageId)}`;
}

const CACHE_LIMIT = 2_000;
const RECENT_TAIL_BYTES = 256 * 1024;

export class ChannelReaders {
  private readonly inFlight = new Map<string, Promise<LocalLookup>>();
  private readonly cache = new Map<string, { stamp: string; lookup: LocalLookup }>();
  private readonly authorshipJoin: AspAuthorshipJoin;

  constructor(private readonly deps: ChannelReaderDeps) {
    this.authorshipJoin = new AspAuthorshipJoin(path.join(deps.stateDir, 'asp-classifications.jsonl'));
  }

  readonly readLocal: LocalReader = (ref) => {
    const key = `${ref.channel}|${ref.conversation}|${ref.message}`;
    const running = this.inFlight.get(key);
    if (running) return running;
    const run = this.read(ref, key).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, run);
    return run;
  };

  /**
   * This machine's ASP verdict for a Telegram row. A row a peer returned is one this machine does
   * not hold, so its `UNRESOLVED` means "no verdict here", not a weaker verdict than the peer's.
   */
  localVerdictOnPeerRow(ref: SourceRef, row: Record<string, unknown>): MessageAuthorship | undefined {
    if (ref.channel !== 'telegram') return undefined;
    const verdict = this.authorshipOf(row);
    return verdict === 'UNRESOLVED' ? undefined : verdict;
  }

  authorshipOf(row: Record<string, unknown>): MessageAuthorship | undefined {
    if (typeof row.messageId !== 'number' || typeof row.text !== 'string' || typeof row.timestamp !== 'string') return undefined;
    const topicId = typeof row.topicId === 'number' ? row.topicId : null;
    const [joined] = this.authorshipJoin.join([{ messageId: row.messageId, topicId, text: row.text, fromUser: row.fromUser === true, timestamp: row.timestamp }]);
    return joined.authorship;
  }

  /**
   * The last turns of one conversation, oldest first, for the send gate's recap test. Telegram has
   * topic memory; every other channel reads its own log here. Reads only the tail of the file.
   */
  recentConversation(channel: SourceChannel, conversation: string, limit = 10): Array<{ role: 'user' | 'agent'; text: string }> {
    if (channel === 'app') {
      const store = this.deps.appStore?.();
      if (!store) return [];
      return store.browseMessages(conversation, null, limit).messages
        .filter((message) => typeof message.text === 'string' && message.text)
        .map((message) => ({ role: message.role === 'agent' ? 'agent' as const : 'user' as const, text: message.text }));
    }
    const log = LOG_FILES[channel];
    const file = channelLogPath(this.deps.stateDir, channel);
    if (!log || !file) return [];
    let tail = '';
    let fd: number | undefined;
    try {
      fd = fs.openSync(file, 'r');
      const size = fs.fstatSync(fd).size;
      const length = Math.min(size, RECENT_TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, size - length);
      tail = buffer.toString('utf8');
    } catch {
      return []; // @silent-fallback-ok — no log means no recent conversation, and B23's crediting test stays unmeasured.
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    const turns: Array<{ role: 'user' | 'agent'; text: string }> = [];
    for (const line of tail.split('\n')) {
      try {
        const row = JSON.parse(line) as Record<string, unknown>;
        if (String(row[log.conversationField]) === conversation && typeof row.text === 'string' && row.text) {
          turns.push({ role: row.fromUser === true ? 'user' : 'agent', text: row.text });
        }
      } catch { /* @silent-fallback-ok — the first line of a tail is usually cut, and a bad row is skipped. */ }
    }
    return turns.slice(-limit);
  }

  /** One pass over a channel's log for many wanted keys (`conversation/message`). */
  readMany(channel: SourceChannel, wanted: Set<string>): Promise<Map<string, Record<string, unknown>>> {
    const file = channelLogPath(this.deps.stateDir, channel);
    if (!file || wanted.size === 0) return Promise.resolve(new Map());
    return scanJsonlMany(file, (row) => rowKey(channel, row), wanted);
  }

  /** Inbound rows of a channel holding any of these words. `find` for channels with no index. */
  searchLog(channel: SourceChannel, words: string[], limit = 200): Promise<Map<string, Record<string, unknown>>> {
    const file = channelLogPath(this.deps.stateDir, channel);
    if (!file || words.length === 0) return Promise.resolve(new Map());
    const lowered = words.map((word) => word.toLowerCase());
    return scanJsonlMany(file, (row) => rowKey(channel, row), null, limit, (row) => {
      if (row.fromUser !== true || typeof row.text !== 'string') return false;
      const text = row.text.toLowerCase();
      return lowered.some((word) => text.includes(word));
    });
  }

  private async read(ref: SourceRef, key: string): Promise<LocalLookup> {
    if (ref.channel === 'app') return this.readApp(ref);
    if (ref.channel === 'threadline') return this.readThreadline(ref);

    const file = channelLogPath(this.deps.stateDir, ref.channel);
    if (!file) return { row: null, retainedFrom: null };
    let stamp = 'missing';
    try {
      const stat = fs.statSync(file);
      stamp = `${stat.size}:${stat.mtimeMs}`;
    } catch {
      return { row: null, retainedFrom: null };
    }
    const cached = this.cache.get(key);
    if (cached?.stamp === stamp) return cached.lookup;

    const lookupKey = `${ref.conversation}/${ref.message}`;
    const scanned = await scanJsonlLog(file, (row) => rowKey(ref.channel, row) === lookupKey);
    const lookup: LocalLookup = scanned.row && ref.channel === 'telegram'
      ? { ...scanned, authorship: this.authorshipOf(scanned.row) }
      : scanned;
    if (this.cache.size >= CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { stamp, lookup });
    return lookup;
  }

  private readApp(ref: SourceRef): LocalLookup {
    const store = this.deps.appStore?.();
    if (!store) return { row: null, retainedFrom: null };
    const conversation = store.getConversation(ref.conversation);
    const retainedFrom = conversation?.createdAt ? conversation.createdAt.slice(0, 10) : null;
    if (!conversation) return { row: null, retainedFrom };
    if (conversation.tombstoned) return { row: null, retainedFrom, removed: true };
    const event = store.getEvent(ref.conversation, ref.message) ?? store.getMessageEvent(ref.conversation, ref.message);
    if (!event) return { row: null, retainedFrom };
    if (event.kind === 'media-message' && event.attachments.length > 0 && event.attachments.every((a) => store.isAttachmentPurged(a.attachmentId))) {
      return { row: null, retainedFrom, removed: true };
    }
    return { row: { ...event, timestamp: event.at }, retainedFrom };
  }

  private readThreadline(ref: SourceRef): LocalLookup {
    const log = this.deps.threadLog?.();
    const seq = Number(ref.message);
    if (!log || !Number.isInteger(seq) || seq < 0 || !log.isPathConfined(ref.conversation)) return { row: null, retainedFrom: null };
    const first = log.read(ref.conversation, { limit: 1 }).entries[0];
    const retainedFrom = first ? first.at.slice(0, 10) : null;
    const entry = log.read(ref.conversation, { afterSeq: seq - 1, limit: 1 }).entries[0];
    if (!entry || entry.seq !== seq) return { row: null, retainedFrom };
    // The words live in `text` alone, so a pin's scrub of `text` covers them.
    const { textRef, ...rest } = entry;
    return { row: { ...rest, text: textRef.kind === 'inline' ? textRef.text : '', timestamp: entry.at }, retainedFrom };
  }
}

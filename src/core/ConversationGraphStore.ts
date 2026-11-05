/**
 * ConversationGraphStore — the durable event file behind the Conversations hierarchy.
 *
 * SOURCE OF TRUTH: one append-only JSONL file, `<stateDir>/conversation-graph/events.jsonl`, never
 * rotated. Every line is an immutable GraphEvent (src/core/conversationGraph.ts). The in-memory
 * event list is derived from it and rebuilt on every load; nothing else outranks the file.
 *
 * DURABILITY (the AppConversationStore pattern): an append is a commit only when the line is
 * written and the file fsynced; creating the file also fsyncs the directory. A failed write is cut
 * back to where its line started. A torn final line (a crash mid-write) was never acknowledged, so
 * on load it is truncated back to the last newline and reported once. Earlier lines are never
 * touched. A line that parses but fails validation is skipped and counted, never rewritten.
 *
 * DUPLICATES: an event id already present with identical bytes is a no-op. One present with
 * DIFFERENT bytes is refused here and, if both copies ever meet (replication), quarantined by the
 * reducer — never silently picked.
 *
 * SCOPE OF THIS SLICE: local commit only. Replication to peers (the CoherenceJournal
 * `conversation-graph-event` kind, v3 §7.2) is not wired yet, so the routes report `replica-lag`
 * as a partial reason on every response and the feature stays dark.
 */
import fs from 'node:fs';
import path from 'node:path';
import { validateGraphEvent, graphEventHash, canonicalJson, MAX_GRAPH_EVENT_BYTES, type GraphEvent } from './conversationGraph.js';

export interface GraphStoreHealth {
  events: number;
  skippedInvalidLines: number;
  tornTailRepaired: boolean;
  file: string;
}

export class ConversationGraphStore {
  readonly file: string;
  private readonly dir: string;
  private list: GraphEvent[] = [];
  private readonly hashes = new Map<string, string>();
  private skipped = 0;
  private tornRepaired = false;

  constructor(stateDir: string, private readonly report: (msg: string) => void = () => {}) {
    this.dir = path.join(stateDir, 'conversation-graph');
    this.file = path.join(this.dir, 'events.jsonl');
    this.load();
  }

  /** (Re)build the in-memory list from the file. */
  load(): void {
    this.list = [];
    this.hashes.clear();
    this.skipped = 0;
    if (!fs.existsSync(this.file)) return;
    let buf = fs.readFileSync(this.file);
    const lastNl = buf.lastIndexOf(0x0a);
    const end = lastNl + 1;
    if (end < buf.length) {
      // A torn final line: never acknowledged, so it is cut, not parsed.
      const fd = fs.openSync(this.file, 'r+'); /* state-registry: conversation-graph */
      try { fs.ftruncateSync(fd, end); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      this.tornRepaired = true;
      this.report(`conversation-graph: truncated a torn final line (${buf.length - end} bytes) in ${this.file}`);
      buf = buf.subarray(0, end);
    }
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line) continue;
      let ev: GraphEvent | null = null;
      try { ev = validateGraphEvent(JSON.parse(line)); } catch { ev = null; }
      if (!ev) { this.skipped += 1; continue; }
      const h = graphEventHash(ev);
      const prior = this.hashes.get(ev.eventId);
      if (prior === h) continue;
      // A differing duplicate on disk is kept in the list so the reducer quarantines both copies.
      if (prior === undefined) this.hashes.set(ev.eventId, h);
      this.list.push(ev);
    }
    if (this.skipped > 0) this.report(`conversation-graph: skipped ${this.skipped} invalid line(s) in ${this.file}`);
  }

  events(): GraphEvent[] { return this.list.slice(); }

  /**
   * Append one event. Returns `appended:false` for an identical duplicate. Throws for an invalid
   * event, a differing duplicate id, or a failed write (in which case nothing was committed).
   */
  append(raw: unknown): { appended: boolean } {
    const ev = validateGraphEvent(raw);
    if (!ev) throw new Error('invalid conversation-graph event');
    const h = graphEventHash(ev);
    const prior = this.hashes.get(ev.eventId);
    if (prior === h) return { appended: false };
    if (prior !== undefined) throw new Error('conversation-graph event id already used for a different event');
    const line = `${canonicalJson(ev)}\n`;
    if (Buffer.byteLength(line) > MAX_GRAPH_EVENT_BYTES) throw new Error('conversation-graph event too large');
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const created = !fs.existsSync(this.file);
    const fd = fs.openSync(this.file, 'a', 0o600); /* state-registry: conversation-graph */
    try {
      const offset = fs.fstatSync(fd).size;
      try {
        fs.writeSync(fd, line);
        fs.fsyncSync(fd);
      } catch (err) {
        try { fs.ftruncateSync(fd, offset); fs.fsyncSync(fd); } catch { /* @silent-fallback-ok — the load-time torn-tail pass truncates it instead */ }
        throw err;
      }
    } finally { fs.closeSync(fd); }
    if (created) this.fsyncDir();
    this.hashes.set(ev.eventId, h);
    this.list.push(ev);
    return { appended: true };
  }

  health(): GraphStoreHealth {
    return { events: this.list.length, skippedInvalidLines: this.skipped, tornTailRepaired: this.tornRepaired, file: this.file };
  }

  private fsyncDir(): void {
    try {
      const dfd = fs.openSync(this.dir, 'r');
      try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
    } catch { /* @silent-fallback-ok — some filesystems refuse a directory fsync; the file itself was fsynced */ }
  }
}

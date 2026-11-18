/**
 * Where imported chats and projects live (docs/specs/import-from-claude-chatgpt.md §B.1, §B.5-§B.7, §C).
 * Local to this machine: plain files under <stateDir>/imported-history/, written by nothing but the
 * importer. It has no replication hook and writes no journal event, so nothing in it leaves the machine.
 * It is read-only after import: chats are never appended to (continuing one starts a new conversation).
 *
 * Re-importing a newer export adds only what's new: conversations are keyed by their original id and
 * messages by their own id (plus #part when split).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { ImportedConversation, ImportedMessage, ImportedProject, ImportSource } from './exportParsers.js';
import { IMPORTED_HISTORY_DIRNAME } from '../core/importedHistoryPaths.js';

export interface ConversationSummary {
  ref: string;
  from: ImportSource;
  originalId: string;
  title: string;
  createdAt: string | null;
  lastAt: string | null;
  messageCount: number;
}

export interface ProjectSummary {
  ref: string;
  from: ImportSource;
  originalId: string;
  name: string;
  instructions: string;
  fileNames: string[];
}

export interface SearchHit {
  ref: string;
  from: ImportSource;
  title: string;
  at: string | null;
  senderName: string;
  snippet: string;
}

interface Manifest {
  version: 1;
  conversations: Record<string, ConversationSummary & { file: string; hash: string }>;
  projects: Record<string, ProjectSummary>;
}

/** The reference imported results carry in search and links: imported:<from>:<originalId>. */
export function importedRef(from: ImportSource, originalId: string): string {
  return `imported:${from}:${originalId}`;
}

function fileFor(ref: string): string {
  return crypto.createHash('sha256').update(ref).digest('hex').slice(0, 32);
}

function writeAtomic(file: string, data: string): void {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export class ImportedHistoryStore {
  readonly dir: string;
  private manifest: Manifest;
  private dirty = false;

  constructor(stateDir: string) {
    this.dir = path.join(stateDir, IMPORTED_HISTORY_DIRNAME);
    fs.mkdirSync(path.join(this.dir, 'conversations'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(this.dir, 'attachments'), { recursive: true, mode: 0o700 });
    this.manifest = this.readManifest();
  }

  /** A fresh reader observes later imports and creates nothing when this machine has no history. */
  static openIfPresent(stateDir: string): ImportedHistoryStore | null {
    return fs.existsSync(path.join(stateDir, 'imported-history', 'manifest.json')) ? new ImportedHistoryStore(stateDir) : null;
  }

  hasConversations(): boolean {
    return Object.keys(this.manifest.conversations).length > 0;
  }

  hasConversation(ref: string): boolean {
    return Object.hasOwn(this.manifest.conversations, ref);
  }

  /** A bounded keyword scan reads one local JSONL row at a time. False means some rows were not searched. */
  async visitSearchMessages(only: string | null, visit: (conversation: ConversationSummary, message: ImportedMessage) => void): Promise<boolean> {
    const conversations = only ? (this.hasConversation(only) ? [this.manifest.conversations[only]!] : []) : this.listConversations();
    const deadline = Date.now() + 1500;
    let rows = 0;
    let files = 0;
    let complete = true;
    for (const conversation of conversations) {
      if (++files > 2000 || Date.now() > deadline) return false;
      const input = fs.createReadStream(this.convPath(fileFor(conversation.ref)), { encoding: 'utf8' });
      const lines = createInterface({ input, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          if (++rows > 5000 || Date.now() > deadline) return false;
          if (!line) continue;
          let message: ImportedMessage;
          try { message = JSON.parse(line) as ImportedMessage; }
          catch { complete = false; continue; } // A torn row must not hide the remaining history.
          if (typeof message?.text !== 'string' || typeof message.key !== 'string') { complete = false; continue; }
          visit(conversation, message);
        }
      } catch (err) {
        if (!(err instanceof Error && 'code' in err)) throw err;
        complete = false; // An unreadable file leaves the other conversations searchable.
      } finally {
        lines.close();
        input.destroy();
      }
    }
    return complete;
  }

  private readManifest(): Manifest {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(this.dir, 'manifest.json'), 'utf-8')) as Manifest;
      if (m && m.version === 1 && m.conversations && m.projects) return m;
    } catch { /* @silent-fallback-ok: no manifest yet means nothing imported */ }
    return { version: 1, conversations: {}, projects: {} };
  }

  private saveManifest(): void {
    writeAtomic(path.join(this.dir, 'manifest.json'), JSON.stringify(this.manifest));
  }

  private convPath(file: string): string {
    return path.join(this.dir, 'conversations', `${file}.jsonl`);
  }

  /**
   * Adds a conversation, or only its new messages when it was imported before. Returns how many were added.
   * The chat's own file is the truth for what's there (not the manifest), so a crash between the append
   * and the manifest save, or a lost manifest, never duplicates messages. Call flush() to save the
   * manifest; the importer does that every few hundred chats and at the end.
   */
  addConversation(conv: ImportedConversation): { added: number; isNew: boolean } {
    const ref = importedRef(conv.from, conv.originalId);
    const existing = this.manifest.conversations[ref];
    const file = existing?.file ?? fileFor(ref);
    const have = new Set<string>();
    for (const m of this.readMessagesByFile(file)) have.add(m.key);
    const fresh = conv.messages.filter((m) => !have.has(m.key));
    if (fresh.length) {
      fs.appendFileSync(this.convPath(file), fresh.map((m) => JSON.stringify(m)).join('\n') + '\n', { mode: 0o600 });
    }
    for (const o of conv.overflow) {
      const a = path.join(this.dir, 'attachments', `${fileFor(`${ref}#${o.key}`)}.txt`);
      if (!fs.existsSync(a)) writeAtomic(a, o.text);
    }
    const all = have.size + fresh.length;
    const times = conv.messages.map((m) => m.at).filter((t): t is string => !!t).sort();
    const lastAt = [existing?.lastAt ?? null, times[times.length - 1] ?? null].filter((t): t is string => !!t).sort().pop() ?? null;
    this.manifest.conversations[ref] = {
      ref, from: conv.from, originalId: conv.originalId, title: conv.title,
      createdAt: existing?.createdAt ?? conv.createdAt, lastAt, messageCount: all, file,
      hash: crypto.createHash('sha256').update(`${existing?.hash ?? ''}${fresh.map((m) => m.key).join(',')}`).digest('hex').slice(0, 32),
    };
    if (fresh.length || !existing || existing.title !== conv.title) this.dirty = true;
    return { added: fresh.length, isNew: !existing && have.size === 0 };
  }

  /** Saves the manifest when anything changed. */
  flush(): void {
    if (!this.dirty) return;
    this.saveManifest();
    this.dirty = false;
  }

  addProject(p: ImportedProject): boolean {
    const ref = importedRef(p.from, p.originalId);
    const isNew = !this.manifest.projects[ref];
    this.manifest.projects[ref] = { ref, from: p.from, originalId: p.originalId, name: p.name, instructions: p.instructions, fileNames: p.fileNames };
    this.dirty = true;
    return isNew;
  }

  /** Imported chats, newest last message first (their own times, not when they were imported). */
  listConversations(): ConversationSummary[] {
    return Object.values(this.manifest.conversations)
      .map(({ file: _f, hash: _h, ...s }) => s)
      .sort((a, b) => (b.lastAt ?? '').localeCompare(a.lastAt ?? ''));
  }

  listProjects(): ProjectSummary[] {
    return Object.values(this.manifest.projects).sort((a, b) => a.name.localeCompare(b.name));
  }

  private readMessagesByFile(file: string): ImportedMessage[] {
    let raw = '';
    try { raw = fs.readFileSync(this.convPath(file), 'utf-8'); } catch { return []; } // @silent-fallback-ok: a conversation with no messages yet
    const out: ImportedMessage[] = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try { out.push(JSON.parse(line) as ImportedMessage); } catch { /* @silent-fallback-ok: a torn last line from a crash mid-append is skipped */ }
    }
    return out;
  }

  /** One imported chat's messages in time order (ties keep their import order). */
  readMessages(ref: string): ImportedMessage[] | null {
    const c = this.manifest.conversations[ref];
    if (!c) return null;
    return this.readMessagesByFile(c.file)
      .map((m, i) => ({ m, i }))
      .sort((a, b) => ((a.m.at ?? '') === (b.m.at ?? '') ? a.i - b.i : (a.m.at ?? '').localeCompare(b.m.at ?? '')))
      .map(({ m }) => m);
  }

  /**
   * Plain keyword search over imported chats: every word must appear in one message. Newest chats are
   * searched first and the walk stops at `limit` hits or `budgetMs`, so a large import stays responsive.
   */
  search(query: string, limit = 20, budgetMs = 1500): { hits: SearchHit[]; complete: boolean } {
    const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 0).slice(0, 8);
    if (!words.length) return { hits: [], complete: true };
    const started = Date.now();
    const hits: SearchHit[] = [];
    for (const c of this.listConversations()) {
      if (Date.now() - started > budgetMs) return { hits, complete: false };
      const file = this.manifest.conversations[c.ref]!.file;
      for (const m of this.readMessagesByFile(file)) {
        if (Date.now() - started > budgetMs) return { hits, complete: false };
        const lower = m.text.toLowerCase();
        if (!words.every((w) => lower.includes(w))) continue;
        const at = lower.indexOf(words[0]!);
        const from = Math.max(0, at - 120);
        hits.push({ ref: c.ref, from: c.from, title: c.title, at: m.at, senderName: m.senderName, snippet: `${from > 0 ? '…' : ''}${m.text.slice(from, from + 400)}${from + 400 < m.text.length ? '…' : ''}` });
        if (hits.length >= limit) return { hits, complete: false };
        break; // one hit per chat
      }
    }
    return { hits, complete: true };
  }

  /** The full text of a message too long to show in parts ("Show the full message"). */
  readFullMessage(ref: string, key: string): string | null {
    try { return fs.readFileSync(path.join(this.dir, 'attachments', `${fileFor(`${ref}#${key}`)}.txt`), 'utf-8'); } catch { return null; } // @silent-fallback-ok: not an overflowed message
  }
}

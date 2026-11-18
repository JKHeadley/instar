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
import Database from 'better-sqlite3';
import { registerSqliteHandle } from '../core/SqliteRegistry.js';
import { privateImportDatabasePath, verifyPrivateImportDirectory } from './privateImportState.js';
import type { ImportedConversation, ImportedMessage, ImportedProject, ImportSource } from './exportParsers.js';

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

export class ImportWriterBusy extends Error {
  constructor() { super('An import is already running.'); }
}

export class ImportedHistoryStore {
  readonly dir: string;
  private manifest: Manifest;
  private dirty = false;
  private writing = false;

  constructor(stateDir: string) {
    this.dir = path.join(stateDir, 'imported-history');
    for (const directory of [this.dir, path.join(this.dir, 'conversations'), path.join(this.dir, 'attachments')]) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      verifyPrivateImportDirectory(directory);
    }
    this.manifest = this.readManifest();
  }

  private readManifest(): Manifest {
    let raw: string;
    try { raw = fs.readFileSync(path.join(this.dir, 'manifest.json'), 'utf-8'); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      return { version: 1, conversations: {}, projects: {} };
    }
    const m: Manifest = JSON.parse(raw);
    if (m?.version !== 1 || !m.conversations || typeof m.conversations !== 'object' || Array.isArray(m.conversations) ||
        !m.projects || typeof m.projects !== 'object' || Array.isArray(m.projects)) {
      throw new Error('The imported history manifest could not be read.');
    }
    return m;
  }

  private refreshForRead(): void {
    if (!this.writing && !this.dirty) this.manifest = this.readManifest();
  }

  /** Both manual and acquired imports acquire the same OS-released lock before the first write. */
  async withWriter<T>(write: () => Promise<T>): Promise<T> {
    const db = new Database(privateImportDatabasePath(this.dir, 'write-lock.sqlite'), { timeout: 0 }); /* state-registry: imported-history-local */
    const unregister = registerSqliteHandle(() => db.close());
    try {
      try { db.exec('BEGIN IMMEDIATE'); }
      catch (err) {
        if (['SQLITE_BUSY', 'SQLITE_LOCKED'].includes((err as {code?: string}).code ?? '')) throw new ImportWriterBusy();
        throw err;
      }
      if (this.dirty) throw new Error('The imported history has unsaved changes.');
      this.manifest = this.readManifest();
      this.writing = true;
      try { return await write(); } catch (err) {
        // A failed flush may have appended durable messages. A retry re-reads the manifest and those files.
        this.dirty = false;
        throw err;
      } finally { this.writing = false; }
    } finally { unregister(); if (db.open) db.close(); }
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
      const fd = fs.openSync(this.convPath(file), 'a+', 0o600);
      try {
        // A killed append may leave an incomplete final record. Keep the next JSON record on its own line.
        const size = fs.fstatSync(fd).size;
        const lastByte = Buffer.alloc(1);
        if (size) fs.readSync(fd, lastByte, 0, 1, size - 1);
        const separator = size && lastByte[0] !== 0x0a ? '\n' : '';
        fs.appendFileSync(fd, separator + fresh.map(m => JSON.stringify(m)).join('\n') + '\n');
      } finally { fs.closeSync(fd); }
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
    this.refreshForRead();
    return Object.values(this.manifest.conversations)
      .map(({ file: _f, hash: _h, ...s }) => s)
      .sort((a, b) => (b.lastAt ?? '').localeCompare(a.lastAt ?? ''));
  }

  listProjects(): ProjectSummary[] {
    this.refreshForRead();
    return Object.values(this.manifest.projects).sort((a, b) => a.name.localeCompare(b.name));
  }

  private readMessagesByFile(file: string): ImportedMessage[] {
    let raw = '';
    try { raw = fs.readFileSync(this.convPath(file), 'utf-8'); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const out: ImportedMessage[] = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try { out.push(JSON.parse(line) as ImportedMessage); } catch { /* @silent-fallback-ok: a torn last line from a crash mid-append is skipped */ }
    }
    return out;
  }

  /** One imported chat's messages in time order (ties keep their import order). */
  readMessages(ref: string): ImportedMessage[] | null {
    this.refreshForRead();
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

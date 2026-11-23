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
import { createInterface } from 'node:readline';
import type { ImportedConversation, ImportedMessage, ImportedProject, ImportSource } from './exportParsers.js';
import { isExportSource } from './exportParsers.js';
import { IMPORTED_HISTORY_DIRNAME } from '../core/importedHistoryPaths.js';
import { CHUNK_BYTES } from '../core/appMediaTypes.js';
import { createLocalSourceClaim, localSourceDestination, parseLocalSourceClaim, type LocalSourceClaim, type LocalSourceIdentity } from './LocalSourceIdentity.js';

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
  private writerLease: Database.Database | null = null;
  private localDirty = false;
  private readonly activeLocalClaims = new Map<string, Readonly<LocalSourceClaim>>();

  constructor(stateDir: string) {
    this.dir = path.join(stateDir, IMPORTED_HISTORY_DIRNAME);
    for (const directory of [this.dir, path.join(this.dir, 'conversations'), path.join(this.dir, 'attachments')]) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      verifyPrivateImportDirectory(directory);
    }
    this.manifest = this.readManifest();
  }

  /** A fresh reader observes later imports and creates nothing when this machine has no history. */
  static openIfPresent(stateDir: string): ImportedHistoryStore | null {
    return fs.existsSync(path.join(stateDir, 'imported-history', 'manifest.json')) ? new ImportedHistoryStore(stateDir) : null;
  }

  hasConversations(): boolean {
    return Object.values(this.manifest.conversations).some(c => isExportSource(c.from));
  }

  hasConversation(ref: string): boolean {
    return Object.hasOwn(this.manifest.conversations, ref);
  }

  /** A bounded keyword scan reads one local JSONL row at a time. False means some rows were not searched. */
  async visitSearchMessages(only: string | null, visit: (conversation: ConversationSummary, message: ImportedMessage) => void): Promise<boolean> {
    const conversations = (only ? (this.hasConversation(only) ? [this.manifest.conversations[only]!] : []) : this.listConversations('exports'))
      .filter(c => isExportSource(c.from));
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
    if (this.writing) throw new ImportWriterBusy();
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
      this.writerLease = db;
      this.activeLocalClaims.clear();
      try {
        const result = await write();
        if (this.localDirty && this.dirty) throw new Error('local-source-flush-required');
        return result;
      } catch (err) {
        // A failed flush may have appended durable messages. A retry re-reads the manifest and those files.
        this.dirty = false;
        this.localDirty = false;
        throw err;
      } finally { this.activeLocalClaims.clear(); this.writerLease = null; this.writing = false; }
    } finally { unregister(); if (db.open) db.close(); }
  }

  private saveManifest(): void {
    writeAtomic(path.join(this.dir, 'manifest.json'), JSON.stringify(this.manifest));
  }

  private convPath(file: string): string {
    return path.join(this.dir, 'conversations', `${file}.jsonl`);
  }

  private hasLocalWriter(): boolean {
    const lease = this.writerLease;
    return this.writing && !!lease?.open && lease.inTransaction;
  }

  /** Fixed, inode-protected metadata DB. Its independent FULL commit completes
   * before conversation append while withWriter keeps the actual writer lock. */
  private withLocalClaims<T>(write: boolean, operation: (db: Database.Database) => T): T {
    if (process.platform === 'win32' || !process.getuid) throw new Error('local-source-private-storage-unavailable');
    let db: Database.Database | undefined;
    let unregister: (() => void) | undefined;
    try {
      // Lookup cannot create a file or repair permissions. Recovery access lets
      // SQLite roll back a dead writer's hot journal; query_only prevents SQL
      // mutations on this logically read-only connection. SQLite owns recovery
      // and live-writer locking, never a PID heuristic or manual journal removal.
      db = new Database(privateImportDatabasePath(this.dir, 'source-claims.sqlite', { readOnly: !write }), { timeout: 0, fileMustExist: !write }); /* state-registry: imported-history-local */
      const opened = db;
      unregister = registerSqliteHandle(() => opened.close());
      if (!write) db.pragma('query_only = ON');
      if (write) {
        db.pragma('synchronous = FULL');
        if (!this.hasLocalClaimsSchema(db)) db.exec('CREATE TABLE local_source_claims (ref TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL)');
      }
      return operation(db);
    } catch (error) {
      if (error instanceof Error && ['unknown-source-identity', 'local-source-reconciliation-required'].includes(error.message)) throw error;
      if (['SQLITE_BUSY', 'SQLITE_LOCKED'].includes((error as { code?: string }).code ?? '')) throw new ImportWriterBusy();
      throw new Error('local-source-identity-unavailable');
    } finally { unregister?.(); if (db?.open) db.close(); }
  }

  private hasLocalClaimsSchema(db: Database.Database): boolean {
    if (db.pragma('user_version', { simple: true }) !== 0) throw new Error('unknown-source-identity');
    const objects = db.prepare("SELECT name, type FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' LIMIT 2").all() as Array<{name: string; type: string}>;
    if (objects.length === 0) {
      if (db.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get()) throw new Error('unknown-source-identity');
      return false;
    }
    if (objects.length !== 1 || objects[0]!.name !== 'local_source_claims' || objects[0]!.type !== 'table') throw new Error('unknown-source-identity');
    const columns = db.pragma('table_info(local_source_claims)') as Array<{name: string; type: string; notnull: number; pk: number; dflt_value: unknown}>;
    if (columns.length !== 2 || columns.some((c, index) => c.name !== (index === 0 ? 'ref' : 'payload')
      || c.type.toUpperCase() !== 'TEXT' || c.notnull !== 1 || c.pk !== (index === 0 ? 1 : 0) || c.dflt_value !== null)) throw new Error('unknown-source-identity');
    return true;
  }

  private readLocalClaim(db: Database.Database, ref: string): Readonly<LocalSourceClaim> | null {
    if (!this.hasLocalClaimsSchema(db)) return null;
    // Direct-column octet_length uses SQLite's no-payload-load byte-length path.
    // CAST before length would allocate the entire damaged cell in native memory.
    const row = db.prepare('SELECT CASE WHEN octet_length(payload) <= ? THEN payload ELSE NULL END AS payload FROM local_source_claims WHERE ref = ?')
      .get(CHUNK_BYTES, ref) as { payload: string | null } | undefined;
    if (!row) return null;
    try { return parseLocalSourceClaim(JSON.parse(row.payload!)); }
    catch { throw new Error('unknown-source-identity'); }
  }

  /** Read parser mode before preparation. The trusted owner namespace is part
   * of the destination, so another profile cannot collide with this lookup. */
  readLocalSourceClaim(identity: Pick<LocalSourceIdentity, 'ownerUserId' | 'source' | 'originalId'>): Readonly<LocalSourceClaim> | null {
    const destination = localSourceDestination(identity);
    const ref = importedRef(identity.source, destination);
    this.refreshForRead();
    let claim: Readonly<LocalSourceClaim> | null = null;
    if (fs.existsSync(path.join(this.dir, 'source-claims.sqlite'))) claim = this.withLocalClaims(false, db => this.readLocalClaim(db, ref));
    if (!claim && (this.manifest.conversations[ref] || fs.existsSync(this.convPath(fileFor(ref))))) throw new Error('unknown-source-identity');
    if (claim && (claim.ownerUserId !== identity.ownerUserId || claim.source !== identity.source || claim.originalId !== identity.originalId)) {
      throw new Error('unknown-source-identity');
    }
    return claim;
  }

  /** Claim the ACTUAL destination under the real writer before first append.
   * Durable provenance is independent of an ephemeral preview/copy approval. */
  assertOrClaimLocalSource(identity: LocalSourceIdentity): Readonly<LocalSourceClaim> {
    if (!this.hasLocalWriter()) throw new Error('local-source-writer-required');
    const proposed = createLocalSourceClaim(identity);
    const ref = importedRef(proposed.source, proposed.destinationId);
    const before = this.readLocalSourceClaim(proposed);
    if (before && JSON.stringify(before) !== JSON.stringify(proposed)) throw new Error('local-source-reconciliation-required');
    const claim = this.withLocalClaims(true, db => {
      const prior = this.readLocalClaim(db, ref);
      if (prior) {
        if (JSON.stringify(prior) !== JSON.stringify(proposed)) throw new Error('local-source-reconciliation-required');
        return prior;
      }
      if (this.manifest.conversations[ref] || fs.existsSync(this.convPath(fileFor(ref)))) throw new Error('unknown-source-identity');
      db.prepare('INSERT INTO local_source_claims (ref, payload) VALUES (?, ?)').run(ref, JSON.stringify(proposed));
      return proposed;
    });
    this.activeLocalClaims.set(ref, claim);
    return claim;
  }

  /**
   * Adds a conversation, or only its new messages when it was imported before. Returns how many were added.
   * The chat's own file is the truth for what's there (not the manifest), so a crash between the append
   * and the manifest save, or a lost manifest, never duplicates messages. Call flush() to save the
   * manifest; the importer does that every few hundred chats and at the end.
   */
  addConversation(conv: ImportedConversation): { added: number; isNew: boolean } {
    if (this.writing && !this.hasLocalWriter()) throw new Error('import-writer-lease-lost');
    const ref = importedRef(conv.from, conv.originalId);
    if (!isExportSource(conv.from)) {
      const active = this.activeLocalClaims.get(ref);
      if (!this.hasLocalWriter() || !active || active.source !== conv.from || active.destinationId !== conv.originalId) {
        throw new Error('local-source-active-claim-required');
      }
      const durable = this.withLocalClaims(false, db => this.readLocalClaim(db, ref));
      if (!durable || JSON.stringify(durable) !== JSON.stringify(active)) throw new Error('unknown-source-identity');
    }
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
    if (!isExportSource(conv.from) && this.dirty) this.localDirty = true;
    return { added: fresh.length, isNew: !existing && have.size === 0 };
  }

  /** Saves the manifest when anything changed. */
  flush(): void {
    if (!this.dirty) return;
    if (this.localDirty && !this.hasLocalWriter()) throw new Error('local-source-writer-required');
    if (this.writing && !this.hasLocalWriter()) throw new Error('import-writer-lease-lost');
    this.saveManifest();
    this.dirty = false;
    this.localDirty = false;
  }

  addProject(p: ImportedProject): boolean {
    if (this.writing && !this.hasLocalWriter()) throw new Error('import-writer-lease-lost');
    const ref = importedRef(p.from, p.originalId);
    const isNew = !this.manifest.projects[ref];
    this.manifest.projects[ref] = { ref, from: p.from, originalId: p.originalId, name: p.name, instructions: p.instructions, fileNames: p.fileNames };
    this.dirty = true;
    return isNew;
  }

  /** Imported chats, newest last message first (their own times, not when they were imported). */
  listConversations(sources: 'all' | 'exports' = 'all'): ConversationSummary[] {
    this.refreshForRead();
    return Object.values(this.manifest.conversations)
      .filter(c => sources === 'all' || isExportSource(c.from))
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
    for (const c of this.listConversations('exports')) {
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

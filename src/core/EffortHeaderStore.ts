/**
 * EffortHeaderStore — the erasable home of user-authored effort text (spec
 * docs/specs/conversation-effort-hierarchy-v3.md §3.2: "No graph event contains user-authored
 * title/summary text"; titles are a versioned header write, outside immutable graph events).
 *
 * WHY NOT AN APPEND-ONLY LOG: a forget must remove the text from disk. An append-only file can only
 * add a tombstone beside the words it is meant to erase. So the source of truth here is ONE
 * snapshot file, `<stateDir>/conversation-graph/effort-headers.json`, rewritten atomically on every
 * change (temp file → fsync → rename → fsync the directory). After a forget, the current file holds
 * no copy of the title. (What the filesystem keeps in freed blocks is outside this store's reach.)
 *
 * CONCURRENCY: every write names the version it read (compare-and-set). A stale version is a
 * `version-conflict` carrying the current version — never a last-writer guess.
 *
 * ERASURE IS PERMANENT for this store: a forgotten header keeps its version counter and a
 * `forgotten` marker, and refuses any later write, so a delayed write cannot restore the text.
 *
 * SCOPE OF THIS SLICE: local only. Replicating headers and erasure tombstones to every installed
 * member (v3 §7.6, "completion waits for every installed member") is the increment-A replication
 * owner's work; `forget()` therefore reports `local: true`, never fleet-wide completion.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { EffortRef } from './conversationGraph.js';
import { SafeFsExecutor } from './SafeFsExecutor.js';

export const MAX_EFFORT_TITLE_CHARS = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface HeaderRecord { version: number; title?: string; forgotten?: true; updatedAt: string }
interface Snapshot { schemaVersion: 1; headers: Record<string, HeaderRecord> }

export type HeaderWriteResult =
  | { ok: true; version: number }
  | { ok: false; code: 'version-conflict'; currentVersion: number }
  | { ok: false; code: 'forgotten' }
  | { ok: false; code: 'invalid' };

export class EffortHeaderStore {
  readonly file: string;
  private readonly dir: string;
  private snap: Snapshot = { schemaVersion: 1, headers: {} };

  constructor(stateDir: string, private readonly now: () => Date = () => new Date()) {
    this.dir = path.join(stateDir, 'conversation-graph');
    this.file = path.join(this.dir, 'effort-headers.json');
    this.load();
  }

  load(): void {
    // A temp file left by a crash mid-persist may hold text a forget was erasing: remove it.
    if (fs.existsSync(this.dir)) {
      for (const name of fs.readdirSync(this.dir)) {
        const m = /^effort-headers\.json\.(\d+)\.tmp$/.exec(name);
        // Only a temp file whose writer is gone: a live process mid-write keeps its own.
        if (m && !EffortHeaderStore.alive(Number(m[1]))) this.removeTemp(path.join(this.dir, name));
      }
    }
    if (!fs.existsSync(this.file)) { this.snap = { schemaVersion: 1, headers: {} }; return; }
    const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as unknown;
    const obj = parsed as Partial<Snapshot>;
    if (!obj || obj.schemaVersion !== 1 || !obj.headers || typeof obj.headers !== 'object') {
      // A header file this version cannot read is never silently replaced: refuse to start.
      throw new Error(`effort header store unreadable: ${this.file}`);
    }
    this.snap = { schemaVersion: 1, headers: { ...obj.headers } };
  }

  /** The current header, or null when none was ever written. A forgotten header has no title. */
  get(effort: EffortRef): { version: number; title: string | null; forgotten: boolean } | null {
    const rec = this.snap.headers[effort.id];
    if (!rec) return null;
    return { version: rec.version, title: rec.forgotten ? null : rec.title ?? null, forgotten: rec.forgotten === true };
  }

  /** The title to display, or null (absent or forgotten). Shaped for GraphProjection.effortTitle. */
  titleOf = (effort: EffortRef): string | null => this.get(effort)?.title ?? null;

  /** Compare-and-set a title. `expectedVersion` is 0 for a header that does not exist yet. */
  write(effort: EffortRef, expectedVersion: number, title: string): HeaderWriteResult {
    if (!UUID_RE.test(effort.id) || typeof title !== 'string') return { ok: false, code: 'invalid' };
    const clean = title.trim();
    if (clean.length === 0 || clean.length > MAX_EFFORT_TITLE_CHARS) return { ok: false, code: 'invalid' };
    const rec = this.snap.headers[effort.id];
    if (rec?.forgotten) return { ok: false, code: 'forgotten' };
    const current = rec?.version ?? 0;
    if (expectedVersion !== current) return { ok: false, code: 'version-conflict', currentVersion: current };
    const next: Snapshot = { schemaVersion: 1, headers: { ...this.snap.headers, [effort.id]: { version: current + 1, title: clean, updatedAt: this.now().toISOString() } } };
    this.persist(next);
    return { ok: true, version: current + 1 };
  }

  /** Erase the title. Idempotent; the text is gone from the current file when this returns. */
  forget(effort: EffortRef): { ok: true; version: number; local: true } | { ok: false; code: 'invalid' } {
    if (!UUID_RE.test(effort.id)) return { ok: false, code: 'invalid' };
    const rec = this.snap.headers[effort.id];
    if (rec?.forgotten) return { ok: true, version: rec.version, local: true };
    const version = (rec?.version ?? 0) + 1;
    const next: Snapshot = { schemaVersion: 1, headers: { ...this.snap.headers, [effort.id]: { version, forgotten: true, updatedAt: this.now().toISOString() } } };
    this.persist(next);
    return { ok: true, version, local: true };
  }

  private persist(next: Snapshot): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      const fd = fs.openSync(tmp, 'w', 0o600); /* state-registry: conversation-graph */
      try {
        fs.writeSync(fd, `${JSON.stringify(next)}\n`);
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, this.file);
    } catch (err) {
      // Any failure before the rename landed: the temp file may hold text this write was meant to
      // erase, so it is removed now rather than left for a later persist to overwrite.
      this.removeTemp(tmp);
      throw err;
    }
    try {
      const dfd = fs.openSync(this.dir, 'r');
      try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
    } catch { /* @silent-fallback-ok — some filesystems refuse a directory fsync; the file itself was fsynced */ }
    this.snap = next;
  }

  private removeTemp(file: string): void {
    try { SafeFsExecutor.safeUnlinkSync(file, { operation: 'src/core/EffortHeaderStore.ts:temp-cleanup' }); } catch { /* @silent-fallback-ok — the next load retries the sweep; the committed file never held the erased text */ }
  }

  private static alive(pid: number): boolean {
    if (pid === process.pid) return false; // this process is not mid-write during load
    try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
  }
}

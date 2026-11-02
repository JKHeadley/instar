/**
 * AppMediaStore — the bytes behind app conversations (docs/specs/mobile-native-chat-media.md,
 * increment 1, this machine's half).
 *
 * `<stateDir>/app-media/`:
 *   blobs/<sha[0:2]>/<sha>   content-addressed, written once, mode 0400, never in a journal or log
 *   deleted/<sha[0:2]>/<sha> blobs referenced only by deleted conversations (retained, not counted)
 *   quarantine/<sha>         a blob whose bytes no longer match its name (moved, never deleted)
 *   uploads/index.sqlite     upload and chunk state (WAL), plus each blob's last check
 *   uploads/<uploadId>/      chunks, then `assembled`
 *   session-files/<messageId>/  a session's private copy (clone where the filesystem can)
 *   outbox/                  the place an agent may put a file it means to send
 *
 * Every step of an upload is safe to repeat and every crash point has one recovery answer
 * (§4.2 steps 4-5, §4.3 recovery). A message event is never written before its blobs are durable.
 * Nothing here decides by content: sizes, hashes and fixed limits only.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { registerSqliteHandle } from './SqliteRegistry.js';
import { SafeFsExecutor } from './SafeFsExecutor.js';
import type { AppConversationStore } from './AppConversationStore.js';
import { assembleChunks, hashFile } from './appMediaWorker.js';
import {
  CHUNK_BYTES, MAX_FILE_BYTES, isSha256Hex, safeFileName, sniffMediaType, type AppAttachment, type MediaKind,
} from './appMediaTypes.js';

export const DEFAULT_MAX_STORE_BYTES = 21_474_836_480;
const DEVICE_MAX_OPEN = 4;
const DEVICE_MAX_STAGED = 256 * 1024 * 1024;
const MACHINE_MAX_STAGED = 1024 * 1024 * 1024;
const FLOOR_ABS_BYTES = 2 * 1024 * 1024 * 1024;
const FLOOR_FRACTION = 0.05;
export const UPLOAD_TTL_MS = 24 * 60 * 60_000;
const EXPIRED_ROW_KEEP_MS = 7 * 24 * 60 * 60_000;
export const CLAIM_RECOVERY_AGE_MS = 5 * 60_000;
const ORPHAN_GRACE_MS = 7 * 24 * 60 * 60_000;
export const SESSION_COPY_TTL_MS = 30 * 24 * 60 * 60_000;
const FULL_CHECK_MS = 7 * 24 * 60 * 60_000;
const OP = 'src/core/AppMediaStore.ts';

export type UploadState = 'open' | 'assembling' | 'complete' | 'claimed' | 'sent' | 'expired';

export interface UploadRow {
  uploadId: string; deviceId: string; conversationRef: string; size: number; sha256: string;
  declaredKind: MediaKind; declaredType: string; filename: string; state: UploadState;
  mediaType: string | null; messageId: string | null; claimedAt: number | null; blobReady: number;
  startedAt: number; expiresAt: number; reserved: number;
}

export type Refusal = { status: number; error: string; detail: string };

export interface AppMediaStoreOptions {
  stateDir: string;
  store: AppConversationStore;
  maxStoreBytes: () => number;
  now?: () => number;
  /** Free and total bytes of the store's volume (injected by tests). */
  diskSpace?: () => { free: number; total: number } | null;
  reportDegradation?: (what: string, detail: string) => void;
  /** An admission was refused for capacity (the service self-heals, then raises one notice). */
  onRefused?: (error: string) => void;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS uploads (uploadId TEXT PRIMARY KEY, deviceId TEXT NOT NULL, conversationRef TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, declaredKind TEXT NOT NULL, declaredType TEXT NOT NULL, filename TEXT NOT NULL, state TEXT NOT NULL, mediaType TEXT, messageId TEXT, claimedAt INTEGER, blobReady INTEGER NOT NULL DEFAULT 0, startedAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL, reserved INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS uploads_state ON uploads(state)`,
  `CREATE INDEX IF NOT EXISTS uploads_device ON uploads(deviceId, state)`,
  `CREATE TABLE IF NOT EXISTS chunks (uploadId TEXT NOT NULL, idx INTEGER NOT NULL, sha256 TEXT NOT NULL, length INTEGER NOT NULL, PRIMARY KEY (uploadId, idx))`,
  `CREATE TABLE IF NOT EXISTS blob_checks (sha256 TEXT PRIMARY KEY, checkedAt INTEGER NOT NULL, mtimeMs REAL NOT NULL, size INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS orphans (sha256 TEXT PRIMARY KEY, firstSeenAt INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
];

export class AppMediaStore {
  readonly root: string;
  private readonly blobsDir: string;
  private readonly deletedDir: string;
  private readonly quarantineDir: string;
  private readonly uploadsDir: string;
  private readonly sessionDir: string;
  readonly outboxDir: string;
  private readonly db: BetterSqliteDatabase;
  private readonly now: () => number;
  private readonly finalizing = new Map<string, Promise<void>>();
  /** Send requests running in this process, by message id: their claims are never undone. */
  private readonly activeClaims = new Set<string>();
  /** Agent-reply reservations (held only for the length of one request). */
  private readonly replyReservations = new Map<string, number>();
  private lastInventory: { orphanBlobs: number; missingBlobs: number; at: number } | null = null;
  private sweepRunning = false;

  constructor(private readonly opts: AppMediaStoreOptions) {
    this.root = path.join(opts.stateDir, 'app-media');
    this.blobsDir = path.join(this.root, 'blobs');
    this.deletedDir = path.join(this.root, 'deleted');
    this.quarantineDir = path.join(this.root, 'quarantine');
    this.uploadsDir = path.join(this.root, 'uploads');
    this.sessionDir = path.join(this.root, 'session-files');
    this.outboxDir = path.join(this.root, 'outbox');
    this.now = opts.now ?? Date.now;
    for (const d of [this.blobsDir, this.deletedDir, this.quarantineDir, this.uploadsDir, this.sessionDir, this.outboxDir]) {
      fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    }
    const dbPath = path.join(this.uploadsDir, 'index.sqlite');
    this.db = new Database(dbPath); /* state-registry: app-media-index */
    try { fs.chmodSync(dbPath, 0o600); } catch { /* @silent-fallback-ok — mode bits are best-effort on some filesystems */ }
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    for (const ddl of SCHEMA) this.db.exec(ddl);
    registerSqliteHandle(() => { try { this.db.close(); } catch { /* @silent-fallback-ok — already closed */ } });
  }

  close(): void { try { this.db.close(); } catch { /* @silent-fallback-ok — already closed */ } }

  private report(detail: string): void {
    try { this.opts.reportDegradation?.('AppMediaStore', detail); } catch { /* @silent-fallback-ok — reporting never fails the store */ }
  }

  // ── Blobs ────────────────────────────────────────────────────────────────────────

  private blobPath(sha: string): string { return path.join(this.blobsDir, sha.slice(0, 2), sha); }
  private deletedPath(sha: string): string { return path.join(this.deletedDir, sha.slice(0, 2), sha); }

  /** Where this blob lives on this machine, or null. */
  locateBlob(sha: string): string | null {
    if (!isSha256Hex(sha)) return null;
    for (const p of [this.blobPath(sha), this.deletedPath(sha)]) { if (fs.existsSync(p)) return p; }
    return null;
  }

  isQuarantined(sha: string): boolean { return isSha256Hex(sha) && fs.existsSync(path.join(this.quarantineDir, sha)); }

  private fsyncDir(dir: string): void {
    try {
      const fd = fs.openSync(dir, 'r');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } catch { /* @silent-fallback-ok — some filesystems refuse a directory fsync; the file itself was fsynced */ }
  }

  /** Atomic publish of a verified, private file: rename, or discard it when the blob exists. */
  private publish(filePath: string, sha: string): void {
    const existing = this.locateBlob(sha);
    if (existing) {
      if (existing !== this.blobPath(sha)) this.moveBlob(existing, this.blobPath(sha));
      SafeFsExecutor.safeRmSync(filePath, { force: true, operation: `${OP}:publish-duplicate` });
    } else {
      const dest = this.blobPath(sha);
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      fs.renameSync(filePath, dest);
      this.fsyncDir(path.dirname(dest));
      this.fsyncDir(this.blobsDir);
    }
    this.recordCheck(sha);
  }

  private moveBlob(from: string, to: string): void {
    fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
    fs.renameSync(from, to);
    this.fsyncDir(path.dirname(to));
  }

  private recordCheck(sha: string): void {
    const p = this.locateBlob(sha);
    if (!p) return;
    const st = fs.statSync(p);
    this.db.prepare('INSERT OR REPLACE INTO blob_checks (sha256, checkedAt, mtimeMs, size) VALUES (?, ?, ?, ?)').run(sha, this.now(), st.mtimeMs, st.size);
  }

  /** The per-attachment byte fact of §4.13. */
  byteFact(sha: string, attachmentId: string): { bytes: 'verified' | 'not-here' | 'mismatch' | 'removed'; bytesCheckedAt?: string } {
    if (this.opts.store.isAttachmentPurged(attachmentId)) return { bytes: 'removed' };
    if (this.isQuarantined(sha)) return { bytes: 'mismatch' };
    const check = this.db.prepare('SELECT checkedAt FROM blob_checks WHERE sha256 = ?').get(sha) as { checkedAt: number } | undefined;
    if (!this.locateBlob(sha) || !check) return { bytes: 'not-here' };
    return { bytes: 'verified', bytesCheckedAt: new Date(check.checkedAt).toISOString() };
  }

  // ── Admission (§4.7) ─────────────────────────────────────────────────────────────

  private diskSpace(): { free: number; total: number } | null {
    if (this.opts.diskSpace) return this.opts.diskSpace();
    try {
      const s = fs.statfsSync(this.root);
      return { free: Number(s.bavail) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize) };
    } catch { return null; } // @silent-fallback-ok — an unreadable volume is reported by the sweep; the write itself still fails loudly
  }

  belowDiskFloor(): boolean {
    const d = this.diskSpace();
    return !!d && d.free < Math.max(FLOOR_FRACTION * d.total, FLOOR_ABS_BYTES);
  }

  /** Whether this hash already counts against the cap, so admitting it adds nothing. */
  private alreadyCounted(sha: string): boolean {
    return (this.opts.store.mediaBlobRefs(sha)?.liveRefs ?? 0) > 0 || fs.existsSync(this.blobPath(sha)) || this.openReservationFor(sha);
  }

  private openReservationFor(sha: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM uploads WHERE sha256 = ? AND reserved > 0 AND state IN ('open','assembling','complete','claimed') LIMIT 1`).get(sha);
  }

  reservedBytes(): number {
    const r = this.db.prepare(`SELECT COALESCE(SUM(reserved), 0) AS b FROM uploads WHERE state IN ('open','assembling','complete','claimed')`).get() as { b: number };
    let bytes = r.b;
    for (const v of this.replyReservations.values()) bytes += v;
    return bytes;
  }

  /** The bytes this file must reserve, or the refusal. A hash already counted reserves 0. */
  private admission(sha: string, size: number): { reserve: number } | Refusal {
    if (this.alreadyCounted(sha)) return { reserve: 0 };
    const refused = this.capacityRefusal(size);
    return refused ?? { reserve: size };
  }

  private capacityRefusal(size: number): Refusal | null {
    let refused: Refusal | null = null;
    if (this.belowDiskFloor()) refused = { status: 507, error: 'media-disk-floor', detail: 'This machine is nearly out of disk space, so the file was not stored.' };
    else if (this.opts.store.mediaLiveBytes() + this.reservedBytes() + size > this.opts.maxStoreBytes()) {
      refused = { status: 507, error: 'media-store-full', detail: 'The media store is full. Permanently remove files in the app, or raise the limit.' };
    }
    if (refused) { try { this.opts.onRefused?.(refused.error); } catch { /* @silent-fallback-ok — the refusal itself stands */ } }
    return refused;
  }

  /** Reserve a reply file before its hash is known: it counts in full until it is published. */
  reserveReplyBytes(id: string, size: number): Refusal | null {
    const refused = this.capacityRefusal(size);
    if (refused) return refused;
    this.replyReservations.set(id, size);
    return null;
  }

  releaseReply(id: string): void { this.replyReservations.delete(id); }

  // ── Uploads (§4.2) ───────────────────────────────────────────────────────────────

  private uploadDir(uploadId: string): string { return path.join(this.uploadsDir, uploadId); }
  private assembledPath(uploadId: string): string { return path.join(this.uploadDir(uploadId), 'assembled'); }

  getUpload(uploadId: string): UploadRow | null {
    return (this.db.prepare('SELECT * FROM uploads WHERE uploadId = ?').get(uploadId) as UploadRow | undefined) ?? null;
  }

  receivedChunks(uploadId: string): number[] {
    return (this.db.prepare('SELECT idx FROM chunks WHERE uploadId = ? ORDER BY idx').all(uploadId) as Array<{ idx: number }>).map((r) => r.idx);
  }

  chunkCount(size: number): number { return Math.ceil(size / CHUNK_BYTES); }

  /** Start an upload after the caller's idempotency check. Returns the row or the refusal. */
  startUpload(input: { deviceId: string; conversationRef: string; size: number; sha256: string; declaredKind: MediaKind; declaredType: string; filename: string }): UploadRow | Refusal {
    if (input.size < 1 || input.size > MAX_FILE_BYTES) return { status: 413, error: 'file-too-large', detail: 'A file can be at most 50 MiB.' };
    // "Open" is an upload still receiving chunks; finished uploads wait to be sent (a message can
    // name 10 of them), and every unfinished-or-unsent one counts toward the staged bytes.
    const open = this.db.prepare(`SELECT COUNT(*) AS n FROM uploads WHERE deviceId = ? AND state IN ('open','assembling')`).get(input.deviceId) as { n: number };
    const staged = this.db.prepare(`SELECT COALESCE(SUM(size), 0) AS b FROM uploads WHERE deviceId = ? AND state IN ('open','assembling','complete','claimed')`).get(input.deviceId) as { b: number };
    if (open.n >= DEVICE_MAX_OPEN || staged.b + input.size > DEVICE_MAX_STAGED) return { status: 429, error: 'too-many-uploads', detail: 'Finish or wait for the uploads in progress first.' };
    if (this.stagedBytes() + input.size > MACHINE_MAX_STAGED) return { status: 507, error: 'upload-staging-full', detail: 'This machine has too many uploads in progress. Try again shortly.' };
    const adm = this.admission(input.sha256, input.size);
    if ('status' in adm) return adm;
    const uploadId = crypto.randomUUID();
    const t = this.now();
    fs.mkdirSync(this.uploadDir(uploadId), { recursive: true, mode: 0o700 });
    const row: UploadRow = {
      ...input, uploadId, state: 'open', mediaType: null, messageId: null, claimedAt: null, blobReady: 0,
      startedAt: t, expiresAt: t + UPLOAD_TTL_MS, reserved: adm.reserve,
    };
    this.db.prepare(`INSERT INTO uploads (uploadId, deviceId, conversationRef, size, sha256, declaredKind, declaredType, filename, state, mediaType, messageId, claimedAt, blobReady, startedAt, expiresAt, reserved)
      VALUES (@uploadId, @deviceId, @conversationRef, @size, @sha256, @declaredKind, @declaredType, @filename, @state, @mediaType, @messageId, @claimedAt, @blobReady, @startedAt, @expiresAt, @reserved)`).run(row);
    return row;
  }

  /** Staging counts every unfinished upload at its declared size (an upper bound on its final file). */
  stagedBytes(): number {
    const r = this.db.prepare(`SELECT COALESCE(SUM(size), 0) AS b FROM uploads WHERE state IN ('open','assembling','complete','claimed')`).get() as { b: number };
    return r.b;
  }

  /** Record one chunk (§4.2 step 2). Writes and fsyncs the file before the row. */
  putChunk(upload: UploadRow, index: number, bytes: Buffer): { ok: true; lastChunk: boolean } | Refusal {
    if (upload.state === 'expired' || upload.expiresAt <= this.now()) return { status: 410, error: 'upload-expired', detail: 'This upload expired. Start it again.' };
    const total = this.chunkCount(upload.size);
    if (index < 0 || index >= total) return { status: 400, error: 'chunk-out-of-range', detail: 'This chunk index is outside the file.' };
    const expected = index === total - 1 ? upload.size - CHUNK_BYTES * (total - 1) : CHUNK_BYTES;
    if (bytes.length !== expected) return { status: 400, error: 'chunk-wrong-length', detail: `This chunk must be ${expected} bytes.` };
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    const prior = this.db.prepare('SELECT sha256 FROM chunks WHERE uploadId = ? AND idx = ?').get(upload.uploadId, index) as { sha256: string } | undefined;
    if (prior) {
      if (prior.sha256 !== sha) return { status: 409, error: 'chunk-conflict', detail: 'Different bytes were already recorded for this chunk.' };
      return { ok: true, lastChunk: false };
    }
    if (upload.state !== 'open') return { status: 409, error: 'upload-not-open', detail: 'This upload has all its chunks already.' };
    const p = path.join(this.uploadDir(upload.uploadId), String(index));
    const fd = fs.openSync(p, 'w', 0o600); /* state-registry: app-media */
    try { fs.writeSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    this.db.prepare('INSERT INTO chunks (uploadId, idx, sha256, length) VALUES (?, ?, ?, ?)').run(upload.uploadId, index, sha, bytes.length);
    const have = (this.db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE uploadId = ?').get(upload.uploadId) as { n: number }).n;
    if (have < total) return { ok: true, lastChunk: false };
    this.db.prepare(`UPDATE uploads SET state = 'assembling' WHERE uploadId = ? AND state = 'open'`).run(upload.uploadId);
    return { ok: true, lastChunk: true };
  }

  /** The one idempotent completion procedure, used by the route and by recovery (§4.2 step 4). */
  finalizeUpload(uploadId: string): Promise<void> {
    const running = this.finalizing.get(uploadId);
    if (running) return running;
    const p = this.runFinalize(uploadId).finally(() => this.finalizing.delete(uploadId));
    this.finalizing.set(uploadId, p);
    return p;
  }

  private async runFinalize(uploadId: string): Promise<void> {
    const u = this.getUpload(uploadId);
    if (!u || u.state !== 'assembling') return;
    const out = this.assembledPath(uploadId);
    let done: Awaited<ReturnType<typeof hashFile>> | null = null;
    if (fs.existsSync(out)) {
      const h = await hashFile(out);
      if (h.sha256 === u.sha256 && h.size === u.size) done = h;
      else SafeFsExecutor.safeRmSync(out, { force: true, operation: `${OP}:reassemble` });
    }
    if (!done) {
      const paths = Array.from({ length: this.chunkCount(u.size) }, (_, i) => path.join(this.uploadDir(uploadId), String(i)));
      const h = await assembleChunks(paths, out);
      if (h.sha256 !== u.sha256 || h.size !== u.size) { this.discardUpload(uploadId, 'hash-mismatch'); return; }
      done = h;
    }
    const mediaType = sniffMediaType(Buffer.from(done.headB64, 'base64'));
    fs.chmodSync(out, 0o400);
    this.db.transaction(() => {
      this.db.prepare(`UPDATE uploads SET state = 'complete', mediaType = ? WHERE uploadId = ?`).run(mediaType, uploadId);
    })();
    this.removeChunks(uploadId);
  }

  /** Whether the last hash check refused this upload (the app starts over). */
  wasHashMismatch(uploadId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM meta WHERE k = ?').get(`mismatch:${uploadId}`);
  }

  private discardUpload(uploadId: string, reason: 'hash-mismatch' | 'expired'): void {
    this.db.transaction(() => {
      if (reason === 'hash-mismatch') this.db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run(`mismatch:${uploadId}`, String(this.now()));
      this.db.prepare(`UPDATE uploads SET state = 'expired', reserved = 0, filename = '' WHERE uploadId = ?`).run(uploadId);
      this.db.prepare('DELETE FROM chunks WHERE uploadId = ?').run(uploadId);
    })();
    SafeFsExecutor.safeRmSync(this.uploadDir(uploadId), { recursive: true, force: true, operation: `${OP}:discard-upload` });
  }

  private removeChunks(uploadId: string): void {
    const dir = this.uploadDir(uploadId);
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const n of names) if (/^\d+$/.test(n)) SafeFsExecutor.safeRmSync(path.join(dir, n), { force: true, operation: `${OP}:remove-chunks` });
  }

  // ── Claim and publish (§4.3) ────────────────────────────────────────────────────

  /**
   * One transaction: every named upload goes complete → claimed for this message, or none does.
   * A second request naming one of them gets `null`.
   */
  claimUploads(uploadIds: string[], messageId: string): boolean {
    const t = this.now();
    const ok = this.db.transaction(() => {
      for (const id of uploadIds) {
        const r = this.db.prepare(`UPDATE uploads SET state = 'claimed', messageId = ?, claimedAt = ? WHERE uploadId = ? AND state = 'complete'`).run(messageId, t, id);
        if (r.changes !== 1) throw new ClaimLost();
      }
      return true;
    });
    try { ok(); } catch (err) {
      if (err instanceof ClaimLost) return false;
      throw err;
    }
    this.activeClaims.add(messageId);
    return true;
  }

  /** Re-hash each assembled file off the event loop and rename it into the blob store. */
  async publishClaimed(uploadIds: string[]): Promise<void> {
    for (const id of uploadIds) {
      const u = this.getUpload(id);
      if (!u) throw new Error('upload vanished');
      if (u.blobReady === 1 && this.locateBlob(u.sha256)) continue;
      const assembled = this.assembledPath(id);
      const h = await hashFile(assembled);
      if (h.sha256 !== u.sha256 || h.size !== u.size) throw new Error('a stored upload no longer matches its hash');
      this.publish(assembled, u.sha256);
      this.db.prepare('UPDATE uploads SET blobReady = 1 WHERE uploadId = ?').run(id);
    }
  }

  /** The event is durable: the uploads are finished and their staging is removed (the name too, §4.13). */
  markSent(uploadIds: string[], messageId: string): void {
    this.db.transaction(() => {
      for (const id of uploadIds) this.db.prepare(`UPDATE uploads SET state = 'sent', reserved = 0, filename = '' WHERE uploadId = ?`).run(id);
    })();
    this.activeClaims.delete(messageId);
    for (const id of uploadIds) SafeFsExecutor.safeRmSync(this.uploadDir(id), { recursive: true, force: true, operation: `${OP}:sent` });
  }

  /** The send failed before its event landed: the uploads may be sent again. */
  releaseClaim(uploadIds: string[], messageId: string): void {
    this.db.transaction(() => {
      for (const id of uploadIds) this.db.prepare(`UPDATE uploads SET state = 'complete', messageId = NULL, claimedAt = NULL WHERE uploadId = ? AND state = 'claimed'`).run(id);
    })();
    this.activeClaims.delete(messageId);
  }

  /**
   * Recovery of claims (§4.3): only a claim whose request is not running here and is older than
   * five minutes. With its event stored it is `sent`; with no event it returns to `complete`.
   */
  recoverClaims(hasMessage: (messageId: string) => boolean): void {
    const rows = this.db.prepare(`SELECT uploadId, messageId, claimedAt FROM uploads WHERE state = 'claimed'`).all() as Array<{ uploadId: string; messageId: string; claimedAt: number }>;
    for (const r of rows) {
      if (this.activeClaims.has(r.messageId) || this.now() - r.claimedAt < CLAIM_RECOVERY_AGE_MS) continue;
      if (hasMessage(r.messageId)) this.markSent([r.uploadId], r.messageId);
      else this.releaseClaim([r.uploadId], r.messageId);
    }
  }

  // ── Agent reply files (§4.6) ─────────────────────────────────────────────────────

  /** A private staging path for a reply snapshot. */
  newSnapshotPath(): string { return path.join(this.uploadsDir, `reply-${crypto.randomUUID()}`); }

  publishSnapshot(snapshotPath: string, sha: string): void { this.publish(snapshotPath, sha); }

  discardSnapshot(snapshotPath: string): void {
    SafeFsExecutor.safeRmSync(snapshotPath, { force: true, operation: `${OP}:discard-snapshot` });
  }

  // ── Session copies (§4.5) ────────────────────────────────────────────────────────

  /** A session's private copy (0400, its own inode), created once; null when the blob is not here. */
  async sessionCopy(messageId: string, a: AppAttachment): Promise<string | null> {
    const blob = this.locateBlob(a.sha256);
    if (!blob) return null;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(messageId)) return null;
    const dir = path.join(this.sessionDir, messageId);
    const dest = path.join(dir, `${a.index}-${safeFileName(a.filename, a.mediaType)}`);
    if (fs.existsSync(dest)) return dest;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${dest}.${crypto.randomUUID()}.tmp`;
    await fs.promises.copyFile(blob, tmp, fs.constants.COPYFILE_FICLONE);
    await fs.promises.chmod(tmp, 0o400);
    fs.renameSync(tmp, dest);
    return dest;
  }

  private removeSessionCopies(messageId: string, index: number): void {
    const dir = path.join(this.sessionDir, messageId);
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const n of names) if (n.startsWith(`${index}-`)) SafeFsExecutor.safeRmSync(path.join(dir, n), { force: true, operation: `${OP}:purge-session-copy` });
    try { if (fs.readdirSync(dir).length === 0) SafeFsExecutor.safeRmdirSync(dir, { operation: `${OP}:empty-session-dir` }); } catch { /* @silent-fallback-ok — an empty directory left behind is harmless */ }
  }

  // ── Keeping the store true (§4.7, §4.8) ─────────────────────────────────────────

  /**
   * Bring blob locations in line with the references: live → blobs/, referenced only by deleted
   * conversations → deleted/, purged with nothing else referencing → removed, and session copies
   * of purged attachments removed. Safe to repeat; runs after a purge or tombstone and hourly.
   */
  applyReferences(): void {
    for (const r of this.opts.store.mediaPurgedRefs()) this.removeSessionCopies(r.messageId, r.idx);
    for (const dir of [this.blobsDir, this.deletedDir]) {
      for (const sha of this.listBlobs(dir)) {
        const refs = this.opts.store.mediaBlobRefs(sha);
        const at = path.join(dir, sha.slice(0, 2), sha);
        if (refs && refs.liveRefs > 0) {
          if (dir === this.deletedDir) this.moveBlob(at, this.blobPath(sha));
        } else if (refs && refs.allRefs > 0) {
          if (dir === this.blobsDir) this.moveBlob(at, this.deletedPath(sha));
        } else if (refs) {
          // Every reference was purged: the operator removed these bytes.
          SafeFsExecutor.safeRmSync(at, { force: true, operation: `${OP}:purge` });
          this.db.prepare('DELETE FROM blob_checks WHERE sha256 = ?').run(sha);
        }
      }
    }
  }

  private listBlobs(dir: string): string[] {
    const out: string[] = [];
    let prefixes: string[] = [];
    try { prefixes = fs.readdirSync(dir).filter((n) => /^[0-9a-f]{2}$/.test(n)); } catch { return out; }
    for (const p of prefixes) {
      try { for (const n of fs.readdirSync(path.join(dir, p))) if (isSha256Hex(n)) out.push(n); } catch { /* @silent-fallback-ok — a vanished prefix holds nothing */ }
    }
    return out;
  }

  /** Crash recovery of uploads at boot and in the sweep (§4.2 step 5). */
  async recoverUploads(): Promise<void> {
    // A chunk row whose file is missing or the wrong length is dropped (the app resends it).
    const open = this.db.prepare(`SELECT uploadId, state FROM uploads WHERE state IN ('open','assembling')`).all() as Array<{ uploadId: string; state: UploadState }>;
    for (const u of open) {
      const dir = this.uploadDir(u.uploadId);
      const rows = this.db.prepare('SELECT idx, length FROM chunks WHERE uploadId = ?').all(u.uploadId) as Array<{ idx: number; length: number }>;
      const assembled = fs.existsSync(this.assembledPath(u.uploadId));
      let lost = false;
      for (const c of rows) {
        const p = path.join(dir, String(c.idx));
        let size = -1;
        try { size = fs.statSync(p).size; } catch { size = -1; } // @silent-fallback-ok — a missing chunk file is the case handled here
        if (size !== c.length) {
          this.db.prepare('DELETE FROM chunks WHERE uploadId = ? AND idx = ?').run(u.uploadId, c.idx);
          lost = true;
        }
      }
      // A chunk file with no row is removed.
      const known = new Set((this.db.prepare('SELECT idx FROM chunks WHERE uploadId = ?').all(u.uploadId) as Array<{ idx: number }>).map((r) => String(r.idx)));
      try {
        for (const n of fs.readdirSync(dir)) if (/^\d+$/.test(n) && !known.has(n)) SafeFsExecutor.safeRmSync(path.join(dir, n), { force: true, operation: `${OP}:unrecorded-chunk` });
      } catch { /* @silent-fallback-ok — no directory means no stray chunks */ }
      if (u.state === 'assembling') {
        if (lost && !assembled) this.db.prepare(`UPDATE uploads SET state = 'open' WHERE uploadId = ?`).run(u.uploadId);
        else await this.finalizeUpload(u.uploadId);
      }
    }
    // A complete upload whose chunk files remain has them removed.
    for (const r of this.db.prepare(`SELECT uploadId FROM uploads WHERE state = 'complete'`).all() as Array<{ uploadId: string }>) this.removeChunks(r.uploadId);
  }

  /** Expire unclaimed uploads past their deadline and forget long-expired rows (§4.2 step 6). */
  expireUploads(): number {
    const t = this.now();
    const rows = this.db.prepare(`SELECT uploadId FROM uploads WHERE state IN ('open','assembling','complete') AND expiresAt <= ?`).all(t) as Array<{ uploadId: string }>;
    for (const r of rows) {
      // A blob already published for this upload stays; the orphan rule owns it.
      this.discardUpload(r.uploadId, 'expired');
    }
    this.db.prepare(`DELETE FROM uploads WHERE state IN ('expired','sent') AND expiresAt <= ?`).run(t - EXPIRED_ROW_KEEP_MS);
    // A reply snapshot left by a crash mid-reply: nothing names it, and it never became a blob.
    try {
      for (const n of fs.readdirSync(this.uploadsDir)) {
        if (!n.startsWith('reply-')) continue;
        const p = path.join(this.uploadsDir, n);
        if (t - fs.statSync(p).mtimeMs >= UPLOAD_TTL_MS) SafeFsExecutor.safeRmSync(p, { force: true, operation: `${OP}:stale-snapshot` });
      }
    } catch { /* @silent-fallback-ok — re-tried at the next sweep */ }
    return rows.length;
  }

  /** A blob no event references and no upload names, 7 days after it was first counted (§4.7). */
  private reclaimOrphans(): number {
    const seen = new Set<string>();
    const t = this.now();
    let count = 0;
    for (const dir of [this.blobsDir, this.deletedDir]) {
      for (const sha of this.listBlobs(dir)) {
        if (this.opts.store.mediaBlobRefs(sha)) continue;
        if (this.db.prepare(`SELECT 1 FROM uploads WHERE sha256 = ? AND state IN ('open','assembling','complete','claimed') LIMIT 1`).get(sha)) continue;
        seen.add(sha);
        this.db.prepare('INSERT OR IGNORE INTO orphans (sha256, firstSeenAt) VALUES (?, ?)').run(sha, t);
        const row = this.db.prepare('SELECT firstSeenAt FROM orphans WHERE sha256 = ?').get(sha) as { firstSeenAt: number };
        if (t - row.firstSeenAt >= ORPHAN_GRACE_MS) {
          SafeFsExecutor.safeRmSync(path.join(dir, sha.slice(0, 2), sha), { force: true, operation: `${OP}:orphan` });
          this.db.prepare('DELETE FROM orphans WHERE sha256 = ?').run(sha);
          this.db.prepare('DELETE FROM blob_checks WHERE sha256 = ?').run(sha);
        } else count++;
      }
    }
    for (const r of this.db.prepare('SELECT sha256 FROM orphans').all() as Array<{ sha256: string }>) {
      if (!seen.has(r.sha256)) this.db.prepare('DELETE FROM orphans WHERE sha256 = ?').run(r.sha256);
    }
    return count;
  }

  /**
   * Integrity (§4.8): hourly any blob whose mtime or size changed, weekly all. A blob whose bytes
   * no longer match its name is moved to quarantine/ (never deleted) and reported.
   */
  private async checkIntegrity(): Promise<void> {
    const t = this.now();
    const last = Number((this.db.prepare(`SELECT v FROM meta WHERE k = 'lastFullCheck'`).get() as { v: string } | undefined)?.v ?? 0);
    const full = t - last >= FULL_CHECK_MS;
    for (const dir of [this.blobsDir, this.deletedDir]) {
      for (const sha of this.listBlobs(dir)) {
        const p = path.join(dir, sha.slice(0, 2), sha);
        let st: fs.Stats;
        try { st = fs.statSync(p); } catch { continue; } // @silent-fallback-ok — it was moved or removed since the listing
        const check = this.db.prepare('SELECT mtimeMs, size FROM blob_checks WHERE sha256 = ?').get(sha) as { mtimeMs: number; size: number } | undefined;
        if (!full && check && check.mtimeMs === st.mtimeMs && check.size === st.size) continue;
        const h = await hashFile(p);
        if (h.sha256 === sha) { this.recordCheck(sha); continue; }
        const q = path.join(this.quarantineDir, sha);
        try { fs.renameSync(p, q); } catch (err) { this.report(`a damaged file could not be set aside: ${err instanceof Error ? err.message : String(err)}`); continue; }
        this.db.prepare('DELETE FROM blob_checks WHERE sha256 = ?').run(sha);
        this.report(`a stored file no longer matches its hash and was quarantined (${sha.slice(0, 12)}…)`);
      }
    }
    if (full) this.db.prepare(`INSERT OR REPLACE INTO meta (k, v) VALUES ('lastFullCheck', ?)`).run(String(t));
  }

  private removeOldSessionCopies(): void {
    const t = this.now();
    let dirs: string[] = [];
    try { dirs = fs.readdirSync(this.sessionDir); } catch { return; }
    for (const d of dirs) {
      const dir = path.join(this.sessionDir, d);
      try {
        for (const n of fs.readdirSync(dir)) {
          const p = path.join(dir, n);
          if (t - fs.statSync(p).mtimeMs >= SESSION_COPY_TTL_MS) SafeFsExecutor.safeRmSync(p, { force: true, operation: `${OP}:old-session-copy` });
        }
        if (fs.readdirSync(dir).length === 0) SafeFsExecutor.safeRmdirSync(dir, { operation: `${OP}:empty-session-dir` });
      } catch { /* @silent-fallback-ok — re-tried at the next sweep */ }
    }
  }

  private countMissing(): number {
    let missing = 0;
    for (const r of this.opts.store.mediaReferencedHashes()) if (!this.locateBlob(r.sha256)) missing++;
    return missing;
  }

  /** The hourly sweep. Every step runs even when an earlier one fails. */
  async sweep(hasMessage: (messageId: string) => boolean): Promise<void> {
    if (this.sweepRunning) return;
    this.sweepRunning = true;
    const step = async (name: string, fn: () => void | Promise<void>) => {
      try { await fn(); } catch (err) { this.report(`${name}: ${err instanceof Error ? err.message : String(err)}`); }
    };
    let orphanBlobs = 0;
    try {
      await step('upload recovery', () => this.recoverUploads());
      await step('claim recovery', () => this.recoverClaims(hasMessage));
      await step('upload expiry', () => { this.expireUploads(); });
      await step('references', () => this.applyReferences());
      await step('orphans', () => { orphanBlobs = this.reclaimOrphans(); });
      await step('integrity', () => this.checkIntegrity());
      await step('session copies', () => this.removeOldSessionCopies());
      await step('inventory', () => { this.lastInventory = { orphanBlobs, missingBlobs: this.countMissing(), at: this.now() }; });
    } finally { this.sweepRunning = false; }
  }

  // ── Health (§4.7) ────────────────────────────────────────────────────────────────

  usageOverCapFraction(fraction: number): boolean {
    return this.opts.store.mediaLiveBytes() + this.reservedBytes() >= fraction * this.opts.maxStoreBytes();
  }

  liveBytes(): number { return this.opts.store.mediaLiveBytes(); }
  maxBytes(): number { return this.opts.maxStoreBytes(); }

  health(): Record<string, unknown> {
    const open = this.db.prepare(`SELECT COUNT(*) AS n FROM uploads WHERE state IN ('open','assembling','complete','claimed')`).get() as { n: number };
    let deletedBytes = 0;
    for (const sha of this.listBlobs(this.deletedDir)) {
      try { deletedBytes += fs.statSync(this.deletedPath(sha)).size; } catch { /* @silent-fallback-ok — observability only */ }
    }
    return {
      liveBytes: this.opts.store.mediaLiveBytes(), deletedBytes, stagedBytes: this.stagedBytes(), reservedBytes: this.reservedBytes(),
      blobs: this.listBlobs(this.blobsDir).length + this.listBlobs(this.deletedDir).length,
      orphanBlobs: this.lastInventory?.orphanBlobs ?? null, missingBlobs: this.lastInventory?.missingBlobs ?? null,
      // Peer pulls and inventories are the next increment: these cannot be measured yet.
      unrecoverableBlobs: null, singleCopyBlobs: null,
      inventoryAsOf: this.lastInventory ? new Date(this.lastInventory.at).toISOString() : null, openUploads: open.n,
    };
  }
}

class ClaimLost extends Error {}

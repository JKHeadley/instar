/** Durable raw-upload staging, not copy authority or an HTTP authenticator.
 * The operation service must provide current authenticated native-owner scope;
 * channel/body admission and fresh preview/apply remain independent gates.
 */
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { registerSqliteHandle } from '../core/SqliteRegistry.js';
import { CHUNK_BYTES } from '../core/appMediaTypes.js';
import { UPLOAD_TTL_MS } from '../core/AppMediaStore.js';
import { acquireLocalHistoryChild, type LocalHistoryChildAdmission } from './LocalHistoryChildCustody.js';
import { LocalHistoryDiskLedger, type LocalHistoryDiskMeasurement } from './LocalHistoryDiskLedger.js';
import { localHistoryUploadDirectory } from './LocalHistoryExchange.js';
import { parseLocalHistoryManifest, type LocalHistoryManifest } from './LocalHistoryManifest.js';
import { LOCAL_HISTORY_PLAINTEXT_BYTES } from './LocalHistoryChannel.js';
import { MAX_LOCAL_SESSION_BYTES } from './localSessionSnapshot.js';
import { privateImportDatabasePath } from './privateImportState.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';
import type { LocalHistoryAuthenticatedDevice, LocalHistoryChannelIssuer, LocalHistoryChannelPrincipal } from './LocalHistoryChannelRegistry.js';

export interface LocalHistoryStagingIssuer extends LocalHistoryChannelIssuer { origin: string }
export interface LocalHistoryUploadStagingDeps {
  stateDir: string;
  principal(device: Readonly<LocalHistoryAuthenticatedDevice>): LocalHistoryChannelPrincipal | null;
  issuer(): LocalHistoryStagingIssuer;
  now?: () => number;
  uploadTtlMs?: number;
  disk?: () => LocalHistoryDiskMeasurement;
}
type Phase = 'uploading' | 'verifying' | 'verified' | 'cancelled' | 'expired' | 'interrupted' | 'conflicted';
interface Row {
  id: string; requestKey: string; ownerHash: string; deviceHash: string; issuerHash: string;
  boot: string; fingerprint: string; tag: string; plan: string; planHash: string; created: number; deadline: number; phase: Phase;
}
interface Plan { manifest: LocalHistoryManifest; files: Array<{ fileId: string; allocation: string }> }
export interface LocalHistoryUploadStatus {
  operationId: string; uploadId: string; phase: Phase; expiresAt: number;
  files: Array<{ fileId: string; plaintextOffset: number; nextExpectedChunk: number }>;
}
export class LocalHistoryUploadStagingRefused extends Error {
  constructor(readonly reason: 'unavailable' | 'invalid' | 'not-found' | 'busy' | 'capacity' | 'expired' | 'conflict') {
    super('local-history-upload-' + reason);
  }
}
function refuse(reason: LocalHistoryUploadStagingRefused['reason']): never { throw new LocalHistoryUploadStagingRefused(reason); }
const digest = (value: unknown) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const live = (phase: Phase) => ['uploading', 'verifying', 'verified'].includes(phase);
const opaque = (value: unknown) => typeof value === 'string' && /^[\x21-\x7e]{1,256}$/.test(value);
const id = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const MAX_ROWS = 1024;
const PLAN_BYTES = 2 * CHUNK_BYTES;
const METADATA_RESERVE = 64 * 1024;
const CHALLENGE_MS = 60_000;

export class LocalHistoryUploadStaging {
  private readonly custody: LocalHistoryChildAdmission;
  private readonly ledger: LocalHistoryDiskLedger;
  private readonly db: Database.Database;
  private readonly unregister: () => void;
  private readonly issuer: Readonly<LocalHistoryStagingIssuer>;
  private readonly issuerHash: string;
  private readonly ttl: number;
  private readonly now: () => number;
  private metadata: string | undefined;
  private readonly invalidated = new Map<string, Phase>();
  private readonly expiryTicks = new Map<string, number>();
  private readonly challengeTicks = new Map<string, number>();
  private readonly reportedCleanup = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly cleanups = new Map<string, ReturnType<typeof setTimeout>[]>();
  private verification: { id: string; done: Promise<void> } | undefined;
  private stopped = false;
  private stopping: Promise<void> | undefined;

  constructor(private readonly deps: LocalHistoryUploadStagingDeps) {
    if (![deps?.principal, deps?.issuer].every(value => typeof value === 'function')) refuse('invalid');
    this.now = deps.now ?? Date.now;
    this.ttl = deps.uploadTtlMs ?? UPLOAD_TTL_MS;
    if (typeof this.now !== 'function' || !Number.isSafeInteger(this.ttl) || this.ttl <= 0) refuse('invalid');
    this.issuer = Object.freeze(this.readIssuer());
    this.issuerHash = this.hashIssuer(this.issuer);
    const custody = acquireLocalHistoryChild(deps.stateDir);
    if (!custody) refuse('busy');
    this.custody = custody;
    let ledger: LocalHistoryDiskLedger | undefined, db: Database.Database | undefined;
    let unregister: (() => void) | undefined, metadata: string | undefined;
    try {
      ledger = new LocalHistoryDiskLedger(deps.stateDir, { disk: deps.disk });
      const directory = localHistoryUploadDirectory(deps.stateDir);
      db = new Database(privateImportDatabasePath(directory, 'jobs.sqlite'), { timeout: 0 }); /* state-registry: local-history-upload-local */
      db.pragma('journal_mode = DELETE'); db.pragma('synchronous = FULL');
      db.exec(`CREATE TABLE IF NOT EXISTS upload_operations (
        id TEXT PRIMARY KEY, requestKey TEXT UNIQUE NOT NULL, ownerHash TEXT NOT NULL, deviceHash TEXT NOT NULL,
        issuerHash TEXT NOT NULL, boot TEXT NOT NULL, fingerprint TEXT NOT NULL, tag TEXT NOT NULL, plan TEXT NOT NULL, planHash TEXT NOT NULL,
        created INTEGER NOT NULL, deadline INTEGER NOT NULL, phase TEXT NOT NULL
      ); CREATE TABLE IF NOT EXISTS upload_challenges (
        hash TEXT PRIMARY KEY, ownerHash TEXT NOT NULL, boot TEXT NOT NULL,
        created INTEGER NOT NULL, deadline INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0
      )`);
      this.ledger = ledger; this.db = db;
      this.unregister = unregister = registerSqliteHandle(() => this.db.close());
      this.recover();
      metadata = ledger.create('r-' + custody.custody.generation + '-' + crypto.randomBytes(16).toString('hex'), METADATA_RESERVE);
      this.metadata = metadata;
      for (const [operation, phase] of this.invalidated) {
        this.metadataRoom(); this.db.prepare('UPDATE upload_operations SET phase = ? WHERE id = ?').run(phase, operation);
      }
    } catch {
      this.stopped = true;
      for (const timer of this.timers.values()) clearTimeout(timer);
      for (const timers of this.cleanups.values()) for (const timer of timers) clearTimeout(timer);
      unregister?.();
      if (ledger && metadata) { try { ledger.dispose(metadata); } catch { /* retained generation-tagged charge */ } }
      if (db?.open) db.close(); ledger?.close(); custody.release();
      refuse('unavailable');
    }
  }
  private clock(): number {
    let now: number;
    try { now = this.now(); } catch { return refuse('unavailable'); }
    if (!Number.isSafeInteger(now) || now < 0) refuse('unavailable');
    return now;
  }
  private readIssuer(): LocalHistoryStagingIssuer {
    try {
      const value = this.deps.issuer();
      const url = new URL(value.origin);
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value.origin
        || ![value.agentId, value.machineId, value.bootId].every(opaque) || !/^[a-f0-9]{64}$/.test(value.signingKeyHash)) refuse('unavailable');
      return { agentId: value.agentId, machineId: value.machineId, bootId: value.bootId, signingKeyHash: value.signingKeyHash, origin: value.origin };
    } catch { return refuse('unavailable'); }
  }
  private hashIssuer(issuer: LocalHistoryStagingIssuer): string {
    return digest(['local-history-issuer-v1', issuer.agentId, issuer.machineId, issuer.origin, issuer.signingKeyHash]);
  }
  private owner(device: LocalHistoryAuthenticatedDevice): { ownerHash: string; deviceHash: string } {
    if (this.stopped) refuse('unavailable');
    try {
      const issuer = this.readIssuer();
      if (this.hashIssuer(issuer) !== this.issuerHash || issuer.bootId !== this.issuer.bootId) refuse('unavailable');
      const principal = this.deps.principal(Object.freeze({ deviceId: device.deviceId, deviceKeyHash: device.deviceKeyHash }));
      if (!principal || principal.deviceId !== device.deviceId || principal.deviceKeyHash !== device.deviceKeyHash
        || !opaque(device.deviceId) || !opaque(device.deviceKeyHash) || typeof principal.ownerUserId !== 'string'
        || !principal.ownerUserId.trim() || principal.ownerUserId.includes('\0') || Buffer.byteLength(principal.ownerUserId) > 256) refuse('unavailable');
      return { ownerHash: digest(['local-history-owner-v1', principal.ownerUserId, principal.deviceId, principal.deviceKeyHash]),
        deviceHash: digest(['local-history-device-v1', principal.deviceId]) };
    } catch { return refuse('unavailable'); }
  }
  private transaction<T>(work: () => T): T {
    try {
      this.db.exec('BEGIN IMMEDIATE');
      try { const result = work(); this.db.exec('COMMIT'); return result; }
      catch (error) { if (this.db.inTransaction) this.db.exec('ROLLBACK'); throw error; }
    } catch (error) {
      if (error instanceof LocalHistoryUploadStagingRefused) throw error;
      if (error instanceof Error && ['local-history-disk-capacity', 'local-history-disk-record-capacity'].includes(error.message)) refuse('capacity');
      if (error instanceof Error && error.message === 'local-history-disk-busy') refuse('busy');
      if (['SQLITE_BUSY', 'SQLITE_LOCKED'].includes((error as {code?: string}).code ?? '')) refuse('busy');
      return refuse('unavailable');
    }
  }
  private row(operationId: string): Row {
    if (!id(operationId)) refuse('not-found');
    const row = this.db.prepare('SELECT * FROM upload_operations WHERE id = ?').get(operationId) as Row | undefined;
    if (!row) refuse('not-found');
    if (![row.requestKey, row.ownerHash, row.deviceHash, row.issuerHash, row.fingerprint, row.planHash].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))
      || !opaque(row.boot) || !id(row.plan) || typeof row.tag !== 'string' || !/^r-[a-f0-9]{64}-[a-f0-9]{32}$/.test(row.tag) || !row.tag.endsWith('-' + row.id)
      || !Number.isSafeInteger(row.created) || row.created < 0 || !Number.isSafeInteger(row.deadline) || row.deadline <= row.created
      || !['uploading', 'verifying', 'verified', 'cancelled', 'expired', 'interrupted', 'conflicted'].includes(row.phase)) refuse('unavailable');
    return { ...row, phase: this.invalidated.get(row.id) ?? row.phase };
  }
  private owned(operationId: string, device: LocalHistoryAuthenticatedDevice): Row {
    const owner = this.owner(device);
    if (!id(operationId)) refuse('not-found');
    const binding = this.db.prepare('SELECT ownerHash,issuerHash FROM upload_operations WHERE id = ?').get(operationId) as {ownerHash: unknown; issuerHash: unknown} | undefined;
    if (!binding || binding.ownerHash !== owner.ownerHash || binding.issuerHash !== this.issuerHash) refuse('not-found');
    const row = this.row(operationId);
    if (live(row.phase) && (this.clock() < row.created || this.clock() >= row.deadline || row.boot !== this.issuer.bootId
      || (this.expiryTicks.has(row.id) && performance.now() >= this.expiryTicks.get(row.id)!))) {
      this.invalidate(row, row.boot !== this.issuer.bootId ? 'interrupted' : 'expired');
      return this.row(operationId);
    }
    return row;
  }
  private capacity(): void {
    const row = this.db.prepare('SELECT (SELECT COUNT(*) FROM upload_operations) + (SELECT COUNT(*) FROM upload_challenges) AS n').get() as {n: number};
    if (!Number.isSafeInteger(row.n) || row.n >= MAX_ROWS) refuse('capacity');
  }
  private metadataRoom(): void {
    // Keep a conservative unwritten work reserve for bounded SQLite page and
    // journal growth; the physical database itself is measured in free space.
    if (!this.metadata) refuse('capacity');
    try { this.ledger.grow(this.metadata, 0); }
    catch { refuse('capacity'); }
  }
  challenge(device: LocalHistoryAuthenticatedDevice): { challenge: string; expiresAt: number } {
    const owner = this.owner(device), now = this.clock(), challenge = crypto.randomBytes(32).toString('base64');
    const expiresTick = performance.now() + CHALLENGE_MS;
    if (!Number.isSafeInteger(now + CHALLENGE_MS)) refuse('unavailable');
    this.transaction(() => {
      this.metadataRoom();
      this.capacity();
      this.db.prepare('INSERT INTO upload_challenges(hash,ownerHash,boot,created,deadline) VALUES(?,?,?,?,?)')
        .run(digest(challenge), owner.ownerHash, this.issuer.bootId, now, now + CHALLENGE_MS);
    });
    this.challengeTicks.set(digest(challenge), expiresTick);
    return { challenge, expiresAt: now + CHALLENGE_MS };
  }
  admit(device: LocalHistoryAuthenticatedDevice, value: unknown): LocalHistoryUploadStatus {
    const owner = this.owner(device), now = this.clock(), started = performance.now();
    let parsed: ReturnType<typeof parseLocalHistoryManifest>;
    try { parsed = parseLocalHistoryManifest(value, { machineId: this.issuer.machineId, bootId: this.issuer.bootId, maxFileBytes: MAX_LOCAL_SESSION_BYTES }); }
    catch { return refuse('invalid'); }
    const { manifest, fingerprint } = parsed;
    if (Buffer.byteLength(JSON.stringify(manifest)) > CHUNK_BYTES) refuse('capacity');
    const requestKey = digest(['local-history-request-v1', this.issuerHash, this.issuer.bootId, owner.ownerHash, manifest.selectionRequestId]);
    const existing = this.db.prepare('SELECT id FROM upload_operations WHERE requestKey = ?').get(requestKey) as {id: string} | undefined;
    if (existing) {
      const row = this.owned(existing.id, device);
      if (row.fingerprint !== fingerprint || !live(row.phase)) refuse('conflict');
      return this.status(device, row.id);
    }
    if (!Number.isSafeInteger(now + this.ttl)) refuse('unavailable');
    const operationId = crypto.randomBytes(16).toString('hex');
    const tag = 'r-' + this.custody.custody.generation + '-' + operationId;
    const allocations: string[] = [];
    try {
      this.transaction(() => {
        this.metadataRoom(); this.capacity();
        const challenge = this.db.prepare('SELECT ownerHash,boot,created,deadline,consumed FROM upload_challenges WHERE hash = ?').get(digest(manifest.selectionChallenge)) as {ownerHash: string; boot: string; created: number; deadline: number; consumed: number} | undefined;
        if (!challenge || challenge.ownerHash !== owner.ownerHash || challenge.boot !== this.issuer.bootId || challenge.consumed !== 0
          || !Number.isSafeInteger(challenge.created) || !Number.isSafeInteger(challenge.deadline) || now < challenge.created || now >= challenge.deadline
          || performance.now() >= (this.challengeTicks.get(digest(manifest.selectionChallenge)) ?? 0)) refuse('expired');
        allocations.push(this.ledger.create(tag, METADATA_RESERVE));
        const files = manifest.files.map(file => {
          const allocation = this.ledger.create(tag, file.bytes); allocations.push(allocation);
          return { fileId: file.fileId, allocation };
        });
        const bytes = Buffer.from(JSON.stringify({ manifest, files } satisfies Plan));
        let plan: string, planHash: string;
        try {
          if (bytes.length > PLAN_BYTES) refuse('capacity');
          planHash = crypto.createHash('sha256').update(bytes).digest('hex');
          plan = this.ledger.create(tag, bytes.length); allocations.push(plan);
          for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) this.ledger.write(plan, bytes.subarray(offset, offset + CHUNK_BYTES));
        } finally { bytes.fill(0); }
        if (this.owner(device).ownerHash !== owner.ownerHash) refuse('unavailable');
        const publishedAt = this.clock();
        if (publishedAt < now || publishedAt >= challenge.deadline || publishedAt >= now + this.ttl || performance.now() >= started + this.ttl
          || performance.now() >= (this.challengeTicks.get(digest(manifest.selectionChallenge)) ?? 0)) refuse('expired');
        this.metadataRoom();
        this.db.prepare('INSERT INTO upload_operations(id,requestKey,ownerHash,deviceHash,issuerHash,boot,fingerprint,tag,plan,planHash,created,deadline,phase) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(operationId, requestKey, owner.ownerHash, owner.deviceHash, this.issuerHash, this.issuer.bootId, fingerprint, tag, plan, planHash, now, now + this.ttl, 'uploading');
        this.db.prepare('UPDATE upload_challenges SET consumed = 1 WHERE hash = ?').run(digest(manifest.selectionChallenge));
      });
    } catch (error) {
      // create() can commit its reservation then fail without returning an id.
      // This known fresh tag covers those rows too; no child has started.
      if (!this.disposeTag(tag) && !this.cleanups.has(tag)) this.scheduleCleanup(tag);
      if (error instanceof LocalHistoryUploadStagingRefused) throw error;
      if (error instanceof Error && error.message.includes('disk-capacity')) refuse('capacity');
      return refuse('unavailable');
    }
    this.expiryTicks.set(operationId, started + this.ttl);
    this.arm(operationId);
    return this.status(device, operationId);
  }
  private plan(row: Row): Plan {
    const allocation = this.ledger.inspect(row.plan);
    if (allocation.operation !== row.tag || allocation.state !== 'active' || allocation.written !== allocation.planned || allocation.written > PLAN_BYTES) refuse('unavailable');
    const parts: Buffer[] = [];
    let bytes: Buffer | undefined;
    try {
      for (let offset = 0; offset < allocation.written; offset += CHUNK_BYTES) parts.push(this.ledger.read(row.plan, offset, Math.min(CHUNK_BYTES, allocation.written - offset)));
      bytes = Buffer.concat(parts);
      if (crypto.createHash('sha256').update(bytes).digest('hex') !== row.planHash) refuse('unavailable');
      const plan = JSON.parse(bytes.toString('utf8')) as Plan;
      const parsed = parseLocalHistoryManifest(plan.manifest, { machineId: this.issuer.machineId, bootId: row.boot, maxFileBytes: MAX_LOCAL_SESSION_BYTES });
      if (parsed.fingerprint !== row.fingerprint || !Array.isArray(plan.files) || plan.files.length !== parsed.manifest.files.length) refuse('unavailable');
      const seen = new Set<string>();
      for (const [index, file] of plan.files.entries()) {
        if (file.fileId !== parsed.manifest.files[index].fileId || !id(file.allocation) || seen.has(file.allocation)) refuse('unavailable');
        seen.add(file.allocation);
        const allocation = this.ledger.inspect(file.allocation);
        if (allocation.operation !== row.tag || !['active', 'sealed'].includes(allocation.state)
          || (row.phase === 'verified' && allocation.state !== 'sealed') || allocation.planned !== parsed.manifest.files[index].bytes) refuse('unavailable');
      }
      return { manifest: parsed.manifest, files: plan.files };
    } catch { return refuse('unavailable'); }
    finally { bytes?.fill(0); for (const part of parts) part.fill(0); }
  }
  status(device: LocalHistoryAuthenticatedDevice, operationId: string): LocalHistoryUploadStatus {
    const row = this.owned(operationId, device);
    const files = live(row.phase) ? this.plan(row).files.map(file => {
      const allocation = this.ledger.inspect(file.allocation);
      return { fileId: file.fileId, plaintextOffset: allocation.written, nextExpectedChunk: Math.ceil(allocation.written / LOCAL_HISTORY_PLAINTEXT_BYTES) };
    }) : [];
    return { operationId: row.id, uploadId: row.id, phase: row.phase, expiresAt: row.deadline, files };
  }
  write(device: LocalHistoryAuthenticatedDevice, operationId: string, fileId: string, index: number, bytes: Buffer): LocalHistoryUploadStatus {
    const row = this.owned(operationId, device);
    if (row.phase !== 'uploading') refuse('conflict');
    const plan = this.plan(row), selected = plan.files.findIndex(file => file.fileId === fileId);
    if (selected < 0) refuse('not-found');
    const file = plan.files[selected], expected = plan.manifest.files[selected];
    const allocation = this.ledger.inspect(file.allocation);
    const offset = index * LOCAL_HISTORY_PLAINTEXT_BYTES;
    const length = Math.min(LOCAL_HISTORY_PLAINTEXT_BYTES, expected.bytes - offset);
    let matches = Number.isSafeInteger(index) && index >= 0 && Number.isSafeInteger(offset) && length > 0
      && Buffer.isBuffer(bytes) && bytes.length === length && offset <= allocation.written;
    if (matches && offset < allocation.written) {
      let prior: Buffer | undefined;
      try {
        prior = this.ledger.read(file.allocation, offset, length);
        matches = prior.length === length && crypto.createHash('sha256').update(prior).digest().equals(crypto.createHash('sha256').update(bytes).digest());
      } finally { prior?.fill(0); }
    } else if (matches) {
      try { this.ledger.write(file.allocation, bytes); }
      catch { this.invalidate(row, 'interrupted'); refuse('unavailable'); }
    }
    if (!matches) { this.invalidate(row, 'conflicted'); refuse('conflict'); }
    return this.status(device, operationId);
  }
  complete(device: LocalHistoryAuthenticatedDevice, operationId: string): LocalHistoryUploadStatus {
    const row = this.owned(operationId, device);
    if (row.phase === 'verifying' || row.phase === 'verified') return this.status(device, operationId);
    if (row.phase !== 'uploading') refuse('conflict');
    if (this.verification) refuse('busy');
    const plan = this.plan(row);
    if (plan.files.some((file, index) => this.ledger.inspect(file.allocation).written !== plan.manifest.files[index].bytes)) refuse('invalid');
    this.transaction(() => {
      this.metadataRoom();
      if (this.owned(operationId, device).phase !== 'uploading') refuse('conflict');
      this.db.prepare("UPDATE upload_operations SET phase = 'verifying' WHERE id = ?").run(row.id);
    });
    const deviceCopy = Object.freeze({ deviceId: device.deviceId, deviceKeyHash: device.deviceKeyHash });
    const done = Promise.resolve().then(() => this.verify(deviceCopy, row.id)).catch(() => {
      try { const current = this.row(row.id); if (live(current.phase)) this.invalidate(current, 'interrupted'); }
      catch { this.invalidated.set(row.id, 'interrupted'); }
    }).finally(() => { if (this.verification?.done === done) this.verification = undefined; });
    this.verification = { id: row.id, done };
    return this.status(device, operationId);
  }
  private async verify(device: LocalHistoryAuthenticatedDevice, operationId: string): Promise<void> {
    const row = this.owned(operationId, device), plan = this.plan(row);
    for (const [index, file] of plan.files.entries()) {
      if (this.owned(operationId, device).phase !== 'verifying') refuse('conflict');
      this.ledger.seal(file.allocation);
      const hash = crypto.createHash('sha256'), expected = plan.manifest.files[index];
      for (let offset = 0; offset < expected.bytes; offset += CHUNK_BYTES) {
        if (this.owned(operationId, device).phase !== 'verifying') refuse('conflict');
        const bytes = this.ledger.read(file.allocation, offset, Math.min(CHUNK_BYTES, expected.bytes - offset));
        try { if (bytes.length !== Math.min(CHUNK_BYTES, expected.bytes - offset)) refuse('invalid'); hash.update(bytes); } finally { bytes.fill(0); }
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      if (hash.digest('hex') !== expected.sha256) { this.invalidate(row, 'conflicted'); refuse('conflict'); }
    }
    if (this.owned(operationId, device).phase !== 'verifying') refuse('conflict');
    this.transaction(() => {
      this.metadataRoom();
      if (this.owned(operationId, device).phase !== 'verifying') refuse('conflict');
      this.db.prepare("UPDATE upload_operations SET phase = 'verified' WHERE id = ?").run(row.id);
    });
  }
  cancel(device: LocalHistoryAuthenticatedDevice, operationId: string): LocalHistoryUploadStatus {
    const row = this.owned(operationId, device);
    if (live(row.phase)) this.invalidate(row, 'cancelled');
    return this.status(device, operationId);
  }
  private invalidate(row: Row, phase: Phase): void {
    this.invalidated.set(row.id, phase);
    this.expiryTicks.delete(row.id);
    const timer = this.timers.get(row.id); if (timer) clearTimeout(timer); this.timers.delete(row.id);
    if (!this.disposeTag(row.tag) && !this.cleanups.has(row.tag) && !this.stopped) this.scheduleCleanup(row.tag);
    try { this.metadataRoom(); this.db.prepare('UPDATE upload_operations SET phase = ? WHERE id = ?').run(phase, row.id); }
    catch { /* live memory denies authority; durable generation remains charged */ }
  }
  private disposeTag(tag: string): boolean {
    let disposed = true;
    let allocations: ReturnType<LocalHistoryDiskLedger['list']>;
    try { allocations = this.ledger.list(tag); } catch { return false; }
    for (const allocation of allocations) if (allocation.state !== 'disposed') {
      try { this.ledger.dispose(allocation.id); } catch { disposed = false; }
    }
    return disposed;
  }
  private scheduleCleanup(tag: string): void {
    const timers = [1000, 10_000, 60_000].map((delay, index) => {
      const timer = setTimeout(() => {
        if (this.stopped) return;
        if (this.disposeTag(tag)) {
          for (const other of this.cleanups.get(tag) ?? []) clearTimeout(other);
          this.cleanups.delete(tag);
          this.reportedCleanup.delete(tag);
        } else if (index === 2 && !this.reportedCleanup.has(tag)) {
          this.reportedCleanup.add(tag); this.report('cleanup', 'owned-temporary-cleanup-pending');
        }
      }, delay);
      timer.unref(); return timer;
    });
    this.cleanups.set(tag, timers);
  }
  private arm(operationId: string): void {
    const row = this.row(operationId), delay = Math.min(row.deadline - this.clock(), (this.expiryTicks.get(operationId) ?? performance.now()) - performance.now());
    const timer = setTimeout(() => {
      this.timers.delete(operationId);
      if (this.stopped) return;
      try {
        const current = this.row(operationId);
        if (live(current.phase)) {
          if (this.clock() < current.created || this.clock() >= current.deadline || performance.now() >= (this.expiryTicks.get(operationId) ?? 0)) this.invalidate(current, 'expired');
          else this.arm(operationId);
        }
      } catch { this.invalidate(row, 'interrupted'); }
    }, Math.max(0, Math.min(delay, 2_147_483_647)));
    timer.unref(); this.timers.set(operationId, timer);
  }
  private recover(): void {
    // Exclusive custody was acquired before a fresh generation was published.
    // Old parents and shared child holders are therefore gone; unknown tags do
    // not acquire deletion authority merely by lacking an operation row.
    const count = this.db.prepare('SELECT (SELECT COUNT(*) FROM upload_operations) + (SELECT COUNT(*) FROM upload_challenges) AS n').get() as {n: number};
    if (!Number.isSafeInteger(count.n) || count.n > MAX_ROWS) refuse('unavailable');
    const inventory = this.ledger.inventory();
    const old = new Set(inventory.map(row => row.operation).filter(tag => /^r-[a-f0-9]{64}-[a-f0-9]{32}$/.test(tag)
      && !tag.startsWith('r-' + this.custody.custody.generation + '-')));
    const operations = this.db.prepare('SELECT id FROM upload_operations LIMIT ?').all(MAX_ROWS) as {id: string}[];
    for (const operation of operations) this.row(operation.id);
    for (const tag of old) if (!this.disposeTag(tag)) this.scheduleCleanup(tag);
    for (const operation of operations) { const row = this.row(operation.id); if (live(row.phase)) this.invalidate(row, 'interrupted'); }
  }
  private report(feature: 'cleanup' | 'lifecycle', reason: string): void {
    try {
      DegradationReporter.getInstance().report({ feature: 'LocalHistoryUploadStaging.' + feature,
        primary: 'Dispose owned temporary conversation uploads', fallback: 'Keep unresolved allocations charged and unavailable',
        reason, impact: 'Temporary conversation upload cleanup needs attention.', internalOnly: true });
    } catch { /* reporting cannot clear charge or turn cleanup into a crash */ }
  }
  stop(): Promise<void> {
    return this.stopping ??= this.close();
  }
  private async close(): Promise<void> {
    this.stopped = true;
    const pending = [...this.cleanups.keys()];
    for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear();
    for (const timers of this.cleanups.values()) for (const timer of timers) clearTimeout(timer); this.cleanups.clear();
    try {
      for (const operation of this.db.prepare('SELECT id FROM upload_operations LIMIT ?').all(MAX_ROWS) as {id: string}[]) {
        try { const row = this.row(operation.id); if (live(row.phase)) this.invalidate(row, 'interrupted'); }
        catch { this.report('lifecycle', 'operation-metadata-unavailable'); }
      }
    } catch { this.report('lifecycle', 'operation-inventory-unavailable');
    } finally {
      try {
        await this.verification?.done;
        for (const tag of pending) this.disposeTag(tag);
      } finally {
        this.expiryTicks.clear(); this.challengeTicks.clear();
        try { this.unregister(); if (this.db.open) this.db.close(); }
        finally {
          try { if (this.metadata) { try { this.ledger.dispose(this.metadata); } catch { /* retained charge */ } } }
          finally { try { this.ledger.close(); } finally { this.custody.release(); } }
        }
      }
    }
  }
}

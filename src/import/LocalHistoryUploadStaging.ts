/** Durable raw-upload staging, not copy authority or an HTTP authenticator.
 * The operation service must provide current authenticated native-owner scope;
 * channel/body admission and fresh preview/apply remain independent gates.
 */
import crypto from 'node:crypto';
import { ChildProcess } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { registerSqliteHandle } from '../core/SqliteRegistry.js';
import { CHUNK_BYTES } from '../core/appMediaTypes.js';
import { CLAUDE_CODE_FRAMEWORK } from '../core/frameworkFacts.js';
import { UPLOAD_TTL_MS } from '../core/AppMediaStore.js';
import type { LocalHistoryChildAdmission } from './LocalHistoryChildCustody.js';
import { acquireLocalHistoryStoreTemporaryAdmission, hasUnsettledLocalHistoryTemporaryRun,
  initializeLocalHistoryStoreTemporaryRuns, localHistoryCopyDestinationDirectories, registerLocalHistoryStoreTemporaryRun, settleOldLocalHistoryTemporaryRuns, validateLocalHistoryFirstPermitRun, validateLocalHistoryTemporaryRunInventory } from './LocalHistoryStoreTemporaryRun.js';
import { LocalHistoryDiskLedger, type LocalHistoryDiskMeasurement } from './LocalHistoryDiskLedger.js';
import { initializeLocalHistoryFirstPermits, readLocalHistoryFirstPermitInventory, recordLocalHistoryFirstPermit,
  recordLocalHistoryFirstPermitObservation, type LocalHistoryFirstPermit } from './LocalHistoryFirstPermit.js';
import { assertLocalHistoryDisposablePilotState } from './LocalHistoryDisposablePilot.js';
import { localHistoryUploadDirectory } from './LocalHistoryExchange.js';
import { parseLocalHistoryManifest, type LocalHistoryManifest } from './LocalHistoryManifest.js';
import { LOCAL_HISTORY_PLAINTEXT_BYTES } from './LocalHistoryChannel.js';
import { MAX_LOCAL_SESSION_BYTES } from './localSessionSnapshot.js';
import { privateImportDatabasePath } from './privateImportState.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';
import { runLocalHistoryParseJob, type LocalHistoryParseReceipt } from './LocalHistoryParseJob.js';
import { estimateLocalHistoryPhysicalBytes, type LocalHistoryPhysicalPolicy } from './LocalHistoryPhysicalBudget.js';
import { LocalHistoryPreparedReadRefused, runLocalHistoryPreparedReadJob, type ObserveLocalHistoryFirstClaimPlan } from './LocalHistoryPreparedReadJob.js';
import { summarizeLocalHistoryPreviewProjects } from './LocalHistoryPreviewProjects.js';
import type { LocalHistoryPreparedPreview } from './LocalHistoryPreparedPreview.js';
import { localSessionOriginalId } from './localSessionParsers.js';
import type { LocalHistoryAuthenticatedDevice, LocalHistoryChannelIssuer, LocalHistoryChannelPrincipal } from './LocalHistoryChannelRegistry.js';

type CopyReservationPolicy = Readonly<{ bootstrapBytes: number; ceiling: number; firstClaimPolicy: LocalHistoryPhysicalPolicy }>;
type CopyReservationBinding = Readonly<{ allocationId: string; runId: string; reservedBytes: number }>;

export interface LocalHistoryStagingIssuer extends LocalHistoryChannelIssuer { origin: string }
export interface LocalHistoryUploadStagingDeps {
  stateDir: string;
  principal(device: Readonly<LocalHistoryAuthenticatedDevice>): LocalHistoryChannelPrincipal | null;
  issuer(): LocalHistoryStagingIssuer;
  now?: () => number;
  uploadTtlMs?: number;
  disk?: () => LocalHistoryDiskMeasurement;
  parserPolicy?: { heapMiB: number; deadlineMs: number; rssBytes: number };
}
type Phase = 'uploading' | 'verifying' | 'verified' | 'preparing' | 'prepared' | 'applying' | 'cancelled' | 'expired' | 'interrupted' | 'conflicted';
interface Row {
  id: string; requestKey: string; ownerHash: string; deviceHash: string; issuerHash: string;
  boot: string; fingerprint: string; tag: string; plan: string; planHash: string; created: number; deadline: number; phase: Phase;
}
interface Plan { manifest: LocalHistoryManifest; files: Array<{ fileId: string; allocation: string }> }
interface PreparedFile extends LocalHistoryParseReceipt { fileId: string; allocation: string }
interface PreparedPlan { version: 1; parserContractVersion: 1; operationId: string; fingerprint: string; files: PreparedFile[] }
type PreparedPreviewRead = Awaited<ReturnType<typeof runLocalHistoryPreparedReadJob>>;
interface PreviewReceipt {
  previewId: string;
  machineId: string;
  expiresAt: number;
  confirmation: { challenge: string; action: 'copy-selected-history' };
  preview: LocalHistoryPreparedPreview;
  readerRssProtection: PreparedPreviewRead['rssProtection'];
  projects: ReturnType<typeof summarizeLocalHistoryPreviewProjects>;
}
export interface LocalHistoryUploadStatus {
  operationId: string; uploadId: string; phase: Phase; expiresAt: number;
  files: Array<{ fileId: string; plaintextOffset: number; nextExpectedChunk: number }>;
  preparation?: Array<Omit<PreparedFile, 'allocation'>>;
}
export class LocalHistoryUploadStagingRefused extends Error {
  constructor(readonly reason: 'unavailable' | 'invalid' | 'not-found' | 'busy' | 'capacity' | 'expired' | 'conflict') {
    super('local-history-upload-' + reason);
  }
}
function refuse(reason: LocalHistoryUploadStagingRefused['reason']): never { throw new LocalHistoryUploadStagingRefused(reason); }
const digest = (value: unknown) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const live = (phase: Phase) => ['uploading', 'verifying', 'verified', 'preparing', 'prepared'].includes(phase);
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
  private readonly parserPolicy: Readonly<{ heapMiB: number; deadlineMs: number; rssBytes: number }>;
  private metadata: string | undefined;
  private readonly invalidated = new Map<string, Phase>();
  private readonly expiryTicks = new Map<string, number>();
  private readonly challengeTicks = new Map<string, number>();
  private readonly reportedCleanup = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly unsettledPermitTags = new Set<string>();
  private readonly unsettledCopyReservationTags = new Set<string>();
  private readonly cleanups = new Map<string, ReturnType<typeof setTimeout>[]>();
  private verification: { id: string; done: Promise<void> } | undefined;
  private activeChildWork: { id: string; tag: string; done: Promise<void>; stop?: () => void } | undefined;
  private stopped = false;
  private stopping: Promise<void> | undefined;

  constructor(private readonly deps: LocalHistoryUploadStagingDeps) {
    if (![deps?.principal, deps?.issuer].every(value => typeof value === 'function')) refuse('invalid');
    this.now = deps.now ?? Date.now;
    this.ttl = deps.uploadTtlMs ?? UPLOAD_TTL_MS;
    this.parserPolicy = Object.freeze({ ...(deps.parserPolicy ?? { heapMiB: 512, deadlineMs: 120_000, rssBytes: 768 * 1024 ** 2 }) });
    if (!['heapMiB', 'deadlineMs', 'rssBytes'].every(key => Number.isSafeInteger(this.parserPolicy[key as keyof typeof this.parserPolicy])
      && this.parserPolicy[key as keyof typeof this.parserPolicy] > 0)) refuse('invalid');
    if (typeof this.now !== 'function' || !Number.isSafeInteger(this.ttl) || this.ttl <= 0) refuse('invalid');
    this.issuer = Object.freeze(this.readIssuer());
    this.issuerHash = this.hashIssuer(this.issuer);
    const custody = acquireLocalHistoryStoreTemporaryAdmission(deps.stateDir);
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
      ); CREATE TABLE IF NOT EXISTS upload_preparations (
        id TEXT PRIMARY KEY, allocation TEXT NOT NULL, sha256 TEXT NOT NULL
      )`);
      this.ledger = ledger; this.db = db;
      this.unregister = unregister = registerSqliteHandle(() => this.db.close());
      this.recover();
      metadata = ledger.create('r-' + custody.custody.generation + '-' + crypto.randomBytes(16).toString('hex'), METADATA_RESERVE);
      this.metadata = metadata;
      this.metadataRoom();
      initializeLocalHistoryStoreTemporaryRuns(db);
      const recovery = settleOldLocalHistoryTemporaryRuns(db, custody, () => this.metadataRoom());
      for (const tag of recovery.settledTags) {
        if (this.unsettledPermitTags.has(tag)) continue;
        if (this.disposeTag(tag)) this.clearCleanup(tag);
        else if (!this.cleanups.has(tag)) this.scheduleCleanup(tag);
      }
      if (recovery.pending) this.report('cleanup', 'registered-namespace-cleanup-pending');
      db.exec(`CREATE TABLE IF NOT EXISTS upload_previews (
        id TEXT PRIMARY KEY, allocation TEXT NOT NULL, sha256 TEXT NOT NULL
      ) STRICT`);
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
  private registerChild(pid: number): Promise<void> {
    return this.custody.registerChild(pid);
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
  private owner(device: LocalHistoryAuthenticatedDevice): { ownerHash: string; deviceHash: string; ownerUserId: string } {
    if (this.stopped) refuse('unavailable');
    try {
      const issuer = this.readIssuer();
      if (this.hashIssuer(issuer) !== this.issuerHash || issuer.bootId !== this.issuer.bootId) refuse('unavailable');
      const principal = this.deps.principal(Object.freeze({ deviceId: device.deviceId, deviceKeyHash: device.deviceKeyHash }));
      if (!principal || principal.deviceId !== device.deviceId || principal.deviceKeyHash !== device.deviceKeyHash
        || !opaque(device.deviceId) || !opaque(device.deviceKeyHash) || typeof principal.ownerUserId !== 'string'
        || !principal.ownerUserId.trim() || principal.ownerUserId.includes('\0') || Buffer.byteLength(principal.ownerUserId) > 256) refuse('unavailable');
      return { ownerHash: digest(['local-history-owner-v1', principal.ownerUserId, principal.deviceId, principal.deviceKeyHash]),
        deviceHash: digest(['local-history-device-v1', principal.deviceId]), ownerUserId: principal.ownerUserId };
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
      || !['uploading', 'verifying', 'verified', 'preparing', 'prepared', 'applying', 'cancelled', 'expired', 'interrupted', 'conflicted'].includes(row.phase)) refuse('unavailable');
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
        if (row.phase === 'prepared') {
          if (allocation.operation !== row.tag || allocation.state !== 'disposed') refuse('unavailable');
          continue;
        }
        if (allocation.operation !== row.tag || !['active', 'sealed'].includes(allocation.state)
          || (row.phase === 'verified' && allocation.state !== 'sealed') || allocation.planned !== parsed.manifest.files[index].bytes) refuse('unavailable');
      }
      return { manifest: parsed.manifest, files: plan.files };
    } catch { return refuse('unavailable'); }
    finally { bytes?.fill(0); for (const part of parts) part.fill(0); }
  }
  status(device: LocalHistoryAuthenticatedDevice, operationId: string): LocalHistoryUploadStatus {
    const row = this.owned(operationId, device);
    const plan = live(row.phase) ? this.plan(row) : undefined;
    const files = plan ? plan.files.map((file, index) => {
      if (row.phase === 'prepared') {
        const expected = plan.manifest.files[index];
        return { fileId: file.fileId, plaintextOffset: expected.bytes, nextExpectedChunk: Math.ceil(expected.bytes / LOCAL_HISTORY_PLAINTEXT_BYTES) };
      }
      const allocation = this.ledger.inspect(file.allocation);
      return { fileId: file.fileId, plaintextOffset: allocation.written, nextExpectedChunk: Math.ceil(allocation.written / LOCAL_HISTORY_PLAINTEXT_BYTES) };
    }) : [];
    return { operationId: row.id, uploadId: row.id, phase: row.phase, expiresAt: row.deadline, files,
      ...(row.phase === 'prepared' ? { preparation: this.prepared(row).files.map(({ allocation: _allocation, ...receipt }) => receipt) } : {}) };
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
    if (['verifying', 'verified', 'preparing', 'prepared'].includes(row.phase)) return this.status(device, operationId);
    if (row.phase !== 'uploading') refuse('conflict');
    if (this.verification || this.activeChildWork) refuse('busy');
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
  /** Start real semantic parsing without holding an HTTP request open. A
   * prepared artifact is still not a preview confirmation or copy permit. */
  prepare(device: LocalHistoryAuthenticatedDevice, operationId: string): LocalHistoryUploadStatus {
    const row = this.owned(operationId, device);
    if (row.phase === 'preparing' || row.phase === 'prepared') return this.status(device, operationId);
    if (row.phase !== 'verified') refuse('conflict');
    if (this.verification || this.activeChildWork) refuse('busy');
    const plan = this.plan(row), ownerUserId = this.owner(device).ownerUserId;
    const destinations = new Set(plan.manifest.files.map(file => JSON.stringify([file.source, localSessionOriginalId(file.expectedSessionId)])));
    if (destinations.size !== plan.files.length) refuse('conflict');
    const deviceCopy = Object.freeze({ deviceId: device.deviceId, deviceKeyHash: device.deviceKeyHash });
    this.transaction(() => {
      this.metadataRoom();
      if (this.owned(operationId, deviceCopy).phase !== 'verified') refuse('conflict');
      this.db.prepare("UPDATE upload_operations SET phase = 'preparing' WHERE id = ?").run(row.id);
    });
    const done = Promise.resolve().then(() => this.parse(deviceCopy, row, plan, ownerUserId)).catch(() => {
      try { const current = this.row(row.id); if (live(current.phase)) this.invalidate(current, 'interrupted'); }
      catch { this.invalidated.set(row.id, 'interrupted'); }
    }).finally(() => {
      if (this.activeChildWork?.done === done) this.activeChildWork = undefined;
      // runLocalHistoryParseJob resolves only after the actual child exited.
      // Cancellation cannot retire its files while that promise is outstanding.
      try { const current = this.row(row.id); if (!live(current.phase)) this.invalidate(current, current.phase); }
      catch { if (!this.disposeTag(row.tag) && !this.cleanups.has(row.tag) && !this.stopped) this.scheduleCleanup(row.tag); }
    });
    this.activeChildWork = { id: row.id, tag: row.tag, done };
    return this.status(deviceCopy, operationId);
  }
  private async parse(device: LocalHistoryAuthenticatedDevice, row: Row, plan: Plan, ownerUserId: string): Promise<void> {
    const authorized = () => {
      try { return this.owned(row.id, device).phase === 'preparing'; } catch { return false; }
    };
    const check = () => { if (!authorized()) refuse('unavailable'); };
    const files: PreparedFile[] = [];
    for (const [index, file] of plan.files.entries()) {
      check();
      const expected = plan.manifest.files[index], output = this.ledger.create(row.tag, 0);
      let leased = false;
      const receipt = await runLocalHistoryParseJob({
        input: { source: expected.source, expectedSessionId: expected.expectedSessionId,
          expectedProjectPath: plan.manifest.project, bytes: expected.bytes, sha256: expected.sha256, ownerUserId },
        ...this.parserPolicy,
        deadlineMs: Math.max(1, Math.floor(Math.min(this.parserPolicy.deadlineMs, row.deadline - this.clock(),
          (this.expiryTicks.get(row.id) ?? 0) - performance.now()))),
        acquireChild: async () => {
          check(); if (leased) return null; leased = true;
          return { custody: this.custody.custody,
            registerChild: async pid => { check(); if (!leased) refuse('unavailable'); await this.registerChild(pid); check(); },
            release: () => { if (!leased) refuse('unavailable'); leased = false; },
          };
        },
        authorized,
        chunks: async function* (this: LocalHistoryUploadStaging, signal: AbortSignal) {
          for (let offset = 0; offset < expected.bytes; offset += CHUNK_BYTES) {
            check(); if (signal.aborted) refuse('unavailable');
            const bytes = this.ledger.read(file.allocation, offset, Math.min(CHUNK_BYTES, expected.bytes - offset));
            try { check(); yield bytes; check(); } finally { bytes.fill(0); }
          }
        }.bind(this),
        writeOutput: async (bytes, signal) => {
          check(); if (signal.aborted) refuse('unavailable');
          for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
            const block = bytes.subarray(offset, offset + CHUNK_BYTES);
            this.ledger.grow(output, block.length); check(); this.ledger.write(output, block); check();
          }
        },
      });
      check();
      const allocation = this.ledger.inspect(output);
      if (allocation.written !== receipt.bytes || allocation.planned !== receipt.bytes) refuse('unavailable');
      this.ledger.seal(output);
      files.push({ fileId: file.fileId, allocation: output, ...receipt });
    }
    check();
    const result: PreparedPlan = { version: 1, parserContractVersion: 1, operationId: row.id, fingerprint: row.fingerprint, files };
    const bytes = Buffer.from(JSON.stringify(result));
    let allocation: string;
    try {
      if (bytes.length > PLAN_BYTES) refuse('capacity');
      allocation = this.ledger.create(row.tag, bytes.length);
      for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) { check(); this.ledger.write(allocation, bytes.subarray(offset, offset + CHUNK_BYTES)); }
      this.ledger.seal(allocation);
      const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      this.transaction(() => {
        check(); this.metadataRoom();
        this.db.prepare('INSERT INTO upload_preparations(id,allocation,sha256) VALUES(?,?,?)').run(row.id, allocation, sha256);
      });
    } finally { bytes.fill(0); }
    check();
    // No whole-tag retry here: that would also dispose the published outputs.
    // A failed raw retirement terminates the operation and later owns the tag.
    for (const file of plan.files) { check(); this.ledger.dispose(file.allocation); }
    this.transaction(() => {
      check(); this.metadataRoom();
      this.db.prepare("UPDATE upload_operations SET phase = 'prepared' WHERE id = ?").run(row.id);
    });
  }
  /** Internal read-only preview of the exact sealed artifacts. This neither
   * publishes a confirmation nonce nor changes the original grant deadline.
   * The preparation custody slot prevents cancellation/recovery from disposing
   * artifact bytes until the actual fixed reader process has closed.
   */
  async readPreparedPreview(device: LocalHistoryAuthenticatedDevice, operationId: string,
    includeFirstClaimPlan?: true): Promise<PreparedPreviewRead> {
    return this.readPreparedPreviewWithObserver(device, operationId, includeFirstClaimPlan);
  }

  private async readPreparedPreviewWithObserver(device: LocalHistoryAuthenticatedDevice, operationId: string,
    includeFirstClaimPlan?: true, copy?: {
      budget: CopyReservationPolicy;
      observe?: (...args: [...Parameters<ObserveLocalHistoryFirstClaimPlan>, CopyReservationBinding]) => undefined;
      pilotCommit?: (...args: [...Parameters<ObserveLocalHistoryFirstClaimPlan>, CopyReservationBinding]) => LocalHistoryFirstPermit;
    }): Promise<PreparedPreviewRead> {
    const row = this.owned(operationId, device);
    if (row.phase !== 'prepared') refuse('conflict');
    if (this.verification || this.activeChildWork) refuse('busy');
    const deviceCopy = Object.freeze({ deviceId: device.deviceId, deviceKeyHash: device.deviceKeyHash });
    const prepared = this.prepared(row), plan = this.plan(row), ownerUserId = this.owner(deviceCopy).ownerUserId;
    const authorized = () => { try { return this.owned(row.id, deviceCopy).phase === 'prepared'; } catch { return false; } };
    const check = () => { if (!authorized()) refuse('unavailable'); };
    let result: PreparedPreviewRead | undefined, writerBusy = false, leased = false;
    let run: ReturnType<typeof registerLocalHistoryStoreTemporaryRun> | undefined;
    let pin: ReturnType<LocalHistoryDiskLedger['pinCopyVolume']> | undefined;
    let reservation: ReturnType<LocalHistoryDiskLedger['createCopyRunReservation']> | undefined;
    let reservationMayExist = false;
    let issuedPermit: LocalHistoryFirstPermit | undefined;
    const bindReservation = (claim: Parameters<ObserveLocalHistoryFirstClaimPlan>[0]): CopyReservationBinding => {
      if (!copy || !reservation || !run || !pin) refuse('unavailable');
      const { bootstrapBytes, firstClaimPolicy } = copy.budget;
      const physicalBytes = estimateLocalHistoryPhysicalBytes({
        kind: 'source-claim', databaseCeilingBytes: claim.databaseCeilingBytes, journalBytes: claim.journalBytes,
      }, firstClaimPolicy);
      if (physicalBytes > 0) reservation.grow(physicalBytes);
      const reservedBytes = bootstrapBytes + physicalBytes;
      reservation.assertCovers(reservedBytes);
      return Object.freeze({ allocationId: reservation.allocationId, runId: run.runId, reservedBytes });
    };
    const done = Promise.resolve().then(async () => {
      check();
      const receipt = await runLocalHistoryPreparedReadJob({
        input: { stateDir: this.deps.stateDir, ownerUserId, maxArtifactBytes: Math.max(...prepared.files.map(file => file.bytes)),
          ...(includeFirstClaimPlan === true && { includeFirstClaimPlan }),
          descriptors: prepared.files.map((file, index) => ({ fileId: file.fileId, source: plan.manifest.files[index].source,
            expectedSessionId: plan.manifest.files[index].expectedSessionId, projectPath: plan.manifest.project,
            representation: file.representation, bytes: file.bytes, sha256: file.sha256 })) },
        heapMiB: this.parserPolicy.heapMiB, perFileDeadlineMs: this.parserPolicy.deadlineMs, rssBytes: this.parserPolicy.rssBytes,
        authorized,
        observeFirstClaimPlan: copy?.observe ? (claim, destinations) =>
          copy.observe!(claim, destinations, bindReservation(claim)) : undefined,
        pilotCommit: copy?.pilotCommit ? (claim, destinations, registered) => {
          const binding = bindReservation(claim);
          if (registered.runId !== binding.runId) refuse('unavailable');
          issuedPermit = copy.pilotCommit!(claim, destinations, binding);
          return issuedPermit;
        } : undefined,
        acquireChild: async () => {
          check(); if (leased) return null; leased = true;
          return { custody: this.custody.custody,
            registerChild: async child => {
              check();
              if (!child.pid) refuse('unavailable');
              if (copy) {
                if (this.unsettledCopyReservationTags.has(row.tag)
                  || hasUnsettledLocalHistoryTemporaryRun(this.db, row.tag)) refuse('unavailable');
                this.metadataRoom();
                if (copy.pilotCommit) initializeLocalHistoryFirstPermits(this.db);
                pin = this.ledger.pinCopyVolume(localHistoryCopyDestinationDirectories(this.deps.stateDir));
                const { bootstrapBytes, ceiling, firstClaimPolicy } = copy.budget;
                if (pin.measure().blockBytes !== firstClaimPolicy.blockBytes) refuse('capacity');
                reservationMayExist = true;
                try {
                  reservation = this.ledger.createCopyRunReservation(this.custody, operationId, pin, bootstrapBytes, ceiling);
                } catch (error) {
                  if (error instanceof Error && ['local-history-disk-capacity', 'local-history-disk-record-capacity',
                    'local-history-disk-copy-reservation'].includes(error.message)) {
                    reservationMayExist = false;
                  }
                  throw error;
                }
                run = registerLocalHistoryStoreTemporaryRun(this.db, this.custody, {
                  operationId, existingDirectoriesOnly: true,
                });
                const registered = await run.registerChild(child);
                reservation.assertCovers(bootstrapBytes);
                check();
                if (copy.pilotCommit) return registered;
              } else {
                await this.registerChild(child.pid);
              }
              check();
            },
            release: () => {
              if (!leased) refuse('unavailable');
              leased = false;
              try {
                if (run && reservation) {
                  run.cleanupAfterChild();
                  if (!this.unsettledPermitTags.has(row.tag)) {
                    reservation.releaseAfterSettlement();
                    reservationMayExist = false;
                  }
                }
              } finally {
                if (reservationMayExist && !this.unsettledPermitTags.has(row.tag)) this.unsettledCopyReservationTags.add(row.tag);
                pin?.close();
              }
            } };
        },
        chunks: async function* (this: LocalHistoryUploadStaging, signal: AbortSignal) {
          for (const file of prepared.files) for (let offset = 0; offset < file.bytes; offset += CHUNK_BYTES) {
            check(); if (signal.aborted) refuse('unavailable');
            const bytes = this.ledger.read(file.allocation, offset, Math.min(CHUNK_BYTES, file.bytes - offset));
            try { check(); yield bytes; check(); } finally { bytes.fill(0); }
          }
        }.bind(this),
      });
      if (issuedPermit) {
        const permit = issuedPermit;
        this.transaction(() => recordLocalHistoryFirstPermitObservation(this.db, permit, {
          kind: 'acknowledge', digest: digest(['synthetic-first-claim-complete', permit.permitId, permit.planDigest]),
        }));
      } else {
        check();
      }
      result = receipt;
    }).catch(error => {
      if (error instanceof LocalHistoryPreparedReadRefused) {
        writerBusy = error.message === 'local-history-preview-writer-busy' && !error.cleanupPending;
        if (copy && error.cleanupPending) this.report('cleanup', 'registered-namespace-cleanup-pending');
      }
    }).finally(() => {
      if (this.activeChildWork?.done === done) this.activeChildWork = undefined;
      try {
        const current = this.row(row.id);
        if (!live(current.phase)) this.invalidate(current, copy?.pilotCommit && current.phase === 'applying' ? 'interrupted' : current.phase);
      }
      catch { if (!this.disposeTag(row.tag) && !this.cleanups.has(row.tag) && !this.stopped) this.scheduleCleanup(row.tag); }
    });
    this.activeChildWork = { id: row.id, tag: row.tag, done };
    await done;
    if (!issuedPermit) check();
    if (writerBusy) refuse('busy');
    if (!result) refuse('unavailable');
    return result;
  }
  /** Publish one immutable candidate for explicit confirmation. Status never
   * invokes this method. The receipt itself cannot authorize any mutation. */
  async publishPreparedPreview(device: LocalHistoryAuthenticatedDevice, operationId: string): Promise<PreviewReceipt> {
    const deviceCopy = Object.freeze({ deviceId: device.deviceId, deviceKeyHash: device.deviceKeyHash });
    const row = this.owned(operationId, deviceCopy);
    if (row.phase !== 'prepared') refuse('conflict');
    const existing = this.readPublishedPreview(row);
    if (existing) return existing;
    const { preview, rssProtection: readerRssProtection } = await this.readPreparedPreview(deviceCopy, operationId);
    const current = this.owned(operationId, deviceCopy);
    if (current.phase !== 'prepared' || this.db.prepare('SELECT 1 FROM upload_previews WHERE id = ?').get(row.id)) refuse('conflict');
    const prepared = this.prepared(current).files;
    const receipt = {
      previewId: crypto.randomBytes(16).toString('hex'), machineId: this.issuer.machineId, expiresAt: current.deadline,
      confirmation: { challenge: crypto.randomBytes(32).toString('base64'), action: 'copy-selected-history' as const },
      preview, readerRssProtection, projects: summarizeLocalHistoryPreviewProjects(preview.files, prepared),
    };
    const bytes = Buffer.from(JSON.stringify({ version: 1, operationId: row.id, issuerHash: row.issuerHash,
      ownerHash: row.ownerHash, deviceHash: row.deviceHash, boot: row.boot, fingerprint: row.fingerprint,
      prepared: prepared.map(({ fileId, sha256 }) => ({ fileId, sha256 })), receipt }));
    let allocation: string | undefined;
    try {
      if (bytes.length > PLAN_BYTES) refuse('capacity');
      allocation = this.ledger.create(row.tag, bytes.length);
      for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
        this.ledger.write(allocation, bytes.subarray(offset, offset + CHUNK_BYTES));
      }
      this.ledger.seal(allocation);
      this.transaction(() => {
        if (this.owned(operationId, deviceCopy).phase !== 'prepared') refuse('conflict');
        this.metadataRoom();
        this.db.prepare('INSERT INTO upload_previews(id,allocation,sha256) VALUES(?,?,?)')
          .run(row.id, allocation, crypto.createHash('sha256').update(bytes).digest('hex'));
      });
      return receipt;
    } catch (error) {
      if (allocation) {
        try { this.ledger.dispose(allocation); } catch { this.report('cleanup', 'preview-allocation-retained'); }
      }
      throw error;
    } finally { bytes.fill(0); }
  }
  /** Take custody of a child already spawned by the internal copy coordinator.
   * This lane registers and settles its namespace without delivering a token
   * or authorizing any mutation. Admission failures before custody transfer
   * leave the child with its original caller. */
  async holdPreparedCopyChild(device: LocalHistoryAuthenticatedDevice, operationId: string, intent: unknown,
    child: ChildProcess, budget: Readonly<{ bootstrapBytes: number; ceiling: number; firstClaimPolicy: LocalHistoryPhysicalPolicy }>): Promise<void> {
    const deviceCopy = Object.freeze({ deviceId: device.deviceId, deviceKeyHash: device.deviceKeyHash });
    const before = this.bindCopyIntent(deviceCopy, operationId, intent);
    if (this.verification || this.activeChildWork) refuse('busy');
    const { bootstrapBytes, ceiling, firstClaimPolicy } = budget;
    const policy = { ...firstClaimPolicy };
    if (!Number.isSafeInteger(bootstrapBytes) || !Number.isSafeInteger(ceiling) || bootstrapBytes <= 0 || bootstrapBytes > ceiling) {
      refuse('invalid');
    }
    if (!(child instanceof ChildProcess) || !child.pid || !child.spawnfile
      || child.exitCode !== null || child.signalCode !== null) refuse('invalid');
    const estimate = await this.estimateFirstCopyClaim(deviceCopy, operationId, before.intent, policy);
    const initialCharge = bootstrapBytes + estimate.estimatedPhysicalBytes;
    if (!Number.isSafeInteger(initialCharge) || initialCharge > ceiling) refuse('capacity');
    const current = this.bindCopyIntent(deviceCopy, operationId, before.intent);
    const previewDigest = digest(current.receipt);
    if (estimate.requestId !== current.requestId || estimate.fingerprint !== current.fingerprint
      || estimate.previewDigest !== previewDigest || digest(before.receipt) !== previewDigest) refuse('conflict');
    if (this.verification || this.activeChildWork) refuse('busy');
    const row = this.owned(operationId, deviceCopy);
    if (child.exitCode !== null || child.signalCode !== null) refuse('invalid');

    let closed = false, failed = false, stopRequested = false, killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (closed || stopRequested) return;
      stopRequested = true;
      try { child.kill('SIGTERM'); } catch { /* Still await the actual close event. */ }
      if (closed) return;
      killTimer = setTimeout(() => {
        if (!closed) try { child.kill('SIGKILL'); } catch { /* Custody is retained until close. */ }
      }, 1000);
      killTimer.unref();
    };
    const onError = () => { failed = true; stop(); };
    child.on('error', onError);
    const childClosed = new Promise<void>(resolve => {
      child.once('close', () => { closed = true; if (killTimer) clearTimeout(killTimer); resolve(); });
    });
    const done = Promise.resolve().then(async () => {
      let run: ReturnType<typeof registerLocalHistoryStoreTemporaryRun> | undefined;
      let pin: ReturnType<LocalHistoryDiskLedger['pinCopyVolume']> | undefined;
      let reservation: ReturnType<LocalHistoryDiskLedger['createCopyRunReservation']> | undefined;
      let reservationMayExist = false;
      try {
        if (closed || this.owned(operationId, deviceCopy).phase !== 'prepared') refuse('unavailable');
        this.metadataRoom();
        pin = this.ledger.pinCopyVolume(localHistoryCopyDestinationDirectories(this.deps.stateDir));
        if (pin.measure().blockBytes !== policy.blockBytes) refuse('capacity');
        reservationMayExist = true;
        reservation = this.ledger.createCopyRunReservation(this.custody, operationId, pin, initialCharge, ceiling);
        pin.revalidate();
        run = registerLocalHistoryStoreTemporaryRun(this.db, this.custody, { operationId, existingDirectoriesOnly: true });
        pin.revalidate();
        await run.registerChild(child);
        reservation.assertCovers(initialCharge);
      } catch (error) {
        if (!reservation && error instanceof Error
          && ['local-history-disk-capacity', 'local-history-disk-record-capacity'].includes(error.message)) reservationMayExist = false;
        failed = true;
        stop();
      }
      await childClosed;
      child.off('error', onError);
      try {
        if (run && pin && reservation) {
          run.cleanupAfterChild();
          reservation.releaseAfterSettlement();
          reservationMayExist = false;
        }
      } catch {
        failed = true;
        this.report('cleanup', 'registered-namespace-cleanup-pending');
      } finally {
        if (reservationMayExist) this.unsettledCopyReservationTags.add(row.tag);
        try { pin?.close(); } catch { failed = true; }
      }
    }).finally(() => {
      if (this.activeChildWork?.done === done) this.activeChildWork = undefined;
      try { const current = this.row(row.id); if (!live(current.phase)) this.invalidate(current, current.phase); }
      catch { this.report('cleanup', 'copy-child-settlement-unavailable'); }
    });
    this.activeChildWork = { id: row.id, tag: row.tag, done, stop };
    await done;
    if (failed) refuse('unavailable');
  }

  /** Recheck the full prepared stream and destination before copy admission.
   * This observation cannot replace revalidation under the mutation writer. */
  async preflightCopyIntent(device: LocalHistoryAuthenticatedDevice, operationId: string, value: unknown): Promise<{
    requestId: string; fingerprint: string;
  }> {
    const { requestId, fingerprint } = await this.checkCopyPreflight(device, operationId, value);
    return { requestId, fingerprint };
  }

  /** Point-in-time sizing for the exact preflighted first claim. The caller's
   * explicit policy still needs an admitted volume and real writer/permit. */
  async estimateFirstCopyClaim(device: LocalHistoryAuthenticatedDevice, operationId: string, value: unknown,
    policy: LocalHistoryPhysicalPolicy) {
    const policySnapshot = { ...policy };
    const { requestId, fingerprint, previewDigest, firstClaimPlan } = await this.checkCopyPreflight(device, operationId, value, true);
    if (!firstClaimPlan) refuse('unavailable');
    const { fileId, contentBytes, databaseCeilingBytes, journalBytes, planDigest } = firstClaimPlan;
    let estimatedPhysicalBytes: number;
    try {
      estimatedPhysicalBytes = estimateLocalHistoryPhysicalBytes({
        kind: 'source-claim', databaseCeilingBytes, journalBytes,
      }, policySnapshot);
    } catch { return refuse('capacity'); }
    return { requestId, fingerprint, previewDigest, fileId, contentBytes, estimatedPhysicalBytes, planDigest };
  }

  private async checkCopyPreflight(device: LocalHistoryAuthenticatedDevice, operationId: string, value: unknown,
    includeFirstClaimPlan?: true) {
    const deviceCopy = Object.freeze({ deviceId: device.deviceId, deviceKeyHash: device.deviceKeyHash });
    const before = this.bindCopyIntent(deviceCopy, operationId, value);
    const { preview } = await this.readPreparedPreview(deviceCopy, operationId, includeFirstClaimPlan);
    const after = this.bindCopyIntent(deviceCopy, operationId, before.intent);
    const original = before.receipt.preview?.files;
    const previewDigest = digest(after.receipt);
    if (before.fingerprint !== after.fingerprint || digest(before.receipt) !== previewDigest
      || !Array.isArray(original) || original.length !== preview.files.length
      || !preview.files.every((file, index) => file.fileId === original[index]?.fileId
        && file.source === original[index].source && file.destinationFingerprint === original[index].destinationFingerprint)) {
      refuse('conflict');
    }
    return { requestId: after.requestId, fingerprint: after.fingerprint, previewDigest, firstClaimPlan: preview.firstClaimPlan };
  }
  /** Inspect the copy plan only while the actual reader holds the writer.
   * The callback has no permit authority and the child will discard the plan. */
  async observeFirstCopyClaim(device: LocalHistoryAuthenticatedDevice, operationId: string, value: unknown,
    budget: CopyReservationPolicy,
    observe: (plan: Parameters<ObserveLocalHistoryFirstClaimPlan>[0], reservation: CopyReservationBinding) => undefined): Promise<void> {
    const ownedBudget = { ...budget, firstClaimPolicy: { ...budget.firstClaimPolicy } };
    const { bootstrapBytes, ceiling } = ownedBudget;
    if (!Number.isSafeInteger(bootstrapBytes) || !Number.isSafeInteger(ceiling) || bootstrapBytes <= 0 || bootstrapBytes > ceiling) refuse('invalid');
    const deviceCopy = Object.freeze({ deviceId: device.deviceId, deviceKeyHash: device.deviceKeyHash });
    const before = this.bindCopyIntent(deviceCopy, operationId, value);
    await this.readPreparedPreviewWithObserver(deviceCopy, operationId, true, { budget: ownedBudget, observe: (plan, destinations, reservation) => {
      const current = this.bindCopyIntent(deviceCopy, operationId, before.intent);
      const original = before.receipt.preview?.files;
      if (before.fingerprint !== current.fingerprint || digest(before.receipt) !== digest(current.receipt)
        || !Array.isArray(original) || original.length !== destinations.length
        || !destinations.every((file, index) => file.fileId === original[index]?.fileId
          && file.source === original[index].source && file.destinationFingerprint === original[index].destinationFingerprint)) {
        refuse('conflict');
      }
      return observe(plan, reservation);
    } });
  }

  /** Complete the first claim only for the built-in disposable fixture. The
   * remaining import is interrupted and its committed reservation stays held. */
  async applyDisposableFirstClaim(device: LocalHistoryAuthenticatedDevice, operationId: string, value: unknown,
    budget: CopyReservationPolicy, signal?: AbortSignal): Promise<{ claimWritten: true }> {
    if (signal?.aborted) refuse('unavailable');
    assertLocalHistoryDisposablePilotState(this.deps.stateDir);
    const ownedBudget = { ...budget, firstClaimPolicy: { ...budget.firstClaimPolicy } };
    const { bootstrapBytes, ceiling } = ownedBudget;
    if (!Number.isSafeInteger(bootstrapBytes) || !Number.isSafeInteger(ceiling) || bootstrapBytes <= 0 || bootstrapBytes > ceiling) refuse('invalid');
    const deviceCopy = Object.freeze({ deviceId: device.deviceId, deviceKeyHash: device.deviceKeyHash });
    const initial = this.bindCopyIntent(deviceCopy, operationId, value);
    await this.readPreparedPreviewWithObserver(deviceCopy, operationId, true, {
      budget: ownedBudget,
      pilotCommit: (claim, destinations, reservation) => this.transaction(() => {
        if (signal?.aborted) refuse('unavailable');
        const row = this.owned(operationId, deviceCopy);
        const current = this.bindCopyIntent(deviceCopy, operationId, initial.intent);
        const destination = destinations[0], selected = current.receipt.preview.files[0];
        if (initial.fingerprint !== current.fingerprint || digest(initial.receipt) !== digest(current.receipt)
          || destinations.length !== 1 || current.receipt.preview.files.length !== 1
          || !destination?.destinationFingerprint || destination.fileId !== selected?.fileId
          || destination.source !== selected.source || destination.destinationFingerprint !== selected.destinationFingerprint) {
          refuse('conflict');
        }
        const index = this.db.prepare('SELECT allocation, sha256 FROM upload_previews WHERE id = ?').get(operationId) as
          { allocation: string; sha256: string } | undefined;
        if (!index) refuse('unavailable');
        const permit: LocalHistoryFirstPermit = {
          operationId, previewId: current.receipt.previewId, applyRequestId: current.requestId, intentFingerprint: current.fingerprint,
          generation: this.custody.custody.generation, runId: reservation.runId, reservationId: reservation.allocationId,
          previewAllocation: index.allocation, previewSha256: index.sha256, uploadFingerprint: row.fingerprint,
          deadline: row.deadline, permitId: crypto.randomBytes(16).toString('hex'), fileIndex: 0,
          destinationBinding: destination.destinationFingerprint, mutationKind: 'claim',
          planDigest: claim.planDigest, plannedBytes: reservation.reservedBytes,
        };
        // Fence before attempting COMMIT. A failure can leave an issued permit.
        this.unsettledPermitTags.add(row.tag);
        if (recordLocalHistoryFirstPermit(this.db, permit) !== 'recorded') refuse('conflict');
        return permit;
      }),
    });
    return { claimWritten: true };
  }

  /** Validate the signed copy intent against current staging state. The
   * eventual permit issuer must repeat this inside its consumption transaction. */
  inspectCopyIntent(device: LocalHistoryAuthenticatedDevice, operationId: string, value: unknown): {
    requestId: string; fingerprint: string;
  } {
    const { requestId, fingerprint } = this.bindCopyIntent(device, operationId, value);
    return { requestId, fingerprint };
  }
  private bindCopyIntent(device: LocalHistoryAuthenticatedDevice, operationId: string, value: unknown) {
    const row = this.owned(operationId, device);
    if (row.phase !== 'prepared') refuse('conflict');
    const fields = ['previewId', 'machineId', 'bootId', 'confirmationChallenge', 'applyRequestId'];
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== fields.length
      || fields.some(field => !Object.hasOwn(value, field))) refuse('invalid');
    const { previewId, machineId, bootId, confirmationChallenge, applyRequestId: requestId } = value as Record<string, unknown>;
    if (!id(previewId) || typeof requestId !== 'string' || !id(requestId)
      || machineId !== this.issuer.machineId || bootId !== row.boot
      || typeof confirmationChallenge !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(confirmationChallenge)) refuse('invalid');
    const receipt = this.readPublishedPreview(row);
    if (!receipt || receipt.previewId !== previewId
      || !crypto.timingSafeEqual(Buffer.from(receipt.confirmation.challenge), Buffer.from(confirmationChallenge))) {
      refuse('conflict');
    }
    const fingerprint = digest(['copy-selected-history', row.id, row.issuerHash,
      row.ownerHash, row.deviceHash, row.boot, row.fingerprint, receipt.previewId, receipt.confirmation.challenge, requestId]);
    return { requestId, fingerprint, receipt, intent: Object.freeze({
      previewId: receipt.previewId, machineId: receipt.machineId, bootId: row.boot,
      confirmationChallenge: receipt.confirmation.challenge, applyRequestId: requestId,
    }) };
  }
  /** Inspect the prepared material for a future sealed owner-consent slip.
   * This exposes neither selection challenges nor copy authority. Capture
   * provenance still must establish who owns each source and its machine. */
  readOwnerConsentPreview(device: LocalHistoryAuthenticatedDevice, operationId: string) {
    const row = this.owned(operationId, device);
    if (row.phase !== 'prepared') refuse('conflict');
    const published = this.readPublishedPreviewRecord(row);
    if (!published) refuse('conflict');
    const { receipt, previewDigest, prepared } = published;
    const files = receipt.preview?.files;
    if (!Array.isArray(files) || files.length !== prepared.length) refuse('unavailable');
    const artifacts = Object.freeze(prepared.map(({ fileId, sha256 }, index) => {
      const file = files[index];
      if (!file || file.fileId !== fileId || (file.source !== 'codex' && file.source !== CLAUDE_CODE_FRAMEWORK)) refuse('unavailable');
      return Object.freeze({ fileId, kind: file.source, artifactDigest: sha256 });
    }));
    const { ownerHash, ownerUserId } = this.owner(device);
    if (ownerHash !== row.ownerHash) refuse('not-found');
    return Object.freeze({ operationId: row.id, previewId: receipt.previewId, previewDigest, ownerUserId, expiresAt: row.deadline, artifacts,
      destination: Object.freeze({ machineId: this.issuer.machineId, machineKeyHash: this.issuer.signingKeyHash,
        agentId: this.issuer.agentId, ownerUserId, bootId: row.boot, origin: this.issuer.origin }),
    });
  }

  // Replay returns the original sealed receipt. Reading its prepared index
  // does not reread normalized payloads. Copy admission needs a full artifact
  // digest and EOF check before its first mutation permit.
  private readPublishedPreview(row: Row): PreviewReceipt | undefined {
    return this.readPublishedPreviewRecord(row)?.receipt;
  }

  private readPublishedPreviewRecord(row: Row) {
    const record = this.db.prepare('SELECT allocation,sha256 FROM upload_previews WHERE id = ?').get(row.id) as
      { allocation: string; sha256: string } | undefined;
    if (!record) return undefined;
    if (!id(record.allocation) || !/^[a-f0-9]{64}$/.test(record.sha256)) refuse('unavailable');
    const stored = this.ledger.inspect(record.allocation);
    if (stored.operation !== row.tag || stored.state !== 'sealed' || stored.written !== stored.planned
      || stored.written <= 0 || stored.written > PLAN_BYTES) refuse('unavailable');
    const bytes = Buffer.alloc(stored.written);
    try {
      for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
        const block = this.ledger.read(record.allocation, offset, Math.min(CHUNK_BYTES, bytes.length - offset));
        try { block.copy(bytes, offset); } finally { block.fill(0); }
      }
      if (crypto.createHash('sha256').update(bytes).digest('hex') !== record.sha256) refuse('unavailable');
      const value = JSON.parse(bytes.toString('utf8'));
      const prepared = this.prepared(row).files.map(({ fileId, sha256 }) => ({ fileId, sha256 }));
      const receipt = value.receipt as PreviewReceipt;
      if (value.version !== 1 || value.operationId !== row.id || value.issuerHash !== row.issuerHash
        || value.ownerHash !== row.ownerHash || value.deviceHash !== row.deviceHash || value.boot !== row.boot
        || value.fingerprint !== row.fingerprint || JSON.stringify(value.prepared) !== JSON.stringify(prepared)
        || !id(receipt?.previewId) || receipt.machineId !== this.issuer.machineId || receipt.expiresAt !== row.deadline
        || !['sampled', 'unavailable'].includes(receipt.readerRssProtection)
        || receipt.confirmation?.action !== 'copy-selected-history'
        || !/^[A-Za-z0-9+/]{43}=$/.test(receipt.confirmation.challenge)) refuse('unavailable');
      return { receipt, previewDigest: record.sha256, prepared };
    } catch { return refuse('unavailable'); }
    finally { bytes.fill(0); }
  }
  private prepared(row: Row): PreparedPlan {
    const record = this.db.prepare('SELECT allocation,sha256 FROM upload_preparations WHERE id = ?').get(row.id) as {allocation: string; sha256: string} | undefined;
    if (!record || !id(record.allocation) || !/^[a-f0-9]{64}$/.test(record.sha256)) refuse('unavailable');
    const allocation = this.ledger.inspect(record.allocation);
    if (allocation.operation !== row.tag || allocation.state !== 'sealed' || allocation.written !== allocation.planned || allocation.written > PLAN_BYTES) refuse('unavailable');
    const parts: Buffer[] = []; let bytes: Buffer | undefined;
    try {
      for (let offset = 0; offset < allocation.written; offset += CHUNK_BYTES) parts.push(this.ledger.read(record.allocation, offset, Math.min(CHUNK_BYTES, allocation.written - offset)));
      bytes = Buffer.concat(parts);
      if (crypto.createHash('sha256').update(bytes).digest('hex') !== record.sha256) refuse('unavailable');
      const result = JSON.parse(bytes.toString('utf8')) as PreparedPlan, plan = this.plan(row);
      if (result.version !== 1 || result.parserContractVersion !== 1 || result.operationId !== row.id || result.fingerprint !== row.fingerprint
        || Object.keys(result).length !== 5
        || !Array.isArray(result.files) || result.files.length !== plan.files.length) refuse('unavailable');
      const seen = new Set<string>([row.plan, record.allocation, ...plan.files.map(file => file.allocation)]);
      for (const [index, file] of result.files.entries()) {
        if (file.fileId !== plan.files[index].fileId || !id(file.allocation) || seen.has(file.allocation)
          || Object.keys(file).length !== 7
          || !Number.isSafeInteger(file.bytes) || file.bytes <= 0 || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)
          || !['canonical', 'event-fallback', 'claude-records'].includes(file.representation)
          || (plan.manifest.files[index].source === CLAUDE_CODE_FRAMEWORK ? file.representation !== 'claude-records' : file.representation === 'claude-records')
          || !['sampled', 'unavailable'].includes(file.rssProtection)
          || !file.counts || Object.keys(file.counts).length !== 5
          || !['records', 'malformed', 'excluded', 'duplicateMessages', 'toolCalls'].every(key => Number.isSafeInteger(file.counts[key as keyof typeof file.counts]) && file.counts[key as keyof typeof file.counts] >= 0)) refuse('unavailable');
        seen.add(file.allocation);
        const stored = this.ledger.inspect(file.allocation);
        if (stored.operation !== row.tag || stored.state !== 'sealed' || stored.planned !== file.bytes || stored.written !== file.bytes) refuse('unavailable');
      }
      return result;
    } catch { return refuse('unavailable'); }
    finally { bytes?.fill(0); for (const part of parts) part.fill(0); }
  }
  cancel(device: LocalHistoryAuthenticatedDevice, operationId: string): LocalHistoryUploadStatus {
    const row = this.owned(operationId, device);
    if (live(row.phase)) this.invalidate(row, 'cancelled');
    return this.status(device, operationId);
  }
  private invalidate(row: Row, phase: Phase): void {
    this.invalidated.set(row.id, phase);
    if (this.activeChildWork?.id === row.id) this.activeChildWork.stop?.();
    this.expiryTicks.delete(row.id);
    const timer = this.timers.get(row.id); if (timer) clearTimeout(timer); this.timers.delete(row.id);
    if (!this.unsettledPermitTags.has(row.tag) && !this.disposeTag(row.tag) && !this.cleanups.has(row.tag) && !this.stopped) {
      this.scheduleCleanup(row.tag);
    }
    try { this.metadataRoom(); this.db.prepare('UPDATE upload_operations SET phase = ? WHERE id = ?').run(phase, row.id); }
    catch { /* live memory denies authority; durable generation remains charged */ }
  }
  private disposeTag(tag: string): boolean {
    if (this.activeChildWork?.tag === tag || this.unsettledPermitTags.has(tag)
      || this.unsettledCopyReservationTags.has(tag)) return false;
    let disposed = true;
    let allocations: ReturnType<LocalHistoryDiskLedger['list']>;
    try {
      if (hasUnsettledLocalHistoryTemporaryRun(this.db, tag)) return false;
      allocations = this.ledger.list(tag);
    } catch { return false; }
    for (const allocation of allocations) if (allocation.state !== 'disposed') {
      try { this.ledger.dispose(allocation.id); } catch { disposed = false; }
    }
    return disposed;
  }
  private clearCleanup(tag: string): void {
    for (const timer of this.cleanups.get(tag) ?? []) clearTimeout(timer);
    this.cleanups.delete(tag);
    this.reportedCleanup.delete(tag);
  }
  private scheduleCleanup(tag: string): void {
    const timers = [1000, 10_000, 60_000].map((delay, index) => {
      const timer = setTimeout(() => {
        if (this.stopped) return;
        if (this.disposeTag(tag)) {
          this.clearCleanup(tag);
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
  private quarantineFirstPermits(operations: readonly Row[], allocations: ReturnType<LocalHistoryDiskLedger['inventory']>): void {
    const operationsById = new Map(operations.map(row => [row.id, row]));
    const allocationsById = new Map(allocations.map(row => [row.id, row]));
    const slots = new Map(readLocalHistoryFirstPermitInventory(this.db).map(row => [row.operationId, row]));
    const preview = this.db.prepare('SELECT 1 FROM sqlite_schema WHERE type = ? AND name = ?').get('table', 'upload_previews')
      ? this.db.prepare('SELECT allocation, sha256 FROM upload_previews WHERE id = ?') : undefined;
    for (const slot of slots.values()) {
      const row = operationsById.get(slot.operationId);
      const tag = 'r-' + slot.generation + '-' + slot.operationId;
      const index = preview?.get(slot.operationId) as { allocation: string; sha256: string } | undefined;
      const allocation = allocationsById.get(slot.reservationId);
      if (!row || !['applying', 'interrupted'].includes(row.phase) || row.tag !== tag
        || row.fingerprint !== slot.uploadFingerprint || row.deadline !== slot.deadline
        || slot.generation === this.custody.custody.generation
        || index?.allocation !== slot.previewAllocation || index.sha256 !== slot.previewSha256
        || allocation?.operation !== tag || allocation.state !== 'active' || allocation.written !== 0
        || allocation.planned < slot.plannedBytes) refuse('unavailable');
      validateLocalHistoryFirstPermitRun(this.db, slot.runId, tag);
    }
    for (const row of operations) {
      if (row.phase === 'applying' && !slots.has(row.id)) refuse('unavailable');
    }
    for (const { operationId } of slots.values()) {
      const row = operationsById.get(operationId)!;
      this.unsettledPermitTags.add(row.tag);
      if (row.phase === 'applying') this.invalidated.set(row.id, 'interrupted');
    }
  }
  private recover(): void {
    // Exclusive custody was acquired before a fresh generation was published.
    // Old parents and shared child holders are therefore gone; unknown tags do
    // not acquire deletion authority merely by lacking an operation row.
    const count = this.db.prepare('SELECT (SELECT COUNT(*) FROM upload_operations) + (SELECT COUNT(*) FROM upload_challenges) AS n').get() as {n: number};
    if (!Number.isSafeInteger(count.n) || count.n > MAX_ROWS) refuse('unavailable');
    const preparedCount = this.db.prepare('SELECT COUNT(*) AS n FROM upload_preparations').get() as {n: number};
    if (!Number.isSafeInteger(preparedCount.n) || preparedCount.n > MAX_ROWS
      || this.db.prepare('SELECT 1 FROM upload_preparations p LEFT JOIN upload_operations o ON o.id = p.id WHERE o.id IS NULL LIMIT 1').get()) refuse('unavailable');
    validateLocalHistoryTemporaryRunInventory(this.db);
    const inventory = this.ledger.inventory();
    const old = new Set(inventory.map(row => row.operation).filter(tag => /^r-[a-f0-9]{64}-[a-f0-9]{32}$/.test(tag)
      && !tag.startsWith('r-' + this.custody.custody.generation + '-')));
    const operations = (this.db.prepare('SELECT id FROM upload_operations LIMIT ?').all(MAX_ROWS) as { id: string }[])
      .map(operation => this.row(operation.id));
    this.quarantineFirstPermits(operations, inventory);
    for (const tag of old) {
      if (!this.unsettledPermitTags.has(tag) && !this.disposeTag(tag)) this.scheduleCleanup(tag);
    }
    for (const row of operations) if (live(row.phase)) this.invalidate(row, 'interrupted');
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
    this.activeChildWork?.stop?.();
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
        await this.activeChildWork?.done;
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

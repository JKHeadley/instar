/** Direct, recipient-encrypted transfer of explicitly approved user job files. */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash, createPublicKey } from 'node:crypto';
import type { MachineIdentityManager } from './MachineIdentity.js';
import { isRegistryEntryActive } from './MachineIdentity.js';
import { isPeerUrlAllowedForCredentials, type PeerEndpointKind } from '../server/peerUrlGuard.js';
import { poolPeerFetch, type PoolPeerTarget, type RopeResultRecorder } from '../server/poolPeerFetch.js';
import { validJobDependencyPath } from './JobDependency.js';
import type { JobCoverageEntry } from './JobCoverage.js';
import { portableRead, portableWrite, portableRemoveIfHash, portableQuarantineIfHash } from './JobPortableFs.js';
import { featureEvidence } from '../monitoring/FeatureEvidenceLog.js';
import { SafeFsExecutor } from './SafeFsExecutor.js';
import {
  collectPortableJob, validatePortableBundle, makePortableBundleRequest, acceptPortableBundleRequest,
  PortableGenerationStore,
  makePortableBundleWire, acceptPortableBundleWire, PortableApprovalStore,
  type PortableBundleRequest, type PortableBundleWire, type PortableJobBundle,
} from './JobPortableBundle.js';

export interface JobPortableSyncOptions {
  stateDir: string;
  projectDir: string;
  identityManager: MachineIdentityManager;
  authToken: string;
  readOnly?: boolean;
  onImport?: () => void;
  withAdmissionFence?: <T>(action: () => T) => T;
  recordRopeResult?: RopeResultRecorder;
}
const MAX_WIRE = 6 * 1024 * 1024;
const PEER_ID = /^m_[a-f0-9]{32}$/;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('empty-body');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const row = await reader.read();
      if (row.done) break;
      size += row.value.byteLength;
      if (size > MAX_WIRE) throw new Error('wire-oversized');
      chunks.push(row.value);
    }
  } finally { reader.releaseLock(); }
  const merged = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), size);
  return JSON.parse(merged.toString('utf8'));
}

export class JobPortableSync {
  private readonly exportApprovals: PortableApprovalStore;
  private readonly activationApprovals: PortableApprovalStore;
  private readonly inboxDir: string;
  private readonly generations: PortableGenerationStore;
  private readonly lastServe = new Map<string, number>();
  private readonly rollbackLatch: string;
  constructor(private readonly options: JobPortableSyncOptions) {
    this.exportApprovals = new PortableApprovalStore(options.stateDir, 'export');
    this.activationApprovals = new PortableApprovalStore(options.stateDir, 'activate');
    this.inboxDir = path.join(options.stateDir, 'state', 'job-portable-inbox');
    this.generations = new PortableGenerationStore(options.stateDir);
    this.rollbackLatch = path.join(options.stateDir, 'state', 'job-portable-disarmed.json');
  }
  /** PIN-gated caller: approval is for the exact files the local operator reviewed. */
  approveExport(slug: string, expectedRoot: string): PortableJobBundle {
    const bundle = collectPortableJob(this.options.projectDir, this.options.stateDir, slug);
    if (bundle.root !== expectedRoot) throw new Error('content-root-changed');
    this.generations.advance(slug, bundle.root);
    this.exportApprovals.approve(slug, bundle.root);
    return bundle;
  }
  revokeExport(slug: string): void { this.exportApprovals.revoke(slug); }
  previewExport(slug: string): { slug: string; root: string; files: Array<{ path: string; sha256: string }> } {
    const bundle = collectPortableJob(this.options.projectDir, this.options.stateDir, slug);
    return { slug, root: bundle.root, files: bundle.files.map(({ path: filePath, sha256 }) => ({ path: filePath, sha256 })) };
  }
  /** Source route: requester signature and registered identity are checked before disk walking. */
  serve(rawRequest: unknown): PortableBundleWire {
    const identity = this.options.identityManager.loadIdentity();
    const request = rawRequest as Partial<PortableBundleRequest>;
    if (!request || typeof request.recipientMachineId !== 'string' || !PEER_ID.test(request.recipientMachineId))
      throw new Error('invalid-request');
    const entry = this.options.identityManager.loadRegistry().machines[request.recipientMachineId];
    const signingKey = entry && isRegistryEntryActive(entry)
      ? this.options.identityManager.getSigningPublicKeyPem(request.recipientMachineId) : null;
    if (!signingKey) throw new Error('unknown-recipient');
    const accepted = acceptPortableBundleRequest(rawRequest, identity.machineId, signingKey);
    const remote = this.options.identityManager.loadRemoteIdentity(accepted.recipientMachineId);
    if (!remote || accepted.sourceKeyEpoch !== (identity.keyEpoch ?? 0)
      || accepted.recipientKeyEpoch !== (remote.keyEpoch ?? 0)) throw new Error('key-epoch-mismatch');
    this.rememberNonce(accepted.recipientMachineId, accepted.nonce);
    const rateKey = `${accepted.recipientMachineId}:${accepted.slug}`;
    const now = Date.now();
    if (now - (this.lastServe.get(rateKey) ?? 0) < 30_000) throw new Error('rate-limited');
    this.lastServe.set(rateKey, now);
    const bundle = collectPortableJob(this.options.projectDir, this.options.stateDir, accepted.slug);
    if (!this.exportApprovals.isApproved(bundle.slug, bundle.root)) throw new Error('export-not-approved');
    const generation = this.generations.current(bundle.slug, bundle.root);
    if (generation === null) throw new Error('generation-unavailable');
    const encryptionPem = this.options.identityManager.getEncryptionPublicKeyPem(accepted.recipientMachineId);
    if (!encryptionPem) throw new Error('recipient-key-missing');
    const encryptionDer = createPublicKey(encryptionPem).export({ type: 'spki', format: 'der' });
    return makePortableBundleWire(bundle, accepted, this.options.identityManager.loadSigningKey(),
      Buffer.from(encryptionDer).toString('base64'), generation);
  }
  private rememberNonce(recipient: string, nonce: string): void {
    const file = path.join(this.options.stateDir, 'state', 'job-portable-request-nonces.json');
    const now = Date.now();
    let seen: Record<string, number> = {};
    try {
      const raw = fs.readFileSync(file, 'utf8');
      if (raw.length > 512 * 1024) throw new Error('nonce-ledger-oversized');
      const parsed = JSON.parse(raw);
      if (parsed.version !== 1 || !parsed.seen || typeof parsed.seen !== 'object') throw new Error('nonce-ledger-corrupt');
      seen = parsed.seen;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const key = `${recipient}:${nonce}`;
    if (seen[key]) throw new Error('replayed-request');
    seen = Object.fromEntries(Object.entries(seen).filter(([, at]) => Number.isFinite(at) && now - at < 24 * 60 * 60_000));
    if (Object.keys(seen).length >= 10_000) throw new Error('nonce-ledger-full');
    seen[key] = now;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, seen }), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  private statusFile(): string { return path.join(this.options.stateDir, 'state', 'job-portable-status.json'); }
  private readStatuses(): Record<string, { state: 'staged' | 'active' | 'error'; root?: string; reason?: string; at: string }> {
    try {
      const raw = fs.readFileSync(this.statusFile(), 'utf8');
      if (raw.length > 128 * 1024) throw new Error('portable-status-oversized');
      const parsed = JSON.parse(raw);
      if (parsed.version !== 1 || !parsed.jobs || typeof parsed.jobs !== 'object') throw new Error('portable-status-corrupt');
      return parsed.jobs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  }
  private recordStatus(source: string, slug: string, state: 'staged' | 'active' | 'error', root?: string, reason?: string): void {
    const jobs = this.readStatuses();
    jobs[`${source}:${slug}`] = { state, ...(root ? { root } : {}), ...(reason ? { reason: reason.slice(0, 80) } : {}), at: new Date().toISOString() };
    if (Object.keys(jobs).length > 1000) throw new Error('portable-status-full');
    const file = this.statusFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, jobs }), { mode: 0o600 });
    const tempFd = fs.openSync(tmp, fs.constants.O_RDONLY);
    try { fs.fsyncSync(tempFd); } finally { fs.closeSync(tempFd); }
    fs.renameSync(tmp, file);
    const dirFd = fs.openSync(path.dirname(file), fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0));
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  }
  /** Receiver: poll only a registered peer that advertised a portable job. */
  async pollPeer(peer: PoolPeerTarget & { kind: PeerEndpointKind }, observed: JobCoverageEntry, generation: string): Promise<{ root: string; staged: boolean }> {
    try { return await this.pollPeerVerified(peer, observed, generation); }
    catch (error) {
      this.recordStatus(peer.machineId, observed.slug, 'error', undefined, error instanceof Error ? error.message : 'transfer-failed');
      throw error;
    }
  }
  private async pollPeerVerified(peer: PoolPeerTarget & { kind: PeerEndpointKind }, observed: JobCoverageEntry, generation: string): Promise<{ root: string; staged: boolean }> {
    const slug = observed.slug;
    if (observed.portable !== true || !/^[a-f0-9]{12}:[a-f0-9]{64}$/.test(generation)) throw new Error('unsigned-observation');
    if (!SLUG.test(slug)) throw new Error('invalid-slug');
    const identity = this.options.identityManager.loadIdentity();
    const entry = this.options.identityManager.loadRegistry().machines[peer.machineId];
    if (!entry || !isRegistryEntryActive(entry)) throw new Error('unknown-source');
    if (!isPeerUrlAllowedForCredentials({ url: peer.url, kind: peer.kind }).ok) throw new Error('url-refused');
    const remote = this.options.identityManager.loadRemoteIdentity(peer.machineId);
    const signingKey = this.options.identityManager.getSigningPublicKeyPem(peer.machineId);
    if (!signingKey || !remote) throw new Error('source-key-missing');
    const request = makePortableBundleRequest(peer.machineId, identity.machineId, slug,
      randomBytes(32).toString('hex'), this.options.identityManager.loadSigningKey(),
      remote.keyEpoch ?? 0, identity.keyEpoch ?? 0);
    const response = await poolPeerFetch(this.options.recordRopeResult, peer, '/jobs/portable-bundle', {
      method: 'POST', headers: { Authorization: `Bearer ${this.options.authToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(request), signal: AbortSignal.timeout(3000), redirect: 'manual',
    });
    if (!response.ok) throw new Error(`http-${response.status}`);
    const wire = await boundedJson(response) as PortableBundleWire;
    const bundle = acceptPortableBundleWire(wire, request, signingKey,
      this.options.identityManager.loadEncryptionKey());
    const rawManifest = bundle.files.find(file => file.path === `.instar/jobs/schedule/${slug}.json`)!;
    const manifest = JSON.parse(Buffer.from(rawManifest.content, 'base64').toString('utf8'));
    if (manifest.schedule !== observed.schedule || (manifest.enabled !== false) !== observed.enabled
      || (manifest.catchUpPolicy ?? undefined) !== observed.catchUpPolicy
      || (Array.isArray(manifest.requiredPaths) ? manifest.requiredPaths.length : 0) !== (observed.dependencyCount ?? 0)
      || JSON.stringify(manifest.machines?.length ? manifest.machines : undefined) !== JSON.stringify(observed.machines))
      throw new Error('bundle-observation-mismatch');
    this.acceptGeneration(peer.machineId, bundle.slug, bundle.root, wire.generation);
    this.writeInbox(peer.machineId, bundle);
    featureEvidence.record('multiMachine.jobDefinitionSync', { kind: 'fired', reason: 'signed portable bundle staged',
      context: { source: peer.machineId, slug: bundle.slug } });
    if (!this.options.readOnly && !fs.existsSync(this.rollbackLatch)
      && this.activationApprovals.isApproved(bundle.slug, bundle.root)) {
      this.install(bundle, peer.machineId);
      this.recordStatus(peer.machineId, slug, 'active', bundle.root);
      return { root: bundle.root, staged: false };
    }
    this.recordStatus(peer.machineId, slug, 'staged', bundle.root);
    return { root: bundle.root, staged: true };
  }
  previewImport(sourceMachineId: string, slug: string): { root: string; files: Array<{ path: string; sha256: string }> } {
    const bundle = this.readInbox(sourceMachineId, slug);
    return { root: bundle.root, files: bundle.files.map(({ path: filePath, sha256 }) => ({ path: filePath, sha256 })) };
  }
  /** PIN-gated caller: a peer cannot activate a quarantined bundle. */
  approveImport(sourceMachineId: string, slug: string, expectedRoot: string): void {
    if (fs.existsSync(this.rollbackLatch)) throw new Error('portable-sync-disarmed');
    if (this.options.readOnly) throw new Error('preview-only');
    const bundle = this.readInbox(sourceMachineId, slug);
    if (bundle.root !== expectedRoot) throw new Error('content-root-changed');
    this.activationApprovals.approve(slug, bundle.root);
    this.install(bundle, sourceMachineId);
    this.recordStatus(sourceMachineId, slug, 'active', bundle.root);
  }
  revokeImport(slug: string): void {
    return this.fenced(() => this.revokeImportFenced(slug));
  }
  private revokeImportFenced(slug: string): void {
    this.activationApprovals.revoke(slug);
    this.quarantineImportedManifest(slug);
    for (const key of Object.keys(this.readStatuses()).filter(key => key.endsWith(`:${slug}`))) {
      const source = key.slice(0, key.indexOf(':'));
      this.recordStatus(source, slug, 'staged', undefined, 'activation-revoked');
    }
  }
  rollbackAll(): string[] {
    return this.fenced(() => this.rollbackAllFenced());
  }
  private rollbackAllFenced(): string[] {
    const journal = this.readImportJournal();
    const moved: string[] = [];
    fs.mkdirSync(path.dirname(this.rollbackLatch), { recursive: true });
    fs.writeFileSync(this.rollbackLatch, JSON.stringify({ disarmedAt: new Date().toISOString() }), { mode: 0o600 });
    for (const slug of Object.keys(journal)) {
      this.quarantineImportedManifest(slug);
      this.activationApprovals.revoke(slug);
      moved.push(slug);
    }
    for (const key of Object.keys(this.readStatuses())) {
      const [source, slug] = key.split(':');
      this.recordStatus(source, slug, 'staged', undefined, 'portable-sync-disarmed');
    }
    return moved;
  }
  rearm(): void {
    if (!fs.existsSync(this.rollbackLatch)) return;
    const pendingDir = path.join(this.options.stateDir, 'state', 'job-portable-pending');
    if (fs.existsSync(pendingDir) && fs.readdirSync(pendingDir).length > 0) throw new Error('pending-apply-needs-review');
    for (const slug of Object.keys(this.readImportJournal())) {
      if (fs.existsSync(path.join(this.options.stateDir, 'jobs', 'schedule', `${slug}.json`)))
        throw new Error('rollback-incomplete');
    }
    if (fs.existsSync(this.rollbackLatch)) SafeFsExecutor.safeRmSync(this.rollbackLatch, { operation: 'JobPortableSync.rearm' });
  }
  /** Bounded durable status index; no bundle or dependency bytes on the coverage hot path. */
  gaps(): string[] {
    try {
      return [...(fs.existsSync(this.rollbackLatch) ? ['Portable transfer disarmed after rollback'] : []),
        ...(fs.existsSync(path.join(this.options.stateDir, 'state', 'job-portable-pending'))
          ? fs.readdirSync(path.join(this.options.stateDir, 'state', 'job-portable-pending')).slice(0, 100)
            .map(name => `${name}: portable installation interrupted; job withheld`) : []),
        ...Object.entries(this.readImportJournal()).filter(([slug, row]) => row.state === 'pending'
          || !this.activationApprovals.isApproved(slug, row.root))
          .map(([slug, row]) => row.state === 'pending'
            ? `${slug}: portable installation interrupted; job withheld`
            : `${slug}: portable activation revoked; job withheld`),
        ...Object.entries(this.readStatuses()).filter(([, row]) => row.state !== 'active')
        .slice(0, 100).map(([key, row]) => `${key}: portable definition ${row.state}${row.reason ? ` (${row.reason})` : ' awaits local approval'}`)];
    } catch { return ['Portable transfer status unavailable; coverage cannot be proven']; }
  }
  private acceptGeneration(source: string, slug: string, root: string, generation: number): void {
    const file = path.join(this.options.stateDir, 'state', 'job-portable-received-generation.json');
    let rows: Record<string, { root: string; generation: number }> = {};
    try {
      const raw = fs.readFileSync(file, 'utf8');
      if (raw.length > 64 * 1024) throw new Error('received-generation-oversized');
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== 1 || typeof parsed.rows !== 'object') throw new Error('received-generation-corrupt');
      rows = parsed.rows;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const key = `${source}:${slug}`;
    const prior = rows[key];
    if (prior && (generation < prior.generation || (generation === prior.generation && root !== prior.root)))
      throw new Error('content-generation-rollback');
    rows[key] = { root, generation };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, rows }), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  private inboxPath(sourceMachineId: string, slug: string): string {
    if (!PEER_ID.test(sourceMachineId) || !SLUG.test(slug)) throw new Error('invalid-inbox-key');
    return path.join(this.inboxDir, sourceMachineId, `${slug}.json`);
  }
  private writeInbox(sourceMachineId: string, bundle: PortableJobBundle): void {
    const file = this.inboxPath(sourceMachineId, bundle.slug);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(bundle), { mode: 0o600 });
    fs.renameSync(tmp, file);
    this.recordStatus(sourceMachineId, bundle.slug, 'staged', bundle.root);
  }
  private readInbox(sourceMachineId: string, slug: string): PortableJobBundle {
    const raw = fs.readFileSync(this.inboxPath(sourceMachineId, slug), 'utf8');
    if (raw.length > MAX_WIRE) throw new Error('inbox-oversized');
    return validatePortableBundle(JSON.parse(raw));
  }
  private applyLatch(slug: string): string { return path.join(this.options.stateDir, 'state', 'job-portable-pending', `${slug}.json`); }
  private journalPath(): string { return path.join(this.options.stateDir, 'state', 'job-portable-import-journal.json'); }
  private readImportJournal(): Record<string, { source: string; root: string; manifestHash: string; owned?: Record<string, string>; state?: 'pending' | 'active'; previous?: { root: string; manifestHash: string }; expected?: Record<string, string> }> {
    try {
      const raw = fs.readFileSync(this.journalPath(), 'utf8');
      if (raw.length > 8 * 1024 * 1024) throw new Error('import-journal-oversized');
      const row = JSON.parse(raw);
      if (!row || row.version !== 1 || !row.jobs || typeof row.jobs !== 'object') throw new Error('import-journal-corrupt');
      return row.jobs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  }
  private writeImportJournal(jobs: Record<string, { source: string; root: string; manifestHash: string; owned?: Record<string, string>; state?: 'pending' | 'active'; previous?: { root: string; manifestHash: string }; expected?: Record<string, string> }>): void {
    const file = this.journalPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, jobs }), { mode: 0o600 });
    const tempFd = fs.openSync(tmp, fs.constants.O_RDONLY);
    try { fs.fsyncSync(tempFd); } finally { fs.closeSync(tempFd); }
    fs.renameSync(tmp, file);
    const dirFd = fs.openSync(path.dirname(file), fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0));
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  }
  private quarantineImportedManifest(slug: string): void {
    if (!SLUG.test(slug)) throw new Error('invalid-slug');
    const journal = this.readImportJournal();
    const record = journal[slug];
    if (!record) return;
    try {
      portableQuarantineIfHash(this.options.stateDir, `jobs/schedule/${slug}.json`,
        `state/job-portable-quarantine/${slug}-${record.root}.json`, record.manifestHash);
    } catch (error) {
      if (record.state !== 'pending' || !record.previous) throw error;
      portableQuarantineIfHash(this.options.stateDir, `jobs/schedule/${slug}.json`,
        `state/job-portable-quarantine/${slug}-${record.previous.root}.json`, record.previous.manifestHash);
    }
  }
  private fenced<T>(action: () => T): T {
    return this.options.withAdmissionFence ? this.options.withAdmissionFence(action) : action();
  }
  private install(bundle: PortableJobBundle, sourceMachineId: string): void {
    return this.fenced(() => this.installFenced(bundle, sourceMachineId));
  }
  private installFenced(bundle: PortableJobBundle, sourceMachineId: string): void {
    if (!this.activationApprovals.isApproved(bundle.slug, bundle.root)) throw new Error('activation-not-approved');
    const manifestPath = `.instar/jobs/schedule/${bundle.slug}.json`;
    const journal = this.readImportJournal();
    const prior = journal[bundle.slug];
    if (prior?.state === 'pending' || fs.existsSync(this.applyLatch(bundle.slug)))
      throw new Error('interrupted-import-needs-rollback');
    if (prior && prior.source !== sourceMachineId) throw new Error('import-source-conflict');
    const existingManifest = path.join(this.options.stateDir, 'jobs', 'schedule', `${bundle.slug}.json`);
    if (fs.existsSync(existingManifest) && !prior) throw new Error('local-job-ownership-conflict');
    const ordered = [...bundle.files].sort((a, b) => Number(a.path === manifestPath) - Number(b.path === manifestPath));
    let pendingWritten = false;
    const changed: Array<{ base: string; relative: string; hash: string; kind: 'created' | 'updated'; old: Buffer }> = [];
    const owned: Record<string, string> = {};
    const expected = Object.fromEntries(bundle.files.map(row => [row.path, row.sha256]));
    let latchWritten = false;
    try {
      const latch = this.applyLatch(bundle.slug);
      fs.mkdirSync(path.dirname(latch), { recursive: true, mode: 0o700 });
      fs.writeFileSync(latch, JSON.stringify({ slug: bundle.slug, root: bundle.root }), { mode: 0o600 });
      const latchFd = fs.openSync(latch, fs.constants.O_RDONLY);
      try { fs.fsyncSync(latchFd); } finally { fs.closeSync(latchFd); }
      const latchDirFd = fs.openSync(path.dirname(latch), fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0));
      try { fs.fsyncSync(latchDirFd); } finally { fs.closeSync(latchDirFd); }
      latchWritten = true;
      const plannedManifest = bundle.files.find(row => row.path === manifestPath)!;
      journal[bundle.slug] = { source: sourceMachineId, root: bundle.root,
        manifestHash: plannedManifest.sha256, owned, expected, state: 'pending',
        ...(prior ? { previous: { root: prior.root, manifestHash: prior.manifestHash } } : {}) };
      this.writeImportJournal(journal);
      pendingWritten = true;
      for (const row of ordered) {
        const isJob = row.path.startsWith('.instar/jobs/');
        if (!isJob && !validJobDependencyPath(row.path)) throw new Error('unsafe-destination');
        const base = isJob ? this.options.stateDir : this.options.projectDir;
        const relative = isJob ? row.path.slice('.instar/'.length) : row.path;
        const content = Buffer.from(row.content, 'base64');
        const result = portableWrite(base, relative, content, prior?.owned?.[row.path]);
        if (result.kind !== 'same') {
          changed.push({ base, relative, hash: row.sha256, kind: result.kind, old: result.old });
          owned[row.path] = row.sha256;
        } else if (prior?.owned?.[row.path] === row.sha256) {
          owned[row.path] = row.sha256;
        }
      }
      const manifest = bundle.files.find(row => row.path === manifestPath)!;
      journal[bundle.slug] = { source: sourceMachineId, root: bundle.root, manifestHash: manifest.sha256, owned, expected, state: 'active' };
      this.writeImportJournal(journal);
      SafeFsExecutor.safeRmSync(this.applyLatch(bundle.slug), { operation: 'JobPortableSync.completeApply' });
      latchWritten = false;
      featureEvidence.record('multiMachine.jobDefinitionSync', { kind: 'fired', reason: 'approved portable job installed',
        context: { source: sourceMachineId, slug: bundle.slug } });
    } catch (error) {
      let rollbackComplete = true;
      for (const row of changed.reverse()) {
        try {
          if (row.kind === 'created') portableRemoveIfHash(row.base, row.relative, row.hash);
          else portableWrite(row.base, row.relative, row.old, row.hash);
        } catch { rollbackComplete = false; /* changed after installation; preserve and withhold job */ }
      }
      if (pendingWritten && rollbackComplete) {
        try {
          if (prior) journal[bundle.slug] = prior; else delete journal[bundle.slug];
          this.writeImportJournal(journal);
          if (latchWritten) {
            SafeFsExecutor.safeRmSync(this.applyLatch(bundle.slug), { operation: 'JobPortableSync.rollbackApply' });
            latchWritten = false;
          }
        } catch { /* pending latch remains and loader refuses the job */ }
      }
      throw error;
    }
  }
}

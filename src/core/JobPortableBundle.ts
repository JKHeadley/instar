/** Private, opt-in scheduled-job file bundles. No peer byte is execution authority. */
import fs from 'node:fs';
import { portableRead, portableCollect } from './JobPortableFs.js';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateManifest, type PerSlugManifest } from '../scheduler/AgentMdJobLoader.js';
import { validJobDependencyPath } from './JobDependency.js';

const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const MAX_FILE = 256 * 1024;
const MAX_PLAINTEXT = 2 * 1024 * 1024;
const MAX_FILES = 64;
const MANIFEST_KEYS = new Set([
  'slug', 'origin', 'schedule', 'priority', 'model', 'framework', 'frameworkModel',
  'leanContext', 'thinkingMode', 'expectedDurationMinutes', 'enabled', 'catchUpPolicy', 'requiredPaths',
  'portable', 'execute', 'tags', 'topicId', 'telegramNotify', 'machines', 'gate',
  'unrestrictedTools', 'manifestVersion', 'perMachineIndependent', 'mcpAccess',
  'disabledAtBodyHash', 'completionAudit', 'declaredEffects', 'conditionalEffects',
]);
const EXECUTE_KEYS = new Set(['type', 'value', 'args']);

export interface PortableFile { path: string; sha256: string; content: string }
export interface PortableJobBundle {
  version: 1;
  slug: string;
  root: string;
  files: PortableFile[];
}

function sha(value: Buffer | string): string { return createHash('sha256').update(value).digest('hex'); }

/** Descriptor-relative walk refuses symlinks in every path component. */
function safeRead(root: string, relative: string): Buffer {
  if (!relative.startsWith('jobs/') && !validJobDependencyPath(relative)) throw new Error('unsafe-path');
  return portableRead(root, relative);
}

function addFile(files: PortableFile[], root: string, relative: string): void {
  if (files.length >= MAX_FILES) throw new Error('file-count-exceeded');
  const bytes = safeRead(root, relative);
  files.push({ path: relative, sha256: sha(bytes), content: bytes.toString('base64') });
}

/** Read a user manifest and only its declared files. Unknown manifest fields are refused. */
export function collectPortableJob(projectRoot: string, stateDir: string, slug: string): PortableJobBundle {
  if (!SLUG.test(slug)) throw new Error('invalid-slug');
  const jobsRoot = path.join(stateDir, 'jobs');
  const relativeManifest = `.instar/jobs/schedule/${slug}.json`;
  const absoluteManifest = path.join(jobsRoot, 'schedule', `${slug}.json`);
  const rawBytes = safeRead(stateDir, `jobs/schedule/${slug}.json`);
  const raw = JSON.parse(rawBytes.toString('utf8')) as Record<string, unknown>;
  if (Object.keys(raw).some(key => !MANIFEST_KEYS.has(key))) throw new Error('unknown-manifest-field');
  if (!raw.execute || typeof raw.execute !== 'object' || Array.isArray(raw.execute)
    || Object.keys(raw.execute as object).some(key => !EXECUTE_KEYS.has(key))) throw new Error('unknown-execute-field');
  const manifest: PerSlugManifest = validateManifest(raw, absoluteManifest);
  if (manifest.slug !== slug || manifest.origin !== 'user' || manifest.portable !== true
    || !Array.isArray(manifest.requiredPaths)) throw new Error('not-approved-portable-shape');
  if (manifest.machines?.length) throw new Error('machine-pinned');
  assertExecutableDeclared(manifest);
  const files: PortableFile[] = [{ path: relativeManifest, sha256: sha(rawBytes), content: rawBytes.toString('base64') }];
  const body = `.instar/jobs/user/${slug}.md`;
  if (manifest.execute.type === 'agentmd') {
    const bytes = safeRead(stateDir, `jobs/user/${slug}.md`);
    files.push({ path: body, sha256: sha(bytes), content: bytes.toString('base64') });
  }
  for (const dependency of manifest.requiredPaths) if (!validJobDependencyPath(dependency)) throw new Error('dependency-refused');
  files.push(...portableCollect(projectRoot, manifest.requiredPaths));
  const unique = new Set(files.map(file => file.path));
  if (unique.size !== files.length) throw new Error('duplicate-file');
  files.sort((a, b) => a.path.localeCompare(b.path));
  const root = sha(files.map(file => `${file.path}\0${file.sha256}\n`).join(''));
  const bundle: PortableJobBundle = { version: 1, slug, root, files };
  if (Buffer.byteLength(JSON.stringify(bundle)) > MAX_PLAINTEXT) throw new Error('bundle-oversized');
  return bundle;
}

/** Validate a decrypted bundle before storing any bytes. */
export function validatePortableBundle(value: unknown): PortableJobBundle {
  if (!value || typeof value !== 'object') throw new Error('invalid-bundle');
  const bundle = value as PortableJobBundle;
  if (bundle.version !== 1 || typeof bundle.slug !== 'string' || !SLUG.test(bundle.slug)
    || typeof bundle.root !== 'string' || !/^[a-f0-9]{64}$/.test(bundle.root)
    || !Array.isArray(bundle.files) || bundle.files.length > MAX_FILES
    || Buffer.byteLength(JSON.stringify(bundle)) > MAX_PLAINTEXT) throw new Error('invalid-bundle');
  const seen = new Set<string>();
  for (const file of bundle.files) {
    if (!file || typeof file.path !== 'string' || typeof file.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(file.sha256) || typeof file.content !== 'string'
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content)
      || seen.has(file.path)) throw new Error('invalid-file');
    const isManifest = file.path === `.instar/jobs/schedule/${bundle.slug}.json`;
    const isBody = file.path === `.instar/jobs/user/${bundle.slug}.md`;
    if (!isManifest && !isBody && !validJobDependencyPath(file.path)) throw new Error('invalid-path');
    const bytes = Buffer.from(file.content, 'base64');
    if (bytes.length > MAX_FILE || sha(bytes) !== file.sha256) throw new Error('invalid-file-hash');
    seen.add(file.path);
  }
  const manifestFile = bundle.files.find(file => file.path === `.instar/jobs/schedule/${bundle.slug}.json`);
  if (!manifestFile) throw new Error('manifest-missing');
  const raw = JSON.parse(Buffer.from(manifestFile.content, 'base64').toString('utf8')) as Record<string, unknown>;
  if (Object.keys(raw).some(key => !MANIFEST_KEYS.has(key)) || !raw.execute
    || typeof raw.execute !== 'object' || Array.isArray(raw.execute)
    || Object.keys(raw.execute as object).some(key => !EXECUTE_KEYS.has(key))) throw new Error('unknown-manifest-field');
  const manifest = validateManifest(raw);
  if (manifest.origin !== 'user' || manifest.slug !== bundle.slug || manifest.portable !== true
    || !Array.isArray(manifest.requiredPaths) || manifest.machines?.length) throw new Error('not-portable');
  const body = `.instar/jobs/user/${bundle.slug}.md`;
  if (manifest.execute.type === 'agentmd' && !seen.has(body)) throw new Error('body-missing');
  assertExecutableDeclared(manifest);
  for (const dependency of manifest.requiredPaths) {
    if (!seen.has(dependency) && ![...seen].some(file => file.startsWith(`${dependency}/`)))
      throw new Error('dependency-missing');
  }
  for (const file of bundle.files) {
    if (file.path.startsWith('.instar/jobs/')) {
      if (file.path !== manifestFile.path && file.path !== body) throw new Error('unexpected-job-file');
    } else if (!manifest.requiredPaths.some(dep => file.path === dep || file.path.startsWith(`${dep}/`))) {
      throw new Error('undeclared-dependency');
    }
  }
  const root = sha([...bundle.files].sort((a, b) => a.path.localeCompare(b.path))
    .map(file => `${file.path}\0${file.sha256}\n`).join(''));
  if (root !== bundle.root) throw new Error('root-mismatch');
  return bundle;
}

function assertExecutableDeclared(manifest: PerSlugManifest): void {
  if (manifest.execute.type !== 'script' && manifest.execute.type !== 'skill') return;
  const target = manifest.execute.value;
  if (!target || !validJobDependencyPath(target)
    || !manifest.requiredPaths?.some(dependency => target === dependency || target.startsWith(`${dependency}/`)))
    throw new Error('executable-dependency-undeclared');
}

/** Signed, recipient-bound transport. The shared Bearer token only admits HTTP. */
import { sign, verify } from './MachineIdentity.js';
import { encryptForSync, decryptFromSync, type EncryptedSecretPayload } from './SecretStore.js';
import crypto from 'node:crypto';

export interface PortableBundleRequest {
  version: 1; sourceMachineId: string; recipientMachineId: string; sourceKeyEpoch: number; recipientKeyEpoch: number; slug: string; nonce: string; signature: string;
}
export interface PortableBundleWire {
  version: 1; sourceMachineId: string; recipientMachineId: string; sourceKeyEpoch: number; recipientKeyEpoch: number; slug: string; nonce: string;
  root: string; generation: number; encrypted: EncryptedSecretPayload; signature: string;
}
const MACHINE_ID = /^m_[a-f0-9]{32}$/;
const NONCE = /^[a-f0-9]{64}$/;
function requestMessage(row: Omit<PortableBundleRequest, 'signature'>): string {
  return `instar-portable-job-request-v1|${JSON.stringify(row)}`;
}
export function makePortableBundleRequest(
  sourceMachineId: string, recipientMachineId: string, slug: string, nonce: string, privateKey: string,
  sourceKeyEpoch = 0, recipientKeyEpoch = 0,
): PortableBundleRequest {
  if (!MACHINE_ID.test(sourceMachineId) || !MACHINE_ID.test(recipientMachineId)
    || !SLUG.test(slug) || !NONCE.test(nonce) || !Number.isSafeInteger(sourceKeyEpoch)
    || sourceKeyEpoch < 0 || !Number.isSafeInteger(recipientKeyEpoch) || recipientKeyEpoch < 0) throw new Error('invalid-request');
  const row = { version: 1 as const, sourceMachineId, recipientMachineId, sourceKeyEpoch, recipientKeyEpoch, slug, nonce };
  return { ...row, signature: sign(requestMessage(row), privateKey) };
}
export function acceptPortableBundleRequest(
  value: unknown, expectedSource: string, publicKey: string,
): PortableBundleRequest {
  if (!value || typeof value !== 'object') throw new Error('invalid-request');
  const row = value as PortableBundleRequest;
  if (row.version !== 1 || row.sourceMachineId !== expectedSource
    || !MACHINE_ID.test(row.recipientMachineId) || !SLUG.test(row.slug) || !NONCE.test(row.nonce)
    || !Number.isSafeInteger(row.sourceKeyEpoch) || row.sourceKeyEpoch < 0
    || !Number.isSafeInteger(row.recipientKeyEpoch) || row.recipientKeyEpoch < 0
    || typeof row.signature !== 'string' || JSON.stringify(value).length > 1024) throw new Error('invalid-request');
  const unsigned = { version: 1 as const, sourceMachineId: row.sourceMachineId,
    recipientMachineId: row.recipientMachineId, sourceKeyEpoch: row.sourceKeyEpoch,
    recipientKeyEpoch: row.recipientKeyEpoch, slug: row.slug, nonce: row.nonce };
  if (!verify(requestMessage(unsigned), row.signature, publicKey)) throw new Error('invalid-request-signature');
  return row;
}
function bundleWireMessage(row: Omit<PortableBundleWire, 'signature'>): string {
  return `instar-portable-job-response-v1|${JSON.stringify(row)}`;
}
export function makePortableBundleWire(
  bundle: PortableJobBundle, request: PortableBundleRequest, sourcePrivateKey: string,
  recipientEncryptionPublicKey: string, generation: number,
): PortableBundleWire {
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('invalid-generation');
  const encrypted = encryptForSync({ bundle: JSON.stringify(bundle) }, recipientEncryptionPublicKey);
  const row = { version: 1 as const, sourceMachineId: request.sourceMachineId,
    recipientMachineId: request.recipientMachineId, sourceKeyEpoch: request.sourceKeyEpoch,
    recipientKeyEpoch: request.recipientKeyEpoch, slug: request.slug, nonce: request.nonce,
    root: bundle.root, generation, encrypted };
  if (Buffer.byteLength(JSON.stringify(row)) > 6 * 1024 * 1024) throw new Error('wire-oversized');
  return { ...row, signature: sign(bundleWireMessage(row), sourcePrivateKey) };
}
export function acceptPortableBundleWire(
  value: unknown, request: PortableBundleRequest, sourcePublicKey: string,
  recipientPrivateKeyPem: string,
): PortableJobBundle {
  if (!value || typeof value !== 'object' || Buffer.byteLength(JSON.stringify(value)) > 6 * 1024 * 1024)
    throw new Error('invalid-wire');
  const row = value as PortableBundleWire;
  if (row.version !== 1 || row.sourceMachineId !== request.sourceMachineId
    || row.recipientMachineId !== request.recipientMachineId
    || row.sourceKeyEpoch !== request.sourceKeyEpoch || row.recipientKeyEpoch !== request.recipientKeyEpoch
    || row.slug !== request.slug
    || row.nonce !== request.nonce || !/^[a-f0-9]{64}$/.test(row.root)
    || !Number.isSafeInteger(row.generation) || row.generation < 1
    || typeof row.signature !== 'string' || !row.encrypted || typeof row.encrypted !== 'object')
    throw new Error('invalid-wire');
  const unsigned = { version: 1 as const, sourceMachineId: row.sourceMachineId,
    recipientMachineId: row.recipientMachineId, sourceKeyEpoch: row.sourceKeyEpoch,
    recipientKeyEpoch: row.recipientKeyEpoch, slug: row.slug, nonce: row.nonce,
    root: row.root, generation: row.generation, encrypted: row.encrypted };
  if (!verify(bundleWireMessage(unsigned), row.signature, sourcePublicKey)) throw new Error('invalid-wire-signature');
  const opened = decryptFromSync(row.encrypted, crypto.createPrivateKey(recipientPrivateKeyPem));
  if (typeof opened.bundle !== 'string') throw new Error('invalid-plaintext');
  const bundle = validatePortableBundle(JSON.parse(opened.bundle));
  if (bundle.slug !== row.slug || bundle.root !== row.root) throw new Error('root-mismatch');
  return bundle;
}

export class PortableApprovalStore {
  private readonly file: string;
  constructor(stateDir: string, private readonly kind: 'export' | 'activate') {
    this.file = path.join(stateDir, 'state', `job-portable-${kind}-approval.json`);
  }
  private read(): Record<string, { root: string; approvedAt: string }> {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      if (raw.length > 64 * 1024) return {};
      const row = JSON.parse(raw);
      return row && row.version === 1 && row.approvals && typeof row.approvals === 'object'
        ? row.approvals : {};
    } catch { return {}; }
  }
  isApproved(slug: string, root: string): boolean {
    const row = this.read()[slug];
    return row?.root === root && Number.isFinite(Date.parse(row.approvedAt));
  }
  approve(slug: string, root: string): void {
    if (!SLUG.test(slug) || !/^[a-f0-9]{64}$/.test(root)) throw new Error('invalid-approval');
    const approvals = this.read();
    approvals[slug] = { root, approvedAt: new Date().toISOString() };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, kind: this.kind, approvals }), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  revoke(slug: string): void {
    const approvals = this.read();
    delete approvals[slug];
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, kind: this.kind, approvals }), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

/** Source-owned monotonic content version, advanced only with an exact-root export approval. */
export class PortableGenerationStore {
  private readonly file: string;
  constructor(stateDir: string) { this.file = path.join(stateDir, 'state', 'job-portable-generation.json'); }
  private read(): Record<string, { root: string; generation: number }> {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      if (raw.length > 64 * 1024) throw new Error('generation-store-oversized');
      const row = JSON.parse(raw);
      if (!row || row.version !== 1 || !row.jobs || typeof row.jobs !== 'object')
        throw new Error('generation-store-corrupt');
      return row.jobs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  }
  current(slug: string, root: string): number | null {
    const row = this.read()[slug];
    return row?.root === root && Number.isSafeInteger(row.generation) && row.generation > 0
      ? row.generation : null;
  }
  advance(slug: string, root: string): number {
    if (!SLUG.test(slug) || !/^[a-f0-9]{64}$/.test(root)) throw new Error('invalid-generation-key');
    const jobs = this.read();
    const prior = jobs[slug];
    const generation = prior?.root === root ? prior.generation : (prior?.generation ?? 0) + 1;
    if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('generation-exhausted');
    jobs[slug] = { root, generation };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, jobs }), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    return generation;
  }
}

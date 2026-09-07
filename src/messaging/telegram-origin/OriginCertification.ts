import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { verify } from 'node:crypto';
import { canonicalOrigin, originDigest, parseOriginJson, wireDigest } from './CanonicalOrigin.js';

export const ORIGIN_CERTIFICATE_PATH = 'src/data/telegramOriginCertification.json';
export const ORIGIN_RELEASE_KEY_PATH = 'dist/keys/instar-release-pub.pem';
export const ORIGIN_CERTIFICATE_DOMAIN = 'instar-telegram-origin-release-certification-v1\n';
export const ORIGIN_REQUIRED_TRIALS = ['text', 'browser', 'hidden-display', 'attachment', 'cross-machine-relay'] as const;
export interface OriginReleaseCertification {
  schema: 'instar-telegram-origin-release-certification-v1';
  approvedAt: number;
  expiresAt: number;
  reviewEvidenceDigest: string;
  buildDigest: string;
  producers: Array<{ producerId: string; entrypoints: string[];
    authorContract: 'deterministic' | 'actual-call' | 'session-observer' | 'forwarded-or-explicit-unknown' | 'mixed-explicit';
    bindingEvidenceDigest: string }>;
  census: { complete: true; entrypoints: string[]; evidenceDigest: string };
  trials: Array<{ kind: typeof ORIGIN_REQUIRED_TRIALS[number]; completedAt: number; passed: true; evidenceDigest: string }>;
  signature: string;
}
export type OriginCertificationResult = { state: 'ready'; certificate: OriginReleaseCertification; verifiedAt: number; validUntil: number }
  | { state: 'unknown'; reason: string; verifiedAt: number; validUntil: number };

async function boundedFile(file: string, max: number): Promise<Buffer> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > max) throw new Error('origin-certification-file-bound');
    // A concurrent writer cannot make readFile allocate past the original bound.
    const buffer = Buffer.alloc(Math.min(max + 1, stat.size + 1));
    let size = 0;
    while (size < buffer.length) {
      const read = await handle.read(buffer, size, buffer.length - size, null);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size !== stat.size) throw new Error('origin-certification-file-changed');
    return buffer.subarray(0, size);
  } finally { await handle.close(); }
}

/** Fingerprint the independently discovered package payload, never a certificate's
 * chosen file list. package.json binds the shipped roots; every file under each
 * root participates (including scripts, templates and maps). Only the certificate
 * is excluded to avoid a self-hash cycle. Issue against the final packaged bytes.
 */
export async function fingerprintOriginPackage(root: string): Promise<{ digest: string; files: Set<string> }> {
  const manifest = await boundedFile(path.join(root, 'package.json'), 1024 * 1024);
  const pkg = parseOriginJson(manifest.toString()) as unknown as { name?: string; files?: unknown };
  const roots = pkg.files;
  if (pkg.name !== 'instar' || !Array.isArray(roots) || roots.length > 100 ||
    !['dist', 'src/templates', 'src/data', 'scripts'].every(required => roots.includes(required))) throw new Error('origin-certification-package-roots');
  const files = new Set<string>(['package.json']);
  const hashes: Array<[string, string]> = [['package.json', wireDigest(manifest)]];
  let bytes = manifest.length, entries = 0;
  const validPath = (value: unknown): value is string => typeof value === 'string' && value.length < 512 &&
    !value.includes('\\') && !path.isAbsolute(value) && value.split('/').every(part => !!part && part !== '.' && part !== '..' && !/[*?\[\]{}]/.test(part));
  const visit = async (relative: string, depth: number): Promise<void> => {
    if (relative === ORIGIN_CERTIFICATE_PATH || files.has(relative)) return;
    if (++entries > 15000 || depth > 24) throw new Error('origin-certification-tree-bound');
    const full = path.join(root, relative), stat = await lstat(full);
    if (stat.isSymbolicLink()) throw new Error('origin-certification-symlink');
    if (stat.isDirectory()) {
      const children = await readdir(full);
      if (children.length > 15000) throw new Error('origin-certification-tree-bound');
      for (const child of children.sort()) await visit(`${relative}/${child}`, depth + 1);
    } else {
      const content = await boundedFile(full, Math.min(32 * 1024 * 1024, 256 * 1024 * 1024 - bytes));
      bytes += content.length;
      if (bytes > 256 * 1024 * 1024) throw new Error('origin-certification-byte-bound');
      files.add(relative); hashes.push([relative, wireDigest(content)]);
    }
  };
  for (const item of [...new Set(roots)]) {
    if (!validPath(item)) throw new Error('origin-certification-package-roots');
    await visit(item, 0);
  }
  return { digest: originDigest(hashes.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)), files };
}

/** Uses only the package-wide Instar release authority. No agent/account key,
 * artifact-provided key, HTTP assertion or version/HEAD string is trusted. */
export async function inspectOriginCertification(root: string, now = Date.now()): Promise<OriginCertificationResult> {
  const unknown = (reason: string): OriginCertificationResult => ({ state: 'unknown', reason, verifiedAt: now, validUntil: now + 30_000 });
  let bytes: Buffer;
  try { bytes = await boundedFile(path.join(root, ORIGIN_CERTIFICATE_PATH), 2 * 1024 * 1024); }
  catch (error) { return unknown((error as NodeJS.ErrnoException).code === 'ENOENT'
    ? 'origin-release-certification-not-installed:release-pipeline-issuance-required' : 'origin-release-certification-unreadable'); }
  return verifyOriginCertificationCandidate(root, bytes.toString(), now);
}

/** Release tooling validates in memory before publishing any certificate bytes.
 * The installed consumer uses this exact authority/schema/build verifier too. */
export async function verifyOriginCertificationCandidate(root: string, bytes: string, now = Date.now()): Promise<OriginCertificationResult> {
  const unknown = (reason: string): OriginCertificationResult => ({ state: 'unknown', reason, verifiedAt: now, validUntil: now + 30_000 });
  let key: Buffer;
  try { key = await boundedFile(path.join(root, ORIGIN_RELEASE_KEY_PATH), 16 * 1024); }
  catch { return unknown('origin-release-certification-authority-unavailable'); }
  try {
    const certificate = parseOriginJson(bytes, 2 * 1024 * 1024) as unknown as OriginReleaseCertification;
    const { signature, ...body } = certificate;
    if (certificate.schema !== 'instar-telegram-origin-release-certification-v1' || typeof signature !== 'string' ||
      !verify(null, Buffer.from(ORIGIN_CERTIFICATE_DOMAIN + canonicalOrigin(body)), key, Buffer.from(signature, 'base64url'))) return unknown('origin-release-certification-signature-invalid');
    if (!Number.isSafeInteger(certificate.approvedAt) || !Number.isSafeInteger(certificate.expiresAt) ||
      certificate.approvedAt > now || certificate.approvedAt < 0 || certificate.expiresAt <= now) return unknown('origin-release-certification-expired-or-future');
    const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
    if (!digest(certificate.reviewEvidenceDigest) || !digest(certificate.buildDigest) ||
      !Array.isArray(certificate.producers) || certificate.producers.length === 0 || certificate.producers.length > 500 ||
      certificate.census?.complete !== true || !digest(certificate.census.evidenceDigest) ||
      !Array.isArray(certificate.census.entrypoints) || certificate.census.entrypoints.length === 0 || certificate.census.entrypoints.length > 1000 ||
      !Array.isArray(certificate.trials) || certificate.trials.length !== ORIGIN_REQUIRED_TRIALS.length) return unknown('origin-release-certification-coverage-invalid');
    const build = await fingerprintOriginPackage(root);
    if (build.digest !== certificate.buildDigest) return unknown('origin-release-certification-build-mismatch');
    const entrypoint = (value: unknown) => typeof value === 'string' && build.files.has(value) && value !== ORIGIN_RELEASE_KEY_PATH && /\.(?:[cm]?js|sh)$/.test(value);
    const census = new Set(certificate.census.entrypoints);
    const ids = new Set<string>();
    if (!certificate.census.entrypoints.every(entrypoint)) return unknown('origin-release-certification-census-invalid');
    for (const producer of certificate.producers) {
      if (!/^[a-z0-9][a-z0-9._/-]{0,127}$/i.test(producer.producerId) || ids.has(producer.producerId) ||
        !['deterministic', 'actual-call', 'session-observer', 'forwarded-or-explicit-unknown', 'mixed-explicit'].includes(producer.authorContract) ||
        !digest(producer.bindingEvidenceDigest) || !Array.isArray(producer.entrypoints) || !producer.entrypoints.length || producer.entrypoints.length > 100 ||
        !producer.entrypoints.every(file => entrypoint(file) && census.has(file))) return unknown('origin-release-certification-producer-binding-invalid');
      ids.add(producer.producerId);
    }
    for (const kind of ORIGIN_REQUIRED_TRIALS) {
      const trials = certificate.trials.filter(trial => trial.kind === kind);
      if (trials.length !== 1 || trials[0].passed !== true || !digest(trials[0].evidenceDigest) ||
        !Number.isSafeInteger(trials[0].completedAt) || trials[0].completedAt < 0 || trials[0].completedAt > certificate.approvedAt) return unknown('origin-release-certification-trials-invalid');
    }
    return { state: 'ready', certificate, verifiedAt: now, validUntil: Math.min(certificate.expiresAt, now + 30_000) };
  } catch { return unknown('origin-release-certification-invalid-or-build-unavailable'); }
}

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { verifySignedLockFileContent } from '../scheduler/AgentMdLockFile.js';
import { installedPackageRoot } from './installedSafeMerge.js';

// The reviewed Instar release key's SPKI digest, independent of package files.
// Rotating this authority requires a reviewed code change.
const RELEASE_KEY_SHA256 = '12e3fb25ab9cfd87591e550b07434a0c492ead03f66c8b6e1eae548a883eed6e';
const LOCK_PATH = ['dist', 'jobs', 'instar.lock.json'];
const KEY_PATH = ['dist', 'keys', 'instar-release-pub.pem'];
const PROBER_PATH = ['scripts', 'doorway-scan.mjs'];
const CATALOG_PATH = ['scripts', 'model-registry-freshness.manifest.json'];

type AssetFailure = { status: 'unavailable' | 'tampered'; reason: string };
type VerifiedCatalog = { status: 'verified'; lastReviewedAt: string; catalog: Record<string, unknown> };
export type VerifiedPackagedCatalogResult = VerifiedCatalog | AssetFailure;
export type VerifiedPackagedDoorwayAssetsResult =
  | (VerifiedCatalog & { catalogBytes: Buffer; proberBytes: Buffer })
  | AssetFailure;

function sha256(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function readPackagedBytes(root: string, segments: string[], maximum: number): Buffer {
  if (!fs.lstatSync(root).isDirectory()) throw new Error('package-root-not-directory');
  let file = root;
  for (const segment of segments.slice(0, -1)) {
    file = path.join(file, segment);
    if (!fs.lstatSync(file).isDirectory()) throw new Error('package-path-not-directory');
  }
  file = path.join(file, segments[segments.length - 1]);
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.size > maximum) throw new Error('package-file-invalid');
  const handle = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const opened = fs.fstatSync(handle);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > maximum) {
      throw new Error('package-file-changed');
    }

    const buffer = Buffer.alloc(opened.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const count = fs.readSync(handle, buffer, offset, buffer.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== opened.size) throw new Error('package-file-changed');
    return buffer.subarray(0, offset);
  } finally {
    fs.closeSync(handle);
  }
}

function failure(reason: string, error: unknown): AssetFailure {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === 'ENOENT' || code === 'EACCES' || code === 'EPERM'
    ? { status: 'unavailable', reason }
    : { status: 'tampered', reason };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Read once from the installed server package. The caller supplies its running release version. */
export function readVerifiedInstalledCatalog(expectedVersion: string): VerifiedPackagedCatalogResult {
  return readVerifiedPackagedCatalog(installedPackageRoot(), expectedVersion, RELEASE_KEY_SHA256);
}

/** Exact-asset verifier. The pinned SPKI hash must come from the trusted caller, never the package. */
export function readVerifiedPackagedCatalog(
  packageRoot: string,
  expectedVersion: string,
  trustedSpkiSha256: string,
): VerifiedPackagedCatalogResult {
  return readVerifiedAssets(packageRoot, expectedVersion, trustedSpkiSha256, false);
}

/** Verify the two assets against the same pinned, version-matched signed lock. */
export function readVerifiedPackagedDoorwayAssets(
  packageRoot: string,
  expectedVersion: string,
  trustedSpkiSha256: string,
): VerifiedPackagedDoorwayAssetsResult {
  return readVerifiedAssets(packageRoot, expectedVersion, trustedSpkiSha256, true);
}

function readVerifiedAssets(
  packageRoot: string, expectedVersion: string, trustedSpkiSha256: string, includeProber: true,
): VerifiedPackagedDoorwayAssetsResult;
function readVerifiedAssets(
  packageRoot: string, expectedVersion: string, trustedSpkiSha256: string, includeProber: false,
): VerifiedPackagedCatalogResult;
function readVerifiedAssets(
  packageRoot: string, expectedVersion: string, trustedSpkiSha256: string, includeProber: boolean,
): VerifiedPackagedCatalogResult | VerifiedPackagedDoorwayAssetsResult {
  let lockBytes: Buffer;
  try {
    lockBytes = readPackagedBytes(packageRoot, LOCK_PATH, 64 * 1024);
  } catch (error) {
    return failure('catalog-lock-unavailable-or-invalid', error);
  }

  let key: crypto.KeyObject;
  try {
    key = crypto.createPublicKey(readPackagedBytes(packageRoot, KEY_PATH, 16 * 1024));
  } catch (error) {
    return failure('catalog-key-unavailable-or-invalid', error);
  }
  const spki = key.export({ type: 'spki', format: 'der' });
  if (key.asymmetricKeyType !== 'ed25519' || sha256(spki) !== trustedSpkiSha256) {
    return { status: 'tampered', reason: 'catalog-key-pin-mismatch' };
  }

  const lock = verifySignedLockFileContent(lockBytes, key);
  if (lock.state !== 'present-trusted') return { status: 'tampered', reason: 'catalog-lock-invalid' };
  if (lock.lockFile.instarVersion !== expectedVersion) {
    return { status: 'tampered', reason: 'catalog-release-version-mismatch' };
  }
  if (!lock.lockFile.catalogHash) return { status: 'unavailable', reason: 'catalog-digest-absent' };

  let bytes: Buffer;
  try {
    bytes = readPackagedBytes(packageRoot, CATALOG_PATH, 1024 * 1024);
  } catch (error) {
    return failure('catalog-file-unavailable-or-invalid', error);
  }
  if (`sha256:${sha256(bytes)}` !== lock.lockFile.catalogHash) {
    return { status: 'tampered', reason: 'catalog-digest-mismatch' };
  }

  let catalog: unknown;
  try {
    catalog = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return { status: 'tampered', reason: 'catalog-schema-invalid' };
  }
  if (!isObject(catalog) || !isObject(catalog.doors)
    || typeof catalog.lastReviewedAt !== 'string'
    || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}(?:T[0-9:.]+Z)?$/.test(catalog.lastReviewedAt)
    || !Number.isFinite(Date.parse(catalog.lastReviewedAt))) {
    return { status: 'tampered', reason: 'catalog-schema-invalid' };
  }
  const verified = { status: 'verified' as const, lastReviewedAt: catalog.lastReviewedAt, catalog };
  if (!includeProber) return verified;
  if (!lock.lockFile.proberHash) return { status: 'unavailable', reason: 'prober-digest-absent' };

  let proberBytes: Buffer;
  try {
    proberBytes = readPackagedBytes(packageRoot, PROBER_PATH, 1024 * 1024);
  } catch (error) {
    return failure('prober-file-unavailable-or-invalid', error);
  }
  if (`sha256:${sha256(proberBytes)}` !== lock.lockFile.proberHash) {
    return { status: 'tampered', reason: 'prober-digest-mismatch' };
  }
  return { ...verified, catalogBytes: bytes, proberBytes };
}

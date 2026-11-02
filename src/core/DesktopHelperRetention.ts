/**
 * DesktopHelperRetention: one kept copy of the Mac desktop helper per Mac, at
 * one path that updates never touch.
 *
 * macOS ties a Screen Recording or Accessibility grant to the exact program.
 * For an ad-hoc signed helper that means its hash, and for a helper with no app
 * bundle it means its path too. So the installed copy is a poor place to hold a
 * grant: each agent on a Mac has its own, and an update can replace its bytes.
 * The kept copy changes only when the helper's SOURCE changes (the build writes
 * a source hash beside the binary), so a rebuild of unchanged source on a newer
 * toolchain cannot cost a grant, and every agent on a Mac shares one macOS
 * entry. A Developer ID identity later keeps that same entry across source
 * changes too, because the path never moves.
 *
 * When the source really does change, the old grant cannot follow it. This
 * module records that fact so the machine can say so plainly.
 *
 * Every failure falls back to the installed copy with a named reason: this
 * module may never make a Mac less reachable than it already was.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from './SafeFsExecutor.js';

export const HELPER_MANIFEST_SUFFIX = '.json';
export const RETAINED_HELPER_NAME = 'instar-desktop-host';
const RECORD_NAME = 'retained.json';
const FAT_MAGIC = 0xcafebabe;

export type DesktopHelperFallback =
  | 'disabled' | 'no-manifest' | 'not-release-build' | 'older-than-retained'
  | 'same-version-different-source' | 'retained-unsafe' | 'retained-unrunnable' | 'copy-failed';

export interface DesktopHelperRecord {
  sourceHash: string;
  binarySha256: string;
  packageVersion: string;
  /** The source hash this Mac last proved it holds the helper's own grant for. */
  grantedSourceHash: string | null;
  replacedAt: string;
}

export interface DesktopHelperResolution {
  path: string;
  source: 'retained' | 'packaged';
  reason?: DesktopHelperFallback;
}

/** Why a missing permission needs a person. `same-program` means a grant was
 * removed by someone or something else, so no update story applies. */
export type DesktopHelperPermissionChange =
  | { kind: 'source-changed'; version: string; helperPath: string }
  | { kind: 'first-grant'; version: string; helperPath: string };

export interface DesktopHelperRetentionOptions {
  packagedBinary: string;
  packageVersion: string;
  /** Default `~/.instar/desktop-helper`. */
  root?: string;
  enabled?: boolean;
  log?: (message: string) => void;
}

export function helperManifestPath(binary: string): string {
  return `${binary}${HELPER_MANIFEST_SUFFIX}`;
}

/** Plain numeric comparison: instar versions are dotted integers. */
export function compareVersions(a: string, b: string): number {
  const parts = (value: string) => value.split('.').map(part => Number.parseInt(part, 10) || 0);
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export class DesktopHelperRetention {
  readonly root: string;
  readonly retainedPath: string;
  private readonly recordPath: string;
  private readonly enabled: boolean;
  private readonly log: (message: string) => void;
  /** Verifying means hashing, so it reruns only when the kept file changes. */
  private verified: { size: number; mtimeMs: number; ino: number; resolution: DesktopHelperResolution } | null = null;
  private broken = false;

  constructor(private readonly options: DesktopHelperRetentionOptions) {
    this.root = options.root ?? path.join(os.homedir(), '.instar', 'desktop-helper');
    this.retainedPath = path.join(this.root, RETAINED_HELPER_NAME);
    this.recordPath = path.join(this.root, RECORD_NAME);
    this.enabled = options.enabled !== false;
    this.log = options.log ?? (message => console.warn(message));
  }

  private packaged(reason: DesktopHelperFallback): DesktopHelperResolution {
    return { path: this.options.packagedBinary, source: 'packaged', reason };
  }

  private packagedSourceHash(): string | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(helperManifestPath(this.options.packagedBinary), 'utf8')) as { sourceHash?: unknown };
      return typeof parsed.sourceHash === 'string' && /^[a-f0-9]{64}$/.test(parsed.sourceHash) ? parsed.sourceHash : null;
    } catch {
      return null; // @silent-fallback-ok — resolve() reports this as the named reason no-manifest.
    }
  }

  /** A local development build is thin. Only a release build may take the Mac's
   * one kept copy, so a test checkout can never replace what is granted. */
  private isReleaseBuild(): boolean {
    let handle: number | null = null;
    try {
      handle = fs.openSync(this.options.packagedBinary, 'r');
      const head = Buffer.alloc(4);
      return fs.readSync(handle, head, 0, 4, 0) === 4 && head.readUInt32BE(0) === FAT_MAGIC;
    } catch {
      return false; // @silent-fallback-ok — resolve() reports this as not-release-build.
    } finally {
      if (handle !== null) fs.closeSync(handle);
    }
  }

  private readRecord(): DesktopHelperRecord | null {
    try {
      const value = JSON.parse(fs.readFileSync(this.recordPath, 'utf8')) as Partial<DesktopHelperRecord>;
      if (typeof value.sourceHash !== 'string' || typeof value.binarySha256 !== 'string'
        || typeof value.packageVersion !== 'string') return null;
      return {
        sourceHash: value.sourceHash, binarySha256: value.binarySha256, packageVersion: value.packageVersion,
        grantedSourceHash: typeof value.grantedSourceHash === 'string' ? value.grantedSourceHash : null,
        replacedAt: typeof value.replacedAt === 'string' ? value.replacedAt : '',
      };
    } catch {
      return null; // @silent-fallback-ok — no readable record means the copy is reinstalled from the package.
    }
  }

  private writeRecord(record: DesktopHelperRecord): void {
    const temporary = `${this.recordPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.recordPath);
  }

  /** The kept copy runs with the Mac's permissions, so it must be a plain file
   * this user owns that nobody else can write, in a folder with the same rule. */
  private safeToRun(): boolean {
    try {
      const uid = process.getuid?.();
      for (const candidate of [this.root, this.retainedPath]) {
        const stat = fs.lstatSync(candidate);
        if (stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o022) !== 0) return false;
      }
      return fs.lstatSync(this.retainedPath).isFile();
    } catch {
      return false; // @silent-fallback-ok — an unreadable copy is unsafe; resolve() names retained-unsafe.
    }
  }

  /** The rename means a helper already running keeps its old file, and macOS
   * never sees a signed program change underneath a live process. */
  private install(sourceHash: string, grantedSourceHash: string | null): void {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const temporary = `${this.retainedPath}.${process.pid}.tmp`;
    fs.copyFileSync(this.options.packagedBinary, temporary);
    fs.chmodSync(temporary, 0o700);
    fs.renameSync(temporary, this.retainedPath);
    this.writeRecord({
      sourceHash, binarySha256: sha256(this.retainedPath), packageVersion: this.options.packageVersion,
      grantedSourceHash,
      replacedAt: new Date().toISOString(),
    });
  }

  /** Which helper to launch. Synchronous and cheap on the repeat path. */
  resolve(): DesktopHelperResolution {
    if (!this.enabled) return this.packaged('disabled');
    if (this.broken) return this.packaged('retained-unrunnable');
    try {
      const stat = fs.statSync(this.retainedPath);
      if (this.verified && this.verified.size === stat.size && this.verified.mtimeMs === stat.mtimeMs
        && this.verified.ino === stat.ino) return this.verified.resolution;
    } catch { /* @silent-fallback-ok — no kept copy yet; the full path below creates it. */ }
    const resolution = this.resolveFully();
    if (resolution.source === 'retained') {
      const stat = fs.statSync(this.retainedPath);
      this.verified = { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, resolution };
    } else {
      this.verified = null;
    }
    return resolution;
  }

  private resolveFully(): DesktopHelperResolution {
    const sourceHash = this.packagedSourceHash();
    if (!sourceHash) return this.packaged('no-manifest');
    if (!this.isReleaseBuild()) return this.packaged('not-release-build');
    const record = this.readRecord();
    const fileExists = fs.existsSync(this.retainedPath);
    if (record && record.sourceHash !== sourceHash) {
      const order = compareVersions(this.options.packageVersion, record.packageVersion);
      // Agents on one Mac update minutes apart. The older one must not swap
      // the helper back and cost the newer one its grant.
      if (order < 0) return this.packaged('older-than-retained');
      if (order === 0) return this.packaged('same-version-different-source');
    }
    const intact = !!record && record.sourceHash === sourceHash && fileExists
      && this.safeToRun() && sha256(this.retainedPath) === record.binarySha256;
    if (intact) return { path: this.retainedPath, source: 'retained' };
    if (record?.sourceHash === sourceHash && fileExists) {
      this.log('[instar] retained Mac desktop helper failed its integrity check; restoring it from this package');
    }
    try {
      // A real source change keeps the old proof, which is how the Mac can say
      // the helper changed. Restoring a damaged copy writes bytes macOS has not
      // seen, so the proof is gone and the Mac must say it needs a grant.
      this.install(sourceHash, record && record.sourceHash !== sourceHash ? record.grantedSourceHash : null);
    } catch (error) {
      this.log(`[instar] could not keep a Mac desktop helper copy: ${error instanceof Error ? error.message : String(error)}`);
      return this.packaged('copy-failed');
    }
    return this.safeToRun() ? { path: this.retainedPath, source: 'retained' } : this.packaged('retained-unsafe');
  }

  /** The kept copy would not run at all, so stop using it until a restart. */
  markBroken(): void {
    this.broken = true;
    this.verified = null;
    this.log('[instar] retained Mac desktop helper would not run; using the installed copy');
  }

  /** The kept copy holds its own grant for its current source. */
  noteGranted(): void {
    const record = this.readRecord();
    if (!record || record.grantedSourceHash === record.sourceHash) return;
    this.writeRecord({ ...record, grantedSourceHash: record.sourceHash });
    this.releaseNotice();
  }

  /** Null when the missing permission has nothing to do with an update. */
  permissionChange(): DesktopHelperPermissionChange | null {
    const record = this.readRecord();
    if (!record) return null;
    const base = { version: record.packageVersion, helperPath: this.retainedPath };
    if (!record.grantedSourceHash) return { kind: 'first-grant', ...base };
    return record.grantedSourceHash === record.sourceHash ? null : { kind: 'source-changed', ...base };
  }

  /** The source hash this notice is about. Stable across agents on this Mac. */
  currentSourceHash(): string | null {
    return this.readRecord()?.sourceHash ?? null;
  }

  private noticePath(): string | null {
    const hash = this.currentSourceHash();
    return hash ? path.join(this.root, `notice-${hash.slice(0, 16)}`) : null;
  }

  /** True for the first caller on this Mac for this helper. One Mac, one item.
   * Creating the marker is atomic, so agents restarting together cannot both win. */
  claimNotice(): boolean {
    const marker = this.noticePath();
    if (!marker) return false;
    try {
      fs.writeFileSync(marker, '', { flag: 'wx', mode: 0o600 });
      return true;
    } catch {
      return false; // @silent-fallback-ok — the marker exists, so another agent holds this notice.
    }
  }

  /** Hands the notice back when raising it failed, or once it is resolved. */
  releaseNotice(): void {
    const marker = this.noticePath();
    if (marker) SafeFsExecutor.safeRmSync(marker, { force: true, operation: 'src/core/DesktopHelperRetention.ts:releaseNotice' });
  }
}

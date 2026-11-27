/**
 * The helper's index of installed-package sets (docs/specs/local-verify-borrowed-slices-count.md,
 * C "Packages are installed only from merged code", and Build decisions "The package cache
 * survives the daily re-creation").
 *
 * The packages themselves live inside the sandbox, on their own volume beside the sandbox image
 * (root-owned there, read-only to `builder` and `tester`). This file is the HOST's record of what
 * that volume should hold, kept outside the sandbox where nothing a test runs can reach it:
 *
 *  - the key is the install-inputs hash (../installInputs.ts);
 *  - `mergedCommit` is the merged commit the packages were installed from. An entry is written
 *    only after the helper's own merged check passed for that commit and `npm ci` ran in that
 *    commit's tree, so "this hash was produced by merged code" survives a restart and the daily
 *    sandbox re-creation with the packages;
 *  - `manifestDigest` is the digest of the manifest of file hashes the sandbox wrote at install.
 *    Before every use the sandbox recomputes the manifest and the host compares it with this
 *    value; a difference discards the set (the entry here and the files there).
 *
 * A missing or unreadable file means nothing is cached (install again from merged code).
 */
import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from '../../core/SafeFsExecutor.js';
import { SHA256_HEX_RE, SHA40_RE } from './helperProtocol.js';

export interface PackageSet {
  /** The install-inputs hash: 64 hex characters. */
  hash: string;
  /** The merged commit whose tree `npm ci` ran in. */
  mergedCommit: string;
  /** sha256 of the manifest the sandbox wrote when it locked the packages. */
  manifestDigest: string;
  installedAt: string;
  lastUsedAt: string;
}

interface IndexFile { v: 1; sets: PackageSet[] }

/** Package sets kept on the volume: the current package list and the two before it. */
export const PACKAGE_SETS_MAX = 3;

function parseSet(v: unknown): PackageSet | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.hash !== 'string' || !SHA256_HEX_RE.test(o.hash)) return null;
  if (typeof o.mergedCommit !== 'string' || !SHA40_RE.test(o.mergedCommit)) return null;
  if (typeof o.manifestDigest !== 'string' || !SHA256_HEX_RE.test(o.manifestDigest)) return null;
  if (typeof o.installedAt !== 'string' || typeof o.lastUsedAt !== 'string') return null;
  return { hash: o.hash, mergedCommit: o.mergedCommit, manifestDigest: o.manifestDigest, installedAt: o.installedAt, lastUsedAt: o.lastUsedAt };
}

export class HelperPackageIndex {
  private readonly file: string;
  constructor(stateDir: string, private readonly now: () => number = () => Date.now()) {
    this.file = path.join(stateDir, 'state', 'local-verify', 'helper-packages.json');
  }

  private load(): PackageSet[] {
    let raw: unknown;
    try { raw = JSON.parse(fs.readFileSync(this.file, 'utf-8')); } catch { return []; } // @silent-fallback-ok: no readable index means nothing is cached; packages are installed again from merged code
    if (!raw || typeof raw !== 'object' || (raw as { v?: unknown }).v !== 1 || !Array.isArray((raw as { sets?: unknown }).sets)) return [];
    const out: PackageSet[] = [];
    for (const s of (raw as { sets: unknown[] }).sets.slice(0, PACKAGE_SETS_MAX * 2)) {
      const p = parseSet(s);
      if (p && !out.some((x) => x.hash === p.hash)) out.push(p);
    }
    return out;
  }

  private save(sets: PackageSet[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const f: IndexFile = { v: 1, sets };
    SafeFsExecutor.atomicWriteJsonSync(this.file, f, { operation: 'local-verify:helper-packages' });
  }

  get(hash: string): PackageSet | null {
    return this.load().find((s) => s.hash === hash) ?? null;
  }

  list(): PackageSet[] { return this.load(); }

  touch(hash: string): void {
    const sets = this.load();
    const s = sets.find((x) => x.hash === hash);
    if (!s) return;
    s.lastUsedAt = new Date(this.now()).toISOString();
    this.save(sets);
  }

  /**
   * Record a set installed from `mergedCommit`. Returns the hashes pushed out by the cap (least
   * recently used first), for the caller to delete from the volume.
   */
  record(hash: string, mergedCommit: string, manifestDigest: string): string[] {
    if (!SHA256_HEX_RE.test(hash) || !SHA40_RE.test(mergedCommit) || !SHA256_HEX_RE.test(manifestDigest)) throw new Error('package set: malformed');
    const at = new Date(this.now()).toISOString();
    const sets = this.load().filter((s) => s.hash !== hash);
    sets.push({ hash, mergedCommit, manifestDigest, installedAt: at, lastUsedAt: at });
    sets.sort((a, b) => a.lastUsedAt.localeCompare(b.lastUsedAt));
    const evicted = sets.splice(0, Math.max(0, sets.length - PACKAGE_SETS_MAX)).map((s) => s.hash);
    this.save(sets);
    return evicted;
  }

  remove(hash: string): void {
    const sets = this.load();
    if (sets.some((s) => s.hash === hash)) this.save(sets.filter((s) => s.hash !== hash));
  }

  /** `instar helper uninstall`. */
  clear(): void {
    try { SafeFsExecutor.safeRmSync(this.file, { force: true, operation: 'local-verify:helper-packages' }); } catch { /* @silent-fallback-ok: nothing to remove */ }
  }
}

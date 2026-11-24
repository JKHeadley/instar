/** Verifier-owned copies of built runtime bytes. Not an OS sandbox for privileged same-UID code. */
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import { targetBuildDescription, validateTargetBuild, type TargetBuildHandle, type TargetBuildDescription, type TargetResource } from './targetBuild.js';

export interface SnapshotBudget { maxEntries: number; maxDepth: number; maxBytes: number }
interface Directory { file: string; mode: number }
interface Link { file: string; text: string; targetFile: string }
interface RuntimeResource extends TargetResource { mode: number }
interface Inventory { resources: RuntimeResource[]; directories: Directory[]; symlinks: Link[] }
export interface RuntimeSnapshotDescription extends Omit<TargetBuildDescription, 'root' | 'dependencyCoverage' | 'resources' | 'digest'> {
  readonly root: string; readonly digest: string; readonly sourceDigest: string;
  readonly sourceRuntimeDigest: string; readonly sourceSymlinks: readonly Readonly<Link>[];
  readonly dependencyCoverage: 'whole-installed-runtime';
  readonly resources: readonly RuntimeResource[];
  readonly directories: readonly Readonly<Directory>[];
  readonly symlinks: readonly Readonly<Link>[];
}
declare const snapshotBrand: unique symbol;
export interface RuntimeSnapshotHandle { readonly [snapshotBrand]: true }
export class RuntimeSnapshotUnavailableError extends Error {
  readonly name = 'RuntimeSnapshotUnavailableError';
  constructor(readonly reason: string, cause?: unknown) { super(`Runtime snapshot unavailable: ${reason}`, { cause }); }
}
interface SnapshotState {
  description: RuntimeSnapshotDescription; active: boolean; check: () => void;
  children: Map<string, boolean>; pendingLaunches: number; budget: SnapshotBudget;
}
const snapshots = new WeakMap<object, SnapshotState>();
const ROOTS = ['dist', 'src/data', 'dashboard', 'node_modules'] as const;
const FILES = ['package.json', 'package-lock.json', 'tsconfig.json'] as const;
function validBudget(value: unknown): value is SnapshotBudget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 3 || !['maxEntries','maxDepth','maxBytes'].every(key => Object.prototype.hasOwnProperty.call(value,key))) return false;
  const budget = value as SnapshotBudget;
  return [budget.maxEntries,budget.maxDepth,budget.maxBytes].every(limit => Number.isSafeInteger(limit) && limit > 0);
}
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
function relative(file: string): boolean { return !!file && !path.isAbsolute(file) && !file.includes('\\') && file.split('/').every(p => !!p && p !== '.' && p !== '..'); }
function copied(file: string): boolean { return (FILES as readonly string[]).includes(file) || ROOTS.some(root => file === root || file.startsWith(root + '/')); }
function state(handle: RuntimeSnapshotHandle): SnapshotState {
  const owned = handle && typeof handle === 'object' ? snapshots.get(handle) : undefined;
  if (!owned || !owned.active) throw new RuntimeSnapshotUnavailableError('released-or-unregistered-custody');
  owned.check(); return owned;
}
async function fileDigest(filename: string, maxBytes: number, check: () => void): Promise<{ bytes: number; sha256: string }> {
  check();
  const input = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await input.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new RuntimeSnapshotUnavailableError('byte-capacity');
    const digest = createHash('sha256'), buffer = Buffer.alloc(64 * 1024); let bytes = 0;
    for (;;) {
      check(); const result = await input.read(buffer, 0, buffer.length, null); check();
      if (!result.bytesRead) break;
      bytes += result.bytesRead;
      if (bytes > maxBytes) throw new RuntimeSnapshotUnavailableError('byte-capacity');
      digest.update(buffer.subarray(0, result.bytesRead));
    }
    return { bytes, sha256: digest.digest('hex') };
  } finally { await input.close(); }
}
async function inventory(root: string, budget: SnapshotBudget, check: () => void): Promise<Inventory> {
  const result: Inventory = { resources: [], directories: [], symlinks: [] };
  let entries = 2, total = 0; // Include the owned root and materialized src layout parent.
  const walk = async (file: string, depth: number): Promise<void> => {
    check();
    if (++entries > budget.maxEntries) throw new RuntimeSnapshotUnavailableError('entry-capacity');
    if (file.split('/').length > budget.maxDepth) throw new RuntimeSnapshotUnavailableError('depth-capacity');
    const filename = path.join(root, file), stat = await fs.lstat(filename); check();
    if (stat.isSymbolicLink()) {
      const text = await fs.readlink(filename), resolved = await fs.realpath(filename); check();
      const targetFile = path.relative(root, resolved).split(path.sep).join('/');
      if (!resolved.startsWith(root + path.sep) || !relative(targetFile) || !copied(targetFile)) throw new RuntimeSnapshotUnavailableError('symlink-outside-runtime');
      result.symlinks.push({ file, text, targetFile });
    } else if (stat.isDirectory()) {
      result.directories.push({ file, mode: stat.mode & 0o777 });
      for await (const entry of await fs.opendir(filename, { bufferSize: 32 })) await walk(`${file}/${entry.name}`, depth + 1);
    } else if (stat.isFile()) {
      const digest = await fileDigest(filename, budget.maxBytes - total, check); total += digest.bytes;
      result.resources.push({ file, ...digest, mode: stat.mode & 0o777 });
    } else throw new RuntimeSnapshotUnavailableError('nonregular-resource');
  };
  // src is a materialized layout parent, not a mount of all candidate source.
  result.directories.push({ file: 'src', mode: (await fs.lstat(path.join(root, 'src'))).mode & 0o777 });
  for (const file of [...FILES, ...ROOTS]) await walk(file, 0);
  for (const rows of [result.resources, result.directories, result.symlinks]) rows.sort((a, b) => a.file.localeCompare(b.file, 'en'));
  check(); return result;
}
function freezeInventory(value: Inventory): Inventory {
  for (const rows of [value.resources, value.directories, value.symlinks]) { for (const row of rows) Object.freeze(row); Object.freeze(rows); }
  return Object.freeze(value);
}
function expectedCopy(source: Inventory): Inventory {
  return {
    resources: source.resources.map(row => ({ ...row, mode: row.mode & 0o111 ? 0o555 : 0o444 })),
    directories: source.directories.map(row => ({ file: row.file, mode: 0o555 })),
    symlinks: source.symlinks.map(row => ({ ...row, text: path.relative(path.dirname(row.file), row.targetFile) || '.' })),
  };
}
async function thawAndRemove(root: string, verifyRoot: string): Promise<void> {
  // Never follow links when restoring cleanup access.
  const thaw = async (filename: string): Promise<void> => {
    const stat = await fs.lstat(filename);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      await fs.chmod(filename, 0o700);
      for await (const entry of await fs.opendir(filename, { bufferSize: 32 })) await thaw(path.join(filename, entry.name));
    }
  };
  await thaw(root);
  await SafeFsExecutor.safeRmTreeSerial(root, { operation: 'design-runtime-snapshot:dispose', localVerifyScopeOk: { verifyRoot } });
}
/** Internal verifier capability: roots/budgets come from installed Local Verify, never candidate JSON. */
export async function createRuntimeSnapshotOwner(input: {
  verifyRoot: string; runDir: string; runId: string; deadlineAt: number; budget: SnapshotBudget;
  now?: () => number; signal?: AbortSignal;
  onEvent?: (event: { kind: 'copy-file'; file: string }) => void | Promise<void>;
  /** Trusted installation journals the internally chosen exact root before it can exist. */
  admitRoot?: (root: string) => Promise<void>;
}) {
  const now = input.now ?? Date.now, signal = input.signal, deadlineAt = input.deadlineAt, runId = input.runId, onEvent = input.onEvent, admitRoot = input.admitRoot, budget = Object.freeze({ ...input.budget });
  if (!runId || !Number.isFinite(deadlineAt) || !validBudget(budget)) throw new RuntimeSnapshotUnavailableError('invalid-owned-budget');
  const verifyRoot = await fs.realpath(input.verifyRoot), runDir = await fs.realpath(input.runDir);
  if (!runDir.startsWith(path.join(verifyRoot, 'runs') + path.sep)) throw new RuntimeSnapshotUnavailableError('source-outside-owned-runs');
  const parent = path.join(verifyRoot, 'design-targets');
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  if (await fs.realpath(parent) !== parent || !(await fs.lstat(parent)).isDirectory()) throw new RuntimeSnapshotUnavailableError('snapshot-parent-escaped');
  await fs.chmod(parent, 0o700);
  const ownedDirectories = new Set<string>(), issued: SnapshotState[] = [];
  let active = true, building = false;
  const check = () => {
    if (!active) throw new RuntimeSnapshotUnavailableError('released-custody');
    if (signal?.aborted) throw new RuntimeSnapshotUnavailableError('aborted');
    if (now() >= deadlineAt) throw new RuntimeSnapshotUnavailableError('deadline');
  };
  return Object.freeze({
    async materialize(source: TargetBuildHandle): Promise<RuntimeSnapshotHandle> {
      check(); if (building || issued.length) throw new RuntimeSnapshotUnavailableError('owner-already-used');
      const sourceDescription = targetBuildDescription(source);
      if (sourceDescription.root !== runDir || sourceDescription.runId !== runId) throw new RuntimeSnapshotUnavailableError('wrong-source-owner');
      building = true;
      let destination: string | undefined;
      try {
        await validateTargetBuild(source); check();
        const before = await inventory(runDir, budget, check);
        if (admitRoot) {
          const planned = path.join(parent, `runtime-${randomBytes(16).toString('hex')}`);
          await admitRoot(planned); check();
          await fs.mkdir(planned, { mode: 0o700 }); destination = planned;
        } else destination = await fs.mkdtemp(path.join(parent, 'runtime-'));
        ownedDirectories.add(destination); check();
        for (const directory of [...before.directories].sort((a, b) => a.file.split('/').length - b.file.split('/').length)) {
          check(); await fs.mkdir(path.join(destination, directory.file), { recursive: true, mode: 0o700 });
        }
        for (const file of before.resources) {
          check(); await onEvent?.({ kind: 'copy-file', file: file.file }); check();
          const sourceFile = path.join(runDir, file.file), targetFile = path.join(destination, file.file);
          const sourceFd = await fs.open(sourceFile, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const output = await fs.open(targetFile, 'wx', 0o600);
            try {
              const buffer = Buffer.alloc(64 * 1024), digest = createHash('sha256'); let bytes = 0;
              for (;;) {
                check(); const read = await sourceFd.read(buffer, 0, buffer.length, null); check();
                if (!read.bytesRead) break;
                bytes += read.bytesRead; if (bytes > file.bytes) throw new RuntimeSnapshotUnavailableError('source-mutated-during-copy');
                digest.update(buffer.subarray(0, read.bytesRead));
                let offset = 0;
                while (offset < read.bytesRead) { check(); const written = await output.write(buffer, offset, read.bytesRead - offset); if (!written.bytesWritten) throw new RuntimeSnapshotUnavailableError('copy-write-stalled'); offset += written.bytesWritten; }
              }
              if (bytes !== file.bytes || digest.digest('hex') !== file.sha256) throw new RuntimeSnapshotUnavailableError('source-mutated-during-copy');
            } finally { await output.close(); }
            const sourceStat = await sourceFd.stat(), targetStat = await fs.stat(targetFile);
            if (sourceStat.dev === targetStat.dev && sourceStat.ino === targetStat.ino) throw new RuntimeSnapshotUnavailableError('shared-source-inode');
            await fs.chmod(targetFile, file.mode & 0o111 ? 0o555 : 0o444);
          } finally { await sourceFd.close(); }
        }
        for (const link of before.symlinks) { check(); await fs.symlink(path.relative(path.dirname(link.file), link.targetFile) || '.', path.join(destination, link.file)); }
        if (JSON.stringify(before) !== JSON.stringify(await inventory(runDir, budget, check))) throw new RuntimeSnapshotUnavailableError('source-mutated-during-copy');
        await validateTargetBuild(source); check();
        for (const directory of [...before.directories].sort((a,b) => b.file.split('/').length - a.file.split('/').length)) await fs.chmod(path.join(destination, directory.file), 0o555);
        await fs.chmod(destination, 0o500); check();
        const actual = await inventory(destination, budget, check), expected = expectedCopy(before);
        if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new RuntimeSnapshotUnavailableError('snapshot-copy-mismatch');
        for (const file of actual.resources) if ((await fs.lstat(path.join(destination, file.file))).mode & 0o222) throw new RuntimeSnapshotUnavailableError('snapshot-writable');
        // Check actual enforcement, not only advertised Unix mode bits. Root-like identities are unavailable.
        const probe = await fs.open(path.join(destination, actual.resources[0].file), 'r+').then(fd => ({ fd }), error => ({ error }));
        if ('fd' in probe) { await probe.fd.close(); throw new RuntimeSnapshotUnavailableError('readonly-permissions-not-enforced'); }
        if (!['EACCES','EPERM','EROFS'].includes((probe.error as NodeJS.ErrnoException).code ?? '')) throw new RuntimeSnapshotUnavailableError('readonly-probe-failed', probe.error);
        const { digest: sourceDigest, root: _sourceRoot, resources: _sourceResources, dependencyCoverage: _coverage, ...identity } = sourceDescription;
        const frozen = freezeInventory(actual);
        const sourceSymlinks = Object.freeze(before.symlinks.map(link => Object.freeze({ ...link })));
        const body = { ...identity, root: destination, sourceDigest, sourceRuntimeDigest: hash(JSON.stringify(before)), sourceSymlinks, dependencyCoverage: 'whole-installed-runtime' as const, ...frozen };
        const description = Object.freeze({ ...body, digest: hash(JSON.stringify(body)) });
        const value: SnapshotState = { description, active: true, check, children: new Map(), pendingLaunches: 0, budget };
        check(); const handle = Object.freeze({}) as RuntimeSnapshotHandle; snapshots.set(handle, value); issued.push(value); return handle;
      } catch (error) {
        if (destination && ownedDirectories.has(destination)) { try { await thawAndRemove(destination, verifyRoot); ownedDirectories.delete(destination); } catch { /* Owner retains failed cleanup for release(). */ } }
        if (error instanceof RuntimeSnapshotUnavailableError) throw error;
        throw new RuntimeSnapshotUnavailableError('materialization-failed', error);
      } finally { building = false; }
    },
    /** Reserve custody BEFORE spawn; this port is held only by the trusted launcher. */
    reserveChildLaunch(handle: RuntimeSnapshotHandle) {
      const value = state(handle);
      if (!issued.includes(value)) throw new RuntimeSnapshotUnavailableError('invalid-child-owner');
      value.pendingLaunches++;
      const launchId = randomBytes(16).toString('hex');
      let settled = false, admitted = false;
      return Object.freeze({
        /** Immediately before the launcher's real synchronous spawn call. */
        beforeSpawn(): void {
          if (settled || admitted) throw new RuntimeSnapshotUnavailableError('child-launch-already-used');
          state(handle); admitted = true;
        },
        /** Past-outcome recording, NOT permission to spawn; survives expiry/revocation. */
        started(child: { pid: number; exit: Promise<{ pid: number; observed: true }> }): { admitted: boolean } {
          if (settled || !Number.isSafeInteger(child.pid) || child.pid <= 0) throw new RuntimeSnapshotUnavailableError('invalid-child-owner');
          const pid = child.pid;
          value.children.set(launchId, false); value.pendingLaunches--; settled = true;
          if (!admitted) value.active = false; // Retain actual cleanup custody, never certify an unadmitted launch.
          void child.exit.then(receipt => { if (receipt.observed === true && receipt.pid === pid) value.children.set(launchId, true); }, () => { /* Rejection retains unconfirmed exit. */ });
          return { admitted };
        },
        /** Only the actual launcher may report a proven failure BEFORE any process existed. */
        notStarted(): void {
          if (settled) throw new RuntimeSnapshotUnavailableError('child-launch-already-used');
          settled = true; value.pendingLaunches--;
        },
      });
    },
    async release(): Promise<{ status: 'released' | 'cleanup-unconfirmed'; roots: readonly string[] }> {
      active = false; for (const value of issued) value.active = false;
      if (building || issued.some(value => value.pendingLaunches > 0 || [...value.children.values()].some(exited => !exited))) return { status: 'cleanup-unconfirmed', roots: [...ownedDirectories] };
      for (const directory of [...ownedDirectories]) { try { await thawAndRemove(directory, verifyRoot); ownedDirectories.delete(directory); } catch { return { status: 'cleanup-unconfirmed', roots: [...ownedDirectories] }; } }
      return { status: 'released', roots: [] };
    },
  });
}
export function runtimeSnapshotDescription(handle: RuntimeSnapshotHandle): RuntimeSnapshotDescription { return state(handle).description; }
export async function validateRuntimeSnapshot(handle: RuntimeSnapshotHandle, requestedBudget?: SnapshotBudget): Promise<void> {
  const value = state(handle), expected = value.description;
  if (requestedBudget !== undefined && !validBudget(requestedBudget)) throw new RuntimeSnapshotUnavailableError('invalid-owned-budget');
  const budget = requestedBudget ? { maxEntries: Math.min(value.budget.maxEntries, requestedBudget.maxEntries), maxDepth: Math.min(value.budget.maxDepth, requestedBudget.maxDepth), maxBytes: Math.min(value.budget.maxBytes, requestedBudget.maxBytes) } : value.budget;
  if (!validBudget(budget)) throw new RuntimeSnapshotUnavailableError('invalid-owned-budget');
  const current = await inventory(expected.root, budget, () => { state(handle); });
  if (JSON.stringify(current.resources) !== JSON.stringify(expected.resources) || JSON.stringify(current.directories) !== JSON.stringify(expected.directories) || JSON.stringify(current.symlinks) !== JSON.stringify(expected.symlinks)
    || (await fs.lstat(expected.root)).mode & 0o222) throw new RuntimeSnapshotUnavailableError('snapshot-mutated');
  for (const file of current.resources) if ((await fs.lstat(path.join(expected.root, file.file))).mode & 0o222) throw new RuntimeSnapshotUnavailableError('snapshot-writable');
  try {
    if (!Number.isSafeInteger(expected.nodeExecutableBytes) || expected.nodeExecutableBytes <= 0) throw new Error('Missing observed Node executable size');
    const executable = await fileDigest(process.execPath, expected.nodeExecutableBytes, () => { state(handle); });
    if (executable.bytes !== expected.nodeExecutableBytes || executable.sha256 !== expected.nodeExecutableSha256) throw new Error('Node executable bytes differ');
  } catch (error) { state(handle); throw new RuntimeSnapshotUnavailableError('node-executable-changed', error); }
  state(handle);
}
export async function createRuntimeSnapshotLaunchObservation(handle: RuntimeSnapshotHandle, budget?: SnapshotBudget) {
  await validateRuntimeSnapshot(handle, budget);
  const target = runtimeSnapshotDescription(handle);
  return Object.freeze({ version: 1 as const, runId: target.runId, nonce: randomBytes(32).toString('hex'), target });
}

/** Registry membership only; serialization never transfers this capability. */
export function isRuntimeSnapshotHandle(handle: unknown): handle is RuntimeSnapshotHandle { return !!handle && typeof handle === 'object' && snapshots.has(handle); }

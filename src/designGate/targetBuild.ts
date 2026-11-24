/** Trusted verifier observations of built bytes; not candidate-authored build attestations. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';

export interface TargetBuildIdentity {
  runId: string; side: 'base' | 'merge'; baseSha: string; tree: string;
  nodeVersion: string; compilerIdentity: string;
}
export interface TargetResource { readonly file: string; readonly bytes: number; readonly sha256: string }
export interface TargetCommand { phase: 'install' | 'build'; command: string; args: readonly string[] }
export interface TargetCommandObservation extends TargetCommand { readonly invocationId: string; readonly startedAt: number; readonly finishedAt: number; readonly status: number | null }
export interface TargetBuildDescription extends TargetBuildIdentity {
  readonly root: string; readonly digest: string; readonly commands: readonly Readonly<TargetCommandObservation>[];
  readonly resources: readonly TargetResource[];
  readonly nodeExecutableSha256: string;
  readonly nodeExecutableBytes: number;
  /** Full production dependency custody is not established by this slice. */
  readonly dependencyCoverage: 'compiler-only';
}
declare const targetBrand: unique symbol;
export interface TargetBuildHandle { readonly [targetBrand]: true }
interface OwnedTarget { description: TargetBuildDescription; checkSource: () => Promise<void>; active: boolean }
const handles = new WeakMap<object, OwnedTarget>();
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const TREES = ['dist', 'src/data', 'dashboard'] as const;
const INPUTS = ['package.json', 'package-lock.json', 'tsconfig.json'] as const;
const COMPILER_FILES = ['package.json', 'bin/tsc', 'lib/tsc.js', 'lib/getExePath.js'] as const;
// Finite defensive manifest bounds, not behavioral approval policy.
const MAX_FILES = 50_000, MAX_ENTRIES = 50_000, MAX_DEPTH = 64, MAX_BYTES = 1024 * 1024 * 1024;
export class TargetBuildUnavailableError extends Error {
  readonly name = 'TargetBuildUnavailableError';
  constructor(readonly reason: 'compiler-package-unavailable' | 'native-compiler-unavailable', cause: unknown) {
    super(`Target build unavailable: ${reason}`, { cause });
  }
}
function relativeFile(file: string): boolean {
  return !!file && !path.isAbsolute(file) && !file.includes('\\') && file.split('/').every(part => !!part && part !== '.' && part !== '..');
}
async function checkedFile(root: string, file: string): Promise<Buffer> {
  if (!relativeFile(file)) throw new Error('Invalid target resource path');
  const absolute = path.join(root, file), real = await fs.realpath(absolute);
  if (real !== absolute || !real.startsWith(root + path.sep)) throw new Error('Target resource symlink or escape');
  const stat = await fs.lstat(absolute);
  if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('Invalid target resource');
  return fs.readFile(absolute);
}
async function manifest(root: string): Promise<readonly TargetResource[]> {
  const files: string[] = [...INPUTS];
  let compilerRoot: string;
  try { compilerRoot = await fs.realpath(path.join(root, 'node_modules/typescript-native')); }
  catch (error) { throw new TargetBuildUnavailableError('compiler-package-unavailable', error); }
  if (!compilerRoot.startsWith(root + path.sep)) throw new Error('Compiler is outside target');
  let nativeRoot: string;
  try {
    const nativePackage = createRequire(path.join(compilerRoot, 'package.json')).resolve(`@typescript/typescript-${process.platform}-${process.arch}/package.json`);
    nativeRoot = await fs.realpath(path.dirname(nativePackage));
    // Optional platform packages may be missing or partially installed. That is unavailable evidence.
    await checkedFile(root, path.relative(root, path.join(nativeRoot, 'package.json')).split(path.sep).join('/'));
    await checkedFile(root, path.relative(root, path.join(nativeRoot, 'lib', process.platform === 'win32' ? 'tsc.exe' : 'tsc')).split(path.sep).join('/'));
  } catch (error) { throw new TargetBuildUnavailableError('native-compiler-unavailable', error); }
  if (!nativeRoot.startsWith(root + path.sep)) throw new Error('Native compiler is outside target');
  for (const file of COMPILER_FILES) files.push(path.relative(root, path.join(compilerRoot, file)).split(path.sep).join('/'));
  files.push(path.relative(root, path.join(nativeRoot, 'package.json')).split(path.sep).join('/'), path.relative(root, path.join(nativeRoot, 'lib', process.platform === 'win32' ? 'tsc.exe' : 'tsc')).split(path.sep).join('/'));
  let visited = files.length;
  const walk = async (relative: string, depth = 0): Promise<void> => {
    if (depth > MAX_DEPTH) throw new Error('Target manifest depth capacity');
    if (++visited > MAX_ENTRIES) throw new Error('Target manifest entry capacity');
    const absolute = path.join(root, relative), stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) throw new Error('Target resource symlink');
    if (stat.isDirectory()) {
      // Stream names; never materialize a caller-controlled directory before checking its budget.
      // Async directory iteration closes its handle when a bound/error ends the traversal.
      for await (const entry of await fs.opendir(absolute, { bufferSize: 32 })) await walk(`${relative}/${entry.name}`, depth + 1);
    } else if (stat.isFile()) { files.push(relative); if (files.length > MAX_FILES) throw new Error('Target manifest capacity'); }
    else throw new Error('Nonregular target resource');
  };
  for (const tree of TREES) await walk(tree);
  const entries: TargetResource[] = []; let total = 0;
  for (const file of files.sort()) {
    const bytes = await checkedFile(root, file); total += bytes.length;
    if (total > MAX_BYTES) throw new Error('Target manifest capacity');
    entries.push(Object.freeze({ file, bytes: bytes.length, sha256: sha(bytes) }));
  }
  return Object.freeze(entries);
}
function owned(handle: TargetBuildHandle): OwnedTarget {
  const value = handle && typeof handle === 'object' ? handles.get(handle) : undefined;
  if (!value || !value.active) throw new Error('Unregistered or released target build handle');
  return value;
}
/** Called only by trusted verifier wiring. Its callbacks are verifier capabilities, never JSON input. */
export async function createTargetBuildAuthority(input: {
  root: string; identity: Omit<TargetBuildIdentity, 'nodeVersion' | 'compilerIdentity'> & Partial<Pick<TargetBuildIdentity, 'nodeVersion' | 'compilerIdentity'>>;
  readSourceIdentity: () => Promise<{ tree: string; clean: boolean }>;
}) {
  const ownedRoot = input.root, readSourceIdentity = input.readSourceIdentity;
  const root = await fs.realpath(ownedRoot), identity = Object.freeze({ ...input.identity });
  if (!/^[a-f0-9]{40}$/.test(identity.tree) || !/^[a-f0-9]{40}$/.test(identity.baseSha)
    || !identity.runId || !['base', 'merge'].includes(identity.side)) throw new Error('Invalid verifier target identity');
  const checkSource = async () => {
    if (await fs.realpath(ownedRoot) !== root) throw new Error('Target root changed');
    const actual = await readSourceIdentity();
    if (actual.tree !== identity.tree || !actual.clean) throw new Error('Target source binding changed');
  };
  await checkSource();
  const initialInputs = await Promise.all(INPUTS.map(async file => [file, sha(await checkedFile(root, file))]));
  const commands: Readonly<TargetCommandObservation>[] = [];
  let issued: TargetBuildHandle | undefined;
  let install = false, build = false, failed = false, executing = false, sealed = false, released = false;
  return Object.freeze({
    /** Wraps the existing real exec; never starts an additional install or build. */
    async observeCommand<T extends { status: number | null }>(command: TargetCommand, execute: () => Promise<T>): Promise<T> {
      if (sealed || executing || failed || !command.command || !Array.isArray(command.args) || !['install','build'].includes(command.phase)
        || command.phase === 'build' && !install) throw new Error('Invalid target build phase');
      const invocation = Object.freeze({ phase: command.phase, command: command.command, args: Object.freeze([...command.args]) });
      const invocationId = randomBytes(16).toString('hex'), startedAt = Date.now();
      executing = true;
      try {
        const result = await execute();
        commands.push(Object.freeze({ ...invocation, invocationId, startedAt, finishedAt: Date.now(), status: result.status }));
        if (result.status !== 0) { failed = true; build = false; }
        else if (invocation.phase === 'install') { install = true; build = false; }
        else { build = true; }
        return result;
      } catch (error) { failed = true; throw error; }
      finally { executing = false; }
    },
    async seal(): Promise<TargetBuildHandle> {
      if (sealed || executing || !install || !build || failed) throw new Error('No complete observed target build');
      sealed = true;
      await checkSource();
      const resources = await manifest(root);
      await checkSource();
      for (const [file, digest] of initialInputs) if (sha(await checkedFile(root, file)) !== digest) throw new Error('Target build inputs changed');
      const compilerIdentity = sha(JSON.stringify(resources.filter(entry => entry.file.startsWith('node_modules/'))));
      const nodeExecutable = await fs.readFile(process.execPath);
      const body = { ...identity, dependencyCoverage: 'compiler-only' as const, nodeVersion: process.version, compilerIdentity, nodeExecutableSha256: sha(nodeExecutable), nodeExecutableBytes: nodeExecutable.length, root, commands: Object.freeze([...commands]), resources };
      const description = Object.freeze({ ...body, digest: sha(JSON.stringify(body)) });
      if (released) throw new Error('Target custody released');
      const handle = Object.freeze({}) as TargetBuildHandle;
      handles.set(handle, { description, checkSource, active: true }); sealed = true; issued = handle;
      return handle;
    },
    release(): void { released = true; if (issued) { const value = handles.get(issued); if (value) value.active = false; } sealed = true; },
  });
}
export function targetBuildDescription(handle: TargetBuildHandle): TargetBuildDescription { return owned(handle).description; }
export async function validateTargetBuild(handle: TargetBuildHandle): Promise<void> {
  const target = owned(handle); await target.checkSource();
  const current = await manifest(target.description.root);
  if (JSON.stringify(current) !== JSON.stringify(target.description.resources)) throw new Error('Target output/resource bytes changed');
  await target.checkSource();
  owned(handle); // Custody may have ended during either awaited validation.
}
export async function readTargetResource(handle: TargetBuildHandle, file: string): Promise<Buffer> {
  const { description } = owned(handle);
  const expected = description.resources.find(entry => entry.file === file);
  if (!expected) throw new Error('Resource is outside target manifest');
  const bytes = await checkedFile(description.root, file);
  if (bytes.length !== expected.bytes || sha(bytes) !== expected.sha256) throw new Error('Target resource changed');
  owned(handle); // A completed read cannot succeed after its owner releases custody.
  return bytes;
}
/** Private launch payload: only a registered parent handle can create it; never an HTTP parser. */
export async function createTargetLaunchObservation(handle: TargetBuildHandle) {
  await validateTargetBuild(handle);
  return Object.freeze({ version: 1 as const, runId: targetBuildDescription(handle).runId,
    nonce: randomBytes(32).toString('hex'), target: targetBuildDescription(handle) });
}

/** Internal lifecycle type used by the installed verifier; it conveys no serialized authority. */
export type TargetBuildAuthority = Awaited<ReturnType<typeof createTargetBuildAuthority>>;

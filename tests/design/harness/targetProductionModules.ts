/** Trusted fixture-child initializer. Candidate modules must never execute in the verifier parent. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createRuntimeSnapshotLaunchObservation, isRuntimeSnapshotHandle, type RuntimeSnapshotHandle } from '../../../src/designGate/runtimeSnapshot.js';
import { createTargetLaunchObservation, type TargetBuildHandle } from '../../../src/designGate/targetBuild.js';
import { ACCOUNTS_CONSOLE_ASSETS, type AccountsConsoleAsset } from './accountsConsoleAssets.js';

export interface AccountsProductionModules {
  accountsReadRoutes: typeof import('../../../src/server/accountsReadRoutes.js') & Record<string, unknown>;
  subscriptionPool: typeof import('../../../src/core/SubscriptionPool.js');
  inUseAccountResolver: typeof import('../../../src/core/InUseAccountResolver.js');
  subscriptionReloginOperatorConfig: typeof import('../../../src/core/SubscriptionReloginOperatorConfig.js');
  browserStatusRead: typeof import('../../../src/server/browserStatusRead.js');
  healthBaseRead: typeof import('../../../src/server/healthBaseRead.js');
  mobileHealthRoutes: typeof import('../../../src/server/mobileHealthRoutes.js');
  workBoardRoutes: typeof import('../../../src/server/workBoardRoutes.js');
  workBoardService: typeof import('../../../src/core/WorkBoardService.js');
  stopGate: typeof import('../../../src/server/stopGate.js');
  accountsModel: { buildAccountsPage: (...args: any[]) => any };
}
const targetRuntimes = new WeakMap<object, Map<string, Buffer>>();
/** Issued only by this full-snapshot loader. Plain export-shaped JSON is not a target runtime. */
export function requireAccountsTargetRuntime(value: AccountsProductionModules): AccountsProductionModules {
  if (!value || !targetRuntimes.has(value)) throw new Error('Unregistered Accounts target runtime');
  return value;
}
export function readTargetAccountsConsoleAsset(value: AccountsProductionModules, asset: Readonly<AccountsConsoleAsset>): Buffer {
  requireAccountsTargetRuntime(value);
  if (!ACCOUNTS_CONSOLE_ASSETS.some(allowed => allowed.route === asset.route && allowed.file === asset.file && allowed.contentType === asset.contentType)) throw new Error('Unlisted Accounts target asset');
  const bytes = targetRuntimes.get(value)!.get(asset.file);
  if (!bytes) throw new Error('Missing Accounts target asset');
  return Buffer.from(bytes);
}
function checkedModules(value: Record<string, Record<string, unknown>>): AccountsProductionModules {
  const required: Record<string, string[]> = {
    accountsReadRoutes: ['createAccountsReadHandlers'], subscriptionPool: ['SubscriptionPool'], inUseAccountResolver: ['InUseAccountResolver'],
    subscriptionReloginOperatorConfig: ['describeSubscriptionReloginConfig', 'readOnDiskSubscriptionReloginBlock'],
    browserStatusRead: ['createBrowserStatusRead'], healthBaseRead: ['buildHealthBase', 'healthProjectProjection', 'formatUptime'],
    mobileHealthRoutes: ['mountMobileHealthRoutes'], workBoardRoutes: ['registerWorkBoardRoutes'], workBoardService: ['WorkBoardService'],
    accountsModel: ['buildAccountsPage'],
  };
  for (const [key, names] of Object.entries(required)) for (const name of names) if (typeof value[key]?.[name] !== 'function') throw new Error(`Missing target production export: ${key}.${name}`);
  if (!value.workBoardService.DEFAULT_WORK_BOARD_SETTINGS || typeof value.workBoardService.DEFAULT_WORK_BOARD_SETTINGS !== 'object'
    || !Number.isSafeInteger(value.stopGate?.GATE_ROUTE_VERSION) || !Number.isSafeInteger(value.stopGate?.GATE_ROUTE_MINIMUM_VERSION)) throw new Error('Missing target production constants');
  return Object.freeze(value) as unknown as AccountsProductionModules;
}

const ACCOUNTS_MODULES = Object.freeze({
  accountsReadRoutes: 'dist/server/accountsReadRoutes.js',
  subscriptionPool: 'dist/core/SubscriptionPool.js',
  inUseAccountResolver: 'dist/core/InUseAccountResolver.js',
  subscriptionReloginOperatorConfig: 'dist/core/SubscriptionReloginOperatorConfig.js',
  browserStatusRead: 'dist/server/browserStatusRead.js',
  healthBaseRead: 'dist/server/healthBaseRead.js',
  mobileHealthRoutes: 'dist/server/mobileHealthRoutes.js',
  workBoardRoutes: 'dist/server/workBoardRoutes.js',
  workBoardService: 'dist/core/WorkBoardService.js',
  stopGate: 'dist/server/stopGate.js',
  accountsModel: 'dashboard/console/accounts-model.js',
});
type Initialization = Awaited<ReturnType<typeof createTargetLaunchObservation>> | Awaited<ReturnType<typeof createRuntimeSnapshotLaunchObservation>>;
export async function createTargetChildInitialization(handle: TargetBuildHandle | RuntimeSnapshotHandle): Promise<Initialization> {
  return isRuntimeSnapshotHandle(handle) ? createRuntimeSnapshotLaunchObservation(handle) : createTargetLaunchObservation(handle);
}
async function verifyFile(filename: string, entry: { bytes: number; sha256: string; mode?: number }): Promise<void> {
  if (await fs.realpath(filename) !== filename || !(await fs.lstat(filename)).isFile()) throw new Error('Target resource escaped');
  if (entry.mode !== undefined && ((await fs.lstat(filename)).mode & 0o777) !== entry.mode) throw new Error('Target resource permissions changed');
  const file = await fs.open(filename, 'r');
  try {
    const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024); let bytes = 0;
    for (;;) { const read = await file.read(buffer,0,buffer.length,null); if (!read.bytesRead) break; bytes += read.bytesRead; if(bytes > entry.bytes) throw new Error('Target bytes changed'); hash.update(buffer.subarray(0,read.bytesRead)); }
    if(bytes !== entry.bytes || hash.digest('hex') !== entry.sha256) throw new Error('Target bytes changed');
  } finally { await file.close(); }
}
/**
 * The trusted launcher supplies binding from its owned IPC channel, never argv/stdin/HTTP.
 * A nonce does not authenticate a parent on its own. Parent must retain and validate its handle.
 * This initializer is an internal port, not yet a wired child launch implementation.
 */
export function createAccountsTargetChildInitializer(binding: { runId: string; nonce: string; targetDigest?: string }) {
  const expected = Object.freeze({ ...binding }); let initialized = false, loaded = false;
  let admitted: Initialization | undefined;
  return Object.freeze({
    async initialize(value: Initialization): Promise<void> {
      if (initialized || !value || value.version !== 1 || value.runId !== expected.runId || value.nonce !== expected.nonce
        || !/^[a-f0-9]{64}$/.test(expected.nonce) || value.target.runId !== expected.runId) throw new Error('Wrong or repeated target initialization');
      // Consume before await: simultaneous initializations cannot both succeed.
      initialized = true;
      const copy = structuredClone(value);
      if(copy.target.dependencyCoverage === 'whole-installed-runtime' && expected.targetDigest !== copy.target.digest) throw new Error('Full target was not registered by launcher');
      const { digest, ...body } = copy.target;
      if (createHash('sha256').update(JSON.stringify(body)).digest('hex') !== digest) throw new Error('Target descriptor changed');
      const root = await fs.realpath(copy.target.root);
      if (root !== copy.target.root) throw new Error('Target root changed');
      for (const entry of copy.target.resources) {
        if (!entry.file || path.isAbsolute(entry.file) || entry.file.includes('\\') || entry.file.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Invalid target resource');
        const absolute = path.join(root, entry.file);
        if (await fs.realpath(absolute) !== absolute || !(await fs.lstat(absolute)).isFile()) throw new Error('Target resource escaped');
        await verifyFile(absolute, entry);
      }
      if(copy.target.dependencyCoverage === 'whole-installed-runtime') {
        if((await fs.lstat(root)).mode & 0o222) throw new Error('Snapshot root is writable');
        for(const directory of copy.target.directories) {
          if(!directory.file || path.isAbsolute(directory.file) || directory.file.includes('\\') || directory.file.split('/').some(p=>!p||p==='.'||p==='..')) throw new Error('Invalid snapshot directory');
          const filename=path.join(root,directory.file);
          if(await fs.realpath(filename)!==filename || ((await fs.lstat(filename)).mode & 0o777)!==directory.mode || directory.mode & 0o222) throw new Error('Snapshot directory changed');
        }
        for(const link of copy.target.symlinks) {
          if(!link.file || path.isAbsolute(link.file) || link.file.includes('\\') || link.file.split('/').some(p=>!p||p==='.'||p==='..') || !link.targetFile || path.isAbsolute(link.targetFile) || link.targetFile.includes('\\') || link.targetFile.split('/').some(p=>!p||p==='.'||p==='..')) throw new Error('Invalid snapshot binding');
          const filename=path.join(root,link.file);
          if(await fs.readlink(filename)!==link.text || await fs.realpath(filename)!==path.join(root,link.targetFile)) throw new Error('Snapshot symlink changed');
        }
      }
      for (const filename of Object.values(ACCOUNTS_MODULES)) if (!copy.target.resources.some(entry => entry.file === filename)) throw new Error('Missing target production module');
      admitted = copy;
    },
    fixedModuleUrls(): Readonly<Record<keyof typeof ACCOUNTS_MODULES, string>> {
      if (!admitted) throw new Error('Target child is not initialized');
      return Object.freeze(Object.fromEntries(Object.entries(ACCOUNTS_MODULES).map(([key,file]) => [key,pathToFileURL(path.join(admitted!.target.root,file)).href])) as Record<keyof typeof ACCOUNTS_MODULES,string>);
    },
    async load(): Promise<AccountsProductionModules> {
      if (!admitted || typeof process.send !== 'function' || !process.connected
        || process.env.INSTAR_DESIGN_FIXTURE_CHILD_RUN_ID !== expected.runId
        || process.env.INSTAR_DESIGN_FIXTURE_CHILD_NONCE !== expected.nonce) throw new Error('Candidate import requires initialized fixture child IPC');
      if (loaded) throw new Error('Target production modules already loaded in this child');
      loaded = true;
      // Narrow the validate/import gap; the parent must still revalidate after capture.
      for (const entry of admitted.target.resources) {
        const absolute = path.join(admitted.target.root, entry.file);
        if (await fs.realpath(absolute) !== absolute) throw new Error('Target resource escaped');
        await verifyFile(absolute,entry);
      }
      // Lockfile/install observations do not fence ignored node_modules mutations.
      // Do not import candidate code until the trusted producer owns that full closure.
      if(admitted.target.dependencyCoverage !== 'whole-installed-runtime') throw new Error('Candidate production dependency custody is incomplete');
      // Preload the BASE allowlist from this SAME verified snapshot, never from the harness repository.
      const assets = new Map<string, Buffer>();
      for (const asset of ACCOUNTS_CONSOLE_ASSETS) {
        if (assets.has(asset.file)) continue;
        const entry = admitted.target.resources.find(resource => resource.file === asset.file);
        if (!entry) throw new Error(`Missing target console asset: ${asset.file}`);
        const filename = path.join(admitted.target.root, asset.file);
        await verifyFile(filename, entry);
        const bytes = await fs.readFile(filename);
        if (bytes.length !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error('Target asset bytes changed');
        assets.set(asset.file, bytes);
      }
      const entries=await Promise.all(Object.entries(ACCOUNTS_MODULES).map(async([key,file])=>[key,await import(pathToFileURL(path.join(admitted!.target.root,file)).href)]));
      const modules = checkedModules(Object.fromEntries(entries));
      targetRuntimes.set(modules, assets);
      return modules;
    },
  });
}

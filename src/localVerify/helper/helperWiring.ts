/**
 * Builds the helper role for the agent server (docs/specs/local-verify-borrowed-unit-slices.md, B).
 *
 * Independent of the run-machine Local Verify service: a laptop helper has no verifier at all.
 * The runtime is cheap until enabled: `get()` returns null (routes 404) unless the live setting
 * `monitoring.localVerify.helper` parses with `enabled: true`, and only then constructs the
 * service with its production seams (Lima on macOS, WSL inside Echo's distro on Windows, the
 * host-stats or owner-signal governor reader, GitHub's compare API, this machine's signer).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { identityKeyLookup, loadMachineSigner } from '../../core/AppRecordSignatures.js';
import { getInstarVersion } from '../../core/Config.js';
import { appendLocalVerifyAudit } from '../LocalVerifyService.js';
import { parseHelperConfig } from './helperConfig.js';
import { HelperService, type HelperServiceDeps } from './HelperService.js';
import { realCommandRunner, type CommandRunner } from './commandRunner.js';
import { LimaDriver, defaultHelperHome } from './limaDriver.js';
import { WslDriver } from './wslDriver.js';
import { MacOwnerLoadReader, WindowsOwnerSignalReader, windowsHelperDriveFreeBytes, type OwnerLoadReader } from './governor.js';
import { BareCloneTreeSource, GitHubCompareChecker, secretStoreToken } from './hostTree.js';
import type { HelperSandboxDriver } from './sandboxDriver.js';
import { TestBypassDriver } from './testBypassDriver.js';

export function isWslHost(readVersion: () => string | null = () => { try { return fs.readFileSync('/proc/version', 'utf-8'); } catch { return null; } }): boolean {
  if (process.platform !== 'linux') return false;
  return /microsoft/i.test(readVersion() ?? '');
}

/** The owner-signal file the Windows scheduled task writes into Echo's distro. */
export function ownerSignalPath(): string {
  return path.join(os.homedir(), '.instar', 'state', 'helper-owner-signal.json');
}

/**
 * The production sandbox for this platform: Lima on macOS, the WSL helper distro when this
 * server runs in Echo's WSL distro, otherwise none. It NEVER returns the test-bypass seam.
 */
export function selectSandboxDriver(o: { platform: NodeJS.Platform; wsl: boolean; stateDir: string; runner?: CommandRunner }): HelperSandboxDriver | null {
  const runner = o.runner ?? realCommandRunner;
  if (o.platform === 'darwin') return new LimaDriver({ runner, limactl: path.join(o.stateDir, 'helper', 'lima', 'bin', 'limactl'), helperHome: defaultHelperHome() });
  if (o.platform === 'linux' && o.wsl) {
    return new WslDriver({
      runner,
      // Set up by that machine's agent (spec Maturation plan, Windows rung).
      installDir: process.env.INSTAR_HELPER_WSL_DIR || 'C:\\instar-helper\\distro',
      rootfsTar: process.env.INSTAR_HELPER_WSL_ROOTFS || 'C:\\instar-helper\\images\\instar-helper-rootfs.tar',
      rootfsTarLocal: process.env.INSTAR_HELPER_WSL_ROOTFS_LOCAL || '/mnt/c/instar-helper/images/instar-helper-rootfs.tar',
      signalFile: ownerSignalPath(),
    });
  }
  return null;
}

export function selectOwnerLoadReader(platform: NodeJS.Platform, wsl: boolean, driver: HelperSandboxDriver | null): OwnerLoadReader {
  if (platform === 'linux' && wsl) return new WindowsOwnerSignalReader({ signalPath: ownerSignalPath(), sandboxBusyCores: () => driver ? driver.sandboxBusyCores() : Promise.resolve(null) });
  return new MacOwnerLoadReader();
}

export async function hostFreeBytes(dir: string = os.homedir()): Promise<number | null> {
  try { const s = await fs.promises.statfs(dir); return Number(s.bavail) * Number(s.bsize); } catch { return null; } // @silent-fallback-ok: unknown free space fails the host-disk check (refuse)
}

/**
 * Host free space for the B2 margin: the owner's home volume on macOS; on Windows the drive holding
 * the helper distro's virtual disk, reported by the owner-signal task (never Echo's own distro disk).
 */
export function selectHostFreeBytes(platform: NodeJS.Platform, wsl: boolean, signalPath: string = ownerSignalPath()): () => Promise<number | null> {
  if (platform === 'linux' && wsl) return () => windowsHelperDriveFreeBytes(signalPath);
  return () => hostFreeBytes();
}

export interface HelperRuntime {
  /** The service when the role is enabled now, else null (routes 404). */
  get(): HelperService | null;
  shutdown(): void;
}

export interface HelperRuntimeOpts {
  liveConfig: { get<T>(key: string, fallback: T): T };
  stateDir: string;
  /**
   * TEST ONLY. `'test-bypass'` with `testBypassDriver` runs slices on the host (e2e suite); refused
   * outside a test runner. Production (server.ts) never passes these.
   */
  sandbox?: 'test-bypass';
  testBypassDriver?: TestBypassDriver;
  /** TEST ONLY: replace individual seams. */
  overrides?: Partial<HelperServiceDeps>;
}

export function buildHelperRuntime(o: HelperRuntimeOpts): HelperRuntime {
  if (o.sandbox === 'test-bypass' && (!process.env.VITEST || !(o.testBypassDriver instanceof TestBypassDriver))) {
    throw new Error('test-bypass is a test-only seam');
  }
  const hw = { ncpu: os.cpus().length, totalMemGb: os.totalmem() / 1024 ** 3 };
  const readCfg = () => parseHelperConfig(o.liveConfig.get<unknown>('monitoring.localVerify.helper', null), hw);
  let svc: HelperService | null = null;
  const auditPath = path.join(o.stateDir, 'logs', 'local-verify.jsonl');
  return {
    get() {
      if (!readCfg()) {
        if (svc) { svc.shutdown(); svc = null; }
        return null;
      }
      if (svc) return svc;
      const wsl = isWslHost();
      const driver = o.sandbox === 'test-bypass' ? o.testBypassDriver! : selectSandboxDriver({ platform: process.platform, wsl, stateDir: o.stateDir });
      svc = new HelperService({
        config: readCfg,
        driver,
        ownerLoad: selectOwnerLoadReader(process.platform, wsl, driver),
        github: new GitHubCompareChecker({ token: secretStoreToken(o.stateDir) }),
        trees: new BareCloneTreeSource(path.join(defaultHelperHome(), 'repo.git')),
        signer: loadMachineSigner(o.stateDir),
        keyLookup: () => identityKeyLookup(o.stateDir),
        stateDir: o.stateDir,
        helperVersion: getInstarVersion(),
        hostFreeBytes: selectHostFreeBytes(process.platform, wsl),
        audit: (e) => appendLocalVerifyAudit(auditPath, e, Date.now()),
        ...(o.overrides ?? {}),
      });
      svc.start();
      return svc;
    },
    shutdown() { svc?.shutdown(); svc = null; },
  };
}

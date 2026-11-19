/**
 * A scriptable in-memory HelperSandboxDriver for the borrowed-helper tests
 * (docs/specs/local-verify-borrowed-unit-slices.md). It records every call and runs nothing.
 */
import crypto from 'node:crypto';
import type { Readable } from 'node:stream';
import type { SandboxImageIdentity } from '../../src/localVerify/helper/dryRunRecord.js';
import type { SandboxSize } from '../../src/localVerify/helper/helperConfig.js';
import type { ContainmentFacts, ContainmentReport, HelperSandboxDriver, SandboxStatus, TesterProgress, TesterRun, TesterRunSpec } from '../../src/localVerify/helper/sandboxDriver.js';
import type { HelperLane } from '../../src/localVerify/helper/helperProtocol.js';

export interface FakeSliceResult { exitCode?: number | null; resultText?: string | null; oversize?: { bytesSeen: number }; unhandledErrors?: number; vitestStartMs?: number | null }

/** A vitest JSON report for files under `root` with per-file assertion statuses. */
export function vitestReport(root: string, files: Record<string, Array<'passed' | 'failed' | 'skipped' | 'todo'>>, opts: { fileStatus?: Record<string, 'passed' | 'failed'> } = {}): string {
  return JSON.stringify({
    testResults: Object.entries(files).map(([f, statuses]) => ({
      name: `${root}/${f}`,
      status: opts.fileStatus?.[f] ?? (statuses.includes('failed') ? 'failed' : 'passed'),
      startTime: 1000, endTime: 1250,
      assertionResults: statuses.map((s, i) => ({ title: `t${i}`, status: s, failureMessages: s === 'failed' ? ['boom'] : [] })),
    })),
  });
}

/** The manifest digest the fake "computes" for a package set. */
export const fakeManifest = (hash: string): string => crypto.createHash('sha256').update(`manifest:${hash}`).digest('hex');

export class FakeSandboxDriver implements HelperSandboxDriver {
  readonly kind = 'fake' as const;
  calls: string[] = [];
  exists = false;
  running = false;
  checksQueue: ContainmentReport[] = [];
  defaultChecks: ContainmentReport = { ok: true, checks: [{ name: 'fake', result: 'pass' }], reason: null };
  freeBytes: number | null = 100 * 1024 ** 3;
  freeBytesAfterPrep: number | null = null;
  diskFileBytes: number | null = 1024 ** 3;
  peakMemMb: number | null = 512;
  reapSurvivors: number[] = [];
  builderExit: Record<string, number | null> = {};
  /**
   * What the next tester run returns; or a function receiving the files, the abort signal and
   * `progress`, which reports one finished file (a one-file vitest report under `root`) as the
   * root-owned runner would while the slice still runs.
   */
  slice: FakeSliceResult | ((files: string[], signal: AbortSignal, progress: (reportText: string, unhandledErrors?: number) => void) => Promise<FakeSliceResult>) = { exitCode: 0, resultText: null };
  /** The lanes and worker counts of every tester run, in order. */
  runs: Array<{ lane: HelperLane; workers: number; files: string[] }> = [];
  /** Whether the package volume (its own disk) is there. */
  packageVolume = true;
  /** The package volume's disk file on the host: its full size (undefined = this driver keeps none on the host) and current size. */
  pkgDiskCapBytes: number | undefined = undefined;
  pkgDiskFileBytes: number | null = null;
  /** What the last start-up check was given. */
  lastFacts: ContainmentFacts | null = null;
  /** Block builder steps until released (to hold a preparation open). */
  builderGate: Promise<void> | null = null;
  lastWorkers: number | null = null;
  removed: string[] = [];
  /** The sandbox's image identity; null = unpinned. Change `imageDigest` to model a new pinned image. */
  image: SandboxImageIdentity | null = { imageDigest: 'sha256:image-one', settingsHash: 'settings-one' };
  /** The package volume: install-inputs hash → manifest digest. It survives `destroy` (its own disk). */
  packages = new Map<string, string>();
  copied: string[] = [];
  readonly root = '/srv/slice/fake';

  async create(_size: SandboxSize): Promise<void> { this.calls.push('create'); this.exists = true; }
  async start(): Promise<{ startMs: number }> { this.calls.push('start'); this.exists = true; this.running = true; return { startMs: 1234 }; }
  async stop(): Promise<void> { this.calls.push('stop'); this.running = false; }
  async status(): Promise<SandboxStatus> {
    return { exists: this.exists, running: this.running, diskFileBytes: this.diskFileBytes, peakMemMb: this.peakMemMb, ...(this.pkgDiskCapBytes !== undefined ? { pkgDiskCapBytes: this.pkgDiskCapBytes, pkgDiskFileBytes: this.pkgDiskFileBytes } : {}) };
  }
  async checks(facts?: ContainmentFacts): Promise<ContainmentReport> { this.calls.push('checks'); this.lastFacts = facts ?? null; return this.checksQueue.shift() ?? this.defaultChecks; }
  async packageVolumeReady(): Promise<boolean> { this.calls.push('pkg-volume'); return this.packageVolume; }
  async imageIdentity(_size: SandboxSize): Promise<SandboxImageIdentity | null> { return this.image; }
  async copyIn(treeId: string, tar: Readable, opts: { placed?: boolean } = {}): Promise<{ copyMs: number }> {
    this.calls.push(`copyIn:${treeId}${opts.placed ? ':placed' : ''}`);
    for await (const _c of tar) { /* drain */ }
    this.copied.push(treeId);
    return { copyMs: 42 };
  }
  async verifyPackages(hash: string, manifestDigest: string): Promise<boolean> {
    this.calls.push(`pkg-verify:${hash}`);
    return this.packages.get(hash) === manifestDigest;
  }
  async discardPackages(hash: string): Promise<void> { this.calls.push(`pkg-discard:${hash}`); this.packages.delete(hash); }
  async installPackages(hash: string, mergedTreeId: string, signal: AbortSignal): Promise<{ exitCode: number | null; manifestDigest: string | null }> {
    this.calls.push(`install:${hash}:${mergedTreeId}`);
    await this.gate(signal);
    const exitCode = signal.aborted ? null : (this.builderExit.install ?? 0);
    if (exitCode !== 0) return { exitCode, manifestDigest: null };
    const manifestDigest = fakeManifest(hash);
    this.packages.set(hash, manifestDigest);
    return { exitCode, manifestDigest };
  }
  async placePackages(treeId: string, hash: string, manifestDigest: string): Promise<void> {
    this.calls.push(`place:${treeId}:${hash}`);
    if (this.packages.get(hash) !== manifestDigest) throw new Error('place failed: packages absent');
  }
  async build(treeId: string, signal: AbortSignal): Promise<{ exitCode: number | null }> {
    this.calls.push(`build:${treeId}`);
    await this.gate(signal);
    if (this.freeBytesAfterPrep !== null) this.freeBytes = this.freeBytesAfterPrep;
    return { exitCode: signal.aborted ? null : (this.builderExit.build ?? 0) };
  }
  private async gate(signal: AbortSignal): Promise<void> {
    if (this.builderGate) await Promise.race([this.builderGate, new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }))]);
  }
  async sealTree(treeId: string): Promise<void> { this.calls.push(`seal:${treeId}`); }
  async execAsTester(treeId: string, run: TesterRunSpec): Promise<TesterRun> {
    this.calls.push(`test:${treeId}:${run.files.length}`);
    this.lastWorkers = run.workers;
    this.runs.push({ lane: run.lane, workers: run.workers, files: [...run.files] });
    const progress = (reportText: string, unhandledErrors = 0): void => { const p: TesterProgress = { rootDir: this.root, reportText, unhandledErrors }; run.onProgress?.(p); };
    const r = typeof this.slice === 'function' ? await this.slice(run.files, run.signal, progress) : this.slice;
    return { rootDir: this.root, exitCode: r.exitCode ?? 0, resultText: r.resultText ?? null, ...(r.oversize ? { oversize: r.oversize } : {}), unhandledErrors: r.unhandledErrors ?? 0, vitestStartMs: r.vitestStartMs ?? 800 };
  }
  async reap(): Promise<{ survivors: number }> { this.calls.push('reap'); return { survivors: this.reapSurvivors.length ? this.reapSurvivors.shift()! : 0 }; }
  async removeTree(treeId: string): Promise<void> { this.calls.push(`remove:${treeId}`); this.removed.push(treeId); }
  async sandboxFreeBytes(): Promise<number | null> { return this.freeBytes; }
  async sandboxBusyCores(): Promise<number | null> { return 0.5; }
  async destroy(): Promise<void> { this.calls.push('destroy'); this.exists = false; this.running = false; }
  async uninstall(): Promise<void> { this.calls.push('uninstall'); this.exists = false; this.running = false; }
}

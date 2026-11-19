/**
 * A scriptable in-memory HelperSandboxDriver for the borrowed-helper tests
 * (docs/specs/local-verify-borrowed-unit-slices.md). It records every call and runs nothing.
 */
import type { Readable } from 'node:stream';
import type { SandboxSize } from '../../src/localVerify/helper/helperConfig.js';
import type { ContainmentReport, HelperSandboxDriver, SandboxStatus, TesterRun } from '../../src/localVerify/helper/sandboxDriver.js';

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
  /** What the next tester run returns; or a function receiving the files and the abort signal. */
  slice: FakeSliceResult | ((files: string[], signal: AbortSignal) => Promise<FakeSliceResult>) = { exitCode: 0, resultText: null };
  /** Block builder steps until released (to hold a preparation open). */
  builderGate: Promise<void> | null = null;
  lastWorkers: number | null = null;
  removed: string[] = [];
  copied: string[] = [];
  readonly root = '/srv/slice/fake';

  async create(_size: SandboxSize): Promise<void> { this.calls.push('create'); this.exists = true; }
  async start(): Promise<{ startMs: number }> { this.calls.push('start'); this.exists = true; this.running = true; return { startMs: 1234 }; }
  async stop(): Promise<void> { this.calls.push('stop'); this.running = false; }
  async status(): Promise<SandboxStatus> { return { exists: this.exists, running: this.running, diskFileBytes: this.diskFileBytes, peakMemMb: this.peakMemMb }; }
  async checks(): Promise<ContainmentReport> { this.calls.push('checks'); return this.checksQueue.shift() ?? this.defaultChecks; }
  async copyIn(treeId: string, tar: Readable): Promise<{ copyMs: number }> {
    this.calls.push(`copyIn:${treeId}`);
    for await (const _c of tar) { /* drain */ }
    this.copied.push(treeId);
    return { copyMs: 42 };
  }
  async execAsBuilder(treeId: string, step: 'npm-ci' | 'build', signal: AbortSignal): Promise<{ exitCode: number | null }> {
    this.calls.push(`${step}:${treeId}`);
    if (this.builderGate) {
      await Promise.race([this.builderGate, new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }))]);
    }
    if (this.freeBytesAfterPrep !== null && step === 'build') this.freeBytes = this.freeBytesAfterPrep;
    return { exitCode: signal.aborted ? null : (this.builderExit[step] ?? 0) };
  }
  async sealTree(treeId: string): Promise<void> { this.calls.push(`seal:${treeId}`); }
  async execAsTester(treeId: string, run: { files: string[]; workers: number; signal: AbortSignal }): Promise<TesterRun> {
    this.calls.push(`test:${treeId}:${run.files.length}`);
    this.lastWorkers = run.workers;
    const r = typeof this.slice === 'function' ? await this.slice(run.files, run.signal) : this.slice;
    return { rootDir: this.root, exitCode: r.exitCode ?? 0, resultText: r.resultText ?? null, ...(r.oversize ? { oversize: r.oversize } : {}), unhandledErrors: r.unhandledErrors ?? 0, vitestStartMs: r.vitestStartMs ?? 800 };
  }
  async reap(): Promise<{ survivors: number }> { this.calls.push('reap'); return { survivors: this.reapSurvivors.length ? this.reapSurvivors.shift()! : 0 }; }
  async removeTree(treeId: string): Promise<void> { this.calls.push(`remove:${treeId}`); this.removed.push(treeId); }
  async sandboxFreeBytes(): Promise<number | null> { return this.freeBytes; }
  async sandboxBusyCores(): Promise<number | null> { return 0.5; }
  async destroy(): Promise<void> { this.calls.push('destroy'); this.exists = false; this.running = false; }
  async uninstall(): Promise<void> { this.calls.push('uninstall'); this.exists = false; this.running = false; }
}

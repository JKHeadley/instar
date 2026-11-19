/**
 * The named TEST-ONLY seam `sandbox: 'test-bypass'` (docs/specs/local-verify-borrowed-unit-slices.md,
 * Tests "E2E lifecycle"): in the e2e suite the helper runs slices directly on the host with HOME
 * pointed elsewhere, so the Local Verify machines never need a sandbox. It provides NO isolation.
 *
 * Production setup can never select it: parseHelperConfig refuses a string `sandbox`,
 * selectSandboxDriver returns only Lima or WSL, buildHelperRuntime accepts it only under a test
 * runner, and its constructor throws outside one (tests/unit/localVerify/helper/helperWiring.test.ts).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { SafeFsExecutor } from '../../core/SafeFsExecutor.js';
import type { SandboxSize } from './helperConfig.js';
import type { ContainmentReport, HelperSandboxDriver, SandboxStatus, TesterRun } from './sandboxDriver.js';

export type BypassSliceRunner = (o: { treeDir: string; files: string[]; workers: number; env: NodeJS.ProcessEnv; signal: AbortSignal }) => Promise<{ exitCode: number | null; reportText: string | null; unhandledErrors?: number; vitestStartMs?: number | null }>;

/** Extract a ustar archive (regular files only) under `dir`. */
export function extractTar(buf: Buffer, dir: string): number {
  let i = 0;
  let n = 0;
  while (i + 512 <= buf.length) {
    const h = buf.subarray(i, i + 512);
    if (h.every((b) => b === 0)) break;
    const name = h.subarray(0, 100).toString('utf-8').replace(/\0.*$/s, '');
    const prefix = h.subarray(345, 500).toString('utf-8').replace(/\0.*$/s, '');
    const size = parseInt(h.subarray(124, 136).toString('ascii').replace(/\0.*$/s, '').trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 48);
    const rel = prefix ? `${prefix}/${name}` : name;
    i += 512;
    if (type === '0' && rel && !rel.split('/').includes('..') && !path.isAbsolute(rel)) {
      const target = path.join(dir, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, buf.subarray(i, i + size));
      n++;
    }
    i += Math.ceil(size / 512) * 512;
  }
  return n;
}

export class TestBypassDriver implements HelperSandboxDriver {
  readonly kind = 'test-bypass' as const;
  private up = false;
  private exists = false;
  private readonly root: string;

  constructor(private readonly o: { runSlice: BypassSliceRunner; root?: string }) {
    if (!process.env.VITEST) throw new Error('test-bypass is a test-only seam and cannot be constructed outside a test runner');
    this.root = o.root ?? fs.mkdtempSync(path.join(os.tmpdir(), 'helper-bypass-'));
  }

  private tree(treeId: string): string { return path.join(this.root, 'trees', treeId); }
  async create(_size: SandboxSize): Promise<void> { this.exists = true; }
  async start(): Promise<{ startMs: number }> { this.exists = true; this.up = true; return { startMs: 0 }; }
  async stop(): Promise<void> { this.up = false; }
  async status(): Promise<SandboxStatus> { return { exists: this.exists, running: this.up, diskFileBytes: 0, peakMemMb: null }; }
  async checks(): Promise<ContainmentReport> {
    return { ok: true, checks: [{ name: 'test-bypass', result: 'pass', detail: 'NO SANDBOX: on-host test-only seam' }], reason: null };
  }
  async copyIn(treeId: string, tar: Readable): Promise<{ copyMs: number }> {
    const chunks: Buffer[] = [];
    for await (const c of tar) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
    fs.mkdirSync(this.tree(treeId), { recursive: true });
    extractTar(Buffer.concat(chunks), this.tree(treeId));
    return { copyMs: 0 };
  }
  async execAsBuilder(): Promise<{ exitCode: number | null }> { return { exitCode: 0 }; }
  async sealTree(): Promise<void> { /* nothing to seal on the host seam */ }
  async execAsTester(treeId: string, run: { files: string[]; workers: number; signal: AbortSignal }): Promise<TesterRun> {
    const home = path.join(this.root, 'home');
    fs.mkdirSync(home, { recursive: true });
    const r = await this.o.runSlice({ treeDir: this.tree(treeId), files: run.files, workers: run.workers, env: { ...process.env, HOME: home, TMPDIR: home }, signal: run.signal });
    return { rootDir: this.tree(treeId), exitCode: r.exitCode, resultText: r.reportText, unhandledErrors: r.unhandledErrors ?? 0, vitestStartMs: r.vitestStartMs ?? null };
  }
  async reap(): Promise<{ survivors: number }> { return { survivors: 0 }; }
  async removeTree(treeId: string): Promise<void> {
    await SafeFsExecutor.safeRm(this.tree(treeId), { recursive: true, force: true, operation: 'local-verify:helper-test-bypass' });
  }
  async sandboxFreeBytes(): Promise<number | null> { return 1024 ** 4; }
  async sandboxBusyCores(): Promise<number | null> { return 0; }
  async destroy(): Promise<void> { this.exists = false; this.up = false; }
  async uninstall(): Promise<void> {
    await SafeFsExecutor.safeRm(this.root, { recursive: true, force: true, operation: 'local-verify:helper-test-bypass' });
  }
}

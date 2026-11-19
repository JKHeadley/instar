/**
 * Production seams of the run machine's borrowed shadow (docs/specs/local-verify-borrowed-unit-slices.md, F):
 * the head's unit files with this machine's recorded durations, a tree reader for D's scan, and the
 * run's own unit-lane report. All async (the verifier's own bare clone is read through the git
 * funnel's streaming surface), all read-only, none on the verify's own path.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { SafeGitExecutor } from '../core/SafeGitExecutor.js';
import { isBorrowedCanaryFile, isBorrowableTestFile, type TreeReader } from './borrowedEligibility.js';
import { parseVitestJson, type FileCounts } from './laneReport.js';
import { verifyPaths } from './orchestrator.js';
import { DURATIONS_MAX_BYTES, mergeDurations } from './shardPlan.js';
import { parseLsTree } from './helper/hostTree.js';

/** The unit report is read only when at most this large (it is written by test-side processes). */
export const UNIT_REPORT_MAX_BYTES = 64 * 1024 * 1024;

function gitOpts(agentHome: string, operation: string) {
  const p = verifyPaths(agentHome, '0'.repeat(40));
  return { cwd: p.verifyRoot, operation, timeout: 10 * 60_000, localVerifyCloneOk: { verifyRoot: p.verifyRoot, gitDir: p.bare } };
}

/** A persistent `git cat-file --batch` reader: requests answered in order, one process per tree read. */
export class BatchCatFile {
  private buf = Buffer.alloc(0);
  private readonly queue: Array<{ resolve: (b: Buffer | null) => void; reject: (e: Error) => void }> = [];
  private closed = false;

  constructor(private readonly child: ChildProcess) {
    child.stdout?.on('data', (d: Buffer) => { this.buf = Buffer.concat([this.buf, d]); this.drain(); });
    // A dead reader is a read failure (the scan fails closed), never "absent".
    const fail = () => { this.closed = true; while (this.queue.length) this.queue.shift()!.reject(new Error('cat-file reader closed')); };
    child.on('close', fail);
    child.on('error', fail);
    child.stdin?.on('error', fail);
  }

  private drain(): void {
    while (this.queue.length > 0) {
      const nl = this.buf.indexOf(0x0a);
      if (nl < 0) return;
      const header = this.buf.subarray(0, nl).toString('utf-8');
      if (/ missing$/.test(header)) { this.buf = this.buf.subarray(nl + 1); this.queue.shift()!.resolve(null); continue; }
      const m = /^[0-9a-f]{40} (\w+) (\d+)$/.exec(header);
      if (!m) { this.buf = this.buf.subarray(nl + 1); this.queue.shift()!.reject(new Error(`unreadable: ${header.slice(0, 80)}`)); continue; }
      const size = Number(m[2]);
      if (this.buf.length < nl + 1 + size + 1) return;
      const body = this.buf.subarray(nl + 1, nl + 1 + size);
      this.buf = this.buf.subarray(nl + 1 + size + 1);
      const q = this.queue.shift()!;
      if (m[1] === 'blob') q.resolve(Buffer.from(body)); else q.reject(new Error(`not a file: ${m[1]}`));
    }
  }

  read(spec: string): Promise<Buffer | null> {
    if (/[\n\r]/.test(spec)) return Promise.reject(new Error('bad spec'));
    if (this.closed) return Promise.reject(new Error('cat-file reader closed'));
    return new Promise((resolve, reject) => { this.queue.push({ resolve, reject }); this.child.stdin?.write(`${spec}\n`); });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin?.end();
  }
}

/** Reads files of `headSha` from the verifier's bare clone; the batch process closes after 30 s idle. */
export function verifyCloneTreeReader(agentHome: string, headSha: string): TreeReader {
  let batch: BatchCatFile | null = null;
  let idle: NodeJS.Timeout | null = null;
  const touch = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => { batch?.close(); batch = null; }, 30_000);
    idle.unref?.();
  };
  return {
    async read(file: string): Promise<string | null> {
      if (!/^[0-9a-f]{40}$/.test(headSha) || file.includes('\n')) throw new Error('bad tree read');
      // A reader that cannot start throws: the scan fails closed on every file.
      if (!batch) batch = new BatchCatFile(SafeGitExecutor.readStream(['cat-file', '--batch'], gitOpts(agentHome, 'local-verify:borrowed-scan')));
      touch();
      const b = await batch.read(`${headSha}:${file}`);
      return b ? b.toString('utf-8') : null;
    },
  };
}

function collect(child: ChildProcess): Promise<{ code: number | null; out: Buffer }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    child.stdout?.on('data', (d: Buffer) => chunks.push(d));
    child.on('error', () => resolve({ code: null, out: Buffer.alloc(0) }));
    child.on('close', (code) => resolve({ code, out: Buffer.concat(chunks) }));
    child.stdin?.end();
  });
}

/** The head's unit-lane files (canary fixtures never included) with this machine's recorded durations. */
export async function unitFilesWithDurations(agentHome: string, headSha: string): Promise<Array<{ file: string; ms: number }>> {
  const p = verifyPaths(agentHome, headSha);
  let durations: Record<string, number> = {};
  try {
    if (fs.statSync(p.durationsPath).size <= DURATIONS_MAX_BYTES) durations = mergeDurations(JSON.parse(fs.readFileSync(p.durationsPath, 'utf-8')), {});
  } catch { durations = {}; } // @silent-fallback-ok: no history yet means no file has a duration, so nothing is planned
  const r = await collect(SafeGitExecutor.readStream(['ls-tree', '-r', '-z', '--full-tree', headSha], gitOpts(agentHome, 'local-verify:borrowed-ls-tree')));
  if (r.code !== 0) throw new Error('ls-tree of the verified head failed');
  return parseLsTree(r.out)
    .map((e) => e.path)
    .filter((f) => isBorrowableTestFile(f) && !isBorrowedCanaryFile(f) && Number.isFinite(durations[f]))
    .map((f) => ({ file: f, ms: durations[f] }));
}

/** This machine's own unit-lane per-file counts for the head, from the run's report (kept until the next run of that head). */
export async function localUnitReport(agentHome: string, headSha: string): Promise<ReadonlyMap<string, FileCounts> | null> {
  const p = verifyPaths(agentHome, headSha);
  const file = path.join(p.reportsDir, 'unit.json');
  try {
    const st = await fs.promises.stat(file);
    if (st.size > UNIT_REPORT_MAX_BYTES) return null;
    return parseVitestJson(await fs.promises.readFile(file, 'utf-8'), p.runDir).files;
  } catch { return null; } // @silent-fallback-ok: no report means the run is audited as not compared
}

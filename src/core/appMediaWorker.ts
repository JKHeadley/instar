/**
 * File work for app media that must never run on the event loop (media spec §4.2 step 4, §4.3,
 * §4.6): concatenating chunks while hashing, re-hashing, snapshotting a checked descriptor, and
 * lifting printable runs out of a file for the credential scan.
 *
 * The worker is inline source so the same code runs from dist and under test.
 * Each call is one short-lived worker; callers run few of these at a time.
 */
import { Worker } from 'node:worker_threads';

export interface HashedFile { sha256: string; size: number; headB64: string }

const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const crypto = require('node:crypto');
const HEAD = 4096;
const BUF = 256 * 1024;
const mode = workerData;

function pump(fd, onChunk) {
  const buf = Buffer.allocUnsafe(BUF);
  let pos = 0;
  for (;;) {
    const n = fs.readSync(fd, buf, 0, BUF, pos);
    if (n === 0) return;
    pos += n;
    if (onChunk(buf.subarray(0, n)) === false) return;
  }
}

function tracker() {
  const hash = crypto.createHash('sha256');
  let size = 0;
  const head = [];
  let headLen = 0;
  return {
    add(b) {
      hash.update(b);
      size += b.length;
      if (headLen < HEAD) { const c = Buffer.from(b.subarray(0, HEAD - headLen)); head.push(c); headLen += c.length; }
    },
    get size() { return size; },
    done() { return { sha256: hash.digest('hex'), size, headB64: Buffer.concat(head).toString('base64') }; },
  };
}

function finishWrite(fd, outPath) {
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.chmodSync(outPath, 0o400);
  try { const d = fs.openSync(require('node:path').dirname(outPath), 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } } catch {}
}

function run() {
  if (mode.op === 'hash') {
    const fd = fs.openSync(mode.path, 'r');
    const t = tracker();
    try { pump(fd, (b) => { t.add(b); }); } finally { fs.closeSync(fd); }
    return t.done();
  }
  if (mode.op === 'assemble') {
    const out = fs.openSync(mode.outPath, 'w', 0o600);
    const t = tracker();
    try {
      for (const p of mode.chunkPaths) {
        const fd = fs.openSync(p, 'r');
        try { pump(fd, (b) => { t.add(b); fs.writeSync(out, b); }); } finally { fs.closeSync(fd); }
      }
    } catch (e) { fs.closeSync(out); throw e; }
    finishWrite(out, mode.outPath);
    return t.done();
  }
  if (mode.op === 'snapshot') {
    const out = fs.openSync(mode.outPath, 'wx', 0o600);
    const t = tracker();
    let over = false;
    try {
      pump(mode.fd, (b) => {
        if (t.size + b.length > mode.limit) { over = true; return false; }
        t.add(b); fs.writeSync(out, b);
        return true;
      });
    } catch (e) { fs.closeSync(out); throw e; }
    finishWrite(out, mode.outPath);
    return over ? { over: true } : t.done();
  }
  if (mode.op === 'printable') {
    // Runs of printable ASCII (tab and line breaks included, so a text file stays whole) of at
    // least minRun characters, posted in batches; a very long run is split with an overlap so a
    // key on a batch boundary is still whole in one of them.
    const fd = fs.openSync(mode.path, 'r');
    let run = [];
    let batch = [];
    let batchLen = 0;
    const flush = () => { if (batchLen) { parentPort.postMessage({ batch: batch.join('\n') }); batch = []; batchLen = 0; } };
    const endRun = () => {
      if (run.length >= mode.minRun) {
        const s = Buffer.from(run).toString('latin1');
        batch.push(s); batchLen += s.length + 1;
        if (batchLen >= mode.batchChars) flush();
      }
      run = [];
    };
    try {
      pump(fd, (b) => {
        for (let i = 0; i < b.length; i++) {
          const c = b[i];
          if ((c >= 0x20 && c <= 0x7e) || c === 0x09 || c === 0x0a || c === 0x0d) {
            run.push(c);
            if (run.length >= mode.batchChars) {
              const tail = run.slice(-mode.overlap);
              endRun();
              run = tail;
            }
          } else endRun();
        }
      });
      endRun();
      flush();
    } finally { fs.closeSync(fd); }
    return { scanned: true };
  }
  throw new Error('unknown op');
}

try { parentPort.postMessage({ result: run() }); }
catch (e) { parentPort.postMessage({ error: e && e.message ? e.message : String(e) }); }
`;

function runWorker<T>(data: Record<string, unknown>, onBatch?: (batch: string) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const w = new Worker(WORKER_SOURCE, { eval: true, workerData: data });
    let settled = false;
    const finish = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
    w.on('message', (m: { result?: T; error?: string; batch?: string }) => {
      if (typeof m.batch === 'string') { onBatch?.(m.batch); return; }
      if (m.error !== undefined) finish(() => reject(new Error(m.error)));
      else finish(() => resolve(m.result as T));
    });
    w.on('error', (err) => finish(() => reject(err)));
    w.on('exit', () => finish(() => reject(new Error('media worker exited without a result'))));
  });
}

export function hashFile(path: string): Promise<HashedFile> { return runWorker({ op: 'hash', path }); }

/** Concatenate chunks into `outPath` (mode 0400, fsynced) while hashing. */
export function assembleChunks(chunkPaths: string[], outPath: string): Promise<HashedFile> {
  return runWorker({ op: 'assemble', chunkPaths, outPath });
}

/** Copy a checked open descriptor to a new private file; `{over:true}` once it passes `limit`. */
export function snapshotDescriptor(fd: number, outPath: string, limit: number): Promise<HashedFile | { over: true }> {
  return runWorker({ op: 'snapshot', fd, outPath, limit });
}

/** Stream a file's printable runs; `onBatch` is called on the event loop with bounded strings. */
export async function scanPrintableRuns(path: string, opts: { minRun: number; batchChars: number; overlap: number }, onBatch: (batch: string) => void): Promise<void> {
  await runWorker({ op: 'printable', path, ...opts }, onBatch);
}

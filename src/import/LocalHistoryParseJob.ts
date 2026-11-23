/** Parent-side bounded parse execution. The caller supplies a REAL shared child
 * lease, live owner checks, already-owned input descriptors and a private output
 * writer that reserves disk before writing each block. This does not admit HTTP
 * requests, discover files, grant access or publish a preview by itself.
 */
import { CLAUDE_CODE_FRAMEWORK } from '../core/frameworkFacts.js';
import crypto from 'node:crypto';
import { fork, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { CHUNK_BYTES } from '../core/appMediaTypes.js';
import { MAX_LOCAL_SESSION_BYTES } from './localSessionSnapshot.js';
import type { LocalHistoryCustodyToken } from './LocalHistoryChildCustody.js';
import type { LocalSessionCounts, LocalSessionRepresentation, LocalSessionSource } from './localSessionParsers.js';

export interface LocalHistoryChildLease {
  /** Shared process-held custody, checked by the fixed child before readiness. */
  readonly custody: LocalHistoryCustodyToken;
  /** Validate parent-held admission after spawn. The child must then acknowledge
   * its actual shared custody lock before any private input is sent. Its PID is
   * not a recovery authority; a surviving shared holder keeps the lane busy. */
  registerChild(pid: number): Promise<void>;
  /** Called only after actual exit (or proven spawn failure), never on a timer. */
  release(): void | Promise<void>;
}
export interface LocalHistoryParseReceipt {
  bytes: number;
  sha256: string;
  counts: LocalSessionCounts;
  representation: LocalSessionRepresentation;
  rssProtection: 'sampled' | 'unavailable';
}
export interface LocalHistoryParseInput {
  source: LocalSessionSource;
  expectedSessionId: string;
  expectedProjectPath: string;
  bytes: number;
  sha256: string;
  expectedRepresentation?: LocalSessionRepresentation;
}
export interface LocalHistoryParseJobOptions {
  input: LocalHistoryParseInput;
  /** Required stateDir-shared combined preparation/apply/read admission. */
  acquireChild(): Promise<LocalHistoryChildLease | null>;
  authorized(): boolean;
  /** Close owned descriptors promptly on abort; no client paths or live discovery. */
  chunks(signal: AbortSignal): AsyncIterable<Buffer>;
  /** Borrowed bytes are cleared after this resolves. Reserve BEFORE the write. */
  writeOutput(bytes: Buffer, signal: AbortSignal): Promise<void>;
  heapMiB: number;
  deadlineMs: number;
  rssBytes: number;
}

/** Sampled protection, not an OS hard memory sandbox. Unsupported/failed reads
 * are reported as unavailable; they never become a false containment claim. */
export async function localHistoryChildRss(pid: number): Promise<number | null> {
  if (!['darwin', 'linux'].includes(process.platform) || !Number.isSafeInteger(pid) || pid <= 0) return null;
  return new Promise(resolve => execFile('/bin/ps', ['-o', 'rss=', '-p', String(pid)],
    { timeout: 1000, maxBuffer: 1024, env: { LANG: 'C', PATH: '/usr/bin:/bin' } }, (error, stdout) => {
      const kib = Number(stdout.trim());
      resolve(!error && Number.isSafeInteger(kib) && kib > 0 && Number.isSafeInteger(kib * 1024) ? kib * 1024 : null);
    }));
}

function validReceipt(value: unknown): value is Omit<LocalHistoryParseReceipt, 'rssProtection'> & {kind: 'complete'} {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  if (r.kind !== 'complete' || typeof r.bytes !== 'number' || !Number.isSafeInteger(r.bytes) || r.bytes <= 0
    || typeof r.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(r.sha256)
    || !['canonical', 'event-fallback', 'claude-records'].includes(String(r.representation))
    || !r.counts || typeof r.counts !== 'object'
    || Object.keys(r).some(key => !['kind', 'bytes', 'sha256', 'counts', 'representation'].includes(key))
    || Object.keys(r.counts).length !== 5) return false;
  return ['records', 'malformed', 'excluded', 'duplicateMessages', 'toolCalls'].every(key => {
    const count = (r.counts as Record<string, unknown>)[key];
    return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0;
  });
}

export class LocalHistoryParseJobRefused extends Error {
  cleanupPending = false;
}
function ownOptions(value: LocalHistoryParseJobOptions): LocalHistoryParseJobOptions {
  try {
    const source = value.input;
    const input = Object.freeze({ source: source.source, expectedSessionId: source.expectedSessionId,
      expectedProjectPath: source.expectedProjectPath, bytes: source.bytes, sha256: source.sha256,
      ...(source.expectedRepresentation !== undefined ? { expectedRepresentation: source.expectedRepresentation } : {}) });
    const owned = { input, acquireChild: value.acquireChild, authorized: value.authorized,
      chunks: value.chunks, writeOutput: value.writeOutput, heapMiB: value.heapMiB,
      deadlineMs: value.deadlineMs, rssBytes: value.rssBytes };
    if (![owned.acquireChild, owned.authorized, owned.chunks, owned.writeOutput].every(fn => typeof fn === 'function')) {
      throw new Error();
    }
    return Object.freeze(owned);
  } catch { throw new LocalHistoryParseJobRefused('local-history-parser-options'); }
}
export async function runLocalHistoryParseJob(value: LocalHistoryParseJobOptions): Promise<LocalHistoryParseReceipt> {
  const opts = ownOptions(value);
  const { input } = opts;
  if (![opts.heapMiB, opts.deadlineMs, opts.rssBytes].every(n => Number.isSafeInteger(n) && n > 0)
    || !Number.isSafeInteger(input.bytes) || input.bytes <= 0 || input.bytes > MAX_LOCAL_SESSION_BYTES
    || (input.source !== 'codex' && input.source !== CLAUDE_CODE_FRAMEWORK)
    || typeof input.expectedSessionId !== 'string' || !input.expectedSessionId
    || typeof input.expectedProjectPath !== 'string' || !input.expectedProjectPath
    || typeof input.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(input.sha256)
    || (input.expectedRepresentation !== undefined && !['canonical', 'event-fallback', 'claude-records'].includes(input.expectedRepresentation))) throw new LocalHistoryParseJobRefused('local-history-parser-policy');
  const header = Buffer.from(JSON.stringify(input));
  if (header.length > CHUNK_BYTES) {
    header.fill(0); throw new LocalHistoryParseJobRefused('local-history-parser-header');
  }
  let lease: LocalHistoryChildLease | null;
  try { lease = await opts.acquireChild(); }
  catch { header.fill(0); throw new LocalHistoryParseJobRefused('local-history-worker-admission'); }
  if (!lease) { header.fill(0); throw new LocalHistoryParseJobRefused('local-history-worker-busy'); }
  let primaryFailure: LocalHistoryParseJobRefused | undefined;
  try {
    let initiallyAuthorized = false;
    try { initiallyAuthorized = opts.authorized() === true; } catch { /* fail closed */ }
    if (!initiallyAuthorized) throw new LocalHistoryParseJobRefused('local-history-not-authorized');
    const child = fork(fileURLToPath(new URL('./localHistoryParseWorker.js', import.meta.url)), [], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'], execArgv: [`--max-old-space-size=${opts.heapMiB}`],
      env: { LANG: 'C.UTF-8', TZ: 'UTC', INSTAR_LOCAL_HISTORY_CUSTODY: JSON.stringify(lease.custody) },
    });
    const abort = new AbortController();
    let signalReady!: () => void;
    let childReady = false;
    const readiness = new Promise<void>(resolve => { signalReady = resolve; });
    let signalControl!: () => void;
    const controlReady = new Promise<void>(resolve => { signalControl = resolve; });
    abort.signal.addEventListener('abort', () => { signalControl(); signalReady(); }, { once: true });
    const deadline = performance.now() + opts.deadlineMs;
    let failure: string | undefined;
    let exited = false;
    let inputEnded = false;
    let receipt: Omit<LocalHistoryParseReceipt, 'rssProtection'> | undefined;
    let rssProtection: LocalHistoryParseReceipt['rssProtection'] = 'unavailable';
    let sampling = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const fail = (code: string) => {
      failure ??= code;
      abort.abort();
      child.stdin?.destroy();
      if (!exited && child.pid) {
        child.kill('SIGTERM');
        killTimer ??= setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, 1000);
      }
    };
    const exit = new Promise<{code: number | null; signal: NodeJS.Signals | null}>(resolve => {
      child.once('exit', (code, signal) => {
        exited = true;
        if (code !== 0 || signal || !inputEnded) fail('local-history-parser-refused');
        resolve({ code, signal });
      });
      child.once('error', () => {
        fail('local-history-parser-spawn');
        if (!child.pid) { exited = true; resolve({ code: null, signal: null }); }
      });
    });
    // Consume but never retain or forward private/native diagnostics.
    child.stderr!.resume();
    child.stdin!.on('error', () => fail('local-history-parser-input'));
    child.on('message', message => {
      if (message && typeof message === 'object' && (message as {kind?: string}).kind === 'ready'
        && Object.keys(message).length === 1 && !childReady) { childReady = true; signalReady(); return; }
      if (childReady && validReceipt(message) && !receipt) {
        receipt = { bytes: message.bytes, sha256: message.sha256, representation: message.representation, counts: { ...message.counts } };
        signalControl();
      }
      else fail('local-history-parser-refused');
    });
    const guard = () => {
      let authorized = false;
      try { authorized = opts.authorized() === true; } catch { /* fail closed */ }
      if (!authorized) fail('local-history-not-authorized');
      if (performance.now() >= deadline) fail('local-history-parser-timeout');
      if (failure) throw new LocalHistoryParseJobRefused(failure);
    };
    const monitor = setInterval(() => {
      try { guard(); } catch { return; }
      if (exited || sampling || !child.pid) return;
      sampling = true;
      void localHistoryChildRss(child.pid).then(bytes => {
        if (exited) return;
        if (bytes === null) rssProtection = 'unavailable';
        else {
          rssProtection = 'sampled';
          if (bytes > opts.rssBytes) fail('local-history-parser-capacity');
        }
      }).finally(() => { sampling = false; });
    }, 100);
    const write = async (bytes: Buffer) => {
      guard();
      await new Promise<void>((resolve, reject) => child.stdin!.write(bytes, error => error ? reject(error) : resolve()));
      guard();
    };
    const send = async () => {
      const size = Buffer.alloc(4); size.writeUInt32BE(header.length);
      try {
        await write(size); await write(header); header.fill(0);
        const digest = crypto.createHash('sha256'); let count = 0;
        for await (const bytes of opts.chunks(abort.signal)) {
          guard();
          if (bytes.length > CHUNK_BYTES) throw new Error('input-block-size');
          count += bytes.length;
          if (count > input.bytes) throw new Error('source-size');
          digest.update(bytes); await write(bytes);
        }
        if (count !== input.bytes || digest.digest('hex') !== input.sha256) throw new Error('source-mismatch');
        guard(); inputEnded = true; child.stdin!.end();
      } catch { fail(failure ?? 'local-history-parser-input'); }
    };
    const digest = crypto.createHash('sha256'); let count = 0;
    const receive = async () => {
      try {
        for await (const block of child.stdout!) {
          const bytes = block as Buffer;
          try {
            guard(); digest.update(bytes); count += bytes.length;
            if (!Number.isSafeInteger(count)) throw new Error('output-size');
            await opts.writeOutput(bytes, abort.signal); guard();
          } finally { bytes.fill(0); }
        }
      } catch { fail(failure ?? 'local-history-parser-output'); }
    };
    try {
      if (!child.pid) throw new LocalHistoryParseJobRefused('local-history-parser-spawn');
      try { await lease.registerChild(child.pid); }
      catch { throw new LocalHistoryParseJobRefused('local-history-child-registration'); }
      await readiness;
      guard();
      if (!childReady) throw new LocalHistoryParseJobRefused('local-history-child-custody');
      const sending = send(); const receiving = receive();
      const result = await exit;
      await Promise.all([sending, receiving]);
      await controlReady;
      if (failure) throw new LocalHistoryParseJobRefused(failure);
      guard();
      if (result.code !== 0 || result.signal || !receipt || receipt.bytes !== count
        || receipt.sha256 !== digest.digest('hex')) throw new LocalHistoryParseJobRefused('local-history-parser-refused');
      return { bytes: receipt.bytes, sha256: receipt.sha256, counts: receipt.counts,
        representation: receipt.representation, rssProtection };
    } finally {
      clearInterval(monitor);
      if (!exited) { fail('local-history-parser-disposal'); await exit; }
      if (killTimer) clearTimeout(killTimer);
      child.stdin!.destroy(); child.stdout!.destroy(); child.stderr!.destroy();
      if (child.connected) child.disconnect();
    }
  } catch (error) {
    primaryFailure = error instanceof LocalHistoryParseJobRefused ? error
      : new LocalHistoryParseJobRefused('local-history-parser-refused');
    throw primaryFailure;
  } finally {
    header.fill(0);
    try { await lease.release(); }
    catch {
      if (primaryFailure) primaryFailure.cleanupPending = true;
      else {
        const refusal = new LocalHistoryParseJobRefused('local-history-worker-release');
        refusal.cleanupPending = true; throw refusal;
      }
    }
  }
}

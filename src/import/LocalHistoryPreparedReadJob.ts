/** Parent supervision for the fixed read-only preview process. Admission and
 * current owner authorization come from the actual parent operation, never a
 * serialized client assertion. This job does not publish consent or copy data.
 */
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { CHUNK_BYTES } from '../core/appMediaTypes.js';
import { localHistoryChildRss, type LocalHistoryChildLease } from './LocalHistoryParseJob.js';
import type { LocalHistoryPreparedPreview, LocalHistoryPreparedPreviewInput } from './LocalHistoryPreparedPreview.js';

export interface LocalHistoryPreparedReadJobOptions {
  input: LocalHistoryPreparedPreviewInput;
  acquireChild(): Promise<LocalHistoryChildLease | null>;
  authorized(): boolean;
  chunks(signal: AbortSignal): AsyncIterable<Buffer>;
  heapMiB: number;
  perFileDeadlineMs: number;
  rssBytes: number;
}
export class LocalHistoryPreparedReadRefused extends Error { cleanupPending = false; }

function validPreview(value: unknown, input: LocalHistoryPreparedPreviewInput): value is LocalHistoryPreparedPreview {
  if (!value || typeof value !== 'object') return false;
  const result = value as LocalHistoryPreparedPreview;
  const expectedKeys = input.includeFirstClaimPlan ? 'files,firstClaimPlan,messages,newMessages' : 'files,messages,newMessages';
  if (Object.keys(result).sort().join(',') !== expectedKeys
    || !Array.isArray(result.files) || result.files.length !== input.descriptors.length
    || Buffer.byteLength(JSON.stringify(result)) > CHUNK_BYTES) return false;
  if (input.includeFirstClaimPlan) {
    const plan = result.firstClaimPlan;
    if (!plan || typeof plan !== 'object'
      || Object.keys(plan).sort().join(',') !== 'contentBytes,databaseCeilingBytes,fileId,journalBytes'
      || plan.fileId !== input.descriptors[0].fileId
      || ![plan.contentBytes, plan.databaseCeilingBytes, plan.journalBytes].every(n => Number.isSafeInteger(n) && n >= 0)
      || !Number.isSafeInteger(plan.databaseCeilingBytes + plan.journalBytes)
      || plan.contentBytes > plan.databaseCeilingBytes + plan.journalBytes) return false;
  }
  let messages = 0, fresh = 0;
  for (const [index, file] of result.files.entries()) {
    if (!file || typeof file !== 'object'
      || Object.keys(file).sort().join(',') !== 'destinationFingerprint,fileId,messages,newMessages,projectPath,redactions,source'
      || file.fileId !== input.descriptors[index].fileId || file.source !== input.descriptors[index].source
      || typeof file.projectPath !== 'string' || !file.projectPath
      || !Number.isSafeInteger(file.messages) || file.messages < 0
      || !Number.isSafeInteger(file.newMessages) || file.newMessages < 0 || file.newMessages > file.messages
      || !Number.isSafeInteger(file.redactions) || file.redactions < 0
      || (file.destinationFingerprint !== null && (typeof file.destinationFingerprint !== 'string'
        || !/^[a-f0-9]{64}$/.test(file.destinationFingerprint)))) return false;
    messages += file.messages; fresh += file.newMessages;
  }
  return Number.isSafeInteger(messages) && Number.isSafeInteger(fresh) && messages === result.messages && fresh === result.newMessages;
}

export async function runLocalHistoryPreparedReadJob(value: LocalHistoryPreparedReadJobOptions): Promise<{
  preview: LocalHistoryPreparedPreview; rssProtection: 'sampled' | 'unavailable';
}> {
  // Own the private metadata before the first await; later caller mutation
  // cannot substitute a different file list under the same admitted execution.
  let input: LocalHistoryPreparedPreviewInput;
  try { input = JSON.parse(JSON.stringify(value.input)); }
  catch { throw new LocalHistoryPreparedReadRefused('local-history-preview-options'); }
  const opts = { ...value, input };
  if (![opts.heapMiB, opts.perFileDeadlineMs, opts.rssBytes, input?.maxArtifactBytes].every(n => Number.isSafeInteger(n) && n > 0)
    || ![opts.acquireChild, opts.authorized, opts.chunks].every(fn => typeof fn === 'function')
    || (input.includeFirstClaimPlan !== undefined && input.includeFirstClaimPlan !== true)
    || !Array.isArray(input.descriptors) || !input.descriptors.length || input.descriptors.length > 1024) {
    throw new LocalHistoryPreparedReadRefused('local-history-preview-policy');
  }
  let expectedBytes = 0;
  for (const descriptor of input.descriptors) {
    if (!Number.isSafeInteger(descriptor.bytes) || descriptor.bytes <= 0 || descriptor.bytes > input.maxArtifactBytes) {
      throw new LocalHistoryPreparedReadRefused('local-history-preview-policy');
    }
    expectedBytes += descriptor.bytes;
  }
  const header = Buffer.from(JSON.stringify(input));
  if (!Number.isSafeInteger(expectedBytes) || header.length > CHUNK_BYTES) {
    header.fill(0); throw new LocalHistoryPreparedReadRefused('local-history-preview-policy');
  }
  let lease: LocalHistoryChildLease | null = null;
  let primary: LocalHistoryPreparedReadRefused | undefined;
  try {
    lease = await opts.acquireChild();
    if (!lease || input.stateDir !== lease.custody.stateDir) throw new LocalHistoryPreparedReadRefused('local-history-preview-admission');
    if (opts.authorized() !== true) throw new LocalHistoryPreparedReadRefused('local-history-not-authorized');
    const child = fork(fileURLToPath(new URL('./localHistoryPreparedReadWorker.js', import.meta.url)), [], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'], execArgv: [`--max-old-space-size=${opts.heapMiB}`],
      env: { LANG: 'C.UTF-8', TZ: 'UTC', INSTAR_LOCAL_HISTORY_CUSTODY: JSON.stringify(lease.custody) },
    });
    const abort = new AbortController();
    let failure: string | undefined, ready = false, ended = false, closed = false;
    let index = -1, deadline = performance.now() + opts.perFileDeadlineMs;
    let preview: LocalHistoryPreparedPreview | undefined;
    let rssProtection: 'sampled' | 'unavailable' = 'unavailable', sampling = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let wakeReady!: () => void, wakeFirstFile!: () => void;
    const readiness = new Promise<void>(resolve => { wakeReady = resolve; });
    const firstFile = new Promise<void>(resolve => { wakeFirstFile = resolve; });
    const fail = (code: string) => {
      failure ??= code; abort.abort(); wakeReady(); wakeFirstFile(); child.stdin!.destroy();
      if (!closed && child.pid) {
        child.kill('SIGTERM');
        killTimer ??= setTimeout(() => { if (!closed) child.kill('SIGKILL'); }, 1000);
      }
    };
    const close = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      child.once('close', (code, signal) => {
        closed = true;
        if (code !== 0 || signal || !ended || !preview) fail('local-history-preview-refused');
        wakeReady(); resolve({ code, signal });
      });
    });
    child.once('error', () => fail('local-history-preview-spawn'));
    child.stdin!.on('error', () => fail('local-history-preview-input'));
    child.stdout!.on('data', () => fail('local-history-preview-output'));
    child.stderr!.resume(); // Never retain or relay private/native diagnostics.
    child.on('message', message => {
      try { guard(); } catch { return; }
      if (!message || typeof message !== 'object') return fail('local-history-preview-protocol');
      const row = message as Record<string, unknown>;
      if (!ready && row.kind === 'ready' && Object.keys(row).length === 1) { ready = true; wakeReady(); return; }
      if (ready && !preview && row.kind === 'refused' && Object.keys(row).length === 2) {
        if (row.code === 'writer-busy' && index === -1) return fail('local-history-preview-writer-busy');
        if (row.code === 'preview-refused') return fail('local-history-preview-refused');
      }
      if (ready && !preview && row.kind === 'file' && Object.keys(row).length === 2
        && row.index === index + 1 && index + 1 < input.descriptors.length) {
        index++; deadline = performance.now() + opts.perFileDeadlineMs; wakeFirstFile(); return;
      }
      if (ready && !preview && ended && row.kind === 'complete' && Object.keys(row).length === 2
        && index === input.descriptors.length - 1 && validPreview(row.preview, input)) { preview = row.preview; return; }
      fail('local-history-preview-protocol');
    });
    const guard = () => {
      let authorized = false;
      try { authorized = opts.authorized() === true; } catch { /* Fail closed. */ }
      if (!authorized) fail('local-history-not-authorized');
      if (performance.now() >= deadline) fail('local-history-preview-timeout');
      if (failure) throw new LocalHistoryPreparedReadRefused(failure);
    };
    const monitor = setInterval(() => {
      try { guard(); } catch { return; }
      if (closed || sampling || !child.pid) return;
      sampling = true;
      void localHistoryChildRss(child.pid).then(bytes => {
        if (closed) return;
        rssProtection = bytes === null ? 'unavailable' : 'sampled';
        if (bytes !== null && bytes > opts.rssBytes) fail('local-history-preview-capacity');
      }).finally(() => { sampling = false; });
    }, 100);
    const write = async (bytes: Buffer) => {
      guard();
      await new Promise<void>((resolve, reject) => child.stdin!.write(bytes, error => error ? reject(error) : resolve()));
      guard();
    };
    try {
      if (!child.pid) throw new Error('spawn');
      await lease.registerChild(child.pid); await readiness; guard();
      if (!ready) throw new Error('custody');
      const sending = (async () => {
        try {
          const size = Buffer.alloc(4); size.writeUInt32BE(header.length);
          await write(size); await write(header); header.fill(0);
          // The first progress signal is emitted from inside the real writer
          // section before the child requests any artifact bytes.
          await firstFile; guard();
          let seen = 0;
          for await (const bytes of opts.chunks(abort.signal)) {
            if (!Buffer.isBuffer(bytes) || bytes.length > CHUNK_BYTES) throw new Error('block');
            seen += bytes.length; if (seen > expectedBytes) throw new Error('size');
            await write(bytes);
          }
          if (seen !== expectedBytes) throw new Error('size');
          guard(); ended = true; child.stdin!.end();
        } catch { fail('local-history-preview-input'); }
      })();
      const result = await close; await sending; guard();
      if (result.code !== 0 || result.signal || !preview) throw new Error('refused');
      return { preview, rssProtection };
    } finally {
      clearInterval(monitor);
      if (!closed) { fail('local-history-preview-disposal'); await close; }
      if (killTimer) clearTimeout(killTimer);
      child.stdin!.destroy(); child.stdout!.destroy(); child.stderr!.destroy();
      if (child.connected) child.disconnect();
    }
  } catch (error) {
    primary = error instanceof LocalHistoryPreparedReadRefused ? error : new LocalHistoryPreparedReadRefused('local-history-preview-refused');
    throw primary;
  } finally {
    header.fill(0);
    if (lease) try { await lease.release(); } catch {
      if (primary) primary.cleanupPending = true;
      else { const refusal = new LocalHistoryPreparedReadRefused('local-history-preview-release'); refusal.cleanupPending = true; throw refusal; }
    }
  }
}

import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import type { LocalJobDefinitionPreviewSnapshot } from './JobDefinitionPreview.js';
import { isJobDefinitionPreviewPosition, type JobDefinitionPreviewPosition } from './JobDefinitionPreviewCursor.js';

type PublicRow = Omit<LocalJobDefinitionPreviewSnapshot['rows'][number], 'occurrence'>;
export type JobDefinitionPreviewPage = Omit<LocalJobDefinitionPreviewSnapshot, 'rows' | 'fingerprint'> & {
  rows: PublicRow[];
  truncated: boolean;
};
export type JobDefinitionPreviewWorkerResult =
  | { status: 'ready'; page: JobDefinitionPreviewPage; continuation?: JobDefinitionPreviewPosition }
  | { status: 'busy' }
  | { status: 'unavailable' }
  | { status: 'restart' };

const PAGE_BYTES = 512 * 1024 - 1024;
const PAGE_ROWS = 250;
const DEADLINE_MS = 2_000;
let busy = false;

export function buildJobDefinitionPreviewPage(
  snapshot: LocalJobDefinitionPreviewSnapshot,
  expected?: JobDefinitionPreviewPosition,
): JobDefinitionPreviewWorkerResult {
  const { complete, coverage, scheduler, pool, fingerprint, rows } = snapshot;
  if (expected && (!isJobDefinitionPreviewPosition(expected) || !complete
    || fingerprint !== expected.fingerprint || expected.nextIndex >= rows.length)) return { status: 'restart' };
  const page: JobDefinitionPreviewPage = { complete, coverage, scheduler, pool, rows: [], truncated: false };
  const start = expected?.nextIndex ?? 0;
  let index = start;
  // Reserve for the longer truncated boolean and charge every encoded row, including delimiters.
  let bytes = Buffer.byteLength(JSON.stringify(page)) + 1;
  while (index < rows.length && page.rows.length < PAGE_ROWS) {
    const { source, disposition, slug, enabled, executor, reason, ownership, mapping } = rows[index];
    const row = { source, disposition, slug, enabled, executor, reason, ownership, mapping };
    bytes += Buffer.byteLength(JSON.stringify(row)) + Number(page.rows.length > 0);
    if (bytes > PAGE_BYTES) break;
    page.rows.push(row);
    index++;
  }
  if (index === start && index < rows.length) return { status: 'unavailable' };
  page.truncated = index < rows.length;
  const continuation = { fingerprint, nextIndex: index };
  if (page.truncated && complete && isJobDefinitionPreviewPosition(continuation)) {
    return { status: 'ready', page, continuation };
  }
  return { status: 'ready', page };
}

export class JobDefinitionPreviewWorker {
  constructor(private readonly workerUrl = new URL('./JobDefinitionPreviewWorker.worker.js', import.meta.url)) {}

  read(input: {
    jobsFile: string;
    signal: AbortSignal;
    continuation?: JobDefinitionPreviewPosition;
  }): Promise<JobDefinitionPreviewWorkerResult> {
    if (input.signal.aborted) return Promise.resolve({ status: 'unavailable' });
    if (busy) return Promise.resolve({ status: 'busy' });

    const cutoff = performance.now() + DEADLINE_MS;
    let worker: Worker;
    try {
      worker = new Worker(this.workerUrl, {
        workerData: { jobsFile: input.jobsFile, continuation: input.continuation },
        env: {}, execArgv: [], stdout: true, stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 },
      });
    } catch {
      return Promise.resolve({ status: 'unavailable' });
    }

    busy = true;
    return new Promise(resolve => {
      let settled = false;
      let result: JobDefinitionPreviewWorkerResult | undefined;
      let forcedStop: NodeJS.Timeout | undefined;
      const complete = (value: JobDefinitionPreviewWorkerResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.signal.removeEventListener('abort', cancel);
        resolve(value);
      };
      const cancel = () => {
        complete({ status: 'unavailable' });
        try {
          worker.postMessage('cancel');
        } catch {
          // The exit listener owns admission even if the worker has already stopped.
        }
        forcedStop ??= setTimeout(() => { void worker.terminate().catch(() => {}); }, 25);
      };
      const timer = setTimeout(cancel, Math.max(0, cutoff - performance.now()));
      worker.stdout.resume();
      worker.stderr.resume();
      worker.on('message', value => { result = value as JobDefinitionPreviewWorkerResult; });
      worker.on('messageerror', cancel);
      worker.on('error', cancel);
      worker.once('exit', code => {
        clearTimeout(forcedStop);
        busy = false;
        if (code === 0 && result && !input.signal.aborted && performance.now() < cutoff) {
          complete(result);
        } else {
          complete({ status: 'unavailable' });
        }
      });
      input.signal.addEventListener('abort', cancel, { once: true });
      if (input.signal.aborted) cancel();
    });
  }
}

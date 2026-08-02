/**
 * Shared worker runtime for Cartographer's zero-cost detect operations.
 *
 * Structural population and the optional summary-authoring sweep both need the
 * same bounded, off-event-loop index scan. Keeping the worker lifecycle here
 * prevents the population path from depending on (or accidentally arming) the
 * cost-bearing sweep engine.
 */
import { Worker } from 'node:worker_threads';
import type { ApplyDeltasInput, DetectInput } from './cartographerDetect.js';

export interface CartographerDetectWorkerOptions {
  timeoutMs?: number;
  heapMb?: number;
  now?: () => number;
}

export interface CartographerWorkerResult<T> {
  ok: boolean;
  result?: T;
  error?: string;
  timedOut?: boolean;
  startFailed?: boolean;
  durationMs: number;
}

/** Minimal env allowlist: detect reads paths + git object ids, never secrets. */
function workerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'SystemRoot', 'TEMP', 'TMP']) {
    if (process.env[k]) env[k] = process.env[k];
  }
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('GIT_')) env[k] = process.env[k];
  }
  return env;
}

/** Spawn one bounded detect/write job and explicitly reap its streamed git child. */
export function runCartographerWorker<T>(
  mode: 'detect' | 'apply-deltas',
  input: DetectInput | ApplyDeltasInput,
  opts: CartographerDetectWorkerOptions = {},
): Promise<CartographerWorkerResult<T>> {
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const heapMb = opts.heapMb ?? 1536;
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      const workerUrl = new URL('./cartographerDetect.worker.js', import.meta.url);
      worker = new Worker(workerUrl, {
        workerData: { mode, input },
        resourceLimits: { maxOldGenerationSizeMb: heapMb },
        env: workerEnv(),
      });
    } catch (err) {
      // @silent-fallback-ok — the caller receives a named startFailed refusal;
      // no synchronous fallback or hidden degraded continuation occurs.
      resolve({
        ok: false,
        startFailed: true,
        error: err instanceof Error ? err.message : String(err),
        durationMs: now() - startedAt,
      });
      return;
    }

    let settled = false;
    let gitChildPid: number | null = null;
    let timeoutPending = false;
    let forceTerminateTimer: NodeJS.Timeout | null = null;
    const done = (r: Omit<CartographerWorkerResult<T>, 'durationMs'>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTerminateTimer) clearTimeout(forceTerminateTimer);
      if (gitChildPid != null) {
        try { process.kill(gitChildPid, 'SIGKILL'); } catch { /* @silent-fallback-ok — already exited is the desired terminal state */ }
        gitChildPid = null;
      }
      worker.terminate().catch(() => { /* @silent-fallback-ok — worker may already be gone after the explicit child reap */ });
      resolve({ ...r, durationMs: now() - startedAt });
    };
    const timer = setTimeout(() => {
      timeoutPending = true;
      worker.postMessage({ kind: 'cancel' });
      forceTerminateTimer = setTimeout(() => done({ ok: false, timedOut: true }), 250);
    }, timeoutMs);

    worker.on('message', (msg: { kind?: string; pid?: number; ok?: boolean; result?: T; error?: string }) => {
      if (msg.kind === 'git-child-spawned' && typeof msg.pid === 'number') { gitChildPid = msg.pid; return; }
      if (msg.kind === 'git-child-closed' && msg.pid === gitChildPid) { gitChildPid = null; return; }
      if (typeof msg.ok === 'boolean') {
        if (timeoutPending) done({ ok: false, timedOut: true });
        else done({ ok: msg.ok, result: msg.result, error: msg.error });
      }
    });
    worker.once('error', (err: Error) => done({ ok: false, error: err.message }));
    worker.once('exit', (code: number) => {
      if (!settled) done({ ok: false, error: `worker exited (${code})` });
    });
  });
}

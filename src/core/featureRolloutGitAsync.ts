import type { ChildProcess } from 'node:child_process';
import { SafeGitExecutor } from './SafeGitExecutor.js';

/** Same per-stream buffer ceiling as the synchronous executor this replaces. */
const COMMAND_BUFFER_BYTES = 10 * 1024 * 1024;

/** Finite safe-Git operation; never parses truncated output or overlaps cleanup. */
export function rolloutGitAsync(
  args: string[],
  cwd: string,
  operation: string,
  signal?: AbortSignal,
  timeoutMs = 30_000,
): Promise<string> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const fetch = args[0] === 'fetch';
    const grouped = fetch && process.platform !== 'win32';
    let child: ChildProcess;
    try {
      const options = { cwd, operation, sourceTreeReadOk: true, timeout: timeoutMs,
        stdio: ['pipe', 'pipe', 'pipe'] as const };
      child = fetch
        ? SafeGitExecutor.spawn(args, { ...options, stdio: ['ignore', 'pipe', 'pipe'], detached: grouped })
        : SafeGitExecutor.readStream(args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) { reject(error); return; }

    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let diagnosticBytes = 0;
    let failure: unknown;
    let closed = false;
    const terminate = (reason: unknown): void => {
      failure ??= reason;
      try {
        if (grouped && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch (error) {
        // @silent-fallback-ok: an exited process/group is the required state.
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure = error;
      }
    };
    const abort = (): void => terminate(new DOMException('Rollout discovery cancelled', 'AbortError'));
    const timer = setTimeout(() => terminate(new Error(`Rollout Git ${args[0]} timed out`)), timeoutMs);
    timer.unref?.();
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout?.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > COMMAND_BUFFER_BYTES) terminate(new Error('Rollout Git stdout exceeded command buffer'));
      else chunks.push(Buffer.from(chunk));
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      diagnosticBytes += chunk.length;
      if (diagnosticBytes > COMMAND_BUFFER_BYTES) terminate(new Error('Rollout Git stderr exceeded command buffer'));
    });
    child.once('error', (error) => { failure ??= error; });
    child.once('close', (code, exitSignal) => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Rollout Git ${args[0]} failed (${exitSignal ?? code})`));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    // Cancellation may have arrived between the preflight and listener installation.
    if (signal?.aborted) abort();
  });
}

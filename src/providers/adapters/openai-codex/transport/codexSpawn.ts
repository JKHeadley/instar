/**
 * Spawn helper for Codex CLI.
 *
 * Codex CLI reads stdin even when the prompt is supplied as a positional
 * argument — without an explicit EOF it hangs indefinitely. Node's
 * `execFile` / `exec` don't close stdin for us, so this helper uses
 * `spawn` and explicitly calls `child.stdin.end()` immediately.
 *
 * Empirically observed 2026-05-15: without this fix, oneShotCompletion
 * hangs for the full timeout window (30-60s) and returns empty. With it,
 * a Reply-with-PONGXYZ smoke call completes in ~4-5 seconds.
 *
 * Used by all transport primitives that spawn `codex exec` (one-shot,
 * structured one-shot). The agenticSessionHeadless primitive spawns
 * codex inside tmux, where tmux owns stdin — that path is unaffected.
 */

import { spawn } from 'node:child_process';

export interface SpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export async function spawnCodexAndWait(
  binary: string,
  args: string[],
  options: { timeoutMs: number; env: NodeJS.ProcessEnv; signal?: AbortSignal },
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let aborted = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    }, options.timeoutMs);
    timer.unref();

    const onAbort = () => {
      aborted = true;
      child.kill('SIGTERM');
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (b: Buffer) => stdoutChunks.push(b));
    child.stderr.on('data', (b: Buffer) => stderrChunks.push(b));

    child.on('error', (err) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');
      if (aborted) {
        const e: Error & { name?: string } = new Error('Aborted');
        e.name = 'AbortError';
        return reject(e);
      }
      if (timedOut) {
        const e: Error & { signal?: string; killed?: boolean; stderr?: string } = new Error(
          `Codex timed out after ${options.timeoutMs}ms`,
        );
        e.signal = 'SIGTERM';
        e.killed = true;
        e.stderr = stderr;
        return reject(e);
      }
      resolve({ exitCode: code, stdout, stderr });
    });

    // Close stdin immediately so Codex doesn't wait for input.
    child.stdin.end();
  });
}

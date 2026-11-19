/**
 * The one place the helper's sandbox drivers start host commands (`limactl`, `wsl.exe`). Async
 * only: a helper runs on someone's personal machine and must never block its event loop.
 * Injected everywhere, so unit tests record command lines instead of running anything.
 */
import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { readCapped } from './sandboxDriver.js';

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** stdout passed `maxStdout`: refused whole, the text is empty. */
  oversize?: { bytesSeen: number };
}

export interface CommandOpts {
  input?: Readable | string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Cap on stdout bytes read (default 1 MB). */
  maxStdout?: number;
  env?: NodeJS.ProcessEnv;
}

export interface CommandRunner {
  run(cmd: string, args: string[], opts?: CommandOpts): Promise<CommandResult>;
}

export const realCommandRunner: CommandRunner = {
  run(cmd, args, opts = {}) {
    return new Promise<CommandResult>((resolve) => {
      const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env: opts.env ?? process.env });
      let stderr = '';
      child.stderr.setEncoding('utf-8');
      child.stderr.on('data', (d: string) => { if (stderr.length < 64 * 1024) stderr += d; });
      const timer = opts.timeoutMs ? setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs) : null;
      timer?.unref?.();
      const onAbort = (): void => { child.kill('SIGKILL'); };
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      if (typeof opts.input === 'string') child.stdin.end(opts.input);
      else if (opts.input) opts.input.pipe(child.stdin);
      else child.stdin.end();
      child.stdin.on('error', () => { /* @silent-fallback-ok: the child exited before reading its input; its exit code reports it */ });
      const out = readCapped(child.stdout, opts.maxStdout ?? 1024 * 1024);
      child.on('error', () => { /* @silent-fallback-ok: spawn failure surfaces as code null below */ });
      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        void out.then((o) => resolve('text' in o ? { code, stdout: o.text, stderr } : { code, stdout: '', stderr, oversize: o.oversize }))
          .catch(() => resolve({ code, stdout: '', stderr })); // @silent-fallback-ok: an unreadable stdout reads as empty; callers treat a missing frame as a failed step
      });
    });
  },
};

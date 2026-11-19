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
  /**
   * Called for each complete stdout line as it arrives (without its line end). Returning true
   * consumes the line: it is not kept in `stdout` and does not count toward `maxStdout`. Used for
   * a slice's progress lines, which must be read while the slice still runs.
   */
  onStdoutLine?: (line: string) => boolean;
}

/** A stdout line longer than this is never offered to `onStdoutLine` (it is kept as plain output). */
const LINE_MAX_BYTES = 256 * 1024;

/**
 * Read a stream line by line: each complete line is offered to `onLine`; what it does not consume
 * is kept, up to `max` bytes (past the cap the WHOLE result is refused, as `readCapped` does).
 */
export function readLinesCapped(stream: Readable, max: number, onLine: (line: string) => boolean): Promise<{ text: string } | { oversize: { bytesSeen: number } }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let seen = 0;
    let over = false;
    let partial: Buffer = Buffer.alloc(0);
    const keep = (b: Buffer): void => {
      seen += b.length;
      if (seen > max) { over = true; chunks.length = 0; return; }
      if (!over) chunks.push(b);
    };
    const offer = (line: Buffer): boolean => {
      if (line.length > LINE_MAX_BYTES) return false;
      try { return onLine(line.toString('utf-8').replace(/\r?\n$/, '')) === true; } catch { return false; } // @silent-fallback-ok: a throwing line reader leaves the line in the plain output
    };
    stream.on('data', (d: Buffer | string) => {
      let buf: Buffer = Buffer.isBuffer(d) ? d : Buffer.from(String(d));
      if (partial.length > 0) buf = Buffer.concat([partial, buf]);
      let i = buf.indexOf(0x0a);
      while (i >= 0) {
        const line = buf.subarray(0, i + 1);
        buf = buf.subarray(i + 1);
        if (!offer(line)) keep(line);
        i = buf.indexOf(0x0a);
      }
      // A very long line with no end yet is plain output: keep it and stop holding it.
      if (buf.length > LINE_MAX_BYTES) { keep(buf); buf = Buffer.alloc(0); }
      partial = buf;
    });
    const done = (): void => {
      if (partial.length > 0) { if (!offer(partial)) keep(partial); partial = Buffer.alloc(0); }
      resolve(over ? { oversize: { bytesSeen: seen } } : { text: Buffer.concat(chunks).toString('utf-8') });
    };
    stream.once('end', done);
    stream.once('error', done);
  });
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
      const max = opts.maxStdout ?? 1024 * 1024;
      const out = opts.onStdoutLine ? readLinesCapped(child.stdout, max, opts.onStdoutLine) : readCapped(child.stdout, max);
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

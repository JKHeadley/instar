import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import path from 'node:path';

/** Safe structural detail; never include browser/page text or URLs in errors. */
export class BrowserProtocolError extends Error {
  readonly contextUnavailable: boolean;
  constructor(readonly method: string, error: unknown) {
    const detail = error && typeof error === 'object' ? error as { message?: unknown } : {};
    const contextUnavailable = typeof detail.message === 'string' && /execution context was destroyed|cannot find (?:default execution )?context|cannot find execution context|inspected target navigated/i.test(detail.message);
    super(`browser-protocol-error:${method}:${contextUnavailable ? 'context-unavailable' : 'request-refused'}`);
    this.contextUnavailable = contextUnavailable;
  }
}

/** Internal transport only. There is deliberately no websocket/TCP endpoint to hand to MCP. */
export class PrivateCdpPipe {
  private sequence = 0;
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<number, { method: string; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private readonly child: ChildProcess;
  private readonly input: Writable;
  private closed = false;
  private exited = false;
  private readonly exitPromise: Promise<void>;
  private readonly requestTimeoutMs: number;
  constructor(options: { executablePath: string; userDataDir: string; requestTimeoutMs?: number }) {
    if (!path.isAbsolute(options.executablePath) || !path.isAbsolute(options.userDataDir)) throw new Error('browser-path-must-be-absolute');
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs < 1 || this.requestTimeoutMs > 30_000) throw new Error('browser-request-timeout-invalid');
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot']) if (process.env[key]) env[key] = process.env[key];
    this.child = spawn(options.executablePath, [
      '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
      '--remote-debugging-pipe', `--user-data-dir=${options.userDataDir}`, 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], detached: true, env });
    this.input = this.child.stdio[3] as Writable;
    const output = this.child.stdio[4] as Readable;
    this.exitPromise = new Promise(resolve => {
      this.child.once('exit', () => { this.exited = true; this.fail(new Error('browser-process-exited')); resolve(); });
      this.child.once('error', () => { this.exited = true; this.fail(new Error('browser-process-failed')); resolve(); });
    });
    this.input.on('error', () => this.terminate(new Error('browser-pipe-failed')));
    output.on('data', (chunk: Buffer) => this.consume(chunk));
    output.on('error', () => this.terminate(new Error('browser-pipe-failed')));
  }
  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > 16 * 1024 * 1024) { void this.close(); return; }
    let end: number;
    while ((end = this.buffer.indexOf(0)) >= 0) {
      const bytes = this.buffer.subarray(0, end);
      this.buffer = this.buffer.subarray(end + 1);
      try {
        const message = JSON.parse(bytes.toString('utf8')) as { id?: number; result?: unknown; error?: unknown };
        const pending = message.id === undefined ? undefined : this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id!);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new BrowserProtocolError(pending.method, message.error));
        else pending.resolve(message.result);
      } catch { this.terminate(new Error('browser-protocol-malformed')); return; }
    }
  }
  private fail(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.buffer = Buffer.alloc(0);
  }
  private terminate(error: Error): void {
    this.fail(error);
    void this.close().catch(() => { /* The channel is closed; process termination failure cannot restore write authority. */ });
  }
  request(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    if (this.closed || this.exited) return Promise.reject(new Error('browser-pipe-closed'));
    if (this.pending.size >= 32) return Promise.reject(new Error('browser-request-capacity'));
    if (this.sequence >= Number.MAX_SAFE_INTEGER) return Promise.reject(new Error('browser-sequence-exhausted'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const bytes = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0';
      if (Buffer.byteLength(bytes) > 1024 * 1024) { reject(new Error('browser-request-too-large')); return; }
      const timer = setTimeout(() => this.terminate(new Error('browser-request-deadline')), this.requestTimeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.input.write(bytes, error => { if (error) this.terminate(new Error('browser-pipe-write-failed')); });
    });
  }
  async close(): Promise<void> {
    if (this.closed) return this.exitPromise;
    this.closed = true;
    this.fail(new Error('browser-pipe-closed'));
    // Kill the process group, not merely the page: a Web worker can keep retrying a send.
    if (!this.exited && this.child.pid) {
      try { process.kill(-this.child.pid, 'SIGKILL'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
    await this.exitPromise;
  }
}

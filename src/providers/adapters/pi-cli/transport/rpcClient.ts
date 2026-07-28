/**
 * PiRpcClient — typed client for pi's RPC mode (`pi --mode rpc`).
 *
 * Protocol (verified hands-on in the P0.1 eval, pi 0.78.1, and per upstream
 * docs/rpc.md):
 *   - Commands: one JSON object per line on stdin.
 *   - Responses: `{"type":"response","command":…,"success":…,"id":…}` lines on
 *     stdout, correlated by the optional `id` we attach to every command.
 *   - Events: every other stdout line is an agent event (agent_start,
 *     turn_start, message_update, tool_execution_start|update|end, turn_end,
 *     agent_end, …), streamed asynchronously.
 *
 * FRAMING IS STRICT LF JSONL: split records on `\n` ONLY (tolerating a
 * trailing `\r`). Node's `readline` is NOT protocol-compliant — it also
 * splits on U+2028/U+2029, which are valid INSIDE JSON strings; using it
 * would corrupt any record whose payload contains those code points. The
 * splitter below buffers manually and is exported for direct unit testing.
 *
 * The subscription guard (policy.ts) is enforced by CALLERS at session/call
 * construction — this client is the dumb pipe.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { UnexpectedError } from '../../../errors.js';
import { PI_CLI_ID } from '../errors.js';
import { buildPiChildEnv } from './piSpawn.js';

/** A parsed pi RPC response line. */
export interface PiRpcResponse {
  id?: string;
  type: 'response';
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

/** Any non-response pi event line (agent_start, message_update, …). */
export interface PiRpcEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * Strict-LF JSONL splitter. Feed raw chunks; complete lines invoke `onLine`
 * with the line content (trailing `\r` stripped, empty lines skipped).
 * Returns a function to flush the trailing partial line (used at stream end).
 *
 * Exported for unit tests — the U+2028/U+2029-inside-string case is pinned
 * there so a refactor to `readline` (which would break it) fails loudly.
 */
export function createStrictLfSplitter(onLine: (line: string) => void): {
  push: (chunk: string) => void;
  flush: () => void;
} {
  let buffer = '';
  return {
    push(chunk: string): void {
      buffer += chunk;
      let idx = buffer.indexOf('\n');
      while (idx !== -1) {
        let line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line.length > 0) onLine(line);
        idx = buffer.indexOf('\n');
      }
    },
    flush(): void {
      let line = buffer;
      buffer = '';
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.length > 0) onLine(line);
    },
  };
}

export interface PiRpcClientOptions {
  /** Absolute path to the pi binary. */
  binaryPath: string;
  /** pi `--model` pattern (`provider/id`). Callers must pass policy first. */
  model?: string;
  /** `--session-dir` (durable transcripts). */
  sessionDir?: string;
  /** `--session-id` (create-or-resume a deterministic session). */
  sessionId?: string;
  /** Run ephemeral (`--no-session`). */
  noSession?: boolean;
  /** Working directory for the pi process (tool execution cwd). */
  cwd?: string;
  /** Extra env on top of the hardened child env (tests use this). */
  envOverrides?: Record<string, string>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const CLOSE_GRACE_MS = 3_000;

/**
 * One spawned `pi --mode rpc` process. Create with `PiRpcClient.spawn()`,
 * drive with the typed command methods, consume `events()`, then `close()`.
 */
export class PiRpcClient {
  private readonly child: ChildProcess;
  private readonly pending = new Map<string, { resolve: (r: PiRpcResponse) => void; timer: NodeJS.Timeout }>();
  private readonly eventQueue: PiRpcEvent[] = [];
  private eventWaiter: (() => void) | null = null;
  private closed = false;
  private exited = false;
  private nextId = 1;

  static spawn(options: PiRpcClientOptions): PiRpcClient {
    const argv: string[] = ['--mode', 'rpc', '--offline'];
    if (options.noSession) argv.push('--no-session');
    if (options.sessionDir) argv.push('--session-dir', options.sessionDir);
    if (options.sessionId) argv.push('--session-id', options.sessionId);
    if (options.model) argv.push('--model', options.model);
    const child = spawn(options.binaryPath, argv, {
      cwd: options.cwd,
      env: { ...buildPiChildEnv(), ...(options.envOverrides ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return new PiRpcClient(child);
  }

  private constructor(child: ChildProcess) {
    this.child = child;
    const splitter = createStrictLfSplitter((line) => this.onLine(line));
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => splitter.push(chunk));
    child.stdout!.on('end', () => splitter.flush());
    child.on('exit', () => {
      this.exited = true;
      // Fail every pending request loudly rather than hanging its caller.
      for (const [id, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.resolve({ id, type: 'response', command: 'unknown', success: false, error: 'pi process exited' });
      }
      this.pending.clear();
      this.wakeEventWaiter();
    });
  }

  /** The underlying pid (HardKill primitive integration). */
  get pid(): number | undefined {
    return this.child.pid;
  }

  get isExited(): boolean {
    return this.exited;
  }

  private onLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A non-JSON stdout line violates the protocol; surface as an event so
      // consumers can log it rather than silently dropping.
      this.enqueueEvent({ type: 'pi-protocol-noise', raw: line.slice(0, 500) });
      return;
    }
    const record = parsed as PiRpcResponse | PiRpcEvent;
    if (record.type === 'response' && typeof (record as PiRpcResponse).command === 'string') {
      const response = record as PiRpcResponse;
      const entry = response.id !== undefined ? this.pending.get(response.id) : undefined;
      if (entry) {
        this.pending.delete(response.id!);
        clearTimeout(entry.timer);
        entry.resolve(response);
        return;
      }
      // Un-correlated response (no id, or already timed out) — still observable.
      this.enqueueEvent(record as unknown as PiRpcEvent);
      return;
    }
    this.enqueueEvent(record as PiRpcEvent);
  }

  private enqueueEvent(event: PiRpcEvent): void {
    this.eventQueue.push(event);
    this.wakeEventWaiter();
  }

  private wakeEventWaiter(): void {
    const waiter = this.eventWaiter;
    this.eventWaiter = null;
    waiter?.();
  }

  /** Send a raw command object (an `id` is attached automatically). */
  request(command: Record<string, unknown>, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<PiRpcResponse> {
    if (this.closed || this.exited) {
      return Promise.resolve({ type: 'response', command: String(command['type'] ?? 'unknown'), success: false, error: 'client closed' });
    }
    const id = `req-${this.nextId++}`;
    return new Promise<PiRpcResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ id, type: 'response', command: String(command['type'] ?? 'unknown'), success: false, error: `timeout after ${timeoutMs}ms` });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      this.child.stdin!.write(JSON.stringify({ id, ...command }) + '\n');
    });
  }

  prompt(message: string, opts?: { streamingBehavior?: 'steer' | 'followUp' }): Promise<PiRpcResponse> {
    return this.request({ type: 'prompt', message, ...(opts?.streamingBehavior ? { streamingBehavior: opts.streamingBehavior } : {}) });
  }

  steer(message: string): Promise<PiRpcResponse> {
    return this.request({ type: 'steer', message });
  }

  followUp(message: string): Promise<PiRpcResponse> {
    return this.request({ type: 'follow_up', message });
  }

  abort(): Promise<PiRpcResponse> {
    return this.request({ type: 'abort' });
  }

  getState(): Promise<PiRpcResponse> {
    return this.request({ type: 'get_state' });
  }

  /**
   * Async iterator over agent events (everything that isn't a correlated
   * response). Ends when the process exits and the queue drains.
   */
  async *events(): AsyncGenerator<PiRpcEvent> {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      while (this.eventQueue.length > 0) {
        yield this.eventQueue.shift()!;
      }
      if (this.exited || this.closed) return;
      await new Promise<void>((resolve) => { this.eventWaiter = resolve; });
    }
  }

  /** End stdin, give pi a grace period, then escalate SIGTERM → SIGKILL. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { this.child.stdin?.end(); } catch { /* already gone */ }
    const exited = await new Promise<boolean>((resolve) => {
      if (this.exited) return resolve(true);
      const timer = setTimeout(() => resolve(false), CLOSE_GRACE_MS);
      this.child.once('exit', () => { clearTimeout(timer); resolve(true); });
    });
    if (!exited) {
      try { this.child.kill('SIGTERM'); } catch { /* already gone */ }
      const terminated = await new Promise<boolean>((resolve) => {
        if (this.exited) return resolve(true);
        const timer = setTimeout(() => resolve(false), CLOSE_GRACE_MS);
        this.child.once('exit', () => { clearTimeout(timer); resolve(true); });
      });
      if (!terminated) {
        try { this.child.kill('SIGKILL'); } catch { /* already gone */ }
      }
    }
    this.wakeEventWaiter();
  }

  /** Throw a typed error when spawn itself failed (no pid). */
  assertSpawned(): void {
    if (this.child.pid === undefined) {
      throw new UnexpectedError(
        'pi RPC process failed to spawn (no pid) — is the binary path valid?',
        PI_CLI_ID,
      );
    }
  }
}

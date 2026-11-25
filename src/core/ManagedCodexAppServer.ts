import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { guardChildStdin } from './pipeErrorGuard.js';

interface AppServerReply {
  id?: number | string;
  method?: string;
  result?: unknown;
  error?: unknown;
}
export interface ManagedCodexAppServerOptions {
  binary: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  model: string;
  modelProvider?: string;
  sandbox: 'read-only' | 'workspace-write';
  timeoutMs: number;
}

function stringId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-z-]{1,128}$/i.test(value);
}

/** A private app-server pipe creates an inert native thread before any turn. */
export async function openManagedCodexAppServer(options: ManagedCodexAppServerOptions) {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 30_000) {
    throw new Error('invalid managed app-server timeout');
  }
  const child = spawn(options.binary, ['app-server', '--stdio'], {
    cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  guardChildStdin(child.stdin, 'managed-codex-app-server');
  child.stderr.resume();

  let resolveClosed!: () => void;
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  let sequence = 0;
  let unavailable = false;
  let turnSent = false;
  let buffer = '';
  const decoder = new StringDecoder('utf8');
  const pending = new Map<number, { accept(value: unknown): void; reject(error: Error): void }>();
  function fail(error: Error): void {
    unavailable = true;
    for (const reply of pending.values()) reply.reject(error);
    pending.clear();
  }
  child.once('error', () => fail(new Error('managed Codex app-server could not start')));
  child.once('close', () => {
    fail(new Error('managed Codex app-server closed'));
    resolveClosed();
  });
  child.stdout.on('data', (chunk: Buffer) => {
    if (unavailable) return;
    buffer += decoder.write(chunk);
    if (Buffer.byteLength(buffer) > 1024 * 1024) {
      fail(new Error('managed Codex app-server response exceeded its bound'));
      return;
    }
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const event = JSON.parse(line) as AppServerReply;
        if (event.id !== undefined && event.method) throw new Error('interactive native request is unsupported');
        if (typeof event.id !== 'number') continue;
        const waiter = pending.get(event.id);
        if (!waiter) continue;
        pending.delete(event.id);
        if (event.error !== undefined) waiter.reject(new Error('managed Codex app-server refused the request'));
        else waiter.accept(event.result);
      } catch {
        fail(new Error('managed Codex app-server protocol was invalid'));
        return;
      }
    }
  });

  function request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (unavailable) return Promise.reject(new Error('managed Codex app-server is unavailable'));
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        fail(new Error('managed Codex app-server request timed out'));
      }, options.timeoutMs);
      const reply = {
        accept(value: unknown) { clearTimeout(timeout); resolve(value); },
        reject(error: Error) { clearTimeout(timeout); reject(error); },
      };
      pending.set(id, reply);
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n', error => {
        if (error) fail(new Error('managed Codex app-server pipe write failed'));
      });
    });
  }

  let closeRequest: Promise<void> | undefined;
  function close(): Promise<void> {
    return closeRequest ??= (async () => {
      fail(new Error('managed Codex app-server controller closed'));
      child.stdin.end();
      const deadline = setTimeout(() => child.kill('SIGKILL'), 2000);
      let hardDeadline: NodeJS.Timeout | undefined;
      try {
        await Promise.race([closed, new Promise<never>((_, reject) => {
          hardDeadline = setTimeout(() => reject(new Error('managed Codex app-server close unconfirmed')), 4000);
        })]);
      } finally {
        clearTimeout(deadline);
        clearTimeout(hardDeadline);
      }
    })();
  }

  try {
    await request('initialize', {
      clientInfo: { name: 'instar_managed_codex', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write('{"method":"initialized","params":{}}\n');
    const opened = await request('thread/start', {
      cwd: options.cwd, model: options.model, modelProvider: options.modelProvider,
      approvalPolicy: 'never', sandbox: options.sandbox,
    }) as { thread?: { id?: unknown } } | undefined;
    const nativeSessionId = opened?.thread?.id;
    if (!stringId(nativeSessionId)) throw new Error('managed Codex native thread identity unavailable');

    return {
      nativeSessionId,
      isOpen: () => !unavailable,
      close,
      async startFirstTurn(input: string): Promise<string> {
        if (!input || turnSent || unavailable) throw new Error('managed Codex first turn unavailable');
        turnSent = true;
        const accepted = await request('turn/start', {
          threadId: nativeSessionId, input: [{ type: 'text', text: input }],
        }) as { turn?: { id?: unknown } } | undefined;
        const turnId = accepted?.turn?.id;
        if (!stringId(turnId)) throw new Error('managed Codex first turn receipt unavailable');
        return turnId;
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Cross the WSL/Windows boundary with the existing PowerShell interop when
 * WSL cannot open a TCP connection to the interactive companion. The child
 * makes one bounded Windows-local request and never opens a listener. */
import { spawn } from 'node:child_process';

const MAX_REPLY_CHARS = 1_800_000;
const ALLOWED = new Set(['probe', 'capture', 'cursor', 'input', 'start', 'heartbeat', 'stop', 'release']);

type LocalReply = { status?: unknown; type?: unknown; body?: unknown };

function parseReply(text: string): Response {
  const reply = JSON.parse(text.trim()) as LocalReply;
  if (!Number.isInteger(reply.status) || (reply.status as number) < 200 || (reply.status as number) > 599
    || (reply.type !== 'application/json' && reply.type !== 'image/jpeg')
    || typeof reply.body !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(reply.body)) {
    throw new Error('invalid');
  }
  const bytes = Buffer.from(reply.body, 'base64');
  if (bytes.length > 1_250_000) throw new Error('large');
  return new Response(bytes, { status: reply.status as number, headers: { 'Content-Type': reply.type } });
}

type ServeChild = ReturnType<typeof spawn>;

/**
 * One long-lived PowerShell relay per lane. Starting powershell.exe from WSL
 * costs about a second, which made every click, key and frame wait that long;
 * a relay that stays up answers each request in milliseconds. Requests on a
 * lane run one at a time and in order. Screen pictures use their own lane so
 * a capture never delays input.
 */
class ServeLane {
  private child: ServeChild | null = null;
  private output = '';
  private waiting: ((error?: Error, line?: string) => void) | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  /** An installed script from before relay mode exits without answering. */
  unsupported = false;

  constructor(private readonly script: string, private readonly address: string) {}

  request(line: string, signal?: AbortSignal | null): Promise<string> {
    const run = this.tail.then(() => this.send(line, signal));
    this.tail = run.catch(() => undefined);
    return run;
  }

  private start(): ServeChild {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', this.script, '-Address', this.address, '-Serve'],
    { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    this.output = '';
    let answered = false;
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      this.output += chunk;
      if (this.output.length > MAX_REPLY_CHARS) { this.fail(child, new Error('windows-desktop-local-transport-reply-too-large')); return; }
      let newline;
      while ((newline = this.output.indexOf('\n')) >= 0) {
        const reply = this.output.slice(0, newline);
        this.output = this.output.slice(newline + 1);
        answered = true;
        const waiter = this.waiting; this.waiting = null;
        waiter?.(undefined, reply);
      }
    });
    const lost = () => {
      if (!answered) this.unsupported = true;
      this.fail(child, new Error('windows-desktop-local-transport-unavailable'));
    };
    child.on('error', lost);
    child.on('close', lost);
    child.stdin!.on('error', lost);
    return child;
  }

  private fail(child: ServeChild, error: Error): void {
    if (this.child === child) this.child = null;
    try { child.kill(); } catch { /* @silent-fallback-ok — already gone */ }
    const waiter = this.waiting; this.waiting = null;
    waiter?.(error);
  }

  private send(line: string, signal?: AbortSignal | null): Promise<string> {
    if (signal?.aborted) return Promise.reject(new Error('windows-desktop-local-transport-aborted'));
    if (!this.child) this.child = this.start();
    const child = this.child;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(child, new Error('windows-desktop-local-transport-timeout')), 4_500);
      const abort = () => this.fail(child, new Error('windows-desktop-local-transport-aborted'));
      signal?.addEventListener('abort', abort, { once: true });
      this.waiting = (error, reply) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(reply!);
      };
      child.stdin!.write(line, 'utf8');
    });
  }
}

export function windowsDesktopLocalSend(endpoint: string, script: string): typeof fetch {
  const base = new URL(endpoint);
  if (base.protocol !== 'http:' || base.port !== '44818' || base.pathname !== '/'
    || !/^(?:127\.0\.0\.1|10\.(?:\d{1,3}\.){2}\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.(?:\d{1,3}\.)\d{1,3}|192\.168\.(?:\d{1,3}\.)\d{1,3})$/.test(base.hostname)
    || !/^[A-Za-z]:\\/.test(script) || !script.toLowerCase().endsWith('\\instardesktop\\local-transport.ps1')) {
    throw new Error('windows-desktop-local-transport-config-invalid');
  }
  const lanes = { capture: new ServeLane(script, base.hostname), control: new ServeLane(script, base.hostname) };
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const operation = url.pathname.slice(1);
    if (url.origin !== base.origin || !ALLOWED.has(operation) || init?.method !== 'POST'
      || typeof init.body !== 'string') throw new Error('windows-desktop-local-transport-request-invalid');
    const headers = new Headers(init.headers);
    const request = { body: init.body,
      time: headers.get('X-Instar-Desktop-Time'),
      nonce: headers.get('X-Instar-Desktop-Nonce'),
      mac: headers.get('X-Instar-Desktop-Mac') };
    const line = JSON.stringify(request) + '\n';
    if (Buffer.byteLength(line) > 12_000) throw new Error('windows-desktop-local-transport-request-too-large');
    const lane = operation === 'capture' ? lanes.capture : lanes.control;
    if (!lane.unsupported) {
      try {
        const reply = await lane.request(JSON.stringify({ ...request, operation }) + '\n', init?.signal);
        try { return parseReply(reply); }
        catch { throw new Error('windows-desktop-local-transport-reply-invalid'); }
      } catch (error) {
        if (!lane.unsupported) throw error;
        // An older installed script has no relay mode: use one process per request.
      }
    }
    return oneShot(script, base.hostname, operation, line, init?.signal);
  }) as typeof fetch;
}

function oneShot(script: string, address: string, operation: string, line: string,
  signal?: AbortSignal | null): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('windows-desktop-local-transport-aborted')); return; }
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', script, '-Address', address, '-Operation', operation],
    { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let output = '';
    let settled = false;
    const done = (error?: Error, response?: Response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) { child.kill(); reject(error); }
      else resolve(response!);
    };
    const abort = () => done(new Error('windows-desktop-local-transport-aborted'));
    const timer = setTimeout(() => done(new Error('windows-desktop-local-transport-timeout')), 4_500);
    child.on('error', () => done(new Error('windows-desktop-local-transport-unavailable')));
    child.stdin.on('error', () => done(new Error('windows-desktop-local-transport-unavailable')));
    child.stdout.on('error', () => done(new Error('windows-desktop-local-transport-unavailable')));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.length > MAX_REPLY_CHARS) done(new Error('windows-desktop-local-transport-reply-too-large'));
    });
    child.on('close', code => {
      if (settled) return;
      if (code !== 0) { done(new Error('windows-desktop-local-transport-unavailable')); return; }
      try { done(undefined, parseReply(output)); }
      catch { done(new Error('windows-desktop-local-transport-reply-invalid')); }
    });
    child.stdin.end(line, 'utf8');
  });
}

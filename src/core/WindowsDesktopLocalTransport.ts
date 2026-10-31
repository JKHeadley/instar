/** Cross the WSL/Windows boundary with the existing PowerShell interop when
 * WSL cannot open a TCP connection to the interactive companion. The child
 * makes one bounded Windows-local request and never opens a listener. */
import { spawn } from 'node:child_process';

const MAX_REPLY_CHARS = 1_800_000;
const ALLOWED = new Set(['probe', 'capture', 'cursor', 'input', 'start', 'heartbeat', 'stop', 'release']);

export function windowsDesktopLocalSend(endpoint: string, script: string): typeof fetch {
  const base = new URL(endpoint);
  if (base.protocol !== 'http:' || base.port !== '44818' || base.pathname !== '/'
    || !/^(?:127\.0\.0\.1|10\.(?:\d{1,3}\.){2}\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.(?:\d{1,3}\.)\d{1,3}|192\.168\.(?:\d{1,3}\.)\d{1,3})$/.test(base.hostname)
    || !/^[A-Za-z]:\\/.test(script) || !script.toLowerCase().endsWith('\\instardesktop\\local-transport.ps1')) {
    throw new Error('windows-desktop-local-transport-config-invalid');
  }
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const operation = url.pathname.slice(1);
    if (url.origin !== base.origin || !ALLOWED.has(operation) || init?.method !== 'POST'
      || typeof init.body !== 'string') throw new Error('windows-desktop-local-transport-request-invalid');
    const headers = new Headers(init.headers);
    const line = JSON.stringify({ body: init.body,
      time: headers.get('X-Instar-Desktop-Time'),
      nonce: headers.get('X-Instar-Desktop-Nonce'),
      mac: headers.get('X-Instar-Desktop-Mac') }) + '\n';
    if (Buffer.byteLength(line) > 12_000) throw new Error('windows-desktop-local-transport-request-too-large');
    return new Promise<Response>((resolve, reject) => {
      if (init?.signal?.aborted) { reject(new Error('windows-desktop-local-transport-aborted')); return; }
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', script, '-Address', base.hostname, '-Operation', operation],
      { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      let output = '';
      let settled = false;
      const done = (error?: Error, response?: Response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        init?.signal?.removeEventListener('abort', abort);
        if (error) { child.kill(); reject(error); }
        else resolve(response!);
      };
      const abort = () => done(new Error('windows-desktop-local-transport-aborted'));
      const timer = setTimeout(() => done(new Error('windows-desktop-local-transport-timeout')), 4_500);
      child.on('error', () => done(new Error('windows-desktop-local-transport-unavailable')));
      child.stdin.on('error', () => done(new Error('windows-desktop-local-transport-unavailable')));
      child.stdout.on('error', () => done(new Error('windows-desktop-local-transport-unavailable')));
      init?.signal?.addEventListener('abort', abort, { once: true });
      if (init?.signal?.aborted) { abort(); return; }
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        output += chunk;
        if (output.length > MAX_REPLY_CHARS) done(new Error('windows-desktop-local-transport-reply-too-large'));
      });
      child.on('close', code => {
        if (settled) return;
        if (code !== 0) { done(new Error('windows-desktop-local-transport-unavailable')); return; }
        try {
          const reply = JSON.parse(output.trim()) as { status?: unknown; type?: unknown; body?: unknown };
          if (!Number.isInteger(reply.status) || (reply.status as number) < 200 || (reply.status as number) > 599
            || (reply.type !== 'application/json' && reply.type !== 'image/jpeg')
            || typeof reply.body !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(reply.body)) {
            throw new Error('invalid');
          }
          const bytes = Buffer.from(reply.body, 'base64');
          if (bytes.length > 1_250_000) throw new Error('large');
          done(undefined, new Response(bytes, { status: reply.status as number,
            headers: { 'Content-Type': reply.type } }));
        } catch { done(new Error('windows-desktop-local-transport-reply-invalid')); }
      });
      child.stdin.end(line, 'utf8');
    });
  }) as typeof fetch;
}

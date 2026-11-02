import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const launch = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: launch }));
import { windowsDesktopLocalSend } from '../../src/core/WindowsDesktopLocalTransport.js';

const endpoint = 'http://127.0.0.1:44818/';
const foreign = 'http://' + 'example.com';
const script = 'C:\\Users\\Justin\\AppData\\Local\\InstarDesktop\\local-transport.ps1';
type Child = EventEmitter & { stdout: PassThrough; stdin: PassThrough; kill: ReturnType<typeof vi.fn> };

function baseChild(): Child {
  const child = new EventEmitter() as Child;
  child.stdout = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = vi.fn();
  return child;
}

/** A one-shot child: answers once and exits. */
function fakeChild(reply: object | null, exitCode = 0): Child {
  const child = baseChild();
  if (reply) queueMicrotask(() => {
    child.stdout.end(JSON.stringify(reply) + '\n');
    child.emit('close', exitCode);
  });
  return child;
}

/** A relay child: answers every request line it reads, and stays up. */
function serveChild(answer: (request: { operation: string }) => object, seen: string[] = []): Child {
  const child = baseChild();
  let buffered = '';
  child.stdin.on('data', chunk => {
    buffered += String(chunk);
    let newline;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      const request = JSON.parse(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1);
      seen.push(request.operation);
      queueMicrotask(() => child.stdout.write(JSON.stringify(answer(request)) + '\n'));
    }
  });
  return child;
}

const json = (value: object) => ({ status: 200, type: 'application/json',
  body: Buffer.from(JSON.stringify(value)).toString('base64') });

describe('Windows-local desktop transport', () => {
  beforeEach(() => { launch.mockReset(); });

  it('keeps one relay process per lane instead of starting PowerShell for every request', async () => {
    const seen: string[] = [];
    launch.mockImplementation(() => serveChild(request => json({ op: request.operation }), seen));
    const send = windowsDesktopLocalSend(endpoint, script);
    const headers = { 'X-Instar-Desktop-Time': '123', 'X-Instar-Desktop-Nonce': 'nonce', 'X-Instar-Desktop-Mac': 'mac' };
    for (const op of ['probe', 'input', 'input', 'cursor']) {
      const result = await send(endpoint + op, { method: 'POST', body: '{}', headers });
      expect(await result.json()).toEqual({ op });
    }
    await send(endpoint + 'capture', { method: 'POST', body: '{}', headers });
    await send(endpoint + 'capture', { method: 'POST', body: '{}', headers });
    expect(seen).toEqual(['probe', 'input', 'input', 'cursor', 'capture', 'capture']);
    expect(launch).toHaveBeenCalledTimes(2);
    expect(launch).toHaveBeenCalledWith('powershell.exe', expect.arrayContaining([
      '-File', script, '-Address', '127.0.0.1', '-Serve',
    ]), expect.objectContaining({ windowsHide: true }));
  });

  it('falls back to one process per request when the installed script has no relay mode', async () => {
    launch.mockImplementationOnce(() => {
      const child = baseChild();
      queueMicrotask(() => child.emit('close', 1));
      return child;
    });
    launch.mockImplementation(() => fakeChild(json({ screenPermission: true })));
    const send = windowsDesktopLocalSend(endpoint, script);
    const result = await send(endpoint + 'probe', { method: 'POST', body: '{}' });
    expect(await result.json()).toEqual({ screenPermission: true });
    expect(launch).toHaveBeenLastCalledWith('powershell.exe', expect.arrayContaining([
      '-File', script, '-Address', '127.0.0.1', '-Operation', 'probe',
    ]), expect.objectContaining({ windowsHide: true }));
  });

  it('rejects a different endpoint and an oversized reply', async () => {
    launch.mockImplementation(() => serveChild(() => ({ status: 200, type: 'image/jpeg',
      body: Buffer.alloc(1_250_001).toString('base64') })));
    const send = windowsDesktopLocalSend(endpoint, script);
    await expect(send(`${foreign}/input`, { method: 'POST', body: '{}' })).rejects.toThrow('request-invalid');
    await expect(send(endpoint + 'capture', { method: 'POST', body: '{}' })).rejects.toThrow(/reply/);
  });

  it('refuses a nonlocal companion address or untrusted script path', () => {
    expect(() => windowsDesktopLocalSend(`${foreign}:44818/`, script)).toThrow('config-invalid');
    expect(() => windowsDesktopLocalSend(endpoint, 'C:\\Temp\\evil.ps1')).toThrow('config-invalid');
  });

  it('restarts a relay that dies after answering, and never launches an already aborted request', async () => {
    let first = true;
    launch.mockImplementation(() => {
      const child = serveChild(() => json({ ok: true }));
      if (first) { first = false; child.stdin.once('data', () => setTimeout(() => child.emit('close', 0), 5)); }
      return child;
    });
    const send = windowsDesktopLocalSend(endpoint, script);
    await send(endpoint + 'probe', { method: 'POST', body: '{}' });
    await new Promise(resolve => setTimeout(resolve, 20));
    const again = await send(endpoint + 'probe', { method: 'POST', body: '{}' });
    expect(await again.json()).toEqual({ ok: true });
    expect(launch).toHaveBeenCalledTimes(2);
    const calls = launch.mock.calls.length;
    const controller = new AbortController();
    controller.abort();
    await expect(send(endpoint + 'probe', { method: 'POST', body: '{}', signal: controller.signal }))
      .rejects.toThrow('transport-aborted');
    expect(launch).toHaveBeenCalledTimes(calls);
  });
});

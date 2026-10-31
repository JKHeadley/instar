import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

const launch = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: launch }));
import { windowsDesktopLocalSend } from '../../src/core/WindowsDesktopLocalTransport.js';

const endpoint = 'http://127.0.0.1:44818/';
const script = 'C:\\Users\\Justin\\AppData\\Local\\InstarDesktop\\local-transport.ps1';

function fakeChild(reply: object | null, exitCode = 0) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough; stdin: PassThrough; kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = vi.fn();
  if (reply) queueMicrotask(() => {
    child.stdout.end(JSON.stringify(reply) + '\n');
    child.emit('close', exitCode);
  });
  return child;
}

describe('Windows-local desktop transport', () => {
  it('forwards only a bounded signed local request and returns the companion response', async () => {
    launch.mockImplementationOnce(() => fakeChild({ status: 200, type: 'application/json',
      body: Buffer.from('{"screenPermission":true}').toString('base64') }));
    const send = windowsDesktopLocalSend(endpoint, script);
    const result = await send(endpoint + 'probe', { method: 'POST', body: '{}', headers: {
      'X-Instar-Desktop-Time': '123', 'X-Instar-Desktop-Nonce': 'nonce', 'X-Instar-Desktop-Mac': 'mac',
    } });
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ screenPermission: true });
    expect(launch).toHaveBeenCalledWith('powershell.exe', expect.arrayContaining([
      '-File', script, '-Address', '127.0.0.1', '-Operation', 'probe',
    ]), expect.objectContaining({ windowsHide: true }));
  });

  it('rejects a different endpoint and an oversized reply', async () => {
    const send = windowsDesktopLocalSend(endpoint, script);
    await expect(send('http://example.com/input', { method: 'POST', body: '{}' })).rejects.toThrow('request-invalid');
    launch.mockImplementationOnce(() => fakeChild({ status: 200, type: 'image/jpeg',
      body: Buffer.alloc(1_250_001).toString('base64') }));
    await expect(send(endpoint + 'capture', { method: 'POST', body: '{}' })).rejects.toThrow('reply-invalid');
  });

  it('refuses a nonlocal companion address or untrusted script path', () => {
    expect(() => windowsDesktopLocalSend('http://example.com:44818/', script)).toThrow('config-invalid');
    expect(() => windowsDesktopLocalSend(endpoint, 'C:\\Temp\\evil.ps1')).toThrow('config-invalid');
  });

  it('handles an early pipe failure and never launches an already aborted request', async () => {
    const child = fakeChild(null);
    launch.mockImplementationOnce(() => {
      queueMicrotask(() => child.stdin.emit('error', new Error('EPIPE')));
      return child;
    });
    const send = windowsDesktopLocalSend(endpoint, script);
    await expect(send(endpoint + 'probe', { method: 'POST', body: '{}' }))
      .rejects.toThrow('transport-unavailable');
    const calls = launch.mock.calls.length;
    const controller = new AbortController();
    controller.abort();
    await expect(send(endpoint + 'probe', { method: 'POST', body: '{}', signal: controller.signal }))
      .rejects.toThrow('transport-aborted');
    expect(launch).toHaveBeenCalledTimes(calls);
  });
});

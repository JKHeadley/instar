import { describe, expect, it, vi } from 'vitest';
import { createHmac, createHash } from 'node:crypto';
import { WindowsDesktopHost } from '../../src/core/WindowsDesktopHost.js';

const secret = Buffer.alloc(32, 7);
const endpoint = 'http://172.22.96.1:44818/';

function validMac(op: string, init: RequestInit): boolean {
  const headers = init.headers as Record<string, string>;
  const digest = createHash('sha256').update(String(init.body)).digest('hex');
  const expected = createHmac('sha256', secret)
    .update(`instar-windows-desktop-v1\n${op}\n${headers['X-Instar-Desktop-Time']}\n${headers['X-Instar-Desktop-Nonce']}\n${digest}`)
    .digest('base64url');
  return headers['X-Instar-Desktop-Mac'] === expected;
}

describe('WindowsDesktopHost WSL boundary', () => {
  it('authenticates each bounded request and checks the real companion probe shape', async () => {
    const calls: string[] = [];
    const send = vi.fn(async (url: string, init: RequestInit) => {
      const op = url.slice(endpoint.length);
      calls.push(op);
      expect(init.redirect).toBe('manual');
      expect(validMac(op, init)).toBe(true);
      return Response.json({ screenPermission: true, inputPermission: true,
        sessionActive: true, displayCount: 1, ok: true });
    });
    const host = new WindowsDesktopHost(endpoint, secret, send as typeof fetch);
    expect(await host.probe()).toEqual({ screenPermission: true, inputPermission: true,
      sessionActive: true, displayCount: 1 });
    await host.startIndicator(() => {});
    await host.input({ kind: 'move', x: 0.3, y: 0.6 });
    host.cancelInput();
    await vi.waitFor(() => expect(calls).toContain('release'));
    host.stopIndicator();
  });

  it('accepts bounded JPEG and refuses an oversized response', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const host = new WindowsDesktopHost(endpoint, secret,
      (async (url: string) => url.endsWith('/capture')
        ? new Response(jpeg, { headers: { 'Content-Type': 'image/jpeg' } })
        : Response.json({ ok: true })) as typeof fetch);
    await host.startIndicator(() => {});
    expect(await host.capture()).toEqual(jpeg);
    host.stopIndicator();
    const oversized = new WindowsDesktopHost(endpoint, secret,
      (async (url: string) => url.endsWith('/capture')
        ? new Response(Buffer.alloc(1_250_001), { headers: { 'Content-Type': 'image/jpeg' } })
        : Response.json({ ok: true })) as typeof fetch);
    await oversized.startIndicator(() => {});
    await expect(oversized.capture()).rejects.toThrow('too-large');
    oversized.stopIndicator();
  });

  it('uses a new lease for replacement and fences old asynchronous cleanup', async () => {
    const calls: Array<{ op: string; leaseId?: string }> = [];
    const send = vi.fn(async (url: string, init: RequestInit) => {
      const op = url.slice(endpoint.length);
      const body = JSON.parse(String(init.body)) as { leaseId?: string };
      calls.push({ op, leaseId: body.leaseId });
      return Response.json({ ok: true });
    });
    const host = new WindowsDesktopHost(endpoint, secret, send as typeof fetch);
    await host.startIndicator(() => {});
    host.cancelInput();
    host.stopIndicator();
    await host.startIndicator(() => {});
    await host.input({ kind: 'move', x: 0.2, y: 0.3 });
    const starts = calls.filter(call => call.op === 'start');
    expect(starts).toHaveLength(2);
    expect(starts[0].leaseId).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(starts[1].leaseId).not.toBe(starts[0].leaseId);
    expect(calls.find(call => call.op === 'stop')?.leaseId).toBe(starts[0].leaseId);
    expect(calls.at(-1)).toEqual({ op: 'input', leaseId: starts[1].leaseId });
    host.stopIndicator();
  });

  it('refuses malformed companion addresses and secrets', () => {
    expect(() => new WindowsDesktopHost('https://example.com/', secret)).toThrow('config-invalid');
    expect(() => new WindowsDesktopHost(endpoint, Buffer.alloc(1))).toThrow('config-invalid');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { WindowsDesktopHost } from '../../src/core/WindowsDesktopHost.js';

const secret = Buffer.alloc(32, 7);
const endpoint = 'http://' + '172.22.96.1:44818/';

describe('Windows capture rate', () => {
  it('totals the Windows-side capture time the relay reports', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const send = vi.fn(async (url: string) => {
      const op = url.slice(endpoint.length);
      if (op === 'capture') return new Response(jpeg, { headers: { 'Content-Type': 'image/jpeg', 'X-Instar-Relay-Ms': '120' } });
      return Response.json({ ok: true });
    });
    const host = new WindowsDesktopHost(endpoint, secret, send as typeof fetch);
    Object.assign(host as unknown as Record<string, unknown>, { leaseId: 'lease', indicatorActive: true });
    await host.capture();
    await host.capture();
    expect(host.captureTiming()).toEqual({ count: 2, totalMs: 240, maxMs: 120 });
  });

  it('encodes a screen that already fits without a full-size redraw', () => {
    const cs = readFileSync('src/native/remote-desktop/windows/InstarDesktopCompanion.cs', 'utf8');
    expect(cs).toContain('if (width == bounds.Width && height == bounds.Height) return EncodeJpeg(full);');
  });

  it('paces the next grab from the start of the tick, not after it', () => {
    const ts = readFileSync('src/server/DesktopStreamManager.ts', 'utf8');
    expect(ts).toContain('Math.max(5, FRAME_INTERVAL_MS - (Date.now() - tickStarted))');
  });

  it('the relay script reports its request time', () => {
    const ps = readFileSync('scripts/windows-desktop-local-transport.ps1', 'utf8');
    expect(ps).toContain('ms = [int]$clock.ElapsedMilliseconds');
  });
});

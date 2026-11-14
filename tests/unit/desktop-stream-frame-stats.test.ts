import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { DesktopStreamManager, desktopStreamFrameSummary } from '../../src/server/DesktopStreamManager.js';

describe('desktop stream picture counts', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('summarises counts into rates without carrying screen content', () => {
    const summary = desktopStreamFrameSummary({ startedAt: 0, ticks: 30, backpressure: 1, captures: 29, unchanged: 9,
      captureMsTotal: 2900, captureMsMax: 400, captureFailed: 1, sent: 18, sentBytes: 2_250_000,
      droppedBudget: 2, droppedBuffer: 0, droppedSize: 0 }, 10_000);
    expect(summary).toEqual({ ticks: 30, backpressure: 1, captures: 29, unchanged: 9, captureMsMax: 400,
      captureFailed: 1, sent: 18, sentBytes: 2_250_000, droppedBudget: 2, droppedBuffer: 0, droppedSize: 0,
      seconds: 10, sentPerSecond: 1.8, captureMsAvg: 100, kbitPerSecond: 1800 });
  });

  it('logs one picture-count line when the stream closes, counting sent and unchanged pictures', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((line: unknown) => { lines.push(String(line)); });
    const server = http.createServer();
    let n = 0;
    const manager = new DesktopStreamManager(async () => ({
      grantId: 'grant-stats',
      assertActive: async () => {},
      // Every other capture is unchanged (null), like a still screen.
      captureEncrypted: async () => (n++ % 2 === 0 ? Buffer.alloc(64, 1) : null),
      decryptCommand: data => JSON.parse(data.toString()),
      input: async () => {},
      revoke: async () => {},
      release: () => {},
    }));
    server.on('upgrade', (request, socket, head) => { void manager.handleUpgrade(request, socket, head); });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing address');
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/desktop-stream`);
    await once(ws, 'open');
    await new Promise(resolve => setTimeout(resolve, 400));
    ws.send(Buffer.from(JSON.stringify({ type: 'stop' })));
    await once(ws, 'close');
    manager.closeAll();
    await new Promise<void>(resolve => server.close(() => resolve()));
    const line = lines.find(l => l.startsWith('[DesktopStream] frames: '));
    expect(line).toBeTruthy();
    const counts = JSON.parse(line!.slice('[DesktopStream] frames: '.length));
    expect(counts.sent).toBeGreaterThan(0);
    expect(counts.unchanged).toBeGreaterThan(0);
    expect(counts.captures).toBe(counts.sent + counts.unchanged + counts.droppedBudget + counts.droppedBuffer + counts.droppedSize);
    expect(line).not.toContain('grant-stats');
  });
});

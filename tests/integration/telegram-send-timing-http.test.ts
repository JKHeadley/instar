import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { observeTelegramSend } from '../../src/messaging/TelegramSendTiming.js';

afterEach(() => vi.restoreAllMocks());
describe('Telegram timing over real HTTP', () => {
  it('measures a real loop block while separately recording delayed HTTP headers', async () => {
    const rows: Record<string, number | string | null>[] = [];
    vi.spyOn(console, 'info').mockImplementation(line => {
      if (String(line).startsWith('[telegram-send-timing] ')) rows.push(JSON.parse(String(line).slice('[telegram-send-timing] '.length)));
    });
    const server = createServer((_req, res) => setTimeout(() => res.end('private response'), 240));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    let block: ReturnType<typeof setTimeout> | undefined;
    try {
      const idle = await observeTelegramSend(() => fetch(url));
      expect(idle.bodyUsed).toBe(false); await idle.text();
      const idleRow = rows.at(-1)!;
      expect(idleRow.event).toBe('headers');
      expect(idleRow.elapsedMs).toBeGreaterThan(150);
      expect(idleRow.samples).toBeGreaterThan(0);
      block = setTimeout(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 160), 40);
      const busy = await observeTelegramSend(() => fetch(url));
      expect(busy.bodyUsed).toBe(false); await busy.text();
      const busyRow = rows.at(-1)!;
      expect(busyRow.eventLoopDelayMaxMs).toBeGreaterThan(100);
      expect(typeof busyRow.processEventLoopUtilization).toBe('number');
      expect(busyRow.processEventLoopUtilization).toBeGreaterThanOrEqual(0);
      expect(busyRow.processEventLoopUtilization).toBeLessThanOrEqual(1);
      expect(JSON.stringify(rows)).not.toContain('private response');
    } finally {
      if (block) clearTimeout(block);
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
  it('records an actual fetch abort without inspecting or replacing its error', async () => {
    const rows: Record<string, unknown>[] = [];
    vi.spyOn(console, 'info').mockImplementation(line => {
      if (String(line).startsWith('[telegram-send-timing] ')) rows.push(JSON.parse(String(line).slice('[telegram-send-timing] '.length)));
    });
    const server = createServer(() => undefined);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const controller = new AbortController(), error = new Error('PRIVATE_ABORT_REASON');
      const abort = setTimeout(() => controller.abort(error), 60);
      try {
        await expect(observeTelegramSend(() => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { signal: controller.signal })))
          .rejects.toBe(error);
      } finally { clearTimeout(abort); }
      expect(rows.map(row => row.event)).toEqual(['start', 'error']);
      expect(JSON.stringify(rows)).not.toContain('PRIVATE_ABORT_REASON');
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});

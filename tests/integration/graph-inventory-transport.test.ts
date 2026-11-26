import { once } from 'node:events';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { fetchGraphInventoryStart } from '../../src/core/graphInventoryFetch.js';

describe('fresh connection for graph inventory startup', () => {
  it('uses one socket per request and does not replay a dropped response', async () => {
    const sockets = new Set<Socket>();
    const server = createServer((request, response) => {
      sockets.add(request.socket);
      request.resume();
      request.once('end', () => {
        if (request.url === '/drop') request.socket.destroy();
        else response.end('ok');
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('inventory fixture has no TCP port');
      const send = (path: string) => fetchGraphInventoryStart(`http://127.0.0.1:${address.port}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
      });
      expect(await (await send('/first')).text()).toBe('ok');
      expect(await (await send('/second')).text()).toBe('ok');
      await expect(send('/drop')).rejects.toThrow('fetch failed');
      expect(sockets.size).toBe(3);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});

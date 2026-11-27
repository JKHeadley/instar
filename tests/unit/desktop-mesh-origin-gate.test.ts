import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { WebSocketManager } from '../../src/server/WebSocketManager.js';
import { generateSigningKeyPair } from '../../src/core/MachineIdentity.js';
import type { DesktopMeshBroker } from '../../src/server/DesktopMeshBroker.js';

describe('desktop mesh browser origin gate', () => {
  it('rejects a foreign Origin before consuming a one-use ticket', async () => {
    const server = createServer();
    const consumeTicket = vi.fn(() => null);
    const signing = generateSigningKeyPair();
    const manager = new WebSocketManager({ server,
      sessionManager: {} as never, state: {} as never,
      selfMachineId: `m_${'a'.repeat(32)}`,
      desktopMeshBroker: { consumeTicket } as unknown as DesktopMeshBroker,
      desktopMeshSigningKeyPem: signing.privateKey,
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const port = (server.address() as { port: number }).port;
      const browser = new WebSocket(`ws://127.0.0.1:${port}/desktop-stream`,
        ['instar-desktop-v1', `ticket.${'K'.repeat(43)}`], { origin: 'https://attacker.example' });
      browser.on('error', () => {});
      const [, response] = await once(browser, 'unexpected-response') as [unknown, { statusCode: number }];
      expect(response.statusCode).toBe(403);
      expect(consumeTicket).not.toHaveBeenCalled();
      browser.terminate();
    } finally {
      manager.shutdown();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});

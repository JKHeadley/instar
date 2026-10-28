import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { DesktopStreamManager, type DesktopStreamSession } from '../../src/server/DesktopStreamManager.js';

describe('DesktopStreamManager', () => {
  const servers: http.Server[] = [];
  const managers: DesktopStreamManager[] = [];
  afterEach(async () => {
    for (const manager of managers.splice(0)) manager.closeAll();
    for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  });

  async function connect(admit: () => Promise<DesktopStreamSession>) {
    const server = http.createServer();
    servers.push(server);
    const manager = new DesktopStreamManager(admit);
    managers.push(manager);
    server.on('upgrade', (request, socket, head) => { void manager.handleUpgrade(request, socket, head); });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing address');
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/desktop-stream`);
    return { ws, manager };
  }

  it('refuses the upgrade when target admission fails', async () => {
    const { ws } = await connect(async () => { throw new Error('denied'); });
    const [error] = await once(ws, 'error') as [Error];
    expect(error.message).toContain('403');
  });

  it('sends a bounded binary frame and revokes on Stop', async () => {
    let active = true;
    let released = 0;
    const actions: unknown[] = [];
    const frame = Buffer.alloc(32, 7);
    const { ws } = await connect(async () => ({
      grantId: 'grant-1',
      assertActive: async () => { if (!active) throw new Error('revoked'); },
      captureEncrypted: async () => frame,
      decryptCommand: data => JSON.parse(data.toString()),
      input: async action => { actions.push(action); },
      revoke: async () => { active = false; },
      release: () => { released++; },
    }));
    await once(ws, 'open');
    const [data, binary] = await once(ws, 'message') as [Buffer, boolean];
    expect(binary).toBe(true);
    expect(Buffer.from(data)).toEqual(frame);
    ws.send(Buffer.from(JSON.stringify({ type: 'input', action: { kind: 'move', x: 0.5, y: 0.5 } })));
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(actions).toEqual([{ kind: 'move', x: 0.5, y: 0.5 }]);
    ws.send(Buffer.from(JSON.stringify({ type: 'stop' })));
    await once(ws, 'close');
    expect(active).toBe(false);
    expect(released).toBe(1);
  });

  it('closes the screen when the grant is revoked externally', async () => {
    const { ws, manager } = await connect(async () => ({
      grantId: 'grant-2',
      assertActive: async () => {},
      captureEncrypted: async () => Buffer.alloc(32),
      decryptCommand: data => JSON.parse(data.toString()),
      input: async () => {},
      revoke: async () => {},
      release: () => {},
    }));
    await once(ws, 'open');
    manager.closeGrant('grant-2');
    await once(ws, 'close');
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });
});

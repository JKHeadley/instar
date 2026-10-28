import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('survives a burst of pointer moves while preserving discrete clicks', async () => {
    const actions: Array<{ kind: string; x?: number }> = [];
    const { ws } = await connect(async () => ({
      grantId: 'burst', assertActive: async () => {},
      captureEncrypted: async () => Buffer.alloc(32),
      decryptCommand: data => JSON.parse(data.toString()),
      input: async action => {
        await new Promise(resolve => setTimeout(resolve, 8));
        actions.push(action);
      },
      revoke: async () => {}, release: () => {},
    }));
    await once(ws, 'open');
    for (let i = 0; i < 100; i++) {
      ws.send(Buffer.from(JSON.stringify({ type: 'input', action: { kind: 'move', x: i / 99, y: 0.5 } })));
    }
    for (let i = 0; i < 3; i++) {
      ws.send(Buffer.from(JSON.stringify({ type: 'input', action: { kind: 'click', x: i / 3, y: 0.5, button: 'left' } })));
    }
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(actions.filter(action => action.kind === 'click')).toHaveLength(3);
    expect(actions.filter(action => action.kind === 'move').at(-1)?.x).toBe(1);
    ws.send(Buffer.from(JSON.stringify({ type: 'stop' })));
    await once(ws, 'close');
  });

  it('drops one transient capture error and resumes frames', async () => {
    let captures = 0;
    const { ws } = await connect(async () => ({
      grantId: 'capture-retry', assertActive: async () => {},
      captureEncrypted: async () => {
        if (++captures === 1) throw new Error('transient screenshot timeout');
        return Buffer.alloc(32, 5);
      },
      decryptCommand: data => JSON.parse(data.toString()),
      input: async () => {}, revoke: async () => {}, release: () => {},
    }));
    await once(ws, 'open');
    const [frame] = await once(ws, 'message') as [Buffer];
    expect(Buffer.from(frame)).toEqual(Buffer.alloc(32, 5));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.send(Buffer.from(JSON.stringify({ type: 'stop' })));
    await once(ws, 'close');
  });

  it('keeps the stream open while a static desktop has no new frame', async () => {
    let captures = 0;
    const { ws } = await connect(async () => ({
      grantId: 'static-screen', assertActive: async () => {},
      captureEncrypted: async () => ++captures < 3 ? null : Buffer.alloc(32, 5),
      decryptCommand: data => JSON.parse(data.toString()),
      input: async () => {}, revoke: async () => {}, release: () => {},
    }));
    await once(ws, 'open');
    const [frame] = await once(ws, 'message') as [Buffer];
    expect(Buffer.from(frame)).toEqual(Buffer.alloc(32, 5));
    expect(captures).toBeGreaterThanOrEqual(3);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.send(Buffer.from(JSON.stringify({ type: 'stop' })));
    await once(ws, 'close');
  });

  it('commits only frames admitted by the bandwidth gate', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    try {
      let captures = 0;
      let queued = 0;
      const { ws } = await connect(async () => ({
        grantId: 'budget-drop', assertActive: async () => {},
        captureEncrypted: async () => { captures++; return Buffer.alloc(625_000, 7); },
        frameQueued: () => { queued++; },
        decryptCommand: data => JSON.parse(data.toString()),
        input: async () => {}, revoke: async () => {}, release: () => {},
      }));
      await once(ws, 'open');
      await once(ws, 'message');
      for (let i = 0; i < 30 && captures < 2; i++) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(captures).toBeGreaterThan(1);
      expect(queued).toBe(1);
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.send(Buffer.from(JSON.stringify({ type: 'stop' })));
      await once(ws, 'close');
    } finally { clock.mockRestore(); }
  });

  it('stops after three consecutive capture failures', async () => {
    let captures = 0;
    let releases = 0;
    const { ws } = await connect(async () => ({
      grantId: 'capture-failure-cap', assertActive: async () => {},
      captureEncrypted: async () => { captures++; throw new Error('screen capture unavailable'); },
      decryptCommand: data => JSON.parse(data.toString()),
      input: async () => {}, revoke: async () => {}, release: () => { releases++; },
    }));
    await once(ws, 'open');
    await once(ws, 'close');
    expect(captures).toBe(3);
    expect(releases).toBe(1);
  });
});

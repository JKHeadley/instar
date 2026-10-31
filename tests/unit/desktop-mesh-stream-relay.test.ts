import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { DesktopMeshStreamRelay } from '../../src/server/DesktopMeshStreamRelay.js';
import { generateSigningKeyPair } from '../../src/core/MachineIdentity.js';

describe('DesktopMeshStreamRelay', () => {
  const servers: Server[] = [];
  const relays: DesktopMeshStreamRelay[] = [];
  afterEach(async () => {
    for (const relay of relays) relay.close();
    relays.length = 0;
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  });

  it('forwards opaque frame/input bytes and closes both legs on Stop', async () => {
    const targetHttp = createServer(); servers.push(targetHttp);
    const targetWss = new WebSocketServer({ noServer: true });
    let targetSocket: WebSocket | undefined;
    let authenticatedHeader = '';
    targetHttp.on('upgrade', (request, socket, head) => {
      authenticatedHeader = String(request.headers['x-machine-id']);
      expect(request.headers.origin).toBe(`http://127.0.0.1:${(targetHttp.address() as { port: number }).port}`);
      targetWss.handleUpgrade(request, socket, head, ws => {
        targetSocket = ws;
        ws.on('message', data => ws.send(data));
        ws.send(Buffer.from([0, 1, 2, 3]));
      });
    });
    targetHttp.listen(0, '127.0.0.1'); await once(targetHttp, 'listening');
    const targetPort = (targetHttp.address() as { port: number }).port;

    const frontHttp = createServer(); servers.push(frontHttp);
    const keys = generateSigningKeyPair();
    const selfId = `m_${'a'.repeat(32)}`;
    const relay = new DesktopMeshStreamRelay(selfId, keys.privateKey); relays.push(relay);
    const requestId = '12345678-1234-1234-1234-123456789abc';
    const ticket = 'K'.repeat(43);
    frontHttp.on('upgrade', (request, socket, head) => {
      relay.handleUpgrade(request, socket, head, requestId, ticket, `http://127.0.0.1:${targetPort}`);
    });
    frontHttp.listen(0, '127.0.0.1'); await once(frontHttp, 'listening');
    const frontPort = (frontHttp.address() as { port: number }).port;
    const browser = new WebSocket(`ws://127.0.0.1:${frontPort}/desktop-stream`,
      ['instar-desktop-v1', `ticket.${ticket}`]);
    const firstFrame = once(browser, 'message');
    await once(browser, 'open');
    const [frame] = await firstFrame as [Buffer];
    expect(Buffer.from(frame)).toEqual(Buffer.from([0, 1, 2, 3]));
    expect(authenticatedHeader).toBe(selfId);
    browser.send(Buffer.from([7, 8, 9]));
    const [echo] = await once(browser, 'message') as [Buffer];
    expect(Buffer.from(echo)).toEqual(Buffer.from([7, 8, 9]));
    const browserClosed = new Promise<void>(resolve => browser.once('close', () => resolve()));
    const targetClosed = once(targetSocket!, 'close');
    relay.closeRequest(requestId);
    await Promise.all([browserClosed, targetClosed]);
    targetWss.close();
  });

  it('cancels an upstream handshake that is still pending when Stop arrives', async () => {
    const targetHttp = createServer(); servers.push(targetHttp);
    let heldTargetSocket: import('node:stream').Duplex | undefined;
    let signalHandshake!: () => void;
    const handshake = new Promise<void>(resolve => { signalHandshake = resolve; });
    targetHttp.on('upgrade', (_request, socket) => {
      // Hold the target's HTTP upgrade open as a real slow peer would.
      heldTargetSocket = socket;
      signalHandshake();
    });
    targetHttp.listen(0, '127.0.0.1'); await once(targetHttp, 'listening');
    const targetPort = (targetHttp.address() as { port: number }).port;
    const frontHttp = createServer(); servers.push(frontHttp);
    const keys = generateSigningKeyPair();
    const relay = new DesktopMeshStreamRelay(`m_${'a'.repeat(32)}`, keys.privateKey); relays.push(relay);
    const requestId = '12345678-1234-1234-1234-123456789abc';
    frontHttp.on('upgrade', (request, socket, head) => {
      relay.handleUpgrade(request, socket, head, requestId, 'K'.repeat(43), `http://127.0.0.1:${targetPort}`);
    });
    frontHttp.listen(0, '127.0.0.1'); await once(frontHttp, 'listening');
    const browser = new WebSocket(`ws://127.0.0.1:${(frontHttp.address() as { port: number }).port}/desktop-stream`);
    const opened = vi.fn();
    browser.on('open', opened);
    browser.on('error', () => {});
    const browserClosed = new Promise<void>(resolve => browser.once('close', () => resolve()));
    await handshake;
    relay.closeRequest(requestId);
    await browserClosed;
    expect(opened).not.toHaveBeenCalled();
    heldTargetSocket?.destroy();
  });
});

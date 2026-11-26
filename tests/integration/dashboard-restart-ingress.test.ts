import http from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { createDashboardRestartIngress } from '../../src/tunnel/DashboardRestartIngress.js';

async function listen(server: http.Server, port = 0): Promise<number> {
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

async function close(server: http.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

it('keeps one ingress across an app stop, boot beacon and replacement', async () => {
  const app = http.createServer((req, res) => {
    res.writeHead(req.headers.authorization === 'Bearer fixture' ? 200 : 401).end('app');
  });
  const appPort = await listen(app);
  const ingress = createDashboardRestartIngress(appPort);
  const ingressPort = await listen(ingress);
  const base = `http://127.0.0.1:${ingressPort}`;
  const boot = http.createServer((_req, res) => res.writeHead(503, { 'x-instar-boot-state': 'starting' }).end('{}'));
  const replacement = http.createServer((_req, res) => res.end('replacement'));
  const sockets = new WebSocketServer({ server: replacement });
  sockets.on('connection', (_socket, request) => { expect(request.headers.cookie).toBe('session=fixture'); });
  let websocket: WebSocket | undefined;
  try {
    expect((await fetch(base + '/dashboard')).status).toBe(401);
    expect(await (await fetch(base + '/dashboard', { headers: { authorization: 'Bearer fixture' } })).text()).toBe('app');
    await close(app);
    const page = await fetch(base + '/dashboard');
    expect(page.status).toBe(503);
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(await page.text()).toContain('Dashboard restarting');
    const api = await fetch(base + '/mobile/chat', { method: 'POST', body: 'fixture' });
    expect(api.status).toBe(503);
    expect(await api.json()).toEqual({ error: 'dashboard-restarting' });
    await listen(boot, appPort);
    expect(await (await fetch(base + '/dashboard')).text()).toContain('Dashboard restarting');
    await close(boot);
    await listen(replacement, appPort);
    expect(await (await fetch(base + '/dashboard')).text()).toBe('replacement');
    websocket = new WebSocket(`ws://127.0.0.1:${ingressPort}/terminal`, { headers: { cookie: 'session=fixture' } });
    await once(websocket, 'open');
  } finally {
    websocket?.terminate();
    sockets.close();
    await Promise.all([close(ingress), close(app), close(boot), close(replacement)]);
  }
});

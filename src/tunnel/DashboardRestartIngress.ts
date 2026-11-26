import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { BOOT_STATE_HEADER } from '../server/BootReadiness.js';

const loopback = '127.0.0.1';
const hopByHop = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
const restartPage = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Dashboard restarting</title></head><body><main><h1>Dashboard restarting</h1><p>Refresh this page in a few seconds.</p></main></body></html>';

function forwardingHeaders(source: IncomingHttpHeaders): IncomingHttpHeaders {
  const headers = { ...source };
  for (const key of [...hopByHop, ...(source.connection ?? '').toLowerCase().split(',').map(value => value.trim())]) {
    delete headers[key];
  }
  return headers;
}

function restart(req: IncomingMessage, res: ServerResponse): void {
  const page = (req.method === 'GET' || req.method === 'HEAD') &&
    (req.url?.split('?')[0] === '/dashboard' || req.headers.accept?.includes('text/html'));
  res.writeHead(503, {
    'content-type': page ? 'text/html; charset=utf-8' : 'application/json',
    'cache-control': 'no-store',
    'retry-after': '5',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
  });
  res.end(req.method === 'HEAD' ? undefined : page ? restartPage : '{"error":"dashboard-restarting"}');
}

/** Dedicated loopback origin. It never retries a request that may have reached the app. */
export function createDashboardRestartIngress(appPort: number): http.Server {
  if (!Number.isInteger(appPort) || appPort < 1 || appPort > 65535) throw new Error('Invalid dashboard app port');
  const upgraded = new Set<Duplex>();
  const server = http.createServer((req, res) => {
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) { res.writeHead(400).end(); return; }
    const upstream = http.request({
      hostname: loopback, port: appPort, path: req.url, method: req.method, headers: forwardingHeaders(req.headers),
    }, response => {
      response.on('error', error => res.destroy(error));
      if (response.statusCode === 503 && response.headers[BOOT_STATE_HEADER] === 'starting') {
        response.resume();
        restart(req, res);
        return;
      }
      res.writeHead(response.statusCode ?? 502, forwardingHeaders(response.headers));
      response.pipe(res);
    });
    upstream.on('error', (error: NodeJS.ErrnoException) => {
      if (res.headersSent) res.destroy(error);
      else if (error.code === 'ECONNREFUSED') restart(req, res);
      else res.writeHead(502, { 'cache-control': 'no-store' }).end();
    });
    res.on('close', () => upstream.destroy());
    req.on('error', error => upstream.destroy(error));
    req.pipe(upstream);
  });

  server.on('upgrade', (req, client, head) => {
    if (req.method !== 'GET' || req.headers.upgrade?.toLowerCase() !== 'websocket' ||
        req.headers['transfer-encoding'] !== undefined || req.headers['content-length'] !== undefined ||        !req.url?.startsWith('/') || req.url.startsWith('//')) { client.destroy(); return; }
    const upstream = net.connect({ host: loopback, port: appPort });
    const fail = () => {
      if (!client.destroyed) client.destroy();
      upstream.destroy();
    };
    upgraded.add(client);
    client.once('close', () => { upgraded.delete(client); upstream.destroy(); });
    upstream.once('close', () => client.destroy());
    upstream.on('error', fail);
    client.on('error', fail);
    upstream.once('connect', () => {
      const headerLines: string[] = [];
      for (let i = 0; i < req.rawHeaders.length; i += 2) headerLines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      upstream.write(`GET ${req.url} HTTP/1.1\r\n${headerLines.join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
  });
  const close = server.close.bind(server);
  server.close = callback => {
    for (const client of upgraded) client.destroy();
    return close(callback);
  };
  return server;
}

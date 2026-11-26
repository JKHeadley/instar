import { createServer, type Server, type ServerOptions } from 'node:https';
import express from 'express';
import type { ConnectViewerAuthority } from '../core/ConnectViewerAuthority.js';
import { mountConnectViewerEnrollment } from './connectViewerRoutes.js';

export interface ConnectViewerListenerOptions {
  readonly tls: Pick<ServerOptions, 'key' | 'cert'>;
  readonly authority: ConnectViewerAuthority;
}

/** Disposable listener only. It has no boot registration or access to general agent routes. */
export async function startConnectViewerListener(options?: ConnectViewerListenerOptions): Promise<Server | undefined> {
  if (!options) return;
  if (!options.tls.key || !options.tls.cert) throw new Error('Connect viewer listener requires a TLS identity');
  const app = express();
  app.disable('x-powered-by');
  app.enable('case sensitive routing');
  app.enable('strict routing');
  let resetAt = 0;
  let requests = 0;
  app.use((_req, res, next) => {
    const now = Date.now();
    if (now >= resetAt) {
      requests = 0;
      resetAt = now + 60_000;
    }
    if (++requests > 30) {
      res.status(429).end();
      return;
    }
    next();
  });
  app.use(express.json({ limit: '2kb' }));
  mountConnectViewerEnrollment(app, options.authority);
  const server = createServer({ ...options.tls, minVersion: 'TLSv1.2', requestTimeout: 5000, headersTimeout: 5000, keepAliveTimeout: 1000 }, app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}

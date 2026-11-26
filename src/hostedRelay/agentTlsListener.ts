import { createHash, X509Certificate } from 'node:crypto';
import type { RequestListener } from 'node:http';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import type { TLSSocket } from 'node:tls';
import { markHostedRelaySocket } from '../core/requestArrival.js';
import { normalizeHostedRelayHostname } from './clientHello.js';

/** Dedicated destination for raw relay connections. Supply only the scoped
 * phone handler, since a public relay must not expose the main agent app. */
export async function startHostedRelayAgentTlsListener(options: {
  hostname: string;
  cert: string | Buffer;
  key: string | Buffer;
  expectedSpkiSha256: string;
  assignment?: string;
  handlePhoneRequest: RequestListener;
  signal: AbortSignal;
}): Promise<{ port: number; closed: Promise<void>; stop(): Promise<void> }> {
  const { hostname, cert, key, signal } = options;
  signal.throwIfAborted();
  const certificate = new X509Certificate(cert);
  const now = Date.now();
  const spki = certificate.publicKey.export({ type: 'spki', format: 'der' });
  if (normalizeHostedRelayHostname(hostname) !== hostname || certificate.checkHost(hostname, { wildcards: false }) === undefined
    || !(Date.parse(certificate.validFrom) <= now && now < Date.parse(certificate.validTo))
    || createHash('sha256').update(spki).digest('hex') !== options.expectedSpkiSha256) {
    throw new Error('relay-agent-certificate-mismatch');
  }
  const sockets = new Set<Duplex>();
  const server = createServer({
    cert, key, minVersion: 'TLSv1.2', handshakeTimeout: 5000,
    requestTimeout: 15_000, headersTimeout: 5000, maxHeaderSize: 8192,
  }, (req, res) => {
    if (signal.aborted || (req.socket as TLSSocket).servername !== hostname || req.headers.host !== hostname) {
      res.writeHead(421, { 'Cache-Control': 'no-store', Connection: 'close' }).end();
      return;
    }
    if (options.assignment) markHostedRelaySocket(req.socket, { hostname, assignment: options.assignment });
    options.handlePhoneRequest(req, res);
  });
  const closed = new Promise<void>(resolve => server.once('close', resolve));
  server.maxConnections = 32;
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  let stopping: Promise<void> | undefined;
  function stop() {
    return stopping ??= new Promise<void>(resolve => {
      signal.removeEventListener('abort', abort);
      server.close(() => resolve());
      for (const socket of sockets) socket.destroy();
    });
  }
  function abort() { void stop(); }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      server.on('error', abort);
      resolve();
    });
  });
  if (signal.aborted) {
    await stop();
    signal.throwIfAborted();
  }
  signal.addEventListener('abort', abort, { once: true });
  return { port: (server.address() as AddressInfo).port, closed, stop };
}

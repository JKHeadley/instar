import http2 from 'node:http2';
import net, { type Server, type Socket } from 'node:net';
import { createDisposableHostedRelay } from './disposableRelay.js';
import type { HostedRelayLeaseAdmission } from './leaseAdmission.js';

const controlSocketLimit = 64;

function bindLoopback(server: Pick<Server, 'listen' | 'address' | 'once' | 'off'>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('hosted-relay-listener-unavailable'));
      else resolve(address.port);
    });
  });
}

function closeListener(server: Pick<Server, 'listening' | 'close'>): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close(error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/** Starts the relay only on two ephemeral loopback listeners. Nothing invokes
 * this launcher automatically, and it cannot expose a public bind address. */
export async function launchDisposableHostedRelay(options: {
  leases: HostedRelayLeaseAdmission;
  key: string | Buffer;
  cert: string | Buffer;
}): Promise<{ controlPort: number; clientPort: number; stop(): Promise<void> }> {
  const relay = createDisposableHostedRelay(options.leases);
  const outbound = http2.createSecureServer({
    key: options.key, cert: options.cert, allowHTTP1: false, minVersion: 'TLSv1.2', handshakeTimeout: 15_000, settings: { maxConcurrentStreams: 68 },
  });
  const ingress = net.createServer(relay.acceptClient);
  const sockets = new Set<Socket>();
  let sweep: ReturnType<typeof setInterval> | undefined, stopping: Promise<void> | undefined;

  outbound.on('connection', socket => {
    if (sockets.size >= controlSocketLimit || stopping) { socket.destroy(); return; }
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  outbound.on('session', session => session.on('error', () => session.destroy()));
  outbound.on('stream', relay.acceptOutbound);

  function stop(): Promise<void> {
    if (!stopping) {
      stopping = Promise.resolve().then(async () => {
        if (sweep) clearInterval(sweep);
        relay.stop();
        for (const socket of sockets) socket.destroy();
        await Promise.all([closeListener(outbound), closeListener(ingress)]);
      });
    }
    return stopping;
  }

  const [control, client] = await Promise.allSettled([bindLoopback(outbound), bindLoopback(ingress)]);
  if (control.status !== 'fulfilled' || client.status !== 'fulfilled') {
    await stop();
    throw new Error('hosted-relay-disposable-bind');
  }
  const stopOnError = () => { void stop().catch(() => {}); }; // @silent-fallback-ok — listener shutdown is already owned by stop()
  outbound.on('error', stopOnError);
  ingress.on('error', stopOnError);
  sweep = setInterval(() => relay.sweep(), 1000);
  sweep.unref();
  return { controlPort: control.value, clientPort: client.value, stop };
}

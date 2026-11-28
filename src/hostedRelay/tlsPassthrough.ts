import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { HOSTED_RELAY_HELLO_LIMIT, inspectHostedRelayClientHello } from './clientHello.js';

/** The resolver supplies one exclusive stream for an already authorized name.
 * This function cannot open a destination address or terminate TLS. */
export function routeHostedRelaySocket(client: Socket, resolveRoute: (hostname: string) => Duplex | undefined): void {
  const prefix = Buffer.alloc(HOSTED_RELAY_HELLO_LIMIT);
  let length = 0, upstream: Duplex | undefined;
  const timer = setTimeout(() => client.destroy(), 5_000);
  timer.unref();

  function releaseReader() {
    clearTimeout(timer);
    client.off('data', inspect);
    prefix.fill(0);
  }

  client.once('close', () => { releaseReader(); upstream?.destroy(); });
  client.on('error', () => client.destroy());

  function inspect(chunk: Buffer) {
    const previous = length;
    length += chunk.copy(prefix, length);
    const result = inspectHostedRelayClientHello(prefix.subarray(0, length));
    if (result.status === 'incomplete') return;
    if (result.status !== 'named') { client.destroy(); return; }
    client.pause();
    try { upstream = resolveRoute(result.hostname); }
    catch { client.destroy(); return; } // @silent-fallback-ok — unavailable routes are closed without disclosing their state
    if (!upstream || upstream.destroyed || !upstream.writable || !upstream.readable) { client.destroy(); return; }
    upstream.once('error', () => client.destroy());
    upstream.once('close', () => { if (!upstream?.readableEnded) client.destroy(); });
    const initial = Buffer.concat([prefix.subarray(0, previous), chunk]);
    releaseReader();
    if (!upstream.write(initial)) upstream.once('drain', () => client.pipe(upstream!));
    else client.pipe(upstream);
    upstream.pipe(client);
  }

  client.on('data', inspect);
}

import { once } from 'node:events';
import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import { expect, it, vi } from 'vitest';
import { runHostedRelayReconnect } from '../../src/hostedRelay/reconnect.js';

const scope = { hostname: 'agent.relay.example', assignment: '1'.repeat(64), holder: 'm_holder' };
const localLease = (epoch: number) => ({ ...scope, epoch, expiresAt: Date.now() + 60_000 });

it('refreshes the lease after disconnect and stops the admitted session on cancellation', async () => {
  const server = http2.createServer();
  const epochs: number[] = [];
  const first = Promise.withResolvers<void>(), second = Promise.withResolvers<void>();
  server.on('stream', (stream, headers) => {
    if (headers[':path'] !== '/relay/v1/control') return;
    stream.respond({ ':status': 200 });
    stream.write(JSON.stringify({ type: 'challenge', nonce: '8'.repeat(64) }) + '\n');
    stream.once('data', chunk => {
      epochs.push(JSON.parse(chunk.toString()).epoch);
      stream.write('{"type":"admitted"}\n');
      (epochs.length === 1 ? first : second).resolve();
    });
  });
  const listen = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listen;
  const url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  const controller = new AbortController();
  const sessions: http2.ClientHttp2Session[] = [];
  let lease = localLease(1);
  const result = runHostedRelayReconnect({
    scope, signal: controller.signal, currentLease: () => lease,
    async connectVerified() {
      const session = http2.connect(url);
      sessions.push(session);
      return { session, closed: new Promise<void>(done => session.once('close', done)) };
    },
    sign: () => 'fixture', openLocalTls: () => undefined,
  });
  try {
    await first.promise;
    lease = localLease(2);
    sessions[0].destroy();
    await second.promise;
    controller.abort();
    await expect(result).resolves.toBe('stopped');
    expect(epochs).toEqual([1, 2]);
    expect(sessions.every(session => session.destroyed)).toBe(true);
  } finally {
    controller.abort();
    for (const session of sessions) session.destroy();
    server.close();
  }
});

it('does not connect a different holder and cancels a retry backoff', async () => {
  const controller = new AbortController();
  const connectVerified = vi.fn(async () => { throw new Error('fixture refusal'); });
  const options = { scope, signal: controller.signal, connectVerified, sign: () => 'fixture', openLocalTls: () => undefined };
  await expect(runHostedRelayReconnect({ ...options, currentLease: () => ({ ...localLease(1), holder: 'm_other' }) }))
    .resolves.toBe('lease-unavailable');
  expect(connectVerified).not.toHaveBeenCalled();
  const pending = runHostedRelayReconnect({ ...options, currentLease: () => localLease(1) });
  await Promise.resolve();
  controller.abort();
  await expect(pending).resolves.toBe('stopped');
  expect(connectVerified).toHaveBeenCalledTimes(1);
});

it('ends a continuously failing run at its retry limit', async () => {
  const connectVerified = vi.fn(async () => { throw new Error('fixture dial failure'); });
  const currentLease = vi.fn(() => localLease(1));
  await expect(runHostedRelayReconnect({ scope, signal: new AbortController().signal,
    currentLease, connectVerified, sign: () => 'fixture', openLocalTls: () => undefined }))
    .resolves.toBe('attempts-exhausted');
  expect(connectVerified).toHaveBeenCalledTimes(6);
  expect(currentLease).toHaveBeenCalledTimes(6);
});

it('disposes a newly connected session when authority regresses and waits for actual closure', async () => {
  const closed = Promise.withResolvers<void>(), destroyCalled = Promise.withResolvers<void>();
  const session = { closed: false, destroyed: false, destroy: () => destroyCalled.resolve() } as unknown as http2.ClientHttp2Session;
  const currentLease = vi.fn().mockReturnValueOnce(localLease(2)).mockReturnValue(localLease(1));
  const result = runHostedRelayReconnect({ scope, currentLease, signal: new AbortController().signal,
    async connectVerified() { return { session, closed: closed.promise }; },
    sign: () => 'fixture', openLocalTls: () => undefined });
  let finished = false;
  void result.then(() => { finished = true; });
  await destroyCalled.promise;
  expect(finished).toBe(false);
  closed.resolve();
  await expect(result).resolves.toBe('lease-unavailable');
});

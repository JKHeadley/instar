import { once } from 'node:events';
import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import { expect, it, vi } from 'vitest';
import { redeemHostedRelaySetupCode } from '../../src/hostedRelay/setupReceipt.js';

it('accepts only an exact locator within the configured relay DNS zone', async () => {
  const domain = 'relay.example', hostname = 'agent.relay.example', code = 'A'.repeat(32);
  let payload = JSON.stringify({ hostname }), cache = 'no-store';
  const seen: string[] = [];
  let partial: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  const server = http2.createServer();
  server.on('stream', (stream, headers) => {
    if (headers[':path'] !== '/relay/v1/rendezvous/redeem' || headers[':method'] !== 'POST') {
      stream.respond({ ':status': 404 }, { endStream: true });
      return;
    }
    stream.on('data', chunk => seen.push(chunk.toString()));
    stream.on('end', () => {
      stream.respond({ ':status': 200, 'content-type': 'application/json', 'cache-control': cache });
      if (partial) {
        stream.write('{"hostname":');
        partial.resolve();
      } else stream.end(payload);
    });
  });
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  const target = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  const sessions: http2.ClientHttp2Session[] = [];
  const injected = vi.fn(async () => {
    const session = http2.connect(target);
    sessions.push(session);
    session.on('error', () => session.destroy());
    const closed = new Promise<void>(done => session.once('close', () => done()));
    return { session, closed };
  });
  const options = { code, routingDomain: domain, connectVerified: injected, signal: new AbortController().signal };
  try {
    expect(await redeemHostedRelaySetupCode({ ...options, code: 'bad' })).toBeUndefined();
    expect(injected).not.toHaveBeenCalled();
    expect(await redeemHostedRelaySetupCode(options)).toEqual({ kind: 'relay-locator', hostname, origin: 'https://' + hostname });
    expect(JSON.parse(seen.join(''))).toEqual({ code });
    for (const invalid of [
      { hostname: 'other.example' },
      { hostname: 'relay.example' },
      { hostname: 'nested.agent.relay.example' },
      { hostname: 'agent.relay.example.evil.example' },
      { hostname: 'agent.relay.example/path' },
      { hostname: 'Agent.relay.example' },
      { hostname, ownerProof: 'pretend' },
      { hostname: 'a'.repeat(600) },
    ]) {
      payload = JSON.stringify(invalid);
      expect(await redeemHostedRelaySetupCode(options)).toBeUndefined();
    }
    payload = JSON.stringify({ hostname });
    cache = 'public';
    expect(await redeemHostedRelaySetupCode(options)).toBeUndefined();
    cache = 'no-store';
    partial = Promise.withResolvers<void>();
    const cancel = new AbortController();
    const incomplete = redeemHostedRelaySetupCode({ ...options, signal: cancel.signal });
    await partial.promise;
    cancel.abort();
    expect(await incomplete).toBeUndefined();
    expect(sessions.at(-1)?.destroyed).toBe(true);
  } finally {
    server.close();
  }
});

import { once } from 'node:events';
import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { HostedRelayOutboundTransport } from '../../src/hostedRelay/outboundTransport.js';

it('multiplexes two reverse streams on the same outbound session and isolates other sessions', async () => {
  const listener = http2.createServer();
  const ready = once(listener, 'listening');
  listener.listen(0, '127.0.0.1');
  await ready;
  const target = 'http://127.0.0.1:' + (listener.address() as AddressInfo).port;
  const reasons: string[] = [];
  const agent = http2.connect(target), other = http2.connect(target);
  try {
    const control = agent.request({ ':method': 'POST', ':path': '/fixture-control' }, { endStream: false });
    const [controlStream] = await once(listener, 'stream') as [http2.ServerHttp2Stream];
    const transport = new HostedRelayOutboundTransport(controlStream, reason => reasons.push(reason));
    expect(transport.offer(controlStream)).toBe(false);
    const foreign = other.request({ ':method': 'POST', ':path': '/fixture-offer' }, { endStream: false });
    const [foreignStream] = await once(listener, 'stream') as [http2.ServerHttp2Stream];
    expect(transport.offer(foreignStream)).toBe(false);
    foreign.close();

    const one = agent.request({ ':method': 'POST', ':path': '/fixture-offer' }, { endStream: false });
    const [oneStream] = await once(listener, 'stream') as [http2.ServerHttp2Stream];
    expect(transport.offer(oneStream)).toBe(true);
    expect(transport.offer(oneStream)).toBe(false);
    const two = agent.request({ ':method': 'POST', ':path': '/fixture-offer' }, { endStream: false });
    const [twoStream] = await once(listener, 'stream') as [http2.ServerHttp2Stream];
    expect(transport.offer(twoStream)).toBe(true);

    const responses = [once(one, 'response'), once(two, 'response')];
    const first = transport.openStream(), second = transport.openStream();
    expect(first).toBe(oneStream);
    expect(second).toBe(twoStream);
    expect(transport.openStream()).toBeUndefined();
    for (const response of await Promise.all(responses)) expect(response[0][':status']).toBe(200);
    const messages = [once(one, 'data'), once(two, 'data')];
    first!.write('one'); second!.write('two');
    expect((await Promise.all(messages)).map(([data]) => data.toString())).toEqual(['one', 'two']);
    const replies = [once(first!, 'data'), once(second!, 'data')];
    first!.resume(); second!.resume();
    one.write('first reply'); two.write('second reply');
    expect((await Promise.all(replies)).map(([data]) => data.toString())).toEqual(['first reply', 'second reply']);

    const pending = agent.request({ ':method': 'POST', ':path': '/fixture-offer' }, { endStream: false });
    const [pendingStream] = await once(listener, 'stream') as [http2.ServerHttp2Stream];
    expect(transport.offer(pendingStream)).toBe(true);
    const pendingClosed = once(pending, 'close');
    transport.disconnect('displaced');
    await pendingClosed;
    expect(reasons).toEqual(['displaced']);
    expect(transport.openStream()).toBeUndefined();
    control.close(); one.close(); two.close();

    const otherControl = other.request({ ':method': 'POST', ':path': '/fixture-control' }, { endStream: false });
    const [otherControlStream] = await once(listener, 'stream') as [http2.ServerHttp2Stream];
    const otherTransport = new HostedRelayOutboundTransport(otherControlStream, () => {});
    const abandoned = other.request({ ':method': 'POST', ':path': '/fixture-offer' }, { endStream: false });
    const [abandonedStream] = await once(listener, 'stream') as [http2.ServerHttp2Stream];
    expect(otherTransport.offer(abandonedStream)).toBe(true);
    const abandonedClosed = once(abandoned, 'close');
    otherControl.close();
    await abandonedClosed;
    expect(otherTransport.openStream()).toBeUndefined();
  } finally {
    agent.destroy(); other.destroy(); listener.close();
  }
});

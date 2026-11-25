import { expect, it } from 'vitest';
import { HOSTED_RELAY_HELLO_LIMIT, inspectHostedRelayClientHello } from '../../src/hostedRelay/clientHello.js';

function u16(value: number): Buffer {
  const result = Buffer.alloc(2);
  result.writeUInt16BE(value);
  return result;
}
function record(payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from([22, 3, 1]), u16(payload.length), payload]);
}
function hello(hostname: string, duplicate = false): Buffer {
  const name = Buffer.from(hostname);
  const entry = Buffer.concat([Buffer.from([0]), u16(name.length), name]);
  const extension = Buffer.concat([u16(0), u16(entry.length + 2), u16(entry.length), entry]);
  const extensions = duplicate ? Buffer.concat([extension, extension]) : extension;
  const payload = Buffer.concat([Buffer.from([3, 3]), Buffer.alloc(32), Buffer.from([0, 0, 2, 0x13, 1, 1, 0]),
    u16(extensions.length), extensions]);
  const header = Buffer.alloc(4);
  header[0] = 1;
  header.writeUIntBE(payload.length, 1, 3);
  return Buffer.concat([header, payload]);
}
it('reads a split hello without interpreting trailing TLS data', () => {
  const message = hello('Sample.Relay.Example');
  const first = record(message.subarray(0, 2)), second = record(message.subarray(2));
  expect(inspectHostedRelayClientHello(first)).toEqual({ status: 'incomplete' });
  expect(inspectHostedRelayClientHello(Buffer.concat([first, second.subarray(0, -1)]))).toEqual({ status: 'incomplete' });
  expect(inspectHostedRelayClientHello(Buffer.concat([first, second, Buffer.from([23])])))
    .toEqual({ status: 'named', hostname: 'sample.relay.example' });
});
it.each(['127.0.0.1', 'bad_host.example', 'example.com.', 'tést.example'])('refuses a non-routing name %s', hostname => {
  expect(inspectHostedRelayClientHello(record(hello(hostname)))).toEqual({ status: 'invalid' });
});
it('refuses duplicate names and over-budget input', () => {
  expect(inspectHostedRelayClientHello(record(hello('sample.example', true)))).toEqual({ status: 'invalid' });
  expect(inspectHostedRelayClientHello(Buffer.alloc(HOSTED_RELAY_HELLO_LIMIT))).toEqual({ status: 'invalid' });
});

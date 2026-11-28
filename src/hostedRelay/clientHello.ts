/** A bounded parser for the routing name in a plaintext TLS ClientHello.
 * It does not negotiate TLS or authorize a route. */
export const HOSTED_RELAY_HELLO_LIMIT = 64 * 1024;

export type HostedRelayHello =
  | { status: 'incomplete' | 'invalid' }
  | { status: 'named'; hostname: string };

export function normalizeHostedRelayHostname(value: string): string | undefined {
  if (!/^[\x00-\x7f]{1,253}$/.test(value)) return undefined;
  const name = value.toLowerCase();
  return name.includes('.') && !/^[\d.]+$/.test(name)
    && name.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ? name : undefined;
}

function routingName(hello: Buffer): string | undefined {
  let offset = 34; // legacy version and random
  const advance = (size: number): number => {
    const start = offset;
    offset += size;
    if (offset > hello.length) throw new RangeError('short ClientHello');
    return start;
  };
  advance(hello[advance(1)]);
  const ciphers = hello.readUInt16BE(advance(2));
  if (ciphers < 2 || ciphers % 2) return undefined;
  advance(ciphers);
  const compression = hello[advance(1)];
  if (!compression) return undefined;
  advance(compression);
  const extensions = hello.readUInt16BE(advance(2));
  if (extensions !== hello.length - offset) return undefined;
  let name: string | undefined;
  while (offset < hello.length) {
    const type = hello.readUInt16BE(advance(2));
    const size = hello.readUInt16BE(advance(2));
    const extension = hello.subarray(offset, offset + size);
    advance(size);
    if (type !== 0) continue;
    if (name || size < 6 || extension.readUInt16BE(0) !== size - 2
      || extension[2] !== 0 || extension.readUInt16BE(3) !== size - 5 || extension.subarray(5).some(byte => byte > 127)) return undefined;
    name = normalizeHostedRelayHostname(extension.toString('ascii', 5));
    if (!name) return undefined;
  }
  return name;
}

export function inspectHostedRelayClientHello(wire: Buffer): HostedRelayHello {
  let offset = 0, received = 0, expected: number | undefined;
  const fragments: Buffer[] = [];
  while (offset + 5 <= wire.length && offset + 5 <= HOSTED_RELAY_HELLO_LIMIT) {
    const size = wire.readUInt16BE(offset + 3);
    const end = offset + 5 + size;
    if (wire[offset] !== 22 || wire[offset + 1] !== 3 || size < 1 || size > 16 * 1024
      || end > HOSTED_RELAY_HELLO_LIMIT) return { status: 'invalid' };
    if (end > wire.length) return { status: 'incomplete' };
    if (fragments.length >= 64) return { status: 'invalid' };
    fragments.push(wire.subarray(offset + 5, end));
    received += size;
    offset = end;
    if (expected === undefined && received >= 4) {
      const header = Buffer.concat(fragments, 4);
      if (header[0] !== 1) return { status: 'invalid' };
      expected = 4 + header.readUIntBE(1, 3);
      if (expected < 44 || expected > HOSTED_RELAY_HELLO_LIMIT - 5) return { status: 'invalid' };
    }
    if (expected !== undefined && received >= expected) {
      try {
        const hostname = routingName(Buffer.concat(fragments, expected).subarray(4));
        return hostname ? { status: 'named', hostname } : { status: 'invalid' };
      } catch { return { status: 'invalid' }; } // @silent-fallback-ok — malformed length refuses routing
    }
  }
  return { status: wire.length >= HOSTED_RELAY_HELLO_LIMIT ? 'invalid' : 'incomplete' };
}

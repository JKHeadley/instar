/**
 * Guard for the loopback bind in tests/vitest-setup.ts. Without it, a test server
 * that calls listen(0) binds the wildcard address and can share its port number
 * with another process's 127.0.0.1 socket, which then answers the test's requests.
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

const open: net.Server[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

function start(listen: (s: net.Server, done: () => void) => void): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    open.push(s);
    s.once('error', reject);
    listen(s, () => resolve(s.address() as AddressInfo));
  });
}

describe('test servers bind loopback, not the wildcard', () => {
  it.each<[string, (s: net.Server, done: () => void) => void]>([
    ['listen(cb)', (s, d) => s.listen(d)],
    ['listen(0, cb)', (s, d) => s.listen(0, d)],
    ['listen(0, backlog, cb)', (s, d) => s.listen(0, 16, d)],
    ['listen({ port: 0 }, cb)', (s, d) => s.listen({ port: 0 }, d)],
  ])('%s lands on 127.0.0.1', async (_name, listen) => {
    const a = await start(listen);
    expect(a.address).toBe('127.0.0.1');
    expect(a.port).toBeGreaterThan(0);
  });

  it('binds synchronously, so address() works straight after listen(0)', () => {
    const s = net.createServer();
    open.push(s);
    s.listen(0);
    expect((s.address() as AddressInfo).address).toBe('127.0.0.1');
  });

  it('applies to http servers too (what express and supertest use)', async () => {
    const s = http.createServer();
    open.push(s);
    await new Promise<void>((r) => s.listen(0, () => r()));
    expect((s.address() as AddressInfo).address).toBe('127.0.0.1');
  });

  it('leaves an explicit host alone', async () => {
    const a = await start((s, d) => s.listen(0, '0.0.0.0', d));
    expect(a.address).toBe('0.0.0.0');
    const b = await start((s, d) => s.listen({ port: 0, host: '0.0.0.0' }, d));
    expect(b.address).toBe('0.0.0.0');
  });

  it('leaves a fixed port alone', async () => {
    const taken = await start((s, d) => s.listen(0, d));
    const free = taken.port;
    await new Promise<void>((r) => open.pop()!.close(() => r()));
    const a = await start((s, d) => s.listen(free, d));
    expect(a.port).toBe(free);
    expect(a.address).not.toBe('127.0.0.1');
  });
});

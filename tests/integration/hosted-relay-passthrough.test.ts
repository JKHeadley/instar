import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net, { type AddressInfo, type Server } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { afterEach, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { routeHostedRelaySocket } from '../../src/hostedRelay/tlsPassthrough.js';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
async function listen(server: Server) {
  cleanups.push(() => server.close());
  const ready = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await ready;
  return (server.address() as AddressInfo).port;
}

it('passes TLS through to the agent and leaves direct access working when the relay declines a route', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-relay-tls-'));
  cleanups.push(() => SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'relay TLS fixture cleanup' }));
  const certificate = path.join(root, 'agent.pem'), key = path.join(root, 'agent.key');
  const hostname = 'test-agent.relay.example';
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=' + hostname, '-keyout', key, '-out', certificate], { stdio: 'ignore', timeout: 10000 });
  const cert = fs.readFileSync(certificate);
  const large = Buffer.alloc(512 * 1024, 0x61);
  const agent = await listen(tls.createServer({ key: fs.readFileSync(key), cert }, socket => {
    cleanups.push(() => socket.destroy());
    socket.once('data', data => socket.end(data.toString() === 'large' ? large : Buffer.concat([Buffer.from('agent:'), data])));
  }));
  const names: string[] = [];
  const relay = await listen(net.createServer(socket => {
    cleanups.push(() => socket.destroy());
    routeHostedRelaySocket(socket, name => {
      names.push(name);
      return name === hostname ? net.connect(agent, '127.0.0.1') : undefined;
    });
  }));
  const request = async (port: number, servername = hostname) => {
    const client = tls.connect({ port, host: '127.0.0.1', servername, ca: cert });
    cleanups.push(() => client.destroy());
    await once(client, 'secureConnect');
    const response = once(client, 'data');
    client.write('private fixture text');
    return (await response)[0].toString();
  };
  expect(await request(relay)).toBe('agent:private fixture text');
  await expect(request(relay, 'unknown.relay.example')).rejects.toThrow();
  expect(await request(agent)).toBe('agent:private fixture text');
  const slow = tls.connect({ port: relay, host: '127.0.0.1', servername: hostname, ca: cert });
  cleanups.push(() => slow.destroy());
  await once(slow, 'secureConnect');
  slow.write('large');
  slow.pause();
  const responseParts: Buffer[] = [];
  slow.on('data', data => responseParts.push(data));
  const ended = once(slow, 'end');
  slow.resume();
  await ended;
  expect(Buffer.concat(responseParts)).toEqual(large);
  expect(names).toEqual([hostname, 'unknown.relay.example', hostname]);
});

import { createServer } from 'node:http';
import { once } from 'node:events';

export async function startStandingPacketAuthority(sessionId: string, packetHash: string) {
  const token = 'fixture-standing-packet-authority';
  const requests: Array<{ url?: string; authorization?: string }> = [];
  let current = true;
  const server = createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    if (req.method !== 'GET' || req.url !== `/standing-packet/keep-current/${sessionId}?packetHash=${packetHash}` ||
        req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(403).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ current }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP authority fixture');
  return {
    config: { port: address.port, authToken: token },
    requests,
    revoke: () => { current = false; },
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    }),
  };
}

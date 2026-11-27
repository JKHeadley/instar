/** Drive Express's HTTP pipeline without opening a listening socket. */
import { IncomingMessage, ServerResponse } from 'node:http';
import { Duplex } from 'node:stream';
import type { Express } from 'express';
export async function inProcessHttp(app: Express, method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
  const chunks: Buffer[] = [];
  const socket = new Duplex({ read() {}, write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
  const req = new IncomingMessage(socket as never);
  req.method = method; req.url = url;
  const encoded = body === undefined ? '' : JSON.stringify(body);
  req.headers = body === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(encoded)) };
  const res = new ServerResponse(req); res.assignSocket(socket as never);
  const finished = new Promise<void>((resolve, reject) => { res.on('finish', resolve); res.on('error', reject); });
  app(req, res);
  req.push(encoded || null); if (encoded) req.push(null);
  await finished;
  const raw = Buffer.concat(chunks).toString();
  const payload = raw.slice(raw.indexOf('\r\n\r\n') + 4);
  return { status: res.statusCode, body: JSON.parse(payload) };
}

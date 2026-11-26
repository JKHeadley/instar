/**
 * Integration: the Telegram egress door sends over HTTP/1.1 once the process is pinned.
 *
 * On Node 26 Node's fetch refuses the npm undici dispatcher this door passes and the door falls
 * back to Node's default dispatcher, which negotiates HTTP/2 (the 2026-11-20 A3 balloon path).
 * Pinned, the fallback is HTTP/1.1. A non-Bot-API URL goes through the same network path
 * without the content checks, so a local TLS server offering h2 and http/1.1 records the protocol.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http2 from 'node:http2';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { pinGlobalFetchToHttp1, resetHttp1PinForTests } from '../../src/core/http1GlobalFetch.js';
import { telegramFetch } from '../../src/messaging/telegram-egress.js';

let server: http2.Http2SecureServer;
let base = '';
let dir = '';
const prevTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-h1-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'),
    '-out', path.join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  server = http2.createSecureServer({
    key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')), allowHTTP1: true,
  }, (req, res) => {
    let bytes = 0;
    req.on('data', (c: Buffer) => { bytes += c.length; });
    req.on('end', () => res.end(JSON.stringify({ httpVersion: req.httpVersion, bytes })));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `https://localhost:${(server.address() as AddressInfo).port}`;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // self-signed test server only
  resetHttp1PinForTests();
  expect((await pinGlobalFetchToHttp1({ log: () => {} })).status).toBe('pinned');
});

afterAll(async () => {
  if (prevTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevTls;
  await new Promise<void>((r) => server.close(() => r()));
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/telegram-egress-http1.test.ts' });
});

describe('telegram egress over a pinned process', () => {
  it('a multipart upload through the egress network path arrives on HTTP/1.1', async () => {
    const form = new FormData();
    form.append('chat_id', '1');
    form.append('document', new Blob([new Uint8Array(200_000)], { type: 'application/octet-stream' }), 'a.bin');
    const r = await telegramFetch(`${base}/upload`, { method: 'POST', body: form });
    const body = await r.json() as { httpVersion: string; bytes: number };
    expect(body.httpVersion).toBe('1.1');
    expect(body.bytes).toBeGreaterThan(200_000);
  });

  it('a request cancelled by its network deadline mid-upload rejects, and the next one still goes out on HTTP/1.1', async () => {
    await expect(telegramFetch(`${base}/slow`, { method: 'POST', body: new Uint8Array(20_000_000), networkTimeoutMs: 1 })).rejects.toThrow();
    const r = await telegramFetch(`${base}/after`);
    expect(((await r.json()) as { httpVersion: string }).httpVersion).toBe('1.1');
  });
});

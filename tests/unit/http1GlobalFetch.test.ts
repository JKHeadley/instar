/**
 * Node's global fetch stays on HTTP/1.1 after pinGlobalFetchToHttp1() (2026-11-20 post-mortem A3).
 *
 * A real TLS server that offers BOTH h2 and http/1.1 over ALPN records which protocol each
 * request arrived on. On Node 26 the unpinned fetch picks h2 (the defect); on Node 20-24 it
 * already picks http/1.1. After the pin it must be http/1.1 on every version, uploads included.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import http2 from 'node:http2';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  pinGlobalFetchToHttp1, resetHttp1PinForTests, http1PinStatus, GLOBAL_DISPATCHER_SYMBOLS,
} from '../../src/core/http1GlobalFetch.js';

type G = Record<symbol, unknown>;
const g = globalThis as unknown as G;

let server: http2.Http2SecureServer;
let base = '';
let dir = '';
const seen: string[] = [];
const prevTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
const saved = new Map<symbol, unknown>();

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h1fetch-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'),
    '-out', path.join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  server = http2.createSecureServer({
    key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')), allowHTTP1: true,
  }, (req, res) => {
    let bytes = 0;
    req.on('data', (c: Buffer) => { bytes += c.length; });
    req.on('end', () => { seen.push(req.httpVersion); res.end(JSON.stringify({ httpVersion: req.httpVersion, bytes })); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `https://localhost:${(server.address() as AddressInfo).port}`;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // self-signed test server only
  await fetch('data:,'); // make Node create its default dispatcher so it can be restored
  for (const s of GLOBAL_DISPATCHER_SYMBOLS) saved.set(s, g[s]);
});

afterEach(() => {
  for (const [s, v] of saved) g[s] = v;
  resetHttp1PinForTests();
  seen.length = 0;
});

afterAll(async () => {
  if (prevTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevTls;
  await new Promise<void>((r) => server.close(() => r()));
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/http1GlobalFetch.test.ts' });
});

const major = Number(process.versions.node.split('.')[0]);

describe('pinGlobalFetchToHttp1', () => {
  it('baseline: what the unpinned fetch negotiates on this Node (h2 from Node 26 on)', async () => {
    const r = await fetch(`${base}/x`);
    const body = await r.json() as { httpVersion: string };
    if (major >= 26) expect(body.httpVersion).toBe('2.0');
    else expect(body.httpVersion).toBe('1.1');
  });

  it('pins GET and upload requests to HTTP/1.1', async () => {
    const res = await pinGlobalFetchToHttp1({ log: () => {} });
    expect(res.status).toBe('pinned');
    const get = await (await fetch(`${base}/get`)).json() as { httpVersion: string };
    const form = new FormData();
    form.append('chat_id', '1');
    form.append('photo', new Blob([new Uint8Array(300_000)], { type: 'image/png' }), 'a.png');
    const up = await (await fetch(`${base}/up`, { method: 'POST', body: form })).json() as { httpVersion: string; bytes: number };
    expect(get.httpVersion).toBe('1.1');
    expect(up.httpVersion).toBe('1.1');
    expect(up.bytes).toBeGreaterThan(300_000);
    expect(seen.every((v) => v === '1.1')).toBe(true);
  });

  it('an aborted upload on the pinned fetch rejects cleanly and the next request still works', async () => {
    await pinGlobalFetchToHttp1({ log: () => {} });
    const ac = new AbortController();
    const p = fetch(`${base}/up`, { method: 'POST', body: new Uint8Array(5_000_000), signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toThrow();
    const after = await (await fetch(`${base}/after`)).json() as { httpVersion: string };
    expect(after.httpVersion).toBe('1.1');
  });

  it('is idempotent', async () => {
    expect((await pinGlobalFetchToHttp1({ log: () => {} })).status).toBe('pinned');
    const slot = GLOBAL_DISPATCHER_SYMBOLS.find((s) => g[s] != null)!;
    const first = g[slot];
    expect((await pinGlobalFetchToHttp1({ log: () => {} })).status).toBe('already-pinned');
    expect(g[slot]).toBe(first);
  });

  it('honours the opt-out and leaves the dispatcher untouched', async () => {
    const slot = GLOBAL_DISPATCHER_SYMBOLS.find((s) => g[s] != null)!;
    const before = g[slot];
    const res = await pinGlobalFetchToHttp1({ env: { INSTAR_ALLOW_FETCH_HTTP2: '1' }, log: () => {} });
    expect(res.status).toBe('opted-out');
    expect(g[slot]).toBe(before);
    expect(http1PinStatus()?.status).toBe('opted-out');
  });

  it('leaves a dispatcher someone installed on purpose alone, and says so', async () => {
    const slot = GLOBAL_DISPATCHER_SYMBOLS.find((s) => g[s] != null)!;
    class ProxyThing { dispatch() { return false; } }
    const custom = new ProxyThing();
    g[slot] = custom;
    const lines: string[] = [];
    const res = await pinGlobalFetchToHttp1({ log: (l) => lines.push(l) });
    expect(res).toEqual({ status: 'left-alone', reason: 'custom-dispatcher', dispatcher: 'ProxyThing' });
    expect(g[slot]).toBe(custom);
    expect(lines.join('\n')).toMatch(/left Node's fetch dispatcher alone/);
  });
});

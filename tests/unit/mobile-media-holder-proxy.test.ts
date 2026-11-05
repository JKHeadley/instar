/** The stream's own rules, off the network (docs/specs/mobile-remote-media.md). */
import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Response as ExpressResponse } from 'express';
import { HOLDER_MEDIA_HEADER, buildMediaHolderStream } from '../../src/server/mobileMediaHolderProxy.js';

class FakeRes extends EventEmitter {
  statusCode = 200; headers: Record<string, string> = {}; chunks: Buffer[] = []; body: unknown = null;
  headersSent = false; destroyed = false; writableFinished = false; ended = false;
  status(n: number) { this.statusCode = n; return this; }
  json(b: unknown) { this.body = b; this.headersSent = true; return this; }
  setHeader(k: string, v: string) { this.headers[k.toLowerCase()] = v; }
  write(c: Uint8Array) { this.headersSent = true; this.chunks.push(Buffer.from(c)); return true; }
  end() { this.ended = true; this.writableFinished = true; }
  destroy() { this.destroyed = true; }
}
const run = async (fetchImpl: typeof fetch, isCurrent: () => boolean, sha: string, over = {}) => {
  const res = new FakeRes();
  const stream = buildMediaHolderStream({ peers: () => [{ machineId: 'm_b', url: 'http://127.0.0.1:9', kind: 'lan' }], token: () => 't', selfMachineId: () => 'm_a', fetchImpl, recheckMs: 0, ...over });
  await stream({ sha256: sha, ref: 'slack:_:C', machine: 'm_b', isCurrent }, res as unknown as ExpressResponse);
  return res;
};
const ok = (b: Buffer, h: Record<string, string> = {}) => new Response(b, { status: 200, headers: { 'content-type': 'text/html', 'content-disposition': 'attachment; filename="../../x.html"', [HOLDER_MEDIA_HEADER]: '1', ...h } });
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

describe('buildMediaHolderStream', () => {
  it('reads the owner check before the dial, and does not dial when it fails', async () => {
    const f = vi.fn();
    const r = await run(f as unknown as typeof fetch, () => false, 'a'.repeat(64));
    expect(f).not.toHaveBeenCalled();
    expect(r.statusCode).toBe(403);
  });

  it('never trusts the holder\'s type or file name', async () => {
    const b = Buffer.from('<script>x</script>');
    const r = await run((async () => ok(b)) as typeof fetch, () => true, sha(b));
    expect(r.headers['content-type']).toBe('application/octet-stream');
    expect(r.headers['content-disposition']).toMatch(/^attachment; filename="[A-Za-z0-9._-]+"$/);
    expect(r.headers[HOLDER_MEDIA_HEADER]).toBeUndefined();
    expect(Buffer.concat(r.chunks)).toEqual(b);
    expect(r.ended).toBe(true);
  });

  it('holds the last chunk: a wrong hash ends with no complete response', async () => {
    const b = Buffer.from('hello world');
    const r = await run((async () => ok(b)) as typeof fetch, () => true, 'c'.repeat(64));
    expect(r.ended).toBe(false);
    expect(Buffer.concat(r.chunks).length).toBe(0);
    expect(r.statusCode).toBe(502);
  });

  it('an empty file with the right hash still completes', async () => {
    const b = Buffer.alloc(0);
    const r = await run((async () => ok(b)) as typeof fetch, () => true, sha(b));
    expect(r.ended).toBe(true);
  });

  it('a revocation after the last byte arrives still sends nothing more', async () => {
    const b = Buffer.from('private');
    let reads = 0;
    const r = await run((async () => ok(b)) as typeof fetch, () => ++reads < 3, sha(b), { recheckMs: 60_000 });
    expect(r.ended).toBe(false);
    expect(r.statusCode).toBe(403);
    expect(Buffer.concat(r.chunks).length).toBe(0);
  });

  it('an owner check that throws on the timer cuts the stream and does not crash', async () => {
    let reads = 0;
    const hang = ((_u: unknown, init: { signal: AbortSignal }) => new Promise((_ok, no) => { init.signal.addEventListener('abort', () => no(init.signal.reason)); })) as unknown as typeof fetch;
    const r = await run(hang, () => { if (++reads > 1) throw new Error('store unreadable'); return true; }, 'a'.repeat(64), { recheckMs: 10 });
    expect(r.statusCode).toBe(403);
  });

  it('gives the slots back after every outcome', async () => {
    const f = (async () => { throw new TypeError('refused'); }) as typeof fetch;
    const res = new FakeRes();
    const stream = buildMediaHolderStream({ peers: () => [{ machineId: 'm_b', url: 'http://127.0.0.1:9', kind: 'lan' }], token: () => 't', selfMachineId: () => 'm_a', fetchImpl: f });
    for (let i = 0; i < 5; i++) await stream({ sha256: 'a'.repeat(64), ref: 'slack:_:C', machine: 'm_b', isCurrent: () => true }, res as unknown as ExpressResponse);
    expect((res.body as { error: string }).error).toBe('holder-unreachable');
  });
});

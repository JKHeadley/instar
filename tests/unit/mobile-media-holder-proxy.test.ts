/** The stream's own rules, off the network (docs/specs/mobile-remote-media.md). */
import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Response as ExpressResponse } from 'express';
import { MOBILE_MEDIA_TIMEOUT_MS, buildRequestTimeoutOverrides, resolveRequestTimeout } from '../../src/server/middleware.js';
import { HOLDER_MEDIA_BUSY_RETRY_MS, HOLDER_MEDIA_DEADLINE_MS, HOLDER_MEDIA_HEADER, buildMediaHolderStream, holderBearerOk } from '../../src/server/mobileMediaHolderProxy.js';

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

  const parts = (list: Buffer[], onPull?: (i: number) => void) => {
    let i = 0;
    return new ReadableStream<Uint8Array>({ pull(c) { onPull?.(i); if (i < list.length) c.enqueue(new Uint8Array(list[i++]!)); else c.close(); } });
  };
  const body = (s: ReadableStream<Uint8Array>, h: Record<string, string> = {}) => new Response(s, { status: 200, headers: { 'content-type': 'text/plain', [HOLDER_MEDIA_HEADER]: '1', ...h } });

  it('checks the owner on every write: a revocation between chunks stops the next write, with the timer far off', async () => {
    const list = [Buffer.from('one'), Buffer.from('two'), Buffer.from('three')];
    let allowed = true;
    const f = (async () => body(parts(list, (i) => { if (i === 3) allowed = false; }))) as typeof fetch;
    const r = await run(f, () => allowed, sha(Buffer.concat(list)), { recheckMs: 60_000 });
    expect(Buffer.concat(r.chunks).toString()).toBe('one');
    expect(r.ended).toBe(false);
    expect(r.destroyed).toBe(true);
  });

  it('an owner check that throws at a write refuses like a failed one', async () => {
    const list = [Buffer.from('one'), Buffer.from('two'), Buffer.from('three')];
    let broken = false;
    const f = (async () => body(parts(list, (i) => { if (i === 3) broken = true; }))) as typeof fetch;
    const r = await run(f, () => { if (broken) throw new Error('store unreadable'); return true; }, sha(Buffer.concat(list)), { recheckMs: 60_000 });
    expect(Buffer.concat(r.chunks).toString()).toBe('one');
    expect(r.ended).toBe(false);
  });

  it('a trailing empty chunk cannot release the real last chunk before the hash check', async () => {
    const list = [Buffer.from('one'), Buffer.from('two'), Buffer.alloc(0)];
    const f = (async () => body(parts(list), { 'content-length': '6' })) as typeof fetch;
    const r = await run(f, () => true, 'c'.repeat(64));
    expect(Buffer.concat(r.chunks).toString()).toBe('one');
    expect(r.ended).toBe(false);
  });

  it('empty chunks around a good file change nothing', async () => {
    const list = [Buffer.alloc(0), Buffer.from('one'), Buffer.alloc(0), Buffer.from('two'), Buffer.alloc(0)];
    const r = await run((async () => body(parts(list))) as typeof fetch, () => true, sha(Buffer.from('onetwo')));
    expect(r.chunks.every((c) => c.length > 0)).toBe(true);
    expect(Buffer.concat(r.chunks).toString()).toBe('onetwo');
    expect(r.ended).toBe(true);
  });

  it('empty chunks do not count as progress: the idle limit still fires', async () => {
    let timer: NodeJS.Timeout | undefined;
    let ctl: ReadableStreamDefaultController<Uint8Array> | undefined;
    const s = new ReadableStream<Uint8Array>({
      start(c) { ctl = c; c.enqueue(new Uint8Array(Buffer.from('one'))); timer = setInterval(() => { try { c.enqueue(new Uint8Array(0)); } catch { clearInterval(timer); } }, 5); },
      cancel() { clearInterval(timer); },
    });
    const f = ((_u: unknown, init: { signal: AbortSignal }) => {
      init.signal.addEventListener('abort', () => { clearInterval(timer); ctl?.error(init.signal.reason); }); // a real fetch body errors on abort
      return Promise.resolve(body(s));
    }) as unknown as typeof fetch;
    const t0 = Date.now();
    const r = await Promise.race([run(f, () => true, 'a'.repeat(64), { idleMs: 60, recheckMs: 60_000 }), new Promise<null>((ok) => setTimeout(() => ok(null), 2_000))]);
    clearInterval(timer);
    expect(r).not.toBeNull();
    expect(Date.now() - t0).toBeLessThan(1_500);
    expect(r!.ended).toBe(false);
    expect(r!.statusCode).toBe(504);
  });

  it('a registry that throws answers the phone and never rejects', async () => {
    const res = new FakeRes();
    const f = vi.fn();
    const stream = buildMediaHolderStream({ peers: () => { throw new Error('REGISTRY_CORRUPT'); }, token: () => 't', selfMachineId: () => 'm_a', fetchImpl: f as unknown as typeof fetch });
    await expect(stream({ sha256: 'a'.repeat(64), ref: 'slack:_:C', machine: 'm_b', isCurrent: () => true }, res as unknown as ExpressResponse)).resolves.toBeUndefined();
    expect(res.statusCode).toBe(503);
    expect(f).not.toHaveBeenCalled();
  });

  it('a phone that stops reading gives its slot back at the drain limit', async () => {
    class Stuck extends FakeRes { write(c: Uint8Array) { super.write(c); return false; } }
    const list = [Buffer.from('one'), Buffer.from('two'), Buffer.from('three')];
    const f = (async () => body(parts(list))) as typeof fetch;
    const stream = buildMediaHolderStream({ peers: () => [{ machineId: 'm_b', url: 'http://127.0.0.1:9', kind: 'lan' }], token: () => 't', selfMachineId: () => 'm_a', fetchImpl: f, recheckMs: 60_000, drainMs: 40 });
    const q = { sha256: sha(Buffer.concat(list)), ref: 'slack:_:C', machine: 'm_b', isCurrent: () => true };
    for (let i = 0; i < 3; i++) { // two per holder: a third only starts if the slots came back
      const res = new Stuck();
      const t0 = Date.now();
      await stream(q, res as unknown as ExpressResponse);
      expect(Date.now() - t0).toBeLessThan(1_000);
      expect(res.chunks.length).toBeGreaterThan(0);
      expect(res.ended).toBe(false);
      expect(res.destroyed).toBe(true);
    }
  });

  it('full slots ask the phone to wait longer than a chat poll', async () => {
    const hang = ((_u: unknown, init: { signal: AbortSignal }) => new Promise((_ok, no) => { init.signal.addEventListener('abort', () => no(init.signal.reason)); })) as unknown as typeof fetch;
    const stream = buildMediaHolderStream({ peers: () => [{ machineId: 'm_b', url: 'http://127.0.0.1:9', kind: 'lan' }], token: () => 't', selfMachineId: () => 'm_a', fetchImpl: hang, firstByteMs: 80 });
    const q = { sha256: 'a'.repeat(64), ref: 'slack:_:C', machine: 'm_b', isCurrent: () => true };
    const held = [new FakeRes(), new FakeRes()].map((r) => stream(q, r as unknown as ExpressResponse));
    const third = new FakeRes();
    await stream(q, third as unknown as ExpressResponse);
    expect(third.statusCode).toBe(202);
    expect(third.body).toEqual({ state: 'fetching', retryAfterMs: HOLDER_MEDIA_BUSY_RETRY_MS });
    await Promise.all(held);
  });

  it('the route timeout outlasts the stream, and uploads keep the default', () => {
    const o = buildRequestTimeoutOverrides();
    expect(MOBILE_MEDIA_TIMEOUT_MS).toBeGreaterThan(HOLDER_MEDIA_DEADLINE_MS);
    expect(resolveRequestTimeout(`/mobile/media/${'a'.repeat(64)}`, 30_000, o)).toBe(MOBILE_MEDIA_TIMEOUT_MS);
    expect(resolveRequestTimeout('/mobile/media/uploads/x/chunks/0', 30_000, o)).toBe(30_000);
    expect(resolveRequestTimeout('/mobile/media/purge', 30_000, o)).toBe(30_000);
  });

  it('a machine with no token of its own accepts no hop', () => {
    const req = { headers: { authorization: 'Bearer anything' } };
    expect(holderBearerOk(req, undefined)).toBe(false);
    expect(holderBearerOk(req, '')).toBe(false);
    expect(holderBearerOk(req, 'anything')).toBe(true);
    expect(holderBearerOk(req, 'other')).toBe(false);
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

/** Logic/race coverage using actual WebCrypto and an asynchronous device-record fixture.
 * Real IndexedDB/Profile durability is verified separately by the browser lifecycle tests. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as bd from '../../dashboard/console/browser-device.js';

type RecordRow = Record<string, any>;
function recordFixture() {
  const rows = new Map<string, RecordRow>();
  const request = (fn: () => any, t: Record<string, any>) => {
    const r: Record<string, any> = {}; t.pending++;
    setTimeout(() => {
      r.result = fn(); r.onsuccess?.(); t.pending--;
      if (!t.pending) setTimeout(() => { if (!t.pending) t.oncomplete?.(); }, 0);
    }, 0);
    return r;
  };
  return { rows, open() {
    const r: Record<string, any> = {};
    setTimeout(() => {
      r.result = {
        objectStoreNames: { contains: () => true }, close() {},
        transaction() {
          const t: Record<string, any> = { pending: 0 };
          t.objectStore = () => ({
            get: (key: string) => request(() => rows.get(key), t),
            getAll: () => request(() => [...rows.values()], t),
            put: (value: RecordRow) => request(() => rows.set(value.machineId, value), t),
            delete: (key: string) => request(() => rows.delete(key), t),
          });
          return t;
        },
      };
      r.onsuccess?.();
    }, 0);
    return r;
  } };
}
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
async function identity(suffix = 'old') {
  const { keyPair, publicKey } = await bd.generateDeviceKey();
  return { machineId: 'm1', host: 'echo.example.dev', deviceId: `device-${suffix}`, keyHash: await bd.keyHashOf(publicKey), keyPair, publicKey, status: 'active' };
}
let db: ReturnType<typeof recordFixture>;
beforeEach(() => { db = recordFixture(); vi.stubGlobal('indexedDB', db); bd.setBrowserDeviceCleanup?.(null); });
afterEach(() => { bd.setBrowserDeviceCleanup?.(null); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('captured browser identity at network admission', () => {
  it('sends one physical target request, preserving exact bytes and returning its 401', async () => {
    const rec = await identity(); db.rows.set('m1', rec);
    const fetchFn = vi.fn(async () => new Response('{}', { status: 401 }));
    const d = bd.createBrowserDevice({ fetchFn }); await d.load('m1');
    const bytes = new TextEncoder().encode('{"text":"original","requestId":"original-id"}');
    const beforeFetch = vi.fn(async () => true);
    const result = await d.call('POST', '/mobile/chat/app/a', { bytes, contentType: 'application/json', expectedRecord: rec, beforeFetch });
    expect(result.status).toBe(401);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(beforeFetch).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][1].body).toBe(bytes);
    expect(fetchFn.mock.calls[0][1].headers['X-Instar-Device']).toBe(rec.deviceId);
  });

  it('refuses an identity replaced while crypto is signing, before any fetch', async () => {
    const rec = await identity(); const replacement = await identity('replacement'); db.rows.set('m1', rec);
    const fetchFn = vi.fn(); const d = bd.createBrowserDevice({ fetchFn }); await d.load('m1');
    const entered = deferred(); const gate = deferred();
    const sign = globalThis.crypto.subtle.sign.bind(globalThis.crypto.subtle);
    vi.spyOn(globalThis.crypto.subtle, 'sign').mockImplementation(async (...args) => { entered.resolve(); await gate.promise; return sign(...args); });
    const pending = d.signedFetch('POST', '/mobile/chat/app/a', { json: { text: 'old' }, expectedRecord: rec });
    const rejected = expect(pending).rejects.toThrow('browser-device-changed');
    await entered.promise; db.rows.set('m1', replacement); gate.resolve();
    await rejected; expect(fetchFn).not.toHaveBeenCalled();
  });

  it('checks liveness synchronously after the last async beforeFetch guard', async () => {
    const rec = await identity(); db.rows.set('m1', rec);
    let live = true; const fetchFn = vi.fn(); const d = bd.createBrowserDevice({ fetchFn }); await d.load('m1');
    await expect(d.signedFetch('POST', '/mobile/chat/app/a', {
      json: { text: 'old' }, expectedRecord: rec, isCurrent: () => live,
      beforeFetch: async () => { live = false; return true; },
    })).rejects.toThrow('browser-device-changed');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('does not fetch when the final queue guard declines admission', async () => {
    const rec = await identity(); db.rows.set('m1', rec);
    const fetchFn = vi.fn(); const d = bd.createBrowserDevice({ fetchFn }); await d.load('m1');
    await expect(d.signedFetch('POST', '/mobile/chat/app/a', { json: {}, beforeFetch: async () => false })).rejects.toThrow('browser-device-changed');
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('status request deadline cancellation', () => {
  it('passes the abort signal to the one status fetch and releases its in-flight slot', async () => {
    const fetchFn = vi.fn(async (_path: string, opts: RequestInit) => new Promise<Response>((_resolve, reject) => {
      opts.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    }));
    const d = bd.createBrowserDevice({ fetchFn }); const ctl = new AbortController();
    const pending = d.status('abc', { signal: ctl.signal }); const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    ctl.abort(); await rejected;
    expect(fetchFn).toHaveBeenCalledTimes(1); expect(fetchFn.mock.calls[0][1].signal).toBe(ctl.signal);
    fetchFn.mockImplementationOnce(async () => new Response(JSON.stringify({ machineId: 'm1', serverTime: Date.now() })));
    expect((await d.status('abc')).ok).toBe(true); expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe('expected-key cleanup and replacement', () => {
  it.each(['revoked', 'declined', 'expired', 'not-found'])('cleans pending content before definitive %s deletion', async (state) => {
    const rec = await identity(); db.rows.set('m1', rec); const order: string[] = [];
    bd.setBrowserDeviceCleanup(async (old: RecordRow) => { expect(db.rows.get('m1')).toBe(rec); expect(old.keyHash).toBe(rec.keyHash); order.push('cleanup'); });
    const d = bd.createBrowserDevice({ fetchFn: async () => new Response(JSON.stringify({ machineId: 'm1', key: { state } })) }); await d.load('m1');
    expect((await d.checkAfter401()).deleted).toBe(true);
    expect(order).toEqual(['cleanup']); expect(db.rows.has('m1')).toBe(false); expect(d.record).toBeNull();
  });

  it('preserves enrollment when pending-content cleanup fails', async () => {
    const rec = await identity(); db.rows.set('m1', rec);
    bd.setBrowserDeviceCleanup(async () => { throw new Error('outbox-erasure-failed'); });
    const d = bd.createBrowserDevice(); await d.load('m1');
    await expect(d.forget()).rejects.toThrow('outbox-erasure-failed');
    expect(db.rows.get('m1')).toBe(rec); expect(d.record).toBe(rec);
  });

  it('does not delete a replacement committed while old cleanup awaited', async () => {
    const rec = await identity(); const replacement = await identity('new'); db.rows.set('m1', rec);
    const entered = deferred(); const gate = deferred();
    bd.setBrowserDeviceCleanup(async () => { entered.resolve(); await gate.promise; });
    const pending = bd.deleteRecord('m1', rec); await entered.promise;
    db.rows.set('m1', replacement); gate.resolve();
    expect(await pending).toBe(false); expect(db.rows.get('m1')).toBe(replacement);
  });

  it('does not overwrite a newer identity after a delayed replacement cleanup', async () => {
    const rec = await identity(); const proposed = await identity('proposed'); const winner = await identity('winner'); db.rows.set('m1', rec);
    const entered = deferred(); const gate = deferred();
    bd.setBrowserDeviceCleanup(async () => { entered.resolve(); await gate.promise; });
    const pending = bd.writeRecord(proposed, { expectedRecord: rec });
    const rejected = expect(pending).rejects.toThrow('browser-device-changed');
    await entered.promise; db.rows.set('m1', winner); gate.resolve(); await rejected;
    expect(db.rows.get('m1')).toBe(winner);
  });

  it('a delayed old status answer cannot delete the current replacement', async () => {
    const rec = await identity(); const replacement = await identity('new'); db.rows.set('m1', rec);
    const answer = deferred<Response>(); const entered = deferred();
    const cleanup = vi.fn(async () => {}); bd.setBrowserDeviceCleanup(cleanup);
    const d = bd.createBrowserDevice({ fetchFn: async () => { entered.resolve(); return answer.promise; } }); await d.load('m1');
    const pending = d.checkAfter401(); await entered.promise;
    db.rows.set('m1', replacement); answer.resolve(new Response(JSON.stringify({ machineId: 'm1', key: { state: 'revoked' } })));
    expect((await pending).deleted).toBe(false); expect(cleanup).not.toHaveBeenCalled(); expect(db.rows.get('m1')).toBe(replacement);
  });

  it('cleans the captured scope even if another actor already removed its signing row', async () => {
    const rec = await identity(); db.rows.set('m1', rec);
    const d = bd.createBrowserDevice(); await d.load('m1');
    db.rows.delete('m1');
    const cleanup = vi.fn(async () => {}); bd.setBrowserDeviceCleanup(cleanup);
    await d.forget();
    expect(cleanup).toHaveBeenCalledWith(rec); expect(d.record).toBeNull();
  });

  it('same-identity approval/status updates do not retire pending content', async () => {
    const rec = await identity(); rec.status = 'pending'; db.rows.set('m1', rec);
    const cleanup = vi.fn(async () => {}); bd.setBrowserDeviceCleanup(cleanup);
    const d = bd.createBrowserDevice(); await d.load('m1'); await d.setStatus('active');
    expect(d.record.status).toBe('active'); expect(db.rows.get('m1')?.status).toBe('active'); expect(cleanup).not.toHaveBeenCalled();
  });
});

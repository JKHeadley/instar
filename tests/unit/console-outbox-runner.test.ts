// Runner decisions only. Real IndexedDB/CryptoKey persistence and signed HTTP are covered separately.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OutboxRunner, beginConsoleOutbox, getConsoleOutbox } from '../../dashboard/console/outbox-runner.js';

const actor = { host: 'localhost:4000', machineId: 'm1', deviceId: 'browser-one', keyHash: 'a'.repeat(64) };
const id = `${Date.now()}-12345678-1234-4123-8123-123456789abc`;
const path = '/mobile/chat/app/3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';
const raw = JSON.stringify({ text: 'original text', requestId: id });
const copy = (v: any) => structuredClone(v);
const runners: any[] = [];
afterEach(() => { for (const r of runners.splice(0)) r.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function fixture({ entry = {}, status = {}, response = { ok: true, status: 200, data: { messageId: 'real-message', deliveryState: 'delivered' } } }: any = {}) {
  let row: any = { requestId: id, actor, ref: 'app:3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b', path, text: 'original text', firstSentAt: Date.now(),
    revision: 1, epoch: 1, files: [], recoveryGeneration: '1', stopEvidence: 'unmatched', finalPath: path, finalBody: raw, ...entry };
  const requests: any[] = [];
  const timerCalls: any[] = [];
  let accepted = 0;
  const statusBody = { machineId: 'm1', key: { state: 'active' }, telegramSend: true,
    outbox: { version: 1, enabled: true, recoveryGeneration: '1', text: true, media: true, stopPhrases: ['stop'] }, ...status };
  const store: any = {
    bindSession: vi.fn(async () => ({ epoch: 1 })), isLive: vi.fn(async () => true),
    get: vi.fn(async () => row && copy(row)), list: vi.fn(async () => row ? [copy(row)] : []),
    metrics: vi.fn(async () => ({ admitted: 1, accepted, held: 0, failure: 0 })),
    admit: vi.fn(async (_s: any, _a: any, e: any) => { row = { ...copy(e), files: [], revision: 1 }; return copy(row); }),
    update: vi.fn(async (_s: any, _a: any, e: any, patch: any) => {
      if (!row || e.revision !== row.revision) return null;
      row = { ...row, ...copy(patch), revision: row.revision + 1 }; return copy(row);
    }),
    claimAttempt: vi.fn(async (_s: any, _a: any, e: any, key: string) => {
      if (!row || e.revision !== row.revision) return { kind: 'stale' };
      row = { ...row, revision: row.revision + 1, attempts: { ...row.attempts, [key]: { count: 1 } } };
      return { kind: 'claimed', entry: copy(row), token: `claim:${key}` };
    }),
    verifyClaim: vi.fn(async () => true),
    finishAttempt: vi.fn(async (_s: any, _a: any, e: any, _token: any, result: any) => {
      if (!row || row.revision !== e.revision) return null;
      row = { ...row, ...result.patch, revision: row.revision + 1 }; return copy(row);
    }),
    remove: vi.fn(async (_s: any, _a: any, _e: any, result: any) => { if (!row || _e.revision !== row.revision) return false; row = null; if (result?.messageId) accepted++; return true; }),
    resetAttempts: vi.fn(async (_s: any, _a: any, e: any) => { row = { ...row, revision: row.revision + 1, attempts: {} }; return copy(row); }),
    legacyAllowed: vi.fn(async () => true), clearAll: vi.fn(async () => {}), part: vi.fn(async () => new Uint8Array([1])),
  };
  const runner = new OutboxRunner({ store, locks: { request: async (_name: any, _options: any, fn: any) => fn() },
    setTimer: (fn: any, ms: number) => { const token = { fn, ms }; timerCalls.push(token); return token; }, clearTimer: () => {} });
  runner.session = { epoch: 1 }; runner.record = actor;
  runner.device = { record: actor, clock: { now: () => Date.now() }, load: vi.fn(async () => actor),
    status: vi.fn(async () => ({ ok: true, data: statusBody })),
    call: vi.fn(async (method: string, url: string, opts: any) => {
      try { if (opts.beforeFetch) await opts.beforeFetch(); } catch { return { ok: false, status: 0, data: null }; }
      requests.push({ method, url, opts });
      return typeof response === 'function' ? response(method, url, opts) : copy(response);
    }) };
  runners.push(runner);
  return { runner, store, requests, timerCalls, current: () => row, entry: () => copy(row) };
}

describe('durable browser send recovery decisions', () => {
  it('replays the frozen final request before looking at an expired upload', async () => {
    const f = fixture({ entry: { files: [{ uploadId: 'expired', complete: true }] } });
    expect(await f.runner.process(f.entry(), true)).toBe(true);
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0].url).toBe(path);
    expect(new TextDecoder().decode(f.requests[0].opts.bytes)).toBe(raw);
    expect(f.store.remove.mock.calls[0][3].messageId).toBe('real-message');
  });
  it.each(['matched', 'unknown'])('does not recover a stop with %s admission evidence', async (evidence) => {
    const f = fixture({ entry: { stopEvidence: evidence, text: 'stop' } });
    await f.runner.process(f.entry(), true);
    expect(f.requests).toHaveLength(0);
    expect(f.current().holdCode).toBe('stop');
  });
  it('holds ordinary text if the current server has added it to the exact stop set', async () => {
    const f = fixture({ entry: { text: 'new stop', stopEvidence: 'unmatched' }, status: {
      outbox: { version: 1, enabled: true, recoveryGeneration: '1', text: true, media: true, stopPhrases: ['new stop'] },
    } });
    await f.runner.process(f.entry(), true);
    expect(f.requests).toHaveLength(0);
    expect(f.current().holdCode).toBe('stop');
  });
  it('holds a changed actor before any target request', async () => {
    const f = fixture({ entry: { actor: { ...actor, deviceId: 'another-browser' } } });
    await f.runner.process(f.entry(), true);
    expect(f.requests).toHaveLength(0);
    expect(f.current().holdCode).toBe('identity');
  });
  it('honors a long server cooldown and retains the identical uncertain request', async () => {
    const f = fixture({ response: { ok: false, status: 429, data: {}, retryAfterMs: 180_000 } });
    await f.runner.process(f.entry(), true);
    expect(f.requests).toHaveLength(1);
    expect(f.current().finalBody).toBe(raw);
    expect(f.current().phase).toBe('submitted');
    expect(f.store.finishAttempt.mock.calls[0][4].nextEligibleAt).toBeGreaterThanOrEqual(Date.now() + 179_000);
    expect(f.timerCalls.some((t) => t.ms >= 179_000)).toBe(true);
    expect(f.store.remove).not.toHaveBeenCalled();
  });
  it('performs no target request if the post-sign epoch guard fails', async () => {
    const f = fixture();
    f.store.verifyClaim.mockResolvedValue(false);
    await f.runner.process(f.entry(), true);
    expect(f.requests).toHaveLength(0);
    expect(f.current()).not.toBeNull();
  });
  it('allows a current online text-only stop through one direct attempt after quota failure', async () => {
    const f = fixture();
    f.store.admit.mockRejectedValue(new DOMException('full', 'QuotaExceededError'));
    const result = await f.runner.submit({ record: actor, status: { outbox: { recoveryGeneration: '1', stopPhrases: ['stop'] } }, ref: 'app:3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b', text: 'stop' });
    expect(result.direct.messageId).toBe('real-message');
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0].opts.json.text).toBe('stop');
    expect(f.store.claimAttempt).not.toHaveBeenCalled();
  });
  it('does not replay or report saved after a lost direct stop acknowledgment', async () => {
    const f = fixture({ response: { ok: false, status: 0, data: null } });
    f.store.admit.mockRejectedValue(new DOMException('full', 'QuotaExceededError'));
    await expect(f.runner.submit({ record: actor, status: { outbox: { recoveryGeneration: '1', stopPhrases: ['stop'] } }, ref: 'app:3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b', text: 'stop' }))
      .rejects.toMatchObject({ code: 'live-stop-outcome-unknown' });
    expect(f.requests).toHaveLength(1);
    expect(f.store.finishAttempt).not.toHaveBeenCalled();
    expect(f.timerCalls).toHaveLength(0);
  });
  it('holds an older recovery generation until explicit local review resumes it', async () => {
    const f = fixture({ entry: { recoveryGeneration: 'older' } });
    await f.runner.process(f.entry(), true);
    expect(f.requests).toHaveLength(0);
    expect(f.current().holdCode).toBe('generation');
    f.runner.reconnect = vi.fn(async () => true);
    await f.runner.resume(f.entry());
    expect(f.current().recoveryGeneration).toBe('1');
    expect(f.current().finalBody).toBe(raw);
    expect(f.store.resetAttempts).toHaveBeenCalledOnce();
    expect(f.runner.reconnect).toHaveBeenCalledOnce();
  });
  it('uses a separate read budget to reconcile a completed seventh PUT', async () => {
    const f = fixture({ entry: { finalBody: undefined, files: [{ uploadId: 'u', complete: false, partCount: 1, received: [] }] },
      response: (method: string) => method === 'GET' ? { ok: true, status: 200, data: { state: 'complete', received: [] } }
        : { ok: true, status: 200, data: { messageId: 'reconciled-message' } } });
    const original = f.store.claimAttempt.getMockImplementation()!;
    f.store.claimAttempt.mockImplementation(async (...args: any[]) => args[3].startsWith('part:') ? { kind: 'exhausted' } : original(...args));
    f.runner.checked.add(`${id}:0`);
    expect(await f.runner.process(f.entry(), true)).toBe(true);
    expect(f.requests.map((r) => r.method)).toEqual(['GET']);
    expect(f.current().files[0].complete).toBe(true);
    expect(await f.runner.process(f.entry(), true)).toBe(true);
    expect(f.requests.map((r) => r.method)).toEqual(['GET', 'POST']);
  });
  it('keeps no-lock recovery automatic writes at zero and allows explicit same-ID resume', async () => {
    const f = fixture();
    f.runner.locks = null;
    await f.runner.reconnect();
    expect(f.requests).toHaveLength(0);
    await f.runner.resume(f.entry());
    expect(f.requests).toHaveLength(1);
    expect(new TextDecoder().decode(f.requests[0].opts.bytes)).toBe(raw);
  });
  it('clears a published controller when its initial durable binding fails', async () => {
    await expect(beginConsoleOutbox({ store: { bindSession: async () => { throw new Error('disk-unavailable'); } } })).rejects.toThrow('disk-unavailable');
    expect(getConsoleOutbox()).toBeNull();
  });
  it('never turns an authoritative ended-session rejection into a direct stop', async () => {
    const f = fixture();
    f.store.admit.mockRejectedValue(Object.assign(new Error('ended'), { code: 'outbox-session-ended' }));
    await expect(f.runner.submit({ record: actor, status: { outbox: { recoveryGeneration: '1', stopPhrases: ['stop'] } }, ref: 'app:3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b', text: 'stop' }))
      .rejects.toMatchObject({ code: 'outbox-session-ended' });
    expect(f.requests).toHaveLength(0);
  });
  it('does not restore legacy plaintext when logout interrupts an import', async () => {
    const f = fixture();
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) };
    vi.stubGlobal('sessionStorage', storage);
    storage.setItem('instar_chat_unfinished', JSON.stringify([{ requestId: id, ref: 'app:3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b', text: 'private old draft', deviceId: actor.deviceId, machineId: actor.machineId }]));
    f.store.admit.mockImplementation(async () => { f.runner.dispose(); storage.removeItem('instar_chat_unfinished'); throw new Error('outbox-session-ended'); });
    await f.runner.importLegacy();
    expect(storage.getItem('instar_chat_unfinished')).toBeNull();
  });
  it('does not rebroadcast an identical held state between reconnecting tabs', async () => {
    const f = fixture({ entry: { phase: 'held', holdCode: 'unsupported', reason: 'Waiting for support' } });
    const changed = vi.spyOn(f.runner, 'changed');
    await f.runner.hold(f.entry(), 'unsupported', 'Waiting for support');
    await f.runner.hold(f.entry(), 'unsupported', 'Waiting for support');
    expect(f.store.update).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
  });
  it('starts a new read-only status budget only after confirmed chunk progress', async () => {
    const f = fixture({ entry: { finalBody: undefined, files: [{ uploadId: 'u', complete: false, partCount: 3, received: [] }] },
      response: { ok: true, status: 200, data: { state: 'open', received: [] } } });
    await f.runner.statusFor(f.entry(), 0, true);
    const firstKey = f.store.claimAttempt.mock.calls[0][3];
    const row = await f.store.update(f.runner.session, actor, f.entry(), { files: [{ uploadId: 'u', complete: false, partCount: 3, received: [0] }] });
    await f.runner.statusFor(row, 0, true);
    expect(f.store.claimAttempt.mock.calls[1][3]).not.toBe(firstKey);
  });

  it('clears cached pending text when its signing record has disappeared', async () => {
    const f = fixture();
    f.runner.entries = [f.entry()];
    f.runner.device.load.mockResolvedValue(null);
    await f.runner.reconnect();
    expect(f.runner.entries).toEqual([]);
    expect(f.runner.record).toBeNull();
  });

  it('waits after a status-read cooldown without attempting an unconfirmed chunk PUT', async () => {
    const f = fixture({ entry: { finalBody: undefined, files: [{ uploadId: 'u', complete: false, partCount: 1, received: [] }] },
      response: { ok: false, status: 503, data: {}, retryAfterMs: 180_000 } });
    await f.runner.process(f.entry(), true);
    expect(f.requests.map((r) => r.method)).toEqual(['GET']);
  });

  it('removes the current retained row after a displayed snapshot becomes stale', async () => {
    const f = fixture();
    const displayed = f.entry();
    await f.store.update(f.runner.session, actor, f.entry(), { phase: 'uploading' });
    expect(await f.runner.remove(displayed)).toBe(true);
    expect(f.current()).toBeNull();
  });

  it('derives the status budget from the latest row after taking ownership', async () => {
    const f = fixture({ entry: { finalBody: undefined, files: [{ uploadId: 'u', complete: false, partCount: 2, received: [] }] },
      response: { ok: true, status: 200, data: { state: 'open', received: [0] } } });
    const stale = f.entry();
    await f.store.update(f.runner.session, actor, f.entry(), { files: [{ uploadId: 'u', complete: false, partCount: 2, received: [0] }] });
    await f.runner.statusFor(stale, 0, true);
    expect(f.store.claimAttempt.mock.calls[0][3]).toBe('status:0:0');
  });
  it('does not preflight expired media when another tab has already frozen the final request', async () => {
    const f = fixture({ entry: { finalBody: undefined, files: [{ uploadId: 'u', complete: false, partCount: 1, received: [] }] } });
    const stale = f.entry();
    await f.store.update(f.runner.session, actor, f.entry(), { finalBody: raw, files: [{ uploadId: 'u', complete: true, partCount: 1, received: [0] }] });
    const result = await f.runner.statusFor(stale, 0, true);
    expect(result.kind).toBe('progress');
    expect(f.requests).toHaveLength(0);
  });
  it('honors a terminal hold recorded after a worker captured its old row', async () => {
    const f = fixture();
    const stale = f.entry();
    await f.store.update(f.runner.session, actor, f.entry(), { holdCode: 'unknown', phase: 'held' });
    await f.runner.process(stale, true);
    expect(f.requests).toHaveLength(0);
  });

  it('does not expose a file when the sign-in ends during its final storage guard', async () => {
    const f = fixture({ entry: { files: [{ filename: 'private.txt', partCount: 1 }] } });
    f.store.assertLive = vi.fn(async () => { f.runner.dispose(); return true; });
    await expect(f.runner.recoverFile(f.entry(), 0)).rejects.toThrow('no longer current');
  });

});

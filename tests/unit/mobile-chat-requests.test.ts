/** Idempotency record for app chat messages (docs/specs/mobile-operator-chat.md §2.4). */
import { describe, it, expect, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MobileChatRequestStore, payloadHash, requestIdAgeOk, requestIdTime } from '../../src/core/MobileChatRequests.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/mobile-chat-requests.test.ts' }); });
function tmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mcr-')); dirs.push(d); return d; }
const rid = (t = Date.now()) => `${t}-${crypto.randomUUID()}`;
const ok = { status: 200, body: { ok: true, outcome: 'delivered' } };

describe('MobileChatRequestStore', () => {
  it('request ids: grammar and the -24h/+5m window', () => {
    const now = Date.now();
    expect(requestIdTime('nope')).toBeNull();
    expect(requestIdTime(`${now}-not-a-uuid`)).toBeNull();
    expect(requestIdTime(rid(now))).toBe(now);
    expect(requestIdAgeOk(rid(now - 23 * 3600_000), now)).toBe(true);
    expect(requestIdAgeOk(rid(now - 25 * 3600_000), now)).toBe(false);
    expect(requestIdAgeOk(rid(now + 4 * 60_000), now)).toBe(true);
    expect(requestIdAgeOk(rid(now + 6 * 60_000), now)).toBe(false);
  });

  it('payload hash covers topic and trimmed text', () => {
    expect(payloadHash(1, ' hi ')).toBe(payloadHash(1, 'hi'));
    expect(payloadHash(1, 'hi')).not.toBe(payloadHash(2, 'hi'));
  });

  it('done repeat returns the stored response; in-flight repeat is in-progress; reuse is refused', () => {
    const s = new MobileChatRequestStore(tmp());
    const id = rid(); const h = payloadHash(1, 'a');
    expect(s.reserve('d', id, h, 1).kind).toBe('reserved');
    expect(s.lookup('d', id, h).kind).toBe('in-progress');
    expect(s.reserve('d', id, h, 1).kind).toBe('in-progress');
    expect(s.lookup('d', id, payloadHash(2, 'a')).kind).toBe('request-id-reused');
    expect(s.finish('d', id, ok)).toBe(true);
    expect(s.lookup('d', id, h)).toEqual({ kind: 'done', ...ok });
  });

  it('an entered record from an earlier boot reads outcome-unknown and is never re-reserved', () => {
    const dir = tmp();
    const id = rid(); const h = payloadHash(1, 'a');
    new MobileChatRequestStore(dir).reserve('d', id, h, 1);
    const after = new MobileChatRequestStore(dir); // restart
    expect(after.lookup('d', id, h).kind).toBe('outcome-unknown');
    expect(after.reserve('d', id, h, 1).kind).toBe('outcome-unknown');
  });

  it('a failed done write leaves the request outcome-unknown without a restart', () => {
    const s = new MobileChatRequestStore(tmp());
    const id = rid(); const h = payloadHash(1, 'a');
    s.reserve('d', id, h, 1);
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('disk full'); });
    try { expect(s.finish('d', id, ok)).toBe(false); } finally { spy.mockRestore(); }
    expect(s.lookup('d', id, h).kind).toBe('outcome-unknown');
  });

  it('release forgets a refused request; markUnknown persists', () => {
    const dir = tmp();
    const s = new MobileChatRequestStore(dir);
    const a = rid(); const b = rid(); const h = payloadHash(1, 'a');
    s.reserve('d', a, h, 1); s.release('d', a);
    expect(s.lookup('d', a, h).kind).toBe('none');
    s.reserve('d', b, h, 1); s.markUnknown('d', b);
    expect(new MobileChatRequestStore(dir).lookup('d', b, h).kind).toBe('outcome-unknown');
  });

  it('records live until their id can no longer be accepted, never earlier', () => {
    let now = Date.now();
    const s = new MobileChatRequestStore(tmp(), () => now);
    const id = rid(now); const h = payloadHash(1, 'a');
    s.reserve('d', id, h, 1); s.finish('d', id, ok);
    now += 24 * 3600_000 + 4 * 60_000;
    expect(s.lookup('d', id, h).kind).toBe('done');
    now += 2 * 60_000;
    expect(s.lookup('d', id, h).kind).toBe('none');
  });

  it('the record file holds no message text', () => {
    const dir = tmp();
    const s = new MobileChatRequestStore(dir);
    const id = rid();
    s.reserve('d', id, payloadHash(1, 'secret words'), 1);
    s.finish('d', id, ok);
    expect(fs.readFileSync(path.join(dir, 'state', 'mobile-chat-requests.json'), 'utf8')).not.toContain('secret words');
  });
});

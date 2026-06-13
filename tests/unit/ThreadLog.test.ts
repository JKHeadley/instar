/**
 * ThreadLog unit tests (D-A) — append/read/verify, persisted-seen-set
 * idempotency (the regression a tail scan misses), content-collision,
 * head-cache rebuild, retention-invariant accumulator, backfilled exclusion,
 * and the traversal allowlist.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ThreadLog, THREAD_ID_RE, type ThreadLogAppendInput } from '../../src/threadline/ThreadLog.js';
import { contentDigest, computeSetAccum } from '../../src/threadline/threadDigest.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'threadlog-')); });
afterEach(() => { try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/ThreadLog.test.ts' }); } catch { /* ignore */ } });

function entry(threadId: string, messageId: string, body: string, direction: 'outbound' | 'inbound' = 'outbound', extra: Partial<ThreadLogAppendInput> = {}): ThreadLogAppendInput {
  const createdAt = `2026-06-12T00:00:${String(messageId.length).padStart(2, '0')}.000Z`;
  return {
    threadId, messageId, direction,
    contentDigest: contentDigest({ threadId, messageId, body, createdAt }),
    textRef: { kind: 'inline', text: body },
    createdAt,
    ...extra,
  };
}

describe('ThreadLog — append / read / verify', () => {
  it('appends and reads back BOTH directions (the F3 fix: own sent messages are auditable)', () => {
    const log = new ThreadLog(dir);
    log.append(entry('thread-a', 'msg-1', 'hello', 'outbound'));
    log.append(entry('thread-a', 'msg-2', 'hi back', 'inbound'));
    log.append(entry('thread-a', 'msg-3', 'more', 'outbound'));
    const { entries } = log.read('thread-a');
    expect(entries.map((e) => e.messageId)).toEqual(['msg-1', 'msg-2', 'msg-3']);
    expect(entries.filter((e) => e.direction === 'outbound').length).toBe(2);
    expect(entries[0].seq).toBe(0);
    expect(entries[2].seq).toBe(2);
  });

  it('empty / missing log = empty history, not an error', () => {
    const log = new ThreadLog(dir);
    expect(log.read('thread-missing').entries).toEqual([]);
    expect(log.head('thread-missing')).toEqual({ count: 0, headHash: '', setAccum: '0'.repeat(64) });
    expect(log.verify('thread-missing')).toEqual({ ok: true });
  });

  it('verify() returns ok on an intact chain and brokenAt on a tampered line', () => {
    const log = new ThreadLog(dir);
    log.append(entry('thread-b', 'msg-1', 'one'));
    log.append(entry('thread-b', 'msg-2', 'two'));
    log.append(entry('thread-b', 'msg-3', 'three'));
    expect(log.verify('thread-b')).toEqual({ ok: true });

    // Tamper with the second line's body without re-chaining.
    const p = path.join(dir, 'threadline', 'threads', 'thread-b.log.jsonl');
    const lines = fs.readFileSync(p, 'utf-8').trim().split('\n');
    const parsed = JSON.parse(lines[1]);
    parsed.textRef = { kind: 'inline', text: 'TAMPERED' };
    lines[1] = JSON.stringify(parsed);
    fs.writeFileSync(p, lines.join('\n') + '\n');
    const v = log.verify('thread-b');
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.brokenAt).toBe(1);
  });

  it('head-cache mismatch → REBUILT from the log (log wins) on a fresh instance', () => {
    const log1 = new ThreadLog(dir);
    log1.append(entry('thread-c', 'msg-1', 'a'));
    log1.append(entry('thread-c', 'msg-2', 'b'));
    const h1 = log1.head('thread-c');
    // A brand-new instance has a cold cache → rebuilds from the on-disk log.
    const log2 = new ThreadLog(dir);
    expect(log2.head('thread-c')).toEqual(h1);
    expect(log2.head('thread-c').count).toBe(2);
  });
});

describe('ThreadLog — idempotency (persisted seen-set, NOT a tail scan)', () => {
  it('a duplicate (same key + same digest) is deduped, not re-appended', () => {
    const log = new ThreadLog(dir);
    const e = entry('thread-d', 'msg-1', 'x', 'outbound');
    expect(log.append(e).status).toBe('appended');
    expect(log.append(e).status).toBe('duplicate');
    expect(log.read('thread-d').entries.length).toBe(1);
  });

  it('a duplicate replayed AFTER > seenSetMaxPerThread intervening entries is STILL deduped (the regression a tail scan would miss)', () => {
    // seenSetMaxPerThread is the in-memory bound; the LIVE LOG is the dedup
    // authority. A cold rebuild reconstructs the seen-set from the whole live
    // log, so a duplicate is caught no matter how many entries intervened.
    const log = new ThreadLog(dir, { seenSetMaxPerThread: 3, maxEntriesPerThread: 10000 });
    const original = entry('thread-e', 'msg-orig', 'first', 'inbound');
    expect(log.append(original).status).toBe('appended');
    for (let i = 0; i < 20; i++) log.append(entry('thread-e', `msg-${i}`, `body-${i}`, 'inbound'));
    // Force a cold rebuild from the log (clears the bounded in-memory state).
    const fresh = new ThreadLog(dir, { seenSetMaxPerThread: 3, maxEntriesPerThread: 10000 });
    expect(fresh.append(original).status).toBe('duplicate');
    expect(fresh.read('thread-e').entries.filter((e) => e.messageId === 'msg-orig').length).toBe(1);
  });

  it('same key + DIFFERENT contentDigest = collision (recorded, never overwritten)', () => {
    const log = new ThreadLog(dir);
    expect(log.append(entry('thread-f', 'msg-1', 'original')).status).toBe('appended');
    expect(log.append(entry('thread-f', 'msg-1', 'POISONED')).status).toBe('collision');
    // The original is intact; the collision did not overwrite it.
    const { entries } = log.read('thread-f');
    expect(entries.length).toBe(1);
    expect(entries[0].contentDigest).toBe(contentDigest({ threadId: 'thread-f', messageId: 'msg-1', body: 'original', createdAt: '2026-06-12T00:00:05.000Z' }));
  });
});

describe('ThreadLog — symmetry head + retention invariance', () => {
  it('head.setAccum equals a hand-computed accumulator over the non-backfilled digests', () => {
    const log = new ThreadLog(dir);
    const e1 = entry('thread-g', 'msg-1', 'one', 'outbound');
    const e2 = entry('thread-g', 'msg-2', 'two', 'inbound');
    log.append(e1);
    log.append(e2);
    expect(log.head('thread-g').setAccum).toBe(computeSetAccum([e1.contentDigest, e2.contentDigest]));
    expect(log.head('thread-g').count).toBe(2);
  });

  it('backfilled legs are EXCLUDED from count/setAccum but still in read()', () => {
    const log = new ThreadLog(dir);
    const live = entry('thread-h', 'msg-1', 'live', 'outbound');
    const back = entry('thread-h', 'msg-0', 'old', 'inbound', { backfilled: true });
    log.append(live);
    log.append(back);
    expect(log.read('thread-h').entries.length).toBe(2);
    // Only the non-backfilled leg counts toward symmetry.
    expect(log.head('thread-h').count).toBe(1);
    expect(log.head('thread-h').setAccum).toBe(computeSetAccum([live.contentDigest]));
  });

  it('rotation to archive/ does NOT change setAccum/count (SI2 — no false diverged)', () => {
    const digests: string[] = [];
    const log = new ThreadLog(dir, { maxEntriesPerThread: 10 });
    for (let i = 0; i < 40; i++) {
      const e = entry('thread-i', `msg-${i}`, `body-${i}`, i % 2 === 0 ? 'outbound' : 'inbound');
      digests.push(e.contentDigest);
      log.append(e);
    }
    // Live segment was rotated (≤ ~10 kept) but the observable totals are intact.
    const head = log.head('thread-i');
    expect(head.count).toBe(40);
    expect(head.setAccum).toBe(computeSetAccum(digests));
    // A fresh instance rebuilds the SAME totals from base sidecar + live log.
    const fresh = new ThreadLog(dir, { maxEntriesPerThread: 10 });
    expect(fresh.head('thread-i')).toEqual(head);
    // The live log itself is bounded.
    expect(fresh.read('thread-i', { limit: 1000 }).entries.length).toBeLessThan(40);
  });
});

describe('ThreadLog — id allowlist + path confinement', () => {
  it('THREAD_ID_RE accepts the real minted shapes and rejects traversal', () => {
    expect(THREAD_ID_RE.test('123e4567-e89b-12d3-a456-426614174000')).toBe(true);
    expect(THREAD_ID_RE.test('msg-1781236493501-ingw5t')).toBe(true);
    expect(THREAD_ID_RE.test('thread-840d5c1d')).toBe(true);
    expect(THREAD_ID_RE.test('../etc/passwd')).toBe(false);
    expect(THREAD_ID_RE.test('thread-../x')).toBe(false);
    expect(THREAD_ID_RE.test('msg-1 ')).toBe(false);
    expect(THREAD_ID_RE.test('thread-840d5c1d/../../x')).toBe(false);
  });

  it('isPathConfined rejects an id that escapes the threads dir', () => {
    const log = new ThreadLog(dir);
    expect(log.isPathConfined('thread-840d5c1d')).toBe(true);
    expect(log.isPathConfined('../../escape')).toBe(false);
  });
});

describe('ThreadLog — close-only retention', () => {
  it('deleteThread removes the log; the orphan-sweep id list reflects it', () => {
    const log = new ThreadLog(dir);
    log.append(entry('thread-j', 'msg-1', 'x'));
    expect(log.listThreadIds()).toContain('thread-j');
    log.deleteThread('thread-j');
    expect(log.listThreadIds()).not.toContain('thread-j');
    expect(log.read('thread-j').entries).toEqual([]);
  });
});

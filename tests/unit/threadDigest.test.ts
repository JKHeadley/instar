/**
 * threadDigest unit tests — the FROZEN v1 wire encoding (D-D / FD-5 / LD1).
 *
 * These vectors are the Dawn-reimplementable bytes: a reference vector test pins
 * `contentDigest` (including a NON-ASCII body) and the order-independent
 * `setAccum` (modulus/endianness/hex-padding/domain-separator all pinned). The
 * literals below were computed by an INDEPENDENT from-scratch implementation (not
 * the module's own output), so a regression in the module is caught rather than
 * blessed.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  contentDigest,
  computeSetAccum,
  setAccumAdd,
  threadSyncEqual,
  EMPTY_SET_ACCUM,
  DIGEST_VERSION,
  type MessageCore,
} from '../../src/threadline/threadDigest.js';

// ── Independent reference implementation (NOT the module) ───────────────────
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const refJcs = (o: Record<string, string>) =>
  '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + JSON.stringify(o[k])).join(',') + '}';
const refContentDigest = (c: MessageCore) =>
  sha(Buffer.from(refJcs({ body: c.body, createdAt: c.createdAt, messageId: c.messageId, threadId: c.threadId }), 'utf-8'));
const refHAcc = (x: string) =>
  BigInt('0x' + sha(Buffer.concat([Buffer.from('threadline-setaccum-v1', 'utf-8'), Buffer.from([0x00]), Buffer.from(x, 'utf-8')])));
const refAccum = (ds: string[]) => {
  let a = 0n;
  for (const d of ds) a = (a + refHAcc(d)) % (1n << 256n);
  return a.toString(16).padStart(64, '0');
};

const CORE1: MessageCore = { threadId: 'thread-abc', messageId: 'msg-1', body: 'café 你好\nsecond line', createdAt: '2026-06-12T00:00:00.000Z' };
const CORE2: MessageCore = { threadId: 'thread-abc', messageId: 'msg-2', body: 'plain ascii reply', createdAt: '2026-06-12T00:00:01.000Z' };

// Frozen golden literals — see the independent computation above and the
// normative "Wire encoding" section of the spec.
const GOLD_CD1 = 'e96bf4b99e66acb5aa276bb7c75db7eda5257d25415e1c7d7f993d854100b6bf';
const GOLD_CD2 = 'ed26a5ae7a26d8244fb76f3c07f49247f04c19eb7d3613f1716a953355969b24';
const GOLD_ACCUM_1 = 'b262dd053a3b90421c64d933ca3546608c33751a25a21390e88b34f930b35fca';
const GOLD_ACCUM_12 = '37ec66b5c769ea7ea99d69aed5dacb43f01ee2ec79aae70f600c47b2b370365b';

describe('threadDigest — frozen v1 wire encoding', () => {
  it('DIGEST_VERSION is 1', () => {
    expect(DIGEST_VERSION).toBe(1);
  });

  it('contentDigest matches the frozen reference vector (incl. non-ASCII body)', () => {
    expect(contentDigest(CORE1)).toBe(GOLD_CD1);
    expect(contentDigest(CORE2)).toBe(GOLD_CD2);
  });

  it('contentDigest reproduces an independent from-scratch implementation', () => {
    expect(contentDigest(CORE1)).toBe(refContentDigest(CORE1));
    expect(contentDigest(CORE2)).toBe(refContentDigest(CORE2));
  });

  it('contentDigest is IDENTITY-FREE — sender identity does not enter it', () => {
    // Two cores with the same {threadId, messageId, body, createdAt} but
    // conceptually different senders produce the SAME digest (identity excluded).
    const d = contentDigest(CORE1);
    expect(d).toBe(GOLD_CD1);
    // A body change DOES change it (the digest is content-addressed).
    expect(contentDigest({ ...CORE1, body: CORE1.body + '!' })).not.toBe(d);
  });

  it('setAccum is order-INDEPENDENT (the keystone property)', () => {
    expect(computeSetAccum([GOLD_CD1, GOLD_CD2])).toBe(computeSetAccum([GOLD_CD2, GOLD_CD1]));
  });

  it('setAccum matches the frozen reference vectors', () => {
    expect(computeSetAccum([GOLD_CD1])).toBe(GOLD_ACCUM_1);
    expect(computeSetAccum([GOLD_CD1, GOLD_CD2])).toBe(GOLD_ACCUM_12);
  });

  it('setAccum reproduces an independent from-scratch implementation', () => {
    expect(computeSetAccum([GOLD_CD1, GOLD_CD2])).toBe(refAccum([GOLD_CD1, GOLD_CD2]));
  });

  it('incremental setAccumAdd equals the whole-set compute (O(1) append == rebuild)', () => {
    let acc = EMPTY_SET_ACCUM;
    acc = setAccumAdd(acc, GOLD_CD1);
    expect(acc).toBe(GOLD_ACCUM_1);
    acc = setAccumAdd(acc, GOLD_CD2);
    expect(acc).toBe(GOLD_ACCUM_12);
    // Folding in the other order reaches the same accumulator.
    let acc2 = EMPTY_SET_ACCUM;
    acc2 = setAccumAdd(acc2, GOLD_CD2);
    acc2 = setAccumAdd(acc2, GOLD_CD1);
    expect(acc2).toBe(GOLD_ACCUM_12);
  });

  it('EMPTY_SET_ACCUM is 64 zero hex chars', () => {
    expect(EMPTY_SET_ACCUM).toBe('0'.repeat(64));
    expect(computeSetAccum([])).toBe(EMPTY_SET_ACCUM);
  });

  it('setAccum is always exactly 64 lowercase-hex chars', () => {
    const a = computeSetAccum([GOLD_CD1, GOLD_CD2, GOLD_CD1]);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('threadSyncEqual requires count AND setAccum AND digestVersion', () => {
    const base = { digestVersion: 1, count: 2, setAccum: GOLD_ACCUM_12 };
    expect(threadSyncEqual(base, { ...base })).toBe(true);
    expect(threadSyncEqual(base, { ...base, count: 3 })).toBe(false);
    expect(threadSyncEqual(base, { ...base, setAccum: GOLD_ACCUM_1 })).toBe(false);
    expect(threadSyncEqual(base, { ...base, digestVersion: 2 })).toBe(false);
  });
});

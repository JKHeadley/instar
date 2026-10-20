/**
 * Instar carries a copy of threadline-core's encryptedSeen mark logic until a published core
 * release exports it and Instar's pin moves to that release (see src/threadline/encryptedSeenMark.ts). This runs the same cases against BOTH,
 * so the copy cannot drift from core silently, and checks the copy's body is byte-identical.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as instar from '../../../src/threadline/encryptedSeenMark.js';
import * as core from '../../../packages/threadline-core/src/encryptedSeen.js';

const K = 'ab'.repeat(32);
const K2 = 'cd'.repeat(32);
const T1 = '2026-10-16T00:00:00.000Z';
const T2 = '2026-10-16T00:05:00.000Z';
const T3 = '2026-10-16T00:10:00.000Z';
const num = (a: number, b: number) => a - b;

describe.each([['core', core], ['instar copy', instar]] as const)('%s', (_name, m) => {
  it('earliestMark: earliest valid, never clears', () => {
    expect(m.earliestMark(T2, T1)).toBe(T1);
    expect(m.earliestMark(T2, undefined)).toBe(T2);
    expect(m.earliestMark(T2, 'x')).toBe(T2);
    expect(m.earliestMark(undefined, undefined)).toBeUndefined();
  });

  it('unifyEncryptedSeen: union keeping the earliest, bound to the key, voided only by a later unpair', () => {
    const seen = (at: string, order: number, key = K) => ({ kind: 'seen' as const, peerIdentityPub: key, at, order });
    expect(m.unifyEncryptedSeen([seen(T3, 3), seen(T1, 1), seen(T2, 2)], K, num)).toBe(T1);
    expect(m.unifyEncryptedSeen([seen(T1, 1, K2)], K, num)).toBeUndefined();
    expect(m.unifyEncryptedSeen([seen(T1, 1), { kind: 'unpaired', peerIdentityPub: K, order: 2 }], K, num)).toBeUndefined();
    expect(m.unifyEncryptedSeen([seen(T1, 1), { kind: 'unpaired', peerIdentityPub: K, order: 2 }, seen(T3, 3)], K, num)).toBe(T3);
    expect(m.unifyEncryptedSeen([seen(T1, 1), { kind: 'unpaired', peerIdentityPub: K2, order: 2 }], K, num)).toBe(T1);
    expect(m.unifyEncryptedSeen([seen(T1, 1), { kind: 'unpaired', order: 2 }], K, num)).toBeUndefined();
  });
});

it('the Instar copy is byte-identical to core below its header', () => {
  const root = path.resolve(__dirname, '../../..');
  const coreSrc = fs.readFileSync(path.join(root, 'packages/threadline-core/src/encryptedSeen.ts'), 'utf-8');
  const copy = fs.readFileSync(path.join(root, 'src/threadline/encryptedSeenMark.ts'), 'utf-8');
  expect(copy.endsWith(coreSrc)).toBe(true);
});

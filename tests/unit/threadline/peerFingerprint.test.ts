/**
 * Shared peer-fingerprint resolver tests.
 * Per docs/specs/threadline-local-delivery-fingerprint-attribution.md — the
 * derivation must mirror the owner-record chain (`fingerprint || publicKey[:32]`),
 * including the LIVE publicKey-only shape that no-op'd the v1 resolver.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolvePeerFingerprint, resolvePeerFingerprintByName } from '../../../src/threadline/peerFingerprint.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

describe('peerFingerprint — resolvePeerFingerprint(entry)', () => {
  it('returns the fingerprint field when present (lowercased)', () => {
    expect(resolvePeerFingerprint({ fingerprint: 'ABCD1234' })).toBe('abcd1234');
  });

  it('falls back to publicKey[:32] when there is no fingerprint (the live sagemind shape)', () => {
    const pub = '1db85f0011223344556677889900aabbccddeeff00112233445566778899aabb';
    expect(resolvePeerFingerprint({ publicKey: pub })).toBe(pub.substring(0, 32));
  });

  it('returns null when neither field is present', () => {
    expect(resolvePeerFingerprint({ name: 'x' } as { name?: string })).toBeNull();
    expect(resolvePeerFingerprint(null)).toBeNull();
    expect(resolvePeerFingerprint(undefined)).toBeNull();
  });
});

describe('peerFingerprint — resolvePeerFingerprintByName(stateDir, name)', () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'peerfp-'));
    fs.mkdirSync(path.join(stateDir, 'threadline'), { recursive: true });
  });
  afterEach(() => { SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'peerFingerprint.test:afterEach' }); });
  const write = (agents: unknown[]) =>
    fs.writeFileSync(path.join(stateDir, 'threadline', 'known-agents.json'), JSON.stringify({ agents }));

  it('resolves a publicKey-only peer to publicKey[:32] (THE incident case)', () => {
    const pub = '1db85f0011223344556677889900aabbccddeeff00112233445566778899aabb';
    write([{ name: 'sagemind', publicKey: pub }]);
    expect(resolvePeerFingerprintByName(stateDir, 'sagemind')).toBe(pub.substring(0, 32));
  });

  it('resolves a fingerprint-only peer', () => {
    write([{ name: 'echo', fingerprint: '63b1dbb2deadbeef63b1dbb2deadbeef' }]);
    expect(resolvePeerFingerprintByName(stateDir, 'echo')).toBe('63b1dbb2deadbeef63b1dbb2deadbeef');
  });

  it('is case-insensitive on the name', () => {
    write([{ name: 'SageMind', publicKey: 'a'.repeat(64) }]);
    expect(resolvePeerFingerprintByName(stateDir, 'sagemind')).toBe('a'.repeat(32));
  });

  it('returns null for an unknown name', () => {
    write([{ name: 'echo', fingerprint: 'abc' }]);
    expect(resolvePeerFingerprintByName(stateDir, 'nobody')).toBeNull();
  });

  it('returns null when the entry has neither fingerprint nor publicKey', () => {
    write([{ name: 'ghost' }]);
    expect(resolvePeerFingerprintByName(stateDir, 'ghost')).toBeNull();
  });

  it('returns null on a name COLLISION with different derived fingerprints (never guess)', () => {
    write([{ name: 'dup', fingerprint: 'aaaaaaaa' }, { name: 'dup', fingerprint: 'bbbbbbbb' }]);
    expect(resolvePeerFingerprintByName(stateDir, 'dup')).toBeNull();
  });

  it('resolves when same-name entries derive the SAME fingerprint (a fingerprint + its publicKey twin)', () => {
    const fp = 'abcd1234abcd1234abcd1234abcd1234';
    const pub = fp + '0'.repeat(32); // publicKey[:32] === fp
    write([{ name: 'twin', fingerprint: fp }, { name: 'twin', publicKey: pub }]);
    expect(resolvePeerFingerprintByName(stateDir, 'twin')).toBe(fp);
  });

  it('returns null on a missing file (fail-safe, no throw)', () => {
    SafeFsExecutor.safeRmSync(path.join(stateDir, 'threadline', 'known-agents.json'), { force: true, operation: 'peerFingerprint.test:missing-file' });
    expect(resolvePeerFingerprintByName(stateDir, 'echo')).toBeNull();
  });

  it('returns null on malformed JSON (no throw)', () => {
    fs.writeFileSync(path.join(stateDir, 'threadline', 'known-agents.json'), 'not json{');
    expect(resolvePeerFingerprintByName(stateDir, 'echo')).toBeNull();
  });

  it('returns null for a null/empty name', () => {
    write([{ name: 'echo', fingerprint: 'abc' }]);
    expect(resolvePeerFingerprintByName(stateDir, null)).toBeNull();
    expect(resolvePeerFingerprintByName(stateDir, '')).toBeNull();
  });
});

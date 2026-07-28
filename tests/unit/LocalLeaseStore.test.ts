/**
 * Tier-1 tests for LocalLeaseStore — the git-less LeaseStore that backs lease
 * coordination on a machine without a git medium (credential-less standby, or an
 * agent home that IS the instar source tree where SourceTreeGuard refuses git).
 * Covers the CAS semantics (strict-advance), durable persistence across
 * instances, same-epoch refresh / supersede, and corrupt-file self-healing.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { LocalLeaseStore } from '../../src/core/LocalLeaseStore.js';
import { FencedLease, type LeaseCrypto } from '../../src/core/FencedLease.js';

function genKey() {
  return crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}
const K = genKey();
const crypt: LeaseCrypto = {
  selfMachineId: 'A',
  sign: (c) => crypto.sign(null, Buffer.from(c), K.privateKey).toString('base64'),
  verify: (c, sig) => {
    try { return crypto.verify(null, Buffer.from(c), K.publicKey, Buffer.from(sig, 'base64')); } catch { return false; }
  },
};
const fl = new FencedLease(crypt, { leaseTtlMs: 60_000, failoverThresholdMs: 900_000 });
function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lls-')), 'lease-local.json');
}

describe('LocalLeaseStore', () => {
  it('reads empty when no file exists', () => {
    const s = new LocalLeaseStore({ filePath: tmpFile() });
    expect(s.read()).toEqual({ lease: null, epoch: 0 });
  });

  it('casWrite accepts a strict epoch advance and persists across instances', () => {
    const fp = tmpFile();
    const s = new LocalLeaseStore({ filePath: fp });
    const l1 = fl.buildAcquisition(undefined, 1000, 1); // epoch 1
    const r = s.casWrite(l1);
    expect(r.ok).toBe(true);
    expect(s.read().epoch).toBe(1);
    expect(s.read().lease?.holder).toBe('A');
    // A fresh instance loads the persisted lease from disk (durable across restart).
    const s2 = new LocalLeaseStore({ filePath: fp });
    expect(s2.read().epoch).toBe(1);
    expect(s2.read().lease?.holder).toBe('A');
  });

  it('casWrite rejects a non-advancing epoch and reports the observed state', () => {
    const fp = tmpFile();
    const s = new LocalLeaseStore({ filePath: fp });
    s.casWrite(fl.buildAcquisition(undefined, 1000, 1)); // epoch 1
    const r = s.casWrite(fl.buildAcquisition(undefined, 1000, 2)); // also epoch 1
    expect(r.ok).toBe(false);
    expect(r.observed.epoch).toBe(1);
  });

  it('refresh keeps the same epoch but declines a superseded one', () => {
    const fp = tmpFile();
    const s = new LocalLeaseStore({ filePath: fp });
    const l2 = fl.signLease(2, new Date(1000).toISOString(), new Date(61_000).toISOString(), 1);
    expect(s.casWrite(l2).ok).toBe(true); // epoch 2
    const renew2 = fl.signLease(2, new Date(2000).toISOString(), new Date(62_000).toISOString(), 2);
    expect(s.refresh(renew2)).toBe(true);
    const stale1 = fl.signLease(1, new Date(1000).toISOString(), new Date(61_000).toISOString(), 1);
    expect(s.refresh(stale1)).toBe(false); // superseded by epoch 2
    expect(s.read().epoch).toBe(2);
  });

  it('a corrupt file reads as empty (self-healing — never authoritative-loss)', () => {
    const fp = tmpFile();
    fs.writeFileSync(fp, '{ this is not valid json');
    const s = new LocalLeaseStore({ filePath: fp });
    expect(s.read()).toEqual({ lease: null, epoch: 0 });
  });
});

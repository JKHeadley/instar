import type { execFileSync } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeMacKeychainKey } from '../../src/core/macKeychainWrite.js';
import { MasterKeyManager } from '../../src/core/SecretStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

it('passes only options in argv and confirms the exact secret through fresh readback', () => {
  const key = Buffer.alloc(32, 7);
  const encoded = key.toString('base64');
  const run = vi.fn();
  const read = vi.fn().mockReturnValueOnce(Buffer.alloc(32, 1)).mockReturnValueOnce(Buffer.from(key));
  const exec = run as unknown as typeof execFileSync;
  expect(writeMacKeychainKey(exec, read, 'fixture-service', 'fixture account', key)).toBe(false);
  expect(writeMacKeychainKey(exec, read, 'fixture-service', 'fixture account', key)).toBe(true);
  expect(read).toHaveBeenCalledTimes(2);
  for (const [binary, args, options] of run.mock.calls) {
    expect(binary).toBe('/usr/bin/security');
    expect(args).toEqual(['-q', '-i']);
    expect(options.input).toContain(encoded);
    expect(options.stdio).toEqual(['pipe', 'ignore', 'ignore']);
    expect(options.timeout).toBe(5000);
    expect(options.killSignal).toBe('SIGKILL');
  }
});

it('refuses command delimiters, control characters, oversized input and invalid key length', () => {
  const run = vi.fn();
  const read = vi.fn();
  for (const account of ['fixture\nquit', 'fixture"quoted', 'x'.repeat(4096)]) {
    expect(writeMacKeychainKey(run as unknown as typeof execFileSync, read, 'service', account, Buffer.alloc(32))).toBe(false);
  }
  expect(writeMacKeychainKey(run as unknown as typeof execFileSync, read, 'service', 'account', Buffer.alloc(31))).toBe(false);
  expect(run).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
});

it('an unconfirmed write that did reach the keychain leaves two copies of the SAME key, and later reads agree', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-dual-copy-'));
  try {
    const slots = new Map<string, Buffer>();
    // Stand-in keychain: the write lands, but its confirmation fails (readback error after a successful upsert).
    const ops = {
      read: (service: string, account: string) => slots.get(`${service}|${account}`) ?? null,
      write: (service: string, account: string, key: Buffer) => { slots.set(`${service}|${account}`, Buffer.from(key)); return false; },
    };
    const first = new MasterKeyManager(stateDir, false, ops).getMasterKey();
    const file = fs.readFileSync(path.join(stateDir, 'machine', 'secrets-master.key'), 'utf-8').trim();
    expect(file).toBe(first.toString('hex'));
    expect([...slots.values()].map((k) => k.toString('hex'))).toEqual([file]);
    const reloaded = new MasterKeyManager(stateDir, false, ops);
    expect(reloaded.getMasterKey().equals(first)).toBe(true);
    const candidates = reloaded.getCandidateKeys();
    expect(candidates).toHaveLength(1);
    expect(candidates[0].key.equals(first)).toBe(true);
  } finally {
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/mac-keychain-write.test.ts' });
  }
});

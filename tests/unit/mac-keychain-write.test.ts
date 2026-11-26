import type { execFileSync } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { writeMacKeychainKey } from '../../src/core/macKeychainWrite.js';

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

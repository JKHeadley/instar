import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writePrivatePasteFile } from '../../src/core/SessionManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

// Long session notifications are written where only this user can read or plant them.
describe('writePrivatePasteFile', () => {
  let base: string;
  beforeEach(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-base-')); });
  afterEach(() => { SafeFsExecutor.safeRmSync(base, { recursive: true, force: true, operation: 'tests/unit/private-paste-file.test.ts' }); });
  const dirFor = () => path.join(base, `instar-${process.getuid?.() ?? 'user'}-paste`);

  it('creates a 0700 folder owned by this user and writes a 0600 file there', () => {
    const p = writePrivatePasteFile('hello', base)!;
    expect(p).toBeTruthy();
    expect(path.dirname(p)).toBe(dirFor());
    expect(fs.statSync(dirFor()).mode & 0o777).toBe(0o700);
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(p, 'utf-8')).toBe('hello');
  });

  it('refuses a folder that is a symlink (planted by someone else)', () => {
    const elsewhere = fs.mkdtempSync(path.join(base, 'elsewhere-'));
    fs.symlinkSync(elsewhere, dirFor());
    expect(writePrivatePasteFile('x', base)).toBeNull();
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it('refuses a folder others can read or write', () => {
    fs.mkdirSync(dirFor(), { mode: 0o777 });
    fs.chmodSync(dirFor(), 0o777);
    expect(writePrivatePasteFile('x', base)).toBeNull();
  });
});

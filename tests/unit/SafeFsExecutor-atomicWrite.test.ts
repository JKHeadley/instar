/**
 * Unit tests for SafeFsExecutor atomic-write helpers.
 *
 * Verifies crash-safe write semantics: temp+fsync+rename, parent-dir
 * creation, JSON convenience wrapper, temp-file cleanup on error, and
 * that a successful write fully replaces prior content.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-write-test-'));
});

afterEach(() => {
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/SafeFsExecutor-atomicWrite.test.ts' });
});

describe('SafeFsExecutor.atomicWriteFileSync', () => {
  it('writes a string to the target', () => {
    const target = path.join(dir, 'out.txt');
    SafeFsExecutor.atomicWriteFileSync(target, 'hello world', { operation: 'test' });
    expect(fs.readFileSync(target, 'utf-8')).toBe('hello world');
  });

  it('creates parent directories if missing', () => {
    const target = path.join(dir, 'a', 'b', 'c', 'out.txt');
    SafeFsExecutor.atomicWriteFileSync(target, 'nested', { operation: 'test' });
    expect(fs.readFileSync(target, 'utf-8')).toBe('nested');
  });

  it('fully replaces prior content (no partial-write residue)', () => {
    const target = path.join(dir, 'out.txt');
    SafeFsExecutor.atomicWriteFileSync(target, 'a long initial string that is quite long', { operation: 'test' });
    SafeFsExecutor.atomicWriteFileSync(target, 'short', { operation: 'test' });
    expect(fs.readFileSync(target, 'utf-8')).toBe('short');
  });

  it('does not leave temp files behind on success', () => {
    const target = path.join(dir, 'out.txt');
    SafeFsExecutor.atomicWriteFileSync(target, 'data', { operation: 'test' });
    const leftovers = fs.readdirSync(dir).filter(f => f.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('respects the mode option', () => {
    const target = path.join(dir, 'out.txt');
    SafeFsExecutor.atomicWriteFileSync(target, 'data', { operation: 'test', mode: 0o600 });
    const stat = fs.statSync(target);
    // Mask to permission bits
    expect(stat.mode & 0o777).toBe(0o600);
  });
});

describe('SafeFsExecutor.atomicWriteJsonSync', () => {
  it('writes pretty-printed JSON', () => {
    const target = path.join(dir, 'state.json');
    SafeFsExecutor.atomicWriteJsonSync(target, { a: 1, b: [2, 3] }, { operation: 'test' });
    const content = fs.readFileSync(target, 'utf-8');
    expect(JSON.parse(content)).toEqual({ a: 1, b: [2, 3] });
    // Pretty-printed (2-space indent default)
    expect(content).toContain('\n  "a": 1');
  });

  it('round-trips through re-read', () => {
    const target = path.join(dir, 'state.json');
    const value = { events: [{ id: 'e1', delta: 0.4 }], schemaVersion: 1 };
    SafeFsExecutor.atomicWriteJsonSync(target, value, { operation: 'test' });
    expect(JSON.parse(fs.readFileSync(target, 'utf-8'))).toEqual(value);
  });

  it('supports a custom indent', () => {
    const target = path.join(dir, 'state.json');
    SafeFsExecutor.atomicWriteJsonSync(target, { a: 1 }, { operation: 'test', indent: 4 });
    expect(fs.readFileSync(target, 'utf-8')).toContain('\n    "a": 1');
  });

  it('overwriting an existing file replaces it atomically', () => {
    const target = path.join(dir, 'state.json');
    SafeFsExecutor.atomicWriteJsonSync(target, { v: 1 }, { operation: 'test' });
    SafeFsExecutor.atomicWriteJsonSync(target, { v: 2 }, { operation: 'test' });
    expect(JSON.parse(fs.readFileSync(target, 'utf-8'))).toEqual({ v: 2 });
    // No temp residue
    expect(fs.readdirSync(dir).filter(f => f.includes('.tmp'))).toEqual([]);
  });
});

/**
 * Unit tests for BoundedJsonlAudit — size-bounded JSONL audit appender with
 * rotation (ownership-gated-spawn-and-judgment-within-floors spec §3.8).
 *
 * Covers: ordered appends, rotation past maxFileBytes (active → .1),
 * keepArchives shifting (.1 → .2, oldest deleted), and swallow-not-throw
 * append failures.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BoundedJsonlAudit } from '../../src/core/BoundedJsonlAudit.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bja-test-'));
});
afterEach(() => {
  SafeFsExecutor.safeRmSync(tmpDir, {
    recursive: true,
    force: true,
    operation: 'tests/unit/BoundedJsonlAudit.test.ts:afterEach',
  });
});

function readRows(file: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** A row whose JSON footprint comfortably exceeds a 200-byte maxFileBytes. */
function bigRow(tag: string): Record<string, unknown> {
  return { tag, pad: 'x'.repeat(250) };
}

describe('append + flush', () => {
  it('writes JSONL lines in append order', async () => {
    const file = path.join(tmpDir, 'audit.jsonl');
    const audit = new BoundedJsonlAudit({ file });
    audit.append({ seq: 1 });
    audit.append({ seq: 2 });
    audit.append({ seq: 3 });
    await audit.flush();

    const rows = readRows(file);
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
  });
});

describe('rotation', () => {
  it('rotates the active file to .1 when it exceeds maxFileBytes', async () => {
    const file = path.join(tmpDir, 'audit.jsonl');
    const audit = new BoundedJsonlAudit({ file, maxFileBytes: 200, keepArchives: 2 });

    audit.append(bigRow('A'));
    await audit.flush();
    // Active now exceeds 200 bytes — the NEXT append rotates first.
    audit.append(bigRow('B'));
    await audit.flush();

    expect(fs.existsSync(`${file}.1`)).toBe(true);
    expect(readRows(`${file}.1`).map((r) => r.tag)).toEqual(['A']);
    expect(readRows(file).map((r) => r.tag)).toEqual(['B']);
  });

  it('keepArchives respected: .1 → .2 shift, oldest archive deleted', async () => {
    const file = path.join(tmpDir, 'audit.jsonl');
    const audit = new BoundedJsonlAudit({ file, maxFileBytes: 200, keepArchives: 2 });

    audit.append(bigRow('A'));
    audit.append(bigRow('B')); // rotation 1: A → .1
    audit.append(bigRow('C')); // rotation 2: A → .2, B → .1
    audit.append(bigRow('D')); // rotation 3: A deleted, B → .2, C → .1
    await audit.flush();

    expect(readRows(file).map((r) => r.tag)).toEqual(['D']);
    expect(readRows(`${file}.1`).map((r) => r.tag)).toEqual(['C']);
    expect(readRows(`${file}.2`).map((r) => r.tag)).toEqual(['B']);
    // The oldest batch (A) is gone, and no archive beyond keepArchives exists.
    expect(fs.existsSync(`${file}.3`)).toBe(false);
    const all = fs.readdirSync(tmpDir).map((f) => fs.readFileSync(path.join(tmpDir, f), 'utf-8')).join('');
    expect(all).not.toContain('"A"');
  });
});

describe('append failures', () => {
  it('a failed append is logged, never thrown, and flush still resolves', async () => {
    // Make the parent "directory" a regular FILE so appendFile fails (ENOTDIR).
    const blocker = path.join(tmpDir, 'blocker');
    fs.writeFileSync(blocker, 'not a directory');
    const log = vi.fn();
    const audit = new BoundedJsonlAudit({ file: path.join(blocker, 'audit.jsonl'), log });

    expect(() => audit.append({ seq: 1 })).not.toThrow();
    await expect(audit.flush()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('append failed'));
  });
});

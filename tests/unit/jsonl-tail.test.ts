// safe-git-allow: test-tmpdir-cleanup — afterEach() removes this test's own
// os.tmpdir() scratch directory (created via fs.mkdtempSync). A unit test
// pulling in SafeFsExecutor just to delete its own jailed tmpdir is worse noise
// than this scoped per-file allow (mirrors the destructive-lint allowlist note).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readJsonlTailLines, readJsonlTailLastLines, DEFAULT_TAIL_BYTES } from '../../src/utils/jsonl-tail.js';

describe('jsonl-tail bounded reader', () => {
  let tmpDir: string;
  let file: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-tail-'));
    file = path.join(tmpDir, 'log.jsonl');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeLines(n: number, prefix = 'line'): void {
    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push(JSON.stringify({ i, t: `${prefix}-${i}` }));
    fs.writeFileSync(file, out.join('\n') + '\n');
  }

  it('returns empty for a missing file', () => {
    const r = readJsonlTailLines(path.join(tmpDir, 'nope.jsonl'));
    expect(r.lines).toEqual([]);
    expect(r.truncated).toBe(false);
  });

  it('returns empty for an empty file', () => {
    fs.writeFileSync(file, '');
    const r = readJsonlTailLines(file);
    expect(r.lines).toEqual([]);
  });

  it('returns all lines (file order) when the file fits the window', () => {
    writeLines(5);
    const r = readJsonlTailLines(file);
    expect(r.lines).toHaveLength(5);
    expect(r.truncated).toBe(false);
    expect(JSON.parse(r.lines[0]).i).toBe(0);
    expect(JSON.parse(r.lines[4]).i).toBe(4);
  });

  it('reads only the TAIL window of a large file — never the whole file', () => {
    // 50,000 lines of ~30 bytes = ~1.5MB. With a tiny 4KB window we must read
    // only a small suffix, not all 50k lines.
    writeLines(50_000);
    const fileSize = fs.statSync(file).size;
    expect(fileSize).toBeGreaterThan(1_000_000);

    const r = readJsonlTailLines(file, 4096);
    expect(r.truncated).toBe(true);
    // Far fewer than 50k lines were returned (only the ~4KB suffix).
    expect(r.lines.length).toBeLessThan(500);
    expect(r.lines.length).toBeGreaterThan(0);
    // The LAST line of the file is present and is the newest record.
    const last = JSON.parse(r.lines[r.lines.length - 1]);
    expect(last.i).toBe(49_999);
  });

  it('drops the partial first line when the window starts mid-record', () => {
    // Force a mid-record cut: write lines, then read a window that lands
    // partway through some earlier line. Every returned line must parse.
    writeLines(10_000);
    const r = readJsonlTailLines(file, 2048);
    expect(r.truncated).toBe(true);
    for (const ln of r.lines) {
      expect(() => JSON.parse(ln)).not.toThrow();
    }
  });

  it('readJsonlTailLastLines returns at most `limit` newest lines', () => {
    writeLines(1000);
    const last50 = readJsonlTailLastLines(file, 50);
    expect(last50).toHaveLength(50);
    expect(JSON.parse(last50[0]).i).toBe(950);
    expect(JSON.parse(last50[49]).i).toBe(999);
  });

  it('readJsonlTailLastLines returns all lines when limit exceeds count', () => {
    writeLines(7);
    const got = readJsonlTailLastLines(file, 100);
    expect(got).toHaveLength(7);
  });

  it('skips blank lines', () => {
    fs.writeFileSync(file, '{"i":0}\n\n{"i":1}\n\n');
    const r = readJsonlTailLines(file);
    expect(r.lines).toEqual(['{"i":0}', '{"i":1}']);
  });

  it('DEFAULT_TAIL_BYTES is a small bounded window (well under typical large logs)', () => {
    expect(DEFAULT_TAIL_BYTES).toBeLessThanOrEqual(1024 * 1024);
    expect(DEFAULT_TAIL_BYTES).toBeGreaterThan(0);
  });
});

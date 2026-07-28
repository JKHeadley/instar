// safe-git-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
/**
 * Bounded Accumulation standard §3.5 — segment rotation must be event-loop-safe
 * (rename, never read-filter-rewrite) and must bound the active file on disk.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { maybeRotateJsonlSegment } from '../../src/utils/jsonl-rotation.js';
import { JsonlStore } from '../../src/core/storage/JsonlStore.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-acc-'));
  file = path.join(dir, 'log.jsonl');
});
afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** List rotated segments "<base>.<seq>" for the active file, sorted by seq. */
function segments(): string[] {
  const base = path.basename(file);
  const re = new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.(\\d+)$');
  return fs.readdirSync(dir).filter((f) => re.test(f)).sort((a, b) => {
    return parseInt(a.match(re)![1], 10) - parseInt(b.match(re)![1], 10);
  });
}

describe('maybeRotateJsonlSegment', () => {
  it('returns false when the file is under maxBytes', () => {
    fs.writeFileSync(file, 'a\nb\n');
    expect(maybeRotateJsonlSegment(file, { maxBytes: 1024 })).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe('a\nb\n');
    expect(segments()).toEqual([]);
  });

  it('never throws and returns false when the file does not exist', () => {
    expect(() => maybeRotateJsonlSegment(path.join(dir, 'missing.jsonl'))).not.toThrow();
    expect(maybeRotateJsonlSegment(path.join(dir, 'missing.jsonl'))).toBe(false);
  });

  it('cuts a segment by RENAME (active content preserved intact, active reset empty)', () => {
    const body = Array.from({ length: 50 }, (_, i) => `line-${i}`).join('\n') + '\n';
    fs.writeFileSync(file, body);
    const rotated = maybeRotateJsonlSegment(file, { maxBytes: 10, keepSegments: 4 });
    expect(rotated).toBe(true);
    // active is fresh + empty (no rewrite of a kept tail)
    expect(fs.readFileSync(file, 'utf8')).toBe('');
    // the FULL prior content is preserved verbatim in segment .1 (rename, not filter)
    expect(segments()).toEqual(['log.jsonl.1']);
    expect(fs.readFileSync(path.join(dir, 'log.jsonl.1'), 'utf8')).toBe(body);
  });

  it('prunes oldest segments beyond keepSegments (monotonic seq)', () => {
    // Force 6 rotations; keepSegments=2 → only the 2 newest segments survive.
    for (let r = 1; r <= 6; r++) {
      fs.writeFileSync(file, `payload-round-${r}\n`.repeat(20));
      maybeRotateJsonlSegment(file, { maxBytes: 10, keepSegments: 2 });
    }
    const segs = segments();
    expect(segs).toEqual(['log.jsonl.5', 'log.jsonl.6']); // .1–.4 pruned
  });

  it('archive mode NEVER prunes — every segment is retained (compliance hold)', () => {
    for (let r = 1; r <= 6; r++) {
      fs.writeFileSync(file, `audit-${r}\n`.repeat(20));
      maybeRotateJsonlSegment(file, { maxBytes: 10, keepSegments: 2, archive: true });
    }
    expect(segments().length).toBe(6); // none dropped despite keepSegments=2
  });
});

describe('JsonlStore (the registered accessor)', () => {
  it('amortizes the size-check — does not rotate until checkEveryBytes appended', () => {
    const store = new JsonlStore(file, { maxBytes: 10, checkEveryBytes: 10_000 });
    // Append well past maxBytes but under checkEveryBytes → no rotation yet.
    for (let i = 0; i < 20; i++) store.appendObject({ i });
    expect(segments()).toEqual([]); // check not yet triggered
    expect(fs.statSync(file).size).toBeGreaterThan(10);
  });

  it('eventually rotates and BOUNDS the active file on disk under a flood', () => {
    const ceiling = 4 * 1024; // 4KB active ceiling
    const store = new JsonlStore(file, { maxBytes: ceiling, keepSegments: 2, checkEveryBytes: 512 });
    for (let i = 0; i < 5000; i++) store.appendObject({ i, pad: 'x'.repeat(40) });
    // active file stays bounded (ceiling + at most one check-interval of slack)
    const activeSize = fs.statSync(file).size;
    expect(activeSize).toBeLessThanOrEqual(ceiling + 512 + 1024);
    // retained data is non-empty (retention didn't nuke everything)
    expect(segments().length).toBeGreaterThan(0);
  });
});

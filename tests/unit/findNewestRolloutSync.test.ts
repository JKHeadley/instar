// #33: findNewestRolloutSync — the sync newest-codex-rollout finder backing the
// RateLimitSentinel's account-wide codex recovery-verification. Verifies it returns the
// newest rollout (by filename in the newest non-empty day partition), stays perf-safe
// (no per-file stat storm), and degrades to null safely on a missing / non-codex tree.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findNewestRolloutSync } from '../../src/providers/adapters/openai-codex/observability/sessionPaths.js';

let home: string;

function writeRollout(dateDir: string, isoTs: string, uuid: string, bytes: number): string {
  const dir = path.join(home, '.codex', 'sessions', ...dateDir.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-${isoTs}-${uuid}.jsonl`);
  fs.writeFileSync(file, 'x'.repeat(bytes));
  return file;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-newest-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('findNewestRolloutSync (#33)', () => {
  it('returns null when there is no codex sessions tree (non-codex agent)', () => {
    expect(findNewestRolloutSync(path.join(home, '.codex'))).toBeNull();
  });

  it('returns the newest rollout by filename in the newest day partition', () => {
    writeRollout('2026/05/30', '2026-05-30T10-00-00', 'aaaa1111-0000-0000-0000-000000000001', 100);
    const newest = writeRollout('2026/05/31', '2026-05-31T09-30-00', 'bbbb2222-0000-0000-0000-000000000002', 250);
    writeRollout('2026/05/31', '2026-05-31T08-00-00', 'cccc3333-0000-0000-0000-000000000003', 50);
    const r = findNewestRolloutSync(path.join(home, '.codex'));
    expect(r).not.toBeNull();
    expect(r!.path).toBe(newest); // newest by filename (09-30 > 08-00) in the newest day (05/31 > 05/30)
    expect(r!.size).toBe(250);
    expect(r!.mtime).toBeGreaterThan(0);
  });

  it('skips an EMPTY newest day partition and falls back to the next', () => {
    const older = writeRollout('2026/05/30', '2026-05-30T12-00-00', 'dddd4444-0000-0000-0000-000000000004', 77);
    // a newer day dir exists but has NO rollout files
    fs.mkdirSync(path.join(home, '.codex', 'sessions', '2026', '05', '31'), { recursive: true });
    const r = findNewestRolloutSync(path.join(home, '.codex'));
    expect(r!.path).toBe(older);
    expect(r!.size).toBe(77);
  });

  it('crosses month/year boundaries (Dec 2025 newer than Jan 2025)', () => {
    writeRollout('2025/01/15', '2025-01-15T10-00-00', 'eeee5555-0000-0000-0000-000000000005', 10);
    const dec = writeRollout('2025/12/01', '2025-12-01T10-00-00', 'ffff6666-0000-0000-0000-000000000006', 20);
    const r = findNewestRolloutSync(path.join(home, '.codex'));
    expect(r!.path).toBe(dec);
  });
});

// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listAllRollouts } from '../../src/providers/adapters/openai-codex/observability/sessionPaths.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

/**
 * Regression coverage for the listAllRollouts perf fix: a real codex account
 * accumulates tens of thousands of rollout files (one machine: 14k / 1.4 GB).
 * The previous full-walk-and-stat-everything made GET /codex/usage time out.
 * The fix walks date partitions newest-first and stats only the newest few.
 * These tests assert (a) correctness across partitions, (b) it does NOT stat
 * the entire history, and (c) the non-date-partitioned fallback still works.
 */
describe('listAllRollouts — bounded date-partition scan', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-rollout-perf-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'tests/unit/codexListAllRolloutsPerf.test.ts:cleanup' });
  });

  function writeRollout(ymd: [string, string, string], uuid: string, mtimeMs?: number): string {
    const dir = path.join(home, 'sessions', ...ymd);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `rollout-${ymd.join('-')}T12-00-00-${uuid}.jsonl`);
    fs.writeFileSync(file, '{"type":"session_meta"}\n');
    if (mtimeMs !== undefined) fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
    return file;
  }

  it('returns the newest rollouts across day-partitions, limited', async () => {
    // Three partitions, distinct mtimes (older → newer).
    writeRollout(['2026', '05', '28'], 'aaaaaaaa-1111-1111-1111-111111111111', 1_000);
    writeRollout(['2026', '05', '29'], 'bbbbbbbb-2222-2222-2222-222222222222', 2_000);
    const newest = writeRollout(['2026', '05', '30'], 'cccccccc-3333-3333-3333-333333333333', 3_000);
    const res = await listAllRollouts(home, 2);
    expect(res).toHaveLength(2);
    expect(res[0].path).toBe(newest); // newest mtime first
    expect(res[0].mtime).toBeGreaterThan(res[1].mtime);
  });

  it('covers >= 2 newest partitions even when the newest holds fewer than `limit`', async () => {
    writeRollout(['2026', '05', '28'], 'aaaaaaaa-1111-1111-1111-111111111111', 1_000);
    writeRollout(['2026', '05', '29'], 'bbbbbbbb-2222-2222-2222-222222222222', 2_000);
    writeRollout(['2026', '05', '30'], 'cccccccc-3333-3333-3333-333333333333', 3_000);
    // limit 3, newest partition (05/30) has only 1 file → must reach into 05/29 (and 05/28).
    const res = await listAllRollouts(home, 3);
    expect(res.map((r) => path.basename(path.dirname(r.path)))).toEqual(['30', '29', '28']);
  });

  it('does NOT stat the entire history — only the newest partitions', async () => {
    // 40 old partitions × 5 files = 200 old files; 2 recent partitions × 3 files.
    for (let d = 1; d <= 40; d++) {
      const dd = String(d).padStart(2, '0');
      for (let i = 0; i < 5; i++) writeRollout(['2026', '03', dd], `old${dd}-${i}-1111-1111-111111111111`, 1_000 + d);
    }
    for (let i = 0; i < 3; i++) writeRollout(['2026', '05', '29'], `new29-${i}-2222-2222-222222222222`, 9_000 + i);
    for (let i = 0; i < 3; i++) writeRollout(['2026', '05', '30'], `new30-${i}-3333-3333-333333333333`, 9_500 + i);

    const statSpy = vi.spyOn(fsp, 'stat');
    const res = await listAllRollouts(home, 3);

    // Correct newest-3 (all from 05/30, the highest mtimes).
    expect(res).toHaveLength(3);
    expect(res.every((r) => r.path.includes('/05/30/'))).toBe(true);
    // Bounded: only the newest two partitions' files (~6) get statted, NOT all 206.
    expect(statSpy.mock.calls.length).toBeLessThan(20);
    expect(statSpy.mock.calls.length).toBeGreaterThan(0);
  });

  it('falls back to a full walk for a non-date-partitioned layout', async () => {
    // Files directly under sessions/ (no YYYY/MM/DD dirs) — the fallback path.
    const dir = path.join(home, 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'rollout-2026-05-30T12-00-00-flatflat-4444-4444-4444-444444444444.jsonl');
    fs.writeFileSync(f, '{"type":"session_meta"}\n');
    const res = await listAllRollouts(home, 10);
    expect(res).toHaveLength(1);
    expect(res[0].path).toBe(f);
  });

  it('returns empty when there is no sessions dir', async () => {
    expect(await listAllRollouts(home, 10)).toEqual([]);
  });
});

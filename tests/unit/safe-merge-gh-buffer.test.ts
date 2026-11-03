/**
 * safe-merge.mjs gh output ceiling: a large PR's file list (every file's patch,
 * paginated and slurped) is bigger than Node's 1 MiB spawnSync default. Before
 * the fix gh died with ENOBUFS and the merge was refused as contexts-unverifiable
 * (PR #2364: 94 files, 1.6 MB diff). These tests run a REAL child process that
 * writes more than 1 MiB, through safe-merge's own gh() and spawn options.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { gh, GH_MAX_BUFFER, GH_SPAWN_OPTIONS } from '../../scripts/safe-merge.mjs';

const BIG = 3 * 1024 * 1024; // 3 MiB, well past the 1 MiB default
const EMIT = ['-e', `process.stdout.write('x'.repeat(${BIG}))`];

/** Stands in for `gh`: same options safe-merge passes, but runs node to emit BIG bytes. */
const nodeAsGh = (_cmd: string, _args: string[], opts: object) => spawnSync(process.execPath, EMIT, opts);

describe('safe-merge gh output ceiling', () => {
  it('the default spawnSync buffer really does overflow on this output (the bug)', () => {
    const r = spawnSync(process.execPath, EMIT, { encoding: 'utf-8' });
    expect((r.error as NodeJS.ErrnoException | undefined)?.code).toBe('ENOBUFS');
  });

  it('gh() returns >1 MiB of stdout without throwing', () => {
    const r = gh(['api', 'repos/x/y/pulls/1/files'], { spawn: nodeAsGh });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(0);
    expect(r.stdout.length).toBe(BIG);
  });

  it('a spawn error still throws (the fix does not swallow real failures)', () => {
    const missing = (_c: string, a: string[], o: object) => spawnSync('definitely-not-a-binary-xyz', a, o);
    expect(() => gh(['api', 'x'], { spawn: missing })).toThrow(/gh spawn failed/);
  });

  it('the ceiling is generous and every gh spawn in the script uses it', () => {
    expect(GH_MAX_BUFFER).toBeGreaterThanOrEqual(256 * 1024 * 1024);
    expect(GH_SPAWN_OPTIONS.maxBuffer).toBe(GH_MAX_BUFFER);
    const src = readFileSync(new URL('../../scripts/safe-merge.mjs', import.meta.url), 'utf-8');
    const ghSpawns = src.match(/spawn(?:Sync)?\('gh',[^)]*\)/g) ?? [];
    expect(ghSpawns.length).toBeGreaterThanOrEqual(3);
    for (const call of ghSpawns) expect(call).toContain('GH_SPAWN_OPTIONS');
  });
});

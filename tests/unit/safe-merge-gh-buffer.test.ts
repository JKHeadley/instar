/**
 * safe-merge's gh calls must not use Node's default 1 MiB output cap: for a large PR GitHub's
 * answer is bigger, spawnSync fails with ENOBUFS, and a green, authorized PR is refused
 * `contexts-unverifiable` (PR 2900 on 2026-11-08, PR 3053 on 2026-11-15).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { GH_MAX_BUFFER_BYTES } from '../../scripts/safe-merge.mjs';

const SRC = fs.readFileSync(path.join(__dirname, '../../scripts/safe-merge.mjs'), 'utf-8');

describe('safe-merge — gh output buffer', () => {
  it('the cap is far above the Node default and still bounded', () => {
    expect(GH_MAX_BUFFER_BYTES).toBeGreaterThanOrEqual(16 * 1024 * 1024);
    expect(GH_MAX_BUFFER_BYTES).toBeLessThanOrEqual(256 * 1024 * 1024);
  });

  it('every spawnSync of gh passes the cap (a new gh call without it reintroduces the refusal)', () => {
    const calls = SRC.split('\n').filter((l) => /spawnSync\(\s*'gh'/.test(l));
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const l of calls) expect(l, l.trim()).toContain('maxBuffer: GH_MAX_BUFFER_BYTES');
  });

  it('the failure this prevents is real: 2 MiB of output overflows the default cap and fits under the new one', () => {
    const big = ['-e', 'process.stdout.write("x".repeat(2 * 1024 * 1024))'];
    const dflt = spawnSync(process.execPath, big, { encoding: 'utf-8' });
    expect((dflt.error as NodeJS.ErrnoException | undefined)?.code).toBe('ENOBUFS');
    const capped = spawnSync(process.execPath, big, { encoding: 'utf-8', maxBuffer: GH_MAX_BUFFER_BYTES });
    expect(capped.error).toBeUndefined();
    expect(capped.stdout.length).toBe(2 * 1024 * 1024);
  });
});

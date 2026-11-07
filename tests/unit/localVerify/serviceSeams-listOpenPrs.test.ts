/** The default open-PR list must only ever claim a COMPLETE list, or callers misread absence as closed. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildDefaultServiceSeams } from '../../../src/localVerify/serviceSeams.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

describe('listOpenPrs default seam', () => {
  let bin: string;
  beforeEach(() => { bin = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-gh-')); });
  afterEach(() => { SafeFsExecutor.safeRmSync(bin, { recursive: true, force: true, operation: 'tests/unit/localVerify/serviceSeams-listOpenPrs.test.ts:cleanup' }); });

  const seamsWithGh = (body: string) => {
    fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return buildDefaultServiceSeams({ repo: 'o/r', resolveGitHubEnv: () => ({ ...process.env, PATH: `${bin}:${process.env.PATH}` }) });
  };

  it('returns the open PR numbers from one list call', async () => {
    const log = path.join(bin, 'args');
    const seams = seamsWithGh(`echo "$@" >> "${log}"\necho '[{"number":3},{"number":7}]'`);
    expect([...(await seams.listOpenPrs!())!].sort()).toEqual([3, 7]);
    const calls = fs.readFileSync(log, 'utf-8').trim().split('\n');
    expect(calls).toHaveLength(1);
    // Without --limit, gh stops at 30 rows and every later open PR would read as closed.
    expect(calls[0]).toContain('pr list --repo o/r --state open --limit 1000 --json number');
  });

  it('returns an empty set when nothing is open: a complete answer, not a failure', async () => {
    expect((await seamsWithGh(`echo '[]'`).listOpenPrs!())!.size).toBe(0);
  });

  it('refuses a full page, which may be cut short', async () => {
    const rows = Array.from({ length: 1000 }, (_, n) => ({ number: n + 1 }));
    const file = path.join(bin, 'rows.json');
    fs.writeFileSync(file, JSON.stringify(rows));
    expect(await seamsWithGh(`cat "${file}"`).listOpenPrs!()).toBeNull();
  });

  it.each([['a failed call', 'exit 1'], ['unparseable output', 'echo nope'], ['a non-list answer', `echo '{"number":1}'`], ['a row without a number', `echo '[{"title":"x"}]'`]])(
    'returns null for %s', async (_label, body) => {
      expect(await seamsWithGh(body).listOpenPrs!()).toBeNull();
    });

  it('returns null when no GitHub environment is available', async () => {
    const seams = buildDefaultServiceSeams({ repo: 'o/r', resolveGitHubEnv: () => null });
    expect(await seams.listOpenPrs!()).toBeNull();
  });
});

/**
 * Rule 119 at the merge funnel: the real script as a process, with a fake `gh`.
 * A PR touching the registry stops until its body names a real counterpart or a
 * stated none; a PR touching neither book is not affected.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const SCRIPT = path.resolve('scripts/safe-merge.mjs');
const HEAD = 'a'.repeat(40);

describe('safe-merge — constitution counterpart', () => {
  let dir: string;
  let log: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-merge-pairing-'));
    log = path.join(dir, 'gh-calls.log');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/safe-merge-constitution-counterpart.test.ts' });
  });

  function run(body: string, files: string[], { counterpartFails = false } = {}) {
    const q = (o: unknown) => JSON.stringify(o);
    const view = q({ state: 'OPEN', mergedAt: null, headRefOid: HEAD, baseRefName: 'main', reviewDecision: '', isDraft: false, author: { login: 'EchoOfDawn' }, isCrossRepository: false });
    const script = `#!/bin/sh
echo "$*" >> "${log}"
case "$*" in
  "pr view"*) echo '${view}' ;;
  "pr checks"*) echo '[]' ;;
  "api --paginate --slurp repos/JKHeadley/instar-2/pulls/190/files"*) echo '[[{"filename":"docs/01-the-rules.md"}]]' ;;
  "api --paginate --slurp repos/JKHeadley/instar/pulls/"*"/files"*) echo '[${q(files.map((filename) => ({ filename })))}]' ;;
  "api repos/JKHeadley/instar-2/pulls/190") ${counterpartFails ? 'echo down >&2; exit 1' : `echo '${q({ state: 'open', merged_at: null, base: { ref: 'main' }, body: '' })}'`} ;;
  "api repos/JKHeadley/instar/pulls/"*) cat "${dir}/pr.json" ;;
  *) echo '[]' ;;
esac
`;
    fs.writeFileSync(path.join(dir, 'pr.json'), q({ state: 'open', merged_at: null, base: { ref: 'main' }, body }));
    fs.writeFileSync(path.join(dir, 'gh'), script, { mode: 0o755 });
    const r = spawnSync(process.execPath, [SCRIPT, '2700', '--auto', '--squash', '--repo', 'JKHeadley/instar', '--deadline-ms', '1000'], {
      encoding: 'utf-8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      timeout: 30_000,
    });
    const line = (r.stdout ?? '').split('\n').filter((l) => l.startsWith('safe-merge-result: ')).pop() ?? '';
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf-8') : '';
    return { r, calls, result: line ? JSON.parse(line.slice('safe-merge-result: '.length)) : null };
  }

  it('a registry change with no line is refused, says how to clear it, and never merges', () => {
    const { r, result, calls } = run('A change.', ['docs/STANDARDS-REGISTRY.md']);
    expect(r.status).toBe(1);
    expect(result.result).toBe('refused:constitution-counterpart');
    expect(r.stderr).toContain('Constitution counterpart:');
    expect(calls).not.toContain('pr merge');
  });

  it('a named counterpart that is real gets past this check', () => {
    const { result } = run('Constitution counterpart: JKHeadley/instar-2#190', ['docs/STANDARDS-REGISTRY.md']);
    expect(result?.result).not.toBe('refused:constitution-counterpart');
  });

  it('a counterpart that cannot be read refuses as unknown, never passes', () => {
    const { result, calls } = run('Constitution counterpart: JKHeadley/instar-2#190', ['docs/STANDARDS-REGISTRY.md'], { counterpartFails: true });
    expect(result.result).toBe('refused:constitution-counterpart');
    expect(result.state).toBe('unknown');
    expect(calls).not.toContain('pr merge');
  });

  it('a stated none gets past this check', () => {
    const { result } = run('Constitution counterpart: none: a code path moved', ['docs/STANDARDS-REGISTRY.md']);
    expect(result?.result).not.toBe('refused:constitution-counterpart');
  });

  it('a PR touching no book is not affected', () => {
    const { result } = run('A change.', ['src/a.ts']);
    expect(result?.result).not.toBe('refused:constitution-counterpart');
  });
});

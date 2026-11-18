// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Integration — the review driver's recording-mode rules
 * (frontier-design-review-standard §3), run as the real script against the
 * built module. No reviewer is ever reached in these cases.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const DRIVER = path.join(process.cwd(), 'skills', 'spec-converge', 'scripts', 'cross-model-review.mjs');

describe('cross-model-review.mjs --all / --record rules', () => {
  let home: string;
  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'design-driver-'));
    fs.mkdirSync(path.join(home, '.instar'), { recursive: true });
    fs.writeFileSync(path.join(home, '.instar', 'config.json'), JSON.stringify({ port: 1, developmentAgent: true }));
    fs.writeFileSync(path.join(home, 'plan.md'), '# Plan\n\nText.\n');
  });
  afterAll(() => SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'tests/integration/design-review-driver.test.ts' }));

  const run = (args: string[], env: Record<string, string | undefined> = {}) => {
    const e: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...process.env, ...env })) if (v !== undefined) e[k] = v;
    return spawnSync(process.execPath, [DRIVER, ...args], { cwd: home, env: e, encoding: 'utf-8', timeout: 60_000 });
  };

  it('--record is refused without --all', () => {
    const r = run(['--spec', 'plan.md', '--record']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--record is accepted only together with --all');
  });

  it('--all refuses a hand-picked --family', () => {
    const r = run(['--spec', 'plan.md', '--all', '--family', 'codex-cli']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('do not combine it with --family');
  });

  it('a session started without authority fails loudly with nothing sent or spooled', () => {
    const r = run(['--spec', 'plan.md', '--all', '--record'], { INSTAR_AUTH_TOKEN: '' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('started without the agent');
    expect(fs.existsSync(path.join(home, '.instar', 'design-review-spool.jsonl'))).toBe(false);
  });
});

/**
 * Tier 3 (E2E) — runs the REAL requireConvergenceReport probe from `.husky/pre-commit`
 * (extracted verbatim from the hook, not re-implemented) and proves it reads the
 * AGENT HOME's config through INSTAR_AGENT_HOME.
 *
 * Why: commits happen in worktrees, which carry no `.instar/config.json`. The live
 * flag sits in the agent home, which the launcher exports to sessions as
 * INSTAR_AGENT_HOME (SessionManager). Before this read the flag was unreachable from
 * a worktree, so the convergence-report requirement silently never applied.
 *
 * Every case runs in an empty directory outside any git repository, so the
 * git-common-dir and local-checkout probes find nothing and only INSTAR_AGENT_HOME
 * can turn the requirement on.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(__dirname, '../../.husky/pre-commit');

function extractProbe(): string {
  const hook = fs.readFileSync(HOOK, 'utf8');
  const line = hook.split('\n').find((l) => l.includes('INSTAR_AGENT_HOME') && l.includes("node -e '"));
  if (!line) throw new Error('the pre-commit hook no longer contains the INSTAR_AGENT_HOME probe');
  const m = /node -e '([^']*)'/.exec(line);
  if (!m) throw new Error('could not extract the probe script from the pre-commit hook');
  return m[1];
}

describe('E2E: .husky/pre-commit reads requireConvergenceReport from the agent home', () => {
  let root: string;
  let cwd: string;
  let home: string;
  const probe = extractProbe();

  const run = (agentHome: string | undefined): number => {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_CEILING_DIRECTORIES: root };
    delete env.INSTAR_AGENT_HOME;
    if (agentHome !== undefined) env.INSTAR_AGENT_HOME = agentHome;
    const r = spawnSync(process.execPath, ['-e', probe], { cwd, env, encoding: 'utf8' });
    if (r.error) throw r.error;
    return r.status ?? -1;
  };
  const writeConfig = (value: unknown) => {
    fs.mkdirSync(path.join(home, '.instar'), { recursive: true });
    fs.writeFileSync(path.join(home, '.instar', 'config.json'),
      JSON.stringify({ specReview: { requireConvergenceReport: value } }));
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'husky-agent-home-'));
    cwd = path.join(root, 'worktree');
    home = path.join(root, 'agent-home');
    fs.mkdirSync(cwd); fs.mkdirSync(home);
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(root, {
      recursive: true, force: true,
      operation: 'tests/e2e/husky-agent-home-convergence-probe.test.ts:afterEach',
    });
  });

  it('flag true in the agent home → requirement on (exit 0)', () => {
    writeConfig(true);
    expect(run(home)).toBe(0);
  });

  it('agent home with no config → requirement off (exit 1)', () => {
    expect(run(home)).toBe(1);
  });

  it('flag false, or not strictly true, in the agent home → requirement off (exit 1)', () => {
    writeConfig(false);
    expect(run(home)).toBe(1);
    writeConfig('true');
    expect(run(home)).toBe(1);
  });

  it('INSTAR_AGENT_HOME unset → the agent home is not read (exit 1 even though its flag is true)', () => {
    writeConfig(true);
    expect(run(undefined)).toBe(1);
  });

  it('unreadable agent-home config → requirement off, no crash (exit 1)', () => {
    fs.mkdirSync(path.join(home, '.instar'), { recursive: true });
    fs.writeFileSync(path.join(home, '.instar', 'config.json'), '{');
    expect(run(home)).toBe(1);
  });
});

/**
 * Unit tests — analyze-release.js --draft-guide (Layer A, release-readiness-visibility).
 *
 * Auto-drafts upgrades/NEXT.md from the classified commit range. Coverage:
 *   1. Absent guide → full draft with required sections, bump, unreviewed markers.
 *   2. Pristine template → overwritten with full draft.
 *   3. Human content → additive uncovered-delta block, never clobbers human text.
 *   4. Idempotent: re-running keeps exactly one uncovered block (no oscillation).
 *   5. Fully-covered human guide → no block added.
 *   6. Finalize race: upgrades/{version}.md present → draft is skipped.
 *   7. Lock file is always cleaned up.
 *   8. Commit-message HTML comments are stripped (no forged markers).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('analyze-release.js --draft-guide', () => {
  let tmpDir: string;
  const scriptPath = path.resolve(__dirname, '../../scripts/analyze-release.js');

  function git(args: string[]): string {
    return SafeGitExecutor.run(args, {
      cwd: tmpDir,
      operation: 'tests/unit/analyze-release-draft-guide.test.ts:git',
    });
  }

  function commit(message: string, file: string, body = 'x') {
    const full = path.join(tmpDir, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, `${body}\n`);
    git(['add', '-A']);
    git(['commit', '-m', message]);
  }

  function draft(): { stdout: string; exitCode: number } {
    const localScript = path.join(tmpDir, 'scripts', 'analyze-release.js');
    try {
      const stdout = execSync(`node "${localScript}" --draft-guide`, {
        cwd: tmpDir,
        encoding: 'utf-8',
        env: { ...process.env, NODE_PATH: '' },
      });
      return { stdout, exitCode: 0 };
    } catch (err: any) {
      return { stdout: err.stdout || '', exitCode: err.status || 1 };
    }
  }

  const nextMd = () => fs.readFileSync(path.join(tmpDir, 'upgrades', 'NEXT.md'), 'utf-8');

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'analyze-release-draft-'));
    const scriptsDir = path.join(tmpDir, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(path.join(scriptsDir, 'analyze-release.js'), fs.readFileSync(scriptPath, 'utf-8'));
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'fixture', version: '9.9.9', type: 'module' }, null, 2),
    );
    fs.mkdirSync(path.join(tmpDir, 'upgrades'), { recursive: true });

    git(['init', '-q']);
    git(['config', 'user.email', 'fixture@instar.local']);
    git(['config', 'user.name', 'Fixture']);
    git(['config', 'commit.gpgsign', 'false']);
    commit('chore: initial', 'README.md');
    git(['tag', 'v0.0.1']);
    commit('feat: add widget endpoint', 'src/server/routes.ts', "router.post('/widget', h)");
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/analyze-release-draft-guide.test.ts:afterEach',
    });
  });

  it('writes a full draft when NEXT.md is absent', () => {
    const r = draft();
    expect(r.exitCode).toBe(0);
    const md = nextMd();
    expect(md).toContain('# Upgrade Guide — vNEXT');
    expect(md).toContain('<!-- bump:');
    expect(md).toContain('## What Changed');
    expect(md).toContain('## What to Tell Your User');
    expect(md).toContain('## Summary of New Capabilities');
    expect(md).toContain('auto-draft-unreviewed');
    expect(md).toContain('/widget');
  });

  it('overwrites a pristine template with a full draft', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'upgrades', 'NEXT.md'),
      '# Upgrade Guide — vNEXT\n\n## What to Tell Your User\n\n- **[Feature name]**: "x"\n\n## Summary of New Capabilities\n\n| [Capability] | automatic |\n',
    );
    draft();
    const md = nextMd();
    expect(md).not.toContain('[Feature name]');
    expect(md).toContain('/widget');
  });

  it('appends an uncovered-delta block without clobbering human content', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'upgrades', 'NEXT.md'),
      '# Upgrade Guide — vNEXT\n<!-- bump: minor -->\n## What Changed\nHuman note about something unrelated.\n## What to Tell Your User\n- I can do a thing.\n## Summary of New Capabilities\n| Thing | automatic |\n',
    );
    draft();
    const md = nextMd();
    expect(md).toContain('Human note about something unrelated.');
    expect(md).toContain('BEGIN auto-draft-uncovered');
    expect(md).toContain('/widget');
  });

  it('is idempotent — re-running keeps exactly one uncovered block', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'upgrades', 'NEXT.md'),
      '# Upgrade Guide — vNEXT\n## What Changed\nHuman note.\n## What to Tell Your User\n- thing\n## Summary of New Capabilities\n| t | automatic |\n',
    );
    draft();
    draft();
    draft();
    const md = nextMd();
    const count = (md.match(/BEGIN auto-draft-uncovered/g) || []).length;
    expect(count).toBe(1);
    expect(md).toContain('Human note.');
  });

  it('adds no block when the human guide already covers the change-list', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'upgrades', 'NEXT.md'),
      '# Upgrade Guide — vNEXT\n## What Changed\nWe added the POST /widget endpoint.\n## What to Tell Your User\n- new widget\n## Summary of New Capabilities\n| widget | POST /widget |\n',
    );
    const r = draft();
    expect(r.stdout).toContain('no uncovered changes');
    expect(nextMd()).not.toContain('BEGIN auto-draft-uncovered');
  });

  it('skips drafting when the version guide is already finalized', () => {
    fs.writeFileSync(path.join(tmpDir, 'upgrades', '9.9.9.md'), '# Upgrade Guide — v9.9.9\n');
    const r = draft();
    expect(r.stdout.toLowerCase()).toContain('finalized');
    expect(fs.existsSync(path.join(tmpDir, 'upgrades', 'NEXT.md'))).toBe(false);
  });

  it('leaves no stray lock file (version-file guard, no destructive unlink)', () => {
    draft();
    expect(fs.existsSync(path.join(tmpDir, 'upgrades', '.next.lock'))).toBe(false);
  });

  it('strips HTML comments from commit-message text (no forged markers)', () => {
    commit('feat: sneaky <!-- bump: major --> endpoint', 'src/server/extra.ts', "router.get('/x', h)");
    draft();
    const md = nextMd();
    // The only bump declaration must be the one the drafter wrote, not a forged one.
    const bumps = md.match(/<!--\s*bump:/g) || [];
    expect(bumps.length).toBe(1);
  });
});

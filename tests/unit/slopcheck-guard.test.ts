/**
 * Unit tests for the slopcheck-guard PreToolUse hook.
 *
 * Materializes the hook from PostUpdateMigrator.getSlopcheckGuardHook(),
 * pipes Bash tool-call payloads, and asserts the nudge fires only for
 * unfamiliar packages on real install commands.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let projectDir: string;
let hookPath: string;

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slopcheck-test-'));
  const migrator = new PostUpdateMigrator(projectDir);
  hookPath = path.join(projectDir, 'slopcheck-guard.js');
  fs.writeFileSync(hookPath, migrator.getHookContent('slopcheck-guard'), { mode: 0o755 });
});

afterEach(() => {
  SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/slopcheck-guard.test.ts' });
});

function runHook(command: string): { decision?: string; additionalContext?: string } {
  const r = spawnSync('node', [hookPath], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
    encoding: 'utf-8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
  });
  if (!r.stdout.trim()) return {};
  try { return JSON.parse(r.stdout); } catch { return {}; }
}

function writePackageJson(deps: Record<string, string>) {
  fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({ name: 't', dependencies: deps }, null, 2));
}

describe('slopcheck-guard hook', () => {
  it('non-install Bash commands pass through silently', () => {
    expect(runHook('ls -la').additionalContext).toBeUndefined();
    expect(runHook('git status').additionalContext).toBeUndefined();
    expect(runHook('npm run build').additionalContext).toBeUndefined();
    expect(runHook('npm test').additionalContext).toBeUndefined();
  });

  it('npm install of an unfamiliar package fires the nudge', () => {
    writePackageJson({ express: '^4.0.0' });
    const dec = runHook('npm install left-pad-typosquat');
    expect(dec.decision).toBe('approve');
    expect(dec.additionalContext).toContain('SLOPCHECK');
    expect(dec.additionalContext).toContain('left-pad-typosquat');
  });

  it('npm install of a package already in package.json does NOT fire', () => {
    writePackageJson({ express: '^4.0.0' });
    const dec = runHook('npm install express');
    expect(dec.additionalContext).toBeUndefined();
  });

  it('strips version specifiers when matching', () => {
    writePackageJson({ express: '^4.0.0' });
    expect(runHook('npm install express@4.18.2').additionalContext).toBeUndefined();
    expect(runHook('pip install requests==2.31.0').additionalContext).toContain('requests');
  });

  it('recognizes pnpm / yarn / pip / cargo install verbs', () => {
    expect(runHook('pnpm add some-new-pkg').additionalContext).toContain('some-new-pkg');
    expect(runHook('yarn add another-new-pkg').additionalContext).toContain('another-new-pkg');
    expect(runHook('pip install brand-new-py').additionalContext).toContain('brand-new-py');
    expect(runHook('cargo add brand-new-crate').additionalContext).toContain('brand-new-crate');
  });

  it('packages present in a lockfile are treated as familiar', () => {
    fs.writeFileSync(path.join(projectDir, 'package-lock.json'), JSON.stringify({
      packages: { 'node_modules/lodash': { version: '4.17.21' } },
    }));
    // raw lockfile contains "lodash" — treated as known
    expect(runHook('npm install lodash').additionalContext).toBeUndefined();
  });

  it('multiple packages — only unfamiliar ones are flagged', () => {
    writePackageJson({ express: '^4.0.0' });
    const dec = runHook('npm install express brand-new-thing');
    expect(dec.additionalContext).toContain('brand-new-thing');
    expect(dec.additionalContext).not.toContain('express,'); // express is familiar, not listed
  });

  it('flags are stripped, not treated as packages', () => {
    writePackageJson({});
    const dec = runHook('npm install --save-dev newpkg');
    expect(dec.additionalContext).toContain('newpkg');
    expect(dec.additionalContext).not.toContain('--save-dev');
  });

  it('malformed input never blocks', () => {
    const r = spawnSync('node', [hookPath], {
      input: 'garbage',
      encoding: 'utf-8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('is signal-only — never emits a block decision', () => {
    writePackageJson({});
    const dec = runHook('npm install something-unfamiliar');
    expect(dec.decision).toBe('approve');
    expect((dec as Record<string, unknown>).block).toBeUndefined();
  });
});

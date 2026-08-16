/**
 * Integration tests — cross-model-review.mjs MODULE resolution
 * (grok-build framework integration spec §8/§11, round-9).
 *
 * The SIXTH load-path-gap instance, and the first on the MODULE load rather
 * than the config read. The wrapper imported `<ROOT>/dist/core/
 * crossModelReviewer.js`, where ROOT is the script's `../../..`. That is
 * correct in a checkout/published package — and UNREACHABLE at the
 * PostUpdateMigrator's own delivery target, because the installed copy lives
 * at `<agent home>/.claude/skills/spec-converge/scripts/`, making ROOT
 * `<agent home>/.claude`, a tree that structurally never contains `dist/`.
 * Every installed copy exited 1 BEFORE any config resolution ran, so the §11
 * migration-parity claim was false at its delivery point.
 *
 * These tests invoke the REAL script as a child process — the production
 * execution shape — and assert the documented ladder end-to-end via the
 * surfaced `resolvedModulePath`, BOTH sides: the checkout candidate wins where
 * it exists, the installed-`.claude` layout falls through to the agent's real
 * instar install, and a layout with no install anywhere fails LOUDLY with the
 * candidates enumerated rather than silently.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'skills', 'spec-converge', 'scripts', 'cross-model-review.mjs');
const BUILT_MODULE = path.join(REPO_ROOT, 'dist', 'core', 'crossModelReviewer.js');

function baseEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env['INSTAR_CONFIG_PATH'];
  return env;
}

interface DetectReport {
  available: boolean;
  resolvedModulePath: string;
  resolvedConfigPath: string;
}

async function runDetect(scriptPath: string, cwd: string): Promise<DetectReport> {
  const { stdout } = await execFileAsync(process.execPath, [scriptPath, '--detect-only'], {
    cwd,
    env: baseEnv(),
    timeout: 60_000,
  });
  return JSON.parse(stdout) as DetectReport;
}

/** Lay down an installed-agent-home shape: `<home>/.claude/skills/.../scripts/`. */
function installWrapper(home: string): string {
  const scriptsDir = path.join(home, '.claude', 'skills', 'spec-converge', 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  const target = path.join(scriptsDir, 'cross-model-review.mjs');
  fs.copyFileSync(SCRIPT, target);
  return target;
}

describe('cross-model-review.mjs module resolution ladder (round-9, sixth load-path-gap)', () => {
  let tmp: string;

  beforeAll(() => {
    // realpath: macOS tmpdir is a /var → /private/var symlink, and the child
    // reports resolved paths.
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xmr-mod-')));
  });

  afterAll(() => {
    if (tmp && fs.existsSync(tmp)) {
      SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'xmr-mod-test' });
    }
  });

  it('preconditions: the built module exists in this checkout', () => {
    // A missing dist would make every assertion below vacuous — the control
    // that stops this suite from passing while measuring nothing.
    expect(fs.existsSync(BUILT_MODULE)).toBe(true);
  });

  it('checkout context: resolves the package-root dist (candidate 1)', async () => {
    const report = await runDetect(SCRIPT, REPO_ROOT);
    expect(fs.realpathSync(report.resolvedModulePath)).toBe(fs.realpathSync(BUILT_MODULE));
  });

  it('installed `.claude` layout: falls through to the agent\'s real instar install', async () => {
    const home = path.join(tmp, 'agent-home-installed');
    const installed = installWrapper(home);

    // The candidate-1 path for this layout is `<home>/.claude/dist/...` — assert
    // it genuinely does NOT exist, so the pass below is earned by the fallthrough
    // rather than by an accidental checkout hit.
    const deadCandidate = path.join(home, '.claude', 'dist', 'core', 'crossModelReviewer.js');
    expect(fs.existsSync(deadCandidate)).toBe(false);

    // The agent's real install, as `instar update` lays it down.
    const shadowPkg = path.join(home, '.instar', 'shadow-install', 'node_modules', 'instar');
    fs.mkdirSync(shadowPkg, { recursive: true });
    fs.symlinkSync(path.join(REPO_ROOT, 'dist'), path.join(shadowPkg, 'dist'), 'dir');

    const report = await runDetect(installed, home);
    expect(fs.realpathSync(report.resolvedModulePath)).toBe(fs.realpathSync(BUILT_MODULE));
    expect(report.resolvedModulePath).toContain(path.join('.instar', 'shadow-install'));
  });

  // ── round-10 (integration): the module ladder was only ONE of three
  // ROOT-relative reads. `--spec`/`--context` still resolved against ROOT,
  // which for the installed copy is `<home>/.claude` — a tree with no docs/.
  // Round 9's live check used an ABSOLUTE spec path and could not fail on it,
  // and this suite only exercised `--detect-only`, which returns before any
  // spec file is read: a passing condition narrower than the claim it made.

  it('installed layout resolves a RELATIVE --spec against the CWD, not the script root', async () => {
    const home = path.join(tmp, 'agent-home-relspec');
    const installed = installWrapper(home);
    const shadowPkg = path.join(home, '.instar', 'shadow-install', 'node_modules', 'instar');
    fs.mkdirSync(shadowPkg, { recursive: true });
    fs.symlinkSync(path.join(REPO_ROOT, 'dist'), path.join(shadowPkg, 'dist'), 'dir');

    // The documented invocation form: a repo-relative path, run from the repo.
    const rel = path.join('docs', 'specs', 'grok-build-framework-integration.md');
    expect(fs.existsSync(path.join(REPO_ROOT, rel))).toBe(true);       // precondition
    expect(fs.existsSync(path.join(home, '.claude', rel))).toBe(false); // the dead ROOT path

    const { stdout } = await execFileAsync(
      process.execPath,
      [installed, '--spec', rel, '--hash-only'],
      { cwd: REPO_ROOT, env: baseEnv(), timeout: 60_000 },
    );
    const parsed = JSON.parse(stdout) as { hash?: string };
    expect(parsed.hash).toMatch(/^[0-9a-f]{64}$/);

    // …and it must agree with the checkout copy on the same input, or the
    // delta-gate would compare hashes across two different readings.
    const { stdout: control } = await execFileAsync(
      process.execPath,
      [SCRIPT, '--spec', rel, '--hash-only'],
      { cwd: REPO_ROOT, env: baseEnv(), timeout: 60_000 },
    );
    expect(parsed.hash).toBe((JSON.parse(control) as { hash: string }).hash);
  });

  it('a genuinely missing --spec still fails loudly, naming both bases it tried', async () => {
    const home = path.join(tmp, 'agent-home-missingspec');
    const installed = installWrapper(home);
    const shadowPkg = path.join(home, '.instar', 'shadow-install', 'node_modules', 'instar');
    fs.mkdirSync(shadowPkg, { recursive: true });
    fs.symlinkSync(path.join(REPO_ROOT, 'dist'), path.join(shadowPkg, 'dist'), 'dir');

    let stderr = '';
    try {
      await execFileAsync(
        process.execPath,
        [installed, '--spec', 'docs/specs/no-such-spec-xyz.md', '--hash-only'],
        { cwd: REPO_ROOT, env: baseEnv(), timeout: 60_000 },
      );
    } catch (err) {
      stderr = String((err as { stderr?: string }).stderr ?? '');
    }
    expect(stderr).toContain('File not found');
    expect(stderr).toContain('tried cwd');
  });

  it('installed layout with NO instar install anywhere: fails loudly, enumerating what it tried', async () => {
    const home = path.join(tmp, 'agent-home-bare');
    const installed = installWrapper(home);

    let failed = false;
    let stderr = '';
    try {
      await runDetect(installed, home);
    } catch (err) {
      failed = true;
      stderr = String((err as { stderr?: string }).stderr ?? '');
    }

    expect(failed).toBe(true);
    expect(stderr).toContain('crossModelReviewer module not found');
    expect(stderr).toContain('Tried:');
    // The enumeration is the point: a dead source must be nameable, not a bare
    // "not found" that leaves the operator guessing which context was wrong.
    expect(stderr).toContain(path.join(home, '.claude', 'dist', 'core', 'crossModelReviewer.js'));
    expect(stderr).toContain(path.join('.instar', 'shadow-install'));
  });
});

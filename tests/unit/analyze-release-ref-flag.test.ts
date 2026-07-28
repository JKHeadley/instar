/**
 * Unit tests — analyze-release.js `--ref` flag (release-readiness-visibility spec, PR-1).
 *
 * Layer B of the spec evaluates release-readiness against canonical `main`
 * (FETCH_HEAD), not the local checkout. That requires analyze-release.js to
 * accept a `--ref=<rev>` flag and thread it through the git range queries.
 * Before this flag, the script hardcoded `${tag}..HEAD` — so Layer B would have
 * silently analyzed local HEAD, recreating the exact silent-staleness bug the
 * spec exists to fix.
 *
 * Coverage (the §10 CI gate depends on this):
 *   1. Default (no --ref) analyzes HEAD — preserves the prepublish chain's behavior.
 *   2. --ref=HEAD is identical to the default.
 *   3. --ref=<an earlier commit> changes the analyzed range — different nearest
 *      tag AND a different commit count (proves the ref is actually threaded,
 *      not silently ignored).
 *   4. --ref <space-separated form> parses identically to --ref=<equals form>.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('analyze-release.js --ref flag', () => {
  let tmpDir: string;
  let betaSha: string;
  const scriptPath = path.resolve(__dirname, '../../scripts/analyze-release.js');

  function git(args: string[]): string {
    // SafeGitExecutor.run routes read verbs → readSync and others → execSync.
    // Operations run inside an OS tmpdir, so the SourceTreeGuard never trips.
    return SafeGitExecutor.run(args, {
      cwd: tmpDir,
      operation: 'tests/unit/analyze-release-ref-flag.test.ts:git',
    });
  }

  function commit(message: string, file: string) {
    fs.writeFileSync(path.join(tmpDir, file), `${file}\n`);
    git(['add', file]);
    git(['commit', '-m', message]);
    return git(['rev-parse', 'HEAD']).trim();
  }

  /** Run the copied script and parse its --json report. */
  function runJson(extraArgs: string[]): { commitCount: number; fileCount: number; lastTag: string } {
    const localScript = path.join(tmpDir, 'scripts', 'analyze-release.js');
    const out = execSync(`node "${localScript}" --json ${extraArgs.join(' ')}`, {
      cwd: tmpDir,
      encoding: 'utf-8',
      env: { ...process.env, NODE_PATH: '' },
    });
    const report = JSON.parse(out);
    return {
      commitCount: report.commitCount,
      fileCount: report.fileCount,
      lastTag: report.lastTag,
    };
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'analyze-release-ref-'));

    // Copy the real script into the temp project so __dirname/ROOT resolve here.
    const scriptsDir = path.join(tmpDir, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(
      path.join(scriptsDir, 'analyze-release.js'),
      fs.readFileSync(scriptPath, 'utf-8'),
    );
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'fixture', version: '9.9.9', type: 'module' }, null, 2),
    );

    // Deterministic git fixture, isolated from the developer's global config.
    git(['init', '-q']);
    git(['config', 'user.email', 'fixture@instar.local']);
    git(['config', 'user.name', 'Fixture']);
    git(['config', 'commit.gpgsign', 'false']);

    // History:
    //   C1 (initial) ── tag v0.0.1
    //   C2 feat alpha
    //   C3 feat beta   ← betaSha (nearest tag v0.0.1, 2 commits since)
    //   C4 feat gamma ── tag v0.0.2
    //   C5 feat delta  (HEAD; nearest tag v0.0.2, 1 commit since)
    commit('chore: initial', 'README.md');
    git(['tag', 'v0.0.1']);
    commit('feat: add alpha', 'alpha.txt');
    betaSha = commit('feat: add beta', 'beta.txt');
    commit('feat: add gamma', 'gamma.txt');
    git(['tag', 'v0.0.2']);
    commit('feat: add delta', 'delta.txt');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/analyze-release-ref-flag.test.ts:afterEach',
    });
  });

  it('default (no --ref) analyzes HEAD — nearest tag v0.0.2, one commit since (C5)', () => {
    const r = runJson([]);
    expect(r.lastTag).toBe('v0.0.2');
    expect(r.commitCount).toBe(1); // only C5 (delta) since v0.0.2
    expect(r.fileCount).toBe(1);
  });

  it('--ref=HEAD is identical to the default', () => {
    const def = runJson([]);
    const headRef = runJson(['--ref=HEAD']);
    expect(headRef).toEqual(def);
  });

  it('--ref=<earlier commit> changes the analyzed tip — different nearest tag and count', () => {
    // From C3 (beta) the nearest tag is v0.0.1, with 2 commits since (alpha, beta).
    // If --ref were silently ignored, this would still report HEAD's v0.0.2 / 1 commit.
    const r = runJson([`--ref=${betaSha}`]);
    expect(r.lastTag).toBe('v0.0.1');
    expect(r.commitCount).toBe(2);
    expect(r.fileCount).toBe(2);
  });

  it('--ref <space form> parses identically to --ref=<equals form>', () => {
    const equalsForm = runJson([`--ref=${betaSha}`]);
    const spaceForm = runJson(['--ref', betaSha]);
    expect(spaceForm).toEqual(equalsForm);
  });
});

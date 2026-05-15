/**
 * Tests for the Rule 3 coverage gate script.
 *
 * The script reads the staged git diff and blocks commits that
 * introduce state-detection patterns without paired infrastructure.
 * We test it by setting up a tmp git repo, staging known-bad and
 * known-good content, and invoking the script with the appropriate
 * CWD.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/check-rule3-coverage.cjs');

function runCheck(cwd: string): { exitCode: number; stderr: string } {
  try {
    execFileSync('node', [SCRIPT_PATH], { cwd, encoding: 'utf-8', stdio: 'pipe' });
    return { exitCode: 0, stderr: '' };
  } catch (err) {
    const e = err as { status: number; stderr: Buffer | string };
    return { exitCode: e.status, stderr: String(e.stderr ?? '') };
  }
}

function stage(cwd: string, filepath: string, content: string): void {
  const full = path.join(cwd, filepath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
  execFileSync('git', ['add', filepath], { cwd, stdio: 'pipe' });
}

describe('check-rule3-coverage.cjs', () => {
  let repo: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rule3-gate-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo });
    // Minimal scaffolding: copy the script and spec file the script reads.
    fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
    fs.copyFileSync(SCRIPT_PATH, path.join(repo, 'scripts', 'check-rule3-coverage.cjs'));
    fs.mkdirSync(path.join(repo, 'specs', 'provider-portability'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, 'specs', 'provider-portability', '06-state-detector-registry.md'),
      '# Registry\n\n(Empty for tests; specific files referenced inline.)\n',
    );
    // Make an initial commit so the repo has a HEAD.
    execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'init'], { cwd: repo });
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('passes when no staged files match state-detection patterns', () => {
    stage(repo, 'src/core/banal.ts', 'export const x = 1;');
    const result = runCheck(repo);
    expect(result.exitCode).toBe(0);
  });

  it('blocks when a staged source file fetches from Anthropic without canary or rationale', () => {
    stage(
      repo,
      'src/core/badNewCode.ts',
      `export async function evil() {
  return fetch('https://api.anthropic.com/v1/messages').then((r) => r.json());
}`,
    );
    const result = runCheck(repo);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('fetch() to Anthropic');
    expect(result.stderr).toContain('src/core/badNewCode.ts');
  });

  it('passes when a fetch is accompanied by an explicit RULE 3: EXEMPT comment', () => {
    stage(
      repo,
      'src/core/exemptCode.ts',
      `// RULE 3: EXEMPT — read-only OAuth usage endpoint, fixed-cost
export async function quota() {
  return fetch('https://api.anthropic.com/api/oauth/usage');
}`,
    );
    const result = runCheck(repo);
    expect(result.exitCode).toBe(0);
  });

  it('passes when source file has RULE 3.1 RATIONALE doc-comment AND a canary file is staged alongside', () => {
    stage(
      repo,
      'src/providers/adapters/example/foo.ts',
      `/**
 * RULE 3.1 RATIONALE
 * Criticality: high
 * Frequency: per-prompt
 * Stability: unstable
 * Fallback: none
 * Verdict: deterministic + canary
 */
import { execFile } from 'node:child_process';
const _captureUse = "capture-pane";`,
    );
    stage(
      repo,
      'src/providers/adapters/example/canary/fooCanary.ts',
      '// canary',
    );
    const result = runCheck(repo);
    expect(result.exitCode).toBe(0);
  });

  it('blocks when source has the rationale comment but no canary alongside', () => {
    stage(
      repo,
      'src/providers/adapters/example/foo.ts',
      `/** RULE 3.1 RATIONALE: ... */
const _useCapture = "capture-pane";`,
    );
    const result = runCheck(repo);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('registry entry or canary file');
  });

  it('blocks when only the canary is staged but the source lacks the rationale comment', () => {
    stage(
      repo,
      'src/providers/adapters/example/foo.ts',
      'const _useCapture = "capture-pane";',
    );
    stage(
      repo,
      'src/providers/adapters/example/canary/fooCanary.ts',
      '// canary',
    );
    const result = runCheck(repo);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Rule 3.1 rationale comment');
  });

  it('flags a new class named *Reader / *Tailer / etc. as a state-detection candidate', () => {
    stage(
      repo,
      'src/providers/adapters/example/LogReader.ts',
      `export class LogReader {
  parse() {}
}`,
    );
    const result = runCheck(repo);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('class *Reader');
  });

  it('does not flag a test file', () => {
    stage(
      repo,
      'src/providers/adapters/example/Foo.test.ts',
      `class FooReader {}`,
    );
    const result = runCheck(repo);
    expect(result.exitCode).toBe(0);
  });
});

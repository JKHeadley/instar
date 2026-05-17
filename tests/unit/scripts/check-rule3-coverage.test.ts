// safe-git-allow: test-fixture-git — tests spin up a throwaway tmp git repo (git init + git add + git commit + tmpdir cleanup) to drive the rule3 script under controlled state; SafeGitExecutor migration tracked separately.
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

// Git sets GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE in the env when running
// its own hooks (e.g. pre-push runs the test suite, which transitively spawns
// these tests). Those vars take precedence over cwd-based repo resolution,
// so `git diff --cached` invoked inside the tmp repo would actually resolve
// against the parent repo's index — making the staged fixtures invisible to
// the script. Strip the inherited git env for every git-touching call.
const childEnv: NodeJS.ProcessEnv = { ...process.env };
delete childEnv.GIT_DIR;
delete childEnv.GIT_WORK_TREE;
delete childEnv.GIT_INDEX_FILE;
delete childEnv.GIT_OBJECT_DIRECTORY;
delete childEnv.GIT_COMMON_DIR;

function runCheck(cwd: string): { exitCode: number; stderr: string } {
  try {
    execFileSync('node', [SCRIPT_PATH], { cwd, encoding: 'utf-8', stdio: 'pipe', env: childEnv });
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
  execFileSync('git', ['add', filepath], { cwd, stdio: 'pipe', env: childEnv });
}

describe('check-rule3-coverage.cjs', () => {
  let repo: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rule3-gate-'));
    execFileSync('git', ['init', '-q'], { cwd: repo, env: childEnv });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo, env: childEnv });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo, env: childEnv });
    // Minimal scaffolding: copy the script and spec file the script reads.
    fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
    fs.copyFileSync(SCRIPT_PATH, path.join(repo, 'scripts', 'check-rule3-coverage.cjs'));
    fs.mkdirSync(path.join(repo, 'specs', 'provider-portability'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, 'specs', 'provider-portability', '06-state-detector-registry.md'),
      '# Registry\n\n(Empty for tests; specific files referenced inline.)\n',
    );
    // Make an initial commit so the repo has a HEAD.
    execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'init'], { cwd: repo, env: childEnv });
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

  // ── Spec 12 (OpenAI / Codex path constraints) — new patterns ─────────

  // Tightened pattern: only LHS assignments / emissions trip the gate.
  // Plain reads (`process.env.OPENAI_API_KEY`) are legitimate and must not
  // false-positive — otherwise every legacy file that reads the env var
  // would block commits without an EXEMPT marker.

  it('does NOT flag plain reads of process.env.OPENAI_API_KEY', () => {
    stage(
      repo,
      'src/providers/adapters/example/foo.ts',
      `export function getKey() { return process.env.OPENAI_API_KEY; }`,
    );
    const result = runCheck(repo);
    expect(result.exitCode).toBe(0);
  });

  it('does NOT flag defensive deletes (delete env.OPENAI_API_KEY)', () => {
    stage(
      repo,
      'src/providers/adapters/example/foo.ts',
      `export function scrub(env: any) { delete env.OPENAI_API_KEY; return env; }`,
    );
    const result = runCheck(repo);
    expect(result.exitCode).toBe(0);
  });

  it('does NOT flag type declarations like OPENAI_API_KEY?: string', () => {
    stage(
      repo,
      'src/providers/adapters/example/foo.ts',
      `export interface Env { OPENAI_API_KEY?: string; }`,
    );
    const result = runCheck(repo);
    expect(result.exitCode).toBe(0);
  });

  it('does NOT flag === comparisons against OPENAI_API_KEY', () => {
    stage(
      repo,
      'src/providers/adapters/example/foo.ts',
      `export function isLeaked(env: any) { return typeof env.OPENAI_API_KEY === 'string'; }`,
    );
    const result = runCheck(repo);
    expect(result.exitCode).toBe(0);
  });

  it('flags LHS assignment env.OPENAI_API_KEY = value as Rule 1 violation', () => {
    stage(
      repo,
      'src/providers/adapters/example/foo.ts',
      `export function leak(env: any) { env.OPENAI_API_KEY = 'sk-leak'; }`,
    );
    const result = runCheck(repo);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('OPENAI_API_KEY');
  });

  it('flags process.env.OPENAI_API_KEY = value (direct env mutation)', () => {
    stage(
      repo,
      'src/providers/adapters/example/foo.ts',
      `export function setKey(k: string) { process.env.OPENAI_API_KEY = k; }`,
    );
    const result = runCheck(repo);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('OPENAI_API_KEY');
  });

  it('flags template-literal shell-style emission `OPENAI_API_KEY=${...}`', () => {
    stage(
      repo,
      'src/providers/adapters/example/foo.ts',
      'export const flag = (v: string) => `OPENAI_API_KEY=${v}`;',
    );
    const result = runCheck(repo);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('OPENAI_API_KEY');
  });

  it('flags new OpenAI() — published SDK client construction', () => {
    stage(
      repo,
      'src/providers/adapters/example/foo.ts',
      `import OpenAI from 'openai';
export const client = new OpenAI({ apiKey: 'sk-x' });`,
    );
    const result = runCheck(repo);
    expect(result.exitCode).toBe(1);
    // Either "new OpenAI" or the import pattern can be the first to fire;
    // the script reports one violation per file.
    expect(result.stderr).toMatch(/new OpenAI|openai/);
  });

  it('flags openai.chat.completions.create — published SDK inference call', () => {
    stage(
      repo,
      'src/providers/adapters/example/foo.ts',
      `export function ask(client: any) {
  return client.chat.completions.create({ model: 'gpt-4o', messages: [] });
}
const openai = {} as any;
openai.chat.completions.create({});`,
    );
    const result = runCheck(repo);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('openai.chat.completions.create');
  });

  it('flags import from "openai" package', () => {
    stage(
      repo,
      'src/providers/adapters/example/foo.ts',
      `import OpenAI from "openai";
export const _x = OpenAI;`,
    );
    const result = runCheck(repo);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('openai');
  });

  it('flags require("openai") — CJS import path', () => {
    stage(
      repo,
      'src/providers/adapters/example/foo.ts',
      `const OpenAI = require('openai');
module.exports = OpenAI;`,
    );
    const result = runCheck(repo);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('openai');
  });

  it('flags LHS assignment to OPENAI_BASE_URL (Instar code must not set this)', () => {
    stage(
      repo,
      'src/providers/adapters/example/foo.ts',
      `process.env.OPENAI_BASE_URL = 'http://attacker.example/v1';
export const _x = 1;`,
    );
    const result = runCheck(repo);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('OPENAI_BASE_URL');
  });

  it('passes when openai patterns appear with rationale + canary (legitimate adapter)', () => {
    stage(
      repo,
      'src/providers/adapters/example/foo.ts',
      `/**
 * RULE 3.1 RATIONALE
 * Criticality: high
 * Frequency: per-prompt
 * Stability: stable
 * Fallback: none
 * Verdict: deterministic
 */
export function readEnv() { return process.env.OPENAI_API_KEY; }`,
    );
    stage(
      repo,
      'src/providers/adapters/example/canary/fooCanary.ts',
      '// canary',
    );
    const result = runCheck(repo);
    expect(result.exitCode).toBe(0);
  });

  it('passes when openai patterns are exempt-marked', () => {
    stage(
      repo,
      'src/providers/adapters/example/foo.ts',
      `// RULE 3: EXEMPT — adapter shims the package surface for testing only
import OpenAI from 'openai';
export const _x = OpenAI;`,
    );
    const result = runCheck(repo);
    expect(result.exitCode).toBe(0);
  });
});

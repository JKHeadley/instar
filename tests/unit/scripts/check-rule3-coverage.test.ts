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

/**
 * Run the COPY of the script inside the tmp repo, not the original.
 *
 * The script resolves the state-detector registry from `__dirname/../specs/`,
 * so running the original made it read the real repo's registry while reading
 * staged files from the tmp repo. `beforeEach` has always copied the script in
 * — the copy was simply never executed, so every registry fixture was silently
 * ignored and the "already in the registry" branch had no reachable coverage.
 */
function runCheck(cwd: string): { exitCode: number; stderr: string } {
  const scriptInRepo = path.join(cwd, 'scripts', 'check-rule3-coverage.cjs');
  try {
    execFileSync('node', [scriptInRepo], { cwd, encoding: 'utf-8', stdio: 'pipe', env: childEnv });
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

/**
 * Overwrite the tmp repo's state-detector registry with the given table rows.
 * The default fixture registry is empty, so the "already in the registry"
 * branch of the gate was never exercised before these tests.
 */
function writeRegistry(cwd: string, ...rows: string[]): void {
  fs.writeFileSync(
    path.join(cwd, 'specs', 'provider-portability', '06-state-detector-registry.md'),
    ['# Registry', '', '| Location | Status |', '|---|---|', ...rows, ''].join('\n'),
    'utf-8',
  );
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

  // A registry entry does NOT exempt on its own: the gate requires
  // `inRegistry && (hasRationale || hasCanary)`. These two cases therefore
  // stage a registered file that carries a rationale but no canary — the
  // combination the registry branch exists to serve.
  //
  // The registry's Location column is section-relative. Most sections write
  // paths relative to src/, but the provider-substrate section writes them
  // relative to src/providers/ (21 of its 23 rows, measured on main).
  const RATIONALE = '/** RULE 3.1 RATIONALE — advisory read; loud fallback. */';

  it('accepts a registered file with a rationale when the registry path is relative to src/', () => {
    writeRegistry(repo, '| `core/Widget.ts` — parses a subprocess result | 🔵 Exempt |');
    stage(repo, 'src/core/Widget.ts', `${RATIONALE}\nexport const r = JSON.parse(stdout);`);
    expect(runCheck(repo).exitCode).toBe(0);
  });

  it('accepts a registered provider file with a rationale when the registry path is relative to src/providers/', () => {
    writeRegistry(
      repo,
      '| `adapters/openai-codex/observability/logTailer.ts` — parses a subprocess result | 🔵 Exempt |',
    );
    stage(
      repo,
      'src/providers/adapters/openai-codex/observability/logTailer.ts',
      `${RATIONALE}\nexport const r = JSON.parse(stdout);`,
    );
    // Before the section-relative fix this failed: the gate stripped only
    // `src/`, looked for `providers/adapters/...`, never matched the row that
    // was right there, and refused the file for "registry entry or canary
    // file" — telling the author to add a row that already existed.
    expect(runCheck(repo).exitCode).toBe(0);
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

  it('does NOT accept a canary-named file from an UNRELATED directory', () => {
    // The canary fallback used to test `/canary/i.test(basename(f))` against
    // every staged file without referencing the file under test — so it was a
    // property of the COMMIT, not a relationship. Staging one canary-named file
    // anywhere credited every other file in the change. src/ carries 11 such
    // files, so any broad commit touching one satisfied the canary half of
    // Rule 3 wholesale. It failed in the QUIET direction, which is why nothing
    // ever complained.
    stage(
      repo,
      'src/providers/adapters/example/foo.ts',
      `/**
 * RULE 3.1 RATIONALE
 * Criticality: high
 */
const _captureUse = "capture-pane";`,
    );
    // Canary-named, but for a completely different adapter.
    stage(repo, 'src/providers/adapters/other/canary/otherCanary.ts', '// canary');
    const result = runCheck(repo);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('src/providers/adapters/example/foo.ts');
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

/**
 * Merge semantics.
 *
 * A merge stages every file that differs between the branch base and the
 * incoming ref. Judging that whole index as the committer's work makes anyone
 * merging `main` into an older branch the author of all of `main` — so they are
 * refused for pre-existing violations absent from their own diff, which they
 * cannot see and did not write.
 *
 * The committer's real contribution to a merge is what differs from the
 * INCOMING ref (`MERGE_HEAD`). A file taken verbatim from the incoming side was
 * not authored here; a conflict resolution was.
 */
describe('check-rule3-coverage.cjs — merge semantics', () => {
  let repo: string;
  // `init.defaultBranch` varies by machine (main / master / anything). Capture
  // the real name instead of hardcoding one — a hardcoded guess passes on the
  // author's box and fails on everyone else's.
  let baseBranch: string;

  function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe', env: childEnv });
  }

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rule3-merge-'));
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'test');
    fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
    fs.copyFileSync(SCRIPT_PATH, path.join(repo, 'scripts', 'check-rule3-coverage.cjs'));
    fs.mkdirSync(path.join(repo, 'specs', 'provider-portability'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, 'specs', 'provider-portability', '06-state-detector-registry.md'),
      '# Registry\n\n(Empty for tests.)\n',
    );
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    baseBranch = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
    git(repo, 'branch', 'incoming');
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('does NOT judge a violating file that came verbatim from the incoming ref', () => {
    // The incoming branch introduces the violation — as `main` did with
    // devClaimCheck.ts. The merging author never touched it.
    git(repo, 'checkout', '-q', 'incoming');
    stage(repo, 'src/core/TheirViolation.ts', 'export const r = JSON.parse(stdout);');
    git(repo, 'commit', '-q', '-m', 'incoming adds a detector');

    git(repo, 'checkout', '-q', baseBranch);
    stage(repo, 'src/core/OurUnrelated.ts', 'export const x = 1;');
    git(repo, 'commit', '-q', '-m', 'ours');

    // --no-commit leaves MERGE_HEAD set, which is the state the hook runs in.
    try {
      git(repo, 'merge', '--no-commit', '--no-ff', 'incoming');
    } catch {
      /* a no-commit merge exits non-zero by design; the index is what matters */
    }
    // Sanity: the file IS staged (so a pass here is not vacuous — it means the
    // gate looked at the index and correctly attributed the file elsewhere).
    expect(git(repo, 'diff', '--cached', '--name-only')).toContain('src/core/TheirViolation.ts');

    expect(runCheck(repo).exitCode).toBe(0);
  });

  it('DOES judge a file the author resolved differently from the incoming ref', () => {
    // Both sides touch the same file; the author resolves it with violating
    // content. That content exists on neither parent — it was authored here.
    git(repo, 'checkout', '-q', 'incoming');
    stage(repo, 'src/core/Contested.ts', 'export const a = 1;\n');
    git(repo, 'commit', '-q', '-m', 'incoming version');

    git(repo, 'checkout', '-q', baseBranch);
    stage(repo, 'src/core/Contested.ts', 'export const b = 2;\n');
    git(repo, 'commit', '-q', '-m', 'our version');

    try {
      git(repo, 'merge', '--no-commit', '--no-ff', 'incoming');
    } catch {
      /* conflict expected */
    }
    // The author's resolution introduces the detector.
    stage(repo, 'src/core/Contested.ts', 'export const r = JSON.parse(stdout);\n');

    const result = runCheck(repo);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('src/core/Contested.ts');
  });
});

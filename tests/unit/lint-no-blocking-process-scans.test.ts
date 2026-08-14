// Self-test for the blocking-process-scan lint (topic 21816 post-mortem, root
// cause #4): a synchronous ps/pgrep/lsof/pkill on the runtime hot path blocks
// the event loop and starves /health under load. The lint must flag a fresh
// sync scan, honour an inline justification, ignore comment-only mentions and
// async/tmux calls, and stay clean on the real tree.
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..');
const LINT_SCRIPT = path.join(REPO_ROOT, 'scripts', 'lint-no-blocking-process-scans.js');

interface RunResult { code: number; stdout: string; stderr: string }

function runLint(...args: string[]): RunResult {
  try {
    const stdout = execFileSync('node', [LINT_SCRIPT, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

const tmpFiles: string[] = [];
function tmpFixture(body: string): string {
  const file = path.join(
    fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scanlint-'))),
    'fixture.ts',
  );
  fs.writeFileSync(file, body);
  tmpFiles.push(file);
  return file;
}

afterEach(() => {
  for (const f of tmpFiles.splice(0)) {
    try {
      SafeFsExecutor.safeRmSync(path.dirname(f), {
        recursive: true,
        force: true,
        operation: 'tests/unit/lint-no-blocking-process-scans.test.ts:cleanup',
      });
    } catch { /* best-effort */ }
  }
});

describe('lint-no-blocking-process-scans', () => {
  it('flags a synchronous ps scan', () => {
    const fx = tmpFixture(
      `import { execFileSync } from 'node:child_process';\n` +
      `export const out = execFileSync('ps', ['aux']);\n`,
    );
    const r = runLint(fx);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('synchronous process scan');
  });

  it('flags spawnSync pgrep and execSync lsof too', () => {
    const fx = tmpFixture(
      `import { spawnSync, execSync } from 'node:child_process';\n` +
      `export const a = spawnSync('pgrep', ['-x', 'foo']);\n` +
      `export const b = execSync('lsof -p 123');\n`,
    );
    const r = runLint(fx);
    expect(r.code).toBe(1);
  });

  it('honours an inline lint-allow-blocking-scan justification', () => {
    const fx = tmpFixture(
      `import { execFileSync } from 'node:child_process';\n` +
      `// lint-allow-blocking-scan: one-shot, bounded, not on a cadence\n` +
      `export const out = execFileSync('lsof', ['-p', '1']);\n`,
    );
    const r = runLint(fx);
    expect(r.code).toBe(0);
  });

  it('does NOT flag comment-only mentions or async/tmux calls', () => {
    const fx = tmpFixture(
      `import { execFile } from 'node:child_process';\n` +
      `// we used to call execFileSync('ps', ...) here — now async\n` +
      `export const x = execFile('tmux', ['list-sessions']);\n`,
    );
    const r = runLint(fx);
    expect(r.code).toBe(0);
  });

  it('the real runtime tree (src/monitoring + src/server) is clean', () => {
    const r = runLint();
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
  });
});

/**
 * The command name does not have to be written at the callsite.
 *
 * The shipped pattern required the scan command as a string literal INSIDE the
 * call — `execFileSync('pgrep', …)`. Anything that puts the name one step away
 * walked past it, and the event loop stalls just the same either way: the
 * incident was about what the process DOES, not about how the argument was
 * spelled.
 *
 * instar-codey reproduced the concatenation form against the shipped lint
 * (`const cmd = 'pg' + 'rep'; execFileSync(cmd, ['node'])` → exit 0) while
 * auditing rename-defeatable checks, and scoped the fix: constant-folded command
 * values plus sync aliases, in the hot dirs only — NOT all sync child-process
 * calls, which would over-block. That scope is what these tests pin.
 */
describe('lint-no-blocking-process-scans — the name one step away', () => {
  it('DEFECT: a concatenated command in a local const is caught', () => {
    const fx = tmpFixture(
      `import { execFileSync } from 'node:child_process';\n` +
      `const cmd = 'pg' + 'rep';\n` +
      `export const out = execFileSync(cmd, ['node']);\n`,
    );
    const r = runLint(fx);
    expect(r.code, `expected a violation; stdout was:\n${r.stdout}`).toBe(1);
    expect(r.stderr).toContain('synchronous process scan');
  });

  it('DEFECT: a plain variable holding the command is caught', () => {
    // Simpler than the concatenation and just as effective — no cleverness needed.
    const fx = tmpFixture(
      `import { spawnSync } from 'node:child_process';\n` +
      `const tool = 'pgrep';\n` +
      `export const out = spawnSync(tool, ['-x', 'node']);\n`,
    );
    const r = runLint(fx);
    expect(r.code, `expected a violation; stdout was:\n${r.stdout}`).toBe(1);
  });

  it('DEFECT: concatenation written inline at the callsite is caught', () => {
    const fx = tmpFixture(
      `import { execFileSync } from 'node:child_process';\n` +
      `export const out = execFileSync('ls' + 'of', ['-p', '1']);\n`,
    );
    const r = runLint(fx);
    expect(r.code, `expected a violation; stdout was:\n${r.stdout}`).toBe(1);
  });

  it('DEFECT: an import-aliased sync call is caught', () => {
    const fx = tmpFixture(
      `import { execFileSync as run } from 'node:child_process';\n` +
      `export const out = run('pkill', ['-f', 'node']);\n`,
    );
    const r = runLint(fx);
    expect(r.code, `expected a violation; stdout was:\n${r.stdout}`).toBe(1);
  });

  // ── The opposite direction. This lint blocks commits, so flagging correct code
  //    is the more expensive failure. Every one of these must stay legal.
  it('CONTROL: the allow comment still exempts a folded command', () => {
    const fx = tmpFixture(
      `import { execFileSync } from 'node:child_process';\n` +
      `const cmd = 'ps';\n` +
      `// lint-allow-blocking-scan: one-shot at boot, cannot run on a cadence\n` +
      `export const out = execFileSync(cmd, ['aux']);\n`,
    );
    const r = runLint(fx);
    expect(r.code, `an allowed one-shot must stay allowed; stderr:\n${r.stderr}`).toBe(0);
  });

  it('CONTROL: a non-scan command in a const is not flagged', () => {
    const fx = tmpFixture(
      `import { execFileSync } from 'node:child_process';\n` +
      `const cmd = 'tmux';\n` +
      `export const out = execFileSync(cmd, ['list-sessions']);\n`,
    );
    const r = runLint(fx);
    expect(r.code, `tmux is bounded and explicitly out of scope; stderr:\n${r.stderr}`).toBe(0);
  });

  it('CONTROL: a command that merely STARTS with a scan name is not flagged', () => {
    // `psql` is not `ps`. Folding must not turn a prefix into a match.
    const fx = tmpFixture(
      `import { execFileSync } from 'node:child_process';\n` +
      `const cmd = 'psql';\n` +
      `export const out = execFileSync(cmd, ['-c', 'select 1']);\n`,
    );
    const r = runLint(fx);
    expect(r.code, `psql must not match ps; stderr:\n${r.stderr}`).toBe(0);
  });

  it('CONTROL: an ASYNC call with a folded command is not flagged — async is the fix', () => {
    const fx = tmpFixture(
      `import { execFile } from 'node:child_process';\n` +
      `const cmd = 'pg' + 'rep';\n` +
      `export const out = execFile(cmd, ['node'], () => {});\n`,
    );
    const r = runLint(fx);
    expect(r.code, `async yields the loop — it is the remedy, not the offence; stderr:\n${r.stderr}`).toBe(0);
  });

  it('CONTROL: a const named like a scan but holding something else is not flagged', () => {
    const fx = tmpFixture(
      `import { execFileSync } from 'node:child_process';\n` +
      `const pgrep = 'tmux';\n` +
      `export const out = execFileSync(pgrep, ['list-sessions']);\n`,
    );
    const r = runLint(fx);
    expect(r.code, `the VALUE decides, not the variable name; stderr:\n${r.stderr}`).toBe(0);
  });
});

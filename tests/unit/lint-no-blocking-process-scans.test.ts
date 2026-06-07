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

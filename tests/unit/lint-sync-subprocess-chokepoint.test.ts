/**
 * Self-test for the sync-subprocess-chokepoint lint (tmux Event-Loop Resilience,
 * Increment 1). A RAW synchronous subprocess spawn (spawnSync/execSync/
 * execFileSync) blocks the single-threaded event loop for the full child-process
 * duration; the lint forward-guards a NEW raw sync spawn outside the
 * InFlightSyncOpMarker funnel (so the (B) marker can never silently lose a
 * blocking op). It must:
 *   - flag a fresh raw execFileSync (and spawnSync/execSync) outside the funnel,
 *   - honour an inline `// lint-allow-sync-spawn:` justification,
 *   - NOT flag a comment-only mention, an async execFile/execFileAsync, or a call
 *     funneled through withSyncOp(...),
 *   - NOT flag a raw spawn inside the chokepoint module itself,
 *   - stay CLEAN on the real tree against the committed frozen baseline,
 *   - FAIL on a new raw spawn that is NOT in the baseline.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..');
const LINT_SCRIPT = path.join(REPO_ROOT, 'scripts', 'lint-sync-subprocess-chokepoint.js');

interface RunResult { code: number; stdout: string; stderr: string }

function runLint(...args: string[]): RunResult {
  try {
    const stdout = execFileSync('node', [LINT_SCRIPT, ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

const tmpDirs: string[] = [];
/** Write a single fixture .ts file under a fresh tmpdir; return its absolute path. */
function tmpFixture(body: string, basename = 'fixture.ts'): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chokelint-')));
  const file = path.join(dir, basename);
  fs.writeFileSync(file, body);
  tmpDirs.push(dir);
  return file;
}

/** An EMPTY baseline file (so a fixture file's hits are all NEW violations). */
function emptyBaseline(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chokebase-')));
  const file = path.join(dir, 'baseline.json');
  fs.writeFileSync(file, JSON.stringify({ keys: [] }));
  tmpDirs.push(dir);
  return file;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      SafeFsExecutor.safeRmSync(d, {
        recursive: true, force: true,
        operation: 'tests/unit/lint-sync-subprocess-chokepoint.test.ts:cleanup',
      });
    } catch { /* best-effort */ }
  }
});

describe('lint-sync-subprocess-chokepoint', () => {
  it('flags a fresh raw execFileSync outside the funnel (exit 1)', () => {
    const fx = tmpFixture(
      `import { execFileSync } from 'node:child_process';\n` +
      `export const out = execFileSync('tmux', ['list-sessions']);\n`,
    );
    const r = runLint(fx, '--baseline', emptyBaseline());
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('raw sync spawn');
  });

  it('flags spawnSync and execSync too', () => {
    const fxSpawn = tmpFixture(
      `import { spawnSync } from 'node:child_process';\n` +
      `export const a = spawnSync('tmux', ['has-session']);\n`,
    );
    const r1 = runLint(fxSpawn, '--baseline', emptyBaseline());
    expect(r1.code).toBe(1);

    const fxExec = tmpFixture(
      `import { execSync } from 'node:child_process';\n` +
      `export const b = execSync('tmux list-sessions');\n`,
    );
    const r2 = runLint(fxExec, '--baseline', emptyBaseline());
    expect(r2.code).toBe(1);
  });

  it('honours an inline // lint-allow-sync-spawn: justification', () => {
    const fx = tmpFixture(
      `import { execFileSync } from 'node:child_process';\n` +
      `// lint-allow-sync-spawn: one-shot CLI boot probe, never on a cadence\n` +
      `export const v = execFileSync('tmux', ['-V']);\n`,
    );
    const r = runLint(fx, '--baseline', emptyBaseline());
    expect(r.code).toBe(0);
  });

  it('does NOT flag a comment-only mention or an async execFile/execFileAsync', () => {
    const fx = tmpFixture(
      `import { execFile } from 'node:child_process';\n` +
      `// we used to call execFileSync('tmux', ...) here — now async\n` +
      `export const x = execFile('tmux', ['list-sessions']);\n` +
      `export const y = execFileAsync('tmux', ['display-message']);\n`,
    );
    const r = runLint(fx, '--baseline', emptyBaseline());
    expect(r.code).toBe(0);
  });

  it('does NOT flag a sync spawn funneled through withSyncOp(...) on the same line', () => {
    const fx = tmpFixture(
      `import { execFileSync } from 'node:child_process';\n` +
      `import { withSyncOp } from './InFlightSyncOpMarker.js';\n` +
      `export const out = withSyncOp(() => execFileSync('tmux', ['send-keys']));\n`,
    );
    // Funneled is allowed unconditionally — even with an EMPTY baseline.
    const r = runLint(fx, '--baseline', emptyBaseline());
    expect(r.code).toBe(0);
  });

  it('skips the chokepoint module: the REAL src/core/InFlightSyncOpMarker.ts is never flagged', () => {
    // The lint identifies the chokepoint module by its repo-relative path
    // (CHOKEPOINT = 'src/core/InFlightSyncOpMarker.ts'); a hit there is the one
    // place a raw sync spawn is allowed (it WRAPS the call in withSyncOp). The
    // real module is pure fs/path with no spawn, so passing it explicitly with an
    // EMPTY baseline must be clean — never a violation. (The skip BRANCH for a
    // chokepoint-internal raw spawn cannot be unit-tested via a fixture tree: the
    // --root override rebases the SCAN but not the chokepoint-skip rel-path check
    // — see the structured finding. We do not mutate the real module to reach it.)
    const r = runLint(path.join(REPO_ROOT, 'src', 'core', 'InFlightSyncOpMarker.ts'), '--baseline', emptyBaseline());
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('clean');
  });

  it('the skip is path-SELECTIVE: a NON-chokepoint core file with a raw spawn IS flagged', () => {
    // Proves the chokepoint exemption is keyed on the specific path, not a blanket
    // src/core pass — a fresh raw spawn in any OTHER core-shaped fixture still fails.
    const fx = tmpFixture(
      `import { execFileSync } from 'node:child_process';\n` +
      `export function elsewhere() { return execFileSync('tmux', ['kill-server']); }\n`,
      'SomeOtherCoreModule.ts',
    );
    const r = runLint(fx, '--baseline', emptyBaseline());
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('raw sync spawn');
  });

  it('the real tree is CLEAN against the committed frozen baseline', () => {
    const r = runLint();
    expect(r.stdout).toContain('clean');
    expect(r.code).toBe(0);
  });

  it('FAILS on a new raw spawn that is NOT in the baseline (the forward ratchet)', () => {
    // A fixture file's hit can never be in the committed real-tree baseline → NEW violation.
    const fx = tmpFixture(
      `import { execFileSync } from 'node:child_process';\n` +
      `export const brandNew = execFileSync('some-brand-new-binary', ['--flag']);\n`,
    );
    const r = runLint(fx); // uses the REAL committed baseline
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('new violation');
  });
});

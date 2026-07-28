// Self-test for the buildHeadlessLaunch funnel lint (spec
// june15-headless-spawn-reroute, finding F5 / verification map V7):
// a future spawn callsite that imports buildHeadlessLaunch directly would
// bypass the June-15 subscription-path reroute and silently re-introduce
// SDK-pot billing — the lint must catch it, and must stay clean on the
// real tree (whose only references live in the closed allowlist).
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..');
const LINT_SCRIPT = path.join(REPO_ROOT, 'scripts', 'lint-no-unfunneled-headless-launch.js');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

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
    fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'headless-lint-'))),
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
        operation: 'tests/unit/lint-no-unfunneled-headless-launch.test.ts:cleanup',
      });
    } catch {
      /* sandbox cleanup is best-effort */
    }
  }
});

describe('lint-no-unfunneled-headless-launch (V7)', () => {
  it('flags a direct buildHeadlessLaunch import outside the allowlist', () => {
    const fixture = tmpFixture(
      `import { buildHeadlessLaunch } from '../core/frameworkSessionLaunch.js';\n` +
      `export const spec = buildHeadlessLaunch('claude-code', { binaryPath: 'claude', prompt: 'x' });\n`,
    );
    const result = runLint(fixture);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('buildHeadlessLaunch reference outside the subscription-path funnel');
  });

  it('does NOT flag comment-only mentions (documentation is not a bypass)', () => {
    const fixture = tmpFixture(
      `// model tiers resolve per-framework inside buildHeadlessLaunch\n` +
      `/* buildHeadlessLaunch is the headless builder */\n` +
      `export const x = 1;\n`,
    );
    const result = runLint(fixture);
    expect(result.code).toBe(0);
  });

  it('the real tree is clean (all references live in the closed allowlist)', () => {
    const result = runLint();
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
  });

  it('the allowlist is closed to exactly the funnel, the definition, the isolated pipe path, and the lint itself', () => {
    const lintSource = fs.readFileSync(LINT_SCRIPT, 'utf8');
    const allowMatch = lintSource.match(/const ALLOWLIST = new Set\(\[([\s\S]*?)\]\);/);
    expect(allowMatch, 'ALLOWLIST block not found in lint script').not.toBeNull();
    const entries = [...allowMatch![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(entries.sort()).toEqual(
      [
        'scripts/lint-no-unfunneled-headless-launch.js',
        'src/core/SessionManager.ts',
        'src/core/frameworkSessionLaunch.ts',
        'src/threadline/PipeSessionSpawner.ts',
      ].sort(),
    );
  });
});

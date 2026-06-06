// safe-fs-allow: test sandbox teardown only (tmpdir scratch dirs).
// safe-git-allow: test sandbox teardown only (tmpdir scratch dirs).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..');
const LINT_SCRIPT = path.join(REPO_ROOT, 'scripts', 'lint-state-registry.js');

function mkSandbox(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lint-state-registry-')));
}

function rmrf(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* noop */
  }
}

function writeFile(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

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
    return {
      code: e.status ?? 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
    };
  }
}

let sandbox: string;
beforeEach(() => {
  sandbox = mkSandbox();
});
afterEach(() => {
  rmrf(sandbox);
});

describe('lint-state-registry — real tree', () => {
  it('lints GREEN against the actual src/ tree', () => {
    const r = runLint();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('lint-state-registry: clean');
  });
});

describe('lint-state-registry — undeclared synthetic store (red)', () => {
  it('FAILS when a durable write targets a state dir / .instar store with no registry entry', () => {
    const file = path.join(sandbox, 'BadStore.ts');
    writeFile(
      file,
      [
        "import fs from 'node:fs';",
        'export function persist(stateDir: string, data: string) {',
        "  fs.writeFileSync(path.join(stateDir, 'totally-undeclared-store.json'), data);",
        '}',
        '',
      ].join('\n'),
    );
    const r = runLint('--root', sandbox);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('totally-undeclared-store.json');
    expect(r.stderr).toContain('no State-Coherence Registry entry');
  });

  it('FAILS for an undeclared appendFileSync JSONL stream under .instar/', () => {
    const file = path.join(sandbox, 'BadAudit.ts');
    writeFile(
      file,
      [
        "import fs from 'node:fs';",
        "fs.appendFileSync('.instar/state/mystery-audit.jsonl', line + '\\n');",
        '',
      ].join('\n'),
    );
    const r = runLint('--root', sandbox);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('mystery-audit.jsonl');
  });
});

describe('lint-state-registry — inline annotation (green)', () => {
  it('PASSES the same undeclared store when an inline /* state-registry: <category> */ annotation names a real entry', () => {
    const file = path.join(sandbox, 'WrappedStore.ts');
    writeFile(
      file,
      [
        "import fs from 'node:fs';",
        'export function persist(stateDir: string, data: string) {',
        '  /* state-registry: commitments */',
        "  fs.writeFileSync(path.join(stateDir, 'totally-undeclared-store.json'), data);",
        '}',
        '',
      ].join('\n'),
    );
    const r = runLint('--root', sandbox);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('lint-state-registry: clean');
  });

  it('still FAILS when the annotation names a category that does not exist (dangling annotation)', () => {
    const file = path.join(sandbox, 'DanglingAnnotation.ts');
    writeFile(
      file,
      [
        "import fs from 'node:fs';",
        '  /* state-registry: not-a-real-category */',
        "  fs.writeFileSync(path.join(stateDir, 'totally-undeclared-store.json'), data);",
        '',
      ].join('\n'),
    );
    const r = runLint('--root', sandbox);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('not-a-real-category');
  });
});

describe('lint-state-registry — out-of-scope sites stay quiet', () => {
  it('does NOT flag a write to a bare variable path with no state-dir indicator on the line', () => {
    const file = path.join(sandbox, 'OkBareVar.ts');
    writeFile(
      file,
      [
        "import fs from 'node:fs';",
        "const tmpPath = '/tmp/whatever.json';",
        '  fs.writeFileSync(tmpPath, data);',
        '',
      ].join('\n'),
    );
    const r = runLint('--root', sandbox);
    expect(r.code).toBe(0);
  });

  it('does NOT flag a state-dir write whose literal is a registered store', () => {
    const file = path.join(sandbox, 'OkRegistered.ts');
    writeFile(
      file,
      [
        "import fs from 'node:fs';",
        "  fs.writeFileSync(path.join(stateDir, 'config.json'), data);",
        '',
      ].join('\n'),
    );
    const r = runLint('--root', sandbox);
    expect(r.code).toBe(0);
  });
});

// Self-test for the credential-write funnel lint (Step 4b of live credential
// re-pointing, spec §2.2): a callsite that writes the Claude credential store
// directly bypasses the per-slot funnel lock and re-opens the clobber race —
// the lint must catch it (both the qualified-method primitives AND the raw
// `security -i` stdin form), must NOT false-positive on the OTHER keychain
// vaults (distinct services) or on comments, and must stay clean on the real tree.
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..');
const LINT_SCRIPT = path.join(REPO_ROOT, 'scripts', 'lint-no-unfunneled-credential-write.js');

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
    fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'credwrite-lint-'))),
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
        operation: 'tests/unit/lint-no-unfunneled-credential-write.test.ts:cleanup',
      });
    } catch {
      /* sandbox cleanup is best-effort */
    }
  }
});

describe('lint-no-unfunneled-credential-write (Step 4b)', () => {
  it('flags a direct defaultCredentialStore.write call', () => {
    const fixture = tmpFixture(
      `export function bad(home: string, raw: string) {\n` +
      `  return defaultCredentialStore.write(home, raw);\n` +
      `}\n`,
    );
    const result = runLint(fixture);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('defaultCredentialStore.write');
  });

  it('flags a direct provider.writeCredentials call', () => {
    const fixture = tmpFixture(
      `export async function bad(provider: any) {\n` +
      `  await provider.writeCredentials({ accessToken: 'sk-ant-oat0-x', expiresAt: 1 });\n` +
      `}\n`,
    );
    const result = runLint(fixture);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('writeCredentials');
  });

  it('flags the raw `security -i` stdin add-generic-password form for the guarded service', () => {
    const fixture = tmpFixture(
      `import { execFileSync } from 'node:child_process';\n` +
      `export function bad(hex: string) {\n` +
      `  execFileSync('security', ['-i'], {\n` +
      `    input: 'add-generic-password -U -a me -s "Claude Code-credentials" -X ' + hex + '\\n',\n` +
      `  });\n` +
      `}\n`,
    );
    const result = runLint(fixture);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('add-generic-password');
  });

  it('does NOT flag a raw add-generic-password to a DIFFERENT service (distinct vault)', () => {
    const fixture = tmpFixture(
      `import { execFileSync } from 'node:child_process';\n` +
      `export function ok(val: string) {\n` +
      `  // a different keychain service entirely — not the Claude credential store\n` +
      `  execFileSync('security', ['add-generic-password', '-s', 'Instar Worktree Vault', '-w', val]);\n` +
      `}\n`,
    );
    const result = runLint(fixture);
    expect(result.code).toBe(0);
  });

  it('does NOT flag comment-only mentions (documentation is not a bypass)', () => {
    const fixture = tmpFixture(
      `// never call provider.writeCredentials( directly — route through the funnel\n` +
      `/* defaultCredentialStore.write( and add-generic-password to "Claude Code-credentials" are forbidden */\n` +
      `export const x = 1;\n`,
    );
    const result = runLint(fixture);
    expect(result.code).toBe(0);
  });

  it('does NOT flag the funnel chokepoint method name (writeCredentialsSerialized)', () => {
    const fixture = tmpFixture(
      `import { writeCredentialsSerialized } from '../monitoring/CredentialProvider.js';\n` +
      `export async function ok(p: any) {\n` +
      `  await writeCredentialsSerialized(p, '/h/.claude', { accessToken: 't', expiresAt: 1 });\n` +
      `}\n`,
    );
    const result = runLint(fixture);
    expect(result.code).toBe(0);
  });

  it('the real tree is clean (all writers route through the funnel)', () => {
    const result = runLint();
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
  });

  it('the allowlist is closed to exactly the funnel, the primitive owners (incl. the Step-5 swap executor), and the lint itself', () => {
    const lintSource = fs.readFileSync(LINT_SCRIPT, 'utf8');
    const allowMatch = lintSource.match(/const ALLOWLIST = new Set\(\[([\s\S]*?)\]\);/);
    expect(allowMatch, 'ALLOWLIST block not found in lint script').not.toBeNull();
    const entries = [...allowMatch![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(entries.sort()).toEqual(
      [
        'scripts/lint-no-unfunneled-credential-write.js',
        'src/core/CredentialWriteFunnel.ts',
        'src/core/OAuthRefresher.ts',
        'src/monitoring/CredentialProvider.ts',
        // Step 5 (spec §2.3): owns the async-execFile keychain write primitive; every write runs
        // inside funnel.withSingleMover → withSlotLocks, so the funnel-routing is at the call layer.
        'src/core/CredentialSwapExecutor.ts',
      ].sort(),
    );
  });
});

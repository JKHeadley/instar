/**
 * Unit tests — CodexCliIntelligenceProvider.
 *
 * The provider spawns the codex binary with a specific arg shape:
 * model, sandbox mode, --cd, --skip-git-repo-check, then the prompt.
 * We use a tiny shell-script "fake codex" that echoes its argv so we
 * can assert the exact argument list without depending on an installed
 * codex binary.
 *
 * Regression-critical: the `--skip-git-repo-check` flag must be passed.
 * Without it, codex refuses to run when --cd points at any non-git
 * directory, which breaks every Codex-based agent whose state dir
 * isn't a git checkout.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexCliIntelligenceProvider } from '../../src/core/CodexCliIntelligenceProvider.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const FAKE_CODEX_SCRIPT = `#!/bin/sh
# Echo every argv as one line each, prefixed so we can parse it back.
for a in "$@"; do
  echo "ARG:$a"
done
echo "DONE"
exit 0
`;

let tmpDir: string;
let fakeCodexPath: string;
let nonGitDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-provider-test-'));
  fakeCodexPath = path.join(tmpDir, 'fake-codex');
  fs.writeFileSync(fakeCodexPath, FAKE_CODEX_SCRIPT, { mode: 0o755 });
  nonGitDir = path.join(tmpDir, 'not-a-git-repo');
  fs.mkdirSync(nonGitDir, { recursive: true });
});

afterAll(() => {
  SafeFsExecutor.safeRmSync(tmpDir, {
    recursive: true,
    force: true,
    operation: 'tests/unit/CodexCliIntelligenceProvider.test.ts:afterAll',
  });
});

function parseArgs(output: string): string[] {
  return output
    .split('\n')
    .filter(line => line.startsWith('ARG:'))
    .map(line => line.slice(4));
}

describe('CodexCliIntelligenceProvider — spawn args', () => {
  it('always passes --skip-git-repo-check so non-git state dirs work', async () => {
    const provider = new CodexCliIntelligenceProvider({
      codexPath: fakeCodexPath,
      workingDirectory: nonGitDir,
    });

    const stdout = await provider.evaluate('classify: refactor python helper');
    const args = parseArgs(stdout);

    expect(args).toContain('--skip-git-repo-check');
  });

  it('passes exec, --model, --sandbox, --cd, --skip-git-repo-check, then prompt as positional', async () => {
    const provider = new CodexCliIntelligenceProvider({
      codexPath: fakeCodexPath,
      workingDirectory: nonGitDir,
      sandboxMode: 'read-only',
    });

    const stdout = await provider.evaluate('classify: hello', { model: 'fast' });
    const args = parseArgs(stdout);

    expect(args[0]).toBe('exec');
    expect(args).toContain('--model');
    expect(args).toContain('--sandbox');
    expect(args).toContain('read-only');
    expect(args).toContain('--cd');
    expect(args).toContain(nonGitDir);
    expect(args).toContain('--skip-git-repo-check');
    // Prompt is the last positional.
    expect(args[args.length - 1]).toBe('classify: hello');
  });

  it('honors a custom sandbox mode', async () => {
    const provider = new CodexCliIntelligenceProvider({
      codexPath: fakeCodexPath,
      workingDirectory: nonGitDir,
      sandboxMode: 'workspace-write',
    });

    const stdout = await provider.evaluate('do thing');
    const args = parseArgs(stdout);
    const sandboxIdx = args.indexOf('--sandbox');
    expect(sandboxIdx).toBeGreaterThanOrEqual(0);
    expect(args[sandboxIdx + 1]).toBe('workspace-write');
  });

  it('returns stdout trimmed of trailing whitespace', async () => {
    const provider = new CodexCliIntelligenceProvider({
      codexPath: fakeCodexPath,
      workingDirectory: nonGitDir,
    });

    const stdout = await provider.evaluate('hi');
    // Our fake codex emits "ARG:exec\n…\nDONE\n" — final trim drops the trailing newline.
    expect(stdout.endsWith('\n')).toBe(false);
    expect(stdout.endsWith('DONE')).toBe(true);
  });

  it('rejects with a wrapped error when the codex binary exits non-zero', async () => {
    const failingScript = path.join(tmpDir, 'fail-codex');
    fs.writeFileSync(failingScript, '#!/bin/sh\necho "bad arg" >&2\nexit 2\n', { mode: 0o755 });
    const provider = new CodexCliIntelligenceProvider({
      codexPath: failingScript,
      workingDirectory: nonGitDir,
    });

    await expect(provider.evaluate('hi')).rejects.toThrow(/Codex CLI error/);
  });
});

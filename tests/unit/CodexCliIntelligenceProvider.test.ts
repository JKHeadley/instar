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

describe('CodexCliIntelligenceProvider — per-call timeout (IntelligenceOptions.timeoutMs)', () => {
  // Regression for the two-walls conformance-gate timeout bug
  // (docs/specs/conformance-gate-timeout.md): the provider used to hardcode the
  // execFile timeout at 30s and ignore the caller's budget. `timeout` is an
  // execFile option, not argv, so we assert it behaviorally with a slow fake.
  let slowCodexPath: string;

  beforeAll(() => {
    slowCodexPath = path.join(tmpDir, 'slow-codex');
    fs.writeFileSync(slowCodexPath, '#!/bin/sh\nsleep 1\necho "DONE"\nexit 0\n', { mode: 0o755 });
  });

  it('honors a short timeoutMs — kills a slow call (pre-fix this budget was ignored)', async () => {
    const provider = new CodexCliIntelligenceProvider({ codexPath: slowCodexPath, workingDirectory: nonGitDir });
    await expect(provider.evaluate('hi', { timeoutMs: 100 })).rejects.toThrow();
  });

  it('a generous timeoutMs lets the same slow call finish', async () => {
    const provider = new CodexCliIntelligenceProvider({ codexPath: slowCodexPath, workingDirectory: nonGitDir });
    await expect(provider.evaluate('hi', { timeoutMs: 5000 })).resolves.toContain('DONE');
  });

  it('without timeoutMs the 30s default is unchanged — a sub-default call still resolves', async () => {
    const provider = new CodexCliIntelligenceProvider({ codexPath: slowCodexPath, workingDirectory: nonGitDir });
    await expect(provider.evaluate('hi')).resolves.toContain('DONE');
  });
});

describe('CodexCliIntelligenceProvider — clean-call (no identity, no hooks)', () => {
  // Regression: judgment calls must NOT run in the agent's project dir, or
  // codex loads the full ~26 KB AGENTS.md identity and fires the project's
  // .codex/hooks.json (session_start / etc.) on every call. They must run in
  // an empty instar-managed scratch dir — the Codex analog of the Claude
  // provider's `--setting-sources user`.

  function cdValue(args: string[]): string | undefined {
    const i = args.indexOf('--cd');
    return i >= 0 ? args[i + 1] : undefined;
  }

  it('runs in the instar scratch dir, NOT the passed workingDirectory', async () => {
    const provider = new CodexCliIntelligenceProvider({
      codexPath: fakeCodexPath,
      workingDirectory: nonGitDir,
    });

    const args = parseArgs(await provider.evaluate('classify: hello'));
    const cd = cdValue(args);

    expect(cd).toBeDefined();
    expect(cd).not.toBe(nonGitDir);
    expect(cd).toContain('instar-codex-intel-scratch');
  });

  it('the scratch dir exists and is empty — no AGENTS.md, no .codex hooks dir', async () => {
    const provider = new CodexCliIntelligenceProvider({ codexPath: fakeCodexPath });

    const args = parseArgs(await provider.evaluate('hi'));
    const cd = cdValue(args)!;

    expect(fs.existsSync(cd)).toBe(true);
    const entries = fs.readdirSync(cd);
    expect(entries).not.toContain('AGENTS.md');
    expect(entries).not.toContain('.codex');
  });

  it('hard-disables project-doc loading via -c project_doc_max_bytes=0', async () => {
    const provider = new CodexCliIntelligenceProvider({ codexPath: fakeCodexPath });

    const args = parseArgs(await provider.evaluate('hi'));
    const ci = args.indexOf('-c');

    expect(ci).toBeGreaterThanOrEqual(0);
    expect(args[ci + 1]).toBe('project_doc_max_bytes=0');
  });

  it('uses the same scratch dir across calls (stable, not per-call)', async () => {
    const provider = new CodexCliIntelligenceProvider({ codexPath: fakeCodexPath });

    const cd1 = cdValue(parseArgs(await provider.evaluate('a')));
    const cd2 = cdValue(parseArgs(await provider.evaluate('b')));

    expect(cd1).toBe(cd2);
  });

  it('creates the scratch dir with private (0700) permissions — not group/other accessible', async () => {
    // Security: a world-accessible scratch dir under /tmp could let another
    // local user plant a .codex/hooks.json that codex would then fire. mkdtemp
    // creates 0700; assert it stays that way.
    const provider = new CodexCliIntelligenceProvider({ codexPath: fakeCodexPath });
    const cd = cdValue(parseArgs(await provider.evaluate('hi')))!;

    const mode = fs.statSync(cd).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it('uses an unguessable (random-suffixed) dir name, not a fixed path', async () => {
    // A fixed name under world-writable /tmp could be pre-created/symlinked by
    // an attacker. The mkdtemp suffix makes the path unpredictable.
    const provider = new CodexCliIntelligenceProvider({ codexPath: fakeCodexPath });
    const cd = cdValue(parseArgs(await provider.evaluate('hi')))!;

    expect(path.basename(cd)).toMatch(/^instar-codex-intel-scratch-.+/);
    expect(cd).not.toBe(path.join(os.tmpdir(), 'instar-codex-intel-scratch'));
  });

  it('recreates the scratch dir if a tmp-reaper deleted it mid-process', async () => {
    const provider = new CodexCliIntelligenceProvider({ codexPath: fakeCodexPath });

    const cd1 = cdValue(parseArgs(await provider.evaluate('a')))!;
    SafeFsExecutor.safeRmSync(cd1, {
      recursive: true,
      force: true,
      operation: 'tests/unit/CodexCliIntelligenceProvider.test.ts:tmp-reaper-recovery',
    });
    expect(fs.existsSync(cd1)).toBe(false);

    const cd2 = cdValue(parseArgs(await provider.evaluate('b')))!;
    expect(fs.existsSync(cd2)).toBe(true);
  });
});

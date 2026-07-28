import { describe, expect, it } from 'vitest';
import {
  runDevPreflight,
  type CommandResult,
  type DevPreflightRunner,
} from '../../src/commands/devPreflight.js';

class FixtureRunner implements DevPreflightRunner {
  readonly calls: Array<{ command: string; args: string[]; label: string }> = [];

  async run(command: string, args: string[], label: string): Promise<CommandResult> {
    this.calls.push({ command, args, label });
    return { command, args, exitCode: 0 };
  }
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('dev preflight command integration', () => {
  it('runs lint, discoverability tests, and reports advisory route warnings without failing', async () => {
    const runner = new FixtureRunner();
    let stdout = '';
    let stderr = '';

    const exitCode = await runDevPreflight({
      cwd: process.cwd(),
      runner,
      capabilityPrefixes: new Set(['capabilities']),
      diffProvider: () => '+router.post("/new-surface/create", handler);',
      output: {
        write: (text) => { stdout += text; },
        error: (text) => { stderr += text; },
      },
    });

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    const plainStdout = stripAnsi(stdout);
    expect(runner.calls.map((call) => [call.command, ...call.args])).toEqual([
      ['pnpm', 'lint'],
      [
        'npx',
        'vitest',
        'run',
        'tests/unit/capabilities-discoverability.test.ts',
        'tests/unit/CapabilityIndex.test.ts',
      ],
      // Test-runner bound self-disable ledger check (spec §2.6(b)) — runs the
      // same detector the pre-push hook uses, in --preflight mode.
      ['node', 'scripts/pre-push-test-runner-selfdisable.mjs', '--preflight'],
    ]);
    expect(plainStdout).toContain('lint: PASS');
    expect(plainStdout).toContain('capabilities-discoverability/CapabilityIndex: PASS');
    expect(plainStdout).toContain('/new-surface');
    expect(plainStdout).toContain('Tier-2 ship-gate checklist reminder');
  });

  it('returns nonzero when lint fails', async () => {
    const runner: DevPreflightRunner = {
      async run(command, args, label) {
        return { command, args, exitCode: label === 'lint' ? 1 : 0 };
      },
    };

    const exitCode = await runDevPreflight({
      runner,
      diffProvider: () => '',
      output: { write: () => {}, error: () => {} },
    });

    expect(exitCode).toBe(1);
  });
});

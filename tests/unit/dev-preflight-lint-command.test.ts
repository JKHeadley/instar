import { describe, expect, it } from 'vitest';
import { resolveLintCommand, runDevPreflight } from '../../src/commands/devPreflight.js';
import type { DevPreflightRunner } from '../../src/commands/devPreflight.js';

/**
 * `dev:preflight` hardcoded `pnpm lint`. CI installs with `npm ci` and never
 * installs pnpm, so the step failed to START there — reported as a lint
 * FAILURE, i.e. an environment gap rendered as a verdict about the code.
 */
describe('resolveLintCommand', () => {
  it('prefers pnpm when pnpm is usable', () => {
    expect(resolveLintCommand((c) => c === 'pnpm')).toEqual({
      command: 'pnpm',
      args: ['lint'],
    });
  });

  it('falls back to `npm run lint` when pnpm is absent', () => {
    expect(resolveLintCommand((c) => c === 'npm')).toEqual({
      command: 'npm',
      args: ['run', 'lint'],
    });
  });

  it('prefers pnpm over npm when both are usable', () => {
    expect(resolveLintCommand(() => true)).toEqual({
      command: 'pnpm',
      args: ['lint'],
    });
  });

  it('returns null when neither manager is usable', () => {
    expect(resolveLintCommand(() => false)).toBeNull();
  });
});

describe('preflight lint step when no package manager exists', () => {
  it('fails the run and says the check did not run — never reports a pass', async () => {
    const calls: string[] = [];
    const runner: DevPreflightRunner = {
      async run(command, args, label) {
        calls.push(label);
        return { command, args, exitCode: 0 };
      },
    };

    let stdout = '';
    let stderr = '';
    const exitCode = await runDevPreflight({
      runner,
      lintCommandResolver: () => null,
      diffProvider: () => '',
      output: {
        write: (t) => { stdout += t; },
        error: (t) => { stderr += t; },
      },
    });

    // The gap is reported as a gap, not swallowed.
    expect(stderr).toContain('no usable package manager');
    expect(stderr).toContain('DID NOT RUN');
    // And it is not laundered into a pass.
    expect(exitCode).not.toBe(0);
    expect(stdout).not.toContain('lint: PASS');
    // The lint step was never spawned, so no runner call carries its label.
    expect(calls).not.toContain('lint');
  });
});

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDevPreflight, aggregateExitCode, BODY_GATE_SCRIPTS } from '../../src/commands/devPreflight.js';
import type { DevPreflightRunner } from '../../src/commands/devPreflight.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

/**
 * `dev:preflight` verified the DIFF (lint, discoverability, route heuristic) and
 * was therefore structurally incapable of catching a gate that reads the PR
 * BODY. Measured consequence: the ELI16 description gate went red across three
 * separate sessions on work whose local lint was green the whole time — so
 * "I ran the gates locally" was true and still missed them, because the body
 * does not exist until `gh pr create` runs.
 *
 * These tests pin the two properties that make the fix worth having:
 *   1. supplying a body actually RUNS the body gates and their failure fails the run;
 *   2. omitting a body SKIPS them and never silently passes something unchecked.
 */

let dir: string;
let calls: Array<{ label: string; args: string[]; env?: NodeJS.ProcessEnv }>;

/** A cwd where both gate scripts exist, so existence checks find them. */
function makeRepo(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-body-'));
  fs.mkdirSync(path.join(d, 'scripts'), { recursive: true });
  for (const rel of Object.values(BODY_GATE_SCRIPTS)) {
    fs.writeFileSync(path.join(d, rel), '// stub\n');
  }
  return d;
}

function makeRunner(exitCodes: Record<string, number> = {}): DevPreflightRunner {
  return {
    async run(command, args, label, env) {
      calls.push({ label, args, env });
      return { command, args, exitCode: exitCodes[label] ?? 0 };
    },
  };
}

beforeEach(() => {
  dir = makeRepo();
  calls = [];
});

afterEach(() => {
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/dev-preflight-body-gates.test.ts' });
});

describe('dev:preflight — PR-body gates run when a body is supplied', () => {
  it('runs the ELI16 gate and passes the body through the environment', async () => {
    const bodyFile = path.join(dir, 'body.md');
    fs.writeFileSync(bodyFile, '## ELI16 — a plain-English summary\n\nreal content');

    await runDevPreflight({
      cwd: dir,
      runner: makeRunner(),
      lintCommandResolver: () => ({ command: 'npm', args: ['run', 'lint'] }),
      diffProvider: () => '',
      bodyPath: bodyFile,
      prTitle: 'feat: something',
      output: { write: () => {}, error: () => {} },
    });

    const eli16 = calls.find((c) => c.label.includes('ELI16'));
    expect(eli16).toBeDefined();
    // The gate reads PR_BODY from the environment — if it is not threaded, the
    // gate judges an empty string and passes vacuously.
    expect(eli16?.env?.PR_BODY).toContain('## ELI16');
    expect(eli16?.env?.PR_TITLE).toBe('feat: something');
  });

  it('runs the UX-impact gate with the body as an argument', async () => {
    const bodyFile = path.join(dir, 'body.md');
    fs.writeFileSync(bodyFile, 'body text');

    await runDevPreflight({
      cwd: dir,
      runner: makeRunner(),
      lintCommandResolver: () => ({ command: 'npm', args: ['run', 'lint'] }),
      diffProvider: () => '',
      bodyPath: bodyFile,
      output: { write: () => {}, error: () => {} },
    });

    const ux = calls.find((c) => c.label.includes('UX impact'));
    expect(ux).toBeDefined();
    expect(ux?.args).toContain('--body');
    expect(ux?.args).toContain('body text');
  });

  it('a failing body gate FAILS the whole preflight', async () => {
    const bodyFile = path.join(dir, 'body.md');
    fs.writeFileSync(bodyFile, 'no eli16 heading here');

    const exitCode = await runDevPreflight({
      cwd: dir,
      runner: makeRunner({ 'ELI16 PR-description gate': 1 }),
      lintCommandResolver: () => ({ command: 'npm', args: ['run', 'lint'] }),
      diffProvider: () => '',
      bodyPath: bodyFile,
      output: { write: () => {}, error: () => {} },
    });

    expect(exitCode).not.toBe(0);
  });

  it('CONTROL: with every gate green the run passes — so the failure above is the gate, not the harness', async () => {
    const bodyFile = path.join(dir, 'body.md');
    fs.writeFileSync(bodyFile, '## ELI16 — fine');

    const exitCode = await runDevPreflight({
      cwd: dir,
      runner: makeRunner(),
      lintCommandResolver: () => ({ command: 'npm', args: ['run', 'lint'] }),
      diffProvider: () => '',
      bodyPath: bodyFile,
      output: { write: () => {}, error: () => {} },
    });

    expect(exitCode).toBe(0);
  });
});

describe('dev:preflight — no body supplied', () => {
  it('SKIPS the body gates rather than failing them', async () => {
    let stdout = '';
    const exitCode = await runDevPreflight({
      cwd: dir,
      runner: makeRunner(),
      lintCommandResolver: () => ({ command: 'npm', args: ['run', 'lint'] }),
      diffProvider: () => '',
      output: { write: (t) => { stdout += t; }, error: () => {} },
    });

    // Running preflight BEFORE writing a description is exactly when it is most
    // useful; failing that would train people not to run it early.
    expect(exitCode).toBe(0);
    expect(calls.find((c) => c.label.includes('ELI16'))).toBeUndefined();
    // ...but the skip is VISIBLE. A silent skip reads identically to a pass,
    // which is the confusion this whole command exists to remove.
    expect(stdout).toContain('SKIPPED');
  });
});

describe('dev:preflight — an unreadable body is a failure, not a pass', () => {
  it('fails when --body points at a file that does not exist', async () => {
    let stderr = '';
    const exitCode = await runDevPreflight({
      cwd: dir,
      runner: makeRunner(),
      lintCommandResolver: () => ({ command: 'npm', args: ['run', 'lint'] }),
      diffProvider: () => '',
      bodyPath: path.join(dir, 'does-not-exist.md'),
      output: { write: () => {}, error: (t) => { stderr += t; } },
    });

    // The caller ASKED for these gates. Passing because we could not read the
    // body is the plausible-zero this command exists to prevent.
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('cannot read');
    expect(calls.find((c) => c.label.includes('ELI16'))).toBeUndefined();
  });
});

describe('aggregateExitCode — body gate participates', () => {
  const green = { lintExitCode: 0, discoverabilityExitCode: 0, routeWarnings: [] };

  it('fails when the body gate failed', () => {
    expect(aggregateExitCode({ ...green, bodyGateExitCode: 1 })).toBe(1);
  });

  it('passes when the body gate is absent (skipped)', () => {
    expect(aggregateExitCode({ ...green })).toBe(0);
  });

  it('passes when the body gate is green', () => {
    expect(aggregateExitCode({ ...green, bodyGateExitCode: 0 })).toBe(0);
  });
});

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { SafeGitExecutor } from '../core/SafeGitExecutor.js';
import { buildPrefixToKeyMap } from '../server/CapabilityIndex.js';

export interface CommandResult {
  command: string;
  args: string[];
  exitCode: number;
}

export interface DevPreflightRunner {
  run(command: string, args: string[], label: string): Promise<CommandResult>;
}

export interface DevPreflightOutput {
  write(text: string): void;
  error(text: string): void;
}

export interface DevPreflightOptions {
  cwd?: string;
  baseRef?: string;
  runner?: DevPreflightRunner;
  output?: DevPreflightOutput;
  capabilityPrefixes?: Set<string>;
  diffProvider?: () => string;
}

export interface RouteWarning {
  prefix: string;
  routes: string[];
}

export interface DevPreflightSummary {
  lintExitCode: number;
  discoverabilityExitCode: number;
  routeWarnings: RouteWarning[];
  heuristicUnavailable?: string;
  /**
   * Test-runner bound self-disable ledger check (spec
   * docs/specs/test-runner-concurrency-bound.md §2.6(b)). Optional so older
   * callers/summaries stay valid; absent means "check unavailable" and never
   * fails the preflight.
   */
  selfDisableExitCode?: number;
}

const DISCOVERABILITY_TEST_ARGS = [
  'vitest',
  'run',
  'tests/unit/capabilities-discoverability.test.ts',
  'tests/unit/CapabilityIndex.test.ts',
];

const ROUTE_METHODS = ['get', 'post', 'put', 'delete', 'patch'];
const ROUTE_REGISTRATION_PATTERN = new RegExp(
  String.raw`(?:app|router)\.(?:${ROUTE_METHODS.join('|')})\s*\(\s*['"]\/([a-z][a-z0-9-]*)[^'"]*['"]`,
  'g',
);

export class SpawnDevPreflightRunner implements DevPreflightRunner {
  constructor(private readonly cwd: string) {}

  run(command: string, args: string[], label: string): Promise<CommandResult> {
    return new Promise((resolve) => {
      process.stdout.write(`${pc.bold(label)}\n`);
      process.stdout.write(`$ ${[command, ...args].join(' ')}\n`);
      const child = spawn(command, args, {
        cwd: this.cwd,
        stdio: 'inherit',
        env: process.env,
      });
      child.on('error', (err) => {
        process.stderr.write(`${label} failed to start: ${err.message}\n`);
        resolve({ command, args, exitCode: 1 });
      });
      child.on('close', (code) => {
        resolve({ command, args, exitCode: code ?? 1 });
      });
    });
  }
}

export function extractAddedRoutePrefixes(diff: string): Map<string, string[]> {
  const prefixes = new Map<string, string[]>();
  for (const line of diff.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const added = line.slice(1);
    ROUTE_REGISTRATION_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ROUTE_REGISTRATION_PATTERN.exec(added)) !== null) {
      const prefix = match[1];
      const routes = prefixes.get(prefix) ?? [];
      routes.push(added.trim());
      prefixes.set(prefix, routes);
    }
  }
  return prefixes;
}

export function findMissingCapabilityPrefixes(
  diff: string,
  capabilityPrefixes: Set<string>,
): RouteWarning[] {
  const addedPrefixes = extractAddedRoutePrefixes(diff);
  const warnings: RouteWarning[] = [];
  for (const [prefix, routes] of addedPrefixes.entries()) {
    if (!capabilityPrefixes.has(prefix)) {
      warnings.push({ prefix, routes });
    }
  }
  return warnings.sort((a, b) => a.prefix.localeCompare(b.prefix));
}

export function aggregateExitCode(summary: DevPreflightSummary): number {
  return summary.lintExitCode === 0 &&
    summary.discoverabilityExitCode === 0 &&
    (summary.selfDisableExitCode ?? 0) === 0
    ? 0
    : 1;
}

/**
 * The shared serverless-host self-disable detector consumer (spec §2.6(b)).
 * dev:preflight SPAWNS the same script the pre-push hook runs so the
 * detection logic lives once (scripts/lib/test-runner-selfdisable-patterns
 * .mjs — plain ESM the hook can load without a built dist).
 *
 * Exit-code choice, documented (§2.6: "dev:preflight … MAY fail on the same
 * pattern"): in --preflight mode the script exits non-zero ONLY for the two
 * unambiguous self-disable signatures (sustained `off`; spoofed CI on a
 * non-CI host — both graded "like `off`" by the spec). Watch/cap/posture/arm
 * divergence WARN without failing. The pre-push surface of the same detector
 * is structurally WARN-only and never fails.
 */
export const SELF_DISABLE_CHECK_SCRIPT = 'scripts/pre-push-test-runner-selfdisable.mjs';

export function defaultCapabilityPrefixes(): Set<string> {
  return new Set(buildPrefixToKeyMap().keys());
}

function readDiffVsMain(cwd: string, explicitBaseRef?: string): string {
  const candidates = explicitBaseRef
    ? [explicitBaseRef]
    : ['JKHeadley/main', 'origin/main', 'upstream/main', 'main'];
  const errors: string[] = [];
  for (const candidate of candidates) {
    try {
      const base = SafeGitExecutor.readSync(['merge-base', 'HEAD', candidate], {
        cwd,
        operation: 'src/commands/devPreflight.ts:readDiffVsMain.merge-base',
        sourceTreeReadOk: true,
      }).trim();
      return SafeGitExecutor.readSync(['diff', '--unified=0', `${base}...HEAD`], {
        cwd,
        operation: 'src/commands/devPreflight.ts:readDiffVsMain.diff',
        sourceTreeReadOk: true,
        maxBuffer: 20 * 1024 * 1024,
      });
    } catch (err) {
      errors.push(`${candidate}: ${(err as Error).message.split('\n')[0]}`);
    }
  }
  throw new Error(errors.join('; '));
}

function printChecklist(output: DevPreflightOutput): void {
  output.write('\nTier-2 ship-gate checklist reminder:\n');
  output.write('- upgrades/next/<slug>.md with minor bump\n');
  output.write('- side-effects artifact with decision inventory\n');
  output.write('- ELI16 with verified tunnel/private-view link\n');
  output.write('- docs coverage updated and checked\n');
  output.write('- pnpm build before shipping\n');
}

function printHeuristic(output: DevPreflightOutput, summary: DevPreflightSummary): void {
  output.write('\nNew-surface route heuristic:\n');
  output.write('Advisory only. Best-effort regex over added diff lines; it is not an AST parser.\n');
  if (summary.heuristicUnavailable) {
    output.write(`${pc.yellow('WARN')} diff unavailable: ${summary.heuristicUnavailable}\n`);
    return;
  }
  if (summary.routeWarnings.length === 0) {
    output.write(`${pc.green('PASS')} no added route prefixes missing from CAPABILITY_INDEX\n`);
    return;
  }
  output.write(`${pc.yellow('WARN')} added route prefixes missing from CAPABILITY_INDEX:\n`);
  for (const warning of summary.routeWarnings) {
    output.write(`- /${warning.prefix}\n`);
    for (const route of warning.routes) {
      output.write(`  ${route}\n`);
    }
  }
}

export async function runDevPreflight(options: DevPreflightOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const output = options.output ?? {
    write: (text: string) => process.stdout.write(text),
    error: (text: string) => process.stderr.write(text),
  };
  const runner = options.runner ?? new SpawnDevPreflightRunner(cwd);

  output.write(`${pc.bold('Instar dev preflight')}\n`);
  output.write('Verify-only: this command never edits CapabilityIndex or server routes.\n\n');

  const lint = await runner.run('pnpm', ['lint'], 'lint');
  output.write('\n');
  const discoverability = await runner.run('npx', DISCOVERABILITY_TEST_ARGS, 'capabilities discoverability');

  // ── Test-runner bound: self-disable ledger check (spec §2.6(b)) ──────────
  // Runs the SAME detector script the pre-push hook uses, in --preflight mode
  // (see SELF_DISABLE_CHECK_SCRIPT for the documented exit-code choice).
  // Skipped quietly when the script is absent (e.g. an older checkout).
  let selfDisableExitCode: number | undefined;
  if (fs.existsSync(path.join(cwd, SELF_DISABLE_CHECK_SCRIPT))) {
    output.write('\n');
    const selfDisable = await runner.run(
      'node',
      [SELF_DISABLE_CHECK_SCRIPT, '--preflight'],
      'test-runner bound self-disable ledger check',
    );
    selfDisableExitCode = selfDisable.exitCode;
  }

  let routeWarnings: RouteWarning[] = [];
  let heuristicUnavailable: string | undefined;
  try {
    const diff = options.diffProvider ? options.diffProvider() : readDiffVsMain(cwd, options.baseRef);
    routeWarnings = findMissingCapabilityPrefixes(
      diff,
      options.capabilityPrefixes ?? defaultCapabilityPrefixes(),
    );
  } catch (err) {
    heuristicUnavailable = (err as Error).message;
  }

  const summary: DevPreflightSummary = {
    lintExitCode: lint.exitCode,
    discoverabilityExitCode: discoverability.exitCode,
    routeWarnings,
    heuristicUnavailable,
    selfDisableExitCode,
  };

  output.write('\nSummary:\n');
  output.write(`- lint: ${lint.exitCode === 0 ? pc.green('PASS') : pc.red('FAIL')}\n`);
  output.write(`- capabilities-discoverability/CapabilityIndex: ${discoverability.exitCode === 0 ? pc.green('PASS') : pc.red('FAIL')}\n`);
  if (selfDisableExitCode !== undefined) {
    output.write(
      `- test-runner self-disable ledger: ${selfDisableExitCode === 0 ? pc.green('PASS') : pc.red('FAIL')} (advisory WARN details above; fails only on sustained off/spoofed-CI)\n`,
    );
  }
  printHeuristic(output, summary);
  printChecklist(output);

  const exitCode = aggregateExitCode(summary);
  if (exitCode === 0) {
    output.write('\nPreflight complete: no blocking failures.\n');
  } else {
    output.error('\nPreflight failed: lint, discoverability tests, or the test-runner self-disable ledger check failed.\n');
  }
  return exitCode;
}

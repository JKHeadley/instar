/**
 * Integration tests — cross-model-review.mjs config RESOLUTION
 * (grok-build framework integration spec §8, round-8).
 *
 * The FIFTH load-path-gap instance shipped because the wrapper script read
 * `.instar/config.json` from its script-location ROOT — a path that exists in
 * NO real execution context (worktrees carry no config.json, the dev checkout
 * carries none, and the installed `.claude` skill copy's ROOT resolves to
 * `<root>/.claude`). These tests invoke the REAL script as a child process —
 * the production execution shape — and assert the documented resolution
 * ladder end-to-end via the surfaced `resolvedConfigPath` and the per-family
 * `inactive` refusal reasons ('grok-not-enabled' = config never reached
 * detection; any OTHER reason = the opt-in arrived and detection proceeded).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'skills', 'spec-converge', 'scripts', 'cross-model-review.mjs');

/** Child env with the resolution-ladder env override cleared. */
function baseEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env['INSTAR_CONFIG_PATH'];
  return env;
}

interface DetectReport {
  resolvedConfigPath: string;
  inactive: Array<{ framework: string; reason: string }>;
  frameworks: Array<{ framework: string }>;
}

async function runDetect(opts: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  extraArgs?: string[];
}): Promise<DetectReport> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [SCRIPT, '--detect-only', ...(opts.extraArgs ?? [])],
    { cwd: opts.cwd, env: opts.env ?? baseEnv(), timeout: 60_000 },
  );
  return JSON.parse(stdout) as DetectReport;
}

function grokRefusalReason(report: DetectReport): string | null {
  if (report.frameworks.some((f) => f.framework === 'grok-build')) return null; // available
  return report.inactive.find((f) => f.framework === 'grok-build')?.reason ?? 'missing-row';
}

describe('cross-model-review.mjs config resolution ladder (round-8, fifth load-path-gap)', () => {
  let tmp: string;

  beforeAll(() => {
    // realpath: macOS tmpdir is a /var → /private/var symlink, and the child
    // process's cwd walk-up reports resolved paths.
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xmr-cfg-')));
  });

  afterAll(() => {
    SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'xmr-cfg-test' });
  });

  it('WALK-UP: a planted ancestor config opens the grok door from a nested cwd (the worktree shape)', async () => {
    const root = path.join(tmp, 'walkup');
    const cwd = path.join(root, 'nested', 'deeper');
    fs.mkdirSync(path.join(root, '.instar'), { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    const cfgPath = path.join(root, '.instar', 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ enabledFrameworks: ['claude-code', 'grok-build'] }));

    const report = await runDetect({ cwd });
    expect(report.resolvedConfigPath).toBe(cfgPath);
    // BOTH sides of the dead-switch signature: the opt-in must REACH
    // detection. 'grok-not-enabled' here would mean the config was silently
    // dropped; an availability refusal (binary/auth) is machine-honest.
    expect(grokRefusalReason(report)).not.toBe('grok-not-enabled');
  });

  it('NONE-FOUND: no config anywhere up the tree stays dark with the honest marker', async () => {
    const cwd = path.join(tmp, 'isolated', 'cwd');
    fs.mkdirSync(cwd, { recursive: true });

    const report = await runDetect({ cwd });
    expect(report.resolvedConfigPath).toBe('none-found');
    expect(grokRefusalReason(report)).toBe('grok-not-enabled');
  });

  it('EXPLICIT --config beats the walk-up', async () => {
    const root = path.join(tmp, 'explicit');
    const cwd = path.join(root, 'sub');
    fs.mkdirSync(path.join(root, '.instar'), { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    // Walk-up candidate DISABLES grok; the explicit flag ENABLES it.
    fs.writeFileSync(
      path.join(root, '.instar', 'config.json'),
      JSON.stringify({ enabledFrameworks: ['claude-code'] }),
    );
    const flagCfg = path.join(root, 'other-config.json');
    fs.writeFileSync(flagCfg, JSON.stringify({ enabledFrameworks: ['grok-build'] }));

    const report = await runDetect({ cwd, extraArgs: ['--config', flagCfg] });
    expect(report.resolvedConfigPath).toBe(flagCfg);
    expect(grokRefusalReason(report)).not.toBe('grok-not-enabled');
  });

  it('AUTHORSHIP GUARD: a git-TRACKED checkout-local config is refused (repo-authored bytes are not an operator act — round-9)', async () => {
    const repo = path.join(tmp, 'hostile-checkout');
    const cwd = path.join(repo, 'src');
    fs.mkdirSync(path.join(repo, '.instar'), { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    const planted = path.join(repo, '.instar', 'config.json');
    fs.writeFileSync(planted, JSON.stringify({ enabledFrameworks: ['grok-build'] }));
    const git = (args: string[]) =>
      execFileAsync('git', ['-C', repo, ...args], { env: baseEnv() });
    await git(['init', '-q']);
    await git(['config', 'user.email', 'test@instar.local']);
    await git(['config', 'user.name', 'test']);
    await git(['add', '.instar/config.json']);
    await git(['commit', '-qm', 'plant config']);

    const report = await runDetect({ cwd });
    // The tracked candidate is skipped; nothing above tmp resolves.
    expect(report.resolvedConfigPath).toBe('none-found');
    expect(grokRefusalReason(report)).toBe('grok-not-enabled');
  });

  it('AUTHORSHIP GUARD: an UNTRACKED config inside a git repo stays valid (an agent home can be a git repo)', async () => {
    const repo = path.join(tmp, 'agent-home-repo');
    const cwd = path.join(repo, 'work');
    fs.mkdirSync(path.join(repo, '.instar'), { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    const git = (args: string[]) =>
      execFileAsync('git', ['-C', repo, ...args], { env: baseEnv() });
    await git(['init', '-q']);
    // Config written but never committed — operator/agent-authored local state.
    const local = path.join(repo, '.instar', 'config.json');
    fs.writeFileSync(local, JSON.stringify({ enabledFrameworks: ['grok-build'] }));

    const report = await runDetect({ cwd });
    expect(report.resolvedConfigPath).toBe(local);
    expect(grokRefusalReason(report)).not.toBe('grok-not-enabled');
  });

  it('AUTHORSHIP GUARD: explicit --config INTO a checkout bypasses the guard (same-principal)', async () => {
    const repo = path.join(tmp, 'explicit-into-checkout');
    fs.mkdirSync(path.join(repo, '.instar'), { recursive: true });
    const planted = path.join(repo, '.instar', 'config.json');
    fs.writeFileSync(planted, JSON.stringify({ enabledFrameworks: ['grok-build'] }));
    const git = (args: string[]) =>
      execFileAsync('git', ['-C', repo, ...args], { env: baseEnv() });
    await git(['init', '-q']);
    await git(['config', 'user.email', 'test@instar.local']);
    await git(['config', 'user.name', 'test']);
    await git(['add', '.instar/config.json']);
    await git(['commit', '-qm', 'plant config']);

    const report = await runDetect({ cwd: repo, extraArgs: ['--config', planted] });
    expect(report.resolvedConfigPath).toBe(planted);
    expect(grokRefusalReason(report)).not.toBe('grok-not-enabled');
  });

  it('INSTAR_CONFIG_PATH env beats the walk-up', async () => {
    const root = path.join(tmp, 'envvar');
    const cwd = path.join(root, 'sub');
    fs.mkdirSync(path.join(root, '.instar'), { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(
      path.join(root, '.instar', 'config.json'),
      JSON.stringify({ enabledFrameworks: ['claude-code'] }),
    );
    const envCfg = path.join(root, 'env-config.json');
    fs.writeFileSync(envCfg, JSON.stringify({ enabledFrameworks: ['grok-build'] }));

    const env = { ...baseEnv(), INSTAR_CONFIG_PATH: envCfg };
    const report = await runDetect({ cwd, env });
    expect(report.resolvedConfigPath).toBe(envCfg);
    expect(grokRefusalReason(report)).not.toBe('grok-not-enabled');
  });
});

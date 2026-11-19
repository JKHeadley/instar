/**
 * Always available: nothing starts a second copy (docs/specs/create-agent-accounts-and-always-on.md
 * §B.5). While a LaunchDaemon runs an agent, its record says `daemon: true`. Then the autostart
 * funnel, the fleet watchdog script, the restart command and the recovery engine all leave the
 * per-user LaunchAgent alone. With `daemon: false` (FileVault on, only pmset changed) or no record,
 * everything behaves as before.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  ALWAYS_AVAILABLE_REFUSAL, agentNameFromLabel, alwaysAvailableRefusal, daemonRunsAgent, readAlwaysAvailableRecord,
} from '../../src/core/alwaysAvailable.js';
import { installAutoStart } from '../../src/commands/setup.js';
import { takeLastAutoStartRefusal } from '../../src/core/ThrowawayAgentGuard.js';
import { LaunchdRecoveryControl } from '../../src/recovery/RecoveryEngine.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/always-available-guards.test.ts' }); });
const savedEnv = process.env.INSTAR_ALWAYS_AVAILABLE_DIR;
afterEach(() => { if (savedEnv === undefined) delete process.env.INSTAR_ALWAYS_AVAILABLE_DIR; else process.env.INSTAR_ALWAYS_AVAILABLE_DIR = savedEnv; });

function recordDir(records: Record<string, unknown | string>): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-records-'));
  dirs.push(d);
  for (const [name, body] of Object.entries(records)) fs.writeFileSync(path.join(d, `${name}.json`), typeof body === 'string' ? body : JSON.stringify(body));
  return d;
}
const env = (d: string) => ({ INSTAR_ALWAYS_AVAILABLE_DIR: d }) as NodeJS.ProcessEnv;

describe('the Always available record', () => {
  const d = recordDir({
    scout: { version: 1, agent: 'scout', daemon: true, daemonLabel: 'ai.instar.always.scout' },
    awake: { version: 1, agent: 'awake', daemon: false },
    broken: '{not json',
    mismatch: { version: 1, agent: 'someone-else', daemon: false },
    future: { version: 2, agent: 'future', daemon: false },
    odd: { version: 1, agent: 'odd', daemon: 'yes' },
  });

  it('daemon on: refuses the per-user start item, in plain words', () => {
    expect(daemonRunsAgent('scout', env(d))).toBe(true);
    expect(alwaysAvailableRefusal('scout', env(d))).toBe(ALWAYS_AVAILABLE_REFUSAL);
    expect(readAlwaysAvailableRecord('scout', env(d))).toMatchObject({ daemonLabel: 'ai.instar.always.scout' });
  });

  it('awake-only (FileVault on), or no record at all: nothing changes', () => {
    expect(daemonRunsAgent('awake', env(d))).toBe(false);
    expect(daemonRunsAgent('nobody', env(d))).toBe(false);
  });

  it('anything unclear counts as on: broken JSON, an unknown version, another agent\'s name, an odd daemon value', () => {
    for (const name of ['broken', 'future', 'mismatch', 'odd']) expect(daemonRunsAgent(name, env(d))).toBe(true);
  });

  const itNotRoot = process.getuid?.() === 0 ? it.skip : it;
  itNotRoot('a record or folder that cannot be read counts as on', () => {
    const locked = recordDir({ scout: { version: 1, agent: 'scout', daemon: false } });
    fs.chmodSync(path.join(locked, 'scout.json'), 0o000);
    expect(daemonRunsAgent('scout', env(locked))).toBe(true);
    fs.chmodSync(path.join(locked, 'scout.json'), 0o600);
    fs.chmodSync(locked, 0o000);
    try { expect(daemonRunsAgent('scout', env(locked))).toBe(true); } finally { fs.chmodSync(locked, 0o700); }
  });

  it('an agent name that could walk out of the folder is never read', () => {
    expect(readAlwaysAvailableRecord('../scout', env(d))).toBeNull();
    expect(readAlwaysAvailableRecord('..', env(d))).toBeNull();
  });

  it('reads the agent name from a per-user label, never the watchdog\'s', () => {
    expect(agentNameFromLabel('ai.instar.scout')).toBe('scout');
    expect(agentNameFromLabel('ai.instar.watchdog')).toBeNull();
    expect(agentNameFromLabel('com.other.thing')).toBeNull();
  });
});

describe('the autostart funnel', () => {
  const itDarwin = process.platform === 'darwin' ? it : it.skip;
  itDarwin('refuses while the daemon runs the agent, even with --force, and writes no plist', () => {
    process.env.INSTAR_ALWAYS_AVAILABLE_DIR = recordDir({ 'aa-funnel-test': { version: 1, agent: 'aa-funnel-test', daemon: true } });
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-project-'));
    dirs.push(project);
    expect(installAutoStart('aa-funnel-test', project, false, { force: true })).toBe(false);
    expect(takeLastAutoStartRefusal()).toBe(ALWAYS_AVAILABLE_REFUSAL);
    expect(fs.existsSync(path.join(os.homedir(), 'Library', 'LaunchAgents', 'ai.instar.aa-funnel-test.plist'))).toBe(false);
  });

  itDarwin('an update refreshing the boot wrapper (noStart) still refreshes it, and writes no plist', () => {
    process.env.INSTAR_ALWAYS_AVAILABLE_DIR = recordDir({ 'aa-funnel-test2': { version: 1, agent: 'aa-funnel-test2', daemon: true } });
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-project-'));
    dirs.push(project);
    fs.mkdirSync(path.join(project, '.instar'), { recursive: true });
    expect(installAutoStart('aa-funnel-test2', project, false, { noStart: true })).toBe(true);
    expect(takeLastAutoStartRefusal()).toBeNull();
    expect(fs.existsSync(path.join(project, '.instar', 'instar-boot.cjs'))).toBe(true);
    expect(fs.existsSync(path.join(os.homedir(), 'Library', 'LaunchAgents', 'ai.instar.aa-funnel-test2.plist'))).toBe(false);
  });
});

describe('the fleet watchdog script', () => {
  const script = fs.readFileSync(path.resolve(__dirname, '..', '..', 'src', 'templates', 'scripts', 'instar-watchdog.sh'), 'utf-8');
  // The exact skip block from the template, run on its own for each label.
  const start = script.indexOf('  aa_dir=');
  const second = script.indexOf('  if [ -e "$aa_record" ]; then', start);
  const block = script.slice(start, script.indexOf('\n  fi\n', second) + 5);

  it('the skip comes before anything that reloads a job', () => {
    expect(block).toContain('aa_record=');
    expect(script.indexOf('aa_record=')).toBeLessThan(script.indexOf('launchctl bootstrap', script.indexOf('for plist in')));
  });

  const run = (d: string) => {
    const loop = `set -euo pipefail\nfor label in ai.instar.scout ai.instar.awake ai.instar.other; do\n${block}\n  echo "checked $label"\ndone`;
    return spawnSync('bash', ['-c', loop], { env: { ...process.env, INSTAR_ALWAYS_AVAILABLE_DIR: d }, encoding: 'utf-8' });
  };

  it('skips a daemon-run agent, and still checks awake-only and unrecorded agents (under set -euo pipefail)', () => {
    const d = recordDir({ scout: { version: 1, agent: 'scout', daemon: true }, awake: { version: 1, agent: 'awake', daemon: false } });
    const r = run(d);
    // The same rule as the TypeScript reader: a future version or another agent's name counts as on.
    const v2 = recordDir({ scout: { version: 1, agent: 'scout', daemon: true }, awake: { version: 2, agent: 'awake', daemon: false } });
    expect(run(v2).stdout.trim().split('\n')).toEqual(['checked ai.instar.other']);
    const other = recordDir({ scout: { version: 1, agent: 'scout', daemon: true }, awake: { version: 1, agent: 'someone', daemon: false } });
    expect(run(other).stdout.trim().split('\n')).toEqual(['checked ai.instar.other']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split('\n')).toEqual(['checked ai.instar.awake', 'checked ai.instar.other']);
    // No record folder at all: every agent is checked as before.
    expect(run(path.join(d, 'missing')).stdout.trim().split('\n')).toHaveLength(3);
  });

  const itNotRoot = process.getuid?.() === 0 ? it.skip : it;
  itNotRoot('a record folder it cannot search skips every agent rather than reloading one', () => {
    const d = recordDir({ awake: { version: 1, agent: 'awake', daemon: false } });
    fs.chmodSync(d, 0o000);
    try {
      const r = run(d);
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
    } finally { fs.chmodSync(d, 0o700); }
  });
});

describe('the recovery engine', () => {
  it('will not reload a daemon-run agent\'s per-user job', async () => {
    process.env.INSTAR_ALWAYS_AVAILABLE_DIR = recordDir({ scout: { version: 1, agent: 'scout', daemon: true } });
    const control = new LaunchdRecoveryControl({ serviceLabel: 'ai.instar.scout' } as never);
    await expect(control.start()).rejects.toThrow('recovery-always-available-daemon');
  });
});

/**
 * Verifies the codex-agent detection that setup-autonomous.sh uses to enable native /goal
 * auto-delegation for codex (#40). The script's claude-version gate is empty for a codex
 * agent, so it falls back to this config-enabledFrameworks check. This tests both sides of
 * the decision boundary: a codex agent enables native /goal; a Claude agent does not.
 *
 * The detection is the exact python one-liner embedded in setup-autonomous.sh:
 *   'codex-cli' in (config.enabledFrameworks or [])  → '1' (enable) else '0' (skip)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

// The exact expression from setup-autonomous.sh (run with cwd = the agent dir).
const DETECT =
  "import json;print('1' if 'codex-cli' in (json.load(open('.instar/config.json')).get('enabledFrameworks') or []) else '0')";

function detect(dir: string): string {
  const r = spawnSync('python3', ['-c', DETECT], { cwd: dir, encoding: 'utf-8', timeout: 5000 });
  return (r.stdout || '').trim();
}

function writeConfig(dir: string, config: object): void {
  fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.instar', 'config.json'), JSON.stringify(config));
}

describe('setup-autonomous.sh codex detection (#40 native /goal auto-wire)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-detect-')); });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/autonomous-codex-native-goal-detection.test.ts' });
  });

  it('enables (1) for a codex agent (enabledFrameworks includes codex-cli)', () => {
    writeConfig(dir, { enabledFrameworks: ['codex-cli'], frameworkBinaryPaths: { 'codex-cli': '/x/codex' } });
    expect(detect(dir)).toBe('1');
  });

  it('does NOT enable (0) for a Claude agent (no codex-cli)', () => {
    writeConfig(dir, { enabledFrameworks: ['claude-code'] });
    expect(detect(dir)).toBe('0');
  });

  it('does NOT enable (0) when enabledFrameworks is absent', () => {
    writeConfig(dir, { port: 4042 });
    expect(detect(dir)).toBe('0');
  });

  it('enables (1) for a multi-framework agent that includes codex-cli', () => {
    writeConfig(dir, { enabledFrameworks: ['claude-code', 'codex-cli'] });
    expect(detect(dir)).toBe('1');
  });

  it('does NOT throw (best-effort 0) when config.json is missing', () => {
    // No config written — the embedded one-liner is wrapped in `|| echo "0"` in the script;
    // here the python errors, so stdout is empty → the script treats it as not-codex.
    expect(detect(dir)).toBe('');
  });
});

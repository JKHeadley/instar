import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { SecretStore } from '../../src/core/SecretStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

// Spec agent-held-google-passkey §6 Increment 1: generic reads of prototype
// passkey keys stay ALLOWED (the operator-run prototype scripts depend on them)
// but each read is logged — key name only, never the value.

describe('secret-get.mjs — prototype passkey reads are allowed and logged', () => {
  let tmpDir: string;
  let stateDir: string;
  const scriptSrc = path.resolve(__dirname, '../../src/templates/scripts/secret-get.mjs');
  const logPath = () => path.join(stateDir, 'logs', 'passkey-legacy-reads.jsonl');

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-get-pk-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.symlinkSync(path.resolve(__dirname, '../../dist'), path.join(tmpDir, 'dist'));
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/secret-get-legacy-passkey-read-log.test.ts:afterEach' });
  });

  const run = (args: string[]) => spawnSync(process.execPath, [scriptSrc, ...args], {
    cwd: tmpDir, encoding: 'utf8', env: { ...process.env, VITEST: '1' },
  });

  it('returns the prototype key value and records one audit line without the value', () => {
    new SecretStore({ stateDir }).write({ google_passkey_echo_studio: 'PRIVATE-KEY-MATERIAL', other: 'x' });
    const r = run(['google_passkey_echo_studio']);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('PRIVATE-KEY-MATERIAL');
    const lines = fs.readFileSync(logPath(), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]);
    expect(rec.key).toBe('google_passkey_echo_studio');
    expect(rec.mode).toBe('stdout');
    expect(fs.readFileSync(logPath(), 'utf8')).not.toContain('PRIVATE-KEY-MATERIAL');
  });

  it('does not log reads of ordinary keys', () => {
    new SecretStore({ stateDir }).write({ github_token: 'ghp_x' });
    const r = run(['github_token']);
    expect(r.status).toBe(0);
    expect(fs.existsSync(logPath())).toBe(false);
  });
});

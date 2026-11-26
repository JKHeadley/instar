// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { SecretStore } from '../../src/core/SecretStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';

// secret-set.mjs is the write half of the no-echo transfer the Gemini pay-per-use
// lane names (docs/specs/gemini-payg-metered-lane.md §4):
//   secret-drop-retrieve.mjs <token> <field> --run -- node .instar/scripts/secret-set.mjs gemini_api_key_payg
// The spec named the script, but it did not exist; the user-role live test found it.

describe('secret-set.mjs — stdin-only vault write', () => {
  let tmpDir: string;
  let stateDir: string;
  const scriptSrc = path.resolve(__dirname, '../../src/templates/scripts/secret-set.mjs');
  const VALUE = 'AIzaSy-SECRET-SET-TEST-VALUE-0123456789';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-set-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.symlinkSync(path.resolve(__dirname, '../../dist'), path.join(tmpDir, 'dist'));
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/secret-set-script.test.ts:afterEach' });
  });

  const run = (args: string[], input?: string) => spawnSync(process.execPath, [scriptSrc, ...args], {
    cwd: tmpDir, encoding: 'utf8', input: input ?? '', env: { ...process.env, VITEST: '1' },
  });

  it('stores the stdin value under the key, printing nothing to stdout and only the length to stderr', () => {
    const r = run(['gemini_api_key_payg'], `${VALUE}\n`);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('gemini_api_key_payg');
    expect(r.stderr).toContain(`${VALUE.length} chars`);
    expect(r.stderr).not.toContain(VALUE);
    expect(new SecretStore({ stateDir }).get('gemini_api_key_payg')).toBe(VALUE);
  });

  it('removes exactly one trailing newline (\\n or \\r\\n) and nothing else', () => {
    expect(run(['a'], `  ${VALUE}\r\n`).status).toBe(0);
    expect(new SecretStore({ stateDir }).get('a')).toBe(`  ${VALUE}`);
    expect(run(['b'], `${VALUE}\n\n`).status).toBe(0);
    expect(new SecretStore({ stateDir }).get('b')).toBe(`${VALUE}\n`);
  });

  it('keeps the other vault entries and overwrites the named one', () => {
    new SecretStore({ stateDir }).write({ github_token: 'ghp_keep', gemini_api_key_payg: 'old' });
    expect(run(['gemini_api_key_payg'], VALUE).status).toBe(0);
    const s = new SecretStore({ stateDir });
    expect(s.get('github_token')).toBe('ghp_keep');
    expect(s.get('gemini_api_key_payg')).toBe(VALUE);
  });

  it('refuses an empty value and writes nothing', () => {
    const r = run(['gemini_api_key_payg'], '\n');
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(fs.existsSync(path.join(stateDir, 'secrets', 'config.secrets.enc'))).toBe(false);
  });

  it('refuses a value on argv (a second argument) and an invalid key path, writing nothing', () => {
    // Credential-shaped fixtures are assembled at run time (fake values; no literal key in the source).
    const unspacedKey = ['AI', 'za', 'SyD4fakeFAKEfake0123456789abcdefGHI'].join('');
    const ghLike = ['gh', 'p_', '0123456789abcdefABCDEF0123456789abcd'].join('');
    const mixed = ['Ab1Cd2Ef3Gh4', 'Ij5Kl6Mn7Op8', 'Qr9St0Uv1Wx2'].join('');
    for (const args of [['gemini_api_key_payg', VALUE], [], ['has space'], ['../escape'], [VALUE.replace(/-/g, ' ')], [unspacedKey], [ghLike], ['k'.repeat(65)], [mixed]]) {
      const r = run(args, VALUE);
      expect(r.status).toBe(2);
      expect(r.stdout).toBe('');
      expect(r.stderr).not.toContain(VALUE);
      expect(r.stderr).not.toContain(unspacedKey);
    }
    expect(fs.existsSync(path.join(stateDir, 'secrets', 'config.secrets.enc'))).toBe(false);
  });

  it('refuses to read the value from a terminal (it would echo it and wait for input)', () => {
    const src = fs.readFileSync(scriptSrc, 'utf8');
    // A TTY cannot be given to a spawned child here; the guard is pinned at its source and
    // ordered before stdin is read or the vault is touched.
    const tty = src.indexOf('if (process.stdin.isTTY)');
    expect(tty).toBeGreaterThan(0);
    expect(tty).toBeLessThan(src.indexOf('fs.readFileSync(0)'));
    expect(tty).toBeLessThan(src.indexOf('new SecretStore('));
  });

  it('is installed (and overwritten) on every update by the migrator, byte-for-byte the template (migration parity)', () => {
    const m = new PostUpdateMigrator({ projectDir: tmpDir, stateDir, port: 4042, hasTelegram: false, projectName: 'test-agent' });
    const target = path.join(stateDir, 'scripts', 'secret-set.mjs');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '// stale\n');
    const result = { upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] };
    (m as unknown as { migrateScripts(r: typeof result): void }).migrateScripts(result);
    expect(result.errors.filter((e) => e.includes('secret-set'))).toEqual([]);
    expect(fs.readFileSync(target, 'utf8')).toBe(fs.readFileSync(scriptSrc, 'utf8'));
    expect(result.upgraded.some((u) => u.includes('secret-set.mjs'))).toBe(true);
  });

  it('is shipped by init for new agents', () => {
    const init = fs.readFileSync(path.resolve(__dirname, '../../src/commands/init.ts'), 'utf8');
    expect(init).toMatch(/function installSecretSet\(projectDir: string\)/);
    expect((init.match(/installSecretSet\(projectDir\);/g) ?? []).length).toBe(2);
  });
});

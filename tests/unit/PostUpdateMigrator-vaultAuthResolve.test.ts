// safe-git-allow: reads one immutable historical hook blob to prove exact-hash migration.
// safe-fs-allow: test file — SafeFsExecutor removes only the per-test tmpdir.
/**
 * PostUpdateMigrator — VAULT_AUTH_RESOLVE marker bumps (Migration Parity).
 *
 * installAutonomousSkill() is install-if-missing, so existing agents only get
 * the vault-aware auth fix through these migrations:
 *   - setup-autonomous.sh: fingerprint-gated re-deploy (W32_PREPARING_LIVENESS
 *     lineage → new bundled bytes);
 *   - autonomous-stop-hook.sh: exact-stock-hash re-deploy (the
 *     PREPARATION_CARRIER-era bytes, pinned by SHA-256).
 * Customized copies must be left untouched in both cases.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  AUTONOMOUS_STOP_HOOK_PREPARATION_CARRIER_SHA256,
  PostUpdateMigrator,
} from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import crypto from 'node:crypto';

type Result = { upgraded: string[]; skipped: string[]; errors: string[] };
const HOOK_REL = path.join('.claude', 'skills', 'autonomous', 'hooks', 'autonomous-stop-hook.sh');
const SETUP_REL = path.join('.claude', 'skills', 'autonomous', 'scripts', 'setup-autonomous.sh');
// The last commit whose bundled stop hook is the PREPARATION_CARRIER-era stock.
const PREPARATION_CARRIER_COMMIT = '5fe5d87e1f60747ff903ee15bf38d87b02a6361b';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'vault-auth-migration-test.cleanup' });
  }
});

function makeProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-auth-mig-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
  return dir;
}

function run(projectDir: string): Result {
  const migrator = new PostUpdateMigrator({
    projectDir, stateDir: path.join(projectDir, '.instar'), port: 4040,
    hasTelegram: false, projectName: 'test',
  });
  const result: Result = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateAutonomousStopHookTopicKeyed(r: Result): void }).migrateAutonomousStopHookTopicKeyed(result);
  return result;
}

function deploy(projectDir: string, rel: string, content: string | Buffer): string {
  const dst = path.join(projectDir, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, content);
  return dst;
}

// The genuine W32-era stock setup — the real bundled bytes from the last
// pre-VAULT_AUTH_RESOLVE commit, so every earlier marker is present and only
// the new bump fires (exactly what a current fleet agent carries).
const PRIOR_SETUP = execFileSync('git', ['show', `${PREPARATION_CARRIER_COMMIT}:.claude/skills/autonomous/scripts/setup-autonomous.sh`]).toString();

describe('setup-autonomous.sh VAULT_AUTH_RESOLVE marker bump', () => {
  it('re-deploys a W32-era stock setup and is idempotent', () => {
    const projectDir = makeProject();
    const dst = deploy(projectDir, SETUP_REL, PRIOR_SETUP);
    expect(PRIOR_SETUP).toContain('W32_PREPARING_LIVENESS');
    expect(PRIOR_SETUP).not.toContain('VAULT_AUTH_RESOLVE');
    const first = run(projectDir);
    expect(first.errors).toEqual([]);
    expect(first.upgraded).toContain('skills/autonomous/scripts/setup-autonomous.sh (vault-aware auth + loud registration refusal)');
    const upgraded = fs.readFileSync(dst, 'utf8');
    expect(upgraded).toContain('VAULT_AUTH_RESOLVE');
    expect(upgraded).toContain('resolve_auth_token()');
    expect(upgraded).not.toContain(`REG_AUTH=$(python3`);
    const second = run(projectDir);
    expect(fs.readFileSync(dst, 'utf8')).toBe(upgraded);
    expect(second.upgraded).not.toContain('skills/autonomous/scripts/setup-autonomous.sh (vault-aware auth + loud registration refusal)');
  });

  it('leaves a customized setup untouched', () => {
    const projectDir = makeProject();
    const custom = '#!/bin/bash\n# operator-customized setup, no stock fingerprint\n';
    const dst = deploy(projectDir, SETUP_REL, custom);
    run(projectDir);
    expect(fs.readFileSync(dst, 'utf8')).toBe(custom);
  });
});

describe('autonomous-stop-hook.sh VAULT_AUTH_RESOLVE exact-hash upgrade', () => {
  it('the pinned predecessor hash matches the PREPARATION_CARRIER-era blob', () => {
    const blob = execFileSync('git', ['show', `${PREPARATION_CARRIER_COMMIT}:.claude/skills/autonomous/hooks/autonomous-stop-hook.sh`]);
    const sha = crypto.createHash('sha256').update(blob).digest('hex');
    expect(sha).toBe(AUTONOMOUS_STOP_HOOK_PREPARATION_CARRIER_SHA256);
  });

  it('re-deploys the exact PREPARATION_CARRIER stock hook and is idempotent', () => {
    const blob = execFileSync('git', ['show', `${PREPARATION_CARRIER_COMMIT}:.claude/skills/autonomous/hooks/autonomous-stop-hook.sh`]);
    const projectDir = makeProject();
    const dst = deploy(projectDir, HOOK_REL, blob);
    const first = run(projectDir);
    expect(first.errors).toEqual([]);
    expect(first.upgraded).toContain('skills/autonomous/hooks/autonomous-stop-hook.sh (vault-aware bearer-token resolution)');
    const upgraded = fs.readFileSync(dst, 'utf8');
    expect(upgraded).toContain('VAULT_AUTH_RESOLVE');
    expect(upgraded).toContain('resolve_auth_token()');
    expect(upgraded).not.toContain(`auth=$(python3 -c "import json;print(json.load(open('.instar/config.json')).get('authToken',''))"`);
    const mode = fs.statSync(dst).mode & 0o777;
    expect(mode & 0o111).not.toBe(0); // stays executable
    const second = run(projectDir);
    expect(fs.readFileSync(dst, 'utf8')).toBe(upgraded);
  });

  it('refuses a customized hook (unknown bytes) with a named skip, not an overwrite', () => {
    const projectDir = makeProject();
    const custom = '#!/bin/bash\n# Autonomous Mode Stop Hook\n# operator customization: do not erase\nexit 0\n';
    const dst = deploy(projectDir, HOOK_REL, custom);
    const result = run(projectDir);
    expect(fs.readFileSync(dst, 'utf8')).toBe(custom);
    expect(result.skipped.some((s) => s.includes('no exact stock hash for vault-auth upgrade'))).toBe(true);
  });
});

/**
 * Verifies PostUpdateMigrator.migrateSubscriptionPoolInteractiveReady — the
 * one-time sweep that seeds interactive onboarding flags into EXISTING
 * claude-code subscription-pool config homes (2026-06-09 incident: pool homes
 * enrolled via headless `claude auth login` had tokens but not the
 * first-launch flags, so pinned/swapped interactive sessions wedged on
 * onboarding screens).
 *
 * Migration Parity Standard: new enrollments get seeding via
 * EnrollmentWizard.complete(); this migration is the only path for homes
 * enrolled BEFORE the fix. Covers both sides of every boundary: no store,
 * no claude accounts, headless home patched, ready home skipped, missing
 * home skipped (no $HOME littering), corrupt config reported as error with
 * bytes preserved, idempotency, and oauthAccount preservation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SubscriptionPool } from '../../src/core/SubscriptionPool.js';
import { INTERACTIVE_ONBOARDING_FLAGS } from '../../src/core/ensureInteractiveReady.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

describe('PostUpdateMigrator — subscription-pool interactive-ready sweep', () => {
  let projectDir: string;
  let stateDir: string;

  function newMigrator(): PostUpdateMigrator {
    return new PostUpdateMigrator({
      projectDir,
      stateDir,
      port: 4042,
      hasTelegram: false,
      projectName: 'test',
    });
  }

  function runMigration(): MigrationResult {
    const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
    (newMigrator() as unknown as {
      migrateSubscriptionPoolInteractiveReady(r: MigrationResult): void;
    }).migrateSubscriptionPoolInteractiveReady(result);
    return result;
  }

  function addAccount(id: string, configHome: string, framework: 'claude-code' | 'codex-cli' = 'claude-code') {
    const pool = new SubscriptionPool({ stateDir });
    pool.add({
      id,
      nickname: id,
      provider: framework === 'claude-code' ? 'anthropic' : 'openai',
      framework,
      configHome,
    });
  }

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-pool-ready-'));
    stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-subscriptionPoolInteractiveReady.test.ts:cleanup',
    });
  });

  it('skips cleanly when no subscription-pool store exists (dark default)', () => {
    const r = runMigration();
    expect(r.upgraded).toEqual([]);
    expect(r.errors).toEqual([]);
    expect(r.skipped.some((s) => s.includes('no pool store'))).toBe(true);
  });

  it('skips when the pool has no claude-code accounts', () => {
    addAccount('codex-1', path.join(projectDir, '.codex-home'), 'codex-cli');
    const r = runMigration();
    expect(r.upgraded).toEqual([]);
    expect(r.skipped.some((s) => s.includes('no claude-code accounts'))).toBe(true);
  });

  it('seeds the flags into a headless-enrolled home, preserving oauthAccount', () => {
    const home = path.join(projectDir, '.claude-sagemind');
    fs.mkdirSync(home);
    const oauthAccount = { accountUuid: 'u-1', emailAddress: 'a@b.c' };
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount }));
    addAccount('sagemind-justin', home);

    const r = runMigration();
    expect(r.errors).toEqual([]);
    expect(r.upgraded.some((s) => s.includes('sagemind-justin'))).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf-8'));
    for (const f of INTERACTIVE_ONBOARDING_FLAGS) expect(cfg[f]).toBe(true);
    expect(cfg.oauthAccount).toEqual(oauthAccount);
  });

  it('is idempotent: a second run reports the home as already ready', () => {
    const home = path.join(projectDir, '.claude-sagemind');
    fs.mkdirSync(home);
    addAccount('sagemind-justin', home);

    expect(runMigration().upgraded.length).toBe(1);
    const second = runMigration();
    expect(second.upgraded).toEqual([]);
    expect(second.errors).toEqual([]);
    expect(second.skipped.some((s) => s.includes('already interactive-ready'))).toBe(true);
  });

  it('leaves a stale registry entry alone (missing home is skipped, not created)', () => {
    const home = path.join(projectDir, '.claude-gone');
    addAccount('stale-acct', home);
    const r = runMigration();
    expect(r.errors).toEqual([]);
    expect(r.skipped.some((s) => s.includes('does not exist'))).toBe(true);
    expect(fs.existsSync(home)).toBe(false);
  });

  it('reports a corrupt .claude.json as an error and preserves its bytes', () => {
    const home = path.join(projectDir, '.claude-corrupt');
    fs.mkdirSync(home);
    const corrupt = '{"oauthAccount": TRUNCATED';
    fs.writeFileSync(path.join(home, '.claude.json'), corrupt);
    addAccount('corrupt-acct', home);

    const r = runMigration();
    expect(r.errors.some((e) => e.includes('corrupt-acct'))).toBe(true);
    expect(fs.readFileSync(path.join(home, '.claude.json'), 'utf-8')).toBe(corrupt);
  });

  it('one bad home never aborts the sweep (the good home still gets seeded)', () => {
    const bad = path.join(projectDir, '.claude-bad');
    fs.mkdirSync(bad);
    fs.writeFileSync(path.join(bad, '.claude.json'), 'NOT JSON');
    addAccount('bad-acct', bad);
    const good = path.join(projectDir, '.claude-good');
    fs.mkdirSync(good);
    addAccount('good-acct', good);

    const r = runMigration();
    expect(r.errors.some((e) => e.includes('bad-acct'))).toBe(true);
    expect(r.upgraded.some((s) => s.includes('good-acct'))).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(path.join(good, '.claude.json'), 'utf-8'));
    for (const f of INTERACTIVE_ONBOARDING_FLAGS) expect(cfg[f]).toBe(true);
  });

  it('is wired into the full migrate() pass (not just callable in isolation)', () => {
    const home = path.join(projectDir, '.claude-sagemind');
    fs.mkdirSync(home);
    addAccount('sagemind-justin', home);
    const result = newMigrator().migrate();
    expect(result.upgraded.some((s) => s.includes('subscription-pool interactive-ready: sagemind-justin'))).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf-8'));
    for (const f of INTERACTIVE_ONBOARDING_FLAGS) expect(cfg[f]).toBe(true);
  });
});

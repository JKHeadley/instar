/**
 * Tier-2 integration tests for the suppressed-duplicate honesty MIGRATION.
 *
 * Per the Migration Parity Standard (CLAUDE.md), an instar agent updates in
 * place: a template-only change reaches ONLY newly created agents. Every agent
 * that already exists keeps the version on its disk unless the SHA-history
 * migrator recognises it. That recognition is the whole deliverable here — the
 * seven-line script fix is inert in the field without it.
 *
 * These tests drive the REAL `migrateScripts()` against a real script already
 * on disk, in both deployed locations, and pin the three branches the migrator
 * distinguishes: known-shipped (upgrade), already-current (no-op), and
 * locally-modified (preserve + `.new` candidate).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

const TEMPLATE = path.resolve('src/templates/scripts/telegram-reply.sh');
const PRE_SUPPRESSION_FIX_FIXTURE = path.resolve(
  'tests/fixtures/relay-history/telegram-reply-pre-suppression.sh',
);

/**
 * The SHA registered by the suppressed-duplicate honesty fix — the version
 * shipped immediately BEFORE that fix.
 */
const PRIOR_SHIPPED_SHA =
  '4464581188f5c736a62edac5e6a2edecfcfcd365557a18e514b741731bed6e0b';

/**
 * The SHA registered by the decision-ref preservation fix — the version shipped
 * immediately BEFORE that fix.
 */
const DECISION_REF_CORRUPT_SHIPPED_SHA =
  '74ee09b4d4d537ddfe032f3192cab08b4f2f956fdb1e1b3ccd94b26dc218fb52';

const SUPPRESSION_MARKER = 'suppressedDuplicate';

/**
 * Read the actual pre-fix shipped script from a pinned fixture. This must not
 * be reconstructed from today's template: later unrelated template changes
 * would create a synthetic version that never shipped.
 */
function priorShippedContent(): string {
  return fs.readFileSync(PRE_SUPPRESSION_FIX_FIXTURE, 'utf-8');
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function createMigrator(projectDir: string): PostUpdateMigrator {
  return new PostUpdateMigrator({
    projectDir,
    stateDir: path.join(projectDir, '.instar'),
    port: 4042,
    hasTelegram: true,
    projectName: 'test-agent',
  });
}

function runMigrateScripts(m: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (m as unknown as { migrateScripts(r: MigrationResult): void }).migrateScripts(result);
  return result;
}

describe('suppressed-duplicate honesty — post-update migration', () => {
  let projectDir: string;
  let claudePath: string;
  let neutralPath: string;
  let backupsDir: string;

  /** Stand up an agent that ALREADY EXISTS, running the pre-fix relay. */
  function deployPriorShippedAgent(content = priorShippedContent()): void {
    for (const p of [claudePath, neutralPath]) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, { mode: 0o755 });
    }
  }

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-suppressed-dup-migration-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudePath = path.join(projectDir, '.claude', 'scripts', 'telegram-reply.sh');
    neutralPath = path.join(projectDir, '.instar', 'scripts', 'telegram-reply.sh');
    backupsDir = path.join(projectDir, '.instar', 'backups');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/integration/telegram-reply-suppressed-duplicate-migration.test.ts',
    });
  });

  it('registers the EXACT deployed relay shas this migration must reach', () => {
    // If either membership check fails, a real deployed stock script is treated
    // as unknown/user-modified and the update path only writes a `.new` file.
    expect(sha256(priorShippedContent())).toBe(PRIOR_SHIPPED_SHA);
    expect(PostUpdateMigrator.TELEGRAM_REPLY_PRIOR_SHIPPED_SHAS.has(PRIOR_SHIPPED_SHA)).toBe(true);
    expect(PostUpdateMigrator.TELEGRAM_REPLY_PRIOR_SHIPPED_SHAS.has(DECISION_REF_CORRUPT_SHIPPED_SHA)).toBe(true);
  });

  it('the pre-fix script genuinely lacks the fix (the "before" state is real)', () => {
    const prior = priorShippedContent();
    expect(prior).not.toContain(SUPPRESSION_MARKER);
    expect(prior).toContain('Sent $(echo "$MSG" | wc -c | tr -d \' \') chars to topic $TOPIC_ID');
  });

  it('patches a pre-fix script already on disk, in BOTH deployed locations', () => {
    deployPriorShippedAgent();
    const template = fs.readFileSync(TEMPLATE, 'utf-8');

    const result = runMigrateScripts(createMigrator(projectDir));

    expect(result.errors).toEqual([]);
    for (const p of [claudePath, neutralPath]) {
      const after = fs.readFileSync(p, 'utf-8');
      expect(after).toBe(template);
      expect(after).toContain('NOT SENT — suppressed duplicate for topic');
    }
    expect(result.upgraded.some(u => u.includes('scripts/telegram-reply.sh'))).toBe(true);
    expect(result.upgraded.some(u => u.includes('.instar/scripts/telegram-reply.sh'))).toBe(true);
  });

  it('keeps the migrated script executable', () => {
    deployPriorShippedAgent();
    runMigrateScripts(createMigrator(projectDir));

    // A relay the agent cannot execute is as broken as one that lies.
    for (const p of [claudePath, neutralPath]) {
      expect(fs.statSync(p).mode & 0o111).not.toBe(0);
    }
  });

  it('backs the prior version up before overwriting', () => {
    deployPriorShippedAgent();
    runMigrateScripts(createMigrator(projectDir));

    const backups = fs.readdirSync(backupsDir).filter(f => f.startsWith('telegram-reply.sh.'));
    expect(backups.length).toBeGreaterThan(0);
    expect(sha256(fs.readFileSync(path.join(backupsDir, backups[0]), 'utf-8')))
      .toBe(PRIOR_SHIPPED_SHA);
  });

  it('is idempotent — a second update run changes nothing and adds no backup', () => {
    deployPriorShippedAgent();
    runMigrateScripts(createMigrator(projectDir));
    const afterFirst = fs.readFileSync(claudePath, 'utf-8');
    const backupsAfterFirst = fs.readdirSync(backupsDir).length;

    const second = runMigrateScripts(createMigrator(projectDir));

    expect(second.errors).toEqual([]);
    expect(fs.readFileSync(claudePath, 'utf-8')).toBe(afterFirst);
    expect(fs.readdirSync(backupsDir).length).toBe(backupsAfterFirst);
    expect(second.skipped.some(s => s.includes('already current'))).toBe(true);
    expect(second.upgraded.some(u => u.includes('telegram-reply.sh'))).toBe(false);
  });

  it('does NOT clobber a locally customised script — writes a .new candidate instead', () => {
    deployPriorShippedAgent(`${priorShippedContent()}\n# operator's local customisation\n`);
    const before = fs.readFileSync(claudePath, 'utf-8');

    const result = runMigrateScripts(createMigrator(projectDir));

    // The operator's file is untouched...
    expect(fs.readFileSync(claudePath, 'utf-8')).toBe(before);
    // ...and the fix is offered alongside for them to reconcile.
    const candidate = fs.readFileSync(`${claudePath}.new`, 'utf-8');
    expect(candidate).toBe(fs.readFileSync(TEMPLATE, 'utf-8'));
    expect(candidate).toContain('NOT SENT — suppressed duplicate for topic');
    expect(result.skipped.some(s => s.includes('user-modified'))).toBe(true);
  });

  it('installs the fixed script outright on an agent that has none', () => {
    // New-agent path — no prior file. Covers the other half of Migration
    // Parity: new agents must not be left behind either.
    const result = runMigrateScripts(createMigrator(projectDir));

    expect(result.errors).toEqual([]);
    for (const p of [claudePath, neutralPath]) {
      expect(fs.readFileSync(p, 'utf-8')).toContain('NOT SENT — suppressed duplicate for topic');
    }
  });
});

/**
 * Verifies PostUpdateMigrator delivers the pre-limit (proactive) swap awareness
 * bullet to BOTH new-section installs and EXISTING agents that already carry the
 * Subscription Pool section (Agent Awareness + Migration Parity). The existing-
 * agent path is the one that matters: the section-install guard skips agents that
 * already have the section, so a dedicated patch is the only way they learn the
 * new capability. Idempotent.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

function newMigrator(projectDir: string): PostUpdateMigrator {
  return new PostUpdateMigrator({
    projectDir,
    stateDir: path.join(projectDir, '.instar'),
    port: 4042,
    hasTelegram: false,
    projectName: 'test',
  });
}

function runClaudeMdMigration(migrator: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
  return result;
}

/** The continuity bullet exactly as an EXISTING agent's CLAUDE.md carries it
 *  (pre-proactive-swap), so we exercise the patch-into-existing-section path. */
const EXISTING_SUBSCRIPTION_SECTION = `
**Subscription Pool (multi-account quota + auto-swap + enrollment)** — Hold ALL of your subscriptions for a provider and use them as one pool.
- **Continuity guarantee** — a long session that hits its account's quota resumes on another eligible account (conversation preserved via \`--resume\`), never dies. Manual lever: \`POST /subscription-pool/swap\` \`{"sessionName":"...","exhaustedAccountId":"..."}\`. Auto-swap on rate-limit ships OFF (opt-in via \`subscriptionPool.autoSwapOnRateLimit\` — it moves a live session, real authority).
- **When to use** (PROACTIVE): "how much quota is left across my accounts?" Single-account pools are a no-op.
`;

describe('PostUpdateMigrator — pre-limit (proactive) swap bullet', () => {
  let projectDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-proactive-md-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-proactiveSwapBullet.test.ts:cleanup',
    });
  });

  it('patches the bullet into an EXISTING subscription section (the parity case)', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n' + EXISTING_SUBSCRIPTION_SECTION);

    const result = runClaudeMdMigration(newMigrator(projectDir));

    expect(result.errors).toEqual([]);
    expect(result.upgraded.some(u => u.includes('pre-limit (proactive) swap'))).toBe(true);

    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain('Pre-limit (proactive) swap');
    expect(after).toContain('subscriptionPool.proactiveSwap.enabled');
    expect(after).toContain('POST /subscription-pool/proactive-swap/check');
    // Inserted right after the continuity bullet (before the "When to use" bullet).
    expect(after.indexOf('Pre-limit (proactive) swap')).toBeGreaterThan(after.indexOf('Continuity guarantee'));
    expect(after.indexOf('Pre-limit (proactive) swap')).toBeLessThan(after.indexOf('When to use'));
  });

  it('a NEW agent (no section) gets the bullet via the section-install path', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nFresh agent, no subscription section.\n');

    runClaudeMdMigration(newMigrator(projectDir));

    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain('Subscription Pool (multi-account quota');
    expect(after).toContain('Pre-limit (proactive) swap');
  });

  it('is idempotent — a second run does not duplicate the bullet', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n' + EXISTING_SUBSCRIPTION_SECTION);

    runClaudeMdMigration(newMigrator(projectDir));
    const afterFirst = fs.readFileSync(claudeMdPath, 'utf-8');
    const second = runClaudeMdMigration(newMigrator(projectDir));
    const afterSecond = fs.readFileSync(claudeMdPath, 'utf-8');

    expect(afterSecond).toBe(afterFirst);
    expect(second.upgraded.some(u => u.includes('pre-limit (proactive) swap'))).toBe(false);
    // Exactly one occurrence.
    expect(afterSecond.split('Pre-limit (proactive) swap').length - 1).toBe(1);
  });
});

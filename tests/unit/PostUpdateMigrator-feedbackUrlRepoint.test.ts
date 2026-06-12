// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Migration Parity tests — canonical feedback URL repoint
 * (docs/specs/feedback-factory-migration.md §2.5 Phase 4: "the sender default
 * lives in the published instar package; new installs get the new URL via init,
 * but deployed agents only repoint through PostUpdateMigrator").
 *
 * MERGING THE CHANGE UNDER TEST IS THE CUTOVER FLIP — these tests pin the
 * semantics that make the flip safe:
 *   - a deployed agent's config.json carrying the OLD canonical URL verbatim is
 *     rewritten to CANONICAL_FEEDBACK_URL (the whole point — Migration Parity)
 *   - IDEMPOTENT: a second run changes nothing
 *   - CONSERVATIVE: an operator's CUSTOM webhook URL is never touched (both
 *     sides of the rewrite decision boundary)
 *   - absent feedback config / absent webhookUrl → untouched (no invention)
 *   - the in-code defaults (Config loader + new-install init shape) resolve to
 *     the canonical constant, and the constant passes the sender's own
 *     validateWebhookUrl gate (https, non-internal)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { CANONICAL_FEEDBACK_URL, LEGACY_FEEDBACK_URLS } from '../../src/core/canonicalFeedback.js';
import { FeedbackManager } from '../../src/core/FeedbackManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

const OLD_URL = 'https://dawn.bot-me.ai/api/instar/feedback';
const CUSTOM_URL = 'https://my-own-factory.example.com/api/feedback';

function newMigrator(projectDir: string): PostUpdateMigrator {
  return new PostUpdateMigrator({
    projectDir,
    stateDir: path.join(projectDir, '.instar'),
    port: 4042,
    hasTelegram: false,
    projectName: 'test',
  });
}

function callMigrateConfig(migrator: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as Record<string, (r: MigrationResult) => void>).migrateConfig(result);
  return result;
}

describe('PostUpdateMigrator — canonical feedback URL repoint (Phase-4 flip)', () => {
  let projectDir: string;
  let configPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-feedback-repoint-'));
    const stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    configPath = path.join(stateDir, 'config.json');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-feedbackUrlRepoint.test.ts:cleanup',
    });
  });

  function writeConfig(feedback: Record<string, unknown> | undefined): void {
    fs.writeFileSync(configPath, JSON.stringify({ projectName: 'x', port: 4042, authToken: 't', dashboardPin: '123456', ...(feedback !== undefined ? { feedback } : {}) }, null, 2) + '\n');
  }

  function readConfig(): Record<string, any> {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }

  it('rewrites the OLD canonical URL to the new canonical front (the deployed-agent repoint)', () => {
    writeConfig({ enabled: true, webhookUrl: OLD_URL, feedbackFile: 'f.json' });
    const r = callMigrateConfig(newMigrator(projectDir));
    expect(r.errors).toEqual([]);
    expect(readConfig().feedback.webhookUrl).toBe(CANONICAL_FEEDBACK_URL);
    expect(r.upgraded.some((u) => u.includes('webhookUrl repointed'))).toBe(true);
    // The rest of the feedback config is untouched.
    expect(readConfig().feedback.enabled).toBe(true);
    expect(readConfig().feedback.feedbackFile).toBe('f.json');
  });

  it('is IDEMPOTENT: a second run changes nothing', () => {
    writeConfig({ enabled: true, webhookUrl: OLD_URL, feedbackFile: 'f.json' });
    callMigrateConfig(newMigrator(projectDir));
    const afterFirst = readConfig();
    const r2 = callMigrateConfig(newMigrator(projectDir));
    expect(r2.upgraded.some((u) => u.includes('webhookUrl repointed'))).toBe(false);
    expect(readConfig().feedback.webhookUrl).toBe(afterFirst.feedback.webhookUrl);
  });

  it("NEVER touches an operator's custom webhook URL (the other side of the boundary)", () => {
    writeConfig({ enabled: true, webhookUrl: CUSTOM_URL, feedbackFile: 'f.json' });
    const r = callMigrateConfig(newMigrator(projectDir));
    expect(readConfig().feedback.webhookUrl).toBe(CUSTOM_URL);
    expect(r.upgraded.some((u) => u.includes('webhookUrl repointed'))).toBe(false);
  });

  it('leaves a config with no feedback block / no webhookUrl alone (no invention)', () => {
    writeConfig(undefined);
    const r1 = callMigrateConfig(newMigrator(projectDir));
    expect(r1.errors).toEqual([]);
    expect(readConfig().feedback?.webhookUrl).toBeUndefined();

    writeConfig({ enabled: false });
    const r2 = callMigrateConfig(newMigrator(projectDir));
    expect(r2.errors).toEqual([]);
    expect(readConfig().feedback.webhookUrl).toBeUndefined();
  });

  it('the legacy list contains the Dawn URL the fleet shipped with (regression pin)', () => {
    expect(LEGACY_FEEDBACK_URLS).toContain(OLD_URL);
    expect(LEGACY_FEEDBACK_URLS).not.toContain(CANONICAL_FEEDBACK_URL);
  });

  it('the canonical URL passes the sender\'s own validateWebhookUrl gate (https, non-internal)', () => {
    // Constructing a FeedbackManager runs validateWebhookUrl — a throw fails the test.
    const fm = new FeedbackManager({ enabled: true, webhookUrl: CANONICAL_FEEDBACK_URL, feedbackFile: path.join(projectDir, 'fb.json') });
    expect(fm).toBeTruthy();
  });
});

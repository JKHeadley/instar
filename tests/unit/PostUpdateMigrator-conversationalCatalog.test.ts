/**
 * Verifies the PostUpdateMigrator ships the conversational-action catalog
 * Playbook manifest template to .instar/playbook/builtin-manifests/ on
 * update. This is the third on-demand loader for the Conversational-action
 * v0.2 wiring (ContextHierarchy Tier 2 segment + SelfKnowledgeTree probe +
 * Playbook context item).
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

function runMigration(migrator: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateConversationalCatalogPlaybookManifest(r: MigrationResult): void }).migrateConversationalCatalogPlaybookManifest(result);
  return result;
}

describe('PostUpdateMigrator — conversational-catalog Playbook manifest', () => {
  let projectDir: string;
  let targetPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-conv-catalog-playbook-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    targetPath = path.join(projectDir, '.instar', 'playbook', 'builtin-manifests', 'conversational-catalog.json');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-conversationalCatalog.test.ts:43' });
  });

  it('installs the manifest when missing', () => {
    expect(fs.existsSync(targetPath)).toBe(false);

    const result = runMigration(newMigrator(projectDir));

    expect(result.errors).toEqual([]);
    expect(result.upgraded.some(u => u.includes('conversational-catalog-playbook'))).toBe(true);
    expect(fs.existsSync(targetPath)).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(targetPath, 'utf-8'));
    expect(manifest.items).toBeDefined();
    expect(manifest.items.length).toBeGreaterThan(0);
    expect(manifest.items[0].id).toBe('/instar/conversational-catalog');
    expect(manifest.items[0].tags.qualifiers).toContain('on-demand');
    expect(manifest.items[0].load_triggers).toContain('interpreting-user-intent');
  });

  it('is idempotent — second run is a no-op when manifest matches template', () => {
    runMigration(newMigrator(projectDir));
    const result2 = runMigration(newMigrator(projectDir));

    expect(result2.errors).toEqual([]);
    expect(result2.skipped.some(s => s.includes('up to date'))).toBe(true);
    expect(result2.upgraded).toEqual([]);
  });

  it('updates the manifest when content drifts (always-overwrite semantics)', () => {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, JSON.stringify({ items: [], stale: true }));

    const result = runMigration(newMigrator(projectDir));

    expect(result.errors).toEqual([]);
    expect(result.upgraded.some(u => u.includes('conversational-catalog-playbook'))).toBe(true);

    const refreshed = JSON.parse(fs.readFileSync(targetPath, 'utf-8'));
    expect(refreshed.items[0].id).toBe('/instar/conversational-catalog');
    expect(refreshed.stale).toBeUndefined();
  });
});

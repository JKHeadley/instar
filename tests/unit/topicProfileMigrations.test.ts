/**
 * Unit tests for the Topic Profile migration-parity surface
 * (TOPIC-PROFILE-SPEC §12 + §12.5).
 *
 * Covers:
 *  - migrateConfig: additive `topicProfiles` block (existence-checked via
 *    applyDefaults), NEVER writes an `enabled` literal (the dark-gate
 *    resolves dark-on-fleet / live-on-dev), preserves operator values,
 *    idempotent.
 *  - ConfigDefaults: the shipped `topicProfiles` defaults block carries all
 *    §12.5 knobs and NO `enabled` key (lint-guarded dark-gate convention).
 *  - DEV_GATED_FEATURES: `topicProfiles` registration with the canonical
 *    configPath.
 *  - migrateClaudeMd: Topic Profile awareness section appended with a
 *    content-sniff guard (conversational triggers PRIMARY, never instruct
 *    typing /topic, Registry-First read surfaces), idempotent, and skipped
 *    on a template-generated CLAUDE.md (template ↔ migration parity).
 *  - generateClaudeMd: the scaffold template carries the same section plus
 *    the Registry-First table rows (Agent Awareness Standard).
 *  - migrateBackupManifest: profile + operator-binding stores join the
 *    includeFiles union with stateDir-RELATIVE paths (`state/...`, never
 *    `.instar/state/...` — the dead-manifest-entry shape), idempotent,
 *    user entries preserved.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { getInitDefaults, getMigrationDefaults } from '../../src/config/ConfigDefaults.js';
import { DEV_GATED_FEATURES } from '../../src/core/devGatedFeatures.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';

interface MigrationResult {
  upgraded: string[];
  errors: string[];
  skipped: string[];
}

const SECTION_MARKER = '**Topic Profile (per-topic model, thinking, framework pins)**';
const SNIFF_MARKER = 'Topic Profile (per-topic model';
const PROFILE_BACKUP_ENTRIES = ['state/topic-profiles.json', 'state/topic-operators.json'];

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-topic-profile-migrations-'));
}

function cleanup(dir: string): void {
  SafeFsExecutor.safeRmSync(dir, {
    recursive: true,
    force: true,
    operation: 'tests/unit/topicProfileMigrations.test.ts:cleanup',
  });
}

function emptyResult(): MigrationResult {
  return { upgraded: [], errors: [], skipped: [] };
}

function buildMigrator(projectDir: string) {
  const stateDir = path.join(projectDir, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  const migrator = new PostUpdateMigrator({
    projectDir,
    stateDir,
    port: 4042,
    hasTelegram: false,
    projectName: 'test',
  });
  const internals = migrator as unknown as {
    migrateConfig: (result: MigrationResult) => void;
    migrateClaudeMd: (result: MigrationResult) => void;
    migrateBackupManifest: (result: MigrationResult) => void;
  };
  return {
    stateDir,
    runConfig: internals.migrateConfig.bind(migrator),
    runClaudeMd: internals.migrateClaudeMd.bind(migrator),
    runBackupManifest: internals.migrateBackupManifest.bind(migrator),
  };
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('Topic Profile migrations (TOPIC-PROFILE-SPEC §12/§12.5)', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = createTempDir();
  });

  afterEach(() => cleanup(projectDir));

  // ── ConfigDefaults + dev-gate registration ───────────────────────────────

  describe('ConfigDefaults topicProfiles block', () => {
    it('ships every §12.5 knob with the spec defaults', () => {
      const defaults = getInitDefaults('managed-project');
      const tp = defaults.topicProfiles as Record<string, unknown>;
      expect(tp).toBeDefined();
      expect(tp.dryRun).toBe(true);
      expect(tp.respawnDebounceMs).toBe(7000);
      expect(tp.frameworkSwitchDebounceMs).toBe(45000);
      expect(tp.maxConcurrentProfileRespawns).toBe(2);
      expect(tp.spawnFailureBreakerThreshold).toBe(3);
      expect(tp.switchNowConfirmTtlMs).toBe(300000);
      expect(tp.defaults).toEqual({});
    });

    it('NEVER carries an `enabled` literal — dark-gate resolves it (round-13 / PR #1001)', () => {
      for (const agentType of ['managed-project', 'standalone'] as const) {
        const init = getInitDefaults(agentType).topicProfiles as Record<string, unknown>;
        const migration = getMigrationDefaults(agentType).topicProfiles as Record<string, unknown>;
        expect(Object.prototype.hasOwnProperty.call(init, 'enabled')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(migration, 'enabled')).toBe(false);
      }
    });

    it('is registered in DEV_GATED_FEATURES with the canonical configPath', () => {
      const entry = DEV_GATED_FEATURES.find((f) => f.name === 'topicProfiles');
      expect(entry).toBeDefined();
      expect(entry?.configPath).toBe('topicProfiles.enabled');
    });
  });

  // ── migrateConfig ────────────────────────────────────────────────────────

  describe('migrateConfig — topicProfiles block', () => {
    it('adds the full topicProfiles block to a config that lacks it, without `enabled`', () => {
      const { stateDir, runConfig } = buildMigrator(projectDir);
      const configPath = path.join(stateDir, 'config.json');
      fs.writeFileSync(configPath, JSON.stringify({ projectName: 'test', port: 4042 }, null, 2));

      const result = emptyResult();
      runConfig(result);
      expect(result.errors).toEqual([]);

      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const tp = config.topicProfiles;
      expect(tp).toBeDefined();
      expect(tp.dryRun).toBe(true);
      expect(tp.respawnDebounceMs).toBe(7000);
      expect(tp.frameworkSwitchDebounceMs).toBe(45000);
      expect(tp.maxConcurrentProfileRespawns).toBe(2);
      expect(tp.spawnFailureBreakerThreshold).toBe(3);
      expect(tp.switchNowConfirmTtlMs).toBe(300000);
      expect(tp.defaults).toEqual({});
      // The load-bearing invariant: migration must not decide enablement.
      expect(Object.prototype.hasOwnProperty.call(tp, 'enabled')).toBe(false);
      expect(result.upgraded.some((u) => u.includes('topicProfiles'))).toBe(true);
    });

    it('preserves operator-set values and an operator-owned defaults map (add-missing-only)', () => {
      const { stateDir, runConfig } = buildMigrator(projectDir);
      const configPath = path.join(stateDir, 'config.json');
      fs.writeFileSync(configPath, JSON.stringify({
        projectName: 'test',
        port: 4042,
        topicProfiles: {
          enabled: false, // explicit operator force-dark override — untouched
          dryRun: false,
          respawnDebounceMs: 12345,
          defaults: { '42': { model: 'claude-opus-4-8', thinkingMode: 'high' } },
        },
      }, null, 2));

      const result = emptyResult();
      runConfig(result);
      expect(result.errors).toEqual([]);

      const tp = JSON.parse(fs.readFileSync(configPath, 'utf-8')).topicProfiles;
      // Operator values survive verbatim.
      expect(tp.enabled).toBe(false);
      expect(tp.dryRun).toBe(false);
      expect(tp.respawnDebounceMs).toBe(12345);
      expect(tp.defaults).toEqual({ '42': { model: 'claude-opus-4-8', thinkingMode: 'high' } });
      // Missing knobs are backfilled.
      expect(tp.frameworkSwitchDebounceMs).toBe(45000);
      expect(tp.maxConcurrentProfileRespawns).toBe(2);
      expect(tp.spawnFailureBreakerThreshold).toBe(3);
      expect(tp.switchNowConfirmTtlMs).toBe(300000);
    });

    it('is idempotent — a second run changes nothing', () => {
      const { stateDir, runConfig } = buildMigrator(projectDir);
      const configPath = path.join(stateDir, 'config.json');
      fs.writeFileSync(configPath, JSON.stringify({ projectName: 'test', port: 4042 }, null, 2));

      runConfig(emptyResult());
      const afterFirst = fs.readFileSync(configPath, 'utf-8');

      const second = emptyResult();
      runConfig(second);
      const afterSecond = fs.readFileSync(configPath, 'utf-8');

      expect(second.errors).toEqual([]);
      expect(second.upgraded.filter((u) => u.includes('topicProfiles'))).toEqual([]);
      expect(afterSecond).toBe(afterFirst);
      // Still no enablement decision after repeated runs.
      const tp = JSON.parse(afterSecond).topicProfiles;
      expect(Object.prototype.hasOwnProperty.call(tp, 'enabled')).toBe(false);
    });
  });

  // ── migrateClaudeMd + template parity ────────────────────────────────────

  describe('migrateClaudeMd — Topic Profile awareness section', () => {
    it('appends the section to a CLAUDE.md that lacks it', () => {
      const { runClaudeMd } = buildMigrator(projectDir);
      const claudeMdPath = path.join(projectDir, 'CLAUDE.md');
      fs.writeFileSync(claudeMdPath, '# CLAUDE.md — test\n\nSome existing content.\n');

      const result = emptyResult();
      runClaudeMd(result);
      expect(result.errors).toEqual([]);
      expect(result.upgraded).toContain('CLAUDE.md: added Topic Profile awareness section');

      const content = fs.readFileSync(claudeMdPath, 'utf-8');
      expect(content).toContain(SECTION_MARKER);
      // Conversational triggers are the PRIMARY surface (B2/B36).
      expect(content).toContain('use codex here');
      expect(content).toContain('pin this topic to Fable');
      expect(content).toContain('set high thinking on this topic');
      // The agent must never instruct the operator to type /topic.
      expect(content).toContain('NEVER instruct the user to type \`/topic\`');
      // Registry-First read surfaces (the READ direction, round-2 P5).
      expect(content).toContain('/topic-profile/TOPIC_ID');
      expect(content).toContain('logs/topic-profile-changes.jsonl');
      // Port is resolved from the migrator config, not hardcoded.
      expect(content).toContain('http://localhost:4042/topic-profile/TOPIC_ID');
    });

    it('is idempotent — two runs leave exactly one section', () => {
      const { runClaudeMd } = buildMigrator(projectDir);
      const claudeMdPath = path.join(projectDir, 'CLAUDE.md');
      fs.writeFileSync(claudeMdPath, '# CLAUDE.md — test\n');

      runClaudeMd(emptyResult());
      const second = emptyResult();
      runClaudeMd(second);

      const content = fs.readFileSync(claudeMdPath, 'utf-8');
      expect(countOccurrences(content, SECTION_MARKER)).toBe(1);
      expect(second.upgraded).not.toContain('CLAUDE.md: added Topic Profile awareness section');
    });

    it('does not duplicate the section on a template-generated CLAUDE.md (template ↔ migration parity)', () => {
      const { runClaudeMd } = buildMigrator(projectDir);
      const claudeMdPath = path.join(projectDir, 'CLAUDE.md');
      fs.writeFileSync(claudeMdPath, generateClaudeMd('test', 'TestAgent', 4042, false));

      const result = emptyResult();
      runClaudeMd(result);
      expect(result.upgraded).not.toContain('CLAUDE.md: added Topic Profile awareness section');

      const content = fs.readFileSync(claudeMdPath, 'utf-8');
      expect(countOccurrences(content, SECTION_MARKER)).toBe(1);
    });
  });

  describe('generateClaudeMd — scaffold template awareness', () => {
    it('carries the Topic Profile section with triggers and read surfaces', () => {
      const template = generateClaudeMd('test', 'TestAgent', 4042, false);
      expect(template).toContain(SECTION_MARKER);
      expect(template).toContain(SNIFF_MARKER);
      expect(template).toContain('use codex here');
      expect(template).toContain('NEVER instruct the user to type \`/topic\`');
      expect(template).toContain('http://localhost:4042/topic-profile/TOPIC_ID');
      expect(template).toContain('logs/topic-profile-changes.jsonl');
    });

    it('carries the Registry-First table rows for both read surfaces', () => {
      const template = generateClaudeMd('test', 'TestAgent', 4042, false);
      expect(template).toContain('| What is this topic pinned to (model/thinking/framework)?');
      expect(template).toContain("| Why/when did this topic's pin change?");
    });
  });

  // ── migrateBackupManifest ────────────────────────────────────────────────

  describe('migrateBackupManifest — topic-profile store entries', () => {
    it('adds the profile + operator-binding stores with stateDir-RELATIVE paths', () => {
      const { stateDir, runBackupManifest } = buildMigrator(projectDir);
      const configPath = path.join(stateDir, 'config.json');
      fs.writeFileSync(configPath, JSON.stringify({ projectName: 'test', port: 4042 }, null, 2));

      const result = emptyResult();
      runBackupManifest(result);
      expect(result.errors).toEqual([]);

      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const includeFiles: string[] = config.backup.includeFiles;
      for (const entry of PROFILE_BACKUP_ENTRIES) {
        expect(includeFiles).toContain(entry);
      }
      // The dead-manifest-entry shape (round-6): BackupManager joins entries
      // onto a stateDir that already IS <project>/.instar, so an
      // `.instar/`-prefixed topic-profile entry would silently never match.
      expect(includeFiles).not.toContain('.instar/state/topic-profiles.json');
      expect(includeFiles).not.toContain('.instar/state/topic-operators.json');
      expect(result.upgraded.some((u) => u.includes('topic-profile state path'))).toBe(true);
    });

    it('resume maps are NOT in the union (machine-local ephemera, §12 round-5)', () => {
      const { stateDir, runBackupManifest } = buildMigrator(projectDir);
      const configPath = path.join(stateDir, 'config.json');
      fs.writeFileSync(configPath, JSON.stringify({ projectName: 'test', port: 4042 }, null, 2));

      runBackupManifest(emptyResult());

      const includeFiles: string[] = JSON.parse(fs.readFileSync(configPath, 'utf-8')).backup.includeFiles;
      expect(includeFiles.some((e) => e.includes('topic-resume-map'))).toBe(false);
      expect(includeFiles.some((e) => e.includes('codex-resume-map'))).toBe(false);
    });

    it('preserves user-added entries and is idempotent', () => {
      const { stateDir, runBackupManifest } = buildMigrator(projectDir);
      const configPath = path.join(stateDir, 'config.json');
      fs.writeFileSync(configPath, JSON.stringify({
        projectName: 'test',
        port: 4042,
        backup: { includeFiles: ['my-custom-state.json'] },
      }, null, 2));

      runBackupManifest(emptyResult());
      const afterFirst = fs.readFileSync(configPath, 'utf-8');
      const firstIncludes: string[] = JSON.parse(afterFirst).backup.includeFiles;
      expect(firstIncludes).toContain('my-custom-state.json');
      for (const entry of PROFILE_BACKUP_ENTRIES) {
        expect(firstIncludes).toContain(entry);
      }

      const second = emptyResult();
      runBackupManifest(second);
      const afterSecond = fs.readFileSync(configPath, 'utf-8');
      expect(second.errors).toEqual([]);
      expect(second.upgraded.some((u) => u.includes('topic-profile state path'))).toBe(false);
      const secondIncludes: string[] = JSON.parse(afterSecond).backup.includeFiles;
      for (const entry of PROFILE_BACKUP_ENTRIES) {
        expect(secondIncludes.filter((e) => e === entry)).toHaveLength(1);
      }
    });
  });
});

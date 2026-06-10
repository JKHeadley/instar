/**
 * Migration parity for Model-Tier Escalation (FABLE-MODEL-ESCALATION-SPEC §10).
 *
 * Four contracts, each earned by a prior incident class:
 *
 * 1. Hook drift guard — the inline getters in PostUpdateMigrator are the
 *    shipping artifact; src/templates/hooks/model-tier-*.{sh,js} are the
 *    canonical references. They MUST stay byte-identical (the
 *    hook-event-reporter lesson: agents stuck on a stale template).
 * 2. migrateHooks always-overwrite — built-in instar/ hooks are rewritten on
 *    every migration run, never install-if-missing.
 * 3. migrateSettings append-with-dedup — the two §5.4 hook registrations are
 *    appended exactly once, never duplicated, never reordering what exists.
 * 4. migrateConfig add-missing-only — `models.tierEscalation` lands dark
 *    (enabled:false, dryRun:true) on agents that lack it, and an operator's
 *    existing `enabled`/`dryRun` is NEVER overwritten (round-1 Lessons-H2,
 *    the burn-alert clobber incident) while missing sub-fields backfill.
 *
 * Plus the CLAUDE.md awareness parity: generateClaudeMd (new agents) and
 * migrateClaudeMd (existing agents) must produce a byte-identical section,
 * and settings-template.json must register both hooks for fresh agents.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { DEFAULT_TIER_ESCALATION_CONFIG } from '../../src/core/ModelTierEscalation.js';
import { getMigrationDefaults, applyDefaults } from '../../src/config/ConfigDefaults.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

const PORT = 4042;

function newMigrator(projectDir: string): PostUpdateMigrator {
  return new PostUpdateMigrator({
    projectDir,
    stateDir: path.join(projectDir, '.instar'),
    port: PORT,
    hasTelegram: false,
    projectName: 'test',
  });
}

function emptyResult(): MigrationResult {
  return { upgraded: [], skipped: [], errors: [] };
}

function runPrivate(migrator: PostUpdateMigrator, method: string): MigrationResult {
  const result = emptyResult();
  (migrator as unknown as Record<string, (r: MigrationResult) => void>)[method](result);
  return result;
}

describe('Model-Tier Escalation — hook template drift guards', () => {
  let projectDir: string;
  let hooksDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-model-tier-hooks-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    hooksDir = path.join(projectDir, '.instar', 'hooks', 'instar');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-modelTierEscalation.test.ts' });
  });

  it('inline model-tier-skill-entry hook is byte-identical to the canonical template file', () => {
    const migrator = newMigrator(projectDir);
    const inline = migrator.getHookContent('model-tier-skill-entry');
    const template = fs.readFileSync(path.resolve(__dirname, '../../src/templates/hooks/model-tier-skill-entry.sh'), 'utf8');
    expect(inline).toBe(template);
    expect(inline).toContain('#!/bin/bash');
  });

  it('inline model-tier-reconciler hook is byte-identical to the canonical template file', () => {
    const migrator = newMigrator(projectDir);
    const inline = migrator.getHookContent('model-tier-reconciler');
    const template = fs.readFileSync(path.resolve(__dirname, '../../src/templates/hooks/model-tier-reconciler.js'), 'utf8');
    expect(inline).toBe(template);
    expect(inline).toContain('#!/usr/bin/env node');
  });

  it('migrateHooks installs both hooks executable when missing', () => {
    const migrator = newMigrator(projectDir);
    const result = runPrivate(migrator, 'migrateHooks');

    for (const file of ['model-tier-skill-entry.sh', 'model-tier-reconciler.js']) {
      const dst = path.join(hooksDir, file);
      expect(fs.existsSync(dst), `${file} must be installed`).toBe(true);
      expect((fs.statSync(dst).mode & 0o111), `${file} must be executable`).not.toBe(0);
      expect(result.upgraded.some(u => u.includes(file)), `${file} must be reported upgraded`).toBe(true);
    }
    expect(result.errors).toEqual([]);
  });

  it('migrateHooks ALWAYS overwrites stale on-disk content (never install-if-missing)', () => {
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'model-tier-skill-entry.sh'), '#!/bin/bash\n# stale broken template\n');
    fs.writeFileSync(path.join(hooksDir, 'model-tier-reconciler.js'), '// stale broken template\n');

    const migrator = newMigrator(projectDir);
    runPrivate(migrator, 'migrateHooks');

    expect(fs.readFileSync(path.join(hooksDir, 'model-tier-skill-entry.sh'), 'utf8')).not.toContain('stale broken');
    expect(fs.readFileSync(path.join(hooksDir, 'model-tier-reconciler.js'), 'utf8')).not.toContain('stale broken');
  });
});

describe('Model-Tier Escalation — migrateSettings append-with-dedup', () => {
  let projectDir: string;
  let settingsPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-model-tier-settings-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
    settingsPath = path.join(projectDir, '.claude', 'settings.json');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-modelTierEscalation.test.ts' });
  });

  function readSettings(): { hooks: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>> } {
    return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  }

  function countCommands(settings: ReturnType<typeof readSettings>, event: string, needle: string): number {
    return (settings.hooks[event] ?? []).reduce(
      (n, entry) => n + (entry.hooks ?? []).filter(h => h.command?.includes(needle)).length,
      0,
    );
  }

  it('registers the skill-entry hook on the existing PostToolUse Skill matcher and the reconciler on UserPromptSubmit', () => {
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        PostToolUse: [
          { matcher: 'Skill', hooks: [{ type: 'command', command: 'bash ${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/skill-usage-telemetry.sh', timeout: 3000 }] },
        ],
      },
    }, null, 2));

    const migrator = newMigrator(projectDir);
    const result = runPrivate(migrator, 'migrateSettings');

    const settings = readSettings();
    expect(countCommands(settings, 'PostToolUse', 'model-tier-skill-entry')).toBe(1);
    expect(countCommands(settings, 'UserPromptSubmit', 'model-tier-reconciler')).toBe(1);
    // Appended onto the existing Skill matcher entry, not a parallel one.
    const skillEntries = settings.hooks.PostToolUse.filter(e => e.matcher === 'Skill');
    expect(skillEntries.length).toBe(1);
    // Pre-existing registration untouched.
    expect(countCommands(settings, 'PostToolUse', 'skill-usage-telemetry')).toBe(1);
    expect(result.upgraded.some(u => u.includes('model-tier-skill-entry'))).toBe(true);
    expect(result.upgraded.some(u => u.includes('model-tier-reconciler'))).toBe(true);
  });

  it('is idempotent — a second run adds nothing', () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: {} }, null, 2));

    const migrator = newMigrator(projectDir);
    runPrivate(migrator, 'migrateSettings');
    const afterFirst = readSettings();
    const firstSkillEntry = countCommands(afterFirst, 'PostToolUse', 'model-tier-skill-entry');
    const firstReconciler = countCommands(afterFirst, 'UserPromptSubmit', 'model-tier-reconciler');
    expect(firstSkillEntry).toBe(1);
    expect(firstReconciler).toBe(1);

    runPrivate(newMigrator(projectDir), 'migrateSettings');
    const afterSecond = readSettings();
    expect(countCommands(afterSecond, 'PostToolUse', 'model-tier-skill-entry')).toBe(1);
    expect(countCommands(afterSecond, 'UserPromptSubmit', 'model-tier-reconciler')).toBe(1);
  });
});

describe('Model-Tier Escalation — migrateConfig add-missing-only (never-overwrite)', () => {
  let projectDir: string;
  let configPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-model-tier-config-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    configPath = path.join(projectDir, '.instar', 'config.json');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-modelTierEscalation.test.ts' });
  });

  function readConfig(): Record<string, any> {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }

  it('adds the full dark §9 block to a config that lacks models entirely', () => {
    fs.writeFileSync(configPath, JSON.stringify({ authToken: 'x', agentType: 'standalone' }, null, 2));

    runPrivate(newMigrator(projectDir), 'migrateConfig');

    const te = readConfig().models?.tierEscalation;
    expect(te).toBeDefined();
    expect(te.enabled).toBe(false);
    expect(te.dryRun).toBe(true);
    expect(te.triggers.skills).toEqual(['build', 'autonomous', 'instar-dev', 'spec-converge']);
    expect(te.frameworks['claude-code']).toEqual({ default: 'claude-opus-4-8', escalated: 'claude-fable-5' });
    expect(te.frameworks['codex-cli']).toEqual({ default: null, escalated: null });
    expect(te.costGuards.maxConcurrentEscalatedPerAccount).toBe(2);
    expect(te.costGuards.respectFreeWindows['claude-fable-5']).toBe('2026-06-22');
  });

  it("NEVER overwrites an operator's enabled/dryRun; backfills only what is missing", () => {
    fs.writeFileSync(configPath, JSON.stringify({
      authToken: 'x',
      agentType: 'standalone',
      models: { tierEscalation: { enabled: true, dryRun: false } },
    }, null, 2));

    runPrivate(newMigrator(projectDir), 'migrateConfig');

    const te = readConfig().models.tierEscalation;
    expect(te.enabled).toBe(true);     // operator value preserved
    expect(te.dryRun).toBe(false);     // operator value preserved
    // Missing sub-blocks backfilled from the §9 defaults.
    expect(te.triggers.skills).toEqual(['build', 'autonomous', 'instar-dev', 'spec-converge']);
    expect(te.costGuards.maxEscalationsPerHour).toBe(8);
  });

  it('preserves operator-tuned nested values (e.g. a custom trigger skill list)', () => {
    fs.writeFileSync(configPath, JSON.stringify({
      authToken: 'x',
      agentType: 'standalone',
      models: { tierEscalation: { triggers: { skills: ['build'] } } },
    }, null, 2));

    runPrivate(newMigrator(projectDir), 'migrateConfig');

    const te = readConfig().models.tierEscalation;
    expect(te.triggers.skills).toEqual(['build']); // arrays are opaque leaves — untouched
    expect(te.enabled).toBe(false);                // missing scalar backfilled dark
    expect(te.triggers.projectDesign).toBe(true);  // missing nested scalar backfilled
  });

  it('is idempotent — a second run reports no tierEscalation changes', () => {
    fs.writeFileSync(configPath, JSON.stringify({ authToken: 'x', agentType: 'standalone' }, null, 2));

    runPrivate(newMigrator(projectDir), 'migrateConfig');
    const result = runPrivate(newMigrator(projectDir), 'migrateConfig');
    expect(result.upgraded.filter(u => u.includes('tierEscalation'))).toEqual([]);
  });

  it('ConfigDefaults migration registry carries the §9 block verbatim (single source of truth)', () => {
    const defaults = getMigrationDefaults('standalone');
    expect((defaults as any).models.tierEscalation).toEqual(DEFAULT_TIER_ESCALATION_CONFIG);
    // applyDefaults add-missing semantics, asserted directly at the registry layer.
    const cfg: Record<string, unknown> = { models: { tierEscalation: { enabled: true, dryRun: false } } };
    applyDefaults(cfg, defaults);
    const te = (cfg.models as any).tierEscalation;
    expect(te.enabled).toBe(true);
    expect(te.dryRun).toBe(false);
  });
});

describe('Model-Tier Escalation — CLAUDE.md awareness parity', () => {
  let projectDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-model-tier-claudemd-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-modelTierEscalation.test.ts' });
  });

  const MARKER = '**Model-Tier Escalation (EXPERIMENTAL';
  const SECTION_END = 'restart sessions to apply.';

  function sliceSection(doc: string): string {
    const start = doc.indexOf(MARKER);
    expect(start, 'section marker must be present').toBeGreaterThanOrEqual(0);
    const end = doc.indexOf(SECTION_END, start);
    expect(end, 'section terminator must be present').toBeGreaterThan(start);
    return doc.slice(start, end + SECTION_END.length);
  }

  it('migrateClaudeMd appends the awareness section to an existing CLAUDE.md', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md — test\n\nExisting content.\n');

    const result = runPrivate(newMigrator(projectDir), 'migrateClaudeMd');

    const content = fs.readFileSync(claudeMdPath, 'utf8');
    expect(content).toContain(MARKER);
    expect(content).toContain('/sessions/SESSION_NAME/model-swap');
    expect(result.upgraded.some(u => u.includes('Model-Tier Escalation'))).toBe(true);
  });

  it('is idempotent — the section is appended exactly once across repeated runs', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md — test\n');
    runPrivate(newMigrator(projectDir), 'migrateClaudeMd');
    runPrivate(newMigrator(projectDir), 'migrateClaudeMd');

    const content = fs.readFileSync(claudeMdPath, 'utf8');
    expect(content.split(MARKER).length - 1).toBe(1);
  });

  it('migrated section is byte-identical to the generateClaudeMd (fresh init) section', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md — test\n');
    runPrivate(newMigrator(projectDir), 'migrateClaudeMd');

    const migrated = sliceSection(fs.readFileSync(claudeMdPath, 'utf8'));
    const fresh = sliceSection(generateClaudeMd('test', 'TestAgent', PORT, false));
    expect(migrated).toBe(fresh);
  });
});

describe('Model-Tier Escalation — settings-template.json registrations (fresh agents)', () => {
  it('registers both §5.4 hooks for new agents', () => {
    const template = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../src/templates/hooks/settings-template.json'), 'utf8'));
    const ups = JSON.stringify(template.hooks.UserPromptSubmit);
    const ptu = JSON.stringify(template.hooks.PostToolUse);
    expect(ups).toContain('model-tier-reconciler.js');
    expect(ptu).toContain('model-tier-skill-entry.sh');
    // The skill-entry registration must sit under the Skill matcher.
    const skillEntry = template.hooks.PostToolUse.find((e: { matcher?: string }) => e.matcher === 'Skill');
    expect(skillEntry.hooks.some((h: { command: string }) => h.command.includes('model-tier-skill-entry.sh'))).toBe(true);
  });
});

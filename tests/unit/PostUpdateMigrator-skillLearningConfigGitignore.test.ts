/**
 * Skill-learning sentinel slice 0 — config defaults (decision 20), gitignore
 * patch (decision 3) and the ladder entry (`restartNeeded: true`).
 *
 * `monitoring.skillLearning` is added as ONE block only when absent with the
 * exact shipped defaults; an operator's block is never rewritten; the two
 * gitignore lines land once in the agent-home `.gitignore` and the internal
 * `.instar/.gitignore`; a second migrate() changes nothing.
 */

import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  PostUpdateMigrator,
  migrateConfigSkillLearningDefaults,
  SKILL_LEARNING_GITIGNORE_PROJECT,
  SKILL_LEARNING_GITIGNORE_STATE,
} from '../../src/core/PostUpdateMigrator.js';
import { getInitDefaults, getMigrationDefaults, SKILL_LEARNING_DEFAULTS } from '../../src/config/ConfigDefaults.js';
import { parseLadderRegistry } from '../../src/monitoring/MaturationLadder.js';
import { readShippedRegistry } from '../../src/monitoring/MaturationLadderService.js';
import { maturationUniverse } from '../../src/monitoring/maturationUniverse.js';

const EXACT_DEFAULTS = {
  enabled: false,
  mode: 'shadow',
  floor: { minOccurrences: 2, minCorroboratedCleanRuns: 1 },
  defaultGate: { minSupport: 3, minDistinctDays: 2, minDistinctSessions: 2, windowDays: 30 },
  shadow: { minDisagreementsSampled: 5, verdictReaskDays: 14 },
  growthSignals: { createdPerWeekNotice: 4 },
  evidence: { runSliceBytesPerRun: 98304, promptBudgetBytes: 262144, transcriptScanBytes: 4194304 },
  retire: { minCorroboratedRuns: 3, defaultScoreFloor: 0.4, defaultMisfireFloor: 0.3, defaultUnusedDays: 60, measurableFloor: 0.2 },
  review: { requireDifferentFamily: true, minCorrectedRunsSameFamily: 2, revertBreakerPer30d: 2 },
  llm: { maxDailyCents: 50, batchSize: 20 },
  tickMinutes: 10,
  reconcile: { enabled: true },
};

function newMigrator(projectDir: string): PostUpdateMigrator {
  return new PostUpdateMigrator({
    projectDir,
    stateDir: path.join(projectDir, '.instar'),
    port: 4042,
    hasTelegram: false,
    projectName: 'test',
  });
}

function countLines(file: string, entry: string): number {
  return fs.readFileSync(file, 'utf-8').split('\n').filter(l => l.trim() === entry).length;
}

describe('migrateConfigSkillLearningDefaults (pure)', () => {
  it('adds the exact shipped block when absent and reports it', () => {
    const config: Record<string, unknown> = { monitoring: { correctionLearning: { enabled: false } } };
    expect(migrateConfigSkillLearningDefaults(config)).toBe(true);
    expect((config.monitoring as Record<string, unknown>).skillLearning).toEqual(EXACT_DEFAULTS);
    expect((config.monitoring as Record<string, unknown>).correctionLearning).toEqual({ enabled: false });
  });

  it('creates the monitoring object when missing or malformed', () => {
    const missing: Record<string, unknown> = {};
    expect(migrateConfigSkillLearningDefaults(missing)).toBe(true);
    expect((missing.monitoring as Record<string, unknown>).skillLearning).toEqual(EXACT_DEFAULTS);
    const malformed: Record<string, unknown> = { monitoring: 'nope' };
    expect(migrateConfigSkillLearningDefaults(malformed)).toBe(true);
    expect((malformed.monitoring as Record<string, unknown>).skillLearning).toEqual(EXACT_DEFAULTS);
  });

  it('never touches an existing block, however partial, and is idempotent', () => {
    const operator = { enabled: true, mode: 'live' };
    const config: Record<string, unknown> = { monitoring: { skillLearning: operator } };
    expect(migrateConfigSkillLearningDefaults(config)).toBe(false);
    expect((config.monitoring as Record<string, unknown>).skillLearning).toBe(operator);
    expect(operator).toEqual({ enabled: true, mode: 'live' });
    const fresh: Record<string, unknown> = {};
    migrateConfigSkillLearningDefaults(fresh);
    expect(migrateConfigSkillLearningDefaults(fresh)).toBe(false);
  });

  it('writes a copy, so later mutation of the config never reaches the shipped constant', () => {
    const config: Record<string, unknown> = {};
    migrateConfigSkillLearningDefaults(config);
    ((config.monitoring as Record<string, unknown>).skillLearning as Record<string, unknown>).enabled = true;
    expect(SKILL_LEARNING_DEFAULTS.enabled).toBe(false);
  });
});

describe('ConfigDefaults carries the same block for fresh installs', () => {
  it('getInitDefaults and getMigrationDefaults ship monitoring.skillLearning with the exact defaults', () => {
    for (const agentType of ['standalone', 'managed-project'] as const) {
      const init = getInitDefaults(agentType) as { monitoring: Record<string, unknown> };
      expect(init.monitoring.skillLearning).toEqual(EXACT_DEFAULTS);
      const mig = getMigrationDefaults(agentType) as { monitoring: Record<string, unknown> };
      expect(mig.monitoring.skillLearning).toEqual(EXACT_DEFAULTS);
    }
    expect(SKILL_LEARNING_DEFAULTS).toEqual(EXACT_DEFAULTS);
  });
});

describe('feature ladder entry', () => {
  it('monitoring.skillLearning is in the switched-off universe and has a restart-needed ladder entry', () => {
    expect(maturationUniverse().map(m => m.path)).toContain('monitoring.skillLearning');
    const parsed = parseLadderRegistry(readShippedRegistry());
    if (!parsed.ok) throw new Error(parsed.reason);
    const entry = parsed.registry.entries.find(e => e.id === 'monitoring.skillLearning');
    expect(entry).toBeDefined();
    expect(entry!.restartNeeded).toBe(true);
    expect(entry!.disposition).toBe('ladder');
    expect(entry!.final).toBe('default-on');
    expect(entry!.flag?.path).toBe('monitoring.skillLearning');
    expect(entry!.aliases).toContain('monitoring.skillLearning.reconcile');
    expect(Object.keys(entry!.rungs).sort()).toEqual(['dev-agent-live', 'fleet']);
    for (const rung of Object.values(entry!.rungs)) {
      const roles = rung!.metrics.map(m => m.role).sort();
      expect(roles).toEqual(['harm', 'ran']);
      for (const m of rung!.metrics) {
        expect(m.source).toBe('jsonl-log');
        expect((m.ref as { file: string }).file).toBe('logs/skill-learning.jsonl');
        expect(m.windowDays).toBe(14);
        expect(m.minSamples).toBe(10);
      }
    }
  });
});

describe('PostUpdateMigrator.migrate() — config block + gitignore lines, end to end', () => {
  let home: string;
  let configPath: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-skill-learning-cfg-'));
    fs.mkdirSync(path.join(home, '.instar'), { recursive: true });
    configPath = path.join(home, '.instar', 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ projectName: 'test', port: 4042, monitoring: {} }, null, 2));
    fs.writeFileSync(path.join(home, '.gitignore'), '# existing\nnode_modules/\n');
    fs.writeFileSync(path.join(home, '.instar', '.gitignore'), '# state repo\n');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-skillLearningConfigGitignore.test.ts' });
  });

  it('adds the block and both gitignore lines once; a second run adds nothing', () => {
    const first = newMigrator(home).migrate();
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as { monitoring: Record<string, unknown> };
    expect(cfg.monitoring.skillLearning).toEqual(EXACT_DEFAULTS);
    expect(first.upgraded.some(u => u.startsWith('config.json: added monitoring.skillLearning defaults'))).toBe(true);

    const projectGi = path.join(home, '.gitignore');
    const stateGi = path.join(home, '.instar', '.gitignore');
    expect(SKILL_LEARNING_GITIGNORE_PROJECT).toEqual(['.instar/state/skill-learning.db*', '.instar/skill-telemetry.jsonl*', '.instar/skill-telemetry/unknown.jsonl']);
    expect(SKILL_LEARNING_GITIGNORE_STATE).toEqual(['state/skill-learning.db*', 'skill-telemetry.jsonl*', 'skill-telemetry/unknown.jsonl']);
    for (const entry of SKILL_LEARNING_GITIGNORE_PROJECT) expect(countLines(projectGi, entry)).toBe(1);
    for (const entry of SKILL_LEARNING_GITIGNORE_STATE) expect(countLines(stateGi, entry)).toBe(1);
    expect(fs.readFileSync(projectGi, 'utf-8').startsWith('# existing\nnode_modules/\n')).toBe(true);

    const cfgBefore = fs.readFileSync(configPath, 'utf-8');
    const second = newMigrator(home).migrate();
    expect(second.skipped).toContain('config.json: monitoring.skillLearning already present');
    expect(second.upgraded.some(u => u.startsWith('config.json: added monitoring.skillLearning'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8')).monitoring.skillLearning).toEqual(JSON.parse(cfgBefore).monitoring.skillLearning);
    for (const entry of SKILL_LEARNING_GITIGNORE_PROJECT) expect(countLines(projectGi, entry)).toBe(1);
    for (const entry of SKILL_LEARNING_GITIGNORE_STATE) expect(countLines(stateGi, entry)).toBe(1);
  });

  it("an operator's existing values survive migrate()", () => {
    fs.writeFileSync(configPath, JSON.stringify({ projectName: 'test', port: 4042, monitoring: { skillLearning: { enabled: true, mode: 'live', llm: { maxDailyCents: 5 } } } }, null, 2));
    newMigrator(home).migrate();
    const sl = JSON.parse(fs.readFileSync(configPath, 'utf-8')).monitoring.skillLearning;
    expect(sl.enabled).toBe(true);
    expect(sl.mode).toBe('live');
    expect(sl.llm.maxDailyCents).toBe(5);
  });
});

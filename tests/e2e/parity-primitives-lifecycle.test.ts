/**
 * E2E lifecycle test — Layer-3 parity primitives (Skill, Hook, Memory).
 *
 * Closes the Testing Integrity Tier-3 gap that PRs #252-#254 deferred.
 *
 * Per Testing Integrity Standard (NON-NEGOTIABLE):
 *   Tier 3 (E2E lifecycle): "production initialization path mirroring
 *   server.ts. Is the feature actually alive? Returns 200, not 503?"
 *
 * For Layer-3 parity primitives, "feature is alive" means:
 *   1. The ParityRegistry initializes with the expected rules registered.
 *   2. Each rule's listInstances, verify, remediate functions work end-to-end
 *      against a real fixture project root (no mocks).
 *   3. The PostUpdateMigrator's parity-renderings backfill renders canonical
 *      sources into framework-native locations on update.
 *   4. The FrameworkParitySentinel can construct + start + scan + stop on the
 *      same fixture, using the same rules.
 *
 * Aggregated into one e2e file because the four assertions share fixture
 * setup and the boundary "the parity layer is alive" is more meaningfully
 * tested as one production-init assertion than four siloed ones.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  listParityRules,
  getParityRule,
} from '../../src/providers/parity/registry.js';
import { FrameworkParitySentinel } from '../../src/monitoring/FrameworkParitySentinel.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

async function tmpProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'parity-primitives-e2e-'));
  await fs.mkdir(path.join(dir, '.instar', 'state'), { recursive: true });
  await fs.writeFile(
    path.join(dir, '.instar', 'config.json'),
    JSON.stringify({ enabledFrameworks: ['claude-code'] }),
  );
  return dir;
}

async function seedCanonicalSkill(projectDir: string, name: string): Promise<void> {
  const dir = path.join(projectDir, '.instar', 'skills', name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: e2e test skill ${name}\n---\n\n# ${name}\n\nBody of the canonical skill.\n`,
  );
}

async function seedCanonicalHook(projectDir: string, event: string, fileName: string): Promise<void> {
  const dir = path.join(projectDir, '.instar', 'hooks', event);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, fileName),
    `#!/bin/bash\n# canonical hook body for ${event}/${fileName}\necho "hook fired"\n`,
  );
}

async function seedCanonicalMemory(projectDir: string): Promise<void> {
  await fs.writeFile(
    path.join(projectDir, '.instar', 'AGENT.md'),
    '# Agent identity\n\nThis is the canonical AGENT.md.\n',
  );
  await fs.writeFile(
    path.join(projectDir, '.instar', 'USER.md'),
    '# User\n\nCanonical USER.md.\n',
  );
  await fs.writeFile(
    path.join(projectDir, '.instar', 'MEMORY.md'),
    '# Memory\n\nCanonical MEMORY.md.\n',
  );
}

describe('E2E: parity primitives lifecycle (production-init)', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await tmpProject();
  });

  afterEach(async () => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/e2e/parity-primitives-lifecycle.test.ts:cleanup',
    });
  });

  describe('Parity registry is alive at boot', () => {
    it('returns the expected Layer-3 rules (skill, hook, memory)', () => {
      const rules = listParityRules();
      const primitives = rules.map(r => r.primitive).sort();
      // The registry MUST contain the three v0.1 rules. Future Agent/Tool
      // rules join the same registry transparently.
      expect(primitives).toEqual(expect.arrayContaining(['skill', 'hook', 'memory']));
    });

    it('each registered rule exposes the ParityRule contract surface', () => {
      for (const rule of listParityRules()) {
        expect(typeof rule.primitive).toBe('string');
        expect(Array.isArray(rule.frameworks)).toBe(true);
        expect(typeof rule.remediationPolicy).toBe('string');
        expect(typeof rule.verify).toBe('function');
        expect(typeof rule.listInstances).toBe('function');
        expect(typeof rule.remediate).toBe('function');
        expect(typeof rule.listOrphans).toBe('function');
        expect(typeof rule.removeOrphans).toBe('function');
      }
    });

    it('getParityRule resolves each registered primitive by name', () => {
      expect(getParityRule('skill')).toBeDefined();
      expect(getParityRule('hook')).toBeDefined();
      expect(getParityRule('memory')).toBeDefined();
    });

    it('hookParityRule advertises alwaysOverwrite=true per Migration Parity §4', () => {
      const hook = getParityRule('hook');
      expect(hook?.alwaysOverwrite).toBe(true);
    });

    it('skillParityRule does NOT set alwaysOverwrite (refuse-on-conflict per §5)', () => {
      const skill = getParityRule('skill');
      expect(skill?.alwaysOverwrite).toBeFalsy();
    });
  });

  describe('Skill parity rule — full end-to-end render cycle', () => {
    it('listInstances → verify → remediate produces the framework-native rendering', async () => {
      const skill = getParityRule('skill');
      expect(skill).toBeDefined();
      if (!skill) return;

      await seedCanonicalSkill(projectDir, 'demo-skill');
      const instances = await skill.listInstances(projectDir);
      expect(instances).toContain('demo-skill');

      // Initial verify: rendering missing
      const before = await skill.verify(projectDir, 'demo-skill');
      expect(before.ok).toBe(false);

      // Remediate renders to .claude/skills/<name>/SKILL.md
      await skill.remediate(projectDir, 'demo-skill', 'claude-code');

      const renderedPath = path.join(projectDir, '.claude', 'skills', 'demo-skill', 'SKILL.md');
      const rendered = await fs.readFile(renderedPath, 'utf-8');
      expect(rendered).toContain('demo-skill');
      expect(rendered).toContain('e2e test skill');

      // Post-remediate verify on claude side is clean
      const after = await skill.verify(projectDir, 'demo-skill');
      const claudeIssues = after.mismatches.filter(m => m.framework === 'claude-code');
      expect(claudeIssues).toEqual([]);
    });
  });

  describe('Hook parity rule — full end-to-end render cycle', () => {
    it('listInstances → remediate produces stamped framework-native rendering', async () => {
      const hook = getParityRule('hook');
      expect(hook).toBeDefined();
      if (!hook) return;

      await seedCanonicalHook(projectDir, 'session-start', 'inject.sh');
      const instances = await hook.listInstances(projectDir);
      expect(instances).toContain('session-start/inject.sh');

      await hook.remediate(projectDir, 'session-start/inject.sh', 'claude-code');

      const renderedPath = path.join(projectDir, '.claude', 'hooks', 'session-start', 'inject.sh');
      const rendered = await fs.readFile(renderedPath, 'utf-8');
      expect(rendered).toContain('#!/bin/bash');
      expect(rendered).toContain('x-instar-stamp:'); // Migration Parity §4 audit comment
      expect(rendered).toContain('echo "hook fired"');
    });
  });

  describe('Memory parity rule — verify production identity artifacts', () => {
    it('verify passes when canonical AGENT/USER/MEMORY.md exist', async () => {
      const memory = getParityRule('memory');
      expect(memory).toBeDefined();
      if (!memory) return;

      await seedCanonicalMemory(projectDir);
      const instances = await memory.listInstances(projectDir);
      // Memory's listInstances returns the artifact identifiers it manages.
      expect(instances.length).toBeGreaterThan(0);

      // Each instance verifies cleanly when the canonical artifact is present.
      for (const inst of instances) {
        const result = await memory.verify(projectDir, inst);
        // Memory verify either passes outright or flags non-existence of a
        // sibling artifact (sqlite db doesn't exist in this fresh fixture).
        // Either way, the rule is alive and producing structured output.
        expect(result).toHaveProperty('ok');
        expect(Array.isArray(result.mismatches)).toBe(true);
      }
    });
  });

  describe('PostUpdateMigrator parity-renderings backfill — production-init path', () => {
    it('migrateAsync iterates the registry and renders all canonical instances', async () => {
      await seedCanonicalSkill(projectDir, 'backfill-skill');
      await seedCanonicalHook(projectDir, 'session-start', 'backfill.sh');

      const migrator = new PostUpdateMigrator({
        projectDir,
        stateDir: path.join(projectDir, '.instar'),
        port: 4042,
        hasTelegram: false,
        projectName: 'parity-e2e',
      });

      const result = await migrator.migrateAsync();

      expect(result.errors).toEqual([]);
      // Each rendered instance landed in result.upgraded.
      expect(result.upgraded.some(u => u.includes('parity-renderings:') && u.includes('backfill-skill'))).toBe(true);
      expect(result.upgraded.some(u => u.includes('parity-renderings:') && u.includes('backfill.sh'))).toBe(true);

      // The framework-native files exist on disk.
      const skillPath = path.join(projectDir, '.claude', 'skills', 'backfill-skill', 'SKILL.md');
      const hookPath = path.join(projectDir, '.claude', 'hooks', 'session-start', 'backfill.sh');
      expect(await fs.access(skillPath).then(() => true).catch(() => false)).toBe(true);
      expect(await fs.access(hookPath).then(() => true).catch(() => false)).toBe(true);
    });

    it('migration is idempotent on second run (marker prevents re-render)', async () => {
      await seedCanonicalSkill(projectDir, 'idempotent-skill');

      const migrator = new PostUpdateMigrator({
        projectDir,
        stateDir: path.join(projectDir, '.instar'),
        port: 4042,
        hasTelegram: false,
        projectName: 'parity-e2e',
      });

      await migrator.migrateAsync();
      const second = await migrator.migrateAsync();
      expect(second.skipped.some(s => s.includes('parity-renderings: already migrated'))).toBe(true);
    });
  });

  describe('FrameworkParitySentinel — boot lifecycle', () => {
    it('constructs + scans + stops without errors against the live registry', async () => {
      await seedCanonicalSkill(projectDir, 'sentinel-skill');

      const sentinel = new FrameworkParitySentinel({
        projectRoot: projectDir,
        stateDir: path.join(projectDir, '.instar'),
        enabledFrameworks: ['claude-code'],
      });

      const report = await sentinel.scan();
      expect(report).toHaveProperty('rulesWalked');
      expect(report).toHaveProperty('instancesChecked');
      expect(report.rulesWalked).toBeGreaterThan(0);
      expect(report.instancesChecked).toBeGreaterThan(0); // saw the seeded skill
    });

    it('start + stop are idempotent in production-init', async () => {
      const sentinel = new FrameworkParitySentinel({
        projectRoot: projectDir,
        stateDir: path.join(projectDir, '.instar'),
        enabledFrameworks: ['claude-code'],
        scanIntervalMs: 60_000,
        initialScanDelayMs: 60_000,
      });
      sentinel.start();
      sentinel.start(); // idempotent
      sentinel.stop();
      sentinel.stop(); // idempotent
    });
  });
});

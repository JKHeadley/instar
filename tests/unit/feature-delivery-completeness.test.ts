/**
 * Feature Delivery Completeness — ensures no gaps between init and migrate.
 *
 * The Three-Legged Stool of Feature Delivery in Instar:
 *   1. Server-side code (the feature itself)
 *   2. PostUpdateMigrator (so existing agents get local files on auto-update)
 *   3. Upgrade guide (so agents understand what they got)
 *
 * Without all three, new features ship to npm but existing agents never
 * actually get activated. This happened with External Operation Safety —
 * the code shipped in v0.9.14 but existing agents didn't get the hook,
 * settings, or config defaults until the migrator was updated.
 *
 * This test prevents that gap by scanning source files and enforcing parity.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const srcDir = path.join(process.cwd(), 'src');
const initSource = fs.readFileSync(path.join(srcDir, 'commands/init.ts'), 'utf-8');
const migratorSource = fs.readFileSync(path.join(srcDir, 'core/PostUpdateMigrator.ts'), 'utf-8');

describe('Feature Delivery Completeness', () => {
  describe('Hook parity: init installHooks() → PostUpdateMigrator migrateHooks()', () => {
    // Extract all hook filenames written in init.ts's installHooks function
    const hookFilePattern = /writeFileSync\(path\.join\(hooksDir,\s*'([^']+)'\)/g;
    const initHookFiles: string[] = [];
    let match;
    while ((match = hookFilePattern.exec(initSource)) !== null) {
      initHookFiles.push(match[1]);
    }

    it('init.ts installs at least 5 hooks (sanity check)', () => {
      expect(initHookFiles.length).toBeGreaterThanOrEqual(5);
    });

    for (const hookFile of initHookFiles) {
      it(`PostUpdateMigrator installs ${hookFile}`, () => {
        // The migrator must reference this hook file in its source
        expect(migratorSource).toContain(hookFile);
      });
    }
  });

  describe('Settings parity: init → PostUpdateMigrator migrateSettings()', () => {
    it('MCP matcher (mcp__.*) is in both init and migrator', () => {
      expect(initSource).toContain("'mcp__.*'");
      expect(migratorSource).toContain("'mcp__.*'");
    });

    it('dangerous-command-guard is referenced in both init and migrator', () => {
      expect(initSource).toContain('dangerous-command-guard');
      expect(migratorSource).toContain('dangerous-command-guard');
    });

    it('Playwright MCP server is in both init and migrator', () => {
      expect(initSource).toContain('playwright');
      expect(migratorSource).toContain('playwright');
    });
  });

  describe('Config parity: init config defaults → PostUpdateMigrator migrateConfig()', () => {
    it('externalOperations config is in both init and migrator', () => {
      expect(initSource).toContain('externalOperations');
      expect(migratorSource).toContain('externalOperations');
    });
  });

  describe('Upgrade guide lifecycle', () => {
    const upgradesDir = path.join(process.cwd(), 'upgrades');
    const nextGuidePath = path.join(upgradesDir, 'NEXT.md');

    it('NEXT.md template exists', () => {
      expect(fs.existsSync(nextGuidePath)).toBe(true);
    });

    it('NEXT.md has required section headers', () => {
      const content = fs.readFileSync(nextGuidePath, 'utf-8');
      expect(content).toContain('## What Changed');
      expect(content).toContain('## What to Tell Your User');
      expect(content).toContain('## Summary of New Capabilities');
    });

    it('at least one versioned upgrade guide exists (proof of delivery)', () => {
      const files = fs.readdirSync(upgradesDir);
      const versionedGuides = files.filter(f => /^\d+\.\d+\.\d+\.md$/.test(f));
      expect(versionedGuides.length).toBeGreaterThan(0);
    });
  });

  describe('CLAUDE.md awareness parity: features have corresponding CLAUDE.md sections', () => {
    it('External Operation Safety has a CLAUDE.md migration section', () => {
      expect(migratorSource).toContain('External Operation Safety');
    });

    it('Coherence Gate has a CLAUDE.md migration section', () => {
      expect(migratorSource).toContain('Coherence Gate');
    });

    it('Self-Discovery has a CLAUDE.md migration section', () => {
      expect(migratorSource).toContain('Self-Discovery');
    });
  });
});

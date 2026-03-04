/**
 * Unit tests — Upgrade guide infrastructure validation.
 *
 * Ensures:
 * - All existing upgrade guides have required sections
 * - The upgrade-notify session prompt includes memory internalization
 * - The session-start hook loads the feature guide
 * - The UpgradeGuideProcessor correctly finds and delivers guides
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

describe('Upgrade Guide Infrastructure', () => {
  const upgradesDir = path.join(ROOT, 'upgrades');

  describe('existing guides are well-formed', () => {
    const allGuideFiles = fs.existsSync(upgradesDir)
      ? fs.readdirSync(upgradesDir).filter(f => f.endsWith('.md'))
      : [];
    // NEXT.md is the pending guide for the next release — validated separately
    const versionedGuides = allGuideFiles.filter(f => f !== 'NEXT.md');

    it('has at least one upgrade guide', () => {
      expect(allGuideFiles.length).toBeGreaterThan(0);
    });

    for (const file of versionedGuides) {
      describe(`upgrades/${file}`, () => {
        const content = fs.readFileSync(path.join(upgradesDir, file), 'utf-8');

        it('has "What Changed" section', () => {
          expect(content).toContain('## What Changed');
        });

        it('has "What to Tell Your User" section', () => {
          expect(content).toContain('## What to Tell Your User');
        });

        it('has "Summary of New Capabilities" section', () => {
          expect(content).toContain('## Summary of New Capabilities');
        });

        it('has substantial content (> 200 chars)', () => {
          expect(content.length).toBeGreaterThan(200);
        });

        it('filename matches semver pattern', () => {
          expect(file).toMatch(/^\d+\.\d+\.\d+\.md$/);
        });
      });
    }

    // NEXT.md convention — if present, must be well-formed
    const nextMdPath = path.join(upgradesDir, 'NEXT.md');
    if (fs.existsSync(nextMdPath)) {
      describe('upgrades/NEXT.md (pending release guide)', () => {
        const content = fs.readFileSync(nextMdPath, 'utf-8');

        it('has "What Changed" section', () => {
          expect(content).toContain('## What Changed');
        });

        it('has "What to Tell Your User" section', () => {
          expect(content).toContain('## What to Tell Your User');
        });

        it('has "Summary of New Capabilities" section', () => {
          expect(content).toContain('## Summary of New Capabilities');
        });

        it('has substantial content (> 200 chars)', () => {
          expect(content.length).toBeGreaterThan(200);
        });
      });
    }
  });

  describe('session-start hook loads feature guide', () => {
    const migrator = new PostUpdateMigrator({
      projectDir: ROOT,
      stateDir: path.join(ROOT, '.instar'),
      port: 4040,
      hasTelegram: true,
      projectName: 'test',
    });
    const hookContent = migrator.getHookContent('session-start');

    it('calls /capabilities endpoint', () => {
      expect(hookContent).toContain('/capabilities');
    });

    it('extracts and outputs featureGuide triggers', () => {
      expect(hookContent).toContain('featureGuide');
      expect(hookContent).toContain('YOUR CAPABILITIES');
    });

    it('loads topic context before identity', () => {
      const topicIdx = hookContent.indexOf('CONVERSATION CONTEXT');
      const identityIdx = hookContent.indexOf('Identity:');
      expect(topicIdx).toBeLessThan(identityIdx);
      expect(topicIdx).toBeGreaterThan(-1);
    });

    it('outputs actual summary and messages, not just pointers', () => {
      expect(hookContent).toContain('SUMMARY OF CONVERSATION SO FAR');
      expect(hookContent).toContain('RECENT MESSAGES');
      // Should NOT have the old placeholder
      expect(hookContent).not.toContain('Read the thread history file for details');
    });
  });

  describe('upgrade-notify session includes memory internalization', () => {
    // Prompt building was extracted to UpgradeNotifyManager for testability
    const notifyManagerPath = path.join(ROOT, 'src', 'core', 'UpgradeNotifyManager.ts');
    const notifyContent = fs.readFileSync(notifyManagerPath, 'utf-8');

    it('instructs agent to update MEMORY.md', () => {
      expect(notifyContent).toContain('Update your memory');
      expect(notifyContent).toContain('MEMORY.md');
    });

    it('does NOT say "That is ALL" (allows memory update step)', () => {
      expect(notifyContent).not.toContain('That is ALL');
    });

    it('includes all three steps (notify, memory, acknowledge)', () => {
      expect(notifyContent).toContain('Step 1: Notify your user');
      expect(notifyContent).toContain('Step 2: Update your memory');
      expect(notifyContent).toContain('Step 3: Acknowledge');
      expect(notifyContent).toContain('instar upgrade-ack');
    });

    it('UpgradeNotifyManager exists and is exported', () => {
      const managerPath = path.join(ROOT, 'src', 'core', 'UpgradeNotifyManager.ts');
      expect(fs.existsSync(managerPath)).toBe(true);
      const content = fs.readFileSync(managerPath, 'utf-8');
      expect(content).toContain('class UpgradeNotifyManager');
    });
  });

  describe('PostUpdateMigrator includes memory internalization', () => {
    const migratorPath = path.join(ROOT, 'src', 'core', 'PostUpdateMigrator.ts');
    const migratorContent = fs.readFileSync(migratorPath, 'utf-8');

    it('instructs agent to update MEMORY.md in upgrade guide section', () => {
      expect(migratorContent).toContain('UPDATE YOUR MEMORY');
      expect(migratorContent).toContain('MEMORY.md');
    });

    it('loads feature guide from capabilities at session start', () => {
      expect(migratorContent).toContain('YOUR CAPABILITIES');
      expect(migratorContent).toContain('featureGuide');
    });
  });
});

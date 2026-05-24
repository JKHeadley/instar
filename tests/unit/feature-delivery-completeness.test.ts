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
 * settings, or config defaults until the migrator was updated. Then again
 * with Threadline relay — code shipped in 0.18.4 but the migration didn't
 * land until 0.18.5, leaving a window where existing agents got the feature
 * code but no awareness of it.
 *
 * This test prevents that gap by automatically extracting feature awareness
 * from source files and enforcing parity. Adding a feature to init/templates
 * without a corresponding PostUpdateMigrator section will fail CI.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const srcDir = path.join(process.cwd(), 'src');
const initSource = fs.readFileSync(path.join(srcDir, 'commands/init.ts'), 'utf-8');
const migratorSource = fs.readFileSync(path.join(srcDir, 'core/PostUpdateMigrator.ts'), 'utf-8');
const templatesSource = fs.readFileSync(path.join(srcDir, 'scaffold/templates.ts'), 'utf-8');

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
    // Feature config blocks are object-valued config keys that represent capabilities.
    // Both init.ts (for new agents) and PostUpdateMigrator (for existing agents) must
    // handle each one. If you add a feature config block, add it to this list.
    //
    // WHY THIS LIST EXISTS: The Threadline incident (0.18.4) showed that shipping
    // feature code without migration code leaves existing agents with capabilities
    // they don't know about. This list is the structural enforcement — if init.ts
    // has a config block that's not in the migrator (or vice versa), the test fails
    // and the version can't be published.
    const featureConfigBlocks = [
      'externalOperations',
      'threadline',
    ];

    for (const key of featureConfigBlocks) {
      it(`config.${key} is set in init.ts (new agents)`, () => {
        expect(initSource).toContain(key);
      });

      it(`config.${key} is migrated in PostUpdateMigrator (existing agents)`, () => {
        expect(migratorSource).toContain(key);
      });
    }

    // Auto-detect: if the migrator adds a config block we haven't listed, fail loudly.
    // Pattern: `if (!config.X)` followed by `config.X = {` means it's a feature block.
    const migratorConfigPattern = /if \(!config\.(\w+)\)\s*\{[\s\S]*?config\.\1\s*=/g;
    const detectedBlocks: string[] = [];
    let configMatch;
    while ((configMatch = migratorConfigPattern.exec(migratorSource)) !== null) {
      detectedBlocks.push(configMatch[1]);
    }

    it('all migrator config blocks are tracked in featureConfigBlocks', () => {
      for (const block of detectedBlocks) {
        expect(
          featureConfigBlocks.includes(block),
          `PostUpdateMigrator adds config.${block} but it's not in featureConfigBlocks — add it so parity is enforced`
        ).toBe(true);
      }
    });
  });

  describe('CLAUDE.md section parity: templates.ts ↔ PostUpdateMigrator', () => {
    // Feature CLAUDE.md sections that represent capabilities agents should know about.
    // Both templates.ts (via generateClaudeMd for new agents) and PostUpdateMigrator
    // (via migrateClaudeMd for existing agents) must include each one.
    //
    // When you add a new CLAUDE.md section to templates.ts, add a key phrase here.
    // The test will verify it exists in both files. If it's only in one, CI fails.
    const featureSections = [
      'Self-Discovery',
      'Publishing',
      'Private Viewing',
      'Secret Drop',
      'Commitments & Follow-Through',
      'Attention Queue',
      'Dashboard',
      'File Viewer',
      'Threadline Network',
      'Playbook',
      'Worktree Convention',
    ];

    for (const section of featureSections) {
      it(`"${section}" is in templates.ts (new agents)`, () => {
        expect(templatesSource).toContain(section);
      });

      it(`"${section}" is in PostUpdateMigrator (existing agents)`, () => {
        expect(migratorSource).toContain(section);
      });
    }

    // STRUCTURAL GUARD (2026-05-24, codex-live-test): every agent-facing
    // capability MUST also reach non-Claude frameworks (Codex AGENTS.md,
    // GEMINI.md) via the migrateFrameworkShadowCapabilities markers[] allowlist.
    // Two live findings on codey proved the cost of a gap here: Secret Drop and
    // Commitments were in the Claude template but NOT in markers[], so Codex
    // agents never learned them and improvised weaker workarounds (a plaintext
    // file the user edits; a raw `sleep` timer). This guard turns "remember to
    // add the marker" into a guarantee — a featureSection with no shadow marker
    // fails CI, so the class of bug cannot recur. (Structure > Willpower.)
    const shadowMarkersMatch = migratorSource.match(/const markers = \[([\s\S]*?)\];/);
    const shadowMarkersBlock = shadowMarkersMatch ? shadowMarkersMatch[1] : '';
    // A featureSection is covered if its phrase appears inside any marker string.
    // (Markers carry markdown decoration like `**X**` / `### X`; substring match
    // tolerates that.)
    it('every agent-facing capability is in migrateFrameworkShadowCapabilities markers[] (reaches Codex/Gemini)', () => {
      expect(shadowMarkersBlock, 'could not locate the markers[] array in PostUpdateMigrator.ts').not.toBe('');
      for (const section of featureSections) {
        expect(
          shadowMarkersBlock.includes(section),
          `Capability "${section}" is in the Claude template but NOT in the shadow-capability markers[] — Codex/Gemini agents will never learn it (they will improvise a weaker workaround). Add a marker for it in migrateFrameworkShadowCapabilities.`,
        ).toBe(true);
      }
    });

    // Auto-detect: if the migrator adds a CLAUDE.md section we haven't listed, fail.
    // Pattern: `if (!content.includes('SectionName'))` in migrateClaudeMd
    const migratorSectionPattern = /if \(!content\.includes\('([^']+)'\)/g;
    const detectedSections: string[] = [];
    let sectionMatch;
    while ((sectionMatch = migratorSectionPattern.exec(migratorSource)) !== null) {
      detectedSections.push(sectionMatch[1]);
    }

    // Some migrator sections are legacy patches for old agents that have since been
    // absorbed into the base template differently. These don't need template parity.
    const legacyMigratorSections = [
      'Coherence Gate',           // absorbed into base template
      'External Operation Safety', // absorbed into base template
      '/capabilities',            // alternate check for Self-Discovery
      'POST /view',               // alternate check for Private Viewing
      '/dashboard',               // alternate check for Dashboard
      '**Dashboard**',            // alternate check for Dashboard (bold markdown variant)
      '**Secret Drop**',          // alternate check for Secret Drop (bold markdown variant — migrateClaudeMd ensure-section)
      '**Commitments & Follow-Through**', // alternate check for Commitments (bold markdown variant — migrateClaudeMd ensure-section)
      '**Publishing**',           // alternate check for Publishing (bold markdown variant — migrateClaudeMd ensure-section)
      '**Attention Queue**',      // alternate check for Attention Queue (bold markdown variant — migrateClaudeMd ensure-section)
      '/coherence/check',         // alternate check for Coherence Gate
      '/operations/evaluate',     // alternate check for External Operation Safety
      'instar playbook',          // alternate check for Playbook
      '## Self-Observations',     // AGENT.md section, not CLAUDE.md — no template parity needed
      '## Identity History',      // AGENT.md section, not CLAUDE.md — no template parity needed
      'Session Continuity',       // conditional (Telegram-only), not a universal feature
      'CONTINUATION',             // alternate check for Session Continuity
      '/api/files/',              // alternate check for File Viewer
      'instar-boot.js',           // plist content check (migrateBootWrapperToCjs), NOT a CLAUDE.md section
      'instar-boot.cjs',          // plist content check (migrateBootWrapperToCjs), NOT a CLAUDE.md section
      // Operational-knowledge sections — runtime self-heal / housekeeping that
      // agents need awareness of, but that don't represent user-invokable
      // capabilities. They live in migrator only, no templates.ts parity required.
      'Version-Skew Self-Recovery',                       // major.minor lifeline coordination
      'coordinated lifeline restart',                     // alternate phrase for Version-Skew
      'restart-cascade dampener',                         // patch-level update self-heal
      'Restart-cascade dampener',                         // alternate case for restart-cascade
      'ORG-INTENT.md (Organizational Intent at Runtime)', // org-intent runtime contract
      'sentinelTelegramEscalation',                       // silently-stopped sentinel delivery gate
      'Sentinel Notifications (silently-stopped trio)',   // alternate heading phrase
    ];

    it('all new migrator CLAUDE.md sections are tracked', () => {
      for (const section of detectedSections) {
        const isTracked = featureSections.includes(section) || legacyMigratorSections.includes(section);
        expect(
          isTracked,
          `PostUpdateMigrator adds CLAUDE.md section "${section}" but it's not tracked — add it to featureSections or legacyMigratorSections`
        ).toBe(true);
      }
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
});

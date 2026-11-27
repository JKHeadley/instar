import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTempProject } from '../helpers/setup.js';
import type { TempProject } from '../helpers/setup.js';
import { MigrationProvenance } from '../../src/core/MigrationProvenance.js';
import { AutonomyProfileManager } from '../../src/core/AutonomyProfileManager.js';
import type { MigrationResult } from '../../src/core/PostUpdateMigrator.js';
import type { InstarConfig } from '../../src/core/types.js';
import { provedProfile } from '../helpers/operatorProof.js';

function makeMigrationResult(): MigrationResult {
  return {
    upgraded: [
      'hooks/instar/session-start.sh (capability awareness)',
      'hooks/instar/dangerous-command-guard.sh',
      'CLAUDE.md section: Self-Discovery',
    ],
    skipped: ['scripts/existing.sh'],
    errors: [],
  };
}

describe('MigrationProvenance + AutonomyProfileManager integration', () => {
  let project: TempProject;

  beforeEach(() => {
    project = createTempProject();
  });

  afterEach(() => {
    project.cleanup();
  });

  it('sends notification at cautious profile', () => {
    const config: InstarConfig = { name: 'test', autonomyProfile: 'cautious' } as InstarConfig;
    const profileManager = new AutonomyProfileManager({
      stateDir: project.stateDir,
      config,
    });

    const prov = new MigrationProvenance(project.stateDir);
    const entry = prov.logMigration('0.12.0', '0.13.0', makeMigrationResult());

    // Should notify at cautious
    expect(prov.shouldNotify(profileManager.getProfile())).toBe(true);

    // Notification should be well-formed
    const msg = prov.formatNotification(entry);
    expect(msg).toContain('Post-Update Migration');
    expect(msg).toContain('0.12.0');
  });

  it('does not send notification at autonomous profile', () => {
    const config: InstarConfig = { name: 'test', autonomyProfile: 'autonomous' } as InstarConfig;
    const profileManager = new AutonomyProfileManager({
      stateDir: project.stateDir,
      config,
    });

    const prov = new MigrationProvenance(project.stateDir);
    prov.logMigration('0.12.0', '0.13.0', makeMigrationResult());

    expect(prov.shouldNotify(profileManager.getProfile())).toBe(false);
  });

  it('log persists through profile changes', () => {
    const config: InstarConfig = { name: 'test' } as InstarConfig;
    const profileManager = new AutonomyProfileManager({
      stateDir: project.stateDir,
      config,
    });

    const prov = new MigrationProvenance(project.stateDir);

    // Log at supervised
    profileManager.setProfile('supervised', 'user requested');
    prov.logMigration('0.12.0', '0.13.0', makeMigrationResult());

    // Change to autonomous
    provedProfile(profileManager).setProfile('autonomous', 'user trusts agent');
    prov.logMigration('0.13.0', '0.14.0', makeMigrationResult());

    // Both entries should be in the log
    const log = prov.getLog();
    expect(log.length).toBe(2);
    expect(log[0].fromVersion).toBe('0.12.0');
    expect(log[1].fromVersion).toBe('0.13.0');
  });

  it('handles migration with errors gracefully', () => {
    const prov = new MigrationProvenance(project.stateDir);
    const result: MigrationResult = {
      upgraded: ['hooks/instar/session-start.sh'],
      skipped: [],
      errors: ['Permission denied: hooks/instar/guard.sh'],
    };

    const entry = prov.logMigration('0.12.0', '0.13.0', result);
    expect(entry.errorCount).toBe(1);
    expect(entry.upgradedCount).toBe(1);

    const msg = prov.formatNotification(entry);
    expect(msg).toContain('errors');
    expect(msg).toContain('Permission denied');
  });
});

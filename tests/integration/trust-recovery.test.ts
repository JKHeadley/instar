import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTempProject } from '../helpers/setup.js';
import type { TempProject } from '../helpers/setup.js';
import { TrustRecovery } from '../../src/core/TrustRecovery.js';
import { AdaptiveTrust } from '../../src/core/AdaptiveTrust.js';
import { proved, provedRecovery } from '../helpers/operatorProof.js';

describe('TrustRecovery + AdaptiveTrust integration', () => {
  let project: TempProject;

  beforeEach(() => {
    project = createTempProject();
  });

  afterEach(() => {
    project.cleanup();
  });

  it('records incident when AdaptiveTrust drops trust, and tracks recovery', () => {
    const trust = new AdaptiveTrust({ stateDir: project.stateDir });
    const recovery = new TrustRecovery({ stateDir: project.stateDir, recoveryThreshold: 3 });

    // Simulate some successful operations to build trust
    for (let i = 0; i < 10; i++) {
      trust.recordSuccess('gmail', 'write');
    }

    // Record an incident in AdaptiveTrust
    const trustEvent = trust.recordIncident('gmail', 'write', 'Failed to send email properly');
    expect(trustEvent).not.toBeNull();

    // Record the incident in TrustRecovery
    const incident = recovery.recordIncident(
      'gmail',
      'write',
      trustEvent!.from,
      trustEvent!.to,
      'Failed to send email properly',
    );

    expect(incident.previousLevel).toBe(trustEvent!.from);
    expect(incident.droppedToLevel).toBe(trustEvent!.to);

    // Now track recovery via successful operations
    for (let i = 0; i < 2; i++) {
      trust.recordSuccess('gmail', 'write');
      expect(recovery.recordSuccess('gmail', 'write')).toBeNull();
    }

    // Third success should trigger recovery suggestion
    trust.recordSuccess('gmail', 'write');
    const suggestion = recovery.recordSuccess('gmail', 'write');
    expect(suggestion).not.toBeNull();
    expect(suggestion!.previousLevel).toBe(trustEvent!.from);
    expect(suggestion!.message).toContain('Trust Recovery');
  });

  it('full lifecycle: incident -> recovery -> restore', () => {
    const trust = new AdaptiveTrust({ stateDir: project.stateDir });
    const recovery = new TrustRecovery({ stateDir: project.stateDir, recoveryThreshold: 5 });

    // Grant initial trust
    proved(trust).grantTrust('github', 'write', 'log', 'Earned trust through operation');

    // Incident drops trust
    const event = trust.recordIncident('github', 'write', 'Accidentally pushed to wrong branch');
    expect(event).not.toBeNull();

    // Record in recovery tracker
    const incident = recovery.recordIncident(
      'github', 'write',
      event!.from, event!.to,
      'Accidentally pushed to wrong branch',
    );

    // Track successes
    let suggestion = null;
    for (let i = 0; i < 5; i++) {
      trust.recordSuccess('github', 'write');
      suggestion = recovery.recordSuccess('github', 'write');
    }

    expect(suggestion).not.toBeNull();

    // Accept recovery
    const recovered = provedRecovery(recovery).acceptRecovery(incident.id);
    expect(recovered!.recovered).toBe(true);

    // Restore trust via AdaptiveTrust
    proved(trust).grantTrust('github', 'write', incident.previousLevel, 'Trust recovered after incident');

    const currentLevel = trust.getTrustLevel('github', 'write');
    expect(currentLevel.level).toBe(incident.previousLevel);

    // No more active incidents
    expect(recovery.getActiveIncidents().length).toBe(0);
  });

  it('dismiss recovery keeps trust at dropped level', () => {
    const recovery = new TrustRecovery({ stateDir: project.stateDir, recoveryThreshold: 3 });
    const incident = recovery.recordIncident('slack', 'write', 'log', 'approve-always', 'Sent wrong message');

    for (let i = 0; i < 3; i++) recovery.recordSuccess('slack', 'write');

    // Dismiss the suggestion
    recovery.dismissRecovery(incident.id);

    // Should not appear in active or pending
    expect(recovery.getActiveIncidents().length).toBe(0);
    expect(recovery.getPendingRecoveries().length).toBe(0);
  });

  it('multiple incidents on same service track independently', () => {
    const recovery = new TrustRecovery({ stateDir: project.stateDir, recoveryThreshold: 3 });

    const i1 = recovery.recordIncident('gmail', 'write', 'log', 'approve-always', 'Error 1');
    // Resolve first incident
    for (let i = 0; i < 3; i++) recovery.recordSuccess('gmail', 'write');
    provedRecovery(recovery).acceptRecovery(i1.id);

    // Second incident
    const i2 = recovery.recordIncident('gmail', 'write', 'approve-first', 'approve-always', 'Error 2');

    // Track recovery for second
    for (let i = 0; i < 3; i++) recovery.recordSuccess('gmail', 'write');

    const pending = recovery.getPendingRecoveries();
    expect(pending.length).toBe(1);
    expect(pending[0].incidentId).toBe(i2.id);
  });
});

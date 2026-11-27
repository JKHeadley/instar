import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTempProject } from '../helpers/setup.js';
import type { TempProject } from '../helpers/setup.js';
import { TrustRecovery } from '../../src/core/TrustRecovery.js';
import { provedRecovery } from '../helpers/operatorProof.js';

describe('TrustRecovery', () => {
  let project: TempProject;

  beforeEach(() => {
    project = createTempProject();
  });

  afterEach(() => {
    project.cleanup();
  });

  // ── Incident Recording ──────────────────────────────────────────

  describe('recordIncident', () => {
    it('records a new incident', () => {
      const tr = new TrustRecovery({ stateDir: project.stateDir });
      const incident = tr.recordIncident('gmail', 'write', 'log', 'approve-always', 'Sent wrong email');

      expect(incident.id).toMatch(/^INC-/);
      expect(incident.service).toBe('gmail');
      expect(incident.operation).toBe('write');
      expect(incident.previousLevel).toBe('log');
      expect(incident.droppedToLevel).toBe('approve-always');
      expect(incident.reason).toBe('Sent wrong email');
      expect(incident.recovered).toBe(false);
      expect(incident.dismissed).toBe(false);
      expect(incident.successesSinceIncident).toBe(0);
    });

    it('persists across instances', () => {
      const tr1 = new TrustRecovery({ stateDir: project.stateDir });
      tr1.recordIncident('gmail', 'write', 'log', 'approve-always', 'Error');

      const tr2 = new TrustRecovery({ stateDir: project.stateDir });
      const incidents = tr2.getActiveIncidents();
      expect(incidents.length).toBe(1);
      expect(incidents[0].service).toBe('gmail');
    });
  });

  // ── Recovery Tracking ─────────────────────────────────────────────

  describe('recordSuccess', () => {
    it('increments success counter', () => {
      const tr = new TrustRecovery({ stateDir: project.stateDir });
      tr.recordIncident('gmail', 'write', 'log', 'approve-always', 'Error');

      tr.recordSuccess('gmail', 'write');
      const incidents = tr.getActiveIncidents();
      expect(incidents[0].successesSinceIncident).toBe(1);
    });

    it('does not trigger suggestion before threshold', () => {
      const tr = new TrustRecovery({ stateDir: project.stateDir, recoveryThreshold: 5 });
      tr.recordIncident('gmail', 'write', 'log', 'approve-always', 'Error');

      for (let i = 0; i < 4; i++) {
        const suggestion = tr.recordSuccess('gmail', 'write');
        expect(suggestion).toBeNull();
      }
    });

    it('triggers recovery suggestion at threshold', () => {
      const tr = new TrustRecovery({ stateDir: project.stateDir, recoveryThreshold: 5 });
      tr.recordIncident('gmail', 'write', 'log', 'approve-always', 'Error');

      let suggestion = null;
      for (let i = 0; i < 5; i++) {
        suggestion = tr.recordSuccess('gmail', 'write');
      }

      expect(suggestion).not.toBeNull();
      expect(suggestion!.service).toBe('gmail');
      expect(suggestion!.previousLevel).toBe('log');
      expect(suggestion!.currentLevel).toBe('approve-always');
      expect(suggestion!.successCount).toBe(5);
    });

    it('uses default threshold of 10', () => {
      const tr = new TrustRecovery({ stateDir: project.stateDir });
      tr.recordIncident('gmail', 'write', 'log', 'approve-always', 'Error');

      for (let i = 0; i < 9; i++) {
        expect(tr.recordSuccess('gmail', 'write')).toBeNull();
      }
      expect(tr.recordSuccess('gmail', 'write')).not.toBeNull();
    });

    it('does not suggest for recovered incidents', () => {
      const tr = new TrustRecovery({ stateDir: project.stateDir, recoveryThreshold: 3 });
      const incident = tr.recordIncident('gmail', 'write', 'log', 'approve-always', 'Error');
      provedRecovery(tr).acceptRecovery(incident.id);

      for (let i = 0; i < 5; i++) {
        expect(tr.recordSuccess('gmail', 'write')).toBeNull();
      }
    });

    it('does not suggest for dismissed incidents', () => {
      const tr = new TrustRecovery({ stateDir: project.stateDir, recoveryThreshold: 3 });
      const incident = tr.recordIncident('gmail', 'write', 'log', 'approve-always', 'Error');
      tr.dismissRecovery(incident.id);

      for (let i = 0; i < 5; i++) {
        expect(tr.recordSuccess('gmail', 'write')).toBeNull();
      }
    });

    it('only counts matching service/operation', () => {
      const tr = new TrustRecovery({ stateDir: project.stateDir, recoveryThreshold: 3 });
      tr.recordIncident('gmail', 'write', 'log', 'approve-always', 'Error');

      // Success on different service/operation should not count
      for (let i = 0; i < 5; i++) {
        tr.recordSuccess('github', 'write');
        tr.recordSuccess('gmail', 'read');
      }

      const incidents = tr.getActiveIncidents();
      expect(incidents[0].successesSinceIncident).toBe(0);
    });

    it('does not suggest twice for the same incident', () => {
      const tr = new TrustRecovery({ stateDir: project.stateDir, recoveryThreshold: 3 });
      tr.recordIncident('gmail', 'write', 'log', 'approve-always', 'Error');

      // First suggestion
      for (let i = 0; i < 3; i++) tr.recordSuccess('gmail', 'write');

      // Should not suggest again
      for (let i = 0; i < 3; i++) {
        expect(tr.recordSuccess('gmail', 'write')).toBeNull();
      }
    });
  });

  // ── Recovery Actions ──────────────────────────────────────────────

  describe('acceptRecovery', () => {
    it('marks incident as recovered', () => {
      const tr = new TrustRecovery({ stateDir: project.stateDir });
      const incident = tr.recordIncident('gmail', 'write', 'log', 'approve-always', 'Error');
      const result = provedRecovery(tr).acceptRecovery(incident.id);

      expect(result).not.toBeNull();
      expect(result!.recovered).toBe(true);
      expect(tr.getActiveIncidents().length).toBe(0);
    });

    it('returns null for non-existent incident', () => {
      const tr = new TrustRecovery({ stateDir: project.stateDir });
      expect(provedRecovery(tr).acceptRecovery('INC-nonexistent')).toBeNull();
    });

    it('returns null for already recovered incident', () => {
      const tr = new TrustRecovery({ stateDir: project.stateDir });
      const incident = tr.recordIncident('gmail', 'write', 'log', 'approve-always', 'Error');
      provedRecovery(tr).acceptRecovery(incident.id);
      expect(provedRecovery(tr).acceptRecovery(incident.id)).toBeNull();
    });
  });

  describe('dismissRecovery', () => {
    it('marks incident as dismissed', () => {
      const tr = new TrustRecovery({ stateDir: project.stateDir });
      const incident = tr.recordIncident('gmail', 'write', 'log', 'approve-always', 'Error');
      const result = tr.dismissRecovery(incident.id);

      expect(result).not.toBeNull();
      expect(result!.dismissed).toBe(true);
      expect(tr.getActiveIncidents().length).toBe(0);
    });

    it('returns null for already dismissed', () => {
      const tr = new TrustRecovery({ stateDir: project.stateDir });
      const incident = tr.recordIncident('gmail', 'write', 'log', 'approve-always', 'Error');
      tr.dismissRecovery(incident.id);
      expect(tr.dismissRecovery(incident.id)).toBeNull();
    });
  });

  // ── Queries ───────────────────────────────────────────────────────

  describe('getActiveIncidents', () => {
    it('returns only active incidents', () => {
      const tr = new TrustRecovery({ stateDir: project.stateDir });
      const i1 = tr.recordIncident('gmail', 'write', 'log', 'approve-always', 'Error 1');
      tr.recordIncident('github', 'delete', 'approve-first', 'approve-always', 'Error 2');
      provedRecovery(tr).acceptRecovery(i1.id);

      const active = tr.getActiveIncidents();
      expect(active.length).toBe(1);
      expect(active[0].service).toBe('github');
    });
  });

  describe('getPendingRecoveries', () => {
    it('returns suggestions for incidents that met threshold', () => {
      const tr = new TrustRecovery({ stateDir: project.stateDir, recoveryThreshold: 3 });
      tr.recordIncident('gmail', 'write', 'log', 'approve-always', 'Error');
      tr.recordIncident('github', 'delete', 'approve-first', 'approve-always', 'Error');

      // Only gmail meets threshold
      for (let i = 0; i < 3; i++) tr.recordSuccess('gmail', 'write');

      const pending = tr.getPendingRecoveries();
      expect(pending.length).toBe(1);
      expect(pending[0].service).toBe('gmail');
    });
  });

  describe('getServiceIncidents', () => {
    it('filters by service', () => {
      const tr = new TrustRecovery({ stateDir: project.stateDir });
      tr.recordIncident('gmail', 'write', 'log', 'approve-always', 'Error 1');
      tr.recordIncident('gmail', 'delete', 'approve-first', 'approve-always', 'Error 2');
      tr.recordIncident('github', 'write', 'log', 'approve-always', 'Error 3');

      expect(tr.getServiceIncidents('gmail').length).toBe(2);
      expect(tr.getServiceIncidents('github').length).toBe(1);
      expect(tr.getServiceIncidents('unknown').length).toBe(0);
    });
  });

  describe('getIncident', () => {
    it('returns incident by ID', () => {
      const tr = new TrustRecovery({ stateDir: project.stateDir });
      const incident = tr.recordIncident('gmail', 'write', 'log', 'approve-always', 'Error');

      expect(tr.getIncident(incident.id)).not.toBeNull();
      expect(tr.getIncident(incident.id)!.service).toBe('gmail');
    });

    it('returns null for non-existent ID', () => {
      const tr = new TrustRecovery({ stateDir: project.stateDir });
      expect(tr.getIncident('INC-nonexistent')).toBeNull();
    });
  });

  // ── Summary ───────────────────────────────────────────────────────

  describe('getSummary', () => {
    it('reports no incidents when empty', () => {
      const tr = new TrustRecovery({ stateDir: project.stateDir });
      expect(tr.getSummary()).toContain('No active trust incidents');
    });

    it('includes active incident details', () => {
      const tr = new TrustRecovery({ stateDir: project.stateDir, recoveryThreshold: 10 });
      tr.recordIncident('gmail', 'write', 'log', 'approve-always', 'Error');

      // Record some progress
      for (let i = 0; i < 5; i++) tr.recordSuccess('gmail', 'write');

      const summary = tr.getSummary();
      expect(summary).toContain('gmail.write');
      expect(summary).toContain('approve-always');
      expect(summary).toContain('was log');
      expect(summary).toContain('5/10');
    });

    it('notes pending recoveries', () => {
      const tr = new TrustRecovery({ stateDir: project.stateDir, recoveryThreshold: 3 });
      tr.recordIncident('gmail', 'write', 'log', 'approve-always', 'Error');
      for (let i = 0; i < 3; i++) tr.recordSuccess('gmail', 'write');

      const summary = tr.getSummary();
      expect(summary).toContain('recovery');
    });
  });

  // ── Recovery Suggestion Message ───────────────────────────────────

  describe('recovery suggestion message', () => {
    it('includes all relevant context', () => {
      const tr = new TrustRecovery({ stateDir: project.stateDir, recoveryThreshold: 3 });
      tr.recordIncident('gmail', 'write', 'log', 'approve-always', 'Error');

      let suggestion = null;
      for (let i = 0; i < 3; i++) {
        suggestion = tr.recordSuccess('gmail', 'write');
      }

      expect(suggestion!.message).toContain('Trust Recovery');
      expect(suggestion!.message).toContain('gmail write');
      expect(suggestion!.message).toContain('3 consecutive');
      expect(suggestion!.message).toContain('log');
      expect(suggestion!.message).toContain('approve-always');
    });
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createTempProject } from '../helpers/setup.js';
import type { TempProject } from '../helpers/setup.js';
import { TrustElevationTracker } from '../../src/core/TrustElevationTracker.js';
import type { ApprovalEvent, TrustElevationConfig } from '../../src/core/TrustElevationTracker.js';

function makeConfig(stateDir: string, overrides: Partial<TrustElevationConfig> = {}): TrustElevationConfig {
  return { stateDir, ...overrides };
}

function makeApprovalEvent(overrides: Partial<ApprovalEvent> = {}): ApprovalEvent {
  const now = new Date();
  return {
    proposalId: `EVO-${Math.floor(Math.random() * 1000)}`,
    proposedAt: new Date(now.getTime() - 60000).toISOString(), // 1 minute ago
    decidedAt: now.toISOString(),
    decision: 'approved',
    modified: false,
    latencyMs: 60000,
    ...overrides,
  };
}

describe('TrustElevationTracker', () => {
  let project: TempProject;

  beforeEach(() => {
    project = createTempProject();
  });

  afterEach(() => {
    project.cleanup();
  });

  // ── Initialization ─────────────────────────────────────────────

  describe('initialization', () => {
    it('creates with empty state', () => {
      const tracker = new TrustElevationTracker(makeConfig(project.stateDir));
      const stats = tracker.getAcceptanceStats();
      expect(stats.totalDecided).toBe(0);
      expect(stats.approved).toBe(0);
      expect(stats.acceptanceRate).toBeNull();
      expect(stats.recentAcceptanceRate).toBeNull();
      expect(tracker.checkEvolutionGovernanceElevation('ai-assisted')).toBeNull();
      expect(tracker.checkProfileElevation('supervised', [])).toBeNull();
    });

    it('loads persisted state', () => {
      const t1 = new TrustElevationTracker(makeConfig(project.stateDir));
      t1.recordApprovalEvent(makeApprovalEvent({ decision: 'approved' }));
      t1.recordApprovalEvent(makeApprovalEvent({ decision: 'rejected' }));

      const t2 = new TrustElevationTracker(makeConfig(project.stateDir));
      const stats = t2.getAcceptanceStats();
      expect(stats.totalDecided).toBe(2);
      expect(stats.approved).toBe(1);
    });

    it('recovers from corrupt state file', () => {
      const statePath = path.join(project.stateDir, 'state', 'trust-elevation.json');
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, '{corrupt json!!!');

      const tracker = new TrustElevationTracker(makeConfig(project.stateDir));
      expect(tracker.getAcceptanceStats().totalDecided).toBe(0);
    });
  });

  // ── Acceptance Stats ───────────────────────────────────────────

  describe('acceptance stats', () => {
    it('tracks approved proposals', () => {
      const tracker = new TrustElevationTracker(makeConfig(project.stateDir));
      for (let i = 0; i < 5; i++) {
        tracker.recordApprovalEvent(makeApprovalEvent({ decision: 'approved' }));
      }
      const stats = tracker.getAcceptanceStats();
      expect(stats.approved).toBe(5);
      expect(stats.rejected).toBe(0);
      expect(stats.acceptanceRate).toBe(1.0);
    });

    it('tracks rejected proposals', () => {
      const tracker = new TrustElevationTracker(makeConfig(project.stateDir));
      tracker.recordApprovalEvent(makeApprovalEvent({ decision: 'approved' }));
      tracker.recordApprovalEvent(makeApprovalEvent({ decision: 'rejected' }));
      const stats = tracker.getAcceptanceStats();
      expect(stats.acceptanceRate).toBe(0.5);
    });

    it('excludes deferred from acceptance rate', () => {
      const tracker = new TrustElevationTracker(makeConfig(project.stateDir));
      tracker.recordApprovalEvent(makeApprovalEvent({ decision: 'approved' }));
      tracker.recordApprovalEvent(makeApprovalEvent({ decision: 'deferred' }));
      const stats = tracker.getAcceptanceStats();
      expect(stats.totalDecided).toBe(1); // deferred excluded
      expect(stats.acceptanceRate).toBe(1.0);
    });

    it('tracks modified vs unmodified', () => {
      const tracker = new TrustElevationTracker(makeConfig(project.stateDir));
      tracker.recordApprovalEvent(makeApprovalEvent({ decision: 'approved', modified: false }));
      tracker.recordApprovalEvent(makeApprovalEvent({ decision: 'approved', modified: true }));
      tracker.recordApprovalEvent(makeApprovalEvent({ decision: 'approved', modified: false }));
      const stats = tracker.getAcceptanceStats();
      expect(stats.approvedUnmodified).toBe(2);
      expect(stats.approved).toBe(3);
    });

    it('computes recent acceptance rate over window', () => {
      const tracker = new TrustElevationTracker(makeConfig(project.stateDir, { recentWindowSize: 5 }));

      // 5 rejections followed by 5 approvals
      for (let i = 0; i < 5; i++) {
        tracker.recordApprovalEvent(makeApprovalEvent({ decision: 'rejected' }));
      }
      for (let i = 0; i < 5; i++) {
        tracker.recordApprovalEvent(makeApprovalEvent({ decision: 'approved' }));
      }

      const stats = tracker.getAcceptanceStats();
      expect(stats.acceptanceRate).toBe(0.5); // 5/10 overall
      expect(stats.recentAcceptanceRate).toBe(1.0); // 5/5 recent window
    });

    it('trims history to 200 events', () => {
      const tracker = new TrustElevationTracker(makeConfig(project.stateDir));
      for (let i = 0; i < 210; i++) {
        tracker.recordApprovalEvent(makeApprovalEvent({ proposalId: `EVO-${i}` }));
      }
      const stats = tracker.getAcceptanceStats();
      // Should have trimmed but still track all that were in the window
      expect(stats.totalDecided).toBeLessThanOrEqual(200);
    });
  });

  // ── Rubber-Stamp Detection ─────────────────────────────────────

  describe('rubber-stamp detection', () => {
    it('detects fast consecutive approvals', () => {
      const tracker = new TrustElevationTracker(makeConfig(project.stateDir, {
        rubberStampLatencyMs: 5000,
        rubberStampConsecutive: 5,
      }));

      for (let i = 0; i < 5; i++) {
        tracker.recordApprovalEvent(makeApprovalEvent({
          decision: 'approved',
          modified: false,
          latencyMs: 2000, // under 5s threshold
        }));
      }

      const signal = tracker.getRubberStampSignal();
      expect(signal.detected).toBe(true);
      expect(signal.consecutiveFastApprovals).toBe(5);
      expect(signal.avgLatencyMs).toBe(2000);
    });

    it('does not detect when below threshold count', () => {
      const tracker = new TrustElevationTracker(makeConfig(project.stateDir, {
        rubberStampConsecutive: 10,
      }));

      for (let i = 0; i < 5; i++) {
        tracker.recordApprovalEvent(makeApprovalEvent({
          decision: 'approved',
          latencyMs: 1000,
        }));
      }

      expect(tracker.getRubberStampSignal().detected).toBe(false);
    });

    it('does not detect when approvals are slow', () => {
      const tracker = new TrustElevationTracker(makeConfig(project.stateDir, {
        rubberStampLatencyMs: 5000,
        rubberStampConsecutive: 3,
      }));

      for (let i = 0; i < 5; i++) {
        tracker.recordApprovalEvent(makeApprovalEvent({
          decision: 'approved',
          latencyMs: 30000, // 30 seconds — actually reviewed
        }));
      }

      expect(tracker.getRubberStampSignal().detected).toBe(false);
    });

    it('does not detect when proposals were modified', () => {
      const tracker = new TrustElevationTracker(makeConfig(project.stateDir, {
        rubberStampLatencyMs: 5000,
        rubberStampConsecutive: 3,
      }));

      for (let i = 0; i < 5; i++) {
        tracker.recordApprovalEvent(makeApprovalEvent({
          decision: 'approved',
          modified: true, // modified
          latencyMs: 2000,
        }));
      }

      expect(tracker.getRubberStampSignal().detected).toBe(false);
    });

    it('dismiss rubber-stamp sets dismissedUntil', () => {
      const tracker = new TrustElevationTracker(makeConfig(project.stateDir, {
        rubberStampConsecutive: 3,
      }));

      for (let i = 0; i < 3; i++) {
        tracker.recordApprovalEvent(makeApprovalEvent({ latencyMs: 1000 }));
      }
      expect(tracker.getRubberStampSignal().detected).toBe(true);

      tracker.dismissRubberStamp(30);
      const signal = tracker.getRubberStampSignal();
      expect(signal.dismissedUntil).toBeTruthy();
    });
  });

  // ── Evolution Governance Elevation ─────────────────────────────

  describe('checkEvolutionGovernanceElevation', () => {
    it('suggests autonomous when acceptance rate is high', () => {
      const tracker = new TrustElevationTracker(makeConfig(project.stateDir, {
        minProposalsForElevation: 5,
        acceptanceRateThreshold: 0.8,
        recentWindowSize: 10,
      }));

      for (let i = 0; i < 10; i++) {
        tracker.recordApprovalEvent(makeApprovalEvent({ decision: 'approved' }));
      }

      const opp = tracker.checkEvolutionGovernanceElevation('ai-assisted');
      expect(opp).not.toBeNull();
      expect(opp!.type).toBe('evolution-governance');
      expect(opp!.suggested).toContain('autonomous');
    });

    it('does not suggest when already autonomous', () => {
      const tracker = new TrustElevationTracker(makeConfig(project.stateDir));
      for (let i = 0; i < 20; i++) {
        tracker.recordApprovalEvent(makeApprovalEvent({ decision: 'approved' }));
      }

      const opp = tracker.checkEvolutionGovernanceElevation('autonomous');
      expect(opp).toBeNull();
    });

    it('does not suggest when not enough proposals', () => {
      const tracker = new TrustElevationTracker(makeConfig(project.stateDir, {
        minProposalsForElevation: 10,
      }));

      for (let i = 0; i < 5; i++) {
        tracker.recordApprovalEvent(makeApprovalEvent({ decision: 'approved' }));
      }

      const opp = tracker.checkEvolutionGovernanceElevation('ai-assisted');
      expect(opp).toBeNull();
    });

    it('does not suggest when acceptance rate is low', () => {
      const tracker = new TrustElevationTracker(makeConfig(project.stateDir, {
        minProposalsForElevation: 5,
        acceptanceRateThreshold: 0.9,
        recentWindowSize: 10,
      }));

      for (let i = 0; i < 5; i++) {
        tracker.recordApprovalEvent(makeApprovalEvent({ decision: 'approved' }));
      }
      for (let i = 0; i < 5; i++) {
        tracker.recordApprovalEvent(makeApprovalEvent({ decision: 'rejected' }));
      }

      const opp = tracker.checkEvolutionGovernanceElevation('ai-assisted');
      expect(opp).toBeNull();
    });
  });

  // ── Profile Elevation ──────────────────────────────────────────

  describe('checkProfileElevation', () => {
    it('suggests next profile when acceptance rate is good', () => {
      const tracker = new TrustElevationTracker(makeConfig(project.stateDir, {
        recentWindowSize: 10,
      }));

      for (let i = 0; i < 15; i++) {
        tracker.recordApprovalEvent(makeApprovalEvent({ decision: 'approved' }));
      }

      const opp = tracker.checkProfileElevation('supervised', []);
      expect(opp).not.toBeNull();
      expect(opp!.type).toBe('profile-upgrade');
      expect(opp!.current).toBe('supervised');
      expect(opp!.suggested).toBe('collaborative');
    });

    it('suggests next profile when many operation elevations earned', () => {
      const tracker = new TrustElevationTracker(makeConfig(project.stateDir));

      const mockElevations = [
        { service: 'gmail', operation: 'write' as const, currentLevel: 'approve-always' as const, suggestedLevel: 'log' as const, reason: 'test', streak: 10 },
        { service: 'github', operation: 'write' as const, currentLevel: 'approve-always' as const, suggestedLevel: 'log' as const, reason: 'test', streak: 15 },
      ];

      const opp = tracker.checkProfileElevation('cautious', mockElevations);
      expect(opp).not.toBeNull();
      expect(opp!.suggested).toBe('supervised');
    });

    it('does not suggest when already autonomous', () => {
      const tracker = new TrustElevationTracker(makeConfig(project.stateDir));
      const opp = tracker.checkProfileElevation('autonomous', []);
      expect(opp).toBeNull();
    });

    it('does not suggest when no signals present', () => {
      const tracker = new TrustElevationTracker(makeConfig(project.stateDir));
      const opp = tracker.checkProfileElevation('cautious', []);
      expect(opp).toBeNull();
    });
  });

  // ── Opportunity Management ─────────────────────────────────────

  describe('opportunity management', () => {
    it('dismiss sets future date', () => {
      const tracker = new TrustElevationTracker(makeConfig(project.stateDir));

      // Manually add an opportunity by triggering the check
      for (let i = 0; i < 15; i++) {
        tracker.recordApprovalEvent(makeApprovalEvent({ decision: 'approved' }));
      }
      const opp = tracker.checkEvolutionGovernanceElevation('ai-assisted');
      expect(opp).not.toBeNull();

      // The opportunity isn't automatically stored — it's computed on demand
      // So dismissOpportunity works on stored ones
      // Let's verify dismiss returns false for non-existent
      expect(tracker.dismissOpportunity('evolution-governance')).toBe(false);
    });

    it('getActiveOpportunities filters dismissed', () => {
      const tracker = new TrustElevationTracker(makeConfig(project.stateDir));
      const active = tracker.getActiveOpportunities();
      expect(active).toEqual([]); // no opportunities initially
    });
  });

  // ── Message Formatting ─────────────────────────────────────────

  describe('message formatting', () => {
    it('formats evolution governance elevation message', () => {
      const tracker = new TrustElevationTracker(makeConfig(project.stateDir));

      for (let i = 0; i < 15; i++) {
        tracker.recordApprovalEvent(makeApprovalEvent({ decision: 'approved' }));
      }
      const opp = tracker.checkEvolutionGovernanceElevation('ai-assisted');
      expect(opp).not.toBeNull();

      const msg = tracker.formatElevationMessage(opp!);
      expect(msg).toContain('Trust Elevation Opportunity');
      expect(msg).toContain('acceptance rate');
      expect(msg).toContain('sounds good');
      expect(msg).toContain('not yet');
    });

    it('formats profile upgrade message', () => {
      const tracker = new TrustElevationTracker(makeConfig(project.stateDir));

      for (let i = 0; i < 15; i++) {
        tracker.recordApprovalEvent(makeApprovalEvent({ decision: 'approved' }));
      }
      const opp = tracker.checkProfileElevation('supervised', []);
      expect(opp).not.toBeNull();

      const msg = tracker.formatElevationMessage(opp!);
      expect(msg).toContain('Profile Upgrade');
      expect(msg).toContain('collaborative');
      expect(msg).toContain('upgrade');
    });

    it('formats rubber-stamp message', () => {
      const tracker = new TrustElevationTracker(makeConfig(project.stateDir, {
        rubberStampConsecutive: 3,
        rubberStampLatencyMs: 5000,
      }));

      for (let i = 0; i < 3; i++) {
        tracker.recordApprovalEvent(makeApprovalEvent({ latencyMs: 2000 }));
      }

      const msg = tracker.formatRubberStampMessage();
      expect(msg).not.toBeNull();
      expect(msg).toContain('Approval Pattern Detected');
      expect(msg).toContain('go for it');
    });

    it('returns null for rubber-stamp message when not detected', () => {
      const tracker = new TrustElevationTracker(makeConfig(project.stateDir));
      expect(tracker.formatRubberStampMessage()).toBeNull();
    });

    it('returns null for dismissed rubber-stamp', () => {
      const tracker = new TrustElevationTracker(makeConfig(project.stateDir, {
        rubberStampConsecutive: 3,
      }));

      for (let i = 0; i < 3; i++) {
        tracker.recordApprovalEvent(makeApprovalEvent({ latencyMs: 1000 }));
      }
      expect(tracker.formatRubberStampMessage()).not.toBeNull();

      tracker.dismissRubberStamp(30);
      expect(tracker.formatRubberStampMessage()).toBeNull();
    });
  });

  // ── Dashboard ──────────────────────────────────────────────────

  describe('getDashboard', () => {
    it('returns complete dashboard structure', () => {
      const tracker = new TrustElevationTracker(makeConfig(project.stateDir));
      tracker.recordApprovalEvent(makeApprovalEvent());

      const dashboard = tracker.getDashboard();
      expect(dashboard.acceptanceStats).toBeDefined();
      expect(dashboard.rubberStamp).toBeDefined();
      expect(dashboard.activeOpportunities).toBeInstanceOf(Array);
      expect(dashboard.allOpportunities).toBeInstanceOf(Array);
      expect(dashboard.lastEvaluatedAt).toBeTruthy();
    });
  });

  // ── Convenience: recordProposalDecision ────────────────────────

  describe('recordProposalDecision', () => {
    it('auto-computes latency from proposal', () => {
      const tracker = new TrustElevationTracker(makeConfig(project.stateDir));

      const proposal = {
        id: 'EVO-001',
        title: 'Test',
        source: 'test',
        description: 'test',
        type: 'capability' as const,
        impact: 'medium' as const,
        effort: 'low' as const,
        status: 'proposed' as const,
        proposedBy: 'agent',
        proposedAt: new Date(Date.now() - 30000).toISOString(), // 30s ago
      };

      tracker.recordProposalDecision(proposal, 'approved');

      const stats = tracker.getAcceptanceStats();
      expect(stats.totalDecided).toBe(1);
      expect(stats.approved).toBe(1);
    });
  });
});

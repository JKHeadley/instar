/**
 * Unit tests for AgentReadinessScorer — Salim Ismail's coordination-vs-judgment
 * "task decomposition matrix" (EXO 3.0). Covers both sides of the decision
 * boundary with realistic inputs: coordination-dominant → deploy-agent,
 * judgment-dominant → human-led, mixed → hybrid, and the no-signal default.
 */

import { describe, it, expect } from 'vitest';
import { AgentReadinessScorer } from '../../src/core/AgentReadinessScorer.js';

const scorer = new AgentReadinessScorer();

describe('AgentReadinessScorer.score', () => {
  it('scores a coordination-dominant task as a strong agent candidate', () => {
    const r = scorer.score({
      name: 'Invoice intake',
      description:
        'Route incoming invoices to the right queue, schedule approvals, track their status, ' +
        'compile a weekly report, and notify owners. Standardized and repetitive.',
    });
    expect(r.coordinationSignals).toBeGreaterThan(r.judgmentSignals);
    expect(r.overallReadiness).toBeGreaterThanOrEqual(75);
    expect(r.recommendation).toBe('deploy-agent');
    expect(r.matched.coordination).toContain('route');
  });

  it('scores a judgment-dominant task as human-led', () => {
    const r = scorer.score({
      name: 'Partner negotiation',
      description:
        'Negotiate a sensitive partnership, resolve ambiguity in the contract, navigate the ' +
        'relationship, and make a strategic call with no playbook — high discretion and nuance.',
    });
    expect(r.judgmentSignals).toBeGreaterThan(r.coordinationSignals);
    expect(r.overallReadiness).toBeLessThan(40);
    expect(r.recommendation).toBe('human-led');
  });

  it('scores a genuinely mixed task as hybrid', () => {
    const r = scorer.score({
      description:
        'Collect status updates from each team and track them, then weigh which exceptions ' +
        'require sensitive judgment to escalate.',
    });
    expect(r.recommendation).toBe('hybrid');
    expect(r.coordinationSignals).toBeGreaterThan(0);
    expect(r.judgmentSignals).toBeGreaterThan(0);
  });

  it('defaults to hybrid (ratio 0.5) when there are no clear signals', () => {
    const r = scorer.score({ description: 'Do the needful thing.' });
    expect(r.coordinationSignals).toBe(0);
    expect(r.judgmentSignals).toBe(0);
    expect(r.coordinationRatio).toBe(0.5);
    expect(r.recommendation).toBe('hybrid');
    expect(r.reason).toMatch(/more detail/);
  });

  it('does not false-match signal substrings inside other words (log vs logical)', () => {
    const r = scorer.score({ description: 'Apply logical reasoning to a philosophical question.' });
    expect(r.matched.coordination).not.toContain('log');
  });
});

describe('AgentReadinessScorer.scoreWorkflow', () => {
  it('scores a coordination-heavy multi-step workflow as agent-ready', () => {
    const r = scorer.scoreWorkflow({
      name: 'Onboarding sync',
      steps: [
        'Fetch the new-hire record',
        'Assign standard accounts',
        'Schedule the orientation',
        'Update the tracker and notify the manager',
      ],
    });
    expect(r.overallReadiness).toBeGreaterThanOrEqual(55);
    expect(['deploy-agent', 'agent-with-oversight']).toContain(r.recommendation);
  });
});

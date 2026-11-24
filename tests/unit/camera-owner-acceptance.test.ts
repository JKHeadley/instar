import { describe, expect, it } from 'vitest';
import { cameraDeliveryDecision, checkCameraOwnerEvidence, type CameraAcceptanceReceipt, type CameraOwnerEvidence } from '../../src/core/CameraOwnerAcceptance.js';

const phone = 'tested-phone';
const otherGrant = { id: 'other', phone, computer: 'other-computer', access: 'read', expiresAt: null, revokedAt: null };
const expectedGrant = { id: 'new', phone, computer: 'test-computer', access: 'manage', expiresAt: null, revokedAt: null };
const unchanged = { before: [otherGrant], after: [otherGrant], visibleComputer: null };
const linked = [otherGrant, expectedGrant];
const evidence: CameraOwnerEvidence = {
  candidate: 'tested-candidate',
  computer: expectedGrant.computer,
  phone,
  expectedGrant,
  observedAt: '2026-11-24T22:00:00Z',
  redirected: false,
  success: { before: [otherGrant], after: linked, visibleComputer: expectedGrant.computer },
  cancellation: unchanged,
  expiry: unchanged,
  replay: { before: linked, after: [...linked].reverse(), visibleComputer: expectedGrant.computer },
};

describe('Camera owner acceptance evidence', () => {
  it('accepts the exact new grant and preserves other grants across negative trials', () => {
    expect(checkCameraOwnerEvidence(evidence.candidate, evidence)).toBe('pass');
  });

  it('holds absent or stale evidence', () => {
    expect(checkCameraOwnerEvidence(evidence.candidate, null)).toBe('pending');
    expect(checkCameraOwnerEvidence('different-candidate', evidence)).toBe('pending');
  });

  it('rejects a redirect even when the remaining checks pass', () => {
    expect(checkCameraOwnerEvidence(evidence.candidate, { ...evidence, redirected: true })).toBe('fail');
  });

  it.each(['cancellation', 'expiry'] as const)('detects deletion of a grant on another computer after %s', trial => {
    expect(checkCameraOwnerEvidence(evidence.candidate, {
      ...evidence,
      [trial]: { ...unchanged, after: [] },
    })).toBe('fail');
  });

  it('rejects a fixture that cannot detect deletion on another computer', () => {
    expect(checkCameraOwnerEvidence(evidence.candidate, {
      ...evidence,
      expiry: { ...unchanged, before: [], after: [] },
    })).toBe('fail');
  });

  it.each(['success', 'cancellation', 'expiry', 'replay'] as const)('detects a changed second-computer grant after %s', trial => {
    const after = evidence[trial].after.map(grant => grant.id === otherGrant.id
      ? { ...grant, revokedAt: '2026-11-24T22:00:00Z' }
      : grant);
    expect(checkCameraOwnerEvidence(evidence.candidate, {
      ...evidence,
      [trial]: { ...evidence[trial], after },
    })).toBe('fail');
  });

  it('rejects an already expired expected grant', () => {
    const expired = { ...expectedGrant, expiresAt: evidence.observedAt };
    const after = [otherGrant, expired];
    expect(checkCameraOwnerEvidence(evidence.candidate, {
      ...evidence,
      expectedGrant: expired,
      success: { ...evidence.success, after },
      replay: { ...evidence.replay, before: after, after },
    })).toBe('fail');
  });

  it('rejects an extra grant on replay', () => {
    expect(checkCameraOwnerEvidence(evidence.candidate, {
      ...evidence,
      replay: { ...evidence.replay, after: [...linked, expectedGrant] },
    })).toBe('fail');
  });
});

describe('Camera owner acceptance delivery decision', () => {
  const requirement = { candidate: evidence.candidate, revision: 2, verifier: 'verifier', builders: ['builder'] };
  const pass: CameraAcceptanceReceipt = { candidate: evidence.candidate, revision: 2, verifier: 'verifier', sequence: 1, decision: 'pass' };

  it('accepts the exact current pass and handles identical replays', () => {
    expect(cameraDeliveryDecision(requirement, [pass, pass])).toBe('pass');
  });

  it.each(['fail', 'pending'] as const)('lets a later %s supersede a pass', decision => {
    expect(cameraDeliveryDecision(requirement, [{ ...pass, sequence: 2, decision }, pass])).toBe(decision);
  });

  it('holds unavailable history, sequence gaps, and conflicting decisions', () => {
    expect(cameraDeliveryDecision(requirement, null)).toBe('pending');
    expect(cameraDeliveryDecision(requirement, [pass, { ...pass, sequence: 3 }])).toBe('pending');
    expect(cameraDeliveryDecision(requirement, [pass, { ...pass, decision: 'fail' }])).toBe('pending');
  });

  it('holds a stale pass, a different candidate, or a builder acting as verifier', () => {
    expect(cameraDeliveryDecision(requirement, [{ ...pass, revision: 1 }])).toBe('pending');
    expect(cameraDeliveryDecision(requirement, [{ ...pass, candidate: 'stale' }])).toBe('pending');
    expect(cameraDeliveryDecision(requirement, [{ ...pass, verifier: 'builder' }])).toBe('pending');
    expect(cameraDeliveryDecision({ ...requirement, builders: ['verifier'] }, [pass])).toBe('pending');
  });
});

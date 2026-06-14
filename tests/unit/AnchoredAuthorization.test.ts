/**
 * Unit tests — AnchoredAuthorization (Robustness Phase 1, G2 / D-C).
 *
 * The POSITIVE boundary that keeps Threadline prose from ever authorizing an
 * irreversible action: the guard accepts ONLY a typed anchored artifact and
 * rejects every prose-derived shape (string, transcript, history summary,
 * ContentClassifier output, null, array).
 */

import { describe, it, expect } from 'vitest';
import {
  isAnchoredAuthorization,
  requireAnchoredAuthorization,
  AnchoredAuthorizationError,
} from '../../src/coordination/AnchoredAuthorization.js';

describe('AnchoredAuthorization — isAnchoredAuthorization', () => {
  it('accepts a mandate reference with an audit hash', () => {
    expect(isAnchoredAuthorization({ kind: 'mandate', id: 'M1', auditHash: 'abc123' })).toBe(true);
  });

  it('accepts a review-exchange reference with an audit hash', () => {
    expect(isAnchoredAuthorization({ kind: 'review-exchange', id: 'RX1', auditHash: 'def456' })).toBe(true);
  });

  it('accepts an operator-confirm reference with authorizedBy', () => {
    expect(isAnchoredAuthorization({ kind: 'operator-confirm', id: 'req-1', authorizedBy: 'justin' })).toBe(true);
  });

  it('REJECTS every prose-derived shape', () => {
    // a raw string ("Dawn confirmed")
    expect(isAnchoredAuthorization('Dawn confirmed the cutover')).toBe(false);
    // a transcript-shaped object
    expect(isAnchoredAuthorization({ messages: [{ from: 'dawn', body: 'go ahead' }] })).toBe(false);
    // a conversation/history summary
    expect(isAnchoredAuthorization({ summary: 'we agreed to lock W1' })).toBe(false);
    // a ContentClassifier output
    expect(isAnchoredAuthorization({ isCommitmentClass: true, matchedTerms: ['go ahead'] })).toBe(false);
    // null / undefined / array / number
    expect(isAnchoredAuthorization(null)).toBe(false);
    expect(isAnchoredAuthorization(undefined)).toBe(false);
    expect(isAnchoredAuthorization(['mandate', 'M1'])).toBe(false);
    expect(isAnchoredAuthorization(42)).toBe(false);
  });

  it('rejects a well-known kind missing its proof (audit hash / authorizedBy)', () => {
    expect(isAnchoredAuthorization({ kind: 'mandate', id: 'M1' })).toBe(false);
    expect(isAnchoredAuthorization({ kind: 'mandate', id: 'M1', auditHash: '' })).toBe(false);
    expect(isAnchoredAuthorization({ kind: 'operator-confirm', id: 'r1' })).toBe(false);
    expect(isAnchoredAuthorization({ kind: 'unknown-kind', id: 'x', auditHash: 'y' })).toBe(false);
  });
});

describe('AnchoredAuthorization — requireAnchoredAuthorization', () => {
  it('returns the typed artifact when valid', () => {
    const a = requireAnchoredAuthorization({ kind: 'mandate', id: 'M1', auditHash: 'h' }, 'test');
    expect(a.kind).toBe('mandate');
  });

  it('THROWS AnchoredAuthorizationError on prose', () => {
    expect(() => requireAnchoredAuthorization('we agreed in chat', 'cutover'))
      .toThrowError(AnchoredAuthorizationError);
    expect(() => requireAnchoredAuthorization({ summary: 'go-live approved' }, 'cutover'))
      .toThrowError(/anchored artifact/i);
  });
});

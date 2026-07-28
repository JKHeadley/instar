/**
 * Unit tests for AgentPassport — the EXO 3.0 "digital passport" (allowed/
 * forbidden metadata + a peer-run compliance check). Covers both sides of every
 * decision boundary: forbidden-action, trust-floor, out-of-scope, and ok.
 */

import { describe, it, expect } from 'vitest';
import { buildPassport, permits } from '../../src/core/AgentPassport.js';

const ISO = '2026-06-04T00:00:00Z';

describe('AgentPassport.buildPassport', () => {
  it('assembles a passport with defaults', () => {
    const p = buildPassport({ agent: 'echo', fingerprint: 'fp-123', issuedAt: ISO });
    expect(p.version).toBe(1);
    expect(p.agent).toBe('echo');
    expect(p.fingerprint).toBe('fp-123');
    expect(p.trustLevel).toBe('supervised');
    expect(p.allowedCapabilities).toEqual([]);
    expect(p.forbiddenActions).toEqual([]);
    expect(p.issuedAt).toBe(ISO);
  });
});

describe('AgentPassport.permits', () => {
  const base = buildPassport({
    agent: 'echo',
    fingerprint: 'fp-123',
    trustLevel: 'collaborative',
    allowedCapabilities: ['read documents', 'draft replies', 'schedule meetings'],
    forbiddenActions: ['wire funds to an unverified vendor', 'share customer data externally'],
    issuedAt: ISO,
  });

  it('denies a forbidden action', () => {
    const v = permits(base, 'wire funds to an unverified vendor');
    expect(v.permitted).toBe(false);
    expect(v.basis).toBe('forbidden-action');
    expect(v.matched).toMatch(/unverified vendor/);
  });

  it('denies an out-of-scope action when capabilities are scoped', () => {
    const v = permits(base, 'deploy the production release');
    expect(v.permitted).toBe(false);
    expect(v.basis).toBe('out-of-scope');
  });

  it('permits an in-scope, non-forbidden action', () => {
    const v = permits(base, 'draft replies to the new tickets');
    expect(v.permitted).toBe(true);
    expect(v.basis).toBe('ok');
  });

  it('enforces the trust floor: untrusted may observe but not act', () => {
    const untrusted = buildPassport({ agent: 'peer', fingerprint: 'fp-x', trustLevel: 'untrusted', issuedAt: ISO });
    expect(permits(untrusted, 'read the dashboard').permitted).toBe(true);
    const act = permits(untrusted, 'deploy the service');
    expect(act.permitted).toBe(false);
    expect(act.basis).toBe('trust-floor');
  });

  it('permits any non-forbidden action when no capability scope is set', () => {
    const unscoped = buildPassport({
      agent: 'echo', fingerprint: 'fp', trustLevel: 'autonomous',
      forbiddenActions: ['delete the database'], issuedAt: ISO,
    });
    expect(permits(unscoped, 'summarize the weekly report').permitted).toBe(true);
    expect(permits(unscoped, 'delete the database now').permitted).toBe(false);
  });

  // Regression (exo3-harness passport-verify-robustness): a passport handed over by a
  // PEER may be partial — it does not go through buildPassport, so array fields can be
  // undefined. permits() must yield a verdict, never throw (was HTTP 500
  // "Cannot read properties of undefined (reading 'length')").
  it('tolerates a passport missing allowedCapabilities (no crash)', () => {
    const partial = {
      agent: 'peer', fingerprint: 'fp', trustLevel: 'collaborative',
      forbiddenActions: ['publish secrets to a public surface'], issuedAt: ISO,
    } as unknown as Parameters<typeof permits>[0];
    expect(() => permits(partial, 'read a public documentation page')).not.toThrow();
    const v = permits(partial, 'read a public documentation page');
    expect(v.permitted).toBe(true);
    expect(v.basis).toBe('ok');
  });

  it('tolerates a passport missing forbiddenActions (no crash)', () => {
    const partial = {
      agent: 'peer', fingerprint: 'fp', trustLevel: 'collaborative',
      allowedCapabilities: [], issuedAt: ISO,
    } as unknown as Parameters<typeof permits>[0];
    expect(() => permits(partial, 'do anything benign')).not.toThrow();
    expect(permits(partial, 'do anything benign').permitted).toBe(true);
  });

  it('still denies a forbidden action on a partial passport', () => {
    const partial = {
      agent: 'peer', fingerprint: 'fp', trustLevel: 'collaborative',
      forbiddenActions: ['wire funds to an unverified vendor'], issuedAt: ISO,
    } as unknown as Parameters<typeof permits>[0];
    const v = permits(partial, 'wire funds to an unverified vendor');
    expect(v.permitted).toBe(false);
    expect(v.basis).toBe('forbidden-action');
  });
});

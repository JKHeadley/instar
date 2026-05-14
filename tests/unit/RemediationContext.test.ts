/**
 * Unit tests for RemediationContext sign/verify helpers — F-8 rest of Tier-2.
 *
 * Covers SELF-HEALING-REMEDIATOR-V2-SPEC §A3 / §A23 / §A42 capability-token
 * HMAC enforcement at the surface boundary.
 */

import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';

import {
  signRemediationContext,
  verifyRemediationContext,
  type CapabilityLeafKeyVault,
} from '../../src/remediation/RemediationContext.js';
import type { RemediationContext } from '../../src/remediation/Remediator.js';
import type { InFlightHandle } from '../../src/remediation/MachineLock.js';

class FakeKeyVault implements CapabilityLeafKeyVault {
  private readonly master = crypto.randomBytes(32);
  private readonly nonce = crypto.randomBytes(32);
  deriveLeafKey(context: 'capability', scopeId: string): Buffer {
    const info = Buffer.from(`${context}:${scopeId}`);
    return Buffer.from(crypto.hkdfSync('sha256', this.master, this.nonce, info, 32));
  }
}

function fakeLockHandle(attemptId: string): InFlightHandle {
  return {
    surfaceId: 'native-module-healer',
    attemptId,
    tupleHash: 'th',
    lockPath: '/tmp/none',
    expiresAt: Date.now() + 60_000,
    release: async () => {},
  } as unknown as InFlightHandle;
}

function makeCtxBase(runbookId = 'node-abi-mismatch'): RemediationContext {
  const attemptId = crypto.randomUUID();
  const issuedAt = Date.now();
  return {
    attemptId,
    runbookId,
    lockHandle: fakeLockHandle(attemptId),
    auditToken: crypto.randomBytes(32),
    abortSignal: new AbortController().signal,
    expiresAt: issuedAt + 1000,
    monotonicDeadline: process.hrtime.bigint() + 1_000_000_000n,
  };
}

describe('RemediationContext sign + verify', () => {
  it('sign + verify roundtrip succeeds', () => {
    const vault = new FakeKeyVault();
    const ctx = makeCtxBase();
    ctx.hmac = signRemediationContext(ctx, vault);
    expect(verifyRemediationContext(ctx, vault)).toBe(true);
  });

  it('verify returns false for tampered ctx body', () => {
    const vault = new FakeKeyVault();
    const ctx = makeCtxBase();
    ctx.hmac = signRemediationContext(ctx, vault);
    // Tamper attemptId after signing — verify must reject.
    const tampered: RemediationContext = { ...ctx, attemptId: 'forged-attempt' };
    expect(verifyRemediationContext(tampered, vault)).toBe(false);
  });

  it('verify returns false when runbookId differs (different leaf key)', () => {
    const vault = new FakeKeyVault();
    const ctxA = makeCtxBase('runbook-a');
    ctxA.hmac = signRemediationContext(ctxA, vault);
    // Reuse the hmac with a different runbookId — verify must reject
    // because the leaf key is derived from runbookId.
    const swapped: RemediationContext = { ...ctxA, runbookId: 'runbook-b' };
    expect(verifyRemediationContext(swapped, vault)).toBe(false);
  });

  it('verify returns false when hmac is forged (wrong key)', () => {
    const vault = new FakeKeyVault();
    const ctx = makeCtxBase();
    // Forge with a random 32-byte buffer that's not the real HMAC.
    ctx.hmac = crypto.randomBytes(32);
    expect(verifyRemediationContext(ctx, vault)).toBe(false);
  });

  it('verify returns false when hmac field is missing', () => {
    const vault = new FakeKeyVault();
    const ctx = makeCtxBase();
    expect(verifyRemediationContext(ctx, vault)).toBe(false);
  });

  it('verify returns false when hmac length differs', () => {
    const vault = new FakeKeyVault();
    const ctx = makeCtxBase();
    ctx.hmac = Buffer.alloc(16); // wrong length
    expect(verifyRemediationContext(ctx, vault)).toBe(false);
  });

  it('verify returns false when runbookId is empty', () => {
    const vault = new FakeKeyVault();
    const ctx = makeCtxBase('');
    ctx.hmac = Buffer.alloc(32, 0xff);
    expect(verifyRemediationContext(ctx, vault)).toBe(false);
  });
});

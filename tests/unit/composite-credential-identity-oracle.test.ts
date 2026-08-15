/**
 * The composite identity oracle — the seam that lets a Codex account be enrolled.
 *
 * The pool refuses to enrol an account whose slot identity cannot be verified.
 * The production oracle answers by calling Anthropic's OAuth profile endpoint, so
 * it can only speak for a claude-code slot; that is why the pool held 6 anthropic
 * accounts and 0 codex ones while both codex logins sat authenticated on disk.
 *
 * These pin the two properties that matter: a Codex slot now resolves, and the
 * pre-existing Anthropic path is untouched.
 */

import { describe, it, expect } from 'vitest';
import { CompositeCredentialIdentityOracle } from '../../src/core/CompositeCredentialIdentityOracle.js';
import type { CodexSlotIdentity } from '../../src/providers/adapters/openai-codex/codexSlotIdentity.js';
import type { IdentityOracle, IdentityOracleResult } from '../../src/core/CredentialLocationLedger.js';

function anthropicOracle(result: IdentityOracleResult, calls: string[] = []): IdentityOracle {
  return {
    async resolveSlotTenant(slot: string): Promise<IdentityOracleResult> {
      calls.push(slot);
      return result;
    },
  };
}

const codexOk = (email: string): CodexSlotIdentity => ({
  email,
  accountId: 'acct-1',
  planType: 'pro',
  unavailable: false,
});
const codexUnavailable = (reason: NonNullable<CodexSlotIdentity['reason']>): CodexSlotIdentity => ({
  email: null,
  accountId: null,
  planType: null,
  unavailable: true,
  reason,
});

describe('CompositeCredentialIdentityOracle', () => {
  it('resolves a Codex slot — the case that was impossible before', () => {
    const calls: string[] = [];
    const oracle = new CompositeCredentialIdentityOracle({
      anthropic: anthropicOracle({ unavailable: true, reason: 'not-anthropic' }, calls),
      readCodex: () => codexOk('justin@sagemindai.io'),
    });

    return oracle.resolveSlotTenant('/slots/codex').then((r) => {
      expect(r.email).toBe('justin@sagemindai.io');
      expect(r.unavailable).toBeUndefined();
      // And it did NOT waste a network round-trip on the Anthropic endpoint.
      expect(calls).toEqual([]);
    });
  });

  it('CONTROL: a non-Codex slot still goes to the Anthropic oracle, verbatim', async () => {
    // Without this, the test above would pass equally well against a composite
    // that had simply broken the claude-code path.
    const calls: string[] = [];
    const oracle = new CompositeCredentialIdentityOracle({
      anthropic: anthropicOracle({ email: 'justin@anthropic-account.example' }, calls),
      readCodex: () => codexUnavailable('auth-file-missing'),
    });

    const r = await oracle.resolveSlotTenant('/slots/claude');
    expect(r.email).toBe('justin@anthropic-account.example');
    expect(calls).toEqual(['/slots/claude']);
  });

  it('passes an Anthropic unavailable result through unchanged', async () => {
    const oracle = new CompositeCredentialIdentityOracle({
      anthropic: anthropicOracle({ unavailable: true, reason: 'timeout' }),
      readCodex: () => codexUnavailable('auth-file-missing'),
    });
    expect(await oracle.resolveSlotTenant('/slots/claude')).toEqual({ unavailable: true, reason: 'timeout' });
  });

  it('a BROKEN Codex slot is reported honestly, not masked as an Anthropic failure', async () => {
    // 'auth-file-missing' means "not a codex slot" and falls through. Any other
    // reason means it IS a codex home that could not identify itself — Anthropic
    // cannot speak for it either, so the real cause must survive.
    const calls: string[] = [];
    const oracle = new CompositeCredentialIdentityOracle({
      anthropic: anthropicOracle({ email: 'wrong@example.com' }, calls),
      readCodex: () => codexUnavailable('id-token-malformed'),
    });

    const r = await oracle.resolveSlotTenant('/slots/codex-broken');
    expect(r.unavailable).toBe(true);
    expect(r.reason).toBe('codex-slot-id-token-malformed');
    // It must NOT fall through and mislabel a broken codex slot as an anthropic one.
    expect(calls).toEqual([]);
  });

  it('a throwing Codex probe degrades to the Anthropic path, never breaks enrolment', async () => {
    // The probe is written not to throw. If it ever does, losing the ability to
    // enrol claude-code accounts would be strictly worse than an unanswered probe.
    const calls: string[] = [];
    const oracle = new CompositeCredentialIdentityOracle({
      anthropic: anthropicOracle({ email: 'still-works@example.com' }, calls),
      readCodex: () => {
        throw new Error('probe exploded');
      },
    });

    const r = await oracle.resolveSlotTenant('/slots/claude');
    expect(r.email).toBe('still-works@example.com');
    expect(calls).toEqual(['/slots/claude']);
  });

  it('THE ENROLMENT PROPERTY: two Codex slots resolve to different identities', async () => {
    // The pool's duplicate guard depends on this. If both slots reported the same
    // identity, two rows could point at one login and "swap to the other account"
    // would be a swap to itself.
    const bySlot: Record<string, CodexSlotIdentity> = {
      '/slots/a': codexOk('a@example.com'),
      '/slots/b': codexOk('b@example.com'),
    };
    const oracle = new CompositeCredentialIdentityOracle({
      anthropic: anthropicOracle({ unavailable: true }),
      readCodex: (slot) => bySlot[slot] ?? codexUnavailable('auth-file-missing'),
    });

    const a = await oracle.resolveSlotTenant('/slots/a');
    const b = await oracle.resolveSlotTenant('/slots/b');
    expect(a.email).not.toBe(b.email);
  });
});

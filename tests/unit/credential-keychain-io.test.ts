/**
 * Step 5a — CredentialKeychainIO: the staging namespace + the disjoint invariant (§2.3.2), plus
 * the async read contract. The pure functions and the invariant are hermetic and run everywhere;
 * the real `security` read of an absent service returns null on both darwin (not-found) and
 * non-darwin (no binary), so the null-on-error contract is checked cross-platform without ever
 * writing to the keychain (write/delete round-trips are exercised by the Step-10 livetest).
 */

import { describe, it, expect } from 'vitest';
import {
  stagingService,
  isStagingService,
  assertStagingDisjoint,
  slotService,
  SecurityKeychainIO,
} from '../../src/core/CredentialKeychainIO.js';
import { claudeCredentialService } from '../../src/core/OAuthRefresher.js';

describe('CredentialKeychainIO — staging namespace + disjoint invariant (§2.3.2)', () => {
  it('stagingService prefixes with the disjoint namespace and carries the swapId', () => {
    expect(stagingService('abc123')).toBe('instar-credential-swap-staging-abc123');
    expect(isStagingService(stagingService('abc123'))).toBe(true);
  });

  it('isStagingService is false for a real Claude credential service', () => {
    expect(isStagingService(claudeCredentialService('~/.claude'))).toBe(false);
    expect(isStagingService(claudeCredentialService('~/.claude-echo-3'))).toBe(false);
  });

  it('the staging namespace is GUARANTEED disjoint from every claudeCredentialService output', () => {
    // claudeCredentialService always begins with "Claude Code-credentials"; staging always begins
    // with "instar-credential-swap-staging-". They can never collide.
    for (const home of ['~/.claude', '~/.claude-a', '~/.claude-echo-3', '/abs/path/.claude-x', '~/weird home/.c']) {
      const real = claudeCredentialService(home);
      expect(real.startsWith('Claude Code-credentials')).toBe(true);
      expect(isStagingService(real)).toBe(false);
      const staging = stagingService(`id-for-${home}`);
      expect(staging.startsWith('Claude Code-credentials')).toBe(false);
      expect(real).not.toBe(staging);
    }
  });

  it('assertStagingDisjoint does not throw for a normal swapId', () => {
    expect(() => assertStagingDisjoint('swap-0001')).not.toThrow();
    expect(() => assertStagingDisjoint('deadbeef')).not.toThrow();
  });

  it('slotService resolves the real Claude credential service for a home', () => {
    expect(slotService('~/.claude')).toBe('Claude Code-credentials');
    expect(slotService('~/.claude-a')).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/);
  });

  it('SecurityKeychainIO.read of a guaranteed-absent service returns null (no throw, no prompt)', async () => {
    const io = new SecurityKeychainIO({ timeoutMs: 5000 });
    const absent = stagingService('definitely-absent-test-service-9z9z9z');
    const val = await io.read(absent);
    expect(val).toBeNull();
  });

  it('SecurityKeychainIO.delete of an absent service never throws', async () => {
    const io = new SecurityKeychainIO({ timeoutMs: 5000 });
    await expect(io.delete(stagingService('also-absent-9z9z9z'))).resolves.toBeUndefined();
  });
});

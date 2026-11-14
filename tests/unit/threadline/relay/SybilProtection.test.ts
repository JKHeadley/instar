import { describe, it, expect } from 'vitest';
import {
  generateChallenge,
  verifySolution,
  solveChallenge,
  computeDynamicDifficulty,
  IPRateLimiter,
  IDENTITY_AGING_MS,
  IP_LIMITS,
} from '../../../../src/threadline/relay/SybilProtection.js';

describe('SybilProtection', () => {
  describe('PoW challenge/solve/verify', () => {
    it('generates a challenge with correct fields', () => {
      const challenge = generateChallenge('127.0.0.1');
      expect(challenge.epoch).toBeDefined();
      expect(challenge.difficulty).toBeGreaterThan(0);
      expect(challenge.issuedAt).toBeGreaterThan(0);
    });

    it('solves and verifies a low-difficulty challenge', () => {
      // Use low difficulty for fast test execution
      const challenge = generateChallenge('127.0.0.1', 8);
      const solution = solveChallenge(challenge, '127.0.0.1');
      const result = verifySolution(solution, '127.0.0.1');
      expect(result.valid).toBe(true);
    });

    it('rejects solution for wrong IP', () => {
      // At 8 bits a nonce solved for one IP also satisfies another 1 time in 256, and the
      // hash includes the epoch, so the test failed for a whole epoch at a time (main red,
      // 2026-11-02 21:57 PST). 16 bits makes that ~1 in 65,536 and still solves in ms.
      const challenge = generateChallenge('127.0.0.1', 16);
      const solution = solveChallenge(challenge, '127.0.0.1');
      // Verify with different IP
      const result = verifySolution(solution, '10.0.0.1');
      expect(result.valid).toBe(false);
    });

    it('rejects insufficient work', () => {
      const challenge = generateChallenge('127.0.0.1', 32); // very high difficulty
      const badSolution = {
        challenge,
        nonce: '0000000000000000', // almost certainly won't satisfy 32 bits
        solveTimeMs: 100,
      };
      const result = verifySolution(badSolution, '127.0.0.1');
      expect(result.valid).toBe(false);
    });
  });

  describe('dynamic difficulty', () => {
    it('returns baseline at normal rate', () => {
      expect(computeDynamicDifficulty(10, 10)).toBe(20); // 1x = baseline
    });

    it('returns baseline at 3x rate', () => {
      expect(computeDynamicDifficulty(30, 10)).toBe(20); // threshold not exceeded
    });

    it('increases at >3x rate', () => {
      const difficulty = computeDynamicDifficulty(60, 10); // 6x
      expect(difficulty).toBeGreaterThan(20);
    });

    it('caps at ceiling', () => {
      const difficulty = computeDynamicDifficulty(1000, 10); // 100x
      expect(difficulty).toBeLessThanOrEqual(24); // MAX_DIFFICULTY_BITS
    });

    it('handles zero baseline', () => {
      expect(computeDynamicDifficulty(10, 0)).toBe(20);
    });
  });

  describe('IPRateLimiter', () => {
    it('allows first connection', () => {
      const limiter = new IPRateLimiter();
      const result = limiter.checkConnection('1.2.3.4', 'agent-a');
      expect(result.allowed).toBe(true);
    });

    it('blocks after too many connections per minute', () => {
      const limiter = new IPRateLimiter();
      // Use same fingerprint to avoid identity limit
      for (let i = 0; i < IP_LIMITS.newConnectionsPerMinute; i++) {
        limiter.checkConnection('1.2.3.4', 'agent-a');
      }
      const result = limiter.checkConnection('1.2.3.4', 'agent-a');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('connections');
    });

    it('blocks new identities after identity limit', () => {
      const limiter = new IPRateLimiter();
      for (let i = 0; i < IP_LIMITS.identitiesPerIPPerHour; i++) {
        limiter.checkConnection('1.2.3.4', `agent-${i}`);
      }
      // Same IP, new identity
      const result = limiter.checkConnection('1.2.3.4', 'new-agent');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('identities/hour');
    });

    it('allows same identity to reconnect', () => {
      const limiter = new IPRateLimiter();
      for (let i = 0; i < IP_LIMITS.identitiesPerIPPerHour; i++) {
        limiter.checkConnection('1.2.3.4', `agent-${i}`);
      }
      // Same identity reconnecting (not a new identity)
      const result = limiter.checkConnection('1.2.3.4', 'agent-0');
      expect(result.allowed).toBe(true);
    });

    it('different IPs have independent limits', () => {
      const limiter = new IPRateLimiter();
      for (let i = 0; i < IP_LIMITS.newConnectionsPerMinute; i++) {
        limiter.checkConnection('1.2.3.4', `agent-${i}`);
      }
      // Different IP should be fine
      const result = limiter.checkConnection('5.6.7.8', 'agent-x');
      expect(result.allowed).toBe(true);
    });
  });

  describe('identity aging', () => {
    it('new identity is not aged', () => {
      const limiter = new IPRateLimiter();
      expect(limiter.isIdentityAged(Date.now())).toBe(false);
    });

    it('old identity is aged', () => {
      const limiter = new IPRateLimiter();
      expect(limiter.isIdentityAged(Date.now() - IDENTITY_AGING_MS - 1000)).toBe(true);
    });
  });
});

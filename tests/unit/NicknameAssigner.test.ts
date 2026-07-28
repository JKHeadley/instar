/**
 * Tier-1 tests for NicknameAssigner — the pure derivation + collision logic
 * behind machine nicknames (Multi-Machine Session Pool §L2). No I/O.
 */

import { describe, it, expect } from 'vitest';
import { assignNickname, deriveBaseNickname, isValidNickname } from '../../src/core/NicknameAssigner.js';

describe('NicknameAssigner', () => {
  describe('deriveBaseNickname', () => {
    it('title-cases a sanitized hostname into a friendly label', () => {
      expect(deriveBaseNickname('justins-macbook-pro', 'darwin-arm64')).toBe('Justins Macbook Pro');
      expect(deriveBaseNickname('mac-mini', 'darwin-arm64')).toBe('Mac Mini');
    });

    it('strips a .local suffix and collapses separators', () => {
      expect(deriveBaseNickname('Studio.local', 'darwin-arm64')).toBe('Studio');
      expect(deriveBaseNickname('build_box-01', 'linux-x64')).toBe('Build Box 01');
    });

    it('falls back to a platform label when the name is empty', () => {
      expect(deriveBaseNickname('', 'darwin-arm64')).toBe('Mac arm64');
      expect(deriveBaseNickname(undefined, 'linux-x64')).toBe('Linux x64');
      expect(deriveBaseNickname('', 'win32-x64')).toBe('Windows x64');
      expect(deriveBaseNickname('', undefined)).toBe('Machine');
    });
  });

  describe('assignNickname', () => {
    it('is deterministic: same inputs → same output', () => {
      const a = assignNickname({ identityName: 'mac-mini', platform: 'darwin-arm64', existingNicknames: [] });
      const b = assignNickname({ identityName: 'mac-mini', platform: 'darwin-arm64', existingNicknames: [] });
      expect(a).toBe(b);
      expect(a).toBe('Mac Mini');
    });

    it('appends a numeric suffix on collision (case-insensitive)', () => {
      expect(assignNickname({ identityName: 'mac-mini', existingNicknames: ['Mac Mini'] })).toBe('Mac Mini 2');
      expect(assignNickname({ identityName: 'mac-mini', existingNicknames: ['mac mini', 'MAC MINI 2'] })).toBe(
        'Mac Mini 3',
      );
    });

    it('does not collide with itself when the pool is empty', () => {
      expect(assignNickname({ identityName: 'laptop', existingNicknames: [] })).toBe('Laptop');
    });

    it('produces a valid nickname for every derivation path', () => {
      for (const opts of [
        { identityName: 'justins-macbook-pro', platform: 'darwin-arm64' },
        { identityName: '', platform: 'linux-x64' },
        { identityName: undefined, platform: undefined },
      ]) {
        expect(isValidNickname(assignNickname(opts))).toBe(true);
      }
    });
  });

  describe('isValidNickname', () => {
    it('accepts friendly names', () => {
      for (const n of ['Mac Mini', 'laptop', 'Build-Box 01', 'studio']) expect(isValidNickname(n)).toBe(true);
    });
    it('rejects empty, over-long, and malformed values', () => {
      expect(isValidNickname('')).toBe(false);
      expect(isValidNickname('   ')).toBe(false);
      expect(isValidNickname('a'.repeat(60))).toBe(false);
      expect(isValidNickname('-leading-hyphen')).toBe(false);
      expect(isValidNickname('bad/slash')).toBe(false);
      expect(isValidNickname(42 as unknown as string)).toBe(false);
      expect(isValidNickname(null as unknown as string)).toBe(false);
    });
  });
});

/**
 * Codex-only enforcement guard (claudeForbiddenGuard).
 *
 * Justin's 2026-05-23 absolute requirement: a codex-only agent must NEVER
 * invoke Claude. The guard makes Claude provider construction throw when
 * the flag is set, so any fallback path that reaches for Claude surfaces
 * loudly instead of silently using it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  setClaudeForbidden,
  clearClaudeForbidden,
  isClaudeForbidden,
  assertClaudeAllowed,
  isCodexOnly,
  ClaudeForbiddenError,
} from '../../src/core/claudeForbiddenGuard.js';
import { ClaudeCliIntelligenceProvider } from '../../src/core/ClaudeCliIntelligenceProvider.js';

describe('claudeForbiddenGuard', () => {
  beforeEach(() => clearClaudeForbidden());
  afterEach(() => clearClaudeForbidden());

  describe('isCodexOnly', () => {
    it('true for ["codex-cli"] (no claude-code)', () => {
      expect(isCodexOnly(['codex-cli'])).toBe(true);
    });
    it('false when claude-code is present', () => {
      expect(isCodexOnly(['codex-cli', 'claude-code'])).toBe(false);
      expect(isCodexOnly(['claude-code'])).toBe(false);
    });
    it('false for empty/undefined (back-compat: legacy installs allow Claude)', () => {
      expect(isCodexOnly([])).toBe(false);
      expect(isCodexOnly(undefined)).toBe(false);
      expect(isCodexOnly(null)).toBe(false);
    });
  });

  describe('flag lifecycle', () => {
    it('defaults to not-forbidden', () => {
      expect(isClaudeForbidden()).toBe(false);
    });
    it('setClaudeForbidden flips the flag', () => {
      setClaudeForbidden('test reason');
      expect(isClaudeForbidden()).toBe(true);
    });
    it('clearClaudeForbidden resets it', () => {
      setClaudeForbidden('x');
      clearClaudeForbidden();
      expect(isClaudeForbidden()).toBe(false);
    });
  });

  describe('assertClaudeAllowed', () => {
    it('no-op when not forbidden', () => {
      expect(() => assertClaudeAllowed('test')).not.toThrow();
    });
    it('throws ClaudeForbiddenError when forbidden, naming the context + reason', () => {
      setClaudeForbidden("enabledFrameworks=['codex-cli']");
      try {
        assertClaudeAllowed('SomeGate');
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(ClaudeForbiddenError);
        expect((e as Error).message).toContain('SomeGate');
        expect((e as Error).message).toContain("codex-cli");
      }
    });
  });

  describe('ClaudeCliIntelligenceProvider construction is gated', () => {
    it('constructs normally when Claude is allowed', () => {
      expect(() => new ClaudeCliIntelligenceProvider('/opt/homebrew/bin/claude')).not.toThrow();
    });
    it('THROWS when Claude is forbidden (the core enforcement)', () => {
      setClaudeForbidden("enabledFrameworks=['codex-cli'] (no claude-code)");
      expect(() => new ClaudeCliIntelligenceProvider('/opt/homebrew/bin/claude'))
        .toThrow(ClaudeForbiddenError);
    });
  });
});
